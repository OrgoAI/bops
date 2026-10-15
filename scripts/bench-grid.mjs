// The comparison runs for model routing (.context/model-routing-research.md): each task case, run once on
// each configuration (a model, an effort, a speed), on the Bops running on this Mac, one at a time, for
// the main bot. Each answer is graded against its case's rubric (POST /api/judge). For each case it finds
// the cheapest configuration that passed (the "oracle"), and how each policy would have done: the old rule
// (a hard task on Astra), the router (POST /api/route, what Jev picks), and always-Sol. That's what sets
// the router's thresholds before BOPS_ROUTER=on.
//
// It uses real AI credit and the user's real bot and computer for hours (cases x configurations, a few
// minutes each), so run it only when they've said so. The tasks only read, or write to test sites and the
// bot's own computer: nothing is booked, sent or bought. Results go to .data/bench/grid-<time>.json.
// Usage: node scripts/bench-grid.mjs [--only id,id] [--configs sol-low,astra-high] [--bot <id>] [--minutes 15] [--out file]
//        node scripts/bench-grid.mjs --list   (the cases and configurations, without running anything)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BOPS_URL ?? "http://127.0.0.1:3210";
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const LIMIT_MS = Number(value("minutes") ?? 15) * 60_000;

/** The configurations, cheapest first (the oracle is the first that passes). */
const CONFIGS = [
  { id: "sol-low", model: "gpt-6.1-sol", effort: "low" },
  { id: "sol-medium", model: "gpt-6.1-sol", effort: "medium" },
  { id: "sol-high", model: "gpt-6.1-sol", effort: "high" },
  { id: "sol-xhigh", model: "gpt-6.1-sol", effort: "xhigh" },
  { id: "astra-high", model: "gpt-6-astra", effort: "high" },
  // The same as sol-medium, on Ultrafast: what speed buys (not in the oracle's order; compared with sol-medium).
  { id: "sol-medium-ultrafast", model: "gpt-6.1-sol", effort: "medium", speed: "ultrafast", speedOf: "sol-medium" },
].filter((c) => !value("configs") || value("configs").split(",").includes(c.id));
const keyOf = (c) => (c ? CONFIGS.find((x) => !x.speed && x.model === c.model && x.effort === c.effort)?.id ?? `${c.model}-${c.effort}` : undefined);

/** What it runs: a task, and what a right answer has in it (the grader reads only the answer). */
const CASES = [
  // Look-ups and reading
  { id: "hn", kind: "lookup", goal: "List the top 5 stories on Hacker News (news.ycombinator.com) right now, with their points.", rubric: "Lists five stories by title, each with a points count, in front-page order." },
  { id: "hn-guidelines", kind: "read", goal: "Read https://news.ycombinator.com/newsguidelines.html and sum up its guidelines in five short bullets.", rubric: "Five bullets that reflect HN's guidelines (for example: intellectually interesting submissions, original sources and plain titles, civil and substantive comments, no flamebait or snark, no self-promotion as the main use)." },
  { id: "sunset", kind: "lookup", goal: "What time is sunset in San Francisco today? Say where you found it.", rubric: "Gives one sunset time in the evening (between 4:30 and 8:45 pm local time) for San Francisco today, and names a source." },
  { id: "node-lts", kind: "lookup", goal: "What is the current Node.js LTS release line, and when does it reach end of life? Use nodejs.org.", rubric: "Names an even-numbered Node.js major version as the current Active LTS line, and an end-of-life date for it, citing nodejs.org." },
  { id: "httpbin-json", kind: "data", goal: "Fetch https://httpbin.org/json and tell me the slideshow's title and how many slides it has.", rubric: 'Says the title is "Sample Slide Show" and that it has 2 slides.' },
  // Research
  { id: "daytona", kind: "research", goal: "Find who the CEO of Daytona (daytona.io, the sandbox company) is, about how many people work there, and their latest funding round. Say where each fact comes from.", rubric: "Names the CEO (Ivan Burazin), gives a headcount estimate, names a funding round with an amount or date, and gives a source for each." },
  { id: "crm-compare", kind: "research", goal: "Compare three CRMs for a 5-person marketing agency (HubSpot, Pipedrive and Attio): price per seat per month on a paid plan, one strength each, and which you'd pick and why.", rubric: "Covers all three CRMs with a per-seat monthly price for a paid plan, one strength each, and a clear pick with a reason." },
  { id: "nextjs-release", kind: "research", goal: "What's the latest stable Next.js release, and what are three of its main changes? Use the Next.js blog.", rubric: "Names a Next.js version number as the latest stable release and lists three changes in it, citing the Next.js blog." },
  { id: "pricing-math", kind: "analysis", goal: "Using OpenAI's API pricing page, what would 10 million input tokens and 1 million output tokens cost on GPT-6.1 Sol and on GPT-6 Astra (no caching, standard tier)? Show the math.", rubric: "GPT-6.1 Sol: $20 input + $10 output = $30. GPT-6 Astra: $100 input + $50 output = $150. Shows the math." },
  { id: "mac-mini", kind: "research", goal: "On apple.com, what's the starting price of the Mac mini in the US, and what chip and memory does that model have?", rubric: "Gives a US starting price in dollars for the Mac mini and names the chip and memory of that base model, from apple.com." },
  // Using sites (only looking)
  { id: "hotel", kind: "search", goal: "Find three hotels in Spokane, WA under $180 a night for next Friday to Sunday, with their prices. Only look: don't book or sign in to anything.", rubric: "Names three Spokane hotels with nightly prices under $180 for the right dates." },
  { id: "flight", kind: "search", goal: "On Google Flights, find the cheapest nonstop flight from SFO to Seattle next Friday morning, with its time and price. Only look: don't book or sign in to anything.", rubric: "Names a nonstop SFO to Seattle flight on next Friday morning with an airline, departure time and price." },
  { id: "usb-hub", kind: "search", goal: "Find a USB-C hub under $40 with at least 4.3 stars on Amazon. Give its name, price and rating. Only look: don't buy or sign in.", rubric: "Names one USB-C hub with a price under $40 and a rating of at least 4.3 stars, from Amazon." },
  { id: "github-repo", kind: "read", goal: "On GitHub, how many stars does the openai/openai-node repository have, and what's its latest release tag?", rubric: "Gives a star count and a release tag (like v7.x.y) for openai/openai-node." },
  // Forms
  { id: "form", kind: "form", goal: "Go to https://httpbin.org/forms/post (a test form that goes nowhere). Fill in the pizza order: customer name Bops Bench, telephone 555-0100, email bench@example.com, size small, topping bacon, delivery time 19:00, comments 'benchmark'. Submit it, then tell me what the page that comes back shows for custname and size.", rubric: 'Says it submitted, and that the returned page shows custname "Bops Bench" and size "small".' },
  { id: "form-large", kind: "form", goal: "Go to https://httpbin.org/forms/post (a test form that goes nowhere). Order a large pizza with cheese and onion for Ada Lovelace, telephone 555-0199, email ada@example.com, delivery 20:30. Submit it and tell me which toppings the returned page lists.", rubric: "Says it submitted, and that the returned page lists the toppings cheese and onion (and size large)." },
  // Apps on the computer (the screen)
  { id: "calc", kind: "app", goal: "On your own computer, open LibreOffice Calc, put the numbers 1 to 5 in cells A1 to A5 and a sum of them in A6, and save it as /workspace/bench.ods. Tell me what A6 shows.", rubric: "Says A6 shows 15 and that the file was saved as /workspace/bench.ods." },
  { id: "writer", kind: "app", goal: "On your own computer, open LibreOffice Writer, write a heading 'Bench' and one sentence under it, and save it as /workspace/bench.odt. Tell me the sentence.", rubric: "Says it saved /workspace/bench.odt with the heading Bench and quotes the sentence it wrote." },
  // Shell and files
  { id: "fibonacci", kind: "code", goal: "In /workspace, write a Python script that prints the first 20 Fibonacci numbers starting 0, 1. Run it and tell me the 20th number.", rubric: "Says the 20th number is 4181 (counting 0 as the first)." },
  { id: "csv", kind: "data", goal: "Download https://people.sc.fsu.edu/~jburkardt/data/csv/hw_200.csv and tell me how many data rows it has and the average of its height column, to two decimals.", rubric: "Says it has 200 data rows and gives the average height (about 67.95 inches)." },
  // Writing and planning (deliverables)
  { id: "cold-email", kind: "writing", goal: "Write a cold email of about 120 words to the owner of a small dental clinic, pitching an AI receptionist that answers calls and books appointments. Save it to /workspace/email.md and give me the text.", rubric: "An email of roughly 100 to 150 words to a dental clinic owner, pitching an AI receptionist that answers calls and books appointments, with a clear call to action; saved to /workspace/email.md." },
  { id: "lisbon", kind: "planning", goal: "Plan a 3-day trip to Lisbon for a first-timer, with one day trip out of the city. A short plan per day.", rubric: "Three days in Lisbon, each with a short plan, one of which is a day trip outside the city (such as Sintra or Cascais)." },
  { id: "podcast-plan", kind: "planning", goal: "Draft a one-page launch plan for a weekly podcast about AI agents for agency owners: format, first 5 episode topics, where to publish, and how to get the first 500 listeners.", rubric: "Covers format, five episode topics about AI agents for agency owners, where to publish, and a concrete plan for the first 500 listeners." },
  { id: "pros-cons", kind: "analysis", goal: "Our team of 3 wants to move from Slack to Discord to save money. Give the three strongest reasons for and against, and a recommendation.", rubric: "Three reasons for and three against moving a 3-person team from Slack to Discord, and a clear recommendation." },
].filter((c) => !value("only") || value("only").split(",").includes(c.id));

if (flag("list")) {
  console.table(CASES.map((c) => ({ id: c.id, kind: c.kind })));
  console.table(CONFIGS.map((c) => ({ id: c.id, model: c.model, effort: c.effort, speed: c.speed ?? "default" })));
  console.log(`${CASES.length} cases x ${CONFIGS.length} configurations = ${CASES.length * CONFIGS.length} runs.`);
  process.exit(0);
}

const token = readFileSync(join(homedir(), "Library/Application Support/Bops/window-token"), "utf8").trim();
const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", "x-bops-window": token, ...(init.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};
const state = async () => (await api("/api/state")).state;
const tokens = async () => (await api("/api/account")).usage?.thisMonth?.tokensBySource ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (s) => ["queued", "starting", "running"].includes(s.status);
const total = (o) => Object.values(o).reduce((a, b) => a + (Number(b) || 0), 0);

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

/** One case on one configuration: its time, tokens, answer and grade. */
async function runOne(c, config, botId) {
  const before = await tokens();
  const started = Date.now();
  const made = await api("/api/sessions", { method: "POST", body: JSON.stringify({ botId, goal: c.goal, title: `Grid: ${c.id} · ${config.id}`, model: config.model, effort: config.effort, ...(config.speed ? { speed: config.speed } : {}) }) });
  const s = await finish(made.id, started);
  const minutes = (Date.now() - started) / 60_000;
  await sleep(4000);
  const used = total(Object.fromEntries(Object.entries(await tokens()).map(([k, v]) => [k, v - (before[k] ?? 0)])));
  const answer = s?.answer ?? "";
  const grade = s?.status === "done" ? await api("/api/judge", { method: "POST", body: JSON.stringify({ task: c.goal, rubric: c.rubric, answer }) }).catch((e) => ({ pass: false, why: `not graded: ${e.message}` })) : { pass: false, why: s?.timedOut ? "timed out" : `ended ${s?.status}: ${s?.error ?? ""}` };
  return { case: c.id, kind: c.kind, config: config.id, status: s?.timedOut ? "timed out" : s?.status, minutes: Math.round(minutes * 10) / 10, tokens: used, pass: grade.pass, why: grade.why, answer: answer.slice(0, 600) };
}

const st = await state();
const botId = value("bot") ?? st.bots.find((b) => b.isMain && (b.workspaceId ?? "ws_main") === (st.workspace ?? "ws_main"))?.id;
if (!botId) throw new Error("No main bot found.");
const busy = st.sessions.filter(live);
if (busy.length && !flag("force")) {
  console.error(`Not now: ${busy.length} task(s) running (${busy.map((s) => s.title).join(", ")}). Run it when Bops is idle, or pass --force.`);
  process.exit(1);
}
console.log(`Grid on ${BASE}, bot ${botId}: ${CASES.length} cases x ${CONFIGS.length} configurations, one at a time, up to ${LIMIT_MS / 60_000} min each.`);

const dir = join(process.cwd(), ".data", "bench");
mkdirSync(dir, { recursive: true });
const file = value("out") ?? join(dir, `grid-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const out = { at: new Date().toISOString(), base: BASE, botId, configs: CONFIGS, runs: [], routes: {} };
const save = () => writeFileSync(file, JSON.stringify(out, null, 2));

for (const c of CASES) {
  // What each policy would run it on (the old rule and the router), asked once per case.
  out.routes[c.id] = await api("/api/route", { method: "POST", body: JSON.stringify({ goal: c.goal, botId }) }).catch((e) => ({ error: e.message }));
  for (const config of CONFIGS) {
    process.stdout.write(`${c.id} on ${config.id}… `);
    const r = await runOne(c, config, botId).catch((e) => ({ case: c.id, config: config.id, status: "error", pass: false, why: e.message }));
    out.runs.push(r);
    save();
    console.log(`${r.pass ? "pass" : "fail"}, ${r.minutes ?? "?"} min, ${r.tokens ?? "?"} tokens${r.pass ? "" : ` (${r.why})`}`);
  }
}

/* ---------------- What it says ---------------- */

const runOf = (caseId, configId) => out.runs.find((r) => r.case === caseId && r.config === configId);
const order = CONFIGS.filter((c) => !c.speed).map((c) => c.id);
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);

// Each configuration: how often it passed, how long it took, what it used.
const byConfig = CONFIGS.map((c) => {
  const rs = out.runs.filter((r) => r.config === c.id);
  return { config: c.id, passed: `${rs.filter((r) => r.pass).length}/${rs.length}`, medianMin: median(rs.map((r) => r.minutes ?? 0)), tokens: rs.reduce((a, r) => a + (r.tokens ?? 0), 0) };
});
// Each case: the cheapest configuration that passed, and what each policy picked and whether that passed.
const policies = { rule: (id) => keyOf(out.routes[id]?.rule), router: (id) => keyOf(out.routes[id]?.router), "always sol-medium": () => "sol-medium" };
const byCase = CASES.map((c) => {
  const oracle = order.find((id) => runOf(c.id, id)?.pass) ?? "none passed";
  const row = { case: c.id, kind: c.kind, oracle };
  for (const [name, pick] of Object.entries(policies)) {
    const id = pick(c.id);
    const r = id ? runOf(c.id, id) : undefined;
    row[name] = id ? `${id}${r ? (r.pass ? " ✓" : " ✗") : " (not run)"}` : "?";
  }
  return row;
});
const score = Object.fromEntries(
  Object.entries(policies).map(([name, pick]) => {
    const rs = CASES.map((c) => runOf(c.id, pick(c.id))).filter(Boolean);
    return [name, { passed: `${rs.filter((r) => r.pass).length}/${CASES.length}`, tokens: rs.reduce((a, r) => a + (r.tokens ?? 0), 0), minutes: Math.round(rs.reduce((a, r) => a + (r.minutes ?? 0), 0) * 10) / 10 }];
  }),
);
// What Ultrafast buys: each speed configuration against its standard twin.
const speed = CONFIGS.filter((c) => c.speedOf).map((c) => {
  const pairs = CASES.map((x) => [runOf(x.id, c.speedOf), runOf(x.id, c.id)]).filter(([a, b]) => a && b);
  return { config: c.id, vs: c.speedOf, medianStandardMin: median(pairs.map(([a]) => a.minutes)), medianFastMin: median(pairs.map(([, b]) => b.minutes)) };
});
out.summary = { byConfig, byCase, score, speed };
save();
console.table(byConfig);
console.table(byCase);
console.table(score);
if (speed.length) console.table(speed);
console.log(`Saved ${file}`);
