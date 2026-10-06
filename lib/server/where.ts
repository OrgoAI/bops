import "server-only";
import { chose, decide } from "./decide";
import { bot, getState, ownerName } from "./store";

export type Where = "mac" | "cloud" | "ask";

export const MAC_WORDS = /\b(on|from|using|use|with) my (mac|macbook|laptop|computer)\b|\blocally\b|\bon this mac\b/i;
const CLOUD_WORDS = /\b(in the cloud|on your (own )?computer|on your (cloud )?machine)\b/i;

/**
 * Where a task should run: the bot's cloud computer, the user's own Mac, or ask them. The cloud is
 * the default (isolated, parallel, keeps going with the laptop closed, never touches their screen);
 * the Mac is for things only it has: its apps (Messages, Notes, Finder…), their files, sign-ins only
 * their Mac has, their network. In order: what the request says outright, the bot's own setting, the
 * user's app rules, then Jev; when Jev isn't sure, the user picks.
 */
export async function chooseWhere(botId: string, goal: string, asked: "mac" | "cloud" | "auto" = "auto"): Promise<Where> {
  const state = getState();
  const mac = state.mac;
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
      owners_mac: { apps_bots_may_always_use: mac.alwaysApps, words_that_mean_mac: mac.rules },
      saved_logins_for_the_cloud: (state.vault ?? []).map((l) => l.site),
    },
    {
      where: {
        type: "choice",
        instructions:
          `A bot is about to do \`task\` for ${owner}. It can work on its own cloud computer (a browser and apps in the cloud, isolated from ${owner}, can run long or in parallel, can sign in to sites in \`saved_logins_for_the_cloud\`), or on ${owner}'s own Mac (their apps, files and signed-in sessions). Where should it run?`,
        criteria: {
          cloud: "The cloud: it's web work, research, anything a fresh browser can do, or long, parallel or scheduled work",
          mac: `${owner}'s Mac: it needs an app only on their Mac (Messages, Notes, Mail, Photos, Finder, Keynote…), their own files, or a sign-in only their Mac has`,
          unsure: "Can't tell from the task; it could reasonably be either",
        },
      },
    },
  );
  const pick = chose(a?.where);
  if (!pick) return "cloud";
  if (pick.choice === "mac" && pick.confidence >= 0.65) return "mac";
  if (pick.choice === "cloud" && pick.confidence >= 0.6) return "cloud";
  return "ask";
}
