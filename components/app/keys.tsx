"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AppApproval, AppState, Bot, Message } from "@/lib/types";
import { Mascot } from "./mascot";
import { KeyIcon } from "./screen-cards";
import { undash } from "./side-group";
import { post, teamOf } from "./ui";

/*
 * Keys (lib/server/keys.ts): the user's API keys their bots may call services with. They're kept in the
 * user's Orgo vault, the same one as Orgo's Settings, Secrets (account scope, "All workspaces" there), by
 * the vault's own names (STRIPE_SECRET_KEY). Bops never has one to show: a value goes to Orgo once, on
 * Save, and only which bots may use which key (Bot.keys) is kept here, in the state.
 */

type Provider = { name: string; label: string; where: string; tip: string; readOnly: boolean };
type KeyRow = Provider & { updatedAt: string | null; bots: string[] };
type KeysInfo = { signedIn: boolean; keys: KeyRow[]; providers: Provider[]; error?: string };

/** Every Keys list on the page, so a save or a remove in Settings shows on a bot's profile too. */
const readers = new Set<() => void>();
const keysChanged = () => readers.forEach((f) => f());

/** GET /api/keys: the services Bops can call and the keys in the vault (names only). `failed` when it didn't answer. */
function useKeys() {
  const [info, setInfo] = useState<KeysInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const read = useCallback((fresh = false) => {
    void fetch(`/api/keys${fresh ? "?fresh=1" : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as Partial<KeysInfo>;
        if (r.ok && Array.isArray(j.keys) && Array.isArray(j.providers)) {
          setInfo(j as KeysInfo);
          setFailed(null);
        } else setFailed(undash(j.error ?? "Couldn't read your keys."));
      })
      .catch(() => setFailed("Couldn't reach Bops."));
  }, []);
  useEffect(() => {
    read();
    const again = () => read(true);
    readers.add(again);
    return () => void readers.delete(again);
  }, [read]);
  return { info, failed, retry: () => read(true) };
}

/** "Oct 15", as Orgo's Secrets shows when a secret was set. */
const setOn = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null);

const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";

/** A bot that may use a key, or may not: tap to change it. */
function BotChip({ bot: b, on, disabled, tip, onClick }: { bot: Bot; on: boolean; disabled?: boolean; tip: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-[26px] items-center gap-1.5 rounded-full pl-1 pr-2.5 text-[12px] font-medium leading-4 disabled:opacity-50 ${on ? "bg-[#FBFFE0] text-ink shadow-[0_0_0_1.5px_#0A0A0A]" : "text-[#6B6B6B] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"}`}
    >
      <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
      {b.name}
    </button>
  );
}

/** PATCH /api/keys: let a bot use a key, or stop it. The chips read Bot.keys, so the state's refresh shows it. */
async function grant(name: string, botId: string, allowed: boolean): Promise<string | null> {
  try {
    const res = await post("/api/keys", { name, botId, allowed }, "PATCH");
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? null : undash(j.error ?? "That didn't change. Try again.");
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/* ---------------- Settings ---------------- */

/**
 * Keys in Settings: each key in the vault (its service, its vault name, where it applies, when it was set),
 * the bots that may use it (tap to change), Replace and Remove; and Add key. `keysFor`: opened from a bot's
 * profile to add one for that bot, so it comes into view with the form open and that bot picked.
 */
export function KeysSettings({ state, keysFor }: { state: AppState; keysFor?: string }) {
  const { info, failed, retry } = useKeys();
  const team = teamOf(state);
  const main = team.find((b) => b.isMain) ?? team[0];
  const picked = keysFor && team.some((b) => b.id === keysFor) ? keysFor : main?.id;
  // The form: a new key (for these bots), or a new value for a saved one.
  const [form, setForm] = useState<{ replace?: KeyRow; bots: string[] } | null>(keysFor ? { bots: picked ? [picked] : [] } : null);
  const [saved, setSaved] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const loaded = !!info;
  useEffect(() => {
    if (keysFor && loaded) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [keysFor, loaded]);
  const done = (label: string) => {
    setForm(null);
    setSaved(`${label} key saved to your Orgo vault.`);
    setTimeout(() => setSaved(null), 2500);
  };
  const add = () => setForm({ bots: main ? [main.id] : [] });

  let body: React.ReactNode;
  if (!info)
    body = failed ? (
      <span role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] leading-[18px] text-[#6B6B6B]">
        {failed}
        <button onClick={retry} className="font-medium text-ink underline-offset-2 hover:underline">
          Try again
        </button>
      </span>
    ) : (
      <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">Checking</span>
    );
  else if (!info.signedIn) body = <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{undash(info.error ?? "Sign in to Orgo to use Keys.")}</span>;
  else if (!info.keys.length && !form)
    body = (
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{saved ?? "No keys yet."}</span>
        <button onClick={add} className={`${btn} bg-ink text-white`}>
          Add key
        </button>
      </div>
    );
  else
    body = (
      <>
        {info.keys.map((k) => (
          <Fragment key={k.name}>
            <KeyLine k={k} team={team} onReplace={() => setForm({ replace: k, bots: [] })} />
            {/* A new value for this key, right under it. */}
            {form?.replace?.name === k.name && <AddKey info={info} team={team} replace={k} bots={[]} first={false} onSaved={done} onCancel={() => setForm(null)} />}
          </Fragment>
        ))}
        {form?.replace ? null : form ? (
          <AddKey info={info} team={team} bots={form.bots} first={!info.keys.length} onSaved={done} onCancel={() => setForm(null)} />
        ) : (
          <div className="flex items-center gap-2 pt-3">
            <button onClick={add} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
              Add key
            </button>
            {saved && <span className="motion-fade-in text-[12px] leading-4 text-[#6B6B6B]">{saved}</span>}
          </div>
        )}
        {failed && (
          <span role="alert" className="pt-2 text-[12px] leading-4 text-[#B42318]">
            {failed}
          </span>
        )}
      </>
    );

  return (
    <div ref={ref} className="flex scroll-mt-4 flex-col gap-2 px-[22px] pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-semibold">Keys</span>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">Saved in your Orgo vault, the same keys as Orgo&apos;s Settings, Secrets. Bots use them through Orgo and never see them.</span>
      </div>
      <div className="flex flex-col rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">{body}</div>
    </div>
  );
}

/** One key in the vault: what it is, who may use it (tap a bot to change), Replace, and Remove after a confirm. */
function KeyLine({ k, team, onReplace }: { k: KeyRow; team: Bot[]; onReplace: () => void }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (b: Bot, allowed: boolean) => {
    setBusy(true);
    setError(await grant(k.name, b.id, allowed));
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post(`/api/keys/${encodeURIComponent(k.name)}`, {}, "DELETE");
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(undash(j.error ?? "That didn't remove it. Try again."));
        setBusy(false);
        return;
      }
      // Done: the list reads again and drops this row. If that read fails, the row isn't stuck on Removing.
      setBusy(false);
      setSure(false);
      keysChanged();
    } catch {
      setError("Couldn't reach Bops. Try again.");
      setBusy(false);
    }
  };
  const when = setOn(k.updatedAt);
  return (
    <div className="flex flex-col gap-2 border-b border-[#F0F0EE] py-3 first:pt-0">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13.5px] font-medium leading-[18px]">{k.label}</span>
            <span data-tip="In your Orgo account, for all your workspaces. It shows in Orgo's Settings, Secrets too." className="rounded-full bg-[#F2F2F0] px-2 py-px text-[11px] leading-4 text-[#6B6B6B]">
              All workspaces
            </span>
            {k.readOnly && (
              <span data-tip={`Orgo lets bots only read from ${k.label}`} className="rounded-full bg-[#F2F2F0] px-2 py-px text-[11px] leading-4 text-[#6B6B6B]">
                Read only
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-[#9A9A98]">
            <span className="truncate font-mono text-[11.5px] text-[#6B6B6B]">{k.name}</span>
            {when && <span className="shrink-0">Updated {when}</span>}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <button disabled={busy} onClick={onReplace} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
            Replace
          </button>
          <button disabled={busy} onClick={() => setSure(true)} className={`${btn} text-[#B42318] hover:bg-[#FEF3F2]`}>
            Remove
          </button>
        </div>
      </div>
      {!!team.length && (
        <div className="flex flex-wrap items-center gap-1.5">
          {team.map((b) => {
            const on = !!b.keys?.includes(k.name);
            return <BotChip key={b.id} bot={b} on={on} disabled={busy} tip={on ? `${b.name} may use it. Tap to stop` : `Let ${b.name} use it`} onClick={() => void toggle(b, !on)} />;
          })}
        </div>
      )}
      {sure && (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#FEF3F2] px-3 py-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-[#3A3A38]">Remove {k.name} from your Orgo vault? Your bots stop using it, and it&apos;s gone from Orgo too.</span>
          <button disabled={busy} onClick={() => void remove()} className={`${btn} bg-[#B42318] text-white`}>
            {busy ? "Removing…" : "Remove"}
          </button>
          <button disabled={busy} onClick={() => setSure(false)} className={`${btn} bg-white hover:bg-[#F7F7F6]`}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

/** Orgo's computers run their agents on these keys from the same vault (orgo-web lib/computer-agent). */
const ORGO_USES: Record<string, string> = { ANTHROPIC_API_KEY: "Anthropic", OPENAI_API_KEY: "OpenAI" };

/**
 * Add a key: a service from the list Bops can call (by its vault name, as in Orgo's Secrets), the key pasted into a password field, and the bots that may use it. `replace`: a new value for a saved key,
 * which keeps who may use it. The value is cleared once Orgo has it, and is never shown.
 */
function AddKey({
  info,
  team,
  replace,
  bots: startBots,
  first,
  onSaved,
  onCancel,
}: {
  info: KeysInfo;
  team: Bot[];
  replace?: KeyRow;
  bots: string[];
  first: boolean;
  onSaved: (label: string) => void;
  onCancel: () => void;
}) {
  // Every name Orgo can call. A service with two (Stripe) shows each one's name.
  const services = info.providers;
  const twice = (label: string) => services.filter((x) => x.label === label).length > 1;
  const [pick, setPick] = useState(replace?.name ?? services.find((p) => !info.keys.some((k) => k.name === p.name))?.name ?? services[0]?.name ?? "");
  const [value, setValue] = useState("");
  const [bots, setBots] = useState(startBots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = replace?.name ?? pick;
  const p = info.providers.find((x) => x.name === name);
  const isSaved = !replace && info.keys.some((k) => k.name === name);
  const canSave = !!p && !!value.trim() && !busy;
  const save = async () => {
    if (!canSave || !p) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/keys", { name, value, botIds: replace ? [] : bots });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) return setError(undash(j.error ?? "That didn't save. Try again."));
      setValue("");
      keysChanged();
      onSaved(p.label);
    } catch {
      setError("Couldn't reach Bops. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const field = "h-8 rounded-full bg-[#F7F7F6] px-3 text-[13px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        // Closes the form, and keeps Settings open (the app's Esc would close it).
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      className={`flex flex-col gap-2.5 ${first ? "" : replace ? "my-3 rounded-[12px] bg-[#FCFCFB] p-3 shadow-[0_0_0_1px_#ECECEA]" : "mt-3 rounded-[12px] bg-[#FCFCFB] p-3 shadow-[0_0_0_1px_#ECECEA]"}`}
    >
      {replace ? (
        <span className="text-[13px] leading-[18px]">
          New key for <span className="font-medium">{replace.label}</span> <span className="font-mono text-[11.5px] text-[#6B6B6B]">{replace.name}</span>
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative flex">
            <select
              aria-label="Service"
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setError(null);
              }}
              className="h-8 cursor-pointer appearance-none rounded-full bg-white pl-3 pr-7 text-[13px] text-ink shadow-[0_0_0_1px_#E6E6E3] outline-none hover:bg-[#FCFCFB] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
            >
              {services.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label}
                  {twice(s.label) ? ` (${s.name})` : ""}
                  {info.keys.some((k) => k.name === s.name) ? " (saved)" : ""}
                </option>
              ))}
            </select>
            <svg width="10" height="10" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden>
              <path d="M3 4.5l3 3 3-3" fill="none" stroke="#6B6B6B" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span data-tip="Its name in your Orgo vault" className="font-mono text-[11.5px] text-[#6B6B6B]">
            {name}
          </span>
        </div>
      )}
      {p ? (
        <span className="text-[12px] leading-[17px] text-[#3A3A38]">
          {p.tip}
          {p.readOnly ? ` Orgo lets bots only read from ${p.label}.` : ""} <span className="text-[#9A9A98]">Get one in {p.where}.</span>
          {isSaved && <span className="text-[#9A9A98]"> Saving replaces the one in your vault.</span>}
          {ORGO_USES[p.name] && <span className="text-[#9A9A98]"> Orgo computers that use your {ORGO_USES[p.name]} key use this one too.</span>}
        </span>
      ) : null}
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={p ? `Paste your ${p.label} key` : "Paste the key"}
        aria-label="Key"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        className={`${field} w-full font-mono text-[12.5px]`}
      />
      {!replace && !!team.length && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="pr-0.5 text-[12px] leading-4 text-[#9A9A98]">Bots that may use it</span>
          {team.map((b) => {
            const on = bots.includes(b.id);
            return <BotChip key={b.id} bot={b} on={on} tip={on ? `${b.name} may use it` : `Let ${b.name} use it`} onClick={() => setBots(on ? bots.filter((x) => x !== b.id) : [...bots, b.id])} />;
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!canSave} className={`${btn} bg-ink text-white disabled:opacity-40`}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
          Cancel
        </button>
        {error && (
          <span role="alert" className="min-w-0 text-[12px] leading-4 text-[#B42318]">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/* ---------------- A bot's profile ---------------- */

/** On a bot's profile: the keys in the vault, on or off for this bot, and the way to Settings to add one. */
export function BotKeys({ bot: b, onAdd, className }: { bot: Bot; onAdd: () => void; className: string }) {
  const { info, failed, retry } = useKeys();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!info)
    return failed ? (
      <div className={`flex w-full flex-col rounded-2xl ${className}`}>
        <span className="px-4 pb-1 pt-[11px] text-[13px] font-semibold leading-4">Keys</span>
        <span role="alert" className="flex flex-wrap items-center gap-x-3 px-4 pb-3 pt-0.5 text-[12px] leading-4 text-[#6B6B6B]">
          {failed}
          <button onClick={retry} className="font-medium text-ink underline-offset-2 hover:underline">
            Try again
          </button>
        </span>
      </div>
    ) : null;
  const toggle = async (name: string, allowed: boolean) => {
    setBusy(name);
    setError(await grant(name, b.id, allowed));
    setBusy(null);
  };
  return (
    <div className={`flex w-full flex-col rounded-2xl ${className}`}>
      <div className="flex items-center justify-between px-4 pb-1 pt-[11px]">
        <span className="text-[13px] font-semibold leading-4">Keys</span>
        {info.signedIn && (
          <button onClick={onAdd} className="text-[12px] font-medium leading-4 text-ink">
            Add in Settings ›
          </button>
        )}
      </div>
      {!info.signedIn || !info.keys.length ? (
        <div className="px-4 pb-3 pt-0.5 text-[12px] leading-4 text-[#6B6B6B]">{info.signedIn ? "No keys in your Orgo vault yet" : undash(info.error ?? "Sign in to Orgo to use Keys.")}</div>
      ) : (
        info.keys.map((k, i) => {
          const on = !!b.keys?.includes(k.name);
          return (
            <div key={k.name} className={`flex items-center gap-2.5 px-4 py-[9px] ${i === info.keys.length - 1 ? "pb-3" : "border-b border-black/[0.05]"}`}>
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 text-[14px] leading-[18px]">{k.label}</span>
                <span className="truncate font-mono text-[11px] leading-4 text-[#9A9A98]">{k.name}</span>
              </div>
              <button
                role="switch"
                aria-checked={on}
                aria-label={on ? `Stop ${b.name} using ${k.label}` : `Let ${b.name} use ${k.label}`}
                disabled={busy === k.name}
                onClick={() => void toggle(k.name, !on)}
                className={`flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 disabled:opacity-60 ${on ? "justify-end bg-ink" : "justify-start bg-[#D9D9D6]"}`}
              >
                <span className={`size-[18px] rounded-full ${on ? "bg-highlighter" : "bg-white"}`} />
              </button>
            </div>
          );
        })
      )}
      {error && (
        <span role="alert" className="px-4 pb-3 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

/* ---------------- In the chat ---------------- */

const CALL = /^(.+) (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

export type ApiCall = { who?: string; label: string; method: string; path: string; failed?: string };

/**
 * A note an API call left in the chat (keys.ts callApi), or null: a GET's "Called Stripe GET /v1/customers",
 * and an approved write's result, "Max: Called Stripe POST /v1/refunds" or "Max couldn't call it: why",
 * which carries what was called in its appResult.
 */
export function apiCallOf(m: Message): ApiCall | null {
  if (m.role !== "system") return null;
  if (m.appResult) {
    const x = CALL.exec(m.appResult.action);
    if (!x) return null;
    const call = { label: x[1], method: x[2], path: x[3] };
    const failed = /^(.+?) couldn't call it: ([\s\S]+)$/.exec(m.text);
    if (failed) return { ...call, who: failed[1], failed: failed[2] };
    const did = /^(.+?): Called /.exec(m.text);
    return did ? { ...call, who: did[1] } : null;
  }
  const x = /^Called (.+) (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(m.text);
  return x ? { label: x[1], method: x[2], path: x[3] } : null;
}

const methodColor = (method: string) => (method === "DELETE" ? "text-[#B42318]" : method === "GET" ? "text-[#6B6B6B]" : "text-ink");

/** An API call in the chat, as a note like an app's: who called which service, the method and the path. */
export function ApiNote({ call: c }: { call: ApiCall }) {
  const what = c.failed !== undefined ? `${c.who ?? "The bot"} couldn't call ${c.label}` : c.who ? `${c.who} called ${c.label}` : `Called ${c.label}`;
  return (
    <div className="flex max-w-[440px] flex-col items-center gap-1">
      <div title={c.path.length > 48 ? c.path : undefined} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-[#F7F7F6] px-3 py-1 text-[12px] leading-4 text-[#6B6B6B]">
        <span className="flex shrink-0 text-[#9A9A98]">
          <KeyIcon />
        </span>
        <span className="shrink-0">{what}</span>
        <span className={`shrink-0 font-mono text-[11px] font-semibold ${methodColor(c.method)}`}>{c.method}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-[#3A3A38]">{c.path}</span>
      </div>
      {c.failed && <span className="line-clamp-2 px-2 text-center text-[12px] leading-4 text-[#B42318]">{undash(c.failed)}</span>}
    </div>
  );
}

/** An approval for a call_api write: the service, method and path, and the vault key Orgo sends it with. Null for another app's. */
export function apiAskOf(a: AppApproval): { name: string; label: string; method: string; path: string } | null {
  if (a.app !== "api") return null;
  const x = /^(\S+) (GET|POST|PUT|PATCH|DELETE) (\S+)$/.exec(a.action);
  if (!x) return null;
  return { name: x[1], method: x[2], path: x[3], label: / in (.+)$/.exec(a.title)?.[1] ?? x[1] };
}

/** The call an approval card asks about, plainly: the method, the whole path, then what goes with it. */
export function ApiAsk({ ask, detail, botName }: { ask: NonNullable<ReturnType<typeof apiAskOf>>; detail: string; botName: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-1.5 rounded-xl bg-[#F7F7F6] px-3 py-2">
        <div className="flex items-start gap-2 font-mono text-[12.5px] leading-[18px]">
          <span className={`shrink-0 rounded-md bg-white px-1.5 text-[11.5px] font-semibold shadow-[0_0_0_1px_#E6E6E3] ${methodColor(ask.method)}`}>{ask.method}</span>
          <span className="min-w-0 select-text text-ink [overflow-wrap:anywhere]">{ask.path}</span>
        </div>
        {detail && <pre className="max-h-[180px] overflow-y-auto whitespace-pre-wrap font-mono text-[11.5px] leading-4 text-[#3A3A38] [overflow-wrap:anywhere]">{detail}</pre>}
      </div>
      <span className="text-[12px] leading-4 text-[#6B6B6B]">
        Orgo sends it to {ask.label} with your key (<span className="font-mono text-[11px]">{ask.name}</span>). {botName} never sees the key.
      </span>
    </div>
  );
}
