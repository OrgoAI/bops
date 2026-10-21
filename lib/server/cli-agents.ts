import "server-only";
import { BRAIN_NAMES, BRAINS_ON, live, planName, type Brain, type BrainKind } from "@/lib/types";
import { brainById, ensureBrainTools, ensureClaudeCode, ensureCodex, revealBrainKey } from "./brains";
import { answerApp, askOwner } from "./composio";
import { orgo } from "./orgo";
import { id, ownerName, session } from "./store";

/**
 * A bot's threads on its brain (lib/server/brains.ts Brain) instead of Bops agent: Claude Code or Codex on
 * the bot's own computer, on the user's own Claude plan or key, or OpenAI key, so none of it is on AI credit.
 * sessions.ts runs such a thread as it runs any (its screen, the screen watch, the ledger, the turn loop,
 * answers, results, routines and the cleanup); only its turns come here (sessions.ts brainTurns).
 *
 * Each run of a thread starts one process for it on the computer (Claude Code, or Codex's runner), detached
 * and pinned to the thread's screen (vm/bin/bops-agent, through bops-brain run: an empty environment, the
 * brain's own folder), with the tools a Bops agent has there (Bops' screen and browser MCP servers) and Bops'
 * briefing after the CLI's own system prompt. Bops reaches the computer one command at a time (orgo.bash)
 * with no stream back, so it talks to the process through files: each message is a line appended to the
 * thread's input, and every poll reads the process's events on from where the last one got to and turns them
 * into the thread's steps. A message the user sends while Claude Code works goes in at once (it takes it
 * after what it's doing); a turn ends once every message sent has its answer. Stop interrupts it (SIGINT); a
 * process that's gone mid-turn (the computer slept or restarted, or it crashed) starts again on the same
 * session. What Claude Code may not do by itself asks the user in Bops first (the screen MCP's approve tool:
 * approveTool), with the app approval card.
 *
 * A driver is one CLI's part in this: how it's installed, what it's told, how a message is written for it,
 * and how its output reads. Claude Code's and Codex's are here, on the same files and turn loop. Codex runs
 * one `codex exec` per message on the same thread (bops-agent keeps it going between them), on the user's
 * OpenAI key only, with full access on the computer as Bops agent's executor has there.
 */

/** What Bops reads from a brain's CLI. `parent`: a helper's (Claude Code's Task), by the call that started it. */
export type CliEvent =
  /** It began: its session, and the MCP servers that didn't start. */
  | { type: "started"; session?: string; failed: string[] }
  /** A tool call. `detail` is how the thread shows it; unset for Bops' own screen and browser tools, which sessions.ts words as a Bops agent's. */
  | { type: "tool"; id: string; tool: string; args: Record<string, unknown>; detail?: string; parent?: string }
  | { type: "text"; text: string; parent?: string }
  | { type: "thinking"; text: string; parent?: string }
  /**
   * One message's answer. `text` unset: its last words are the answer (Codex says it in its last message,
   * not with the end of its turn). `stop`: turned down at the plan's usage limit or the key's ("limit"), or
   * for its sign-in or key ("auth").
   */
  | { type: "result"; ok: boolean; text?: string; stop?: "limit" | "auth" }
  | { type: "exited"; code: number };

/** One CLI agent, as the turn loop uses it. */
export type CliDriver = {
  kind: BrainKind;
  /** Its CLI and Bops' scripts on a computer (once per run of Bops). */
  prepare: (computerId: string) => Promise<void>;
  /** What it's told about itself after Bops' briefing: whose tools it has, and what asks the user. */
  note: (owner: string) => string;
  /** A message to it, as one line of its input. */
  line: (text: string) => string;
  /** One event of its output (a JSON line, made small by bops-agent read) as what Bops does with it. */
  parse: (event: Record<string, unknown>) => CliEvent[];
  /** A message sent while it works goes in then (Claude Code queues it after what it's doing); else it waits for the next turn. */
  steers: boolean;
  /** What it may not do by itself asks the user through the screen MCP's approve tool (Claude Code's --permission-prompt-tool). */
  asks: boolean;
};

/** How often a turn reads the CLI's output, and how long an approval waits for the user (the screen MCP gives up at 20 minutes). Mutable for the tests only. */
export const cliTiming = { pollMs: 1500, approveMs: 19 * 60_000 };
/** How many times a turn starts its process again when it's gone. */
const RESTARTS = 2;
/** At most this much of the CLI's output per read (bops-agent makes each event small first). */
const READ_MOST = 256 * 1024;
const MARK = "@@bops-agent@@ ";

/** The replies a user taps when a brain stopped at its limit (sessions.ts replyToSession). */
export const FINISH_ON_BOPS = "Finish on Bops agent";
export const WAIT = "Wait";
/** Which of them a reply is, when it's one. */
export function limitPick(text: string): "bops" | "wait" | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  return t === FINISH_ON_BOPS.toLowerCase() ? "bops" : t === WAIT.toLowerCase() ? "wait" : undefined;
}

/* ---------------- Claude Code ---------------- */

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const base = (p: unknown) => (str(p) ?? "a file").replace(/\/+$/, "").split("/").pop() || "a file";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Claude Code's own tools as the thread shows them, worded like a Bops agent's steps ("ran npm test", "edited cart.ts"). Bops' MCP tools by their own names. */
function claudeTool(name: string, args: Record<string, unknown>): { tool: string; detail?: string } {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return mcp[1] === "screen" || mcp[1] === "browser" ? { tool: mcp[2] } : { tool: mcp[2], detail: `used ${mcp[2]} (${mcp[1]})` };
  switch (name) {
    case "Bash":
      return { tool: "command", detail: `ran ${cut(str(args.command) ?? "a command", 100)}` };
    case "BashOutput":
    case "KillShell":
      return { tool: "command", detail: name === "KillShell" ? "stopped a command" : "checked on a command" };
    case "Read":
      return { tool: "read", detail: `read ${base(args.file_path)}` };
    case "Edit":
    case "MultiEdit":
      return { tool: "edit", detail: `edited ${base(args.file_path)}` };
    case "Write":
      return { tool: "edit", detail: `wrote ${base(args.file_path)}` };
    case "NotebookEdit":
      return { tool: "edit", detail: `edited ${base(args.notebook_path)}` };
    case "Glob":
      return { tool: "search", detail: `looked for files like ${cut(str(args.pattern) ?? "", 60)}` };
    case "Grep":
      return { tool: "search", detail: `searched files for "${cut(str(args.pattern) ?? "", 50)}"` };
    case "LS":
      return { tool: "search", detail: `listed ${base(args.path)}` };
    case "WebSearch":
      return { tool: "search", detail: `searched "${cut(str(args.query) ?? "", 70)}"` };
    case "WebFetch":
      return { tool: "search", detail: `read ${cut((str(args.url) ?? "a page").replace(/^https?:\/\/(www\.)?/, ""), 70)}` };
    case "TodoWrite":
      return { tool: "note", detail: "updated its to-do list" };
    case "Task":
    case "Agent":
      return { tool: "helper", detail: str(args.description) ? `brought in a helper for ${cut(str(args.description)!, 60)}` : "started a helper" };
    default:
      return { tool: name, detail: `used ${name}` };
  }
}

/** A result's words when it failed: Claude Code's own, from the result or its errors. */
const failure = (e: Record<string, unknown>) =>
  [str(e.result), ...(Array.isArray(e.errors) ? e.errors.map((x) => (typeof x === "string" ? x : str((x as { message?: unknown })?.message))) : [])].filter(Boolean).join(" ").trim() ||
  (e.subtype === "error_max_turns" ? "it reached the most turns it may take" : `it stopped (${str(e.subtype) ?? "an error"})`);

/** A brain's CLI turned a turn down at a limit (the plan's usage, the key's credit, quota or rate), or for its sign-in or key. */
const LIMIT = /usage limit|limit reached|hit your (usage )?limit|out of (extra )?usage|credit balance is too low|rate.?limit|quota|too many requests|\b429\b/i;
const AUTH = /(invalid|incorrect) api key|please run \/login|not logged in|log ?in again|oauth token|token (has )?expired|authentication|unauthori[sz]ed|\b401\b/i;
export const stopOf = (text: string) => (LIMIT.test(text) ? "limit" : AUTH.test(text) ? "auth" : undefined);

export const claudeDriver: CliDriver = {
  kind: "claude",
  steers: true,
  asks: true,
  prepare: async (computerId) => {
    await ensureClaudeCode(computerId);
    await ensureBrainTools(computerId);
  },
  note: (owner) =>
    `You run as Claude Code on this computer, for Bops. Your tools are Claude Code's own (Bash for the shell, Read, Edit and Write for files, WebSearch and WebFetch to look things up and read pages, TodoWrite, and Task for helpers) and Bops' (mcp__screen__* for the screen, ${owner}'s apps, signing in from their vault and screens for helpers; mcp__browser__* for the Chrome on your screen). Where the instructions above name a tool, use the one of yours that does that: web_search is WebSearch, the shell is Bash. Any other tool asks ${owner} in Bops first and waits for their answer; if they say no, don't do it another way.`,
  line: (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
  parse: (e) => {
    const parent = str(e.parent_tool_use_id);
    if (e.type === "system" && e.subtype === "init") {
      const servers = (Array.isArray(e.mcp_servers) ? e.mcp_servers : []) as { name?: unknown; status?: unknown }[];
      return [{ type: "started", session: str(e.session_id), failed: servers.filter((x) => x.status === "failed" || x.status === "needs-auth").map((x) => str(x.name) ?? "a server") }];
    }
    if (e.type === "assistant") {
      const content = ((e.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[];
      return (Array.isArray(content) ? content : []).flatMap((c): CliEvent[] => {
        if (c.type === "text" && str(c.text)?.trim()) return [{ type: "text", text: str(c.text)!.trim(), parent }];
        if (c.type === "thinking" && str(c.thinking)?.trim()) return [{ type: "thinking", text: str(c.thinking)!.trim(), parent }];
        if (c.type === "tool_use") {
          const args = c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {};
          const name = str(c.name) ?? "tool";
          return [{ type: "tool", id: str(c.id) ?? "", ...claudeTool(name, args), args, parent }];
        }
        return [];
      });
    }
    if (e.type === "result") {
      const failed = e.is_error === true || e.subtype !== "success";
      const text = failed ? failure(e) : (str(e.result) ?? "").trim();
      const stop = failed ? stopOf(text) : undefined;
      return [{ type: "result", ok: !failed, text, ...(stop ? { stop } : {}) }];
    }
    if (e.type === "bops" && e.subtype === "exited") return [{ type: "exited", code: Number(e.code) || 0 }];
    return [];
  },
};

/* ---------------- Codex ---------------- */

/** A command as Codex ran it, without the shell it wraps it in: "/bin/bash -lc 'npm test'" is npm test. */
const unwrap = (cmd: string) => /^(?:\S*\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(cmd.trim())?.[2] ?? cmd.trim();

/** What a file change did, worded as Claude Code's are: "edited cart.ts", "wrote notes.md", "deleted old.ts", "edited cart.ts and 2 more files". */
function fileChange(changes: unknown) {
  const all = (Array.isArray(changes) ? changes : []) as { path?: unknown; kind?: unknown }[];
  if (!all.length) return "edited files";
  const verb = (k: unknown) => (k === "add" ? "wrote" : k === "delete" ? "deleted" : "edited");
  const first = `${verb(all[0].kind)} ${base(all[0].path)}`;
  return all.length === 1 ? first : `${first} and ${all.length - 1} more file${all.length === 2 ? "" : "s"}`;
}

/** A web search as the thread shows it, as a Bops agent's are (sessions.ts describeSearch). */
function codexSearch(item: Record<string, unknown>) {
  const a = (item.action && typeof item.action === "object" ? item.action : {}) as Record<string, unknown>;
  if (a.type === "open_page" && str(a.url)) return `read ${cut(str(a.url)!.replace(/^https?:\/\/(www\.)?/, ""), 70)}`;
  if (a.type === "find_in_page") return `looked for "${cut(str(a.pattern) ?? "", 40)}" in the page`;
  const q = str(item.query)?.trim() || str(a.query)?.trim() || (Array.isArray(a.queries) ? a.queries.filter((x) => typeof x === "string").join(", ") : "");
  return q ? `searched "${cut(q, 70)}"` : "searched the web";
}

/** Codex said one of its MCP servers didn't start (as a warning: an error item), and which. */
const NOT_STARTED = /^MCP client for `([^`]+)` (?:failed to start|timed out)/;

/**
 * Codex (`codex exec --json`, bops-agent): each message is a turn of its own on the thread, which picks the
 * thread back up (`exec resume`), so a message the user sends while it works waits for the next turn: it
 * doesn't steer. Its key is the user's OpenAI key, and it has full access on the computer (as Bops agent's
 * executor has there), so nothing asks the user but what changes their apps (the screen MCP's app tools
 * ask, as they do for Bops agent).
 */
export const codexDriver: CliDriver = {
  kind: "codex",
  steers: false,
  asks: false,
  prepare: async (computerId) => {
    await ensureCodex(computerId);
    await ensureBrainTools(computerId);
  },
  note: (owner) =>
    `You run as Codex on this computer, for Bops. Your tools are Codex's own (the shell, editing files, web search and your plan) and Bops' (the screen server's tools for the screen, ${owner}'s apps and signing in from their vault; the browser server's for the Chrome on your screen). Where the instructions above name a tool, use the one of yours that does that: web_search is your web search, the shell is your shell. You have no helpers here, so do every part yourself. What would change ${owner}'s apps (sending, posting, paying) asks them in Bops first and waits for their answer; if they say no, don't do it another way.`,
  line: (text) => `${JSON.stringify({ text })}\n`,
  parse: (e) => {
    if (e.type === "thread.started") return [{ type: "started", session: str(e.thread_id), failed: [] }];
    if (e.type === "turn.completed") return [{ type: "result", ok: true }];
    if (e.type === "turn.failed") {
      const text = str((e.error as { message?: unknown } | undefined)?.message)?.trim() || "its turn failed";
      const stop = stopOf(text);
      return [{ type: "result", ok: false, text, ...(stop ? { stop } : {}) }];
    }
    if (e.type === "bops" && e.subtype === "exited") return [{ type: "exited", code: Number(e.code) || 0 }];
    const item = (e.item && typeof e.item === "object" ? e.item : undefined) as Record<string, unknown> | undefined;
    if (!item) return [];
    const id = str(item.id) ?? "";
    // What it does shows as it starts; what's only whole once it's done (a change to files, a search's query, its words) as it ends.
    if (e.type === "item.started") {
      if (item.type === "command_execution") {
        const command = unwrap(str(item.command) ?? "");
        return [{ type: "tool", id, tool: "command", detail: `ran ${cut(command || "a command", 100)}`, args: { command } }];
      }
      if (item.type === "mcp_tool_call") {
        const server = str(item.server) ?? "a server";
        const tool = str(item.tool) ?? "tool";
        const args = item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments) ? (item.arguments as Record<string, unknown>) : {};
        return [{ type: "tool", id, tool, args, ...(server === "screen" || server === "browser" ? {} : { detail: `used ${tool} (${server})` }) }];
      }
      if (item.type === "todo_list") return [{ type: "tool", id, tool: "note", detail: "updated its to-do list", args: {} }];
      if (item.type === "collab_tool_call" && item.tool === "spawn_agent")
        return [{ type: "tool", id, tool: "helper", detail: str(item.prompt) ? `brought in a helper for ${cut(str(item.prompt)!, 60)}` : "started a helper", args: { description: str(item.prompt) ?? "" } }];
      return [];
    }
    if (e.type !== "item.completed") return [];
    if (item.type === "agent_message" && str(item.text)?.trim()) return [{ type: "text", text: str(item.text)!.trim() }];
    // Its reasoning summary leads with a heading in bold ("**Checking the cart**"): that, for the caption.
    if (item.type === "reasoning" && str(item.text)?.trim()) return [{ type: "thinking", text: /^\*\*(.+?)\*\*/.exec(str(item.text)!.trim())?.[1] ?? str(item.text)!.trim().split("\n")[0] }];
    if (item.type === "file_change") return [{ type: "tool", id, tool: "edit", detail: `${item.status === "failed" ? "couldn't change: " : ""}${fileChange(item.changes)}`, args: {} }];
    if (item.type === "web_search") return [{ type: "tool", id, tool: "search", detail: codexSearch(item), args: {} }];
    const down = item.type === "error" ? NOT_STARTED.exec(str(item.message) ?? "") : null;
    if (down) return [{ type: "started", failed: [down[1]] }];
    return [];
  },
};

/** None in a build without brains (BRAINS_ON): every thread runs on Bops agent, one a brain ran too. */
const DRIVERS: Partial<Record<BrainKind, CliDriver>> = BRAINS_ON ? { claude: claudeDriver, codex: codexDriver } : {};
/** The driver for a brain's CLI, when this build runs it (one without runs on Bops agent). */
export const cliDriver = (kind: BrainKind) => DRIVERS[kind];

/* ---------------- The thread's CLI on its computer ---------------- */

/** A thread's CLI on a computer, for one run of the thread: where it is, its session, and how far Bops has read its output. */
export type CliRun = {
  sessionId: string;
  computerId: string;
  display: number;
  brain: Brain;
  driver: CliDriver;
  /** The CLI's session for the thread (Session.brainRun.cli), and whether it should have it already (it began it before). */
  cli: string;
  resume: boolean;
  /** Its process was started in this run, and how many times since it had to be started again. */
  up: boolean;
  restarts: number;
  /** How far its output has been read, in bytes (a new process starts it over). */
  offset: number;
  /** Helpers' names by the call that started them (Claude Code's Task), for their steps. */
  helpers: Map<string, string>;
  /** Its MCP servers the thread has been told didn't start, this run. */
  down: Set<string>;
  /** More arguments for the CLI as it starts (the REAL_CLAUDE test's --max-turns), each a plain word. */
  args?: string[];
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

/**
 * A CLI session's id as Bops keeps it and puts it in a command: Claude Code's and Codex's are both UUIDs. One
 * that isn't (the CLI's output said something else, and the bot's own shell can write there) is never used.
 */
export const cliId = (v: string | undefined) => (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : undefined);

/**
 * The brain as it is now, for a start of its process (each one: a run can last long): the user may have
 * removed it meanwhile, and a key brain's key is the Vault's now, not when the run began.
 */
function brainNow(x: Brain): Brain {
  const now = brainById(x.id);
  if (!now) throw new Error(`${x.name} isn't there anymore, so it didn't start again`);
  return now;
}

/** A file for the thread's CLI on the computer (bops-agent put), from stdin: never on a command line of its own. */
async function put(run: Pick<CliRun, "computerId" | "sessionId">, name: "mcp.json" | "prompt.md" | "key", body: string) {
  const r = await orgo.bash(run.computerId, `echo ${b64(body)} | base64 -d | bops-agent put ${run.sessionId} ${name}`, 30);
  if (!r.output.includes("ok")) throw new Error(`Bops couldn't set up the computer for this (${r.output.trim().slice(0, 120) || "no answer"})`);
}

/**
 * Set a thread's CLI up on its computer for a run: its tools (`mcp`: the MCP servers' config) and its
 * briefing (`prompt`), which every start of its process in this run uses.
 */
export async function openRun(o: { sessionId: string; computerId: string; display: number; brain: Brain; driver: CliDriver; cli: string; resume: boolean; mcp: unknown; prompt: string; args?: string[] }): Promise<CliRun> {
  await put(o, "mcp.json", JSON.stringify(o.mcp));
  await put(o, "prompt.md", o.prompt);
  return { sessionId: o.sessionId, computerId: o.computerId, display: o.display, brain: o.brain, driver: o.driver, cli: o.cli, resume: o.resume, up: false, restarts: 0, offset: 0, helpers: new Map(), down: new Set(), ...(o.args?.length ? { args: o.args } : {}) };
}

/**
 * Start the thread's process (any left from before goes first): it picks its session back up when the brain's
 * folder has it, else begins it. A key brain's key goes along as a file the run reads and deletes (revealed
 * for this start only). Says which.
 */
async function startCli(run: CliRun): Promise<"resumed" | "fresh"> {
  const x = brainNow(run.brain);
  const cli = cliId(run.cli);
  if (!cli) throw new Error(`${x.name} has no session Bops can pick up`);
  if (x.auth === "key") await put(run, "key", await revealBrainKey(x));
  const more = (run.args ?? []).filter((a) => /^[A-Za-z0-9=_.:/-]+$/.test(a));
  const r = await orgo.bash(run.computerId, `bops-agent start ${run.sessionId} ${x.id} ${run.driver.kind} ${run.display} ${run.computerId} '${cli}'${more.length ? ` -- ${more.join(" ")}` : ""}`, 30);
  const mode = /started (resumed|fresh)/.exec(r.output)?.[1] as "resumed" | "fresh" | undefined;
  if (!mode) throw new Error(`${run.brain.name} didn't start on the computer (${r.output.trim().slice(-160) || "no answer"})`);
  run.up = true;
  run.offset = 0;
  return mode;
}

/** One message into the thread's process. False when the process is gone. */
async function sendCli(run: CliRun, text: string) {
  const r = await orgo.bash(run.computerId, `echo ${b64(run.driver.line(text))} | base64 -d | bops-agent send ${run.sessionId}`, 30);
  if (r.output.includes("sent")) return true;
  if (r.output.includes("gone")) return false;
  throw new Error(`Bops couldn't reach ${run.brain.name} on the computer (${r.output.trim().slice(0, 120) || "no answer"})`);
}

/** What the process said since the last read, whether there's more of it to read, and whether it still runs (when it doesn't, its last error words). */
async function readCli(run: CliRun): Promise<{ events: CliEvent[]; alive: boolean; more: boolean; err: string }> {
  const r = await orgo.bash(run.computerId, `bops-agent read ${run.sessionId} ${run.offset} ${READ_MOST}`, 30);
  const at = r.output.indexOf(MARK);
  if (at < 0) throw new Error(r.output.trim().slice(0, 120) || "no answer");
  const [head, ...lines] = r.output.slice(at + MARK.length).split("\n");
  const h = JSON.parse(head) as { next?: number; alive?: boolean; more?: boolean; err?: string };
  const events: CliEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(...run.driver.parse(JSON.parse(line) as Record<string, unknown>));
    } catch {
      /* a line that isn't an event */
    }
  }
  if (typeof h.next === "number" && h.next >= run.offset) run.offset = h.next;
  return { events, alive: !!h.alive, more: !!h.more, err: h.err ?? "" };
}

/** Stop the thread's process now (Stop: SIGINT, then harder). */
export async function stopCli(run: Pick<CliRun, "computerId" | "sessionId">) {
  await orgo.bash(run.computerId, `bops-agent stop ${run.sessionId}`, 30);
}

/** The run is over: the process's input ends, so it finishes and exits (it's stopped if it doesn't). */
export async function closeCli(run: Pick<CliRun, "computerId" | "sessionId">) {
  await orgo.bash(run.computerId, `bops-agent close ${run.sessionId}`, 30);
}

/**
 * Open a thread's Claude Code session in a terminal on a screen of its computer, for the user to work with
 * it there (sessions.ts openInTerminal): the thread's headless process goes first (bops-agent terminal), then
 * xfce4-terminal runs Claude Code's own `--resume` of the thread's session there, with the thread's tools
 * and briefing (`mcp`, `prompt`, as a run has them) through bops-brain run: an empty environment, the brain's
 * own folder. A key brain's key goes along as a file that run reads and deletes. What Claude Code asks, the
 * user answers in the terminal.
 */
export async function openTerminal(o: { sessionId: string; computerId: string; display: number; brain: Brain; cli: string; mcp: unknown; prompt: string }) {
  const x = brainNow(o.brain);
  const cli = cliId(o.cli);
  if (!cli) throw new Error(`${x.name} has no session to open`);
  await put(o, "mcp.json", JSON.stringify(o.mcp));
  await put(o, "prompt.md", o.prompt);
  if (x.auth === "key") await put(o, "key", await revealBrainKey(x));
  const r = await orgo.bash(o.computerId, `bops-agent terminal ${o.sessionId} ${x.id} ${o.display} ${o.computerId} '${cli}'`, 30);
  if (!r.output.includes("terminal on")) throw new Error(`its terminal didn't open (${r.output.trim().slice(-160) || "no answer"})`);
}

/** Close a thread's terminal, when it's open: its Claude Code there stops, so the thread's own can start. */
export async function closeTerminal(run: Pick<CliRun, "computerId" | "sessionId">) {
  await orgo.bash(run.computerId, `bops-agent unterm ${run.sessionId}`, 30);
}

/** A brain's CLI turned a turn down at its limit or for its sign-in or key (CliEvent stop): the thread waits on the user. */
export class BrainStopped extends Error {
  why: "limit" | "auth";
  constructor(why: "limit" | "auth", said: string) {
    super(said);
    this.why = why;
  }
}

/** Approvals a thread's CLI is waiting on, by thread: its turn isn't stuck while the user decides. */
const asking = new Map<string, number>();

export type CliTurn = {
  input: string;
  signal: AbortSignal;
  /** How long the turn may run at all, and with nothing new (not counting an approval the user hasn't answered yet), and what each is called when it's given up on. */
  timeoutMs: number;
  idleMs: number;
  tooLong: string;
  stalled: string;
  /** A step for the thread; `detail` unset is Bops' screen or browser tool's, worded by sessions.ts (describe). */
  step: (tool: string, detail: string | undefined, args: Record<string, unknown>, who?: string) => void;
  /** What it's doing, in a few words, for its cursor's caption. */
  activity: (text: string) => void;
  /** What the user has said in the thread since it last looked, and how to mark it sent once it's in. */
  steer: () => { text: string; sent: () => void } | undefined;
  /** Bops calls `wake` when the user says something, so the turn looks at once; unset when the turn is over. */
  onSteer: (wake: (() => void) | undefined) => void;
  /** The CLI began (or picked up) its session: its id, as it said. */
  started: (cli: string) => void;
  /** One more message's answer was read (the turn's own first, then the user's words it took as it worked, in order). */
  answered?: () => void;
  /** What a session that lost its history needs first (its process started fresh where it should have picked up): the task, and where it got to. */
  context: () => string;
};

/** Said with the messages a process that was gone mid-turn gets again. */
const CUT_OFF = "(From Bops: you were cut off while you worked on this, and started again. Check what's already done before you carry on.)";

/**
 * One turn on a thread's CLI: the message in (its process started first, when this run hasn't yet), the
 * process's events read every cliTiming.pollMs into steps, the user's words in as they come, until every
 * message sent has its answer. Returns the last answer; one on the way (before the user's next words) is a
 * step. Stopped (the signal), stuck or out of time, it stops the process. A process that's gone is started
 * again (RESTARTS at most) and given again what it hadn't answered.
 */
export async function cliTurn(run: CliRun, t: CliTurn): Promise<string> {
  const name = run.brain.name;
  const queue: string[] = [];
  // Its latest words of its own: a step once it goes on, or nothing when they're its answer.
  let said: string | undefined;
  const flush = () => {
    if (said) t.step("note", said, {});
    said = undefined;
  };
  const who = (parent?: string) => (parent ? (run.helpers.get(parent) ?? "helper") : undefined);
  /** Start its process (`again`: it was gone mid-turn) and give it what it hasn't answered. */
  const begin = async (again: boolean, why = "") => {
    if (again && ++run.restarts > RESTARTS) throw new Error(`${name} stopped and didn't start again${why ? ` (${why.slice(-160)})` : ""}`);
    const mode = await startCli(run);
    // It should have had its session, and doesn't (the brain's folder lost it): the task and where it got to, first.
    const lost = mode === "fresh" && run.resume;
    for (const [i, text] of queue.entries()) {
      const words = [i === 0 && lost ? t.context() : "", i === 0 && again ? CUT_OFF : "", text].filter(Boolean).join("\n\n");
      if (!(await sendCli(run, words))) throw new Error(`${name} stopped as it started${why ? ` (${why.slice(-160)})` : ""}`);
    }
  };
  let poke: (() => void) | undefined;
  t.onSteer(() => poke?.());
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        t.signal.removeEventListener("abort", done);
        poke = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      poke = done;
      t.signal.addEventListener("abort", done, { once: true });
    });
  const startedAt = Date.now();
  let lastAt = Date.now();
  const giveUp = async (why: string): Promise<never> => {
    await stopCli(run).catch(() => {});
    throw new Error(why);
  };
  try {
    queue.push(t.input);
    // Stopped while it was on its way: nothing starts.
    if (t.signal.aborted) await giveUp("Stopped by you");
    if (!run.up) await begin(false);
    else if (!(await sendCli(run, t.input))) await begin(true);
    for (;;) {
      if (t.signal.aborted) await giveUp("Stopped by you");
      if (Date.now() - startedAt > t.timeoutMs) await giveUp(t.tooLong);
      if (!asking.get(run.sessionId) && Date.now() - lastAt > t.idleMs) await giveUp(t.stalled);
      if (asking.get(run.sessionId)) lastAt = Date.now();
      // The user's words since: in now, and Claude Code takes them after what it's doing. Codex doesn't
      // steer: they stay unsent, and the session runner gives them to it as the next turn (sessions.ts run).
      const st = run.driver.steers ? t.steer() : undefined;
      if (st) {
        queue.push(st.text);
        const into = await sendCli(run, st.text);
        st.sent();
        if (!into) await begin(true);
      }
      // A read that didn't get through (Orgo had a moment) is tried again at the next poll.
      const r = await readCli(run).catch(() => null);
      for (const e of r?.events ?? []) {
        lastAt = Date.now();
        if (e.type === "started") {
          // Only a session id that is one (cliId): it goes into the commands that start it again.
          const cli = cliId(e.session);
          if (cli) {
            run.cli = cli;
            run.resume = true;
            t.started(run.cli);
          }
          // Said once a run (Codex starts its servers again for every message).
          const failed = e.failed.filter((x) => !run.down.has(x));
          for (const x of failed) run.down.add(x);
          if (failed.length) t.step("note", `Its ${failed.join(" and ")} tools didn't start, so it works without them`, {});
        } else if (e.type === "tool") {
          if (!e.parent) flush();
          if (e.tool === "helper" && e.id) run.helpers.set(e.id, cut(str(e.args.description) ?? str(e.args.subagent_type) ?? "helper", 30));
          t.step(e.tool, e.detail, e.args, who(e.parent));
        } else if (e.type === "text") {
          if (e.parent) t.step("note", e.text, {}, who(e.parent));
          else {
            flush();
            said = e.text;
          }
        } else if (e.type === "thinking" && !e.parent) {
          const line = e.text.replace(/\*\*/g, "").split(/(?<=[.!?])\s/)[0].trim();
          if (line) t.activity(line.charAt(0).toLowerCase() + line.slice(1, 60).replace(/[.!?]$/, ""));
        } else if (e.type === "result") {
          queue.shift();
          t.answered?.();
          const text = e.text ?? said ?? "";
          // Turned down, or failed: what it has from the user still to do waits (BrainStopped: until the user
          // signs in or says more) or goes back to them (sessions.ts brainTurns), so it doesn't start on it.
          if (e.stop) {
            if (queue.length) await stopCli(run).catch(() => {});
            throw new BrainStopped(e.stop, text);
          }
          if (!e.ok) await giveUp(`${name} stopped: ${text}`);
          if (said && said !== text) flush();
          said = undefined;
          if (!queue.length) return text || "Done.";
          // An answer on the way, before the user's next words: a step, and the turn goes on with those.
          if (text) t.step("note", text, {});
        }
      }
      // Gone with messages unanswered, once all it said is read: the computer slept or restarted, or it
      // crashed. Again, on the same session.
      if (r && !r.alive && !r.more && queue.length) {
        if (t.signal.aborted) await giveUp("Stopped by you");
        await begin(true, r.err);
        lastAt = Date.now();
      }
      // More to read already: on with it.
      if (!r?.more) await nap(cliTiming.pollMs);
    }
  } finally {
    t.onSteer(undefined);
  }
}

/* ---------------- Asking the user ---------------- */

/** A tool call in a few words for the approval card's title: the tool, and its command, file or address. */
function shortCall(tool: string, input: Record<string, unknown>) {
  const name = /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool;
  const what = [input.command, input.file_path, input.notebook_path, input.url, input.path, input.query].map(str).find((v) => v?.trim()) ?? Object.values(input).map(str).find((v) => v?.trim());
  return cut(`${name} ${(what ?? "").replace(/\s+/g, " ").trim()}`.trim(), 90);
}

/** A tool call's input for the user to check: each field on a line of its own, short. */
const callDetail = (input: Record<string, unknown>) =>
  Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${cut(typeof v === "string" ? v : JSON.stringify(v), 600)}`)
    .join("\n")
    .slice(0, 1500);

/**
 * Claude Code asks whether a thread may use a tool it may not use by itself (the screen MCP's approve tool, its
 * --permission-prompt-tool; composio.ts appCall checks it's the thread's own bot and the thread is running).
 * The user sees the app approval card ("Sam wants to run: …") and says yes or no. No answer within
 * cliTiming.approveMs, or the thread stopped meanwhile, is a no, and the card goes. Answers what the approve
 * tool hands Claude Code: allow, or deny with why.
 */
export async function approveTool(botId: string, sessionId: string, args: Record<string, unknown>): Promise<string> {
  const tool = cut(str(args.tool) ?? "a tool", 80);
  const input = args.input && typeof args.input === "object" && !Array.isArray(args.input) ? (args.input as Record<string, unknown>) : {};
  const owner = ownerName();
  if (!BRAINS_ON || !session(sessionId)?.brainRun) return JSON.stringify({ behavior: "deny", message: "Only a thread a brain runs asks this way." });
  // Claude Code asks about one of its own tools by its name (NotebookEdit), never Bops' screen and browser
  // ones (it uses those by itself) or words of its own: anything else isn't its question (the approve tool is
  // one the model can call too), so the user is never shown a card for something made up.
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(tool) || /^mcp__(screen|browser)__/.test(tool))
    return JSON.stringify({ behavior: "deny", message: "That isn't a tool Claude Code asks about. Don't call approve yourself." });
  const approvalId = id("apr");
  asking.set(sessionId, (asking.get(sessionId) ?? 0) + 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let check: ReturnType<typeof setInterval> | undefined;
  try {
    const answer = await new Promise<"yes" | "no" | "late" | "gone">((resolve) => {
      void askOwner({ botId, sessionId, app: "brain", action: tool, title: shortCall(tool, input), detail: callDetail(input) }, approvalId).then((yes) => resolve(yes ? "yes" : "no"));
      timer = setTimeout(() => resolve("late"), cliTiming.approveMs);
      check = setInterval(() => {
        const s = session(sessionId);
        if (!s || !live(s)) resolve("gone");
      }, 1000);
    });
    if (answer === "late" || answer === "gone") answerApp(approvalId, false);
    if (answer === "yes") return JSON.stringify({ behavior: "allow" });
    const why =
      answer === "no"
        ? `${owner} said no. Don't do it, and don't do it another way.`
        : answer === "late"
          ? `${owner} didn't answer in time, so it wasn't done. Don't do it another way: say in your answer what you needed.`
          : "This task was stopped.";
    return JSON.stringify({ behavior: "deny", message: why });
  } finally {
    clearTimeout(timer);
    clearInterval(check);
    const n = (asking.get(sessionId) ?? 1) - 1;
    if (n > 0) asking.set(sessionId, n);
    else asking.delete(sessionId);
  }
}

/* ---------------- Waiting on the user ---------------- */

/** Whose key a key brain runs on. */
const vendor = (x: Pick<Brain, "kind">) => (x.kind === "codex" ? "OpenAI" : "Anthropic");

/** When a limit resets, as Claude Code said it ("…|1760032800", or "resets 3pm"). */
function resetsAt(text: string) {
  const ts = /\|(\d{10})\b/.exec(text)?.[1];
  if (ts) return new Date(Number(ts) * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return /\bresets? (?:at )?([^.·|\n]{1,40})/i.exec(text)?.[1]?.trim();
}

/** What a thread waiting for its plan brain's sign-in says (sessions.ts brainTurns). `where`: "Sam's computer". */
export const signInWords = (x: Brain, where: string, began: boolean) => `${x.name} isn't signed in on ${where}. Sign in with your Claude plan there and I'll ${began ? "carry on" : "start"}.`;

/**
 * What a thread says when its brain stopped (BrainStopped), with the two replies it offers (tidyAnswer makes
 * them buttons): Bops agent finishes it, on AI credit, or it waits. `plan`: the signed-in plan, when known.
 */
export function stoppedWords(x: Brain, why: "limit" | "auth", said: string, where: string, plan?: string) {
  const resets = why === "limit" ? resetsAt(said) : undefined;
  const until = resets ? ` until ${resets}` : "";
  const what =
    why === "limit"
      ? x.auth === "plan"
        ? `${x.name} reached your ${planName(plan)}'s usage limit${until}.`
        : `${x.name} reached what your ${vendor(x)} key allows${until}.`
      : x.auth === "plan"
        ? `${x.name} isn't signed in to your Claude plan on ${where} anymore.`
        : `${vendor(x)} turned down your key for ${x.name}.`;
  return `${what} I can finish this on Bops agent, on your AI credit, or wait.\n\nOptions: ${FINISH_ON_BOPS} | ${WAIT}`;
}

/** A brain's name for the record, when the brain is gone. */
export const brainName = (x: Brain | undefined, kind: BrainKind) => x?.name ?? BRAIN_NAMES[kind];
