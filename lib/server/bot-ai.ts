import "server-only";
import { AGENTS, agentOn, aiOf, cleanAi, hasProfile, isCli, MAX_AGENTS, modelOk, newAgentId, PAYS_SOON, paysOk, threadAgent } from "@/lib/agents";
import { BRAINS_ON, workspaceOf, type AgentKind, type AgentPays, type Bot, type BotAi, type BotAgent } from "@/lib/types";
import { addBrain, BrainError, ensureBrainTools } from "./brains";
import { alsoSpec } from "./cli-agents";
import { orgo } from "./orgo";
import { workComputer } from "./screens";
import { bot, getState, ownerName, session, update } from "./store";

/**
 * A bot's AI profile (Bot.ai, lib/agents.ts), changed by its owner from the bot's profile, AI (POST /api/bots/ai):
 * an agent added, changed, removed, or made the Default. What runs on an agent that went, or on its old account
 * or way to pay, stops at once (sessions.ts agentsChanged), and its folder on the bot's computer goes (bops-brain
 * bot-clear), so nothing more runs on the old plan or key after the owner said so. A new Default or model only
 * changes new threads: the ones running keep theirs.
 */

export type AiOp =
  | { op: "add"; kind: AgentKind; pays: AgentPays; model?: string; newAccount?: boolean }
  | { op: "update"; agentId: string; model?: string | null; pays?: AgentPays; account?: string; newAccount?: boolean }
  | { op: "remove"; agentId: string }
  | { op: "default"; agentId: string };

const soonWords = (kind: AgentKind, pays?: AgentPays) => `Soon: ${(pays && PAYS_SOON[kind]?.[pays]) ?? AGENTS[kind].soon ?? `${AGENTS[kind].name} isn't in Bops yet.`}`;

/**
 * The account for an agent of `kind` paying with `pays` in the bot's workspace: the one there is that the bot's other
 * agents of its kind don't use (`taken`), else a new one (`fresh`: always new). A key account is one per kind and
 * workspace (its Vault key is the workspace's): another one adds nothing, so a second agent on it is turned down.
 */
function accountFor(kind: "claude" | "codex", pays: AgentPays, wsId: string, fresh: boolean, taken: Set<string | undefined>, botName: string) {
  const all = (getState().brains ?? []).filter((x) => x.kind === kind && x.auth === pays && x.workspaceId === wsId);
  const free = all.filter((x) => !taken.has(x.id));
  if (pays === "key" && all[0]) {
    if (!free[0]) throw new BrainError(`${botName} has ${AGENTS[kind].name} on your key already.`, 400);
    return free[0].id;
  }
  if (!fresh && free[0]) return free[0].id;
  return addBrain({ kind, auth: pays as "plan" | "key", workspaceId: wsId, bots: [] }).id;
}

/** Change a bot's AI profile. Returns it as it runs now (`out.added`: an agent it added). Throws BrainError with words for the owner. */
export function setBotAi(botId: string, o: AiOp, out: { added?: string } = {}): BotAi {
  const b = bot(botId);
  if (!b) throw new BrainError("No such bot.", 404);
  if (getState().shared) throw new BrainError(`Only ${ownerName()} changes ${b.name}'s AI.`, 403);
  const wsId = workspaceOf(b);
  const before = aiOf(b, getState());
  // The stored profile (with CLI agents a build without brains keeps but doesn't show), or the one its brains say.
  const base = cleanAi(b.ai, getState().brains ?? [], wsId) ?? before;
  const agents: BotAgent[] = base.agents.map((x) => ({ ...x }));
  let def = base.default;
  const find = (id: string) => {
    const x = agents.find((y) => y.id === id);
    if (!x) throw new BrainError(`${b.name} doesn't have that agent.`, 404);
    return x;
  };
  const cliOk = (kind: AgentKind, pays?: AgentPays) => {
    if (kind === "bops") return;
    if (!BRAINS_ON) throw new BrainError("This version of Bops runs Bops agent only.", 404);
    if (AGENTS[kind].soon || !agentOn(kind)) throw new BrainError(soonWords(kind), 400);
    if (pays && !paysOk(kind, pays)) throw new BrainError(PAYS_SOON[kind]?.[pays] ? soonWords(kind, pays) : `${AGENTS[kind].name} doesn't run that way.`, 400);
  };
  const modelCheck = (kind: AgentKind, model: string | undefined | null) => {
    if (model && !(kind === "bops" && model === "auto") && !modelOk(kind, model)) throw new BrainError(`${AGENTS[kind].name} can't use that model.`, 400);
  };
  // The accounts the bot's other agents of a kind use: one account is one agent of the bot's.
  const takenBy = (kind: AgentKind, but?: BotAgent) => new Set(agents.filter((y) => y !== but && y.kind === kind).map((y) => y.account));
  switch (o.op) {
    case "add": {
      if (o.kind === "bops") throw new BrainError("Bops agent is always there.", 400);
      cliOk(o.kind, o.pays);
      modelCheck(o.kind, o.model);
      if (agents.length >= MAX_AGENTS) throw new BrainError(`A bot runs at most ${MAX_AGENTS} agents.`, 400);
      const account = o.kind === "claude" || o.kind === "codex" ? accountFor(o.kind, o.pays, wsId, !!o.newAccount, takenBy(o.kind), b.name) : undefined;
      if (o.kind !== "opencode" && agents.some((x) => x.kind === o.kind && x.pays === o.pays && x.account === account))
        throw new BrainError(`${b.name} has ${AGENTS[o.kind].name} on that account already.`, 400);
      out.added = newAgentId();
      agents.push({ id: out.added, kind: o.kind, pays: o.pays, ...(account ? { account } : {}), ...(o.model ? { model: o.model } : {}) });
      break;
    }
    case "update": {
      const x = find(o.agentId);
      if (o.pays !== undefined && o.pays !== x.pays) {
        cliOk(x.kind, o.pays);
        if (x.kind === "bops") throw new BrainError("Bops agent runs on Bops credit.", 400);
        // Another way to pay: its model and account start over (the old account's model may not be the new one's).
        x.pays = o.pays;
        delete x.model;
        delete x.account;
        if (x.kind === "claude" || x.kind === "codex") x.account = accountFor(x.kind, o.pays, wsId, false, takenBy(x.kind, x), b.name);
      }
      // Move to another account: a new one of its kind (a second Claude plan signs in on its own).
      if (o.newAccount && (x.kind === "claude" || x.kind === "codex")) {
        const fresh = accountFor(x.kind, x.pays, wsId, true, takenBy(x.kind, x), b.name);
        if (agents.some((y) => y !== x && y.kind === x.kind && y.account === fresh)) throw new BrainError(`${b.name} has that account already.`, 400);
        x.account = fresh;
      } else if (o.account !== undefined && o.account !== x.account) {
        const acct = (getState().brains ?? []).find((y) => y.id === o.account && y.kind === x.kind && y.auth === x.pays && y.workspaceId === wsId);
        if (!acct) throw new BrainError("That account isn't one this agent can use.", 400);
        // One account is one agent of the bot's: taking its other agent's would leave one of them gone.
        if (takenBy(x.kind, x).has(acct.id)) throw new BrainError(`${b.name}'s other ${AGENTS[x.kind].name} uses that account. Pick another, or remove that one first.`, 400);
        x.account = acct.id;
      }
      if (o.model !== undefined) {
        modelCheck(x.kind, o.model);
        if (!o.model || (x.kind === "bops" && o.model === "auto")) delete x.model;
        else x.model = o.model;
      }
      break;
    }
    case "remove": {
      const x = find(o.agentId);
      if (x.kind === "bops") throw new BrainError("Bops agent is always there: it is chat's agent and every thread's fallback.", 400);
      agents.splice(agents.indexOf(x), 1);
      if (def === x.id) def = "bops";
      break;
    }
    case "default": {
      const x = find(o.agentId);
      cliOk(x.kind);
      def = x.id;
      break;
    }
    default:
      throw new BrainError("What should change?", 400);
  }
  const next = cleanAi({ agents, default: def }, getState().brains ?? [], wsId);
  update((s) => {
    const c = s.bots.find((y) => y.id === botId);
    if (!c) return;
    if (next) c.ai = next;
    else delete c.ai;
    // For older Bops: its brain is the Default's account, and each brain's bots those with an agent on it.
    const d = next?.agents.find((x) => x.id === next.default);
    if (d && isCli(d.kind) && d.account) c.brain = d.account;
    else delete c.brain;
    for (const x of s.brains ?? []) {
      const on = !!next?.agents.some((a) => a.account === x.id);
      x.bots = on ? [...new Set([...x.bots, botId])] : x.bots.filter((y) => y !== botId);
    }
  });
  aiChanged(botId, base, next);
  return aiOf(bot(botId)!, getState());
}

/**
 * A bot's profile changed (setBotAi, or Settings' accounts: brains.ts): what ran on an agent that went, or that's on
 * another account or way to pay now, stops at once (`stop`: brains.ts stops its own, brainLeft), and the bot's
 * folders on its computer follow it (letGo). `after` undefined: back to no profile, today's Bops agent.
 */
export function aiChanged(botId: string, before: BotAi, after: BotAi | undefined, stop = true) {
  const changed = before.agents.filter((x) => {
    const y = after?.agents.find((z) => z.id === x.id);
    return isCli(x.kind) && (!y || y.account !== x.account || y.pays !== x.pays);
  });
  if (changed.length || (!after && before.agents.some((x) => isCli(x.kind)))) void letGo(botId, changed.map((x) => x.id), !after, stop);
}

/**
 * Behind aiChanged: the threads on what changed stop, a terminal open on the bot's shell or on a thread of one of
 * them closes (a thread open in a terminal isn't running, so it isn't among those that stop), then on its computer
 * those agents' folders and gates go (or the whole bot's, back to the default), and every other agent of the bot
 * gets its wrappers again from its profile now (bops-brain rebin), so a Claude plan it doesn't run anymore leaves
 * its Bops agent's commands and its other threads at once. Best effort: a computer that's asleep or gone has
 * nothing more running on them, and its next start writes fresh settings.
 */
async function letGo(botId: string, agentIds: string[], all: boolean, stop: boolean) {
  try {
    const S = await import("./sessions");
    const left = stop ? S.agentsChanged((at) => at.botId === botId) : [];
    const b = bot(botId);
    const t = getState().takeover;
    const open = t?.sessionId ? session(t.sessionId) : undefined;
    const onIt = !!open && open.botId === botId && (all || agentIds.includes(open.brainRun?.agentId ?? open.agent?.id ?? "") || (!!b && !!threadAgent(open, b, getState()).gone));
    if (t?.terminal && t.botId === botId && (t.terminal.shell || onIt || left.some((l) => l.sessionId === t.sessionId))) S.returnControl();
    const computerId = b ? workComputer(b).computerId : undefined;
    if (computerId) await clearOnComputer(computerId, botId, all ? [] : agentIds, left.map((l) => l.sessionId), all || !b ? undefined : alsoSpec(b));
  } catch (e) {
    console.warn(`[bot-ai] ${botId}: ${(e as Error).message}`);
  }
}

/**
 * A bot's agents' folders and gates on a computer go (vm/bin/bops-brain bot-clear), after the threads on them stop.
 * None named: the whole bot's. `also`: its CLI agents now, for every other agent's wrappers there (bops-brain rebin).
 */
export async function clearOnComputer(computerId: string, botId: string, agentIds: string[], stopThreads: string[] = [], also?: string) {
  const ok = (v: string) => /^[A-Za-z0-9_-]+$/.test(v);
  if (!ok(botId)) return;
  await ensureBrainTools(computerId);
  const stops = stopThreads.filter(ok).map((t) => `bops-agent stop ${t}`);
  const clears = agentIds.length ? agentIds.filter(ok).map((a) => `bops-brain bot-clear ${botId} ${a}`) : [`bops-brain bot-clear ${botId}`];
  const rebin = also !== undefined && agentIds.length && /^[A-Za-z0-9._:/,-]*$/.test(also) ? [`bops-brain rebin ${botId}${also ? ` --also ${also}` : ""}`] : [];
  await orgo.bash(computerId, [...stops, ...clears, ...rebin].join("; "), 60);
}

/**
 * A bot leaves a computer it worked on (deleted, or moved to a computer of its own): its folder there goes, with
 * its agents' wrappers, gates and OpenCode's sessions (its threads' words), in the background. Nothing for a bot
 * that never ran a CLI agent: nothing of it is there.
 */
export function leaveComputer(b: Bot, computerId: string | undefined) {
  if (!BRAINS_ON || !computerId || !(hasProfile(b, getState()) && aiOf(b, getState()).agents.some((x) => isCli(x.kind)))) return;
  void clearOnComputer(computerId, b.id, []).catch((e: Error) => console.warn(`[bot-ai] ${b.name} leaving its computer: ${e.message}`));
}

