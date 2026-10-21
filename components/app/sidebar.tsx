"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { live, MAIN_WORKSPACE, workspaceOf, type AppState, type Chat, type Session, type Watch } from "@/lib/types";
import { initialsOf, signOutOfOrgo } from "./account";
import { AutopilotButton, AutopilotSections, type AutopilotOpen } from "./autopilot";
import { categoriesOpen } from "@/lib/memory-categories";
import { KeyIcon } from "./screen-cards";
import { MembersButton } from "./members";
import { FooterButton, footerPillOf, useFooterHover, type FooterKey, type FooterPage } from "./sidebar-footer";
import { Mascot } from "./mascot";
import { AppsIcon } from "./made-apps";
import { KnowledgeIcon, useKnowledgeNews, type MemoryOpen } from "./memory-categories";
import { AppLogo } from "./apps";
import { BotMenu, type BotMenuActions } from "./bot-menu";
import { RestartConfirm, RestartIcon, useCanRestart } from "./restart";
import { useSetupNeedsYou } from "./setup";
import { arrived, DeleteX, forgetShown, rememberShown, usePop, useRise } from "./side-group";
import { UpdateNotice } from "./update-notice";
import { forgetWorkspaceHere } from "@/lib/workspace-local";
import { ago, ChatAvatar, chatInWorkspace, chatName, currentWorkspace, needsYou, NeedsYouDot, post, quietNothing, RoundButton, SideToggleIcon, StatusIcon, teamOf, useNow } from "./ui";

/**
 * The sidebar for one workspace (switch at the top). The list: one row per conversation (Sam pinned, then by latest activity), each with its
 * last message and a dot when there's something you haven't read, like iMessage. Work lives in one
 * place: the Threads list below (and each thread's chip in its chat) shows what's running and what
 * needs you, so the chat rows don't repeat it.
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
  menuActions,
  onCollapse,
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
  /** Hide the sidebar (bops-app.tsx brings it back from the title bar). */
  onCollapse?: () => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const q = query?.trim().toLowerCase();
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
  useEffect(() => {
    rememberShown(state.sessions.map((s) => s.id));
    rememberShown((state.watches ?? []).map((w) => w.id));
    rememberShown(state.routines.map((r) => r.id));
  }, [state.sessions, state.watches, state.routines]);
  // Gone with the sidebar (signing out), so the next sign-in's first paint has nothing new in it either.
  useEffect(() => forgetShown, []);

  const lastMessage = (c: Chat) => [...state.messages].reverse().find((m) => m.chatId === c.id);
  const activity = (c: Chat) => lastMessage(c)?.at ?? c.createdAt;
  const ws = currentWorkspace(state);
  const team = teamOf(state);
  const chats = [...state.chats]
    .filter((c) => chatInWorkspace(state, c))
    .filter((c) => !q || chatName(c, state.bots).toLowerCase().includes(q) || state.messages.some((m) => m.chatId === c.id && m.text.toLowerCase().includes(q)))
    .sort((a, b) => {
      const pin = (c: Chat) => (c.kind === "bot" && state.bots.find((x) => x.id === c.botIds[0])?.isMain ? 1 : 0);
      return pin(b) - pin(a) || activity(b) - activity(a);
    });

  const mainBot = team.find((b) => b.isMain);
  const mainChat = mainBot ? state.chats.find((c) => c.kind === "bot" && c.botIds[0] === mainBot.id) : undefined;

  // A quiet routine's run that found nothing for the user posted nothing, so it isn't listed either.
  const threads = [...state.sessions]
    .filter((s) => workspaceOf(state.bots.find((b) => b.id === s.botId)) === ws && state.bots.some((b) => b.id === s.botId) && !s.replacedBy && !quietNothing(s))
    .filter((s) => !q || s.title.toLowerCase().includes(q))
    .sort((a, b) => Number(live(b) || needsYou(b)) - Number(live(a) || needsYou(a)) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
    .slice(0, 6);

  return (
    <aside className="flex min-h-0 flex-col border-r border-[#ECECEA] bg-[#F9F9F8] px-2.5 pb-3 pt-3.5">
      <div className="flex items-center justify-between pb-3 pl-2.5 pr-2">
        {query === null ? (
          <WorkspaceSwitcher state={state} />
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
              title="Hide the sidebar (⌘\)"
              aria-label="Hide the sidebar"
              className="flex size-[34px] shrink-0 items-center justify-center rounded-full hover:bg-black/[0.05]"
            >
              <SideToggleIcon side="left" open />
            </button>
          )}
          <RoundButton label="Search" active={query !== null} onClick={() => setQuery(query === null ? "" : null)}>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="#0A0A0A" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" fill="none" stroke="#0A0A0A" strokeWidth="1.5" strokeLinecap="round" />
          </RoundButton>
          <RoundButton label="New chat or bot" onClick={onCompose}>
            <path d="M8 3v10M3 8h10" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
          </RoundButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* The main bot runs the team, so it sits above it (once you type a search, everything lists together). */}
        {!q && mainChat && <MainBot chat={mainChat} state={state} selected={mainChat.id === chatId} onClick={() => onOpenChat(mainChat.id)} onMenu={openMenu(mainChat)} last={lastMessage(mainChat)} />}
        <div className="flex flex-col gap-0.5">
          {chats
            .filter((c) => !!q || c !== mainChat)
            .map((c) => (
              <ChatRow key={c.id} chat={c} state={state} selected={c.id === chatId} onClick={() => onOpenChat(c.id)} onMenu={openMenu(c)} menuOpen={!!menu && c.kind === "bot" && c.botIds[0] === menu.botId} last={lastMessage(c)} />
            ))}
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

        {threads.length > 0 && (
          <div className="flex flex-col pt-4">
            <div className="px-2.5 pb-1.5 text-[13px] font-medium leading-4 text-[#9A9A98]">Threads</div>
            {threads.map((s) => (
              <ThreadRow key={s.id} session={s} onClick={() => onOpenThread(s)} />
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
        you={(expanded) => <YouMenu state={state} expanded={expanded} onAccount={onAccount} onSettings={onSettings} onSetup={onSetup} />}
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
  you,
  onMembers,
  onVault,
  onOpenAutopilot,
  onOpenMemory,
  onApps,
}: {
  state: AppState;
  open?: FooterPage;
  hover?: FooterKey;
  news?: boolean;
  you: (expanded: boolean) => ReactNode;
  onMembers: () => void;
  onVault: () => void;
  onOpenAutopilot: (open: AutopilotOpen) => void;
  onOpenMemory: (open: MemoryOpen) => void;
  /** The Apps home: the apps the bots made (made-apps.tsx). */
  onApps: () => void;
}) {
  const knowledge = categoriesOpen(state);
  const page = open === "knowledge" && !knowledge ? "vault" : open;
  const { hover, row } = useFooterHover(initialHover);
  const pill = footerPillOf({ rest: page, hover: hover === "knowledge" && !knowledge ? null : hover });
  return (
    <div {...row} data-footer-row className="flex items-center gap-1 pb-1 pt-3">
      {you(pill === "you")}
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
      <FooterButton name="apps" expanded={pill === "apps"} pressed={page === "apps"} label="Apps" tip="Apps your bots made for you" onClick={onApps} icon={<AppsIcon size={16} />} />
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
      tip={news ? "Knowledge: something new your bots learned" : "Knowledge: what your bots know, learned as you chat"}
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
export function YouMenu({
  state,
  expanded = false,
  onAccount,
  onSettings,
  onSetup,
}: {
  state: AppState;
  expanded?: boolean;
  onAccount: () => void;
  onSettings: () => void;
  onSetup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [restart, setRestart] = useState(false);
  const canRestart = useCanRestart();
  const needsYou = useSetupNeedsYou(state);
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
        <div className="motion-menu-in absolute bottom-[calc(100%+8px)] left-0 z-30 flex w-[248px] origin-bottom-left flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_rgba(0,0,0,0.12)]">
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
 * The main bot (Sam) as the head of the team, like Grok's: big, starred, with how the team is doing
 * at a glance. Click it to talk to Sam.
 */
function MainBot({ chat: c, state, selected, onClick, onMenu, last }: { chat: Chat; state: AppState; selected: boolean; onClick: () => void; onMenu?: (e: React.MouseEvent) => void; last?: AppState["messages"][number] }) {
  const b = state.bots.find((x) => x.id === c.botIds[0])!;
  const unread = !!last && last.role !== "user" && last.at > (c.readAt ?? 0) && !selected;
  const dot = usePop(unread);
  const mine = new Set(teamOf(state).map((x) => x.id));
  const sessions = state.sessions.filter((s) => mine.has(s.botId));
  const working = new Set(sessions.filter((s) => live(s) && !s.askWhere).map((s) => s.botId)).size;
  const waiting = sessions.filter((s) => needsYou(s)).length + (state.watches?.filter((w) => w.alert && mine.has(w.botId)).length ?? 0);
  // One line: what needs you, else who's working, else just the role.
  const status = c.typing.length ? "typing…" : waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : working ? `${working} working` : "Chief of Staff";
  return (
    <button
      onClick={onClick}
      onContextMenu={onMenu}
      className={`relative mb-2 flex flex-col items-center gap-1.5 rounded-[18px] px-3 pb-3 pt-4 text-center ${selected ? "bg-[#EEEEEC]" : "hover:bg-black/[0.03]"}`}
    >
      <span className="relative">
        <Mascot botId={b.id} color={b.color} size={64} />
        <span className="absolute -bottom-0.5 -right-0.5 flex size-[22px] items-center justify-center rounded-full bg-highlighter shadow-[0_0_0_2.5px_#F9F9F8,0_0_0_3.5px_#0A0A0A]" title="Runs the team">
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M6 1l1.5 3.1 3.4.5-2.5 2.4.6 3.4L6 8.8 2.9 10.4l.6-3.4L1 4.6l3.5-.5z" fill="#0A0A0A" />
          </svg>
        </span>
        {unread && <span data-tip="Unread" onAnimationEnd={dot.done} className={`absolute -left-0.5 top-0.5 size-[11px] rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A,0_0_0_3.5px_#F9F9F8] ${dot.pop ? "motion-dot-in" : ""}`} />}
      </span>
      <span className="flex flex-col items-center gap-0.5">
        <span className="text-[16px] font-semibold leading-5">{b.name}</span>
        <span className={`text-[12.5px] leading-4 ${waiting ? "font-medium text-ink" : "text-[#9A9A98]"}`}>{status}</span>
      </span>
    </button>
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
}: {
  chat: Chat;
  state: AppState;
  selected: boolean;
  onClick: () => void;
  onMenu?: (e: React.MouseEvent) => void;
  /** Its bot's right-click menu is open: the row is outlined. */
  menuOpen?: boolean;
  last?: AppState["messages"][number];
}) {
  const members = state.bots.filter((b) => c.botIds.includes(b.id));
  const solo = c.kind === "bot" ? members[0] : undefined;
  const unread = !!last && last.role !== "user" && last.at > (c.readAt ?? 0) && !selected;
  const dot = usePop(unread);
  const typing = c.typing.length > 0;
  const preview = typing
    ? "typing…"
    : last
      ? last.role === "user"
        ? `You: ${last.text}`
        : c.kind === "group" && last.botId
          ? `${state.bots.find((b) => b.id === last.botId)?.name}: ${last.text}`
          : last.text
      : solo
        ? solo.isMain
          ? "Your chief of staff. Ask for anything."
          : `${solo.role}. Say hi.`
        : `${members.map((m) => m.name).join(", ")} and you`;

  return (
    <button onClick={onClick} onContextMenu={onMenu} className={`flex items-center gap-3 rounded-[14px] p-2.5 text-left ${selected ? "bg-[#EEEEEC]" : "hover:bg-black/[0.03]"} ${menuOpen ? "shadow-[inset_0_0_0_1.5px_#0A0A0A]" : ""}`}>
      <ChatAvatar chat={c} bots={state.bots} size={44} />
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
        </div>
      </div>
    </button>
  );
}

/** One of the Threads: in ink with its mark while it's working or needs you; × deletes it once it's stopped. */
function ThreadRow({ session: s, onClick }: { session: Session; onClick: () => void }) {
  // New since the sidebar opened: rises in, once.
  const row = useRise(() => arrived(s.id));
  // Its mark (as StatusIcon draws it) pops when it changes in place, as working turns to needs you.
  const mark = live(s) && !(s.askWhere && needsYou(s)) ? "working" : needsYou(s) ? "you" : s.status;
  const pop = usePop(mark);
  return (
    <button
      onClick={onClick}
      onAnimationEnd={row.done}
      className={`group/thread flex h-[34px] items-center gap-2 rounded-[10px] px-2.5 text-left hover:bg-black/[0.03] ${row.rise ? "motion-rise-in" : ""}`}
    >
      <span className={`min-w-0 flex-1 truncate text-[14px] leading-[18px] ${live(s) || needsYou(s) ? "text-ink" : "text-[#6B6B6B]"}`}>{s.title}</span>
      {(live(s) || needsYou(s)) && (
        <span key={pop.n} onAnimationEnd={pop.done} className={`flex shrink-0 ${pop.pop ? "motion-dot-in" : ""}`}>
          <StatusIcon session={s} />
        </span>
      )}
      {!live(s) && (
        <DeleteX label={`Delete ${s.title}`} onDelete={() => void post(`/api/sessions/${s.id}`, {}, "DELETE")} className="group-hover/thread:opacity-100 group-focus-visible/thread:opacity-100" />
      )}
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

function WorkspaceSwitcher({ state }: { state: AppState }) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<null | { id?: string; name: string }>(null);
  // The workspace whose Delete was pressed: what goes with it once Bops (and Orgo) said, and what went wrong.
  const [deleting, setDeleting] = useState<null | { id: string; preview?: DeletePreview; error?: string; busy?: boolean }>(null);
  // What Orgo said about a name (one the user's Orgo already has), shown over the field until it changes.
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const workspaces = state.workspaces ?? [];
  const current = workspaces.find((w) => w.id === currentWorkspace(state));

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
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string; suggestion?: string };
      if (!res.ok) {
        setProblem(j.error ?? "That didn't work. Try again.");
        if (j.suggestion) setNaming({ id: naming?.id, name: j.suggestion });
        return;
      }
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
  const count = (id: string) => state.bots.filter((b) => workspaceOf(b) === id).length;

  return (
    <div ref={box} className="relative min-w-0">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        title="Switch workspace"
        className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-[10px] px-1.5 py-0.5 hover:bg-black/[0.04]"
      >
        <span className="truncate text-[22px] font-semibold leading-7 tracking-[-0.02em]">{current?.name ?? "Main"}</span>
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
              </Fragment>
            ) : (
              <div key={w.id} className="group/ws flex items-center rounded-[10px] hover:bg-black/[0.04]">
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
            ),
          )}
          {deleting && <DeleteConfirm name={workspaces.find((w) => w.id === deleting.id)?.name ?? "this workspace"} {...deleting} onCancel={() => setDeleting(null)} onDelete={() => void confirmDelete()} />}
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
              <GoesWith label="Orbit issues" items={preview.issues ?? []} />
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
