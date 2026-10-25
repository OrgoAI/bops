import type { AppState, Session } from "@/lib/types";
import type { PanelTab } from "./panel-tabs";

/** The bot profile tab: always the chat's bot. */
export const PROFILE_TAB = "tab_profile";

/**
 * Whether a thread's work brings up the Your Mac tab (its work leading the chat, or the thread opened): one
 * on this Mac, in the user's own workspace. In a workspace shared with them it's the owner's work on the
 * owner's Mac, never the viewer's own Mac: the bot's tab says where it works.
 */
export const opensMacTab = (state: Pick<AppState, "shared">, s: Pick<Session, "runsOn">) => s.runsOn === "mac" && !state.shared;

/**
 * The tabs open now that the window shows, of the ones the user opened (`open`): a deleted bot's go with it,
 * the profile tab is always the chat's bot (`chatBotId`), a CRM file shows in its own workspace only and only
 * to an account the CRM is open to (`crm`: lib/crm-access.ts), the same for the memory page (`memory`:
 * lib/memory-categories.ts) and for apps (`apps`: lib/apps-access.ts), and Routines its own workspace's. In a
 * workspace shared with the user (state.shared) a New tab doesn't stay: it lists the user's own things to
 * open as theirs, none of which is the owner's. Nor does Your Mac: it's the viewer's own Mac, which none of
 * the owner's bots ever works on (their work on the owner's Mac isn't shown there).
 */
export function tabsShown(open: PanelTab[], state: AppState, o: { chatBotId: string; ws: string; crm: boolean; memory: boolean; apps: boolean }): PanelTab[] {
  return (
    open
      .map((t) => (t.id === PROFILE_TAB && t.kind === "bot" ? { ...t, botId: o.chatBotId } : t))
      .filter((t) => !("botId" in t) || state.bots.some((b) => b.id === t.botId))
      .filter((t) => (t.kind !== "new" && t.kind !== "mac") || !state.shared)
      .filter((t) => t.kind !== "crm" || (o.crm && t.ws === o.ws))
      // Skills are this Mac's folders and need no account, so a Knowledge tab on Skills stays without one.
      // Knowledge has no Apps any more (Apps are the apps bots make, in the footer): a tab saved on it closes.
      .filter((t) => t.kind !== "memory" || (t.ws === o.ws && (t.category as string) !== "apps" && (o.memory || t.category === "skills")))
      // Routines shows its own workspace's bots only: another workspace's tab goes on a switch.
      .filter((t) => t.kind !== "autopilot" || t.ws === o.ws)
      // The Apps home is a workspace's, and an app's tab goes with the app.
      .filter((t) => t.kind !== "made-apps" || (o.apps && t.ws === o.ws))
      .filter((t) => t.kind !== "hosted-app" || (o.apps && t.ws === o.ws))
      .filter((t) => t.kind !== "made-app" || (o.apps && !!state.madeApps?.some((a) => a.id === t.appId)))
  );
}
