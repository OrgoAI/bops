// Tests for a bot that keeps its memory to itself (lib/chain.ts memory "own", lib/server/memory.ts MemoryScope): its chats,
// tasks and facts land in a bank of its own (<team bank>-bot-<id>) and never in the team's; its memory block reads both
// banks while it still knows what the team knows, and only its own when it doesn't; recall asks its own bank and falls back
// to the team's only when that said nothing; the other bots' memory blocks and recall, and Knowledge, never see what it
// learned; Bring it in copies its facts into the team's and deletes its bank, Keep it apart leaves both; deleting the bot
// deletes its bank, through the outbox when memory is off then (and no new bot gets its id while it waits); and the main
// bot always uses the team's memory.
//
// Honcho is a fake answering the REST calls its SDK makes, Jev isn't set up, the Keychain is a stand-in that's never
// there, and the state lives in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-memory-own.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-memory-own";
process.env.HONCHO_API_KEY = "hc-test-memory-own";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-memory-own-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// Modules that would start processes when loaded, and the threads, are stand-ins whose exports do nothing.
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
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));

/* ---------------- Honcho: a fake of the REST calls the SDK makes ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const iso = (ms) => new Date(ms).toISOString();
const honcho = { banks: new Map(), calls: [], seq: 0 };
function hbank(id) {
  let b = honcho.banks.get(id);
  if (!b) honcho.banks.set(id, (b = { cards: new Map(), facts: [], sessions: new Map() }));
  return b;
}
const asConclusion = (f) => ({ id: f.id, content: f.text, observer_id: "user", observed_id: "user", session_id: f.session, created_at: iso(f.at), level: "explicit", source_ids: null, times_derived: 1 });
const addFact = (bank, text, session = null) => {
  const f = { id: `c${++honcho.seq}`, text, at: Date.now(), session };
  hbank(bank).facts.push(f);
  return f;
};
const words = (t) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
const near = (bank, q) => hbank(bank).facts.filter((f) => [...words(q)].some((w) => words(f.text).has(w)));

async function honchoAnswer(req, url) {
  const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : undefined };
  honcho.calls.push(call);
  const p = url.pathname.split("/").slice(1);
  const created_at = iso(0);
  if (p.length === 2 && req.method === "POST") {
    hbank(call.body.id);
    return json({ id: call.body.id, metadata: {}, configuration: {}, created_at });
  }
  if (p.length === 3 && req.method === "DELETE") {
    if (!honcho.banks.has(p[2])) return json({ detail: "Workspace not found" }, 404);
    honcho.banks.delete(p[2]);
    return new Response(null, { status: 202 });
  }
  const id = p[2];
  const b = hbank(id);
  const rest = p.slice(3).join("/");
  if (rest === "peers" && req.method === "POST") return json({ id: call.body.id, workspace_id: id, metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, created_at });
  const card = rest.match(/^peers\/([^/]+)\/card$/);
  if (card && req.method === "GET") return json({ peer_card: b.cards.get(card[1]) ?? null });
  if (/^peers\/[^/]+\/context$/.test(rest)) {
    const q = call.query.search_query ?? "";
    return json({ peer_id: "user", target_id: "user", representation: near(id, q).map((f) => `[explicit] ${f.text}`).join("\n"), peer_card: b.cards.get("user") ?? [] });
  }
  if (/^peers\/[^/]+\/chat$/.test(rest)) return json({ content: near(id, call.body.query ?? "").map((f) => f.text).join(" ") });
  if (rest === "conclusions/query" && req.method === "POST") return json(near(id, call.body.query ?? "").map(asConclusion));
  if (rest === "conclusions/list" && req.method === "POST") {
    const size = Number(call.query.size ?? 50);
    const page = Number(call.query.page ?? 1);
    const all = [...b.facts].reverse();
    return json({ items: all.slice((page - 1) * size, page * size).map(asConclusion), total: all.length, page, size, pages: Math.max(1, Math.ceil(all.length / size)) });
  }
  if (rest === "conclusions" && req.method === "POST") return json(call.body.conclusions.map((c) => asConclusion(addFact(id, c.content, c.session_id ?? null))));
  const one = rest.match(/^conclusions\/([^/]+)$/);
  if (one && req.method === "DELETE") {
    if (!b.facts.some((f) => f.id === one[1])) return json({ detail: "Conclusion not found" }, 404);
    b.facts = b.facts.filter((f) => f.id !== one[1]);
    return new Response(null, { status: 204 });
  }
  if (rest === "sessions" && req.method === "POST") {
    let x = b.sessions.get(call.body.id);
    if (!x) b.sessions.set(call.body.id, (x = { id: call.body.id, metadata: call.body.metadata ?? {}, messages: [] }));
    return json({ id: x.id, workspace_id: id, is_active: true, metadata: x.metadata, configuration: {}, created_at });
  }
  const sess = rest.match(/^sessions\/([^/]+)(?:\/(.*))?$/);
  if (sess) {
    const x = b.sessions.get(sess[1]);
    if (!x) return json({ detail: "Session not found" }, 404);
    if (sess[2] === "peers" && req.method === "POST") return json({ id: x.id, workspace_id: id, is_active: true, metadata: x.metadata, configuration: {}, created_at });
    if (sess[2] === "messages" && req.method === "POST") {
      const made = call.body.messages.map((m) => ({ id: `m${++honcho.seq}`, content: m.content, peer_id: m.peer_id, session_id: x.id, workspace_id: id, metadata: m.metadata ?? {}, created_at: iso(Date.now()), token_count: 1 }));
      x.messages.push(...made);
      return json(made);
    }
  }
  return json({ detail: "Not Found" }, 404);
}

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.honcho.dev") return honchoAnswer(req, url);
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

const S = await import(`${root}/lib/server/store.ts`);
const Mem = await import(`${root}/lib/server/memory.ts`);
const MD = await import(`${root}/lib/server/memory-deletes.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);

// The main workspace: Boppy runs it (bank "bops"). Juno keeps its memory to itself and still reads the team's; Rex keeps
// its own and reads only its own; Max uses the team's.
S.update((s) => {
  s.owner = { name: "Alex" };
  for (const [id, name] of [["juno", "Juno"], ["rex", "Rex"], ["max", "Max"]]) {
    s.bots.push({ id, name, role: "Assistant", color: "#4F7BF7", isMain: false, computerStatus: "none" });
    s.chats.push({ id: botChatId(id), kind: "bot", botIds: [id], typing: [] });
  }
  s.workspaces[0].chain = { bots: { juno: { memory: "own" }, rex: { memory: "own", readsTeam: false }, boppy: { memory: "own" } } };
});
// What's on the team's card ("About you").
hbank("bops").cards.set("user", ["Alex works at Acme"]);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n${e.stack}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(15)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
}
const messagesIn = (bank) => [...hbank(bank).sessions.values()].flatMap((x) => x.messages.map((m) => m.content));
const factsIn = (bank) => hbank(bank).facts.map((f) => f.text);

await check("each bot's memory scope: its own bank while it keeps its memory to itself, the team's otherwise; never the main bot's own", () => {
  assert.deepEqual(Mem.scopeOf("juno"), { ws: "ws_main", bot: "juno", readsTeam: true });
  assert.deepEqual(Mem.scopeOf("rex"), { ws: "ws_main", bot: "rex", readsTeam: false });
  assert.deepEqual(Mem.scopeOf("max"), { ws: "ws_main" });
  assert.deepEqual(Mem.scopeOf("boppy"), { ws: "ws_main" }, "the main bot always uses the team's memory");
  assert.deepEqual(Mem.bindingOf(Mem.scopeOf("juno")), { bank: "bops-bot-juno", peer: "user" });
  assert.deepEqual(Mem.bindingOf("ws_main"), { bank: "bops", peer: "user" });
});

await check("its chats, tasks and facts land in its own bank, never in the team's", async () => {
  Mem.saveToMemory(Mem.scopeOf("juno"), "chat", botChatId("juno"), [{ who: Mem.OWNER_WHO, text: "Book my dentist for Tuesday" }], { chat: "Juno" });
  Mem.saveToMemory(Mem.scopeOf("juno"), "task", "ses_j1", [{ who: Mem.OWNER_WHO, text: "Find a dentist near the office" }, { who: "juno", text: "Found three." }]);
  Mem.rememberMessage(Mem.scopeOf("juno"), botChatId("juno"), "msg_j1", "I see the dentist every spring");
  assert.equal(await Mem.learn(Mem.scopeOf("juno"), "Alex sees the dentist every spring.", botChatId("juno")), "Saved.");
  await until(() => messagesIn("bops-bot-juno").length >= 4, "its saves");
  assert.deepEqual(messagesIn("bops-bot-juno").sort(), ["Book my dentist for Tuesday", "Find a dentist near the office", "Found three.", "I see the dentist every spring"].sort());
  assert.deepEqual(factsIn("bops-bot-juno"), ["Alex sees the dentist every spring."]);
  assert.deepEqual(messagesIn("bops"), [], "nothing of it in the team's");
  assert.deepEqual(factsIn("bops"), []);
  // The chat's note keeps whose bank it went to, so Undo takes it from there.
  const note = S.getState().messages.find((m) => m.memory?.fact === "Alex sees the dentist every spring.");
  assert.deepEqual([note.memory.ws, note.memory.bot], ["ws_main", "juno"]);
  await Mem.undoMemory(note.id, "undo");
  assert.deepEqual(factsIn("bops-bot-juno"), []);
  await Mem.learn(Mem.scopeOf("juno"), "Alex sees the dentist every spring.");
});

await check("its memory block reads its own bank and the team's while it knows what the team knows; only its own when it doesn't", async () => {
  await Mem.learn("ws_main", "Alex's dentist is on Elm Road near the office.");
  const juno = await Mem.memoryBlock(Mem.scopeOf("juno"), "when is the dentist?");
  assert.match(juno, /Alex sees the dentist every spring\./);
  assert.match(juno, /Alex's dentist is on Elm Road/);
  assert.match(juno, /- Alex works at Acme/);
  await Mem.learn(Mem.scopeOf("rex"), "Alex prefers the dentist in the morning.");
  const rex = await Mem.memoryBlock(Mem.scopeOf("rex"), "when is the dentist?");
  assert.match(rex, /Alex prefers the dentist in the morning\./);
  assert.ok(!/Elm Road|Acme/.test(rex), "nothing of the team's");
  const reads = honcho.calls.filter((c) => c.path.endsWith("/peers/user/context")).map((c) => c.path.split("/")[3]);
  assert.deepEqual([...new Set(reads)].sort(), ["bops", "bops-bot-juno", "bops-bot-rex"]);
});

await check("the other bots' memory blocks, recall and Knowledge never see what it learned", async () => {
  const max = await Mem.memoryBlock(Mem.scopeOf("max"), "when is the dentist?");
  assert.match(max, /Elm Road/);
  assert.ok(!/every spring|in the morning/.test(max));
  assert.ok(!/every spring/.test(await Mem.recall(Mem.scopeOf("max"), "when does Alex see the dentist every spring?")));
  // Knowledge is built from the team's bank.
  const { rows } = await Mem.scanFacts("ws_main", 100);
  assert.deepEqual(rows.map((r) => r.text), ["Alex's dentist is on Elm Road near the office."]);
});

await check("recall asks its own bank first, and the team's only when that said nothing and it reads the team's", async () => {
  const h = honcho.calls.length;
  assert.equal(await Mem.recall(Mem.scopeOf("juno"), "does Alex go every spring?"), "Alex sees the dentist every spring.");
  assert.deepEqual(honcho.calls.slice(h).filter((c) => c.path.endsWith("/chat")).map((c) => c.path.split("/")[3]), ["bops-bot-juno"]);
  const k = honcho.calls.length;
  assert.match(await Mem.recall(Mem.scopeOf("juno"), "which road is the office on?"), /Elm Road/);
  assert.deepEqual(honcho.calls.slice(k).filter((c) => c.path.endsWith("/chat")).map((c) => c.path.split("/")[3]), ["bops-bot-juno", "bops"]);
  assert.equal(await Mem.recall(Mem.scopeOf("rex"), "which road is the office on?"), "Nothing on that.", "Rex reads only its own");
});

await check("its Memory tab shows its own memory, and says so", async () => {
  const tab = await Mem.memoryFor("juno");
  assert.equal(tab.own, true);
  assert.deepEqual(tab.facts.map((f) => f.text), ["Alex sees the dentist every spring."]);
  assert.equal((await Mem.memoryFor("max")).own, undefined);
});

await check("Keep it apart leaves both banks; Bring it in copies its facts into the team's and deletes its bank", async () => {
  // Kept apart: the chart says so, and nothing moves.
  S.update((s) => (s.workspaces[0].chain.bots.juno = { kept: true }));
  assert.deepEqual(Mem.scopeOf("juno"), { ws: "ws_main" }, "it uses the team's memory from now on");
  assert.deepEqual(factsIn("bops-bot-juno"), ["Alex sees the dentist every spring."]);
  assert.ok(!(await Mem.memoryBlock(Mem.scopeOf("juno"), "dentist every spring")).includes("every spring"), "nothing reads the bank kept apart");
  // Memory off (signed out): nothing is brought in, and nothing is deleted.
  delete process.env.HONCHO_API_KEY;
  try {
    await assert.rejects(MD.bringInOwnBank("juno"), /Memory isn't on right now/);
  } finally {
    process.env.HONCHO_API_KEY = "hc-test-memory-own";
  }
  assert.deepEqual(factsIn("bops-bot-juno"), ["Alex sees the dentist every spring."]);
  assert.deepEqual(MD.memoryDeletesForTests.waiting(), []);
  // Brought in.
  assert.equal(await MD.bringInOwnBank("juno"), 1);
  assert.ok(factsIn("bops").includes("Alex sees the dentist every spring."));
  assert.equal(honcho.banks.has("bops-bot-juno"), false, "its bank is deleted");
  assert.deepEqual(MD.memoryDeletesForTests.waiting(), []);
});

await check("deleting a bot deletes its own bank", async () => {
  const { deleteBot } = await import(`${root}/lib/server/remove.ts`);
  assert.ok(honcho.banks.has("bops-bot-rex"));
  await deleteBot("rex");
  assert.equal(S.getState().bots.some((b) => b.id === "rex"), false);
  assert.equal(honcho.banks.has("bops-bot-rex"), false);
  assert.equal(S.getState().workspaces[0].chain.bots.rex, undefined, "and its place on the chart");
  // One that never kept its own: memory isn't asked to delete anything, as before.
  const h = honcho.calls.length;
  await deleteBot("max");
  assert.deepEqual(honcho.calls.slice(h).filter((c) => c.method === "DELETE"), []);
  assert.ok(!warned.some((w) => /own memory/.test(w)), warned.join("\n"));
});

await check("a bot deleted while memory is off: its bank waits in the outbox, a new bot never gets its id meanwhile, and it goes once memory is back; in another workspace, that workspace's bank", async () => {
  const { deleteBot } = await import(`${root}/lib/server/remove.ts`);
  const { freeBotId } = await import(`${root}/lib/server/bots.ts`);
  // Pip, in Acme's workspace, keeps its memory to itself: its bank is Acme's, "bops-ws_acme-bot-pip".
  S.update((s) => {
    s.workspaces.push({ id: "ws_acme", name: "Acme", createdAt: 1, chain: { bots: { pip: { memory: "own" } } } });
    s.bots.push({ id: "pip", name: "Pip", role: "Outreach", color: "#4F7BF7", isMain: false, computerStatus: "none", workspaceId: "ws_acme" });
    s.chats.push({ id: botChatId("pip"), kind: "bot", botIds: ["pip"], typing: [] });
  });
  await Mem.learn(Mem.scopeOf("pip"), "Alex's Acme login is in the vault.");
  assert.deepEqual(factsIn("bops-ws_acme-bot-pip"), ["Alex's Acme login is in the vault."]);
  delete process.env.HONCHO_API_KEY;
  try {
    await deleteBot("pip");
    assert.equal(honcho.banks.has("bops-ws_acme-bot-pip"), true, "memory is off: nothing deleted yet");
    assert.deepEqual(MD.memoryDeletesForTests.waiting().map((e) => [e.wsId, e.item.bank, e.item.bot]), [["ws_acme", "bops-ws_acme-bot-pip", "pip"]]);
    assert.equal(freeBotId("Pip"), "pip-2", "a new Pip doesn't get the old one's bank");
  } finally {
    process.env.HONCHO_API_KEY = "hc-test-memory-own";
  }
  MD.memoryDeletesForTests.reset();
  assert.equal(await MD.flushMemoryDeletes(), true);
  assert.equal(honcho.banks.has("bops-ws_acme-bot-pip"), false, "gone once memory is back");
  assert.deepEqual(MD.memoryDeletesForTests.waiting(), []);
  assert.equal(freeBotId("Pip"), "pip", "free again");
  assert.ok(!honcho.banks.has("bops-bot-pip"), "never the main workspace's");
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\nmemory own: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
