import "server-only";
import { APIConnectionTimeoutError } from "openai";
import { openaiClient } from "./openai-client";
import { computerAsleepError, orgo, screenId } from "./orgo";
import { APP_TOOLS, findAppActions, runAppAction } from "./composio";
import { DATA_TOOL_NAMES, DATA_TOOLS, runDataTool } from "./treg";
import { bot, patchSession, session, stateEpoch } from "./store";
import { recordTokens, usageTags } from "./usage";
import type { Session } from "@/lib/types";

/**
 * A thread on a bot's Orgo computer, run on the Responses API's own `computer` tool: the model sees
 * its screen and asks for clicks and keys, and Bops does them on that screen (xdotool, the way the
 * screen MCP does) and sends the screen back. Next to it: web search, a shell on the computer, and
 * the user's apps. Every new cloud thread runs on it (BOPS_COMPUTER_TOOL=0 puts them back on an Agents API
 * session); a thread keeps the runner it started on.
 *
 * Why: on the same model, tasks and screen, it finished GUI work about 30% faster for about 45% less
 * than the Agents API with the screen MCP, at the same success rate (.context/bench, 2026-10-06): it
 * does several actions per model call, and carries no harness prompt.
 *
 * What it doesn't have (the Agents API thread does): the browser tools (pages by DOM), and helpers.
 */

export const computerToolOn = () => process.env.BOPS_COMPUTER_TOOL !== "0";

const client = openaiClient();
/** Model calls a turn may take before it stops and says where it got to. */
const MAX_CALLS = 400;
/** After acting, how long the screen settles before it's captured (as the screen MCP does). */
const SETTLE_S = 0.6;

type Usage = Parameters<typeof recordTokens>[2];
type Action = {
  type: string;
  x?: number;
  y?: number;
  button?: string;
  keys?: string[] | null;
  path?: { x: number; y: number }[];
  text?: string;
  scroll_x?: number;
  scroll_y?: number;
};
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  action?: Action;
  actions?: Action[];
  pending_safety_checks?: { id: string; code?: string | null; message?: string | null }[];
  role?: string;
  phase?: string;
  content?: { type: string; text?: string }[];
  summary?: { text: string }[];
  status?: string;
};
type Owed = NonNullable<Session["owed"]>[number];

export type ComputerTurn = {
  sessionId: string;
  computerId: string;
  display: number;
  model: string;
  effort: string;
  instructions: string;
  /** The user's apps as tools (find_app_actions, use_app). */
  apps: boolean;
  input: string;
  signal: AbortSignal;
  /** How long the turn may run at all, and how long one step (the model's answer) may take before it counts as stuck. */
  timeoutMs: number;
  idleMs: number;
  step: (tool: string, detail: string) => void;
  /** What the user has said in the thread since it last looked, and how to mark it sent once the model has it. */
  steer?: () => { text: string; sent: () => void } | undefined;
};

/** One turn: from the user's message to the bot's answer. Returns the answer. */
export async function computerTurn(t: ComputerTurn): Promise<string> {
  const s = session(t.sessionId)!;
  const b = bot(s.botId)!;
  const epoch = stateEpoch();
  const started = Date.now();
  // Business data runs in this process (treg.ts), so the task has it wherever its computer is.
  const tools = [{ type: "computer" }, { type: "web_search" }, SHELL_TOOL, VAULT_TOOL, ...(t.apps ? APP_TOOLS(b) : []), ...DATA_TOOLS(b)];
  // A turn that was stopped mid-step owes OpenAI the outputs of the calls it was answering.
  let input: unknown[] = [...(await settle(t, s.owed ?? [])), { role: "user", content: [{ type: "input_text", text: t.input }] }];
  let prev = s.responseId;

  for (let calls = 0; ; calls++) {
    if (t.signal.aborted) throw new Error("Stopped");
    if (Date.now() - started > t.timeoutMs) throw new Error(`Ran for ${Math.round(t.timeoutMs / 60_000)} minutes without finishing`);
    if (calls >= MAX_CALLS) return "I took too many steps without finishing, so I stopped here. Tell me how you'd like me to go on.";
    // The user's replies since the last step go in with this one, so they can redirect it mid-task (steering)
    // rather than wait for the turn to end. Marked sent once the model has them; a failed call leaves them for the next turn.
    const said = calls > 0 ? t.steer?.() : undefined;
    if (said) input.push({ role: "user", content: [{ type: "input_text", text: said.text }] });
    const r = (await client.responses.create(
      {
        model: t.model,
        instructions: t.instructions,
        tools,
        reasoning: { effort: t.effort, summary: "auto" },
        input,
        previous_response_id: prev,
        truncation: "auto",
      } as never,
      // A step that hangs is the turn stalling: it ends rather than waiting out the hour.
      { ...usageTags("session", b.id), signal: t.signal, timeout: t.idleMs, maxRetries: 1 },
    ).catch((e: Error) => {
      throw e instanceof APIConnectionTimeoutError ? new Error(`Stuck: nothing happened for ${Math.round(t.idleMs / 60_000)} minutes`) : e;
    })) as unknown as { id: string; model: string; usage: Usage; output: OutputItem[] };
    said?.sent();
    recordTokens("session", r.model, r.usage, b.id, epoch);
    prev = r.id;
    const asks = r.output.filter((o) => o.type === "computer_call" || o.type === "function_call");
    patchSession(t.sessionId, {
      responseId: r.id,
      owed: asks.map((o) => ({ id: o.call_id!, type: o.type === "computer_call" ? "computer" : "function", ...(o.pending_safety_checks?.length ? { checks: o.pending_safety_checks } : {}) })),
    });
    for (const o of r.output) record(t, o, asks.length > 0);
    if (!asks.length) {
      patchSession(t.sessionId, { owed: undefined });
      return answerIn(r.output) || "Done.";
    }
    // OpenAI flagged the next step (instructions on a page, an unexpected or sensitive site): the user
    // decides. Nothing is done; their reply is the next turn, which answers the call with the checks acknowledged (settle).
    const flagged = asks.flatMap((o) => o.pending_safety_checks ?? []).map((c) => c.message ?? c.code ?? "flagged");
    if (flagged.length) {
      t.step("note", `Safety check: ${flagged.join("; ")}`);
      return `Before my next step I need your OK. OpenAI flagged it: ${flagged.join("; ")}. Reply "go on" and I'll do it, or tell me what to do instead.`;
    }
    input = [];
    for (const o of asks) {
      if (t.signal.aborted) throw new Error("Stopped");
      if (o.type === "computer_call") input.push(await act(t, o));
      else {
        const answered = await runFunction(t, o);
        input.push(answered);
        // Kept with the call, so a turn stopped before sending it answers with what really happened (settle).
        patchSession(t.sessionId, (x) => {
          const owed = x.owed?.find((w) => w.id === o.call_id);
          if (owed) owed.output = answered.output;
        });
      }
    }
  }
}

/**
 * What a turn that ended mid-step still owes OpenAI: the screen as it is now for each computer call
 * (its safety checks acknowledged: the user has answered since), and for each tool call what it
 * answered, or that it didn't run.
 */
async function settle(t: ComputerTurn, owed: Owed[]) {
  const out: unknown[] = [];
  for (const o of owed)
    out.push(
      o.type === "computer"
        ? { type: "computer_call_output", call_id: o.id, acknowledged_safety_checks: o.checks ?? [], output: await screen(t) }
        : { type: "function_call_output", call_id: o.id, output: o.output ?? "Not run: the task was stopped first." },
    );
  return out;
}

/** The bot's answer in a response: its final answer, without what it said on the way there (as the Agents API thread's, sessions.ts finalAnswer). */
function answerIn(output: OutputItem[]) {
  const said = output.filter((o) => o.type === "message");
  const final = said.filter((o) => o.phase === "final_answer");
  return (final.length ? final : said.filter((o) => o.phase !== "commentary"))
    .flatMap((o) => (o.content ?? []).map((c) => c.text ?? ""))
    .join("\n")
    .trim();
}

/** A finished item, into the thread: its narration, what it's thinking (the live caption), its searches. */
function record(t: ComputerTurn, o: OutputItem, more: boolean) {
  if (o.type === "reasoning" && o.summary?.length) {
    const line = o.summary.map((x) => x.text).join(" ").replace(/\*\*/g, "").split(/(?<=[.!?])\s/)[0].trim();
    if (line) patchSession(t.sessionId, { activity: line.charAt(0).toLowerCase() + line.slice(1, 60).replace(/[.!?]$/, "") });
  } else if (o.type === "message" && (more || o.phase === "commentary")) {
    const text = (o.content ?? []).map((c) => c.text ?? "").join(" ").trim();
    if (text) t.step("note", text);
  } else if (o.type === "web_search_call") {
    const a = o.action as { type?: string; query?: string; url?: string } | undefined;
    t.step("search", a?.type === "open_page" && a.url ? `read ${a.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)}` : a?.query ? `searched "${a.query.slice(0, 70)}"` : "searched the web");
  }
}

/* ---------------- The screen ---------------- */

/**
 * The screen, as the computer tool takes it: full size, so the model's coordinates are the screen's.
 * Orgo left the computer asleep for it (409 computer_asleep: nobody said it's in use for 15 minutes, say
 * on a hosted server, which doesn't beat): an action wakes it, and the screenshot is taken again, once.
 */
async function screen(t: ComputerTurn) {
  const shot = () => orgo.screenshot(t.computerId, screenId(t.display), 1, "png");
  const png = await shot().catch(async (e: unknown) => {
    if (!computerAsleepError(e)) throw e;
    await orgo.bash(t.computerId, "true", 30);
    return shot();
  });
  return { type: "computer_screenshot", image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, detail: "original" };
}

/** Do a computer call's actions on the screen, then send the screen back. */
async function act(t: ComputerTurn, o: OutputItem) {
  const actions = o.actions ?? (o.action ? [o.action] : []);
  const doing = actions.filter((a) => a.type !== "screenshot");
  for (const a of actions) t.step(STEP_TOOL[a.type] ?? a.type, describeAction(a));
  if (doing.length) {
    const X = `DISPLAY=:${t.display} xdotool`;
    const script = [...doing.map((a) => xdo(X, a)), `mkdir -p /root/.bops/activity && echo "$(date +%s.%N) ${STEP_TOOL[doing.at(-1)!.type] ?? "act"}" > /root/.bops/activity/${t.display}`, `sleep ${SETTLE_S}`];
    const r = await orgo.bash(t.computerId, script.join("\n"), 60);
    if (r.exit_code !== 0) console.warn(`[computer] ${t.sessionId}: ${r.output.slice(0, 160)}`);
  }
  return { type: "computer_call_output", call_id: o.call_id, output: await screen(t) };
}

const KEYS: Record<string, string> = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift", cmd: "super", command: "super", meta: "super", super: "super", win: "super",
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", backspace: "BackSpace", delete: "Delete", del: "Delete", space: "space",
  up: "Up", down: "Down", left: "Left", right: "Right", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
  home: "Home", end: "End", pageup: "Page_Up", pagedown: "Page_Down", insert: "Insert", capslock: "Caps_Lock",
};
/** Keys that are a character other than a letter or digit, by their X name (xdotool doesn't know "/" or "+"). */
const SYMBOLS: Record<string, string> = {
  " ": "space", "/": "slash", "\\": "backslash", ".": "period", ",": "comma", ";": "semicolon", ":": "colon", "'": "apostrophe", '"': "quotedbl",
  "`": "grave", "-": "minus", "=": "equal", "+": "plus", "[": "bracketleft", "]": "bracketright", "{": "braceleft", "}": "braceright",
  "(": "parenleft", ")": "parenright", "<": "less", ">": "greater", "?": "question", "!": "exclam", "@": "at", "#": "numbersign",
  $: "dollar", "%": "percent", "^": "asciicircum", "&": "ampersand", "*": "asterisk", _: "underscore", "|": "bar", "~": "asciitilde",
};
const key = (k: string) => {
  const l = k.toLowerCase();
  return KEYS[l] ?? SYMBOLS[k] ?? (/^f\d{1,2}$/.test(l) ? l.toUpperCase() : l.length === 1 ? l : k);
};
/** One word for the shell, whatever it holds. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const n = (v: unknown) => Math.round(Number(v) || 0);

function xdo(X: string, a: Action): string {
  const held = (a.keys ?? []).map((k) => sh(key(k)));
  const down = held.length ? `${X} keydown ${held.join(" ")}; ` : "";
  const up = held.length ? `; ${X} keyup ${held.join(" ")}` : "";
  const button = { left: 1, wheel: 2, middle: 2, right: 3, back: 8, forward: 9 }[a.button ?? "left"] ?? 1;
  switch (a.type) {
    case "click":
      return `${X} mousemove ${n(a.x)} ${n(a.y)}; ${down}${X} click ${button}${up}`;
    case "double_click":
      return `${X} mousemove ${n(a.x)} ${n(a.y)}; ${down}${X} click --repeat 2 1${up}`;
    case "move":
      return `${X} mousemove ${n(a.x)} ${n(a.y)}`;
    case "drag": {
      const [first, ...rest] = a.path ?? [];
      if (!first) return "true";
      return [`${X} mousemove ${n(first.x)} ${n(first.y)}`, `${down}${X} mousedown 1`, ...rest.map((p) => `${X} mousemove --sync ${n(p.x)} ${n(p.y)}`), `${X} mouseup 1${up}`].join("; ");
    }
    case "type":
      // Base64, decoded on the computer, so the text needs no quoting; the "." keeps a newline at its end, which $(…) would drop.
      return `T="$(echo ${Buffer.from(a.text ?? "").toString("base64")} | base64 -d; echo .)"; ${X} type --delay 12 -- "\${T%.}"`;
    case "keypress":
      return `${X} key -- ${sh((a.keys ?? []).map(key).join("+"))}`;
    case "scroll": {
      // Pixels to wheel clicks, about 100 a click, at most 15 at a time.
      const clicks = (px?: number) => Math.min(15, Math.max(px ? 1 : 0, Math.round(Math.abs(px ?? 0) / 100)));
      const v = clicks(a.scroll_y), h = clicks(a.scroll_x);
      return [`${X} mousemove ${n(a.x)} ${n(a.y)}`, v && `${down}${X} click --repeat ${v} ${(a.scroll_y ?? 0) < 0 ? 4 : 5}${up}`, h && `${X} click --repeat ${h} ${(a.scroll_x ?? 0) < 0 ? 6 : 7}`]
        .filter(Boolean)
        .join("; ");
    }
    case "wait":
      return "sleep 2";
    default:
      return "true";
  }
}

/** The screen MCP's name for each action, so a thread's steps read the same on either runner. */
const STEP_TOOL: Record<string, string> = { click: "click", double_click: "click", type: "type_text", keypress: "key", scroll: "scroll", drag: "drag", move: "move", wait: "wait", screenshot: "screenshot" };

/** A computer action in the thread's words, matching the screen MCP's (sessions.ts describe). */
function describeAction(a: Action) {
  switch (a.type) {
    case "click":
      return `${a.button === "right" ? "right-clicked" : "clicked"} (${n(a.x)}, ${n(a.y)})`;
    case "double_click":
      return `double-clicked (${n(a.x)}, ${n(a.y)})`;
    case "type":
      return `typed "${(a.text ?? "").slice(0, 60)}"`;
    case "keypress":
      return `pressed ${(a.keys ?? []).join("+")}`;
    case "scroll":
      return `scrolled ${(a.scroll_y ?? 0) < 0 ? "up" : (a.scroll_y ?? 0) > 0 ? "down" : (a.scroll_x ?? 0) < 0 ? "left" : "right"}`;
    case "drag":
      return "dragged";
    case "move":
      return "moved the pointer";
    case "wait":
      return "waited for the page";
    default:
      return "looked at the screen";
  }
}

/* ---------------- Tools ---------------- */

const SHELL_TOOL = {
  type: "function",
  name: "run_command",
  description:
    "Run a bash command on your computer (Linux, as root, in /workspace) and get its output: for files, data, downloads, calculations and documents. Don't use it to drive websites or apps: do that on the screen. Up to 300 seconds; start longer jobs in the background.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command", "timeout_seconds"],
    properties: { command: { type: "string" }, timeout_seconds: { type: ["integer", "null"], description: "Default 60, at most 300." } },
  },
  strict: true,
};
/** Signing in from the user's vault on the task's screen (vault.ts vaultSignIn): the bot never sees the secret. */
const VAULT_TOOL = {
  type: "function",
  name: "sign_in_from_vault",
  description:
    "Sign in on a sign-in or verification code page from the user's vault: Bops finds the page on your screen, fills the saved username, password or 2FA code straight into it and submits; you never see them. Call it whenever a page asks you to sign in, and never type a password yourself. It says whether that worked.",
  parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  strict: true,
};

const clip = (s: string, max = 12_000) => (s.length > max ? `${s.slice(0, max / 2)}\n… (cut) …\n${s.slice(-max / 2)}` : s);

async function runFunction(t: ComputerTurn, o: OutputItem) {
  const s = session(t.sessionId)!;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(o.arguments || "{}");
  } catch {
    /* answered below */
  }
  let output: string;
  try {
    if (o.name === "run_command") {
      const command = String(args.command ?? "");
      t.step("command", `ran ${command.slice(0, 100)}`);
      const timeout = Math.min(300, Math.max(5, Number(args.timeout_seconds) || 60));
      const r = await orgo.bash(t.computerId, `mkdir -p /workspace && cd /workspace && export DISPLAY=:${t.display}\n${command}`, timeout);
      output = `exit code ${r.exit_code}\n${clip(r.output)}`;
    } else if (o.name === "sign_in_from_vault") {
      t.step("vault", "signing in from your vault");
      output = await (await import("./vault")).vaultSignIn(s.botId, t.display, t.sessionId);
    } else if (o.name === "find_app_actions") {
      t.step("find_app_actions", `looked for "${String(args.query ?? "").slice(0, 60)}" in your apps`);
      output = await findAppActions(s.botId, String(args.query ?? ""));
    } else if (o.name === "use_app") {
      t.step("use_app", `used ${String(args.action ?? "an app")}`);
      output = await runAppAction(s.botId, String(args.action ?? ""), (args.arguments as Record<string, unknown>) ?? {}, { sessionId: t.sessionId }, undefined, (args.account as string | null) ?? null);
    } else if (o.name && DATA_TOOL_NAMES.has(o.name)) {
      t.step(o.name, o.name === "business_search" ? `looked up ${String(args.job ?? "business data")}` : o.name === "find_data" ? `looked for "${String(args.query ?? "").slice(0, 60)}" in business data` : `got ${String(args.endpoint_id ?? "data")}`);
      output = await runDataTool(s.botId, o.name, args, { sessionId: t.sessionId });
    } else output = `Unknown tool ${o.name}.`;
  } catch (e) {
    output = `Failed: ${(e as Error).message}`;
  }
  return { type: "function_call_output", call_id: o.call_id, output };
}
