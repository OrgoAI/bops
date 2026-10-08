import "server-only";
import { decide, yes } from "./decide";
import { ownerName } from "./store";

/**
 * Quick calls Jev makes so Bops feels faster and asks less (see decide.ts): whether a message needs
 * the user's memory, and whether an action is low-stakes enough to just do.
 */

/**
 * Would knowing the user (their preferences, people, habits, past decisions) help with this message?
 * Small talk and plain commands don't, and skipping the memory search makes those turns faster.
 * If Jev can't answer, memory is used.
 */
export async function needsMemory(said: string) {
  if (!said.trim()) return false;
  const owner = ownerName();
  const a = await decide(
    { app: "Bops" },
    {
      memory: {
        type: "noul",
        instructions: `A message from ${owner} to their AI assistant: "${said.slice(0, 1500)}". To answer or do this well, would it help to know things about ${owner} from their long-term memory: their preferences, people in their life, their habits, past decisions, their work and history? Not needed for small talk, plain commands with everything spelled out, or general facts.`,
        criteria: { true: `Knowing more about ${owner} would help`, false: "Not needed" },
      },
    },
  );
  return (yes(a?.memory) ?? 1) >= 0.35;
}

/**
 * Is this action low-stakes enough to do without asking the user: it reaches no one else, can't do real
 * harm, and only touches their own things in a way that's easy to undo (marking read, a label, a note,
 * an event only they attend, opening an app to look)? Strict on purpose; when Jev can't answer, ask.
 */
export async function lowRisk(what: string, details: string) {
  const act = `${what}${details ? ` (${details.slice(0, 600)})` : ""}`;
  const owner = ownerName();
  const a = await decide(
    { app: `Bops: AI assistants act in ${owner}'s apps` },
    {
      reach: {
        type: "noul",
        instructions: `An AI assistant wants to do this for ${owner}: ${act}. Would it send, post, share, invite, or show something to anyone other than ${owner}?`,
        criteria: { true: "Reaches someone else", false: `Stays with ${owner}` },
      },
      harm: {
        type: "noul",
        instructions: `An AI assistant wants to do this for ${owner}: ${act}. Could it lose or delete data, cost money, change who can access something, change a shared record others rely on, or be hard to undo?`,
        criteria: { true: "Could do real harm or be hard to undo", false: "No" },
      },
      safe: {
        type: "noul",
        instructions: `An AI assistant wants to do this for ${owner}: ${act}. Is it low-stakes: it only affects ${owner}'s own things and is easy to undo (marking read, labeling, a draft or note for themselves, an event only they attend, opening an app to look at something)?`,
        criteria: { true: "Low-stakes and easy to undo", false: "Not clearly low-stakes" },
      },
    },
  );
  if (!a) return false;
  return (yes(a.reach) ?? 1) < 0.2 && (yes(a.harm) ?? 1) < 0.45 && (yes(a.safe) ?? 0) >= 0.8;
}

/** Whether an app action could move money: a bot on "Just do it" still asks before those. Strict: when Jev can't tell, it could. */
export async function movesMoney(what: string, details: string) {
  const act = `${what}${details ? ` (${details.slice(0, 600)})` : ""}`;
  const owner = ownerName();
  const a = await decide(
    { app: `Bops: AI assistants act in ${owner}'s apps` },
    {
      money: {
        type: "noul",
        instructions: `An AI assistant wants to do this for ${owner}: ${act}. Would it pay, charge, buy, subscribe, refund, transfer or pay out money, or commit ${owner} to a payment?`,
        criteria: { true: "Moves money or commits to a payment", false: "No money moves" },
      },
    },
  );
  return !a || (yes(a.money) ?? 1) >= 0.2;
}
