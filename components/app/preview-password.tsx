"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PASS_COOKIE, type PreviewPassword, type PreviewSite } from "@/lib/hosted-apps";
import { CopyLink } from "./hosted-apps";
import { useDismiss } from "./new-thread";
import { InlineConfirm, undash } from "./side-group";
import { post } from "./ui";

/*
 * A site's Preview password, the owner's, beside its link wherever Bops shows it: the Preview tab's bar (a lock by the
 * address, and Open in browser saying the browser asks for it), each site's Preview line in Your Apps, and its tab's
 * Preview section (Ask for a password, New password). Read from the server's window only route
 * (/api/hosted-apps/[name]/password), once per site, and again when the apps list says Bops set a newer one
 * (PreviewSite.passwordAt: a new one comes with each Preview deploy that goes live), so every place shows the same,
 * current one. Bops' own view of the Preview gets the cookie that opens it (desktop/preview-frames.cjs), set again
 * each time it changes. Copy copies it only when pressed.
 */

type Kept = { answer: PreviewPassword; acted?: true };
/** Each site's password as read or changed last, by "<ws>\n<app>\n<site>". */
const kept = new Map<string, Kept>();
const reading = new Map<string, Promise<PreviewPassword | null>>();
/** Sites whose last read failed (said so, never read again in a loop: the next change to its list reads it again). */
const missed = new Set<string>();
const heard = new Set<() => void>();
const listen = (f: () => void) => (heard.add(f), () => void heard.delete(f));
const tell = () => heard.forEach((f) => f());
const keep = (key: string, k: Kept) => {
  kept.set(key, k);
  missed.delete(key);
  tell();
};

const route = (name: string) => `/api/hosted-apps/${encodeURIComponent(name)}/password`;

/** Read a site's password (once at a time per site). Null when it couldn't be read. */
function read(ws: string, name: string, site: string | undefined, key: string): Promise<PreviewPassword | null> {
  const was = reading.get(key);
  if (was) return was;
  if (missed.delete(key)) tell();
  const p = (async () => {
    const r = await fetch(`${route(name)}?ws=${encodeURIComponent(ws)}${site ? `&site=${encodeURIComponent(site)}` : ""}`, { cache: "no-store" }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as PreviewPassword | null) : null;
    if (j && "on" in j) keep(key, { answer: j });
    else {
      missed.add(key);
      tell();
    }
    return j;
  })().finally(() => reading.delete(key));
  reading.set(key, p);
  return p;
}

/** What's kept is as new as the apps list says (its link, and a password Bops set no later than it). */
const fresh = (k: Kept | undefined, p: PreviewSite | null | undefined): k is Kept => !!k && !!p?.url && k.answer.url === p.url && (k.answer.at ?? 0) >= (p.passwordAt ?? 0);

/**
 * A site's Preview password (`p`: its Preview as the apps list says it): `can`, Orgo can put one on it (its switch
 * shows); `on`, it asks for one; the password and its cookie once read; `act` changes it ("new", "on", "off").
 */
export function usePreviewPassword(ws: string, name: string, site: string | undefined, p: PreviewSite | null | undefined) {
  const key = `${ws}\n${name}\n${site ?? name}`;
  const k = useSyncExternalStore(
    listen,
    () => kept.get(key),
    () => undefined,
  );
  const failed = useSyncExternalStore(
    listen,
    () => missed.has(key),
    () => false,
  );
  const ok = fresh(k, p);
  // (A link Orgo turned off asks nothing: it isn't served.)
  const can = !!p?.url && !p.off && typeof p.protected === "boolean";
  // (Just changed here: what the change answered, until the list catches up.)
  const on = can && (ok && k.acted ? k.answer.on === true : p?.protected === true);
  const want = on && !ok;
  // (Read when the list says one it doesn't have: its link, or a newer one. A failed read waits for the next change.)
  const stamp = `${p?.url ?? ""}\n${p?.passwordAt ?? ""}`;
  useEffect(() => {
    if (want) void read(ws, name, site, key);
  }, [want, ws, name, site, key, stamp]);
  const [busy, setBusy] = useState<"new" | "on" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "new" | "on" | "off") => {
    setBusy(action);
    setError(null);
    const r = await post(route(name), { ws, action, ...(site ? { site } : {}) }).catch(() => null);
    const j = ((await r?.json().catch(() => null)) ?? {}) as PreviewPassword & { error?: string };
    setBusy(null);
    if (!r?.ok || !("on" in j)) {
      setError(undash(j.error || "Couldn't change its password. Try again."));
      return false;
    }
    keep(key, { answer: j, acted: true });
    return true;
  };
  const now = ok ? k.answer : null;
  // What shows in its value's place: being read, couldn't be, or Orgo has none to show (only its cookie's check, or a key that can't read it).
  const waiting = !on || now?.password ? null : now ? (now.why ?? "Can't be shown. Make a new one.") : want && !failed ? "Reading…" : "Couldn't read it just now.";
  return { can, on, url: p?.url ?? null, password: on ? (now?.password ?? null) : null, cookie: on ? (now?.cookie ?? null) : null, waiting, busy, error, act };
}

/** The Mac app's call that puts a Preview's cookie in a preview's session (desktop/preload.cjs); none in a plain browser. */
const macSignIn = () =>
  (window as unknown as { bopsMac?: { previewSignIn?: (ask: { partition: string; url: string; name: string; value: string }) => Promise<boolean> } }).bopsMac?.previewSignIn;

/**
 * The Preview tab's password: the site's (usePreviewPassword), its cookie put in the tab's session as soon as it's read
 * and again whenever it changes (`onRenewed` then: the page loads again with it), `ready` to wait on before showing the
 * Preview, and which of the bar's popovers is open (the lock's, or Open in browser's).
 */
export function usePreviewTabPassword(ws: string, name: string, site: string | undefined, p: PreviewSite | null | undefined, partition: string, onRenewed: () => void) {
  const pass = usePreviewPassword(ws, name, site, p);
  const [popover, setPopover] = useState<"lock" | "browser" | null>(null);
  const signed = useRef<string | null>(null);
  const renewed = useRef(onRenewed);
  useEffect(() => {
    renewed.current = onRenewed;
  });
  /** Its cookie in the tab's session: once a value, a change after the first set loading the page again. */
  const signIn = async (url: string | null, c: PreviewPassword["cookie"]) => {
    const set = macSignIn();
    if (!set || !url || c?.name !== PASS_COOKIE || signed.current === c.value) return;
    const was = signed.current;
    if (!(await set({ partition, url, name: c.name, value: c.value }).catch(() => false))) return;
    signed.current = c.value;
    try {
      if (was) renewed.current();
    } catch {
      // (Its page not attached yet: it loads with the new cookie anyway.)
    }
  };
  const value = pass.cookie?.value;
  useEffect(() => {
    if (pass.on && value) void signIn(pass.url, pass.cookie);
    // (Only a new value, its link or its session sets it again.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pass.on, pass.url, value, partition]);
  /** Before the Preview shows: its cookie set, read first when it hasn't been. */
  const ready = async () => {
    if (!pass.on || !pass.url) return;
    const c = pass.cookie ?? (await read(ws, name, site, `${ws}\n${name}\n${site ?? name}`))?.cookie ?? null;
    await signIn(pass.url, c);
  };
  return { ...pass, popover, setPopover, ready };
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      <rect x="2.75" y="6.25" width="8.5" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.75 6.25V4.5a2.25 2.25 0 0 1 4.5 0v1.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A password in one line, with Copy (only when pressed), never cut short; or what's said meanwhile, cut short with all of it in its tooltip. */
function Value({ password, waiting }: { password: string | null; waiting: string | null }) {
  return password ? (
    <span className="flex shrink-0 items-center gap-0.5">
      <span data-preview-password className="select-all whitespace-nowrap font-mono text-[12px] leading-4 text-ink">
        {password}
      </span>
      <CopyLink url={password} label="Copy password" />
    </span>
  ) : (
    <span data-tip={waiting ?? undefined} className="min-w-0 truncate text-[12px] leading-4 text-[#9A9A98]">
      {waiting}
    </span>
  );
}

/**
 * The Preview tab bar's lock, by the address while its Preview is shown and asks for a password: pressed, the password
 * with Copy. Open in browser opens the same, saying the browser asks for it, with Open to go on.
 */
export function PreviewLock({ pass, at }: { pass: ReturnType<typeof usePreviewTabPassword>; at: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const open = pass.popover;
  const close = pass.setPopover;
  useDismiss(!!open, () => close(null), box);
  // (Another place shown, or its password off: shown again later, it starts closed.)
  useEffect(() => () => close(null), [close]);
  return (
    <span ref={box} className="relative flex shrink-0">
      <button
        data-preview-lock
        aria-label="Its password"
        data-tip={open ? undefined : "Asks for a password"}
        aria-expanded={!!open}
        onClick={() => pass.setPopover(open ? null : "lock")}
        className="flex size-7 items-center justify-center rounded-lg text-[#3A3A38] hover:bg-[#F2F2F0] aria-expanded:bg-[#F2F2F0]"
      >
        <LockIcon />
      </button>
      {open && (
        <span
          data-preview-pass-popover={open}
          role="dialog"
          aria-label="Its password"
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[240px] flex-col gap-1.5 rounded-[12px] bg-white p-3 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]"
        >
          <span className="text-[12px] leading-4 text-[#6B6B6B]">{open === "browser" ? "Your browser asks for this password." : "This preview asks for a password."}</span>
          <Value password={pass.password} waiting={pass.waiting} />
          {open === "browser" && (
            <button
              data-preview-pass-open
              onClick={() => {
                pass.setPopover(null);
                window.open(at, "_blank");
              }}
              className="self-start rounded-full bg-ink px-2.5 py-1 text-[12px] font-semibold leading-4 text-white"
            >
              Open in browser
            </button>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Beside a Preview link in Your Apps: "Password", its value and Copy, while it asks for one. One piece: the line it's on
 * wraps it under the link when they don't fit side by side (a password is never cut short; what's said meanwhile is).
 */
export function PasswordBeside({ ws, name, site, preview }: { ws: string; name: string; site?: string; preview?: PreviewSite | null }) {
  const pass = usePreviewPassword(ws, name, site, preview);
  if (!pass.on) return null;
  return <PasswordShown password={pass.password} waiting={pass.waiting} />;
}

/** "Password", its value and Copy, as beside a Preview link: the owner's (PasswordBeside), and a member's with Your Apps at Write (shared-apps.tsx). */
export function PasswordShown({ password, waiting = null }: { password: string | null; waiting?: string | null }) {
  return (
    <span data-password-beside className={`flex max-w-full items-center gap-1.5 ${password ? "shrink-0" : "min-w-0"}`} onClick={(e) => e.stopPropagation()}>
      <span className="shrink-0 text-[12px] leading-4 text-[#6B6B6B]">Password</span>
      <Value password={password} waiting={waiting} />
    </span>
  );
}

const HEAD = "pb-1 text-[12px] font-semibold leading-4 text-[#6B6B6B]";
const HINT = "text-[12px] leading-4 text-[#9A9A98]";

/**
 * A site's tab, Preview picked: its password, with Copy; Ask for a password (on by default: off, the link is open to
 * anyone who has it); and New password, asked once more in place.
 */
export function PasswordSection({ ws, name, site, preview }: { ws: string; name: string; site?: string; preview?: PreviewSite | null }) {
  const pass = usePreviewPassword(ws, name, site, preview);
  const [asking, setAsking] = useState(false);
  if (!pass.can) return null;
  return (
    <div data-password-section className="flex flex-col">
      <span className={HEAD}>Password</span>
      {/* (Its value first; New password and the switch at its end, or together on a line of their own under it in a narrow panel.) */}
      <div className="-mx-2 flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1">
        {pass.on ? <Value password={pass.password} waiting={pass.waiting} /> : <span className={`${HINT} min-w-0`}>Anyone with the link can open it.</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {pass.on && !asking && (
            <button data-password-new disabled={!!pass.busy} onClick={() => setAsking(true)} className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F6F6F4] disabled:text-[#9A9A98]">
              New password
            </button>
          )}
          <button
            role="switch"
            aria-checked={pass.on}
            data-password-switch
            disabled={!!pass.busy}
            onClick={() => void pass.act(pass.on ? "off" : "on")}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[12px] leading-4 text-ink hover:bg-black/[0.04] disabled:opacity-50"
          >
            <span className={`relative h-4 w-7 rounded-full transition-colors ${pass.on ? "bg-ink" : "bg-[#D9D9D6]"}`}>
              <span className={`absolute top-0.5 size-3 rounded-full bg-white transition-all ${pass.on ? "left-3.5" : "left-0.5"}`} />
            </span>
            Ask for a password
          </button>
        </span>
      </div>
      {pass.on && <span className={HINT}>A new one with each deploy.</span>}
      {asking && (
        <div className="pt-1">
          <InlineConfirm
            text="Make a new password? People using the old one will need the new one."
            action="New password"
            doing="Making it…"
            busy={pass.busy === "new"}
            onConfirm={() => void pass.act("new").then((ok) => ok && setAsking(false))}
            onCancel={() => setAsking(false)}
          />
        </div>
      )}
      {pass.error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {pass.error}
        </span>
      )}
    </div>
  );
}
