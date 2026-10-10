"use client";

import { useEffect, useRef, useState } from "react";
import { botChatId, live, sharesComputer, workBot, type AppState, type Host, type Session, type Watch } from "@/lib/types";
import { Account } from "./account";
import { Members } from "./members";
import { BotPanel, type Section } from "./bot-panel";
import { CallBar } from "./call-bar";
import { ChatView, ThreadSheet, ToPicker } from "./chat-view";
import { ComputerPeek, ComputerView, defaultDisplay } from "./computer";
import { crmOpen } from "@/lib/crm-access";
import { CrmView, OpenCrm } from "./crm";
import { BusyBots, Mascot } from "./mascot";
import { CHAT_TAB, hostOf, NewTab, OpenLink, TabBar, WebTab, type PanelTab } from "./panel-tabs";

/** Your Mac's tab, and the chat's bot's profile (it follows the chat, like the computer tab); both open on demand. */
const MAC_TAB = "tab_mac";
const PROFILE_TAB = "tab_profile";
import { Sidebar } from "./sidebar";
import { CloudUnreachable, SignIn, useAuthStatus } from "./sign-in";
import { Setup, ThisMacSettings } from "./setup";
import { TooltipLayer } from "./tooltip";
import { VaultTab } from "./vault";
import { MacPreviews } from "./mac-tab";
import { OPEN_MAC_KEY } from "./mac-pip";
import { MacComputer } from "./mac-computer";
import { NoticePopup } from "./notice-popup";
import { chatInWorkspace, currentWorkspace, post, teamOf, useAppState, useSelfHosted } from "./ui";
import { UsageData, useAnalytics } from "./usage-data";
import { trackEvent } from "@/lib/analytics";
import { OwnerEmail, useOwnerEmailInfo } from "./owner-email";
import { OwnerPhone, useOwnerPhone, usePhoneInfo, type OwnerNumber, type PendingCode } from "./owner-phone";
import { LineLink } from "./line-link";
import { EmailAddresses, MailAddressStep } from "./mail-address";
import { bannerNumber, ReachBanner } from "./reach-banner";

/*
 * Bops. Layout and values follow the Paper designs: a Messages list, a chat per bot (and group
 * chats) where long tasks are threads, and a right side of tabs in the title bar: the chat's bot's
 * computer first, then whatever you open (another computer, a bot's profile, a web page). The
 * right side collapses, and a computer can be opened full width.
 */

/** The chime for news worth interrupting for: two soft rising notes. */
function chime() {
  const ctx = new AudioContext();
  const out = ctx.createGain();
  out.gain.value = 0.06;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  [
    [740, 0],
    [988, 0.12],
  ].forEach(([f, dt]) => {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0 + dt);
    env.gain.linearRampToValueAtTime(1, t0 + dt + 0.012);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.35);
    env.connect(out);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f;
    osc.connect(env);
    osc.start(t0 + dt);
    osc.stop(t0 + dt + 0.36);
  });
  setTimeout(() => void ctx.close().catch(() => {}), 700);
}

/**
 * Bops asks who you are first: nobody signed in with Orgo means the sign-in screen (sign-in.tsx),
 * unless this is a self-hosted install running on its own Orgo key. Signing out anywhere clears the
 * state's account, which checks again and brings the sign-in screen back. Once signed in it's the app
 * right away: what this Mac still needs (setup.tsx) waits behind a badge on the account menu.
 */
export function BopsApp() {
  const state = useAppState();
  const [auth, recheck, retry] = useAuthStatus(state?.account?.signedInAt);
  useAnalytics(state);
  if (auth?.needsSignIn) return <SignIn onSignedIn={recheck} />;
  // Signed in, but their Bops (it lives in Bops Cloud) couldn't be loaded: nothing to show until it can.
  if (auth?.cloudProblem) return <CloudUnreachable onRetry={retry} />;
  return <Bops state={auth ? state : null} />;
}

function Bops({ state }: { state: AppState | null }) {
  // Empty until a chat is picked: the workspace's main bot's chat shows (see `chat` below).
  const [chatId, setChatId] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [focus, setFocus] = useState(false);
  // Full width shows your Mac instead of a bot's computer.
  const [macFocus, setMacFocus] = useState(false);
  // ...or a CRM file (crm.tsx), from its tab's Full width.
  const [crmFocus, setCrmFocus] = useState<{ ws: string; file: string } | null>(null);
  // The right side's tabs (the chat's own computer is always first; see panel-tabs.tsx).
  // Only the computer is open from the start; the rest open as you need them.
  const [openTabs, setTabs] = useState<PanelTab[]>([]);
  // The work the panel last followed ("thread:where"), so it switches between your Mac and the bot's
  // computer only when that changes, and a tab you picked stays until it does.
  const [followed, setFollowed] = useState("");
  // The popped-out Mac previews ask for the Your Mac tab by bumping a key in local storage.
  const openMacRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === OPEN_MAC_KEY && openMacRef.current();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // A file dropped where nothing takes it (only the chat and the CRM do) is refused: left to the
  // window, it would open the file in place of Bops. Only files: text dragged into a field drops as before.
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const over = (e: DragEvent) => {
      if (e.defaultPrevented || !files(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "none";
    };
    const drop = (e: DragEvent) => files(e) && e.preventDefault();
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const [active, setActive] = useState(CHAT_TAB);
  // Where you were, so leaving a tab goes back there: the tabs you've had open (latest last), and how
  // the side panel was when the tab on it now opened it (hidden, or a computer full width).
  const [recent, setRecent] = useState<string[]>([CHAT_TAB]);
  const [openedFrom, setOpenedFrom] = useState<{ id: string; panelOpen: boolean; focus: boolean } | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [displays, setDisplays] = useState<Record<string, number>>({});
  // The open thread's screen the panel last went to ("thread:display"), so it follows the thread there once.
  const [shownScreen, setShownScreen] = useState("");
  // Screens you picked yourself stay put; otherwise the panel follows the action (see ComputerView).
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState(false);
  const [account, setAccount] = useState(false);
  const [setup, setSetup] = useState(false);
  // The People sheet (members.tsx): who can see the bots' computers.
  const [members, setMembers] = useState(false);
  // Heads-ups already brought forward (null until the first state arrives), and the way back.
  const [cutAlerts, setCutAlerts] = useState<Set<string> | null>(null);
  const [cutBack, setCutBack] = useState<{ name: string; back: string } | null>(null);
  // Your Mac's live view, kept while hidden: macHeldAt is 0 while it's showing, 1 while held, 2 once let go.
  const [macHeldAt, setMacHeldAt] = useState(0);
  const [macWasShown, setMacWasShown] = useState(false);
  useEffect(() => {
    if (macHeldAt !== 1) return;
    const t = setTimeout(() => setMacHeldAt((v) => (v === 1 ? 2 : v)), 120_000);
    return () => clearTimeout(t);
  }, [macHeldAt]);
  // The computer kept connected while hidden (see showingComputer below), until two minutes after it's left.
  const [held, setHeld] = useState<{ botId: string; hidden?: boolean } | null>(null);
  useEffect(() => {
    if (!held?.hidden) return;
    const t = setTimeout(() => setHeld((h) => (h?.hidden ? null : h)), 120_000);
    return () => clearTimeout(t);
  }, [held]);
  const bringForward = useRef<() => void>(() => {});
  // A soft chime (and a notification when Bops is behind) for what's worth interrupting for: news
  // judged "now", and finished tasks the user is waiting on. Not for what was already there when Bops opened.
  const pinged = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!state) return;
    const due = [
      ...(state.watches ?? []).filter((w) => w.alert?.level === "now").map((w) => ({ key: `w:${w.id}:${w.alert!.at}`, title: w.mac?.title ?? w.site, body: w.alert!.text })),
      ...state.messages.filter((m) => m.ping).map((m) => ({ key: `m:${m.id}`, title: state.bots.find((b) => b.id === m.botId)?.name ?? "Bops", body: m.text.replace(/\*\*|\[|\]\([^)]*\)/g, "").slice(0, 140) })),
    ];
    if (!pinged.current) {
      pinged.current = new Set(due.map((d) => d.key));
      return;
    }
    const fresh = due.filter((d) => !pinged.current!.has(d.key));
    if (!fresh.length) return;
    for (const d of fresh) pinged.current.add(d.key);
    chime();
    if (document.hidden && "Notification" in window) {
      const show = () => fresh.forEach((d) => new Notification(d.title, { body: d.body, silent: true }).addEventListener("click", () => window.focus()));
      if (Notification.permission === "granted") show();
      else if (Notification.permission !== "denied") void Notification.requestPermission().then((p) => p === "granted" && show());
    }
  }, [state]);
  useEffect(() => {
    const t = setTimeout(() => bringForward.current(), 0);
    return () => clearTimeout(t);
  });
  // The "New from … · Back" pill goes away on its own.
  useEffect(() => {
    if (!cutBack) return;
    const t = setTimeout(() => setCutBack(null), 12_000);
    return () => clearTimeout(t);
  }, [cutBack]);
  // The call you're on, if any. It lives here, above the chats, so leaving the chat doesn't hang up:
  // only the hang-up button does. In the caller's chat it sits in the header slot; elsewhere it waits
  // small in the sidebar's corner.
  const [call, setCall] = useState<string | null>(null);
  const [callSlot, setCallSlot] = useState<HTMLElement | null>(null);
  const [slotBox, setSlotBox] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!callSlot) return;
    const measure = () => {
      const r = callSlot.getBoundingClientRect();
      setSlotBox({ x: r.left + r.width / 2, y: r.top });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(callSlot);
    if (callSlot.parentElement) ro.observe(callSlot.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [callSlot]);
  // (No app-wide clock: redrawing everything every second cost a full render a second. What shows a
  // running time keeps its own: the open thread, the sidebar's "5m", watch pills, the call timer.)

  // Clicking into a computer takes over its screen; leaving the full view hands it back (a CRM file full width took nothing).
  const wasFocused = useRef(false);
  const computerFocus = focus && !crmFocus;
  useEffect(() => {
    if (wasFocused.current && !computerFocus) void post("/api/takeover", {}, "DELETE");
    wasFocused.current = computerFocus;
  }, [computerFocus]);

  // What Esc does to the tab on the right, set on every render (see escTab.current below).
  const escTab = useRef<(e: KeyboardEvent) => void>(() => {});
  // A sheet open over People (Account from its upgrade, Setup from there), set on every render: Esc
  // closes that alone and goes back to People, as its X does.
  const overPeople = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setComposing(true);
      }
      if (e.key === "Escape" && overPeople.current) {
        setAccount(false);
        setSetup(false);
        return;
      }
      if (e.key === "Escape") {
        setThreadId(null);
        setFocus(false);
        setSettings(false);
        setAccount(false);
        setSetup(false);
        setMembers(false);
        // Last, so going back can bring a full-width computer back.
        escTab.current(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state) return <div className="flex h-screen items-center justify-center text-pencil">Loading Bops…</div>;

  // Stay inside the workspace you're in: a chat from another one falls back to this one's main bot.
  const team = teamOf(state);
  const here = state.chats.filter((c) => chatInWorkspace(state, c));
  const chat = here.find((c) => c.id === chatId) ?? here.find((c) => c.kind === "bot" && team.find((b) => b.id === c.botIds[0])?.isMain) ?? here[0] ?? state.chats[0];
  const thread = threadId ? state.sessions.find((s) => s.id === threadId) : undefined;
  // The first tab shows the computer of the bot you're talking to (or whose thread is open).
  const chatBotId = thread?.botId ?? chat.botIds[0];
  // A deleted bot's tabs go with it; the profile tab is always the chat's bot. A CRM file shows in its own workspace only,
  // and only to an account the CRM is open to (lib/crm-access.ts).
  const crm = crmOpen(state);
  const tabs = openTabs
    .map((t) => (t.id === PROFILE_TAB && t.kind === "bot" ? { ...t, botId: chatBotId } : t))
    .filter((t) => !("botId" in t) || state.bots.some((b) => b.id === t.botId))
    .filter((t) => t.kind !== "crm" || (crm && t.ws === currentWorkspace(state)));
  const tab = active === CHAT_TAB ? undefined : tabs.find((t) => t.id === active);
  if (recent.at(-1) !== active) {
    setRecent([...recent.filter((id) => id !== active), active].slice(-20));
    // Gone on to another tab: leaving that one later shouldn't hide the panel this one opened.
    if (openedFrom && openedFrom.id !== active) setOpenedFrom(null);
  }

  // Where the chat's bot is working now: on your Mac or on its own computer. When that changes (a
  // task starts, or moves), the panel shows it, unless you're reading something (a page, the Vault).
  const lead = state.sessions.filter((s) => s.botId === chatBotId && live(s) && s.runsOn && !s.askWhere).at(-1);
  const leadKey = lead ? `${lead.id}:${lead.runsOn}` : "";
  if (leadKey !== followed) {
    setFollowed(leadKey);
    const browsing = tab && (tab.kind === "web" || tab.kind === "vault" || tab.kind === "crm" || (tab.kind === "computer" && tab.botId !== chatBotId) || (tab.kind === "bot" && tab.id !== PROFILE_TAB));
    if (lead && !browsing && !focus) {
      if (lead.runsOn === "mac") {
        // Your Mac's tab, however it was opened (from a new tab it keeps that tab's id): never a second one.
        const mac = openTabs.find((t) => t.kind === "mac");
        if (!mac) setTabs([...openTabs, { id: MAC_TAB, kind: "mac" }]);
        setActive(mac?.id ?? MAC_TAB);
      } else setActive(CHAT_TAB);
    }
  }
  const botId = tab && "botId" in tab ? tab.botId : chatBotId;
  const bot = state.bots.find((b) => b.id === botId) ?? team[0] ?? state.bots[0];
  const display = defaultDisplay(state, bot.id, displays[bot.id]);
  const setDisplay = (d: number) => {
    setDisplays({ ...displays, [bot.id]: d });
    setPinned((p) => ({ ...p, [bot.id]: true }));
  };
  const follow = {
    on: !pinned[bot.id],
    auto: (d: number) => setDisplays((x) => ({ ...x, [bot.id]: d })),
    resume: () => setPinned((p) => ({ ...p, [bot.id]: false })),
  };
  // The computer last on screen stays connected, hidden, for two minutes after you switch tabs, so
  // coming back shows its live screen at once (reconnecting took about 1.5 s).
  const showingComputer = !tab || tab.kind === "computer";
  if (showingComputer && (held?.botId !== bot.id || held.hidden)) setHeld({ botId: bot.id });
  else if (!showingComputer && held && !held.hidden) setHeld({ ...held, hidden: true });
  const showingMac = tab?.kind === "mac";
  if (showingMac && macHeldAt !== 0) setMacHeldAt(0);
  else if (!showingMac && macHeldAt === 0 && macWasShown) setMacHeldAt(1);
  if (showingMac && !macWasShown) setMacWasShown(true);
  const macHeld = macWasShown && !showingMac && macHeldAt === 1;
  const heldBot = showingComputer ? bot : held ? state.bots.find((b) => b.id === held.botId) : undefined;
  const takeOver = (d: number) => void post("/api/takeover", { botId: bot.id, display: d });
  // Full screen, when asked for explicitly (taking control happens in place, in the panel).
  const clickIn = () => {
    setMacFocus(false);
    setCrmFocus(null);
    setFocus(true);
  };

  /** Show a tab, opening it first if it isn't open yet. */
  const openTab = (match: (t: PanelTab) => boolean, make: () => PanelTab, update?: (t: PanelTab) => PanelTab) => {
    const open = tabs.find(match);
    const t = open ?? make();
    if (!open) setTabs([...tabs, t]);
    else if (update) setTabs(tabs.map((x) => (x === open ? update(x) : x)));
    setActive(t.id);
    // Opened over a hidden side panel, or a computer full width: leaving it puts that back.
    if (!panelOpen || focus) setOpenedFrom({ id: t.id, panelOpen, focus });
    setPanelOpen(true);
    setFocus(false);
  };
  const tabId = () => `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const openComputer = (id: string) => {
    if (id === chatBotId) {
      setActive(CHAT_TAB);
      setPanelOpen(true);
      setFocus(false);
    } else openTab((t) => t.kind === "computer" && t.botId === id, () => ({ id: tabId(), kind: "computer", botId: id }));
  };
  const openProfile = (id: string, section: Section = "details") =>
    openTab(
      (t) => t.kind === "bot" && t.botId === id && (t.id === PROFILE_TAB) === (id === chatBotId),
      () => ({ id: id === chatBotId ? PROFILE_TAB : tabId(), kind: "bot", botId: id, section }),
      (t) => ({ ...t, section }) as PanelTab,
    );
  const openVault = () => openTab((t) => t.kind === "vault", () => ({ id: tabId(), kind: "vault" }));
  /** A CRM file, as a tab (one per file). */
  const openCrm = (ws: string, file: string) =>
    openTab(
      (t) => t.kind === "crm" && t.ws === ws && t.file.toLowerCase() === file.toLowerCase(),
      () => ({ id: tabId(), kind: "crm", ws, file }),
      (t) => ({ ...t, file }) as PanelTab,
    );
  /** A CRM file was renamed or deleted in the sidebar: its tab (and the full view of it) follows, or closes. */
  const crmChanged = ({ ws, from, to }: { ws: string; from: string; to: string | null }) => {
    const same = (x: { ws: string; file: string }) => x.ws === ws && x.file.toLowerCase() === from.toLowerCase();
    if (to) setTabs(openTabs.map((t) => (t.kind === "crm" && same(t) ? { ...t, file: to } : t)));
    else for (const t of tabs) if (t.kind === "crm" && same(t)) closeTab(t.id);
    if (crmFocus && same(crmFocus)) {
      if (to) setCrmFocus({ ws, file: to });
      else {
        setCrmFocus(null);
        setFocus(false);
      }
    }
  };
  const openMac = () => openTab((t) => t.kind === "mac", () => ({ id: MAC_TAB, kind: "mac" }));
  // eslint-disable-next-line react-hooks/refs -- kept current for the storage listener above
  openMacRef.current = openMac;
  const openWeb = (url: string, title?: string) => openTab((t) => t.kind === "web" && t.url === url, () => ({ id: tabId(), kind: "web", url, title }));
  /**
   * Leave the tab you're on for where you were: the tab you had open before it (else `fallback`), and the
   * side panel the way it was if this tab opened it.
   */
  const leave = (id: string, open: PanelTab[], fallback = CHAT_TAB) => {
    const before = [...recent].reverse().find((r) => r !== id && (r === CHAT_TAB || open.some((t) => t.id === r)));
    setActive(before ?? fallback);
    if (openedFrom?.id === id) {
      setPanelOpen(openedFrom.panelOpen);
      setFocus(openedFrom.focus);
    }
  };
  const closeTab = (id: string) => {
    const i = tabs.findIndex((t) => t.id === id);
    const gone = tabs[i];
    // A CRM file shown full width goes with its tab (back to where you were, not to a computer).
    if (gone?.kind === "crm" && crmFocus && gone.ws === crmFocus.ws && gone.file.toLowerCase() === crmFocus.file.toLowerCase()) {
      setCrmFocus(null);
      setFocus(false);
    }
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    setRecent(recent.filter((r) => r !== id));
    if (active === id) leave(id, rest, rest[i - 1]?.id ?? rest[i]?.id ?? CHAT_TAB);
  };
  /** A page-like tab's own X (and Esc) closes it. */
  const leaveTab = closeTab;
  // eslint-disable-next-line react-hooks/refs -- kept current for the key listener above
  overPeople.current = members && (account || setup);
  // Esc leaves a tab that reads as a page (the Vault, a bot's profile) for where you were, once nothing
  // nearer wants it: a sheet, a thread or a dialog (the app picker, an image) closes first, something
  // inside that used it (a form) says so with preventDefault, and Esc while typing elsewhere (the chat,
  // a search) stays there.
  // eslint-disable-next-line react-hooks/refs -- kept current for the key listener above
  escTab.current = (e) => {
    const page = panelOpen && !focus && (tab?.kind === "vault" || tab?.kind === "bot" || tab?.kind === "crm") ? tab : undefined;
    if (!page || e.defaultPrevented || thread || composing || settings || account || setup || members || document.querySelector('[role="dialog"]')) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && !panelRef.current?.contains(el)) return;
    leaveTab(page.id);
  };
  const pickTab = (id: string) => {
    setActive(id);
    setFocus(false);
    setPanelOpen(true);
  };

  /** Show a watched thing: its Mac window in Your Mac, or the bot's screen it's on. Seeing it clears its news. */
  const showWatch = (w: Watch) => {
    if (w.mac) openMac();
    else {
      setDisplays((x) => ({ ...x, [w.botId]: w.display }));
      setPinned((p) => ({ ...p, [w.botId]: true }));
      openComputer(w.botId);
    }
    if (w.alert) void post("/api/watches", { id: w.id, action: "seen" }, "PATCH");
  };
  // News on a watched screen brings it forward (once per heads-up), unless you're reading a page or
  // the Vault, typing, or Bops isn't in front: then it waits (checked again on every update) until
  // you're free. Alerts already there when Bops opens stay in the sidebar instead.
  // eslint-disable-next-line react-hooks/refs -- kept current for the effect that runs it
  bringForward.current = () => {
    const key = (w: Watch) => `${w.id}:${w.alert?.at}`;
    // Only news Jev judged worth interrupting for (older alerts have no level: they interrupt too).
    const alerting = (state.watches ?? []).filter((w) => w.alert && (w.alert.level ?? "now") === "now" && team.some((b) => b.id === w.botId));
    if (cutAlerts === null) return setCutAlerts(new Set(alerting.map(key)));
    const fresh = alerting.find((w) => !cutAlerts.has(key(w)));
    if (!fresh || document.hidden || focus || tab?.kind === "web" || tab?.kind === "vault" || tab?.kind === "crm") return;
    const el = document.activeElement as HTMLInputElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && (el.value ?? el.textContent ?? "").trim()) return;
    setCutAlerts(new Set([...cutAlerts, key(fresh)]));
    setCutBack({ name: fresh.mac?.title ?? fresh.site, back: active });
    if (fresh.mac) openMac();
    else {
      setDisplays((x) => ({ ...x, [fresh.botId]: fresh.display }));
      setPinned((p) => ({ ...p, [fresh.botId]: true }));
      openComputer(fresh.botId);
    }
  };
  const openChat = (id: string) => {
    setChatId(id);
    setThreadId(null);
    setComposing(false);
    setFocus(false);
    setActive(CHAT_TAB);
  };
  const openThread = (s: Session) => {
    const inView = s.chatId === chat.id || chat.botIds.includes(s.botId);
    if (!inView) setChatId(state.chats.some((c) => c.id === s.chatId) ? s.chatId : botChatId(s.botId));
    setComposing(false);
    setFocus(false);
    setThreadId(s.id);
    // A thread on your Mac shows your Mac; one in the cloud, the bot's computer, on its screen.
    if (s.runsOn === "mac") {
      const mac = openTabs.find((t) => t.kind === "mac");
      if (!mac) setTabs([...openTabs, { id: MAC_TAB, kind: "mac" }]);
      setActive(mac?.id ?? MAC_TAB);
    } else setActive(CHAT_TAB);
    const screen = s.display ?? s.lastDisplay;
    if (screen !== undefined) {
      setDisplays({ ...displays, [s.botId]: screen });
      setPinned((p) => ({ ...p, [s.botId]: true }));
    }
    setShownScreen(`${s.id}:${screen}`);
    // Its screen comes up with it, even with the side panel hidden.
    if (screen !== undefined || s.macScreen !== undefined) setPanelOpen(true);
  };
  // The open thread gets a screen (it was waiting for one) or moves to another: the panel goes there.
  const threadScreen = thread && thread.runsOn !== "mac" ? thread.display : undefined;
  if (thread && threadScreen !== undefined && shownScreen !== `${thread.id}:${threadScreen}`) {
    setShownScreen(`${thread.id}:${threadScreen}`);
    setDisplays({ ...displays, [thread.botId]: threadScreen });
    setPinned((p) => ({ ...p, [thread.botId]: true }));
  }

  const chatColumn = composing ? (
    <ToPicker state={state} onOpenChat={openChat} onCancel={() => setComposing(false)} />
  ) : (
    <div className="relative flex min-h-0 min-w-0 flex-col">
      <ChatView
        state={state}
        chat={chat}
        wide={!panelOpen}
        onOpenThread={openThread}
        onShowBot={(id) => openProfile(id)}
        onShowMac={openMac}
        onShowScreen={(id, d) => {
          setDisplays((x) => ({ ...x, [id]: d }));
          setPinned((p) => ({ ...p, [id]: true }));
          openComputer(id);
        }}
        onUpgrade={() => {
          trackEvent("bops_upgrade_clicked", { surface: "chat" });
          setAccount(true);
        }}
        peek={!panelOpen && <ComputerPeek state={state} bot={bot} onOpen={() => setPanelOpen(true)} />}
        call={call}
        onCall={setCall}
        callSlot={setCallSlot}
      />
      {thread && (
        <ThreadSheet
          state={state}
          session={thread}
          onClose={() => setThreadId(null)}
          onShowComputer={() => {
            setPanelOpen(true);
            setActive(CHAT_TAB);
          }}
        />
      )}
    </div>
  );

  const callBot = call ? state.bots.find((b) => b.id === call) : undefined;
  const callHere = !!callBot && !composing && !focus && !!callSlot && chat.kind === "bot" && chat.botIds[0] === callBot.id;
  const columns = focus || !panelOpen ? "grid-cols-[340px_minmax(0,1fr)]" : "grid-cols-[340px_440px_minmax(0,1fr)]";
  const tabBar = (panelOpen || focus) && (
    <TabBar
      state={state}
      tabs={tabs}
      active={focus ? (crmFocus ? (tabs.find((t) => t.kind === "crm" && t.ws === crmFocus.ws && t.file.toLowerCase() === crmFocus.file.toLowerCase())?.id ?? CHAT_TAB) : CHAT_TAB) : active}
      chatBotId={chatBotId}
      onPick={pickTab}
      onClose={closeTab}
      onNew={() => openTab(() => false, () => ({ id: tabId(), kind: "new" }))}
    />
  );

  // Bots at work open their eyes (every mascot reads this): a running thread, typing, or on a call.
  const busy = new Set([...state.sessions.filter((s) => live(s) && !s.askWhere).map((s) => s.botId), ...state.chats.flatMap((c) => c.typing), ...(call ? [call] : [])]);

  return (
    <BusyBots.Provider value={busy}>
    <OpenLink.Provider value={openWeb}>
    <OpenCrm.Provider value={openCrm}>
      <TooltipLayer />
      <NoticePopup />
      <div className="flex h-screen flex-col bg-white font-sans text-ink antialiased">
        <TitleBar
          columns={columns}
          wide={focus || !panelOpen}
          tabs={tabBar}
          panelOpen={panelOpen && !focus}
          onTogglePanel={() => {
            // You set the panel yourself: leaving the tab on it keeps it as it is.
            setOpenedFrom(null);
            if (focus) setFocus(false);
            else setPanelOpen(!panelOpen);
          }}
        />
        <div className={`grid min-h-0 flex-1 ${columns}`}>
          <Sidebar
            state={state}
            chatId={chat.id}
            onOpenChat={openChat}
            onOpenThread={openThread}
            onCompose={() => setComposing(true)}
            onSettings={() => setSettings(true)}
            onAccount={() => setAccount(true)}
            onSetup={() => setSetup(true)}
            onVault={openVault}
            onMembers={() => setMembers(true)}
            onOpenWatch={showWatch}
            onOpenCrm={openCrm}
            activeCrm={focus ? (crmFocus ?? undefined) : panelOpen && tab?.kind === "crm" ? { ws: tab.ws, file: tab.file } : undefined}
            onCrmChange={crmChanged}
          />
          {focus && crmFocus && crm ? (
            <div className="flex min-h-0 min-w-0 flex-col bg-white">
              <CrmView
                key={`${crmFocus.ws}:${crmFocus.file}`}
                state={state}
                ws={crmFocus.ws}
                file={crmFocus.file}
                mode="focus"
                onBack={() => setFocus(false)}
                onClose={() => {
                  const t = tabs.find((x) => x.kind === "crm" && x.ws === crmFocus.ws && x.file.toLowerCase() === crmFocus.file.toLowerCase());
                  if (t) closeTab(t.id);
                  else {
                    setCrmFocus(null);
                    setFocus(false);
                  }
                }}
              />
            </div>
          ) : focus && macFocus ? (
            <div className="flex min-h-0 min-w-0 flex-col bg-white">
              <MacComputer state={state} mode="focus" showThread={thread?.runsOn === "mac" ? thread.id : undefined} onBack={() => setFocus(false)} onOpenThread={openThread} />
            </div>
          ) : focus ? (
            <div className="flex min-h-0 min-w-0 flex-col bg-white">
              <ComputerView
                state={state}
                bot={bot}
                display={display}
                onDisplay={(d) => {
                  setDisplay(d);
                  takeOver(d);
                }}
                mode="focus"
                onBack={() => setFocus(false)}
              />
            </div>
          ) : (
            <>
              {chatColumn}
              {panelOpen && (
                <section ref={panelRef} className="relative flex min-h-0 min-w-0 flex-col bg-white">
                  {cutBack && (
                    <div className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 animate-[screen-in_300ms_ease-out] items-center gap-2 rounded-full bg-ink py-1 pl-3 pr-1 text-[12.5px] leading-4 text-white shadow-[0_10px_24px_-10px_#00000080]">
                      <span className="max-w-[260px] truncate">New from {cutBack.name}</span>
                      <button
                        onClick={() => {
                          setActive(cutBack.back);
                          setCutBack(null);
                        }}
                        className="rounded-full bg-white/15 px-2.5 py-1 font-medium hover:bg-white/25"
                      >
                        Back
                      </button>
                    </div>
                  )}
                  {/* Web pages stay loaded while you look at other tabs. */}
                  {tabs.map(
                    (t) =>
                      t.kind === "web" && (
                        <WebTab
                          key={t.id}
                          url={t.url}
                          user={state.account?.user.id}
                          hidden={t.id !== active}
                          onPage={(url, title) => setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, title: title || hostOf(url) } : x)))}
                        />
                      ),
                  )}
                  {tab?.kind === "bot" ? (
                    <BotPanel
                      state={state}
                      bot={bot}
                      section={tab.section}
                      onSection={(section) => setTabs(tabs.map((t) => (t.id === tab.id ? { ...tab, section } : t)))}
                      onOpenChat={openChat}
                      onOpenThread={openThread}
                      onOpenVault={openVault}
                      onOpenComputer={openComputer}
                      onUpgrade={() => {
                        trackEvent("bops_upgrade_clicked", { surface: "bot_panel" });
                        setAccount(true);
                      }}
                      onClose={() => leaveTab(tab.id)}
                    />
                  ) : tab?.kind === "new" ? (
                    <NewTab
                      state={state}
                      onWeb={(url) => setTabs(tabs.map((t) => (t.id === tab.id ? { id: t.id, kind: "web", url } : t)))}
                      onComputer={(id) => {
                        closeTab(tab.id);
                        openComputer(id);
                      }}
                      onProfile={(id) => setTabs(tabs.map((t) => (t.id === tab.id ? { id: t.id, kind: "bot", botId: id, section: "details" } : t)))}
                      onVault={() => setTabs(tabs.map((t) => (t.id === tab.id ? { id: t.id, kind: "vault" } : t)))}
                      onMac={() => setTabs(tabs.map((t) => (t.id === tab.id ? { id: t.id, kind: "mac" } : t)))}
                    />
                  ) : tab?.kind === "vault" ? (
                    <VaultTab state={state} onClose={() => leaveTab(tab.id)} />
                  ) : tab?.kind === "crm" ? (
                    <CrmView
                      key={`${tab.id}:${tab.file}`}
                      state={state}
                      ws={tab.ws}
                      file={tab.file}
                      mode="panel"
                      onClose={() => leaveTab(tab.id)}
                      onFocus={() => {
                        setMacFocus(false);
                        setCrmFocus({ ws: tab.ws, file: tab.file });
                        setFocus(true);
                      }}
                    />
                  ) : null}
                  {/* Your Mac stays capturing, hidden, for two minutes after you leave it (restarting capture is slow). */}
                  {(showingMac || macHeld) && (
                    <div className={`min-h-0 flex-1 flex-col px-5 pb-4 pt-4 ${showingMac ? "flex" : "hidden"}`}>
                      <MacComputer
                        state={state}
                        mode="panel"
                        showThread={thread?.runsOn === "mac" ? thread.id : undefined}
                        onFocus={() => {
                          setMacFocus(true);
                          setCrmFocus(null);
                          setFocus(true);
                        }}
                        onOpenThread={openThread}
                        hidden={!showingMac}
                      />
                    </div>
                  )}
                  {heldBot && (
                    <div className={`min-h-0 flex-1 flex-col px-5 pb-4 pt-4 ${showingComputer ? "flex" : "hidden"}`}>
                      <ComputerView
                        key={heldBot.id}
                        state={state}
                        bot={heldBot}
                        display={defaultDisplay(state, heldBot.id, displays[heldBot.id])}
                        onDisplay={setDisplay}
                        follow={showingComputer ? follow : undefined}
                        mode="panel"
                        onFocus={clickIn}
                        hidden={!showingComputer}
                      />
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
        {callBot && (
          // One call bar for the whole app, never remounted while the call lasts: it only moves.
          <div
            className="fixed z-40"
            style={callHere && slotBox ? { left: slotBox.x, top: slotBox.y, transform: "translateX(-50%)" } : { left: 12, bottom: 76 }}
          >
            <CallBar bot={callBot} owner={state.owner?.name} compact={!(callHere && slotBox)} onOpen={() => openChat(botChatId(callBot.id))} onClose={() => setCall(null)} />
          </div>
        )}
        {/* Before Account, so the plans open on top of it and closing them shows it again. */}
        {members && (
          <Members
            state={state}
            onClose={() => setMembers(false)}
            onUpgrade={() => {
              trackEvent("bops_upgrade_clicked", { surface: "members" });
              setAccount(true);
            }}
          />
        )}
        {settings && <Settings state={state} onClose={() => setSettings(false)} />}
        {account && (
          <Account
            state={state}
            onClose={() => setAccount(false)}
            onThisMac={() => {
              setAccount(false);
              setSetup(true);
            }}
          />
        )}
        {setup && <Setup state={state} onClose={() => setSetup(false)} />}
        {/* The first time a workspace gets email: "Pick your Bops address" (or an offer to change one Bops picked). */}
        {!settings && !account && !setup && !members && <MailAddressStep state={state} />}
        {/* What bots are doing on the user's Mac, live, in the corner (hidden while the Your Mac tab is open). */}
        {!(tab?.kind === "mac" && panelOpen) && <MacPreviews state={state} onOpen={openMac} />}
      </div>
    </OpenCrm.Provider>
    </OpenLink.Provider>
    </BusyBots.Provider>
  );
}

/* ---------------- Title bar ---------------- */

/** The window's title bar: traffic lights (in the desktop app), the right side's tabs above it, and the panel toggle. */
function TitleBar({ columns, wide, tabs, panelOpen, onTogglePanel }: { columns: string; wide: boolean; tabs: React.ReactNode; panelOpen: boolean; onTogglePanel: () => void }) {
  const desktop = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
  return (
    <div className={`grid h-11 shrink-0 border-b border-[#ECECEA] bg-[#F7F7F6] [-webkit-app-region:drag] ${columns}`}>
      <div className="flex items-center px-3.5">{desktop && <div className="w-[52px] shrink-0" />}</div>
      {!wide && <div />}
      <div className="flex min-w-0 items-center gap-2 pl-3 pr-3.5">
        {tabs || <div className="flex-1" />}
        <button
          onClick={onTogglePanel}
          title={panelOpen ? "Hide the side panel" : "Show the side panel"}
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg [-webkit-app-region:no-drag] ${panelOpen ? "bg-[#EEEEEC]" : "shadow-[0_0_0_1px_#E2E2DF]"}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="#3A3A38" strokeWidth="1.3" />
            <path d="M10 2.5v11" stroke="#3A3A38" strokeWidth="1.3" />
            {panelOpen && <rect x="10.6" y="3.1" width="3.3" height="9.8" fill="#3A3A38" opacity="0.25" />}
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ---------------- Settings ---------------- */

type MailInfo = {
  on: boolean;
  error?: string;
  domain?: string;
  status?: string;
  subdomains?: boolean;
  records?: { type: string; name: string; value: string; priority?: number; status: string }[];
  inboxes?: { bot: string; email: string }[];
};

/** Email for bots: on or off, bops.bot's state, and the DNS records to add while it isn't verified. */
function MailSettings() {
  const [info, setInfo] = useState<MailInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (body?: { action: string }) => {
    setBusy(true);
    void fetch("/api/mail", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined)
      .then((r) => r.json())
      .then((j: MailInfo) => setInfo((was) => (j.error && was ? { ...was, error: j.error } : j)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    void fetch("/api/mail")
      .then((r) => r.json())
      .then((j: MailInfo) => setInfo(j));
  }, []);
  if (!info) return null;
  const ready = info.status === "VERIFIED" && info.subdomains;
  const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <span className="text-[13px] font-semibold">Email</span>
      <div className="flex flex-col gap-2.5 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        {!info.on ? (
          <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">Off. Add AGENTMAIL_API_KEY to .env.local and every bot gets its own email address.</span>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
              <span className={`size-[7px] rounded-full ${ready ? "bg-[#2BB673]" : info.status === "NOT_ADDED" ? "bg-[#C9C9C6]" : "bg-[#E59A0B]"}`} />
              {ready
                ? `Bots have ${info.domain} addresses.`
                : info.status === "NOT_ADDED"
                  ? `Bots have agentmail.to addresses for now. Set up ${info.domain} to give them yours.`
                  : `${info.domain} is ${info.status?.toLowerCase().replace("_", " ")}. Add these records at your DNS host, then check again. Bots move to it on their own once it's verified.`}
            </span>
            {!ready && !!info.records?.length && (
              <div className="flex flex-col overflow-hidden rounded-[10px] shadow-[0_0_0_1px_#ECECEA]">
                {info.records.map((r, i) => (
                  <div key={i} className="flex items-start gap-3 border-b border-[#F0F0EE] px-3 py-2 font-mono text-[11.5px] leading-4 last:border-0">
                    <span className="w-9 shrink-0 font-semibold">{r.type}</span>
                    <span className="w-[150px] shrink-0 truncate" title={r.name}>{r.name}</span>
                    <span className="min-w-0 flex-1 select-all break-all text-[#3A3A38]">
                      {r.priority !== undefined ? `${r.priority} ` : ""}
                      {r.value}
                    </span>
                    <span className={`shrink-0 font-sans ${r.status === "VERIFIED" ? "text-[#2BB673]" : "text-[#9A9A98]"}`}>{r.status.toLowerCase()}</span>
                  </div>
                ))}
              </div>
            )}
            {!!info.inboxes?.length && (
              <span className="text-[12px] leading-4 text-[#6B6B6B]">{info.inboxes.map((x) => `${x.bot}: ${x.email}`).join(" · ")}</span>
            )}
            {info.error && <span className="text-[12px] leading-4 text-[#B42318]">{info.error}</span>}
            <div className="flex gap-1.5">
              {info.status === "NOT_ADDED" && (
                <button disabled={busy} onClick={() => load({ action: "setup" })} className={`${btn} bg-ink text-white`} data-tip="Adds it to AgentMail and shows the DNS records to add. Changes no DNS.">
                  Set up {info.domain}
                </button>
              )}
              {!ready && info.status !== "NOT_ADDED" && (
                <button disabled={busy} onClick={() => load({ action: "verify" })} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
                  Check DNS again
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type PhoneInfo = {
  on: boolean;
  error?: string;
  texting?: string;
  textingNote?: string;
  calls?: string;
  owners?: OwnerNumber[];
  pending?: PendingCode[];
  verify?: boolean;
  workspaces?: { id: string; name: string; main: string | null; line: { phone: string; type: string } | null; call: string | null }[];
  lines?: { bot: string; phone: string }[];
};

/**
 * A row of How your bots reach you that has nothing to set yet: still loading, not on this server, or
 * Bops didn't answer (`retry` reads it again).
 */
function ReachNote({ label, line, retry }: { label: string; line: string; retry?: () => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium leading-4">{label}</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-4 text-[#6B6B6B]">
        <span role={retry ? "alert" : undefined}>{line}</span>
        {retry && (
          <button onClick={retry} className="font-medium text-ink underline-offset-2 hover:underline">
            Try again
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * The mobile part of How your bots reach you: the banner while a saved number isn't verified, your
 * mobile (texts and calls from it are you, and it's where bots text you, with your OK: the opt-in
 * carriers ask for), and the numbers to text and call your bots on.
 */
function MobileRows({ info, onInfo }: { info: PhoneInfo; onInfo: (p: PhoneInfo) => void }) {
  const phone = useOwnerPhone(info, onInfo);
  const reach = (info.workspaces ?? []).filter((w) => w.line || w.call);
  return (
    <>
      <ReachBanner info={info} phone={phone} />
      <OwnerPhone info={info} phone={phone} recommended collapseWhenSaved bannerFor={bannerNumber(info, phone)?.number} />
      {!!reach.length && (
        <div className="flex flex-col gap-1 border-t border-[#F0F0EE] pt-2.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
          {reach.map((w) => {
            const who = w.main ?? "your main bot";
            const text = w.line?.phone ?? w.call;
            return (
              <div key={w.id} className="flex flex-col gap-1">
                <span>
                  {reach.length > 1 && <span className="text-[#9A9A98]">{w.name}: </span>}
                  {w.call && w.call !== text ? `Text ${who} at ${text} · call at ${w.call}` : `Text or call ${who} at ${text}`}
                  <span className="text-[#9A9A98]"> ({who} hands work to the team)</span>
                </span>
                {text && <LineLink phone={text} />}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * How your bots reach you: your mobile first (the main way your bots know it's you, and where they
 * text you), then your email addresses (emails from them are you). Shown when texting or email is on
 * here; each row says so when its own service isn't, and the line at the top names only what is.
 */
function ReachSettings() {
  const [phone, setPhone, phoneRead] = usePhoneInfo<PhoneInfo>();
  const [email, setEmail, emailRead] = useOwnerEmailInfo();
  if (!phone?.on && !email?.on) return null;
  // Not known yet (or not read) counts as on: the rows below say how each stands.
  const texting = phone?.on !== false;
  const mailing = email?.on !== false;
  const intro =
    texting && mailing
      ? "Text, call or email your bots, and they reach you back. They know it's you from the numbers and emails listed here."
      : texting
        ? "Text or call your bots, and they reach you back. They know it's you from the numbers listed here."
        : "Email your bots, and they reach you back. They know it's you from the emails listed here.";
  const unreachable = "Couldn't reach Bops.";
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-semibold">How your bots reach you</span>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">{intro}</span>
      </div>
      <div className="flex flex-col gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        {!phone ? (
          <ReachNote label="Your mobile" {...(phoneRead.failed ? { line: unreachable, retry: phoneRead.retry } : { line: "Checking" })} />
        ) : !phone.on ? (
          <ReachNote label="Your mobile" line="Texting your bots isn't set up on this server." />
        ) : (
          <MobileRows info={phone} onInfo={setPhone} />
        )}
        {mailing && (
          <div className="border-t border-[#F0F0EE] pt-3">
            {email ? (
              <OwnerEmail info={email} onInfo={setEmail} />
            ) : (
              <ReachNote label="Your email" {...(emailRead.failed ? { line: unreachable, retry: emailRead.retry } : { line: "Checking" })} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** For self-hosting: how your own phone service stands (texting approval, live-voice calls, numbers). */
function PhoneService() {
  const [info] = usePhoneInfo<PhoneInfo>();
  if (!info?.on) return null;
  const texting = info.texting === "approved" || info.texting === "active" ? "ready" : info.texting === "none" ? "not registered yet" : (info.texting ?? "unknown").replace(/_/g, " ");
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <span className="text-[13px] font-semibold">Phone service (AgentPhone)</span>
      <div className="flex flex-col gap-1 rounded-[14px] p-3.5 text-[12.5px] leading-[18px] text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3]">
        <span>
          <span className="text-[#9A9A98]">Texting back:</span> {texting}
          {info.texting === "none" ? " (carriers approve business texting first (A2P 10DLC), about 7–10 business days)" : ""}
        </span>
        <span>
          <span className="text-[#9A9A98]">Calls to the bots&apos; numbers:</span> {info.calls === "agent" ? "on (each number's agent passes every turn to Bops)" : (info.calls ?? "unknown")}
        </span>
        {info.workspaces?.map((w) => (
          <span key={w.id}>
            <span className="text-[#9A9A98]">{w.name}:</span> {w.line ? `${w.line.phone} (${w.line.type === "imessage" ? "iMessage" : "SMS"})` : "no workspace number"}
          </span>
        ))}
        {!!info.lines?.length && <span className="text-[#6B6B6B]">Bots&apos; own numbers: {info.lines.map((l) => `${l.bot} ${l.phone}`).join(" · ")}</span>}
      </div>
    </div>
  );
}

/** Who the bots work for: the name they call you by, and what they should know about you (in every bot's instructions). */
function OwnerSettings({ owner }: { owner: AppState["owner"] }) {
  const [name, setName] = useState(owner?.name ?? "");
  const [about, setAbout] = useState(owner?.about ?? "");
  const [saved, setSaved] = useState(false);
  const changed = name.trim() !== (owner?.name ?? "") || about.trim() !== (owner?.about ?? "");
  const save = async () => {
    await post("/api/owner", { name, about });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
      <span className="text-[13px] font-semibold">You</span>
      <div className="flex flex-col gap-2.5 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        <label className="flex items-center gap-3">
          <span className="w-[120px] text-[13px] font-medium">Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What your bots call you"
            className="h-8 w-[260px] rounded-full bg-[#F7F7F6] px-3 text-[13px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
          />
        </label>
        <label className="flex items-start gap-3">
          <span className="w-[120px] pt-1.5 text-[13px] font-medium">About you</span>
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            rows={2}
            placeholder="What every bot should know, like your role and company"
            className="flex-1 resize-none rounded-[12px] bg-[#F7F7F6] px-3 py-1.5 text-[13px] leading-[18px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
          />
        </label>
        <div className="flex items-center gap-2 pl-[132px]">
          <button disabled={!changed || !name.trim()} onClick={() => void save()} className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white disabled:opacity-40">
            Save
          </button>
          {saved && <span className="text-[12px] text-[#6B6B6B]">Saved</span>}
        </div>
      </div>
    </div>
  );
}

const option = (on: boolean) => (on ? "bg-[#FBFFE0] shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]");
const radio = (on: boolean) =>
  on ? (
    <span className="flex size-4 items-center justify-center rounded-full bg-ink">
      <span className="size-1.5 rounded-full bg-highlighter" />
    </span>
  ) : (
    <span className="size-4 rounded-full shadow-[inset_0_0_0_1.5px_#C9C9C6]" />
  );

/** A bot's computer, in plain words. A bot that shares says whose computer it works on. */
const computerNow = (state: AppState, b: AppState["bots"][number]) => {
  const c = workBot(b, state.bots);
  if (state.host !== "mac" && c.id !== b.id) return `Works on ${c.name}'s computer`;
  return state.host === "mac" ? "Uses this Mac" : b.computerStatus === "ready" ? "Ready" : b.computerStatus === "cloning" ? "Setting up" : b.computerStatus === "none" ? "Set up on its first task" : "Couldn't be set up yet";
};

/**
 * For self-hosting (BOPS_SELF_HOSTED=1): the providers behind Bops, from .env.local. How screens are
 * reached (Tailscale), the email domain, the phone service, and each computer's id.
 */
function SelfHosting({ state }: { state: AppState }) {
  const joined = state.bots.filter((b) => b.tailnet);
  const tailnet = state.host === "orgo" && joined.length > 0;
  return (
    <div className="mt-5 flex flex-col border-t border-[#F0F0EE] pb-5">
      <div className="flex flex-col gap-0.5 px-[22px] pt-4">
        <span className="text-[15px] font-semibold">Self-hosting</span>
        <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">Your own provider accounts, set in .env.local. The hosted Bops runs these for its users.</span>
      </div>

      <div className="flex flex-col gap-2 px-[22px] pt-4">
        <span className="text-[13px] font-semibold">Network</span>
        <div className="flex gap-2.5">
          <div className={`flex flex-1 flex-col gap-1.5 rounded-[14px] p-3.5 ${option(!tailnet)}`}>
            <span className="flex items-center justify-between">
              <span className="text-[14px] font-semibold">{state.host === "mac" ? "Direct on this Mac" : "Through Orgo"}</span>
              {radio(!tailnet)}
            </span>
            <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">
              {state.host === "mac" ? "Screens are mirrored as live pages straight from the browsers here." : "Screenshots and input go through Orgo's API. Works everywhere."}
            </span>
          </div>
          <div className={`flex flex-1 flex-col gap-1.5 rounded-[14px] p-3.5 ${option(tailnet)}`}>
            <span className="flex items-center justify-between">
              <span className="text-[14px] font-semibold">Your Tailscale tailnet</span>
              {radio(tailnet)}
            </span>
            <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">
              {joined.length
                ? `${joined.length} computer${joined.length === 1 ? "" : "s"} on your tailnet. Orgo screens are mirrored as live pages, directly and privately.`
                : "Computers join your tailnet when they start a task, for a direct, private mirror."}
            </span>
          </div>
        </div>
      </div>

      <MailSettings />
      <PhoneService />

      <div className="flex flex-col px-[22px] pt-4">
        <span className="pb-1 text-[13px] font-semibold">Computers (Orgo)</span>
        {state.bots.map((b) => (
          <div key={b.id} className="flex items-center border-b border-[#F0F0EE] py-2 last:border-0">
            <span className="w-[200px] text-[13px] font-medium">{b.name}</span>
            <span className="font-mono text-[12px] text-[#3A3A38]">{state.host === "mac" ? "this Mac" : b.computerId ? `${b.computerId}${b.tailnet ? ` · ${b.tailnet.ip}` : ""}` : sharesComputer(b) ? `shares ${workBot(b, state.bots).name}'s` : "none yet"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Settings({ state, onClose }: { state: AppState; onClose: () => void }) {
  const setHost = (host: Host) => void post("/api/host", { host });
  const selfHosted = useSelfHosted();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-[760px] flex-col overflow-y-auto rounded-[22px] bg-white shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]">
        <div className="flex items-center justify-between border-b border-[#F0F0EE] px-[22px] py-[18px]">
          <div className="flex flex-col gap-0.5">
            <span className="text-[18px] font-semibold leading-[22px]">Settings</span>
            <span className="text-[13px] leading-[17px] text-[#6B6B6B]">You, how your bots reach you, this Mac, and where your bots work</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3]">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <OwnerSettings owner={state.owner} />
        {!selfHosted && <UsageData />}
        <ReachSettings />
        {!selfHosted && <EmailAddresses state={state} />}
        <ThisMacSettings state={state} />

        <div className="flex flex-col gap-2 px-[22px] pt-4">
          <span className="text-[13px] font-semibold">Where your bots work</span>
          <div className="flex gap-2.5">
            {(["orgo", "mac"] as const).map((h) => (
              <button key={h} onClick={() => setHost(h)} className={`flex flex-1 flex-col gap-1.5 rounded-[14px] p-3.5 text-left ${option(state.host === h)}`}>
                <span className="flex items-center justify-between">
                  <span className="text-[14px] font-semibold">{h === "orgo" ? "Their own cloud computers" : "This Mac"}</span>
                  {radio(state.host === h)}
                </span>
                <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">
                  {h === "orgo" ? "Recommended. Your bots work on a computer in the cloud, with 4 screens, and keep working when your Mac is closed. A bot can have one of its own." : "Bots work in background browsers on this Mac, from your own internet connection."}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className={`flex flex-col px-[22px] pt-4 ${selfHosted ? "" : "pb-5"}`}>
          <span className="pb-1 text-[13px] font-semibold">Your bots&apos; computers</span>
          {teamOf(state).map((b) => (
            <div key={b.id} className="flex items-center border-b border-[#F0F0EE] py-2.5 last:border-0">
              <span className="flex w-[200px] items-center gap-2">
                <Mascot botId={b.id} color={b.color} size={20} />
                <span className="text-[13.5px] font-medium">{b.name}</span>
              </span>
              <span className="flex flex-1 items-center gap-1.5 text-[12.5px] text-[#3A3A38]">
                <span
                  className={`size-[7px] rounded-full ${state.host === "mac" || workBot(b, state.bots).computerStatus === "ready" ? "bg-[#2BB673]" : workBot(b, state.bots).computerStatus === "cloning" ? "bg-[#E59A0B]" : "bg-[#C9C9C6]"}`}
                />
                {computerNow(state, b)}
              </span>
            </div>
          ))}
        </div>

        {selfHosted && <SelfHosting state={state} />}
      </div>
    </div>
  );
}
