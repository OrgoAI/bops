import { DISPLAYS, live, workBot, workspaceOf, type AppState, type Bot, type ScreenLeft, type Session } from "@/lib/types";

/**
 * A computer's screens as people and bots both see them: numbered 1 to 4, each saying who's on it,
 * what for, and in what state, and a free one who left it last and on what. One map, from the state
 * alone, for the app (the screen tiles, the team row, a thread's screen), the bots' briefing
 * (lib/server/briefing.ts) and the scheduler's holds (lib/server/sessions.ts pump), so what a bot
 * believes about its screens is what the user sees.
 *
 * Screen numbers are the X displays in DISPLAYS order (the made screens first, Orgo's boot screen
 * last). X display numbers stay inside the server; everything a person or a bot reads says "screen n".
 */

/** A screen's number (1 to 4) from its X display; 0 for one that isn't a screen. */
export const screenNo = (display: number) => DISPLAYS.indexOf(display) + 1;
/** The X display of screen `no`. */
export const displayOf = (no: number) => DISPLAYS[no - 1];
/** "screen 2", as a bot says it. */
export const screenLabel = (display: number) => `screen ${screenNo(display)}`;

/** How long a free screen shows who left it, and what. */
export const LEFT_FOR_MS = 30 * 60_000;
/** How long a thread that stopped to ask the user keeps its screen, so their answer picks it up there. */
export const HOLD_MS = 15 * 60_000;

/**
 * The bot whose computer `b` works on (lib/server/screens.ts workComputer, from the state alone): on this Mac
 * every bot has its own browsers. Not in a workspace shared with the user (state.shared): `host` is the
 * viewer's own app's, and the owner's bots work on their own computers wherever the viewer's work.
 */
export function computerOf(state: Pick<AppState, "host" | "bots" | "shared">, b: Bot): Bot {
  return state.host === "mac" && !state.shared ? b : workBot(b, state.bots);
}

/** Whether two bots work on the same computer, so share its screens. */
export function onSameComputer(state: Pick<AppState, "host" | "bots" | "shared">, a: string, b: string): boolean {
  if (a === b) return true;
  const x = state.bots.find((y) => y.id === a);
  const y = state.bots.find((z) => z.id === b);
  return !!x && !!y && computerOf(state, x).id === computerOf(state, y).id;
}

/**
 * A thread that stopped to ask the user something keeps its screen for HOLD_MS (or until they
 * answer, which picks it up there): new work takes another screen while one is free.
 */
export function holdsScreen(s: Session, now = Date.now()): boolean {
  return !live(s) && !!s.waitingOnYou && !s.dismissed && s.lastDisplay !== undefined && now - (s.endedAt ?? 0) < HOLD_MS;
}

export type ScreenKind = "driving" | "needsYou" | "working" | "helper" | "watched" | "held" | "free";

/** One screen, as the map says it. `botId` is the bot on it (not the one whose view this is). */
export type ScreenInfo = {
  display: number;
  no: number;
  kind: ScreenKind;
  botId?: string;
  sessionId?: string;
  /** The thread's title, a helper's job, or a watched site. */
  title?: string;
  /** What it's doing now (a thread's live caption), or what a watch looks for. */
  doing?: string;
  /** A watch with something new for the user. */
  alert?: boolean;
  /** A free screen: who left it, on what, when (for LEFT_FOR_MS). */
  left?: ScreenLeft;
};

/** The order screens are worth the user's eye in: needs them first, then their own control, work, and the rest. */
export const KIND_ORDER: ScreenKind[] = ["needsYou", "driving", "working", "helper", "held", "watched", "free"];

/** The four screens of the computer `botId` works on. */
export function screenMap(state: AppState, botId: string, now = Date.now()): ScreenInfo[] {
  const me = state.bots.find((b) => b.id === botId);
  if (!me) return [];
  const c = computerOf(state, me);
  const here = (id: string) => onSameComputer(state, id, botId);
  const t = state.takeover;
  return DISPLAYS.map((d): ScreenInfo => {
    const base = { display: d, no: screenNo(d) };
    if (t && "display" in t && t.display === d && here(t.botId)) return { ...base, kind: "driving", botId: t.botId, sessionId: t.sessionId };
    const s = state.sessions.find((x) => live(x) && x.display === d && here(x.botId));
    if (s) return { ...base, kind: s.blocker ? "needsYou" : "working", botId: s.botId, sessionId: s.id, title: s.title, doing: s.activity };
    const p = state.sessions.find((x) => live(x) && x.helperScreens?.includes(d) && here(x.botId));
    if (p) return { ...base, kind: "helper", botId: p.botId, sessionId: p.id, title: p.helperTasks?.[d] ?? p.title };
    const w = (state.watches ?? []).find((x) => !x.mac && x.display === d && here(x.botId));
    if (w) return { ...base, kind: "watched", botId: w.botId, title: w.site, doing: w.lookFor, alert: !!w.alert };
    const h = state.sessions.find((x) => holdsScreen(x, now) && x.lastDisplay === d && here(x.botId));
    if (h) return { ...base, kind: "held", botId: h.botId, sessionId: h.id, title: h.title };
    const left = state.screenLog?.[`${c.id}:${d}`];
    return { ...base, kind: "free", ...(left && now - left.at < LEFT_FOR_MS ? { left } : {}) };
  });
}

/** A screen on another bot's computer, for the main bot's team row. */
export type TeamScreen = ScreenInfo & { computerBotId: string };

/**
 * What the team is doing on computers other than `mainId`'s, for the main bot's view: every screen
 * someone's working on, needs the user on, or that the user drives, and what was left on one in the
 * last half hour. Needs-you first, then the rest by kind; left screens newest first.
 */
export function teamScreens(state: AppState, mainId: string, now = Date.now()): TeamScreen[] {
  const main = state.bots.find((b) => b.id === mainId);
  if (!main) return [];
  const mine = computerOf(state, main).id;
  const computers = [
    ...new Set(
      state.bots
        .filter((b) => workspaceOf(b) === workspaceOf(main))
        .map((b) => computerOf(state, b))
        .filter((c) => c.id !== mine && c.computerStatus === "ready")
        .map((c) => c.id),
    ),
  ];
  return computers
    .flatMap((id) => screenMap(state, id, now).map((s) => ({ ...s, computerBotId: id })))
    .filter((s) => s.kind !== "free" || s.left)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.left?.at ?? 0) - (a.left?.at ?? 0));
}

/** "4 min ago", for a screen left at `at`. */
export function ago(at: number, now = Date.now()): string {
  const m = Math.max(1, Math.round((now - at) / 60_000));
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
