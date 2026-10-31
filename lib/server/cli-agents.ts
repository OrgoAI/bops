import "server-only";
import { randomBytes } from "node:crypto";
import { AGENTS, agentLabel, aiOf, isCli, keyVendor, ROUTE_NAMES, shellLabel, threadAgent, type AgentRun } from "@/lib/agents";
import { redactDeep } from "@/lib/secret-patterns";
import { BRAINS_ON, CLI_NAMES, live, planName, workspaceOf, type Bot, type Brain, type CliKind } from "@/lib/types";
import { ensureBrainTools, ensureClaudeCode, ensureCodex, ensureOpenCode, revealBrainKey, revealNamedKey } from "./brains";
import { KeysError } from "./keys";
import { heldAsk } from "./permission";
import { orgo } from "./orgo";
import { bot, getState, ownerName, session } from "./store";

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
 * and how its output reads. Claude Code's, Codex's and OpenCode's are here, on the same files and turn loop.
 * Codex and OpenCode run one `codex exec` (`opencode run`) per message on the same thread (bops-agent keeps it
 * going between them), on the user's own key, with full access on the computer as Bops agent's executor has.
 *
 * Every process a thread starts runs as its bot's agent (lib/agents.ts, the bot's AI profile): bops-brain gives
 * it only that bot's and that agent's settings, its own claude, codex and opencode, and on a key a token for a
 * gate that holds the key for that run (vm/bin/bops-ai-gate), so several bots on one computer each keep to
 * their own. The agent is read again from the bot's profile at every start (agentNow), never from the thread alone.
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
  | { type: "result"; ok: boolean; text?: string; stop?: CliStop }
  /** It compacted its session (Claude Code's compact_boundary): by itself, or as Compact asked (cliCompact). */
  | { type: "compacted" }
  | { type: "exited"; code: number };

/**
 * Why a CLI agent stopped and waits on the user: its plan's or key's limit, its sign in or key turned down, a
 * model its account can't use, its provider not answering, or the Vault has given all the keys it allows this hour.
 */
export type CliStop = "limit" | "auth" | "model" | "down" | "vault";

/** One CLI agent, as the turn loop uses it. */
export type CliDriver = {
  kind: CliKind;
  /** Its session id as Bops keeps it and puts it in a command (one that isn't is never used), and a new one for a thread. */
  cliId: (v: string | undefined) => string | undefined;
  newSession: () => string;
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
  /** It compacts its session when asked (cliCompact): Claude Code's /compact. Codex's exec and OpenCode's run have no such thing. */
  compacts: boolean;
};

/** How often a turn reads the CLI's output, and how long an approval waits for the user (the screen MCP gives up at 20 minutes). Mutable for the tests only. */
export const cliTiming = { pollMs: 1500, approveMs: 19 * 60_000 };
/** How many times a turn starts its process again when it's gone. */
const RESTARTS = 2;
/** At most this much of the CLI's output per read (bops-agent makes each event small first). */
const READ_MOST = 256 * 1024;
const MARK = "@@bops-agent@@ ";

/** The replies a user taps when a brain stopped and waits on them (sessions.ts replyToSession). */
export const FINISH_ON_BOPS = "Finish on Bops agent";
export const WAIT = "Wait";
/** Its provider wasn't answering: it starts again on its own agent, now. */
export const TRY_AGAIN = "Try again";
/** Which of them a reply is, when it's one. */
export function limitPick(text: string): "bops" | "wait" | "retry" | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  return t === FINISH_ON_BOPS.toLowerCase() ? "bops" : t === WAIT.toLowerCase() ? "wait" : t === TRY_AGAIN.toLowerCase() ? "retry" : undefined;
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
      return { tool: "note", detail: "updated its todo list" };
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

/**
 * A CLI agent turned a turn down: at a limit (the plan's usage, the key's credit, quota or rate), for its sign in
 * or key, for a model its account can't use (never a quiet run on the CLI's own default model instead), or its
 * provider isn't answering (or the gate couldn't reach it).
 */
const LIMIT = /usage limit|limit reached|hit your (usage )?limit|out of (extra )?usage|credit balance is too low|rate.?limit|quota|too many requests|\b429\b/i;
const AUTH = /(invalid|incorrect) (x-)?api.?key|please run \/login|not logged in|log ?in again|oauth token|token (has )?expired|authentication|unauthori[sz]ed|\b401\b|provider\.auth/i;
const MODEL = /\bmodel\b.{0,80}\b(not available|not found|not allowed|invalid|does not exist|isn't available|is not supported)\b|\b(invalid|unknown|unsupported) model\b/i;
const DOWN = /overloaded|\b529\b|\b502\b|\b503\b|connection (refused|reset)|ECONNREFUSED|ECONNRESET|service unavailable|Bops couldn't reach/i;
export const stopOf = (text: string): Exclude<CliStop, "vault"> | undefined => (LIMIT.test(text) ? "limit" : AUTH.test(text) ? "auth" : MODEL.test(text) ? "model" : DOWN.test(text) ? "down" : undefined);

/** A UUID, as Claude Code's and Codex's sessions are. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidId = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);

export const claudeDriver: CliDriver = {
  kind: "claude",
  cliId: uuidId,
  newSession: () => crypto.randomUUID(),
  steers: true,
  asks: true,
  compacts: true,
  prepare: async (computerId) => {
    await ensureClaudeCode(computerId);
    await ensureBrainTools(computerId);
  },
  note: (owner) =>
    `You run as Claude Code on this computer, for Bops. Your tools are Claude Code's own (Bash for the shell, Read, Edit and Write for files, WebSearch and WebFetch to look things up and read pages, TodoWrite, and Task for helpers) and Bops' (mcp__screen__* for the screen, ${owner}'s apps, signing in with their saved logins and screens for helpers; mcp__browser__* for the Chrome on your screen). Where the instructions above name a tool, use the one of yours that does that: web_search is WebSearch, the shell is Bash. Any other tool asks ${owner} in Bops first and waits for their answer; if they say no, don't do it another way.`,
  line: (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
  parse: (e) => {
    const parent = str(e.parent_tool_use_id);
    if (e.type === "system" && e.subtype === "init") {
      const servers = (Array.isArray(e.mcp_servers) ? e.mcp_servers : []) as { name?: unknown; status?: unknown }[];
      return [{ type: "started", session: str(e.session_id), failed: servers.filter((x) => x.status === "failed" || x.status === "needs-auth").map((x) => str(x.name) ?? "a server") }];
    }
    if (e.type === "system" && e.subtype === "compact_boundary") return [{ type: "compacted" }];
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
  cliId: uuidId,
  newSession: () => crypto.randomUUID(),
  steers: false,
  asks: false,
  compacts: false,
  prepare: async (computerId) => {
    await ensureCodex(computerId);
    await ensureBrainTools(computerId);
  },
  note: (owner) =>
    `You run as Codex on this computer, for Bops. Your tools are Codex's own (the shell, editing files, web search and your plan) and Bops' (the screen server's tools for the screen, ${owner}'s apps and signing in with their saved logins; the browser server's for the Chrome on your screen). Where the instructions above name a tool, use the one of yours that does that: web_search is your web search, the shell is your shell. You have no helpers here, so do every part yourself. What would change ${owner}'s apps (sending, posting, paying) asks them in Bops first and waits for their answer; if they say no, don't do it another way.`,
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
      if (item.type === "todo_list") return [{ type: "tool", id, tool: "note", detail: "updated its todo list", args: {} }];
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

/* ---------------- OpenCode ---------------- */

/** OpenCode's own tools, worded as Claude Code's are. Bops' MCP tools come as <server>_<tool>. */
function openCodeTool(name: string, args: Record<string, unknown>): { tool: string; detail?: string } {
  const mcp = /^(screen|browser)_(.+)$/.exec(name);
  if (mcp) return { tool: mcp[2] };
  switch (name) {
    case "bash":
      return { tool: "command", detail: `ran ${cut(str(args.command) ?? "a command", 100)}` };
    case "read":
      return { tool: "read", detail: `read ${base(args.filePath ?? args.file_path)}` };
    case "edit":
    case "patch":
      return { tool: "edit", detail: `edited ${base(args.filePath ?? args.file_path)}` };
    case "write":
      return { tool: "edit", detail: `wrote ${base(args.filePath ?? args.file_path)}` };
    case "glob":
    case "grep":
    case "list":
      return { tool: "search", detail: name === "grep" ? `searched files for "${cut(str(args.pattern) ?? "", 50)}"` : `looked for files like ${cut(str(args.pattern) ?? str(args.path) ?? "", 60)}` };
    case "webfetch":
      return { tool: "search", detail: `read ${cut((str(args.url) ?? "a page").replace(/^https?:\/\/(www\.)?/, ""), 70)}` };
    case "todowrite":
    case "todoread":
      return { tool: "note", detail: "updated its todo list" };
    case "task":
      return { tool: "helper", detail: str(args.description) ? `brought in a helper for ${cut(str(args.description)!, 60)}` : "started a helper" };
    default:
      return { tool: name, detail: `used ${name}` };
  }
}

/** OpenCode's session for a thread: Bops makes it, as OpenCode's own look ("ses_" and letters), and OpenCode creates it on the first run. */
const SES = /^ses_[A-Za-z0-9]{8,40}$/;
const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * OpenCode 2.0.27 (`opencode run --standalone --format json`, bops-agent _opencode): each message a run of its
 * own on the thread's session, on a private server (never the background service other bots on the computer
 * would share), its events as its run writes them (step_start, text, reasoning, tool_use once a tool ends,
 * error), then Bops' own line saying how the turn ended. Like Codex it doesn't steer and never asks.
 */
export const opencodeDriver: CliDriver = {
  kind: "opencode",
  cliId: (v) => (v && SES.test(v) ? v : undefined),
  newSession: () => `ses_${Array.from(randomBytes(24), (n) => ABC[n % ABC.length]).join("")}`,
  steers: false,
  asks: false,
  compacts: false,
  prepare: async (computerId) => {
    await ensureOpenCode(computerId);
    await ensureBrainTools(computerId);
  },
  note: (owner) =>
    `You run as OpenCode on this computer, for Bops. Your tools are OpenCode's own (bash for the shell, read, edit and write for files, glob and grep to find things, webfetch to read a page, your to-do list) and Bops' (the screen server's tools for the screen, ${owner}'s apps and signing in with their saved logins; the browser server's for the Chrome on your screen). Where the instructions above name a tool, use the one of yours that does that: the shell is bash. What would change ${owner}'s apps (sending, posting, paying) asks them in Bops first and waits for their answer; if they say no, don't do it another way.`,
  line: (text) => `${JSON.stringify({ text })}\n`,
  parse: (e) => {
    if (e.type === "bops" && e.subtype === "started") return [{ type: "started", session: str(e.session), failed: [] }];
    if (e.type === "bops" && e.subtype === "turn") {
      if (e.ok === true) return [{ type: "result", ok: true }];
      const text = str(e.error)?.trim() || "its turn failed";
      const stop = stopOf(text);
      return [{ type: "result", ok: false, text, ...(stop ? { stop } : {}) }];
    }
    if (e.type === "bops" && e.subtype === "exited") return [{ type: "exited", code: Number(e.code) || 0 }];
    const part = (e.part && typeof e.part === "object" ? e.part : {}) as Record<string, unknown>;
    if (e.type === "text" && str(part.text)?.trim()) return [{ type: "text", text: str(part.text)!.trim() }];
    if (e.type === "reasoning" && str(part.text)?.trim()) return [{ type: "thinking", text: str(part.text)!.trim().split("\n")[0] }];
    if (e.type === "tool_use") {
      const st = (part.state && typeof part.state === "object" ? part.state : {}) as Record<string, unknown>;
      const args = st.input && typeof st.input === "object" && !Array.isArray(st.input) ? (st.input as Record<string, unknown>) : {};
      const name = str(part.tool) ?? "tool";
      const t = openCodeTool(name, args);
      return [{ type: "tool", id: str(part.id) ?? "", ...t, ...(st.status === "error" && t.detail ? { detail: `couldn't: ${t.detail}` } : {}), args }];
    }
    return [];
  },
};

/** None in a build without brains (BRAINS_ON): every thread runs on Bops agent, one a CLI agent ran too. */
const DRIVERS: Partial<Record<CliKind, CliDriver>> = BRAINS_ON ? { claude: claudeDriver, codex: codexDriver, opencode: opencodeDriver } : {};
/** The driver for a CLI agent, when this build runs it (one without runs on Bops agent). */
export const cliDriver = (kind: CliKind) => DRIVERS[kind];

/* ---------------- The thread's CLI on its computer ---------------- */

/** A thread's CLI on a computer, for one run of the thread: where it is, its session, and how far Bops has read its output. */
export type CliRun = {
  sessionId: string;
  computerId: string;
  display: number;
  /** The agent it runs on as the run began (lib/agents.ts threadAgent), and its name for what the thread says. */
  agent: AgentRun;
  name: string;
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
  /** Started afresh by Compact where it should have picked its session up (cliCompact): the next turn's first words get what it lost. */
  lost?: true;
};

const b64 = (s: string) => Buffer.from(s).toString("base64");

/**
 * A CLI session's id as Bops keeps it and puts it in a command: Claude Code's and Codex's are UUIDs, OpenCode's
 * "ses_" and letters. One that isn't (the CLI's output said something else, and the bot's own shell can write
 * there) is never used.
 */
export const cliId = (v: string | undefined) => uuidId(v) ?? opencodeDriver.cliId(v);

/**
 * The thread's agent as its bot's profile has it now, for a start of its process (each one: a run can last
 * long): the user may have switched or removed it meanwhile, or moved it to another account, and nothing more
 * runs on the old one; a key is the Vault's now, not when the run began. Throws, in words, when it changed.
 */
export function agentNow(o: Pick<CliRun, "sessionId" | "agent" | "name">): { run: AgentRun; bot: Bot } {
  const s = session(o.sessionId);
  const b = s && bot(s.botId);
  if (!s || !b) throw new Error("That thread isn't there anymore");
  const now = threadAgent(s, b, getState());
  if (now.gone || now.kind !== o.agent.kind || now.agent.id !== o.agent.agent.id || now.agent.pays !== o.agent.agent.pays || now.account?.id !== o.agent.account?.id)
    throw new Error(`${b.name} doesn't run ${o.name} anymore, so this stopped`);
  return { run: now, bot: b };
}

/**
 * The flags that make a process on the computer this bot's agent's (bops-agent, bops-brain run --bot): the bot,
 * the agent, its model and thinking, where its key goes, and the bot's other agents (for its wrappers: a Claude
 * plan works in all its threads, a key only in its own agent's). Every value is checked here and again there.
 */
const safe = (v: string | undefined) => (v && /^[A-Za-z0-9._:/-]+$/.test(v) ? v : undefined);

/** The bot's CLI agents but `except`, for its wrappers (bops-brain --also: "claude:plan:<account>:<model>,codex:key:<account>:"). */
export function alsoSpec(b: Bot, except?: string) {
  return aiOf(b, getState())
    .agents.filter((x) => isCli(x.kind) && x.id !== except)
    .map((x) => `${x.kind}:${x.pays}:${safe(x.account) ?? "-"}:${safe(x.model) ?? ""}`)
    .filter((x) => /^[a-z]+:[a-z]+:[A-Za-z0-9_-]+:[A-Za-z0-9._:/-]*$/.test(x))
    .join(",");
}

export function agentFlags(r: AgentRun, b: Bot) {
  const others = alsoSpec(b, r.agent.id);
  const effort = r.kind !== "opencode" && (b.effort === "low" || b.effort === "medium" || b.effort === "high") ? b.effort : undefined;
  return [
    "--bot", b.id,
    "--agent", r.agent.id,
    ...(safe(r.model) ? ["--model", r.model!] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(r.route ? ["--route", r.route] : []),
    ...(others ? ["--also", others] : []),
    "--label", shellLabel(b.name),
  ].filter((x) => /^[A-Za-z0-9._:/,-]+$/.test(x));
}

/**
 * The key an agent on a key runs on, for one start only: its account's (Claude Code, Codex), or for OpenCode
 * its model's provider's, from the Vault. When the Vault has given all it allows this hour, the thread waits
 * for it (CliStopped "vault") rather than failing.
 */
export async function revealAgentKey(r: AgentRun, b: Bot): Promise<string> {
  try {
    if (r.account) return await revealBrainKey(r.account);
    if (!r.keyName) throw new Error(`${AGENTS[r.kind].name} has no key to run on`);
    return await revealNamedKey(r.keyName, workspaceOf(b));
  } catch (e) {
    if (e instanceof KeysError && e.status === 429) throw new BrainStopped("vault", e.message);
    throw e;
  }
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
export async function openRun(o: { sessionId: string; computerId: string; display: number; agent: AgentRun; driver: CliDriver; cli: string; resume: boolean; mcp: unknown; prompt: string; args?: string[] }): Promise<CliRun> {
  await put(o, "mcp.json", JSON.stringify(o.mcp));
  await put(o, "prompt.md", o.prompt);
  return { sessionId: o.sessionId, computerId: o.computerId, display: o.display, agent: o.agent, name: CLI_NAMES[o.driver.kind], driver: o.driver, cli: o.cli, resume: o.resume, up: false, restarts: 0, offset: 0, helpers: new Map(), down: new Set(), ...(o.args?.length ? { args: o.args } : {}) };
}

/**
 * Start the thread's process (any left from before goes first): it picks its session back up when the brain's
 * folder has it, else begins it. A key brain's key goes along as a file the run reads and deletes (revealed
 * for this start only). Says which.
 */
async function startCli(run: CliRun): Promise<"resumed" | "fresh"> {
  const { run: now, bot: b } = agentNow(run);
  const cli = run.driver.cliId(run.cli);
  if (!cli) throw new Error(`${run.name} has no session Bops can pick up`);
  if (now.agent.pays === "key") await put(run, "key", await revealAgentKey(now, b));
  const more = (run.args ?? []).filter((a) => /^[A-Za-z0-9=_.:/-]+$/.test(a));
  const r = await orgo.bash(run.computerId, `bops-agent start ${run.sessionId} ${now.account?.id ?? "-"} ${run.driver.kind} ${run.display} ${run.computerId} '${cli}' ${agentFlags(now, b).join(" ")}${more.length ? ` -- ${more.join(" ")}` : ""}`, 30);
  const mode = /started (resumed|fresh)/.exec(r.output)?.[1] as "resumed" | "fresh" | undefined;
  if (!mode) throw new Error(`${run.name} didn't start on the computer (${r.output.trim().slice(-160) || "no answer"})`);
  run.up = true;
  run.offset = 0;
  return mode;
}

/** One message into the thread's process. False when the process is gone. */
async function sendCli(run: CliRun, text: string) {
  const r = await orgo.bash(run.computerId, `echo ${b64(run.driver.line(text))} | base64 -d | bops-agent send ${run.sessionId}`, 30);
  if (r.output.includes("sent")) return true;
  if (r.output.includes("gone")) return false;
  throw new Error(`Bops couldn't reach ${run.name} on the computer (${r.output.trim().slice(0, 120) || "no answer"})`);
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
      // A key or token the CLI happened to say (an `env` it ran, an error) never comes into Bops.
      events.push(...run.driver.parse(redactDeep(JSON.parse(line) as Record<string, unknown>)));
    } catch {
      /* a line that isn't an event */
    }
  }
  if (typeof h.next === "number" && h.next >= run.offset) run.offset = h.next;
  return { events, alive: !!h.alive, more: !!h.more, err: redactDeep(h.err ?? "") };
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
 * Open a thread's CLI session in a terminal on a screen of its computer, for the user to work with it there
 * (sessions.ts openInTerminal): the thread's headless process goes first (bops-agent terminal), then
 * xfce4-terminal runs the CLI's own resume of the thread's session there (Claude Code's `--resume` with the
 * thread's tools and briefing, Codex's `resume`, OpenCode on the session) through bops-brain run as the bot's
 * agent; once the CLI is closed it's the bot's own shell, with the same settings. A key goes along as a file
 * that run reads and deletes. What the CLI asks, the user answers in the terminal.
 */
export async function openTerminal(o: { sessionId: string; computerId: string; display: number; agent: AgentRun; cli: string; mcp: unknown; prompt: string }) {
  const name = CLI_NAMES[o.agent.kind as CliKind];
  const { run: now, bot: b } = agentNow({ sessionId: o.sessionId, agent: o.agent, name });
  const driver = cliDriver(now.kind as CliKind);
  const cli = driver?.cliId(o.cli);
  if (!driver || !cli) throw new Error(`${name} has no session to open`);
  await put(o, "mcp.json", JSON.stringify(o.mcp));
  await put(o, "prompt.md", o.prompt);
  if (now.agent.pays === "key") await put(o, "key", await revealAgentKey(now, b));
  const r = await orgo.bash(o.computerId, `bops-agent terminal ${o.sessionId} ${now.account?.id ?? "-"} ${o.display} ${o.computerId} '${cli}' --kind ${driver.kind} ${agentFlags(now, b).join(" ")}`, 30);
  if (!r.output.includes("terminal on")) throw new Error(`its terminal didn't open (${r.output.trim().slice(-160) || "no answer"})`);
}

/**
 * A bot's own terminal with no thread (its profile's Open its terminal): its shell on a screen of its computer,
 * as its Default CLI agent (or its first), so claude, codex and opencode there are the bot's own. A key goes
 * along as a file the run reads and deletes, for the gate that holds it while the terminal is open.
 */
export async function openShell(o: { botId: string; computerId: string; display: number; agent: AgentRun; bot: Bot }) {
  const driver = cliDriver(o.agent.kind as CliKind);
  if (!driver) throw new Error("Only Claude Code, Codex or OpenCode opens a terminal");
  await driver.prepare(o.computerId);
  if (o.agent.agent.pays === "key") {
    const key = await revealAgentKey(o.agent, o.bot);
    const r = await orgo.bash(o.computerId, `echo ${b64(key)} | base64 -d | bops-agent put shell-${o.botId} key`, 30);
    if (!r.output.includes("ok")) throw new Error(`Bops couldn't set up the computer for this (${r.output.trim().slice(0, 120) || "no answer"})`);
  }
  const r = await orgo.bash(o.computerId, `bops-agent shell ${o.botId} ${o.agent.account?.id ?? "-"} ${driver.kind} ${o.display} ${o.computerId} ${agentFlags(o.agent, o.bot).join(" ")}`, 30);
  if (!r.output.includes("terminal on")) throw new Error(`its terminal didn't open (${r.output.trim().slice(-160) || "no answer"})`);
}

/** Close a thread's terminal, when it's open: its Claude Code there stops, so the thread's own can start. */
export async function closeTerminal(run: Pick<CliRun, "computerId" | "sessionId">) {
  await orgo.bash(run.computerId, `bops-agent unterm ${run.sessionId}`, 30);
}

/** A CLI agent turned a turn down (CliStop): the thread waits on the user. */
export class BrainStopped extends Error {
  why: CliStop;
  constructor(why: CliStop, said: string) {
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
  const name = run.name;
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
  let startedAt = Date.now();
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
    else if (!(await sendCli(run, run.lost ? `${t.context()}\n\n${t.input}` : t.input))) await begin(true);
    delete run.lost;
    for (;;) {
      if (t.signal.aborted) await giveUp("Stopped by you");
      // Time a tool waited on the user's OK (approveTool) isn't the turn running long, nor stalling.
      if (asking.get(run.sessionId)) {
        startedAt += Date.now() - lastAt;
        lastAt = Date.now();
      }
      if (Date.now() - startedAt > t.timeoutMs) await giveUp(t.tooLong);
      if (Date.now() - lastAt > t.idleMs) await giveUp(t.stalled);
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

/** What Claude Code is sent to compact its session: its own command, alone, never with Bops' briefing or notes around it (they'd be taken as what to keep). */
const COMPACT = "/compact";

/**
 * Compact (sessions.ts compactThread): the thread's CLI folds its session so far into a summary of its own, now. Claude
 * Code's /compact runs without a turn of the model's: it says compact_boundary, then a result with nothing in it. Its
 * process is started first when this run hasn't yet; one that began afresh there (the brain's folder lost its session)
 * has nothing to compact, and its next turn gets what it lost (CliRun.lost). A result without compact_boundary (the
 * command wasn't taken as one) didn't compact, and says so. Stopped, stuck past `idleMs` or gone, it stops the process.
 */
export async function cliCompact(run: CliRun, t: { signal: AbortSignal; idleMs: number; stalled: string; started: (cli: string) => void }): Promise<void> {
  if (!run.driver.compacts) throw new Error(`${run.name} doesn't compact as Bops runs it`);
  const giveUp = async (why: string): Promise<never> => {
    await stopCli(run).catch(() => {});
    throw new Error(why);
  };
  if (t.signal.aborted) throw new Error("Stopped by you");
  if (!run.up && (await startCli(run)) === "fresh" && run.resume) {
    run.lost = true;
    throw new Error("its conversation wasn't on the computer anymore");
  }
  if (!(await sendCli(run, COMPACT))) throw new Error(`${run.name} stopped as it started`);
  let compacted = false;
  let lastAt = Date.now();
  for (;;) {
    if (t.signal.aborted) await giveUp("Stopped by you");
    if (Date.now() - lastAt > t.idleMs) await giveUp(t.stalled);
    const r = await readCli(run).catch(() => null);
    for (const e of r?.events ?? []) {
      lastAt = Date.now();
      if (e.type === "started") {
        const cli = cliId(e.session);
        if (cli) {
          run.cli = cli;
          run.resume = true;
          t.started(cli);
        }
      } else if (e.type === "compacted") compacted = true;
      else if (e.type === "result") {
        if (e.stop) throw new BrainStopped(e.stop, e.text ?? "");
        if (!e.ok) throw new Error(e.text || "it didn't compact");
        if (!compacted) throw new Error(`${run.name} didn't take it as its compact`);
        return;
      }
    }
    if (r && !r.alive && !r.more) {
      run.up = false;
      throw new Error(`${run.name} stopped${r.err ? ` (${r.err.slice(-160)})` : ""}`);
    }
    if (!r?.more) await new Promise((resolve) => setTimeout(resolve, cliTiming.pollMs));
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
 * The user sees the request's card ("Sam wants to use Bash") and answers. Claude Code holds the call meanwhile,
 * so it can't pause the way Bops' own engines do: the request is held (permission.ts heldAsk). No answer within
 * cliTiming.approveMs, or the thread stopped meanwhile, is a no, and the request is taken out. Answers what the
 * approve tool hands Claude Code: allow, or deny with why (the user's own words, when they said what to do instead).
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
  asking.set(sessionId, (asking.get(sessionId) ?? 0) + 1);
  try {
    const name = /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool;
    const call = shortCall(tool, input);
    const answer = await heldAsk(
      { action: `Use ${name}`, resources: [call], preview: callDetail(input), kind: "brain" },
      { botId, threadId: sessionId },
      {
        ms: cliTiming.approveMs,
        alive: () => {
          const s = session(sessionId);
          return !!s && live(s);
        },
      },
    );
    if (typeof answer !== "string" && answer.reply !== "reject") return JSON.stringify({ behavior: "allow" });
    const why =
      typeof answer !== "string"
        ? answer.message
          ? `${owner} said no: ${answer.message}`
          : `${owner} said no. Don't do it, and don't do it another way.`
        : answer === "late"
          ? `${owner} didn't answer in time, so it wasn't done. Don't do it another way: say in your answer what you needed.`
          : "This task was stopped.";
    return JSON.stringify({ behavior: "deny", message: why });
  } finally {
    const n = (asking.get(sessionId) ?? 1) - 1;
    if (n > 0) asking.set(sessionId, n);
    else asking.delete(sessionId);
  }
}

/* ---------------- Waiting on the user ---------------- */


/** When a limit resets, as Claude Code said it ("…|1760032800", or "resets 3pm"). */
function resetsAt(text: string) {
  const ts = /\|(\d{10})\b/.exec(text)?.[1];
  if (ts) return new Date(Number(ts) * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return /\bresets? (?:at )?([^.·|\n]{1,40})/i.exec(text)?.[1]?.trim();
}

/** What a thread waiting for its Claude plan's sign in says (sessions.ts brainTurns). `where`: "Sam's computer". */
export const signInWords = (x: Pick<Brain, "name">, where: string, began: boolean) => `${x.name} isn't signed in on ${where}. Sign in with your Claude plan there and I'll ${began ? "carry on" : "start"}.`;

/**
 * What a thread says when its CLI agent stopped (BrainStopped), with the replies it offers (tidyAnswer makes them
 * buttons): Bops agent finishes it, on AI credit, or it waits (a reply carries it on, which tries again); a provider
 * that wasn't answering is tried again now (Try again); the Vault's hour starts it again by itself in a few minutes
 * (sessions.ts vaultWaitsDue), so Wait there is just that. `plan`: the signed in plan, when known. `bot`: its name,
 * for its profile, where a model for new threads is picked.
 */
export function stoppedWords(r: Pick<AgentRun, "kind" | "agent" | "model">, why: CliStop, said: string, where: string, plan?: string, bot?: string) {
  const name = AGENTS[r.kind].name;
  const onPlan = r.agent.pays === "plan";
  const vendor = keyVendor({ ...r.agent, model: r.model });
  const resets = why === "limit" ? resetsAt(said) : undefined;
  const until = resets ? ` until ${resets}` : "";
  const finish = "I can finish this on Bops agent, on your AI credit";
  if (why === "model")
    return `Your ${onPlan ? planName(plan) : `${vendor} key`} can't use ${agentLabel({ kind: r.kind, model: r.model }).replace(`${name} · `, "")}. Pick another model for new threads in ${bot ? `${bot}'s` : "the bot's"} profile. ${finish}, or wait.\n\nOptions: ${FINISH_ON_BOPS} | ${WAIT}`;
  if (why === "vault") return `Waiting for your Vault. It allows 30 key uses an hour, so this starts again by itself in a few minutes. Or I can finish it on Bops agent, on your AI credit.\n\nOptions: ${FINISH_ON_BOPS} | ${WAIT}`;
  if (why === "down") {
    const who = r.kind === "claude" ? "Claude" : r.kind === "codex" ? "OpenAI" : (ROUTE_NAMES[r.model?.split("/")[0] as keyof typeof ROUTE_NAMES] ?? "Its provider");
    return `${who} isn't answering right now. I can try again, or finish this on Bops agent, on your AI credit.\n\nOptions: ${TRY_AGAIN} | ${FINISH_ON_BOPS}`;
  }
  const what =
    why === "limit"
      ? onPlan
        ? `${name} reached your ${planName(plan)}'s usage limit${until}.`
        : `${name} reached what your ${vendor} key allows${until}.`
      : onPlan
        ? `${name} isn't signed in to your Claude plan on ${where} anymore.`
        : `${vendor} turned down your key for ${name}.`;
  return `${what} ${finish}, or wait.\n\nOptions: ${FINISH_ON_BOPS} | ${WAIT}`;
}

/** A CLI agent's name for the record. */
export const brainName = (x: Brain | undefined, kind: CliKind) => (x && x.name !== CLI_NAMES[kind] && kind !== "opencode" ? x.name : CLI_NAMES[kind]);
