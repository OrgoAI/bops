import type { AppState } from "./types";

/** What's worth a chime (and a notification when Bops is behind), with the key it's chimed for once. */
export type Ping = { key: string; title: string; body: string };

/**
 * What in the user's own state is worth interrupting them for (components/app/bops-app.tsx chimes for
 * each new one): news judged "now", finished tasks they're waiting on (Message.ping), and something a bot
 * waits on their OK for (AppApproval: its run waits there, wherever it runs). While a workspace shared with
 * them is open the window's state is that one's, so /api/state sends theirs along (AppState.ownPings:
 * lib/server/shared-core.ts viewState), with the same keys, so nothing chimes twice.
 */
export function duePings(state: Pick<AppState, "watches" | "messages" | "bots" | "appApprovals">): Ping[] {
  return [
    ...(state.watches ?? []).filter((w) => w.alert?.level === "now").map((w) => ({ key: `w:${w.id}:${w.alert!.at}`, title: w.mac?.title ?? w.site, body: w.alert!.text })),
    ...state.messages.filter((m) => m.ping).map((m) => ({ key: `m:${m.id}`, title: state.bots.find((b) => b.id === m.botId)?.name ?? "Bops", body: m.text.replace(/\*\*|\[|\]\([^)]*\)/g, "").slice(0, 140) })),
    ...(state.appApprovals ?? [])
      .filter((a) => !a.reply)
      .map((a) => ({ key: `a:${a.id}`, title: state.bots.find((b) => b.id === a.botId)?.name ?? "Bops", body: `Waiting for your OK: ${a.action}`.slice(0, 140) })),
  ];
}
