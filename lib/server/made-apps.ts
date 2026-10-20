import "server-only";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appPage, compile, MODULES } from "@/lib/made-app-page";
import { workspaceOf, type MadeApp } from "@/lib/types";
import { creditsOut, noteOutOfCredit } from "./cloud";
import { setting } from "./models";
import { openaiClient } from "./openai-client";
import { LIGHT } from "./routing";
import { appList } from "./composio";
import { addMessage, bot, getState, id, ownerName, sameState, update, userDir } from "./store";
import { recordTokens, usageTags } from "./usage";

/**
 * Apps the bots make for the user: a small React app in one TSX file, asked for in a chat (make_app,
 * change_app in chat.ts) and built here in the background while it shows in a tab of the right panel.
 *
 * - Each version's code is a file on this Mac (.data/users/<id>/made-apps/<app>/v<n>.tsx), and so is
 *   what the app keeps (data.json). The list and each app's state (building, its versions) are in the
 *   app state, so the app shows them as they change.
 * - A model wrote the code, so it runs locked down (app/api/made-apps/[appId]/view): a sandboxed frame
 *   with no network and no storage of its own. All it can reach is `window.bops`, which the window
 *   passes on to the bridge route: its own data, and quick answers from a small model.
 * - Going back to a version is a change like any other (a new version with that code), so nothing is
 *   ever lost and Undo is the same thing.
 */

const client = openaiClient();
const BUILD_MODEL = () => setting("gpt-6.1-sol", "BOPS_APP_MODEL", "BOPS_CHAT_MODEL");
/** The code a build may write, and what an app may keep (both far more than a small app needs). */
const MAX_CODE = 200_000;
const MAX_DATA = 5_000_000;
const dirOf = (appId: string) => {
  const dir = userDir();
  if (!dir) throw new Error("Sign in to Bops first.");
  if (!/^app_[a-z0-9]+$/i.test(appId)) throw new Error("No such app.");
  return join(dir, "made-apps", appId);
};

export const madeApp = (appId: string) => getState().madeApps?.find((a) => a.id === appId);

/** An app's code at a version (its current one by default), or null. */
export function appCode(appId: string, version?: number) {
  const app = madeApp(appId);
  const n = version ?? app?.version;
  if (!app || !n) return null;
  const file = join(dirOf(appId), `v${n}.tsx`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** What a build is writing right now, by app, for the tab's Code view. */
const drafts = new Map<string, string>();
export const draftOf = (appId: string) => drafts.get(appId) ?? null;
/** Builds in order, one at a time per app: a change asked for mid-build waits for the build before it. */
const queue = new Map<string, Promise<void>>();

const RULES = (owner: string, maker: string, reach: string) =>
  [
    `You write small apps for ${owner} that run inside Bops, the app where their AI team works. Each app is one TypeScript React file (TSX).`,
    "",
    "The file:",
    '- `export default function App()`. React 19: import hooks from "react" (`import { useState, useEffect } from "react"`). No other imports: npm packages, the network, fonts and images from the web are all blocked. Draw icons and charts in inline SVG.',
    "- Style it with Tailwind CSS classes (Tailwind 4 is loaded). Calm and light: a white page, neutral grays, black text, rounded-xl, generous spacing, system-ui type. One accent, used sparingly: highlighter yellow #E8FF3A with black text (bg-[#E8FF3A]), for what matters most. It fills a panel about 600px wide and the full height; it must work from 360px wide.",
    "- Plain, short words in the UI. An empty state says what to do first.",
    "",
    "`window.bops` is all it can reach (every call is async):",
    "- bops.data.get(key) → the value or null; bops.data.set(key, value) keeps any JSON value; bops.data.delete(key); bops.data.list(prefix?) → keys. Keep everything the user enters or the app works out here (localStorage and cookies are blocked); load it on start. It's the app's own, kept on their Mac, and it stays when the app changes.",
    "- bops.ask(prompt, { json?: boolean }) → a quick answer from an AI model (a string, or parsed JSON with json: true): for summarizing, sorting, drafting, extracting. It has no tools and can't browse.",
    `- bops.bot(question, { json?: boolean }) → ${maker}, the bot that made the app, finds it out and answers: it can read ${reach}, ${owner}'s memory and the web. For anything from ${owner}'s own accounts or the live web ("the people who replied to my emails this week, as {\"people\":[{\"name\",\"email\",\"said\"}]}"). Ask for the result, not how to get it: it searches and reads on its own, and can't call APIs or fetch URLs you name. Say exactly what to return; with json: true ask for one JSON object. It's slow (10 to 60 seconds) and costs: call it when the user presses a button (Refresh) or when the kept result is a day old, never on every render; show that it's working, keep the result with bops.data and show the kept one at once. The first time, ${owner} is asked to allow it; if they don't, it throws: show that plainly with a way to try again.`,
    "",
    "Answer with the whole file and nothing else: no Markdown fences, no explanation. Its first line is a comment saying in a few words what this version does or changes (`// Tracks replies by stage`).",
  ].join("\n");

/**
 * Make an app, or change one, in the background. Returns the app at once (building); the build
 * writes its new version, or says in the chat why it couldn't.
 */
export function buildApp(botId: string, chatId: string, ask: { appId?: string; title?: string; change: string }) {
  const b = bot(botId);
  if (!b) throw new Error("No such bot.");
  const change = ask.change.trim();
  if (!change) throw new Error("Say what the app should do.");
  let app = ask.appId ? madeApp(ask.appId) : undefined;
  if (ask.appId && !app) throw new Error("No such app.");
  if (!app) {
    const now = Date.now();
    app = { id: id("app"), title: ask.title?.trim().slice(0, 60) || "New app", botId, chatId, ws: workspaceOf(b), version: 0, versions: [], createdAt: now, updatedAt: now };
    const made = app;
    update((s) => void (s.madeApps ??= []).push(made));
  }
  const appId = app.id;
  const first = !app.version;
  update((s) => {
    const a = s.madeApps?.find((x) => x.id === appId);
    if (a) a.building = { change, since: Date.now(), chars: 0 };
  });
  const line = addMessage({ chatId, role: "system", text: `${first ? "Building" : "Changing"} ${app.title}`, madeApp: { appId, version: (app.versions.at(-1)?.n ?? 0) + 1 } });
  const ours = sameState();
  const run = (queue.get(appId) ?? Promise.resolve()).then(() => build(appId, botId, change, line.id, ours));
  queue.set(appId, run);
  void run.finally(() => queue.get(appId) === run && queue.delete(appId));
  return app;
}

async function build(appId: string, botId: string, change: string, lineId: string, ours: () => boolean) {
  const app = madeApp(appId);
  if (!app) return;
  const set = (fn: (a: MadeApp) => void) =>
    ours() &&
    update((s) => {
      const a = s.madeApps?.find((x) => x.id === appId);
      if (a) fn(a);
    });
  // The chat's line for this build says how it went (the app shows it live; texts and other surfaces read this).
  const say = (text: string) =>
    ours() &&
    update((s) => {
      const m = s.messages.find((x) => x.id === lineId);
      if (m) m.text = text;
    });
  try {
    if (await creditsOut()) throw new Error("Your AI credit is used up.");
    const now = appCode(appId);
    const input = now
      ? `The app "${app.title}" now:\n\n${now}\n\nChange it: ${change}\n\nAnswer with the whole new file.`
      : `Make the app "${app.title}": ${change}`;
    // bops.bot asks the bot that made the app, whoever changes it.
    const maker = bot(app.botId);
    const reach = (maker && appList(maker)) || "nothing of theirs yet (they can connect apps in Logins)";
    const rules = RULES(ownerName(), maker?.name ?? "The bot", reach);
    let code = await write(appId, botId, input, ours, rules);
    let compiled: string | null = null;
    // One more go when what it wrote doesn't compile, with the error.
    for (let tries = 0; tries < 2 && compiled === null; tries++) {
      try {
        compiled = compile(code);
      } catch (e) {
        if (tries) throw new Error(`The code didn't compile: ${(e as Error).message}`);
        code = await write(appId, botId, `${input}\n\nYour last answer didn't compile (${(e as Error).message}). The file you wrote:\n\n${code}\n\nAnswer with the whole file, fixed.`, ours, rules);
      }
    }
    const bad = [...code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]).filter((m) => !MODULES.includes(m));
    if (bad.length) throw new Error(`It imports ${bad.join(", ")}, which apps can't use.`);
    if (!ours()) return;
    const n = (madeApp(appId)?.versions.at(-1)?.n ?? 0) + 1;
    const note = /^\s*\/\/\s*(.+)/.exec(code)?.[1]?.trim().slice(0, 120) || change.slice(0, 120);
    mkdirSync(dirOf(appId), { recursive: true });
    writeFileSync(join(dirOf(appId), `v${n}.tsx`), code);
    set((a) => {
      a.version = n;
      a.versions.push({ n, note, at: Date.now() });
      a.updatedAt = Date.now();
      delete a.building;
      delete a.error;
    });
    say(n === 1 ? `Made ${app.title}` : `${app.title} updated to v${n}`);
  } catch (e) {
    const why = noteOutOfCredit(e) ? "Your AI credit is used up." : (e as Error).message;
    set((a) => {
      delete a.building;
      a.error = why.slice(0, 300);
    });
    say(`Couldn't ${app.version ? "change" : "make"} ${app.title}: ${why.slice(0, 200)}`);
  } finally {
    drafts.delete(appId);
  }
}

/** One build's code, streamed: the tab's Code view and progress follow it as it's written. */
async function write(appId: string, botId: string, input: string, ours: () => boolean, rules: string) {
  drafts.set(appId, "");
  const stream = await client.responses.create(
    { model: BUILD_MODEL(), reasoning: { effort: "medium" }, instructions: rules, input, stream: true },
    usageTags("chat", botId),
  );
  let text = "";
  let shown = 0;
  for await (const event of stream) {
    if (!ours()) throw new Error("Signed out.");
    if (event.type === "response.output_text.delta") {
      text += event.delta;
      drafts.set(appId, text);
      if (text.length > MAX_CODE) throw new Error("The app came out too big.");
      // The progress in the state, now and then: every change there is sent to the window.
      if (text.length - shown > 600) {
        shown = text.length;
        update((s) => {
          const a = s.madeApps?.find((x) => x.id === appId);
          if (a?.building) a.building.chars = text.length;
        });
      }
    }
    if (event.type === "response.completed") recordTokens("chat", event.response.model, event.response.usage ?? undefined, botId);
    if (event.type === "response.failed" || event.type === "error") throw new Error("The model stopped partway.");
  }
  return text.replace(/^\s*```[a-z]*\n/i, "").replace(/\n```\s*$/, "").trim() + "\n";
}

/* ---------------- The page an app runs in ---------------- */

/** Where the server's own files are: next to server.js in the Mac app (whose working folder is the user's), else here. */
const root = () => (process.env.BOPS_SERVER_JS ? dirname(process.env.BOPS_SERVER_JS) : process.cwd());
const runtimes = new Map<string, string>();
const runtime = (file: string) => {
  if (!runtimes.has(file)) runtimes.set(file, readFileSync(join(root(), "public", "made-apps", file), "utf8"));
  return runtimes.get(file)!;
};

/** The whole page for an app at a version (its current one by default), or null. */
export function viewPage(appId: string, version?: number) {
  const app = madeApp(appId);
  const code = appCode(appId, version);
  if (!app || !code) return null;
  return appPage(app.title, code, { react: runtime("react-19.2.8.js"), tailwind: runtime("tailwind-browser-4.3.3.js") });
}

/** Go back to a version: a new version with its code, so the one being left stays in the history. */
export function goBack(appId: string, to: number) {
  const app = madeApp(appId);
  const code = appCode(appId, to);
  if (!app || !code) throw new Error("No such version.");
  if (app.building) throw new Error("It's being changed right now. Try again when that's done.");
  if (to === app.version) return app;
  const n = (app.versions.at(-1)?.n ?? 0) + 1;
  writeFileSync(join(dirOf(appId), `v${n}.tsx`), code);
  update((s) => {
    const a = s.madeApps?.find((x) => x.id === appId);
    if (!a) return;
    a.version = n;
    a.versions.push({ n, note: `Back to v${to}`, at: Date.now() });
    a.updatedAt = Date.now();
    delete a.error;
  });
  return madeApp(appId);
}

export function deleteApp(appId: string) {
  if (!madeApp(appId)) return;
  rmSync(dirOf(appId), { recursive: true, force: true });
  update((s) => void (s.madeApps = s.madeApps?.filter((a) => a.id !== appId)));
}

/* ---------------- What an app keeps ---------------- */

function readData(appId: string): Record<string, unknown> {
  const file = join(dirOf(appId), "data.json");
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeData(appId: string, data: Record<string, unknown>) {
  const text = JSON.stringify(data);
  if (text.length > MAX_DATA) throw new Error("This app's data is full (5 MB).");
  mkdirSync(dirOf(appId), { recursive: true });
  writeFileSync(join(dirOf(appId), "data.json"), text);
}

/** A call the user hasn't allowed this app yet: the window asks them, and calls again if they do. */
export class NeedsAllow extends Error {
  constructor(readonly what: "bot") {
    super("Not allowed yet.");
  }
}

/** Let an app ask its bot (`bops.bot`), or stop it. */
export function allow(appId: string, what: "bot", on: boolean) {
  update((s) => {
    const a = s.madeApps?.find((x) => x.id === appId);
    if (!a) return;
    a.allowed ??= {};
    if (on) a.allowed[what] = Date.now();
    else delete a.allowed[what];
  });
}

/** Questions an app asked its bot lately, by app: a loop in an app's code can't run up the user's credit. */
const asked = new Map<string, number[]>();
const ASKS_PER_HOUR = 30;

/** JSON from a model's answer: as is, else the first object or array in it (it may have added words or fences). */
function jsonFrom(text: string) {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start)
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  throw new Error("The answer wasn't JSON.");
}

/** A call from an app's `window.bops` (the window passes it on: components/app/made-apps.tsx). */
export async function bridge(appId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const app = madeApp(appId);
  if (!app) throw new Error("No such app.");
  const key = typeof args.key === "string" ? args.key.slice(0, 200) : "";
  switch (method) {
    case "data.get":
      return readData(appId)[key] ?? null;
    case "data.set": {
      if (!key) throw new Error("data.set needs a key.");
      const data = readData(appId);
      data[key] = args.value ?? null;
      writeData(appId, data);
      return true;
    }
    case "data.delete": {
      const data = readData(appId);
      delete data[key];
      writeData(appId, data);
      return true;
    }
    case "data.list": {
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      return Object.keys(readData(appId)).filter((k) => k.startsWith(prefix));
    }
    case "ask":
      return ask(app, String(args.prompt ?? ""), args.json === true);
    case "bot": {
      const question = String(args.prompt ?? "").trim();
      if (!question) throw new Error("bops.bot needs a question.");
      if (!app.allowed?.bot) throw new NeedsAllow("bot");
      const now = Date.now();
      const recent = (asked.get(appId) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= ASKS_PER_HOUR) throw new Error("This app has asked its bot a lot in the last hour. Try again later.");
      asked.set(appId, [...recent, now]);
      const { answerForApp } = await import("./chat");
      const answer = await answerForApp(app.botId, app, question, args.json === true);
      return args.json === true ? jsonFrom(answer) : answer;
    }
    default:
      throw new Error(`bops.${method} isn't something apps can do.`);
  }
}

async function ask(app: MadeApp, prompt: string, json: boolean) {
  if (!prompt.trim()) throw new Error("bops.ask needs a prompt.");
  if (await creditsOut()) throw new Error("Your AI credit is used up.");
  const r = await client.responses.create(
    {
      model: LIGHT(),
      instructions: `You answer for "${app.title}", an app in Bops. Be brief and exact.${json ? " Answer with JSON only." : ""}`,
      input: prompt.slice(0, 20_000),
      ...(json ? { text: { format: { type: "json_object" as const } } } : {}),
    },
    usageTags("chat", app.botId),
  );
  recordTokens("chat", r.model, r.usage, app.botId);
  const out = r.output_text ?? "";
  return json ? jsonFrom(out) : out;
}
