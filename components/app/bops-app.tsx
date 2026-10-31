"use client";

import { appsName, appsOwnShown, appsShown } from "@/lib/apps-access";
import { screenMap } from "@/lib/screens";
import { chatAsks } from "@/lib/asks";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountIn, botChatId, BRAINS_ON, isScreenWatch, live, sharesComputer, siteBotOf, siteLoginIn, workBot, workspaceOf, type AppState, type Host, type Session, type Watch } from "@/lib/types";
import { appCoders, copyBotOf } from "@/lib/hosted-apps";
import { initialsOf, PlanAndCredit, UsageSection } from "./account";
import { AutopilotPage, type AutopilotOpen, type AutopilotSection } from "./autopilot";
import { Members } from "./members";
import { TeamChart } from "./team-chart";
import { BotPanel, type Section } from "./bot-panel";
import { ChatEdge, gridColumns, storedChatWidth } from "./chat-edge";
import { BotComputers } from "./bot-computers";
import { BrainSettings } from "./brains";
import { CallBar } from "./call-bar";
import { ChatView, forgetSheet, ThreadSheet, ToPicker } from "./chat-view";
import { ComputerPeek, ComputerView, defaultDisplay } from "./computer";
import { crmOpen } from "@/lib/crm-access";
import { categoriesOpen } from "@/lib/memory-categories";
import { tagsOf } from "@/lib/routine-catalog";
import { CrmView, OpenCrm } from "./crm";
import { BoppyLoading, BotMoodsFrom, CallTalking, Mascot, talkingStore } from "./mascot";
import { MemoryView, type MemoryOpen } from "./memory-categories";
import { CHAT_TAB, electron, forgetTab, hostOf, isReading, memoryAgain, NewTab, OpenBotLocal, OpenLink, OpenPreview, TabBar, WebTab, type PanelTab, type PreviewOpened } from "./panel-tabs";
import { PreviewTab } from "./preview-tab";
import { MadeAppsHome, MadeAppTab, OpenMadeApp } from "./made-apps";
import { appsStamp, HostedAppTab, OpenAppTask, OpenHostedApp, OpenSettings } from "./hosted-apps";
import { ComposerBridgeProvider, useComposerBridgeHost } from "./composer-bridge";
import { OpenBotComputer } from "./app-envs";
import { WorkspaceDomains } from "./workspace-domains";
import { BotSettingsPage } from "./bot-settings";
import type { SettingsSection } from "@/lib/bot-settings";

/** Your Mac's tab, and the chat's bot's profile (it follows the chat, like the computer tab); both open on demand. */
const MAC_TAB = "tab_mac";
import { opensMacTab, PROFILE_TAB, tabsShown } from "./tabs-shown";
import { NameInput, Sidebar } from "./sidebar";
import { SidebarRail } from "./sidebar-rail";
import type { BotMenuActions } from "./bot-menu";
import { NewThread } from "./new-thread";
import { readyAgents } from "@/lib/agents";
import { footerPageOf, openFooterPage } from "./sidebar-footer";
import { CloudUnreachable, SignIn, useAuthStatus } from "./sign-in";
import { ThisMacSettings } from "./setup";
import { TooltipLayer } from "./tooltip";
import { LoginsPage } from "./logins";
import { MacPreviews } from "./mac-tab";
import { OPEN_MAC_KEY } from "./mac-pip";
import { MacComputer } from "./mac-computer";
import { RestartButton, RestartIcon, useCanRestart } from "./restart";
import { RunsOnSettings } from "./runs-on";
import { chatInWorkspace, currentWorkspace, option, post, radio, SideToggleIcon, teamOf, useAppState, useSelfHosted } from "./ui";
import { viewOnly } from "./view-only";
import { readOnlyLine } from "@/lib/shared";
import { duePings } from "@/lib/pings";
import { UsageData, useAnalytics } from "./usage-data";
import { YourData } from "./your-data";
import { trackEvent } from "@/lib/analytics";
import { OwnerEmail, useOwnerEmailInfo } from "./owner-email";
import { OwnerPhone, useOwnerPhone, usePhoneInfo, type OwnerNumber, type PendingCode } from "./owner-phone";
import { LineLink } from "./line-link";
import { EmailAddresses } from "./mail-address";
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

/** A new tab's id, made when a tab opens (in a handler, never while rendering). */
const tabId = () => `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function Bops({ state }: { state: AppState | null }) {
  // Empty until a chat is picked: the workspace's main bot's chat shows (see `chat` below).
  const [chatId, setChatId] = useState("");
  // What to put in a chat's message box once, to change and send (askBot; ChatView prefill): until it's in.
  const [prefill, setPrefill] = useState<{ chatId: string; text: string; at: number } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  // Closed by any way (Esc, a chat opened, its own close): the thread sheet's next opening plays its entrance again.
  useEffect(() => {
    if (!threadId) forgetSheet();
  }, [threadId]);
  const [composing, setComposing] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  // The sidebar on the left, or its rail of icons once you collapse it (sidebar-rail.tsx; this Mac
  // remembers; ⌘\ or the toggle).
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" || localStorage.getItem(SIDEBAR_KEY) !== "0");
  // Collapsing or expanding, the column slides (SLIDE), what's in it cut off at its edge until it's done
  // (then a menu in it may open past its edge again, as the rail's account menu does). Counted, so a
  // second toggle mid-slide waits its own full slide. Clipped, not hidden: a search opening focused in
  // it can't scroll the column sideways.
  const [sliding, setSliding] = useState(0);
  useEffect(() => {
    if (!sliding) return;
    const t = setTimeout(() => setSliding(0), SIDEBAR_SLIDE_MS + 60);
    return () => clearTimeout(t);
  }, [sliding]);
  // Expanded from the rail's Search or its workspace: the sidebar opens with that open.
  const [openWith, setOpenWith] = useState<"search" | "workspaces" | null>(null);
  const toggleSidebar = (open: "search" | "workspaces" | null = null) => {
    setOpenWith(open);
    setSliding((n) => n + 1);
    setSidebarOpen((was) => {
      localStorage.setItem(SIDEBAR_KEY, was ? "0" : "1");
      return !was;
    });
  };
  // The chat's column beside the side panel, as wide as its edge was dragged (chat-edge.tsx; this Mac remembers). While it's
  // dragged the columns don't slide, so the edge stays under the pointer.
  const [chatWidth, setChatWidth] = useState(storedChatWidth);
  const [edgeDragged, setEdgeDragged] = useState(false);
  const [focus, setFocus] = useState(false);
  // Full width shows your Mac instead of a bot's computer.
  const [macFocus, setMacFocus] = useState(false);
  // ...or a CRM file (crm.tsx), from its tab's Full width.
  const [crmFocus, setCrmFocus] = useState<{ ws: string; file: string } | null>(null);
  // The right side's tabs (the chat's own computer is always first; see panel-tabs.tsx).
  // Only the computer is open from the start; the rest open as you need them.
  const [openTabs, setTabs] = useState<PanelTab[]>([]);
  // The tabs as they are now, for what an answer that came later opens (Open preview).
  const tabsNow = useRef<PanelTab[]>([]);
  useEffect(() => {
    tabsNow.current = openTabs;
  }, [openTabs]);
  // The work the panel last followed ("thread:where"), so it switches between your Mac and the bot's
  // computer only when that changes, and a tab you picked stays until it does.
  const [followed, setFollowed] = useState("");
  // The newest thing waiting on you in this chat that the panel last went to (lib/asks.ts chatAsks): undefined until the first look, so what was already waiting doesn't jump.
  const [shownAsk, setShownAsk] = useState<string | undefined>(undefined);
  // The latest app build line in the chat (made-apps.tsx), so a new one opens its app's tab once.
  const [shownBuild, setShownBuild] = useState<string | undefined>(undefined);
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
  // The thread whose card you came to a bot's screen from (its Sign in), by bot: taking control of that screen is for it (ComputerView forThread).
  const [cameFor, setCameFor] = useState<Record<string, { display: number; sessionId: string } | undefined>>({});
  // Settings, a page in the main area (the sidebar stays beside it), at one of its places: Logins from the footer, Team
  // from your initials, Plan and credit from an upgrade, This Mac from the setup badge, the Org chart at a bot (`chartBot`),
  // Domains from an app's All domains; `keysFor`: the bot a key is being added for. `atAt` makes each opening go to its
  // place again, even the one it's at. Only here, in this window: nothing of it is saved.
  const [settings, setSettings] = useState<false | { at?: SettingsPane; keysFor?: string; chartBot?: string; atAt: number }>(false);
  const openSettings = (at?: SettingsPane, more: { keysFor?: string; chartBot?: string } = {}) => setSettings({ ...(at ? { at } : {}), ...more, atAt: Date.now() });
  // A bot's full settings page (bot-settings.tsx), over the whole window, at a section; `atAt` makes each opening a new page.
  const [botPage, setBotPage] = useState<{ botId: string; at?: SettingsSection; atAt: number } | null>(null);
  // What had focus as the page opened (the panel's Open full settings, or one of its rows), and whether closing gives it
  // back: Back, the X, Esc and Collapse leave the app as it was, focus too; a link elsewhere takes focus where it goes.
  const pageOpener = useRef<HTMLElement | null>(null);
  const pageRefocus = useRef(false);
  const openBotPage = (botId: string, at?: SettingsSection) => {
    pageOpener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    pageRefocus.current = false;
    setBotPage({ botId, at, atAt: Date.now() });
  };
  const closePage = () => {
    pageRefocus.current = true;
    setBotPage(null);
  };
  useEffect(() => {
    if (botPage) return;
    const el = pageOpener.current;
    const back = pageRefocus.current;
    pageOpener.current = null;
    pageRefocus.current = false;
    // Once the grid under the page isn't inert any more (this commit): the opener, else the panel's own way back in.
    if (back) (el?.isConnected ? el : document.querySelector<HTMLElement>("[data-open-full]"))?.focus({ preventScroll: true });
  }, [botPage]);
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
  // judged "now", and finished tasks the user is waiting on (lib/pings.ts). Not for what was already there when Bops opened.
  const pinged = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!state) return;
    // A workspace shared with the user is someone else's: its news is theirs to be told of. The user's own
    // still chimes meanwhile, as the server sends it along (AppState.ownPings).
    const due = state.shared ? (state.ownPings ?? []) : duePings(state);
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
  // New thread, for a bot with more than one agent ready (new-thread.tsx): its bot. Over its chat's message box, in place.
  const [newThreadFor, setNewThreadFor] = useState<string | null>(null);
  // What the Preview tab's Select and Draw put in a bot's message box, unsent (composer-bridge.tsx): its chat comes
  // up with its box in view (no thread over it, nothing full width), the side panel left as it is.
  const composerBridge = useComposerBridgeHost((id) => {
    setChatId(id);
    setThreadId(null);
    setComposing(false);
    setNewThreadFor(null);
    setFocus(false);
  });
  // Whether the bot's voice is coming through on that call right now (its mascot talks while it does):
  // a store of its own (CallTalking), so a word starting or ending doesn't redraw the whole app.
  const [callTalking] = useState(talkingStore);
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
  // The sidebar collapsing or expanding moves the chat column without resizing it: measured again once it
  // has slid (before the slide's own end clears `sliding`, which would cancel this).
  useEffect(() => {
    if (!callSlot || !sliding) return;
    const t = setTimeout(() => {
      const r = callSlot.getBoundingClientRect();
      setSlotBox({ x: r.left + r.width / 2, y: r.top });
    }, SIDEBAR_SLIDE_MS + 30);
    return () => clearTimeout(t);
  }, [callSlot, sliding]);
  // (No app-wide clock: redrawing everything every second cost a full render a second. What shows a
  // running time keeps its own: the open thread, the sidebar's "5m", watch pills, the call timer.)

  // Clicking into a computer takes over its screen; leaving the full view hands it back (a CRM file full width took nothing).
  // Not a thread's terminal (Takeover.terminal): it stays open on its screen until a reply or Hand back closes it.
  const wasFocused = useRef(false);
  const computerFocus = focus && !crmFocus;
  const inTerminal = !!state?.takeover?.terminal;
  useEffect(() => {
    if (wasFocused.current && !computerFocus && !inTerminal) void post("/api/takeover", {}, "DELETE");
    wasFocused.current = computerFocus;
  }, [computerFocus, inTerminal]);

  // What Esc does to the tab on the right, set on every render (see escTab.current below).
  const escTab = useRef<(e: KeyboardEvent) => void>(() => {});
  // Whether the Settings page is open, set on every render: Esc goes back from it (and only from it).
  const settingsOpen = useRef(false);
  // Settings while a domain is being bought (Settings' onHold): Esc leaves it open, and everything under it as it is.
  const settingsHeld = useRef(false);
  // What Esc does while a bot's settings page is open, set on every render: true when it took the key (pageEsc.current below).
  const pageEsc = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const holdSettings = useCallback((held: boolean) => {
    settingsHeld.current = held;
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setBotPage(null);
        setComposing(true);
      }
      // ⌘\ collapses the sidebar to its rail, or expands it.
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setOpenWith(null);
        setSliding((n) => n + 1);
        setSidebarOpen((open) => {
          localStorage.setItem(SIDEBAR_KEY, open ? "0" : "1");
          return !open;
        });
        return;
      }
      if (e.key === "Escape" && settingsHeld.current) return;
      if (e.key === "Escape" && settingsOpen.current) {
        // The Settings page: Esc goes back to where you were, once nothing in it wanted the key (a menu, a picker, a
        // confirm in place say so with preventDefault; some listen after this one, so it's read once they all have).
        setTimeout(() => {
          if (!e.defaultPrevented && !settingsHeld.current) setSettings(false);
        }, 0);
        return;
      }
      if (e.key === "Escape" && pageEsc.current(e)) return;
      if (e.key === "Escape") {
        setThreadId(null);
        setFocus(false);
        // Last, so going back can bring a full-width computer back.
        escTab.current(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A workspace shared with the user open: nothing in the window changes anything through the app's own routes
  // (view-only.ts); what a member with Write does there goes only through /api/workspaces/shared. Set as it
  // renders, not in an effect: what it draws runs its effects first (a chat's mark read), and the ids there are
  // often the user's own too.
  viewOnly(state?.shared ? readOnlyLine() : null);

  if (!state) return <FirstLoad />;

  // Your Mac full width is the viewer's own Mac, never a workspace shared with them: opening one from the
  // sidebar (still there at full width) goes back to the chat rather than carry it over (MacComputer).
  if (state.shared && macFocus) {
    setMacFocus(false);
    if (focus && !crmFocus) setFocus(false);
  }

  // Stay inside the workspace you're in: a chat from another one falls back to this one's main bot.
  const team = teamOf(state);
  const here = state.chats.filter((c) => chatInWorkspace(state, c));
  const chat = here.find((c) => c.id === chatId) ?? here.find((c) => c.kind === "bot" && team.find((b) => b.id === c.botIds[0])?.isMain) ?? here[0] ?? state.chats[0];
  const thread = threadId ? state.sessions.find((s) => s.id === threadId) : undefined;
  // The first tab shows the computer of the bot you're talking to (or whose thread is open).
  const chatBotId = thread?.botId ?? chat.botIds[0];
  // A deleted bot's tabs go with it; the profile tab is always the chat's bot. A CRM file shows in its own workspace only,
  // and only to an account the CRM is open to (lib/crm-access.ts); the same for the memory page (lib/memory-categories.ts)
  // and for apps, the ones bots made and those on the web (lib/apps-access.ts), which a shared workspace never shows (they're its owner's).
  const crm = crmOpen(state);
  const memory = categoriesOpen(state);
  const apps = appsShown(state);
  // The apps the bots made stay the owner's, in a workspace shared with Your Apps too.
  const ownApps = appsOwnShown(state);
  const tabs = tabsShown(openTabs, state, { chatBotId, ws: currentWorkspace(state), crm, memory, apps });
  const tab = active === CHAT_TAB ? undefined : tabs.find((t) => t.id === active);
  // The footer's pill: the Settings page's Logins or Your Apps while it's open there, else the page in sight on the right.
  const inSight = { settings: settings ? (settings.at ?? "profile") : undefined, tab: panelOpen && !focus ? tab?.kind : undefined, knowledge: memory };
  const footer = footerPageOf(inSight);
  // The rail fills in only a page that's really open (no resting pill to fall back on).
  const openPage = openFooterPage(inSight);
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
    const browsing =
      tab &&
      (tab.kind === "web" ||
        tab.kind === "vault" ||
        tab.kind === "crm" ||
        tab.kind === "memory" ||
        tab.kind === "autopilot" ||
        tab.kind === "made-app" ||
        tab.kind === "made-apps" ||
        tab.kind === "hosted-app" ||
        (tab.kind === "computer" && tab.botId !== chatBotId) ||
        (tab.kind === "bot" && tab.id !== PROFILE_TAB));
    if (lead && !browsing && !focus) {
      // Its screen comes up with it, even with the side panel hidden, and the panel follows the action
      // again (several at once show side by side), even if you'd picked a screen before.
      setPanelOpen(true);
      if (lead.runsOn !== "mac") setPinned((p) => ({ ...p, [lead.botId]: false }));
      // In a workspace shared with the user, a lead on the owner's Mac is never the viewer's own Mac tab (opensMacTab).
      if (opensMacTab(state, lead)) {
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
  // Not while a shared workspace is open: it would keep capturing the viewer's own screens there.
  const macHeld = macWasShown && !showingMac && macHeldAt === 1 && !state.shared;
  const heldBot = showingComputer ? bot : held ? state.bots.find((b) => b.id === held.botId) : undefined;
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
  const openComputer = (id: string) => {
    if (id === chatBotId) {
      setActive(CHAT_TAB);
      setPanelOpen(true);
      setFocus(false);
    } else openTab((t) => t.kind === "computer" && t.botId === id, () => ({ id: tabId(), kind: "computer", botId: id }));
  };
  /**
   * A screen up close: that bot's computer (its tab, or the chat's own panel), pinned to the screen. The chat stays where it is.
   * `sessionId`: the thread waiting there whose card this came from, so taking control of that screen is for it.
   */
  const showScreen = (id: string, d: number, sessionId?: string) => {
    setDisplays((x) => ({ ...x, [id]: d }));
    setPinned((p) => ({ ...p, [id]: true }));
    setCameFor((x) => ({ ...x, [id]: sessionId ? { display: d, sessionId } : undefined }));
    openComputer(id);
  };
  // Something new waiting on you here (in the main bot's chat, from any bot): the panel shows its screen,
  // with its card, unless you're reading something (a page, the Vault) or have a computer full width.
  // Never in a shared workspace: its bots' screens are the owner's, which this window doesn't read (view-only.ts
  // OWN_READS), and a Write member answers its card in the chat.
  const [ask] = state.shared ? [] : chatAsks(state, chat.id);
  const askKey = ask ? `${ask.id}:${ask.endedAt ?? ""}:${ask.blocker ?? ""}` : "";
  if (shownAsk !== askKey) {
    setShownAsk(askKey);
    const reading = isReading(tab);
    const d = ask && (ask.display ?? ask.lastDisplay);
    if (shownAsk !== undefined && ask && d !== undefined && ask.runsOn !== "mac" && ask.host !== "mac" && !reading && !focus) {
      // As showScreen does, with the tab named for the ask (rendering can't make a new id).
      setDisplays((x) => ({ ...x, [ask.botId]: d }));
      setPinned((p) => ({ ...p, [ask.botId]: true }));
      if (ask.botId === chatBotId) {
        setActive(CHAT_TAB);
        setPanelOpen(true);
        setFocus(false);
      } else openTab((t) => t.kind === "computer" && t.botId === ask.botId, () => ({ id: `tab_ask_${ask.id}`, kind: "computer", botId: ask.botId }));
    }
  }
  const openProfile = (id: string, section: Section = "details") =>
    openTab(
      (t) => t.kind === "bot" && t.botId === id && (t.id === PROFILE_TAB) === (id === chatBotId),
      () => ({ id: id === chatBotId ? PROFILE_TAB : tabId(), kind: "bot", botId: id, section }),
      (t) => ({ ...t, section }) as PanelTab,
    );
  // Logins: Settings, at the open workspace's Logins (keysFor: adding a key for that bot).
  const openVault = (keysFor?: string) => setSettings({ at: "logins", ...(keysFor ? { keysFor } : {}), atAt: Date.now() });
  /** A CRM file, as a tab (one per file). */
  const openCrm = (ws: string, file: string) =>
    openTab(
      (t) => t.kind === "crm" && t.ws === ws && t.file.toLowerCase() === file.toLowerCase(),
      () => ({ id: tabId(), kind: "crm", ws, file }),
      (t) => ({ ...t, file }) as PanelTab,
    );
  /**
   * Knowledge, what Bops knows (memory-categories.tsx): the workspace's one Knowledge tab, on the kind
   * asked for (all of them when none is), at the item asked for or with the search asked for, or opened.
   */
  const openMemory = ({ category, focus: item, query }: MemoryOpen = {}) => {
    const ws = currentWorkspace(state);
    const focusAt = Date.now();
    // A search with no kind goes to All: left on Skills or Issues, the tab would show a page that has no search.
    const cat = category ?? (query !== undefined ? "all" : undefined);
    openTab(
      (t) => t.kind === "memory" && t.ws === ws,
      () => ({ id: tabId(), kind: "memory", ws, category: cat ?? "all", focus: item, focusAt, query }),
      (t) => (t.kind === "memory" ? memoryAgain(t, { category: cat, focus: item, query }, focusAt) : t),
    );
  };
  /**
   * What the bots do on their own (autopilot.tsx): the workspace's one Routines tab, switched to the
   * section asked for, at the row asked for and showing only the bot asked for (from its profile), or opened.
   * `bot` null is every bot's (the sidebar: the whole workspace); left out, the bot shown stays.
   */
  const openAutopilot = (section: AutopilotSection, item?: string, bot?: string | null) => {
    const ws = currentWorkspace(state);
    const focusAt = Date.now();
    openTab(
      (t) => t.kind === "autopilot" && t.ws === ws,
      () => ({ id: tabId(), kind: "autopilot", ws, section, focus: item, focusAt, bot: bot ?? undefined }),
      (t) => ({ ...t, section, focus: item, focusAt, bot: bot === undefined && t.kind === "autopilot" ? t.bot : (bot ?? undefined) }) as PanelTab,
    );
  };
  /** Skills (skills.tsx), in Knowledge: the Knowledge tab on the one asked for ("skill:<slug>"). */
  const openSkills = (item?: string) => openMemory({ category: "skills", focus: item });
  const openMac = () => openTab((t) => t.kind === "mac", () => ({ id: MAC_TAB, kind: "mac" }));
  /** An app a bot made, in its tab (one per app), and every app as tiles (one tab per workspace). */
  const openMadeApp = (appId: string) => {
    if (ownApps) openTab((t) => t.kind === "made-app" && t.appId === appId, () => ({ id: tabId(), kind: "made-app", appId }));
  };
  const openApps = () => {
    if (!apps) return;
    const ws = currentWorkspace(state);
    openTab((t) => t.kind === "made-apps" && t.ws === ws, () => ({ id: tabId(), kind: "made-apps", ws }));
  };
  /** An app on the web (hosted-apps.tsx), from the Apps page's list, by its Ingot repo's name: one tab per app. */
  const openHostedApp = (ws: string, name: string) => {
    if (apps) openTab((t) => t.kind === "hosted-app" && t.ws === ws && t.name === name, () => ({ id: tabId(), kind: "hosted-app", ws, name }));
  };
  // An app starting to build from this chat comes up beside it, built live there (unless a computer is
  // full width). Not on the first look at the chat: only a build that starts while you're here.
  const lastBuild = state.messages.findLast((m) => m.chatId === chat.id && m.madeApp);
  if (shownBuild !== (lastBuild?.id ?? "")) {
    setShownBuild(lastBuild?.id ?? "");
    const building = lastBuild?.madeApp && state.madeApps?.find((a) => a.id === lastBuild.madeApp!.appId)?.building;
    if (shownBuild !== undefined && lastBuild?.madeApp && building && !focus && ownApps) {
      // As openMadeApp does (rendering can't make a new id: the tab is named for the app).
      const appId = lastBuild.madeApp.appId;
      const there = openTabs.find((t) => t.kind === "made-app" && t.appId === appId);
      if (!there) setTabs([...openTabs, { id: `tab_app_${appId}`, kind: "made-app", appId }]);
      setActive(there?.id ?? `tab_app_${appId}`);
      setPanelOpen(true);
    }
  }
  // The app beside the chat, which what the user says is about (made-apps.tsx LookingAt).
  const lookingAt = panelOpen && tab?.kind === "made-app" ? state.madeApps?.find((a) => a.id === tab.appId) : undefined;
  // eslint-disable-next-line react-hooks/refs -- kept current for the storage listener above
  openMacRef.current = openMac;
  const openWeb = (url: string, title?: string) => openTab((t) => t.kind === "web" && t.url === url, () => ({ id: tabId(), kind: "web", url, title }));
  /** A bot's computer in the panel, at screen `screen` when one is named (Local on its screen is 99). */
  const openBotComputer = (id: string, screen?: number) => (screen === undefined ? openComputer(id) : showScreen(id, screen));
  /**
   * Open preview (Your Apps, the app's tab, the chat's header, a localhost link): the chat goes to the app's bot,
   * its Local is started when it isn't, and it shows in the panel at its own localhost:<port>, this Mac forwarding
   * that same port to its computer (one app per port: another app's preview on it closes); in a plain browser, in a tab of
   * the browser's own. When this Mac can't reach its computer (or that port of the Mac is in use), it opens on
   * its bot's screen instead, which the panel shows.
   */
  const openPreview = async (ws: string, name: string, site?: string, botId?: string): Promise<PreviewOpened> => {
    const h = state.workspaces?.find((w) => w.id === ws)?.hostedApps?.[name];
    // (A bot's copy of it: that bot's chat, and its copy's Local.)
    const copy = copyBotOf(state, ws, name, botId);
    const who = copy ?? h?.botId;
    if (who) openChat(botChatId(who));
    const at = `/api/hosted-apps/${encodeURIComponent(name)}/local`;
    const r = await post(at, { ws, action: "preview", start: true, ...(site ? { site } : {}), ...(copy ? { bot: copy } : {}) }).catch(() => null);
    const j = ((await r?.json().catch(() => null)) ?? {}) as { preview?: string; fallback?: string; error?: string };
    if (r?.ok && j.preview) {
      const url = j.preview;
      if (!electron()) {
        window.open(url, "_blank", "noopener");
        return {};
      }
      // One app a Mac port: another app's preview on the same address closes.
      const keep = tabsNow.current.filter((t) => !(t.kind === "preview" && t.url === url && !(t.ws === ws && t.name === name)));
      const open = keep.find((t): t is Extract<PanelTab, { kind: "preview" }> => t.kind === "preview" && t.ws === ws && t.name === name && (t.site ?? "") === (site ?? "") && (t.bot ?? "") === (copy ?? ""));
      const t: PanelTab = open ? { ...open, url } : { id: tabId(), kind: "preview", ws, name, ...(site ? { site } : {}), ...(copy ? { bot: copy } : {}), url };
      setTabs(open ? keep.map((x) => (x === open ? t : x)) : [...keep, t]);
      setActive(t.id);
      setPanelOpen(true);
      setFocus(false);
      return {};
    }
    if (j.fallback === "screen" && h?.botId) {
      // (On the screen it opened on: its bot's task's on the app, else a free one.)
      const o = await post(at, { ws, action: "open", ...(site ? { site } : {}), ...(copy ? { bot: copy } : {}) }).catch(() => null);
      const on = ((await o?.json().catch(() => null)) ?? {}) as { display?: number };
      showScreen(copy ?? h.botId, on.display ?? 99);
      return { screen: true, said: j.error };
    }
    return { error: j.error ?? "Couldn't reach its computer. Try again." };
  };
  /** A bot's localhost link in its chat: the preview of an app it works on (its copy's, when it has one), or its screen when it works on none. */
  const openBotLocal = (id: string) => {
    for (const w of state.workspaces ?? [])
      for (const name of Object.keys(w.hostedApps ?? {}))
        if (appCoders(state, w.id, name).includes(id)) return void openPreview(w.id, name, undefined, id);
    openComputer(id);
  };
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
    forgetTab(id);
    // An app's preview closed: this Mac's port for it closes too.
    if (gone?.kind === "preview") void post(`/api/hosted-apps/${encodeURIComponent(gone.name)}/local`, { ws: gone.ws, action: "unpreview", ...(gone.site ? { site: gone.site } : {}), ...(gone.bot ? { bot: gone.bot } : {}) }).catch(() => null);
    setRecent(recent.filter((r) => r !== id));
    if (active === id) leave(id, rest, rest[i - 1]?.id ?? rest[i]?.id ?? CHAT_TAB);
  };
  /** A page-like tab's own X (and Esc) closes it. */
  const leaveTab = closeTab;
  // eslint-disable-next-line react-hooks/refs -- kept current for the key listener above
  settingsOpen.current = !!settings;
  // Esc leaves a tab that reads as a page (the Vault, a bot's profile) for where you were, once nothing
  // nearer wants it: a sheet, a thread or a dialog (the app picker, an image) closes first, something
  // inside that used it (a form) says so with preventDefault, and Esc while typing elsewhere (the chat,
  // a search) stays there.
  // eslint-disable-next-line react-hooks/refs -- kept current for the key listener above
  escTab.current = (e) => {
    // Under a bot's settings page, the tab on the right stays as it is.
    if (botPage) return;
    const page = panelOpen && !focus && (tab?.kind === "vault" || tab?.kind === "bot" || tab?.kind === "crm" || tab?.kind === "memory" || tab?.kind === "autopilot") ? tab : undefined;
    if (!page || e.defaultPrevented || thread || composing || settings || document.querySelector('[role="dialog"]')) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && !panelRef.current?.contains(el)) return;
    leaveTab(page.id);
  };
  /**
   * A bot's settings page open: the Settings page over it (its Plan and credit, its Org chart) goes back first, through
   * the branch before this one, and the page stays; else Esc goes back to the chat, once nothing nearer wanted it (the
   * page's own Esc, inside it, does that too). Gone bot, gone page.
   */
  // eslint-disable-next-line react-hooks/refs -- kept current for the key listener above
  pageEsc.current = (e) => {
    if (!botPage || settings) return false;
    if (!e.defaultPrevented && !document.querySelector('[role="dialog"]')) closePage();
    return true;
  };
  // Only a bot of the workspace open, and never in one shared with the user (another one opened, or the bot deleted, closes it).
  const pageBot = botPage && !state.shared ? team.find((b) => b.id === botPage.botId) : undefined;
  if (botPage && !pageBot) setBotPage(null);
  /** Leave the page, then go where a link of its goes. */
  const away =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      setBotPage(null);
      fn(...a);
    };
  /**
   * Go somewhere from the sidebar, or from a link on the Settings page: the pages in the main area (Settings, a bot's
   * settings page) give way to it. Nothing goes while Settings is held (a domain being bought: its answer would be lost).
   */
  const leavePages =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      if (settings && settingsHeld.current) return;
      setSettings(false);
      setBotPage(null);
      fn(...a);
    };
  const pickTab = (id: string) => {
    setActive(id);
    setFocus(false);
    setPanelOpen(true);
  };

  /**
   * Show a watched thing: its Mac window in Your Mac, the bot's screen it's on, or (a web page, which has
   * no screen) its row on the Routines page. Seeing it clears its news.
   */
  const showWatch = (w: Watch) => {
    if (w.page) openAutopilot("monitors", w.id);
    else if (w.mac) openMac();
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
    // A shared workspace's news is its owner's to be shown (as its chime is: never the viewer's to be interrupted by).
    if (state.shared) return;
    const key = (w: Watch) => `${w.id}:${w.alert?.at}`;
    // Only news Jev judged worth interrupting for (older alerts have no level: they interrupt too), on a
    // screen or a Mac window: a web page has no screen to cut to (its chime and sidebar mark say it).
    const alerting = (state.watches ?? []).filter(
      (w) => w.alert && (w.alert.level ?? "now") === "now" && (isScreenWatch(w) || !!w.mac) && team.some((b) => b.id === w.botId),
    );
    if (cutAlerts === null) return setCutAlerts(new Set(alerting.map(key)));
    const fresh = alerting.find((w) => !cutAlerts.has(key(w)));
    if (!fresh || document.hidden || focus || tab?.kind === "web" || tab?.kind === "vault" || tab?.kind === "crm" || tab?.kind === "memory" || tab?.kind === "autopilot") return;
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
    setPrefill(null);
    setNewThreadFor(null);
    setThreadId(null);
    setComposing(false);
    setFocus(false);
    setActive(CHAT_TAB);
  };
  /**
   * Ask a bot something (an example on Routines, or Ask <name>): its chat, with `text` in the message box
   * to change and send, never sent by itself, and the box focused.
   */
  const askBot = (botId: string, text?: string) => {
    const id = botChatId(botId);
    openChat(id);
    if (state.chats.some((c) => c.id === id)) setPrefill({ chatId: id, text: text ?? "", at: Date.now() });
  };
  /** The task Add app started (hosted-apps.tsx): its thread once the window has it, else its bot's chat, where its chip is. */
  const openAppTask = (a: { chatId: string; sessionId: string }) => {
    const s = state.sessions.find((x) => x.id === a.sessionId);
    if (s) openThread(s);
    else openChat(a.chatId);
  };
  const openThread = (s: Session) => {
    const inView = s.chatId === chat.id || chat.botIds.includes(s.botId);
    if (!inView) setChatId(state.chats.some((c) => c.id === s.chatId) ? s.chatId : botChatId(s.botId));
    setComposing(false);
    setFocus(false);
    setThreadId(s.id);
    // A thread on your Mac shows your Mac; one in the cloud, the bot's computer, on its screen. The owner's
    // thread on their Mac, in a workspace shared with the user, is never shown as the viewer's own Mac (opensMacTab).
    if (opensMacTab(state, s)) {
      const mac = openTabs.find((t) => t.kind === "mac");
      if (!mac) setTabs([...openTabs, { id: MAC_TAB, kind: "mac" }]);
      setActive(mac?.id ?? MAC_TAB);
    } else setActive(CHAT_TAB);
    const screen = s.display ?? s.lastDisplay;
    // A finished thread's screen is shown only while no other task has it: else the panel would show that
    // task's work as this one's (its sheet shows where it left off instead: its last frame).
    const elsewhere = !live(s) && screen !== undefined && screenMap(state, s.botId).some((x) => x.display === screen && !!x.sessionId && x.sessionId !== s.id && x.kind !== "free");
    if (screen !== undefined && !elsewhere) {
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
        lookingAt={lookingAt}
        onOpenThread={openThread}
        onShowBot={(id) => openProfile(id)}
        onShowMac={openMac}
        onShowScreen={showScreen}
        onUpgrade={() => {
          trackEvent("bops_upgrade_clicked", { surface: "chat" });
          openSettings("plan");
        }}
        peek={!panelOpen && <ComputerPeek state={state} bot={bot} onOpen={() => setPanelOpen(true)} />}
        call={call}
        onCall={setCall}
        callSlot={setCallSlot}
        prefill={prefill}
        onPrefilled={() => setPrefill(null)}
      />
      {/* New task from a bot's menu, for a bot with more than one agent: over the message box of its chat, the chat still in view. */}
      {newThreadFor && !thread && state.bots.some((x) => x.id === newThreadFor) && (
        <div className="absolute inset-x-0 bottom-0 z-30 px-3 pb-3">
          <NewThread state={state} bot={state.bots.find((x) => x.id === newThreadFor)!} onClose={() => setNewThreadFor(null)} onStarted={(s) => (setNewThreadFor(null), openThread(s))} onSetUp={() => (setNewThreadFor(null), openProfile(newThreadFor))} />
        </div>
      )}
      {thread && (
        <ThreadSheet
          state={state}
          session={thread}
          onClose={() => setThreadId(null)}
          onShowComputer={() => {
            setPanelOpen(true);
            setActive(CHAT_TAB);
          }}
          onShowScreen={showScreen}
        />
      )}
    </div>
  );

  const callBot = call ? state.bots.find((b) => b.id === call) : undefined;
  const callHere = !!callBot && !composing && !focus && !!callSlot && chat.kind === "bot" && chat.botIds[0] === callBot.id;
  // The sidebar collapsed to its rail, the chat (and panel) take the rest; the title bar's corner over the
  // rail still clears the window's buttons. The title bar's columns are the same, sliding together.
  const wide = focus || !panelOpen;
  // A page in the main area (Settings, a bot's settings page): it covers the columns past the sidebar, as wide as the
  // sidebar is now (its rail, or itself), sliding with it.
  const covered = !!settings || !!pageBot;
  const sidebarWidth = sidebarOpen ? 340 : 72;
  // The chat's column, when the panel is beside it, as wide as its edge was dragged (chat-edge.tsx).
  const columns = { gridTemplateColumns: gridColumns(sidebarWidth, wide ? null : chatWidth) };
  const slide = edgeDragged ? "" : SLIDE;
  // What a bot's right-click menu does, in the sidebar and on its rail (bot-menu.tsx).
  const botMenuActions: BotMenuActions = {
    onChat: (id) => openChat(botChatId(id)),
    onCall: (id) => {
      openChat(botChatId(id));
      setCall(id);
    },
    onComputer: openComputer,
    onProfile: (id, section) => openProfile(id, section),
    // A bot that runs more than one agent: its chat with New thread over the message box, to pick which. Else its chat, with the composer
    // focused for the task (once the chat is on screen).
    onNewTask: (id) => {
      const nb = state.bots.find((x) => x.id === id);
      if (nb && !state.shared && readyAgents(nb, state).length > 1) {
        setComposing(false);
        openChat(botChatId(id));
        return setNewThreadFor(id);
      }
      openChat(botChatId(id));
      setTimeout(() => document.getElementById("composer")?.focus(), 60);
    },
  };
  // The same from the sidebar while a page is open in the main area: the page gives way first.
  const pageMenuActions: BotMenuActions = {
    onChat: leavePages(botMenuActions.onChat),
    onCall: leavePages(botMenuActions.onCall),
    onComputer: leavePages(botMenuActions.onComputer),
    onProfile: leavePages(botMenuActions.onProfile),
    onNewTask: leavePages(botMenuActions.onNewTask),
  };
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

  // What the bots are doing, for every mascot's mood: a running thread (writing, or not), a reply, a call
  // (whether the bot on it is talking, each of its mascots reads from CallTalking), a thanks, and what
  // they're doing on the user's other devices (state.liveMoods).
  return (
    <BotMoodsFrom state={state} call={call ? { botId: call, speaking: false } : null}>
    <CallTalking.Provider value={callTalking}>
    <OpenLink.Provider value={openWeb}>
    <OpenCrm.Provider value={openCrm}>
    <OpenMadeApp.Provider value={openMadeApp}>
    <OpenHostedApp.Provider value={openHostedApp}>
    <OpenSettings.Provider value={(at) => openSettings(at)}>
    <OpenAppTask.Provider value={openAppTask}>
    <OpenBotComputer.Provider value={openBotComputer}>
    <OpenPreview.Provider value={openPreview}>
    <OpenBotLocal.Provider value={openBotLocal}>
    <ComposerBridgeProvider value={composerBridge}>
      <TooltipLayer />
      {/* A shared workspace's chats aren't the user's own: nothing of them is said as what they're looking at. */}
      <ViewReporter chatId={state.shared ? "" : chat.id} threadId={state.shared ? null : (thread?.id ?? null)} />
      <div className="flex h-screen flex-col overflow-clip bg-white font-sans text-ink antialiased">
        <TitleBar
          bare={!!pageBot || !!settings}
          columns={columns}
          slide={slide}
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
        {/*
          The pages in the main area (Settings, a bot's settings page) draw over the grid's columns past the sidebar, which
          stay as they were underneath (the chat, its draft, a live computer); the sidebar stays beside them, to go anywhere.
        */}
        <div className="relative flex min-h-0 flex-1 flex-col">
        <div className={`grid min-h-0 flex-1 ${slide}`} style={columns}>
          {/* The sidebar's column, its color and edge whichever it shows (an inset edge, so the sidebar's 340px fit). */}
          <div className={`flex min-h-0 min-w-0 bg-[#F9F9F8] shadow-[inset_-1px_0_0_#ECECEA] ${sliding ? "overflow-clip" : ""}`}>
          {!sidebarOpen ? (
            <SidebarRail
              state={state}
              chatId={chat.id}
              footer={openPage}
              menuActions={pageMenuActions}
              onExpand={() => toggleSidebar()}
              onSearch={() => toggleSidebar("search")}
              onWorkspaces={() => toggleSidebar("workspaces")}
              onCompose={leavePages(() => setComposing(true))}
              onOpenChat={leavePages(openChat)}
              onAccount={() => openSettings("plan")}
              onSettings={() => openSettings()}
              onSetup={() => openSettings("mac")}
              onTeam={() => openSettings("team")}
              onVault={() => openVault()}
              onOpenAutopilot={leavePages(({ section, focus: item }: AutopilotOpen) => openAutopilot(section, item, null))}
              onOpenMemory={leavePages(openMemory)}
              onApps={leavePages(openApps)}
            />
          ) : (
          <Sidebar
            state={state}
            chatId={chat.id}
            search={openWith === "search" ? "" : null}
            workspaces={openWith === "workspaces"}
            onCollapse={() => toggleSidebar()}
            onOpenChat={leavePages(openChat)}
            onOpenThread={leavePages(openThread)}
            onCompose={leavePages(() => setComposing(true))}
            onSettings={() => openSettings()}
            onAccount={() => openSettings("plan")}
            onSetup={() => openSettings("mac")}
            onVault={() => openVault()}
            onApps={leavePages(openApps)}
            onTeam={() => openSettings("team")}
            onTeamChart={() => openSettings("chart")}
            onOpenWatch={leavePages(showWatch)}
            onOpenMemory={leavePages(openMemory)}
            onOpenAutopilot={leavePages(({ section, focus: item }: AutopilotOpen) => openAutopilot(section, item, null))}
            footer={footer}
            menuActions={pageMenuActions}
          />
          )}
          </div>
          {/* Under a page in the main area, what's here keeps going but can't be reached (contents: the grid's columns stay its own). */}
          <div className="contents" inert={covered}>
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
          ) : focus && macFocus && !state.shared ? (
            <div className="flex min-h-0 min-w-0 flex-col bg-white">
              <MacComputer state={state} mode="focus" showThread={thread?.runsOn === "mac" ? thread.id : undefined} onBack={() => setFocus(false)} onOpenThread={openThread} />
            </div>
          ) : focus ? (
            <div className="flex min-h-0 min-w-0 flex-col bg-white">
              <ComputerView
                state={state}
                bot={bot}
                display={display}
                forThread={cameFor[bot.id]}
                // Picking a screen only shows it: taking control is its own button, never a side effect of looking.
                onDisplay={setDisplay}
                onShowScreen={showScreen}
                mode="focus"
                onBack={() => setFocus(false)}
              />
            </div>
          ) : (
            <>
              {chatColumn}
              {panelOpen && (
                <section ref={panelRef} className="relative flex min-h-0 min-w-0 flex-col bg-white">
                  <ChatEdge from={sidebarWidth} width={chatWidth} onWidth={setChatWidth} onDragging={setEdgeDragged} />
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
                  {/* An app's preview stays loaded too, so its page and sign in are there when you come back. */}
                  {tabs.map((t) => {
                    if (t.kind !== "preview") return null;
                    const h = state.workspaces?.find((w) => w.id === t.ws)?.hostedApps?.[t.name];
                    // A bot's copy's: that bot. Else its site's bot (the one whose Works on is it, with no copy of its own), else the app's own: Fix it, Select and Draw ask there.
                    const siteBot = siteBotOf(state, t.ws, t.name, t.site ?? t.name);
                    const ownBot = t.bot ?? (siteBot && !copyBotOf(state, t.ws, t.name, siteBot.id) ? siteBot.id : h?.botId);
                    const appBot = h && !h.lost ? state.bots.find((b) => b.id === ownBot) : undefined;
                    const appChat = appBot && state.chats.some((c) => c.id === botChatId(appBot.id)) ? botChatId(appBot.id) : undefined;
                    return (
                      <PreviewTab
                        key={t.id}
                        ws={t.ws}
                        name={t.name}
                        site={t.site}
                        url={t.url}
                        user={state.account?.user.id}
                        hidden={t.id !== active}
                        stamp={taskStamp(state, t.ws, t.name)}
                        apps={appsStamp(state, t.ws)}
                        bot={appBot && appChat ? { name: appBot.name, chatId: appChat } : undefined}
                        copy={t.bot}
                        own={!state.shared}
                        // (Local on its screen was 99 before the server said which.)
                        onScreen={(display) => h?.botId && showScreen(t.bot ?? h.botId, display ?? 99)}
                      />
                    );
                  })}
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
                      onOpenVault={() => openVault()}
                      onOpenComputer={openComputer}
                      onOpenKeys={(keysFor) => openVault(keysFor)}
                      onShowScreen={showScreen}
                      onOpenAutopilot={openAutopilot}
                      onOpenSkills={openSkills}
                      onAsk={askBot}
                      onUpgrade={() => {
                        trackEvent("bops_upgrade_clicked", { surface: "bot_panel" });
                        openSettings("plan");
                      }}
                      onClose={() => leaveTab(tab.id)}
                      onOpenChart={(botId) => openSettings("chart", { chartBot: botId })}
                      onExpand={(at) => openBotPage(bot.id, at)}
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
                      onVault={() => {
                        closeTab(tab.id);
                        openVault();
                      }}
                      // The workspace's one Apps tab: this new tab gives way to it (or becomes it). None where apps aren't open.
                      onApps={
                        apps
                          ? () => {
                              const ws = currentWorkspace(state);
                              const there = tabs.find((t) => t.kind === "made-apps" && t.ws === ws);
                              if (there) {
                                closeTab(tab.id);
                                setActive(there.id);
                              } else setTabs(tabs.map((t) => (t.id === tab.id ? { id: t.id, kind: "made-apps", ws } : t)));
                            }
                          : undefined
                      }
                      // The workspace's one Knowledge tab: this new tab gives way to it (or becomes it).
                      onKnowledge={
                        categoriesOpen(state)
                          ? () => {
                              const ws = currentWorkspace(state);
                              const there = tabs.find((t) => t.kind === "memory" && t.ws === ws);
                              if (there) {
                                closeTab(tab.id);
                                setActive(there.id);
                              } else setTabs(tabs.map((t) => (t.id === tab.id ? { id: t.id, kind: "memory", ws, category: "all" } : t)));
                            }
                          : undefined
                      }
                      onMac={() => setTabs(tabs.map((t) => (t.id === tab.id ? { id: t.id, kind: "mac" } : t)))}
                    />
                  ) : tab?.kind === "vault" ? (
                    <LoginsPage state={state} keysFor={tab.keysFor} onOpenWatch={showWatch} onClose={() => leaveTab(tab.id)} />
                  ) : tab?.kind === "made-app" ? (
                    <MadeAppTab key={tab.id} state={state} appId={tab.appId} />
                  ) : tab?.kind === "made-apps" ? (
                    <MadeAppsHome state={state} ws={tab.ws} />
                  ) : tab?.kind === "hosted-app" ? (
                    <HostedAppTab key={tab.id} state={state} ws={tab.ws} name={tab.name} onAsk={askBot} />
                  ) : tab?.kind === "crm" ? (
                    // These two pages fade in from here (the others in their own files). The key is on the
                    // wrapper, so the page remounts exactly when it did before.
                    <div key={`${tab.id}:${tab.file}`} className="motion-fade-in flex min-h-0 flex-1 flex-col">
                      <CrmView
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
                    </div>
                  ) : tab?.kind === "memory" ? (
                    <div key={tab.id} className="motion-fade-in flex min-h-0 flex-1 flex-col">
                      <MemoryView
                        state={state}
                        user={state.account?.user.id}
                        ws={tab.ws}
                        category={tab.category}
                        focus={tab.focus}
                        focusAt={tab.focusAt}
                        query={tab.query}
                        last={state.messages[state.messages.length - 1]?.id}
                        tags={tagsOf(state.workspaces?.find((w) => w.id === tab.ws)).map((t) => t.name)}
                        // The search asked for is used once: off the tab, so coming back doesn't fill it in again.
                        onQueryUsed={() => setTabs((all) => all.map((t) => (t.id === tab.id && t.kind === "memory" ? { ...t, query: undefined } : t)))}
                        onCategory={(category) => setTabs((all) => all.map((t) => (t.id === tab.id && t.kind === "memory" ? { ...t, category, focus: undefined } : t)))}
                        onClose={() => leaveTab(tab.id)}
                      />
                    </div>
                  ) : tab?.kind === "autopilot" ? (
                    <div key={tab.id} className="motion-fade-in flex min-h-0 flex-1 flex-col">
                      <AutopilotPage
                        state={state}
                        focus={tab.focus}
                        focusAt={tab.focusAt}
                        bot={tab.bot}
                        onBot={(bot) => setTabs((all) => all.map((t) => (t.id === tab.id && t.kind === "autopilot" ? { ...t, bot } : t)))}
                        onOpenWatch={showWatch}
                        onOpenSkills={() => openSkills()}
                        onAsk={askBot}
                        onOpenThread={openThread}
                        onClose={() => leaveTab(tab.id)}
                      />
                    </div>
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
                        forThread={cameFor[heldBot.id]}
                        onDisplay={setDisplay}
                        follow={showingComputer ? follow : undefined}
                        mode="panel"
                        onFocus={clickIn}
                        onShowScreen={showScreen}
                        hidden={!showingComputer}
                      />
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          </div>
        </div>
        {pageBot && botPage && (
          <div className={`absolute inset-y-0 right-0 z-30 bg-white ${PAGE_SLIDE}`} style={{ left: sidebarWidth }} inert={!!settings}>
            <BotSettingsPage
              key={`${pageBot.id}:${botPage.atAt}`}
              state={state}
              bot={pageBot}
              at={botPage.at}
              onBack={closePage}
              onCollapse={(at) => {
                closePage();
                openProfile(pageBot.id, at === "skills" || at === "routines" || at === "memory" ? at : "details");
              }}
              links={{
                onOpenChat: away(openChat),
                onOpenThread: away(openThread),
                onOpenVault: away(() => openVault()),
                onOpenComputer: away(openComputer),
                onOpenKeys: away((keysFor: string) => openVault(keysFor)),
                onShowScreen: away(showScreen),
                onOpenAutopilot: away(openAutopilot),
                onOpenSkills: away(openSkills),
                onAsk: away(askBot),
                onUpgrade: () => {
                  trackEvent("bops_upgrade_clicked", { surface: "bot_panel" });
                  openSettings("plan");
                },
                onOpenChart: (botId) => openSettings("chart", { chartBot: botId }),
              }}
            />
          </div>
        )}
        {settings && (
          // Over a bot's settings page when it opened from there (its Plan and credit, its Org chart): Back goes back to it.
          <div className={`absolute inset-y-0 right-0 z-30 flex bg-white ${PAGE_SLIDE}`} style={{ left: sidebarWidth }}>
            {/* What opens from it goes where it goes, and the page gives way (an app's tab, a page on the web). */}
            <OpenLink.Provider value={leavePages(openWeb)}>
            <OpenCrm.Provider value={leavePages(openCrm)}>
            <OpenMadeApp.Provider value={leavePages(openMadeApp)}>
            <OpenHostedApp.Provider value={leavePages(openHostedApp)}>
            <OpenAppTask.Provider value={leavePages(openAppTask)}>
              <Settings
                state={state}
                at={settings.at}
                atAt={settings.atAt}
                keysFor={settings.keysFor}
                chartBot={settings.chartBot}
                onPane={(at) => setSettings((x) => (x && x.at !== at ? { ...x, at } : x))}
                onOpenWatch={leavePages(showWatch)}
                onOpenBot={(botId) => {
                  setSettings(false);
                  openBotPage(botId);
                }}
                onMakeBot={leavePages(() => setComposing(true))}
                onOpenApp={leavePages(openHostedApp)}
                onClose={() => setSettings(false)}
                onHold={holdSettings}
                onShowScreen={leavePages(showScreen)}
                onOpenVault={() => openVault()}
              />
            </OpenAppTask.Provider>
            </OpenHostedApp.Provider>
            </OpenMadeApp.Provider>
            </OpenCrm.Provider>
            </OpenLink.Provider>
          </div>
        )}
        </div>
        {callBot && (
          // One call bar for the whole app, never remounted while the call lasts: it only moves.
          <div
            className="fixed z-40"
            // Compact, it waits in the sidebar's corner over its footer; by the rail, just past it, so the rail's buttons stay clear.
            style={callHere && slotBox ? { left: slotBox.x, top: slotBox.y, transform: "translateX(-50%)" } : { left: sidebarOpen ? 12 : 84, bottom: 76 }}
          >
            <CallBar bot={callBot} owner={state.owner?.name} compact={!(callHere && slotBox)} onOpen={() => openChat(botChatId(callBot.id))} onClose={() => setCall(null)} onSpeaking={callTalking.set} />
          </div>
        )}
        {/* What bots are doing on the user's Mac, live, in the corner (hidden while the Your Mac tab is open). */}
        {!(tab?.kind === "mac" && panelOpen) && !state.shared && <MacPreviews state={state} onOpen={openMac} />}
      </div>
    </ComposerBridgeProvider>
    </OpenBotLocal.Provider>
    </OpenPreview.Provider>
    </OpenBotComputer.Provider>
    </OpenAppTask.Provider>
    </OpenSettings.Provider>
    </OpenHostedApp.Provider>
    </OpenMadeApp.Provider>
    </OpenCrm.Provider>
    </OpenLink.Provider>
    </CallTalking.Provider>
    </BotMoodsFrom>
  );
}

/** Where this Mac remembers whether the sidebar is shown ("0": hidden). */
const SIDEBAR_KEY = "bops.sidebar";
/** How long the sidebar takes to collapse to its rail or expand (none with reduced motion). */
const SIDEBAR_SLIDE_MS = 200;
/** The grid's columns slide as the sidebar's width changes, the title bar's with them. */
const SLIDE = "transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none";
/** A page in the main area slides with them: its left edge is the sidebar's. */
const PAGE_SLIDE = "transition-[left] duration-200 ease-out motion-reduce:transition-none";

/* ---------------- Title bar ---------------- */

/** The window's title bar: traffic lights (in the desktop app), the right side's tabs above it, and the panel toggle. */
function TitleBar({
  bare,
  columns,
  slide,
  wide,
  tabs,
  panelOpen,
  onTogglePanel,
}: {
  /** A bot's settings page over the window: the drag region and room for the window's buttons only (tabs would change what's under it). */
  bare?: boolean;
  columns: React.CSSProperties;
  slide: string;
  wide: boolean;
  tabs: React.ReactNode;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const desktop = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
  return (
    <div className={`grid h-11 shrink-0 border-b border-[#ECECEA] bg-[#F7F7F6] [-webkit-app-region:drag] ${slide}`} style={columns}>
      <div className="flex items-center gap-3 px-3.5">
        {/* Room for the window's buttons (the sidebar's toggle is in its header, or at the top of its rail). */}
        {desktop && <div className="w-[56px] shrink-0" />}
      </div>
      {bare ? null : (
        <>
      {!wide && <div />}
      <div className="flex min-w-0 items-center gap-2 pl-3 pr-3.5">
        {tabs || <div className="flex-1" />}
        <button
          onClick={onTogglePanel}
          title={panelOpen ? "Hide the side panel" : "Show the side panel"}
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg [-webkit-app-region:no-drag] ${panelOpen ? "bg-[#EEEEEC]" : "shadow-[0_0_0_1px_#E2E2DF]"}`}
        >
          <SideToggleIcon side="right" open={panelOpen} />
        </button>
      </div>
        </>
      )}
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
          {info.texting === "none" ? " (carriers approve business texting first (A2P 10DLC), about 7 to 10 business days)" : ""}
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
            <span className="font-mono text-[12px] text-[#3A3A38]">{!state.shared && state.host === "mac" ? "this Mac" : b.computerId ? `${b.computerId}${b.tailnet ? ` · ${b.tailnet.ip}` : ""}` : sharesComputer(b) ? `shares ${workBot(b, state.bots).name}'s` : "none yet"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Where your bots work: their own cloud computers (the default), or this Mac. One switch for every workspace. */
function WhereBotsWork({ state }: { state: AppState }) {
  const setHost = (host: Host) => void post("/api/host", { host });
  return (
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
  );
}

/** Settings' places: Account (yours, in every workspace), then Workspace (the one open now), then Orgo's team's own. */
export type SettingsPane = "profile" | "plan" | "usage" | "reach" | "ai" | "privacy" | "mac" | "general" | "team" | "chart" | "bots" | "logins" | "email" | "apps" | "domains";

/** A place in Settings' nav: its name, its glyph, and a quiet value on the right. */
type NavItem = { id: SettingsPane; name: string; icon: React.ReactNode; value?: string | number };

const glyph = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const GLYPHS: Record<SettingsPane, string> = {
  profile: "M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8zM3 13.5c.7-2.4 2.6-3.6 5-3.6s4.3 1.2 5 3.6",
  plan: "M2 4.5h12v7H2zM2 7h12M4.5 9.5h2",
  usage: "M3 13V9M6.3 13V6M9.6 13V8M13 13V3.5",
  reach: "M5 2h6v12H5zM7.3 12h1.4",
  ai: "M8 2l1.3 3.4L13 6.7l-3.7 1.3L8 11.5 6.7 8 3 6.7l3.7-1.3z",
  privacy: "M8 2l5 1.9v3.9c0 3.1-2.1 5.6-5 6.6-2.9-1-5-3.5-5-6.6V3.9z",
  mac: "M2.5 3.5h11v7.5h-11zM1.5 13h13",
  general: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1",
  team: "M6 7.6a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6zM1.8 13.2c.6-2.3 2.2-3.5 4.2-3.5s3.6 1.2 4.2 3.5M10.4 3.5a2.4 2.4 0 0 1 0 4.4M12 9.9c1.2.4 2 1.5 2.3 3.3",
  chart: "M6.5 2.5h3v2.5h-3zM2 11h3v2.5H2zM11 11h3v2.5h-3zM8 5v3M3.5 11V8h9v3",
  bots: "M3.5 6h9v6.5h-9zM8 6V3.5M6 9h.01M10 9h.01M2 8.5v2M14 8.5v2",
  logins: "M5.5 10.5a3 3 0 1 1 2.1-.9L13.5 3.7M11 6.2l1.5 1.5M9.3 7.9l1.3 1.3",
  email: "M2 3.5h12v9H2zM2 4l6 4.5L14 4",
  apps: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  domains: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6",
};

/** A pane's title and what it's for, above what it holds. */
function PaneHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-[22px] pt-6">
      <span className="text-[22px] font-bold leading-7 tracking-[-0.02em]">{title}</span>
      {sub && <span className="text-[13px] leading-[19px] text-[#6B6B6B]">{sub}</span>}
    </div>
  );
}

/** Workspace, General: its name, renamed here as in the sidebar's workspace menu (Orgo's workspace too). */
function WorkspaceGeneral({ state }: { state: AppState }) {
  const ws = currentWorkspace(state);
  const w = state.workspaces?.find((x) => x.id === ws);
  const [naming, setNaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = state.shared ? state.shared.name : (w?.name ?? "This workspace");
  const save = async () => {
    const next = naming?.trim();
    if (!next || !w) return;
    const res = await post("/api/workspaces", { id: w.id, name: next }, "PATCH").catch(() => null);
    const j = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string };
    if (res?.ok) {
      setNaming(null);
      setError(null);
    } else setError(j.error ?? "Couldn't reach Bops. Try again.");
  };
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
      <span className="text-[13px] font-semibold">Name</span>
      <div className="flex items-center gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        {naming !== null ? (
          <div className="min-w-0 flex-1">
            <NameInput value={naming} onChange={setNaming} onSave={() => void save()} onCancel={() => setNaming(null)} />
          </div>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{name}</span>
            {!state.shared && w && (
              <button onClick={() => setNaming(w.name)} className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
                Rename
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
      <span className="text-[12px] leading-4 text-[#9A9A98]">{state.shared ? `Shared with you by ${state.shared.owner || "its owner"}.` : "Make another workspace, or delete this one, from the workspace menu in the sidebar."}</span>
    </div>
  );
}

/** Workspace, Bots: its bots, each opening its own settings page. */
function WorkspaceBots({ state, onOpenBot }: { state: AppState; onOpenBot?: (botId: string) => void }) {
  const team = teamOf(state);
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
      <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
        {team.map((b) => (
          <div key={b.id} className="flex items-center gap-3 border-b border-[#F0F0EE] px-3.5 py-2.5 last:border-0">
            <Mascot botId={b.id} color={b.color} size={26} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13.5px] font-medium leading-[18px]">{b.name}</span>
              <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{b.role}</span>
            </span>
            {onOpenBot && (
              <button onClick={() => onOpenBot(b.id)} className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
                Open settings
              </button>
            )}
          </div>
        ))}
        {!team.length && <span className="px-3.5 py-3 text-[12.5px] text-[#6B6B6B]">No bots here yet.</span>}
      </div>
    </div>
  );
}

/** Workspace, Email and phone: its bots' address (Pick or Change) and the number its main bot is texted and called at. */
function WorkspaceReach({ state }: { state: AppState }) {
  const ws = currentWorkspace(state);
  const w = state.workspaces?.find((x) => x.id === ws);
  const main = state.bots.find((b) => b.isMain && workspaceOf(b) === ws);
  const has = !!(w?.mailClaimed || w?.mailPick);
  return (
    <>
      <EmailAddresses state={state} only={ws} />
      <div className="flex flex-col gap-2 px-[22px] pt-4">
        <span className="text-[13px] font-semibold">Phone</span>
        <div className="rounded-[14px] px-3.5 py-3 text-[13px] shadow-[0_0_0_1px_#E6E6E3]">
          {w?.line?.phone ? (
            <span>
              Text or call {main?.name ?? "its main bot"} at <span className="font-mono text-[12.5px]">{w.line.phone}</span>
            </span>
          ) : (
            <span className="text-[#6B6B6B]">No number yet. A workspace gets one to text and call its main bot.</span>
          )}
        </div>
      </div>
      {!has && <span className="block px-[22px] pt-3 text-[12px] text-[#9A9A98]">Its bots get an address when they first need one.</span>}
    </>
  );
}

/**
 * Settings, a page in the main area beside the app's own sidebar, with its places on the left: Account (yours, in every
 * workspace: Profile, Plan and credit, Usage, How bots reach you, AI plans, Privacy, This Mac), then Workspace, the one
 * open now, picked at the group's heading (General, Team, Org chart, Bots, Logins, Email and phone), then Orgo's team's
 * own (Your Apps, Domains). Every place is a section of the page, Team, the Org chart and Your Apps too.
 * `at`: the place it opens at (Logins from the footer, Team from your initials, Domains from an app's All domains), gone
 * to again on each opening (`atAt`); `onPane` hears each place picked here. `chartBot`: the bot the Org chart opens at.
 * Back (its heading), Esc and the sidebar leave it (`onClose`; the app's own Esc). `onShowScreen`: a brain's sign in
 * started on a bot's screen, so Settings gives way and that screen shows; `onOpenVault`: to add a key there (brains.tsx);
 * `onOpenApp`: an app named there opened in its tab; `onMakeBot`: the Org chart's new bot. `onHold`: whether Settings
 * must stay now (a domain being bought: its answer would be lost), for the app's own Esc. Exported for the tests.
 */
export function Settings({
  state,
  onClose,
  onShowScreen,
  onOpenVault,
  at,
  atAt,
  keysFor,
  chartBot,
  onPane,
  onOpenApp = () => {},
  onHold,
  onOpenBot,
  onMakeBot,
  onOpenWatch = () => {},
}: {
  state: AppState;
  onClose: () => void;
  onShowScreen: (botId: string, display: number) => void;
  onOpenVault: () => void;
  at?: SettingsPane;
  /** When it was asked for at `at`: each asking goes there again. */
  atAt?: number;
  /** A bot's profile asked to add a key for it (Logins). */
  keysFor?: string;
  /** The bot whose card the Org chart opens at (from its profile). */
  chartBot?: string;
  onPane?: (at: SettingsPane) => void;
  onOpenApp?: (ws: string, name: string) => void;
  onHold?: (held: boolean) => void;
  onOpenBot?: (botId: string) => void;
  onMakeBot?: () => void;
  onOpenWatch?: (w: Watch) => void;
}) {
  const selfHosted = useSelfHosted();
  // The workspace's domains (bought through Orgo): only where apps are shown (an @orgo.ai account, its own workspace).
  const domains = appsOwnShown(state);
  const apps = appsShown(state);
  const fits = (p?: SettingsPane) => !!p && (p !== "domains" || domains) && (p !== "apps" || apps) && (!state.shared || (p !== "team" && p !== "chart" && p !== "email"));
  const [pane, setPane] = useState<SettingsPane>(fits(at) ? at! : "profile");
  const [was, setWas] = useState(`${at}:${atAt}`);
  if (was !== `${at}:${atAt}`) {
    setWas(`${at}:${atAt}`);
    if (fits(at)) setPane(at!);
  }
  const go = (p: SettingsPane) => {
    setPane(p);
    onPane?.(p);
  };
  // A domain being bought: nothing leaves Settings (Back, Esc, the sidebar, an app opened from it) until it's answered.
  const [buying, setBuying] = useState(false);
  useEffect(() => {
    onHold?.(buying);
    return () => onHold?.(false);
  }, [buying, onHold]);
  const close = () => {
    if (!buying) onClose();
  };
  const ws = currentWorkspace(state);
  const shared = !!state.shared;
  const team = teamOf(state);
  const own = state.workspaces ?? [];
  const wsName = shared ? (state.shared?.name ?? "") : (own.find((w) => w.id === ws)?.name ?? "Main");
  const people = shared ? 0 : Object.keys(own.find((w) => w.id === ws)?.memberAccess ?? {}).length;
  const logins = shared ? 0 : (state.accounts ?? []).filter((a) => accountIn(state, a).includes(ws)).length + (state.vault ?? []).filter((l) => siteLoginIn(state, l).includes(ws)).length;
  const user = state.account?.user;
  const who = user?.name?.trim() || state.owner?.name.trim() || user?.email?.split("@")[0] || "You";
  const item = (id: SettingsPane, name: string, more: Partial<NavItem> = {}): NavItem => ({ id, name, icon: glyph(GLYPHS[id]), ...more });
  const account: NavItem[] = [
    item("profile", "Profile"),
    item("plan", "Plan and credit"),
    item("usage", "Usage"),
    item("reach", "How bots reach you"),
    ...(BRAINS_ON ? [item("ai", "AI plans")] : []),
    ...(!selfHosted ? [item("privacy", "Privacy")] : []),
    item("mac", "This Mac"),
  ];
  const workspace: NavItem[] = [
    item("general", "General"),
    ...(!shared ? [item("team", "Team", { value: people || undefined })] : []),
    ...(!shared ? [item("chart", "Org chart")] : []),
    item("bots", "Bots", { value: team.length || undefined }),
    item("logins", "Logins", { value: logins || undefined }),
    ...(!shared ? [item("email", "Email and phone")] : []),
  ];
  const team_: NavItem[] = [...(apps ? [item("apps", appsName(state))] : []), ...(domains ? [item("domains", "Domains")] : [])];
  const navRow = (x: NavItem) => (
    <button
      key={x.id}
      data-settings-nav={x.id}
      onClick={() => go(x.id)}
      aria-current={pane === x.id ? "page" : undefined}
      className={`flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${pane === x.id ? "bg-[#EFEFEC] font-semibold text-ink" : "text-[#3A3A38] hover:bg-[#F2F2F0]"}`}
    >
      {x.icon}
      <span className="min-w-0 flex-1 truncate">{x.name}</span>
      {x.value !== undefined && <span className="shrink-0 text-[11.5px] font-normal tabular-nums text-[#8A8A88]">{x.value}</span>}
    </button>
  );
  const group = (label: string, why: string | null, items: NavItem[], heading?: React.ReactNode) => (
    <div className="flex flex-col gap-px pt-4">
      <span className="px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[#8A8A88]">{label}</span>
      {heading}
      {why && <span className="px-2.5 pb-1 text-[11px] leading-4 text-[#A3A3A0]">{why}</span>}
      {items.map(navRow)}
    </div>
  );
  const switcher = (
    <div className="mx-0.5 my-1.5 flex items-center gap-2 rounded-[10px] bg-white px-2 py-1.5 shadow-[0_0_0_1px_#E8E8E5,0_1px_2px_#00000008]">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-[#1F5F4A] text-[11px] font-semibold uppercase text-white">{wsName[0] ?? "W"}</span>
      {shared || own.length < 2 ? (
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{wsName}</span>
      ) : (
        <select
          aria-label="Workspace"
          value={ws}
          onChange={(e) => void post("/api/workspaces", { current: e.target.value }, "PATCH")}
          className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-[13px] font-semibold outline-none"
        >
          {own.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      {!shared && own.length > 1 && (
        <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden className="shrink-0 text-[#9A9A98]">
          <path d="M2.5 4.5L5 2l2.5 2.5M2.5 7.5L5 10l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (pane === "profile")
    body = (
      <>
        <PaneHead title="Profile" sub="Who your bots work for, in every workspace." />
        <OwnerSettings owner={state.owner} />
      </>
    );
  else if (pane === "plan")
    body = (
      <>
        <PaneHead title="Plan and credit" sub="Your Bops plan and AI credit, and the inboxes and numbers it pays for." />
        <PlanAndCredit state={state} />
      </>
    );
  else if (pane === "usage")
    body = (
      <>
        <PaneHead title="Usage" sub="What your bots used, in every workspace." />
        <UsageSection />
      </>
    );
  else if (pane === "reach")
    body = (
      <>
        <PaneHead title="How bots reach you" sub="Your numbers and emails: how your bots know it's you." />
        <ReachSettings />
      </>
    );
  else if (pane === "ai" && BRAINS_ON)
    body = (
      <>
        <PaneHead title="AI plans" sub="Your own AI plans and agent sign ins, for your bots' work." />
        <BrainSettings state={state} onShowScreen={onShowScreen} onOpenVault={onOpenVault} />
      </>
    );
  else if (pane === "privacy")
    body = (
      <>
        <PaneHead title="Privacy" sub="What Bops keeps, for how long, and what it shares." />
        {!selfHosted && <UsageData />}
        {/* Where the user's things are kept and for how long: their own, never a shared workspace's owner's. */}
        {!selfHosted && !shared && <YourData />}
      </>
    );
  else if (pane === "mac")
    body = (
      <>
        <PaneHead title="This Mac" sub="Permissions here, where your bots work, and their computers." />
        <ThisMacSettings state={state} />
        <WhereBotsWork state={state} />
        {/* Bots in browsers on this Mac have no computer to run routines on; a self-hosted Bops has no Bops Cloud for a runner to share the state through. */}
        {!selfHosted && state.host !== "mac" && <RunsOnSettings state={state} />}
        {/* (A shared workspace's computers are its owner's: nothing asks this Mac's Orgo about their keys.) */}
        <BotComputers state={state} padded={!selfHosted} askKeys={!selfHosted && !state.shared} />
        {selfHosted && <SelfHosting state={state} />}
      </>
    );
  else if (pane === "general")
    body = (
      <>
        <PaneHead title="General" sub={shared ? `${wsName}, shared with you.` : `${wsName}, shared with the people you add.`} />
        <WorkspaceGeneral state={state} />
      </>
    );
  else if (pane === "team" && !shared)
    body = <Members state={state} onUpgrade={() => go("plan")} onTeamChart={() => go("chart")} />;
  else if (pane === "chart" && !shared)
    body = <TeamChart key={`${chartBot ?? ""}:${atAt ?? ""}`} state={state} focus={chartBot} onMakeBot={onMakeBot} onOpenPeople={() => go("team")} />;
  else if (pane === "apps" && apps) body = <MadeAppsHome state={state} ws={ws} />;
  else if (pane === "bots")
    body = (
      <>
        <PaneHead title="Bots" sub={`${wsName}'s bots. Each has a settings page of its own.`} />
        <WorkspaceBots state={state} onOpenBot={shared ? undefined : onOpenBot} />
      </>
    );
  else if (pane === "logins") body = <LoginsPage state={state} keysFor={keysFor} onOpenWatch={onOpenWatch} onOpenBot={onOpenBot} />;
  else if (pane === "email")
    body = (
      <>
        <PaneHead title="Email and phone" sub={`How people reach ${wsName}'s bots.`} />
        <WorkspaceReach state={state} />
      </>
    );
  else if (pane === "domains" && domains)
    body = (
      <>
        <PaneHead title="Domains" />
        <WorkspaceDomains state={state} ws={ws} onOpenApp={(w, name) => !buying && onOpenApp(w, name)} onBuying={setBuying} />
      </>
    );
  else body = <PaneHead title="Settings" />;

  // The places with a frame of their own (Logins, the Org chart, Your Apps) scroll inside it; the rest scroll here.
  const framed = pane === "logins" || pane === "chart" || pane === "apps";
  return (
    <div data-settings className="motion-fade-in flex min-h-0 min-w-0 flex-1">
      <nav aria-label="Settings" className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-[#E8E8E5] bg-[#FBFBFA] px-3 pb-4 pt-4">
        <button onClick={close} disabled={buying} aria-label="Back" title="Back (Esc)" data-settings-back className="flex items-center gap-2 self-start rounded-lg px-2 py-1 text-[14px] font-semibold hover:bg-[#F2F2F0] disabled:opacity-40">
          <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden>
            <path d="M6 1.5L1.5 6 6 10.5" fill="none" stroke="#8A8A88" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Settings
        </button>
        <div className="flex items-center gap-2.5 px-2 pb-1 pt-3">
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-ink text-[12.5px] font-semibold tracking-[0.02em] text-white">{initialsOf(state)}</span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] font-semibold leading-[18px]">{who}</span>
            <span className="truncate text-[11.5px] leading-4 text-[#8A8A88]">{user?.email ?? "Not signed in"}</span>
          </span>
        </div>
        {group("Account", "Yours, in every workspace", account)}
        {group("Workspace", shared ? "Shared with you" : "Shared with its people", workspace, switcher)}
        {team_.length > 0 && group("Orgo team only", null, team_)}
      </nav>
      <main data-settings-pane={pane} className={`flex min-h-0 min-w-0 flex-1 flex-col ${framed ? "" : "overflow-y-auto pb-8"}`}>
        {body}
      </main>
    </div>
  );
}

/**
 * The app's first load. One that takes far longer than usual (a server that won't answer this window,
 * the Keychain or Bops Cloud stuck) says so and offers a restart, rather than bopping on forever.
 */
function FirstLoad() {
  const [slow, setSlow] = useState(false);
  const canRestart = useCanRestart();
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <BoppyLoading label="Loading Bops…">
      {slow && (
        <div className="flex flex-col items-center gap-3">
          <span>This is taking longer than usual.</span>
          {canRestart && (
            <div className="flex w-[300px] justify-center">
              <RestartButton className="flex items-center gap-1.5 rounded-full bg-[#F2F2F0] px-3.5 py-1.5 text-[13px] font-medium leading-4 text-ink hover:bg-[#EAEAE7]">
                <RestartIcon />
                Restart Bops
              </RestartButton>
            </div>
          )}
        </div>
      )}
    </BoppyLoading>
  );
}

/**
 * Tells the server what's in front of you (lib/server/presence.ts): the chat and thread open, and
 * whether this window is focused. A task you're looking at runs its steps fast; one you've left runs
 * at standard speed. Said when it changes, and every 5 seconds so the server knows it's still true.
 */
function ViewReporter({ chatId, threadId }: { chatId: string; threadId: string | null }) {
  const sent = useRef("");
  useEffect(() => {
    const say = (again = false) => {
      const body = JSON.stringify({ chatId, threadId, focused: document.hasFocus() && document.visibilityState === "visible" });
      if (!again && body === sent.current) return;
      sent.current = body;
      void fetch("/api/view", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    };
    say();
    const changed = () => say();
    const beat = setInterval(() => say(true), 5000);
    window.addEventListener("focus", changed);
    window.addEventListener("blur", changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
      clearInterval(beat);
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", changed);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [chatId, threadId]);
  return null;
}

/** The newest ended task on an app (its id and how it ended): its preview reloads once when this changes. */
const taskStamp = (state: AppState, ws: string, name: string) => {
  const s = state.sessions.findLast((x) => x.app?.wsId === ws && x.app.name === name && !live(x));
  return s ? `${s.id}:${s.status}` : "";
};
