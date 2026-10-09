"use client";

import { useEffect, useRef, useState } from "react";
import { DISPLAYS, live, workspaceOf, type AppState, type Chat, type Session, type Watch } from "@/lib/types";
import { initialsOf, signOutOfOrgo } from "./account";
import { CrmSection } from "./crm";
import { KeyIcon } from "./screen-cards";
import { Mascot } from "./mascot";
import { RestartConfirm, RestartIcon, useCanRestart } from "./restart";
import { useSetupNeedsYou } from "./setup";
import { UpdateNotice } from "./update-notice";
import { WATCH, WatchEye, watchName } from "./watch-overlay";
import { ago, ChatAvatar, chatInWorkspace, chatName, currentWorkspace, needsYou, post, RoundButton, StatusIcon, teamOf, useNow } from "./ui";

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
  onOpenWatch,
  onOpenCrm,
  activeCrm,
  onCrmChange,
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
  /** Show a watched screen or Mac window. */
  onOpenWatch: (watch: Watch) => void;
  /** Open a CRM file as a tab on the right (crm.tsx). */
  onOpenCrm: (ws: string, file: string) => void;
  /** The CRM file showing on the right, if one is. */
  activeCrm?: { ws: string; file: string };
  /** A CRM file was renamed (`to`) or deleted (null): its tabs follow. */
  onCrmChange: (change: { ws: string; from: string; to: string | null }) => void;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const q = query?.trim().toLowerCase();
  // The "5m" next to each chat stays current.
  useNow(30_000);

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

  const threads = [...state.sessions]
    .filter((s) => workspaceOf(state.bots.find((b) => b.id === s.botId)) === ws && state.bots.some((b) => b.id === s.botId) && !s.replacedBy)
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
            placeholder="Search bots, chats, threads, files"
            className="mr-2 h-[34px] min-w-0 flex-1 rounded-full bg-white px-3.5 text-[13px] shadow-[0_0_0_1px_#E6E6E3] outline-none placeholder:text-[#9A9A98]"
          />
        )}
        <div className="flex gap-2">
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
        {!q && mainChat && <MainBot chat={mainChat} state={state} selected={mainChat.id === chatId} onClick={() => onOpenChat(mainChat.id)} last={lastMessage(mainChat)} />}
        <div className="flex flex-col gap-0.5">
          {chats
            .filter((c) => !!q || c !== mainChat)
            .map((c) => (
              <ChatRow key={c.id} chat={c} state={state} selected={c.id === chatId} onClick={() => onOpenChat(c.id)} last={lastMessage(c)} />
            ))}
        </div>

        {/* The workspace's CRM: its files, each a chart and a table on the right. */}
        <CrmSection state={state} query={q} active={activeCrm} onOpen={onOpenCrm} onChange={onCrmChange} />

        {!q && <Watching state={state} onOpen={onOpenWatch} />}

        {threads.length > 0 && (
          <div className="flex flex-col pt-4">
            <div className="px-2.5 pb-1.5 text-[13px] font-medium leading-4 text-[#9A9A98]">Threads</div>
            {threads.map((s) => (
              <button
                key={s.id}
                onClick={() => onOpenThread(s)}
                className="group/thread flex h-[34px] items-center gap-2 rounded-[10px] px-2.5 text-left hover:bg-black/[0.03]"
              >
                <span className={`min-w-0 flex-1 truncate text-[14px] leading-[18px] ${live(s) || needsYou(s) ? "text-ink" : "text-[#6B6B6B]"}`}>{s.title}</span>
                {(live(s) || needsYou(s)) && <StatusIcon session={s} />}
                {!live(s) && <DeleteX label={`Delete ${s.title}`} onDelete={() => void post(`/api/sessions/${s.id}`, {}, "DELETE")} className="group-hover/thread:opacity-100" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* A newer Bops on bops.bot (the Mac app checks; Bops doesn't update itself). */}
      <UpdateNotice />
      <div className="flex items-center gap-2.5 p-1 pt-3">
        <YouMenu state={state} onAccount={onAccount} onSettings={onSettings} onSetup={onSetup} />
        <button
          onClick={onCompose}
          className="flex h-10 flex-1 items-center justify-center rounded-full bg-white text-[14px] font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"
        >
          + New bot
        </button>
        <button
          onClick={onVault}
          title="Vault: your apps and logins, and which bots can use them"
          aria-label="Vault"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"
        >
          <KeyIcon />
        </button>
      </div>
    </aside>
  );
}

/** Something on this Mac still needs you (setup.tsx): a small amber dot with an exclamation mark. */
function NeedsYouDot({ className = "" }: { className?: string }) {
  return (
    <span className={`flex size-4 shrink-0 items-center justify-center rounded-full bg-[#E59A0B] ${className}`}>
      <svg width="8" height="8" viewBox="0 0 8 8">
        <path d="M4 1.3v3.1" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="4" cy="6.3" r="0.85" fill="#FFFFFF" />
      </svg>
    </span>
  );
}

/**
 * You, at the bottom of the sidebar: your initials, and a menu with your Orgo account (plan and
 * usage), Settings, this Mac's permissions, Restart Bops (in the Mac app; restart.tsx) and signing
 * out. While something on this Mac still needs you (and you haven't skipped it on the setup screen),
 * a badge on your initials opens that screen and the menu item carries the same mark.
 */
function YouMenu({ state, onAccount, onSettings, onSetup }: { state: AppState; onAccount: () => void; onSettings: () => void; onSetup: () => void }) {
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
  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        title={user ? `${user.name ?? user.email ?? "Your account"}: account and settings` : "Account and settings"}
        className={`flex size-10 items-center justify-center rounded-full text-[13px] font-semibold ${open ? "bg-ink text-highlighter" : "bg-[#EEEEEC] text-[#6B6B6B] hover:bg-[#E6E6E3]"}`}
      >
        {initialsOf(state)}
      </button>
      {needsYou && (
        <button
          onClick={() => {
            setOpen(false);
            onSetup();
          }}
          title="Something on this Mac needs you"
          aria-label="Something on this Mac needs you"
          className="absolute -bottom-0.5 -left-0.5 rounded-full shadow-[0_0_0_2px_#F9F9F8]"
        >
          <NeedsYouDot />
        </button>
      )}
      {open && (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 flex w-[248px] flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_rgba(0,0,0,0.12)]">
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
function MainBot({ chat: c, state, selected, onClick, last }: { chat: Chat; state: AppState; selected: boolean; onClick: () => void; last?: AppState["messages"][number] }) {
  const b = state.bots.find((x) => x.id === c.botIds[0])!;
  const unread = !!last && last.role !== "user" && last.at > (c.readAt ?? 0) && !selected;
  const mine = new Set(teamOf(state).map((x) => x.id));
  const sessions = state.sessions.filter((s) => mine.has(s.botId));
  const working = new Set(sessions.filter((s) => live(s) && !s.askWhere).map((s) => s.botId)).size;
  const waiting = sessions.filter((s) => needsYou(s)).length + (state.watches?.filter((w) => w.alert && mine.has(w.botId)).length ?? 0);
  // One line: what needs you, else who's working, else just the role.
  const status = c.typing.length ? "typing…" : waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : working ? `${working} working` : "Chief of Staff";
  return (
    <button
      onClick={onClick}
      className={`relative mb-2 flex flex-col items-center gap-1.5 rounded-[18px] px-3 pb-3 pt-4 text-center ${selected ? "bg-[#EEEEEC]" : "hover:bg-black/[0.03]"}`}
    >
      <span className="relative">
        <Mascot botId={b.id} color={b.color} size={64} />
        <span className="absolute -bottom-0.5 -right-0.5 flex size-[22px] items-center justify-center rounded-full bg-highlighter shadow-[0_0_0_2.5px_#F9F9F8,0_0_0_3.5px_#0A0A0A]" title="Runs the team">
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M6 1l1.5 3.1 3.4.5-2.5 2.4.6 3.4L6 8.8 2.9 10.4l.6-3.4L1 4.6l3.5-.5z" fill="#0A0A0A" />
          </svg>
        </span>
        {unread && <span data-tip="Unread" className="absolute -left-0.5 top-0.5 size-[11px] rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A,0_0_0_3.5px_#F9F9F8]" />}
      </span>
      <span className="flex flex-col items-center gap-0.5">
        <span className="text-[16px] font-semibold leading-5">{b.name}</span>
        <span className={`text-[12.5px] leading-4 ${waiting ? "font-medium text-ink" : "text-[#9A9A98]"}`}>{status}</span>
      </span>
    </button>
  );
}

function ChatRow({ chat: c, state, selected, onClick, last }: { chat: Chat; state: AppState; selected: boolean; onClick: () => void; last?: AppState["messages"][number] }) {
  const members = state.bots.filter((b) => c.botIds.includes(b.id));
  const solo = c.kind === "bot" ? members[0] : undefined;
  const unread = !!last && last.role !== "user" && last.at > (c.readAt ?? 0) && !selected;
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
    <button onClick={onClick} className={`flex items-center gap-3 rounded-[14px] p-2.5 text-left ${selected ? "bg-[#EEEEEC]" : "hover:bg-black/[0.03]"}`}>
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
          {unread && <span data-tip="Unread" className="size-[9px] shrink-0 rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" />}
        </div>
      </div>
    </button>
  );
}

/** A small × that shows on hover and deletes, without opening what it sits on. */
export function DeleteX({ label, onDelete, className = "" }: { label: string; onDelete: () => void; className?: string }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      // It's a button to the keyboard too: Enter or Space.
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onDelete();
      }}
      className={`flex size-5 shrink-0 items-center justify-center rounded-md text-[#9A9A98] opacity-0 hover:bg-black/[0.06] hover:text-[#B42318] ${className}`}
    >
      <svg width="9" height="9" viewBox="0 0 12 12">
        <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * The workspace name, in place of a "Messages" title. Click it to switch workspaces, rename this
 * one, or start a new one. Each workspace is its own team: its own main bot, bots, chats and threads.
 */
function WorkspaceSwitcher({ state }: { state: AppState }) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<null | { id?: string; name: string }>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const workspaces = state.workspaces ?? [];
  const current = workspaces.find((w) => w.id === currentWorkspace(state));

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
  };
  const save = async () => {
    const name = naming?.name.trim();
    if (!name) return;
    if (naming?.id) await post("/api/workspaces", { id: naming.id, name }, "PATCH");
    else await post("/api/workspaces", { name });
    close();
  };
  const count = (id: string) => state.bots.filter((b) => workspaceOf(b) === id).length;

  return (
    <div ref={box} className="relative min-w-0">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        title="Switch workspace"
        className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-[10px] px-1.5 py-0.5 hover:bg-black/[0.04]"
      >
        <span className="truncate text-[22px] font-semibold leading-7 tracking-[-0.02em]">{current?.name ?? "Main"}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="#6B6B6B" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-30 flex w-[248px] flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_rgba(0,0,0,0.12)]">
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-[#9A9A98]">Workspaces</div>
          {workspaces.map((w) =>
            naming?.id === w.id ? (
              <NameInput key={w.id} value={naming.name} onChange={(name) => setNaming({ id: w.id, name })} onSave={save} onCancel={() => setNaming(null)} />
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
                  className="mx-1 flex size-7 shrink-0 items-center justify-center rounded-md text-[#9A9A98] opacity-0 hover:bg-black/[0.06] hover:text-ink group-hover/ws:opacity-100"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16">
                    <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12 3 13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </button>
                {workspaces.length > 1 &&
                  (deleting === w.id ? (
                    <button
                      onClick={() => {
                        void post("/api/workspaces", { id: w.id }, "DELETE");
                        setDeleting(null);
                      }}
                      title={`Delete ${w.name}, its bots and their computers`}
                      className="mr-1 h-7 shrink-0 rounded-md bg-[#B42318] px-2 text-[12px] font-medium text-white"
                    >
                      Delete
                    </button>
                  ) : (
                    <button
                      onClick={() => setDeleting(w.id)}
                      title={`Delete ${w.name}`}
                      aria-label={`Delete ${w.name}`}
                      className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-[#9A9A98] opacity-0 hover:bg-black/[0.06] hover:text-[#B42318] group-hover/ws:opacity-100"
                    >
                      <svg width="9" height="9" viewBox="0 0 12 12">
                        <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  ))}
              </div>
            ),
          )}
          <div className="mx-2 my-1 h-px bg-[#ECECEA]" />
          {naming && !naming.id ? (
            <NameInput value={naming.name} placeholder="Name the workspace" onChange={(name) => setNaming({ name })} onSave={save} onCancel={() => setNaming(null)} />
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

/**
 * Everything the team is watching, in one place: what (a conversation, a mailbox, a site), and
 * whether it's live, paused (not showing right now) or has news. Click to see it; × stops it.
 */
function Watching({ state, onOpen }: { state: AppState; onOpen: (w: Watch) => void }) {
  const team = new Set(teamOf(state).map((b) => b.id));
  const list = (state.watches ?? []).filter((w) => team.has(w.botId)).sort((a, b) => Number(!!b.alert) - Number(!!a.alert) || b.since - a.since);
  if (!list.length) return null;
  return (
    <div className="flex flex-col pt-4">
      <div className="px-2.5 pb-1.5 text-[13px] font-medium leading-4 text-[#9A9A98]">Watching</div>
      {list.map((w) => {
        const where = w.mac ? w.mac.app : `${state.bots.find((b) => b.id === w.botId)?.name ?? "Bot"}'s screen ${DISPLAYS.indexOf(w.display) + 1}`;
        return (
          <button
            key={w.id}
            onClick={() => onOpen(w)}
            title={`${w.lookFor}${w.away ? " · paused: it isn't showing right now" : ""}`}
            className="group/watch flex h-[34px] items-center gap-2 rounded-[10px] px-2.5 text-left hover:bg-black/[0.03]"
          >
            <span className={w.away ? "text-[#C9C9C6]" : ""} style={w.away ? undefined : { color: WATCH }}>
              <WatchEye size={14} blink={!w.away && !w.alert} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px]">
              <span className={w.away ? "text-[#6B6B6B]" : "text-ink"}>{watchName(w)}</span>
              <span className="text-[#9A9A98]"> · {where}</span>
            </span>
            {w.alert ? (
              <span className="shrink-0 rounded-full bg-highlighter px-1.5 py-px text-[11px] font-semibold leading-4 text-ink shadow-[0_0_0_1px_#0000001F]">New</span>
            ) : (
              w.away && <span className="shrink-0 text-[12px] text-[#9A9A98] group-hover/watch:hidden">Paused</span>
            )}
            <DeleteX label={`Stop watching ${watchName(w)}`} onDelete={() => void post(`/api/watches?id=${encodeURIComponent(w.id)}`, {}, "DELETE")} className="group-hover/watch:opacity-100" />
          </button>
        );
      })}
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
