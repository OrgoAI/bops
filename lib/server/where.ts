import "server-only";
import { chose, decide } from "./decide";
import { fullAccessOn } from "./full-access";
import { bot, getState, ownerName } from "./store";

export type Where = "mac" | "cloud" | "ask";

/** Where a new task runs, from its words (chooseWhere). Moving work already under way takes more: asksForMac. */
const MAC_WORDS = /\b(on|from|using|use|with) my (mac|macbook|laptop|computer)\b|\blocally\b|\bon this mac\b/i;
const CLOUD_WORDS = /\b(in the cloud|on your (own )?computer|on your (cloud )?machine)\b/i;

/** The user's Mac by name: "on my Mac", "use my MacBook Pro", "to this laptop", "on the Mac" (not the Mac App Store). */
const MAC_ASK = /\b(?:(?:on|from|using|use|with|to|onto) (?:my|this) (?:mac(?:book)?(?: (?:air|pro))?|imac|mac (?:mini|studio)|laptop)|(?:on|to|onto) the mac)\b(?![-\s]*app\b)/gi;
/** A no in front of it, in the same part of the sentence: "don't do this on my Mac", "not on my laptop". */
const NOT = /\b(?:don['’]?t|do not|doesn['’]?t|does not|didn['’]?t|did not|not|never|no|without|instead of|rather than|avoid|stop|can['’]?t|cannot|won['’]?t|shouldn['’]?t)\b/i;

/** "Anywhere but on my Mac", "except on my laptop": a no just before it that the split at "but" would lose. */
const BUT_NOT = /\b(?:(?:anywhere|anything|everywhere|everything|nowhere|all|nothing)\s+but|except|other than|apart from|besides)\s*$/i;
/** "On my Mac? No way": a no straight after it, as an answer. */
const NO_AFTER = /^\s*[?!]\s*(?:no|nope|never|no way|not)\b/i;

/**
 * The user's own words ask for their Mac ("do it on my Mac", "move it to my MacBook", "on this Mac"):
 * with the bot's say (tell_task on_mac, a task for the Mac) what moves a thread already under way there
 * (moving stops it and starts it again on the Mac); on its own, what offers the move. Stricter than where
 * a new task runs: a bare "locally" ("find a plumber locally") and "computer" (in Bops that's also the
 * bot's own, in the cloud) don't count, nor does a no in front ("don't do this on my Mac", "anywhere but
 * on my Mac") or straight after ("on my Mac? no way").
 */
export function asksForMac(text: string) {
  for (const m of text.matchAll(MAC_ASK)) {
    const before = text.slice(0, m.index);
    if (BUT_NOT.test(before) || NO_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    // The few words before it, back to the start of its part of the sentence.
    const part = before.split(/[.!?;:,\n]|\b(?:but|and|so|then)\b/i).at(-1) ?? "";
    if (!NOT.test(part.trim().split(/\s+/).slice(-6).join(" "))) return true;
  }
  return false;
}

/**
 * The user's words could be about their Mac (asksForMac, or the looser words a new task goes by: "do it
 * locally", "with my computer", without a no anywhere in them): what offers to move a cloud thread there
 * ("Move to your Mac?"), never what moves it.
 */
export const mentionsMac = (text: string) => asksForMac(text) || (MAC_WORDS.test(text) && !NOT.test(text) && !BUT_ANYWHERE.test(text));
/** "Anywhere but", "except": a no anywhere in the words, for mentionsMac. */
const BUT_ANYWHERE = /\b(?:anywhere|anything|everywhere|everything|nowhere|all|nothing)\s+but\b|\b(?:except|other than|apart from|besides)\b/i;

/**
 * Where a task should run: the bot's cloud computer, the user's own Mac, or ask them. The cloud is
 * the default (isolated, parallel, keeps going with the laptop closed, never touches their screen);
 * the Mac is for what only it has: their home internet, in a Chrome of the bot's own there, and, with
 * Full access (MacState.fullAccess), their files and apps. Without it bots can't use the Mac's apps or
 * files (lib/server/executor-sandbox.ts); a task that needs them and lands there says so. In order: what the request says outright, the bot's own setting, the user's app
 * rules, then Jev; when Jev isn't sure, the user picks.
 *
 * `outside`: asked for on a turn someone else started (an email, a text or a call from outside Bops).
 * Nothing said on that turn puts work on the Mac (its words, "mac" asked for, Jev's read of them): it
 * runs in the cloud. When the user set the bot itself to work on their Mac, they pick ("ask"): a task
 * there may have their files, apps and a shell, and its goal was written from someone else's words.
 */
export async function chooseWhere(botId: string, goal: string, asked: "mac" | "cloud" | "auto" = "auto", opts: { outside?: boolean } = {}): Promise<Where> {
  const state = getState();
  const mac = state.mac;
  // Full access is kept on this Mac, not in the state (full-access.ts).
  const full = fullAccessOn();
  if (opts.outside) return asked === "cloud" || bot(botId)?.runsOn !== "mac" || !mac?.ready ? "cloud" : "ask";
  if (asked !== "auto") return asked;
  if (MAC_WORDS.test(goal)) return "mac";
  if (CLOUD_WORDS.test(goal)) return "cloud";
  const b = bot(botId);
  if (b?.runsOn === "mac" || b?.runsOn === "cloud") return b.runsOn;
  // Without a Mac Bops can use, there's only the cloud.
  if (!mac?.ready) return "cloud";
  const rule = mac.rules.find((r) => new RegExp(`\\b${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(goal));
  if (rule) return "mac";
  const owner = ownerName();
  const a = await decide(
    {
      task: goal,
      owners_mac: { words_that_mean_mac: mac.rules },
      saved_logins_for_the_cloud: (state.vault ?? []).map((l) => l.site),
    },
    {
      where: {
        type: "choice",
        instructions:
          `A bot is about to do \`task\` for ${owner}. It can work on its own cloud computer (a browser and apps in the cloud, isolated from ${owner}, can run long or in parallel, can sign in to sites in \`saved_logins_for_the_cloud\`), or on ${owner}'s own Mac (in a Chrome of its own there, on ${owner}'s home internet; ${full ? "with full access, it can also use the Mac's files and apps" : "it can't use the Mac's apps or files"}). Where should it run?`,
        criteria: {
          cloud: "The cloud: it's web work, research, anything a fresh browser can do, or long, parallel or scheduled work",
          mac: `${owner}'s Mac: it needs ${owner}'s own home internet connection, ${full ? `their files, ` : ""}or it's about an app only on their Mac (Messages, Notes, Mail, Photos, Finder, Keynote…)`,
          unsure: "Can't tell from the task; it could reasonably be either",
        },
      },
    },
    { botId },
  );
  const pick = chose(a?.where);
  if (!pick) return "cloud";
  if (pick.choice === "mac" && pick.confidence >= 0.65) return "mac";
  if (pick.choice === "cloud" && pick.confidence >= 0.6) return "cloud";
  return "ask";
}
