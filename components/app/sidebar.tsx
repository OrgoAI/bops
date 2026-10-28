"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { MAIN_WORKSPACE, waitingAsks, WORKSPACE_APPS_SINCE, workspaceOf, type AppState, type Chat, type Session, type Watch } from "@/lib/types";
import { initialsOf, signOutOfOrgo } from "./account";
import { AutopilotButton, AutopilotSections, type AutopilotOpen } from "./autopilot";
import { categoriesOpen } from "@/lib/memory-categories";
import { KeyIcon } from "./screen-cards";
import { MembersButton } from "./members";
import { FooterButton, footerPillOf, useFooterHover, type FooterKey, type FooterPage } from "./sidebar-footer";
import { AppsIcon } from "./made-apps";
import { KnowledgeIcon, useKnowledgeNews, type MemoryOpen } from "./memory-categories";
import { AppLogo } from "./apps";
import { BotMenu, type BotMenuActions } from "./bot-menu";
import { RestartConfirm, RestartIcon, useCanRestart } from "./restart";
import { useSetupNeedsYou, useSetupWaiting } from "./setup";
import { DeleteX, forgetShown, rememberShown, undash, usePop } from "./side-group";
import { attentionOf, FavoritesSection, needsByBot, threadOrder, threadsByBot, threadsOf, ThreadRow, WithThreads } from "./sidebar-sections";
import { useIssues } from "./orbit-issues";
import { UpdateNotice } from "./update-notice";
import { forgetWorkspaceHere } from "@/lib/workspace-local";
import { ago, ChatAvatar, chatInWorkspace, chatName, currentWorkspace, NeedsYouDot, post, RoundButton, SideToggleIcon, useNow } from "./ui";
import { ownerWho, roleLabel, saidBy, saidName, sharedBy, type SharedWorkspace } from "@/lib/shared";
import { appsShown } from "@/lib/apps-access";

/** A chat's newest message, if it has one. */
export const lastMessageOf = (state: AppState, c: Chat) => [...state.messages].reverse().find((m) => m.chatId === c.id);

/** The workspace's chats as the sidebar lists them (folded to its rail too): the main bot's first, as it runs the team, then by latest activity. */
export function sidebarChats(state: AppState): Chat[] {
  const activity = (c: Chat) => lastMessageOf(state, c)?.at ?? c.createdAt;
  const pin = (c: Chat) => (c.kind === "bot" && state.bots.find((x) => x.id === c.botIds[0])?.isMain ? 1 : 0);
  return state.chats.filter((c) => chatInWorkspace(state, c)).sort((a, b) => pin(b) - pin(a) || activity(b) - activity(a));
}

/**
 * The sidebar for one workspace (switch at the top). On top, Favorites: Needs your attention while
 * anything waits on the user, then the Knowledge kinds they pinned (sidebar-sections.tsx). Then the list:
 * one row per conversation (Sam pinned, with a star on its avatar, then by latest activity), each with
 * its last message and a dot when there's something you haven't read, like iMessage. Under each bot's
 * own row, folded until opened: what waits on the user from it, as cards (the issues its routines opened
 * that wait on us, its urgent alerts, Setup under the main bot), then its threads, with a chip that says
 * how many there are and, folded, whether something needs you or a thread is working. Needs your
 * attention opens every bot with something waiting. A search lists everything together: the chats,
 * then the threads that match, flat.
 */
export function Sidebar({
  state,
  chatId,
  onOpenChat,
  onOpenThread,
  onCompose,
  onSettings,
  onAccount,
  onSetup,
  onVault,
  onApps,
  onMembers,
  onOpenWatch,
  onOpenMemory,
  onOpenAutopilot,
  footer,
  menuActions: actions,
  onCollapse,
  search = null,
  workspaces = false,
}: {
  state: AppState;
  chatId: string;
  onOpenChat: (chatId: string) => void;
  onOpenThread: (session: Session) => void;
  onCompose: () => void;
  onSettings: () => void;
  onAccount: () => void;
  /** The setup screen: what this Mac gives Bops (setup.tsx). */
  onSetup: () => void;
  onVault: () => void;
  /** The apps the bots made (made-apps.tsx). */
  onApps: () => void;
  /** The People sheet: who can see the bots' computers on Orgo (members.tsx). */
  onMembers: () => void;
  /** Show a watched screen or Mac window (a watched page: its row on the Routines page). */
  onOpenWatch: (watch: Watch) => void;
  /** Open Knowledge on the right, on a kind, an item or a search (memory-categories.tsx). */
  onOpenMemory: (open: MemoryOpen) => void;
  /** Open Routines on the right, at a section and one of its rows (autopilot.tsx). */
  onOpenAutopilot: (open: AutopilotOpen) => void;
  /** Which of the footer's buttons is the pill: the page open on the right (sidebar-footer.tsx footerPageOf). */
  footer?: FooterPage;
  /** What a bot's right-click menu does (bot-menu.tsx). */
  menuActions?: BotMenuActions;
  /** Fold the sidebar to its rail of icons (sidebar-rail.tsx, which unfolds it again). */
  onCollapse?: () => void;
  /** Searching for this from the start (expanded from the rail's Search: ""; tests). */
  search?: string | null;
  /** The workspace switcher open from the start (expanded from the rail's workspace). */
  workspaces?: boolean;
}) {
  const [query, setQuery] = useState<string | null>(search);
  const q = query?.trim().toLowerCase();
  // A workspace shared with the user is read only: no bot menu, and nothing new is made in it.
  const menuActions = state.shared ? undefined : actions;
  // A bot's right-click menu (bot-menu.tsx): which bot, and where it was asked for.
  const [menu, setMenu] = useState<{ botId: string; x: number; y: number } | null>(null);
  const menuBot = menu ? state.bots.find((b) => b.id === menu.botId) : undefined;
  /** A bot's chat opens its menu on right-click; a group's has none (the browser's own is kept off it too). */
  const openMenu = (c: Chat) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (c.kind === "bot" && menuActions) setMenu({ botId: c.botIds[0], x: e.clientX, y: e.clientY });
  };
  // The "5m" next to each chat stays current.
  useNow(30_000);
  // After each paint, every thread, watch, schedule and procedure in the state is known (in every
  // workspace, whatever a search hides), so only one that turns up from here on rises in (side-group.tsx).
  // The cards under the bots too, each by what it's for (an alert, an issue, a setup item), so one that
  // comes to need the user later rises in.
  const setup = useSetupWaiting(state);
  useEffect(() => {
    rememberShown(state.sessions.map((s) => s.id));
    rememberShown((state.watches ?? []).map((w) => w.id));
    rememberShown(state.routines.map((r) => r.id));
    rememberShown((state.watches ?? []).flatMap((w) => (w.alert ? [`alert:${w.id}:${w.alert.at}`] : [])));
    rememberShown((state.appApprovals ?? []).map((a) => `ask:${a.id}`));
  }, [state.sessions, state.watches, state.routines, state.appApprovals]);
  useEffect(() => rememberShown(setup.map((i) => `setup:${i}`)), [setup]);
  // Gone with the sidebar (signing out), so the next sign-in's first paint has nothing new in it either.
  useEffect(() => forgetShown, []);

  const lastMessage = (c: Chat) => lastMessageOf(state, c);
  const ws = currentWorkspace(state);
  const chats = sidebarChats(state).filter((c) => !q || chatName(c, state.bots).toLowerCase().includes(q) || state.messages.some((m) => m.chatId === c.id && m.text.toLowerCase().includes(q)));

  // Each bot's threads, under its row (a quiet routine's run that found nothing for the user posted
  // nothing, so it isn't listed either). A search lists the ones that match, flat, under Threads.
  const byBot = threadsByBot(state);
  const found = q ? threadsOf(state).filter((s) => s.title.toLowerCase().includes(q)).sort(threadOrder).slice(0, 6) : [];
  const user = state.account?.user.id ?? "";
  // What waits on the user, under the bot it's from. Issues are read as Knowledge reads them (the same
  // copy as Favorites' Issues), while Knowledge is there. Neither the user's issues nor this Mac's setup
  // go under a shared workspace's bots: they're the user's own, not its owner's.
  const { list: issues } = useIssues(ws, user, categoriesOpen(state) && !state.shared);
  useEffect(() => rememberShown((issues?.issues ?? []).map((i) => `issue:${i.id}`)), [issues]);
  const needs = needsByBot(state, issues?.issues ?? null, state.shared ? [] : setup);
  // The threads Waiting for your OK: a request of theirs is unanswered (lib/types.ts waitsForOk), wherever they run.
  const okWaits = new Set(waitingAsks(state).flatMap((a) => (a.threadId ? [a.threadId] : [])));
  const attention = attentionOf(state, needs);
  // Needs your attention opens every bot with something waiting (how many times it's been asked, and which bots).
  const [opened, setOpened] = useState<{ at: number; bots: Set<string> } | null>(null);
  const openAttention = () => {
    setOpened({ at: (opened?.at ?? 0) + 1, bots: attention.bots });
    // The first of them (the main bot, pinned first, when it has some) comes into view.
    const sel = [...attention.bots].map((id) => `[data-bot-threads="${CSS.escape(id)}"]`).join(",");
    requestAnimationFrame(() => sel && document.querySelector<HTMLElement>(sel)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  /** A bot's chat row with what's under it (none for a group's). */
  const withThreads = (c: Chat, row: (space: ReactNode) => ReactNode) => {
    const b = c.kind === "bot" ? state.bots.find((x) => x.id === c.botIds[0]) : undefined;
    if (!b) return row(null);
    return (
      <WithThreads
        key={c.id}
        user={user}
        ws={ws}
        botId={b.id}
        name={b.name}
        threads={byBot.get(b.id) ?? []}
        needs={needs.get(b.id)}
        okWaits={okWaits}
        openAt={opened?.bots.has(b.id) ? opened.at : 0}
        selected={c.id === chatId}
        readOnly={!!state.shared}
        row={row}
        onOpenThread={onOpenThread}
        onOpenIssue={(i) => onOpenMemory({ category: "issues", focus: i.id })}
        onOpenWatch={onOpenWatch}
        onSetup={onSetup}
        onOpenAsk={(a) => {
          const t = a.threadId ? state.sessions.find((x) => x.id === a.threadId) : undefined;
          if (t) onOpenThread(t);
          else onOpenChat(a.chatId ?? c.id);
        }}
      />
    );
  };

  return (
    // Its color and edge are the column's (bops-app.tsx), which it keeps folded to the rail (sidebar-rail.tsx);
    // its width is its own, so sliding open it's uncovered rather than squeezed.
    <aside className="flex min-h-0 w-[340px] shrink-0 flex-col px-2.5 pb-3 pt-3.5">
      <div className="flex items-center justify-between pb-3 pl-2.5 pr-2">
        {query === null ? (
          <WorkspaceSwitcher state={state} opened={workspaces} />
        ) : (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
            // Clicking away from an empty search closes it (not when the click is on the search button, which toggles it).
            onBlur={(e) => !query.trim() && e.relatedTarget?.getAttribute("aria-label") !== "Search" && setQuery(null)}
            placeholder={categoriesOpen(state) ? "Search bots, chats, threads, people" : "Search bots, chats, threads"}
            className="motion-fade-in mr-2 h-[34px] min-w-0 flex-1 rounded-full bg-white px-3.5 text-[13px] shadow-[0_0_0_1px_#E6E6E3] outline-none placeholder:text-[#9A9A98]"
          />
        )}
        <div className="flex items-center gap-2">
          {onCollapse && (
            <button
              onClick={onCollapse}
              title="Collapse the sidebar (⌘\)"
              aria-label="Collapse the sidebar"
              className="flex size-[34px] shrink-0 items-center justify-center rounded-full hover:bg-black/[0.05]"
            >
              <SideToggleIcon side="left" open />
            </button>
          )}
          <RoundButton label="Search" active={query !== null} onClick={() => setQuery(query === null ? "" : null)}>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="#0A0A0A" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" fill="none" stroke="#0A0A0A" strokeWidth="1.5" strokeLinecap="round" />
          </RoundButton>
          {!state.shared && (
            <RoundButton label="New chat or bot" onClick={onCompose}>
              <path d="M8 3v10M3 8h10" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
            </RoundButton>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* What needs you and what you pinned: over everything, and gone while you search. */}
        {!q && <FavoritesSection state={state} attention={attention.count} onAttention={openAttention} onOpenMemory={onOpenMemory} />}
        {/* The main bot's row first (it runs the team), then the rest by latest activity. */}
        <div className="flex flex-col gap-0.5">
          {chats.map((c) => {
            const row = (space: ReactNode) => (
              <ChatRow key={c.id} chat={c} state={state} selected={c.id === chatId} onClick={() => onOpenChat(c.id)} onMenu={openMenu(c)} menuOpen={!!menu && c.kind === "bot" && c.botIds[0] === menu.botId} last={lastMessage(c)} trail={space} />
            );
            return q ? row(null) : withThreads(c, row);
          })}
        </div>

        {/* A search looks in Knowledge too: one row that opens it with the search filled in. */}
        {!!q && categoriesOpen(state) && (
          <button onClick={() => onOpenMemory({ query: query ?? "" })} className="mt-1 flex h-[38px] items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[14px] leading-[18px] text-[#3A3A38] hover:bg-black/[0.03]">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#F2F2F0] text-[#3A3A38]">
              <KnowledgeIcon size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              Search knowledge for &ldquo;{query?.trim()}&rdquo;
            </span>
          </button>
        )}

        {found.length > 0 && (
          <div className="flex flex-col pt-4">
            <div className="px-2.5 pb-1.5 text-[13px] font-medium leading-4 text-[#9A9A98]">Threads</div>
            {found.map((s) => (
              <ThreadRow key={s.id} session={s} onClick={() => onOpenThread(s)} readOnly={!!state.shared} okWait={okWaits.has(s.id)} />
            ))}
          </div>
        )}
      </div>

      {/*
        Pinned under the chats while searching: the routines that match. Routines and Knowledge (with
        Skills in it) open from the footer.
      */}
      {!!query?.trim() && (
        <div className="-mx-2.5 shrink-0 border-t border-[#ECECEA] px-2.5 empty:hidden">
          <AutopilotSections state={state} query={query} onOpen={onOpenAutopilot} onOpenWatch={onOpenWatch} />
        </div>
      )}
      {/* A newer Bops: downloading, ready to Restart into, or out on bops.bot (the Mac app checks and downloads it). */}
      <UpdateNotice />
      {/* You, then People, your logins (the Vault, with the apps you've connected), Routines, Knowledge and the apps your bots made (sidebar-footer.tsx). New bots are the + at the top. */}
      <SidebarFooter
        state={state}
        open={footer}
        you={(expanded) => <YouMenuView state={state} expanded={expanded} needsYou={setup.length > 0} onAccount={onAccount} onSettings={onSettings} onSetup={onSetup} />}
        onMembers={onMembers}
        onVault={onVault}
        onOpenAutopilot={onOpenAutopilot}
        onOpenMemory={onOpenMemory}
        onApps={onApps}
      />
      {menu && menuBot && menuActions && <BotMenu state={state} bot={menuBot} x={menu.x} y={menu.y} onClose={() => setMenu(null)} actions={menuActions} />}
    </aside>
  );
}

/**
 * The footer's row: `you` (your account: the initials and their menu, given whether it's the pill), then
 * People, Logins, Routines, Knowledge and Apps (the apps your bots made). The pill (with its label) is
 * the one pointed at or tabbed to, else the one `open` names (sidebar-footer.tsx footerPageOf,
 * footerPillOf); the others are round.
 * Picking one opens its page, and that one is the pill at rest. `hover` seeds the pointed-at one, and
 * `news` whether Knowledge has something new (tests).
 */
export function SidebarFooter({
  state,
  open = "vault",
  hover: initialHover,
  news,
  vertical = false,
  you,
  onMembers,
  onVault,
  onOpenAutopilot,
  onOpenMemory,
  onApps,
}: {
  state: AppState;
  /** The page that's open; null, none (only the vertical column says so: the row's pill rests on Logins). */
  open?: FooterPage | null;
  hover?: FooterKey;
  news?: boolean;
  /**
   * The folded sidebar's (sidebar-rail.tsx): the same buttons in a column, every one round, the open
   * page's filled in grey, and you at the bottom. Their tooltips say what they are.
   */
  vertical?: boolean;
  you: (expanded: boolean) => ReactNode;
  onMembers: () => void;
  onVault: () => void;
  onOpenAutopilot: (open: AutopilotOpen) => void;
  onOpenMemory: (open: MemoryOpen) => void;
  /** The Apps home: the apps the bots made (made-apps.tsx). */
  onApps: () => void;
}) {
  const knowledge = categoriesOpen(state);
  // Apps only for an @orgo.ai account for now (lib/apps-access.ts), and never in a shared workspace (they're its owner's).
  const apps = appsShown(state);
  const page = (open === "knowledge" && !knowledge) || (open === "apps" && !apps) ? "vault" : open;
  const { hover, row } = useFooterHover(initialHover);
  const pill = vertical ? null : footerPillOf({ rest: page ?? "vault", hover: (hover === "knowledge" && !knowledge) || (hover === "apps" && !apps) ? null : hover });
  const pages = (
    <>
      <MembersButton state={state} expanded={pill === "people"} pressed={page === "people"} onClick={onMembers} />
      <FooterButton
        name="vault"
        expanded={pill === "vault"}
        pressed={page === "vault"}
        label="Logins"
        tip="Your accounts and logins, and which bots can use them"
        onClick={onVault}
        trail={<AppsTrail state={state} expanded={pill === "vault"} />}
      />
      <AutopilotButton state={state} expanded={pill === "routines"} pressed={page === "routines"} onOpen={onOpenAutopilot} />
      {knowledge && <KnowledgeButton state={state} expanded={pill === "knowledge"} pressed={page === "knowledge"} news={news} onOpen={() => onOpenMemory({})} />}
      {apps && <FooterButton name="apps" expanded={pill === "apps"} pressed={page === "apps"} label="Apps" tip="Apps your bots made for you" onClick={onApps} icon={<AppsIcon size={16} />} />}
    </>
  );
  if (vertical)
    return (
      // Each slot held to a circle (your initials too, however wide).
      <div data-footer-column className="flex flex-col items-center gap-2 pt-3 [&_button[aria-pressed=true]]:bg-[#EEEEEC] [&>[data-footer-key]]:w-9">
        {pages}
        {you(false)}
      </div>
    );
  return (
    <div {...row} data-footer-row className="flex items-center gap-1 pb-1 pt-3">
      {you(pill === "you")}
      {pages}
    </div>
  );
}

/**
 * Knowledge in the footer, with a blue dot on its corner while there's something new in it (what memory
 * learned since it was last open: memory-categories.tsx useKnowledgeNews), none while it's the open page.
 * `news` is for the tests.
 */
export function KnowledgeButton({ state, expanded, pressed, news: given, onOpen }: { state: AppState; expanded: boolean; pressed: boolean; news?: boolean; onOpen: () => void }) {
  const fresh = useKnowledgeNews(currentWorkspace(state), state.account?.user.id ?? "");
  const news = (given ?? fresh) && !pressed;
  return (
    <FooterButton
      name="knowledge"
      expanded={expanded}
      pressed={pressed}
      label="Knowledge"
      tip={state.shared ? "Knowledge: what the owner's bots know" : news ? "Knowledge: something new your bots learned" : "Knowledge: what your bots know, learned as you chat"}
      ariaLabel={news ? "Knowledge, something new" : undefined}
      onClick={onOpen}
      icon={<KnowledgeIcon size={16} />}
      badge={news && <NewDot />}
    />
  );
}

/** A small blue dot with a soft ring that swells out of it and fades, over and over (with reduced motion, it keeps still). */
function NewDot() {
  return (
    <span data-new-dot className="motion-dot-in pointer-events-none absolute -right-px -top-px flex size-2.5">
      <span className="motion-new-pulse absolute inset-0 rounded-full bg-[#2F7BFF] motion-reduce:hidden" />
      <span className="relative size-2.5 rounded-full bg-[#2F7BFF] shadow-[0_0_0_2px_#F9F9F8,0_0_0_4px_#2F7BFF2E]" />
    </span>
  );
}

/**
 * Logins' end: as the pill, the apps you've connected; round, the Vault's key. Both are there
 * and fade with the label (globals.css .motion-footer-label), so the logos don't pop in or out as it
 * grows or shrinks; the key sits over the middle of the round button.
 */
function AppsTrail({ state, expanded }: { state: AppState; expanded: boolean }) {
  return (
    <span className="relative flex items-center">
      <span aria-hidden className={`motion-footer-label flex min-w-0 overflow-hidden py-0.5 ${expanded ? "max-w-[48px] opacity-100" : "max-w-0 opacity-0"}`}>
        <AppStack state={state} />
      </span>
      <span aria-hidden className={`motion-footer-label pointer-events-none absolute inset-0 flex items-center justify-center ${expanded ? "opacity-0" : "opacity-100"}`}>
        <KeyIcon />
      </span>
    </span>
  );
}

/** The apps you've connected, as up to three overlapping logos (none yet: the Vault's key). */
function AppStack({ state }: { state: AppState }) {
  const apps = [...new Map((state.accounts ?? []).filter((a) => a.status === "active").map((a) => [a.app, a])).values()].slice(0, 3);
  if (!apps.length) return <KeyIcon />;
  return (
    <span className="flex shrink-0 items-center">
      {apps.map((a, i) => (
        <span key={a.app} className={`flex rounded-[5px] bg-white shadow-[0_0_0_1.5px_#FFFFFF] ${i ? "-ml-2" : ""}`}>
          <AppLogo app={a.app} name={a.appName} size={18} />
        </span>
      ))}
    </span>
  );
}

/**
 * You, at the bottom of the sidebar: your initials, and a menu with your Orgo account (plan and
 * usage), Settings, this Mac's permissions, Restart Bops (in the Mac app; restart.tsx) and signing
 * out. Like the footer's other buttons it's a slot that grows into the pill while pointed at
 * (`expanded`), with your name (or email) after the initials. While something on this Mac still needs
 * you (and you haven't skipped it on the setup screen), a badge on your initials opens that screen and
 * the menu item carries the same mark.
 */
export function YouMenu(props: { state: AppState; expanded?: boolean; onAccount: () => void; onSettings: () => void; onSetup: () => void }) {
  return <YouMenuView {...props} needsYou={useSetupNeedsYou(props.state)} />;
}

/** YouMenu, told whether this Mac needs something (the sidebar and its rail read that once, for Needs you too). */
export function YouMenuView({
  state,
  expanded = false,
  needsYou,
  onAccount,
  onSettings,
  onSetup,
}: {
  state: AppState;
  expanded?: boolean;
  needsYou: boolean;
  onAccount: () => void;
  onSettings: () => void;
  onSetup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [restart, setRestart] = useState(false);
  const canRestart = useCanRestart();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    // Esc closes the menu, and only the menu (preventDefault keeps the Vault or a profile on the right open).
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), setOpen(false));
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const user = state.account?.user;
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const item = "flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[14px] font-medium hover:bg-black/[0.04]";
  const name = user?.name?.trim() || user?.email || state.owner?.name?.trim() || "You";
  return (
    <div ref={box} data-footer-slot="You" data-footer-key="you" className={`motion-footer-slot relative flex h-9 min-w-9 basis-9 ${expanded ? "grow" : "grow-0"} shrink`}>
      <button
        onClick={() => setOpen(!open)}
        title={expanded ? undefined : user ? `${user.name ?? user.email ?? "Your account"}: account and settings` : "Account and settings"}
        aria-label={`${name}: account and settings`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-9 w-full min-w-0 items-center justify-center overflow-hidden rounded-full px-2.5 text-[13px] font-semibold outline-none transition-[background-color,color,transform] duration-150 ease-out focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] active:scale-[.96] motion-reduce:transition-none ${open ? "bg-ink text-highlighter" : "bg-[#EEEEEC] text-[#6B6B6B] hover:bg-[#E6E6E3]"}`}
      >
        <span className="shrink-0">{initialsOf(state)}</span>
        <span aria-hidden className={`motion-footer-label min-w-0 truncate whitespace-nowrap text-[13.5px] font-medium ${open ? "text-highlighter" : "text-ink"} ${expanded ? "max-w-[160px] translate-x-0 pl-1.5 opacity-100" : "max-w-0 -translate-x-1 pl-0 opacity-0"}`}>
          {name}
        </span>
      </button>
      {/* Pops as it appears: YouMenu stays mounted, so polls don't replay it (at launch it may pop once, as the permissions are first read). */}
      {needsYou && (
        <button
          onClick={() => {
            setOpen(false);
            onSetup();
          }}
          title="Something on this Mac needs you"
          aria-label="Something on this Mac needs you"
          className="motion-dot-in absolute -bottom-0.5 -left-0.5 rounded-full shadow-[0_0_0_2px_#F9F9F8]"
        >
          <NeedsYouDot />
        </button>
      )}
      {open && (
        // Over the chat column's own sheets (z-40, z-50) when it opens from the rail, past the column's edge.
        <div className="motion-menu-in absolute bottom-[calc(100%+8px)] left-0 z-[60] flex w-[248px] origin-bottom-left flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_rgba(0,0,0,0.12)]">
          <div className="flex flex-col gap-0.5 px-2.5 pb-2 pt-1.5">
            <span className="truncate text-[14px] font-semibold leading-[18px]">{user?.name || state.owner?.name || "You"}</span>
            <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{user ? (user.email ?? "Signed in with Orgo") : "Not signed in"}</span>
          </div>
          <div className="mx-2 mb-1 h-px bg-[#ECECEA]" />
          <button onClick={pick(onAccount)} className={item}>
            <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0">
              <circle cx="8" cy="5.5" r="2.8" fill="none" stroke="#0A0A0A" strokeWidth="1.4" />
              <path d="M2.8 13.5c.8-2.6 2.8-3.9 5.2-3.9s4.4 1.3 5.2 3.9" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            Account and usage
          </button>
          <button onClick={pick(onSettings)} className={item}>
            <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0">
              <path d="M3 4.5h10M3 8h10M3 11.5h10" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="6" cy="4.5" r="1.6" fill="#fff" stroke="#0A0A0A" strokeWidth="1.3" />
              <circle cx="10.5" cy="8" r="1.6" fill="#fff" stroke="#0A0A0A" strokeWidth="1.3" />
              <circle cx="5" cy="11.5" r="1.6" fill="#fff" stroke="#0A0A0A" strokeWidth="1.3" />
            </svg>
            Settings
          </button>
          <button onClick={pick(onSetup)} className={item}>
            <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0">
              <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4" fill="none" stroke="#0A0A0A" strokeWidth="1.4" />
              <path d="M5.8 13.6h4.4" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span className="flex-1">Permissions on this Mac</span>
            {needsYou && <NeedsYouDot />}
          </button>
          {canRestart && (
            <button onClick={pick(() => setRestart(true))} className={item}>
              <RestartIcon />
              Restart Bops
            </button>
          )}
          {user && (
            <>
              <div className="mx-2 my-1 h-px bg-[#ECECEA]" />
              <button onClick={pick(() => void signOutOfOrgo())} className={`${item} text-[#6B6B6B] hover:text-[#B42318]`}>
                <span className="w-[15px] shrink-0" />
                Sign out
              </button>
            </>
          )}
        </div>
      )}
      {restart && <RestartConfirm onClose={() => setRestart(false)} />}
    </div>
  );
}

/**
 * The main bot's mark: a small star on its avatar's corner, cut out of the row with a ring of the row's
 * own color (selected, hovered or not), so it reads as a badge and not as part of the mascot.
 */
export function MainStar({ selected }: { selected: boolean }) {
  return (
    <span
      role="img"
      aria-label="Runs the team"
      title="Runs the team"
      className={`absolute -bottom-px -right-px flex size-4 items-center justify-center rounded-full bg-highlighter ${selected ? "shadow-[inset_0_0_0_1px_#0A0A0A,0_0_0_2px_#EEEEEC]" : "shadow-[inset_0_0_0_1px_#0A0A0A,0_0_0_2px_#F9F9F8] group-hover/chat:shadow-[inset_0_0_0_1px_#0A0A0A,0_0_0_2px_#F2F2F1]"}`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
        <path
          d="M11.54 3.54Q12 2.5 12.46 3.54L14.61 8.36Q14.9 9.01 15.61 9.08L20.85 9.64Q21.99 9.76 21.14 10.52L17.22 14.05Q16.69 14.53 16.84 15.22L17.94 20.38Q18.17 21.5 17.18 20.93L12.62 18.29Q12 17.94 11.38 18.29L6.82 20.93Q5.83 21.5 6.06 20.38L7.16 15.22Q7.31 14.53 6.78 14.05L2.86 10.52Q2.01 9.76 3.15 9.64L8.39 9.08Q9.1 9.01 9.39 8.36Z"
          fill="#0A0A0A"
        />
      </svg>
    </span>
  );
}

function ChatRow({
  chat: c,
  state,
  selected,
  onClick,
  onMenu,
  menuOpen,
  last,
  trail,
}: {
  chat: Chat;
  state: AppState;
  selected: boolean;
  onClick: () => void;
  onMenu?: (e: React.MouseEvent) => void;
  /** Its bot's right-click menu is open: the row is outlined. */
  menuOpen?: boolean;
  last?: AppState["messages"][number];
  /** At the end of the preview line: the room its threads' chip takes (sidebar-sections.tsx WithThreads). */
  trail?: ReactNode;
}) {
  const members = state.bots.filter((b) => c.botIds.includes(b.id));
  const solo = c.kind === "bot" ? members[0] : undefined;
  // A shared workspace's chats have no read mark of the viewer's (readAt is the owner's): none are unread. In the
  // owner's own, a member's message (someone they gave Write) is new to them like a bot's.
  const unread = !!last && (last.role !== "user" || saidBy(last, state) !== "you") && last.at > (c.readAt ?? 0) && !selected && !state.shared;
  const dot = usePop(unread);
  const typing = c.typing.length > 0;
  // A routine's post says which routine, as the chat does above it ("From a routine · …"): an alert on its
  // own ("someone@example.com requests…") read as if it were the bot's own address.
  const routine = last?.routine && (state.routines.find((r) => r.id === last.routine!.id)?.title ?? "Routine");
  const preview = typing
    ? "typing…"
    : last
      ? last.role === "user"
        ? `${saidName(last, state) ?? ownerWho(state.shared)}: ${last.text}`
        : routine
          ? `${undash(routine)}: ${last.text}`
          : c.kind === "group" && last.botId
          ? `${state.bots.find((b) => b.id === last.botId)?.name}: ${last.text}`
          : last.text
      : solo
        ? // A shared workspace's chats aren't the user's to start.
          state.shared
          ? solo.role
          : solo.isMain
            ? "Your chief of staff. Ask for anything."
            : `${solo.role}. Say hi.`
        : `${members.map((m) => m.name).join(", ")}${state.shared ? "" : " and you"}`;

  return (
    <button onClick={onClick} onContextMenu={onMenu} className={`group/chat flex items-center gap-3 rounded-[14px] p-2.5 text-left ${selected ? "bg-[#EEEEEC]" : "hover:bg-black/[0.03]"} ${menuOpen ? "shadow-[inset_0_0_0_1.5px_#0A0A0A]" : ""}`}>
      {solo?.isMain ? (
        <span className="relative shrink-0">
          <ChatAvatar chat={c} bots={state.bots} size={44} />
          <MainStar selected={selected} />
        </span>
      ) : (
        <ChatAvatar chat={c} bots={state.bots} size={44} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold leading-[18px]">{c.title ?? (solo ? solo.name : members.map((m) => m.name).join(", "))}</span>
          {solo && (
            <span className={`shrink-0 rounded-[5px] px-1.5 py-px text-[11px] leading-[14px] text-[#6B6B6B] ${selected ? "bg-white" : "bg-[#EEEEEC]"}`}>
              {solo.role}
            </span>
          )}
          <span className="flex-1" />
          <span className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">{last ? ago(last.at) : ""}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13px] leading-[17px] ${unread ? "font-medium text-ink" : typing ? "text-[#6B6B6B] italic" : "text-[#6B6B6B]"}`}>{preview}</span>
          {unread && <span data-tip="Unread" onAnimationEnd={dot.done} className={`size-[9px] shrink-0 rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A] ${dot.pop ? "motion-dot-in" : ""}`} />}
          {trail}
        </div>
      </div>
    </button>
  );
}

/** The small × that deletes from a row (side-group.tsx), as the CRM's rows import it from here. */
export { DeleteX };

/**
 * The workspace name, in place of a "Messages" title. Click it to switch workspaces, rename this
 * one, or start a new one. Each workspace is its own team: its own main bot, bots, chats and threads.
 */
/** What deleting a workspace takes with it (GET /api/workspaces?preview=), for the confirm. */
type DeletePreview = {
  id: string;
  name: string;
  orgo: boolean;
  memory?: boolean;
  computers: { id: string; name: string }[];
  keys: string[];
  skills: string[];
  apps: string[];
  madeApps?: string[];
  crmFiles?: string[];
  routines?: string[];
  issues?: string[];
};

/** How often a rename made on orgo.ai is looked for while the app is open. */
const NAMES_SYNC_MS = 10 * 60_000;

/**
 * Why Orgo still shows the default workspace as "bops" while it has the user's name here, by the reason
 * it waits (OrgoMigration.defaultRename, lib/server/workspaces.ts HeldReason): an app that's older, that
 * didn't say its version, none on record yet, or an Orgo that can't tell (old_app, silent_app, no_record,
 * no_signal) all wait for every app to be updated; the rest say what they wait for. Bops tries again by
 * itself at each start, sign-in and names sync.
 */
export function heldNameNote(reason: string): string {
  if (reason === "unreachable") return "Orgo keeps the name bops for now: Bops couldn't reach Orgo, and tries again by itself.";
  if (reason === "no_project") return "Orgo gets this name once its Orgo workspace is made, with your first computer.";
  if (reason === "no_free_name") return "Orgo keeps the name bops: your Orgo already has workspaces with this name.";
  return `Orgo keeps the name bops until every Bops app you use is updated to ${WORKSPACE_APPS_SINCE}.`;
}

export function WorkspaceSwitcher({
  state,
  opened = false,
  sharedList,
}: {
  state: AppState;
  /** Tests: open from the start. */
  opened?: boolean;
  /** Tests: the workspaces shared with the user, as if Orgo had listed them. */
  sharedList?: SharedWorkspace[];
}) {
  const [open, setOpen] = useState(opened);
  // Workspaces others shared with the user (lib/shared.ts), read each time the menu opens.
  const [shared, setShared] = useState<SharedWorkspace[]>(sharedList ?? []);
  const [naming, setNaming] = useState<null | { id?: string; name: string }>(null);
  // The workspace whose Delete was pressed: what goes with it once Bops (and Orgo) said, and what went wrong.
  const [deleting, setDeleting] = useState<null | { id: string; preview?: DeletePreview; error?: string; busy?: boolean }>(null);
  // What Orgo said about a name (one the user's Orgo already has), shown over the field until it changes.
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The user's own: a shared one open now is in the state too, under its own id, and listed below instead.
  const workspaces = (state.workspaces ?? []).filter((w) => w.id !== state.shared?.wsId);
  const current = workspaces.find((w) => w.id === currentWorkspace(state));
  const sharedRows = state.shared && !shared.some((x) => x.projectId === state.shared!.projectId) ? [state.shared, ...shared] : shared;

  useEffect(() => {
    if (!open || sharedList) return;
    let gone = false;
    void fetch("/api/workspaces/shared", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { workspaces?: SharedWorkspace[] }) => !gone && setShared(j.workspaces ?? []))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [open, sharedList]);

  // A workspace deleted (here, or on another Mac) takes what this window kept for it in localStorage.
  const listed = useRef<{ user: string; ids: Set<string> } | null>(null);
  const user = state.account?.user.id ?? "";
  const ids = workspaces.map((w) => w.id).join(" ");
  useEffect(() => {
    const now = new Set(ids.split(" ").filter(Boolean));
    const was = listed.current;
    if (was && was.user === user && now.size) for (const id of was.ids) if (!now.has(id)) forgetWorkspaceHere(id);
    listed.current = { user, ids: now };
  }, [user, ids]);

  // A workspace renamed on orgo.ai is renamed here too: now, and every 10 minutes while the app is open.
  useEffect(() => {
    const sync = () => void post("/api/workspaces", { syncNames: true }, "PATCH").catch(() => {});
    sync();
    const t = setInterval(sync, NAMES_SYNC_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        setNaming(null);
      }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    setNaming(null);
    setDeleting(null);
    setProblem(null);
  };
  /**
   * New workspace or Rename: where each workspace is an Orgo workspace of its own, Orgo makes or renames it
   * too, and a name the user's Orgo already has comes back to pick another, with one to start from.
   */
  const save = async () => {
    const name = naming?.name.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = naming?.id ? await post("/api/workspaces", { id: naming.id, name }, "PATCH") : await post("/api/workspaces", { name });
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string; suggestion?: string; waiting?: string };
      if (!res.ok) {
        setProblem(j.error ?? "That didn't work. Try again.");
        if (j.suggestion) setNaming({ id: naming?.id, name: j.suggestion });
        return;
      }
      // The default's name waits for the apps: the menu stays open on why Orgo still shows bops.
      if (j.waiting) {
        setNaming(null);
        setProblem(null);
        return;
      }
      close();
    } catch {
      setProblem("Couldn't reach Bops. Try again.");
    } finally {
      setBusy(false);
    }
  };
  /** Open a workspace shared with the user, read only, in place of the one open now. */
  const openShared = async (projectId: string) => {
    if (busy) return;
    if (state.shared?.projectId === projectId) return close();
    setBusy(true);
    try {
      const res = await post("/api/workspaces/shared", { open: projectId });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setProblem(j.error ?? "Couldn't open it. Try again.");
      close();
    } catch {
      setProblem("Couldn't reach Bops. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const editName = (id?: string) => (name: string) => {
    setNaming({ id, name });
    setProblem(null);
  };
  /** Delete pressed: ask what goes with it first; nothing is deleted until the user confirms the list. */
  const askDelete = async (id: string) => {
    setDeleting({ id, busy: true });
    try {
      const res = await fetch(`/api/workspaces?preview=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as DeletePreview & { error?: string };
      setDeleting((d) => (d?.id === id ? (res.ok ? { id, preview: j } : { id, error: j.error ?? "Couldn't tell what's in it. Try again." }) : d));
    } catch {
      setDeleting((d) => (d?.id === id ? { id, error: "Couldn't reach Bops. Try again." } : d));
    }
  };
  const confirmDelete = async () => {
    if (!deleting?.preview || deleting.busy) return;
    const { id, preview } = deleting;
    setDeleting({ id, preview, busy: true });
    try {
      const res = await post("/api/workspaces", { id }, "DELETE");
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setDeleting(null);
        forgetWorkspaceHere(id);
      }
      else setDeleting({ id, preview, error: j.error ?? "That didn't work, so nothing was deleted. Try again." });
    } catch {
      setDeleting({ id, preview, error: "Couldn't reach Bops. Try again." });
    }
  };
  const renamed = state.orgoMigration?.renamed ?? [];
  // The default's name, held for the apps: said under it, and under its name field while it's renamed.
  const held = state.orgoMigration?.defaultRename;
  const heldNote = (wsId: string) =>
    wsId === MAIN_WORKSPACE && held ? (
      <span data-held-name className="px-2.5 pb-1 text-[12px] leading-4 text-[#6B6B6B]">
        {heldNameNote(held.reason)}
      </span>
    ) : null;
  // A shared workspace open: the window's bots are its, so the user's own are counted from what it says.
  const count = (id: string) => (state.shared ? (state.shared.ownBots?.[id] ?? 0) : state.bots.filter((b) => workspaceOf(b) === id).length);

  return (
    <div ref={box} className="relative min-w-0">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        title="Switch workspace"
        className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-[10px] px-1.5 py-0.5 hover:bg-black/[0.04]"
      >
        <span className="truncate text-[22px] font-semibold leading-7 tracking-[-0.02em]">{state.shared?.name ?? current?.name ?? "Main"}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className={`shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="#6B6B6B" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="motion-menu-in absolute left-0 top-[calc(100%+6px)] z-30 flex w-[248px] origin-top-left flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_rgba(0,0,0,0.12)]">
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-[#9A9A98]">Workspaces</div>
          {workspaces.map((w) =>
            naming?.id === w.id ? (
              <Fragment key={w.id}>
                {problem && <span role="alert" className="px-2.5 pt-1 text-[12px] leading-4 text-[#B42318]">{problem}</span>}
                <NameInput value={naming.name} onChange={editName(w.id)} onSave={save} onCancel={() => setNaming(null)} />
                {heldNote(w.id)}
              </Fragment>
            ) : (
              <Fragment key={w.id}>
                <div className="group/ws flex items-center rounded-[10px] hover:bg-black/[0.04]">
                  <button
                    onClick={() => {
                      if (w.id !== current?.id) void post("/api/workspaces", { current: w.id }, "PATCH");
                      close();
                    }}
                    className="flex h-9 min-w-0 flex-1 items-center gap-2 pl-2.5 text-left"
                  >
                    <span className="flex size-[18px] shrink-0 items-center justify-center">
                      {w.id === current?.id && (
                        <svg width="12" height="12" viewBox="0 0 12 12">
                          <path d="M2.5 6.5l2.3 2.2L9.5 3.5" fill="none" stroke="#0A0A0A" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{w.name}</span>
                    <span className="shrink-0 text-[12px] text-[#9A9A98]">
                      {count(w.id)} bot{count(w.id) === 1 ? "" : "s"}
                    </span>
                  </button>
                  <button
                    onClick={() => setNaming({ id: w.id, name: w.name })}
                    title={`Rename ${w.name}`}
                    aria-label={`Rename ${w.name}`}
                    className="mx-1 flex size-7 shrink-0 items-center justify-center rounded-md text-[#9A9A98] opacity-0 transition-opacity duration-150 ease-out hover:bg-black/[0.06] hover:text-ink focus-visible:opacity-100 group-hover/ws:opacity-100 group-has-[:focus-visible]/ws:opacity-100 motion-reduce:transition-none"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16">
                      <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12 3 13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {workspaces.length > 1 && w.id !== MAIN_WORKSPACE && deleting?.id !== w.id && (
                    <button
                      onClick={() => void askDelete(w.id)}
                      title={`Delete ${w.name}`}
                      aria-label={`Delete ${w.name}`}
                      className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-[#9A9A98] opacity-0 transition-opacity duration-150 ease-out hover:bg-black/[0.06] hover:text-[#B42318] focus-visible:opacity-100 group-hover/ws:opacity-100 group-has-[:focus-visible]/ws:opacity-100 motion-reduce:transition-none"
                    >
                      <svg width="9" height="9" viewBox="0 0 12 12">
                        <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>
                {heldNote(w.id)}
              </Fragment>
            ),
          )}
          {deleting && <DeleteConfirm name={workspaces.find((w) => w.id === deleting.id)?.name ?? "this workspace"} {...deleting} onCancel={() => setDeleting(null)} onDelete={() => void confirmDelete()} />}
          {sharedRows.length > 0 && (
            <>
              <div className="px-2.5 pb-1 pt-2.5 text-[12px] font-medium text-[#9A9A98]">Shared with you</div>
              {sharedRows.map((x) => (
                <button
                  key={x.projectId}
                  data-shared={x.projectId}
                  onClick={() => void openShared(x.projectId)}
                  className="flex min-h-9 items-center gap-2 rounded-[10px] py-1.5 pl-2.5 pr-2 text-left hover:bg-black/[0.04]"
                >
                  <span className="flex size-[18px] shrink-0 items-center justify-center">
                    {x.projectId === state.shared?.projectId && (
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M2.5 6.5l2.3 2.2L9.5 3.5" fill="none" stroke="#0A0A0A" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[14px] font-medium">{x.name}</span>
                    <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{sharedBy(x)}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-[#9A9A98]">{roleLabel(x.role)}</span>
                </button>
              ))}
              {problem && !naming && (
                <span role="alert" className="px-2.5 pb-1 text-[12px] leading-4 text-[#B42318]">
                  {problem}
                </span>
              )}
            </>
          )}
          {/* After each workspace became an Orgo workspace of its own: names Orgo already had (until dismissed). */}
          {renamed.length > 0 && (
            <div className="flex flex-col gap-0.5 px-2.5 pt-1 text-[12px] leading-4 text-[#6B6B6B]">
              {renamed.map((r) => (
                <span key={r.wsId}>
                  {r.from} is {r.to} in Orgo: you already had an Orgo workspace named {r.from}.
                </span>
              ))}
              {renamed.length > 0 && (
                <button onClick={() => void post("/api/workspaces", { noticeSeen: true }, "PATCH").catch(() => {})} className="self-start text-[12px] font-medium text-[#0A0A0A] hover:underline">
                  Dismiss
                </button>
              )}
            </div>
          )}
          <div className="mx-2 my-1 h-px bg-[#ECECEA]" />
          {naming && !naming.id ? (
            <>
              {problem && <span role="alert" className="px-2.5 pb-1 text-[12px] leading-4 text-[#B42318]">{problem}</span>}
              <NameInput value={naming.name} placeholder="Name the workspace" onChange={editName()} onSave={save} onCancel={() => setNaming(null)} />
            </>
          ) : (
            <button onClick={() => setNaming({ name: "" })} className="flex h-9 items-center gap-2 rounded-[10px] pl-2.5 text-left text-[14px] font-medium hover:bg-black/[0.04]">
              <span className="flex size-[18px] items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 16 16">
                  <path d="M8 3v10M3 8h10" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
              New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One line of what goes with a deleted workspace: "Computers (2): Bea's computer, Max's computer". */
function GoesWith({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <li>
      <span className="font-medium text-ink">
        {label} ({items.length}):
      </span>{" "}
      {items.join(", ")}
    </li>
  );
}

/**
 * Delete a workspace, confirmed: what goes with it (its computers, keys, skills and apps, the apps its bots
 * made, its CRM files, routines and Orbit issues, here and in its Orgo workspace, and its memory when its bank
 * goes), then Delete. Orgo saying no keeps the workspace whole, with its words here.
 */
export function DeleteConfirm({ name, preview, error, busy, onCancel, onDelete }: { name: string; preview?: DeletePreview; error?: string; busy?: boolean; onCancel: () => void; onDelete: () => void }) {
  const nothing =
    !!preview &&
    !preview.computers.length &&
    !preview.keys.length &&
    !preview.skills.length &&
    !preview.apps.length &&
    !preview.madeApps?.length &&
    !preview.crmFiles?.length &&
    !preview.routines?.length &&
    !preview.issues?.length;
  const team = preview?.memory ? "Its bots, chats and memory go" : "Its bots and chats go";
  return (
    <div className="mx-1 my-1 flex flex-col gap-1.5 rounded-[10px] bg-[#F7F7F5] p-2.5 text-[12px] leading-4 text-[#6B6B6B]">
      <span className="text-[13px] font-medium text-ink">Delete {name}?</span>
      {!preview && !error && <span>Checking what&apos;s in it&hellip;</span>}
      {preview && (
        <>
          <span>{nothing ? `${team}. Nothing else is in it.` : `${team}, and with them:`}</span>
          {!nothing && (
            <ul className="flex flex-col gap-0.5">
              <GoesWith label="Computers" items={preview.computers.map((c) => c.name)} />
              <GoesWith label="Keys" items={preview.keys} />
              <GoesWith label="Skills" items={preview.skills} />
              <GoesWith label="Apps" items={preview.apps} />
              <GoesWith label="Apps its bots made" items={preview.madeApps ?? []} />
              <GoesWith label="CRM files" items={preview.crmFiles ?? []} />
              <GoesWith label="Routines" items={preview.routines ?? []} />
              <GoesWith label="Issues" items={preview.issues ?? []} />
            </ul>
          )}
          {preview.orgo && <span>Its Orgo workspace is deleted too.</span>}
        </>
      )}
      {error && (
        <span role="alert" className="text-[#B42318]">
          {error}
        </span>
      )}
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button onClick={onCancel} className="h-7 rounded-md px-2 text-[12px] font-medium text-ink hover:bg-black/[0.06]">
          Cancel
        </button>
        {preview && (
          <button onClick={onDelete} disabled={busy} className="h-7 rounded-md bg-[#B42318] px-2 text-[12px] font-medium text-white disabled:opacity-50">
            {busy ? "Deleting" : "Delete"}
          </button>
        )}
      </div>
    </div>
  );
}

/** A name typed in place (a workspace, a CRM file): Enter saves, Esc cancels. With a placeholder, it makes a new one. */
export function NameInput({ value, placeholder, onChange, onSave, onCancel }: { value: string; placeholder?: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      className="flex items-center gap-1.5 p-1"
    >
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
        className="h-8 min-w-0 flex-1 rounded-[8px] bg-[#F4F4F2] px-2.5 text-[14px] outline-none placeholder:text-[#9A9A98] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
      />
      <button type="submit" disabled={!value.trim()} className="h-8 shrink-0 rounded-[8px] bg-ink px-3 text-[13px] font-medium text-white disabled:opacity-30">
        {placeholder ? "Create" : "Save"}
      </button>
    </form>
  );
}
