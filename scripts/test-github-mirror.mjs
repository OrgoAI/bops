// Tests for an app whose production is on GitHub (lib/server/github-mirror.ts), everything compared by what's in the
// files against GitHub's folder at the point: Publish carries the preview's differences to one commit on top of the
// branch, inside the app's folder only (never what's outside it, its `keep` paths, GitHub's symbolic links), after
// bringing GitHub's changes into Ingot; what came from GitHub is never pushed back undone (a preview older than the
// point is refused) and never trips a later Publish; a file both changed, or newer work in Ingot on a file GitHub
// changed, stops it with nothing written, until Bring in takes GitHub's version; a file too big to send stops it,
// but only one that would be sent; a folder gone or mostly deleted stops it; someone pushing meanwhile stops it; a
// named workflow runs after a push; Link only takes two sides with the same files; each Ingot file is read once.
//
// Ingot and GitHub (through Orgo's key broker) are fakes in memory below. The repo and its files are made up.
// Usage: node --conditions=react-server scripts/test-github-mirror.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FAKES = { ingot: ["ingot"], keys: ["callKey", "KeysError", "keyProjectFor", "listKeys"], store: ["userDir"] };
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
    if (name === "store") return { format: "module", shortCircuit: true, source: `export const userDir = () => globalThis.__fake.userDir;` + unfaked(name, url, FAKES.store) };
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
  /** Someone commits on GitHub: some paths changed (null: deleted; { link }: a symbolic link). */
  gh.push = (changes) => {
    const map = new Map(gh.commits.get(gh.head).files);
    for (const [p, v] of Object.entries(changes)) {
      if (v === null) map.delete(p);
      else if (typeof v === "object" && v.link) map.set(p, { sha: blob(B(v.link)), mode: "120000" });
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
  gh.call = async (c) => {
    try {
      return await gh.raw(c);
    } catch (e) {
      // What keys.ts callKey does when the broker didn't answer.
      throw new (await import(`${root}/lib/server/keys.ts`)).KeysError(`GitHub didn't answer (${e.message}).`, 502);
    }
  };
  gh.raw = async ({ method, path, body, query }) => {
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
    if (method === "GET" && (m = /\/contents\/?(.*)$/.exec(path))) {
      const at = m[1].split("/").map(decodeURIComponent).join("/");
      const files = gh.commits.get(query.ref).files;
      const link = (f) => `https://raw.fake.example/${f.sha}?token=short-lived`;
      // A file's own entry: its bytes inline up to 1 MB (GitHub's rule), else its link alone; the broker cuts an answer over 512 KB.
      if (files.has(at)) {
        const f = files.get(at);
        const b = gh.blobs.get(f.sha);
        const body = b.length <= 1024 * 1024 ? { sha: f.sha, encoding: "base64", content: b.toString("base64"), download_url: link(f) } : { sha: f.sha, encoding: "none", content: "", download_url: link(f) };
        return { ...ok(body), truncated: JSON.stringify(body).length > 512 * 1024 };
      }
      const pre = at ? `${at}/` : "";
      const entries = [...files].filter(([p]) => p.startsWith(pre) && !p.slice(pre.length).includes("/"));
      return ok(entries.map(([p, f]) => ({ name: p.slice(pre.length), path: p, sha: f.sha, size: gh.blobs.get(f.sha).length, type: "file", download_url: link(f) })));
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
      if (gh.beforeMove) gh.beforeMove();
      if (gh.moveFails || gh.commits.get(body.sha).parent !== gh.head) return ok({ message: "Update is not a fast forward" }, 422);
      gh.head = body.sha;
      if (gh.answerLost) throw new Error("the broker timed out");
      return ok({ object: { sha: body.sha } });
    }
    if (method === "POST" && /\/actions\/workflows\/.+\/dispatches$/.test(path)) {
      if (gh.dispatchThrows) throw new Error("429");
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
  const ig = { sets: new Map(), head: "", commits: [], order: [], reads: 0 };
  const make = (map) => {
    const id = sha1(`i${ig.sets.size}${Math.random()}`).slice(0, 32);
    ig.sets.set(id, map);
    ig.head = id;
    ig.order.push(id);
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
    log: async (_ws, _n, { limit = 50, before, at } = {}) => {
      // (A line here: `at`'s ancestors are the changesets before it.)
      const upTo = at ? ig.order.slice(0, ig.order.indexOf(at) + 1) : ig.order;
      const newest = [...upTo].reverse();
      const from = before ? newest.indexOf(before) + 1 : 0;
      const page = newest.slice(from, from + limit);
      return { changesets: page.map((id) => ({ id })), next: from + limit < newest.length ? page.at(-1) : null };
    },
    tree: async (_ws, _n, at) => (ig.sets.has(at) ? [...ig.sets.get(at)].map(([path, f]) => ({ path, blob: sha256(f.b), size: f.b.length, executable: f.x })) : null),
    manifest: async (_ws, _n, at) => [...ig.sets.get(at)].map(([path, f]) => ({ path, blob: sha256(f.b), size: f.b.length, executable: f.x, url: `https://ingot.fake.example/${at}/${encodeURIComponent(path)}` })),
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
// GitHub's own download links (raw.fake.example) from its blobs; Ingot's presigned ones (ingot.fake.example) from its changesets, counted.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  let m = /^https:\/\/raw\.fake\.example\/([0-9a-f]+)/.exec(u);
  if (m) return new Response(gh.blobs.get(m[1]));
  m = /^https:\/\/ingot\.fake\.example\/([0-9a-f]+)\/(.+)$/.exec(u);
  if (m) {
    ig.reads++;
    return new Response(ig.sets.get(m[1]).get(decodeURIComponent(m[2])).b);
  }
  return realFetch(url, init);
};
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const home = mkdtempSync(join(tmpdir(), "bops-mirror-"));
const reset = (ghFiles, igFiles) => {
  gh = makeGithub(ghFiles);
  ig = makeIngot(igFiles);
  globalThis.__fake = { ingot: ig.api, callKey: (c) => gh.call(c), userDir: home };
};
reset({ a: "1" }, { a: "1" });
const { mirrorPublish, mirrorPull, linkMirror, linkAndSay, keptPath, gitSha: ourGitSha, MirrorError, BLOB_MAX } = await import(`${root}/lib/server/github-mirror.ts`);
const { cleanGithubMirror } = await import(`${root}/lib/hosted-apps.ts`);

// The BrandLord shape: the app is the formula/ folder; the rest of the repo is the server's and its secrets'.
const GH0 = {
  ".github/workflows/deploy-formula.yml": "on: push",
  "envs/prod/web-secrets.env": "ENC[...]",
  "formula/AGENTS.md": "agents v1",
  "formula/CLAUDE.md": { link: "AGENTS.md" },
  "formula/lib/look.ts": "orange",
  "formula/clients/fourcorners/client.json": '{"autoDeploy":true}',
  "formula/clients/cclc/deck.ts": "cclc deck",
  "formula/old.ts": "old",
};
// Four Corners' Ingot: formula/ without CCLC's client, with its own preview password and .ingotignore.
const IG0 = {
  ".ingotignore": "node_modules",
  "AGENTS.md": "agents v1",
  "CLAUDE.md": "agents v1",
  "proxy.ts": "preview password",
  "lib/look.ts": "orange",
  "clients/fourcorners/client.json": '{"autoDeploy":true}',
  "old.ts": "old",
};
const KEEP = ["proxy.ts", "clients/cclc/"];
const CFG = (last, more = {}) => ({ repo: "OrgoAI/orgo-brandlord", branch: "main", path: "formula", keep: KEEP, ...more, ...(last ? { last } : {}) });
const link = async (cfg = CFG()) => linkMirror("ws_1", "fourcorners", cfg);
const publish = (at, last, more) => mirrorPublish("ws_1", "fourcorners", at, CFG(last, more), "bops; Bops");
const writes = () => gh.calls.filter((c) => !c.startsWith("GET"));
const code = (c) => (e) => e instanceof MirrorError && e.extra?.code === c;

await check("not linked yet: nothing happens, and it says to link it", async () => {
  reset(GH0, IG0);
  await assert.rejects(publish(ig.head), code("NOT_LINKED"));
  assert.deepEqual(gh.calls, []);
});

await check("Link: GitHub has nothing Ingot lacks or has otherwise (but kept paths, GitHub's links, .ingotignore), at both newest", async () => {
  reset(GH0, IG0);
  const last = await link();
  assert.deepEqual({ ...last, when: 0 }, { sha: gh.head, ingot: ig.head, keep: KEEP, when: 0 });
  assert.deepEqual(writes(), []);
  // A file both have, otherwise: it stops, naming only that one (Ingot's own extra.ts is fine).
  reset(GH0, { ...IG0, "lib/look.ts": "teal", "extra.ts": "x" });
  await assert.rejects(link(), (e) => code("LINK_DIFFERS")(e) && e.extra.paths.join() === "lib/look.ts" && /Ingot and GitHub differ in lib\/look\.ts\./.test(e.message));
  // A file only GitHub has: it stops too.
  reset({ ...GH0, "formula/theirs.ts": "only on GitHub" }, IG0);
  await assert.rejects(link(), (e) => code("LINK_DIFFERS")(e) && e.extra.paths.join() === "theirs.ts");
  // Not on GitHub yet: an empty folder, so the first Publish puts it all there.
  reset({ "README.md": "x" }, IG0);
  const l2 = await link();
  await publish(ig.head, l2);
  assert.equal(gh.files().get("formula/lib/look.ts"), "orange");
  assert.ok(!gh.files().has("formula/proxy.ts"));
  assert.equal(gh.files().get("README.md"), "x");
});

await check("Link takes files only Ingot has (a new client's own folder): they're Ingot's changes, and the first Publish puts them there", async () => {
  // A new client of a shared formula/: its own clients/acme/ folder isn't on GitHub yet.
  reset(GH0, { ...IG0, "clients/acme/client.json": '{"autoDeploy":false}', "clients/acme/deck.ts": "acme deck" });
  const linked = await linkAndSay("ws_1", "fourcorners", CFG());
  assert.deepEqual(linked.ingotOnly, ["clients/acme/client.json", "clients/acme/deck.ts"]);
  assert.match(linked.said, /^Linked fourcorners to GitHub OrgoAI\/orgo-brandlord main, folder formula at [0-9a-f]{7}\. 2 files only Ingot has \(clients\/acme\/client\.json, clients\/acme\/deck\.ts\) go to GitHub with the next Publish\.$/);
  assert.ok(!/[\u2013\u2014]| - /.test(linked.said), "no dashes in what it says");
  assert.deepEqual(writes(), [], "Link writes nothing to GitHub");
  const done = await publish(ig.head, linked.last);
  assert.equal(gh.files().get("formula/clients/acme/deck.ts"), "acme deck", "the first Publish puts them there");
  assert.equal(gh.files().get("formula/clients/acme/client.json"), '{"autoDeploy":false}');
  assert.equal(gh.files().get("formula/clients/cclc/deck.ts"), "cclc deck", "another client's kept folder stays");
  assert.match(done.said, /Pushed 2 files/);
  // Kept paths are still left out of the comparison: an Ingot-only kept file is neither a difference nor pushed.
  reset(GH0, { ...IG0, "clients/cclc/mine.ts": "kept here" });
  const kept = await linkAndSay("ws_1", "fourcorners", CFG());
  assert.deepEqual(kept.ingotOnly, []);
  assert.equal(kept.said.includes("only Ingot has"), false);
});

await check("Bring in after a Link with files only Ingot has: they stay Ingot's, GitHub's changes come in", async () => {
  reset(GH0, { ...IG0, "clients/acme/deck.ts": "acme deck" });
  const linked = await linkAndSay("ws_1", "fourcorners", CFG());
  gh.push({ "formula/lib/look.ts": "teal on GitHub" });
  const done = await mirrorPull("ws_1", "fourcorners", CFG(linked.last), "bops; Ada");
  assert.equal(done.brought, 1);
  assert.equal(ig.files().get("lib/look.ts"), "teal on GitHub");
  assert.equal(ig.files().get("clients/acme/deck.ts"), "acme deck", "Ingot's own file stays");
  assert.equal(ig.commits.at(-1).author, "bops; Ada", "Ingot's commit is in the person's name");
});

await check("Ingot's changes go to GitHub: one commit on top of the branch, its folder only; kept paths, links and the rest stay", async () => {
  reset(GH0, IG0);
  const last = await link();
  const before = gh.head;
  const at = ig.change({ "lib/look.ts": "logo orange", "clients/fourcorners/brochure.ts": { text: "new", x: true }, "old.ts": null, "proxy.ts": "other password", "CLAUDE.md": "changed copy" });
  const done = await publish(at, last);
  const files = gh.files();
  assert.equal(files.get("formula/lib/look.ts"), "logo orange");
  assert.equal(files.get("formula/clients/fourcorners/brochure.ts"), "new");
  assert.equal(gh.commits.get(gh.head).files.get("formula/clients/fourcorners/brochure.ts").mode, "100755", "executable stays executable");
  assert.ok(!files.has("formula/old.ts"), "a file deleted in Ingot is deleted there");
  assert.ok(!files.has("formula/proxy.ts"), "a kept path never goes");
  assert.equal(files.get("formula/clients/cclc/deck.ts"), "cclc deck", "another app's client (kept) stays, though Ingot has none");
  assert.deepEqual(files.get("formula/CLAUDE.md"), { link: true }, "GitHub's link stays a link");
  assert.equal(files.get("envs/prod/web-secrets.env"), "ENC[...]", "outside the folder: untouched");
  assert.equal(files.get(".github/workflows/deploy-formula.yml"), "on: push");
  assert.ok(!files.has("formula/.ingotignore"));
  assert.equal(gh.commits.get(gh.head).parent, before, "on top of the branch, never forced");
  assert.match(gh.commits.get(gh.head).message, new RegExp(`Ingot-Changeset: ${at}`));
  assert.deepEqual({ ...done.last, when: 0 }, { sha: gh.head, ingot: at, keep: KEEP, when: 0 });
  assert.equal(done.pushed.files, 3);
  assert.match(done.said, /Pushed 3 files to OrgoAI\/orgo-brandlord main .*GitHub deploys it/);
  assert.equal(ig.commits.length, 0, "nothing written to Ingot");
  // The same preview again: nothing to push.
  const again = await publish(at, done.last);
  assert.equal(again.pushed, null);
});

await check("GitHub's changes come into Ingot first; with nothing new in Ingot, nothing is pushed", async () => {
  reset(GH0, IG0);
  const last = await link();
  gh.push({ "formula/lib/look.ts": "teal", "formula/clients/fourcorners/new.ts": "added there", "formula/old.ts": null, "formula/clients/cclc/deck.ts": "cclc v2", "README.md": "outside" });
  const head = gh.head;
  const done = await publish(last.ingot, last);
  const files = ig.files();
  assert.equal(files.get("lib/look.ts"), "teal");
  assert.equal(files.get("clients/fourcorners/new.ts"), "added there");
  assert.ok(!files.has("old.ts"));
  assert.ok(!files.has("clients/cclc/deck.ts"), "a kept path never comes in");
  assert.ok(!files.has("README.md"), "outside the folder isn't the app's");
  assert.equal(files.get("proxy.ts"), "preview password");
  assert.equal(ig.commits.length, 1);
  assert.match(ig.commits[0].message, /^From GitHub: 3 files changed on OrgoAI\/orgo-brandlord main/);
  assert.equal(gh.head, head, "no commit on GitHub");
  assert.equal(done.pushed, null);
  assert.equal(done.brought, 3);
  assert.deepEqual({ ...done.last, when: 0 }, { sha: head, ingot: ig.head, keep: KEEP, when: 0 }, "the point: GitHub's newest, and Ingot's changeset with its changes in");
  assert.match(done.said, /Brought 3 changes from GitHub into Ingot first\. GitHub already has everything.*Deploy the newest to the preview/);
});

await check("the same old preview again after GitHub's changes came in: refused, never pushing them back undone", async () => {
  reset(GH0, IG0);
  const last = await link();
  const at = ig.change({ "AGENTS.md": "agents v2" });
  gh.push({ "formula/lib/look.ts": "teal", "formula/clients/fourcorners/new.ts": "added there" });
  const first = await publish(at, last);
  assert.equal(first.brought, 2);
  assert.equal(gh.files().get("formula/AGENTS.md"), "agents v2");
  const ghNow = gh.head;
  await assert.rejects(publish(at, first.last), (e) => code("PREVIEW_BEHIND")(e) && /Deploy the newest to the preview first/.test(e.message));
  assert.equal(gh.head, ghNow, "GitHub as it was: teal stays");
  assert.equal(gh.files().get("formula/lib/look.ts"), "teal");
  // The newest preview (with GitHub's changes in) publishes only what's new, and nothing that came in.
  const at2 = ig.change({ "clients/fourcorners/brochure.ts": "brochure" });
  const second = await publish(at2, first.last);
  assert.equal(second.pushed.files, 1);
  assert.equal(gh.files().get("formula/lib/look.ts"), "teal");
  assert.equal(gh.files().get("formula/clients/fourcorners/new.ts"), "added there");
  // GitHub changes a file that came in from it again: no false conflict, it just comes in.
  gh.push({ "formula/clients/fourcorners/new.ts": "changed again there" });
  const third = await publish(ig.change({ "AGENTS.md": "agents v3" }), second.last);
  assert.equal(third.brought, 1);
  assert.equal(ig.files().get("clients/fourcorners/new.ts"), "changed again there");
  assert.equal(gh.files().get("formula/AGENTS.md"), "agents v3");
});

await check("a file both changed to other bytes stops it, with nothing written on either side; same bytes and mode is no conflict", async () => {
  reset(GH0, IG0);
  const last = await link();
  gh.push({ "formula/lib/look.ts": "teal" });
  const ghHead = gh.head;
  const at = ig.change({ "lib/look.ts": "logo orange" });
  await assert.rejects(publish(at, last), (e) => code("BOTH_CHANGED")(e) && e.extra.paths.join() === "lib/look.ts" && /Bring in GitHub's changes/.test(e.message));
  assert.equal(gh.head, ghHead);
  assert.deepEqual(writes(), []);
  assert.equal(ig.commits.length, 0);
  reset(GH0, IG0);
  const l2 = await link();
  gh.push({ "formula/lib/look.ts": "same" });
  const done = await publish(ig.change({ "lib/look.ts": "same" }), l2);
  assert.equal(done.pushed, null);
  assert.equal(done.brought, 0);
  reset(GH0, IG0);
  const l3 = await link();
  gh.push({ "formula/old.ts": "changed there" });
  await assert.rejects(publish(ig.change({ "old.ts": null }), l3), code("BOTH_CHANGED"));
});

await check("newer work in Ingot (main past the preview) on a file GitHub changed: stops, never written over", async () => {
  reset(GH0, IG0);
  const last = await link();
  const at = ig.change({ "AGENTS.md": "agents v2" });
  ig.change({ "lib/look.ts": "red, not published yet" });
  gh.push({ "formula/lib/look.ts": "teal" });
  await assert.rejects(publish(at, last), (e) => code("BOTH_CHANGED")(e) && e.extra.paths.join() === "lib/look.ts");
  assert.equal(ig.files().get("lib/look.ts"), "red, not published yet");
  assert.deepEqual(writes(), []);
  // Newer work on another file is fine: GitHub's change comes in on top of it.
  reset(GH0, IG0);
  const l2 = await link();
  const at2 = ig.change({ "AGENTS.md": "agents v2" });
  ig.change({ "clients/fourcorners/client.json": "newer" });
  gh.push({ "formula/lib/look.ts": "teal" });
  const done = await publish(at2, l2);
  assert.equal(ig.files().get("clients/fourcorners/client.json"), "newer");
  assert.equal(ig.files().get("lib/look.ts"), "teal");
  assert.equal(gh.files().get("formula/clients/fourcorners/client.json"), '{"autoDeploy":true}', "the newer work isn't published: it isn't in the preview");
  assert.equal(done.last.ingot, ig.head);
});

await check("Bring in GitHub's changes: GitHub's version wins where both changed, the point moves, and Ingot's change then publishes", async () => {
  reset(GH0, IG0);
  const last = await link();
  gh.push({ "formula/lib/look.ts": "teal", "formula/clients/fourcorners/new.ts": "x" });
  ig.change({ "lib/look.ts": "logo orange", "AGENTS.md": "agents v2" });
  const pulled = await mirrorPull("ws_1", "fourcorners", CFG(last), "bops; Bops");
  assert.deepEqual(pulled.took, ["lib/look.ts"]);
  assert.match(pulled.said, /Took GitHub's version of lib\/look\.ts/);
  assert.equal(ig.files().get("lib/look.ts"), "teal");
  assert.equal(ig.files().get("AGENTS.md"), "agents v2", "what only Ingot changed stays");
  assert.equal(pulled.last.sha, gh.head);
  const at = ig.change({ "lib/look.ts": "logo orange, again" });
  const done = await publish(at, pulled.last);
  assert.equal(gh.files().get("formula/lib/look.ts"), "logo orange, again");
  assert.equal(gh.files().get("formula/AGENTS.md"), "agents v2");
  assert.equal(done.pushed.files, 2);
});

await check("too big to send stops it before anything is written, but only a file that would be sent", async () => {
  reset(GH0, IG0);
  const last = await link();
  const at = ig.change({ "clients/fourcorners/photo.jpeg": "x".repeat(BLOB_MAX + 1), "lib/look.ts": "logo orange" });
  await assert.rejects(publish(at, last), (e) => code("TOO_BIG")(e) && /photo\.jpeg/.test(e.message) && /Nothing was published/.test(e.message));
  assert.deepEqual(writes(), []);
  // A big file GitHub has already (it came from there): never in the way.
  const big = "p".repeat(BLOB_MAX + 5);
  reset({ ...GH0, "formula/clients/fourcorners/big.pdf": big }, { ...IG0, "clients/fourcorners/big.pdf": big });
  const l2 = await link();
  const done = await publish(ig.change({ "lib/look.ts": "logo orange" }), l2);
  assert.equal(done.pushed.files, 1);
});

await check("GitHub's files of any size come down, checked: small ones inline, bigger ones by their folder's listing", async () => {
  reset(GH0, IG0);
  const last = await link();
  gh.push({ "formula/clients/fourcorners/mid.pdf": "m".repeat(370_000), "formula/clients/fourcorners/larger.pdf": "l".repeat(600_000), "formula/clients/fourcorners/big.pdf": "b".repeat(1_200_000) });
  const done = await publish(last.ingot, last);
  assert.equal(ig.files().get("clients/fourcorners/mid.pdf").length, 370_000, "inline in its own entry");
  assert.equal(ig.files().get("clients/fourcorners/larger.pdf").length, 600_000, "too big inline for the broker: by its folder's listing");
  assert.equal(ig.files().get("clients/fourcorners/big.pdf").length, 1_200_000, "over 1 MB: its own entry's link");
  assert.ok(gh.calls.includes("GET /contents/formula/clients/fourcorners"), "the listing, for the one that needed it");
  assert.equal(done.brought, 3);
});

await check("the executable bit is a change of its own, either way", async () => {
  reset(GH0, IG0);
  const last = await link();
  const done = await publish(ig.change({ "lib/look.ts": { text: "orange", x: true } }), last);
  assert.equal(done.pushed.files, 1);
  assert.equal(gh.commits.get(gh.head).files.get("formula/lib/look.ts").mode, "100755");
});

await check("a folder gone from GitHub, or most of it deleted on either side, stops it with nothing written", async () => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`formula/f${i}.ts`, `${i}`]));
  const manyIg = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.ts`, `${i}`]));
  reset(many, manyIg);
  let last = await link(CFG(undefined, { keep: [] }));
  gh.push(Object.fromEntries(Object.keys(many).map((p) => [p, null])));
  await assert.rejects(publish(ig.head, last, { keep: [] }), code("FOLDER_GONE"));
  reset(many, manyIg);
  last = await link(CFG(undefined, { keep: [] }));
  gh.push(Object.fromEntries(Object.keys(many).slice(0, 25).map((p) => [p, null])));
  await assert.rejects(publish(ig.head, last, { keep: [] }), (e) => code("MASS_DELETE")(e) && /^GitHub deleted 25 of the folder's 30 files/.test(e.message));
  reset(many, manyIg);
  last = await link(CFG(undefined, { keep: [] }));
  await assert.rejects(publish(ig.change(Object.fromEntries(Object.keys(manyIg).slice(0, 22).map((p) => [p, null]))), last, { keep: [] }), (e) => code("MASS_DELETE")(e) && /^Ingot deleted 22/.test(e.message));
  assert.equal(ig.commits.length, 0);
  assert.deepEqual(writes(), []);
});

await check("someone pushing to the branch meanwhile stops it, saying to publish again", async () => {
  reset(GH0, IG0);
  const last = await link();
  const at = ig.change({ "lib/look.ts": "logo orange" });
  gh.moveFails = true;
  await assert.rejects(publish(at, last), (e) => code("GITHUB_MOVED")(e) && /Publish again/.test(e.message));
});

await check("on a bot's computer, the GitHub key its bot wasn't given (Orgo turns its computer's call away, 403): said plainly as that, nothing written", async () => {
  reset(GH0, IG0);
  const last = await link();
  const at = ig.change({ "lib/look.ts": "logo green" });
  const { KeysError } = await import(`${root}/lib/server/keys.ts`);
  const n = writes().length;
  const was = process.env.BOPS_RUNNER;
  process.env.BOPS_RUNNER = "1";
  globalThis.__fake.callKey = async () => {
    throw new KeysError("Orgo didn't send it: not one of its bots' keys.", 403);
  };
  try {
    await assert.rejects(publish(at, last), (e) => code("NO_GITHUB_KEY")(e) && e.message === "The bot publishing it has no GitHub key for this app, so nothing went to GitHub. Give it the GitHub key in Keys, then publish again.");
  } finally {
    if (was === undefined) delete process.env.BOPS_RUNNER;
    else process.env.BOPS_RUNNER = was;
  }
  assert.equal(writes().length, n, "nothing written");
  // (On the Mac the same refusal is Orgo's own words, as before.)
  await assert.rejects(publish(at, last), (e) => e instanceof MirrorError && /^GitHub: Orgo didn't send it/.test(e.message));
});

await check("a named workflow runs after a push (a client that doesn't deploy on a push), never without one", async () => {
  reset(GH0, IG0);
  const last = await link();
  const more = { dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc" } } };
  let done = await publish(last.ingot, last, more);
  assert.equal(gh.dispatched.length, 0, "nothing pushed, nothing run");
  done = await publish(ig.change({ "AGENTS.md": "agents v2" }), done.last, more);
  assert.equal(gh.dispatched.length, 1);
  assert.deepEqual(gh.dispatched[0].body, { ref: "main", inputs: { client: "cclc" } });
  assert.match(done.said, /Started deploy-formula\.yml on GitHub\./);
});

await check("each Ingot file is read once: later publishes read only what's new (and the table outlives the process)", async () => {
  reset(GH0, IG0);
  delete globalThis.__bopsGitIds;
  rmSync(join(home, "github-mirror-ids.json"), { force: true });
  const last = await link();
  const afterLink = ig.reads;
  assert.equal(afterLink, 4, "each file read once to link (AGENTS.md and CLAUDE.md are the same bytes: once; kept ones never)");
  const done = await publish(ig.change({ "lib/look.ts": "logo orange" }), last);
  assert.ok(ig.reads - afterLink <= 2, `only the changed file read again (${ig.reads - afterLink})`);
  const before = ig.reads;
  await publish(done.last.ingot, done.last);
  assert.equal(ig.reads, before, "nothing new, nothing read");
  delete globalThis.__bopsGitIds;
  await publish(done.last.ingot, done.last);
  assert.equal(ig.reads, before, "read back from the user's folder after a restart");
});

await check("the whole repo as the folder, a nested folder, and a branch with a slash", async () => {
  reset({ "x.ts": "1", "deep/a/b.ts": "2" }, { "x.ts": "1", "deep/a/b.ts": "2" });
  const last = await link(CFG(undefined, { path: "", keep: [] }));
  await publish(ig.change({ "x.ts": "changed" }), last, { path: "", keep: [] });
  assert.equal(gh.files().get("x.ts"), "changed");
  reset({ "deep/a/b.ts": "2", "deep/z.ts": "3" }, { "b.ts": "2" });
  const l2 = await link(CFG(undefined, { path: "deep/a", keep: [] }));
  await publish(ig.change({ "b.ts": "changed" }), l2, { path: "deep/a", keep: [] });
  assert.equal(gh.files().get("deep/a/b.ts"), "changed");
  assert.equal(gh.files().get("deep/z.ts"), "3");
  await assert.rejects(linkMirror("ws_1", "app", CFG(undefined, { branch: "release/1" })), /no branch release\/1/);
});

await check("the paths left alone changed since the Link (one taken off): refused until linked again, nothing deleted on GitHub", async () => {
  reset(GH0, IG0);
  const last = await link();
  const at0 = ig.head;
  assert.deepEqual(last.keep, KEEP);
  await assert.rejects(publish(ig.change({ "lib/look.ts": "x" }), last, { keep: ["proxy.ts", "clients/cclc"] }), (e) => code("RELINK")(e) && /link it again first/.test(e.message));
  await assert.rejects(publish(at0, last, { keep: ["proxy.ts"] }), code("RELINK"));
  assert.deepEqual(writes(), []);
  assert.equal(gh.files().get("formula/clients/cclc/deck.ts"), "cclc deck");
  // More left alone is fine.
  const done = await publish(at0, last, { keep: [...KEEP, "notes/"] });
  assert.equal(done.pushed, null);
});

await check("GitHub's changes came in, then the push failed: the point moves to them anyway, and nothing is undone after", async () => {
  reset(GH0, IG0);
  const last = await link();
  const at = ig.change({ "AGENTS.md": "agents v2" });
  gh.push({ "formula/lib/look.ts": "teal", "formula/old.ts": null });
  // Another app puts look.ts back and old.ts back while this one publishes: the push is refused.
  gh.beforeMove = () => {
    gh.beforeMove = null;
    gh.push({ "formula/lib/look.ts": "orange", "formula/old.ts": "old" });
  };
  const err = await publish(at, last).catch((e) => e);
  assert.ok(code("GITHUB_MOVED")(err));
  const point = err.extra.last;
  assert.ok(point && point.ingot === ig.head && point.sha !== last.sha, "the point is GitHub's commit the changes were read at, and Ingot's with them in");
  // The newest preview: GitHub's put-back comes in, Ingot's AGENTS.md goes up, teal is never pushed back.
  const done = await publish(ig.head, point);
  assert.equal(gh.files().get("formula/lib/look.ts"), "orange");
  assert.equal(gh.files().get("formula/old.ts"), "old");
  assert.equal(gh.files().get("formula/AGENTS.md"), "agents v2");
  assert.equal(ig.files().get("lib/look.ts"), "orange");
  assert.equal(done.brought, 2);
});

await check("a link on GitHub that became a file is GitHub's change (Ingot's copy never pushed); a file that became a link stops Ingot's change", async () => {
  reset(GH0, IG0);
  const last = await link();
  gh.push({ "formula/CLAUDE.md": "claude's own file now" });
  const done = await publish(ig.change({ "CLAUDE.md": "changed copy" }), last);
  assert.equal(gh.files().get("formula/CLAUDE.md"), "claude's own file now", "GitHub's file stays");
  assert.equal(ig.files().get("CLAUDE.md"), "claude's own file now", "and comes into Ingot");
  assert.equal(done.brought, 1);
  reset(GH0, IG0);
  const l2 = await link();
  gh.push({ "formula/old.ts": { link: "lib/look.ts" } });
  await assert.rejects(publish(ig.change({ "old.ts": "changed in Ingot" }), l2), (e) => code("BOTH_CHANGED")(e) && e.extra.paths.join() === "old.ts");
  const fine = await publish(ig.change({ "lib/look.ts": "x" }), l2).catch((e) => e);
  assert.ok(code("BOTH_CHANGED")(fine), "still: old.ts changed in Ingot since the point");
});

await check("once the branch moved nothing fails it: a lost answer is checked on GitHub, a workflow that won't start is said", async () => {
  reset(GH0, IG0);
  const last = await link();
  gh.answerLost = true;
  const more = { dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc" } } };
  gh.dispatchThrows = true;
  const done = await publish(ig.change({ "lib/look.ts": "logo orange" }), last, more);
  assert.equal(gh.files().get("formula/lib/look.ts"), "logo orange");
  assert.equal(done.last.sha, gh.head);
  assert.match(done.said, /Couldn't start deploy-formula\.yml on GitHub: run it there\./);
});

await check("a preview from before the point, whatever the log's order, is refused; its own history decides", async () => {
  reset(GH0, IG0);
  const last = await link();
  const older = ig.order[0];
  const newer = ig.change({ "lib/look.ts": "x" });
  await assert.rejects(publish(older, { ...last, ingot: newer }), code("PREVIEW_BEHIND"));
  const done = await publish(newer, last);
  assert.equal(done.pushed.files, 1);
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
  assert.match(cleanGithubMirror({ repo: "a/b", keep: ["proxy.ts", "../x"] }).why, /"\.\.\/x" can't be a path left alone/, "a bad path is refused, never dropped without a word");
  assert.deepEqual(cleanGithubMirror({ repo: "https://github.com/OrgoAI/orgo-brandlord.git", branch: "", path: "/formula/", keep: ["proxy.ts", " notes/ ", "proxy.ts"], dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc", "bad key": "x" } } }), {
    ok: { repo: "OrgoAI/orgo-brandlord", branch: "main", path: "formula", keep: ["proxy.ts", "notes/"], dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc" } } },
  });
  assert.match(cleanGithubMirror({ repo: "nope" }).why, /Which GitHub repo/);
  assert.match(cleanGithubMirror({ repo: "a/b", branch: "../x" }).why, /branch/);
  assert.match(cleanGithubMirror({ repo: "a/b", path: "../etc" }).why, /folder/);
  assert.match(cleanGithubMirror({ repo: "a/b", dispatch: { workflow: "rm -rf" } }).why, /workflow/);
  assert.ok(!("last" in cleanGithubMirror({ repo: "a/b", last: { sha: "x", ingot: "y" } }).ok), "the window never sets the point");
});

rmSync(home, { recursive: true, force: true });
console.log(`github mirror: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
