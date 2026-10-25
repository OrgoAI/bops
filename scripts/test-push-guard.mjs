// Tests for the git hook scripts/setup.sh installs (pre-push, "bops-public-history-guard", a copy of
// scripts/push-guard.sh): with bops-secrets' private patterns at hand, a push to the public repo is refused when
// anything a new commit carries matches one, wherever in the commit it is: its message or another header (a
// merged tag's), a line it adds or takes out (one that starts with "++ " or "-- " too), a file's path (one
// added and taken out again in the same push too), a binary file's bytes (as text, as UTF-16 text, unpacked
// when compressed, and with an allowed phrase allowing only its own run of text), who wrote or committed it
// when that's someone the remote's history doesn't have yet, an annotated tag's name, message or tagger (a
// tag's under a tag's too), and the name a branch is pushed as. A compressed file it can't unpack is refused.
// What the remote has already, and the lines bops-secrets allows, pass; so does a push elsewhere. The public
// repo is the public repo however it's addressed (ssh.github.com, an SSH alias, a fork), and a shallow clone
// is checked too. It names the commit and never prints what matched. A hook installed long ago gives way to
// a newer one in the checkout that pushes, and setup leaves a newer one installed from elsewhere as it is.
//
// It runs in a throwaway clone of this repo (shared: no objects copied, nothing checked out) with made-up
// patterns of its own (BOPS_SECRETS points at a throwaway folder), and calls the hook as git would, without
// pushing anything anywhere.
// Usage: node scripts/test-push-guard.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-push-guard-"));
const clone = join(scratch, "clone");
const secrets = join(scratch, "secrets");
const index = join(scratch, "index");

// Made up: nothing here is anyone's.
const PATTERN = "Quorvex";
const PERSON = "Zed Ombra";
mkdirSync(join(secrets, "docs"), { recursive: true });
writeFileSync(join(secrets, "docs/private-patterns.txt"), `# made up for the test\n${PATTERN}\n\\b${PERSON}\\b\n`);
writeFileSync(join(secrets, "docs/public-allowed.txt"), `# made up for the test\nthanks to Quorvex Labs\n`);

const env = { ...process.env, BOPS_SECRETS: secrets, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Ava Lin", GIT_AUTHOR_EMAIL: "ava@example.test", GIT_COMMITTER_NAME: "Ava Lin", GIT_COMMITTER_EMAIL: "ava@example.test" };
for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(k)) delete env[k];
const git = (args, { input, extra = {} } = {}) => execFileSync("git", args, { cwd: clone, env: { ...env, ...extra }, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").join("\n  ")}`);
  }
}

try {
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", root, clone], { env, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  // The remote has this repo's HEAD (as a clone of the public repo would have its main).
  git(["update-ref", "refs/remotes/origin/base", head]);
  execFileSync("bash", [join(root, "scripts/setup.sh"), "--hook"], { cwd: clone, env, stdio: "pipe" });
  const hook = join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "hooks/pre-push");

  /** A commit on `parent`: `files` sets each path's bytes (null takes it out); `who` writes and commits it. */
  const commit = (parent, files, message, who) => {
    const extra = { GIT_INDEX_FILE: index, ...(who ? { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } : {}) };
    git(["read-tree", parent], { extra });
    for (const [path, bytes] of Object.entries(files)) {
      if (bytes === null) git(["update-index", "--force-remove", "--", path], { extra });
      else {
        const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: clone, env: { ...env, ...extra }, input: bytes }).toString().trim();
        git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { extra });
      }
    }
    const tree = git(["write-tree"], { extra });
    return git(["commit-tree", tree, "-p", parent, "-m", message], { extra });
  };
  /** The hook as git runs it before a push of `sha` to `url` (remote `remote`): its exit code and what it said. */
  const push = (sha, { url = "https://github.com/OrgoAI/bops.git", remote = "origin", ref = "refs/heads/feature", cwd = clone, run = hook, extra = {} } = {}) => {
    const r = spawnSync(run, [remote, url], { cwd, env: { ...env, ...extra }, input: `${ref} ${sha} ${ref} ${"0".repeat(40)}\n`, encoding: "utf8" });
    return { code: r.status, said: `${r.stdout}${r.stderr}` };
  };
  const short = (sha) => git(["rev-parse", "--short", sha]);
  const refused = (r, sha) => {
    assert.equal(r.code, 1, r.said);
    assert.match(r.said, new RegExp(`commit ${short(sha)} has \\d+ line`), r.said);
    assert.ok(!r.said.includes(PATTERN) && !r.said.includes(PERSON), "it never prints what matched");
  };

  await check("a commit with nothing private goes, and so does the history the remote has already", () => {
    const sha = commit(head, { "docs/notes.md": "Plain notes.\n" }, "Notes for Ava");
    assert.deepEqual(push(sha), { code: 0, said: "" });
    assert.equal(push(head).code, 0);
  });

  await check("a line it adds with a private detail is refused (as before), named by its commit", () => {
    const sha = commit(head, { "docs/notes.md": `Call ${PATTERN} on Monday.\n` }, "Notes");
    refused(push(sha), sha);
  });

  await check("so is one it takes out, and one in its message", () => {
    const add = commit(head, { "docs/notes.md": `Call ${PATTERN}.\n` }, "Notes");
    const out = commit(add, { "docs/notes.md": "Call later.\n" }, "Notes again");
    git(["update-ref", "refs/remotes/origin/had-it", add]);
    // The remote has the first: only the second is new, and it takes the line out.
    refused(push(out), out);
    const msg = commit(head, { "docs/notes.md": "Fine.\n" }, `Ask ${PATTERN} about it`);
    refused(push(msg), msg);
    git(["update-ref", "-d", "refs/remotes/origin/had-it"]);
  });

  await check("a line that starts with ++ or -- is a line like any other, not a file's header", () => {
    const plus = commit(head, { "docs/notes.md": `++ ${PATTERN}\n` }, "Notes");
    refused(push(plus), plus);
    const minus = commit(head, { "docs/notes.md": `-- ${PATTERN}\n` }, "Notes");
    refused(push(minus), minus);
  });

  await check("a file whose path has a private detail is refused, though no line in it does, and though the push takes it out again", () => {
    const add = commit(head, { [`docs/${PATTERN}-notes.md`]: "Plain.\n" }, "Notes");
    const gone = commit(add, { [`docs/${PATTERN}-notes.md`]: null }, "Tidy");
    const r = push(gone);
    refused(r, add);
    // Taking it out names the path too.
    refused(r, gone);
    // Renamed to it, or from it.
    const plain = commit(head, { "docs/plain.md": "Plain.\n" }, "Plain");
    git(["update-ref", "refs/remotes/origin/plain", plain]);
    const renamed = commit(plain, { "docs/plain.md": null, [`docs/${PATTERN}.md`]: "Plain.\n" }, "Rename");
    refused(push(renamed), renamed);
    git(["update-ref", "-d", "refs/remotes/origin/plain"]);
  });

  await check("a binary file holding a private detail is refused, though the push takes it out again", () => {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]), Buffer.from(`\n${PATTERN}\n`), Buffer.from([0x00, 0xff, 0x00])]);
    const add = commit(head, { "public/odd.bin": bytes }, "Picture");
    const gone = commit(add, { "public/odd.bin": null }, "No picture");
    const r = push(gone);
    refused(r, add);
    refused(r, gone);
  });

  await check("a commit by someone new whose name or address is private is refused; one by someone the remote's history has goes", () => {
    const sha = commit(head, { "docs/notes.md": "Plain.\n" }, "Notes", { name: PERSON, email: "zed@example.test" });
    refused(push(sha), sha);
    const mail = commit(head, { "docs/notes.md": "Plain.\n" }, "Notes", { name: "Max Hale", email: `${PATTERN}@example.test` });
    refused(push(mail), mail);
    // Already in the remote's history: public already.
    const known = commit(head, { "docs/a.md": "A.\n" }, "A", { name: PERSON, email: "zed@example.test" });
    git(["update-ref", "refs/remotes/origin/known", known]);
    const again = commit(known, { "docs/b.md": "B.\n" }, "B", { name: PERSON, email: "zed@example.test" });
    assert.equal(push(again).code, 0, push(again).said);
    git(["update-ref", "-d", "refs/remotes/origin/known"]);
  });

  await check("an annotated tag whose message has a private detail is refused", () => {
    const tag = git(["mktag"], { input: `object ${head}\ntype commit\ntag v9.9.9\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease for ${PATTERN}\n` });
    const r = push(tag, { ref: "refs/tags/v9.9.9" });
    assert.equal(r.code, 1, r.said);
    assert.ok(!r.said.includes(PATTERN));
    const fine = git(["mktag"], { input: `object ${head}\ntype commit\ntag v9.9.8\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease\n` });
    assert.equal(push(fine, { ref: "refs/tags/v9.9.8" }).code, 0);
    // Tagged by someone new whose name is private.
    const by = git(["mktag"], { input: `object ${head}\ntype commit\ntag v9.9.7\ntagger ${PERSON} <zed@example.test> 1700000000 +0000\n\nRelease\n` });
    assert.equal(push(by, { ref: "refs/tags/v9.9.7" }).code, 1);
  });

  await check("a branch pushed under a name with a private detail is refused", () => {
    const sha = commit(head, { "docs/notes.md": "Plain.\n" }, "Notes");
    const r = push(sha, { ref: `refs/heads/fix-${PATTERN}` });
    assert.equal(r.code, 1, r.said);
    assert.match(r.said, /the name it's pushed as has a private detail/);
  });

  await check("a line bops-secrets allows goes; so does a push anywhere but the public repo", () => {
    const allowed = commit(head, { "AUTHORS.md": "With thanks to Quorvex Labs for the font.\n" }, "Thanks");
    assert.equal(push(allowed).code, 0, push(allowed).said);
    const priv = commit(head, { "docs/notes.md": `Call ${PATTERN}.\n` }, "Notes");
    assert.equal(push(priv, { url: "git@github.com:OrgoAI/bops-secrets.git" }).code, 0);
    // To the public repo by its address rather than a remote's name: everything it adds is looked at still.
    refused(push(priv, { remote: "https://github.com/OrgoAI/bops.git" }), priv);
  });

  /** A zip of one file, its bytes deflated (as zip makes them). */
  const zipOf = (name, data) => {
    const body = deflateRawSync(data);
    const n = Buffer.from(name);
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + n.length, 12);
    end.writeUInt32LE(30 + n.length + body.length, 16);
    return Buffer.concat([local, n, body, central, n, end]);
  };
  const said = (r, what) => {
    assert.equal(r.code, 1, r.said);
    assert.match(r.said, what, r.said);
    assert.ok(!r.said.includes(PATTERN) && !r.said.includes(PERSON), "it never prints what matched");
  };

  await check("an annotated tag of a tag is read all the way down: the inner one's message, and a tag's own name", () => {
    const inner = git(["mktag"], { input: `object ${head}\ntype commit\ntag v9.8.1\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease for ${PATTERN}\n` });
    const outer = git(["mktag"], { input: `object ${inner}\ntype tag\ntag v9.8.2\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease\n` });
    said(push(outer, { ref: "refs/tags/v9.8.2" }), new RegExp(`its tag ${short(inner)} has 1 line`));
    const plainInner = git(["mktag"], { input: `object ${head}\ntype commit\ntag v9.8.3\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease\n` });
    const plainOuter = git(["mktag"], { input: `object ${plainInner}\ntype tag\ntag v9.8.4\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease\n` });
    assert.equal(push(plainOuter, { ref: "refs/tags/v9.8.4" }).code, 0);
    // Pushed as a plain name, though the tag itself is named otherwise (that name goes public too).
    const named = git(["mktag"], { input: `object ${head}\ntype commit\ntag ${PATTERN}-1\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease\n` });
    said(push(named, { ref: "refs/tags/v9.8.5" }), /in its name, message or tagger/);
    // A tag of a file is no history.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: clone, env, input: "Plain.\n" }).toString().trim();
    const ofBlob = git(["mktag"], { input: `object ${blob}\ntype blob\ntag v9.8.6\ntagger Ava Lin <ava@example.test> 1700000000 +0000\n\nRelease\n` });
    said(push(ofBlob, { ref: "refs/tags/v9.8.6" }), /isn't OrgoAI\/bops's history/);
  });

  await check("a merge's merged tag (its mergetag header) is read too, and its signature isn't", () => {
    const side = commit(head, { "docs/side.md": "Side.\n" }, "Side");
    git(["update-ref", "refs/remotes/origin/side", side]);
    const tree = git(["rev-parse", `${side}^{tree}`]);
    const raw = (msg) =>
      `tree ${tree}\nparent ${head}\nparent ${side}\nauthor Ava Lin <ava@example.test> 1700000000 +0000\ncommitter Ava Lin <ava@example.test> 1700000000 +0000\nmergetag object ${side}\n type commit\n tag v9.7.0\n tagger Ava Lin <ava@example.test> 1700000000 +0000\n \n ${msg}\n -----BEGIN PGP SIGNATURE-----\n ${PATTERN}AAAA\n -----END PGP SIGNATURE-----\n\nMerge tag 'v9.7.0'\n`;
    const bad = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: clone, env, input: raw(`Release for ${PATTERN}`) }).toString().trim();
    refused(push(bad), bad);
    const fine = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: clone, env, input: raw("Release") }).toString().trim();
    assert.equal(push(fine).code, 0, push(fine).said);
    git(["update-ref", "-d", "refs/remotes/origin/side"]);
  });

  await check("a binary file's text is read as UTF-16 too, while it's there and once it's taken out", () => {
    for (const enc of ["utf16le", "utf16be"]) {
      const text = `"greeting" = "Hello ${PATTERN}";\n`;
      const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
      const bytes = enc === "utf16le" ? le : Buffer.from(le).swap16();
      const add = commit(head, { "desktop/Localizable.strings": bytes }, "Strings");
      refused(push(add), add);
      git(["update-ref", "refs/remotes/origin/had-it", add]);
      const gone = commit(add, { "desktop/Localizable.strings": null }, "No strings");
      refused(push(gone), gone);
      git(["update-ref", "-d", "refs/remotes/origin/had-it"]);
    }
    const plain = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`"greeting" = "Hello Ava";\n`, "utf16le")]);
    const fine = commit(head, { "desktop/Localizable.strings": plain }, "Strings");
    assert.equal(push(fine).code, 0, push(fine).said);
  });

  await check("a compressed file is read unpacked (gzip, zip), and one it can't unpack is refused", () => {
    const text = Buffer.from(`notes\nCall ${PATTERN} on Monday.\n`);
    const gz = commit(head, { "docs/notes.txt.gz": gzipSync(text) }, "Notes");
    said(push(gz), new RegExp(`commit ${short(gz)} has \\d+ line\\(s\\) in a binary file's text`));
    git(["update-ref", "refs/remotes/origin/had-it", gz]);
    const gone = commit(gz, { "docs/notes.txt.gz": null }, "No notes");
    said(push(gone), new RegExp(`commit ${short(gone)} has \\d+ line\\(s\\) in a binary file's text`));
    git(["update-ref", "-d", "refs/remotes/origin/had-it"]);
    const zip = commit(head, { "docs/notes.zip": zipOf("notes.txt", Buffer.concat([text, Buffer.from("more notes\n".repeat(20))])) }, "Notes");
    said(push(zip), new RegExp(`commit ${short(zip)} has \\d+ line\\(s\\) in a binary file's text|commit ${short(zip)} has a compressed file this check can't unpack`));
    // A kind it has no tool for (7z), or an archive broken off: it can't tell what's in it.
    const sevenZ = commit(head, { "docs/notes.7z": Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]), Buffer.alloc(64, 7)]) }, "Notes");
    said(push(sevenZ), new RegExp(`commit ${short(sevenZ)} has a compressed file this check can't unpack`));
    const broken = commit(head, { "docs/notes.txt.gz": gzipSync(text).subarray(0, 20) }, "Notes");
    said(push(broken), /a compressed file this check can't unpack/);
    // Nothing private in it: it goes, and so does a picture.
    const fine = commit(head, { "docs/plain.txt.gz": gzipSync(Buffer.from("Plain notes for Ava.\n")), "public/pic.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), Buffer.alloc(200, 3)]) }, "Notes");
    assert.equal(push(fine).code, 0, push(fine).said);
  });

  await check("in a binary file an allowed phrase allows only its own run of text, not the private detail beside it", () => {
    const bytes = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from("With thanks to Quorvex Labs"), Buffer.from([0x00, 0x02]), Buffer.from(PATTERN), Buffer.from([0x00, 0xff])]);
    const add = commit(head, { "public/odd.bin": bytes }, "Picture");
    const gone = commit(add, { "public/odd.bin": null }, "No picture");
    const r = push(gone);
    said(r, new RegExp(`commit ${short(add)} has \\d+ line\\(s\\) in a binary file's text`));
    said(r, new RegExp(`commit ${short(gone)} has \\d+ line\\(s\\) in a binary file's text`));
    const alone = commit(head, { "public/odd.bin": Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from("With thanks to Quorvex Labs"), Buffer.from([0x00, 0xff])]) }, "Picture");
    assert.equal(push(alone).code, 0, push(alone).said);
  });

  await check("the public repo is the public repo however it's addressed: ssh.github.com's port 443, an SSH alias, a fork", () => {
    const priv = commit(head, { "docs/notes.md": `Call ${PATTERN}.\n` }, "Notes");
    // A stand-in ssh: what `ssh -G <alias>` says of each alias.
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\n[ "$1" = -G ] || exit 255\ncase "$2" in github-orgo) echo "hostname ssh.github.com" ;; gitlab-work) echo "hostname gitlab.example.test" ;; *) echo "hostname $2" ;; esac\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const extra = { PATH: `${bin}:${process.env.PATH}` };
    for (const url of ["git@github-orgo:OrgoAI/bops.git", "ssh://git@ssh.github.com:443/OrgoAI/bops.git", "ssh://git@github.com/OrgoAI/bops", "https://x:y@GitHub.com:443/orgoai/BOPS.git/", "git@github.com:ava-lin/bops.git", "https://github.com/OrgoAI/bops-oss"])
      refused(push(priv, { url, extra }), priv);
    for (const url of ["git@gitlab-work:OrgoAI/bops.git", "git@github.com:OrgoAI/bops-secrets.git", "https://gitlab.example.test/OrgoAI/bops.git", "/tmp/OrgoAI/bops"]) assert.equal(push(priv, { url, extra }).code, 0, url);
  });

  await check("a shallow clone is checked too: only the history check is skipped", () => {
    const shallow = join(scratch, "shallow");
    execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", root, shallow], { env, stdio: "pipe" });
    const sh = (args, input) => execFileSync("git", args, { cwd: shallow, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    sh(["update-ref", "refs/remotes/origin/base", head]);
    writeFileSync(join(sh(["rev-parse", "--path-format=absolute", "--git-dir"]), "shallow"), `${head}\n`);
    assert.equal(sh(["rev-parse", "--is-shallow-repository"]), "true");
    execFileSync("bash", [join(root, "scripts/setup.sh"), "--hook"], { cwd: shallow, env, stdio: "pipe" });
    const shallowHook = join(sh(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "hooks/pre-push");
    const sha = sh(["commit-tree", sh(["rev-parse", `${head}^{tree}`]), "-p", head, "-m", `Ask ${PATTERN} about it`]);
    const r = push(sha, { cwd: shallow, run: shallowHook });
    assert.equal(r.code, 1, r.said);
    assert.match(r.said, /has 1 line\(s\) in its message/);
    const fine = sh(["commit-tree", sh(["rev-parse", `${head}^{tree}`]), "-p", head, "-m", "Notes"]);
    assert.equal(push(fine, { cwd: shallow, run: shallowHook }).code, 0);
  });

  await check("an older hook gives way to the newer one in the checkout that pushes, and setup leaves a newer one installed as it is", () => {
    const real = readFileSync(join(root, "scripts/push-guard.sh"), "utf8");
    const version = Number(/^guard_version=(\d+)$/m.exec(real)[1]);
    // Installed long ago: it lets everything through.
    const old = real.replace(/^guard_version=\d+$/m, "guard_version=1").replace(/^lower\(\) \{/m, "exit 0\nlower() {");
    writeFileSync(hook, old);
    const priv = commit(head, { "docs/notes.md": `Call ${PATTERN}.\n` }, "Notes");
    assert.equal(push(priv).code, 0, "the old one, alone, lets it through");
    mkdirSync(join(clone, "scripts"), { recursive: true });
    writeFileSync(join(clone, "scripts/push-guard.sh"), real);
    refused(push(priv), priv);
    assert.equal(readFileSync(hook, "utf8"), real, "the newer one is installed");
    rmSync(join(clone, "scripts"), { recursive: true, force: true });
    refused(push(priv), priv);
    // Setup never puts an older one over a newer one.
    const newer = real.replace(/^guard_version=\d+$/m, `guard_version=${version + 1}`);
    writeFileSync(hook, newer);
    execFileSync("bash", [join(root, "scripts/setup.sh"), "--hook"], { cwd: clone, env, stdio: "pipe" });
    assert.equal(readFileSync(hook, "utf8"), newer);
    writeFileSync(hook, old);
    execFileSync("bash", [join(root, "scripts/setup.sh"), "--hook"], { cwd: clone, env, stdio: "pipe" });
    assert.equal(readFileSync(hook, "utf8"), real);
  });

  await check("macOS's own bash runs it", () => {
    if (spawnSync("/bin/bash", ["-c", "true"]).status !== 0) return;
    const priv = commit(head, { "docs/notes.md": `Call ${PATTERN}.\n` }, "Notes");
    const r = spawnSync("/bin/bash", [hook, "origin", "https://github.com/OrgoAI/bops.git"], { cwd: clone, env, input: `refs/heads/feature ${priv} refs/heads/feature ${"0".repeat(40)}\n`, encoding: "utf8" });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    const fine = commit(head, { "docs/notes.md": "Plain.\n", "public/pic.bin": Buffer.from([0, 1, 2, 3]) }, "Notes");
    const ok = spawnSync("/bin/bash", [hook, "origin", "https://github.com/OrgoAI/bops.git"], { cwd: clone, env, input: `refs/heads/feature ${fine} refs/heads/feature ${"0".repeat(40)}\n`, encoding: "utf8" });
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
