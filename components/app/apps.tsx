"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { APP_LEVELS, appLogo, FEATURED_APPS, type AppAccount, type AppLevel, type AppState, type Bot } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
import { post, teamOf } from "./ui";

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

/** An app's real logo on a white tile; its first letter if the logo won't load. */
export function AppLogo({ app, name, size }: { app: string; name: string; size: number }) {
  const [broken, setBroken] = useState(false);
  const logo = appLogo(app);
  const radius = Math.round(size * 0.26);
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

/** The bot's apps, one logo per app, for its profile and home screen. */
export function botApps(state: AppState, b: Bot) {
  const seen = new Map<string, { app: string; appName: string; accounts: { account: AppAccount; level: AppLevel }[] }>();
  for (const a of state.accounts ?? []) {
    const level = b.access?.[a.id];
    if (!level || a.status !== "active") continue;
    const e = seen.get(a.app) ?? { app: a.app, appName: a.appName, accounts: [] };
    e.accounts.push({ account: a, level });
    seen.set(a.app, e);
  }
  return [...seen.values()];
}

/* ---------------- The Vault's Apps section ---------------- */

export function AppsSection({ state }: { state: AppState }) {
  const [picking, setPicking] = useState<{ app?: string; replaces?: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Pick up accounts connected, signed out or removed in Composio's own dashboard.
  useEffect(() => {
    void post("/api/apps", {}, "PATCH");
  }, []);
  const groups = useMemo(() => {
    const m = new Map<string, AppAccount[]>();
    for (const a of state.accounts ?? []) m.set(a.app, [...(m.get(a.app) ?? []), a]);
    return [...m.entries()].sort((x, y) => x[1][0].appName.localeCompare(y[1][0].appName));
  }, [state.accounts]);
  // A sign-in just finished: open that app, so the user sees who can use it.
  const before = useRef(new Set((state.accounts ?? []).map((a) => a.id)));
  useEffect(() => {
    const fresh = (state.accounts ?? []).find((a) => !before.current.has(a.id));
    before.current = new Set((state.accounts ?? []).map((a) => a.id));
    if (fresh) setOpen(fresh.app);
  }, [state.accounts]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold leading-5">Apps</span>
          <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">Your accounts. Each bot gets only the access you give it.</span>
        </div>
        <button onClick={() => setPicking({})} className="flex shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold leading-4 text-white hover:bg-[#2A2A28]">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Add an app
        </button>
      </div>

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

      {groups.length ? (
        <div className="flex flex-col rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
          {groups.map(([app, accounts], i) => (
            <AppGroup
              key={app}
              state={state}
              accounts={accounts}
              last={i === groups.length - 1}
              open={open === app}
              onToggle={() => setOpen(open === app ? null : app)}
              onAddAnother={() => setPicking({ app })}
              onSignIn={(replaces) => setPicking({ app, replaces })}
            />
          ))}
        </div>
      ) : (
        <QuickStart onPick={(app) => setPicking({ app })} />
      )}

      {picking && <AppPicker state={state} start={picking.app} replaces={picking.replaces} onClose={() => setPicking(null)} />}
    </div>
  );
}

/** Nothing connected yet: the apps most teams start with, one tap each. */
function QuickStart({ onPick }: { onPick: (app: string) => void }) {
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

/** One app: its accounts and who can use them, folded away until it's opened. */
function AppGroup({
  state,
  accounts,
  last,
  open,
  onToggle,
  onAddAnother,
  onSignIn,
}: {
  state: AppState;
  accounts: AppAccount[];
  last: boolean;
  open: boolean;
  onToggle: () => void;
  onAddAnother: () => void;
  onSignIn: (replaces: string) => void;
}) {
  const first = accounts[0];
  const team = teamOf(state);
  const users = team.filter((b) => accounts.some((a) => b.access?.[a.id]));
  const expired = accounts.filter((a) => a.status === "expired").length;
  const openApp = first.id.startsWith("open:");
  const summary = openApp ? "No sign-in needed" : accounts.length === 1 ? accountTitle(first) : `${accounts.length} accounts · ${accounts.map((a) => a.label ?? a.name ?? "").filter(Boolean).join(", ")}`;
  return (
    <div className={last ? "" : "border-b border-[#F0F0EE]"}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-[#FCFCFB]">
        <AppLogo app={first.app} name={first.appName} size={32} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-medium leading-[18px]">{first.appName}</span>
          <span className={`truncate text-[12.5px] leading-4 ${expired ? "text-[#B54708]" : "text-[#6B6B6B]"}`}>{expired ? `Signed out${accounts.length > 1 ? ` (${expired} of ${accounts.length})` : ""} · sign in again` : summary}</span>
        </span>
        {users.length ? (
          <span className="flex shrink-0 -space-x-1.5" title={users.map((b) => b.name).join(", ")}>
            {users.slice(0, 5).map((b) => (
              <span key={b.id} className="rounded-full bg-white p-px">
                <Mascot botId={b.id} color={b.color} size={20} antenna={false} />
              </span>
            ))}
          </span>
        ) : (
          <span className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">No bots yet</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="#9A9A98" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3.5 pb-3.5">
          {accounts.map((a) => (
            <AccountBlock key={a.id} state={state} account={a} many={accounts.length > 1} onSignIn={() => onSignIn(a.id)} />
          ))}
          {!openApp && (
            <button onClick={onAddAnother} className="self-start rounded-full px-2 py-1 text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]">
              + Add another {first.appName} account
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One account: its name (and the user's label for it), and each bot's access to it. */
function AccountBlock({ state, account: a, many, onSignIn }: { state: AppState; account: AppAccount; many: boolean; onSignIn: () => void }) {
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState(a.label ?? "");
  const [sure, setSure] = useState(false);
  const openApp = a.id.startsWith("open:");
  const save = () => {
    setNaming(false);
    if (label.trim() !== (a.label ?? "")) void post("/api/apps", { account: a.id, label }, "PUT");
  };
  return (
    <div className={`flex flex-col gap-1 ${many ? "rounded-xl bg-[#FAFAF9] p-2" : ""}`}>
      <div className="flex min-h-7 items-center gap-2 px-2">
        {naming ? (
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && (setLabel(a.label ?? ""), setNaming(false)))}
            placeholder="Work, Personal…"
            className="h-7 w-[150px] rounded-lg bg-white px-2 text-[12.5px] outline-none shadow-[0_0_0_1.5px_#0A0A0A]"
          />
        ) : (
          <span className="min-w-0 truncate text-[12.5px] font-medium leading-4 text-[#3A3A38]">{openApp ? "Ready to use" : accountTitle(a)}</span>
        )}
        {a.status === "expired" && <span className="shrink-0 rounded-full bg-[#FEF0C7] px-1.5 py-px text-[10.5px] font-medium leading-[14px] text-[#93370D]">Signed out</span>}
        <span className="flex-1" />
        {a.status === "expired" && (
          <button onClick={onSignIn} className="shrink-0 rounded-full bg-ink px-2.5 py-1 text-[12px] font-medium leading-4 text-white">
            Sign in again
          </button>
        )}
        {!openApp && !naming && (
          <button onClick={() => setNaming(true)} className="shrink-0 rounded-full px-2 py-1 text-[12px] text-[#6B6B6B] hover:bg-[#F2F2F0]">
            {a.label ? "Rename" : "Name it"}
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
          <button onClick={() => setSure(true)} className="shrink-0 rounded-full px-2 py-1 text-[12px] text-[#B42318] hover:bg-[#FEF3F2]">
            {openApp ? "Remove" : "Disconnect"}
          </button>
        )}
      </div>
      {teamOf(state).map((b) => (
        <BotAccess key={b.id} bot={b} account={a} />
      ))}
    </div>
  );
}

/** A bot's access to one account: none, read only, or read and act. */
function BotAccess({ bot: b, account: a }: { bot: Bot; account: AppAccount }) {
  const level = b.access?.[a.id] ?? null;
  const set = (next: AppLevel | null) => void post("/api/bots", { botId: b.id, access: { account: a.id, level: next } }, "PATCH");
  return (
    <div className="flex items-center gap-2.5 rounded-xl px-2 py-1">
      <Mascot botId={b.id} color={b.color} size={22} antenna={false} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4">{b.name}</span>
      <span className="flex shrink-0 rounded-full bg-[#F2F2F0] p-0.5">
        {([null, ...APP_LEVELS.map((l) => l.id)] as (AppLevel | null)[]).map((l) => (
          <button
            key={l ?? "none"}
            onClick={() => set(l)}
            title={l ? APP_LEVELS.find((x) => x.id === l)!.hint : "Can't use it"}
            className={`rounded-full px-2.5 py-[3px] text-[12px] leading-4 transition-colors ${level === l ? "bg-white font-medium text-ink shadow-[0_1px_2px_#0000001F]" : "text-[#6B6B6B] hover:text-ink"}`}
          >
            {l ? APP_LEVELS.find((x) => x.id === l)!.name : "None"}
          </button>
        ))}
      </span>
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
function AppPicker({ state, start, replaces, onClose }: { state: AppState; start?: string; replaces?: string; onClose: () => void }) {
  const { apps, error } = useCatalog();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<string | undefined>(start);
  const results = useMemo(() => (apps ? search(apps, q) : []), [apps, q]);
  const featured = useMemo(() => (apps ? FEATURED_APPS.map((a) => apps.find((x) => x.app === a)).filter((x): x is CatalogApp => !!x) : []), [apps]);
  const list = q.trim() ? results : featured;
  const connected = new Set((state.accounts ?? []).map((a) => a.app));
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const info = chosen ? (apps?.find((a) => a.app === chosen) ?? { app: chosen, name: (state.accounts ?? []).find((a) => a.app === chosen)?.appName ?? chosen, tags: [], auth: "oauth" as const }) : null;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center bg-black/10 p-6 pt-[9vh] backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[76vh] w-full max-w-[600px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000066]">
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

/** The second step: what signing in will look like, a name for the account, and who may use it. */
function ConnectStep({ state, app: a, replaces, hasOne, onBack, onDone }: { state: AppState; app: CatalogApp; replaces?: string; hasOne: boolean; onBack: () => void; onDone: () => void }) {
  const team = teamOf(state);
  const old = replaces ? state.accounts?.find((x) => x.id === replaces) : undefined;
  const [label, setLabel] = useState("");
  const [bots, setBots] = useState<string[]>(() => team.filter((b) => b.isMain).map((b) => b.id));
  const [level, setLevel] = useState<AppLevel>("act");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    const res = await post("/api/apps", { app: a.app, label: label || undefined, replaces, grant: replaces ? undefined : { bots, level } });
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
        ? `${a.name} connects with an API key. A secure Composio page opens in your browser and asks for it; Bops never sees it.`
        : `${a.name}'s own sign-in opens in your browser. Composio keeps the access; Bops never sees your password.`;
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
