"use client";

import { useContext, useEffect, useState, type ReactNode } from "react";
import { ENV_NAME, ENV_RESERVED, isAppName, isSiteName, MAX_SITES, REGISTRANT_FIELDS, typedAppName } from "@/lib/hosted-apps";
import type {
  AddAppAnswer,
  AddAppAsk,
  AppDeploy,
  AppDnsZone,
  AppDomain,
  AppDomainAdd,
  AppDomainAdded,
  AppDomainChecked,
  AppDomainOptions,
  AppDomainsAnswer,
  AppEnvChange,
  AppRenewal,
  AppSettingsAnswer,
  AppSettingsChange,
  DomainOffer,
  DomainSearchAnswer,
  HostedApp,
  Registrant,
  RegistrantField,
} from "@/lib/hosted-apps";
import { PencilIcon, rowIconBtn, rowTrashBtn, TrashIcon } from "./apps";
import { act, AppSite, CopyLink, isSending, PILL, QUIET, removeApp, short, siteQuery, STATES, UrlLink, useSending } from "./hosted-apps";
import { InlineConfirm, undash } from "./side-group";
import { ago, post } from "./ui";

/*
 * An app on the web's own page, beyond what hosted-apps.tsx shows of it (lib/hosted-apps.ts): Add app on the
 * Apps page (its main bot builds it); its address on orgo.dev; adding a domain (one bought now, one the user
 * owns, or one the workspace bought before), checking one's DNS, removing one, a bought one's auto-renew;
 * its port, commands and health check; its variables (names only: Orgo never gives a value back, so one is
 * typed again to change it, and none is ever kept here), which can be set before its first deploy; its
 * recent deploys, an earlier one put back without a build; and its end: Add a site (one more from the same
 * repo), Remove a site, Remove app (its repo too, only when ticked). Every call about one site of it says
 * which (AppSite). Nothing here buys anything until Buy is pressed on the step that shows the exact charge.
 *
 * (hosted-apps.tsx imports this file and this one takes its pieces back: they're used as it renders only.)
 */

const at = (name: string) => `/api/hosted-apps/${encodeURIComponent(name)}`;
const wsQuery = (ws: string) => `ws=${encodeURIComponent(ws)}`;

/** Why the server turned something down: its words (no dashes), the field to fix, and Orgo's code and facts (a new price, the credits there are). */
export type Refused = { error: string; field?: string; code?: string; price?: number | null; renewal?: number | null; years?: number | null; available?: number | null };

/** What a call answered: the answer, or why not. */
export type Answered<T> = { ok: T; no?: undefined } | { ok?: undefined; no: Refused };

const refusedOf = (j: Record<string, unknown>, fallback: string): Refused => {
  const n = (v: unknown) => (typeof v === "number" ? v : v === null ? null : undefined);
  const out: Refused = { error: undash(typeof j.error === "string" && j.error ? j.error : fallback) };
  if (typeof j.field === "string") out.field = j.field;
  if (typeof j.code === "string") out.code = j.code;
  for (const k of ["price", "renewal", "years", "available"] as const) if (n(j[k]) !== undefined) out[k] = n(j[k]);
  return out;
};

async function answered<T>(r: Response | null, fallback: string): Promise<Answered<T>> {
  const j = ((await r?.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return r?.ok ? { ok: j as T } : { no: refusedOf(j, fallback) };
}

const read = async <T,>(url: string, fallback: string) => answered<T>(await fetch(url, { cache: "no-store" }).catch(() => null), fallback);
const write = async <T,>(url: string, body: unknown, method: string, fallback: string) => answered<T>(await post(url, body, method).catch(() => null), fallback);

/** Add app: the workspace's main bot builds it on its computer. */
export const addApp = (ask: AddAppAsk) => write<AddAppAnswer>("/api/hosted-apps", ask, "POST", "Couldn't start it. Try again.");

export const readSettings = (ws: string, name: string, site?: string) => read<AppSettingsAnswer>(`${at(name)}/settings?${wsQuery(ws)}${siteQuery(site)}`, "Couldn't read its settings just now.");
export const saveSettings = (name: string, c: AppSettingsChange) => write<AppSettingsAnswer>(`${at(name)}/settings`, c, "PATCH", "Couldn't save that. Try again.");
/** Its variables set or removed: the values go in this one request, to the server and on to Orgo, and nowhere else. */
export const saveEnv = (name: string, c: AppEnvChange) => write<{ env: string[] }>(`${at(name)}/env`, c, "PATCH", "Couldn't save the variables. Try again.");

export const readDomainOptions = (ws: string, name: string, site?: string) =>
  read<AppDomainOptions>(`${at(name)}/domains?${wsQuery(ws)}${siteQuery(site)}`, "Couldn't reach Orgo's domains just now.");
export const searchDomains = (ws: string, name: string, q: string, page = 0, site?: string) =>
  read<DomainSearchAnswer>(`${at(name)}/domains/search?${wsQuery(ws)}&q=${encodeURIComponent(q)}&page=${page}${siteQuery(site)}`, "Couldn't search just now. Try again.");
export const addDomain = (name: string, body: AppDomainAdd) => write<AppDomainAdded>(`${at(name)}/domains`, body, "POST", "Couldn't add the domain. Try again.");
/** Orgo asked to check a domain's DNS now (nothing else of the window's state changes, so it isn't read again). */
export const checkDomain = async (ws: string, name: string, id: string, site?: string) =>
  answered<AppDomainChecked>(
    await fetch(`${at(name)}/domains/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(site ? { ws, site } : { ws }) }).catch(() => null),
    "Couldn't check it just now.",
  );
export const removeDomain = (ws: string, name: string, id: string, site?: string) =>
  write<AppDomainsAnswer>(`${at(name)}/domains/${encodeURIComponent(id)}`, site ? { ws, site } : { ws }, "DELETE", "Couldn't remove it. Try again.");
export const setAutoRenew = (ws: string, name: string, zone: string, on: boolean, site?: string) =>
  write<{ renewal: AppRenewal | null }>(`${at(name)}/domains`, { ws, zone, autoRenew: on, ...(site ? { site } : {}) }, "PATCH", "Couldn't change auto-renew. Try again.");

/** Dollars of Orgo credits, from cents. */
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** A price for its term: "$12.00 a year", or "$140.00 for 2 years". */
export const priceFor = (cents: number, years: number | null) => (years && years > 1 ? `${money(cents)} for ${years} years` : `${money(cents)} a year`);
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const HEAD = "pb-1 text-[12px] font-semibold leading-4 text-[#6B6B6B]";
const HINT = "text-[12px] leading-4 text-[#9A9A98]";
const ALERT = "min-w-0 text-[12px] leading-4 text-[#B42318]";
const BOX = "flex flex-col gap-2 rounded-[12px] bg-[#FCFCFB] p-2.5 shadow-[0_0_0_1px_#ECECEA]";
const field = (wrong: boolean, extra = "") =>
  `h-8 min-w-0 rounded-full bg-[#F7F7F6] px-3 text-[12px] outline-none ${wrong ? "shadow-[0_0_0_1.5px_#B42318]" : "shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]"} ${extra}`;
const dark = () => `${PILL} bg-ink text-white disabled:opacity-40`;
const light = () => `${PILL} bg-[#F2F2F0] hover:bg-[#EAEAE7]`;
/** Esc closes what it's on, and only that (the app's Esc would close the panel), never while it saves. */
const escCloses = (busy: boolean, close: () => void) => (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  if (!busy) close();
};

/* ---------------- Add app ---------------- */

/**
 * Add app's form, under "On the web": its name (an Ingot repo's, as it's typed), what it should be, and
 * whether to put it live when it's ready (on). Start has the workspace's main bot build it on its computer;
 * `onStarted` opens that task.
 */
export function AddAppForm({ ws, builder, onStarted, onCancel }: { ws: string; builder?: string | null; onStarted: (a: AddAppAnswer) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [what, setWhat] = useState("");
  const [deploy, setDeploy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refused | null>(null);
  const ok = isAppName(name) && !!what.trim();
  return (
    <form
      data-add-app-form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !ok) return;
        setBusy(true);
        setError(null);
        void addApp({ ws, name, what: what.trim(), deploy }).then((r) => {
          setBusy(false);
          if (r.ok) onStarted(r.ok);
          else setError(r.no);
        });
      }}
      onKeyDown={escCloses(busy, onCancel)}
      className={BOX}
    >
      <input
        aria-label="Name"
        aria-invalid={error?.field === "name" || undefined}
        value={name}
        onChange={(e) => {
          setName(typedAppName(e.target.value));
          setError(null);
        }}
        placeholder="Its name, like recipe-box"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        className={field(error?.field === "name" || (!!name && !isAppName(name)), "w-full font-mono")}
      />
      {!!name && !isAppName(name) && <span className={HINT}>Lowercase letters, numbers and single hyphens, like recipe-box.</span>}
      <textarea
        aria-label="What it should be"
        aria-invalid={error?.field === "what" || undefined}
        value={what}
        onChange={(e) => {
          setWhat(e.target.value);
          setError(null);
        }}
        rows={3}
        placeholder="What it should be, like a page for our recipes with a search box"
        className={`min-h-[64px] w-full resize-y rounded-[10px] bg-[#F7F7F6] px-3 py-2 text-[12.5px] leading-[18px] outline-none ${error?.field === "what" ? "shadow-[0_0_0_1.5px_#B42318]" : "shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]"}`}
      />
      <label className="flex items-center gap-2 text-[12.5px] leading-4 text-ink">
        <input type="checkbox" aria-label="Put it live when it's ready" checked={deploy} onChange={(e) => setDeploy(e.target.checked)} className="size-3.5 accent-[#0A0A0A]" />
        Put it live when it&apos;s ready
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !ok} className={dark()}>
          {busy ? "Starting…" : "Start"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={light()}>
          Cancel
        </button>
        {error ? (
          <span role="alert" className={ALERT}>
            {error.error}
          </span>
        ) : (
          builder && <span className={HINT}>{builder} builds it on its computer.</span>
        )}
      </div>
    </form>
  );
}

/* ---------------- Its address ---------------- */

/**
 * Its address on orgo.dev, to open and copy. Orgo names it after the app's deploy and it can't be renamed
 * (orgo-web keeps a deploy's name, and a public URL's, as they were made): said in its tooltip.
 */
export function AppAddress({ url }: { url: string | null }) {
  // None yet (never deployed, or no address yet): its title line says so already.
  if (!url) return null;
  return (
    <div data-address-section className="flex flex-col">
      <span className={HEAD}>Address</span>
      <div data-address className="-mx-2 flex h-8 min-w-0 items-center gap-2 rounded-lg px-2">
        <UrlLink url={url} />
        <CopyLink url={url} />
        <span className="flex-1" />
        <span data-tip="Orgo names it after the app. It can't be renamed." className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">
          Its address on Orgo
        </span>
      </div>
    </div>
  );
}

/* ---------------- A bought domain's renewal ---------------- */

/**
 * A bought domain's renewal, under its DNS records' title: when it renews, for how much, from whose
 * credits, and Auto-renew to turn on (the user's credits pay from then on) or off. Why its last try failed,
 * while Orgo tries again.
 */
export function RenewalLine({ ws, name, zone, onRenewal }: { ws: string; name: string; zone: AppDnsZone; onRenewal: (zone: string, r: AppRenewal) => void }) {
  const site = useContext(AppSite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = zone.renewal;
  if (!r) return null;
  const cost = r.cents !== null ? (r.years > 1 ? `${money(r.cents)} every ${r.years} years` : `${money(r.cents)} a year`) : null;
  const whose = r.payer === "member" ? "a teammate's" : "your";
  const words =
    r.state === "expired"
      ? `Expired${r.expires ? ` ${day(r.expires)}` : ""}.`
      : r.state === "renewing"
        ? "Renewing now."
        : r.on
          ? `Renews${r.expires ? ` ${day(r.expires)}` : ""}${r.cents !== null ? ` for ${money(r.cents)}` : ""}, from ${whose} Orgo credits.`
          : `Expires${r.expires ? ` ${day(r.expires)}` : ""}.${cost ? ` Auto-renew pays ${cost} from your Orgo credits.` : ""}`;
  const flip = () => {
    setBusy(true);
    setError(null);
    void setAutoRenew(ws, name, zone.id, !r.on, site).then((x) => {
      setBusy(false);
      if (x.ok?.renewal) onRenewal(zone.id, x.ok.renewal);
      else setError(x.no?.error ?? "Couldn't change auto-renew. Try again.");
    });
  };
  return (
    <div data-renewal={zone.domain} className="flex flex-col gap-0.5">
      <div className="flex min-h-7 items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] leading-4 text-[#6B6B6B]">{words}</span>
        {r.state !== "expired" && (
          <button
            role="switch"
            aria-checked={r.on}
            aria-label="Auto-renew"
            data-tip={r.on ? "Turn it off: it expires at the end of its term." : `Turn it on: its renewals are paid from your Orgo credits.`}
            disabled={busy}
            onClick={flip}
            className="flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[12px] leading-4 text-ink hover:bg-black/[0.04] disabled:opacity-50"
          >
            <span className={`relative h-4 w-7 rounded-full transition-colors ${r.on ? "bg-ink" : "bg-[#D9D9D6]"}`}>
              <span className={`absolute top-0.5 size-3 rounded-full bg-white transition-all ${r.on ? "left-3.5" : "left-0.5"}`} />
            </span>
            Auto-renew
          </button>
        )}
      </div>
      {r.error && <span className="text-[12px] leading-4 text-[#B54708]">{r.error}</span>}
      {error && (
        <span role="alert" className={ALERT}>
          {error}
        </span>
      )}
    </div>
  );
}

/* ---------------- Adding a domain ---------------- */

/** One name a search found, as its line says it: its price for its term and each year after, or why it can't be bought. */
const offerWords = (o: DomainOffer) =>
  o.status === "available" && o.price !== null
    ? `${priceFor(o.price, o.years)}${o.renewal !== null ? `, then ${money(o.renewal)} a year` : ""}`
    : o.status === "taken"
      ? "Taken"
      : o.status === "premium"
        ? "Not sold here"
        : "Couldn't tell";

/**
 * Add a domain, under its domains: the workspace's bought domains nothing points at yet, to use as they are;
 * then two ways. Get a new domain: a search, a name picked from it with its price, who it's registered to (as
 * the registry requires it, filled from what Orgo has of the user's last one, else their email), then a last
 * step with the exact charge in Orgo credits and what it renews for, and Buy (which sends that price: Orgo
 * refuses it if the price changed, and the step shows the new one to buy at). Use a domain I own: typed, then
 * pointed here, with the records to set shown on its line. `onAdded`: the app's domains as they are now, and
 * the one added (null: bought but not pointed here, with why).
 */
export function AddDomain({
  ws,
  name,
  email,
  onAdded,
  onClose,
}: {
  ws: string;
  name: string;
  /** The signed-in account's email, to fill who a domain is registered to when Orgo has nothing of theirs. */
  email?: string | null;
  onAdded: (domains: AppDomainsAnswer, added: AppDomain | null) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<AppDomainOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState<string | null>(null);
  const [mode, setMode] = useState<"buy" | "own" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refused | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<(DomainSearchAnswer & { q: string }) | null>(null);
  const [offer, setOffer] = useState<DomainOffer | null>(null);
  const [who, setWho] = useState<Registrant>({});
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [reads, setReads] = useState(0);
  const site = useContext(AppSite);
  useEffect(() => {
    let stop = false;
    void readDomainOptions(ws, name, site).then((r) => {
      if (stop) return;
      if (r.ok) setOptions(r.ok);
      else setOptionsFailed(r.no.error);
    });
    return () => {
      stop = true;
    };
  }, [ws, name, site, reads]);
  const buyOpen = !!options?.buy.open;
  const shown = mode ?? (options && !buyOpen ? "own" : "buy");
  const done = (r: AppDomainAdded) => {
    onAdded(r.domains, r.domain);
    if (r.domain) return onClose();
    // Bought, but not pointed here: it's among the workspace's own now, to use from there.
    setError({ error: undash(r.error ?? "Couldn't point it at this app just now.") });
    setOffer(null);
    setConfirming(false);
    setReads((n) => n + 1);
  };
  const send = (body: AppDomainAdd, after?: (no: Refused) => void) => {
    setBusy(true);
    setError(null);
    void addDomain(name, site ? { ...body, site } : body).then((r) => {
      setBusy(false);
      if (r.ok) return done(r.ok);
      setError(r.no);
      after?.(r.no);
    });
  };
  const search = (page = 0) => {
    const words = q.trim();
    if (!words) return;
    setBusy(true);
    setError(null);
    void searchDomains(ws, name, words, page, site).then((r) => {
      setBusy(false);
      if (!r.ok) return setError(r.no);
      setFound((was) => (page && was && was.q === words ? { ...r.ok, q: words, results: [...was.results, ...r.ok.results] } : { ...r.ok, q: words }));
    });
  };
  const pick = (o: DomainOffer) => {
    setOffer(o);
    setConfirming(false);
    setError(null);
    // Who it's registered to: what Orgo has of the last one, else the account's email. Never a guess.
    setWho((w) => (Object.keys(w).length ? w : (options?.contact ?? (email ? { email } : {}))));
  };
  const missing = REGISTRANT_FIELDS.find((f) => !("optional" in f && f.optional) && !(who[f.key] ?? "").trim());
  const buy = () => {
    if (!offer || offer.price === null) return;
    send({ ws, action: "buy", domain: offer.domain, registrant: who, price: offer.price }, (no) => {
      // A new price: the step shows it, to buy at that one. Who it's registered to, wrong: back to that.
      if (no.code === "PRICE_CHANGED" && typeof no.price === "number") setOffer({ ...offer, price: no.price, renewal: no.renewal ?? offer.renewal, years: no.years ?? offer.years });
      else if (no.code === "INVALID_REGISTRANT") setConfirming(false);
      else if (no.code === "DOMAIN_TAKEN" || no.code === "DOMAIN_UNAVAILABLE") {
        setOffer(null);
        setConfirming(false);
      }
    });
  };
  const tab = (m: "buy" | "own", label: string) => (
    <button
      role="tab"
      aria-selected={shown === m}
      disabled={busy}
      onClick={() => {
        setMode(m);
        setError(null);
      }}
      className={`${PILL} ${shown === m ? "bg-ink text-white" : "text-[#3A3A38] hover:bg-[#F2F2F0]"}`}
    >
      {label}
    </button>
  );
  const why = error && (
    <span role="alert" className={ALERT}>
      {error.error}
    </span>
  );
  let body: ReactNode;
  if (shown === "own")
    body = (
      <form
        data-own-domain
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && typed.trim()) send({ ws, action: "connect", domain: typed.trim() });
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Your domain"
            aria-invalid={error?.field === "domain" || undefined}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            placeholder="app.example.com"
            autoComplete="off"
            spellCheck={false}
            className={field(error?.field === "domain", "min-w-[160px] flex-1 font-mono")}
          />
          <button type="submit" disabled={busy || !typed.trim()} className={dark()}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
        <span className={HINT}>You set its DNS records where the domain is kept. They show here once it&apos;s connected.</span>
        {why}
      </form>
    );
  else if (!options) body = <span className={QUIET}>{optionsFailed ?? "Reading…"}</span>;
  else if (!buyOpen) body = <span className={QUIET}>{options.buy.why ?? "Buying domains isn't open here."}</span>;
  else if (offer && offer.price !== null && confirming)
    body = (
      <div data-confirm={offer.domain} className="flex flex-col gap-2">
        <span className="text-[12.5px] leading-[18px] text-ink">
          Buy <span className="font-mono font-medium">{offer.domain}</span> for <b>{money(offer.price)}</b> from your Orgo credits
          {offer.years && offer.years > 1 ? `, for ${offer.years} years` : ", for a year"}.
          {offer.renewal !== null ? ` Then it renews for ${money(offer.renewal)} a year from your credits, with auto-renew on. You can turn that off here.` : ""}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button data-buy onClick={buy} disabled={busy} className={dark()}>
            {busy ? "Buying…" : `Buy for ${money(offer.price)}`}
          </button>
          <button disabled={busy} onClick={() => setConfirming(false)} className={light()}>
            Back
          </button>
          {why}
        </div>
      </div>
    );
  else if (offer && offer.price !== null)
    body = (
      <form
        data-registrant={offer.domain}
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing) {
            setError(null);
            setConfirming(true);
          }
        }}
        className="flex flex-col gap-2"
      >
        <span className="text-[12.5px] leading-[18px] text-ink">
          Who <span className="font-mono font-medium">{offer.domain}</span> is registered to. The registry needs it, and Orgo keeps it private.
        </span>
        <div className="flex flex-wrap gap-2">
          {REGISTRANT_FIELDS.map((f) => (
            <input
              key={f.key}
              aria-label={f.label}
              aria-invalid={error?.field === f.key || undefined}
              value={who[f.key] ?? ""}
              onChange={(e) => {
                const v = f.key === "country" ? e.target.value.toUpperCase() : e.target.value;
                setWho((w) => ({ ...w, [f.key as RegistrantField]: v.slice(0, f.max) }));
                if (error) setError(null);
              }}
              placeholder={"optional" in f && f.optional ? `${f.label} (optional)` : f.key === "country" ? "Country, like US" : f.key === "phone" ? "Phone, like +1 415 555 0123" : f.label}
              autoComplete="off"
              className={field(error?.field === f.key, f.key === "country" || f.key === "postal_code" ? "w-[132px]" : "min-w-[150px] flex-1")}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy || !!missing} className={dark()}>
            Continue
          </button>
          <button type="button" disabled={busy} onClick={() => setOffer(null)} className={light()}>
            Back
          </button>
          {why ?? (missing && <span className={HINT}>{missing.label} is needed.</span>)}
        </div>
      </form>
    );
  else
    body = (
      <div className="flex flex-col gap-2">
        <form
          data-domain-search
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) search();
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            aria-label="Search for a domain"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="A name, like acme"
            autoComplete="off"
            spellCheck={false}
            className={field(error?.field === "q", "min-w-[160px] flex-1 font-mono")}
          />
          <button type="submit" disabled={busy || !q.trim()} className={dark()}>
            {busy && !found ? "Searching…" : "Search"}
          </button>
        </form>
        {found && (
          <div className="-mx-1 flex flex-col">
            {!found.results.length && <span className={QUIET}>Nothing found for that. Try another name.</span>}
            {found.results.map((o) => {
              const can = o.status === "available" && o.price !== null;
              return (
                <div key={o.domain} data-offer={o.domain} className="flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-1 py-1">
                  <span title={o.domain} className={`min-w-[72px] flex-1 truncate font-mono text-[12px] leading-4 ${can ? "text-ink" : "text-[#9A9A98]"}`}>
                    {o.domain}
                  </span>
                  {/* Wraps under itself in a narrow panel, never past its edge. */}
                  <span className={`max-w-[60%] text-right text-[12px] leading-4 ${can ? "text-[#3A3A38]" : "text-[#9A9A98]"}`}>{offerWords(o)}</span>
                  {can && (
                    <button onClick={() => pick(o)} disabled={busy} className={`${PILL} shrink-0 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-white`}>
                      Pick
                    </button>
                  )}
                </div>
              );
            })}
            {found.partial && <span className={HINT}>Some endings didn&apos;t answer just now.</span>}
            {found.next !== null && (
              <button onClick={() => search(found.next ?? 0)} disabled={busy} className="mt-0.5 h-7 self-start rounded-lg px-1 text-[12px] leading-4 text-[#6B6B6B] hover:text-ink disabled:text-[#9A9A98]">
                {busy ? "Reading…" : "Show more"}
              </button>
            )}
          </div>
        )}
        {why}
      </div>
    );
  return (
    <div data-add-domain-panel onKeyDown={escCloses(busy, onClose)} className={`mt-1 ${BOX}`}>
      {!!options?.owned.length && (
        <div data-owned className="flex flex-col">
          <span className="text-[12px] leading-[18px] text-[#6B6B6B]">Your domains not in use:</span>
          {options.owned.map((o) => (
            <div key={o.id} data-owned-domain={o.domain} className="flex h-8 min-w-0 items-center gap-2">
              <span title={o.domain} className="min-w-0 shrink truncate font-mono text-[12px] leading-4 text-ink">
                {o.domain}
              </span>
              <span className="flex-1" />
              <button onClick={() => send({ ws, action: "connect", zone: o.id })} disabled={busy} className={`${PILL} shrink-0 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-white`}>
                Use
              </button>
            </div>
          ))}
        </div>
      )}
      <div role="tablist" className="flex flex-wrap items-center gap-1">
        {tab("buy", "Get a new domain")}
        {tab("own", "Use a domain I own")}
        <span className="flex-1" />
        <button aria-label="Close" disabled={busy} onClick={onClose} className="flex size-6 shrink-0 items-center justify-center rounded-md text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 2l6 6M8 2L2 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {body}
    </div>
  );
}

/* ---------------- Its settings and variables ---------------- */

const COMMANDS = [
  { key: "install", label: "Install" },
  { key: "build", label: "Build" },
  { key: "start", label: "Start" },
] as const;

/** The settings form as `s` has them (none yet: all empty, for Orgo's own). */
const formOf = (s: AppSettingsAnswer["settings"]) => ({
  port: s?.port !== null && s?.port !== undefined ? String(s.port) : "",
  install: s?.install ?? "",
  build: s?.build ?? "",
  start: s?.start ?? "",
  health: s?.health && s.health !== "/" ? s.health : "",
});

/**
 * Its settings: its port, its install, build and start commands (empty for the ones Orgo finds itself) and
 * its health check's path (empty for "/", Orgo's own), saved together (only what changed is sent); a new
 * port builds it again and its domains move with it. Then its variables (Variables). Of the site picked
 * (AppSite), for an app with more than one. Before its first deploy (no settings yet) they're there to set
 * too, empty: the first save makes its deploy project with them (nothing deployed), so its first build has
 * them, as a second site from the same repo is started its own way.
 */
export function AppSettingsSection({ ws, name, answer, onSaved }: { ws: string; name: string; answer: AppSettingsAnswer; onSaved: (a: AppSettingsAnswer) => void }) {
  const site = useContext(AppSite);
  const s = answer.settings;
  const first = !s;
  const start = formOf(s);
  const [form, setForm] = useState(start);
  const [was, setWas] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refused | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // What was read changed (another window, a refresh): the form follows, unless it's being typed in.
  const key = JSON.stringify(start);
  if (key !== JSON.stringify(was)) {
    setWas(start);
    if (JSON.stringify(form) === JSON.stringify(was)) setForm(start);
  }
  const changed = (Object.keys(start) as (keyof typeof start)[]).filter((k) => form[k].trim() !== start[k].trim());
  const save = () => {
    if (!changed.length || busy) return;
    setBusy(true);
    setError(null);
    setSaid(null);
    const c: AppSettingsChange = site ? { ws, site } : { ws };
    for (const k of changed) c[k] = form[k].trim();
    void saveSettings(name, c).then((r) => {
      setBusy(false);
      if (!r.ok) return setError(r.no);
      setSaid(r.ok.said ? undash(r.ok.said) : first ? "Saved. Its first deploy has them." : changed.includes("port") ? "Saved. It's being built again for the new port." : "Saved. It applies from its next deploy.");
      // The form as it's saved (its port too, the one Orgo gave a first one).
      const now = formOf(r.ok.settings);
      setForm(now);
      setWas(now);
      onSaved(r.ok);
    });
  };
  const set = (k: keyof typeof start) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setError(null);
    setSaid(null);
  };
  return (
    <div data-settings data-first={first || undefined} className="flex flex-col">
      <span className={HEAD}>Settings</span>
      {first && <span className={`pb-1 ${HINT}`}>Set them now and its first deploy has them. Orgo finds what&apos;s left empty, and keeps the variables&apos; values secret.</span>}
      <form
        data-settings-form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-1.5"
      >
        <label className="flex min-w-0 items-center gap-2">
          <span className="w-[64px] shrink-0 text-[12px] leading-4 text-[#6B6B6B]">Port</span>
          <input
            aria-label="Port"
            aria-invalid={error?.field === "port" || undefined}
            value={form.port}
            onChange={set("port")}
            inputMode="numeric"
            placeholder={first ? "Next free" : undefined}
            className={field(error?.field === "port", "w-[96px] font-mono")}
          />
        </label>
        {COMMANDS.map((c) => (
          <label key={c.key} className="flex min-w-0 items-center gap-2">
            <span className="w-[64px] shrink-0 text-[12px] leading-4 text-[#6B6B6B]">{c.label}</span>
            <input
              aria-label={`${c.label} command`}
              aria-invalid={error?.field === c.key || undefined}
              value={form[c.key]}
              onChange={set(c.key)}
              placeholder="Orgo finds it"
              autoComplete="off"
              spellCheck={false}
              className={field(error?.field === c.key, "flex-1 font-mono")}
            />
          </label>
        ))}
        <label className="flex min-w-0 items-center gap-2">
          <span data-tip="The path Orgo asks for to check a new release answers before it goes live" className="w-[64px] shrink-0 text-[12px] leading-4 text-[#6B6B6B]">
            Health
          </span>
          <input
            aria-label="Health check path"
            aria-invalid={error?.field === "health" || undefined}
            value={form.health}
            onChange={set("health")}
            placeholder="/"
            autoComplete="off"
            spellCheck={false}
            className={field(error?.field === "health", "flex-1 font-mono")}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button type="submit" disabled={busy || !changed.length} className={dark()}>
            {busy ? "Saving…" : "Save"}
          </button>
          {changed.length > 0 && !busy && (
            <button
              type="button"
              onClick={() => {
                setForm(start);
                setError(null);
              }}
              className={light()}
            >
              Undo
            </button>
          )}
          {error ? (
            <span role="alert" className={ALERT}>
              {error.error}
            </span>
          ) : (
            said && <span className={HINT}>{said}</span>
          )}
        </div>
      </form>
      <Variables ws={ws} name={name} names={answer.env} onSaved={(env) => onSaved({ ...answer, env })} first={first} />
    </div>
  );
}

/** A variable's value, typed: hidden as it's typed unless Show is pressed. */
function SecretInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <span className="flex min-w-[160px] flex-1 items-center gap-1">
      <input
        aria-label="Value"
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Its value"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        className={field(false, "min-w-0 flex-1 font-mono")}
      />
      <button type="button" onClick={() => setShow(!show)} aria-pressed={show} className="shrink-0 rounded-full px-2 py-1 text-[12px] leading-4 text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink">
        {show ? "Hide" : "Show"}
      </button>
    </span>
  );
}

/**
 * Its variables, one line each: the name, and its value hidden (Orgo keeps it encrypted and never gives it
 * back, so there's nothing to show: a new one is typed to change it). Add variable, Change and Remove (asked
 * once more first). A value lives only in its form while it's typed, and goes once Save is pressed. `first`:
 * before its first deploy (the first one saved makes its deploy project with it).
 */
function Variables({ ws, name, names, onSaved, first }: { ws: string; name: string; names: string[]; onSaved: (env: string[]) => void; first?: boolean }) {
  const site = useContext(AppSite);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refused | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const close = () => {
    setEditing(null);
    setRemoving(null);
    setNewName("");
    setValue("");
    setError(null);
  };
  const send = (env: Record<string, string | null>) => {
    setBusy(true);
    setError(null);
    void saveEnv(name, site ? { ws, site, env } : { ws, env }).then((r) => {
      setBusy(false);
      if (!r.ok) return setError(r.no);
      close();
      setSaid(first ? "Saved. Its first deploy has it." : "Saved. Variables apply from its next deploy.");
      onSaved(r.ok.env);
    });
  };
  const nameWrong = !!newName && (!ENV_NAME.test(newName) || ENV_RESERVED.has(newName));
  const form = (fixed: string | null) => (
    <form
      data-env-form={fixed ?? "new"}
      onSubmit={(e) => {
        e.preventDefault();
        const k = fixed ?? newName;
        if (!busy && k && !nameWrong && value) send({ [k]: value });
      }}
      onKeyDown={escCloses(busy, close)}
      className="flex flex-wrap items-center gap-2 py-1"
    >
      {fixed ? (
        <span className="shrink-0 font-mono text-[12px] leading-4 text-ink">{fixed}</span>
      ) : (
        <input
          aria-label="Name"
          aria-invalid={nameWrong || error?.field === "name" || undefined}
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value.toUpperCase().replace(/[\s-]+/g, "_"));
            setError(null);
          }}
          placeholder="NAME"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className={field(nameWrong || error?.field === "name", "w-[150px] font-mono")}
        />
      )}
      <SecretInput value={value} onChange={setValue} autoFocus={!!fixed} />
      <button type="submit" disabled={busy || !value || (!fixed && (!newName || nameWrong))} className={dark()}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" disabled={busy} onClick={close} className={light()}>
        Cancel
      </button>
      {nameWrong && !error && <span className={HINT}>{ENV_RESERVED.has(newName) ? `${newName} is set by Orgo.` : "Capital letters, digits and underscores."}</span>}
    </form>
  );
  return (
    <div data-env className="mt-3 flex flex-col">
      <span className="text-[12px] leading-[18px] text-[#6B6B6B]">Variables</span>
      <div className="-mx-2 flex flex-col">
        {names.map((k) =>
          editing === k ? (
            <div key={k} className="px-2">
              {form(k)}
            </div>
          ) : (
            <div key={k} className="flex flex-col">
              <div data-env-name={k} className="group flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 hover:bg-[#F6F6F4]">
                <span title={k} className="min-w-0 shrink truncate font-mono text-[12px] leading-4 text-ink">
                  {k}
                </span>
                <span data-tip="Orgo keeps its value secret and never shows it again. Change it to type a new one." className="shrink-0 font-mono text-[12px] leading-4 text-[#9A9A98]">
                  ••••••••
                </span>
                <span className="flex-1" />
                <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                  <button
                    aria-label={`Change ${k}`}
                    data-tip="Change"
                    disabled={busy}
                    onClick={() => {
                      close();
                      setEditing(k);
                      setSaid(null);
                    }}
                    className={rowIconBtn}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    aria-label={`Remove ${k}`}
                    data-tip="Remove"
                    disabled={busy}
                    onClick={() => {
                      close();
                      setRemoving(k);
                      setSaid(null);
                    }}
                    className={rowTrashBtn}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>
              {removing === k && (
                <div className="px-2 pb-1" onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}>
                  <InlineConfirm text={`Remove ${k}? The app goes without it from its next deploy.`} action="Remove" doing="Removing…" busy={busy} onConfirm={() => send({ [k]: null })} onCancel={close} />
                </div>
              )}
            </div>
          ),
        )}
      </div>
      {editing === "new" ? (
        form(null)
      ) : (
        <button
          data-add-env
          onClick={() => {
            close();
            setEditing("new");
            setSaid(null);
          }}
          disabled={busy}
          className="-mx-2 mt-0.5 flex h-7 items-center gap-1.5 self-start rounded-lg px-2 text-[12px] leading-4 text-[#6B6B6B] hover:bg-[#F6F6F4] hover:text-ink disabled:text-[#9A9A98]"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M5 1.5v7M1.5 5h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Add variable
        </button>
      )}
      {error ? (
        <span role="alert" className={`pt-1 ${ALERT}`}>
          {error.error}
        </span>
      ) : (
        said && <span className={`pt-1 ${HINT}`}>{said}</span>
      )}
    </div>
  );
}

/* ---------------- Its deploys ---------------- */

/**
 * What a deploy's line says of it: Live only for the one its site serves now (one put back says so); one that
 * went live and was replaced since, Was live; else its state.
 */
const deployWords = (d: AppDeploy) =>
  d.live ? (d.rollback ? "Live, put back" : "Live") : d.state === "succeeded" ? "Was live" : (STATES[d.state]?.word ?? d.state);

/** Its dot: green only for the one live now; one that was live, grey; else its state's. */
const deployDot = (d: AppDeploy) => (d.live ? "bg-[#2BB673]" : d.state === "succeeded" ? "bg-[#C9C9C6]" : (STATES[d.state]?.dot ?? "bg-[#9A9A98]"));

/**
 * Its recent deploys, newest first, one line each: the changeset it built, how it went, when; only the one
 * live now says Live (green), one live before it says Was live (grey), with Roll back when it's still on the
 * computer (put back without a build). The newest one's log under them (`log`).
 */
export function AppDeploys({ ws, app, deploys, onChanged, log }: { ws: string; app: HostedApp; deploys: AppDeploy[]; onChanged: (app: HostedApp) => void; log?: ReactNode }) {
  const site = useContext(AppSite);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!deploys.length && !log) return null;
  const back = (d: AppDeploy) => {
    setBusy(d.id);
    setError(null);
    void act(app.name, site ? { ws, action: "rollback", deployment: d.id, site } : { ws, action: "rollback", deployment: d.id }).then((r) => {
      setBusy(null);
      if (r.app) onChanged(r.app);
      else setError(undash(r.error ?? "Couldn't roll back. Try again."));
    });
  };
  const running = app.live?.state === "queued" || app.live?.state === "running";
  return (
    <div data-deploys className="flex flex-col">
      <span className={HEAD}>Deploys</span>
      {!!deploys.length && (
        <div className="-mx-2 flex flex-col">
          {deploys.map((d) => (
            <div key={d.id} data-deploy={d.id} data-state={d.state} className="group flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 hover:bg-[#F6F6F4]">
              <span className={`size-2 shrink-0 rounded-full ${deployDot(d)}`} />
              <span title={d.at ?? undefined} className="w-[52px] shrink-0 font-mono text-[11.5px] leading-4 text-[#6B6B6B]">
                {d.at ? short(d.at) : "·"}
              </span>
              <span title={d.error ?? undefined} className={`min-w-0 flex-1 truncate text-[12.5px] leading-4 ${d.state === "failed" ? "text-[#B42318]" : d.live ? "font-medium text-ink" : "text-[#6B6B6B]"}`}>
                {deployWords(d)}
                {d.state === "failed" && d.error ? `: ${d.error}` : ""}
              </span>
              {d.when ? <span className="w-8 shrink-0 text-right text-[12px] leading-4 text-[#9A9A98]">{ago(d.when)}</span> : null}
              {!d.live && d.canRollback ? (
                <span className="flex w-[78px] shrink-0 justify-end opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                  <span data-tip={running ? "A deploy is running. Wait for it to finish." : "Put this one live again, without a build"} className="flex">
                    <button
                      disabled={!!busy || running}
                      onClick={() => back(d)}
                      className="whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-white disabled:text-[#9A9A98] disabled:shadow-[0_0_0_1px_#ECECEA]"
                    >
                      {busy === d.id ? "Rolling back…" : "Roll back"}
                    </button>
                  </span>
                </span>
              ) : (
                <span className="w-[78px] shrink-0" />
              )}
            </div>
          ))}
        </div>
      )}
      {error && (
        <span role="alert" className={`pt-1 ${ALERT}`}>
          {error}
        </span>
      )}
      {log}
    </div>
  );
}

/* ---------------- Its end: Add a site, Remove one, Remove app ---------------- */

/**
 * Its end: Add a site (one more from the same repo on the same computer, with its own address, port and
 * variables: a name, as its address takes it), Remove the site picked (`site`, one of its others: its
 * domains and its deploy come off its computer; the code stays the app's), and Remove app (its sites and
 * their domains off the web, and the app out of the workspace; its code in Ingot too only when that's
 * ticked). Each removal is asked once more first, says only what of it is on the web, and waits while a
 * deploy of it is being sent. `onPicked`: a site just added is picked; `onRemoved`: the app is gone, with
 * the domains Orgo kept on its computer said.
 */
export function AppEnd({
  ws,
  app,
  site,
  onChanged,
  onRemoved,
  onPicked,
}: {
  ws: string;
  app: HostedApp;
  site?: string;
  onChanged: (app: HostedApp) => void;
  onRemoved: (said?: string) => void;
  onPicked: (site: string) => void;
}) {
  useSending();
  const [open, setOpen] = useState<"add" | "site" | "app" | null>(null);
  const [typed, setTyped] = useState("");
  const [repo, setRepo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refused | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const count = app.sites?.length ?? 1;
  const full = count >= MAX_SITES;
  const close = () => {
    setOpen(null);
    setTyped("");
    setRepo(false);
    setError(null);
  };
  const ask = (which: "add" | "site" | "app") => {
    close();
    setSaid(null);
    setOpen(which);
  };
  const nameWrong = !!typed && (!isSiteName(typed) || typed === app.name || !!app.sites?.some((x) => x.name === typed));
  const add = () => {
    if (busy || !typed || nameWrong) return;
    setBusy(true);
    setError(null);
    void act(app.name, { ws, action: "addSite", site: typed }).then((r) => {
      setBusy(false);
      if (!r.app) return setError({ error: undash(r.error ?? "Couldn't add it. Try again."), ...(r.field ? { field: r.field } : {}) });
      onChanged(r.app);
      onPicked(typed);
      close();
      setSaid(`Added ${typed}. Set its settings and variables, then deploy it.`);
    });
  };
  const dropSite = () => {
    if (!site) return;
    setBusy(true);
    setError(null);
    void act(app.name, { ws, action: "removeSite", site }).then((r) => {
      setBusy(false);
      if (!r.app) return setError({ error: undash(r.error ?? "Couldn't remove it. Try again.") });
      onChanged(r.app);
      onPicked(app.name);
      close();
      setSaid(r.said ? undash(r.said) : `Removed ${site}.`);
    });
  };
  const dropApp = () => {
    setBusy(true);
    setError(null);
    void removeApp(ws, app.name, repo).then((r) => {
      setBusy(false);
      if (!r.ok) return setError({ error: r.error ?? "Couldn't remove it. Try again." });
      close();
      onRemoved(r.ok.said ? undash(r.ok.said) : undefined);
    });
  };
  const lost = !!app.hosting?.lost;
  // What comes off the web: only the sites deployed (each has its project), never ones that never were.
  const live = lost ? [] : app.sites ? app.sites.filter((x) => x.projectId).map((x) => x.name) : app.hosting?.projectId ? [app.name] : [];
  const offWeb =
    live.length > 1 ? `Its ${live.length} sites and their domains come off the web, and it leaves` : live.length ? `${count > 1 ? live[0] : "Its site"} and its domains come off the web, and it leaves` : "It leaves";
  // (Not while a deploy of it is being sent: it would put a site back on the web as it goes.)
  const wait = isSending(app.name) ? "A deploy is being sent. Wait for it." : undefined;
  return (
    <div data-app-end className="flex flex-col gap-1.5 border-t border-[#F0F0EE] pt-3">
      {open === "add" ? (
        <form
          data-add-site-form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          onKeyDown={escCloses(busy, close)}
          className={BOX}
        >
          <span className="text-[12.5px] leading-[17px] text-[#3A3A38]">Another site from the same code, on the same computer, with its own address, port and variables.</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Site name"
              aria-invalid={nameWrong || error?.field === "site" || undefined}
              value={typed}
              onChange={(e) => {
                setTyped(typedAppName(e.target.value).slice(0, 32));
                setError(null);
              }}
              placeholder={`${app.name.slice(0, 24)}-admin`}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className={field(nameWrong || error?.field === "site", "w-[220px] font-mono")}
            />
            <button type="submit" disabled={busy || !typed || nameWrong} className={dark()}>
              {busy ? "Adding…" : "Add"}
            </button>
            <button type="button" disabled={busy} onClick={close} className={light()}>
              Cancel
            </button>
          </div>
          <span className={HINT}>
            {nameWrong
              ? typed === app.name || app.sites?.some((x) => x.name === typed)
                ? "It has a site by that name."
                : "Lowercase letters, numbers and single hyphens."
              : typed
                ? `Its address is ${typed}.orgo.dev once it's live, if no one has it.`
                : "Its name is its address on Orgo, so it can't be renamed."}
          </span>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span data-tip={full ? `An app can have ${MAX_SITES} sites at most.` : "Another site from the same code, with its own address, port and variables"} className="flex">
            <button data-add-site disabled={busy || full} onClick={() => ask("add")} className={`${light()} disabled:opacity-50`}>
              Add a site
            </button>
          </span>
          {site && (
            <span data-tip={wait} className="flex">
              <button data-remove-site disabled={busy || !!wait} onClick={() => ask("site")} className={`${light()} disabled:opacity-50`}>
                Remove {site}
              </button>
            </span>
          )}
          <span className="flex-1" />
          <span data-tip={wait} className="flex">
            <button data-remove-app disabled={busy || !!wait} onClick={() => ask("app")} className={`${PILL} text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50`}>
              Remove app
            </button>
          </span>
        </div>
      )}
      {open === "site" && site && (
        <InlineConfirm text={`Remove ${site}? It comes off the web with its domains. The code stays the app's.`} action="Remove" doing="Removing…" busy={busy} onConfirm={dropSite} onCancel={close} />
      )}
      {open === "app" && (
        <InlineConfirm
          text={`Remove ${app.name}? ${offWeb} this workspace.`}
          action="Remove"
          doing="Removing…"
          busy={busy}
          onConfirm={dropApp}
          onCancel={close}
          extra={
            <label className="flex items-center gap-2 text-[12px] leading-4 text-[#3A3A38]">
              <input type="checkbox" checked={repo} disabled={busy} onChange={(e) => setRepo(e.target.checked)} className="size-3.5 accent-[#0A0A0A]" />
              Delete its code in Ingot too, with all its history. This can&apos;t be undone.
            </label>
          }
        />
      )}
      {error ? (
        <span role="alert" className={ALERT}>
          {error.error}
        </span>
      ) : (
        said && <span className={HINT}>{said}</span>
      )}
    </div>
  );
}
