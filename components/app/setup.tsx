"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
import { useMacApp } from "./mac-screens";
import { RestartConfirm, useCanRestart } from "./restart";
import { post } from "./ui";

/*
 * Everything Bops needs on this Mac, in one place (Setup). It never stands in the way: signing in goes
 * straight to the app, and the account menu (sidebar.tsx) shows a badge while something here still
 * needs the user and they haven't skipped it, and opens this as a sheet. Settings → This Mac has the
 * same cards.
 *
 * - Screen recording, the microphone and notifications are this app's own macOS permissions, asked
 *   through the Mac app (desktop/main.cjs, window.bopsMac.permissions). In a browser they can't be.
 * - Routing through this Mac: bots' computers reach the internet through this Mac (app/api/relay).
 *   It's on by default wherever Orgo offers it, so the card shows it on; turning it off sticks.
 *
 * When something's off, the setup screen also offers Restart Bops (restart.tsx), under its buttons.
 *
 * - Full access (Settings → This Mac only, never Setup): bots' tasks on this Mac run outside Bops'
 *   sandbox, with a shell, the user's files and apps (MacState.fullAccess). Off until the user turns it on.
 *
 * The user's mobile isn't asked for here: it becomes theirs when they call or text their bot's number
 * (the bot's profile and Settings say how), or with a texted code in Settings (owner-phone.tsx).
 */

export type PermId = "screen" | "microphone" | "notifications" | "accessibility" | "fullDisk" | "automation";
export type PermStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

type ScriptedApp = { id: string; name: string; status: PermStatus };
type Permissions = {
  status(): Promise<Record<PermId, PermStatus>>;
  request(id: PermId): Promise<PermStatus>;
  openSettings(id: PermId): Promise<void>;
  /** Full access's apps, each with its Automation answer (null until Bops can read them). Older Mac apps don't have it. */
  automationApps?(): Promise<ScriptedApp[] | null>;
};
type Bridge = { permissions?: Permissions; screenNeedsRestart?: () => Promise<boolean> };
const bridge = () => (window as unknown as { bopsMac?: Bridge }).bopsMac;

export type RelayInfo = { available: boolean; on: boolean; reason?: string; device?: { id: string; name: string }; running: boolean; online?: boolean; routedComputers: string[] };

/** The items on the setup screen, which it can record as skipped (app/api/setup keeps the same list). */
type Item = "screen" | "microphone" | "notifications" | "relay";
const ITEMS: Item[] = ["screen", "microphone", "notifications", "relay"];

/** The OS permissions setup asks for. Accessibility isn't one: Bops itself never drives other apps. */
const ASKED: PermId[] = ["microphone", "notifications", "screen"];

/** Runs `fn` now, every few seconds, and whenever the window comes back (from System Settings, say). */
function useWhileOpen(fn: () => void, every = 3000) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const run = () => ref.current();
    const onVisible = () => document.visibilityState === "visible" && run();
    run();
    const t = setInterval(run, every);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [every]);
}

/** This Mac's permissions for Bops, read live, and whether Screen Recording waits on a restart. */
function usePermissions(every: number) {
  const inApp = useMacApp();
  const [status, setStatus] = useState<Partial<Record<PermId, PermStatus>> | null>(null);
  const [restart, setRestart] = useState(false);
  const refresh = useCallback(async () => {
    const b = bridge();
    if (!b?.permissions) return;
    try {
      setStatus(await b.permissions.status());
      setRestart(!!(await b.screenNeedsRestart?.()));
    } catch {
      /* the next look tries again */
    }
  }, []);
  useWhileOpen(() => void refresh(), every);
  return { inApp: inApp && !!bridge()?.permissions, status, restart, refresh };
}

/** Routing through this Mac (GET/POST /api/relay). A server without the route reads as not available. */
function useRelay(every: number) {
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = async (res: Response) => {
    const j = (await res.json().catch(() => ({}))) as Partial<RelayInfo> & { error?: string };
    if (res.status === 404) return { available: false, on: false, running: false, routedComputers: [] } satisfies RelayInfo;
    if (!res.ok && j.available === undefined) throw new Error(j.error || j.reason || "Couldn't reach routing on this Mac.");
    return { available: !!j.available, on: !!j.on, reason: j.reason, device: j.device, running: !!j.running, online: j.online, routedComputers: j.routedComputers ?? [] } satisfies RelayInfo;
  };
  const load = useCallback(async () => {
    try {
      setInfo(await read(await fetch("/api/relay", { cache: "no-store" })));
    } catch {
      setInfo((was) => was ?? { available: false, on: false, running: false, routedComputers: [] });
    }
  }, []);
  useWhileOpen(() => void (!busy && load()), every);
  const turn = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
      const j = (await res.clone().json().catch(() => ({}))) as { error?: string };
      if (!res.ok && j.error) setError(j.error);
      setInfo(await read(res));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return { info, busy, error, turn };
}

/** Everything the cards need, shared by the setup screen, Settings and the account menu's badge (`slow`: it looks less often). */
function useSetupItems(state: AppState, slow = false) {
  const perms = usePermissions(slow ? 15_000 : 3000);
  const relay = useRelay(slow ? 30_000 : 5000);
  // Grants made in System Settings show up through the polling; this is what was opened there.
  const [sentToSettings, setSent] = useState<Set<PermId>>(new Set());
  const [asking, setAsking] = useState<PermId | null>(null);
  const ask = async (id: PermId) => {
    const p = bridge()?.permissions;
    if (!p) return;
    setAsking(id);
    try {
      const now = await p.request(id);
      // macOS answers Screen Recording in System Settings (its prompt offers to open it), and a grant
      // there only applies after a restart: offer one from here on.
      if (id === "screen" && now !== "granted") setSent((s) => new Set(s).add("screen"));
    } finally {
      setAsking(null);
      await perms.refresh();
    }
  };
  const openSettings = async (id: PermId) => {
    setSent((s) => new Set(s).add(id));
    await bridge()?.permissions?.openSettings(id);
  };
  const done = (item: Item) => (item === "relay" ? !!relay.info?.on || !!state.relay?.on : perms.status?.[item] === "granted");
  // What the user can do something about here: a permission in the Mac app (once read), routing where Orgo offers it.
  const offered = (item: Item) => (item === "relay" ? !!relay.info?.available : perms.inApp && !!perms.status?.[item]);
  /** What still needs the user: what the setup screen's Continue records as skipped, and what the badge counts. */
  const waiting = ITEMS.filter((i) => !done(i) && offered(i));
  return { state, perms, relay, ask, asking, openSettings, sentToSettings, done, waiting };
}
type Items = ReturnType<typeof useSetupItems>;

/* ---------------- The cards ---------------- */

type Tone = "ok" | "todo" | "off" | "none";
const DOT: Record<Tone, string> = { ok: "bg-[#2BB673]", todo: "bg-[#E59A0B]", off: "bg-[#C9C9C6]", none: "bg-[#C9C9C6]" };
const pill = "shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
const dark = `${pill} bg-ink text-white`;
const light = `${pill} bg-[#F2F2F0] hover:bg-[#EAEAE7]`;

/** One thing to set up: what it is, where it stands, its buttons (`children`), and anything that goes under it (`below`, lined up with the title). */
function Card({
  icon,
  title,
  chip,
  line,
  tone,
  status,
  children,
  below,
}: {
  icon: React.ReactNode;
  title: string;
  chip?: string;
  line: string;
  tone: Tone;
  status: string;
  children?: React.ReactNode;
  below?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-[14px] bg-white p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
      <div className="flex items-center gap-3">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-[11px] ${tone === "ok" ? "bg-ink text-highlighter" : "bg-[#F2F2F0] text-ink"}`}>{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-[13.5px] font-semibold leading-[18px]">{title}</span>
            {chip && <span className="rounded-full bg-[#F2F2F0] px-2 py-px text-[11px] font-medium leading-4 text-[#3A3A38]">{chip}</span>}
          </span>
          <span className="text-[12px] leading-4 text-pencil">{line}</span>
          <span className="flex items-center gap-1.5 pt-0.5 text-[12px] leading-4 text-[#3A3A38]">
            <span className={`size-[7px] shrink-0 rounded-full ${DOT[tone]}`} />
            {status}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      </div>
      {below && <div className="pl-12 pt-3">{below}</div>}
    </div>
  );
}

const ICONS = {
  screen: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" strokeLinecap="round" />
      <circle cx="8" cy="7" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  microphone: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0010 0M8 12.5v2" />
    </svg>
  ),
  notifications: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M4 11.5V7a4 4 0 018 0v4.5l1 1.2H3z" />
      <path d="M6.6 14.2a1.5 1.5 0 002.8 0" strokeLinecap="round" />
    </svg>
  ),
  fullAccess: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="7" width="11" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 015.8-1.1" />
    </svg>
  ),
  relay: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.6 3.8 2.6 6.2S9.8 12.5 8 14.2C6.2 12.5 5.4 10.4 5.4 8S6.2 3.5 8 1.8z" />
    </svg>
  ),
};

const COPY: Record<"screen" | "microphone" | "notifications", { title: string; line: string }> = {
  screen: { title: "Screen recording", line: "See your Mac live in Bops, and watch bots work on it." },
  microphone: { title: "Microphone", line: "Talk to your bots on a call." },
  notifications: { title: "Notifications", line: "Hear from bots when something needs you." },
};

function PermissionCard({ id, items }: { id: "screen" | "microphone" | "notifications"; items: Items }) {
  const { perms, ask, asking, openSettings, sentToSettings } = items;
  const [restarting, setRestarting] = useState(false);
  const s = perms.status?.[id];
  const copy = COPY[id];
  if (!perms.inApp)
    return <Card icon={ICONS[id]} title={copy.title} line={copy.line} tone="none" status="Needs the Bops app for Mac" />;
  if (!s) return <Card icon={ICONS[id]} title={copy.title} line={copy.line} tone="none" status="Checking" />;
  // Screen Recording turned on while Bops was open: macOS applies it on the next launch.
  const restart = id === "screen" && (perms.restart || (s !== "granted" && sentToSettings.has("screen")));
  const status =
    s === "granted"
      ? id === "screen" && perms.restart
        ? "Allowed. Restart Bops to use it"
        : "Allowed"
      : s === "restricted"
        ? id === "notifications"
          ? "Not available on this Mac"
          : "Blocked by your Mac's settings or admin"
        : s === "denied"
          ? restart
            ? "Turn on Bops in System Settings, then restart Bops"
            : "Off. Turn it on in System Settings"
          : id === "notifications" && s === "unknown"
            ? "Asked. Check System Settings if none showed"
            : "Not asked yet";
  const tone: Tone = s === "granted" && !(id === "screen" && perms.restart) ? "ok" : s === "not-determined" || s === "unknown" ? "off" : "todo";
  return (
    <Card icon={ICONS[id]} title={copy.title} line={copy.line} tone={tone} status={status}>
      {restart && (
        <button onClick={() => setRestarting(true)} className={s === "granted" ? dark : light}>
          Restart Bops
        </button>
      )}
      {restarting && <RestartConfirm onClose={() => setRestarting(false)} />}
      {s === "not-determined" || (id === "notifications" && s === "unknown") ? (
        <button disabled={!!asking} onClick={() => void ask(id)} className={dark}>
          {asking === id ? <Spinner size={11} color="#FFFFFF" /> : "Allow"}
        </button>
      ) : s === "denied" || (s === "unknown" && id !== "notifications") ? (
        <button onClick={() => void openSettings(id)} className={restart ? light : dark}>
          Open System Settings
        </button>
      ) : null}
    </Card>
  );
}

function RelayCard({ items }: { items: Items }) {
  const { info, busy, error, turn } = items.relay;
  const line = "Your bots' computers go online through this Mac, so websites see your home internet.";
  if (!info) return <Card icon={ICONS.relay} title="Route through this Mac" line={line} tone="none" status="Checking" />;
  if (!info.available) return <Card icon={ICONS.relay} title="Route through this Mac" line={line} tone="none" status={info.reason ? `Not available yet. ${info.reason}` : "Not available yet"} />;
  const n = info.routedComputers.length;
  // On by default: the relay may still be starting (or reconnecting) while it's on.
  const connecting = !info.running || info.online === false;
  const status = error
    ? error
    : info.on
      ? `On${info.device ? ` as ${info.device.name}` : ""}${connecting ? ", connecting" : ""}. ${n ? `${n} computer${n === 1 ? "" : "s"} routed` : "No computers routed yet"}`
      : "Off. Bots' computers use Orgo's connection";
  return (
    <Card icon={ICONS.relay} title="Route through this Mac" line={line} tone={error ? "todo" : info.on ? (connecting ? "todo" : "ok") : "off"} status={status}>
      <button disabled={busy} onClick={() => void turn(!info.on)} className={info.on ? light : dark}>
        {busy ? <Spinner size={11} color={info.on ? "#0A0A0A" : "#FFFFFF"} /> : info.on ? "Turn off" : "Turn on"}
      </button>
    </Card>
  );
}

function Cards({ items }: { items: Items }) {
  return (
    <div className="flex flex-col gap-2">
      <PermissionCard id="screen" items={items} />
      <PermissionCard id="microphone" items={items} />
      <PermissionCard id="notifications" items={items} />
      <RelayCard items={items} />
    </div>
  );
}

/** Ask macOS for each permission still unasked, one after another (the microphone and notifications first: their prompts stay in Bops). */
async function allowAll(items: Items) {
  for (const id of ASKED) {
    const s = items.perms.status?.[id];
    if (s === "not-determined" || (id === "notifications" && s === "unknown")) await items.ask(id);
  }
}

/* ---------------- The setup screen ---------------- */

/**
 * The setup screen, as a sheet over the app (from the account menu and its badge): everything in one
 * place, each item skippable. Continue records what still waits on the user as skipped, which puts the
 * badge away for those.
 */
export function Setup({ state, onClose }: { state: AppState; onClose: () => void }) {
  const items = useSetupItems(state);
  const [busy, setBusy] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const canRestart = useCanRestart();
  const [restart, setRestart] = useState(false);
  const askable = items.perms.inApp && ASKED.some((id) => items.perms.status?.[id] === "not-determined" || (id === "notifications" && items.perms.status?.[id] === "unknown"));
  const finish = async () => {
    setBusy(true);
    await post("/api/setup", { skipped: items.waiting }).catch(() => undefined);
    setBusy(false);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-[560px] animate-[call-in_220ms_ease-out] flex-col overflow-y-auto rounded-[22px] bg-white px-7 pb-6 pt-8 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <div className="flex flex-col items-center gap-1.5 pb-5 text-center">
          <Mascot botId="boppy" color="#0A0A0A" size={48} />
          <span className="pt-3 text-[20px] font-semibold leading-6 tracking-[-0.01em]">Set up Bops on this Mac</span>
          <span className="max-w-[380px] text-[13.5px] leading-[19px] text-pencil">
            {items.perms.inApp
              ? "A few things your bots need. Allow what you want now; you can change any of it later in Settings."
              : "Screen, microphone and notifications need the Bops app for Mac. You can set up the rest here."}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] leading-4 text-pencil">This Mac</span>
          <Cards items={items} />
        </div>
        <div className="flex flex-col gap-2 pt-5">
          {askable && (
            <button
              disabled={allowing}
              onClick={() => {
                setAllowing(true);
                void allowAll(items).finally(() => setAllowing(false));
              }}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-[13.5px] font-medium text-white disabled:opacity-50"
            >
              {allowing && <Spinner size={13} color="#FFFFFF" />}
              {allowing ? "Asking your Mac" : "Allow all"}
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => void finish()}
            className={
              askable
                ? "flex h-10 w-full items-center justify-center rounded-full text-[13.5px] font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB] disabled:opacity-50"
                : "flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-[13.5px] font-medium text-white disabled:opacity-50"
            }
          >
            {items.waiting.length ? "Continue" : "Done"}
          </button>
          {!!items.waiting.length && <span className="text-center text-[12px] leading-4 text-pencil">Anything you skip stays in Settings.</span>}
          {canRestart && (
            <span className="text-center text-[12px] leading-4 text-pencil">
              Something not working?{" "}
              <button onClick={() => setRestart(true)} className="underline underline-offset-2 hover:text-ink">
                Restart Bops
              </button>
            </span>
          )}
        </div>
        {restart && <RestartConfirm onClose={() => setRestart(false)} />}
      </div>
    </div>
  );
}

/**
 * Whether something on the setup screen still needs the user and they haven't skipped it there: the
 * account menu's badge (sidebar.tsx). The same items and the same "done" as the screen's own.
 */
export function useSetupNeedsYou(state: AppState) {
  const items = useSetupItems(state, true);
  const skipped = new Set(state.setup?.skipped ?? []);
  return items.waiting.some((i) => !skipped.has(i));
}

/* ---------------- In Settings ---------------- */

/** Settings → This Mac: the same cards, to come back to any time. */
export function ThisMacSettings({ state }: { state: AppState }) {
  const items = useSetupItems(state);
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold">This Mac</span>
        {items.perms.inApp && ASKED.some((id) => items.perms.status?.[id] === "not-determined") && (
          <button onClick={() => void allowAll(items)} className={light}>
            Allow all
          </button>
        )}
      </div>
      <Cards items={items} />
      <FullAccessCard items={items} />
    </div>
  );
}

/**
 * What Full access needs from macOS, asked for here up front rather than mid-task: Full Disk Access
 * (files in protected places, and Messages' history), which only System Settings can give, then
 * Automation for each app bots script, which Bops asks for all at once (desktop/main.cjs askAutomation:
 * apps it opens for that stay hidden).
 */
function FullAccessSetup({ items }: { items: Items }) {
  const [apps, setApps] = useState<ScriptedApp[] | null>(null);
  useWhileOpen(() => void bridge()?.permissions?.automationApps?.().then(setApps).catch(() => {}), 5000);
  const disk = items.perms.status?.fullDisk === "granted";
  const auto = items.perms.status?.automation;
  const asking = items.asking === "automation";
  const off = (apps ?? []).filter((a) => a.status === "denied").map((a) => a.name);
  const names = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? ""));
  const row = (done: boolean, title: string, text: string, button?: React.ReactNode) => (
    <div className="flex items-center gap-2.5">
      <span className={`size-[7px] shrink-0 rounded-full ${done ? DOT.ok : DOT.todo}`} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-medium leading-4">{title}</span>
        <span className="text-[12px] leading-4 text-pencil">{text}</span>
      </div>
      {button}
    </div>
  );
  return (
    <div className="flex flex-col gap-2.5">
      {row(
        disk,
        "Your files",
        disk ? "Bops has Full Disk Access." : "Give Bops Full Disk Access in System Settings, then come back.",
        !disk && (
          <button onClick={() => void items.openSettings("fullDisk")} className={dark}>
            Open Settings
          </button>
        ),
      )}
      {row(
        auto === "granted",
        "Your apps",
        auto === "granted"
          ? `Bots can use ${names((apps ?? []).map((a) => a.name)) || "your apps"}.`
          : asking
            ? "macOS asks once for each app: allow each one. Apps open hidden and close after."
            : off.length
              ? `Turned off for ${names(off)}. Turn them on under Automation in System Settings.`
              : "Allow the apps bots use (Messages, Notes, Mail and the rest) now, so macOS doesn't ask mid-task.",
        auto !== "granted" &&
          (off.length && !asking ? (
            <button onClick={() => void items.openSettings("automation")} className={light}>
              Open Settings
            </button>
          ) : (
            <button onClick={() => void items.ask("automation")} disabled={asking || !disk} title={disk ? undefined : "Full Disk Access first"} className={dark}>
              {asking ? "Asking…" : "Allow apps"}
            </button>
          )),
      )}
    </div>
  );
}

/** Full access for bots on this Mac (MacState.fullAccess): off by default, and only here, with what it means. */
function FullAccessCard({ items }: { items: Items }) {
  const on = !!items.state.mac?.fullAccess;
  const set = items.perms.status?.fullDisk === "granted" && items.perms.status?.automation === "granted";
  if (!items.state.mac?.ready && !on) return null;
  return (
    <Card
      icon={ICONS.fullAccess}
      title="Full access for bots"
      chip={on ? "On" : undefined}
      line="Bots' tasks on this Mac get a shell, your files and your apps, outside Bops' sandbox. Anything you could do here, they can."
      tone={on ? (set || !items.perms.inApp ? "ok" : "todo") : "off"}
      status={on ? (set || !items.perms.inApp ? "Bots can use your files and apps" : "Two steps left, so macOS never stops a bot mid-task") : "Off: bots on this Mac only browse, in a Chrome of their own"}
      below={on && items.perms.inApp ? <FullAccessSetup items={items} /> : undefined}
    >
      <button onClick={() => void post("/api/mac", { fullAccess: !on }, "PATCH")} className={on ? light : dark}>
        {on ? "Turn off" : "Turn on"}
      </button>
    </Card>
  );
}
