import "server-only";
import { botChatId, live, sharesComputer, workspaceOf, type Bot } from "@/lib/types";
import { bot, getState, update } from "./store";
import { ensureInbox } from "./mail";
import { noMainComputer, noOwnComputer } from "./plan";

/**
 * Where people can reach this bot, for its own prompts (chat and calls), so "what's your email?" or
 * "what's your number?" gets the real answer, never a made-up one.
 */
export function contactLine(b: Bot, spoken = false) {
  const say = (email: string) => (spoken ? `${email} (say it as "${email.replace("@", " at ").replace(/\./g, " dot ").replace(/-/g, " dash ")}")` : email);
  // The workspace's number belongs to its main bot; the others are reached through it.
  const ws = workspaceOf(b);
  const line = getState().workspaces?.find((w) => w.id === ws)?.line;
  const main = getState().bots.find((x) => x.isMain && workspaceOf(x) === ws);
  const kind = line?.type === "imessage" ? "iMessage" : "texts";
  const phone = line
    ? b.isMain
      ? `The team's phone number is yours: ${line.phone} (${kind}). People text you there; you reply there, and hand specialist work to teammates.`
      : `You don't have your own phone number: people text ${main?.name ?? "the main bot"} at the team's number, ${line.phone}, who passes work to you.`
    : b.phone
      ? `Your own phone number is ${b.phone}; people can text or call you on it.`
      : "You don't have a phone number yet: it's coming soon. Don't make one up.";
  return [b.email ? `Your own email address is ${say(b.email)}; anyone can email you there, and you can give it out.` : "You don't have an email address yet.", phone].join(" ");
}

const COLORS = ["#FF9F43", "#2EC4B6", "#A78BFA", "#F87171", "#60A5FA", "#34D399", "#E9FF3B", "#FF6FB5"];

/** A bot id from a name, unique across all workspaces ("sam", then "sam-2"…). */
export function freeBotId(name: string) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
  let botId = base;
  for (let n = 2; bot(botId); n++) botId = `${base}-${n}`;
  return botId;
}

/**
 * Rename a bot. Its email address follows the new name (mail to the old one keeps arriving), and so
 * do its phone agents' names and the name on its computer's desktop.
 */
export function renameBot(botId: string, name: string): { ok: true } | { error: string } {
  const b = bot(botId);
  const clean = name.trim().slice(0, 40);
  if (!b) return { error: "no such bot" };
  if (!clean) return { error: "name required" };
  if (clean === b.name) return { ok: true };
  if (getState().bots.some((x) => x.id !== botId && workspaceOf(x) === workspaceOf(b) && x.name.toLowerCase() === clean.toLowerCase())) return { error: "a bot with that name exists" };
  update(() => (b.name = clean));
  void ensureInbox(botId).catch((e: Error) => console.warn(`[rename] ${botId} email: ${e.message}`));
  void import("./phone").then(({ renameAgents }) => renameAgents(botId)).catch((e: Error) => console.warn(`[rename] ${botId} phone: ${e.message}`));
  void import("./channels").then(({ renameInChannels }) => renameInChannels(botId)).catch((e: Error) => console.warn(`[rename] ${botId} channels: ${e.message}`));
  // Just the name on the desktop: Chrome keeps running.
  if (b.computerId) void import("./desktop").then(({ applyDesktop }) => applyDesktop(b, { restartChrome: false })).catch((e: Error) => console.warn(`[rename] ${botId} desktop: ${e.message}`));
  return { ok: true };
}

/**
 * Add a bot to a workspace, with its own chat. By default it works on the main bot's computer (on
 * screens of its own there); with `ownComputer` it gets its own, forked from the main bot's on its
 * first task, if the user's Orgo plan has room for one. If it hasn't, the bot works on the main bot's,
 * and `note` says why. Names are unique within a workspace; ids across all of them.
 */
export async function createBot(name: string, role?: string, workspaceId?: string, ownComputer = false): Promise<{ botId: string; chatId: string; note?: string } | { error: string }> {
  const clean = name.trim();
  if (!clean) return { error: "name required" };
  const ws = workspaceId ?? getState().workspace;
  const team = workspaceOf({ workspaceId: ws });
  const noRoom = ownComputer ? await noOwnComputer(team) : null;
  if (getState().bots.some((b) => workspaceOf(b) === team && b.name.toLowerCase() === clean.toLowerCase())) return { error: "a bot with that name exists" };
  const botId = freeBotId(clean);
  update((s) => {
    const b: Bot = {
      id: botId,
      name: clean,
      role: role?.trim() || "Generalist",
      color: COLORS[(s.bots.length - 1) % COLORS.length],
      isMain: false,
      computerStatus: "none",
      computer: ownComputer && !noRoom ? "own" : "shared",
      workspaceId: ws,
    };
    s.bots.push(b);
    s.chats.push({ id: botChatId(botId), kind: "bot", botIds: [botId], createdAt: Date.now(), typing: [], workspaceId: ws });
  });
  // Its own email address, made in the background (mail.ts; nothing happens when mail is off).
  void ensureInbox(botId).catch((e: Error) => console.warn(`[mail] inbox for ${botId}: ${e.message}`));
  if (!noRoom) return { botId, chatId: botChatId(botId) };
  const main = getState().bots.find((b) => b.isMain && workspaceOf(b) === team);
  return { botId, chatId: botChatId(botId), note: `${clean} works on ${main?.name ?? "the main bot"}'s computer. ${noRoom}` };
}

/**
 * Switch a bot between working on the main bot's computer ("shared") and its own ("own"). Only while
 * it has no cloud work going (threads, watched screens, the user driving one of its screens), since
 * those hold screens on the computer it's leaving. Going to shared deletes its own computer (Bops
 * workspace only), so nothing is left running unused; going to own forks one on its next task, and
 * only when the user's Orgo plan has room for it (the refusal says why, with the numbers). A main bot
 * that works on the free Bops computer (lib/server/plan.ts shareFree) can go to one of its own on the
 * plan the same way, and its team with it; a main bot never goes back.
 */
export async function setComputer(botId: string, mode: "shared" | "own"): Promise<{ ok: true } | { error: string }> {
  const b = bot(botId);
  if (!b) return { error: "no such bot" };
  if (b.isMain && !(sharesComputer(b) && mode === "own")) return { error: `${b.name} runs the team, so the computer is its own` };
  if (sharesComputer(b) === (mode === "shared")) {
    update(() => (b.computer = mode));
    return { ok: true };
  }
  // A computer being made would land after the switch; let it finish first.
  if (b.computerStatus === "cloning") return { error: `${b.name}'s computer is being set up. Try again in a minute.` };
  const st = getState();
  // A main bot takes the bots that share its computer along: none of them may be at work on the one it leaves.
  const moving = b.isMain ? st.bots.filter((x) => workspaceOf(x) === workspaceOf(b) && (x.id === botId || sharesComputer(x))) : [b];
  const busy = (id: string) => moving.find((x) => x.id === id)?.name;
  const working = st.sessions.find((s) => busy(s.botId) && live(s) && s.runsOn !== "mac");
  if (working) return { error: `${busy(working.botId)} is working in the cloud right now. Pause it first.` };
  const watching = st.watches?.find((w) => busy(w.botId) && !w.mac);
  if (watching) return { error: `${busy(watching.botId)} is watching a screen. Stop watching it first.` };
  if (st.takeover && busy(st.takeover.botId)) return { error: `You're driving one of ${busy(st.takeover.botId)}'s screens. Hand it back first.` };
  const noRoom = mode !== "own" ? null : b.isMain ? await noMainComputer(b) : await noOwnComputer(workspaceOf(b));
  if (noRoom) return { error: noRoom };
  if (mode === "shared" && b.computerId) {
    const { resetComputer } = await import("./sessions");
    try {
      await resetComputer(botId);
    } catch (e) {
      return { error: `couldn't delete its own computer: ${(e as Error).message}` };
    }
  }
  // Leaving the main bot's computer: its secret there goes with it (see dropGuestKey), and its team's too for a main bot.
  if (mode === "own") for (const x of moving) await (await import("./sessions")).dropGuestKey(x.id);
  update((state) => {
    // A main bot's own is the default for a main bot.
    b.computer = b.isMain ? undefined : mode;
    b.computerStatus = "none";
    b.tailnet = undefined;
    // What its screens showed was on the computer it left.
    for (const key of Object.keys(state.screens ?? {})) if (key.startsWith(`${botId}:`)) delete state.screens![key];
  });
  return { ok: true };
}
