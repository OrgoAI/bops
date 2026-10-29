import "server-only";
import { chainSet, entryOf, mayAsk, mayHandOff, teamOfBot } from "@/lib/chain";
import { bot, getState, ownerName } from "./store";
import { appVersion } from "./app-version";

/*
 * The team chart (lib/chain.ts) as the Mac server reads it: what a turn, a thread or a teammate's answer may
 * reach, from the state as it is now. The rules themselves are in cloud/chain.ts.
 */

/** The team a bot is in, on the chart now. */
export const teamNow = (botId: string) => teamOfBot(getState(), botId);

/** Whether bot a may ask bot b now (and so knows of it). */
export const asksNow = (a: string, b: string) => mayAsk(getState(), a, b);

/** Whether bot a may hand work to bot b now. */
export const handsNow = (a: string, b: string) => mayHandOff(getState(), a, b);

/** Whether the bot's workspace has a chart that changes anything from before (the prompt lines say where it stands only then). */
export function chartedFor(botId: string): boolean {
  const t = teamNow(botId);
  return !!t && chainSet(t.chain);
}

/**
 * Why a hand off from bot `from` to bot `to` isn't done, in the words the bot reads: it takes work only from
 * the owner (takesWork false), or it isn't under `from` on the chart. Null when it may.
 */
export function handOffRefused(from: string, to: string): string | null {
  if (handsNow(from, to)) return null;
  const t = teamNow(from);
  const target = bot(to);
  if (!t || !target) return "Couldn't hand that off: no such teammate";
  if (entryOf(t, to).takesWork === false) return `Not handed off: ${target.name} takes work only from ${ownerName()}.`;
  return `Not handed off: ${target.name} isn't under ${bot(from)?.name ?? "this bot"} on the org chart.`;
}

/** "Max", "Max and Nova", "Max, Nova and Pip". */
export const namesList = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * The first Bops release whose turns follow the team chart. A Mac or a computer's runner on an older one runs
 * turns by the rules from before until it updates, which the chart says (olderBopsOnAccount).
 */
export const CHART_SINCE = "0.0.33";

/**
 * Whether a Mac or a runner on the account runs a Bops older than the team chart's (CHART_SINCE; this one's own
 * version when this one is older still, as a build in development is, so it never counts itself): a runner set up
 * or running one (state.runners), or an app Orgo saw lately (orgo.ts bopsAppVersions). False when it can't be told.
 */
export async function olderBopsOnAccount(): Promise<boolean> {
  // (Orgo's module only when asked: the chart's rules, read on every turn, don't need it.)
  const { bopsAppVersions, olderVersion } = await import("./orgo");
  const here = appVersion()?.replace(/^v/i, "");
  const floor = here && /^\d+\.\d+\.\d+$/.test(here) && olderVersion(here, CHART_SINCE) ? here : CHART_SINCE;
  const older = (v: string | undefined) => !!v && /^\d+\.\d+\.\d+$/.test(v) && olderVersion(v, floor);
  const runners = Object.values(getState().runners ?? {}).filter((r) => r.status === "running" || r.status === "installing");
  if (runners.some((r) => older(r.version?.replace(/^v/i, "")))) return true;
  return !!(await bopsAppVersions().catch(() => null))?.some(older);
}
