"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AppDnsWritten, AppDnsZone, AppRenewal, DomainUse, WorkspaceDomain, WorkspaceDomainBought, WorkspaceDomainsAnswer } from "@/lib/hosted-apps";
import type { AppState } from "@/lib/types";
import { BOX, buyForWorkspace, day, DomainShop, escCloses, HEAD, readWorkspaceDomains, readWorkspaceZone, RenewalLine, searchForWorkspace, setWorkspaceAutoRenew } from "./app-settings";
import { changeWorkspaceDns, DnsZone, DOMAIN_STATES, PULSE, QUIET } from "./hosted-apps";

/*
 * Settings, Domains (as orgo.ai's Settings has them, for the workspace open here): every domain the
 * workspace bought through Orgo, a row each in a card as Settings' other sections have them, with its
 * renewal and the apps its names serve; a row opened (one at a time) shows its renewal with Auto-renew,
 * where its names point (an app's name opens that app), and its DNS records to add to, change and
 * remove, Orgo's own locked. Get a domain searches and
 * buys one there without an app, and never points it anywhere: an app's Domains does that. Only an @orgo.ai
 * account sees any of it (bops-app.tsx asks appsShown), and every call goes to app/api/domains.
 */

/** Get a domain, as Settings' other header buttons are (This Mac's Allow all): light, never the black one. */
const LIGHT = "shrink-0 rounded-full bg-[#F2F2F0] px-3 py-1.5 text-[12.5px] font-medium leading-4 hover:bg-[#EAEAE7] disabled:opacity-50 disabled:hover:bg-[#F2F2F0]";

/** How often, and how many times, the list is read again while a domain is still being registered. */
const PENDING_MS = 15_000;
const PENDING_READS = 20;

/** Words that end in their own "Try again" (or "Try again later."), without it, for a line with a Try again button after it. */
export const withoutTryAgain = (s: string) => s.replace(/\s*Try again[^.]*\.?\s*$/, "") || s;

/** How a domain gets onto an app: on the app's tab, Add a domain lists Your domains, each with Use. */
const NOTHING_HERE = "Nothing points here yet. Open an app, press Add a domain, then Use.";

/** Who serves each of a domain's names, once each, in words: its apps (by name), else the computers. */
const servers = (uses: DomainUse[]) => [...new Set(uses.map((u) => u.app ?? u.where ?? "another computer"))];

/**
 * A domain's line, after its name: when it renews and what it's on; while registering, or a renewal
 * retrying, that. `late`: it's been registering for as long as the list is read again by itself.
 */
export function domainLine(d: WorkspaceDomain, late = false): { text: string; amber?: boolean } {
  if (d.status === "pending") return { text: late ? "Still registering." : "Registering. This usually takes a minute." };
  const r = d.renewal;
  if (r?.state === "retrying" && r.error) return { text: r.error, amber: true };
  if (r?.state === "expired") return { text: `Expired${r.expires ? ` ${day(r.expires)}` : ""}` };
  const on = servers(d.uses);
  const where = on.length ? `on ${on[0]}${on.length > 1 ? ` and ${on.length - 1} more` : ""}` : "not on an app yet";
  if (!r) return { text: where[0].toUpperCase() + where.slice(1) };
  const when = r.state === "renewing" ? "Renewing now" : `${r.on ? "Renews" : "Expires"}${r.expires ? ` ${day(r.expires)}` : ""}`;
  return { text: `${when} · ${where}` };
}

/** A domain's dot: green once it's the workspace's, pulsing while it's registered, amber while a renewal needs looking at, grey once it's expired. */
const dotOf = (d: WorkspaceDomain) =>
  d.status === "pending" ? PULSE : d.renewal?.state === "retrying" ? "bg-[#F79009]" : d.renewal?.state === "expired" ? "bg-[#9A9A98]" : "bg-[#2BB673]";

/**
 * The workspace's domains, in Settings. `onOpenApp`: an app named under Where it points, opened in its tab
 * (Settings closes). `onBuying`: whether its shop has a search or a buy out now (Settings stays open until
 * it's answered). Read when it shows; again every few seconds while one is registering.
 */
export function WorkspaceDomains({
  state,
  ws,
  onOpenApp,
  onBuying,
}: {
  state: AppState;
  ws: string;
  onOpenApp: (ws: string, name: string) => void;
  onBuying?: (busy: boolean) => void;
}) {
  const [got, setGot] = useState<{ ws: string; answer: WorkspaceDomainsAnswer | null; failed: string | null } | null>(null);
  const [reads, setReads] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [shopping, setShopping] = useState(false);
  const [buying, setBuying] = useState(false);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const answer = got?.ws === ws ? got.answer : null;
  const failed = got?.ws === ws ? got.failed : null;
  // Settings is the account's: say which workspace these are (the Email section names each on its line).
  const named = state.workspaces?.find((w) => w.id === ws)?.name?.trim() || "this workspace";
  useEffect(() => {
    let stop = false;
    void readWorkspaceDomains(ws).then((r) => {
      if (stop) return;
      setGot((was) => (r.ok ? { ws, answer: r.ok, failed: null } : { ws, answer: was?.ws === ws ? was.answer : null, failed: r.no.error }));
    });
    return () => {
      stop = true;
    };
  }, [ws, reads]);
  // One still registering: read again every few seconds (Orgo settles it as it lists them), for a few
  // minutes; then it says so, with Check again (which reads it again, and goes on for a few more).
  const pending = !!answer?.domains.some((d) => d.status === "pending");
  const [round, setRound] = useState(0);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!pending) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n <= PENDING_READS) return setReads((x) => x + 1);
      clearInterval(t);
      setLate(true);
    }, PENDING_MS);
    return () => clearInterval(t);
  }, [pending, round]);
  const stillLate = late && pending;
  const checkAgain = () => {
    setLate(false);
    setRound((x) => x + 1);
    setReads((x) => x + 1);
  };
  const onRenewal = (id: string, renewal: AppRenewal) =>
    setGot((g) => g && g.answer && { ...g, answer: { ...g.answer, domains: g.answer.domains.map((d) => (d.id === id ? { ...d, renewal } : d)) } });
  // Where focus goes once the shop has closed (never left on the page, where Esc would close Settings): back
  // on Get a domain, or after a buy on the new domain's line.
  const section = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const at = focusAfter.current;
    if (!at || shopping) return;
    focusAfter.current = null;
    section.current?.querySelector<HTMLElement>(at)?.focus();
  });
  const closeShop = () => {
    focusAfter.current = "[data-get-domain]";
    setShopping(false);
  };
  const bought = (b: WorkspaceDomainBought) => {
    setGot({ ws, answer: b.domains, failed: null });
    const it = b.domains.domains.find((d) => d.domain === b.bought);
    focusAfter.current = it ? `[data-domain-row="${it.domain}"]` : "[data-get-domain]";
    setShopping(false);
    if (it) {
      setOpen(it.id);
      setNote({ id: it.id, text: `Bought ${b.bought}.` });
    }
    return null;
  };
  const canBuy = !!answer?.open && answer.buy.open;
  const closedWhy = useId();
  // Settings stays open while the shop has something out; let go once it's answered, or the shop's gone.
  const holding = buying && shopping && !!answer?.open;
  useEffect(() => {
    onBuying?.(holding);
  }, [holding, onBuying]);
  useEffect(() => () => onBuying?.(false), [onBuying]);
  const aside = answer?.open && !shopping && (
    <button
      data-get-domain
      disabled={!canBuy}
      aria-describedby={canBuy ? undefined : closedWhy}
      onClick={() => {
        setBuying(false);
        setShopping(true);
      }}
      className={LIGHT}
    >
      Get a domain
    </button>
  );
  // A line of the card when there's no list to show: reading, couldn't be read, closed, or none yet.
  const say = (text: ReactNode, attrs: Record<string, string | boolean> = {}) => (
    <span {...attrs} className={`flex min-h-10 items-center py-2.5 ${QUIET}`}>
      {text}
    </span>
  );
  return (
    <div ref={section} data-settings-domains className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-semibold">Domains</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">Domains {named} owns, paid for with Orgo credits.</span>
        </div>
        {aside}
      </div>
      {/* Why Get a domain is off, said where it can be read (a button that's off takes no focus, nor a tooltip). */}
      {answer?.open && !canBuy && (
        <span id={closedWhy} data-buy-closed className={QUIET}>
          {answer.buy.why ?? "Buying domains isn't open here."}
        </span>
      )}
      {shopping && answer?.open && (
        <div data-domain-shop onKeyDown={(e) => escCloses(buying, closeShop)(e)} className={BOX}>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[12px] font-semibold leading-4 text-[#6B6B6B]">Get a domain</span>
            <button aria-label="Close" disabled={buying} onClick={closeShop} className="flex size-6 shrink-0 items-center justify-center rounded-md text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink disabled:opacity-50">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2 2l6 6M8 2L2 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <DomainShop
            open={answer.buy.open}
            why={answer.buy.why}
            contact={answer.contact}
            email={state.account?.user.email}
            search={(q, page) => searchForWorkspace(ws, q, page)}
            buy={(domain, registrant, price) => buyForWorkspace({ ws, domain, registrant, price })}
            onBought={bought}
            onUnsure={() => setReads((x) => x + 1)}
            onBusy={setBuying}
            autoFocus
          />
        </div>
      )}
      {/* One card, a divided row a domain, as Settings' other sections have them. */}
      <div data-domains-card className="flex flex-col rounded-[14px] px-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        {!answer ? (
          failed ? (
            <div data-domains-failed className="flex min-h-10 flex-wrap items-center gap-x-2 py-2.5">
              {/* (Its own "Try again" goes: the button says it.) */}
              <span role="alert" className={QUIET}>
                {withoutTryAgain(failed)}
              </span>
              <button onClick={() => setReads((x) => x + 1)} className="text-[12.5px] font-medium leading-4 text-ink underline-offset-2 hover:underline">
                Try again
              </button>
            </div>
          ) : (
            say("Reading them…")
          )
        ) : !answer.open ? (
          say(answer.why, { "data-domains-closed": true })
        ) : !answer.domains.length ? (
          say("This workspace has no domains yet.", { "data-no-domains": true })
        ) : (
          answer.domains.map((d) => (
            <div key={d.id} className="flex flex-col border-b border-[#F0F0EE] last:border-0">
              <DomainRow d={d} late={stillLate} open={open === d.id} onClick={() => setOpen((o) => (o === d.id ? null : d.id))} />
              {open === d.id && d.status === "active" && (
                <DomainDetail ws={ws} d={d} note={note?.id === d.id ? note.text : null} onRenewal={onRenewal} onOpenApp={(name) => onOpenApp(ws, name)} />
              )}
            </div>
          ))
        )}
      </div>
      {stillLate && (
        <div data-still-registering className="flex flex-wrap items-center gap-x-2">
          <span className={QUIET}>Registering is taking longer than usual.</span>
          <button onClick={checkAgain} className="text-[12.5px] font-medium leading-4 text-ink underline-offset-2 hover:underline">
            Check again
          </button>
        </div>
      )}
    </div>
  );
}

/** One domain, one row of the card: its dot, its name, and when it renews and what it's on (or why it needs looking at). One still registering doesn't open. */
function DomainRow({ d, late, open, onClick }: { d: WorkspaceDomain; late: boolean; open: boolean; onClick: () => void }) {
  const line = domainLine(d, late);
  const opens = d.status === "active";
  return (
    <button
      data-domain-row={d.domain}
      aria-expanded={opens ? open : undefined}
      disabled={!opens}
      onClick={onClick}
      className="flex min-h-10 w-full min-w-0 items-center gap-2.5 py-2.5 text-left"
    >
      <span className={`size-[7px] shrink-0 rounded-full ${dotOf(d)}`} />
      <span title={d.domain} className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[13px] leading-4 text-ink">
        {d.domain}
      </span>
      <span data-domain-line className={`min-w-0 flex-1 truncate text-[12.5px] leading-4 ${line.amber ? "text-[#B54708]" : "text-[#6B6B6B]"}`}>
        {line.text}
      </span>
      {opens && (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className={`shrink-0 text-[#9A9A98] transition-transform ${open ? "rotate-90" : ""}`}>
          <path d="M2.5 1l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** One of a domain's names, where it points: what serves it (an app's name opens it) and how it's doing. */
function UseLine({ u, onOpenApp }: { u: DomainUse; onOpenApp: (name: string) => void }) {
  const s = DOMAIN_STATES[u.status] ?? DOMAIN_STATES.pending;
  return (
    <div data-use={u.name} className="flex min-h-7 min-w-0 items-center gap-2 text-[12px] leading-4 text-[#3A3A38]">
      <span className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
      <span className="min-w-0 truncate">
        <span className="font-mono text-ink">{u.name}</span> is on{" "}
        {u.app ? (
          <button onClick={() => onOpenApp(u.app as string)} className="font-medium text-ink underline-offset-2 hover:underline">
            {u.app}
          </button>
        ) : (
          (u.where ?? "another computer")
        )}
        {u.site ? `, site ${u.site}` : ""} · {s.word}
      </span>
    </div>
  );
}

/**
 * A domain opened: its renewal (Auto-renew), where its names point, and its DNS records, read once as it
 * opens. Just bought, it says how to put it on an app.
 */
function DomainDetail({ ws, d, note, onRenewal, onOpenApp }: { ws: string; d: WorkspaceDomain; note: string | null; onRenewal: (id: string, r: AppRenewal) => void; onOpenApp: (name: string) => void }) {
  const [zone, setZone] = useState<AppDnsZone | null>(null);
  const [uses, setUses] = useState<DomainUse[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    void readWorkspaceZone(ws, d.id).then((r) => {
      if (stop) return;
      if (r.no) return setFailed(r.no.error);
      // Its renewal is said once, above: the zone's own line has none.
      const { renewal: _renewal, ...z } = r.ok.zone;
      void _renewal;
      setZone(z);
      setUses(r.ok.uses);
    });
    return () => {
      stop = true;
    };
  }, [ws, d.id]);
  const flip = (on: boolean) => setWorkspaceAutoRenew(ws, d.id, on);
  const shown = uses ?? d.uses;
  return (
    <div data-domain-detail={d.domain} className="flex flex-col gap-2 pb-3.5">
      {note && (
        <span role="status" className="text-[12px] leading-4 text-[#1E7A4C]">
          {note}
        </span>
      )}
      <RenewalLine zone={{ id: d.id, domain: d.domain, serving: true, ttl: null, records: [], renewal: d.renewal }} flip={flip} onRenewal={onRenewal} />
      <div data-where className="flex flex-col">
        <span className={HEAD}>Where it points</span>
        {shown.length ? shown.map((u) => <UseLine key={u.name} u={u} onOpenApp={onOpenApp} />) : <span className={QUIET}>{NOTHING_HERE}</span>}
      </div>
      {zone ? (
        <DnsZone ws={ws} name="" zone={zone} onDns={(w: AppDnsWritten) => setZone((z) => z && { ...z, records: w.records })} change={(c) => changeWorkspaceDns(ws, c)} flip={flip} />
      ) : (
        <span className={`flex h-8 items-center ${QUIET}`}>{failed ?? "Reading its DNS records…"}</span>
      )}
    </div>
  );
}
