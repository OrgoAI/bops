// A benchmark of how bots work, on the Bops running on this Mac: real tasks and chat questions, one at a
// time, for the main bot. For each: how long it took, its steps by kind (the screen, a page script or the
// browser tools, web search, the shell, apps and data), what it answered, and the model tokens it used
// (Bops' own count, before and after; nothing else should run meanwhile). The tasks only read, or write
// to test sites and the bot's own computer: nothing is booked, sent or bought.
//
// It uses real AI credit and the user's real bot and computer, so run it only when they've said so.
// Results go to .data/bench/<time>.json (and a table here), to compare one build of Bops with another.
// Usage: node scripts/bench-tasks.mjs [--only hn,form] [--tasks-only | --chat-only] [--bot <id>] [--minutes 20]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BOPS_URL ?? "http://127.0.0.1:3210";
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const token = readFileSync(join(homedir(), "Library/Application Support/Bops/window-token"), "utf8").trim();
const LIMIT_MS = Number(value("minutes") ?? 20) * 60_000;

/**
 * What it runs. kind: what the work is (a look-up, research, a form, an app that needs the screen).
 * chat: asked in the bot's chat, as the user would; else started as a task (POST /api/sessions).
 */
const CASES = [
  { id: "chat-sunset", kind: "lookup", chat: true, text: "What time is sunset in San Francisco today?" },
  { id: "chat-hn", kind: "lookup", chat: true, text: "What are the top 3 stories on Hacker News right now?" },
  { id: "hn", kind: "lookup", title: "Bench: Hacker News top 5", goal: "List the top 5 stories on Hacker News (news.ycombinator.com) right now, with their points." },
  { id: "page", kind: "read", title: "Bench: HN guidelines", goal: "Read https://news.ycombinator.com/newsguidelines.html and sum up its guidelines in five short bullets." },
  { id: "research", kind: "research", title: "Bench: Daytona facts", goal: "Find who the CEO of Daytona (daytona.io, the sandbox company) is, about how many people work there, and their latest funding round. Say where each fact comes from." },
  { id: "hotel", kind: "search", title: "Bench: Spokane hotels", goal: "Find three hotels in Spokane, WA under $180 a night for next Friday to Sunday, with their prices. Only look: don't book or sign in to anything." },
  { id: "flight", kind: "search", title: "Bench: SFO to Seattle", goal: "On Google Flights, find the cheapest nonstop flight from SFO to Seattle next Friday morning, with its time and price. Only look: don't book or sign in to anything." },
  { id: "form", kind: "form", title: "Bench: test form", goal: "Go to https://httpbin.org/forms/post (a test form that goes nowhere). Fill in the pizza order: customer name Bops Bench, telephone 555-0100, email bench@example.com, size small, topping bacon, delivery time 19:00, comments 'benchmark'. Submit it, then tell me what the page that comes back shows for custname and size." },
  { id: "gui", kind: "app", title: "Bench: Calc sheet", goal: "On your own computer, open LibreOffice Calc, put the numbers 1 to 5 in cells A1 to A5 and a sum of them in A6, and save it as /workspace/bench.ods. Tell me what A6 shows." },
].filter((c) => {
  const only = value("only")?.split(",");
  if (only && !only.includes(c.id)) return false;
  if (flag("tasks-only") && c.chat) return false;
  if (flag("chat-only") && !c.chat) return false;
  return true;
});

const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", "x-bops-window": token, ...(init.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};
const state = async () => (await api("/api/state")).state;
/** Bops' own count of model tokens this month, by what they were for (lib/server/usage.ts, the account page). */
const tokens = async () => (await api("/api/account")).usage?.thisMonth?.tokensBySource ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (s) => ["queued", "starting", "running"].includes(s.status);

/** A step, by kind of work: what the bench compares. */
const SCREEN = new Set(["click", "key", "type_text", "scroll", "drag", "move", "wait", "screenshot", "computer", "press_key", "double_click"]);
const APPS = new Set(["use_app", "find_app_actions", "business_search", "find_data", "get_data"]);
function kindOf(tool = "") {
  if (SCREEN.has(tool)) return "screen";
  if (tool === "page" || tool.startsWith("browser_")) return "page";
  if (tool === "search") return "search";
  if (tool === "command") return "shell";
  if (APPS.has(tool) || tool.includes(".")) return "apps";
  if (tool === "note" || tool === "setup") return null;
  return "other";
}
function stepsOf(s) {
  const out = { screen: 0, page: 0, search: 0, shell: 0, apps: 0, other: 0 };
  for (const st of s?.steps ?? []) {
    const k = kindOf(st.tool);
    if (k) out[k]++;
  }
  return out;
}
const sum = (o) => Object.values(o).reduce((a, b) => a + (Number(b) || 0), 0);
const minus = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k] ?? 0) - (b[k] ?? 0)]));

/** Wait for a thread to end (or stop it at the limit), and say how it went. */
async function finish(sessionId, started) {
  for (;;) {
    const s = (await state()).sessions.find((x) => x.id === sessionId);
    if (s && !live(s)) return s;
    if (Date.now() - started > LIMIT_MS) {
      await api("/api/sessions", { method: "DELETE", body: JSON.stringify({ sessionId }) }).catch(() => {});
      await sleep(3000);
      return { ...(await state()).sessions.find((x) => x.id === sessionId), timedOut: true };
    }
    await sleep(3000);
  }
}

async function runCase(c, botId) {
  const before = await tokens();
  const started = Date.now();
  let s;
  let reply;
  let replyMs;
  if (c.chat) {
    // Asked in the bot's chat, as the user would: the reply, and the task it started, if it did.
    const chatId = `bot:${botId}`;
    await api(`/api/chats/${encodeURIComponent(chatId)}/messages`, { method: "POST", body: JSON.stringify({ text: c.text }) });
    const asked = (await state()).messages.filter((m) => m.chatId === chatId && m.role === "user").at(-1);
    for (;;) {
      const st = await state();
      reply = st.messages.find((m) => m.chatId === chatId && m.role === "bot" && m.at > asked.at && !m.resultOf);
      if (reply) break;
      if (Date.now() - started > LIMIT_MS) break;
      await sleep(500);
    }
    replyMs = Date.now() - started;
    const sid = reply?.sessionIds?.[0];
    if (sid) s = await finish(sid, started);
  } else {
    const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ botId, goal: c.goal, title: c.title }) });
    s = await finish(made.id, started);
  }
  const ms = Date.now() - started;
  // The last model calls are counted as they come back; give the ledger a moment.
  await sleep(4000);
  const used = minus(await tokens(), before);
  return {
    id: c.id,
    kind: c.kind,
    via: c.chat ? "chat" : "task",
    minutes: Math.round((ms / 60_000) * 10) / 10,
    replySeconds: replyMs ? Math.round(replyMs / 100) / 10 : undefined,
    startedTask: c.chat ? !!s : true,
    status: s ? (s.timedOut ? "timed out" : s.status) : reply ? "answered" : "no reply",
    runner: s?.runner ?? (s ? (s.agentSessionId ? "agents" : "?") : "chat"),
    runsOn: s?.runsOn,
    steps: stepsOf(s),
    tokens: sum(used),
    tokensBySource: used,
    answer: (s?.answer ?? reply?.text ?? "").slice(0, 400),
    error: s?.error,
  };
}

const st = await state();
// The main bot of the workspace open in Bops (bots of the first workspace have none set).
const botId = value("bot") ?? st.bots.find((b) => b.isMain && (b.workspaceId ?? "ws_main") === (st.workspace ?? "ws_main"))?.id;
if (!botId) throw new Error("No main bot found.");
const busy = st.sessions.filter(live);
if (busy.length && !flag("force")) {
  console.error(`Not now: ${busy.length} task(s) running (${busy.map((s) => s.title).join(", ")}). Run it when Bops is idle, or pass --force.`);
  process.exit(1);
}
const version = await fetch(`${BASE}/api/health`).then((r) => r.json()).then((h) => h.version ?? h.build ?? null).catch(() => null);
console.log(`Bench on ${BASE} (Bops ${version ?? "?"}), bot ${botId}: ${CASES.length} case(s), one at a time, up to ${LIMIT_MS / 60_000} min each.`);

const results = [];
for (const c of CASES) {
  process.stdout.write(`${c.id}… `);
  const r = await runCase(c, botId).catch((e) => ({ id: c.id, kind: c.kind, status: "error", error: e.message }));
  results.push(r);
  console.log(`${r.status}, ${r.minutes ?? "?"} min, ${r.tokens ?? "?"} tokens, steps ${JSON.stringify(r.steps ?? {})}`);
}

const out = { at: new Date().toISOString(), base: BASE, version, botId, results };
const dir = join(process.cwd(), ".data", "bench");
mkdirSync(dir, { recursive: true });
const file = value("out") ?? join(dir, `${out.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.table(results.map((r) => ({ id: r.id, via: r.via, status: r.status, runner: r.runner, min: r.minutes, replyS: r.replySeconds, task: r.startedTask, screen: r.steps?.screen, page: r.steps?.page, search: r.steps?.search, shell: r.steps?.shell, apps: r.steps?.apps, tokens: r.tokens })));
console.log(`Saved ${file}`);
