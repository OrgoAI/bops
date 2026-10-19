"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { describeSchedule, runsADay } from "@/cloud/schedule";
import { APP_LEVELS, appLogo, FEATURED_APPS, levelOf, type AppAccess, type AppAccount, type AppConnecting, type AppLevel, type AppState, type Bot, type LastUses, type Schedule } from "@/lib/types";
import { CHECK_TIMES, checkerOf, isKeyApp } from "@/lib/routine-catalog";
import { Mascot, Spinner } from "./mascot";
import { KeyIcon } from "./screen-cards";
import { ago, post, teamOf } from "./ui";

/*
 * The user's apps, in the Vault. Only what's connected is listed, one row per app (however many
 * accounts it has); everything else is one search away in the app picker, so a thousand apps never
 * crowd the page. Open an app to see its accounts and set, per account, what each bot may do.
 */

/** One app the picker can offer (from /api/apps/catalog). */
type CatalogApp = { app: string; name: string; about?: string; tags: string[]; auth: "oauth" | "key" | "open"; tools?: number };

let catalogOnce: Promise<CatalogApp[]> | null = null;
function useCatalog() {
  const [apps, setApps] = useState<CatalogApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    catalogOnce ??= fetch("/api/apps/catalog")
      .then((r) => r.json() as Promise<{ apps: CatalogApp[]; error?: string }>)
      .then((j) => {
        if (j.error && !j.apps.length) throw new Error(j.error);
        return j.apps;
      });
    catalogOnce.then((a) => !gone && setApps(a)).catch((e: Error) => {
      catalogOnce = null;
      if (!gone) setError(e.message);
    });
    return () => {
      gone = true;
    };
  }, []);
  return { apps, error };
}

/** An app's real logo on a white tile; its first letter if the logo won't load. A vault key (STRIPE_SECRET_KEY) is a key. */
export function AppLogo({ app, name, size }: { app: string; name: string; size: number }) {
  const [broken, setBroken] = useState(false);
  const logo = appLogo(app);
  const radius = Math.round(size * 0.26);
  if (isKeyApp(app))
    return (
      <span role="img" aria-label={name} className="flex shrink-0 items-center justify-center bg-[#F2F2F0] text-[#3A3A38]" style={{ width: size, height: size, borderRadius: radius }}>
        <KeyIcon size={Math.max(10, Math.round(size * 0.6))} />
      </span>
    );
  if (broken)
    return (
      <span className="flex shrink-0 items-center justify-center bg-[#F2F2F0] font-semibold text-[#3A3A38]" style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.42) }}>
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  if (logo.tile)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo.src} alt={name} width={size} height={size} className="shrink-0" style={{ borderRadius: radius }} onError={() => setBroken(true)} />;
  return (
    <span className="flex shrink-0 items-center justify-center bg-white shadow-[0_0_0_1px_#0000001A]" style={{ width: size, height: size, borderRadius: radius }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo.src} alt={name} loading="lazy" width={Math.round(size * 0.64)} height={Math.round(size * 0.64)} className="object-contain" onError={() => setBroken(true)} />
    </span>
  );
}

/** How an account reads in a list: its label and its own name, else the app's name. */
export const accountTitle = (a: AppAccount) => [a.label, a.name].filter(Boolean).join(" · ") || a.appName;

/** The bot's apps, one logo per app, for its profile and home screen (levelOf: every bot has every app by default). */
export function botApps(state: AppState, b: Bot) {
  const seen = new Map<string, { app: string; appName: string; accounts: { account: AppAccount; level: AppLevel }[] }>();
  for (const a of state.accounts ?? []) {
    const level = levelOf(b, a);
    if (!level || a.status !== "active") continue;
    const e = seen.get(a.app) ?? { app: a.app, appName: a.appName, accounts: [] };
    e.accounts.push({ account: a, level });
    seen.set(a.app, e);
  }
  return [...seen.values()];
}

/* ---------------- Pieces of the Vault (vault.tsx) ---------------- */

/** Accounts being connected: each waits for its sign-in in the browser, or says why it didn't connect. */
export function Connecting({ state }: { state: AppState }) {
  return (
    <>
      {(state.connecting ?? []).map((c) => (
        <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-white px-3.5 py-2.5 shadow-[0_0_0_1px_#ECECEA]">
          <AppLogo app={c.app} name={c.appName} size={28} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13.5px] font-medium leading-[18px]">{c.appName}</span>
            <span className={`truncate text-[12px] leading-4 ${c.status === "failed" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>
              {c.status === "failed" ? `Couldn't connect: ${c.error ?? "try again"}` : "Finish signing in in your browser…"}
            </span>
          </span>
          {c.status === "waiting" ? <Spinner size={14} /> : (
            <button onClick={() => void post("/api/apps", { app: c.app, label: c.label, grant: c.grant, replaces: c.replaces })} className="shrink-0 rounded-full bg-ink px-3 py-1 text-[12px] font-medium leading-4 text-white">
              Try again
            </button>
          )}
          <button onClick={() => void post("/api/apps", { waiting: c.id }, "DELETE")} className="shrink-0 rounded-full px-2 py-1 text-[12px] text-[#6B6B6B] hover:bg-[#F2F2F0]">
            {c.status === "waiting" ? "Cancel" : "Dismiss"}
          </button>
        </div>
      ))}
    </>
  );
}

/** Nothing connected yet: the apps most teams start with, one tap each. */
export function QuickStart({ onPick }: { onPick: (app: string) => void }) {
  const { apps } = useCatalog();
  // Once the catalog is in, only apps it offers (signed in with Orgo, the ones that can connect through Bops Cloud).
  const pick = (apps ? FEATURED_APPS.map((a) => apps.find((x) => x.app === a)).filter((x): x is CatalogApp => !!x) : FEATURED_APPS.map((a) => ({ app: a, name: a }))).slice(0, 8);
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl px-4 py-4 shadow-[0_0_0_1px_#ECECEA]">
      <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">Connect the apps you work in, and your bots use them directly: faster and steadier than clicking through them on a computer.</span>
      <div className="grid grid-cols-4 gap-1.5">
        {pick.map((a) => (
          <button key={a.app} onClick={() => onPick(a.app)} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-[#F7F7F6]">
            <AppLogo app={a.app} name={a.name} size={22} />
            <span className="truncate text-[12.5px] font-medium leading-4">{a.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A row's round icon button (Rename, Remove, Show, Copy), here and on key rows (keys.tsx). */
export const rowIconBtn =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-[#6B6B6B] outline-none transition-colors hover:bg-black/[0.05] hover:text-ink focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-50";
/** The same, for the one that removes: red on hover. */
export const rowTrashBtn = `${rowIconBtn} hover:!bg-[#FEF3F2] hover:!text-[#B42318]`;

export function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path d="M10.6 2.9l2.5 2.5L5.8 12.7l-3.1.6.6-3.1 7.3-7.3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 4.5h11M6.5 4.5V3a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One account in two lines: its name (and the user's label for it) with Rename and Disconnect as icons, then
 * the bots that can use it and when one last did.
 */
export function AccountBlock({ state, account: a, many, last, onSignIn }: { state: AppState; account: AppAccount; many: boolean; last?: LastUses[string]; onSignIn: () => void }) {
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState(a.label ?? "");
  const [sure, setSure] = useState(false);
  const openApp = a.id.startsWith("open:");
  const save = () => {
    setNaming(false);
    if (label.trim() !== (a.label ?? "")) void post("/api/apps", { account: a.id, label }, "PUT");
  };
  const team = teamOf(state);
  const meta = usedLine(last, team) ?? (a.usedAt ? `Used ${usedWhen(a.usedAt)}` : "Not used yet");
  const set = (b: Bot, level: AppAccess) => void post("/api/bots", { botId: b.id, access: { account: a.id, level } }, "PATCH");
  return (
    <div className={`flex flex-col gap-1.5 ${many ? "rounded-xl bg-[#FAFAF9] p-2" : ""}`}>
      <div className="flex min-h-7 items-center gap-2 px-2">
        {naming ? (
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && (e.preventDefault(), setLabel(a.label ?? ""), setNaming(false)))}
            placeholder="Work, Personal…"
            className="h-7 w-[150px] rounded-lg bg-white px-2 text-[12.5px] outline-none shadow-[0_0_0_1.5px_#0A0A0A]"
          />
        ) : (
          <span className="min-w-0 truncate text-[13.5px] font-medium leading-[18px]">{openApp ? "Ready to use" : accountTitle(a)}</span>
        )}
        {a.status === "expired" && <span className="shrink-0 rounded-full bg-[#FEF0C7] px-1.5 py-px text-[10.5px] font-medium leading-[14px] text-[#93370D]">Signed out</span>}
        <span className="flex-1" />
        {a.status === "expired" && (
          <button onClick={onSignIn} className="shrink-0 rounded-full bg-ink px-2.5 py-1 text-[12px] font-medium leading-4 text-white">
            Sign in again
          </button>
        )}
        {sure ? (
          <span className="flex shrink-0 items-center gap-1">
            <button onClick={() => void post("/api/apps", { account: a.id }, "DELETE")} className="rounded-full bg-[#B42318] px-2.5 py-1 text-[12px] font-semibold leading-4 text-white">
              {openApp ? "Remove" : "Disconnect"}
            </button>
            <button onClick={() => setSure(false)} className="rounded-full px-2 py-1 text-[12px] text-[#6B6B6B]">
              Keep
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center">
            {!openApp && !naming && (
              <button type="button" onClick={() => setNaming(true)} aria-label={a.label ? "Rename" : "Name it"} data-tip={a.label ? "Rename" : "Name it"} className={rowIconBtn}>
                <PencilIcon />
              </button>
            )}
            <button type="button" onClick={() => setSure(true)} aria-label={openApp ? "Remove" : "Disconnect"} data-tip={openApp ? "Remove" : "Disconnect"} className={rowTrashBtn}>
              <TrashIcon />
            </button>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 px-2">
        <div className="min-w-0 flex-1">
          <BotChips
            team={team}
            choices={APP_CHOICES}
            level={(b) => levelOf(b, a) ?? "none"}
            note={(b) => (levelOf(b, a) === "read" ? "read only" : undefined)}
            what={openApp ? a.appName : accountTitle(a)}
            onSet={set}
          />
        </div>
        <span className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">{meta}</span>
      </div>
    </div>
  );
}

/* ---------------- Who can use it: bot chips (here, and for keys in keys.tsx) ---------------- */

/** A bot's choices for an account, the most first, as its chip's menu offers them: Read & act, Read only, No access. */
const APP_CHOICES: { id: AppAccess; name: string; hint: string }[] = [
  ...[...APP_LEVELS].reverse().map((l) => ({ id: l.id as AppAccess, name: l.name, hint: l.hint })),
  { id: "none", name: "No access", hint: "Can't use it." },
];

/** When, in a few words: "just now", "5m ago", "3h ago", else the day ("Oct 15"). */
export function usedWhen(at: number) {
  const a = ago(at);
  if (a === "now") return "just now";
  return /^\d/.test(a) ? `${a} ago` : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Used 2h ago by Iris", from the use log (GET /api/apps/log), when a bot of `team` used it. */
export function usedLine(last: LastUses[string] | undefined, team: Bot[]) {
  const b = last && team.find((x) => x.id === last.bot);
  return last && b ? `Used ${usedWhen(last.at)} by ${b.name}` : null;
}

/**
 * When each account and key was last used, and by which bot (GET /api/apps/log, the use log in
 * lib/server/access-sync.ts): read again whenever `tick` changes. Empty until it's read.
 */
export function useLastUses(tick: unknown): LastUses {
  const [last, setLast] = useState<LastUses>({});
  useEffect(() => {
    let gone = false;
    void fetch("/api/apps/log", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ last?: LastUses }>) : null))
      .then((j) => {
        if (!gone && j?.last) setLast(j.last);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [tick]);
  return last;
}

const MENU_W = 156;

/** A tiny menu under a chip, over everything (the Vault's list clips what's inside it). Esc, a click outside or a scroll closes it. */
function ChipMenu({ anchor, label, onClose, children }: { anchor: () => HTMLElement | null; label: string; onClose: () => void; children: React.ReactNode }) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  const get = useRef(anchor);
  useLayoutEffect(() => {
    close.current = onClose;
    get.current = anchor;
  });
  useLayoutEffect(() => {
    const put = () => {
      const r = get.current()?.getBoundingClientRect();
      if (r) setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8)), top: r.bottom + 4 });
    };
    put();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only the menu closes: the Vault under it stays.
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    const gone = () => close.current();
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", gone, true);
    window.addEventListener("resize", gone);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", gone, true);
      window.removeEventListener("resize", gone);
    };
  }, []);
  if (!place) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        role="menu"
        aria-label={label}
        style={{ left: place.left, top: place.top, width: MENU_W }}
        className="motion-fade-in fixed z-[61] flex flex-col rounded-xl bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040]"
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

const menuItem = "flex h-7 items-center gap-2 rounded-lg px-2 text-left text-[12.5px] leading-4 text-ink hover:bg-[#F2F2F0]";

/** A bot's chip: its mascot and name, small and round (BotChips, and BotChip). */
const CHIP = "flex h-6 items-center gap-1 rounded-full bg-[#F4F4F2] pl-[3px] pr-2 text-[12px] font-medium leading-4 text-[#3A3A38]";

/** A bot as a chip that only says who, nothing to open (a routine's row on the Routines page): `tip` on hover. */
export function BotChip({ bot, tip }: { bot: Bot; tip: string }) {
  return (
    <span data-tip={tip} className={`${CHIP} shrink-0`}>
      <Mascot botId={bot.id} color={bot.color} size={18} antenna={false} />
      {bot.name}
    </span>
  );
}

/**
 * Who can use something (an account, or a key in keys.tsx): a chip for each bot that can (mascot, name,
 * and a quiet `note` such as "read only"), and a quiet "+N" for the rest. A chip opens a tiny menu of
 * `choices` for that bot; "+N" lists the others, and one picked there gets the first choice.
 */
export function BotChips<T extends string>({
  team,
  choices,
  level,
  note,
  what,
  disabled,
  onSet,
}: {
  team: Bot[];
  /** The choices, the most first; the last one is no access. */
  choices: { id: T; name: string; hint: string }[];
  /** Each bot's choice now. */
  level: (b: Bot) => T;
  note?: (b: Bot) => string | undefined;
  /** What it is, for the menus' labels ("Work · maya@acme.com", STRIPE_SECRET_KEY). */
  what: string;
  disabled?: boolean;
  onSet: (b: Bot, to: T) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const none = choices[choices.length - 1].id;
  const users = team.filter((b) => level(b) !== none);
  const rest = team.filter((b) => level(b) === none);
  const pick = (b: Bot, to: T) => {
    setOpen(null);
    if (to !== level(b)) onSet(b, to);
  };
  const chosen = users.find((b) => b.id === open);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {users.map((b) => {
        const word = note?.(b);
        return (
          <button
            key={b.id}
            ref={(el) => void (el ? anchors.current.set(b.id, el) : anchors.current.delete(b.id))}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open === b.id}
            disabled={disabled}
            data-tip={`${b.name}: ${choices.find((c) => c.id === level(b))?.name ?? ""}`}
            onClick={() => setOpen(open === b.id ? null : b.id)}
            className={`${CHIP} outline-none hover:bg-[#EDEDEA] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-50`}
          >
            <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
            {b.name}
            {word && <span className="font-normal text-[#9A9A98]">{word}</span>}
          </button>
        );
      })}
      {!users.length && <span className="pr-1 text-[12px] leading-4 text-[#9A9A98]">No bot can use it</span>}
      {rest.length > 0 && (
        <button
          ref={(el) => void (el ? anchors.current.set("+", el) : anchors.current.delete("+"))}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open === "+"}
          disabled={disabled}
          data-tip={`Can't use it: ${rest.map((b) => b.name).join(", ")}`}
          onClick={() => setOpen(open === "+" ? null : "+")}
          className="h-6 rounded-full px-2 text-[12px] font-medium leading-4 text-[#9A9A98] outline-none hover:bg-[#F4F4F2] hover:text-[#3A3A38] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-50"
        >
          +{rest.length}
        </button>
      )}
      {open === "+" && (
        <ChipMenu anchor={() => anchors.current.get("+") ?? null} label={`Let a bot use ${what}`} onClose={() => setOpen(null)}>
          {rest.map((b) => (
            <button key={b.id} type="button" role="menuitem" data-tip={choices[0].hint} onClick={() => pick(b, choices[0].id)} className={menuItem}>
              <Mascot botId={b.id} color={b.color} size={16} antenna={false} />
              <span className="truncate">{b.name}</span>
            </button>
          ))}
        </ChipMenu>
      )}
      {chosen && (
        <ChipMenu anchor={() => anchors.current.get(chosen.id) ?? null} label={`${chosen.name} in ${what}`} onClose={() => setOpen(null)}>
          {choices.map((c) => (
            <button key={c.id} type="button" role="menuitemradio" aria-checked={level(chosen) === c.id} data-tip={c.hint} onClick={() => pick(chosen, c.id)} className={menuItem}>
              <span className="flex w-3 shrink-0 justify-center">
                {level(chosen) === c.id && (
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                    <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className={c.id === none ? "text-[#B42318]" : ""}>{c.name}</span>
            </button>
          ))}
        </ChipMenu>
      )}
    </div>
  );
}

/* ---------------- The app picker ---------------- */

/** Rank the catalog for a search: name first, then the slug, then what it does and its categories. */
function search(apps: CatalogApp[], q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const score = (a: CatalogApp) => {
    const n = a.name.toLowerCase();
    if (n === s || a.app === s) return 0;
    if (n.startsWith(s)) return 1;
    if (n.split(/\s+/).some((w) => w.startsWith(s)) || a.app.startsWith(s)) return 2;
    if (n.includes(s) || a.app.includes(s)) return 3;
    if (a.tags.some((t) => t.toLowerCase().includes(s))) return 4;
    if (a.about?.toLowerCase().includes(s)) return 5;
    return 9;
  };
  return apps
    .map((a, i) => ({ a, r: score(a), i }))
    .filter((x) => x.r < 9)
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .slice(0, 60)
    .map((x) => x.a);
}

/**
 * Add an app: search the whole catalog (or pick a popular one), then say who may use the account
 * before signing in, so it's ready the moment the sign-in finishes.
 */
export function AppPicker({ state, start, replaces, onClose }: { state: AppState; start?: string; replaces?: string; onClose: () => void }) {
  const { apps, error } = useCatalog();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<string | undefined>(start);
  const results = useMemo(() => (apps ? search(apps, q) : []), [apps, q]);
  const featured = useMemo(() => (apps ? FEATURED_APPS.map((a) => apps.find((x) => x.app === a)).filter((x): x is CatalogApp => !!x) : []), [apps]);
  const list = q.trim() ? results : featured;
  const connected = new Set((state.accounts ?? []).map((a) => a.app));
  // Esc closes the picker, and only the picker: the Vault behind it stays (it sees the dialog, and preventDefault).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const info = chosen ? (apps?.find((a) => a.app === chosen) ?? { app: chosen, name: (state.accounts ?? []).find((a) => a.app === chosen)?.appName ?? chosen, tags: [], auth: "oauth" as const }) : null;

  return (
    <div onClick={onClose} className="motion-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/10 p-6 pt-[9vh] backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add an app"
        onClick={(e) => e.stopPropagation()}
        className="motion-dialog-in flex max-h-[76vh] w-full max-w-[600px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000066]"
      >
        {info ? (
          <ConnectStep state={state} app={info} replaces={replaces} onBack={start ? onClose : () => setChosen(undefined)} onDone={onClose} hasOne={connected.has(info.app)} />
        ) : (
          <>
            <div className="flex items-center gap-2.5 border-b border-[#F0F0EE] px-4 py-3">
              <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0 text-[#9A9A98]">
                <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setCursor((c) => (e.key === "ArrowDown" ? Math.min(c + 1, list.length - 1) : Math.max(c - 1, 0)));
                  }
                  if (e.key === "Enter" && list[cursor]) setChosen(list[cursor].app);
                }}
                placeholder={apps ? `Search ${apps.length.toLocaleString()} apps: Notion, HubSpot, QuickBooks…` : "Search apps…"}
                className="min-w-0 flex-1 bg-transparent text-[15px] leading-5 outline-none placeholder:text-[#9A9A98]"
              />
              <kbd className="shrink-0 rounded-md bg-[#F2F2F0] px-1.5 py-0.5 text-[11px] text-[#6B6B6B]">esc</kbd>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!apps ? (
                <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[#9A9A98]">{error ? `Couldn't load the apps: ${error}` : <><Spinner size={14} /> Loading apps…</>}</div>
              ) : !q.trim() ? (
                <>
                  <div className="px-2 pb-1.5 pt-1 text-[11.5px] font-medium uppercase tracking-[0.05em] text-[#9A9A98]">Popular for business</div>
                  <div className="grid grid-cols-3 gap-0.5">
                    {featured.map((a, i) => (
                      <button key={a.app} onMouseEnter={() => setCursor(i)} onClick={() => setChosen(a.app)} className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${cursor === i ? "bg-[#F4F4F2]" : ""}`}>
                        <AppLogo app={a.app} name={a.name} size={26} />
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium leading-[18px]">{a.name}</span>
                        {connected.has(a.app) && <Check />}
                      </button>
                    ))}
                  </div>
                  <div className="px-2 pb-1 pt-3 text-[12px] leading-4 text-[#9A9A98]">Type to search every app.</div>
                </>
              ) : results.length ? (
                results.map((a, i) => (
                  <button key={a.app} onMouseEnter={() => setCursor(i)} onClick={() => setChosen(a.app)} className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left ${cursor === i ? "bg-[#F4F4F2]" : ""}`}>
                    <AppLogo app={a.app} name={a.name} size={30} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[14px] font-medium leading-[18px]">{a.name}</span>
                        {connected.has(a.app) && <Check />}
                      </span>
                      <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{a.about ?? a.tags.join(" · ")}</span>
                    </span>
                    {a.tags[0] && <span className="shrink-0 rounded-full bg-[#F2F2F0] px-2 py-0.5 text-[11px] capitalize leading-4 text-[#6B6B6B]">{a.tags[0]}</span>}
                  </button>
                ))
              ) : (
                <div className="py-10 text-center text-[13px] text-[#9A9A98]">No app called &ldquo;{q}&rdquo;. Bots can still use it on their computer.</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const Check = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" className="shrink-0" aria-label="Connected">
    <circle cx="7" cy="7" r="7" fill="#12B76A" />
    <path d="M4 7.2l2 2 4-4.2" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** How often a bot looks at a new account on its own (the Connect screen): Only when asked makes no routine; the rest are a check's times. */
export const HOW_OFTEN: { label: string; schedule?: Schedule }[] = [{ label: "Only when asked" }, ...CHECK_TIMES];

/**
 * The line under How often: who checks, when, and what it does with what's new for the access picked;
 * for a check through the day, how many checks a day that is, each one using AI credit.
 */
export function checkLine(bot: string, app: string, level: AppLevel, schedule: Schedule, tz?: string) {
  const when = describeSchedule(schedule, tz);
  const often = `${when.charAt(0).toLowerCase()}${when.slice(1)}`;
  const what = level === "read" ? `${bot} checks ${app} ${often} and tells you what's new.` : `${bot} checks ${app} ${often} and handles what's new. Asks you before it sends, posts, deletes or pays.`;
  const n = schedule.kind === "every" ? runsADay(schedule) : 1;
  return n > 1 ? `${what} That's ${n} checks a day, and each one uses AI credit.` : what;
}

/**
 * Who may use a new account, how much, and how often it's checked (`check`, a How often schedule), as
 * Continue sends them (POST /api/apps): no check without a bot to do it, and nothing for signing in again
 * (the bots keep what they had).
 */
export function grantOf(bots: string[], level: AppLevel, check: Schedule | undefined, replaces?: string): AppConnecting["grant"] {
  if (replaces) return undefined;
  return { bots, level, ...(check && bots.length ? { check } : {}) };
}

/** The second step: what signing in will look like, a name for the account, who may use it, and how often it's checked. */
export function ConnectStep({ state, app: a, replaces, hasOne, onBack, onDone }: { state: AppState; app: CatalogApp; replaces?: string; hasOne: boolean; onBack: () => void; onDone: () => void }) {
  const team = teamOf(state);
  const old = replaces ? state.accounts?.find((x) => x.id === replaces) : undefined;
  const [label, setLabel] = useState("");
  // Every bot, Read & act: the default for every account.
  const [bots, setBots] = useState<string[]>(() => team.map((b) => b.id));
  const [level, setLevel] = useState<AppLevel>("act");
  // Only when asked by default: no routine.
  const [often, setOften] = useState(HOW_OFTEN[0].label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One bot checks it: the main bot when it's picked, else the first one picked. None picked: no checks.
  const checker = checkerOf(bots, team);
  const check = checker ? HOW_OFTEN.find((o) => o.label === often)?.schedule : undefined;
  const connect = async () => {
    setBusy(true);
    setError(null);
    const res = await post("/api/apps", { app: a.app, label: label || undefined, replaces, grant: grantOf(bots, level, check, replaces) });
    const j = (await res.json()) as { error?: string };
    if (j.error) {
      setError(j.error);
      setBusy(false);
    } else onDone();
  };
  const how =
    a.auth === "open"
      ? `${a.name} needs no sign-in: your bots can use it straight away.`
      : a.auth === "key"
        ? `${a.name} connects with an API key. A secure page opens in your browser and asks for it. Bops never sees it.`
        : `${a.name}'s own sign-in opens in your browser. Bops never sees your password.`;
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <button onClick={onBack} aria-label="Back" className="-ml-1 mt-1 flex size-7 shrink-0 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0]">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <AppLogo app={a.app} name={a.name} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[17px] font-semibold leading-[22px]">{old ? `Sign in to ${a.name} again` : hasOne ? `Add another ${a.name} account` : `Connect ${a.name}`}</span>
          <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">{old ? `For ${accountTitle(old)}. Your bots keep the access they had.` : (a.about ?? how)}</span>
        </div>
      </div>

      {!old && (
        <>
          {a.auth !== "open" && (
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Name it · optional{hasOne ? ", so bots can tell your accounts apart" : ""}</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work, Personal, Client X…" className="w-full rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13.5px] leading-[18px] outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]" />
            </label>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Who can use it</span>
            <div className="flex flex-wrap gap-1.5">
              {team.map((b) => {
                const on = bots.includes(b.id);
                return (
                  <button
                    key={b.id}
                    onClick={() => setBots(on ? bots.filter((x) => x !== b.id) : [...bots, b.id])}
                    className={`flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12.5px] leading-4 ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#6B6B6B]"}`}
                  >
                    <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
                    {b.name}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-1.5 pt-1">
              {APP_LEVELS.map((l) => (
                <button key={l.id} onClick={() => setLevel(l.id)} className={`flex-1 rounded-xl px-3 py-2 text-left ${level === l.id ? "bg-white shadow-[0_0_0_1.5px_#0A0A0A]" : "bg-[#F7F7F6] hover:bg-[#F2F2F0]"}`}>
                  <span className="block text-[13px] font-medium leading-[18px]">{l.name}</span>
                  <span className="block text-[11.5px] leading-[15px] text-[#6B6B6B]">{l.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">How often</span>
            <div role="radiogroup" aria-label="How often" className="flex flex-wrap gap-1.5">
              {HOW_OFTEN.map((o) => {
                const on = o.schedule === check;
                return (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!checker}
                    onClick={() => setOften(o.label)}
                    className={`rounded-full px-2.5 py-1 text-[12.5px] leading-4 disabled:opacity-50 ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#6B6B6B] hover:bg-[#EAEAE7]"}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {!checker ? (
              <span className="text-[11.5px] leading-[15px] text-[#9A9A98]">Pick a bot above first: it does the checks.</span>
            ) : (
              check && <span className="text-[11.5px] leading-[15px] text-[#6B6B6B]">{checkLine(checker.name, a.name, level, check, state.owner?.timeZone)}</span>
            )}
          </div>
        </>
      )}

      {error && <span className="rounded-xl bg-[#FFF4F2] px-3 py-2 text-[12.5px] leading-[17px] text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-3">
        <button onClick={() => void connect()} disabled={busy} className="shrink-0 whitespace-nowrap rounded-full bg-ink px-4 py-2 text-[13px] font-semibold leading-4 text-white hover:bg-[#2A2A28] disabled:opacity-50">
          {busy ? "Opening…" : a.auth === "open" ? `Add ${a.name}` : old ? "Sign in" : "Continue to sign in"}
        </button>
        <span className="text-[11.5px] leading-4 text-[#9A9A98]">{a.auth === "open" ? "" : how}</span>
      </div>
    </div>
  );
}
