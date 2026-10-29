"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { levelOf as memberLevelOf } from "@/lib/member-access";
import {
  accountIn,
  APP_LEVELS,
  BRAINS_ON,
  CHANNEL_APPS,
  levelIn,
  mayUseLogin,
  openToTeam,
  siteLoginIn,
  workBot,
  workspaceOf,
  type AppAccess,
  type AppState,
  type Bot,
  type LastUses,
  type Watch,
} from "@/lib/types";
import { FOLD_AFTER_MS, FOLD_OVER, isMcp, lastUsed, servicesOf, signedOut, type Service } from "@/lib/vault-services";
import { initialsFrom, initialsOf } from "./account";
import { AccountBlock, accountTitle, AppLogo, AppPicker, Connecting, QuickStart, usedLine, usedWhen, useLastUses } from "./apps";
import { keyId, KeysSettings, type KeyRow } from "./keys";
import { Mascot } from "./mascot";
import { anchorOf, AppRoutines, hasTemplates, routineCount, routinesOfApp, RoutineSuggest, usePendingSuggest } from "./routines";
import { currentWorkspace, post, teamOf } from "./ui";
import { LoginForm, LoginRow, ServiceLogo, SiteTile } from "./vault";

/*
 * Logins (Settings, Workspace): the owner's logins as the open workspace's bots have them. A login stays the person's
 * who connected it (the Mac's owner, today): they sign in once and switch it on in the workspaces that should use it
 * (Used in, lib/server/logins.ts). In each workspace the per bot picker says which bots have it (Read only, Read & act
 * or No access for an app; Can use it or No access for a key or a site login), and the people the owner added reach
 * it only through the bots they can use (Workspace.memberAccess), every send, change, delete or payment asking the
 * owner first. Apps and site logins come one row a service (lib/vault-services.ts), each sign in with who connected it,
 * its bots and when one last used it; keys under them (keys.tsx); a side panel for the one picked. Passwords stay in
 * the Mac's Keychain, and keys in the owner's Orgo vault: no AI sees either.
 */

/** What the side panel shows: an app's sign in, a saved site login, or a key. */
export type Picked = { kind: "app"; id: string } | { kind: "site"; id: string } | { kind: "key"; id: string };

/** "Sales", "Sales and Boppy", "Sales, Boppy and Rex". */
const and = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/** Who connected a login, as a face: today always the Mac's owner. */
function Face({ label, size = 20, dark = true }: { label: string; size?: number; dark?: boolean }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(7.5, Math.round(size * 0.38)) }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold tracking-[0.02em] ${dark ? "bg-ink text-white" : "bg-[#E6E6E3] text-[#3A3A38]"}`}
    >
      {label}
    </span>
  );
}

/** The people the owner added to the workspace, by access key (email, or user:<id>), with their names when /api/members says. */
function usePeople(state: AppState, ws: string) {
  const [names, setNames] = useState<Record<string, string>>({});
  const map = state.shared ? undefined : state.workspaces?.find((w) => w.id === ws)?.memberAccess;
  const any = !!map && Object.keys(map).length > 0;
  useEffect(() => {
    if (!any) return;
    let gone = false;
    void fetch("/api/members", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ state?: string; people?: { id: string; name: string; email?: string }[] }>) : null))
      .then((j) => {
        if (gone || j?.state !== "ready") return;
        const out: Record<string, string> = {};
        for (const p of j.people ?? []) {
          if (p.email) out[p.email.toLowerCase()] = p.name;
          out[`user:${p.id}`] = p.name;
        }
        setNames(out);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [any, ws]);
  return Object.entries(map ?? {}).map(([key, access]) => ({ key, access, name: names[key] ?? (key.startsWith("user:") ? "Someone" : key.split("@")[0]) }));
}

/**
 * Who reaches a login in the workspace: the people the owner added, each through the bots of `bots` (the ones that
 * have it) they can tell (Write: "Tells Sales and Boppy") or only see (Read: "Sees Sales, can't ask"). Nobody else.
 */
export function reachersOf(people: ReturnType<typeof usePeople>, bots: Bot[]) {
  const out: { key: string; name: string; line: string; invited: boolean }[] = [];
  for (const p of people) {
    const tells = bots.filter((b) => memberLevelOf(p.access, b.id) === "write").map((b) => b.name);
    const sees = bots.filter((b) => memberLevelOf(p.access, b.id) === "read").map((b) => b.name);
    if (!tells.length && !sees.length) continue;
    const line = tells.length ? `Tells ${and(tells)}${sees.length ? `, sees ${and(sees)}` : ""}` : `Sees ${and(sees)}, can't ask`;
    out.push({ key: p.key, name: p.name, line, invited: p.access.invite === true });
  }
  return out;
}

/**
 * What's signed in on the workspace's computers' screens besides the logins here: the AI plans signed in on a bot's
 * computer (Brain.signIns), which any bot that works there can use. Only what Bops knows: nothing when there's none.
 */
export function screenSignIns(state: AppState, ws: string): { host: Bot; what: string[]; bots: Bot[] }[] {
  if (!BRAINS_ON) return [];
  const out = new Map<string, { host: Bot; what: string[]; bots: Bot[] }>();
  for (const x of state.brains ?? []) {
    if (x.workspaceId !== ws) continue;
    for (const s of x.signIns ?? []) {
      const host = state.bots.find((b) => b.computerId === s.computerId && workspaceOf(b) === ws);
      if (!host) continue;
      const e = out.get(host.id) ?? { host, what: [], bots: state.bots.filter((b) => workspaceOf(b) === ws && workBot(b, state.bots).id === host.id) };
      if (!e.what.includes(x.name)) e.what.push(x.name);
      out.set(host.id, e);
    }
  }
  return [...out.values()];
}

/**
 * The Logins page. `framed`: inside Settings, which has its own close; otherwise (a tab) it has an X. `keysFor`: a bot's
 * profile asked to add a key for it. `onOpenBot`: a bot's settings page, at a section (the screens note's See them).
 */
export function LoginsPage({
  state,
  keysFor,
  onOpenWatch,
  onClose,
  onOpenBot,
}: {
  state: AppState;
  keysFor?: string;
  onOpenWatch: (w: Watch) => void;
  onClose?: () => void;
  onOpenBot?: (botId: string) => void;
}) {
  const ws = currentWorkspace(state);
  const shared = !!state.shared;
  const wsName = shared ? (state.shared?.name ?? "this workspace") : (state.workspaces?.find((w) => w.id === ws)?.name ?? "this workspace");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [picking, setPicking] = useState<{ app?: string; replaces?: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const onKeys = useCallback((k: KeyRow[]) => setKeys(k), []);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "attention">("all");
  const [showRest, setShowRest] = useState(false);
  const [showElsewhere, setShowElsewhere] = useState(false);
  // The time, for "not used lately", read once a minute (never while rendering).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Pick up accounts connected, signed out or removed in Composio's own dashboard.
  useEffect(() => {
    void post("/api/apps", {}, "PATCH");
  }, []);
  // When each account and key was last used, by which bot and for whom: read again each minute.
  const uses = useLastUses(`${now}:${ws}`);
  const people = usePeople(state, ws);
  const all = useMemo(() => servicesOf(state.accounts ?? [], state.vault ?? []), [state.accounts, state.vault]);
  // This workspace's: a service with a sign in or a login on here (where it was connected, switched on, or given to a
  // bot here by name). The rest are the owner's other workspaces', folded under the list. A shared workspace's page
  // lists the viewer's own logins, as before: none of them are its bots'.
  const isHere = (s: Service) => shared || s.accounts.some((a) => accountIn(state, a).includes(ws)) || s.logins.some((l) => siteLoginIn(state, l).includes(ws));
  const services = all.filter(isHere);
  const elsewhere = all.filter((s) => !isHere(s));
  // A sign in just finished: open its service, so the user sees who can use it.
  const before = useRef(new Set((state.accounts ?? []).map((a) => a.id)));
  useEffect(() => {
    const fresh = (state.accounts ?? []).find((a) => !before.current.has(a.id));
    before.current = new Set((state.accounts ?? []).map((a) => a.id));
    if (fresh) setOpen(all.find((s) => s.accounts.some((a) => a.id === fresh.id))?.key ?? null);
  }, [state.accounts, all]);
  // Routines for an app: asked for from its row (the main bot picked), or offered as a connect finished.
  const icons = useRef(new Map<string, HTMLElement>());
  const [asked, setAsked] = useState<string | null>(null);
  const suggest = usePendingSuggest(state, (x) => (state.accounts ?? []).some((a) => a.app === x.app && a.status === "active"));
  const routinesFor = asked ? { app: asked, botId: undefined } : suggest.pending ? { app: suggest.pending.app, botId: suggest.pending.botId } : null;

  const needing = services.filter((s) => signedOut(s).length);
  const term = q.trim().toLowerCase();
  const matches = (s: Service) =>
    !term || [s.name, ...s.accounts.flatMap((a) => [a.appName, a.name ?? "", a.label ?? ""]), ...s.logins.flatMap((l) => [l.site, l.username])].some((x) => x.toLowerCase().includes(term));
  const hits = services.filter((s) => (only === "all" || signedOut(s).length) && matches(s));
  // Short as it grows: past FOLD_OVER, what no bot used lately (and nothing's wrong with, and wasn't just added) folds away.
  const folds = !term && only === "all" && hits.length > FOLD_OVER;
  const quiet = (s: Service) => folds && !signedOut(s).length && now - lastUsed(s) > FOLD_AFTER_MS && s.key !== open;
  const shown = showRest ? hits : hits.filter((s) => !quiet(s));
  const rest = showRest ? [] : hits.filter(quiet);
  const others = only === "all" ? elsewhere.filter(matches) : [];
  const first = needing[0] && signedOut(needing[0])[0];
  const screens = shared ? [] : screenSignIns(state, ws);
  const me = initialsOf(state);
  const pick = (p: Picked) => setPicked((x) => (x && x.kind === p.kind && x.id === p.id ? null : p));

  return (
    <div data-logins className="flex min-h-0 min-w-0 flex-1">
      <div className="motion-fade-in relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-7 pb-8 pt-5">
        <div className="flex w-full flex-col gap-3.5">
          <div className="flex items-start gap-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-[#F6F6F4] py-[3px] pl-1 pr-2.5 text-[11.5px] leading-4 text-[#6B6B6B] shadow-[0_0_0_1px_#E8E8E5]">
                <span className="flex size-4 items-center justify-center rounded-[5px] bg-[#1F5F4A] text-[9.5px] font-semibold uppercase text-white">{wsName[0]}</span>
                Workspace · {wsName}
              </span>
              <span className="mt-2 text-[22px] font-bold leading-7 tracking-[-0.02em]">Logins</span>
              <span className="mt-0.5 text-[13px] leading-[19px] text-[#6B6B6B]">
                {shared
                  ? "Your own apps, keys and site logins. They're yours, not this workspace's bots'."
                  : `Apps, keys and site logins for ${wsName}'s bots. Each bot gets only the access you give it. Passwords stay in your Mac's Keychain, and no AI sees them.`}
              </span>
            </div>
            <div className="relative mt-[30px] shrink-0">
              <button onClick={() => setAdding(!adding)} aria-expanded={adding} className="flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold leading-4 text-white hover:bg-[#2A2A28]">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                Connect
              </button>
              {adding && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setAdding(false)} />
                  <div className="absolute right-0 top-[calc(100%+6px)] z-40 flex w-[220px] flex-col rounded-xl bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040]">
                    <button onClick={() => (setAdding(false), setPicking({}))} className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-[#F2F2F0]">
                      <span className="text-[13px] font-medium leading-4">An app</span>
                      <span className="text-[12px] leading-4 text-[#6B6B6B]">Gmail, Slack, GitHub, an MCP server…</span>
                    </button>
                    <button onClick={() => (setAdding(false), setEditing("new"))} className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-[#F2F2F0]">
                      <span className="text-[13px] font-medium leading-4">A website login</span>
                      <span className="text-[12px] leading-4 text-[#6B6B6B]">For sites bots sign in to on a screen</span>
                    </button>
                  </div>
                </>
              )}
            </div>
            {onClose && (
              <button onClick={onClose} aria-label="Close" className="mt-[30px] flex size-8 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>

          {shared && (
            <div data-shared-note className="rounded-2xl bg-[#F7F7F6] px-3.5 py-3 text-[13px] leading-[19px] text-[#3A3A38]">
              {`The owner's logins reach you only through their bots you can use. Anything those bots send, change, delete or pay from them waits for the owner's yes.`}
            </div>
          )}

          {first && (
            <div className="flex items-center gap-3 rounded-2xl bg-[#FBFFE0] px-3.5 py-3 shadow-[0_0_0_1px_#E6F57A]">
              <span className="size-2 shrink-0 rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" />
              <span className="min-w-0 flex-1 text-[13.5px] leading-[19px]">
                Signed out of {first.appName}
                {first.label || first.name ? ` (${first.label ?? first.name})` : ""}. Bots can&apos;t use it until you sign in again.
                {needing.length > 1 && (
                  <button onClick={() => setOnly("attention")} className="ml-1.5 font-medium underline decoration-[#0A0A0A33] underline-offset-2">
                    {needing.length - 1} more
                  </button>
                )}
              </span>
              <button onClick={() => setPicking({ app: first.app, replaces: first.id })} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-white">
                Sign in again
              </button>
            </div>
          )}

          <Connecting state={state} />
          {/* Connect's An app, and Sign in again: the picker, here in the page as the login's form is. */}
          {picking && <AppPicker key={`${picking.app ?? ""}:${picking.replaces ?? ""}`} state={state} start={picking.app} replaces={picking.replaces} onClose={() => setPicking(null)} />}
          {editing === "new" && <LoginForm state={state} onDone={() => setEditing(null)} />}

          {all.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-[#F7F7F6] px-3.5 text-[#9A9A98] focus-within:bg-white focus-within:shadow-[0_0_0_1.5px_#0A0A0A]">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                  <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && q && (e.preventDefault(), setQ(""))}
                  placeholder="Search logins"
                  aria-label="Search logins"
                  className="min-w-0 flex-1 bg-transparent text-[13.5px] leading-5 text-ink outline-none placeholder:text-[#9A9A98]"
                />
              </label>
              <button onClick={() => setOnly("all")} aria-pressed={only === "all"} className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium ${only === "all" ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}>
                All
              </button>
              <button
                onClick={() => setOnly("attention")}
                aria-pressed={only === "attention"}
                disabled={!needing.length}
                className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium disabled:opacity-50 ${only === "attention" ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
              >
                Needs attention{needing.length ? ` ${needing.length}` : ""}
              </button>
            </div>
          )}

          {!all.length ? (
            editing !== "new" && <QuickStart onPick={(app) => setPicking({ app })} />
          ) : !hits.length && !others.length ? (
            <div className="py-10 text-center text-[13.5px] leading-5 text-[#6B6B6B]">{term ? <>Nothing matches &ldquo;{q.trim()}&rdquo;.</> : only === "attention" ? "Nothing needs you." : `No logins in ${wsName} yet.`}</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3 pl-3 pr-[44px] text-[12px] font-medium leading-4 text-[#9A9A98]">
                <span className="flex-1">Apps and site logins</span>
                <span className="w-[82px] shrink-0">Connected by</span>
                <span className="w-[92px] shrink-0 text-right">Bots</span>
                <span className="w-[50px] shrink-0" />
              </div>
              <div className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-[0_0_0_1px_#ECECEA]">
                {shown.map((s, i) => (
                  <ServiceRow
                    key={s.key}
                    state={state}
                    service={s}
                    me={me}
                    last={i === shown.length - 1 && !rest.length && !(others.length && showElsewhere)}
                    open={open === s.key}
                    onToggle={() => setOpen(open === s.key ? null : s.key)}
                    editing={editing}
                    onEdit={setEditing}
                    onPick={setPicking}
                    picked={picked}
                    onSelect={pick}
                    onRoutines={setAsked}
                    onOpenWatch={onOpenWatch}
                    uses={uses}
                    iconRef={(el) => s.accounts.forEach((a) => void (el ? icons.current.set(a.app, el) : icons.current.delete(a.app)))}
                  />
                ))}
                {rest.length > 0 && (
                  <button onClick={() => setShowRest(true)} className="flex items-center gap-3 border-t border-[#F0F0EE] px-3.5 py-3 text-left first:border-0 hover:bg-[#FCFCFB]">
                    <span className="flex shrink-0">
                      {rest.slice(0, 5).map((s, i) => (
                        <span key={s.key} className={`flex rounded-[7px] bg-white shadow-[0_0_0_2px_#FFFFFF] ${i ? "-ml-1.5" : ""}`}>
                          <ServiceLogo service={s} size={24} />
                        </span>
                      ))}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13.5px] font-medium leading-[18px]">{rest.length} more, not used lately</span>
                      <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{rest.map((s) => s.name).join(", ")}</span>
                    </span>
                    <span className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-[#3A3A38] shadow-[0_0_0_1px_#E2E2DF]">Show</span>
                  </button>
                )}
                {showElsewhere &&
                  others.map((s, i) => (
                    <ServiceRow
                      key={s.key}
                      state={state}
                      service={s}
                      me={me}
                      off
                      last={i === others.length - 1}
                      open={open === s.key}
                      onToggle={() => setOpen(open === s.key ? null : s.key)}
                      editing={editing}
                      onEdit={setEditing}
                      onPick={setPicking}
                      picked={picked}
                      onSelect={pick}
                      onRoutines={setAsked}
                      onOpenWatch={onOpenWatch}
                      uses={uses}
                      iconRef={() => {}}
                    />
                  ))}
              </div>
              {others.length > 0 && !showElsewhere && (
                <button data-elsewhere onClick={() => setShowElsewhere(true)} className="flex items-center gap-2 self-start rounded-full px-2 py-1 text-[12.5px] leading-4 text-[#6B6B6B] hover:bg-[#F2F2F0]">
                  {others.length} more in your other workspaces: {others.slice(0, 3).map((s) => s.name).join(", ")}
                  {others.length > 3 ? ", …" : ""}
                  <span className="font-medium text-ink">Show</span>
                </button>
              )}
            </div>
          )}

          <KeysSettings state={state} keysFor={keysFor} uses={uses} onOpenWatch={onOpenWatch} picked={picked?.kind === "key" ? picked.id : null} onPick={shared ? undefined : (k) => pick({ kind: "key", id: keyId(k) })} onKeys={onKeys} />

          {screens.length > 0 && (
            <div data-screen-sign-ins className="flex items-center gap-2.5 rounded-xl bg-[#FFF8EB] px-3 py-2.5 text-[12px] leading-[17px] text-[#7A4A0E] shadow-[0_0_0_1px_#F5DFB5]">
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
                <rect x="2" y="3" width="14" height="9.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6.5 15.5h5M9 12.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span className="min-w-0 flex-1">
                <b className="font-semibold text-[#5C3608]">Also signed in on screens.</b>{" "}
                {screens
                  .map((x) => `${x.host.name}'s computer has ${and(x.what)} signed in. Anyone who can tell ${and(x.bots.map((b) => b.name))} what to do can use ${x.what.length > 1 ? "them" : "it"}.`)
                  .join(" ")}
              </span>
              {onOpenBot && screens.length === 1 && (
                <button onClick={() => onOpenBot(screens[0].host.id)} className="shrink-0 rounded-full bg-white px-2.5 py-1 font-semibold text-[#5C3608] shadow-[0_0_0_1px_#F5DFB5]">
                  See them
                </button>
              )}
            </div>
          )}
        </div>
        {routinesFor && (
          <RoutineSuggest
            key={`${routinesFor.app}:${routinesFor.botId ?? ""}`}
            state={state}
            app={routinesFor.app}
            botId={routinesFor.botId}
            pickBot
            anchor={() => anchorOf(icons.current, routinesFor.app)}
            onClose={() => {
              setAsked(null);
              suggest.handled();
            }}
          />
        )}
      </div>
      {picked && <LoginPanel state={state} picked={picked} keys={keys} uses={uses} people={people} me={me} onClose={() => setPicked(null)} onSignIn={(p) => setPicking(p)} onEdit={setEditing} />}
    </div>
  );
}

/**
 * One service: a short row (its mark, name, what's connected, who connected it, its bots: "every bot", or "only" and
 * their faces, which kinds: App, MCP, Login) that opens to each sign in and each login, a name opening the side panel.
 * `off`: one of the owner's other workspaces' logins, not on here (its side panel switches it on).
 */
function ServiceRow({
  state,
  service: s,
  me,
  off,
  last,
  open,
  onToggle,
  editing,
  onEdit,
  onPick,
  picked,
  onSelect,
  onRoutines,
  onOpenWatch,
  uses,
  iconRef,
}: {
  state: AppState;
  service: Service;
  me: string;
  off?: boolean;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  editing: string | "new" | null;
  onEdit: (id: string | null) => void;
  onPick: (p: { app?: string; replaces?: string }) => void;
  picked: Picked | null;
  onSelect: (p: Picked) => void;
  onRoutines: (app: string) => void;
  onOpenWatch: (w: Watch) => void;
  uses: LastUses;
  iconRef: (el: HTMLSpanElement | null) => void;
}) {
  const team = teamOf(state);
  const out = signedOut(s);
  const kinds = [s.accounts.some((a) => !isMcp(a)) && "App", s.accounts.some(isMcp) && "MCP", s.logins.length > 0 && "Login"].filter(Boolean) as string[];
  // Who can use any of it: every bot (said quietly), some (their faces), or none yet.
  const users = team.filter((b) => s.accounts.some((a) => levelIn(state, b, a)) || s.logins.some((l) => mayUseLogin(l, b.id)));
  const everyone = !!team.length && users.length === team.length;
  const apps = [...new Set(s.accounts.map((a) => a.appName))];
  const count = (n: string) => s.accounts.filter((a) => a.appName === n).length;
  const whose = [
    ...new Set(
      [
        ...s.accounts.map((a) => (a.id.startsWith("open:") ? "" : (a.label ?? a.name ?? ""))),
        ...s.logins.map((l) => [l.username, l.auto ? "auto sign in" : "", l.hasTotp ? "2FA codes" : ""].filter(Boolean).join(" · ")),
      ].filter((x) => x && x !== s.name),
    ),
  ];
  const line = off
    ? "Not on here. Open it to switch it on."
    : out.length
      ? `Signed out of ${out[0].appName}${out.length > 1 ? ` and ${out.length - 1} more` : ""} · sign in again`
      : [apps.length > 1 ? apps.map((n) => (count(n) > 1 ? `${n} ×${count(n)}` : n)).join(", ") : "", whose.length ? `${whose[0]}${whose.length > 1 ? ` and ${whose.length - 1} more` : ""}` : ""]
          .filter(Boolean)
          .join(" · ") || (s.accounts.some((a) => a.id.startsWith("open:")) ? "No sign in needed" : "");
  const byApp = [...new Set(s.accounts.map((a) => a.app))].map((app) => s.accounts.filter((a) => a.app === app));
  const runs = byApp.reduce((n, accounts) => n + routinesOfApp(state, accounts[0].app), 0);
  const by = <Face label={me} size={18} />;
  return (
    <div data-service={s.key} className={`${last ? "" : "border-b border-[#F0F0EE]"} ${off ? "bg-[#FCFCFB]" : ""}`}>
      {/* Where focus goes when the last of its routines is deleted (autopilot.tsx, focusAfterRemove). */}
      <button data-list-heading onClick={onToggle} aria-expanded={open} className="flex h-[48px] w-full items-center gap-3 px-3.5 text-left hover:bg-[#FCFCFB]">
        <span ref={iconRef} className={`flex shrink-0 ${off ? "opacity-60" : ""}`}>
          <ServiceLogo service={s} size={26} />
        </span>
        <span className={`w-[128px] shrink-0 truncate text-[14px] font-medium leading-[18px] ${off ? "text-[#6B6B6B]" : ""}`}>{s.name}</span>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-4 ${out.length && !off ? "text-[#B54708]" : "text-[#6B6B6B]"}`}>
          {line}
          {runs > 0 && !off && (
            <span className="text-[#9A9A98]">
              {line ? " · " : ""}
              {routineCount(runs)}
            </span>
          )}
        </span>
        <span className="flex w-[82px] shrink-0 items-center" data-tip="Connected by you">
          <Face label={me} />
        </span>
        <span className="flex w-[92px] shrink-0 items-center justify-end gap-1">
          {off ? (
            <span className="text-[11.5px] leading-4 text-[#9A9A98]">off here</span>
          ) : everyone ? (
            <span className="text-[11.5px] leading-4 text-[#9A9A98]">every bot</span>
          ) : users.length ? (
            <span className="flex items-center gap-1" data-tip={`Only ${users.map((b) => b.name).join(", ")}`}>
              <span className="text-[11.5px] leading-4 text-[#9A9A98]">only</span>
              <span className="flex -space-x-1.5">
                {users.slice(0, 3).map((b) => (
                  <span key={b.id} className="rounded-full bg-white p-px">
                    <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span className="text-[11.5px] leading-4 text-[#9A9A98]">No bots yet</span>
          )}
        </span>
        <span className="flex w-[50px] shrink-0 justify-end gap-1">
          {kinds.slice(0, 1).map((k) => (
            <span key={k} className="w-[46px] shrink-0 rounded-[5px] bg-[#F2F2F0] py-px text-center text-[10.5px] font-medium leading-[15px] text-[#3A3A38]">
              {k}
            </span>
          ))}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="#9A9A98" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3.5 pb-3.5">
          {byApp.map((accounts) => (
            <div key={accounts[0].app} className="flex flex-col gap-2">
              {byApp.length + (s.logins.length ? 1 : 0) > 1 && (
                <span className="flex items-center gap-2 px-2 text-[12px] font-medium leading-4 text-[#9A9A98]">
                  <AppLogo app={accounts[0].app} name={accounts[0].appName} size={16} />
                  {accounts[0].appName}
                </span>
              )}
              {accounts.map((a) => (
                <AccountBlock
                  key={a.id}
                  state={state}
                  account={a}
                  many={accounts.length > 1}
                  last={uses[a.id]}
                  onSignIn={() => onPick({ app: a.app, replaces: a.id })}
                  picked={picked?.kind === "app" && picked.id === a.id}
                  onPick={() => onSelect({ kind: "app", id: a.id })}
                  by={
                    <span className="flex shrink-0 items-center gap-1 text-[12px] leading-4 text-[#6B6B6B]">
                      {by}
                      You
                    </span>
                  }
                />
              ))}
              {!off && <AppRoutines state={state} app={accounts[0].app} onOpenWatch={onOpenWatch} />}
              {!off && (
                <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
                  {!accounts[0].id.startsWith("open:") && (
                    <button onClick={() => onPick({ app: accounts[0].app })} className="rounded-full px-2 py-1 text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]">
                      + Add another {accounts[0].appName} account
                    </button>
                  )}
                  {hasTemplates(accounts[0].app) && accounts.some((a) => a.status === "active") && (
                    <button
                      onClick={() => onRoutines(accounts[0].app)}
                      className="rounded-full bg-[#F2F2F0] px-2.5 py-1 text-[12px] font-medium leading-4 text-[#3A3A38] outline-none hover:bg-[#EAEAE7] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
                    >
                      Add routines
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {s.logins.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {byApp.length > 0 && <span className="px-2 text-[12px] font-medium leading-4 text-[#9A9A98]">Website login</span>}
              <div className="flex flex-col rounded-xl shadow-[0_0_0_1px_#F0F0EE]">
                {s.logins.map((l, i) =>
                  editing === l.id ? (
                    <div key={l.id} className="p-3">
                      <LoginForm state={state} login={l} onDone={() => onEdit(null)} />
                    </div>
                  ) : (
                    <LoginRow key={l.id} state={state} login={l} last={i === s.logins.length - 1} onEdit={() => onEdit(l.id)} picked={picked?.kind === "site" && picked.id === l.id} onPick={() => onSelect({ kind: "site", id: l.id })} />
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- The side panel: one login ---------------- */

const APP_PICKS: [AppAccess, string][] = [["read", APP_LEVELS[0].name], ["act", APP_LEVELS[1].name], ["none", "No access"]];
const USE_PICKS: ["act" | "none", string][] = [["act", "Can use it"], ["none", "No access"]];

/** A bot's choice, as a pill of choices (segmented.tsx's look, without its title). */
function Pill<V extends string>({ label, value, options, onPick, disabled }: { label: string; value: V; options: [V, string][]; onPick: (v: V) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
      {options.map(([v, name]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => value !== v && onPick(v)}
          className={`whitespace-nowrap rounded-full px-[7px] py-1 text-[11.5px] leading-4 disabled:opacity-60 ${value === v ? "bg-white font-semibold text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** A switch, on or off (Used in). `locked`: shown, not changed, with why. */
function Toggle({ label, on, locked, onFlip }: { label: string; on: boolean; locked?: boolean; onFlip: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={locked}
      onClick={() => onFlip(!on)}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:cursor-default ${on ? "bg-ink" : "bg-[#D9D9D6]"} ${locked ? "opacity-50" : ""}`}
    >
      <span className={`absolute top-[2px] size-[14px] rounded-full bg-white transition-[left] ${on ? "left-[14px]" : "left-[2px]"}`} />
    </button>
  );
}

const sectionTitle = "pb-2 text-[11px] font-semibold uppercase leading-4 tracking-[0.05em] text-[#8A8A88]";
const card = "flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]";
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * The side panel for the login picked: who connected it, the workspaces it's used in (a switch each), which of this
 * workspace's bots have it and how much, who reaches it through them, that it asks first, and Rename and Disconnect.
 */
function LoginPanel({
  state,
  picked,
  keys,
  uses,
  people,
  me,
  onClose,
  onSignIn,
  onEdit,
}: {
  state: AppState;
  picked: Picked;
  keys: KeyRow[];
  uses: LastUses;
  people: ReturnType<typeof usePeople>;
  me: string;
  onClose: () => void;
  onSignIn: (p: { app?: string; replaces?: string }) => void;
  onEdit: (id: string) => void;
}) {
  const ws = currentWorkspace(state);
  const shared = !!state.shared;
  const team = teamOf(state);
  const own = state.workspaces ?? [];
  const wsName = (id: string) => own.find((w) => w.id === id)?.name ?? "this workspace";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  // Picking another login starts its panel afresh.
  const [was, setWas] = useState(picked);
  if (was !== picked) {
    setWas(picked);
    setSure(false);
    setNaming(null);
    setError(null);
  }
  const a = picked.kind === "app" ? state.accounts?.find((x) => x.id === picked.id) : undefined;
  const l = picked.kind === "site" ? state.vault?.find((x) => x.id === picked.id) : undefined;
  const k = picked.kind === "key" ? keys.find((x) => keyId(x) === picked.id) : undefined;
  if (!a && !l && !k) return null;

  const send = async (url: string, body: unknown, method: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await post(url, body, method);
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "That didn't work. Try again.");
      return res.ok;
    } catch {
      setError("Couldn't reach Bops. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const flip = (wsId: string, on: boolean) => {
    const id = a ? a.id : l ? l.id : `${k!.from ? (own.find((w) => w.id === k!.from)?.orgoProjectId ?? "") : (own.find((w) => w.id === ws)?.orgoProjectId ?? "")}:${k!.name}`;
    void send("/api/logins", { kind: a ? "app" : l ? "site" : "key", id, workspaceId: wsId, on }, "PATCH");
  };

  // Where it's used: each of the owner's workspaces, on or off; the one it was connected in always on.
  const home = a ? workspaceOf(a) : k ? (k.scope === "all" ? null : (k.from ?? ws)) : null;
  // (A key of another workspace's listed here is switched on here, whatever the list said.)
  const inWs = a ? accountIn(state, a) : l ? siteLoginIn(state, l) : k ? (k.scope === "all" ? own.map((w) => w.id) : [home!, ...(k.usedIn ?? []), ...(k.from ? [ws] : [])]) : [];
  const onHere = shared || inWs.includes(ws);
  // Which of this workspace's bots have it, and how much.
  const level = (b: Bot): AppAccess => (a ? (levelIn(state, b, a) ?? "none") : l ? (mayUseLogin(l, b.id) ? "act" : "none") : b.keys?.includes(k!.name) ? "act" : "none");
  const setLevel = (b: Bot, to: AppAccess) => {
    if (a) return void send("/api/bots", { botId: b.id, access: { account: a.id, level: to } }, "PATCH");
    if (k) return void send("/api/keys", { name: k.name, botId: b.id, allowed: to === "act" }, "PATCH");
    if (!l) return;
    const now = l.bots === "all" ? state.bots.map((x) => x.id) : l.bots;
    const next = to === "act" ? [...new Set([...now, b.id])] : now.filter((x) => x !== b.id);
    void send("/api/vault", { id: l.id, bots: next }, "PATCH");
  };
  const having = team.filter((b) => level(b) !== "none");
  const reachers = shared ? [] : reachersOf(people, having);

  const title = a ? (a.id.startsWith("open:") ? a.appName : accountTitle(a)) : l ? l.site : k!.name;
  const sub = a
    ? `${a.appName} · in ${wsName(workspaceOf(a))} · connected ${day(a.at)}`
    : l
      ? `Website login · ${l.username}${l.auto ? " · signs in by itself" : ""}`
      : `${k!.label} · ${k!.scope === "all" ? "from your account" : k!.from ? `from ${wsName(k!.from)}` : "this workspace"}`;
  const last = uses[a?.id ?? k?.name ?? ""];
  const usedLineText = usedLine(last, team) ?? (a?.usedAt ? `Used ${usedWhen(a.usedAt)}` : l?.usedAt ? `Used ${usedWhen(l.usedAt)}` : null);
  const forWhom = last?.for ? ` for ${last.for}` : "";
  const expired = a?.status === "expired";
  const owner = state.account?.user.name?.trim() || state.owner?.name?.trim() || "You";
  const email = state.account?.user.email;
  const channel = !!a && CHANNEL_APPS.has(a.app);

  return (
    <aside data-login-panel aria-label={title} className="motion-fade-in flex w-[372px] shrink-0 flex-col overflow-y-auto border-l border-[#E8E8E5] bg-white px-5 py-5">
      <div className="flex items-center gap-3">
        {a ? <AppLogo app={a.app} name={a.appName} size={42} /> : l ? <SiteTile site={l.site} /> : <AppLogo app={k!.name} name={k!.label} size={42} />}
        <div className="flex min-w-0 flex-1 flex-col">
          {naming !== null ? (
            <input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onBlur={() => {
                if (a && naming.trim() !== (a.label ?? "")) void send("/api/apps", { account: a.id, label: naming }, "PUT");
                setNaming(null);
              }}
              onKeyDown={(e) => (e.key === "Enter" ? (e.currentTarget as HTMLInputElement).blur() : e.key === "Escape" && (e.preventDefault(), setNaming(null)))}
              placeholder="Work, Personal…"
              aria-label="Its name"
              className="h-7 rounded-lg bg-white px-2 text-[14px] outline-none shadow-[0_0_0_1.5px_#0A0A0A]"
            />
          ) : (
            <span className={`truncate text-[16px] font-semibold leading-5 ${k ? "font-mono text-[14px]" : ""}`}>{title}</span>
          )}
          <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{sub}</span>
        </div>
        <button onClick={onClose} aria-label="Close" className="flex size-7 shrink-0 items-center justify-center self-start rounded-full shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="pt-[18px]">
        <div className={sectionTitle}>Connected by</div>
        <div className={`${card} flex-row items-center gap-3 px-3.5 py-3`}>
          <Face label={me} size={32} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13.5px] font-semibold leading-[18px]">{owner === "You" ? "You" : `${owner} (you)`}</span>
            <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{[email, a ? day(a.at) : l ? day(l.addedAt) : null].filter(Boolean).join(" · ")}</span>
          </div>
          {a && (
            <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${expired ? "bg-[#FEF0C7] text-[#93370D]" : "bg-[#ECFDF3] text-[#1E8A55]"}`}>
              <span className={`size-1.5 rounded-full ${expired ? "bg-[#F79009]" : "bg-[#2BB673]"}`} />
              {expired ? "Signed out" : "Working"}
            </span>
          )}
        </div>
        {expired && (
          <button onClick={() => onSignIn({ app: a!.app, replaces: a!.id })} className="mt-2 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-white">
            Sign in again
          </button>
        )}
        {usedLineText && (
          <span className="block pt-2 text-[12px] leading-4 text-[#9A9A98]">
            {usedLineText}
            {forWhom}
          </span>
        )}
      </div>

      {!shared && own.length > 0 && (
        <div className="pt-[18px]" data-used-in>
          <div className={sectionTitle}>Used in</div>
          <div className={card}>
            {own.map((w) => {
              const isHome = (a && home === w.id) || (k && home === w.id);
              const locked = !!isHome || (!!k && k.scope === "all");
              const on = locked || inWs.includes(w.id);
              return (
                <div key={w.id} className="flex items-center gap-3 border-b border-[#F0F0EE] px-3.5 py-2.5 last:border-0">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-[#1F5F4A] text-[10.5px] font-semibold uppercase text-white">{w.name[0]}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium leading-[18px]">{w.name}</span>
                    {isHome ? (
                      <span className="text-[11.5px] leading-4 text-[#9A9A98]">{a ? "Connected here" : "Its own workspace"}</span>
                    ) : k?.scope === "all" ? (
                      <span className="text-[11.5px] leading-4 text-[#9A9A98]">From your account</span>
                    ) : null}
                  </span>
                  <Toggle label={`Used in ${w.name}`} on={on} locked={locked || busy} onFlip={(x) => flip(w.id, x)} />
                </div>
              );
            })}
          </div>
          <span className="block pt-2 text-[12px] leading-4 text-[#9A9A98]">
            {a && !openToTeam(a)
              ? "Where it's on, only the bots you pick have it."
              : l
                ? "On in a workspace: its bots have it, and you pick which below. You signed in once: it's the same login everywhere."
                : "On in a workspace: its bots can have it, and you pick which below. You signed in once: it's the same sign in everywhere."}
          </span>
        </div>
      )}

      {!shared && (
        <div className="pt-[18px]" data-which-bots>
          <div className={sectionTitle}>Which bots have it</div>
          {!onHere ? (
            <span className="block text-[12.5px] leading-[18px] text-[#6B6B6B]">Off in {wsName(ws)}. Switch it on above to give it to bots here.</span>
          ) : !team.length ? (
            <span className="block text-[12.5px] leading-[18px] text-[#6B6B6B]">No bots in {wsName(ws)} yet.</span>
          ) : (
            <div className={card}>
              {team.map((b) => (
                <div key={b.id} className="flex items-center gap-2 border-b border-[#F0F0EE] px-2.5 py-2.5 last:border-0">
                  <Mascot botId={b.id} color={b.color} size={22} antenna={false} />
                  <span className="min-w-[44px] flex-1 truncate text-[13px] font-medium" title={b.name}>
                    {b.name}
                  </span>
                  {a ? (
                    <Pill label={`${b.name}'s access`} value={level(b)} options={channel ? APP_PICKS.slice(1) : APP_PICKS} disabled={busy} onPick={(v) => setLevel(b, v)} />
                  ) : (
                    <Pill label={`${b.name}'s access`} value={level(b) === "none" ? "none" : "act"} options={USE_PICKS} disabled={busy} onPick={(v) => setLevel(b, v)} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!shared && (
        <div className="pt-[18px]" data-who-reaches>
          <div className={sectionTitle}>Who reaches it</div>
          <div className={card}>
            <div className="flex items-center gap-2.5 border-b border-[#F0F0EE] px-3 py-2.5 last:border-0">
              <Face label={me} size={24} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">You</span>
              <span className="text-[12px] leading-4 text-[#6B6B6B]">Owner</span>
            </div>
            {reachers.map((p) => (
              <div key={p.key} className="flex items-center gap-2.5 border-b border-[#F0F0EE] px-3 py-2.5 last:border-0">
                <Face label={initialsFrom(p.name)} size={24} dark={false} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {p.name}
                  {p.invited && <span className="font-normal text-[#9A9A98]"> · invited</span>}
                </span>
                <span className="shrink-0 text-right text-[12px] leading-4 text-[#6B6B6B]">{p.line}</span>
              </div>
            ))}
          </div>
          <span className="block pt-2 text-[12px] leading-4 text-[#9A9A98]">People reach it only through the bots they can use.</span>
        </div>
      )}

      <div data-asks-first className="mt-[18px] flex gap-2.5 rounded-[14px] bg-[#F7F7F6] px-3.5 py-3 shadow-[0_0_0_1px_#ECECEA]">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="mt-0.5 shrink-0">
          <path d="M8 1.8l5 1.9v3.9c0 3.1-2.1 5.6-5 6.6-2.9-1-5-3.5-5-6.6V3.7l5-1.9z" fill="none" stroke="#0A0A0A" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M5.8 8.1l1.5 1.5 2.9-3" fill="none" stroke="#0A0A0A" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[13px] leading-[19px] text-[#3A3A38]">
          <b className="font-semibold text-ink">It asks first.</b>{" "}
          {l
            ? l.auto
              ? "It signs in by itself for the bots here that have it, whoever asked. Turn that off in Edit, and every sign in waits for your tap."
              : "Signing in with it waits for your tap, whoever asks."
            : "Anything that sends, changes, deletes or pays from it waits for a yes from you, who connected it."}
        </span>
      </div>

      {error && (
        <span role="alert" className="pt-3 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-[#F0F0EE] pt-4">
        {sure ? (
          <>
            <span className="w-full pb-1 text-[12.5px] leading-[18px] text-[#3A3A38]">
              {a ? `Disconnect ${title}? No bot can use it any more, in any workspace.` : l ? `Delete the ${l.site} login? It's gone from your Mac's Keychain too.` : `Remove ${k!.name} from your Orgo vault? Your bots stop using it.`}
            </span>
            <button
              disabled={busy}
              onClick={async () => {
                const ok = a ? await send("/api/apps", { account: a.id }, "DELETE") : l ? await send("/api/vault", { id: l.id }, "DELETE") : await send(`/api/keys/${encodeURIComponent(k!.name)}${k!.scope === "workspace" ? "?scope=workspace" : ""}`, {}, "DELETE");
                if (ok) onClose();
              }}
              className="rounded-full bg-[#B42318] px-3.5 py-2 text-[13px] font-semibold leading-4 text-white disabled:opacity-50"
            >
              {a ? (a.id.startsWith("open:") ? "Remove" : "Disconnect") : l ? "Delete" : "Remove"}
            </button>
            <button onClick={() => setSure(false)} className="rounded-full px-3 py-2 text-[13px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]">
              Keep
            </button>
          </>
        ) : (
          <>
            {a && !a.id.startsWith("open:") && (
              <button onClick={() => setNaming(a.label ?? "")} className="rounded-full px-3.5 py-2 text-[13px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
                Rename
              </button>
            )}
            {l && (
              <button onClick={() => onEdit(l.id)} className="rounded-full px-3.5 py-2 text-[13px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
                Edit
              </button>
            )}
            {!k?.from && (
              <button onClick={() => setSure(true)} className="rounded-full px-3.5 py-2 text-[13px] font-medium leading-4 text-[#B42318] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FEF3F2]">
                {a ? (a.id.startsWith("open:") ? "Remove" : "Disconnect") : l ? "Delete" : "Remove"}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

