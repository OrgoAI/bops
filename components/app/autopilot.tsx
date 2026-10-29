"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type AnimationEvent, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { describeSchedule, whenText } from "@/cloud/schedule";
import { appNameFor, canonicalApp, CHECK_TEMPLATE, CHECK_TIMES, sameApp, templateById } from "@/lib/routine-catalog";
import { botChatId, computerWait, DISPLAYS, isScreenWatch, onceDone, runningNow, waitingAsks, type AppState, type Bot, type Delivery, type Routine, type RoutineRun, type RoutineSource, type Session, type Watch } from "@/lib/types";
import { you, your, yourMac } from "@/lib/shared";
import { Fold } from "./fold";
import { Mascot } from "./mascot";
import {
  arrived,
  Chevron,
  DeleteX,
  FIRST,
  focusAfterRemove,
  InlineConfirm,
  QuestionScope,
  since,
  small,
  undash,
  usePop,
  useQuestion,
} from "./side-group";
import { watchName } from "./watch-overlay";
import { AppLogo, BotChip, botApps, rowTrashBtn, TrashIcon } from "./apps";
import { asCadence, asSchedule, CadencePicker, sameCadence, suggestedOf, tidy, type Cadence } from "./cadence-picker";
import { CloseButton, currentWorkspace, needsYou, post, ReadOnlyLine, teamOf } from "./ui";
import { FooterButton } from "./sidebar-footer";
import { deleteQuestion, RoutineWeek, useClock, weekPlan, WeekLegend, WeekLetters } from "./routine-week";
import { ReportsSheet } from "./routine-reports";
import { BRAND } from "@/lib/brand";

/*
 * Routines: what the workspace's bots do on their own, and how. Schedules (routines: a reminder, a turn
 * in the chat, or a task on a computer, at set times) and Monitors (watches: a bot's screen, a window on the
 * user's Mac, or a web page with no screen). One bot owns each. How a bot does a kind of job is a skill
 * now, in Skills, in Knowledge (skills.tsx). In the sidebar, a round button in the footer beside Knowledge
 * (AutopilotButton), and the matches while it searches (AutopilotSections); on the right, a page with
 * every bot's in one list, each row ending with the bot that runs it and a trash that deletes it (asked
 * once more in place), filtered by bot, Connected App or what needs the user, each opening in place with
 * what can be done to it, first, then what it does and how it went (AutopilotPage), and what to ask
 * for while there's nothing (RoutinesEmpty). A bot's own, in short, are on its profile too (routines.tsx).
 * All read the app's state (useAppState), so they're as current as everything else. (Called Autopilot
 * before; the code keeps the name.)
 */

export type AutopilotSection = "schedules" | "monitors";

/** Open the page on the right (bops-app.tsx): at a section, at one of its rows, and at one bot's. */
export type AutopilotOpen = { section: AutopilotSection; focus?: string; bot?: string };

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

/**
 * When a schedule runs next ("Tomorrow 9 AM"), or that it's running now (really: runningNow), paused, or done;
 * or, while its bot's computer is down or asleep with it overdue, that it waits and why ("Waiting: Max's
 * computer is stopped", computerWait): it runs there once the computer is up.
 */
export function nextWords(r: Routine, state: Pick<AppState, "sessions" | "bots" | "runners" | "workspaces">, tz?: string) {
  if (runningNow(r, state.sessions)) return "Running now";
  if (done(r)) return "Done";
  if (!r.enabled) return "Paused";
  const wait = computerWait(state, r);
  if (wait) return `Waiting: ${wait}`;
  return r.nextRunAt ? whenText(r.nextRunAt, Date.now(), tz) : describeSchedule(r.schedule, tz);
}

/** "today 9 AM", "Tue 9 AM": when a time is, inside a sentence. */
const clockWords = (t: number, tz?: string) => whenText(t, Date.now(), tz).replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase());

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
 * (an app action to approve, a sign-in, a question). Never in a shared workspace: what's wrong there
 * waits on its owner, never the viewer (no Needs you filter, count or row note).
 */
export function scheduleNeedsYou(r: Routine, state: AppState) {
  if (state.shared) return false;
  if (trouble(r)) return true;
  // A chat run of it paused for the user's OK (its request names the routine and no thread).
  if (waitingAsks(state).some((a) => a.routineId === r.id && !a.threadId)) return true;
  const sid = r.last?.sessionId;
  if (!sid) return false;
  if (waitingAsks(state, sid).length) return true;
  const s = state.sessions.find((x) => x.id === sid);
  return !!s && needsYou(s);
}

/** A monitor needs the user when its page couldn't be read (news is its own mark, New). Never in a shared workspace (scheduleNeedsYou). */
export const monitorNeedsYou = (w: Watch, state?: Pick<AppState, "shared">) => !state?.shared && !!w.page?.error && !w.paused;

/** A Connected App's or a key's name as the user knows it: from their accounts or the catalog ("Stripe"), else its slug, capitalized. */
export function appNameOf(state: AppState, app: string) {
  return state.accounts?.find((a) => a.app === app)?.appName ?? appNameFor(app) ?? app.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * What a Connected App's check looks at, as the question before it's deleted says it: the app, with its
 * account's label (else its name, when the app has another account), since How often is the account's.
 */
export function checkedOf(state: AppState, source: RoutineSource) {
  const app = appNameOf(state, source.app);
  const account = state.accounts?.find((a) => a.id === source.account);
  if (!account || account.id.startsWith("open:")) return app;
  const another = (state.accounts ?? []).some((a) => a.id !== account.id && sameApp(a.app, account.app));
  const which = account.label?.trim() || (another ? account.name?.trim() : "");
  return which ? `${app} (${which})` : app;
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
        <span key={t} className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11.5px] leading-4 text-[color:var(--c-3a3a38)]">
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
  const to = [`${BRAND.name} chat`];
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
/** How a run went, as a viewer reads it: a quiet run had nothing for the owner in a workspace shared with them (lib/shared.ts you). */
const ranWords = (status: RoutineRun["status"], state: AppState) => (status === "quiet" ? `Ran, nothing for ${you(state)}` : RAN[status]);

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
  if (w.mac) return `${w.mac.app} on ${yourMac(state)}`;
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
    return `Couldn't reach ${BRAND.name}. Try again.`;
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
 * How many monitors have news, and where Routines opens: on monitors while one has news (at the first
 * with news, which the list puts first, as a monitor's own row opens it), else on the first section with
 * something in it. For Routines in the account menu (sidebar.tsx) and its round button.
 */
export function routinesEntry(state: AppState): { news: number; open: AutopilotOpen } {
  const lists = autopilotOf(state);
  const news = lists.monitors.filter((w) => w.alert).length;
  const section: AutopilotSection = news ? "monitors" : (SECTIONS.find((s) => lists[s.id].length)?.id ?? "schedules");
  return { news, open: { section, focus: news ? lists.monitors.find((w) => w.alert)?.id : undefined } };
}

/**
 * Routines in the sidebar's footer, beside Knowledge: a round button that opens the page (one tab per
 * workspace), with how many monitors have news on it while some do (it pops in when news comes). The
 * pill, with its name, while the page is open (sidebar-footer.tsx).
 */
export function AutopilotButton({ state, expanded = false, pressed = expanded, onOpen }: { state: AppState; expanded?: boolean; pressed?: boolean; onOpen: (open: AutopilotOpen) => void }) {
  const { news, open } = routinesEntry(state);
  return (
    <FooterButton
      name="routines"
      expanded={expanded}
      pressed={pressed}
      label={GROUP_NAME}
      tip={news ? `${GROUP_NAME}: ${news === 1 ? "a monitor has" : `${news} monitors have`} news` : `${GROUP_NAME}: what ${your(state)} bots do on their own`}
      ariaLabel={news ? `${GROUP_NAME}, ${news} with news` : GROUP_NAME}
      onClick={() => onOpen(open)}
      icon={<AutopilotIcon size={16} />}
      badge={
        news > 0 && (
          <span key={news} className="motion-dot-in pointer-events-none absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-highlighter px-1 text-[11px] font-semibold leading-none tabular-nums text-ink shadow-[0_0_0_2px_var(--c-f9f9f8)]">
            {news}
          </span>
        )
      }
    />
  );
}

/**
 * Routines while the sidebar searches: one row with the count of matches (and New while a matching
 * monitor has news) that opens the page, and the matches under it (up to five). None, and it's gone.
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
  // One row, and what comes next under it: monitors with news, then the soonest
  // schedules, then the other monitors. Nothing under it while there are none (the page says how).
  const next = [
    ...monitors.filter((w) => w.alert).map((w) => <MonitorLine key={w.id} watch={w} onClick={() => onOpenWatch(w)} readOnly={!!state.shared} />),
    ...schedules.map((r) => <ScheduleLine key={r.id} routine={r} state={state} tz={tz} onClick={() => onOpen({ section: "schedules", focus: r.id })} />),
    ...monitors.filter((w) => !w.alert).map((w) => <MonitorLine key={w.id} watch={w} onClick={() => onOpenWatch(w)} readOnly={!!state.shared} />),
  ];
  const max = q ? FIRST : 3;
  const first = SECTIONS.find((s) => lists[s.id].length)?.id ?? "schedules";
  return (
    <div className="flex flex-col pt-3">
      <button onClick={() => onOpen({ section: first })} className={SIDE_HEAD}>
        <span className="text-[color:var(--c-6b6b6b)]">
          <AutopilotIcon id="schedules" />
        </span>
        <span className="flex-1">{GROUP_NAME}</span>
        {news > 0 && <NewPill />}
        {total > 0 && <span className="tabular-nums font-normal text-[color:var(--c-9a9a98)]">{total}</span>}
      </button>
      {next.slice(0, max)}
      {next.length > max && (
        <button onClick={() => onOpen({ section: first })} className={`${SIDE_ROW} text-[13px] leading-[18px] text-[color:var(--c-6b6b6b)] hover:text-ink`}>
          Show all {next.length}
        </button>
      )}
    </div>
  );
}

/** A row in the sidebar's pinned box, while it searches: Routines. */
export const SIDE_HEAD =
  "flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[13px] font-medium leading-4 text-[color:var(--c-3a3a38)] outline-none hover:bg-black/[0.04] focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)]";

const SIDE_ROW =
  "flex h-[30px] shrink-0 items-center gap-2 rounded-[10px] pl-8 pr-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)]";

/** A schedule in the sidebar: its name, then when it runs next (or Paused, Done) and "quiet" in grey; a red dot when its last run or delivery failed. */
function ScheduleLine({ routine: r, state, tz, onClick }: { routine: Routine; state: AppState; tz?: string; onClick: () => void }) {
  const fresh = useFresh(r.id);
  const bad = trouble(r);
  const line = [nextWords(r, state, tz), r.quiet ? "quiet" : ""].filter(Boolean).join(" · ");
  return (
    <button onClick={onClick} onAnimationEnd={fresh.done} className={`${SIDE_ROW} ${fresh.on ? "motion-new-item" : ""}`}>
      <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px]">
        <span className={r.enabled ? "text-ink" : "text-[color:var(--c-9a9a98)]"}>{undash(r.title)}</span>
        <span className="text-[color:var(--c-9a9a98)]">
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
function MonitorLine({ watch: w, onClick, readOnly }: { watch: Watch; onClick: () => void; readOnly?: boolean }) {
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
        <span className={off ? "text-[color:var(--c-9a9a98)]" : "text-ink"}>{watchName(w)}</span>
        <span className="text-[color:var(--c-9a9a98)]">
          {" · "}
          {undash(w.lookFor)}
        </span>
      </span>
      {w.alert ? (
        <NewPill pop={pop.pop} onAnimationEnd={pop.done} />
      ) : error && !w.paused ? (
        <TroubleDot tip={`Couldn't read the page: ${undash(error)}`} />
      ) : (
        off && <span className="shrink-0 text-[12px] text-[color:var(--c-9a9a98)] group-hover/watch:hidden group-has-[:focus-visible]/watch:hidden group-focus-visible/watch:hidden">Paused</span>
      )}
      {!readOnly && (
        <DeleteX
          label={`Stop watching ${watchName(w)}`}
          onDelete={() => void post(`/api/watches?id=${encodeURIComponent(w.id)}`, {}, "DELETE")}
          className="group-hover/watch:opacity-100 group-focus-visible/watch:opacity-100"
        />
      )}
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
    monitors: lists.monitors.filter((w) => (!f.bot || w.botId === f.bot) && (!f.app || (!!w.source && sameApp(w.source.app, f.app))) && (!f.needsYou || monitorNeedsYou(w, state))),
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
      className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium leading-4 outline-none transition-colors duration-150 ease-out focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] motion-reduce:transition-none ${on ? "bg-ink text-white" : "bg-[color:var(--c-f2f2f0)] text-[color:var(--c-3a3a38)] hover:bg-[color:var(--c-eaeae7)]"}`}
    >
      {children}
    </button>
  );
}

/**
 * Schedules then monitors, one card (on the Routines page, or an app's in the Vault): each row opens in
 * place. Opening a page's news is seeing it (a screen's is seen where it shows: Show it). `chips`: each
 * row ends with the bot that runs it as a chip, as a key's row says its bots (the page's one list), in
 * place of its mascot before the name.
 */
export function RoutineList({
  state,
  schedules,
  monitors,
  openId,
  onToggle,
  onOpenWatch,
  onReport,
  chips = false,
  className = "shadow-[0_0_0_1px_var(--c-ececea)]",
}: {
  state: AppState;
  schedules: Routine[];
  monitors: Watch[];
  openId: string | null;
  onToggle: (id: string) => void;
  onOpenWatch: (w: Watch) => void;
  /** A schedule's reports (the Routines page's sheet), at one of its runs (its start) when given; `from`: where focus goes back. */
  onReport?: (id: string, at?: number, from?: HTMLElement) => void;
  chips?: boolean;
  className?: string;
}) {
  const tz = state.owner?.timeZone;
  const n = schedules.length + monitors.length;
  if (!n) return null;
  return (
    <div className={`flex flex-col overflow-hidden rounded-2xl ${className}`}>
      {schedules.map((r, i) => (
        <ScheduleRow
          key={r.id}
          routine={r}
          state={state}
          tz={tz}
          chip={chips}
          last={i === n - 1}
          open={openId === r.id}
          onToggle={() => onToggle(r.id)}
          onReport={onReport && ((at, from) => onReport(r.id, at, from))}
        />
      ))}
      {monitors.map((w, i) => (
        <MonitorRow
          key={w.id}
          watch={w}
          state={state}
          chip={chips}
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

/** Things to ask a bot for, to start from: each goes in its message box to change before it's sent. */
const ASKS = ["Every weekday at 8:30, summarize my inbox", "Every Friday at 5 PM, send me what we did this week", "Watch a page and tell me when the price drops"];

/** The bot to ask in RoutinesEmpty, while it has a chat to put the words in (else no asks, rather than another bot's chat). */
export const askable = (state: AppState, b?: Bot) => (b && state.chats.some((c) => c.id === botChatId(b.id)) ? b : undefined);

/**
 * Nothing runs yet: a bot's (its Routines tab, or the one picked on the page) or the whole workspace's.
 * Its mascot (the workspace's: its main bot's), what to ask for, and the way to start: `children` when
 * there's something to offer (a bot's Connected Apps with starter routines), else a few asks that open
 * `asks`'s chat with one in the message box, not sent. No Ask button: the chat is right there.
 */
export function RoutinesEmpty({ bot, asks, onAsk, children }: { bot?: Bot; asks?: Bot; onAsk?: (botId: string, text?: string) => void; children?: ReactNode }) {
  const face = bot ?? (asks?.isMain ? asks : undefined);
  return (
    <div data-empty className="flex flex-col items-center gap-3 py-10 text-center">
      <Mascot botId={face?.id ?? "boppy"} color={face?.color ?? "#0A0A0A"} size={52} />
      <span className="flex max-w-[340px] flex-col gap-1">
        <span className="text-[15px] font-semibold leading-5 text-ink">{bot ? `${bot.name} has no routines yet` : "No routines yet"}</span>
        <span className="text-[13.5px] leading-5 text-[color:var(--c-6b6b6b)]">{`Ask ${bot ? bot.name : "a bot"} to do something on a schedule, or to watch a page`}</span>
      </span>
      {/* What it offers, else the asks. */}
      {children ||
        (asks && onAsk && (
          <div role="group" aria-label="Things to ask" className="flex max-w-[440px] flex-wrap justify-center gap-1.5 pt-1">
            {ASKS.map((a) => (
              <button
                key={a}
                onClick={() => onAsk(asks.id, a)}
                data-tip={`Opens ${asks.name}'s chat with this typed, not sent`}
                className="rounded-full bg-[color:var(--c-f2f2f0)] px-3 py-1.5 text-[12.5px] leading-4 text-[color:var(--c-3a3a38)] outline-none transition-colors duration-150 ease-out hover:bg-[color:var(--c-eaeae7)] focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] motion-reduce:transition-none"
              >
                {a}
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * Routines as a page on the right (one tab per workspace): every bot's schedules and monitors in one
 * list, as the Vault lists keys, each row ending with the bot that runs it and opening in place to say
 * how it works and how it went, with what can be done to it. Filters: a bot (a row of every bot with how
 * many each runs, on top, which is the week's legend too: whose each color is; `bot` picks one when the
 * page is asked for at it, from a bot's profile), a Connected App they came from, and Needs you (a failed
 * run or delivery, a run waiting on the user, a page that can't be read). Nothing yet, for the workspace
 * or the bot picked: what to ask for, and a way to ask (RoutinesEmpty). How a bot does each job is a
 * skill: a link goes there. A run in the week (its line), or a row's Reports (its Last run's See report),
 * opens that routine's reports over the page (routine-reports.tsx): every run and what each said.
 */
export function AutopilotPage({
  state,
  focus,
  focusAt,
  bot,
  onBot,
  onOpenWatch,
  onOpenSkills,
  onAsk,
  onOpenThread,
  onClose,
}: {
  state: AppState;
  focus?: string;
  focusAt?: number;
  /**
   * The bot whose to show: the one the page was asked for at (a new one with focusAt, none for all), and
   * after that the one the user picked, kept on the tab (onBot) so coming back to it shows the same.
   */
  bot?: string;
  /** The bot shown changed on the page (picked, cleared): keep it on the tab. */
  onBot: (bot?: string) => void;
  /** Show a watched screen or Mac window (bops-app.tsx showWatch). */
  onOpenWatch: (w: Watch) => void;
  /** Skills, in Knowledge, where procedures went. */
  onOpenSkills: () => void;
  /** Ask a bot: its chat, with `text` in the message box to change and send (bops-app.tsx askBot). */
  onAsk: (botId: string, text?: string) => void;
  /** Open a routine run's thread (bops-app.tsx openThread), from its report. */
  onOpenThread?: (s: Session) => void;
  onClose: () => void;
}) {
  // "Tomorrow 9 AM", "5m ago" stay current.
  const now = useClock(30_000);
  const all = autopilotOf(state);
  const team = teamOf(state);
  // The filter asked for (the bot's, or the one there was), unless it hides the row asked for: then none, so that row shows.
  const fit = (f: RoutineFilter): RoutineFilter => {
    if (!focus) return f;
    const s = filterRoutines(state, all, f);
    return [...s.schedules, ...s.monitors].some((x) => x.id === focus) ? f : {};
  };
  const [filter, setFilter] = useState<RoutineFilter>(() => fit(bot ? { bot } : {}));
  // A routine picked in the week opens below, as one asked for from outside does.
  const [picked, setPicked] = useState<{ id: string; at: number } | null>(null);
  const [askedAt, setAskedAt] = useState(focusAt);
  if (askedAt !== focusAt) {
    setAskedAt(focusAt);
    setPicked(null);
    // Asked again at the same bot (a row's link): the filters stay; at another bot, or all: just that.
    setFilter(fit(bot === filter.bot ? filter : bot ? { bot } : {}));
  }
  // The tab keeps the bot shown, for when the page comes back.
  useEffect(() => {
    if (filter.bot !== bot) onBot(filter.bot);
  }, [filter.bot, bot, onBot]);
  // A bot since deleted shows as none picked.
  const botOn = team.some((b) => b.id === filter.bot) ? filter.bot : undefined;
  const shown = filterRoutines(state, all, { ...filter, bot: botOn });
  const want = picked ?? (focus ? { id: focus, at: focusAt } : null);
  const there = !!want && [...shown.schedules, ...shown.monitors].some((x) => x.id === want.id);
  const { openId, toggle, list } = useOpenRow(want?.id, want?.at, there);
  const tz = state.owner?.timeZone;
  const zone = useCallback((r: Routine) => zoneOf(r, tz), [tz]);
  // The Connected Apps and Needs you for the bot shown (all of them: every bot's); one that's on stays, to turn off.
  const ofBot = filterRoutines(state, all, { bot: botOn });
  const apps = [...new Set([...sourceApps(ofBot), ...(filter.app ? [filter.app] : [])])];
  const needs = filterRoutines(state, ofBot, { needsYou: true });
  const needsN = needs.schedules.length + needs.monitors.length;
  const total = all.schedules.length + all.monitors.length;
  // How many each bot runs, for the row of bots.
  const counts = Object.fromEntries(team.map((b) => [b.id, all.schedules.filter((r) => r.botId === b.id).length + all.monitors.filter((w) => w.botId === b.id).length]));
  const pickedBot = botOn ? team.find((b) => b.id === botOn) : undefined;
  // Asks for the whole workspace go to its main bot.
  const main = team.find((b) => b.isMain) ?? team[0];
  // Each row's bot as a chip only while more than one bot's are shown (one bot's: its mascot leads).
  const chips = team.length > 1 && !pickedBot;
  const week = shown.schedules.length > 0;
  const appFilters = total > 0 && (apps.length > 0 || needsN > 0 || !!filter.needsYou);
  // A routine's reports, over the page (routine-reports.tsx), at a run when one was picked; focus goes back where it was opened from.
  const [report, setReport] = useState<{ id: string; at?: number; key: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const reported = report ? state.routines.find((r) => r.id === report.id) : undefined;
  const openReport = (id: string, at?: number, from?: HTMLElement) => {
    const had = document.activeElement as HTMLElement | null;
    opener.current = from ?? (had && had !== document.body && typeof had.focus === "function" ? had : null);
    setReport({ id, at, key: Date.now() });
  };
  const closeReport = useCallback(() => {
    // Back where it was opened from, unless focus has moved out of the sheet since (into the chat beside the page).
    const had = document.activeElement;
    const back = !had || had === document.body || !!had.closest('[role="dialog"]');
    flushSync(() => setReport(null));
    if (back && opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Behind the reports while they're open: nothing here takes focus or a click. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7" inert={!!reported}>
        <div className="flex w-full max-w-[560px] flex-col gap-5">
          {/* A shared workspace's routines are the owner's: shown, never changed here (view-only.ts holds every change). */}
          <ReadOnlyLine state={state} />
          <div className="flex items-start gap-3.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
              <AutopilotIcon size={20} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {/* Where focus goes when the last routine is deleted (focusAfterRemove). */}
              <span data-list-heading tabIndex={-1} className="text-[20px] font-semibold leading-6 tracking-[-0.01em] outline-none">
                {GROUP_NAME}
              </span>
              <span className="text-[13px] leading-[19px] text-[color:var(--c-6b6b6b)]">
                {state.shared ? "What the owner's bots do on their own" : "What your bots do on their own"}. How they do each job is in{" "}
                {/* The link and its period together, so the period never starts a line on its own. */}
                <span className="whitespace-nowrap">
                  <button onClick={onOpenSkills} className="font-medium text-ink underline decoration-[color:var(--c-c9c9c6)] underline-offset-2 hover:decoration-ink">
                    Skills
                  </button>
                  .
                </span>
              </span>
            </div>
            <CloseButton onClick={onClose} className="mt-1.5" />
          </div>

          {(team.length > 1 || appFilters) && (
            <div className="flex flex-col gap-2">
              {/* Every bot, with how many each runs: whose each color in the week is, and which bot's to show. */}
              {team.length > 1 && <WeekLegend bots={team} on={botOn} counts={counts} all={total} onPick={(bot) => setFilter({ ...filter, bot })} />}
              {appFilters && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={state.shared ? "Connected App" : "Connected App and Needs you"}>
                  {(needsN > 0 || filter.needsYou) && (
                    <FilterPill on={!!filter.needsYou} onClick={() => setFilter({ ...filter, needsYou: !filter.needsYou })}>
                      Needs you
                      <span className={`tabular-nums ${filter.needsYou ? "text-white/60" : "text-[color:var(--c-9a9a98)]"}`}>{needsN}</span>
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

          {/* One remove question at a time, in the week or the list; opening a row, or another filter, closes it. */}
          <QuestionScope reset={`${openId ?? ""}|${botOn ?? ""}|${filter.app ?? ""}|${filter.needsYou ? 1 : 0}`}>
            {week && (
              <RoutineWeek
                routines={shown.schedules}
                // One bot's: its lines needn't say its name.
                bots={pickedBot ? [pickedBot] : team}
                tz={tz}
                now={now}
                zoneOf={zone}
                running={(r) => runningNow(r, state.sessions)}
                needsYou={(r) => scheduleNeedsYou(r, state)}
                checked={(x) => checkedOf(state, x)}
                onOpen={(id) => setPicked({ id, at: Date.now() })}
                onReport={openReport}
                viewOnly={!!state.shared}
              />
            )}

            <div ref={list} data-rows className="flex flex-col gap-5">
              {pickedBot && !counts[pickedBot.id] ? (
                <RoutinesEmpty bot={pickedBot} asks={askable(state, pickedBot)} onAsk={onAsk} />
              ) : !total ? (
                <RoutinesEmpty asks={askable(state, main)} onAsk={onAsk} />
              ) : !shown.schedules.length && !shown.monitors.length ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center text-[13.5px] leading-5 text-[color:var(--c-6b6b6b)]">
                  Nothing matches these filters
                  <button onClick={() => setFilter({})} className={small("plain")}>
                    Show all
                  </button>
                </div>
              ) : (
                // One list, in its order, each row with the bot that runs it (the row of bots above picks one).
                <RoutineList state={state} schedules={shown.schedules} monitors={shown.monitors} openId={openId} onToggle={toggle} onOpenWatch={onOpenWatch} onReport={openReport} chips={chips} />
              )}
            </div>
          </QuestionScope>
        </div>
      </div>
      {reported && report && <ReportsSheet key={report.key} state={state} routine={reported} at={report.at} onClose={closeReport} onOpenThread={onOpenThread} />}
    </div>
  );
}

/*
 * A row's trash sits where its chevron is, over the end of the button that opens the row, and the chevron
 * gives way while it shows (hover, keyboard focus), so the name keeps all its room the rest of the time. On
 * a touch screen it always shows: the button keeps room for it there, with the chevron before it.
 */
const TRASH_SHOWS =
  "opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100";
const CHEVRON_GIVES_WAY =
  "transition-opacity duration-150 ease-out group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0 motion-reduce:transition-none [@media(hover:none)]:!opacity-100";
const TOUCH_ROOM = "[@media(hover:none)]:pr-[42px]";

/**
 * A row on the page: its name and a line, opening in place (one at a time) to its actions and details,
 * rendered once first opened. `editing` takes the row's place while it's changed in place. `remove`: a
 * trash at the row's end, on the chevron's place and not in the button that opens the row, as on the
 * Vault's key rows: shown on hover and keyboard focus, always on a touch screen. `confirm`: the question
 * it asks, in place under the row's head, open or not.
 */
function PageRow({
  id,
  lead,
  title,
  line,
  dim,
  end,
  last,
  open,
  onToggle,
  editing,
  remove,
  confirm,
  rowRef,
  children,
}: {
  id: string;
  /** Before the name: the row's bot (BotMark). */
  lead?: ReactNode;
  title: string;
  line?: string;
  dim?: boolean;
  end?: ReactNode;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  editing?: ReactNode;
  remove?: { label: string; tip: string; busy: boolean; onAsk: (from: HTMLElement) => void };
  confirm?: ReactNode;
  /** The row itself (where focus goes after it's deleted is worked out from it). */
  rowRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const fresh = useFresh(id);
  return (
    <div ref={rowRef} data-item={id} onAnimationEnd={fresh.done} className={`flex flex-col ${last ? "" : "border-b border-[color:var(--c-f0f0ee)]"} ${fresh.on ? "motion-new-item" : ""}`}>
      {editing ? (
        <div className="px-3.5 py-3">{editing}</div>
      ) : (
        <div className="group/row relative flex items-start">
          <button
            data-row-head
            onClick={onToggle}
            aria-expanded={open}
            className={`flex min-w-0 flex-1 items-start gap-3 py-3 pl-3.5 pr-3.5 text-left outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)] ${remove ? TOUCH_ROOM : ""}`}
          >
            {lead && <span className={`flex shrink-0 pt-px ${dim ? "opacity-50" : ""}`}>{lead}</span>}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`truncate text-[14px] font-medium leading-[18px] ${dim ? "text-[color:var(--c-9a9a98)]" : "text-ink"}`}>{title}</span>
              {line && <span className={`text-[12.5px] leading-[17px] text-[color:var(--c-6b6b6b)] ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>{line}</span>}
            </span>
            {end && <span className="flex shrink-0 items-center gap-1.5 pt-px">{end}</span>}
            <span className={`pt-[3px] text-[color:var(--c-b0b0ad)] ${remove ? CHEVRON_GIVES_WAY : ""}`}>
              <Chevron open={open} />
            </span>
          </button>
          {remove && (
            <span className={`absolute right-1.5 top-2 flex ${TRASH_SHOWS}`}>
              <button type="button" data-row-trash onClick={(e) => remove.onAsk(e.currentTarget)} disabled={remove.busy} aria-label={remove.label} data-tip={remove.tip} className={rowTrashBtn}>
                <TrashIcon />
              </button>
            </span>
          )}
        </div>
      )}
      {confirm && <div className="flex flex-col gap-1.5 px-3.5 pb-3">{confirm}</div>}
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
            <dt className="text-[color:var(--c-9a9a98)]">{k}</dt>
            <dd className="min-w-0 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">{v}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

/** About this many characters, or lines, fill the four a clamped Words shows (it measures once it's on screen). */
const LONG_WORDS = 280;
const looksLong = (text: string) => text.length > LONG_WORDS || text.split("\n").length > 4;

/**
 * Words written for or by a bot (an ask, steps), as they were written: their line breaks kept. `clamp`:
 * the first four lines, with Show all when there's more (and Show less after).
 */
function Words({ label, text, clamp = false }: { label: string; text: string; clamp?: boolean }) {
  const [all, setAll] = useState(false);
  // Whether there's more than four lines: a guess from its length, then measured once it's laid out.
  const [more, setMore] = useState(() => clamp && looksLong(text));
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!clamp || all || !el) return;
    const measure = () => {
      // Not laid out (no height yet): the guess stands.
      if (el.clientHeight) setMore(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [clamp, all, text]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium leading-4 text-[color:var(--c-9a9a98)]">{label}</span>
      <span className="rounded-xl bg-[color:var(--c-f7f7f6)] px-3 py-2 text-[13px] leading-[19px] text-[color:var(--c-3a3a38)]">
        <span ref={box} className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${clamp && !all ? "line-clamp-4" : "block"}`}>
          {undash(text)}
        </span>
      </span>
      {clamp && more && (
        <button
          onClick={() => setAll(!all)}
          aria-expanded={all}
          className="self-start text-[12px] font-medium leading-4 text-ink underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {all ? "Show less" : "Show all"}
        </button>
      )}
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

/** What the When picker needs for a routine: its starter's suggested times (a check's How often), and whether its bot uses Google Calendar. */
function whenContext(r: Routine, state: AppState) {
  const bot = state.bots.find((b) => b.id === r.botId);
  return {
    presets: r.source?.template ? suggestedOf(r.source.template === CHECK_TEMPLATE ? { suggested: CHECK_TIMES } : templateById(r.source.template)) : undefined,
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
  const field = "w-full rounded-xl bg-[color:var(--c-f7f7f6)] px-3 py-2 text-[13px] leading-[18px] outline-none focus:bg-white focus:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]";
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
        <span className="text-[11.5px] font-medium leading-4 text-[color:var(--c-9a9a98)]">Name</span>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium leading-4 text-[color:var(--c-9a9a98)]">What it does</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} className={`${field} resize-none`} />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium leading-4 text-[color:var(--c-9a9a98)]">When</span>
        <CadencePicker value={when.schedule} onChange={when.setSchedule} zone={when.zone} ownerZone={tz} onZone={when.setZone} presets={ctx.presets} calendar={ctx.calendar} disabled={busy} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-[12.5px] leading-4 text-[color:var(--c-3a3a38)]">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} className="size-3.5 accent-[color:var(--c-0a0a0a)]" />
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

/** A row's bot: its mascot, saying its name on hover (one that's gone: a grey circle). */
function BotMark({ bot }: { bot?: Bot }) {
  if (!bot) return <span className="size-6 rounded-full bg-[color:var(--c-ececea)]" />;
  return (
    <span role="img" aria-label={bot.name} data-tip={bot.name} className="flex">
      <Mascot botId={bot.id} color={bot.color} size={24} antenna={false} />
    </span>
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
type Busy = null | "run" | "toggle" | "skip" | "unskip" | "check" | "remove" | "save";

/**
 * What a row's actions share: which one is on its way, what went wrong, and the remove question (asked
 * once more in place, under the row's head, from its trash or from Delete or Stop inside it; one at a
 * time in the list, closed as a row opens or shuts: QuestionScope). `run` sends one and says how it went;
 * `remove` sends the remove, and once it's done focus goes to the next row (else the one before, else the
 * list's heading: focusAfterRemove); refused, why shows under the question.
 */
function useActions(kind: "schedule" | "monitor", id: string, open: boolean) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const question = useQuestion(kind);
  const sure = question.on === id;
  // The row (PageRow's), Delete or Stop inside it, and which asked: the row's trash, or that one
  // ("inside", gone while the question shows, so it's found again by its ref), where focus goes back on Cancel.
  const row = useRef<HTMLDivElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const asked = useRef<HTMLElement | "inside" | null>(null);
  const run = async (what: Exclude<Busy, null>, url: string, body: unknown, method: string, answered?: (json: unknown) => string | null) => {
    setBusy(what);
    setError(null);
    const e = await send(url, body, method, answered);
    setBusy(null);
    setError(e);
    return !e;
  };
  const ask = (from: HTMLElement | "inside") => {
    asked.current = from;
    setError(null);
    question.ask(id);
  };
  const cancelRemove = () => {
    // Back where it was asked: focus returns to the button (it's back on screen once this renders). Asked
    // inside a row that has shut since (its details can't take focus then): the row's trash.
    flushSync(() => question.close(id));
    (asked.current !== "inside" ? asked.current : open ? removeButton.current : row.current?.querySelector<HTMLElement>("[data-row-trash]"))?.focus();
  };
  const remove = async (url: string, body: unknown, method: string) => {
    const moveOn = focusAfterRemove(row.current, "[data-item]");
    if (!(await run("remove", url, body, method))) return;
    // Gone (the list drops the row as the state comes in, as every list does). Focus moves on only from
    // the question (or the page): asked somewhere else meanwhile, it stays there.
    const at = document.activeElement;
    const here = !at || at === document.body || !!row.current?.contains(at);
    flushSync(() => question.close(id));
    if (here) moveOn();
  };
  return { busy, error, setError, sure, ask, run, cancelRemove, remove, row, removeButton };
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span role="alert" className="text-[12.5px] leading-4 text-[#B42318]">
      {text}
    </span>
  );
}

/**
 * A schedule on the page: its bot (its mascot before the name, or with `chip` a chip at the end) and a
 * trash at the end; opened, Run now, Skip next, Pause or Resume, Edit and Delete first, then what it asks
 * (four lines, Show all for the rest), when and how it runs, where results go, how its last run and
 * delivery went. Deleting a Connected App's check says that app's How often goes back to Only when asked.
 */
export function ScheduleRow({
  routine: r,
  state,
  tz,
  chip = false,
  last,
  open,
  onToggle,
  onReport,
}: {
  routine: Routine;
  state: AppState;
  tz?: string;
  chip?: boolean;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  /** Its reports (every run, what each said), at one run (its start) when given; `from`: the button, where focus goes back. */
  onReport?: (at?: number, from?: HTMLElement) => void;
}) {
  const { busy, error, setError, sure, ask, run, cancelRemove, remove, row, removeButton } = useActions("schedule", r.id, open);
  const [editing, setEditing] = useState(false);
  // Changing only when it runs, in place on its When.
  const [changingWhen, setChangingWhen] = useState(false);
  if (!open && changingWhen) setChangingWhen(false);
  const bad = trouble(r);
  const zone = zoneOf(r, tz);
  const next = nextRunText(r, tz);
  const ran = r.last;
  const delivery = ran?.delivery;
  // Its coming week, for the days it runs (a minute is fine enough).
  const now = useClock(60_000);
  const minute = Math.floor(now / 60_000);
  const sig = JSON.stringify([minute, tz, zone, r.enabled, r.nextRunAt, r.schedule, r.skips, r.last?.at]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const week = useMemo(() => weekPlan([r], minute * 60_000, tz, () => zone), [sig]);
  const bot = state.bots.find((b) => b.id === r.botId);
  const color = bot?.color;
  const skips = (r.skips ?? []).filter((x) => x > now);
  const canSkip = r.enabled && r.nextRunAt !== undefined && r.schedule.kind !== "once" && r.schedule.kind !== "before_event";
  return (
    <PageRow
      id={r.id}
      lead={chip ? undefined : <BotMark bot={bot} />}
      title={undash(r.title)}
      line={`${describeSchedule(r.schedule, zone)} · ${nextWords(r, state, tz)}${r.quiet ? " · quiet" : ""}`}
      dim={!r.enabled}
      end={
        <>
          {r.enabled && <WeekLetters days={week} routineId={r.id} color={color} />}
          {r.source && <SourceMark state={state} app={r.source.app} />}
          {bad && <TroubleDot tip={bad} />}
          {chip && bot && <BotChip bot={bot} tip={`Runs as ${bot.name}`} />}
        </>
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
      rowRef={row}
      remove={state.shared ? undefined : { label: `Delete ${undash(r.title)}`, tip: "Delete", busy: !!busy, onAsk: ask }}
      confirm={
        sure && (
          <>
            <InlineConfirm
              text={deleteQuestion(r, false, (x) => checkedOf(state, x))}
              action="Delete"
              doing="Deleting…"
              busy={busy === "remove"}
              onConfirm={() => void remove("/api/routines", { id: r.id }, "DELETE")}
              onCancel={cancelRemove}
            />
            <ErrorLine text={error} />
          </>
        )
      }
    >
      {/* What can be done to it first, above what it does (often long). The question takes their place. A shared workspace's are the owner's to do; its reports are there to read. */}
      {!sure && state.shared && onReport && (
        <div className="-ml-2.5 flex flex-wrap items-center gap-0.5">
          <button onClick={(e) => onReport(undefined, e.currentTarget)} className={small("plain")}>
            Reports
          </button>
        </div>
      )}
      {!sure && !state.shared && (
        <div className="-ml-2.5 flex flex-wrap items-center gap-0.5">
          <button onClick={() => void run("run", "/api/routines", { id: r.id, action: "run" }, "PATCH")} disabled={!!busy || runningNow(r, state.sessions)} className={small("plain")}>
            {busy === "run" ? "Running…" : r.last?.status === "failed" ? "Run again" : "Run now"}
          </button>
          {canSkip && (
            <button
              onClick={() => void run("skip", "/api/routines", { id: r.id, action: "skip", at: r.nextRunAt }, "PATCH")}
              disabled={!!busy}
              data-tip={r.nextRunAt !== undefined ? `It won't run ${clockWords(r.nextRunAt, tz)}` : undefined}
              className={small("plain")}
            >
              {busy === "skip" ? "Skipping…" : "Skip next"}
            </button>
          )}
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
          {onReport && (
            <button onClick={(e) => onReport(undefined, e.currentTarget)} className={small("plain")}>
              Reports
            </button>
          )}
          <button ref={removeButton} onClick={() => ask("inside")} disabled={!!busy} className={small("red")}>
            Delete
          </button>
        </div>
      )}
      {!sure && <ErrorLine text={error} />}
      <Words label={r.reminder ? "The reminder" : "What it does"} text={r.reminder ?? r.goal} clamp />
      <Facts
        rows={[
          ["Bot", <BotName key="bot" bot={bot} />],
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
                {zone && zone !== tz ? <span className="text-[color:var(--c-9a9a98)]">{` (${zone.split("/").pop()?.replace(/_/g, " ")} time)`}</span> : null}
                {!done(r) && !state.shared && (
                  <button onClick={() => setChangingWhen(true)} disabled={!!busy} className="ml-1.5 text-[12px] font-medium leading-4 text-ink underline-offset-2 outline-none hover:underline focus-visible:underline disabled:opacity-40">
                    Change
                  </button>
                )}
              </span>
            ),
          ],
          [
            "Skipping",
            skips.length > 0 && (
              <span key="skipping" className="flex flex-wrap items-center gap-1">
                {skips.map((x) => (
                  <span key={x} className="inline-flex items-center gap-1 rounded-full bg-[color:var(--c-f2f2f0)] py-0.5 pl-2 pr-0.5 text-[12px] leading-4">
                    <span className="line-through decoration-[color:var(--c-9a9a98)]">{whenText(x, now, tz)}</span>
                    {!state.shared && (
                    <button
                      onClick={() => void run("unskip", "/api/routines", { id: r.id, action: "unskip", at: x }, "PATCH")}
                      disabled={!!busy}
                      aria-label={`Run at ${whenText(x, now, tz)} after all`}
                      className="rounded-full px-1.5 text-[11.5px] font-medium leading-4 text-ink hover:bg-white disabled:opacity-40"
                    >
                      Undo
                    </button>
                    )}
                  </span>
                ))}
              </span>
            ),
          ],
          ["Runs", howWords(r)],
          ["Quiet", r.quiet ? `Yes: it posts only when there's something for ${you(state)}` : ""],
          ["Results go to", destinations(r, state)],
          // Set up on someone else's say (an email or a text from outside): who, so the user can tell.
          ["Set up by", r.fromOutside ? undash(r.fromOutside) : ""],
          [
            "Last run",
            ran && (
              <span className="flex flex-col gap-0.5">
                <span>
                  {ranWords(ran.status, state)} · {since(ran.at)}
                  {onReport && (
                    <button onClick={(e) => onReport(ran.at, e.currentTarget)} className="ml-1.5 text-[12px] font-medium leading-4 text-ink underline-offset-2 outline-none hover:underline focus-visible:underline">
                      See report
                    </button>
                  )}
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
    </PageRow>
  );
}

/**
 * A monitor on the page: its bot (its mascot before the name, or with `chip` a chip at the end) and a
 * trash at the end that stops it; opened, Show it, Check now, Pause or Resume and Stop first, then what it
 * watches (a page opens in the browser), what for, how often and when it last looked, its news or trouble.
 */
export function MonitorRow({
  watch: w,
  state,
  chip = false,
  last,
  open,
  onToggle,
  onShow,
}: {
  watch: Watch;
  state: AppState;
  chip?: boolean;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  onShow: () => void;
}) {
  const { busy, error, sure, ask, run, cancelRemove, remove, row, removeButton } = useActions("monitor", w.id, open);
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
  const bot = state.bots.find((b) => b.id === w.botId);
  const checked = page?.checkedAt ?? w.readAt;
  const url = page && /^https?:\/\//i.test(page.url) ? page.url : null;
  return (
    <PageRow
      id={w.id}
      lead={chip ? undefined : <BotMark bot={bot} />}
      title={watchName(w)}
      line={undash(w.lookFor)}
      dim={!!w.paused || !!w.away}
      end={
        <>
          {w.source && <SourceMark state={state} app={w.source.app} />}
          {w.alert ? <NewPill /> : page?.error && !w.paused ? <TroubleDot tip={`Couldn't read the page: ${undash(page.error)}`} /> : null}
          {chip && bot && <BotChip bot={bot} tip={`Runs as ${bot.name}`} />}
        </>
      }
      last={last}
      open={open}
      onToggle={onToggle}
      rowRef={row}
      remove={state.shared ? undefined : { label: `Stop watching ${watchName(w)}`, tip: "Stop", busy: !!busy, onAsk: ask }}
      confirm={
        sure && (
          <>
            <InlineConfirm
              text={`Stop watching this? ${BRAND.name} stops checking it.`}
              action="Stop"
              doing="Stopping…"
              busy={busy === "remove"}
              onConfirm={() => void remove(`/api/watches?id=${encodeURIComponent(w.id)}`, {}, "DELETE")}
              onCancel={cancelRemove}
            />
            <ErrorLine text={error} />
          </>
        )
      }
    >
      {!sure && !state.shared && (
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
          <button ref={removeButton} onClick={() => ask("inside")} disabled={!!busy} className={small("red")}>
            Stop
          </button>
        </div>
      )}
      {!sure && <ErrorLine text={error} />}
      {found && !error && !busy && (
        <span role="status" className="text-[12.5px] leading-4 text-[color:var(--c-6b6b6b)]">
          {found}
        </span>
      )}
      <Facts
        rows={[
          ["Bot", <BotName key="bot" bot={bot} />],
          ["From", w.source && <AppName key="from" state={state} app={w.source.app} />],
          [
            "Watching",
            url ? (
              // Opens in the user's own browser (the Mac app hands new windows to it).
              <a key="url" href={url} target="_blank" rel="noreferrer" className="text-ink underline decoration-[color:var(--c-c9c9c6)] underline-offset-2 hover:decoration-ink">
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
          ["Paused", w.paused ? (state.shared ? "Yes, until the owner resumes it" : "Yes, until you resume it") : w.away ? "It isn't showing right now" : ""],
          [
            "News",
            w.alert && (
              <span className="flex flex-col gap-0.5">
                <span>{undash(w.alert.text)}</span>
                <span className="text-[color:var(--c-9a9a98)]">{since(w.alert.at)}</span>
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
    </PageRow>
  );
}
