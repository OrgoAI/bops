"use client";

import { Fragment, useEffect, useRef, useState, type AnimationEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { describeSchedule, whenText } from "@/cloud/schedule";
import { appNameFor, canonicalApp, sameApp, templateById } from "@/lib/routine-catalog";
import { DISPLAYS, isScreenWatch, onceDone, runningNow, type AppState, type Delivery, type Routine, type RoutineRun, type Session, type Watch } from "@/lib/types";
import { Fold } from "./fold";
import { Mascot } from "./mascot";
import {
  arrived,
  Chevron,
  DeleteX,
  FIRST,
  InlineConfirm,
  since,
  small,
  undash,
  usePop,
} from "./side-group";
import { watchName } from "./watch-overlay";
import { AppLogo, botApps } from "./apps";
import { asCadence, asSchedule, CadencePicker, sameCadence, suggestedOf, tidy, type Cadence } from "./cadence-picker";
import { CloseButton, currentWorkspace, needsYou, post, teamOf, useNow } from "./ui";

/*
 * Routines: what the workspace's bots do on their own, and how. Schedules (routines: a reminder, a turn
 * in the chat, or a task on a computer, at set times) and Monitors (watches: a bot's screen, a window on the
 * user's Mac, or a web page with no screen). One bot owns each. How a bot does a kind of job is a skill
 * now, on the Skills page (skills.tsx), just below in the sidebar. In the sidebar, a group pinned above
 * Orbit with a section each that folds (AutopilotSections); on the right, a page with every bot's, grouped
 * by bot and filtered by bot, Connected App or what needs the user, each opening in place with what can be
 * done to it (AutopilotPage). A bot's own are on its profile too (routines.tsx). All read the app's state
 * (useAppState), so they're as current as everything else. (Called Autopilot before; the code keeps the name.)
 */

export type AutopilotSection = "schedules" | "monitors";

/** Open the page on the right (bops-app.tsx): at a section, and at one of its rows. */
export type AutopilotOpen = { section: AutopilotSection; focus?: string };

export const GROUP_NAME = "Routines";

const SECTIONS: { id: AutopilotSection; label: string; empty: string; how: string }[] = [
  { id: "schedules", label: "Schedules", empty: "Ask a bot to do something on a schedule", how: "Try: every weekday at 8:30, summarize my inbox" },
  { id: "monitors", label: "Monitors", empty: "Ask a bot to watch a page", how: "Try: watch this page and tell me when the price drops, with its link" },
];

/* ---------------- What's here ---------------- */

/** A one-time schedule whose time has passed: it's done, not paused (Run now before its time doesn't finish it). */
const done = (r: Routine) => onceDone(r);

/**
 * The workspace's schedules and monitors (its own bots' only), in the order both lists show them.
 * Schedules: the ones on first, the soonest run first, then the rest, the latest run first. Monitors:
 * news first, then the newest. With `botId`, that bot's only (its Skills, bot-skills.tsx).
 */
export function autopilotOf(state: AppState, botId?: string) {
  const team = new Set(botId ? [botId] : teamOf(state).map((b) => b.id));
  const schedules = state.routines
    .filter((r) => team.has(r.botId))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.enabled ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) : (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0)) || a.title.localeCompare(b.title));
  const monitors = (state.watches ?? []).filter((w) => team.has(w.botId)).sort((a, b) => Number(!!b.alert) - Number(!!a.alert) || b.since - a.since);
  return { schedules, monitors };
}

/** Whether any of these words has the search in it (lowercased; none: everything matches). */
const has = (q: string, ...words: (string | undefined)[]) => !q || words.some((w) => !!w && w.toLowerCase().includes(q));
const matchSchedule = (r: Routine, q: string) => has(q, r.title, r.goal, r.reminder);
const matchMonitor = (w: Watch, q: string) => has(q, watchName(w), w.site, w.lookFor, w.page?.url, w.mac?.app);

/* ---------------- Words ---------------- */

/** When a schedule runs next ("Tomorrow 9 AM"), or that it's running now (really: runningNow), paused, or done. */
export function nextWords(r: Routine, sessions: Session[], tz?: string) {
  if (runningNow(r, sessions)) return "Running now";
  if (done(r)) return "Done";
  if (!r.enabled) return "Paused";
  return r.nextRunAt ? whenText(r.nextRunAt, Date.now(), tz) : describeSchedule(r.schedule, tz);
}

/** When an on schedule runs next, in words ("Tue 9 AM"), if it does. */
const nextRunText = (r: Routine, tz?: string) => (r.enabled && r.nextRunAt ? whenText(r.nextRunAt, Date.now(), tz) : null);

/** What went wrong last time, if anything: the run failed, or its result didn't reach where it goes. */
export function trouble(r: Routine) {
  const last = r.last;
  if (last?.status === "failed") return `The last run failed${last.error ? `: ${undash(last.error)}` : ""}`;
  if (last?.delivery?.status === "failed") return `Couldn't send it to ${last.delivery.to}${last.delivery.error ? `: ${undash(last.delivery.error)}` : ""}`;
  return null;
}

/**
 * A schedule needs the user: its last run or delivery failed, or the run it started is waiting on them
 * (an app action to approve, a sign-in, a question).
 */
export function scheduleNeedsYou(r: Routine, state: AppState) {
  if (trouble(r)) return true;
  const sid = r.last?.sessionId;
  if (!sid) return false;
  if (state.appApprovals?.some((a) => a.sessionId === sid)) return true;
  const s = state.sessions.find((x) => x.id === sid);
  return !!s && needsYou(s);
}

/** A monitor needs the user when its page couldn't be read (news is its own mark, New). */
export const monitorNeedsYou = (w: Watch) => !!w.page?.error && !w.paused;

/** A Connected App's or a key's name as the user knows it: from their accounts or the catalog ("Stripe"), else its slug, capitalized. */
export function appNameOf(state: AppState, app: string) {
  return state.accounts?.find((a) => a.app === app)?.appName ?? appNameFor(app) ?? app.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The Connected App a routine or monitor came from, as a small logo that says so on hover. */
export function SourceMark({ state, app, size = 16 }: { state: AppState; app: string; size?: number }) {
  const name = appNameOf(state, app);
  return (
    <span data-tip={`From ${name}`} aria-label={`From ${name}`} role="img" className="flex shrink-0">
      <AppLogo app={app} name={name} size={size} />
    </span>
  );
}

/** Tags, as small chips. */
export function TagChips({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11.5px] leading-4 text-[#3A3A38]">
          {t}
        </span>
      ))}
    </span>
  );
}

const howWords = (r: Routine) => (r.reminder ? "A reminder" : r.run === "chat" ? "In the chat" : "On a computer");

const SERVICES = { slack: "Slack", telegram: "Telegram", discord: "Discord" } as const;

/** Where a result goes besides the chat: Text, Email, or a Slack, Telegram or Discord place ("Slack #sales"). */
function deliveryName(d: Delivery, state: AppState) {
  if (d.kind === "text") return "Text";
  if (d.kind === "email") return "Email";
  const link = state.channels?.find((l) => l.id === d.linkId);
  if (!link) return "A channel";
  const channel = d.chat && link.slack?.channels.find((c) => c.id === d.chat);
  return channel ? `Slack #${channel.name}` : SERVICES[link.kind];
}

/** Every place a schedule's results go: the bot's chat in Bops always, then what it delivers to. */
function destinations(r: Routine, state: AppState) {
  const to = ["Bops chat"];
  if (r.deliverTo) to.push(deliveryName(r.deliverTo, state));
  if (r.textTo && r.deliverTo?.kind !== "text") to.push("Text");
  return to.join(", ");
}

export const RAN: Record<RoutineRun["status"], string> = {
  running: "Running now",
  ok: "Ran",
  quiet: "Ran, nothing for you",
  failed: "Failed",
  skipped: "Skipped",
};

/** How often a page is read: "Every 30 minutes", "Every hour", "Every 2 hours". */
function everyWords(min: number) {
  if (min === 60) return "Every hour";
  if (min > 60 && min % 60 === 0) return `Every ${min / 60} hours`;
  return `Every ${min} minute${min === 1 ? "" : "s"}`;
}

/** A page's address the way people say it: no scheme, no www, no trailing slash. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");

/** What a watch looks at, in words: a page, a window on the user's Mac, or one of a bot's screens. */
function whereWords(w: Watch, state: AppState) {
  if (w.page) return shortUrl(w.page.url);
  if (w.mac) return `${w.mac.app} on your Mac`;
  return `${state.bots.find((b) => b.id === w.botId)?.name ?? "Bot"}'s screen ${DISPLAYS.indexOf(w.display) + 1}`;
}

/**
 * Asks Bops for a change: null when done (the state shows it), else what went wrong, in words. `answered`
 * reads what Bops answered when it worked, and can say what went wrong there too (a look that failed).
 */
async function send(url: string, body: unknown, method: string, answered?: (json: unknown) => string | null): Promise<string | null> {
  try {
    const r = await post(url, body, method);
    const j: unknown = await r.json().catch(() => null);
    const said = (j as { error?: unknown } | null)?.error;
    if (r.ok && !said) return answered?.(j) ?? null;
    return typeof said === "string" && said ? undash(said) : "That didn't work. Try again.";
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/* ---------------- Icons ---------------- */

const GLYPHS: Record<AutopilotSection | "autopilot", ReactNode> = {
  // Round and round, on its own.
  autopilot: (
    <>
      <path d="M13.2 8.4A5.2 5.2 0 1 1 11.6 4.3" />
      <path d="M13.4 2.6v2.6h-2.6" />
      <path d="M6.9 6v4l3.1-2z" />
    </>
  ),
  schedules: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5v3.2l2.1 1.3" />
    </>
  ),
  monitors: (
    <>
      <path d="M1.8 8S4.1 3.9 8 3.9 14.2 8 14.2 8 11.9 12.1 8 12.1 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
};

/** Autopilot's mark, or one of its sections': in the sidebar, its tab, and on its page. */
export function AutopilotIcon({ id = "autopilot", size = 14 }: { id?: AutopilotSection | "autopilot"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {GLYPHS[id]}
    </svg>
  );
}

/** A small red dot for something that went wrong, saying what on hover. */
function TroubleDot({ tip, className = "" }: { tip: string; className?: string }) {
  return (
    <span role="img" aria-label={tip} data-tip={tip} className={`flex size-3.5 shrink-0 items-center justify-center ${className}`}>
      <span className="size-[7px] rounded-full bg-[#D92D20]" />
    </span>
  );
}

/** The highlighter's "New", on a watch with news (it pops when news comes in while it's shown). */
function NewPill({ pop, onAnimationEnd }: { pop?: boolean; onAnimationEnd?: (e: AnimationEvent) => void }) {
  return (
    <span onAnimationEnd={onAnimationEnd} className={`shrink-0 rounded-full bg-highlighter px-1.5 py-px text-[11px] font-semibold leading-4 text-ink shadow-[0_0_0_1px_#0000001F] ${pop ? "motion-dot-in" : ""}`}>
      New
    </span>
  );
}

/** A row that turned up after the sidebar's first paint: rises in with a soft wash, once (the class goes when the wash ends). */
function useFresh(id: string) {
  const [on, setOn] = useState(() => arrived(id));
  return { on, done: (e: AnimationEvent) => e.target === e.currentTarget && e.animationName === "wash" && setOn(false) };
}

/* ---------------- The sidebar ---------------- */

/**
 * Routines in the sidebar, above Skills and Orbit: one row with its count (and New while a monitor has
 * news) that opens the page, and under it the next three: monitors with news, the soonest schedules,
 * the other monitors. Nothing under it while there are none. While the sidebar searches, the matches
 * (up to five); none, and the row is gone.
 */
export function AutopilotSections({ state, query = "", onOpen, onOpenWatch }: { state: AppState; query?: string; onOpen: (open: AutopilotOpen) => void; onOpenWatch: (w: Watch) => void }) {
  const user = state.account?.user.id ?? "";
  const ws = currentWorkspace(state);
  // Keyed by account and workspace: a switch shows the other's sections as they are, nothing folding or ticking.
  return <SidebarGroup key={`${user}:${ws}`} state={state} query={query} onOpen={onOpen} onOpenWatch={onOpenWatch} />;
}

function SidebarGroup({
  state,
  query,
  onOpen,
  onOpenWatch,
}: {
  state: AppState;
  query: string;
  onOpen: (open: AutopilotOpen) => void;
  onOpenWatch: (w: Watch) => void;
}) {
  const q = query.trim().toLowerCase();
  const tz = state.owner?.timeZone;
  const lists = autopilotOf(state);
  const schedules = lists.schedules.filter((r) => matchSchedule(r, q));
  const monitors = lists.monitors.filter((w) => matchMonitor(w, q));
  const news = monitors.filter((w) => w.alert).length;
  const total = schedules.length + monitors.length;
  if (q && !total) return null;
  // One row, like Skills under it, and what comes next under it: monitors with news, then the soonest
  // schedules, then the other monitors. Nothing under it while there are none (the page says how).
  const next = [
    ...monitors.filter((w) => w.alert).map((w) => <MonitorLine key={w.id} watch={w} onClick={() => onOpenWatch(w)} />),
    ...schedules.map((r) => <ScheduleLine key={r.id} routine={r} sessions={state.sessions} tz={tz} onClick={() => onOpen({ section: "schedules", focus: r.id })} />),
    ...monitors.filter((w) => !w.alert).map((w) => <MonitorLine key={w.id} watch={w} onClick={() => onOpenWatch(w)} />),
  ];
  const max = q ? FIRST : 3;
  const first = SECTIONS.find((s) => lists[s.id].length)?.id ?? "schedules";
  return (
    <div className="flex flex-col pt-3">
      <button onClick={() => onOpen({ section: first })} className={SIDE_HEAD}>
        <span className="text-[#6B6B6B]">
          <AutopilotIcon id="schedules" />
        </span>
        <span className="flex-1">{GROUP_NAME}</span>
        {news > 0 && <NewPill />}
        {total > 0 && <span className="tabular-nums font-normal text-[#9A9A98]">{total}</span>}
      </button>
      {next.slice(0, max)}
      {next.length > max && (
        <button onClick={() => onOpen({ section: first })} className={`${SIDE_ROW} text-[13px] leading-[18px] text-[#6B6B6B] hover:text-ink`}>
          Show all {next.length}
        </button>
      )}
    </div>
  );
}

/** A row in the sidebar's pinned box: Routines here, Skills (skills.tsx) the same. */
export const SIDE_HEAD =
  "flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[13px] font-medium leading-4 text-[#3A3A38] outline-none hover:bg-black/[0.04] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]";

const SIDE_ROW =
  "flex h-[30px] shrink-0 items-center gap-2 rounded-[10px] pl-8 pr-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]";

/** A schedule in the sidebar: its name, then when it runs next (or Paused, Done) and "quiet" in grey; a red dot when its last run or delivery failed. */
function ScheduleLine({ routine: r, sessions, tz, onClick }: { routine: Routine; sessions: Session[]; tz?: string; onClick: () => void }) {
  const fresh = useFresh(r.id);
  const bad = trouble(r);
  const line = [nextWords(r, sessions, tz), r.quiet ? "quiet" : ""].filter(Boolean).join(" · ");
  return (
    <button onClick={onClick} onAnimationEnd={fresh.done} className={`${SIDE_ROW} ${fresh.on ? "motion-new-item" : ""}`}>
      <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px]">
        <span className={r.enabled ? "text-ink" : "text-[#9A9A98]"}>{undash(r.title)}</span>
        <span className="text-[#9A9A98]">
          {" · "}
          {line}
        </span>
      </span>
      {bad && <TroubleDot tip={bad} />}
    </button>
  );
}

/**
 * A monitor in the sidebar (the old Watching row): what's watched, then what for in grey; New while it
 * has news, Paused while the user paused it or the screen shows something else, a red dot when a page
 * couldn't be read; × stops it.
 */
function MonitorLine({ watch: w, onClick }: { watch: Watch; onClick: () => void }) {
  const fresh = useFresh(w.id);
  // Its New mark pops when news comes in while it's shown.
  const pop = usePop(!!w.alert);
  const off = !!w.paused || !!w.away;
  const error = w.page?.error;
  return (
    <button
      onClick={onClick}
      title={`${w.lookFor}${w.paused ? " · paused" : w.away ? " · paused: it isn't showing right now" : ""}`}
      onAnimationEnd={fresh.done}
      className={`group/watch ${SIDE_ROW} ${fresh.on ? "motion-new-item" : ""}`}
    >
      <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px]">
        <span className={off ? "text-[#9A9A98]" : "text-ink"}>{watchName(w)}</span>
        <span className="text-[#9A9A98]">
          {" · "}
          {undash(w.lookFor)}
        </span>
      </span>
      {w.alert ? (
        <NewPill pop={pop.pop} onAnimationEnd={pop.done} />
      ) : error && !w.paused ? (
        <TroubleDot tip={`Couldn't read the page: ${undash(error)}`} />
      ) : (
        off && <span className="shrink-0 text-[12px] text-[#9A9A98] group-hover/watch:hidden group-has-[:focus-visible]/watch:hidden group-focus-visible/watch:hidden">Paused</span>
      )}
      <DeleteX
        label={`Stop watching ${watchName(w)}`}
        onDelete={() => void post(`/api/watches?id=${encodeURIComponent(w.id)}`, {}, "DELETE")}
        className="group-hover/watch:opacity-100 group-focus-visible/watch:opacity-100"
      />
    </button>
  );
}

/* ---------------- The page ---------------- */

/** Which of a list of schedules and monitors to show: one bot's, one Connected App's, only what needs the user. */
export type RoutineFilter = { bot?: string; app?: string; needsYou?: boolean };

/** The schedules and monitors a filter keeps (each list keeps its order). */
export function filterRoutines(state: AppState, lists: { schedules: Routine[]; monitors: Watch[] }, f: RoutineFilter) {
  return {
    schedules: lists.schedules.filter((r) => (!f.bot || r.botId === f.bot) && (!f.app || (!!r.source && sameApp(r.source.app, f.app))) && (!f.needsYou || scheduleNeedsYou(r, state))),
    monitors: lists.monitors.filter((w) => (!f.bot || w.botId === f.bot) && (!f.app || (!!w.source && sameApp(w.source.app, f.app))) && (!f.needsYou || monitorNeedsYou(w))),
  };
}

/** The Connected Apps these came from, in the order first met. */
export function sourceApps(lists: { schedules: Routine[]; monitors: Watch[] }) {
  return [...new Set([...lists.schedules, ...lists.monitors].map((x) => x.source?.app).filter((a): a is string => !!a).map(canonicalApp))];
}

/**
 * Open rows, one at a time, and the one asked for brought into view once it's there. `focus` opens one;
 * `focusAt` is when it was asked for, so asking again (it was closed since, or scrolled away) does it again.
 */
export function useOpenRow(focus: string | undefined, focusAt: number | undefined, there: boolean) {
  const [openId, setOpenId] = useState<string | null>(focus ?? null);
  const [asked, setAsked] = useState({ focus, focusAt });
  if (asked.focus !== focus || asked.focusAt !== focusAt) {
    setAsked({ focus, focusAt });
    if (focus) setOpenId(focus);
  }
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!there || !focus) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(focus)}"]`);
    if (!el) return;
    const go = () => el.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    go();
    // Its details fold open over 200ms (fold.tsx): once they're in, bring all of it into view.
    const opened = (e: TransitionEvent) => e.propertyName === "grid-template-rows" && go();
    el.addEventListener("transitionend", opened);
    const t = setTimeout(() => el.removeEventListener("transitionend", opened), 600);
    return () => {
      clearTimeout(t);
      el.removeEventListener("transitionend", opened);
    };
  }, [there, focus, focusAt]);
  return { openId, toggle: (id: string) => setOpenId(openId === id ? null : id), list };
}

/** A pill that filters a page: dark while it's on. */
export function FilterPill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium leading-4 outline-none transition-colors duration-150 ease-out focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] motion-reduce:transition-none ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
    >
      {children}
    </button>
  );
}

/**
 * Schedules then monitors, one card (on a page, or a bot's Routines): each row opens in place. Opening a
 * page's news is seeing it (a screen's is seen where it shows: Show it).
 */
export function RoutineList({
  state,
  schedules,
  monitors,
  openId,
  onToggle,
  onOpenWatch,
  className = "shadow-[0_0_0_1px_#ECECEA]",
}: {
  state: AppState;
  schedules: Routine[];
  monitors: Watch[];
  openId: string | null;
  onToggle: (id: string) => void;
  onOpenWatch: (w: Watch) => void;
  className?: string;
}) {
  const tz = state.owner?.timeZone;
  const n = schedules.length + monitors.length;
  if (!n) return null;
  return (
    <div className={`flex flex-col overflow-hidden rounded-2xl ${className}`}>
      {schedules.map((r, i) => (
        <ScheduleRow key={r.id} routine={r} state={state} tz={tz} last={i === n - 1} open={openId === r.id} onToggle={() => onToggle(r.id)} />
      ))}
      {monitors.map((w, i) => (
        <MonitorRow
          key={w.id}
          watch={w}
          state={state}
          last={schedules.length + i === n - 1}
          open={openId === w.id}
          onToggle={() => {
            if (openId !== w.id && w.alert && w.page) void post("/api/watches", { id: w.id, action: "seen" }, "PATCH");
            onToggle(w.id);
          }}
          onShow={() => onOpenWatch(w)}
        />
      ))}
    </div>
  );
}

/**
 * Routines as a page on the right (one tab per workspace): every bot's schedules and monitors, grouped
 * by bot, each opening in place to say how it works and how it went, with what can be done to it.
 * Filters: a bot, a Connected App they came from, and Needs you (a failed run or delivery, a run waiting
 * on the user, a page that can't be read). How a bot does each kind of job is a skill: a link goes there.
 */
export function AutopilotPage({
  state,
  focus,
  focusAt,
  onOpenWatch,
  onOpenSkills,
  onClose,
}: {
  state: AppState;
  focus?: string;
  focusAt?: number;
  /** Show a watched screen or Mac window (bops-app.tsx showWatch). */
  onOpenWatch: (w: Watch) => void;
  /** The Skills page, where procedures went. */
  onOpenSkills: () => void;
  onClose: () => void;
}) {
  // "Tomorrow 9 AM", "5m ago" stay current.
  useNow(30_000);
  const all = autopilotOf(state);
  const [filter, setFilter] = useState<RoutineFilter>({});
  const team = teamOf(state);
  const shown = filterRoutines(state, all, filter);
  // A row asked for that the filter hides: the filter goes, so it shows.
  const [askedAt, setAskedAt] = useState(focusAt);
  if (askedAt !== focusAt) {
    setAskedAt(focusAt);
    if (focus && ![...shown.schedules, ...shown.monitors].some((x) => x.id === focus)) setFilter({});
  }
  const there = !!focus && [...shown.schedules, ...shown.monitors].some((x) => x.id === focus);
  const { openId, toggle, list } = useOpenRow(focus, focusAt, there);
  const apps = sourceApps(all);
  const needs = filterRoutines(state, all, { needsYou: true });
  const needsN = needs.schedules.length + needs.monitors.length;
  const total = all.schedules.length + all.monitors.length;
  const owners = team.filter((b) => all.schedules.some((r) => r.botId === b.id) || all.monitors.some((w) => w.botId === b.id));
  const groups = team
    .map((b) => ({ bot: b, schedules: shown.schedules.filter((r) => r.botId === b.id), monitors: shown.monitors.filter((w) => w.botId === b.id) }))
    .filter((g) => g.schedules.length + g.monitors.length);
  const filtered = !!(filter.bot || filter.app || filter.needsYou);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <AutopilotIcon size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{GROUP_NAME}</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">
              What your bots do on their own. How they do each kind of job is in{" "}
              <button onClick={onOpenSkills} className="font-medium text-ink underline decoration-[#C9C9C6] underline-offset-2 hover:decoration-ink">
                Skills
              </button>
            </span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>

        {total > 0 && (owners.length > 1 || apps.length > 0 || needsN > 0 || filtered) && (
          <div className="flex flex-col gap-2">
            {owners.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Bot">
                <FilterPill on={!filter.bot} onClick={() => setFilter({ ...filter, bot: undefined })}>
                  All bots
                </FilterPill>
                {owners.map((b) => (
                  <FilterPill key={b.id} on={filter.bot === b.id} onClick={() => setFilter({ ...filter, bot: filter.bot === b.id ? undefined : b.id })}>
                    <Mascot botId={b.id} color={b.color} size={14} antenna={false} />
                    {b.name}
                  </FilterPill>
                ))}
              </div>
            )}
            {(apps.length > 0 || needsN > 0 || filter.needsYou) && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Connected App and Needs you">
                {(needsN > 0 || filter.needsYou) && (
                  <FilterPill on={!!filter.needsYou} onClick={() => setFilter({ ...filter, needsYou: !filter.needsYou })}>
                    Needs you
                    <span className={`tabular-nums ${filter.needsYou ? "text-white/60" : "text-[#9A9A98]"}`}>{needsN}</span>
                  </FilterPill>
                )}
                {apps.map((a) => (
                  <FilterPill key={a} on={filter.app === a} onClick={() => setFilter({ ...filter, app: filter.app === a ? undefined : a })}>
                    <AppLogo app={a} name={appNameOf(state, a)} size={14} />
                    {appNameOf(state, a)}
                  </FilterPill>
                ))}
              </div>
            )}
          </div>
        )}

        <div ref={list} className="flex flex-col gap-5">
          {!total ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Mascot botId="boppy" color="#0A0A0A" size={52} />
              <span className="flex max-w-[340px] flex-col gap-1 text-[13.5px] leading-5">
                <span className="text-[#6B6B6B]">Ask a bot to do something on a schedule, or to watch a page</span>
                <span className="text-[#9A9A98]">Try: every weekday at 8:30, summarize my inbox</span>
              </span>
            </div>
          ) : !groups.length ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-[13.5px] leading-5 text-[#6B6B6B]">
              Nothing matches these filters
              <button onClick={() => setFilter({})} className={small("plain")}>
                Show all
              </button>
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.bot.id} className="flex flex-col gap-2">
                <span className="flex items-center gap-1.5 px-1 text-[12px] font-medium leading-4 text-[#6B6B6B]">
                  <Mascot botId={g.bot.id} color={g.bot.color} size={14} antenna={false} />
                  {g.bot.name} <span className="font-normal tabular-nums text-[#B0B0AD]">{g.schedules.length + g.monitors.length}</span>
                </span>
                <RoutineList state={state} schedules={g.schedules} monitors={g.monitors} openId={openId} onToggle={toggle} onOpenWatch={onOpenWatch} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A row on the page: its name and a line, opening in place (one at a time) to its details and actions,
 * rendered once first opened. `editing` takes the row's place while it's changed in place.
 */
function PageRow({
  id,
  title,
  line,
  dim,
  end,
  last,
  open,
  onToggle,
  editing,
  children,
}: {
  id: string;
  title: string;
  line?: string;
  dim?: boolean;
  end?: ReactNode;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  editing?: ReactNode;
  children: ReactNode;
}) {
  const fresh = useFresh(id);
  return (
    <div data-item={id} onAnimationEnd={fresh.done} className={`flex flex-col ${last ? "" : "border-b border-[#F0F0EE]"} ${fresh.on ? "motion-new-item" : ""}`}>
      {editing ? (
        <div className="px-3.5 py-3">{editing}</div>
      ) : (
        <button onClick={onToggle} aria-expanded={open} className="flex items-start gap-3 px-3.5 py-3 text-left outline-none focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={`truncate text-[14px] font-medium leading-[18px] ${dim ? "text-[#9A9A98]" : "text-ink"}`}>{title}</span>
            {line && <span className={`text-[12.5px] leading-[17px] text-[#6B6B6B] ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>{line}</span>}
          </span>
          {end && <span className="flex shrink-0 items-center gap-1.5 pt-px">{end}</span>}
          <span className="pt-[3px] text-[#B0B0AD]">
            <Chevron open={open} />
          </span>
        </button>
      )}
      <Fold open={open && !editing} lazy>
        <div className="flex flex-col gap-3 px-3.5 pb-3.5">{children}</div>
      </Fold>
    </div>
  );
}

/** Facts about a row, a label each (rows with nothing to say left out). */
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] leading-[17px]">
      {rows
        .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== "")
        .map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-[#9A9A98]">{k}</dt>
            <dd className="min-w-0 text-[#3A3A38] [overflow-wrap:anywhere]">{v}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

/** Words written for or by a bot (an ask, steps), as they were written: their line breaks kept. */
function Words({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">{label}</span>
      <span className="whitespace-pre-wrap rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13px] leading-[19px] text-[#3A3A38] [overflow-wrap:anywhere]">{undash(text)}</span>
    </div>
  );
}

function AppName({ state, app }: { state: AppState; app: string }) {
  const name = appNameOf(state, app);
  return (
    <span className="inline-flex items-center gap-1.5 align-top">
      <AppLogo app={app} name={name} size={14} />
      {name}
    </span>
  );
}

/** The zone a routine's times are in: its own (Routine.timeZone), else the owner's. */
export const zoneOf = (r: Routine, ownerZone?: string) => (r as Routine & { timeZone?: string }).timeZone || ownerZone;

/** What the When picker needs for a routine: its starter's suggested times, and whether its bot uses Google Calendar. */
function whenContext(r: Routine, state: AppState) {
  const bot = state.bots.find((b) => b.id === r.botId);
  return {
    presets: r.source?.template ? suggestedOf(templateById(r.source.template)) : undefined,
    calendar: !!bot && botApps(state, bot).some((x) => sameApp(x.app, "googlecalendar")),
  };
}

/** `timeZone` null: back on the owner's zone (the routine stops having its own). */
type WhenEdit = { schedule?: Routine["schedule"]; timeZone?: string | null };

/** When it runs, as picked: what changed from the routine's own (nothing when nothing did). */
function useWhen(r: Routine, tz?: string) {
  const [schedule, setSchedule] = useState<Cadence>(() => asCadence(r.schedule));
  const was = zoneOf(r, tz);
  const [zone, setZone] = useState(was);
  const edit: WhenEdit = {
    ...(!sameCadence(schedule, asCadence(r.schedule)) ? { schedule: asSchedule(tidy(schedule)) } : {}),
    // The owner's own zone picked for a routine that had its own: it follows the owner again (wherever they travel), not pinned to it.
    ...(zone && zone !== was ? { timeZone: zone === tz && r.timeZone ? null : zone } : {}),
  };
  return { schedule, setSchedule, zone, setZone, edit };
}

/**
 * Change a schedule in place: its name, what it does, when it runs (CadencePicker) and whether it's
 * quiet. Esc cancels (and only that), Cmd+Enter saves.
 */
function ScheduleEdit({
  routine: r,
  state,
  tz,
  busy,
  error,
  onSave,
  onCancel,
}: {
  routine: Routine;
  state: AppState;
  tz?: string;
  busy: boolean;
  error: string | null;
  onSave: (edit: { title?: string; goal?: string; quiet?: boolean } & WhenEdit) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(r.title);
  const [goal, setGoal] = useState(r.goal);
  const when = useWhen(r, tz);
  const [quiet, setQuiet] = useState(!!r.quiet);
  const ctx = whenContext(r, state);
  const edit = {
    ...(title.trim() && title.trim() !== r.title ? { title: title.trim() } : {}),
    ...(goal.trim() && goal.trim() !== r.goal ? { goal: goal.trim() } : {}),
    ...when.edit,
    ...(quiet !== !!r.quiet ? { quiet } : {}),
  };
  const changed = Object.keys(edit).length > 0;
  const field = "w-full rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13px] leading-[18px] outline-none focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !busy) onSave(edit);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (!busy) onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && changed && !busy) {
          e.preventDefault();
          onSave(edit);
        }
      }}
      className="flex flex-col gap-2.5"
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">Name</span>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">What it does</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} className={`${field} resize-none`} />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">When</span>
        <CadencePicker value={when.schedule} onChange={when.setSchedule} zone={when.zone} ownerZone={tz} onZone={when.setZone} presets={ctx.presets} calendar={ctx.calendar} disabled={busy} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-[12.5px] leading-4 text-[#3A3A38]">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} className="size-3.5 accent-[#0A0A0A]" />
          Quiet: post only when there&rsquo;s something for you
        </label>
      </div>
      <div className="-ml-2.5 flex items-center gap-0.5">
        <button type="submit" disabled={!changed || busy} className="rounded-full bg-ink px-3 py-1 text-[12px] font-medium leading-4 text-white disabled:opacity-40">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={small("plain")}>
          Cancel
        </button>
      </div>
      <ErrorLine text={error} />
    </form>
  );
}

/** Just when a schedule runs, changed in place on its When: Save, Cancel, Esc cancels, Cmd+Enter saves. */
function WhenChange({ routine: r, state, tz, busy, onSave, onCancel }: { routine: Routine; state: AppState; tz?: string; busy: boolean; onSave: (edit: WhenEdit) => void; onCancel: () => void }) {
  const when = useWhen(r, tz);
  const ctx = whenContext(r, state);
  const changed = Object.keys(when.edit).length > 0;
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && changed && !busy) {
          e.preventDefault();
          onSave(when.edit);
        }
      }}
      className="flex flex-col gap-2 pt-0.5"
    >
      <CadencePicker value={when.schedule} onChange={when.setSchedule} zone={when.zone} ownerZone={tz} onZone={when.setZone} presets={ctx.presets} calendar={ctx.calendar} disabled={busy} />
      <div className="-ml-2.5 flex items-center gap-0.5">
        <button type="button" onClick={() => onSave(when.edit)} disabled={!changed || busy} className="rounded-full bg-ink px-3 py-1 text-[12px] font-medium leading-4 text-white disabled:opacity-40">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={small("plain")}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BotName({ bot }: { bot?: { id: string; name: string; color: string } }) {
  if (!bot) return <>A bot that&rsquo;s gone</>;
  return (
    <span className="inline-flex items-center gap-1.5 align-top">
      <Mascot botId={bot.id} color={bot.color} size={14} antenna={false} />
      {bot.name}
    </span>
  );
}

/** What a row is doing now: which action, while Bops does it. */
type Busy = null | "run" | "toggle" | "check" | "remove" | "save";

/**
 * What a row's actions share: which one is on its way, what went wrong, and the remove question (asked
 * once more in place; shut, the row drops it). `run` sends one and says how it went.
 */
function useActions(open: boolean) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  if (!open && sure) setSure(false);
  const run = async (what: Exclude<Busy, null>, url: string, body: unknown, method: string, answered?: (json: unknown) => string | null) => {
    setBusy(what);
    setError(null);
    const e = await send(url, body, method, answered);
    setBusy(null);
    setError(e);
    return !e;
  };
  const cancelRemove = () => {
    // Back where it was asked: focus returns to the button (it's back on screen once this renders).
    flushSync(() => setSure(false));
    removeButton.current?.focus();
  };
  return { busy, error, setError, sure, setSure, removeButton, run, cancelRemove };
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span role="alert" className="text-[12.5px] leading-4 text-[#B42318]">
      {text}
    </span>
  );
}

/** A schedule on the page: what it asks, its bot, when and how it runs, where results go, how its last run and delivery went; Run now, Pause or Resume, Delete. */
export function ScheduleRow({ routine: r, state, tz, last, open, onToggle }: { routine: Routine; state: AppState; tz?: string; last: boolean; open: boolean; onToggle: () => void }) {
  const { busy, error, setError, sure, setSure, removeButton, run, cancelRemove } = useActions(open);
  const [editing, setEditing] = useState(false);
  // Changing only when it runs, in place on its When.
  const [changingWhen, setChangingWhen] = useState(false);
  if (!open && changingWhen) setChangingWhen(false);
  const bad = trouble(r);
  const zone = zoneOf(r, tz);
  const next = nextRunText(r, tz);
  const ran = r.last;
  const delivery = ran?.delivery;
  return (
    <PageRow
      id={r.id}
      title={undash(r.title)}
      line={`${describeSchedule(r.schedule, zone)} · ${nextWords(r, state.sessions, tz)}${r.quiet ? " · quiet" : ""}`}
      dim={!r.enabled}
      end={
        (bad || r.source) && (
          <>
            {r.source && <SourceMark state={state} app={r.source.app} />}
            {bad && <TroubleDot tip={bad} />}
          </>
        )
      }
      editing={
        editing && (
          <ScheduleEdit
            routine={r}
            state={state}
            tz={tz}
            busy={busy === "save"}
            error={error}
            onSave={async (edit) => (await run("save", "/api/routines", { id: r.id, edit }, "PATCH")) && setEditing(false)}
            onCancel={() => {
              setError(null);
              setEditing(false);
            }}
          />
        )
      }
      last={last}
      open={open}
      onToggle={onToggle}
    >
      <Words label={r.reminder ? "The reminder" : "What it does"} text={r.reminder ?? r.goal} />
      <Facts
        rows={[
          ["Bot", <BotName key="bot" bot={state.bots.find((b) => b.id === r.botId)} />],
          ["From", r.source && <AppName key="from" state={state} app={r.source.app} />],
          ["Tags", r.tags?.length ? <TagChips key="tags" tags={r.tags} /> : ""],
          [
            "When",
            changingWhen ? (
              <WhenChange
                key="when"
                routine={r}
                state={state}
                tz={tz}
                busy={busy === "save"}
                onSave={async (edit) => (await run("save", "/api/routines", { id: r.id, edit }, "PATCH")) && setChangingWhen(false)}
                onCancel={() => {
                  setError(null);
                  setChangingWhen(false);
                }}
              />
            ) : (
              <span key="when">
                {`${describeSchedule(r.schedule, zone)}${next ? `. Next: ${next}` : ""}`}
                {zone && zone !== tz ? <span className="text-[#9A9A98]">{` (${zone.split("/").pop()?.replace(/_/g, " ")} time)`}</span> : null}
                {!done(r) && (
                  <button onClick={() => setChangingWhen(true)} disabled={!!busy} className="ml-1.5 text-[12px] font-medium leading-4 text-ink underline-offset-2 outline-none hover:underline focus-visible:underline disabled:opacity-40">
                    Change
                  </button>
                )}
              </span>
            ),
          ],
          ["Runs", howWords(r)],
          ["Quiet", r.quiet ? "Yes: it posts only when there's something for you" : ""],
          ["Results go to", destinations(r, state)],
          // Set up on someone else's say (an email or a text from outside): who, so the user can tell.
          ["Set up by", r.fromOutside ? undash(r.fromOutside) : ""],
          [
            "Last run",
            ran && (
              <span className="flex flex-col gap-0.5">
                <span>
                  {RAN[ran.status]} · {since(ran.at)}
                </span>
                {ran.error && <span className="text-[#B42318]">{undash(ran.error)}</span>}
              </span>
            ),
          ],
          [
            "Delivery",
            delivery &&
              (delivery.status === "sent" ? (
                `Sent to ${delivery.to} · ${since(delivery.at)}`
              ) : (
                <span className="text-[#B42318]">
                  Couldn&rsquo;t send to {delivery.to}
                  {delivery.error ? `: ${undash(delivery.error)}` : ""}
                </span>
              )),
          ],
        ]}
      />
      {sure ? (
        <InlineConfirm
          text="Delete this schedule? It won't run again."
          action="Delete"
          doing="Deleting…"
          busy={busy === "remove"}
          onConfirm={() => void run("remove", "/api/routines", { id: r.id }, "DELETE")}
          onCancel={cancelRemove}
        />
      ) : (
        <div className="-ml-2.5 flex flex-wrap items-center gap-0.5">
          <button onClick={() => void run("run", "/api/routines", { id: r.id, action: "run" }, "PATCH")} disabled={!!busy || runningNow(r, state.sessions)} className={small("plain")}>
            {busy === "run" ? "Running…" : "Run now"}
          </button>
          {!done(r) && (
            <button onClick={() => void run("toggle", "/api/routines", { id: r.id, enabled: !r.enabled }, "PATCH")} disabled={!!busy} className={small("plain")}>
              {r.enabled ? "Pause" : "Resume"}
            </button>
          )}
          {!r.reminder && (
            <button onClick={() => setEditing(true)} disabled={!!busy} className={small("plain")}>
              Edit
            </button>
          )}
          <button ref={removeButton} onClick={() => setSure(true)} disabled={!!busy} className={small("red")}>
            Delete
          </button>
        </div>
      )}
      <ErrorLine text={error} />
    </PageRow>
  );
}

/** A monitor on the page: its bot, what it watches (a page opens in the browser), what for, how often and when it last looked, its news or trouble; Show it, Check now, Pause or Resume, Stop. */
export function MonitorRow({ watch: w, state, last, open, onToggle, onShow }: { watch: Watch; state: AppState; last: boolean; open: boolean; onToggle: () => void; onShow: () => void }) {
  const { busy, error, sure, setSure, removeButton, run, cancelRemove } = useActions(open);
  // What Check now found when there was nothing new (a failure shows as the error).
  const [found, setFound] = useState<string | null>(null);
  if (!open && found) setFound(null);
  const check = () => {
    setFound(null);
    void run("check", "/api/watches", { id: w.id, action: "check" }, "PATCH", (json) => {
      const result = (json as { result?: unknown } | null)?.result;
      if (result === "failed") return "Couldn't look at it just now. Try again.";
      if (result === "same" || result === "changed") setFound("Checked just now: nothing new.");
      return null;
    });
  };
  const page = w.page;
  const checked = page?.checkedAt ?? w.readAt;
  const url = page && /^https?:\/\//i.test(page.url) ? page.url : null;
  return (
    <PageRow
      id={w.id}
      title={watchName(w)}
      line={undash(w.lookFor)}
      dim={!!w.paused || !!w.away}
      end={
        <>
          {w.source && <SourceMark state={state} app={w.source.app} />}
          {w.alert ? <NewPill /> : page?.error && !w.paused ? <TroubleDot tip={`Couldn't read the page: ${undash(page.error)}`} /> : null}
        </>
      }
      last={last}
      open={open}
      onToggle={onToggle}
    >
      <Facts
        rows={[
          ["Bot", <BotName key="bot" bot={state.bots.find((b) => b.id === w.botId)} />],
          ["From", w.source && <AppName key="from" state={state} app={w.source.app} />],
          [
            "Watching",
            url ? (
              // Opens in the user's own browser (the Mac app hands new windows to it).
              <a key="url" href={url} target="_blank" rel="noreferrer" className="text-ink underline decoration-[#C9C9C6] underline-offset-2 hover:decoration-ink">
                {shortUrl(url)}
              </a>
            ) : (
              whereWords(w, state)
            ),
          ],
          ["Looks for", undash(w.lookFor)],
          ["How often", page ? everyWords(page.everyMin) : ""],
          ["Checked", checked ? since(checked) : page ? "Not yet" : ""],
          ["Changed", page?.changedAt ? since(page.changedAt) : ""],
          ["Read", page?.via === "browser" ? "In a browser, since the page needs one" : ""],
          ["Paused", w.paused ? "Yes, until you resume it" : w.away ? "It isn't showing right now" : ""],
          [
            "News",
            w.alert && (
              <span className="flex flex-col gap-0.5">
                <span>{undash(w.alert.text)}</span>
                <span className="text-[#9A9A98]">{since(w.alert.at)}</span>
              </span>
            ),
          ],
          [
            "Problem",
            page?.error && (
              <span className="text-[#B42318]">
                {undash(page.error)}
                {(page.failures ?? 0) > 1 ? `. Tried ${page.failures} times, so it checks less often for now.` : ""}
              </span>
            ),
          ],
        ]}
      />
      {sure ? (
        <InlineConfirm
          text="Stop watching this? Bops stops checking it."
          action="Stop"
          doing="Stopping…"
          busy={busy === "remove"}
          onConfirm={() => void run("remove", `/api/watches?id=${encodeURIComponent(w.id)}`, {}, "DELETE")}
          onCancel={cancelRemove}
        />
      ) : (
        <div className="-ml-2.5 flex flex-wrap items-center gap-0.5">
          {(isScreenWatch(w) || !!w.mac) && (
            <button onClick={onShow} disabled={!!busy} className={small("plain")}>
              Show it
            </button>
          )}
          <button onClick={check} disabled={!!busy || !!w.paused} className={small("plain")}>
            {busy === "check" ? "Checking…" : "Check now"}
          </button>
          <button onClick={() => void run("toggle", "/api/watches", { id: w.id, action: w.paused ? "resume" : "pause" }, "PATCH")} disabled={!!busy} className={small("plain")}>
            {w.paused ? "Resume" : "Pause"}
          </button>
          <button ref={removeButton} onClick={() => setSure(true)} disabled={!!busy} className={small("red")}>
            Stop
          </button>
        </div>
      )}
      <ErrorLine text={error} />
      {found && !error && !busy && (
        <span role="status" className="text-[12.5px] leading-4 text-[#6B6B6B]">
          {found}
        </span>
      )}
    </PageRow>
  );
}
