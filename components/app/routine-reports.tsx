"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { describeSchedule } from "@/cloud/schedule";
import { routineReports, tookWords, type RecordedRun, type Report } from "@/lib/routine-reports";
import type { AppState, Message, Routine, Session } from "@/lib/types";
import { Rich } from "./chat-view";
import { ReplyDrafts } from "./reply-drafts";
import { SkillProposals } from "./skill-proposals";
import { Fold } from "./fold";
import { Mascot, Spinner } from "./mascot";
import { clockOf, dayKey, RAN_WORDS, StatusMark, useClock } from "./routine-week";
import { Chevron, since, undash } from "./side-group";

/*
 * A routine's reports, over the Routines page as a thread's sheet is over the chat (chat-view.tsx
 * ThreadSheet): every run, newest first, each with when it ran, how it went in the page's words and how
 * long it took, opening in place to what it said in the bot's chat (in full, Show all when long, and the
 * replies it wrote for the user to send, as cards with Send: reply-drafts.tsx), its
 * thread when it ran on a computer, what it was sent to, why it failed or didn't run. The runs are Orgo's
 * record (/api/routines/{id}/runs) with the last run as Bops has it, what they said the chat's
 * (lib/routine-reports.ts). The last run shows at once, the rest under it once Orgo answers, so nothing
 * moves; when it doesn't, the last run and what's in the chat, said so. In a workspace shared with the
 * viewer, only what that view shows: the last run and the chat they can read (nothing is asked of Orgo,
 * which keeps the owner's). Esc, the ×, or a click outside closes it; the page puts focus back. Esc typed
 * in a box outside it (the chat beside the page) stays there, as bops-app.tsx keeps it for a page.
 */

type Loaded = { id: string; orgo: "ok" | "none" | "offline"; runs: RecordedRun[] | null };

/** A report's words are cut past this height, with Show all; till they're measured, a guess from their length (or lines). */
const CUT_PX = 220;
const LONG_CHARS = 700;
const LONG_LINES = 10;

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a run began, in zone `tz`: "Today 8 AM", "Yesterday 4:29 PM", "Mon 8 AM" this past week, "Oct 12, 8 AM" before. */
export function ranWhen(t: number, now: number, tz?: string) {
  const [y, m, d] = dayKey(t, tz).split("-").map(Number);
  const [ny, nm, nd] = dayKey(now, tz).split("-").map(Number);
  const ago = Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(y, m - 1, d)) / 86_400_000);
  const clock = clockOf(t, tz);
  if (ago === 0) return `Today ${clock}`;
  if (ago === 1) return `Yesterday ${clock}`;
  if (ago > 1 && ago < 7) return `${DOW[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]} ${clock}`;
  return `${MONTH[m - 1]} ${d}${y !== ny ? `, ${y}` : ""}, ${clock}`;
}

/** A report's first words, for its closed line: no markdown marks. */
const firstLine = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>|`]+/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

export function ReportsSheet({
  state,
  routine: r,
  at,
  onClose,
  onOpenThread,
}: {
  state: AppState;
  routine: Routine;
  /** The run to open at (its start), when one was picked. */
  at?: number;
  onClose: () => void;
  /** Open a run's thread (bops-app.tsx openThread). */
  onOpenThread?: (s: Session) => void;
}) {
  const shared = !!state.shared;
  const tz = state.owner?.timeZone;
  const zone = r.timeZone || tz;
  const bot = state.bots.find((b) => b.id === r.botId);
  // "Today 8 AM" turns "Yesterday 8 AM" at midnight.
  const now = useClock(60_000);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const loading = !shared && loaded?.id !== r.id;
  useEffect(() => {
    if (shared) return;
    let gone = false;
    const done = (x: Omit<Loaded, "id">) => !gone && setLoaded({ id: r.id, ...x });
    (async () => {
      try {
        const res = await fetch(`/api/routines/${encodeURIComponent(r.id)}/runs`);
        const j = (await res.json().catch(() => null)) as { orgo?: unknown; runs?: unknown } | null;
        if (res.ok && j?.orgo === "ok" && Array.isArray(j.runs)) done({ orgo: "ok", runs: j.runs as RecordedRun[] });
        else if (res.ok && j?.orgo === "none") done({ orgo: "none", runs: null });
        else done({ orgo: "offline", runs: null });
      } catch {
        done({ orgo: "offline", runs: null });
      }
    })();
    return () => {
      gone = true;
    };
  }, [r.id, shared]);

  const runs = loaded?.id === r.id ? loaded.runs : null;
  const all = useMemo(
    () => routineReports({ routine: r, runs, messages: state.messages, sessions: state.sessions, chats: state.chats }),
    [r, runs, state.messages, state.sessions, state.chats],
  );
  // While Orgo is asked, only the last run (it's Bops' own): the rest come in under it, so nothing above moves.
  const reports = loading ? all.filter((x) => x.last) : all;
  const [openKey, setOpenKey] = useState<string | null>(() => (at !== undefined ? `run:${at}` : null));
  const list = useRef<HTMLOListElement>(null);
  const heading = useRef<HTMLSpanElement>(null);

  // Opening: focus on the run it opened at (in view), else the heading.
  useLayoutEffect(() => {
    const head = openKey ? list.current?.querySelector<HTMLElement>(`[data-report="${CSS.escape(openKey)}"] [data-report-head]`) : null;
    if (head) {
      head.focus();
      head.scrollIntoView({ block: "nearest" });
    } else heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Esc closes it (before the page: bops-app.tsx leaves a page alone while a dialog is open), but not one
  // typed in a box outside it (the chat beside the page), which stays there.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && !box.current?.contains(el)) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = undash(r.title);
  const note = shared
    ? "In a shared workspace, only the last run and what's in the chat show here."
    : loaded?.orgo === "offline"
      ? reports.length
        ? "Couldn't load earlier runs right now. Here's the last run and what's in the chat."
        : "Couldn't load earlier runs right now."
      : null;
  return (
    // Clicking anywhere outside the sheet closes it, as the × does (a thread's sheet, chat-view.tsx).
    <div ref={box} role="dialog" aria-label={`Reports for ${title}`} onClick={onClose} className="motion-fade-in absolute inset-0 z-20 flex flex-col bg-white/70 px-3 pb-3 pt-3 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="motion-sheet-in flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000038]">
        <div className="flex items-center gap-2.5 border-b border-[color:var(--c-f0f0ee)] py-3.5 pl-4 pr-3.5">
          {bot ? <Mascot botId={bot.id} color={bot.color} size={32} /> : <span className="size-8 shrink-0 rounded-full bg-[color:var(--c-ececea)]" />}
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span ref={heading} tabIndex={-1} className="truncate text-[15px] font-semibold leading-[18px] outline-none">
              {title}
            </span>
            <span className="truncate text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">
              Reports · {bot ? `${bot.name} · ` : ""}
              {describeSchedule(r.schedule, zone)}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close reports" className="flex size-[34px] shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_var(--c-e6e6e3)] outline-none hover:bg-[color:var(--c-f7f7f6)] focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-4 pt-3">
          {note && (
            <span data-reports-note className="px-1.5 text-[12.5px] leading-[17px] text-[color:var(--c-6b6b6b)]">
              {note}
            </span>
          )}
          {!reports.length && !loading ? (
            <span data-reports-empty className="px-1.5 py-6 text-center text-[13.5px] leading-5 text-[color:var(--c-9a9a98)]">
              No runs yet
            </span>
          ) : (
            <ol ref={list} className="flex flex-col">
              {reports.map((x, i) => (
                <ReportRow
                  key={x.key}
                  state={state}
                  report={x}
                  bot={bot}
                  tz={tz}
                  now={now}
                  shared={shared}
                  last={i === reports.length - 1 && !loading}
                  open={openKey === x.key}
                  onToggle={() => setOpenKey(openKey === x.key ? null : x.key)}
                  onOpenThread={onOpenThread}
                />
              ))}
            </ol>
          )}
          {loading && (
            // As tall as a run's line, where the earlier runs come in.
            <span data-reports-loading className="flex h-[52px] shrink-0 items-center gap-2 px-3.5 text-[12.5px] leading-4 text-[color:var(--c-9a9a98)]">
              <Spinner size={12} color="#9A9A98" />
              Loading earlier runs
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** One run: its line (when, how it went, how long), opening to what it said and where it went. */
function ReportRow({
  state,
  report: x,
  bot,
  tz,
  now,
  shared,
  last,
  open,
  onToggle,
  onOpenThread,
}: {
  state: AppState;
  report: Report;
  bot?: AppState["bots"][number];
  tz?: string;
  now: number;
  shared: boolean;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  onOpenThread?: (s: Session) => void;
}) {
  const words = x.status === "quiet" && shared ? "Ran, nothing for the owner" : RAN_WORDS[x.status];
  // How long a run that ran took: never for one that didn't (a skip is recorded the moment it happens), nor under a second.
  const took = (x.status === "ok" || x.status === "quiet" || x.status === "failed") && x.ms !== undefined && x.ms >= 1000 ? tookWords(x.ms) : null;
  const said = x.status === "ok" || x.status === "running" ? x.messages : [];
  // What it said, when the chat no longer has it: Orgo's copy, else its thread's answer.
  const kept = !said.length && x.status === "ok" ? (x.summary ?? x.thread?.answer) : undefined;
  const preview = said.length ? firstLine(said[0].text) : kept ? firstLine(kept) : x.status === "failed" && x.error ? undash(x.error) : "";
  return (
    <li data-report={x.key} className={`flex flex-col ${last ? "" : "border-b border-[color:var(--c-f0f0ee)]"}`}>
      <button
        data-report-head
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-start gap-3 rounded-xl py-3 pl-2 pr-2.5 text-left outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)]"
      >
        <span className="relative flex shrink-0 pt-px">
          {bot ? <Mascot botId={bot.id} color={bot.color} size={24} antenna={false} /> : <span className="size-6 rounded-full bg-[color:var(--c-ececea)]" />}
          <StatusMark status={x.status} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13.5px] font-medium leading-[18px] text-ink">{ranWhen(x.at, now, tz)}</span>
          <span className={`text-[12px] leading-4 ${x.status === "failed" ? "text-[#B42318]" : "text-[color:var(--c-6b6b6b)]"}`}>
            {words}
            {took ? ` · took ${took}` : ""}
          </span>
          {!open && preview && <span className="truncate text-[12.5px] leading-[17px] text-[color:var(--c-9a9a98)]">{preview}</span>}
        </span>
        <span className="pt-[3px] text-[color:var(--c-b0b0ad)]">
          <Chevron open={open} />
        </span>
      </button>
      <Fold open={open} lazy>
        <div data-report-body className="flex flex-col gap-2 pb-3.5 pl-[44px] pr-2.5">
          {x.status === "quiet" && <Plain>{shared ? "Nothing needed the owner" : "Nothing needed you"}</Plain>}
          {x.status === "failed" && <span className="text-[13px] leading-[19px] text-[#B42318] [overflow-wrap:anywhere]">{x.error ? undash(x.error) : "It failed."}</span>}
          {x.status === "skipped" && <Plain>{x.error ? undash(x.error) : "It didn't run."}</Plain>}
          {x.status === "running" && !said.length && <Plain>It&rsquo;s still going.</Plain>}
          {said.map((m) => (
            <Said key={m.id} message={m} state={state} />
          ))}
          {kept && <Said text={kept} botId={bot?.id} caption={x.summary ? "Saved with the run" : undefined} />}
          {x.status === "ok" && !said.length && !kept && <Plain>Its message isn&rsquo;t in the chat anymore.</Plain>}
          {x.delivery &&
            (x.delivery.status === "sent" ? (
              <Plain>
                Sent to {x.delivery.to} · {since(x.delivery.at)}
              </Plain>
            ) : (
              <span className="text-[12.5px] leading-[17px] text-[#B42318] [overflow-wrap:anywhere]">
                Couldn&rsquo;t send to {x.delivery.to}
                {x.delivery.error ? `: ${undash(x.delivery.error)}` : ""}
              </span>
            ))}
          {x.thread && onOpenThread && (
            <button
              onClick={() => onOpenThread(x.thread!)}
              className="self-start text-[12.5px] font-medium leading-4 text-ink underline decoration-[color:var(--c-c9c9c6)] underline-offset-2 outline-none hover:decoration-ink focus-visible:decoration-ink"
            >
              Open its thread
            </button>
          )}
        </div>
      </Fold>
    </li>
  );
}

function Plain({ children }: { children: React.ReactNode }) {
  return <span className="text-[13px] leading-[19px] text-[color:var(--c-6b6b6b)] [overflow-wrap:anywhere]">{children}</span>;
}

/** What a run said, as the chat shows a bot's words: in full, cut with Show all when taller than CUT_PX; then the replies it wrote to send, as in the chat. */
function Said({ message, state, text = message?.text ?? "", botId = message?.botId, caption }: { message?: Message; state?: AppState; text?: string; botId?: string; caption?: string }) {
  // Whether it's taller than the cut: a guess from its length, then measured once it's laid out (as Words is, autopilot.tsx).
  const [long, setLong] = useState(() => text.length > LONG_CHARS || text.split("\n").length > LONG_LINES);
  const [all, setAll] = useState(false);
  const bubble = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bubble.current;
    if (all || !el) return;
    const measure = () => {
      // Not laid out (no height yet): the guess stands.
      if (el.clientHeight) setLong(el.scrollHeight > CUT_PX + 1);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [all, text]);
  const cut = long && !all;
  return (
    <div className="flex flex-col gap-1">
      {caption && <span className="text-[11.5px] font-medium leading-4 text-[color:var(--c-9a9a98)]">{caption}</span>}
      <div
        ref={bubble}
        data-said
        className={`relative whitespace-pre-wrap rounded-[18px] bg-[color:var(--c-f2f2f0)] px-3.5 py-2 text-[14px] leading-5 [overflow-wrap:anywhere] ${cut ? "max-h-[220px] overflow-hidden" : ""}`}
      >
        <Rich text={text} botId={botId} />
        {cut && <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-[18px] bg-gradient-to-t from-[color:var(--c-f2f2f0)] to-[color:var(--c-f2f2f0)]/0" />}
      </div>
      {long && (
        <button
          onClick={() => setAll(!all)}
          aria-expanded={all}
          className="self-start text-[12px] font-medium leading-4 text-ink underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          {all ? "Show less" : "Show all"}
        </button>
      )}
      {message && state && <ReplyDrafts message={message} state={state} className="pt-1" />}
      {message && state && <SkillProposals message={message} state={state} className="pt-1" />}
    </div>
  );
}
