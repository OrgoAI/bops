// Tests for change_files (lib/server/repo-change.ts, its place in lib/server/chat.ts): a bot with the user's GitHub key
// changes files in a repository with ONE ask, whatever the number of files. Before the ask only reads go out (the
// branch, each file there now, for the card's short diff); the ask carries the bot's reason, which files and how, and
// the facts line says "GitHub · changes 2 files on <branch>". On Allow, Bops makes the blobs (the text as UTF-8, never
// base64 from the model), the tree and the commit, and moves the branch last (making it from its base when it's new);
// on Deny nothing is written; a failure part way leaves the branch where it was. A task never has it. Bad input is said
// plainly, and nothing goes out for it.
//
// orgo-web is a fake (a local server with /api/secrets and its broker), behind which a stand-in GitHub keeps a tiny
// repository (refs, commits, trees, blobs) in memory; OpenAI is a fake (/v1/responses answers what each test queues);
// the state lives in a throwaway folder: nothing reaches a real service. The keys are made up.
// Usage: node --conditions=react-server scripts/test-file-change.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const sha = sha1(Buffer.concat([Buffer.from("blob"), bytes]));
    blobs.set(sha, bytes);
    return sha;
  };
  const files = { "src/look.ts": 'export const look = {\n  accent: "#FFD400",\n  ink: "#20222D",\n};\n', "README.md": "# Site\n", "old.css": "a { color: red; }\n" };
  const tree = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, blob(Buffer.from(t))]));
  const treeSha = sha1(JSON.stringify(tree));
  const commitSha = sha1(`c0${treeSha}`);
  gh = { blobs, trees: new Map([[treeSha, tree]]), commits: new Map([[commitSha, { tree: treeSha, parents: [], message: "First" }]]), refs: new Map([["main", commitSha]]), calls: [], fail: null, blob };
}
freshRepo();
/** What the stand-in GitHub answers one call (as the broker passes it on): status and JSON. */
function github(method, path, query, body) {
  gh.calls.push({ method, path, query, body });
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
    if (!tree?.[p]) return no(404, "Not Found");
    const bytes = gh.blobs.get(tree[p]);
    return ok({ type: "file", path: p, size: bytes.length, sha: tree[p], encoding: "base64", content: bytes.toString("base64").replace(/(.{60})/g, "$1\n") });
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
      } else tree[e.path] = e.sha;
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
const fileAt = (ref, p) => gh.blobs.get(gh.trees.get(gh.commits.get(gh.refs.get(ref))?.tree)?.[p])?.toString();

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const url = new URL(req.url, "http://fake");
  const send = (status, obj) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
  if (req.headers.authorization !== `Bearer ${ORGO_KEY}`) return send(401, { error: "Not authenticated" });
  if (url.pathname === "/api/secrets" && req.method === "GET") return send(200, { secrets: [{ name: "GITHUB_TOKEN", workspace_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }] });
  if (url.pathname === "/api/secrets/call" && req.method === "POST") {
    if (body.name !== "GITHUB_TOKEN") return send(404, { error: "Secret not set" });
    // Orgo's broker refuses a path with ".." (as the real one does), whatever the service.
    if (body.path.includes("..")) return send(400, { error: "path must not contain '..'" });
    const r = github(body.method, body.path, body.query, body.body);
    return send(200, { status: r.status, contentType: "application/json", body: r.body, truncated: false, headers: {} });
  }
  send(404, { error: "no such route" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
process.env.BOPS_ORGO_ORIGIN = `http://127.0.0.1:${PORT}`;

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
const { apiFacts } = await import(`${root}/lib/permission.ts`);
clearInterval(globalThis.__bopsRoutines);

const chatId = botChatId("boppy");
S.update((s) => (s.owner = { name: "Alex", timeZone: "America/New_York" }));
Keys.grantKey("GITHUB_TOKEN", "boppy", true);
const messages = () => S.getState().messages.filter((m) => m.chatId === chatId);
const outputOf = (body, i = 0) => body.input.filter((x) => x.type === "function_call_output")[i]?.output;
const NEW_LOOK = 'export const look = {\n  accent: "#F15B3B",\n  ink: "#20222D",\n};\n';
const change = (over = {}) => ({
  key: "GITHUB_TOKEN",
  repo: "acme/site",
  branch: "site/orange-buttons",
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
  assert.match(tool.description, /any change to files, never call_api's contents or git calls/);
  assert.match(tool.description, /not a diff, not base64/);
  assert.match(body.tools.find((t) => t.name === "call_api").description, /To change files in a GitHub repository \(an edit, a new file, a delete\), use change_files, never these calls/);
  assert.match(JSON.stringify(body.input), /change_files/, "the chat's own words point at it too");
  for (const t of [tool.description, ...Object.values(tool.parameters.properties).map((p) => p.description ?? "")]) assert.ok(!DASHES.test(t), t);
});

await check("a task never has it: its key calls only read, and change_files refuses outside the chat, sending nothing", async () => {
  const src = readFileSync(`${root}/lib/server/computer-task.ts`, "utf8");
  assert.ok(!/change_files|changeFiles|repo-change/.test(src), "nothing of it in a task's tools");
  const { changeFiles } = await import(`${root}/lib/server/repo-change.ts`);
  const n = gh.calls.length;
  const r = await changeFiles("boppy", change(), { sessionId: "ses_x" });
  assert.equal(r.text, "Only in the chat: a task's keys only read.");
  assert.equal(gh.calls.length, n);
});

/* ---------------- One ask ---------------- */

await check("two files, one call: exactly ONE ask; before it only reads went out; the card's facts, files and short diff", async () => {
  freshRepo();
  const { a0, apr, opened } = await asking(change());
  assert.equal(opened, 1, "one ask");
  assert.equal(asked.length, a0 + 1, "the turn paused at it");
  assert.deepEqual(writes(), [], "nothing written before the yes");
  assert.deepEqual([apr.action, apr.kind, apr.reason], ["Call GitHub", "api", "Make the buttons the logo's orange, as a draft"]);
  assert.deepEqual(apr.api.change, { repo: "acme/site", branch: "site/orange-buttons", base: "main", files: [{ path: "src/look.ts", op: "change", bytes: Buffer.byteLength(NEW_LOOK) }, { path: "src/notes.md", op: "add", bytes: 17 }] });
  assert.equal(apiFacts(apr.api), "GitHub · changes 2 files on site/orange-buttons");
  assert.match(apr.preview, /^New branch site\/orange-buttons, from main\./);
  assert.match(apr.preview, /src\/look\.ts: changed, \d+ B\nat line 2\n- {3}accent: "#FFD400",\n\+ {3}accent: "#F15B3B",/);
  assert.match(apr.preview, /src\/notes\.md: added, 17 B\n\+ Buttons: orange\./);
  assert.ok(!/[A-Za-z0-9+/]{40,}={0,2}/.test(apr.preview), "no base64 on the card");
  globalThis.__lastAsk = apr;
});

await check("Allow: the blobs as UTF-8, the tree, the commit, and the branch made last; the chat says it plainly; the bot gets the link", async () => {
  const apr = globalThis.__lastAsk;
  const a0 = asked.length;
  assert.equal(P.replyToAsk(apr.id, "once"), undefined);
  await until(() => asked.length === a0 + 1 && gh.refs.has("site/orange-buttons"), "the change to go in");
  const w = writes();
  assert.deepEqual(w.map((c) => `${c.method} ${c.path}`), ["POST /repos/acme/site/git/blobs", "POST /repos/acme/site/git/blobs", "POST /repos/acme/site/git/trees", "POST /repos/acme/site/git/commits", "POST /repos/acme/site/git/refs"], "the branch moves last");
  assert.deepEqual(w.slice(0, 2).map((c) => c.body), [{ content: NEW_LOOK, encoding: "utf-8" }, { content: "Buttons: orange.\n", encoding: "utf-8" }]);
  assert.equal(fileAt("site/orange-buttons", "src/look.ts"), NEW_LOOK);
  assert.equal(fileAt("site/orange-buttons", "README.md"), "# Site\n", "the rest kept");
  assert.equal(fileAt("main", "src/look.ts").includes("#FFD400"), true, "main untouched");
  const out = outputOf(asked[a0]);
  assert.match(out, /^Saved: 2 files on site\/orange-buttons in acme\/site, a new branch from main \(commit [0-9a-f]{7}\): https:\/\/github\.com\/acme\/site\/commit\/[0-9a-f]{40}$/);
  const notes = messages().filter((m) => m.appResult && m.at >= apr.at);
  assert.deepEqual(notes.map((m) => m.text), ["Boppy: Called GitHub PUT /repos/acme/site/contents/src/look.ts", "Boppy: Called GitHub PUT /repos/acme/site/contents/src/notes.md"], "one note per file, which the chat folds into one line");
  assert.ok(!S.getState().appApprovals.some((x) => x.id === apr.id), "the ask taken out");
});

await check("an existing branch moves by a fast forward, last; a delete says so on the card and in the facts line", async () => {
  const before = gh.refs.get("site/orange-buttons");
  gh.calls = [];
  const { apr, opened } = await asking(change({ files: [{ path: "src/look.ts", text: NEW_LOOK.replace("F15B3B", "E04A2A"), delete: null }, { path: "old.css", text: null, delete: true }] }));
  assert.equal(opened, 1);
  assert.equal(apiFacts(apr.api), "GitHub · changes 1 file and deletes 1 on site/orange-buttons");
  assert.match(apr.preview, /old\.css: deleted/);
  assert.ok(!/New branch/.test(apr.preview));
  const a0 = asked.length;
  P.replyToAsk(apr.id, "once");
  await until(() => asked.length === a0 + 1, "the change to go in");
  assert.deepEqual(writes().map((c) => c.method).at(-1), "PATCH");
  assert.deepEqual(writes().at(-1).body.force, false);
  assert.equal(gh.commits.get(gh.refs.get("site/orange-buttons")).parents[0], before);
  assert.equal(fileAt("site/orange-buttons", "old.css"), undefined, "deleted");
  const only = await asking(change({ files: [{ path: "README.md", text: null, delete: true }] }));
  assert.equal(apiFacts(only.apr.api), "GitHub · deletes 1 file on site/orange-buttons");
  P.replyToAsk(only.apr.id, "reject");
  await until(() => !S.getState().appApprovals.some((x) => x.id === only.apr.id), "the no to be read");
});

await check("Deny: nothing is written, and the bot is told", async () => {
  freshRepo();
  const { apr } = await asking(change(), "Ok, I left it.");
  const a0 = asked.length;
  P.replyToAsk(apr.id, "reject", "Not yet");
  await until(() => asked.length === a0 + 1, "the turn to go on from the no");
  assert.equal(outputOf(asked[a0]), "Declined: Not yet");
  assert.deepEqual(writes(), []);
  assert.equal(gh.refs.has("site/orange-buttons"), false);
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
  assert.match(await say({ files: [{ path: "a.txt", text: "x", delete: true }] }), /not both/);
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

await check("no dashes in anything it said, and no key value anywhere", () => {
  for (const m of messages()) assert.ok(!DASHES.test(m.text), m.text);
  assert.ok(!logged.some((l) => l.includes(ORGO_KEY)));
});

server.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\nfile change: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
