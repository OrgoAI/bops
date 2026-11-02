import "server-only";
import type { CloudPlanPayload, PlanInbox, PlanPhone } from "@/cloud/protocol";
import { botChatId, workspaceOf, type Bot } from "@/lib/types";
import { cloudSession, cloudSessionNow } from "./cloud";
import { adoptHandle } from "./mail";
import { tellCloudLine } from "./phone-lines";
import { addMessage, bot, getState, sameState, update } from "./store";

/**
 * What the user's plan brings the main bot, set up by Bops Cloud (cloud/plans.ts, cloud/provision.ts)
 * whether or not this Mac was open: a "plan" event from the tunnel (app/api/cloud/event) says the
 * number and inbox as they stand now, and this takes them into the app's state as if the app had made
 * them (Bot.phone and Bot.phoneLine, Bot.email and Bot.mail), with a line in the bot's chat:
 *
 * - ready (or still being set up): the bot has them. The number's 15 minutes for its first caller
 *   open here, when the user is shown it (the cloud never opens them itself: the Mac may have been
 *   closed, and a stranger texting a new number would become its owner), as for a number the app
 *   buys. The inbox is on the workspace's handle; when Bops picked that handle, the app offers to
 *   change it ("Your Bops address").
 * - paused (the plan ended): they stay on the bot, marked paused. The cloud doesn't answer calls and
 *   texts to the number, and the app doesn't read the inbox, until the user upgrades again.
 * - released (30 days after the pause): they're gone from the bot.
 *
 * Billed by use, an event about a number's month (PlanPhone.renewal, cloud/numbers-renew.ts) says a
 * number paused because the Orgo credit couldn't pay its month, back on once it did, or given back 30
 * days after the pause (takeRenewal).
 *
 * Safe to get twice: what's already in the state isn't said again.
 */

const pretty = (e164: string) => {
  const d = e164.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e164;
};

function say(b: Bot, text: string) {
  addMessage({ chatId: botChatId(b.id), role: "system", text });
}

/** Said unless it's the last thing the bot's chat says already (an event handed over twice, for a number not on the bot). */
function sayOnce(b: Bot, text: string) {
  const chatId = botChatId(b.id);
  const messages = getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].chatId !== chatId) continue;
    if (messages[i].role === "system" && messages[i].text === text) return;
    break;
  }
  say(b, text);
}

/** The day a number paused for its month is given back, as the chat says it ("Dec 20"), in this Mac's time zone. */
function dayOf(iso: string | undefined) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
}

/**
 * A number's month, billed by use (PlanPhone.renewal): paused because the Orgo credit couldn't pay it
 * (calls and texts to it go unanswered, and none go out from it, until it's paid), back on once it is,
 * or given back 30 days after the pause. Said in the chat of the bot that has the number (a workspace's
 * number: its main bot's), and that bot's own number marked paused (`unpaid`) meanwhile, as a plan's is.
 */
function takeRenewal(p: PlanPhone, botId: string | null) {
  const s = getState();
  const own = s.bots.find((x) => x.phoneLine?.numberId === p.numberId);
  const ws = own ? undefined : s.workspaces?.find((w) => w.line?.numberId === p.numberId);
  const b = own ?? (ws && s.bots.find((x) => x.isMain && workspaceOf(x) === ws.id)) ?? (botId ? bot(botId) : undefined);
  if (!b) return;
  const day = dayOf(p.renewal?.releaseAt);
  const text =
    p.status === "paused"
      ? `${b.name}'s number ${pretty(p.number)} is paused because your Orgo credit ran out: calls and texts to it go unanswered. Add credit to keep it. It's given back ${day ? `on ${day}` : "30 days after the pause"} if still unpaid.`
      : p.status === "released"
        ? `${b.name}'s number ${pretty(p.number)} was given back, 30 days after your Orgo credit ran out.`
        : `${b.name}'s number ${pretty(p.number)} is back on.`;
  if (!own?.phoneLine) return sayOnce(b, text);
  const had = own.phoneLine;
  const paused = p.status === "paused";
  if (p.status !== "released" && (paused ? had.paused && had.unpaid : !had.unpaid)) return;
  update((st) => {
    const x = st.bots.find((y) => y.id === own.id);
    if (x?.phoneLine?.numberId !== p.numberId) return;
    if (p.status === "released") {
      x.phoneLine = undefined;
      x.phone = undefined;
      return;
    }
    x.phoneLine = { numberId: x.phoneLine.numberId, agentId: x.phoneLine.agentId, ...(x.phoneLine.plan ? { plan: true } : {}), ...(paused ? { paused: true, unpaid: true } : {}) };
  });
  say(own, text);
}

async function takePhone(b: Bot, p: PlanPhone) {
  const had = b.phoneLine?.numberId === p.numberId ? b.phoneLine : undefined;
  if (p.status === "released") {
    if (!had) return;
    update((s) => {
      const x = s.bots.find((y) => y.id === b.id);
      if (x?.phoneLine?.numberId !== p.numberId) return;
      x.phoneLine = undefined;
      x.phone = undefined;
    });
    return say(b, `${b.name}'s number ${pretty(p.number)} was given back, 30 days after the plan ended. Upgrade to get a number again.`);
  }
  // A main bot with a number of its own keeps it: the plan's would have been made only when it had none.
  if (b.phoneLine && !had) return;
  const paused = p.status === "paused";
  if (had && !!had.paused === paused && b.phone === p.number) return;
  update((s) => {
    const x = s.bots.find((y) => y.id === b.id);
    if (!x) return;
    x.phone = p.number;
    x.phoneLine = { numberId: p.numberId, agentId: p.agentId, plan: true, ...(paused ? { paused: true } : {}) };
  });
  if (paused) say(b, `${b.name}'s number ${pretty(p.number)} is paused while you're on Free: calls and texts to it go unanswered. Upgrade within 30 days to keep it.`);
  else if (had?.paused) say(b, `${b.name}'s number ${pretty(p.number)} is back on.`);
  else {
    const ours = sameState();
    // The user is told now, so its 15 minutes for the first caller start now (a line with an owner keeps it).
    const line = await tellCloudLine({ numberId: p.numberId, botId: b.id, open: true }).catch((e: Error) => {
      console.warn(`[plan] couldn't open ${b.name}'s number for its first caller: ${e.message}`);
      return null;
    });
    // Signed out, or another account in, meanwhile: their number isn't said in someone else's chat.
    if (!ours()) return;
    const then = line?.owner
      ? "Calls and texts from your linked phone count as you."
      : line?.claimUntil
        ? "Call or text it from your phone in the next 15 minutes, and calls and texts from your phone count as you."
        : "Link your phone to it on its Details card, and calls and texts from your phone count as you.";
    say(b, `${b.name} has a phone number now, with your plan: ${pretty(p.number)}. ${then}`);
  }
}

function takeInbox(b: Bot, e: PlanInbox, workspaceId: string) {
  const had = b.mail?.inboxId === e.inboxId ? b.mail : undefined;
  if (e.status === "released") {
    if (!had) return;
    update((s) => {
      const x = s.bots.find((y) => y.id === b.id);
      if (x?.mail?.inboxId !== e.inboxId) return;
      x.mail = x.mail.past?.length ? { ...x.mail, inboxId: x.mail.past[x.mail.past.length - 1], past: x.mail.past.slice(0, -1), plan: undefined, paused: undefined } : undefined;
      x.email = x.mail?.inboxId;
    });
    return say(b, `${b.name}'s email ${e.email} was given back, 30 days after the plan ended.`);
  }
  if (b.mail && !had && e.status === "paused") return;
  const paused = e.status === "paused";
  if (had && !!had.paused === paused && b.email === e.email) return;
  update((s) => {
    const x = s.bots.find((y) => y.id === b.id);
    if (!x) return;
    const past = [...(x.mail?.past ?? []), ...(x.mail && x.mail.inboxId !== e.inboxId ? [x.mail.inboxId] : [])].filter((p) => p !== e.inboxId);
    x.mail = { inboxId: e.inboxId, podId: e.podId, past: past.length ? past : undefined, seenAt: x.mail?.seenAt ?? Date.now(), plan: true, ...(paused ? { paused: true } : {}) };
    x.email = e.email;
  });
  if (e.handle && !paused) adoptHandle(workspaceId, e.handle);
  if (paused) say(b, `${b.name}'s email ${e.email} is paused while you're on Free: new mail isn't read until you upgrade again.`);
  else if (had?.paused) say(b, `${b.name}'s email ${e.email} is back on.`);
  else say(b, `${b.name} has an email address now, with your plan: ${e.email}.`);
}

/**
 * Take a "plan" event into the state. A bot this Mac doesn't have (deleted since) is skipped. A plan or a
 * way of paying that isn't the session's (a move to billing by use, an upgrade) has the session asked
 * for again, so the limits and the words that go by it (CloudSession.plan) follow at once.
 */
export async function adoptPlan(p: CloudPlanPayload) {
  const session = cloudSessionNow();
  const was = session?.plan;
  if (session && (!was || was.tier !== p.tier || (was.billing ?? "plan") !== (p.billing ?? "plan"))) void cloudSession(true).catch(() => {});
  if (p.phone?.renewal) return takeRenewal(p.phone, p.botId);
  const b = p.botId ? bot(p.botId) : undefined;
  if (p.handle) adoptHandle(p.workspaceId, p.handle.handle, { offer: p.handle.auto && !!p.email && p.email.status !== "paused" && !b?.mail?.plan });
  if (!b) return;
  const ours = sameState();
  if (p.phone?.numberId) await takePhone(b, p.phone);
  // Another account's state came in while the number was set up: the inbox isn't theirs to take.
  if (p.email?.inboxId && ours()) takeInbox(bot(b.id) ?? b, p.email, p.workspaceId);
}
