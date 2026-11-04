// Tests for an app whose production is on GitHub (lib/server/github-mirror.ts): Publish carries what changed in Ingot
// since the last point to one commit on top of the branch, inside the app's folder only (never what's outside it, the
// app's `keep` files, or GitHub's symbolic links), after bringing what changed on GitHub since then into Ingot; a file
// both changed to other bytes, or one too big to send, stops it with nothing written; someone pushing meanwhile stops
// it too; a named workflow runs after a push; and linking takes both sides as they are.
//
// Ingot and GitHub (through Orgo's key broker) are fakes in memory below. The repo and its files are made up.
// Usage: node --conditions=react-server scripts/test-github-mirror.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FAKES = { ingot: ["ingot"], keys: ["callKey", "KeysError", "keyProjectFor", "listKeys"] };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (name === "ingot") return { format: "module", shortCircuit: true, source: `export const ingot = new Proxy({}, { get: (_, k) => (...a) => globalThis.__fake.ingot[k](...a) });` + unfaked(name, url, FAKES.ingot) };
    if (name === "keys")
      return {
        format: "module",
        shortCircuit: true,
        source:
          `export class KeysError extends Error { constructor(m, status) { super(m); this.status = status; } }\n` +
          `export const callKey = (...a) => globalThis.__fake.callKey(...a);\nexport const keyProjectFor = () => undefined;\nexport const listKeys = async () => [];` +
          unfaked(name, url, FAKES.keys),
      };
    return next(url, context);
  },
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 6).join("\n  ") ?? e.message}`);
  }
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const gitSha = (b) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const B = (t) => Buffer.from(t);

/* ---------- A fake GitHub: commits of whole file maps, trees and blobs by id, as the git data API answers them ---------- */
function makeGithub(files) {
  const gh = { blobs: new Map(), trees: new Map(), commits: new Map(), head: "", calls: [], moveFails: false, dispatched: [] };
  const blob = (b) => {
    const id = gitSha(b);
    gh.blobs.set(id, b);
    return id;
  };
  const commit = (map, parent) => {
    const id = sha1(`c${gh.commits.size}${Math.random()}`);
    const rootTree = sha1(`t${id}`);
    gh.trees.set(rootTree, { files: map, dir: "" });
    gh.commits.set(id, { files: map, tree: rootTree, parent });
    return id;
  };
  gh.commit = (entries, parent) => {
    const map = new Map();
    for (const [p, v] of Object.entries(entries))
      map.set(p, typeof v === "object" && v.link ? { sha: blob(B(v.link)), mode: "120000" } : { sha: blob(B(typeof v === "object" ? v.text : v)), mode: (typeof v === "object" && v.mode) || "100644" });
    return commit(map, parent);
  };
  /** Someone commits on GitHub: some paths changed (null: deleted). */
  gh.push = (changes) => {
    const map = new Map(gh.commits.get(gh.head).files);
    for (const [p, v] of Object.entries(changes)) {
      if (v === null) map.delete(p);
      else map.set(p, { sha: blob(B(v)), mode: "100644" });
    }
    gh.head = commit(map, gh.head);
    return gh.head;
  };
  gh.files = (sha = gh.head) => new Map([...gh.commits.get(sha).files].map(([p, f]) => [p, f.mode === "120000" ? { link: true } : gh.blobs.get(f.sha).toString()]));
  const listDir = (map, dir, recursive) => {
    const pre = dir ? `${dir}/` : "";
    const out = [];
    const seen = new Set();
    for (const [p, f] of map) {
      if (!p.startsWith(pre)) continue;
      const rest = p.slice(pre.length);
      if (recursive) out.push({ path: rest, type: "blob", mode: f.mode, sha: f.sha, size: gh.blobs.get(f.sha).length });
      else {
        const [first, ...more] = rest.split("/");
        if (!more.length) out.push({ path: first, type: "blob", mode: f.mode, sha: f.sha });
        else if (!seen.has(first)) {
          seen.add(first);
          const id = sha1(`d${p}${Math.random()}`);
          gh.trees.set(id, { files: map, dir: pre + first });
          out.push({ path: first, type: "tree", mode: "040000", sha: id });
        }
      }
    }
    return out;
  };
  gh.call = async ({ method, path, body, query }) => {
    gh.calls.push(`${method} ${path.replace(/\/repos\/[^/]+\/[^/]+/, "")}`);
    const ok = (b, status = 200) => ({ status, contentType: "application/json", body: b, truncated: false, headers: {} });
    let m;
    if (method === "GET" && (m = /\/git\/ref\/heads\/(.+)$/.exec(path))) return m[1] === "main" ? ok({ object: { sha: gh.head } }) : ok({ message: "Not Found" }, 404);
    if (method === "GET" && (m = /\/git\/commits\/([0-9a-f]+)$/.exec(path))) return ok({ tree: { sha: gh.commits.get(m[1]).tree } });
    if (method === "GET" && (m = /\/git\/trees\/([0-9a-f]+)$/.exec(path))) {
      const t = gh.trees.get(m[1]);
      return ok({ tree: listDir(t.files, t.dir, query?.recursive === "1"), truncated: false });
    }
    if (method === "GET" && (m = /\/git\/blobs\/([0-9a-f]+)$/.exec(path))) return ok({ content: gh.blobs.get(m[1]).toString("base64"), encoding: "base64" });
    if (method === "GET" && (m = /\/contents\/(.+)$/.exec(path))) {
      const full = decodeURIComponent(m[1]);
      const f = gh.commits.get(query.ref).files.get(full);
      return ok({ download_url: `https://raw.fake.example/${f.sha}?token=short-lived` });
    }
    if (method === "POST" && path.endsWith("/git/blobs")) return ok({ sha: blob(Buffer.from(body.content, "base64")) }, 201);
    if (method === "POST" && path.endsWith("/git/trees")) {
      const base = gh.trees.get(body.base_tree).files;
      const map = new Map(base);
      for (const e of body.tree) {
        if (e.sha === null) map.delete(e.path);
        else map.set(e.path, { sha: e.sha, mode: e.mode });
      }
      const id = sha1(`n${Math.random()}`);
      gh.trees.set(id, { files: map, dir: "" });
      return ok({ sha: id }, 201);
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      const id = commit(gh.trees.get(body.tree).files, body.parents[0]);
      gh.commits.get(id).message = body.message;
      return ok({ sha: id }, 201);
    }
    if (method === "PATCH" && /\/git\/refs\/heads\//.test(path)) {
      if (gh.moveFails || gh.commits.get(body.sha).parent !== gh.head) return ok({ message: "Update is not a fast forward" }, 422);
      gh.head = body.sha;
      return ok({ object: { sha: body.sha } });
    }
    if (method === "POST" && /\/actions\/workflows\/.+\/dispatches$/.test(path)) {
      gh.dispatched.push({ path, body });
      return { status: 204, contentType: null, body: null, truncated: false, headers: {} };
    }
    throw new Error(`fake GitHub has no ${method} ${path}`);
  };
  gh.head = gh.commit(files);
  return gh;
}

/* ---------- A fake Ingot: changesets of whole file maps; commit on top of main, stale when main moved ---------- */
function makeIngot(files) {
  const ig = { sets: new Map(), head: "", commits: [] };
  const make = (map) => {
    const id = sha1(`i${ig.sets.size}${Math.random()}`).slice(0, 32);
    ig.sets.set(id, map);
    ig.head = id;
    return id;
  };
  ig.change = (changes) => {
    const map = new Map(ig.sets.get(ig.head));
    for (const [p, v] of Object.entries(changes)) {
      if (v === null) map.delete(p);
      else map.set(p, { b: B(typeof v === "object" ? v.text : v), x: typeof v === "object" && !!v.x });
    }
    return make(map);
  };
  ig.files = (at = ig.head) => new Map([...ig.sets.get(at)].map(([p, f]) => [p, f.b.toString()]));
  make(new Map(Object.entries(files).map(([p, t]) => [p, { b: B(t), x: false }])));
  ig.api = {
    head: async () => ig.head,
    tree: async (_ws, _n, at) => (ig.sets.has(at) ? [...ig.sets.get(at)].map(([path, f]) => ({ path, blob: sha256(f.b), size: f.b.length, executable: f.x })) : null),
    manifest: async (_ws, _n, at) => [...ig.sets.get(at)].map(([path, f]) => ({ path, blob: sha256(f.b), size: f.b.length, executable: f.x, url: `data:application/octet-stream;base64,${f.b.toString("base64")}` })),
    commit: async (_ws, _n, c, author) => {
      ig.commits.push({ ...c, author });
      if (c.base !== ig.head) return { stale: ig.head };
      const map = new Map(ig.sets.get(ig.head));
      for (const ch of c.changes) {
        if (ch.delete) map.delete(ch.path);
        else map.set(ch.path, { b: Buffer.from(ch.content_base64, "base64"), x: !!ch.executable });
      }
      return { id: make(map) };
    },
  };
  return ig;
}

let gh, ig;
// GitHub's own download links (raw.fake.example) are served from the fake's blobs; anything else (Ingot's data: links) as ever.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const m = /^https:\/\/raw\.fake\.example\/([0-9a-f]+)/.exec(String(url));
  if (m) return new Response(gh.blobs.get(m[1]));
  return realFetch(url, init);
};
const reset = (ghFiles, igFiles) => {
  gh = makeGithub(ghFiles);
  ig = makeIngot(igFiles);
  globalThis.__fake = { ingot: ig.api, callKey: (c) => gh.call(c) };
};
reset({ a: "1" }, { a: "1" });
const { mirrorPublish, linkMirror, keptPath, gitSha: ourGitSha, MirrorError, BLOB_MAX } = await import(`${root}/lib/server/github-mirror.ts`);
const { cleanGithubMirror } = await import(`${root}/lib/hosted-apps.ts`);

// The BrandLord shape: the app is the formula/ folder; the rest of the repo is the server's and its secrets'.
const GH0 = {
  ".github/workflows/deploy-formula.yml": "on: push",
  "envs/prod/web-secrets.env": "ENC[...]",
  "formula/AGENTS.md": "agents v1",
  "formula/CLAUDE.md": { link: "AGENTS.md" },
  "formula/lib/look.ts": "orange",
  "formula/clients/fourcorners/client.json": '{"autoDeploy":true}',
  "formula/old.ts": "old",
};
const IG0 = {
  ".ingotignore": "node_modules",
  "AGENTS.md": "agents v1",
  "CLAUDE.md": "agents v1",
  "proxy.ts": "preview password",
  "lib/look.ts": "orange",
  "clients/fourcorners/client.json": '{"autoDeploy":true}',
  "old.ts": "old",
};
const CFG = (last, more = {}) => ({ repo: "OrgoAI/orgo-brandlord", branch: "main", path: "formula", keep: ["proxy.ts"], ...more, ...(last ? { last } : {}) });
const linkNow = async (cfg = CFG()) => linkMirror("ws_1", "fourcorners", cfg);
const writes = () => gh.calls.filter((c) => !c.startsWith("GET"));

await check("not linked yet: nothing happens, and it says to link it", async () => {
  reset(GH0, IG0);
  await assert.rejects(mirrorPublish("ws_1", "fourcorners", ig.head, CFG(), "bops; Bops"), (e) => e instanceof MirrorError && e.extra?.code === "NOT_LINKED");
  assert.deepEqual(gh.calls, []);
});

await check("linking takes both sides as they are now", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  assert.equal(last.at, ig.head);
  assert.equal(last.sha, gh.head);
  assert.deepEqual(writes(), []);
});

await check("Ingot's changes go to GitHub: one commit on top of the branch, its folder only; kept files and links stay", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  const before = gh.head;
  const at = ig.change({ "lib/look.ts": "logo orange", "clients/fourcorners/brochure.ts": { text: "new", x: true }, "old.ts": null, "proxy.ts": "other password", "CLAUDE.md": "changed copy" });
  const done = await mirrorPublish("ws_1", "fourcorners", at, CFG(last), "bops; Bops");
  const files = gh.files();
  assert.equal(files.get("formula/lib/look.ts"), "logo orange");
  assert.equal(files.get("formula/clients/fourcorners/brochure.ts"), "new");
  assert.equal(gh.commits.get(gh.head).files.get("formula/clients/fourcorners/brochure.ts").mode, "100755", "executable stays executable");
  assert.ok(!files.has("formula/old.ts"), "a file deleted in Ingot is deleted there");
  assert.ok(!files.has("formula/proxy.ts"), "a kept file never goes");
  assert.deepEqual(files.get("formula/CLAUDE.md"), { link: true }, "GitHub's link stays a link");
  assert.equal(files.get("envs/prod/web-secrets.env"), "ENC[...]", "outside the folder: untouched");
  assert.equal(files.get(".github/workflows/deploy-formula.yml"), "on: push");
  assert.ok(!files.has("formula/.ingotignore"));
  assert.equal(gh.commits.get(gh.head).parent, before, "on top of the branch, never forced");
  assert.match(gh.commits.get(gh.head).message, new RegExp(`Ingot-Changeset: ${at}`));
  assert.deepEqual(done.last, { at, sha: gh.head, when: done.last.when });
  assert.equal(done.pushed.files, 3);
  assert.equal(done.brought, 0);
  assert.match(done.said, /Pushed 3 files to OrgoAI\/orgo-brandlord main .*GitHub deploys it/);
  assert.equal(ig.commits.length, 0, "nothing written to Ingot");
});

await check("GitHub's changes come into Ingot first; with nothing new in Ingot, nothing is pushed", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  gh.push({ "formula/lib/look.ts": "teal", "formula/clients/cclc/deck.ts": "deck", "formula/old.ts": null, "README.md": "outside" });
  const head = gh.head;
  const done = await mirrorPublish("ws_1", "fourcorners", last.at, CFG(last), "bops; Bops");
  const files = ig.files();
  assert.equal(files.get("lib/look.ts"), "teal");
  assert.equal(files.get("clients/cclc/deck.ts"), "deck");
  assert.ok(!files.has("old.ts"));
  assert.ok(!files.has("README.md"), "outside the folder isn't the app's");
  assert.equal(files.get("proxy.ts"), "preview password", "a kept file stays as Ingot has it");
  assert.equal(ig.commits.length, 1);
  assert.match(ig.commits[0].message, /^From GitHub: 3 files changed on OrgoAI\/orgo-brandlord main/);
  assert.equal(gh.head, head, "no commit on GitHub");
  assert.equal(done.pushed, null);
  assert.equal(done.brought, 3);
  assert.equal(done.last.at, ig.head, "Ingot's point is the changeset with GitHub's changes in");
  assert.equal(done.last.sha, head);
  assert.match(done.said, /Brought 3 changes from GitHub into Ingot first\. GitHub already has everything/);
});

await check("both at once: GitHub's in first, Ingot's out after, and the next one doesn't trip on what came in", async () => {
  reset(GH0, IG0);
  let last = await linkNow();
  gh.push({ "formula/clients/cclc/deck.ts": "deck" });
  const at = ig.change({ "lib/look.ts": "logo orange" });
  let done = await mirrorPublish("ws_1", "fourcorners", at, CFG(last), "bops; Bops");
  assert.equal(gh.files().get("formula/lib/look.ts"), "logo orange");
  assert.equal(gh.files().get("formula/clients/cclc/deck.ts"), "deck");
  assert.equal(ig.files().get("clients/cclc/deck.ts"), "deck");
  last = done.last;
  // GitHub changes the file that came in again; Ingot changes something else.
  gh.push({ "formula/clients/cclc/deck.ts": "deck v2" });
  const at2 = ig.change({ "AGENTS.md": "agents v2" });
  done = await mirrorPublish("ws_1", "fourcorners", at2, CFG(last), "bops; Bops");
  assert.equal(gh.files().get("formula/AGENTS.md"), "agents v2");
  assert.equal(ig.files().get("clients/cclc/deck.ts"), "deck v2");
});

await check("a file both changed to other bytes stops it, with nothing written on either side", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  gh.push({ "formula/lib/look.ts": "teal" });
  const ghHead = gh.head;
  const at = ig.change({ "lib/look.ts": "logo orange" });
  await assert.rejects(mirrorPublish("ws_1", "fourcorners", at, CFG(last), "bops; Bops"), (e) => e.extra?.code === "BOTH_CHANGED" && e.extra.paths.join() === "lib/look.ts" && /Both Ingot and GitHub changed lib\/look\.ts/.test(e.message));
  assert.equal(gh.head, ghHead);
  assert.deepEqual(writes(), []);
  assert.equal(ig.commits.length, 0);
  // Changed to the same bytes on both: nothing to carry, no stop.
  reset(GH0, IG0);
  const l2 = await linkNow();
  gh.push({ "formula/lib/look.ts": "same" });
  const at2 = ig.change({ "lib/look.ts": "same" });
  const done = await mirrorPublish("ws_1", "fourcorners", at2, CFG(l2), "bops; Bops");
  assert.equal(done.pushed, null);
  assert.equal(done.brought, 0);
  // Deleted on one side, changed on the other: a stop too.
  reset(GH0, IG0);
  const l3 = await linkNow();
  gh.push({ "formula/old.ts": "changed there" });
  const at3 = ig.change({ "old.ts": null });
  await assert.rejects(mirrorPublish("ws_1", "fourcorners", at3, CFG(l3), "bops; Bops"), (e) => e.extra?.code === "BOTH_CHANGED");
});

await check("a file too big to send stops it before anything is written", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  const at = ig.change({ "clients/cclc/photo.jpeg": "x".repeat(BLOB_MAX + 1), "lib/look.ts": "logo orange" });
  await assert.rejects(mirrorPublish("ws_1", "fourcorners", at, CFG(last), "bops; Bops"), (e) => e.extra?.code === "TOO_BIG" && /photo\.jpeg/.test(e.message) && /Nothing was published/.test(e.message));
  assert.deepEqual(writes(), []);
});

await check("a big file GitHub changed comes down by GitHub's own link, checked", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  gh.push({ "formula/clients/cclc/sample.pdf": "p".repeat(400_000) });
  const done = await mirrorPublish("ws_1", "fourcorners", last.at, CFG(last), "bops; Bops");
  assert.equal(ig.files().get("clients/cclc/sample.pdf").length, 400_000);
  assert.ok(gh.calls.some((c) => c.startsWith("GET /contents/formula/clients/cclc/sample.pdf")));
  assert.equal(done.brought, 1);
});

await check("someone pushing to the branch meanwhile stops it, saying to publish again", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  const at = ig.change({ "lib/look.ts": "logo orange" });
  gh.moveFails = true;
  await assert.rejects(mirrorPublish("ws_1", "fourcorners", at, CFG(last), "bops; Bops"), (e) => e.extra?.code === "GITHUB_MOVED" && /Publish again/.test(e.message));
});

await check("a named workflow runs after a push (a client that doesn't deploy on a push), never without one", async () => {
  reset(GH0, IG0);
  const last = await linkNow();
  const cfg = CFG(last, { dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc" } } });
  let done = await mirrorPublish("ws_1", "cclc", last.at, cfg, "bops; Bops");
  assert.equal(gh.dispatched.length, 0, "nothing pushed, nothing run");
  const at = ig.change({ "clients/fourcorners/client.json": '{"autoDeploy":false}' });
  done = await mirrorPublish("ws_1", "cclc", at, { ...cfg, last: done.last }, "bops; Bops");
  assert.equal(gh.dispatched.length, 1);
  assert.deepEqual(gh.dispatched[0].body, { ref: "main", inputs: { client: "cclc" } });
  assert.match(done.said, /Started deploy-formula\.yml on GitHub\./);
});

await check("the whole repo as the folder, a nested folder, and a branch with a slash", async () => {
  reset({ "x.ts": "1", "deep/a/b.ts": "2" }, { "x.ts": "1", "deep/a/b.ts": "2" });
  const last = await linkNow(CFG(undefined, { path: "" }));
  const at = ig.change({ "x.ts": "changed" });
  await mirrorPublish("ws_1", "app", at, CFG(last, { path: "" }), "bops; Bops");
  assert.equal(gh.files().get("x.ts"), "changed");
  reset({ "deep/a/b.ts": "2", "deep/z.ts": "3" }, { "b.ts": "2" });
  const l2 = await linkNow(CFG(undefined, { path: "deep/a" }));
  const at2 = ig.change({ "b.ts": "changed" });
  await mirrorPublish("ws_1", "app", at2, CFG(l2, { path: "deep/a" }), "bops; Bops");
  assert.equal(gh.files().get("deep/a/b.ts"), "changed");
  assert.equal(gh.files().get("deep/z.ts"), "3");
  await assert.rejects(linkMirror("ws_1", "app", CFG(undefined, { branch: "release/1" })), /no branch release\/1/);
});

await check("kept paths: a file, a folder, and always .ingotignore", () => {
  assert.ok(keptPath(".ingotignore"));
  assert.ok(keptPath("proxy.ts", ["proxy.ts"]));
  assert.ok(keptPath("notes/a.md", ["notes/"]));
  assert.ok(!keptPath("notes.md", ["notes/"]));
  assert.ok(!keptPath("lib/proxy.ts", ["proxy.ts"]));
  assert.equal(ourGitSha(B("hello")), gitSha(B("hello")));
});

await check("the setting as the window sends it: cleaned, or why not", () => {
  assert.deepEqual(cleanGithubMirror({ repo: "https://github.com/OrgoAI/orgo-brandlord.git", branch: "", path: "/formula/", keep: ["proxy.ts", " notes/ ", "proxy.ts", "../x"], dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc", "bad key": "x" } } }), {
    ok: { repo: "OrgoAI/orgo-brandlord", branch: "main", path: "formula", keep: ["proxy.ts", "notes/"], dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc" } } },
  });
  assert.match(cleanGithubMirror({ repo: "nope" }).why, /Which GitHub repo/);
  assert.match(cleanGithubMirror({ repo: "a/b", branch: "../x" }).why, /branch/);
  assert.match(cleanGithubMirror({ repo: "a/b", path: "../etc" }).why, /folder/);
  assert.match(cleanGithubMirror({ repo: "a/b", dispatch: { workflow: "rm -rf" } }).why, /workflow/);
  assert.ok(!("last" in cleanGithubMirror({ repo: "a/b", last: { at: "x", sha: "y" } }).ok), "the window never sets last");
});

console.log(`github mirror: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
