import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screenMap } from "@/lib/screens";
import { botChatId, BRAIN_KEYS, BRAIN_NAMES, BRAINS_ON, planName, workspaceOf, type Brain, type BrainAuth, type BrainKind, type BrainSignIn } from "@/lib/types";
import { keysOf, listKeys, revealKey, type KeyScope } from "./keys";
import { orgo } from "./orgo";
import { sameComputer, workComputer } from "./screens";
import { addMessage, bot, getState, id, sameState, update } from "./store";

/**
 * Brains: the agent a bot's tasks run on, when the user brings their own instead of Bops agent (Bops'
 * own, on AI credit). Claude Code, which Bops installs unmodified on the bot's computer at a pinned
 * version, signed in with the user's own Claude plan or run on their own Anthropic key; or Codex, on
 * their own OpenAI key. Bops never pays for these runs and never handles the plan's login: the user
 * signs in through Claude Code's own sign-in, in a terminal on one of the bot's screens that they drive
 * live in Bops, and the login stays in that brain's folder on that computer (vm/bin/bops-brain). Bops
 * only ever asks Claude Code whether it's signed in, and keeps what it says about whose account it is
 * (BrainSignIn). A key brain names its key in the Vault; the key goes to the computer only as a file the
 * run reads and deletes (bops-brain run --key-file), like the executor's key (vm/bin/bops-exec).
 *
 * A plan sign-in is per computer: a bot that works on another computer signs in again there. Nothing
 * here copies a login from one folder or computer to another, and a computer copied from another starts
 * with no brain folders (sessions.ts ensureComputer).
 */

/** Claude Code's version on every computer: npm's stable one when it was pinned. */
export const CLAUDE_CODE_VERSION = "2.1.292";
/** Where Bops installs it on a computer (npm's global prefix there), and the binary. */
export const CLAUDE_PREFIX = "/opt/bops/claude";
export const CLAUDE_BIN = `${CLAUDE_PREFIX}/bin/claude`;
/** Codex, in the computer's image (orgo/bops-base.mjs), at the version the image pins (ensureCodex fetches it onto a computer without it). */
export const CODEX_BIN = "/usr/local/bin/codex";
export const CODEX_VERSION = "0.160.0";
/** Each brain's folder on a computer: Claude Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME. */
export const BRAINS_DIR = "/root/.bops/brains";
export const brainDir = (brainId: string) => `${BRAINS_DIR}/${brainId}`;

/** What a brain route answers in a build without brains (BRAINS_ON): there's nothing there. Null in one with them. */
export const brainsOff = () => (BRAINS_ON ? null : Response.json({ error: "This version of Bops has no brains." }, { status: 404 }));

/** A brain call turned down, with its HTTP status and words for the user. */
export class BrainError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const MAX_NAME = 60;
/** A name as kept: one line, no long dashes (the app's words never have them), at most MAX_NAME characters. */
const cleanName = (s: string) => s.replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);

export const brainById = (brainId: string) => getState().brains?.find((x) => x.id === brainId);
function need(brainId: string): Brain {
  const x = brainById(brainId);
  if (!x) throw new BrainError("That brain isn't there anymore.", 404);
  return x;
}

/** The workspace's brains, oldest first. */
export const brainsOf = (wsId: string) => (getState().brains ?? []).filter((x) => x.workspaceId === wsId);

/** "Claude Code", or "Claude Code 2" when the workspace has one by that name already. */
function freeName(kind: BrainKind, wsId: string) {
  const taken = new Set(brainsOf(wsId).map((x) => x.name.toLowerCase()));
  const base = BRAIN_NAMES[kind];
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** The bots of `wsId` among `botIds`, each once. */
const botsIn = (botIds: unknown, wsId: string) =>
  (Array.isArray(botIds) ? botIds : []).filter((x, i, all): x is string => typeof x === "string" && all.indexOf(x) === i && workspaceOf(bot(x)) === wsId && !!bot(x));

export type NewBrain = { kind: BrainKind; auth: BrainAuth; name?: string; keyScope?: KeyScope; bots?: string[]; use?: boolean; workspaceId?: string };

/**
 * Add a brain to the workspace (the current one unless `workspaceId`): Claude Code on a Claude plan or an
 * Anthropic key, or Codex on an OpenAI key. `bots` may use it; with `use`, they use it now (Bot.brain).
 */
export function addBrain(n: NewBrain): Brain {
  if (n.kind !== "claude" && n.kind !== "codex") throw new BrainError("Pick Claude Code or Codex.", 400);
  if (n.auth !== "plan" && n.auth !== "key") throw new BrainError("Pick how it signs in.", 400);
  if (n.kind === "codex" && n.auth !== "key") throw new BrainError("Codex works with your own OpenAI API key only.", 400);
  const wsId = n.workspaceId ?? getState().workspace ?? getState().workspaces?.[0]?.id;
  if (!wsId || !getState().workspaces?.some((w) => w.id === wsId)) throw new BrainError("No such workspace.", 404);
  const bots = botsIn(n.bots, wsId);
  const brain: Brain = {
    id: id("brain"),
    kind: n.kind,
    name: cleanName(n.name ?? "") || freeName(n.kind, wsId),
    auth: n.auth,
    ...(n.auth === "key" ? { keyName: BRAIN_KEYS[n.kind], keyScope: n.keyScope === "workspace" ? "workspace" : "all" } : {}),
    bots,
    workspaceId: wsId,
    createdAt: Date.now(),
  };
  update((s) => {
    s.brains = [...(s.brains ?? []), brain];
    if (n.use) for (const b of s.bots) if (bots.includes(b.id)) b.brain = brain.id;
  });
  return brainById(brain.id)!;
}

/**
 * What a brain runs now for bots that aren't on it anymore (or for any, once it's gone) stops at once
 * (sessions.ts brainLeft): nothing more runs on the user's plan or key after they said so. The threads it
 * stopped, with their computers.
 */
async function letGo(brainId: string, name: string) {
  const { brainLeft } = await import("./sessions");
  return brainLeft(brainId, name);
}
const letGoNow = (brainId: string, name: string) => void letGo(brainId, name).catch((e: Error) => console.warn(`[brains] stopping ${brainId}'s threads: ${e.message}`));

/** Rename a brain, change which bots may use it, or (a key brain) where its key is. A bot taken off it goes back to Bops agent. */
export function updateBrain(brainId: string, p: { name?: string; bots?: string[]; keyScope?: KeyScope }): Brain {
  const x = need(brainId);
  if (p.name !== undefined && !cleanName(p.name)) throw new BrainError("Give it a name.", 400);
  const bots = p.bots === undefined ? undefined : botsIn(p.bots, x.workspaceId);
  update((s) => {
    const y = s.brains?.find((z) => z.id === brainId);
    if (!y) return;
    if (p.name !== undefined) y.name = cleanName(p.name);
    if (bots) {
      y.bots = bots;
      for (const b of s.bots) if (b.brain === brainId && !bots.includes(b.id)) delete b.brain;
    }
    if (p.keyScope && y.auth === "key") y.keyScope = p.keyScope === "workspace" ? "workspace" : "all";
  });
  if (bots) letGoNow(brainId, x.name);
  return brainById(brainId)!;
}

/**
 * One bot on a brain's chips (Settings, Brain): it uses it now ("use"), may pick it in its profile ("may"),
 * or neither ("none", back to Bops agent if it used it).
 */
export function setBrainBot(brainId: string, botId: string, level: "use" | "may" | "none"): Brain {
  const x = need(brainId);
  const b = bot(botId);
  if (!b || workspaceOf(b) !== x.workspaceId) throw new BrainError("No such bot here.", 404);
  update((s) => {
    const y = s.brains?.find((z) => z.id === brainId);
    const c = s.bots.find((z) => z.id === botId);
    if (!y || !c) return;
    const rest = y.bots.filter((z) => z !== botId);
    y.bots = level === "none" ? rest : [...rest, botId];
    if (level === "use") c.brain = brainId;
    else if (c.brain === brainId) delete c.brain;
  });
  if (level !== "use") letGoNow(brainId, x.name);
  return brainById(brainId)!;
}

/** A bot's brain from its profile: one it may use, or null for Bops agent. */
export function setBotBrain(botId: string, brainId: string | null) {
  const b = bot(botId);
  if (!b) throw new BrainError("No such bot.", 404);
  if (brainId !== null && !need(brainId).bots.includes(botId)) throw new BrainError(`${b.name} isn't on that brain. Add it in Settings, Brain.`, 400);
  const was = b.brain && brainById(b.brain);
  update(() => {
    const c = bot(botId)!;
    if (brainId) c.brain = brainId;
    else delete c.brain;
  });
  if (was && was.id !== brainId) letGoNow(was.id, was.name);
}

/**
 * Take a brain away: its bots go back to Bops agent, a sign-in going stops, what it's running stops (letGo),
 * and on every computer it has a folder on (signed in or signing in there, or a thread of it ran there),
 * that thread's process stops, Claude Code signs out and the folder goes (in the background, best effort:
 * a computer that's gone has nothing left to remove).
 */
export function removeBrain(brainId: string) {
  const x = need(brainId);
  stopWatching(brainId);
  const ran = getState().sessions.flatMap((s) => (s.brainRun?.brainId === brainId ? [s.brainRun.computerId] : []));
  const computers = [...new Set([...(x.signIns ?? []).map((s) => s.computerId), ...(x.signingIn ? [x.signingIn.computerId] : []), ...ran])];
  update((s) => {
    s.brains = (s.brains ?? []).filter((y) => y.id !== brainId);
    for (const b of s.bots) if (b.brain === brainId) delete b.brain;
  });
  void letGo(brainId, x.name)
    .catch(() => [] as { sessionId: string; computerId: string }[])
    .then((left) => {
      for (const c of computers) {
        // Its threads' processes there first, so nothing runs on the folder as it goes.
        const stops = left.filter((l) => l.computerId === c).map((l) => `bops-agent stop ${l.sessionId}; `);
        void ensureBrainTools(c)
          .then(() => orgo.bash(c, `${stops.join("")}bops-brain cancel ${brainId}; bops-brain forget ${brainId}`, 60))
          .catch((e: Error) => console.warn(`[brains] removing ${brainId} from ${c}: ${e.message}`));
      }
    });
}

/* ---------------- Claude Code on a computer ---------------- */

/** Each computer's install of Claude Code, once per run of Bops; one that failed is tried again next time. */
const claudeReady = new Map<string, Promise<void>>();

/** The shell that installs the pinned Claude Code (npm's own package, its scripts and all) unless that version is there, and says so. */
export function claudeInstallCommand() {
  const v = CLAUDE_CODE_VERSION;
  const has = `[ "$(DISABLE_AUTOUPDATER=1 ${CLAUDE_BIN} --version 2>/dev/null | cut -d' ' -f1)" = "${v}" ]`;
  return [
    "mkdir -p /var/log/bops",
    `${has} || (mkdir -p ${CLAUDE_PREFIX} && npm install -g --prefix ${CLAUDE_PREFIX} --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code@${v} > /var/log/bops/claude-install.log 2>&1)`,
    `if ${has}; then echo "claude ${v}"; else tail -3 /var/log/bops/claude-install.log; fi`,
  ].join("\n");
}

/**
 * Claude Code on a computer, at CLAUDE_CODE_VERSION: installed from npm into CLAUDE_PREFIX when it isn't
 * there (or another version is), unchanged. Throws with plain words when it can't be.
 */
export function ensureClaudeCode(computerId: string): Promise<void> {
  const known = claudeReady.get(computerId);
  if (known) return known;
  const ready = orgo.bash(computerId, claudeInstallCommand(), 280).then((r) => {
    if (!r.output.includes(`claude ${CLAUDE_CODE_VERSION}`)) throw new BrainError(`Claude Code didn't install on the computer (${r.output.trim().slice(-160) || "no answer"}).`, 502);
  });
  ready.catch(() => claudeReady.delete(computerId));
  claudeReady.set(computerId, ready);
  return ready;
}

/** Each computer's Codex, checked once per run of Bops; one that failed is tried again next time. */
const codexReady = new Map<string, Promise<void>>();

/**
 * The shell that makes sure a computer has Codex (CODEX_BIN, as its image puts it there: `codex exec-server`
 * runs Bops agent's tools with it), and when it hasn't, fetches the release the image pins from GitHub, as
 * the image does, unchanged. Says "codex" and its version.
 */
export function codexInstallCommand() {
  const v = CODEX_VERSION;
  const has = `${CODEX_BIN} --version 2>/dev/null | grep -q '^codex-cli '`;
  const release = `codex-$(uname -m | sed 's/arm64/aarch64/')-unknown-linux-musl`;
  return [
    "mkdir -p /var/log/bops",
    `${has} || (cd /tmp && curl -fsSL -o codex-bops.tgz https://github.com/openai/codex/releases/download/rust-v${v}/${release}.tar.gz && tar -xzf codex-bops.tgz && install -m 755 ${release} ${CODEX_BIN}; rm -f codex-bops.tgz ${release}) > /var/log/bops/codex-install.log 2>&1`,
    `if ${has}; then echo "codex $(${CODEX_BIN} --version | cut -d' ' -f2)"; else tail -3 /var/log/bops/codex-install.log; fi`,
  ].join("\n");
}

/** Codex on a computer: the image's, or the pinned release when it has none. Throws with plain words when it can't be. */
export function ensureCodex(computerId: string): Promise<void> {
  const known = codexReady.get(computerId);
  if (known) return known;
  const ready = orgo.bash(computerId, codexInstallCommand(), 180).then((r) => {
    if (!/^codex \d/m.test(r.output)) throw new BrainError(`Codex isn't on the computer and didn't install (${r.output.trim().slice(-160) || "no answer"}).`, 502);
  });
  ready.catch(() => codexReady.delete(computerId));
  codexReady.set(computerId, ready);
  return ready;
}

/** The brain scripts every computer needs, kept matching this copy of Bops: sign-ins and runs, and a thread's process (bops-agent: cli-agents.ts). */
const BRAIN_TOOLS = [
  ["vm/bin/bops-brain", "/usr/local/bin/bops-brain"],
  ["vm/bin/bops-brain-browser", "/usr/local/bin/bops-brain-browser"],
  ["vm/bin/bops-agent", "/usr/local/bin/bops-agent"],
] as const;
const toolsChecked = new Map<string, string>();

/** Put the brain scripts (vm/bin/bops-brain, bops-brain-browser, bops-agent) on a computer that's missing them or behind, as sessions.ts does the screen tools. */
export async function ensureBrainTools(computerId: string) {
  const files = BRAIN_TOOLS.map(([src, dst]) => {
    const body = readFileSync(join(/*turbopackIgnore: true*/ process.cwd(), src));
    return { dst, body, md5: createHash("md5").update(body).digest("hex") };
  });
  const want = files.map((f) => f.md5).join(" ");
  if (toolsChecked.get(computerId) === want) return;
  const have = (await orgo.bash(computerId, `md5sum ${files.map((f) => f.dst).join(" ")} 2>/dev/null`, 15)).output;
  for (const f of files) {
    if (have.includes(`${f.md5}  ${f.dst}`)) continue;
    const r = await orgo.bash(computerId, `echo ${f.body.toString("base64")} | base64 -d > ${f.dst} && chmod 0755 ${f.dst} && echo ok`, 30);
    if (!r.output.includes("ok")) throw new BrainError(`Bops couldn't set up the computer for its brains (${r.output.trim().slice(0, 120)}).`, 502);
  }
  toolsChecked.set(computerId, want);
}

/* ---------------- Signed in, or not ---------------- */

/** What Claude Code says about a brain's sign-in on one computer: only these, never its login. */
export type BrainStatus = { loggedIn: boolean; method?: string; account?: BrainSignIn["account"] };

/**
 * Claude Code's `auth status --json`, kept to what Bops may keep: whether it's signed in, how
 * (authMethod), and whose account (email, orgName, subscriptionType as `plan`). Anything else it says
 * (its folder, the org's id, a provider) is dropped. Null when there's no answer to read.
 */
export function parseStatus(output: string): BrainStatus | null {
  const at = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (at < 0 || end < at) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(output.slice(at, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof j.loggedIn !== "boolean") return null;
  if (!j.loggedIn) return { loggedIn: false };
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
  const account = { email: text(j.email), orgName: text(j.orgName), plan: text(j.subscriptionType)?.toLowerCase() };
  const kept = Object.fromEntries(Object.entries(account).filter(([, v]) => v !== undefined)) as BrainStatus["account"];
  return { loggedIn: true, ...(text(j.authMethod) ? { method: text(j.authMethod) } : {}), ...(kept && Object.keys(kept).length ? { account: kept } : {}) };
}

/** Keep what a status said on the brain: its sign-in on that computer, or none. */
function record(brainId: string, computerId: string, st: BrainStatus) {
  update((s) => {
    const y = s.brains?.find((z) => z.id === brainId);
    if (!y) return;
    const rest = (y.signIns ?? []).filter((z) => z.computerId !== computerId);
    const next = st.loggedIn ? [...rest, { computerId, at: Date.now(), ...(st.method ? { method: st.method } : {}), ...(st.account ? { account: st.account } : {}) }] : rest;
    if (next.length) y.signIns = next;
    else delete y.signIns;
  });
}

/**
 * Ask Claude Code on a computer whether a plan brain is signed in there (`claude auth status --json` in
 * the brain's folder, with no Anthropic key or token in its environment: bops-brain status), and keep
 * what it says (BrainSignIn). A computer without Claude Code yet isn't signed in.
 */
export async function signInStatus(brainId: string, computerId: string): Promise<BrainStatus> {
  const x = need(brainId);
  if (x.kind !== "claude" || x.auth !== "plan") throw new BrainError("Only a Claude Code brain on a Claude plan signs in on a computer.", 400);
  await ensureBrainTools(computerId);
  const r = await orgo.bash(computerId, `bops-brain status ${brainId} ${computerId}`, 30);
  const st = parseStatus(r.output);
  if (!st) throw new BrainError("Claude Code didn't say whether it's signed in. Try again.", 502);
  if (brainById(brainId)) record(brainId, computerId, st);
  return st;
}

/* ---------------- Signing in on a bot's screen ---------------- */

/** How often a sign-in asks Claude Code, how long it waits for the user, and how long after they hand the screen back. Mutable for the tests only. */
export const signInTiming = { pollMs: 3000, maxMs: 10 * 60_000, afterHandBackMs: 60_000 };
const g = globalThis as unknown as { bopsBrainWatch?: Map<string, AbortController> };
const watching = (g.bopsBrainWatch ??= new Map());

function stopWatching(brainId: string) {
  watching.get(brainId)?.abort();
  watching.delete(brainId);
}

/** The user drives that screen still (they took it over for the sign-in, and haven't handed it back or moved on). */
const driving = (botId: string, display: number) => {
  const t = getState().takeover;
  return !!t && t.display === display && sameComputer(t.botId, botId);
};

/** Hand the screen back if the sign-in still has it. */
async function handBack(botId: string, display: number) {
  if (!driving(botId, display)) return;
  const { returnControl } = await import("./sessions");
  returnControl();
}

const signingIn = (brainId: string, patch: Brain["signingIn"]) =>
  update((s) => {
    const y = s.brains?.find((z) => z.id === brainId);
    if (!y) return;
    if (patch) y.signingIn = patch;
    else delete y.signingIn;
  });

/**
 * Sign a plan brain in on the computer `botId` works on, there and then, by the user: Bops wakes the
 * computer (or makes it), takes one of its free screens for them (a takeover, so no task starts there),
 * makes sure Claude Code is on it, and opens Claude Code's own sign-in in a terminal on that screen, its
 * page in that screen's Chrome. The app shows that screen and the user signs in on it. Bops asks Claude
 * Code every few seconds until it says it's signed in (then hands the screen back and says so in the
 * bot's chat), the user gives up (hands the screen back and doesn't finish soon after), or it's been
 * signInTiming.maxMs. Returns the screen at once; the rest goes on behind (Brain.signingIn says how).
 */
export async function startSignIn(brainId: string, botId: string): Promise<{ botId: string; display: number }> {
  const x = need(brainId);
  if (x.kind !== "claude" || x.auth !== "plan") throw new BrainError("Only a Claude Code brain on a Claude plan signs in on a computer.", 400);
  const b = bot(botId);
  if (!b) throw new BrainError("No such bot.", 404);
  if (!x.bots.includes(botId)) throw new BrainError(`Let ${b.name} use ${x.name} first.`, 400);
  if (getState().host === "mac") throw new BrainError("Your bots work in browsers on this Mac (Settings, Where your bots work), so there's no bot computer to sign in on.", 400);
  const fresh = sameState();
  let c = workComputer(b);
  if (!c.computerId || c.computerStatus !== "ready") {
    const { ensureComputer } = await import("./sessions");
    await ensureComputer(c.id);
    if (!fresh()) throw new BrainError("Bops signed out meanwhile.", 409);
    c = workComputer(bot(botId)!);
  }
  const computerId = c.computerId;
  if (!computerId || c.computerStatus !== "ready") throw new BrainError(`${c.name}'s computer isn't ready yet. Try again in a minute.`, 409);
  // Going there already: the same screen again.
  const going = brainById(brainId)?.signingIn;
  if (going && !going.failed && going.computerId === computerId && watching.has(brainId)) return { botId: going.botId, display: going.display };
  const display = screenMap(getState(), botId).find((s) => s.kind === "free")?.display;
  if (display === undefined) throw new BrainError(`All of ${c.name}'s screens are in use. Try again when one is free.`, 409);
  // Going on another computer: that one closes first (its terminal and page there, its screen back to its bot),
  // as Cancel would, so it isn't left open on a screen the bots work on again.
  if (going && !going.failed && going.computerId !== computerId) await cancelSignIn(brainId);
  stopWatching(brainId);
  const ctl = new AbortController();
  watching.set(brainId, ctl);
  signingIn(brainId, { botId, computerId, display, at: Date.now() });
  // The user has the screen from now (takeOver marks it theirs before it waits on anything), so no task starts on it.
  const S = await import("./sessions");
  const taken = S.takeOver(botId, display);
  taken.catch(() => {});
  void signIn(brainId, botId, computerId, display, taken, ctl.signal);
  return { botId, display };
}

/** The sign-in, behind startSignIn: the screen (`taken`: the takeover, waking the computer), Claude Code and its sign-in on it, then the wait. */
async function signIn(brainId: string, botId: string, computerId: string, display: number, taken: Promise<void>, signal: AbortSignal) {
  const fresh = sameState();
  const live = () => fresh() && !signal.aborted && !!brainById(brainId);
  const name = () => workComputer(bot(botId)!).name;
  const fail = async (why: string) => {
    if (!live()) return;
    const was = brainById(brainId)?.signingIn;
    signingIn(brainId, { botId, computerId, display, at: was?.at ?? Date.now(), failed: why });
    watching.delete(brainId);
    await orgo.bash(computerId, `bops-brain cancel ${brainId}`, 15).catch(() => null);
    await handBack(botId, display);
    addMessage({ chatId: botChatId(botId), role: "system", text: `Claude Code didn't sign in on ${name()}'s computer: ${why}` });
  };
  try {
    const { ensureScreens } = await import("./sessions");
    await taken;
    if (!live()) return;
    if (!driving(botId, display)) return await fail(`${name()}'s computer is asleep and couldn't wake up.`);
    await ensureScreens(computerId);
    await ensureClaudeCode(computerId);
    await ensureBrainTools(computerId);
    if (!live()) return;
    const r = await orgo.bash(computerId, `bops-brain login ${brainId} ${display} ${computerId}`, 30);
    if (r.exit_code !== 0 || !r.output.includes("signing in")) return await fail(`its sign-in didn't open (${r.output.trim().slice(0, 120) || "no answer"}).`);
  } catch (e) {
    return await fail((e as Error).message);
  }
  const started = Date.now();
  let gaveBack = 0;
  while (live()) {
    await new Promise((r) => setTimeout(r, signInTiming.pollMs));
    if (!live()) return;
    const st = await signInStatus(brainId, computerId).catch(() => null);
    if (!live()) return;
    if (st?.loggedIn) {
      signingIn(brainId, undefined);
      watching.delete(brainId);
      // Its window closes by itself once Claude Code has signed in; this is in case it's still open.
      await orgo.bash(computerId, `bops-brain cancel ${brainId}`, 15).catch(() => null);
      await handBack(botId, display);
      const x = brainById(brainId);
      addMessage({ chatId: botChatId(botId), role: "system", text: `${x?.name ?? "Claude Code"} is signed in on ${name()}'s computer with your ${planName(st.account?.plan)}.` });
      // Threads that waited for it there carry on.
      const { brainSignedIn } = await import("./sessions");
      brainSignedIn(brainId, computerId);
      return;
    }
    if (driving(botId, display)) gaveBack = 0;
    else gaveBack ||= Date.now();
    if (gaveBack && Date.now() - gaveBack > signInTiming.afterHandBackMs) return await fail("the screen was handed back before signing in finished.");
    if (Date.now() - started > signInTiming.maxMs) return await fail("it took too long. Try again when you're ready.");
  }
}

/** Stop a sign-in: its terminal closes and the screen goes back to the bot. */
export async function cancelSignIn(brainId: string) {
  const x = need(brainId);
  const going = x.signingIn;
  stopWatching(brainId);
  signingIn(brainId, undefined);
  if (!going) return;
  await orgo.bash(going.computerId, `bops-brain cancel ${brainId}`, 15).catch(() => null);
  await handBack(going.botId, going.display);
}

/** Sign a plan brain out on the computer `botId` works on (Claude Code's own `auth logout` in its folder there). */
export async function signOut(brainId: string, botId: string) {
  const x = need(brainId);
  const b = bot(botId);
  if (!b) throw new BrainError("No such bot.", 404);
  const computerId = workComputer(b).computerId;
  if (!computerId) return;
  await ensureBrainTools(computerId);
  await orgo.bash(computerId, `bops-brain logout ${x.id}`, 30);
  record(x.id, computerId, { loggedIn: false });
}

/* ---------------- For a run ---------------- */

/**
 * A key brain's key, for its run only: from the Vault (Orgo limits and logs each one), on its way to the
 * computer as a 0600 file `bops-brain run --key-file` reads and deletes. Never kept, logged, or shown to a model.
 */
export async function revealBrainKey(x: Brain): Promise<string> {
  if (x.auth !== "key" || !x.keyName) throw new BrainError(`${x.name} doesn't run on a key.`, 400);
  const name = x.keyName;
  // The key as the Vault has it now, as the bots' calls find one: the workspace's own first, else the one for
  // all workspaces (not where it was when the brain was added: it may have been replaced in the other since).
  // When the Vault can't say, where it was then.
  const scope: KeyScope = await listKeys({ fresh: true })
    .then((all): KeyScope => {
      const have = keysOf(all, x.workspaceId).filter((k) => k.name === name);
      return have.some((k) => k.workspaceId) ? "workspace" : have.length ? "all" : (x.keyScope ?? "all");
    })
    .catch(() => x.keyScope ?? "all");
  return (await revealKey(name, scope, x.workspaceId)).value;
}
