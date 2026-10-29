"use client";

import { useEffect, useRef, useState } from "react";
import type { AppState, Chat } from "@/lib/types";
import { categoriesOpen } from "@/lib/memory-categories";
import type { AutopilotOpen } from "./autopilot";
import { BotMenu, type BotMenuActions } from "./bot-menu";
import { Spinner } from "./mascot";
import type { MemoryOpen } from "./memory-categories";
import { useIssues } from "./orbit-issues";
import { useSetupWaiting } from "./setup";
import { lastMessageOf, MainStar, sidebarList, SidebarFooter, YouMenuView } from "./sidebar";
import { GROUP_WORDS } from "@/lib/bot-groups";
import type { FooterPage } from "./sidebar-footer";
import { needsByBot, railMark, threadsByBot } from "./sidebar-sections";
import { ChatAvatar, chatName, currentWorkspace, RoundButton, SideToggleIcon } from "./ui";
import { UpdateButton } from "./update-notice";
import { MailAddressRail } from "./mail-address";
import { NoticeRail } from "./notice-popup";

/**
 * The sidebar folded (its toggle, or ⌘\): a narrow rail of icons in its place, so the chat and the panel
 * get the room and the bots stay one click away. On top the toggle that unfolds it, the workspace's initial
 * when there's more than one to be in (unfolds it with the switcher open), Search (unfolds it searching) and
 * New; then one avatar per chat in the sidebar's order (the main bot first, with its star; the bots that work on one
 * computer together on a faint ground, named on hover, never folded here),
 * marked as its row would be: how many things from that bot wait on you (counted as Needs your attention
 * counts them), else a dot while something is unread, else a spinner while one of its threads works. Its
 * name shows on hover, its menu on right-click, and the open one is kept in view.
 * At the bottom a newer Bops (update-notice.tsx), the footer's pages as round buttons, and you. Tooltips here
 * open to the right (tooltip.tsx, data-tip-side).
 */
export function SidebarRail({
  state,
  chatId,
  footer,
  menuActions: actions,
  onExpand,
  onSearch,
  onWorkspaces,
  onCompose,
  onOpenChat,
  onAccount,
  onSettings,
  onSetup,
  onTeam,
  onVault,
  onOpenAutopilot,
  onOpenMemory,
  onApps,
}: {
  state: AppState;
  chatId: string;
  /** Which footer page is open on the right, if one is (sidebar-footer.tsx openFooterPage). */
  footer?: FooterPage | null;
  /** What a bot's right-click menu does (bot-menu.tsx). */
  menuActions?: BotMenuActions;
  /** Unfold the sidebar. */
  onExpand: () => void;
  /** Unfold it with its search open. */
  onSearch: () => void;
  /** Unfold it with the workspace switcher open. */
  onWorkspaces: () => void;
  onCompose: () => void;
  onOpenChat: (chatId: string) => void;
  onAccount: () => void;
  onSettings: () => void;
  onSetup: () => void;
  /** Team, in Settings (from your initials' menu). */
  onTeam: () => void;
  onVault: () => void;
  onOpenAutopilot: (open: AutopilotOpen) => void;
  onOpenMemory: (open: MemoryOpen) => void;
  onApps: () => void;
}) {
  // A workspace shared with the user is read only: no bot menu, and nothing new is made in it.
  const menuActions = state.shared ? undefined : actions;
  const [menu, setMenu] = useState<{ botId: string; x: number; y: number } | null>(null);
  const menuBot = menu ? state.bots.find((b) => b.id === menu.botId) : undefined;
  const openMenu = (c: Chat) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (c.kind === "bot" && menuActions) setMenu({ botId: c.botIds[0], x: e.clientX, y: e.clientY });
  };
  // What waits on the user, by bot, read as the unfolded sidebar reads it (sidebar.tsx).
  const ws = currentWorkspace(state);
  const user = state.account?.user.id ?? "";
  const setup = useSetupWaiting(state);
  const { list: issues } = useIssues(ws, user, categoriesOpen(state) && !state.shared);
  const needs = needsByBot(state, issues?.issues ?? null, state.shared ? [] : setup);
  const byBot = threadsByBot(state);
  // The workspace, when there's another to switch to (the user's own, or one shared with them open now).
  const own = (state.workspaces ?? []).filter((w) => w.id !== state.shared?.wsId);
  const wsName = state.shared?.name ?? own.find((w) => w.id === ws)?.name ?? "Main";
  const switchable = own.length > 1 || !!state.shared;
  // The open chat kept in view (a short window scrolls the avatars).
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [chatId]);

  /** One chat's avatar, marked as its row would be. */
  const avatar = (c: Chat) => {
    const solo = c.kind === "bot" ? state.bots.find((b) => b.id === c.botIds[0]) : undefined;
    const selected = c.id === chatId;
    const last = lastMessageOf(state, c);
    // As the row says it (sidebar.tsx ChatRow): a shared workspace's chats have no read mark of the viewer's.
    const unread = !!last && last.role !== "user" && last.at > (c.readAt ?? 0) && !selected && !state.shared;
    const mark = solo ? railMark(byBot.get(solo.id) ?? [], needs.get(solo.id), !!state.shared) : { waiting: 0, working: false };
    const name = chatName(c, state.bots);
    const says = mark.waiting ? `${mark.waiting} waiting on you` : unread ? "unread" : mark.working ? "working" : "";
    return (
      <button
        key={c.id}
        onClick={() => onOpenChat(c.id)}
        onContextMenu={openMenu(c)}
        aria-label={says ? `${name}, ${says}` : name}
        aria-current={selected ? "page" : undefined}
        data-tip={says ? `${name}: ${says}` : name}
        data-rail-chat={c.id}
        className={`group/chat relative flex size-12 shrink-0 items-center justify-center rounded-[14px] outline-none focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A] ${selected ? "bg-[#EEEEEC]" : "hover:bg-black/[0.03]"} ${menu && solo && menu.botId === solo.id ? "shadow-[inset_0_0_0_1.5px_#0A0A0A]" : ""}`}
      >
        {selected && <span aria-hidden className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-ink" />}
        <span className="relative flex">
          <ChatAvatar chat={c} bots={state.bots} size={36} />
          {solo?.isMain && <MainStar selected={selected} />}
          {mark.waiting > 0 ? (
            <span
              aria-hidden
              data-rail-mark="you"
              className={`absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-highlighter px-1 text-[10px] font-semibold leading-none tabular-nums text-ink ${selected ? "shadow-[inset_0_0_0_1.2px_#0A0A0A,0_0_0_2px_#EEEEEC]" : "shadow-[inset_0_0_0_1.2px_#0A0A0A,0_0_0_2px_#F9F9F8]"}`}
            >
              {mark.waiting > 9 ? "9+" : mark.waiting}
            </span>
          ) : unread ? (
            <span aria-hidden data-rail-mark="unread" className="absolute -right-0.5 -top-0.5 size-[9px] rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A,0_0_0_3px_#F9F9F8]" />
          ) : mark.working ? (
            <span aria-hidden data-rail-mark="working" className={`absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-white ${selected ? "shadow-[0_0_0_1px_#E6E6E3,0_0_0_3px_#EEEEEC]" : "shadow-[0_0_0_1px_#E6E6E3,0_0_0_3px_#F9F9F8]"}`}>
              <Spinner size={10} color="#3A3A38" />
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <aside data-tip-side="right" aria-label="Sidebar, collapsed" className="flex min-h-0 w-[72px] shrink-0 flex-col px-3 pb-3 pt-3.5">
      <div className="flex flex-col items-center gap-2 pb-3">
        <button onClick={onExpand} aria-label="Expand the sidebar" data-tip="Expand the sidebar (⌘\)" className="flex size-[34px] shrink-0 items-center justify-center rounded-full hover:bg-black/[0.05]">
          <SideToggleIcon side="left" open={false} />
        </button>
        {switchable && (
          <button
            onClick={onWorkspaces}
            aria-label={`${wsName}: switch workspaces`}
            className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-white text-[14px] font-semibold text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"
          >
            <span aria-hidden>{[...wsName.trim()][0]?.toUpperCase() ?? "M"}</span>
          </button>
        )}
        <RoundButton label="Search" onClick={onSearch}>
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="#0A0A0A" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" fill="none" stroke="#0A0A0A" strokeWidth="1.5" strokeLinecap="round" />
        </RoundButton>
        {!state.shared && (
          <RoundButton label="New chat or bot" onClick={onCompose}>
            <path d="M8 3v10M3 8h10" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
          </RoundButton>
        )}
      </div>
      <div aria-hidden className="mx-auto mb-2 h-px w-8 shrink-0 bg-[#E6E6E3]" />

      {/* As wide as the rail, so the selected chat's mark at its edge isn't cut off. */}
      <nav ref={list} aria-label="Chats" className="-mx-3 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-3 pt-1 [scrollbar-width:none]">
        {sidebarList(state).map((item) =>
          "chat" in item ? (
            avatar(item.chat)
          ) : (
            <div
              key={`group:${item.group.key}`}
              role="group"
              aria-label={`${item.group.name}, ${GROUP_WORDS.bots(item.group.bots.length)}`}
              data-tip={item.group.name}
              data-rail-group={item.group.key}
              className="flex shrink-0 flex-col items-center gap-1 rounded-[16px] bg-black/[0.03] py-1"
            >
              {item.chats.map(avatar)}
            </div>
          ),
        )}
      </nav>

      <div className="flex shrink-0 flex-col items-center gap-2 pt-2 empty:hidden">
        <UpdateButton onOpen={onExpand} />
        {!state.shared && <MailAddressRail state={state} onOpen={onExpand} />}
        <NoticeRail onOpen={onExpand} />
      </div>
      <SidebarFooter
        vertical
        state={state}
        open={footer}
        you={() => <YouMenuView state={state} needsYou={setup.length > 0} onAccount={onAccount} onSettings={onSettings} onSetup={onSetup} onTeam={onTeam} />}
        onVault={onVault}
        onOpenAutopilot={onOpenAutopilot}
        onOpenMemory={onOpenMemory}
        onApps={onApps}
      />
      {menu && menuBot && menuActions && <BotMenu state={state} bot={menuBot} x={menu.x} y={menu.y} onClose={() => setMenu(null)} actions={menuActions} />}
    </aside>
  );
}
