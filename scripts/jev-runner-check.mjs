// Checks the runner's questions and cutoffs (lib/server/routing.ts RUNNER_QUESTIONS, RUNNER_AT) against
// labeled task goals, on one or more Jev versions: how many workbench goals each version sends to an Agents
// API session, and how many screen goals it sends there by mistake, per cutoff. Run it before moving
// decide.ts JEV_MODEL to a new version, or after changing a question.
//
// Cases: a JSON file of [{ goal, label: "workbench" | "screen" | "either" }] ("either" is left out of the
// counts). Real goals are the user's own: keep that file out of the repo (the 2026-10-28 one was 177 of
// Nick's threads, hand-labeled, plus the made-up ones below). With no file, only the made-up ones run.
//
// Usage: TYPESAFE_API_KEY=… node --conditions=react-server scripts/jev-runner-check.mjs [cases.json] [--models jev-1.13.0,jev-1.14.0]
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
});
const { RUNNER_QUESTIONS, RUNNER_AT, runnerFrom } = await import(`${root}/lib/server/routing.ts`);

/** Building and code jobs a bot gets, made up (the user's threads had few): all workbench. */
const MADE_UP = [
  "Add a dark mode toggle to the Orgo CRM app and push the change.",
  "Fix the build error in the Carrier Portal Calculator app: npm run build fails on a missing import.",
  "Write a Python script that removes duplicate rows from /workspace/leads.csv by email and saves leads-clean.csv.",
  "Build a small dashboard web page that charts our weekly signups from the CSV in /workspace and open it in the browser.",
  "Clone github.com/orgoai/bops-site, change the homepage headline to 'AI coworkers with their own computers', run it locally and show me.",
  "Deploy the Water app to production and tell me the live URL.",
  "Create a Node.js API with an endpoint that returns the current Bitcoin price, run it on port 8080 and test it with curl.",
  "Review the last three commits in the UPangea repo and tell me if anything looks risky.",
  "Make a landing page for the Agent Operators podcast with an email signup form, and put it live.",
  "Write a bash script that backs up /workspace/projects every night and set it up with cron.",
  "Turn the Spokane hotel research into a spreadsheet file with prices and links, saved as /workspace/hotels.xlsx.",
  "Update the README in the momentum-claw-platform repo to explain how to run it locally, then open a pull request.",
  "Do three things at once: research Daytona's pricing, research E2B's pricing, and research Browserbase's pricing, each on its own screen.",
  "On four screens at the same time, check the status pages of OpenAI, Anthropic, Vercel and Supabase and report back.",
  "Install Playwright on your computer and write a test that checks orgo.ai loads and shows a Sign in button.",
  "Refactor the HN Top app so stories load faster, keeping the same look.",
  "Set up a new Next.js project in /workspace/apps/notes with a page that lists notes saved in a JSON file.",
  "Debug why the cron job on your computer stopped running and fix it.",
  "Write a script that renames every photo in /workspace/photos by the date it was taken.",
  "Build a simple Chrome extension that highlights the word Orgo on any page, and load it in your browser.",
].map((goal) => ({ goal, label: "workbench" }));

const args = process.argv.slice(2);
const at = args.indexOf("--models");
const models = at >= 0 ? args[at + 1].split(",") : ["jev-1.14.0"];
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--models");
const cases = [...(file ? JSON.parse(readFileSync(file, "utf8")) : []), ...MADE_UP].filter((c) => c.label !== "either");
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("TYPESAFE_API_KEY is needed");

async function ask(model, goal) {
  for (let t = 0; t < 4; t++) {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: { task: goal.slice(0, 3000) }, questions: RUNNER_QUESTIONS }),
    });
    // Busy (429, 529): back off and try again, as Typesafe asks.
    if (r.status === 429 || r.status === 529) {
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** t));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error("Jev stayed busy");
}

const pct = (a, b) => `${a}/${b}`;
for (const model of models) {
  const rows = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let c; (c = queue.shift()); ) rows.push({ ...c, answers: (await ask(model, c.goal)).answers });
    }),
  );
  const work = rows.filter((r) => r.label === "workbench");
  const screen = rows.filter((r) => r.label === "screen");
  const agents = (r, cut) => runnerFrom(r.answers, cut)?.pick === "agents";
  console.log(`\n${model}: ${work.length} workbench, ${screen.length} screen`);
  for (const scale of [0.75, 0.875, 1, 1.0625]) {
    const cut = Object.fromEntries(Object.entries(RUNNER_AT).map(([k, v]) => [k, Math.min(0.99, +(v * scale).toFixed(2))]));
    const caught = work.filter((r) => agents(r, cut)).length;
    const wrong = screen.filter((r) => agents(r, cut)).length;
    console.log(`  ${JSON.stringify(cut)}${scale === 1 ? " (now)" : ""}: Agents API for ${pct(caught, work.length)} workbench, ${pct(wrong, screen.length)} screen by mistake`);
  }
  for (const r of rows) {
    const got = runnerFrom(r.answers)?.pick;
    if ((r.label === "workbench") !== (got === "agents")) console.log(`  ${r.label === "workbench" ? "missed" : "wrongly sent"}: ${runnerFrom(r.answers)?.why} | ${r.goal.slice(0, 110)}`);
  }
}
