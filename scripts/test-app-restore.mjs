// Tests for what a task changed in an app on the web, and Restore (lib/server/hosted-apps.ts changeCardAfterTask,
// restoreApp and restoreConfirm, lib/server/ingot.ts changesTo, byBots, folderChanges and its tree and commit calls,
// app/api/hosted-apps/[name] POST restore and GET ?restore=, where sessions.ts calls the card, and what a shared
// workspace gets of it): the commit Restore asks Ingot for, as a pure function of two changesets' files (each file
// added, changed, deleted, an executable bit alone, nothing to do); Restore through Ingot's own API (the files at the
// changeset to go back to and at main's newest, one commit on top of main's newest naming blobs Ingot has, by Bops,
// "Restore <app> to <short id>"), the working folder's status read on its computer before anything is committed and
// the folder pulled after, its Local started again when what it installs from changed; Ingot's stale (made once more
// from main's newest, then refused, saying so) and empty (said, nothing committed); its refusals (a task works on
// it, a folder with changes nobody committed, a workspace shared with the user, a page that isn't the Bops window, a
// changeset that isn't one of it); the question's data (every change after it, newest first, who and when, and why
// it can't be restored now); the card once a task's run ended (only the bot's changesets count, once a run, none when
// it committed nothing, a later run's from where the last card ended, said in words an older Bops shows); and that
// neither Bops Cloud nor a shared workspace's view ever carries the card. Every script sent to a computer passes bash -n,
// and nothing a person reads has a dash.
//
// orgo-web, the central Ingot and the computer are a fake fetch on made-up origins (Ingot as its Rust server answers:
// crates/ingot-store changeset.rs commit, stale and empty; crates/ingot-hosted handlers.rs tree and log), the
// Keychain a fake `security`, and the state lives in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-app-restore.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG|INGOT)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-app-restore";
process.env.BOPS_RESPONSES_WS = "0";
const UI = "ui-token-test-app-restore";
process.env.BOPS_UI_TOKEN = UI;
const ORGO = "http://orgo.test";
const INGOT = "http://ingot.test";
process.env.BOPS_ORGO_ORIGIN = ORGO;
process.env.BOPS_INGOT_URL = INGOT;
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-app-restore-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), '#!/bin/sh\nif [ "$1" = "-i" ]; then cat >/dev/null; exit 0; fi\nexit 44\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);
const vendor = join(scratch, "vendor-ingot");
mkdirSync(vendor);
process.env.BOPS_INGOT_DIR = vendor;
process.env.BOPS_LOCAL_SCRIPT = join(root, "vm/bin/bops-local");
const BINARY = randomBytes(1024);
writeFileSync(join(vendor, "ingot-linux-amd64"), BINARY);

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
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(w, ...rest));
const logged = [];
for (const k of ["info", "warn"]) console[k] = (...a) => logged.push(a.map(String).join(" "));

const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
let clock = Date.parse("2026-10-30T12:00:00Z");
const iso = () => new Date((clock += 60_000)).toISOString();

/* ---------------- The central Ingot, as its Rust server answers ---------------- */

const KEY = "sk_orgo_test_app_restore";
const PA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TOKEN_SUM = sha("ingot_test_token\n");
const alex = { id: "u_alex", email: "alex@orgo.ai", name: "Alex" };
const W = `/api/v1/w/${PA}`;

/**
 * One repo, recipe-box: its changesets newest first, each with its files (path to { path, blob, size, executable }),
 * and the blobs it has. `beforeCommit`: done as the next commit comes in, before it's checked (someone commits
 * first); `commitAnswer`: answers the next commit instead. Every commit asked, with its author.
 */
const ingotFake = { changesets: [], blobs: new Set(), commits: [], calls: [], down: false, beforeCommit: [], commitAnswer: null };
const head = () => ingotFake.changesets[0]?.id ?? null;
const filesOf = (files) =>
  new Map(
    Object.entries(files).map(([path, v]) => {
      const [text, exec] = Array.isArray(v) ? v : [v, false];
      ingotFake.blobs.add(sha(text));
      return [path, { path, blob: sha(text), size: text.length, executable: !!exec }];
    }),
  );
/** A changeset someone made, with every file the app has after it ({ path: text } or [text, executable]). */
function put(message, author, files) {
  const c = { id: sha(randomBytes(16)), parents: head() ? [head()] : [], author, message, at: iso(), files: filesOf(files) };
  ingotFake.changesets.unshift(c);
  return c;
}
const view = ({ files, ...c }) => (void files, c);
const sorted = (m) => [...m.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
/** Two changesets' files the same (each path, blob and executable bit). */
const same = (a, b) => JSON.stringify(sorted(a).map(({ size, ...x }) => (void size, x))) === JSON.stringify(sorted(b).map(({ size, ...x }) => (void size, x)));

function ingotApi(req, url, body) {
  const author = req.headers.get("x-ingot-author");
  ingotFake.calls.push(`${req.method} ${url.pathname}${url.search}`);
  if (req.headers.get("authorization") !== `Bearer ${KEY}`) return json({ error: "unauthorized", message: "no" }, 401);
  if (url.pathname === `${W}/tokens` && req.method === "GET") return json({ tokens: [{ id: 7, revoked_at: null, expires_at: null }] });
  if (url.pathname === `${W}/repos` && req.method === "GET") return json({ repos: [{ name: "recipe-box", head: head(), updated_at: ingotFake.changesets[0]?.at ?? null }] });
  if (url.pathname === `${W}/repos/recipe-box` && req.method === "GET") return json({ repo: { name: "recipe-box" }, refs: head() ? [{ name: "main", target: head() }] : [] });
  if (url.pathname === `${W}/repos/recipe-box/log` && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const before = url.searchParams.get("before");
    const list = before ? ingotFake.changesets.slice(ingotFake.changesets.findIndex((x) => x.id === before) + 1) : ingotFake.changesets;
    const page = list.slice(0, limit);
    return json({ changesets: page.map(view), next: list.length > limit ? page.at(-1).id : null });
  }
  if (url.pathname === `${W}/repos/recipe-box/tree` && req.method === "GET") {
    const c = ingotFake.changesets.find((x) => x.id === url.searchParams.get("at"));
    if (!c) return json({ error: "not_found", message: "no changeset" }, 404);
    return json({ at: c.id, files: sorted(c.files) });
  }
  if (url.pathname === `${W}/repos/recipe-box/commit` && req.method === "POST") {
    ingotFake.commits.push({ body, author });
    ingotFake.beforeCommit.shift()?.();
    if (ingotFake.commitAnswer) {
      const a = ingotFake.commitAnswer;
      ingotFake.commitAnswer = null;
      return json(a.body, a.status);
    }
    // crates/ingot-store changeset.rs commit: a message, a stale base refused before anything is read, then each change.
    if (!body?.message?.trim()) return json({ error: "bad_request", message: "a message is required" }, 400);
    if (!body.changes?.length) return json({ error: "empty", message: "no changes to commit" }, 400);
    if ((body.base ?? "") !== (head() ?? "")) return json({ error: "stale", message: "main moved", head: head() }, 409);
    const files = new Map(ingotFake.changesets[0]?.files ?? []);
    const seen = new Set();
    for (const ch of body.changes) {
      if (seen.has(ch.path)) return json({ error: "bad_request", message: `${ch.path}: changed twice in one commit` }, 400);
      seen.add(ch.path);
      if (ch.delete) {
        if (ch.blob) return json({ error: "bad_request", message: "a change either deletes a file or sets its content" }, 400);
        if (!files.has(ch.path)) return json({ error: "not_found", message: `${ch.path}: no such file to delete` }, 404);
        files.delete(ch.path);
        continue;
      }
      if (!ingotFake.blobs.has(ch.blob)) return json({ error: "unknown_blob", message: `${ch.path}: blob is not in recipe-box; send its content` }, 400);
      const executable = typeof ch.executable === "boolean" ? ch.executable : !!files.get(ch.path)?.executable;
      files.set(ch.path, { path: ch.path, blob: ch.blob, size: files.get(ch.path)?.size ?? 1, executable });
    }
    if (same(files, ingotFake.changesets[0]?.files ?? new Map())) return json({ error: "empty", message: "the changes leave every file as it is" }, 400);
    const who = author?.split("; ")[1];
    const c = { id: sha(randomBytes(16)), parents: [head()], author: { id: "u_alex", name: who ? `${who} via Alex` : "Alex" }, message: body.message, at: iso(), files };
    ingotFake.changesets.unshift(c);
    return json({ changeset: view(c) }, 201);
  }
  return json({ error: "not_found", message: "No such route." }, 404);
}

/* ---------------- Its computer: Ingot set up there, the app's working folder, bops-local ---------------- */

/** The computer c_a: its working folder's state (clean, changed or none), how often it was pulled, its Locals, and every script's first line. */
const comp = { folder: "clean", status: "running", pulls: 0, locals: new Map([["recipe-box--recipe-box", "running"]]), starts: [], ran: [], badSyntax: [], statusOut: null };
function statusOutput() {
  if (comp.statusOut) return comp.statusOut;
  const lines = [`${PA}/recipe-box at ${head()?.slice(0, 7)}`];
  if (comp.folder === "clean") lines.push("nothing to commit, the folder matches its base", "not tracked (links and other special files):", "  added     node_modules/.bin/next");
  else lines.push("  modified  src/app.tsx", "  added     notes.md", "  now executable run.sh", "  deleted   old.css");
  return `${lines.join("\n")}\n`;
}
function bash(command) {
  const first = command.split("\n")[0];
  comp.ran.push(first);
  const check = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  if (check.status !== 0) comp.badSyntax.push(`${first}: ${check.stderr.trim()}`);
  if (first === "# bops-ingot status recipe-box") {
    assert.match(command, new RegExp(`if \\[ "\\$there" != '${PA}/recipe-box' \\]; then echo INGOT_FOLDER=none; exit 0; fi`));
    if (comp.folder === "none") return { output: "INGOT_FOLDER=none\n", exit_code: 0 };
    return { output: `${statusOutput()}INGOT_FOLDER=status\n`, exit_code: 0 };
  }
  if (first === "# bops-ingot probe") return { output: [`INGOT_ARCH=amd64`, `INGOT_BIN=${sha(BINARY)}`, `INGOT_CONFIG=${sha(`${JSON.stringify({ url: INGOT })}\n`)}`, `INGOT_TOKEN_FILE=${TOKEN_SUM}`].join("\n"), exit_code: 0 };
  if (first === "# bops-ingot git") return { output: "INGOT_GIT=ok\n", exit_code: 0 };
  if (first === "# bops-ingot folder recipe-box") {
    comp.pulls++;
    return { output: "INGOT_FOLDER=pull\nUpdated to the newest main.\n", exit_code: 0 };
  }
  if (first === "# bops-local install") return { output: "BOPS_LOCAL_TOOL=ok\n", exit_code: 0 };
  let out = "";
  for (const line of command.split("\n")) {
    const [cmd, app, site] = line.replace(/^\/usr\/local\/bin\/bops-local /, "").split(" ");
    if (cmd === "start") {
      comp.starts.push(`${app}--${site}`);
      comp.locals.set(`${app}--${site}`, "running");
    }
    for (const [k, state] of comp.locals) if (k.startsWith(`${app}--`) && (cmd === "status" || k === `${app}--${site}`)) out += `BOPS_LOCAL ${k} ${state} 3000 1761134400 ${Buffer.from("npm run dev").toString("base64")} - -\nBOPS_LOCAL_MORE ${k} dev=3000 auth=0\n`;
  }
  return { output: out, exit_code: 0 };
}

const orgoCalls = [];
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const text = await req.text();
  const body = text ? JSON.parse(text) : undefined;
  if (url.origin === INGOT) {
    if (ingotFake.down) throw new TypeError("fetch failed");
    return ingotApi(req, url, body);
  }
  if (url.origin === ORGO) {
    orgoCalls.push(`${req.method} ${url.pathname}${body?.command ? ` ${body.command.split("\n")[0]}` : ""}`);
    if (url.pathname === "/api/computers/c_a" && req.method === "GET") return json({ id: "c_a", name: "bops-alex", status: comp.status });
    if (url.pathname === "/api/computers/c_a/bash" && req.method === "POST") return comp.bashDown ? json({ error: "Desktop unreachable" }, 502) : json(bash(body.command));
    // Deploys aren't open on this fake: the app's answer says no deploy, and Local's start makes no project.
    if (/\/deploy-projects/.test(url.pathname)) return json({ error: "Deploys are not enabled", code: "DEPLOYS_DISABLED" }, 404);
    if (/\/public-urls/.test(url.pathname)) return json({ enabled: true, public_urls: [] });
    if (/\/domains/.test(url.pathname)) return json({ domains: [] });
    return json({ error: "Not found" }, 404);
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

const S = await import(`${root}/lib/server/store.ts`);
const Auth = await import(`${root}/lib/server/orgo-auth.ts`);
const H = await import(`${root}/lib/server/hosted-apps.ts`);
const I = await import(`${root}/lib/server/ingot.ts`);
const AppRoute = await import(`${root}/app/api/hosted-apps/[name]/route.ts`);
const { sharedMessage, sharedMessages } = await import(`${root}/cloud/ws-slice.ts`);
const { viewState } = await import(`${root}/lib/server/shared-core.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);
clearInterval(globalThis.__bopsRoutines);

await Auth.signIn(KEY, alex);
const CHAT = botChatId("boppy");
/** Each check starts the same: Alex's app recipe-box on his computer c_a, Ingot set up there, no task, no messages. */
function fresh() {
  globalThis.bopsIngotReady?.clear();
  globalThis.bopsIngotListed?.clear();
  globalThis.bopsShared = null;
  Object.assign(ingotFake, { changesets: [], blobs: new Set(), commits: [], calls: [], down: false, beforeCommit: [], commitAnswer: null });
  Object.assign(comp, { folder: "clean", status: "running", pulls: 0, locals: new Map([["recipe-box--recipe-box", "running"]]), starts: [], ran: [], statusOut: null, bashDown: false });
  S.update((s) => {
    s.owner = { name: "Alex", timeZone: "America/New_York" };
    s.workspaces[0].orgoProjectId = PA;
    s.workspaces[0].ingotTokens = { c_a: { id: "7", sum: TOKEN_SUM, at: Date.now() } };
    s.workspaces[0].hostedApps = { "recipe-box": { botId: "boppy", computerId: "c_a" } };
    Object.assign(s.bots.find((x) => x.id === "boppy"), { name: "Boppy", computerStatus: "ready", computerId: "c_a" });
    s.bots = s.bots.filter((x) => x.id !== "ivy");
    s.bots.push({ id: "ivy", name: "Ivy", role: "Design", color: "#2EC4B6", isMain: false, computerStatus: "none" });
    s.sessions = [];
    s.messages = [];
  });
}
/** A task of `botId` on recipe-box, as work_on_app starts one. */
const task = (id, o = {}) => ({ id, botId: "boppy", chatId: CHAT, sentVia: "you", title: "Work on recipe-box", goal: "Work on recipe-box", host: "orgo", status: "done", steps: [], replies: [], createdAt: Date.now(), ...o, app: { wsId: "ws_main", name: "recipe-box", ...o.app } });
const withTask = (t) => S.update((s) => void s.sessions.push(t));
const cards = () => S.getState().messages.filter((m) => m.appChange);
const short = (id) => id.slice(0, 7);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  fresh();
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e?.stack ?? e).split("\n").slice(0, 8).join("\n     ")}`);
  }
}
/** Everything a person reads, checked for dashes at the end. */
const heard = [];
const hear = (x) => (heard.push(typeof x === "string" ? x : JSON.stringify(x)), x);
const post = async (body, window = true) => {
  const res = await AppRoute.POST(new Request("http://localhost:3210/api/hosted-apps/recipe-box", { method: "POST", headers: { "content-type": "application/json", ...(window ? { "x-bops-window": UI } : {}) }, body: JSON.stringify({ ws: "ws_main", ...body }) }), { params: Promise.resolve({ name: "recipe-box" }) });
  return { status: res.status, body: hear(await res.json()) };
};
const confirm = async (to, name = "recipe-box") => {
  const res = await AppRoute.GET(new Request(`http://localhost:3210/api/hosted-apps/${name}?ws=ws_main&restore=${to}`), { params: Promise.resolve({ name }) });
  return { status: res.status, body: hear(await res.json()) };
};
/** A workspace someone shared with Alex is open on this Mac (lib/server/shared.ts sharedOpen). */
const sharedOpenNow = () =>
  (globalThis.bopsShared = { user: S.stateUser(), key: KEY, copy: { openNow: () => ({ projectId: "p_shared" }), data: () => ({ messages: [] }), close() {} }, subscriber: { stop() {} }, moods: { forApp: () => ({}) } });

/** The app's history for most checks: a first version, the bot's two changes (from its computer and from this Mac), Alex's own after. */
function history() {
  const BOT = { id: "u_alex", name: "Boppy on bops-alex via Alex" };
  const v1 = put("A recipe list", BOT, { "index.html": "<h1>Recipes</h1>", "package.json": '{"name":"rb"}', "run.sh": ["#!/bin/sh\nnpm run dev", true], "old.css": "h1{}" });
  const v2 = put("A search box\n\nIt filters as you type.", BOT, { "index.html": "<h1>Recipes</h1><input>", "package.json": '{"name":"rb","dependencies":{"fuse.js":"7"}}', "run.sh": ["#!/bin/sh\nnpm run dev", false], "search.js": "fuse()" });
  const v3 = put("Bigger title", { id: "u_alex", name: "Alex" }, { "index.html": "<h1 class=big>Recipes</h1><input>", "package.json": '{"name":"rb","dependencies":{"fuse.js":"7"}}', "run.sh": ["#!/bin/sh\nnpm run dev", false], "search.js": "fuse()" });
  return { v1, v2, v3 };
}

/* ---------------- The commit Restore asks for, from two changesets' files ---------------- */

const f = (path, text, executable = false) => ({ path, blob: sha(text), size: text.length, executable });

await check("changesTo: what makes one changeset's files another's, in path order: each added, changed or deleted file, an executable bit alone, none when they're the same", async () => {
  const now = [f("a.txt", "a"), f("b.txt", "b"), f("bin/run", "run", true), f("gone.txt", "x"), f("same.txt", "s")];
  const want = [f("a.txt", "a2"), f("b.txt", "b"), f("bin/run", "run", false), f("new/added.txt", "n", true), f("same.txt", "s")];
  assert.deepEqual(I.changesTo(now, want), [
    { path: "a.txt", blob: sha("a2"), executable: false },
    { path: "bin/run", blob: sha("run"), executable: false },
    { path: "gone.txt", delete: true },
    { path: "new/added.txt", blob: sha("n"), executable: true },
  ]);
  // Back the other way: the bit set again, the file deleted again, the one deleted put back.
  assert.deepEqual(I.changesTo(want, now), [
    { path: "a.txt", blob: sha("a"), executable: false },
    { path: "bin/run", blob: sha("run"), executable: true },
    { path: "gone.txt", blob: sha("x"), executable: false },
    { path: "new/added.txt", delete: true },
  ]);
  assert.deepEqual(I.changesTo(now, now), [], "nothing to do");
  assert.deepEqual(I.changesTo(now, [...now].reverse()), [], "in any order");
  assert.deepEqual(I.changesTo([], [f("x", "1")]), [{ path: "x", blob: sha("1"), executable: false }]);
  assert.deepEqual(I.changesTo([f("x", "1")], []), [{ path: "x", delete: true }]);
  // Every change names a blob it has, with its bit said, or deletes: never content (no bytes go from here).
  for (const c of I.changesTo(now, want)) assert.ok("delete" in c ? Object.keys(c).join() === "path,delete" : Object.keys(c).join() === "path,blob,executable");
});

await check("byBots: Ingot's names for a bot's changesets (this Mac's, its computer's token, Ingot's local mode), never a person's, never another bot whose name starts the same", async () => {
  S.update((s) => s.bots.push({ id: "boppy2", name: "Boppy Two", role: "x", color: "#123456", isMain: false, computerStatus: "none" }));
  const by = (name, id = "u_alex") => I.byBots({ author: { id, name } }, ["boppy"]);
  assert.equal(by("Boppy via Alex"), true, "this Mac's write (authorOf)");
  assert.equal(by("Boppy on bops-alex via Alex"), true, "its computer's token");
  assert.equal(by("whatever", "boppy"), true, "Ingot's local mode keeps the bot's id");
  assert.equal(by("Alex"), false, "Alex's own");
  assert.equal(by("Boppy Two via Alex"), false, "another bot whose name starts the same");
  assert.equal(by("Bops via Alex"), false, "Bops' own (a restore)");
  assert.equal(I.byBots({ author: null }, ["boppy"]), false);
  // A long name: the token's cut to 30 characters.
  S.update((s) => (s.bots.find((x) => x.id === "boppy2").name = "Boppy The Very Long Named Coder Of Recipes"));
  assert.equal(I.byBots({ author: { name: "Boppy The Very Long Named Code on bops-alex via Alex" } }, ["boppy2"]), true);
});

/* ---------------- Restore's question ---------------- */

await check("GET ?restore=: every change after it, newest first, its first line, who and when; Ingot only, no computer asked", async () => {
  const { v1, v2, v3 } = history();
  const n = orgoCalls.length;
  const r = await confirm(v1.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    later: [
      { id: v3.id, title: "Bigger title", author: "Alex", at: Date.parse(v3.at) },
      { id: v2.id, title: "A search box", author: "Boppy on bops-alex via Alex", at: Date.parse(v2.at) },
    ],
  });
  assert.equal(orgoCalls.length, n, "nothing asked of the computer or Orgo");
  // Its newest: nothing after it to undo.
  const now = await confirm(v3.id);
  assert.deepEqual([now.status, now.body.later, now.body.blocked], [200, [], `recipe-box is at ${short(v3.id)} now, so there's nothing to restore.`]);
});

await check("GET ?restore=: blocked while a task works on it, while Ingot isn't answering; a changeset that isn't one of it, or isn't an id, refused", async () => {
  const { v1 } = history();
  withTask(task("ses_live", { status: "running" }));
  const busy = await confirm(v1.id);
  assert.equal(busy.body.blocked, "Boppy is working on recipe-box now. Restore it once that task ends.");
  assert.equal(busy.body.later.length, 2, "still says what it would undo");
  S.update((s) => (s.sessions = []));
  ingotFake.down = true;
  const down = await confirm(v1.id);
  assert.deepEqual([down.status, down.body.blocked], [200, "Ingot isn't answering, so it can't be restored just now. Try again in a minute."]);
  ingotFake.down = false;
  assert.deepEqual([(await confirm("f".repeat(64))).status, (await confirm("abc")).status, (await confirm(v1.id, "no-such-app")).status], [404, 400, 404]);
  const none = await AppRoute.GET(new Request("http://localhost:3210/api/hosted-apps/recipe-box?ws=ws_main"), { params: Promise.resolve({ name: "recipe-box" }) });
  assert.equal(none.status, 400);
});

await check("GET ?restore=: the owner's alone (403 while a shared workspace is open), and 404 for an account apps aren't open to", async () => {
  const { v1 } = history();
  sharedOpenNow();
  const r = await confirm(v1.id);
  assert.deepEqual([r.status, r.body.error], [403, "Only the owner can restore an app."]);
  globalThis.bopsShared = null;
  S.update((s) => (s.account.user.email = "alex@example.com"));
  try {
    assert.equal((await confirm(v1.id)).status, 404);
  } finally {
    S.update((s) => (s.account.user.email = "alex@orgo.ai"));
  }
});

/* ---------------- Restore ---------------- */

await check("Restore: the folder's status read first, one commit on main's newest naming blobs Ingot has (adds, changes, deletes, executable bits) by Bops, then the folder pulled; the files are the old ones again, history a line", async () => {
  const { v1, v2, v3 } = history();
  const r = await post({ action: "restore", to: v1.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ingotFake.commits.length, 1);
  const { body, author } = ingotFake.commits[0];
  assert.equal(author, "bops; Bops", "Bops' own write (authorOf)");
  assert.deepEqual({ ref: body.ref, base: body.base, message: body.message }, { ref: "main", base: v3.id, message: `Restore recipe-box to ${short(v1.id)}` });
  assert.deepEqual(body.changes, [
    { path: "index.html", blob: sha("<h1>Recipes</h1>"), executable: false },
    { path: "old.css", blob: sha("h1{}"), executable: false },
    { path: "package.json", blob: sha('{"name":"rb"}'), executable: false },
    { path: "run.sh", blob: sha("#!/bin/sh\nnpm run dev"), executable: true },
    { path: "search.js", delete: true },
  ]);
  assert.ok(!JSON.stringify(body).includes("content_base64"), "no bytes sent");
  const made = ingotFake.changesets[0];
  assert.ok(same(made.files, v1.files), "its files are v1's again");
  assert.deepEqual(made.parents, [v3.id], "on top of main: nothing is lost");
  assert.deepEqual(ingotFake.changesets.map((c) => c.id), [made.id, v3.id, v2.id, v1.id]);
  assert.equal(made.author.name, "Bops via Alex");
  assert.equal(r.body.restored, made.id);
  assert.equal(r.body.app.name, "recipe-box");
  // In order: the folder's status before the commit, the pull after it.
  const statusAt = comp.ran.indexOf("# bops-ingot status recipe-box");
  const pullAt = comp.ran.indexOf("# bops-ingot folder recipe-box");
  assert.ok(statusAt >= 0 && pullAt > statusAt, comp.ran.join(" | "));
  assert.equal(comp.pulls, 1);
  const commitAt = ingotFake.calls.findIndex((c) => c === `POST ${W}/repos/recipe-box/commit`);
  assert.ok(commitAt > ingotFake.calls.findIndex((c) => c.startsWith(`GET ${W}/repos/recipe-box/tree?at=${v3.id}`)), "the commit after both trees were read");
  // package.json changed: its Local that runs starts again (bops-local start installs first).
  assert.deepEqual(comp.starts, ["recipe-box--recipe-box"]);
  assert.equal(r.body.said, `Restored recipe-box to ${short(v1.id)}, as a new change (${short(made.id)}). What it installs changed, so its Local is starting again with a fresh install.`);
  assert.deepEqual(comp.badSyntax, []);
});

await check("Restore: nothing it installs from changed, so its Local isn't started again; a folder not on its computer is neither read nor pulled after the status says so; Ingot's executable bit kept", async () => {
  const BOT = { id: "u_alex", name: "Boppy via Alex" };
  const a = put("One", BOT, { "index.html": "1", "run.sh": ["x", true] });
  put("Two", BOT, { "index.html": "2", "run.sh": ["x", true] });
  const r = await post({ action: "restore", to: a.id });
  assert.equal(r.status, 200);
  assert.deepEqual(ingotFake.commits[0].body.changes, [{ path: "index.html", blob: sha("1"), executable: false }]);
  assert.equal(ingotFake.changesets[0].files.get("run.sh").executable, true);
  assert.deepEqual(comp.starts, []);
  assert.equal(r.body.said, `Restored recipe-box to ${short(a.id)}, as a new change (${short(ingotFake.changesets[0].id)}).`);
  // No working folder there (never cloned): committed, nothing pulled (its bot's next task clones it).
  fresh();
  const b = put("One", BOT, { "index.html": "1" });
  put("Two", BOT, { "index.html": "2" });
  comp.folder = "none";
  const r2 = await post({ action: "restore", to: b.id });
  assert.equal(r2.status, 200);
  assert.equal(ingotFake.commits.length, 1);
  assert.equal(comp.pulls, 0);
});

await check("Restore refused while a task works on the app: nothing read on its computer, nothing committed", async () => {
  const { v1 } = history();
  withTask(task("ses_live", { status: "queued" }));
  const r = await post({ action: "restore", to: v1.id });
  assert.deepEqual([r.status, r.body.error], [409, "Boppy is working on recipe-box now. Restore it once that task ends."]);
  assert.equal(ingotFake.commits.length, 0);
  assert.deepEqual(comp.ran, []);
  // One that ended doesn't stop it.
  S.update((s) => (s.sessions[0].status = "failed"));
  assert.equal((await post({ action: "restore", to: v1.id })).status, 200);
});

await check("Restore refused while its working folder has changes nobody committed: said with the files, nothing committed, nothing pulled", async () => {
  const { v1 } = history();
  comp.folder = "dirty";
  const r = await post({ action: "restore", to: v1.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "recipe-box's working folder on its computer has changes nobody committed (src/app.tsx, notes.md, run.sh and 1 more), so it wasn't restored. Ask its bot to commit them, or to put them back, first.");
  assert.deepEqual(r.body.changed, ["src/app.tsx", "notes.md", "run.sh", "old.css"]);
  assert.equal(ingotFake.commits.length, 0);
  assert.equal(comp.pulls, 0);
  // A conflict left by a pull counts too; a file it doesn't track (a link) doesn't.
  comp.folder = "clean";
  comp.statusOut = `${PA}/recipe-box at abc1234\nnothing to commit, the folder matches its base\nconflicts to resolve before committing:\n  index.html\nnot tracked (links and other special files):\n  node_modules/.bin/next\n`;
  const c = await post({ action: "restore", to: v1.id });
  assert.deepEqual([c.status, c.body.changed], [409, ["index.html"]]);
  comp.statusOut = `${PA}/recipe-box at abc1234\nsomething it doesn't know\n`;
  const odd = await post({ action: "restore", to: v1.id });
  assert.equal(odd.status, 502, "a status it can't read isn't taken for clean");
  // Its computer not answering: not taken for clean either.
  comp.statusOut = null;
  comp.bashDown = true;
  const away = await post({ action: "restore", to: v1.id });
  assert.deepEqual([away.status, away.body.error], [502, "Couldn't reach its computer just now, so its working folder couldn't be checked. Try again in a minute."]);
  assert.equal(ingotFake.commits.length, 0);
});

await check("Restore: the owner's alone (403 with a shared workspace open), from the Bops window only, a changeset of it only", async () => {
  const { v1 } = history();
  sharedOpenNow();
  const shared = await post({ action: "restore", to: v1.id });
  assert.deepEqual([shared.status, shared.body.error], [403, "Only the owner can restore an app."]);
  globalThis.bopsShared = null;
  assert.equal((await post({ action: "restore", to: v1.id }, false)).status, 403, "not from the Bops window");
  assert.equal((await post({ action: "restore", to: "zz" })).status, 400);
  assert.equal((await post({ action: "restore" })).status, 400);
  assert.equal((await post({ action: "restore", to: "e".repeat(64) })).status, 404);
  assert.equal(ingotFake.commits.length, 0);
  assert.deepEqual(comp.ran, []);
});

await check("Restore when main moved as it was committed (Ingot's stale): made again once from main's newest, saying so; moved twice, refused, nothing written", async () => {
  const { v1 } = history();
  // Someone commits as Restore's commit comes in: Ingot answers stale with where main is now.
  ingotFake.beforeCommit.push(() => put("Dark mode", { id: "u_alex", name: "Alex" }, { "index.html": "<h1>Dark</h1>", "package.json": '{"name":"rb"}', "run.sh": ["#!/bin/sh\nnpm run dev", true], "old.css": "h1{}" }));
  const r = await post({ action: "restore", to: v1.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ingotFake.commits.length, 2);
  const [first, second] = ingotFake.commits.map((c) => c.body);
  assert.notEqual(first.base, second.base);
  assert.equal(second.base, ingotFake.changesets[1].id, "the second on main's newest");
  // Made again from main's newest: only index.html differs from v1 there.
  assert.deepEqual(second.changes, [{ path: "index.html", blob: sha("<h1>Recipes</h1>"), executable: false }]);
  assert.ok(same(ingotFake.changesets[0].files, v1.files));
  assert.match(r.body.said, /Someone committed to it as it was being restored, so that change is undone too\./);
  // Twice: refused, saying so.
  fresh();
  const h2 = history();
  const move = () => put("Again", { id: "u_alex", name: "Alex" }, { "index.html": String(Math.random()) });
  ingotFake.beforeCommit.push(move, move);
  const n = ingotFake.changesets.length;
  const again = await post({ action: "restore", to: h2.v1.id });
  assert.deepEqual([again.status, again.body.error], [409, "Someone committed to recipe-box twice as it was being restored, so it wasn't. Look at its history, then try again."]);
  assert.equal(ingotFake.changesets.length, n + 2, "only the two others' changes");
  assert.equal(comp.pulls, 0);
});

await check("Restore to what it is already (nothing to change, or Ingot's empty): said, nothing committed, the computer not asked", async () => {
  const BOT = { id: "u_alex", name: "Boppy via Alex" };
  const a = put("One", BOT, { "index.html": "1" });
  put("Two", BOT, { "index.html": "2" });
  put("One again", BOT, { "index.html": "1" });
  const r = await post({ action: "restore", to: a.id });
  assert.deepEqual([r.status, r.body.restored, r.body.said], [200, undefined, `recipe-box is as it was at ${short(a.id)} already, so there was nothing to restore.`]);
  assert.equal(ingotFake.commits.length, 0);
  assert.deepEqual(comp.ran, []);
  // Ingot itself says empty (its own check, after this one's): the same words.
  put("Two again", BOT, { "index.html": "2" });
  ingotFake.commitAnswer = { status: 400, body: { error: "empty", message: "the changes leave every file as it is" } };
  const e = await post({ action: "restore", to: a.id });
  assert.deepEqual([e.status, e.body.said], [200, `recipe-box is as it was at ${short(a.id)} already, so there was nothing to restore.`]);
  assert.equal(comp.pulls, 0);
});

await check("Restore: Ingot not answering is said (503), its other refusals in its words; a restore already under way refuses a second", async () => {
  const { v1 } = history();
  ingotFake.down = true;
  const down = await post({ action: "restore", to: v1.id });
  assert.deepEqual([down.status, down.body.error], [503, "Ingot isn't answering, so it can't be restored just now. Try again in a minute."]);
  ingotFake.down = false;
  ingotFake.commitAnswer = { status: 413, body: { error: "too_large", message: "the request is over the size limit" } };
  const big = await post({ action: "restore", to: v1.id });
  assert.deepEqual([big.status, big.body.error], [502, "Couldn't commit to recipe-box: the request is over the size limit"]);
  // Two presses at once: one goes, the other is refused.
  const [x, y] = await Promise.all([post({ action: "restore", to: v1.id }), post({ action: "restore", to: v1.id })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.ok([x.body.error, y.body.error].includes("recipe-box is being restored already."));
});

await check("Restore marks the cards whose change it put back Restored (theirs alone: another app's, or another change's, stay)", async () => {
  const { v1, v2 } = history();
  const card = (app, from, to) => ({ chatId: CHAT, role: "bot", botId: "boppy", text: "Changed", appNote: true, bops: true, appChange: { ws: "ws_main", app, from, to, title: "x", count: 1, authors: [] } });
  S.addMessage(card("recipe-box", v1.id, v2.id));
  S.addMessage(card("recipe-box", v2.id, v2.id));
  S.addMessage(card("other-app", v1.id, v2.id));
  assert.equal((await post({ action: "restore", to: v1.id })).status, 200);
  assert.deepEqual(
    cards().map((m) => m.appChange.restored ?? false),
    [true, false, false],
  );
});

/* ---------------- The card once a task's run ended ---------------- */

await check("The card: the bot's newest changeset since the task first ran, its first line and short id, how many in all and whose; an appNote in its chat as the bot, in words an older Bops shows", async () => {
  const BOT = { id: "u_alex", name: "Boppy on bops-alex via Alex" };
  const start = put("A recipe list", { id: "u_alex", name: "Alex" }, { "index.html": "1" });
  withTask(task("ses_a", { app: { startHead: start.id } }));
  const c1 = put("A search box\n\nIt filters as you type.", BOT, { "index.html": "2" });
  const mid = put("Typo", { id: "u_alex", name: "Alex" }, { "index.html": "3" });
  const c2 = put("Favorites", { id: "u_alex", name: "Boppy via Alex" }, { "index.html": "4" });
  // Alex's own after the bot's newest isn't this change.
  put("Alex again", { id: "u_alex", name: "Alex" }, { "index.html": "5" });
  await H.changeCardAfterTask("ses_a");
  const [m] = cards();
  assert.ok(m);
  assert.deepEqual(m.appChange, { ws: "ws_main", app: "recipe-box", from: start.id, to: c2.id, title: "Favorites", count: 3, authors: ["Boppy via Alex", "Alex", "Boppy on bops-alex via Alex"] });
  assert.deepEqual({ chatId: m.chatId, role: m.role, botId: m.botId, sessionIds: m.sessionIds, appNote: m.appNote, bops: m.bops }, { chatId: CHAT, role: "bot", botId: "boppy", sessionIds: ["ses_a"], appNote: true, bops: true });
  hear(m.text);
  assert.equal(m.text, `Changed recipe-box: Favorites (${short(c2.id)}), the newest of 3 changes`);
  void c1;
  void mid;
});

await check("The card once a run: the paths a run ends by each call it, at once or after; a later run's card from where the last ended; none when the task committed nothing", async () => {
  const BOT = { id: "u_alex", name: "Boppy on bops-alex via Alex" };
  const start = put("A recipe list", { id: "u_alex", name: "Alex" }, { "index.html": "1" });
  withTask(task("ses_b", { app: { startHead: start.id } }));
  // Nothing of the bot's yet (Alex's own only): no card.
  put("Alex's", { id: "u_alex", name: "Alex" }, { "index.html": "x" });
  await H.changeCardAfterTask("ses_b");
  assert.equal(cards().length, 0);
  const c1 = put("A search box", BOT, { "index.html": "2" });
  await Promise.all([H.changeCardAfterTask("ses_b"), H.changeCardAfterTask("ses_b")]);
  await H.changeCardAfterTask("ses_b");
  assert.equal(cards().length, 1, "once");
  assert.equal(cards()[0].text, `Changed recipe-box: A search box (${short(c1.id)}), the newest of 2 changes`);
  // Its next run (an answer to its question): only that run's changes.
  const c2 = put("Favorites", BOT, { "index.html": "3" });
  await H.changeCardAfterTask("ses_b");
  assert.equal(cards().length, 2);
  assert.deepEqual([cards()[1].appChange.from, cards()[1].appChange.to, cards()[1].appChange.count], [c1.id, c2.id, 1]);
  assert.equal(cards()[1].text, `Changed recipe-box: Favorites (${short(c2.id)})`);
  // A run that committed nothing more: none.
  await H.changeCardAfterTask("ses_b");
  assert.equal(cards().length, 2);
});

await check("No card without where the app was as the task first ran, for a routine's run, one moved on, or another account's state; a new app's card is from before its first changeset", async () => {
  const BOT = { id: "u_alex", name: "Boppy via Alex" };
  const first = put("A recipe list", BOT, { "index.html": "1" });
  withTask(task("ses_none"));
  withTask(task("ses_routine", { routineId: "r1", app: { startHead: null } }));
  withTask(task("ses_moved", { replacedBy: "ses_x", app: { startHead: null } }));
  for (const id of ["ses_none", "ses_routine", "ses_moved"]) await H.changeCardAfterTask(id);
  assert.equal(cards().length, 0);
  // A new app (nothing committed as its task first ran): from null, its first changeset on.
  withTask(task("ses_new", { app: { startHead: null } }));
  await H.changeCardAfterTask("ses_new");
  assert.deepEqual([cards().length, cards()[0].appChange.from, cards()[0].appChange.to, cards()[0].appChange.count], [1, null, first.id, 1]);
  // Ingot not answering: no card, nothing thrown.
  withTask(task("ses_down", { app: { startHead: null } }));
  ingotFake.down = true;
  await H.changeCardAfterTask("ses_down");
  ingotFake.down = false;
  assert.equal(cards().length, 1);
});

await check("The card counts a bot's changesets named after the computer it works on (another bot's): Ivy on Boppy's computer", async () => {
  S.update((s) => Object.assign(s.bots.find((x) => x.id === "ivy"), { computerId: undefined }));
  // Ivy has no computer of her own: she works on the main bot's, whose token names her commits.
  const start = put("A recipe list", { id: "u_alex", name: "Alex" }, { "index.html": "1" });
  withTask(task("ses_ivy", { botId: "ivy", chatId: botChatId("ivy"), app: { startHead: start.id } }));
  const c = put("Pink buttons", { id: "u_alex", name: "Boppy on bops-alex via Alex" }, { "index.html": "2" });
  await H.changeCardAfterTask("ses_ivy");
  assert.deepEqual([cards().length, cards()[0]?.appChange.to, cards()[0]?.chatId], [1, c.id, botChatId("ivy")]);
});

await check("sessions.ts: the card asked for after a run that ended done (with deployAfterTask and previewAfterTask), and after one that failed or was stopped", async () => {
  const src = readFileSync(`${root}/lib/server/sessions.ts`, "utf8");
  const runAt = src.indexOf("async function run(sessionId");
  const doneAt = src.indexOf('patchSession(sessionId, { status: "done"', runAt);
  const preview = src.indexOf("void previewAfterTask(sessionId)", doneAt);
  const cardDone = src.indexOf("void changeCardAfterTask(sessionId)", doneAt);
  assert.ok(preview > doneAt && cardDone > preview && cardDone - preview < 400, "after the result, beside the other two");
  const failedAt = src.indexOf("if (!stopped.has(sessionId)) void deployAfterTask(sessionId)", runAt);
  const cardFailed = src.indexOf("void changeCardAfterTask(sessionId)", failedAt);
  assert.ok(failedAt > cardDone && cardFailed > failedAt && cardFailed - failedAt < 400, "and after a failure, the user's Stop too");
  assert.ok(!/if \(!stopped\.has\(sessionId\)\) void changeCardAfterTask/.test(src));
});

/* ---------------- Never a member's ---------------- */

await check("Bops Cloud never carries the card (cloud/ws-slice.ts keeps only the fields it names): a member with Your Apps reads its words, one without none of it", async () => {
  const msg = { id: "m1", chatId: CHAT, role: "bot", botId: "boppy", text: "Changed recipe-box: Favorites (abc1234)", at: 1, sessionIds: ["ses_a"], appNote: true, bops: true, appChange: { ws: "ws_main", app: "recipe-box", from: "a".repeat(64), to: "b".repeat(64), title: "Favorites", count: 1, authors: ["Alex"] } };
  // The owner's own view of the slice, and a member given the bot and Your Apps at Write (appBots): its words alone.
  for (const got of [sharedMessage(msg), sharedMessage(msg, new Set(["boppy"]), new Set(), new Set(), new Set(["boppy"]))]) {
    assert.ok(got);
    assert.equal(got.appChange, undefined);
    assert.equal(got.text, msg.text);
  }
  // A member given the bot but not its apps: not the message at all (an appNote).
  assert.equal(sharedMessage(msg, new Set(["boppy"])), null);
  assert.deepEqual(sharedMessages([msg], new Set(["boppy"])), []);
});

await check("A shared workspace's view drops the card from any copy that has it (lib/server/shared-core.ts viewState): its words stay", async () => {
  const own = { ...S.getState(), messages: [] };
  const data = {
    projectId: "p_shared",
    wsId: "ws_main",
    role: "member",
    name: "Acme",
    hash: "h",
    seq: 1,
    state: { workspace: { id: "ws_main", name: "Acme", createdAt: 1 }, bots: [{ id: "boppy", name: "Boppy", isMain: true }], chats: [{ id: CHAT, kind: "bot", botIds: ["boppy"] }], sessions: [], routines: [], watches: [] },
    messages: [{ id: "m1", chatId: CHAT, role: "bot", botId: "boppy", text: "Changed recipe-box: Favorites (abc1234)", at: 1, appNote: true, bops: true, appChange: { ws: "ws_main", app: "recipe-box", from: null, to: "b".repeat(64), title: "Favorites", count: 1, authors: [] } }],
    more: [],
  };
  const v = viewState(own, { projectId: "p_shared", name: "Acme", owner: "dana@orgo.ai", role: "member", wsId: "shared:p_shared" }, data, {});
  const m = v.messages.find((x) => x.id === "m1");
  assert.ok(m);
  assert.equal(m.appChange, undefined);
  assert.equal(m.text, "Changed recipe-box: Favorites (abc1234)");
});

await check("Nothing a person reads has a dash", async () => {
  for (const x of heard) assert.ok(!/[–—]| - /.test(x), x);
  for (const m of S.getState().messages) assert.ok(!/[–—]| - /.test(m.text), m.text);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`app restore: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
