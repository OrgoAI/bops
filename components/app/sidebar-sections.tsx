"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { favoriteCount, favoriteLabel, movedFavorite, nudgedFavorite, toggledFavorite, type FavoriteKind } from "@/lib/favorites";
import { categoriesOpen } from "@/lib/memory-categories";
import { alwaysScope, toDo } from "@/lib/permission";
import { answersAsk, canAct, writesThread } from "@/lib/shared";
import { askKind } from "@/lib/asks";
import { memberAct } from "./shared-act";
import { live, waitingAsks, workspaceOf, type AppApproval, type AppState, type Session, type Watch } from "@/lib/types";
import { menuPoint, SideMenu, useFavorites, type MenuItem } from "./favorites";
import { Fold } from "./fold";
import { Spinner } from "./mascot";
import { CategoryIcon, useMemoryCategories, type MemoryOpen } from "./memory-categories";
import { isOpen, issueOrder, StatusDot, useIssues, type Issue } from "./orbit-issues";
import { KeyIcon } from "./screen-cards";
import { SETUP_NEEDS, type SetupItem } from "./setup";
import { arrived, Chevron, Count, DeleteX, readSectionOpen, undash, usePop, useRise, writeSectionOpen } from "./side-group";
import { SkillsIcon } from "./skills";
import { ago, currentWorkspace, needsYou, NeedsYouDot, post, quietNothing, StatusIcon } from "./ui";
import { BRAND } from "@/lib/brand";

/*
 * The sidebar's sections over the chats (sidebar.tsx): Favorites, with Needs your attention first while
 * anything waits on the user, then the Knowledge kinds the user pinned; and under each bot's own chat,
 * what waits on the user from it, as cards, then its threads. Every list shows a few rows and keeps the
 * rest behind "Show N more", so a flood never takes the sidebar over. What's folded is remembered on this
 * Mac (side-group.tsx), per account and workspace.
 */

/** Rows a list shows before "Show N more". */
export const SHOWN = 3;

/** This Mac's memory of what's folded, for the sidebar (side-group.tsx keeps it): sections, and each bot's threads. */
const GROUP = "sidebar";
const THREADS = "threads";

/**
 * Whether something is open, as the user left it on this Mac (`fallback` until they fold or open it),
 * read again for another workspace or bot (`key`), and how to change it (remembered, when it can be).
 */
function useRemembered(group: string, user: string, ws: string, key: string, fallback: boolean) {
  const id = `${user}:${ws}:${key}`;
  const [v, setV] = useState(() => ({ id, open: readSectionOpen(group, user, ws, key, fallback) }));
  if (v.id !== id) setV({ id, open: readSectionOpen(group, user, ws, key, fallback) });
  const open = v.id === id ? v.open : readSectionOpen(group, user, ws, key, fallback);
  const set = (next: boolean) => {
    setV({ id, open: next });
    writeSectionOpen(group, user, ws, key, next);
  };
  return [open, set] as const;
}

/* ---------------- Threads ---------------- */

/**
 * The workspace's threads, as the sidebar lists them: its bots' (one that's gone takes its threads
 * with it), not one a newer thread took over, and not a quiet routine's run that found nothing.
 */
export function threadsOf(state: AppState) {
  const ws = currentWorkspace(state);
  return state.sessions.filter((s) => workspaceOf(state.bots.find((b) => b.id === s.botId)) === ws && state.bots.some((b) => b.id === s.botId) && !s.replacedBy && !quietNothing(s));
}

/** Working or needing the user first, then the newest. */
export const threadOrder = (a: Session, b: Session) => Number(live(b) || needsYou(b)) - Number(live(a) || needsYou(a)) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt);

/** Each bot's threads (threadsOf), in threadOrder. */
export function threadsByBot(state: AppState) {
  const out = new Map<string, Session[]>();
  for (const s of [...threadsOf(state)].sort(threadOrder)) out.set(s.botId, [...(out.get(s.botId) ?? []), s]);
  return out;
}

/**
 * What a collapsed bot's chip says besides the count: needs you over working, else nothing. `shared`: a
 * workspace shared with the user, whose threads ask its owner, never them: working, else nothing.
 */
export const chipMark = (threads: Session[], shared?: boolean) =>
  !shared && threads.some((s) => needsYou(s)) ? "you" : threads.some((s) => live(s) && !s.askWhere) ? "working" : null;

/**
 * A bot's mark on the folded sidebar (sidebar-rail.tsx): how many things from it wait on the user, counted
 * as attentionOf counts them for Needs your attention (its threads that need them, then its cards, a
 * request of a thread already counted not again), so the rail's numbers add up to that one; and whether
 * one of its threads is working.
 */
export function railMark(threads: Session[], needs: BotNeeds | undefined, shared?: boolean) {
  const asking = shared ? [] : threads.filter((s) => needsYou(s));
  const counted = new Set(asking.map((s) => s.id));
  const cards = needs ? needs.asks.filter((x) => !x.ask.threadId || !counted.has(x.ask.threadId)).length + needs.issues.length + needs.alerts.length + needs.setup.length : 0;
  return { waiting: asking.length + cards, working: threads.some((s) => live(s) && !s.askWhere) };
}

/** One thread under its bot: in ink with its mark while it's working or needs you; × deletes it once it's stopped. */
/**
 * `readOnly`: a shared workspace's thread, the owner's to delete (and what it asks, theirs to answer). `okWait`: a
 * request of its for the user's OK is unanswered (lib/types.ts waitsForOk): it waits on them, not working.
 */
export function ThreadRow({ session: s, onClick, readOnly, okWait }: { session: Session; onClick: () => void; readOnly?: boolean; okWait?: boolean }) {
  // New since the sidebar opened: rises in, once.
  const row = useRise(() => arrived(s.id));
  // Its mark (as StatusIcon draws it) pops when it changes in place, as working turns to needs you.
  const mark = okWait ? "you" : live(s) && !(s.askWhere && needsYou(s)) ? "working" : needsYou(s) ? "you" : s.status;
  const pop = usePop(mark);
  return (
    <button
      onClick={onClick}
      onAnimationEnd={row.done}
      data-thread={s.id}
      className={`group/thread flex h-[34px] shrink-0 items-center gap-2 rounded-[10px] px-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)] ${row.rise ? "motion-rise-in" : ""}`}
    >
      <span className={`min-w-0 flex-1 truncate text-[14px] leading-[18px] ${live(s) || needsYou(s) ? "text-ink" : "text-[color:var(--c-6b6b6b)]"}`}>{s.title}</span>
      {(live(s) || needsYou(s)) && (
        <span key={pop.n} onAnimationEnd={pop.done} className={`flex shrink-0 ${pop.pop ? "motion-dot-in" : ""}`}>
          <StatusIcon session={s} owner={readOnly} okWait={okWait} />
        </span>
      )}
      {!live(s) && !readOnly && (
        <DeleteX label={`Delete ${s.title}`} onDelete={() => void post(`/api/sessions/${s.id}`, {}, "DELETE")} className="group-hover/thread:opacity-100 group-focus-visible/thread:opacity-100" />
      )}
    </button>
  );
}

/** "Show N more" under a list cut at SHOWN, "Show less" once it's all there. */
function MoreButton({ hidden, open, onToggle, className = "" }: { hidden: number; open: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={`flex h-7 shrink-0 items-center rounded-[10px] px-2.5 text-left text-[13px] leading-4 text-[color:var(--c-9a9a98)] outline-none hover:bg-black/[0.03] hover:text-[color:var(--c-6b6b6b)] focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)] ${className}`}
    >
      {open ? "Show less" : `Show ${hidden} more`}
    </button>
  );
}

/** A list of rows that shows SHOWN of them, the rest behind "Show N more". */
function Capped({ rows, className = "" }: { rows: ReactNode[]; className?: string }) {
  const [all, setAll] = useState(false);
  const hidden = rows.length - SHOWN;
  return (
    <div className={`flex flex-col ${className}`}>
      {hidden > 0 && !all ? rows.slice(0, SHOWN) : rows}
      {hidden > 0 && <MoreButton hidden={hidden} open={all} onToggle={() => setAll(!all)} />}
    </div>
  );
}

/**
 * The chip at the end of a bot's preview line: a chevron and how many things are under the bot (what
 * waits on the user, then its threads), and while it's folded, the highlighter dot when something there
 * needs the user, else a spinner when a thread is working.
 */
function ChipFace({ count, mark, open, selected }: { count: number; mark: ReturnType<typeof chipMark>; open: boolean; selected?: boolean }) {
  const shown = open ? null : mark;
  return (
    <span className={`flex h-[17px] items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] leading-[14px] tabular-nums text-[color:var(--c-6b6b6b)] ${selected ? "bg-white" : "bg-[color:var(--c-eeeeec)]"}`}>
      <Chevron open={open} />
      {shown === "you" && <span data-chip-mark="you" className="size-[7px] shrink-0 rounded-full bg-highlighter shadow-[0_0_0_1.2px_var(--c-0a0a0a)]" />}
      {shown === "working" && (
        <span data-chip-mark="working" className="flex">
          <Spinner size={10} color="#3A3A38" />
        </span>
      )}
      {count}
    </span>
  );
}

/**
 * Something under a bot that waits on the user, as a compact card over its threads: its mark and what it
 * is on one line, cut short (the tooltip has all of it), and a grey line under it with who it's from,
 * when, and its tags. One that comes to need the user after
 * the sidebar's first paint rises in, once (side-group.tsx).
 */
function NeedCard({ id, icon, title, meta, onClick }: { id: string; icon: ReactNode; title: string; meta?: string; onClick: () => void }) {
  const row = useRise(() => arrived(id));
  return (
    <button
      onClick={onClick}
      onAnimationEnd={row.done}
      data-need={id}
      title={meta ? `${title}\n${meta}` : title}
      className={`flex shrink-0 items-start gap-2 rounded-[9px] bg-white px-2.5 py-1.5 text-left shadow-[0_0_0_1px_var(--c-e6e6e3)] outline-none hover:shadow-[0_0_0_1px_#CFCFCB] focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] ${row.rise ? "motion-rise-in" : ""}`}
    >
      <span className="flex h-[17px] w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-[17px] text-ink">{title}</span>
        {meta && <span className="truncate text-[11.5px] leading-[14px] text-[color:var(--c-9a9a98)]">{meta}</span>}
      </span>
    </button>
  );
}

/**
 * Something a bot asked the user's OK for (AppApproval), under the bot, as a compact card: what it wants to do
 * on one line (the tooltip has all of it, and the chat's card the details, with what to do instead), where it's
 * for and when, and Deny, Always allow (for the bot and this action, whoever it's for, as the line under the buttons
 * says: lib/permission.ts alwaysScope) and Allow once. Its run waits for the reply wherever it runs
 * (lib/server/permission.ts); the title opens the chat or thread it's in. One that comes after the sidebar's
 * first paint rises in, once.
 */
function AskCard({ ask: a, botName, where, shared, onOpen }: { ask: AppApproval; botName: string; where?: string; shared?: boolean; onOpen: () => void }) {
  const row = useRise(() => arrived(`ask:${a.id}`));
  const [working, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // From a shared workspace, the answer as it stands (AppApproval.memberSend): waits while it's on its way, says why it didn't go.
  const sent = a.memberSend;
  const busy = working || (!!sent && sent.state !== "failed");
  const decide = async (reply: "once" | "always" | "reject") => {
    setBusy(true);
    // In a shared workspace (a bot the viewer has at Write): through the owner's Bops (shared-act.ts).
    if (shared) {
      const r = await memberAct({ act: "answer", askId: a.id, reply });
      setError(r.ok ? null : (r.error ?? null));
      setBusy(false);
      return;
    }
    await post("/api/apps/approvals", { id: a.id, reply });
  };
  const title = `${botName} wants to ${toDo(undash(a.action))}`;
  const scope = alwaysScope(botName, { ...a, action: undash(a.action) });
  const meta = [where ? `For ${undash(where)}` : shared ? "Waiting for an OK" : "Waiting for your OK", ago(a.at)].join(" · ");
  const said = sent && sent.state !== "failed" ? (sent.state === "sending" ? "Sending…" : `Waiting for the owner's ${BRAND.name} to open.`) : null;
  const shownError = said ? null : (error ?? (sent?.state === "failed" ? (sent.error ?? "That didn't go. Try again.") : null));
  const btn = "rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 disabled:opacity-50";
  return (
    <div
      onAnimationEnd={row.done}
      data-need={`ask:${a.id}`}
      className={`flex shrink-0 flex-col gap-1.5 rounded-[9px] bg-white px-2.5 py-1.5 shadow-[0_0_0_1px_var(--c-e6e6e3)] ${row.rise ? "motion-rise-in" : ""}`}
    >
      <button onClick={onOpen} title={a.preview ? `${title}\n${a.preview}` : title} className="flex items-start gap-2 text-left outline-none focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]">
        <span className="flex h-[17px] w-4 shrink-0 items-center justify-center">
          <NeedsYouDot />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium leading-[17px] text-ink">{title}</span>
          <span className="truncate text-[11.5px] leading-[14px] text-[color:var(--c-9a9a98)]">{meta}</span>
        </span>
      </button>
      <span className="flex flex-wrap gap-1 pl-6">
        <button disabled={busy} onClick={() => void decide("reject")} className={`${btn} bg-[color:var(--c-f2f2f0)] hover:bg-[color:var(--c-eaeae7)]`}>
          Deny
        </button>
        <button disabled={busy} onClick={() => void decide("always")} title={scope} className={`${btn} bg-[color:var(--c-f2f2f0)] hover:bg-[color:var(--c-eaeae7)]`}>
          Always allow
        </button>
        <button disabled={busy} onClick={() => void decide("once")} className={`${btn} bg-ink text-white`}>
          Allow once
        </button>
      </span>
      <span title={scope} className="truncate pl-6 text-[11.5px] leading-[14px] text-[color:var(--c-9a9a98)]">
        {scope}
      </span>
      {said && <span className="pl-6 text-[11.5px] leading-[14px] text-[color:var(--c-9a9a98)]">{said}</span>}
      {shownError && (
        <span role="alert" className="pl-6 text-[11.5px] leading-[14px] text-[#B42318]">
          {shownError}
        </span>
      )}
    </div>
  );
}

/** What a card under a bot opens: an issue (its page in Knowledge), an alert's watch, Setup, or the chat or thread an ask is in. */
export type NeedActs = { onOpenIssue: (issue: Issue) => void; onOpenWatch: (w: Watch) => void; onSetup: () => void; onOpenAsk?: (a: AppApproval) => void };

/** A bot's cards (needsByBot): what it asked your OK for, its urgent alerts, the issues waiting on us, then what Setup still needs. */
function needCards(n: BotNeeds, acts: NeedActs) {
  return [
    ...n.asks.map((x) => <AskCard key={`ask:${x.ask.id}`} ask={x.ask} botName={x.botName} where={x.where} shared={x.shared} onOpen={() => acts.onOpenAsk?.(x.ask)} />),
    ...n.alerts.map((w) => (
      <NeedCard
        key={`alert:${w.id}`}
        id={`alert:${w.id}:${w.alert!.at}`}
        icon={<NeedsYouDot />}
        title={undash(w.alert!.text)}
        meta={`${w.mac?.title ?? w.site} · ${ago(w.alert!.at)}`}
        onClick={() => acts.onOpenWatch(w)}
      />
    )),
    ...n.issues.map((i) => (
      <NeedCard
        key={i.id}
        id={`issue:${i.id}`}
        icon={<StatusDot status={i.status} />}
        title={undash(i.title)}
        meta={[i.customer?.name, ago(i.updatedAt), ...i.tags]
          .filter((x): x is string => !!x)
          .map(undash)
          .join(" · ")}
        onClick={() => acts.onOpenIssue(i)}
      />
    )),
    ...n.setup.map((item) => (
      <NeedCard
        key={`setup:${item}`}
        id={`setup:${item}`}
        icon={
          <span className="flex text-[color:var(--c-6b6b6b)]">
            <KeyIcon size={12} />
          </span>
        }
        title={SETUP_NEEDS[item]}
        meta="Setup"
        onClick={acts.onSetup}
      />
    )),
  ];
}

/**
 * A bot's chat row (`row`, given the space to keep for the chip at the end of its preview line) with
 * what's under it, folded until the user opens it (remembered per bot on this Mac; a new `openAt` opens
 * it, as Needs your attention does): first, as cards, what waits on the user from this bot (needsByBot),
 * then its threads, an indented list on a thin rule. Each part shows SHOWN and keeps the rest behind
 * "Show N more". A bot with nothing under it has just its row, without the chip.
 */
export function WithThreads({
  user,
  ws,
  botId,
  name,
  threads,
  needs,
  okWaits,
  openAt = 0,
  selected,
  readOnly,
  row,
  onOpenThread,
  ...acts
}: {
  user: string;
  ws: string;
  botId: string;
  name: string;
  threads: Session[];
  needs?: BotNeeds;
  /** The threads Waiting for your OK (lib/types.ts waitsForOk), by id. */
  okWaits?: ReadonlySet<string>;
  openAt?: number;
  selected?: boolean;
  /** A shared workspace's bot: its threads are the owner's to delete, and what they ask the owner's to answer. */
  readOnly?: boolean;
  row: (space: ReactNode) => ReactNode;
  onOpenThread: (s: Session) => void;
} & NeedActs) {
  const [open, setOpen] = useRemembered(THREADS, user, ws, botId, false);
  useEffect(() => {
    if (openAt) setOpen(true);
    // Only when asked again: the user folding it afterwards keeps it folded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAt]);
  const cards = needs ? needCards(needs, acts) : [];
  const count = cards.length + threads.length;
  const any = count > 0;
  const mark = cards.length || threads.some((s) => okWaits?.has(s.id)) ? "you" : chipMark(threads, readOnly);
  const face = <ChipFace count={count} mark={mark} open={open} selected={selected} />;
  // The same elements around the row with something under it or not, so the first thing (or the last one
  // gone) doesn't put a new row in its place: its focus, hover and unread dot stay as they were.
  return (
    <div className="flex flex-col" data-bot-threads={any ? botId : undefined}>
      <div className="relative flex flex-col">
        {row(
          any ? (
            <span aria-hidden className="invisible flex shrink-0">
              {face}
            </span>
          ) : null,
        )}
        {any && (
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={
              cards.length
                ? `${name}: ${cards.length} waiting on you${threads.length ? `, ${threads.length} ${threads.length === 1 ? "thread" : "threads"}` : ""}`
                : `${name}'s threads, ${threads.length}${!open && mark === "you" ? ", one needs you" : !open && mark === "working" ? ", working" : ""}`
            }
            title={open ? "Hide" : cards.length ? "Show what needs you, and threads" : "Show threads"}
            className="absolute bottom-[13px] right-2.5 flex rounded-[7px] outline-none focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]"
          >
            {face}
          </button>
        )}
      </div>
      {any && (
        <Fold open={open} lazy>
          <div key={botId} className="mb-1 ml-[52px] mr-0.5 flex flex-col border-l border-[color:var(--c-e6e6e3)] pl-1.5">
            {cards.length > 0 && <Capped className="gap-1.5 pb-1.5 pt-0.5" rows={cards} />}
            {threads.length > 0 && <Capped rows={threads.map((s) => <ThreadRow key={s.id} session={s} onClick={() => onOpenThread(s)} readOnly={readOnly} okWait={okWaits?.has(s.id)} />)} />}
          </div>
        </Fold>
      )}
    </div>
  );
}

/* ---------------- Needs your attention ---------------- */

/** What waits on the user under one bot (needsByBot): what it asked their OK for (with its name, and the thread or routine it's for), its issues, alerts and setup. */
/** `shared`: an ask in a workspace shared with the user, of a bot they have at Write (answered through the owner's Bops). */
export type BotNeeds = { asks: { ask: AppApproval; botName: string; where?: string; shared?: boolean }[]; issues: Issue[]; alerts: Watch[]; setup: SetupItem[] };

/**
 * What waits on the user in this workspace, under the bot it's from: what it asked their OK for and waits on
 * (wherever its run runs: a bot's computer too), the issues its routines opened that
 * wait on us (Orbit's Waiting on us), its alerts worth interrupting for (a watch at level "now", or one
 * from before alerts had a level, the newest first), and under the main bot, which runs the team, what
 * this Mac still needs set up (setup.tsx useSetupWaiting). An issue no bot here opened is the main bot's
 * too. The threads that asked the user something stay first among their own bot's threads. In a workspace
 * shared with the user, only the asks of bots they have at Write (theirs to answer too): its alerts are its
 * owner's to answer, and the user's own issues and setup aren't its.
 */
export function needsByBot(state: AppState, issues: Issue[] | null, setup: SetupItem[]) {
  const out = new Map<string, BotNeeds>();
  const ws = currentWorkspace(state);
  const team = state.bots.filter((b) => workspaceOf(b) === ws);
  const main = (team.find((b) => b.isMain) ?? team[0])?.id;
  const of = (id: string) => {
    let n = out.get(id);
    if (!n) out.set(id, (n = { asks: [], issues: [], alerts: [], setup: [] }));
    return n;
  };
  for (const a of waitingAsks(state).sort((x, y) => y.at - x.at)) {
    const b = team.find((x) => x.id === a.botId);
    // (Never one only the owner answers: their apps or keys, or a thread on their Mac: answersAsk.)
    if (!b || (state.shared && (!canAct(state, [b.id]) || !answersAsk(state, a)))) continue;
    const where = state.sessions.find((x) => x.id === a.threadId)?.title ?? state.routines.find((x) => x.id === a.routineId)?.title;
    of(b.id).asks.push({ ask: a, botName: b.name, ...(where ? { where } : {}), ...(state.shared ? { shared: true } : {}) });
  }
  if (state.shared) return out;
  const owner = (id?: string) => (id && team.some((b) => b.id === id) ? id : main);
  for (const i of (issues ?? []).filter((i) => i.status === "waiting_us").sort(issueOrder)) {
    const id = owner(i.botId);
    if (id) of(id).issues.push(i);
  }
  // An alert stored before alerts had a level interrupts too (bops-app.tsx brings it forward), so it's urgent here.
  const urgent = (state.watches ?? []).filter((w) => team.some((b) => b.id === w.botId) && !!w.alert && (w.alert.level ?? "now") === "now");
  for (const w of urgent.sort((a, b) => b.alert!.at - a.alert!.at)) of(w.botId).alerts.push(w);
  if (main && setup.length) of(main).setup.push(...setup);
  return out;
}

/**
 * Needs your attention: how many things wait on the user (what's under each bot, and the threads that
 * asked them something), and the bots they're under, which it opens. In a workspace shared with the user,
 * only what the threads of bots they have at Write ask that's theirs to answer (never a sign in at the
 * owner's screen, where it runs, an OK on the owner's phone, or anything of a thread on the owner's Mac: writesThread):
 * the rest waits on its owner.
 */
export function attentionOf(state: AppState, needs: Map<string, BotNeeds>) {
  const theirs = (s: Session) => writesThread(state, s) && !s.blocker && s.brainRun?.waits !== "sign_in" && !(s.askWhere && live(s)) && askKind(s) !== "elsewhere";
  const waiting = threadsOf(state).filter((s) => needsYou(s) && (!state.shared || theirs(s)));
  let count = waiting.length;
  // A request of a thread already counted counts once.
  const counted = new Set(waiting.map((s) => s.id));
  for (const n of needs.values()) count += n.asks.filter((x) => !x.ask.threadId || !counted.has(x.ask.threadId)).length + n.issues.length + n.alerts.length + n.setup.length;
  return { count, bots: new Set([...needs.keys(), ...waiting.map((s) => s.botId)]) };
}

/** A row in Favorites: its mark, its words, and what's on its right. */
const ROW =
  "group/item flex h-[34px] shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)]";

/** A section's heading: its name, a count, and the chevron that folds it. */
function SectionHead({ label, count, open, scope, onToggle }: { label: string; count?: number; open: boolean; scope: string; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      data-list-heading
      className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-left text-[13px] font-medium leading-4 text-[color:var(--c-9a9a98)] outline-none hover:bg-black/[0.03] hover:text-[color:var(--c-6b6b6b)] focus-visible:shadow-[inset_0_0_0_1.5px_var(--c-0a0a0a)]"
    >
      <span>{label}</span>
      {count !== undefined && <Count n={count} quiet={false} scope={scope} className="rounded-full bg-[color:var(--c-eeeeec)] px-1.5 text-[11.5px] leading-4 tabular-nums text-[color:var(--c-6b6b6b)]" />}
      <span className="flex-1" />
      <Chevron open={open} />
    </button>
  );
}

/* ---------------- Favorites ---------------- */

/** A pinned kind's mark, as its chip and page draw it. */
function KindIcon({ id }: { id: FavoriteKind }) {
  return (
    <span className="flex size-[18px] items-center justify-center rounded-full bg-[color:var(--c-eeeeec)] text-[color:var(--c-6b6b6b)]">{id === "skills" ? <SkillsIcon size={11} /> : <CategoryIcon id={id} size={11} />}</span>
  );
}

/** How many issues are open, for the Issues row (read as Knowledge reads them; none of the user's own in a shared workspace). */
function IssuesMeta({ ws, user, on }: { ws: string; user: string; on: boolean }) {
  const { list } = useIssues(ws, user, on);
  return <Meta text={favoriteCount("issues", null, list ? list.issues.filter(isOpen).length : undefined)} />;
}

/** What's due or coming, for a Tasks, Promises or Events row (the same copy of the categories the footer and the page read). */
function MemoryMeta({ id, ws, user }: { id: FavoriteKind; ws: string; user: string }) {
  const { snap } = useMemoryCategories(ws, user);
  return <Meta text={favoriteCount(id, snap?.on ? snap.items : null, undefined)} />;
}

function Meta({ text }: { text: string | null }) {
  return text ? <span className="shrink-0 text-[12px] leading-4 tabular-nums text-[color:var(--c-9a9a98)]">{text}</span> : null;
}

/**
 * Favorites: first, while anything waits on the user, Needs your attention, which opens every bot it's
 * under (attentionOf), and then the Knowledge kinds pinned to the sidebar (Issues, Tasks and People
 * until the user changes them; lib/favorites.ts), in their order, while Knowledge is there and something
 * is pinned. A kind's row opens Knowledge at it, with a number only when there's something to act on. Rows drag
 * to a new place, or move with Option and the up or down arrow from the keyboard; a right-click has
 * Remove from Favorites, Move up and Move down. None of that in a workspace shared with the user, which
 * is read only (useFavorites `can`). It folds with its heading (open until folded, per workspace on this Mac).
 */
export function FavoritesSection({
  state,
  attention = 0,
  onAttention,
  onOpenMemory,
}: {
  state: AppState;
  /** How many things wait on the user (attentionOf), and what opens them. */
  attention?: number;
  onAttention?: () => void;
  onOpenMemory: (open: MemoryOpen) => void;
}) {
  const user = state.account?.user.id ?? "";
  const ws = currentWorkspace(state);
  const favorites = useFavorites(state, ws);
  const [open, setOpen] = useRemembered(GROUP, user, ws, "favorites", true);
  const [menu, setMenu] = useState<{ id: FavoriteKind; x: number; y: number } | null>(null);
  // Dragging: the row held, and the one it would land before (null: at the end).
  const [drag, setDrag] = useState<{ id: FavoriteKind; before: FavoriteKind | null } | null>(null);
  const rows = useRef<HTMLDivElement>(null);
  const list = favorites.shown;
  const kinds = categoriesOpen(state) && list.length > 0;
  if (!kinds && !attention) return null;
  const items = (id: FavoriteKind): MenuItem[] => [
    { label: "Remove from Favorites", onPick: () => favorites.save(toggledFavorite(favorites.stored, id)) },
    { label: "Move up", disabled: list[0] === id, onPick: () => favorites.save(nudgedFavorite(favorites.stored, id, -1)) },
    { label: "Move down", disabled: list[list.length - 1] === id, onPick: () => favorites.save(nudgedFavorite(favorites.stored, id, 1)) },
  ];
  // Dropped where it was: nothing saved (the defaults stay the defaults).
  const drop = () => {
    const next = drag ? movedFavorite(favorites.stored, drag.id, drag.before) : null;
    if (next && next.join() !== favorites.stored.join()) favorites.save(next);
    setDrag(null);
  };
  // Option and an arrow moves the row with the keyboard; focus stays on it in its new place.
  const nudge = (id: FavoriteKind, by: -1 | 1) => {
    const next = nudgedFavorite(favorites.stored, id, by);
    if (next.join() === favorites.stored.join()) return;
    favorites.save(next);
    requestAnimationFrame(() => rows.current?.querySelector<HTMLElement>(`[data-favorite="${id}"]`)?.focus());
  };
  return (
    <section aria-label="Favorites" data-section="favorites" className="flex shrink-0 flex-col pb-3">
      <SectionHead label="Favorites" open={open} scope={ws} onToggle={() => setOpen(!open)} />
      <Fold open={open}>
        {attention > 0 && (
          <button data-favorite="attention" onClick={onAttention} title="Open every bot with something waiting on you" className={ROW}>
            <span className="flex size-[18px] shrink-0 items-center justify-center">
              <NeedsYouDot />
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px] text-ink">Needs your attention</span>
            <Meta text={String(attention)} />
          </button>
        )}
        <div ref={rows} className="flex flex-col" onDragOver={(e) => drag && e.preventDefault()} onDrop={(e) => (e.preventDefault(), drop())}>
          {(kinds ? list : []).map((id, i) => {
            const label = favoriteLabel(id);
            const meta = id === "issues" ? <IssuesMeta ws={ws} user={user} on={!state.shared} /> : id === "todos" || id === "promises" || id === "events" ? <MemoryMeta id={id} ws={ws} user={user} /> : null;
            const line = drag && drag.id !== id && drag.before === id && list[i - 1] !== drag.id;
            return (
              <button
                key={id}
                data-favorite={id}
                draggable={favorites.can}
                onClick={() => onOpenMemory({ category: id })}
                aria-keyshortcuts={favorites.can ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onKeyDown={(e) => {
                  if (!favorites.can || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  nudge(id, e.key === "ArrowUp" ? -1 : 1);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (favorites.can) setMenu({ id, ...menuPoint(e) });
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", label);
                  setDrag({ id, before: list[i + 1] ?? null });
                }}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const before = e.clientY < r.top + r.height / 2 ? id : (list[i + 1] ?? null);
                  if (before !== drag.before) setDrag({ ...drag, before });
                }}
                onDragEnd={() => setDrag(null)}
                className={`${ROW} relative ${drag?.id === id ? "opacity-40" : ""}`}
              >
                {line && <span aria-hidden className="pointer-events-none absolute inset-x-2.5 -top-px h-[2px] rounded-full bg-ink" />}
                <KindIcon id={id} />
                <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px] text-ink">{label}</span>
                {meta}
              </button>
            );
          })}
          {drag && drag.before === null && list[list.length - 1] !== drag.id && <span aria-hidden className="mx-2.5 h-[2px] rounded-full bg-ink" />}
        </div>
      </Fold>
      {menu && <SideMenu x={menu.x} y={menu.y} label={favoriteLabel(menu.id)} items={items(menu.id)} onClose={() => setMenu(null)} />}
    </section>
  );
}
