"use client";

import { Fragment, useEffect, useRef, useState, type AnimationEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { describeSchedule, whenText } from "@/cloud/schedule";
import { DISPLAYS, isScreenWatch, MAX_PROCEDURE_CHARS, onceDone, PROCEDURE_NAME_MAX, PROCEDURE_WHEN_MAX, runningNow, type AppState, type Delivery, type Procedure, type Routine, type RoutineRun, type Session, type Watch } from "@/lib/types";
import { Fold } from "./fold";
import { Mascot } from "./mascot";
import {
  arrived,
  Chevron,
  Count,
  DeleteX,
  FIRST,
  InlineConfirm,
  OpenIcon,
  readGroupOpen,
  readSectionOpen,
  since,
  small,
  undash,
  usePop,
  writeGroupOpen,
  writeSectionOpen,
} from "./side-group";
import { watchName } from "./watch-overlay";
import { CloseButton, currentWorkspace, post, teamOf, useNow } from "./ui";

/*
 * Autopilot: what the workspace's bots do on their own, and how. Schedules (routines: a reminder, a turn
 * in the chat, or a task on a computer, at set times), Monitors (watches: a bot's screen, a window on the
 * user's Mac, or a web page with no screen) and Procedures (how a bot does one kind of job). In the
 * sidebar, a group pinned above Orbit with a section each that folds (AutopilotSections); on the right,
 * a page with every one of them, each opening in place with what can be done to it (AutopilotPage). Both
 * read the app's state (useAppState), so they're as current as everything else.
 */

export type AutopilotSection = "schedules" | "monitors" | "procedures";

/** Open the page on the right (bops-app.tsx): at a section, and at one of its rows. */
export type AutopilotOpen = { section: AutopilotSection; focus?: string };

const GROUP_NAME = "Autopilot";
/** Where this Mac keeps what's folded here (side-group.tsx): each section open until folded, like the group. */
const FOLDS = "autopilot";

const SECTIONS: { id: AutopilotSection; label: string; empty: string; how: string }[] = [
  { id: "schedules", label: "Schedules", empty: "Ask a bot to do something on a schedule", how: "Try: every weekday at 8:30, summarize my inbox" },
  { id: "monitors", label: "Monitors", empty: "Ask a bot to watch a page", how: "Try: watch this page and tell me when the price drops, with its link" },
  { id: "procedures", label: "Procedures", empty: "Save one from a chat's menu", how: "Or tell a bot: remember how you did that, for next time" },
];

/* ---------------- What's here ---------------- */

/** A one-time schedule whose time has passed: it's done, not paused (Run now before its time doesn't finish it). */
const done = (r: Routine) => onceDone(r);

/**
 * The workspace's schedules, monitors and procedures (its own bots' only), in the order both lists show
 * them. Schedules: the ones on first, the soonest run first, then the rest, the latest run first.
 * Monitors: news first, then the newest. Procedures: by name.
 */
export function autopilotOf(state: AppState) {
  const team = new Set(teamOf(state).map((b) => b.id));
  const schedules = state.routines
    .filter((r) => team.has(r.botId))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.enabled ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) : (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0)) || a.title.localeCompare(b.title));
  const monitors = (state.watches ?? []).filter((w) => team.has(w.botId)).sort((a, b) => Number(!!b.alert) - Number(!!a.alert) || b.since - a.since);
  const procedures = (state.procedures ?? []).filter((p) => team.has(p.botId)).sort((a, b) => a.name.localeCompare(b.name));
  return { schedules, monitors, procedures };
}

/** Whether any of these words has the search in it (lowercased; none: everything matches). */
const has = (q: string, ...words: (string | undefined)[]) => !q || words.some((w) => !!w && w.toLowerCase().includes(q));
const matchSchedule = (r: Routine, q: string) => has(q, r.title, r.goal, r.reminder);
const matchMonitor = (w: Watch, q: string) => has(q, watchName(w), w.site, w.lookFor, w.page?.url, w.mac?.app);
const matchProcedure = (p: Procedure, q: string) => has(q, p.name, p.whenToUse);

/* ---------------- Words ---------------- */

/** When a schedule runs next ("Tomorrow 9 AM"), or that it's running now (really: runningNow), paused, or done. */
function nextWords(r: Routine, sessions: Session[], tz?: string) {
  if (runningNow(r, sessions)) return "Running now";
  if (done(r)) return "Done";
  if (!r.enabled) return "Paused";
  return r.nextRunAt ? whenText(r.nextRunAt, Date.now(), tz) : describeSchedule(r.schedule, tz);
}

/** When an on schedule runs next, in words ("Tue 9 AM"), if it does. */
const nextRunText = (r: Routine, tz?: string) => (r.enabled && r.nextRunAt ? whenText(r.nextRunAt, Date.now(), tz) : null);

/** What went wrong last time, if anything: the run failed, or its result didn't reach where it goes. */
function trouble(r: Routine) {
  const last = r.last;
  if (last?.status === "failed") return `The last run failed${last.error ? `: ${undash(last.error)}` : ""}`;
  if (last?.delivery?.status === "failed") return `Couldn't send it to ${last.delivery.to}${last.delivery.error ? `: ${undash(last.delivery.error)}` : ""}`;
  return null;
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

const RAN: Record<RoutineRun["status"], string> = {
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
  procedures: (
    <>
      <path d="M6.6 4.4h6.4M6.6 8h6.4M6.6 11.6h4.2" />
      <path d="M3 4.4h.9M3 8h.9M3 11.6h.9" />
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
 * Autopilot in the sidebar, pinned above Orbit: a section each for Schedules, Monitors and Procedures,
 * from the start (blank ones say how to get one). The name folds the whole group and an arrow beside it
 * opens the page; each section counts what it has and lists its first five, open until the user folds
 * it (this Mac remembers both). Monitors keep the old Watching list's ways: the New mark (also on the
 * section, and on the group, while folded), Paused, and × to stop. While the sidebar searches, only
 * sections with a match, every one open (as Orbit does); none, and the group is gone.
 */
export function AutopilotSections({ state, query = "", onOpen, onOpenWatch }: { state: AppState; query?: string; onOpen: (open: AutopilotOpen) => void; onOpenWatch: (w: Watch) => void }) {
  const user = state.account?.user.id ?? "";
  const ws = currentWorkspace(state);
  // Keyed by account and workspace: a switch shows the other's sections as they are, nothing folding or ticking.
  return <SidebarGroup key={`${user}:${ws}`} state={state} user={user} ws={ws} query={query} onOpen={onOpen} onOpenWatch={onOpenWatch} />;
}

function SidebarGroup({
  state,
  user,
  ws,
  query,
  onOpen,
  onOpenWatch,
}: {
  state: AppState;
  user: string;
  ws: string;
  query: string;
  onOpen: (open: AutopilotOpen) => void;
  onOpenWatch: (w: Watch) => void;
}) {
  // The group, and each section, folded or opened since Bops opened, over what this Mac remembers.
  const [groupToggled, setGroupToggled] = useState<boolean | null>(null);
  const [toggled, setToggled] = useState<Partial<Record<AutopilotSection, boolean>>>({});
  const q = query.trim().toLowerCase();
  const tz = state.owner?.timeZone;
  const lists = autopilotOf(state);
  const multi = teamOf(state).length > 1;
  const botName = (id: string) => state.bots.find((b) => b.id === id)?.name;
  const schedules = lists.schedules.filter((r) => matchSchedule(r, q));
  const monitors = lists.monitors.filter((w) => matchMonitor(w, q));
  const procedures = lists.procedures.filter((p) => matchProcedure(p, q));
  const news = monitors.filter((w) => w.alert).length;
  const sections = [
    {
      ...SECTIONS[0],
      n: schedules.length,
      rows: schedules.slice(0, FIRST).map((r) => <ScheduleLine key={r.id} routine={r} sessions={state.sessions} tz={tz} onClick={() => onOpen({ section: "schedules", focus: r.id })} />),
    },
    {
      ...SECTIONS[1],
      n: monitors.length,
      // A screen or a Mac window shows as it always has (bops-app.tsx showWatch); a page opens here on the right.
      rows: monitors.slice(0, FIRST).map((w) => <MonitorLine key={w.id} watch={w} onClick={() => onOpenWatch(w)} />),
    },
    {
      ...SECTIONS[2],
      n: procedures.length,
      rows: procedures.slice(0, FIRST).map((p) => <ProcedureLine key={p.id} procedure={p} bot={multi ? botName(p.botId) : undefined} onClick={() => onOpen({ section: "procedures", focus: p.id })} />),
    },
  ].filter((s) => !q || s.n);
  if (q && !sections.length) return null;
  // While searching, the group stays open.
  const shown = !!q || (groupToggled ?? readGroupOpen(FOLDS, user, ws));
  // The arrow opens the page at the first section with something in it.
  const first = SECTIONS.find((s) => lists[s.id].length)?.id ?? "schedules";
  return (
    <div className="flex flex-col pt-4">
      <div className="group/autopilot mb-1.5 flex items-center gap-1.5 pr-1">
        <button
          onClick={() => {
            if (q) return;
            setGroupToggled(!shown);
            writeGroupOpen(FOLDS, user, ws, !shown);
          }}
          aria-expanded={shown}
          className="flex items-center gap-1.5 rounded-[6px] px-2.5 text-left text-[13px] font-medium leading-4 text-[#9A9A98] outline-none hover:text-[#6B6B6B] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
        >
          {GROUP_NAME}
          <Chevron open={shown} />
        </button>
        {/* News on a monitor stays in sight with the group folded. */}
        {!shown && news > 0 && <NewPill />}
        <span className="flex-1" />
        <button
          onClick={() => onOpen({ section: first })}
          aria-label={`Open ${GROUP_NAME}`}
          title={`Open ${GROUP_NAME}`}
          className="flex size-6 items-center justify-center rounded-[6px] text-[#9A9A98] opacity-0 outline-none transition-opacity duration-150 ease-out hover:bg-black/[0.04] hover:text-[#6B6B6B] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] group-hover/autopilot:opacity-100 motion-reduce:transition-none"
        >
          <OpenIcon />
        </button>
      </div>
      {/* The group folds under its name, and each section under its own (fold.tsx). */}
      <Fold open={shown}>
        {sections.map((s) => {
          // Folded until opened, like Orbit's: the group shares the pinned box with Orbit, which stays in view.
          const open = !!q || (toggled[s.id] ?? readSectionOpen(FOLDS, user, ws, s.id, false));
          return (
            <div key={s.id} className="flex flex-col">
              <button
                onClick={() => {
                  // While searching, every section stays open.
                  if (q) return;
                  setToggled({ ...toggled, [s.id]: !open });
                  writeSectionOpen(FOLDS, user, ws, s.id, !open);
                }}
                aria-expanded={open}
                className="flex h-[34px] items-center gap-2 rounded-[10px] px-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
              >
                <span className="text-[#6B6B6B]">
                  <AutopilotIcon id={s.id} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px] text-ink">{s.label}</span>
                {/* Folded, the section still says when a monitor has news. */}
                {s.id === "monitors" && !open && news > 0 && <NewPill />}
                <Count n={s.n} quiet={!!q} scope={`${user}.${ws}`} className="shrink-0 text-[12px] tabular-nums text-[#9A9A98]" />
                <span className="text-[#B0B0AD]">
                  <Chevron open={open} />
                </span>
              </button>
              <Fold open={open}>
                <div className="flex flex-col">
                  {!s.n && <div className="flex h-[30px] shrink-0 items-center pl-8 pr-2.5 text-[13px] leading-[18px] text-[#9A9A98]">{s.empty}</div>}
                  {s.rows}
                  {s.n > FIRST && (
                    <button
                      onClick={() => onOpen({ section: s.id })}
                      className="flex h-[30px] shrink-0 items-center rounded-[10px] pl-8 pr-2.5 text-left text-[13px] leading-[18px] text-[#6B6B6B] outline-none hover:bg-black/[0.03] hover:text-ink focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
                    >
                      Show all {s.n}
                    </button>
                  )}
                </div>
              </Fold>
            </div>
          );
        })}
      </Fold>
    </div>
  );
}

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

/** A procedure in the sidebar: its name, and its bot's in grey when the workspace has more than one. */
function ProcedureLine({ procedure: p, bot, onClick }: { procedure: Procedure; bot?: string; onClick: () => void }) {
  const fresh = useFresh(p.id);
  return (
    <button onClick={onClick} onAnimationEnd={fresh.done} title={undash(p.whenToUse)} className={`${SIDE_ROW} ${fresh.on ? "motion-new-item" : ""}`}>
      <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px]">
        <span className="text-ink">{undash(p.name)}</span>
        {bot && (
          <span className="text-[#9A9A98]">
            {" · "}
            {bot}
          </span>
        )}
      </span>
    </button>
  );
}

/* ---------------- The page ---------------- */

/**
 * Autopilot as a page on the right (one tab per workspace): a section at a time, every schedule, monitor
 * or procedure in it, each opening in place to say how it works and how it went, with what can be done
 * to it. `focus` opens one and brings it into view; `focusAt` is when it was asked for, so asking again
 * (it was closed since, or scrolled away) does it again.
 */
export function AutopilotPage({
  state,
  section,
  focus,
  focusAt,
  onSection,
  onOpenWatch,
  onClose,
}: {
  state: AppState;
  section: AutopilotSection;
  focus?: string;
  focusAt?: number;
  onSection: (section: AutopilotSection) => void;
  /** Show a watched screen or Mac window (bops-app.tsx showWatch). */
  onOpenWatch: (w: Watch) => void;
  onClose: () => void;
}) {
  // "Tomorrow 9 AM", "5m ago" stay current.
  useNow(30_000);
  const s = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  const lists = autopilotOf(state);
  const tz = state.owner?.timeZone;
  const multi = teamOf(state).length > 1;
  const [openId, setOpenId] = useState<string | null>(focus ?? null);
  // A new ask from the sidebar opens the row asked for.
  const [asked, setAsked] = useState({ focus, focusAt });
  if (asked.focus !== focus || asked.focusAt !== focusAt) {
    setAsked({ focus, focusAt });
    if (focus) setOpenId(focus);
  }
  const list = useRef<HTMLDivElement>(null);
  // ...and it comes into view, once it's there.
  const there = !!focus && [...lists.schedules, ...lists.monitors, ...lists.procedures].some((x) => x.id === focus);
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

  const toggle = (id: string) => setOpenId(openId === id ? null : id);
  const bot = (id: string) => state.bots.find((b) => b.id === id);
  const groups: { label?: string; rows: ReactNode[] }[] =
    s.id === "schedules"
      ? [
          { label: "Coming up", items: lists.schedules.filter((r) => r.enabled) },
          { label: "Paused", items: lists.schedules.filter((r) => !r.enabled && !done(r)) },
          { label: "Done", items: lists.schedules.filter(done) },
        ].map((g) => ({
          label: g.label,
          rows: g.items.map((r, n) => (
            <ScheduleRow key={r.id} routine={r} state={state} tz={tz} last={n === g.items.length - 1} open={openId === r.id} onToggle={() => toggle(r.id)} />
          )),
        }))
      : s.id === "monitors"
        ? [
            { label: "Watching", items: lists.monitors.filter((w) => !w.paused) },
            { label: "Paused", items: lists.monitors.filter((w) => w.paused) },
          ].map((g) => ({
            label: g.label,
            rows: g.items.map((w, n) => (
              <MonitorRow
                key={w.id}
                watch={w}
                state={state}
                last={n === g.items.length - 1}
                open={openId === w.id}
                onToggle={() => {
                  // Opening a page's news is seeing it (a screen's is seen where it shows: Show it).
                  if (openId !== w.id && w.alert && w.page) void post("/api/watches", { id: w.id, action: "seen" }, "PATCH");
                  toggle(w.id);
                }}
                onShow={() => onOpenWatch(w)}
              />
            )),
          }))
        : [
            {
              rows: lists.procedures.map((p, n) => (
                <ProcedureRow
                  key={p.id}
                  procedure={p}
                  bot={bot(p.botId)}
                  showBot={multi}
                  last={n === lists.procedures.length - 1}
                  open={openId === p.id}
                  onToggle={() => toggle(p.id)}
                />
              )),
            },
          ];
  const shown = groups.filter((g) => g.rows.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <AutopilotIcon size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{GROUP_NAME}</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">What your bots do on their own, and how they do it</span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SECTIONS.map((x) => {
            const on = x.id === s.id;
            return (
              <button
                key={x.id}
                onClick={() => !on && onSection(x.id)}
                aria-pressed={on}
                className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium leading-4 transition-colors duration-150 ease-out motion-reduce:transition-none ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
              >
                {x.label}
                <span className={`tabular-nums ${on ? "text-white/60" : "text-[#9A9A98]"}`}>{lists[x.id].length}</span>
              </button>
            );
          })}
        </div>

        {/* Another section: its list fades in (the key), not the page around it. */}
        <div ref={list} key={s.id} className="motion-fade-in flex flex-col gap-5">
          {!shown.length ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Mascot botId="boppy" color="#0A0A0A" size={52} />
              <span className="flex max-w-[320px] flex-col gap-1 text-[13.5px] leading-5">
                <span className="text-[#6B6B6B]">{s.empty}</span>
                <span className="text-[#9A9A98]">{s.how}</span>
              </span>
            </div>
          ) : (
            shown.map((g) => (
              <div key={g.label ?? "all"} className="flex flex-col gap-2">
                {g.label && (
                  <span className="px-1 text-[12px] font-medium leading-4 text-[#9A9A98]">
                    {g.label} <span className="font-normal tabular-nums text-[#B0B0AD]">{g.rows.length}</span>
                  </span>
                )}
                <div className="flex flex-col overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]">{g.rows}</div>
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
function ScheduleRow({ routine: r, state, tz, last, open, onToggle }: { routine: Routine; state: AppState; tz?: string; last: boolean; open: boolean; onToggle: () => void }) {
  const { busy, error, sure, setSure, removeButton, run, cancelRemove } = useActions(open);
  const bad = trouble(r);
  const next = nextRunText(r, tz);
  const ran = r.last;
  const delivery = ran?.delivery;
  return (
    <PageRow
      id={r.id}
      title={undash(r.title)}
      line={`${describeSchedule(r.schedule, tz)} · ${nextWords(r, state.sessions, tz)}${r.quiet ? " · quiet" : ""}`}
      dim={!r.enabled}
      end={bad && <TroubleDot tip={bad} />}
      last={last}
      open={open}
      onToggle={onToggle}
    >
      <Words label={r.reminder ? "The reminder" : "What it does"} text={r.reminder ?? r.goal} />
      <Facts
        rows={[
          ["Bot", <BotName key="bot" bot={state.bots.find((b) => b.id === r.botId)} />],
          ["When", `${describeSchedule(r.schedule, tz)}${next ? `. Next: ${next}` : ""}`],
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
function MonitorRow({ watch: w, state, last, open, onToggle, onShow }: { watch: Watch; state: AppState; last: boolean; open: boolean; onToggle: () => void; onShow: () => void }) {
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
      end={w.alert ? <NewPill /> : page?.error && !w.paused ? <TroubleDot tip={`Couldn't read the page: ${undash(page.error)}`} /> : null}
      last={last}
      open={open}
      onToggle={onToggle}
    >
      <Facts
        rows={[
          ["Bot", <BotName key="bot" bot={state.bots.find((b) => b.id === w.botId)} />],
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

/** A procedure on the page: its bot and when to use it (its line, in full once open), its steps and pitfalls, how often it was used; Edit (in place), Delete. */
function ProcedureRow({
  procedure: p,
  bot,
  showBot,
  last,
  open,
  onToggle,
}: {
  procedure: Procedure;
  bot?: { id: string; name: string; color: string };
  showBot: boolean;
  last: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { busy, error, setError, sure, setSure, removeButton, run, cancelRemove } = useActions(open);
  const [editing, setEditing] = useState(false);
  const used = p.uses ? `${p.uses} time${p.uses === 1 ? "" : "s"}${p.usedAt ? `, last ${since(p.usedAt)}` : ""}` : "Not yet";
  return (
    <PageRow
      id={p.id}
      title={undash(p.name)}
      line={[showBot ? bot?.name : "", undash(p.whenToUse)].filter(Boolean).join(" · ")}
      last={last}
      open={open}
      onToggle={onToggle}
      editing={
        editing && (
          <ProcedureForm
            procedure={p}
            busy={busy === "save"}
            error={error}
            onSave={(edit) => void run("save", "/api/procedures", { id: p.id, edit }, "PATCH").then((ok) => ok && setEditing(false))}
            onCancel={() => {
              setEditing(false);
              setError(null);
            }}
          />
        )
      }
    >
      <Facts
        rows={[
          ["Bot", <BotName key="bot" bot={bot} />],
          ["Used", used],
        ]}
      />
      <Words label="Steps" text={p.steps} />
      {!!p.pitfalls?.trim() && <Words label="Pitfalls" text={p.pitfalls} />}
      {sure ? (
        <InlineConfirm
          text="Delete this procedure? Its bot won't follow it anymore."
          action="Delete"
          doing="Deleting…"
          busy={busy === "remove"}
          onConfirm={() => void run("remove", "/api/procedures", { id: p.id }, "DELETE")}
          onCancel={cancelRemove}
        />
      ) : (
        <div className="-ml-2.5 flex flex-wrap items-center gap-0.5">
          <button
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
            disabled={!!busy}
            className={small("plain")}
          >
            Edit
          </button>
          <button ref={removeButton} onClick={() => setSure(true)} disabled={!!busy} className={small("red")}>
            Delete
          </button>
        </div>
      )}
      {!editing && <ErrorLine text={error} />}
    </PageRow>
  );
}

type ProcedureEdit = { name: string; whenToUse: string; steps: string; pitfalls: string };

/**
 * A procedure changed in place: its name, when to use it, its steps and pitfalls. Enter in a one-line
 * field saves (⌘ Enter in the others), Esc cancels (not while saving).
 */
function ProcedureForm({ procedure: p, busy, error, onSave, onCancel }: { procedure: Procedure; busy: boolean; error: string | null; onSave: (edit: ProcedureEdit) => void; onCancel: () => void }) {
  const [name, setName] = useState(p.name);
  const [whenToUse, setWhen] = useState(p.whenToUse);
  const [steps, setSteps] = useState(p.steps);
  const [pitfalls, setPitfalls] = useState(p.pitfalls ?? "");
  const first = useRef<HTMLInputElement>(null);
  const over = name.length + whenToUse.length + steps.length + pitfalls.length - MAX_PROCEDURE_CHARS;
  const ready = !!name.trim() && !!whenToUse.trim() && !!steps.trim() && over <= 0;
  const field = "w-full rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13.5px] leading-[18px] outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  // ⌘ Enter in a box of several lines saves (Enter there is a new line).
  const saveKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !ready) return;
        // Save turns off while it saves, and Chrome drops focus from a button that turns off (Esc would then
        // close the page, and a failure's error with it): the name has focus instead, unless a field has it.
        const el = document.activeElement;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) first.current?.focus();
        onSave({ name: name.trim(), whenToUse: whenToUse.trim(), steps: steps.trim(), pitfalls: pitfalls.trim() });
      }}
      // Esc cancels the edit, and only the edit (preventDefault keeps the page open); while it saves, nothing.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="flex flex-col gap-2"
    >
      <input ref={first} autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" placeholder="Name" maxLength={PROCEDURE_NAME_MAX} className={`${field} font-medium`} />
      <input value={whenToUse} onChange={(e) => setWhen(e.target.value)} aria-label="When to use it" placeholder="When to use it" maxLength={PROCEDURE_WHEN_MAX} className={field} />
      <textarea
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
        onKeyDown={saveKey}
        aria-label="Steps"
        placeholder="Steps, one per line"
        rows={5}
        className={`${field} resize-y`}
      />
      <textarea
        value={pitfalls}
        onChange={(e) => setPitfalls(e.target.value)}
        onKeyDown={saveKey}
        aria-label="Pitfalls"
        placeholder="Pitfalls, one per line (optional)"
        rows={3}
        className={`${field} resize-y`}
      />
      {over > 0 && <span className="text-[12.5px] leading-4 text-[#B42318]">{over.toLocaleString("en-US")} characters too long</span>}
      {error && (
        <span role="alert" className="text-[12.5px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
      <span className="flex items-center gap-2">
        <button type="submit" disabled={busy || !ready} className="rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-semibold leading-4 text-white disabled:opacity-40">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-40">
          Cancel
        </button>
      </span>
    </form>
  );
}
