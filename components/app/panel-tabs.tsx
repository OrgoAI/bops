"use client";

import { createContext, createElement, useEffect, useRef, useState } from "react";
import { GROUP_NAME } from "@/lib/memory-categories";
import { live, type AppState } from "@/lib/types";
import { computerOf } from "@/lib/screens";
import { AutopilotIcon, type AutopilotSection } from "./autopilot";
import type { Section } from "./bot-panel";
import { CrmFileIcon } from "./crm";
import { Mascot } from "./mascot";
import { MacIcon } from "./mac-tab";
import { KnowledgeIcon, type OrbitSection } from "./memory-categories";
import { KeyIcon } from "./screen-cards";
import { MonitorIcon, teamOf } from "./ui";

/*
 * The right side is a row of tabs in the title bar, like a browser's. The first tab is always the
 * computer of whoever you're chatting with, and follows the chat; the rest are what you opened:
 * another bot's computer, a bot's profile, a web page (links in the chat open here).
 */

export type PanelTab =
  | { id: string; kind: "computer"; botId: string }
  | { id: string; kind: "bot"; botId: string; section: Section }
  | { id: string; kind: "web"; url: string; title?: string }
  | { id: string; kind: "new" }
  | { id: string; kind: "vault"; keysFor?: string }
  | { id: string; kind: "mac" }
  /** A CRM file (crm.tsx), in the workspace it belongs to. */
  | { id: string; kind: "crm"; ws: string; file: string }
  /**
   * What Bops knows, one section at a time (memory-categories.tsx; Issues, orbit-issues.tsx): one tab per workspace, at the item
   * asked for (`focus`), or with a search filled in (`query`: Show all, from the sidebar's search; it's
   * taken off once the page has filled it in). `focusAt` is when they were asked for, so asking again
   * for the same one shows it again.
   */
  | { id: string; kind: "memory"; ws: string; category: OrbitSection; focus?: string; focusAt?: number; query?: string }
  /**
   * Autopilot (autopilot.tsx): what the workspace's bots do on their own, a section at a time. One tab per
   * workspace, at the row asked for (`focus`) and the bot asked for (`bot`: only its, from its profile);
   * `focusAt` is when they were asked for, so asking again shows them again.
   */
  | { id: string; kind: "autopilot"; ws: string; section: AutopilotSection; focus?: string; focusAt?: number; bot?: string };

/** The tab that follows the chat. */
export const CHAT_TAB = "chat";

/** A tab you're reading (a page, the Vault, a CRM file, Knowledge and Skills in it, a profile, Routines): a new "Needs you" doesn't take the panel from it. */
export const isReading = (t?: PanelTab) =>
  !!t && (t.kind === "web" || t.kind === "vault" || t.kind === "crm" || t.kind === "memory" || t.kind === "bot" || t.kind === "autopilot");

/**
 * The Knowledge tab, opened again for a kind, an item or a search: on the kind asked for, else where it
 * was, except that a search asked for on Issues (whose page doesn't search) goes to All.
 */
export function memoryAgain(t: Extract<PanelTab, { kind: "memory" }>, { category, focus, query }: { category?: OrbitSection; focus?: string; query?: string }, focusAt: number): PanelTab {
  const to = category ?? (query && t.category === "issues" ? "all" : t.category);
  return { ...t, category: to, focus, focusAt, query };
}

/** Open a link as a tab on the right; null outside the app (links then open in the browser). */
export const OpenLink = createContext<((url: string, title?: string) => void) | null>(null);

const electron = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * The tabs the bar has shown, kept while it's away (it's unmounted while the side panel is hidden). A
 * tab that opens later slides in; the ones there when Bops opened, or back as the panel shows again,
 * are simply there.
 */
const shownTabs = new Set<string>();
let barShown = false;

/** A tab closed (not just out of sight): opened again, it slides in again. */
export const forgetTab = (id: string) => void shownTabs.delete(id);

export function TabBar({
  state,
  tabs,
  active,
  chatBotId,
  onPick,
  onClose,
  onNew,
}: {
  state: AppState;
  tabs: PanelTab[];
  active: string;
  chatBotId: string;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  useEffect(() => {
    barShown = true;
  }, []);
  const all: PanelTab[] = [{ id: CHAT_TAB, kind: "computer", botId: chatBotId }, ...tabs];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {all.map((t) => (
        <Tab key={t.id} state={state} tab={t} on={t.id === active} closable={t.id !== CHAT_TAB} onPick={() => onPick(t.id)} onClose={() => onClose(t.id)} />
      ))}
      <button
        onClick={onNew}
        title="New tab"
        aria-label="New tab"
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[#6B6B6B] hover:bg-[#EEEEEC] hover:text-ink [-webkit-app-region:no-drag]"
      >
        <svg width="13" height="13" viewBox="0 0 14 14">
          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function Tab({ state, tab: t, on, closable, onPick, onClose }: { state: AppState; tab: PanelTab; on: boolean; closable: boolean; onPick: () => void; onClose: () => void }) {
  // New since the bar first showed, decided once as it mounts (see shownTabs).
  const [opening] = useState(() => barShown && !shownTabs.has(t.id));
  useEffect(() => {
    shownTabs.add(t.id);
  }, [t.id]);
  const b = "botId" in t ? state.bots.find((x) => x.id === t.botId) : undefined;
  // A computer tab says when its bot is working, or when something there needs you.
  const working =
    (t.kind === "computer" && state.sessions.some((s) => s.botId === t.botId && live(s) && s.runsOn !== "mac")) ||
    (t.kind === "mac" && state.sessions.some((s) => s.runsOn === "mac" && live(s)));
  const needsYou =
    // (A watched web page has no screen there: its news shows on Autopilot instead.)
    t.kind === "computer" && (state.watches?.some((w) => w.botId === t.botId && !w.page && w.alert) || state.sessions.some((s) => s.botId === t.botId && live(s) && s.blocker));
  // The computer it works on: its own, or the main bot's it shares (lib/screens.ts), named for whose it is.
  const host = b ? computerOf(state, b) : undefined;
  const label =
    t.kind === "computer"
      ? host && host.id !== b?.id
        ? `${host.name}'s computer`
        : `${b?.name ?? "Bot"}'s computer`
      : t.kind === "bot"
        ? (b?.name ?? "Bot")
        : t.kind === "web"
          ? t.title || hostOf(t.url)
          : t.kind === "vault"
            ? "Vault"
            : t.kind === "mac"
              ? "Your Mac"
              : t.kind === "crm"
                ? t.file
                : t.kind === "memory"
                  ? GROUP_NAME
                  : t.kind === "autopilot"
                    ? "Routines"
                    : "New tab";
  return (
    <div
      onClick={onPick}
      onAuxClick={(e) => e.button === 1 && closable && onClose()}
      title={t.kind === "web" ? t.url : label}
      // Clipped, so what's in a tab stays inside it while it opens up.
      className={`group/tab flex h-[30px] min-w-0 max-w-[220px] shrink cursor-default items-center gap-1.5 overflow-hidden rounded-[10px] pl-2.5 ${closable ? "pr-1" : "pr-3"} text-[13px] leading-4 transition-[background-color,box-shadow,color] duration-150 ease-out motion-reduce:transition-none [-webkit-app-region:no-drag] ${
        opening ? "motion-tab-in" : ""
      } ${on ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F,0_2px_6px_-3px_#00000026]" : "text-[#6B6B6B] hover:bg-[#EEEEEC]"}`}
    >
      {t.kind === "computer" ? (
        <MonitorIcon size={14} color={on ? "#0A0A0A" : "#6B6B6B"} />
      ) : t.kind === "bot" && b ? (
        <Mascot botId={b.id} color={b.color} size={15} antenna={false} />
      ) : t.kind === "vault" ? (
        <KeyIcon />
      ) : t.kind === "mac" ? (
        <MacIcon />
      ) : t.kind === "crm" ? (
        <CrmFileIcon />
      ) : t.kind === "memory" ? (
        <KnowledgeIcon />
      ) : t.kind === "autopilot" ? (
        <AutopilotIcon />
      ) : (
        <GlobeIcon />
      )}
      <span className={`truncate ${on ? "font-medium" : ""}`}>{label}</span>
      {needsYou ? (
        <span className="size-[7px] shrink-0 rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" title="Needs you" />
      ) : working ? (
        <span className="size-[6px] shrink-0 animate-pulse rounded-full bg-[#2BB673]" title="Working" />
      ) : null}
      {closable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={`Close ${label}`}
          className={`flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.06] ${on ? "" : "opacity-0 group-hover/tab:opacity-100"}`}
        >
          <svg width="9" height="9" viewBox="0 0 12 12">
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.6 3.8 2.6 6.2s-.8 4.5-2.6 6.2M8 1.8C6.2 3.5 5.4 5.6 5.4 8s.8 4.5 2.6 6.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

type WebviewElement = HTMLElement & { goBack: () => void; goForward: () => void; reload: () => void; getURL: () => string; canGoBack: () => boolean; loadURL: (url: string) => Promise<void> };

/** What was typed in an address bar, as a URL: an address as is (https:// added), anything else a Google search. */
export const toAddress = (typed: string) => {
  const a = typed.trim();
  return /^[a-z]+:\/\//i.test(a) ? a : /\s/.test(a) || !a.includes(".") ? `https://www.google.com/search?q=${encodeURIComponent(a)}` : `https://${a}`;
};

/**
 * A web page in a tab. In the Mac app it's a real browser view (its own signed-in session, kept
 * across launches); in a plain browser tab it's a frame, which some sites refuse, hence the
 * "Open in browser" button.
 */
const webPartition = (user?: string) => (user ? `persist:bops-web-${user.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}` : "persist:bops-web");

/**
 * A web page in a tab. In the Mac app its cookies and storage are the signed-in Orgo user's own
 * (`user`: a partition each), so another account signed in on this Mac never sees their sign-ins.
 */
export function WebTab({ url, hidden, user, onPage }: { url: string; hidden: boolean; user?: string; onPage: (url: string, title: string) => void }) {
  // The tab loads its first address once; navigating inside it doesn't reload it from here.
  const [src, setSrc] = useState(url);
  const [at, setAt] = useState(url);
  // What's in the address bar while the user edits it (null: it shows the page's address).
  const [typing, setTyping] = useState<string | null>(null);
  const go = (typed: string) => {
    if (!typed.trim()) return;
    const next = toAddress(typed);
    setTyping(null);
    setAt(next);
    if (native && view) void view.loadURL(next).catch(() => {});
    else setSrc(next);
  };
  const [view, setView] = useState<WebviewElement | null>(null);
  const report = useRef(onPage);
  useEffect(() => {
    report.current = onPage;
  });
  const native = electron();

  useEffect(() => {
    const el = view;
    if (!el || !native) return;
    const page = () => {
      setAt(el.getURL());
      report.current(el.getURL(), (el as unknown as { getTitle: () => string }).getTitle());
    };
    for (const ev of ["did-navigate", "did-navigate-in-page", "page-title-updated"]) el.addEventListener(ev, page);
    return () => {
      for (const ev of ["did-navigate", "did-navigate-in-page", "page-title-updated"]) el.removeEventListener(ev, page);
    };
  }, [view, native]);

  const button = "flex size-7 items-center justify-center rounded-lg text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-30";
  return (
    <div className={`min-h-0 flex-1 flex-col ${hidden ? "hidden" : "flex"}`}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[#F0F0EE] px-2.5">
        {native && (
          <>
            <button className={button} aria-label="Back" onClick={() => view?.goBack()}>
              <svg width="12" height="12" viewBox="0 0 14 14">
                <path d="M9 2.5L4.5 7 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className={button} aria-label="Forward" onClick={() => view?.goForward()}>
              <svg width="12" height="12" viewBox="0 0 14 14">
                <path d="M5 2.5L9.5 7 5 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className={button} aria-label="Reload" onClick={() => view?.reload()}>
              <svg width="12" height="12" viewBox="0 0 14 14">
                <path d="M11.5 7A4.5 4.5 0 1 1 10 3.6M10.5 1.5v2.6H7.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go(typing ?? at);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
          className="mx-1.5 flex min-w-0 flex-1"
        >
          <input
            value={typing ?? at}
            onChange={(e) => setTyping(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setTyping(null)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setTyping(null);
              e.currentTarget.blur();
            }}
            spellCheck={false}
            aria-label="Address"
            className="min-w-0 flex-1 truncate rounded-full bg-[#F2F2F0] px-3 py-1 font-mono text-[11.5px] leading-4 text-[#6B6B6B] outline-none focus:bg-white focus:text-ink focus:shadow-[0_0_0_1.5px_#0A0A0A]"
          />
        </form>
        <button onClick={() => window.open(at, "_blank")} className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-[#3A3A38] hover:bg-[#F2F2F0]">
          Open in browser
        </button>
      </div>
      {native ? (
        createElement("webview", { ref: setView, src, partition: webPartition(user), allowpopups: "true", className: "min-h-0 flex-1" })
      ) : (
        <iframe src={src} className="min-h-0 w-full flex-1 border-0" title={hostOf(src)} />
      )}
    </div>
  );
}

/** A new tab: go to an address, or open one of the bots' computers or profiles. */
export function NewTab({
  state,
  onWeb,
  onComputer,
  onProfile,
  onVault,
  onKnowledge,
  onMac,
}: {
  state: AppState;
  onWeb: (url: string) => void;
  onComputer: (botId: string) => void;
  onProfile: (botId: string) => void;
  onVault: () => void;
  /** Knowledge, what the bots know (memory-categories.tsx); none where it isn't open to this account. */
  onKnowledge?: () => void;
  onMac: () => void;
}) {
  const [address, setAddress] = useState("");
  const go = () => {
    if (address.trim()) onWeb(toAddress(address));
  };
  const typed = address.trim();
  // The site it'll open, when what's typed is an address rather than a search.
  const target = typed ? toAddress(typed) : "";
  const site = target && !target.startsWith("https://www.google.com/search?") ? hostOf(target).replace(/^www\./, "") : null;
  return (
    <div className="motion-fade-in flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-8 pt-[12vh]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
        className="flex w-full max-w-[520px] flex-col gap-1.5"
      >
        <div className="flex items-center gap-2.5 rounded-full bg-white px-4 shadow-[0_0_0_1px_#E2E2DF,0_8px_24px_-14px_#00000040] focus-within:shadow-[0_0_0_1.5px_#0A0A0A,0_8px_24px_-14px_#00000040]">
          {/* A magnifier for a search, a globe once it reads as an address. */}
          <span className="flex size-5 shrink-0 items-center justify-center text-[#9A9A98]">
            {typed && site ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                <circle cx="8" cy="8" r="6" />
                <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <circle cx="7" cy="7" r="4.6" />
                <path d="M10.5 10.5L14 14" />
              </svg>
            )}
          </span>
          <input
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Search Google or type a URL"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-3 text-[15px] leading-5 outline-none placeholder:text-[#9A9A98]"
          />
        </div>
        {/* What Enter will do, before you press it. */}
        {typed && (
          <button type="submit" className="flex items-center gap-2.5 rounded-[14px] px-4 py-2 text-left text-[13.5px] leading-5 hover:bg-[#F7F7F6]">
            <span className="flex size-5 shrink-0 items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- a site's own icon, any domain */}
              <img src={`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(site ?? "google.com")}`} alt="" width={16} height={16} className="rounded-[3px]" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[#6B6B6B]">
              {site ? (
                <>
                  Go to <span className="font-medium text-ink">{site}</span>
                </>
              ) : (
                <>
                  Search Google for <span className="font-medium text-ink">{typed}</span>
                </>
              )}
            </span>
            <kbd className="shrink-0 rounded-[6px] bg-[#F2F2F0] px-1.5 py-0.5 font-sans text-[11.5px] leading-4 text-[#6B6B6B]">↵</kbd>
          </button>
        )}
      </form>
      <div className="flex w-full max-w-[520px] flex-col gap-2">
        <button onClick={onVault} className="mb-2 flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left shadow-[0_0_0_1px_#ECECEA] hover:bg-[#FCFCFB]">
          <span className="flex size-7 items-center justify-center rounded-full bg-ink text-highlighter">
            <KeyIcon />
          </span>
          <span className="flex flex-col">
            <span className="text-[14px] font-medium leading-[18px]">Vault</span>
            <span className="text-[12px] leading-4 text-[#6B6B6B]">
              Your apps and logins, and which bots can use them
            </span>
          </span>
        </button>
        {onKnowledge && (
          <button onClick={onKnowledge} className="mb-2 flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left shadow-[0_0_0_1px_#ECECEA] hover:bg-[#FCFCFB]">
            <span className="flex size-7 items-center justify-center rounded-full bg-ink text-highlighter">
              <KnowledgeIcon size={14} />
            </span>
            <span className="flex flex-col">
              <span className="text-[14px] font-medium leading-[18px]">Knowledge</span>
              <span className="text-[12px] leading-4 text-[#6B6B6B]">What your bots know: people, plans, promises and more</span>
            </span>
          </button>
        )}
        <button onClick={onMac} className="mb-2 flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left shadow-[0_0_0_1px_#ECECEA] hover:bg-[#FCFCFB]">
          <span className="flex size-7 items-center justify-center rounded-full bg-ink text-highlighter">
            <MacIcon />
          </span>
          <span className="flex flex-col">
            <span className="text-[14px] font-medium leading-[18px]">Your Mac</span>
            <span className="text-[12px] leading-4 text-[#6B6B6B]">{state.mac?.ready ? "Where bots work when a task needs your Mac" : (state.mac?.reason ?? "Checking…")}</span>
          </span>
        </button>
        <span className="px-1 text-[12px] font-medium leading-4 text-[#9A9A98]">Your bots</span>
        <div className="grid grid-cols-2 gap-2">
          {teamOf(state).map((b) => (
            <div key={b.id} className="flex items-center gap-2.5 rounded-2xl px-3 py-2.5 shadow-[0_0_0_1px_#ECECEA]">
              <Mascot botId={b.id} color={b.color} size={28} />
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-[18px]">{b.name}</span>
              <button onClick={() => onComputer(b.id)} title={`${b.name}'s computer`} className="flex size-7 items-center justify-center rounded-lg hover:bg-[#F2F2F0]">
                <MonitorIcon size={14} color="#3A3A38" />
              </button>
              <button onClick={() => onProfile(b.id)} className="rounded-full px-2 py-1 text-[12px] font-medium text-[#3A3A38] hover:bg-[#F2F2F0]">
                Profile
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
