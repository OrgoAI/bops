"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { levelOf, type AppState, type BotId, type LastUses, type VaultLogin, type Watch } from "@/lib/types";
import { FOLD_AFTER_MS, FOLD_OVER, isMcp, lastUsed, servicesOf, signedOut, type Service } from "@/lib/vault-services";
import { AccountBlock, AppLogo, AppPicker, Connecting, QuickStart, useLastUses } from "./apps";
import { KeysSettings } from "./keys";
import { Mascot } from "./mascot";
import { anchorOf, AppRoutines, hasTemplates, routineCount, routinesOfApp, RoutineSuggest, usePendingSuggest } from "./routines";
import { ago, CloseButton, post, teamOf } from "./ui";

/*
 * The vault: everything your bots can get into, in one place. Apps (any of Composio's catalog, several
 * accounts each) with how much each bot may do in them, API keys in the Orgo vault (keys.tsx), and logins bots sign in with. For logins, Bops shows the site,
 * the username and who may use each; the password and 2FA setup key live in the Mac's Keychain and
 * are filled straight into the sign-in page, so no AI ever sees them.
 */

/**
 * The Vault, as a tab on the right: Apps & logins, one list with a row per service (an app's accounts,
 * its MCP server and the site's saved login together), so it stays short as more is connected. What
 * needs the user (an account signed out) comes first, with a way to fix it; bots show on a row only
 * where access differs from "all of them"; with more than FOLD_OVER services, the ones not used lately
 * fold into one line. A row opens to its accounts (each bot's access, rename, disconnect) and logins.
 * An app with routines to offer (routines.tsx) has Add routines there, opening them on the row's mark; a
 * connect that just finished opens them there by itself, the bot it was for picked. API keys sit under
 * the list (keys.tsx), `keysFor` opening a new one for that bot.
 * Its X (or Esc, see bops-app.tsx) closes it, back to where you were.
 */
export function VaultTab({ state, keysFor, onOpenWatch, onClose }: { state: AppState; keysFor?: string; onOpenWatch: (w: Watch) => void; onClose: () => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [picking, setPicking] = useState<{ app?: string; replaces?: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "attention">("all");
  const [showRest, setShowRest] = useState(false);
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
  // When each account and key was last used, and by which bot: read again each minute.
  const uses = useLastUses(`${now}:${state.workspace ?? ""}`);
  const services = useMemo(() => servicesOf(state.accounts ?? [], state.vault ?? []), [state.accounts, state.vault]);
  // A sign-in just finished: open its service, so the user sees who can use it.
  const before = useRef(new Set((state.accounts ?? []).map((a) => a.id)));
  useEffect(() => {
    const fresh = (state.accounts ?? []).find((a) => !before.current.has(a.id));
    before.current = new Set((state.accounts ?? []).map((a) => a.id));
    if (fresh) setOpen(services.find((s) => s.accounts.some((a) => a.id === fresh.id))?.key ?? null);
  }, [state.accounts, services]);
  // Routines for an app: asked for from its row (the main bot picked), or offered as a connect finished.
  const icons = useRef(new Map<string, HTMLElement>());
  const [asked, setAsked] = useState<string | null>(null);
  const suggest = usePendingSuggest(state, (x) => (state.accounts ?? []).some((a) => a.app === x.app && a.status === "active"));
  const routinesFor = asked ? { app: asked, botId: undefined } : suggest.pending ? { app: suggest.pending.app, botId: suggest.pending.botId } : null;

  const needing = services.filter((s) => signedOut(s).length);
  const term = q.trim().toLowerCase();
  const hits = services.filter(
    (s) =>
      (only === "all" || signedOut(s).length) &&
      (!term ||
        [s.name, ...s.accounts.flatMap((a) => [a.appName, a.name ?? "", a.label ?? ""]), ...s.logins.flatMap((l) => [l.site, l.username])].some((x) => x.toLowerCase().includes(term))),
  );
  // Short as it grows: past FOLD_OVER, what no bot used lately (and nothing's wrong with, and wasn't just added) folds away.
  const folds = !term && only === "all" && hits.length > FOLD_OVER;
  const quiet = (s: Service) => folds && !signedOut(s).length && now - lastUsed(s) > FOLD_AFTER_MS && s.key !== open;
  const shown = showRest ? hits : hits.filter((s) => !quiet(s));
  const rest = showRest ? [] : hits.filter(quiet);
  const first = needing[0] && signedOut(needing[0])[0];

  return (
    <div className="motion-fade-in relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[600px] flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[22px] font-bold leading-7 tracking-[-0.02em]">Apps &amp; logins</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">
              {services.length ? `${services.length} connected. ` : ""}Each bot gets only the access you give it; passwords stay in your Mac&apos;s Keychain and no AI sees them.
            </span>
          </div>
          <div className="relative shrink-0">
            <button onClick={() => setAdding(!adding)} aria-expanded={adding} className="mt-0.5 flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold leading-4 text-white hover:bg-[#2A2A28]">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Add
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
          <CloseButton onClick={onClose} className="mt-1" />
        </div>

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
        {editing === "new" && <LoginForm state={state} onDone={() => setEditing(null)} />}

        {services.length > 0 && (
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
                placeholder="Search apps and logins"
                aria-label="Search apps and logins"
                className="min-w-0 flex-1 bg-transparent text-[13.5px] leading-5 text-ink outline-none placeholder:text-[#9A9A98]"
              />
            </label>
            <button onClick={() => setOnly("all")} aria-pressed={only === "all"} className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium ${only === "all" ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}>
              All
            </button>
            {needing.length > 0 && (
              <button
                onClick={() => setOnly("attention")}
                aria-pressed={only === "attention"}
                className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium ${only === "attention" ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
              >
                Needs attention {needing.length}
              </button>
            )}
          </div>
        )}

        {!services.length ? (
          editing !== "new" && <QuickStart onPick={(app) => setPicking({ app })} />
        ) : !hits.length ? (
          <div className="py-10 text-center text-[13.5px] leading-5 text-[#6B6B6B]">Nothing matches &ldquo;{q.trim()}&rdquo;.</div>
        ) : (
          <div className="flex flex-col overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
            {shown.map((s, i) => (
              <ServiceRow
                key={s.key}
                state={state}
                service={s}
                last={i === shown.length - 1 && !rest.length}
                open={open === s.key}
                onToggle={() => setOpen(open === s.key ? null : s.key)}
                editing={editing}
                onEdit={setEditing}
                onPick={setPicking}
                onRoutines={setAsked}
                onOpenWatch={onOpenWatch}
                uses={uses}
                iconRef={(el) => s.accounts.forEach((a) => void (el ? icons.current.set(a.app, el) : icons.current.delete(a.app)))}
              />
            ))}
            {rest.length > 0 && (
              <button onClick={() => setShowRest(true)} className="flex items-center gap-3 px-3.5 py-3 text-left hover:bg-[#FCFCFB]">
                <span className="flex shrink-0">
                  {rest.slice(0, 5).map((s, i) => (
                    <span key={s.key} className={`flex rounded-[7px] bg-white shadow-[0_0_0_2px_#FFFFFF] ${i ? "-ml-1.5" : ""}`}>
                      <ServiceLogo service={s} size={24} />
                    </span>
                  ))}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13.5px] font-medium leading-[18px]">
                    {rest.length} more, not used lately
                  </span>
                  <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{rest.map((s) => s.name).join(", ")}</span>
                </span>
                <span className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-[#3A3A38] shadow-[0_0_0_1px_#E2E2DF]">Show</span>
              </button>
            )}
          </div>
        )}

        <KeysSettings state={state} keysFor={keysFor} uses={uses} onOpenWatch={onOpenWatch} />
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
      {picking && <AppPicker state={state} start={picking.app} replaces={picking.replaces} onClose={() => setPicking(null)} />}
    </div>
  );
}

/** A service's mark: its app's logo, else its site's first letter. */
function ServiceLogo({ service: s, size }: { service: Service; size: number }) {
  const a = s.accounts.find((x) => !isMcp(x)) ?? s.accounts[0];
  if (a) return <AppLogo app={a.app} name={a.appName} size={size} />;
  return (
    <span style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-[7px] bg-[#F2F2F0] text-[12px] font-semibold uppercase text-[#3A3A38]">
      {s.name[0]}
    </span>
  );
}

/**
 * One service: a short row (its mark, name, what's connected, which kinds: App, MCP, Login, and the bots
 * only when not all of them can use it) that opens to each account's access and each login.
 */
function ServiceRow({
  state,
  service: s,
  last,
  open,
  onToggle,
  editing,
  onEdit,
  onPick,
  onRoutines,
  onOpenWatch,
  uses,
  iconRef,
}: {
  state: AppState;
  service: Service;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  editing: string | "new" | null;
  onEdit: (id: string | null) => void;
  onPick: (p: { app?: string; replaces?: string }) => void;
  /** Open an app's routines (one of its apps with routines to offer and an account that works). */
  onRoutines: (app: string) => void;
  /** Show a watched screen or Mac window, from one of its routines. */
  onOpenWatch: (w: Watch) => void;
  /** When each account was last used, and by which bot. */
  uses: LastUses;
  /** Its mark, where its routines open. */
  iconRef: (el: HTMLSpanElement | null) => void;
}) {
  const team = teamOf(state);
  const out = signedOut(s);
  const kinds = [s.accounts.some((a) => !isMcp(a)) && "App", s.accounts.some(isMcp) && "MCP", s.logins.length > 0 && "Login"].filter(Boolean) as string[];
  // Who can use any of it: every bot (said nowhere, it's the usual), some (shown), or none yet.
  const users = team.filter((b) => s.accounts.some((a) => levelOf(b, a)) || s.logins.some((l) => l.bots === "all" || l.bots.includes(b.id)));
  const everyone = users.length === team.length;
  // What's connected, in a few words: several apps by name ("Gmail ×3, Google Calendar"), then whose (the first account or login, and how many more).
  const apps = [...new Set(s.accounts.map((a) => a.appName))];
  const count = (n: string) => s.accounts.filter((a) => a.appName === n).length;
  const whose = [...new Set([...s.accounts.map((a) => (a.id.startsWith("open:") ? "" : (a.label ?? a.name ?? ""))), ...s.logins.map((l) => l.username)].filter((x) => x && x !== s.name))];
  const line = out.length
    ? `Signed out of ${out[0].appName}${out.length > 1 ? ` and ${out.length - 1} more` : ""} · sign in again`
    : [apps.length > 1 ? apps.map((n) => (count(n) > 1 ? `${n} ×${count(n)}` : n)).join(", ") : "", whose.length ? `${whose[0]}${whose.length > 1 ? ` and ${whose.length - 1} more` : ""}` : ""]
        .filter(Boolean)
        .join(" · ") || (s.accounts.some((a) => a.id.startsWith("open:")) ? "No sign-in needed" : "");
  const byApp = [...new Set(s.accounts.map((a) => a.app))].map((app) => s.accounts.filter((a) => a.app === app));
  // What bots run from it on their own (its routines, on the row's line and inside).
  const runs = byApp.reduce((n, accounts) => n + routinesOfApp(state, accounts[0].app), 0);
  return (
    <div className={last ? "" : "border-b border-[#F0F0EE]"}>
      {/* Where focus goes when the last of its routines is deleted (autopilot.tsx, focusAfterRemove). */}
      <button data-list-heading onClick={onToggle} aria-expanded={open} className="flex h-[52px] w-full items-center gap-3 px-3.5 text-left hover:bg-[#FCFCFB]">
        <span ref={iconRef} className="flex shrink-0">
          <ServiceLogo service={s} size={26} />
        </span>
        <span className="w-[120px] shrink-0 truncate text-[14px] font-medium leading-[18px]">{s.name}</span>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-4 ${out.length ? "text-[#B54708]" : "text-[#6B6B6B]"}`}>
          {line}
          {runs > 0 && <span className="text-[#9A9A98]">{line ? " · " : ""}{routineCount(runs)}</span>}
        </span>
        {!everyone &&
          (users.length ? (
            <span className="flex shrink-0 items-center gap-1" title={`Only ${users.map((b) => b.name).join(", ")}`}>
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
            <span className="shrink-0 text-[11.5px] leading-4 text-[#9A9A98]">No bots yet</span>
          ))}
        <span className="flex w-[100px] shrink-0 justify-end gap-1">
          {kinds.map((k) => (
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
                <AccountBlock key={a.id} state={state} account={a} many={accounts.length > 1} last={uses[a.id]} onSignIn={() => onPick({ app: a.app, replaces: a.id })} />
              ))}
              <AppRoutines state={state} app={accounts[0].app} onOpenWatch={onOpenWatch} />
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
                    <LoginRow key={l.id} state={state} login={l} last={i === s.logins.length - 1} onEdit={() => onEdit(l.id)} />
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

function SiteTile({ site }: { site: string }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[#F2F2F0] text-[14px] font-semibold uppercase text-[#3A3A38]">{site.replace(/^www\./, "")[0]}</span>
  );
}

function LoginRow({ state, login: l, last, onEdit }: { state: AppState; login: VaultLogin; last: boolean; onEdit: () => void }) {
  const [sure, setSure] = useState(false);
  const who = l.bots === "all" ? teamOf(state) : teamOf(state).filter((b) => (l.bots as BotId[]).includes(b.id));
  return (
    <div className={`group flex items-center gap-3 px-3.5 py-3 ${last ? "" : "border-b border-[#F0F0EE]"}`}>
      <SiteTile site={l.site} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-medium leading-[18px]">{l.site}</span>
          {l.hasTotp && <Badge>2FA codes</Badge>}
          {l.auto && <Badge>Auto sign-in</Badge>}
        </span>
        <span className="truncate text-[12.5px] leading-4 text-[#6B6B6B]">
          {l.username}
          {l.usedAt ? ` · used ${ago(l.usedAt) === "now" ? "just now" : `${ago(l.usedAt)} ago`}` : " · not used yet"}
        </span>
      </div>
      <span className="flex shrink-0 -space-x-1.5" title={l.bots === "all" ? "Every bot can use it" : who.map((b) => b.name).join(", ")}>
        {who.slice(0, 4).map((b) => (
          <span key={b.id} className="rounded-full bg-white p-px">
            <Mascot botId={b.id} color={b.color} size={20} antenna={false} />
          </span>
        ))}
      </span>
      {sure ? (
        <span className="motion-rise-in flex shrink-0 items-center gap-1">
          <button onClick={() => void post("/api/vault", { id: l.id }, "DELETE")} className="rounded-full bg-[#B42318] px-2.5 py-1 text-[12px] font-semibold text-white">
            Delete
          </button>
          <button onClick={() => setSure(false)} className="rounded-full px-2 py-1 text-[12px] text-[#6B6B6B]">
            Keep
          </button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={onEdit} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[#3A3A38] hover:bg-[#F2F2F0]">
            Edit
          </button>
          <button onClick={() => setSure(true)} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[#B42318] hover:bg-[#FEF3F2]">
            Delete
          </button>
        </span>
      )}
    </div>
  );
}

export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded-full bg-[#F2F2F0] px-1.5 py-px text-[10.5px] font-medium leading-[14px] text-[#3A3A38]">{children}</span>;
}

/** Add a login, or change one. Secrets are write-only: an existing one shows as dots and can only be replaced. */
function LoginForm({ state, login, onDone }: { state: AppState; login?: VaultLogin; onDone: () => void }) {
  const [site, setSite] = useState(login?.site ?? "");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [bots, setBots] = useState<VaultLogin["bots"]>(login?.bots ?? "all");
  const [auto, setAuto] = useState(login?.auto ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "w-full rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13.5px] leading-[18px] outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  const toggleBot = (id: string) => {
    const now = bots === "all" ? state.bots.map((b) => b.id) : bots;
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    setBots(next.length === state.bots.length ? "all" : next);
  };
  const on = (id: string) => bots === "all" || bots.includes(id);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { site, username, password: password || undefined, totp: totp || undefined, bots, auto };
    const res = login ? await post("/api/vault", { id: login.id, ...body }, "PATCH") : await post("/api/vault", body);
    if (res.ok) {
      setPassword("");
      setTotp("");
      onDone();
    } else {
      setError(((await res.json()) as { error?: string }).error ?? "Couldn't save it");
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      // Esc cancels the form first; the next one closes the Vault (preventDefault tells it this one's taken).
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onDone();
      }}
      className="motion-rise-in flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-[0_0_0_1px_#ECECEA,0_10px_30px_-18px_#00000040]"
    >
      <div className="grid grid-cols-2 gap-2.5">
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Site</span>
          <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="x.com" autoFocus={!login} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Email or username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={login?.hasPassword ? "•••••••• (unchanged)" : ""} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">2FA setup key · optional</span>
          <input
            type="password"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            autoComplete="off"
            placeholder={login?.hasTotp ? "•••••••• (unchanged)" : "The code under \"can't scan?\""}
            className={`${field} font-mono`}
          />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Who can use it</span>
        <div className="flex flex-wrap gap-1.5">
          {teamOf(state).map((b) => (
            <button
              type="button"
              key={b.id}
              onClick={() => toggleBot(b.id)}
              className={`flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12.5px] leading-4 ${on(b.id) ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#6B6B6B]"}`}
            >
              <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
              {b.name}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2.5 text-[13px] leading-[18px]">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="size-4 accent-[#0A0A0A]" />
        <span>
          Sign in automatically <span className="text-[#6B6B6B]">· otherwise you get a one-tap &ldquo;Sign in as&rdquo; when a bot asks</span>
        </span>
      </label>

      {error && <span className="text-[12.5px] leading-4 text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-2">
        <button disabled={busy || !site.trim() || !username.trim() || (!login && !password)} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold leading-4 text-white disabled:opacity-40">
          {busy ? "Saving…" : login ? "Save" : "Save login"}
        </button>
        <button type="button" onClick={onDone} className="rounded-full px-3.5 py-2 text-[13px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]">
          Cancel
        </button>
        <span className="flex-1" />
        <span className="text-[11.5px] leading-4 text-[#9A9A98]">Stored in your Mac&apos;s Keychain</span>
      </div>
    </form>
  );
}
