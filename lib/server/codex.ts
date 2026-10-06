import "server-only";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MacApproval, MacState } from "@/lib/types";
import { codexPath, findCodex, installCodex, installStatus } from "./codex-cli";
import { lowRisk, TALKING_APPS } from "./judgment";
import { agentEnv } from "./local";
import { onPostgres } from "./persist";
import { addMessage, bot, getState, id, ownerName, update } from "./store";

/**
 * The user's Mac, through Codex. Bops drives a local `codex app-server` (OpenAI's documented protocol
 * for apps built on Codex, as T3 Code and Conductor do), signed in with the user's ChatGPT account, so
 * work on their Mac runs on their plan and uses Codex's own computer use: it sees, clicks and types in
 * their apps in the background. Codex asks before using an app it hasn't been allowed; those asks
 * become cards in Bops ("Sam wants to use Calculator on your Mac"), answered once, for the
 * session, or always. Bops installs the CLI itself when the Mac has none (lib/server/codex-cli.ts).
 */

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown> & { threadId?: string }; result?: unknown; error?: { message?: string } };
type Listener = (m: Rpc) => void;

const CODEX_HOME = join(homedir(), ".codex");
/** Apps that, named in a task, mean it belongs on the user's Mac (they can change the list). */
export const DEFAULT_MAC_RULES = ["Messages", "iMessage", "Notes", "Apple Mail", "Photos", "Finder", "Keynote", "Pages", "Numbers", "Xcode", "Reminders", "my desktop", "my Downloads", "my laptop", "my Mac"];

class Codex {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private listeners = new Map<string, Listener>();
  private starting?: Promise<void>;
  /** Codex's questions waiting on the user, by approval id: how to answer them. */
  readonly waiting = new Map<string, { rpcId: number | string; method: string; threadId?: string }>();
  /** Apps the user allowed for the rest of a Codex thread ("this session"). */
  readonly sessionApps = new Map<string, Set<string>>();
  /** A sign-in to Codex open in the browser (signInToCodex), and how the last one ended if it failed. */
  login?: { id?: string; until: number };
  loginError?: string;

  /** Start the app server if it isn't running, and say hello. */
  ready() {
    if (this.proc && this.proc.exitCode === null && this.starting) return this.starting;
    this.starting = (async () => {
      // Bops threads run on the user's own Codex setup, minus a few things:
      // - the Composio plugin, which reaches all their accounts (Bops gives each bot only the apps
      //   it allows, lib/server/composio.ts);
      // - other computer-control servers (Cua Driver, Cua Spaces). Codex's own computer use asks
      //   the user once per app (the cards in Bops); these ask per tool (click, drag, type…), flood them
      //   with prompts, and follow rules of their own.
      const off = ['plugins."composio@composio".enabled=false', "mcp_servers.cua-driver.enabled=false", "mcp_servers.cua.enabled=false"];
      const proc = spawn(findCodex() ?? "codex", ["app-server", ...off.flatMap((c) => ["-c", c])], {
        cwd: homedir(),
        env: agentEnv({ PATH: codexPath() }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      this.buf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (d: string) => this.read(d));
      proc.stderr.on("data", () => {});
      proc.on("exit", () => {
        if (this.proc !== proc) return;
        this.proc = undefined;
        for (const p of this.pending.values()) p.rej(new Error("Codex stopped"));
        this.pending.clear();
        // Turns it was running can't finish now: end them, so their threads don't wait out a timeout.
        for (const [threadId, fn] of [...this.listeners]) fn({ method: "turn/completed", params: { threadId, turn: { status: "failed", error: { message: "Codex stopped" } } } as Rpc["params"] });
        // Anything it was asking about can't be answered anymore, and a sign-in it ran is gone with it.
        update((state) => state.mac && (state.mac.approvals = []));
        this.waiting.clear();
        this.login = undefined;
      });
      proc.on("error", () => {});
      await this.request("initialize", { clientInfo: { name: "bops", title: "Bops", version: "0.1" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } });
      this.send({ jsonrpc: "2.0", method: "initialized" });
    })();
    this.starting.catch(() => (this.starting = undefined));
    return this.starting;
  }

  private send(m: object) {
    this.proc?.stdin.write(`${JSON.stringify(m)}\n`);
  }

  request<T = Record<string, unknown>>(method: string, params: object, timeoutMs = 60_000): Promise<T> {
    return new Promise((res, rej) => {
      const rid = this.nextId++;
      const t = setTimeout(() => {
        this.pending.delete(rid);
        rej(new Error(`Codex didn't answer ${method}`));
      }, timeoutMs);
      this.pending.set(rid, { res: (v) => (clearTimeout(t), res(v as T)), rej: (e) => (clearTimeout(t), rej(e)) });
      this.send({ jsonrpc: "2.0", id: rid, method, params });
    });
  }

  respond(rpcId: number | string, result: object) {
    this.send({ jsonrpc: "2.0", id: rpcId, result });
  }

  on(threadId: string, fn: Listener) {
    this.listeners.set(threadId, fn);
  }
  off(threadId: string) {
    this.listeners.delete(threadId);
  }

  private read(d: string) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: Rpc;
      try {
        m = JSON.parse(line) as Rpc;
      } catch {
        continue;
      }
      if (m.id !== undefined && !m.method) {
        const p = this.pending.get(m.id as number);
        this.pending.delete(m.id as number);
        if (m.error) p?.rej(new Error(m.error.message ?? "Codex error"));
        else p?.res(m.result);
      } else if (m.id !== undefined && m.method) void this.ask(m);
      else if (m.method === "serverRequest/resolved") this.resolvedElsewhere(m.params?.requestId as number | string | undefined);
      else if (m.method === "account/login/completed") this.signedIn(m.params as { loginId?: string | null; success?: boolean; error?: string | null });
      else if (m.method) {
        const t = m.params?.threadId;
        if (t) this.listeners.get(t)?.(m);
      }
    }
  }

  /** Codex is asking something: answer what the user already decided, or put it in front of them. */
  private async ask(m: Rpc) {
    const threadId = m.params?.threadId;
    const session = threadId ? getState().sessions.find((s) => s.codexThread === threadId) : undefined;
    // Bops' own app tools already ask the user, with the details, so Codex needn't ask again.
    if (m.method === "mcpServer/elicitation/request" && m.params?.serverName === "bops_apps") return this.respond(m.id!, { action: "accept", content: {} });
    if (m.method === "mcpServer/elicitation/request") {
      const message = String(m.params?.message ?? "Codex is asking to continue");
      const app = /use "([^"]+)"/.exec(message)?.[1];
      const always = app && getState().mac?.alwaysApps.some((a) => a.toLowerCase() === app.toLowerCase());
      const forSession = app && threadId && this.sessionApps.get(threadId)?.has(app.toLowerCase());
      if (always || forSession) return this.respond(m.id!, { action: "accept", content: {} });
      // Low-stakes for this task (looking at Calculator, Notes, a setting): allowed without asking,
      // just this once, and said so in the chat. Apps where using them at all can mean talking to
      // someone (Messages, Mail, Slack…) always ask: on the Mac an app is allowed as a whole.
      if (app && session && !TALKING_APPS.test(app) && (await lowRisk(`Use the ${app} app on ${ownerName()}'s Mac`, `task: ${session.goal.slice(0, 500)}`))) {
        addMessage({ chatId: session.chatId, role: "system", text: `${bot(session.botId)?.name ?? "A bot"} used ${app} on your Mac · low risk for this task, so didn't ask`, sessionIds: [session.id] });
        return this.respond(m.id!, { action: "accept", content: {} });
      }
      return this.hold(m, { kind: app ? "app" : "other", app, message, sessionId: session?.id, botId: session?.botId });
    }
    if (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval") {
      const cmd = (m.params?.command ?? m.params?.reason ?? "") as string | string[];
      const what = Array.isArray(cmd) ? cmd.join(" ") : String(cmd);
      return this.hold(m, {
        kind: "command",
        message: m.method.includes("fileChange") ? `Change files${what ? `: ${what.slice(0, 160)}` : ""}` : `Run a command${what ? `: ${what.slice(0, 160)}` : ""}`,
        sessionId: session?.id,
        botId: session?.botId,
      });
    }
    // Anything else Codex asks a client (more input, permissions, tokens) Bops doesn't do yet.
    if (m.method?.endsWith("requestApproval") || m.method === "execCommandApproval" || m.method === "applyPatchApproval") return this.respond(m.id!, { decision: "decline" });
    if (m.method === "mcpServer/elicitation/request" || m.method === "item/tool/requestUserInput") return this.respond(m.id!, { action: "decline", content: null });
    this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Bops can't do that" } });
  }

  /** The sign-in in the browser ended: look at the Mac again right away, so the setup card moves on. */
  private signedIn(p: { loginId?: string | null; success?: boolean; error?: string | null }) {
    if (this.login?.id && p.loginId && p.loginId !== this.login.id) return;
    this.login = undefined;
    this.loginError = p.success ? undefined : "Codex sign-in didn't finish. Try again.";
    void checkMac().catch(() => {});
  }

  /** A question got its answer somewhere else (computer use's own prompt on the Mac): drop its card. */
  private resolvedElsewhere(requestId: number | string | undefined) {
    if (requestId === undefined) return;
    for (const [approvalId, w] of this.waiting)
      if (String(w.rpcId) === String(requestId)) {
        this.waiting.delete(approvalId);
        update((state) => state.mac && (state.mac.approvals = state.mac.approvals.filter((x) => x.id !== approvalId)));
      }
  }

  private hold(m: Rpc, a: Omit<MacApproval, "id" | "at">) {
    const approval: MacApproval = { id: id("ok"), at: Date.now(), ...a };
    this.waiting.set(approval.id, { rpcId: m.id!, method: m.method!, threadId: m.params?.threadId });
    update((state) => {
      state.mac ??= emptyMac();
      state.mac.approvals.push(approval);
    });
    // Unanswered for ten minutes: no.
    setTimeout(() => this.waiting.has(approval.id) && answer(approval.id, "deny"), 10 * 60_000);
  }
}

const g = globalThis as typeof globalThis & { __bopsCodex?: Codex; __bopsMacCheck?: ReturnType<typeof setInterval> };
export const codex = (g.__bopsCodex ??= new Codex());

export const emptyMac = (): MacState => ({ ready: false, approvals: [], alwaysApps: [], rules: [...DEFAULT_MAC_RULES] });

/** The user's answer to one of Codex's questions. "always" also remembers the app for every future task. */
export function answer(approvalId: string, decision: "once" | "session" | "always" | "deny") {
  const w = codex.waiting.get(approvalId);
  const a = getState().mac?.approvals.find((x) => x.id === approvalId);
  codex.waiting.delete(approvalId);
  update((state) => state.mac && (state.mac.approvals = state.mac.approvals.filter((x) => x.id !== approvalId)));
  if (!w) return;
  const yes = decision !== "deny";
  if (yes && a?.app && decision === "session" && w.threadId) {
    const set = codex.sessionApps.get(w.threadId) ?? new Set<string>();
    set.add(a.app.toLowerCase());
    codex.sessionApps.set(w.threadId, set);
  }
  if (yes && a?.app && decision === "always")
    update((state) => {
      state.mac ??= emptyMac();
      if (!state.mac.alwaysApps.some((x) => x.toLowerCase() === a.app!.toLowerCase())) state.mac.alwaysApps.push(a.app!);
    });
  if (w.method === "mcpServer/elicitation/request") codex.respond(w.rpcId, yes ? { action: "accept", content: {} } : { action: "decline", content: null });
  else codex.respond(w.rpcId, { decision: !yes ? "decline" : decision === "once" ? "accept" : "acceptForSession" });
}

/** This server runs on the user's Mac (not a hosted one), where Codex can work for the bots. */
const onTheMac = () => process.platform === "darwin" && !onPostgres();

/**
 * Is the user's Mac ready for bots, and if not, the one next step: the Codex CLI (Bops installs it
 * when it's missing, once per start and again on Retry), signed in to Codex with ChatGPT, and Codex's
 * Computer Use on (it comes with OpenAI's Codex app for Mac, not the CLI). Checked now and then, after
 * a sign-in ends, and while the setup card waits on the user; the answer lives in state.mac.
 */
export async function checkMac() {
  const has = (p: string) => existsSync(p);
  let ready = false;
  let reason: string | undefined;
  let next: MacState["next"];
  let plan: string | undefined;
  const bin = findCodex();
  if (!bin && !onTheMac()) {
    next = "elsewhere";
    reason = "Computer use works in the Bops app on your Mac.";
  } else if (!bin) {
    if (!installStatus()) installCodex(() => void checkMac().catch(() => {}));
    const failed = installStatus()?.state === "failed" ? installStatus()?.error : undefined;
    next = "codex";
    reason = failed !== undefined ? `Couldn't install Codex. ${failed}` : "Installing Codex";
  } else {
    const config = has(join(CODEX_HOME, "config.toml")) ? readFileSync(join(CODEX_HOME, "config.toml"), "utf8") : "";
    const computerUse =
      has(join(CODEX_HOME, "computer-use", "Codex Computer Use.app")) && /\[plugins\."(unified-)?computer-use@openai-bundled"\]\s*\n\s*enabled\s*=\s*true/.test(config);
    try {
      await codex.ready();
      const acct = await codex.request<{ account?: { type?: string; planType?: string } | null }>("account/read", {}, 15_000);
      if (codex.login && codex.login.until < Date.now()) codex.login = undefined;
      if (acct.account?.type !== "chatgpt") {
        next = "sign-in";
        reason = codex.login ? "Finish signing in in your browser" : (codex.loginError ?? "Sign in to Codex with your ChatGPT account");
      } else if (!computerUse) {
        next = "computer-use";
        reason = "Turn on Computer Use in Codex";
      } else ready = true;
      if (acct.account?.type === "chatgpt") codex.login = codex.loginError = undefined;
      plan = acct.account?.planType;
    } catch (e) {
      next = "codex";
      reason = `Codex didn't start (${(e as Error).message.replace(/\.$/, "")}).`;
    }
  }
  const now = { ready, reason, next, installing: next === "codex" && installStatus()?.state === "installing", signingIn: !!codex.login, plan };
  // The setup card looks every few seconds while it waits on the user: only a change goes out to the app.
  const was = getState().mac;
  if (was && (Object.keys(now) as (keyof typeof now)[]).every((k) => was[k] === now[k])) return ready;
  update((state) => {
    state.mac ??= emptyMac();
    Object.assign(state.mac, { ...now, checkedAt: Date.now() });
  });
  return ready;
}

/** Retry: install the CLI again if it's still missing (a failed install isn't retried by itself), then look again. */
export async function retryCodex() {
  if (!findCodex() && onTheMac()) installCodex(() => void checkMac().catch(() => {}));
  await checkMac();
}

/**
 * Sign in to Codex with ChatGPT through the app server Bops already runs (account/login/start), so it
 * knows the account the moment it's done: Codex's sign-in page opens in the user's browser, and its
 * end (account/login/completed) checks the Mac again. One sign-in at a time: a new one replaces the last.
 */
export async function signInToCodex() {
  await codex.ready();
  const was = codex.login?.id;
  if (was) await codex.request("account/login/cancel", { loginId: was }, 10_000).catch(() => {});
  const r = await codex.request<{ loginId?: string; authUrl?: string }>("account/login/start", { type: "chatgpt" }, 30_000);
  if (!r.authUrl) throw new Error("Codex didn't start a sign-in.");
  codex.login = { id: r.loginId, until: Date.now() + 15 * 60_000 };
  codex.loginError = undefined;
  await new Promise<void>((res, rej) => execFile("/usr/bin/open", [r.authUrl!], (e) => (e ? rej(new Error("Couldn't open the sign-in page.")) : res())));
  await checkMac();
}

/**
 * Open OpenAI's Codex app (`codex app`, which opens its installer when it's missing), where the user
 * turns on Computer Use. It comes only with that app; the CLI can't install it.
 */
export function openCodexApp() {
  const bin = findCodex();
  if (!bin) throw new Error("Codex isn't installed yet.");
  const child = spawn(bin, ["app", homedir()], { cwd: homedir(), env: agentEnv({ PATH: codexPath() }), stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

g.__bopsMacCheck ??= setInterval(() => void checkMac().catch(() => {}), 5 * 60_000);
void checkMac().catch(() => {});
