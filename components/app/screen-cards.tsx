"use client";

import { useEffect, useState } from "react";
import type { Bot, ScreenRead, VaultLogin } from "@/lib/types";
import { Mascot } from "./mascot";
import { post } from "./ui";

/*
 * Generative cards: native Bops UI drawn over the bot's real page when Jev reads something on it
 * that needs the user. Each card is wired to the page itself, so acting here acts there.
 */

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * "Sign in for Otto": the page's own sign-in or code fields, as Jev matched them. What the user types
 * goes straight into the page; Bops never keeps it and no model sees it. Multi-step sign-ins
 * (email, then password, then a code) redraw the card for each step.
 */
export function SignInCard({
  bot: b,
  display,
  read,
  compact,
  onTakeOver,
  onDismiss,
  vault,
}: {
  bot: Bot;
  display: number;
  read: ScreenRead;
  compact: boolean;
  onTakeOver: () => void;
  onDismiss: () => void;
  vault: VaultLogin[];
}) {
  const form = read.form!;
  // Saved logins this bot may use on this site: one tap, filled from the Keychain.
  const pageHost = host(read.url);
  const saved = vault.filter((l) => (l.bots === "all" || l.bots.includes(b.id)) && (pageHost === l.site || pageHost.endsWith(`.${l.site}`)));
  const [save, setSave] = useState(false);
  const fields = (["identifier", "password", "code"] as const).filter((k) => form[k]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = read.blocker === "two_factor" || (!!form.code && !form.identifier && !form.password);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await post("/api/screen-form", { botId: b.id, display, values, save: save && !code });
    const json = (await res.json()) as { error?: string; read?: ScreenRead | null };
    setBusy(false);
    setValues({});
    if (json.error) setError(json.error);
    else if (json.read?.form && json.read.url === read.url && JSON.stringify(json.read.form) === JSON.stringify(read.form))
      setError("Still on the same step. Check what you entered, or take over to see the page.");
  };

  return (
    <CardShell bot={b} title={code ? `${b.name} needs a code` : `Sign in for ${b.name}`} subtitle={`${read.title ? `${read.title} · ` : ""}${host(read.url)}`} compact={compact} onDismiss={onDismiss}>
      {saved.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {saved.map((l) => (
            <button
              key={l.id}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const res = await post("/api/vault/use", { botId: b.id, display, loginId: l.id });
                const json = (await res.json()) as { error?: string; signedIn?: boolean; busy?: boolean };
                setBusy(false);
                if (json.error) setError(json.error);
                else if (json.busy) setError("Already signing in with it. Give it a few seconds.");
                else if (!json.signedIn) setError(`Signed in partway. ${host(read.url)} still wants something: fill it below, or take over.`);
              }}
              className="flex items-center gap-2.5 rounded-[14px] bg-ink px-3.5 py-2.5 text-left text-white disabled:opacity-60"
            >
              <KeyIcon />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13.5px] font-semibold leading-[18px]">{busy ? "Signing in…" : `Sign in as ${l.username}`}</span>
                <span className="text-[11.5px] leading-4 text-white/60">Saved in your vault{l.hasTotp ? " · makes the 2FA code too" : ""}</span>
              </span>
            </button>
          ))}
          <span className="pt-1 text-center text-[11.5px] leading-4 text-[#9A9A98]">or type it</span>
        </div>
      )}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        {fields.map((k, i) => {
          const f = form[k]!;
          return (
            <label key={f.id} className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">{f.label}</span>
              <input
                autoFocus={i === 0}
                type={k === "password" ? "password" : "text"}
                inputMode={k === "code" ? "numeric" : undefined}
                autoComplete={k === "identifier" ? "username" : k === "password" ? "current-password" : "one-time-code"}
                value={values[k] ?? ""}
                onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                className={`${fieldClass} ${k === "code" ? "font-mono tracking-[0.3em]" : ""}`}
              />
            </label>
          );
        })}
        {!code && (
          <label className="flex items-center gap-2 text-[12.5px] leading-4 text-[#3A3A38]">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="size-3.5 accent-[#0A0A0A]" />
            Save to your vault, so {b.name} can sign in next time
          </label>
        )}
        {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
        <div className="flex items-center gap-2">
          <button disabled={busy || !fields.some((k) => values[k]?.trim())} className={primary}>
            {busy ? "Working on it…" : code ? "Send code" : "Continue"}
          </button>
          <button type="button" onClick={onTakeOver} className={secondary}>
            Take over
          </button>
        </div>
        <span className="text-[11px] leading-[15px] text-[#9A9A98]">
          Goes straight into the page on {b.name}&apos;s screen. {save ? "Saved logins stay in your Mac's Keychain." : "Bops doesn't keep it."} No AI sees it.
        </span>
      </form>
    </CardShell>
  );
}

export function KeyIcon({ color = "currentColor" }: { color?: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0">
      <circle cx="5.5" cy="10.5" r="3" fill="none" stroke={color} strokeWidth="1.4" />
      <path d="M7.7 8.3L13.5 2.5M11.5 4.5l1.6 1.6M10 6l1.2 1.2" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** The shared shell of a card over the bot's page: the bot, what it needs, and a way out. */
function CardShell({
  bot: b,
  title,
  subtitle,
  compact,
  onDismiss,
  children,
}: {
  bot: Bot;
  title: string;
  subtitle: string;
  compact: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-end justify-center bg-gradient-to-t from-black/25 via-black/5 to-transparent p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`pointer-events-auto flex max-h-full w-full flex-col gap-3 overflow-y-auto rounded-[22px] bg-white/95 p-4 shadow-[0_0_0_1px_#0000000F,0_24px_60px_-18px_#00000059] backdrop-blur ${compact ? "max-w-[360px]" : "max-w-[440px]"}`}
      >
        <div className="flex items-center gap-2.5">
          <Mascot botId={b.id} color={b.color} size={30} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[14.5px] font-semibold leading-5">{title}</span>
            <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{subtitle}</span>
          </div>
          <button type="button" onClick={onDismiss} aria-label="Not now" className="flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-[#F2F2F0]">
            <svg width="10" height="10" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#6B6B6B" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const fieldClass = "rounded-xl bg-[#F7F7F6] px-3 py-2.5 text-[14px] leading-5 outline-none shadow-[inset_0_0_0_1px_#E6E6E3] focus:bg-white focus:shadow-[inset_0_0_0_1.5px_#0A0A0A]";
const primary = "flex-1 rounded-full bg-ink px-4 py-2.5 text-[14px] font-semibold leading-[18px] text-highlighter disabled:opacity-40";
const secondary = "rounded-full px-3.5 py-2.5 text-[13px] font-medium leading-[18px] text-[#3A3A38] shadow-[inset_0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]";

async function act(botId: string, display: number, action: string, values?: Record<string, string>) {
  const res = await post("/api/screen-action", { botId, display, action, values });
  return (await res.json()) as { error?: string };
}

/** A checkout the bot reached: the user approves (the card presses the page's own pay button) or declines. */
export function PaymentCard({
  bot: b,
  display,
  read,
  compact,
  onTakeOver,
  onDismiss,
}: {
  bot: Bot;
  display: number;
  read: ScreenRead;
  compact: boolean;
  onTakeOver: () => void;
  onDismiss: () => void;
}) {
  const p = read.payment!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "pay" | "decline") => {
    setBusy(action);
    setError(null);
    const r = await act(b.id, display, action);
    setBusy(null);
    if (r.error) setError(r.error);
  };
  return (
    <CardShell bot={b} title={`${b.name} wants to pay`} subtitle={`${read.title ? `${read.title} · ` : ""}${p.merchant}`} compact={compact} onDismiss={onDismiss}>
      <div className="flex flex-col items-center gap-0.5 rounded-2xl bg-[#F7F7F6] py-4">
        <span className="text-[30px] font-semibold leading-9 tracking-[-0.02em]">{p.amount ?? "Amount unclear"}</span>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">at {p.merchant}</span>
      </div>
      {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-2">
        <button disabled={!!busy || !p.confirm} onClick={() => void run("pay")} className={primary} title={p.confirm ? `Presses "${p.confirm.text}" on the page` : "Couldn't find the pay button"}>
          {busy === "pay" ? "Paying…" : `Approve${p.amount ? ` ${p.amount}` : ""}`}
        </button>
        <button disabled={!!busy} onClick={() => void run("decline")} className={secondary}>
          Decline
        </button>
        <button onClick={onTakeOver} className={secondary}>
          Take over
        </button>
      </div>
      <span className="text-[11px] leading-[15px] text-[#9A9A98]">
        {p.confirm ? `Approve presses "${p.confirm.text}" on ${b.name}'s screen.` : `Take over to check the page and pay yourself.`} Nothing is bought until you say so.
      </span>
    </CardShell>
  );
}

/** An email the bot drafted: the user reads it here, edits any field, and sends it (the card fills the real draft and presses Send). */
export function EmailCard({
  bot: b,
  display,
  read,
  compact,
  onTakeOver,
  onDismiss,
}: {
  bot: Bot;
  display: number;
  read: ScreenRead;
  compact: boolean;
  onTakeOver: () => void;
  onDismiss: () => void;
}) {
  const e = read.email!;
  const [draft, setDraft] = useState<{ to?: string; subject?: string; body?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void fetch(`/api/screen-action?bot=${b.id}&display=${display}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { to?: string; subject?: string; body?: string; error?: string }) => !gone && setDraft(d.error ? {} : d));
    return () => {
      gone = true;
    };
  }, [b.id, display, read.url]);

  const run = async (action: "send" | "discard") => {
    setBusy(action);
    setError(null);
    const r = await act(b.id, display, action, action === "send" ? (draft as Record<string, string>) : undefined);
    setBusy(null);
    if (r.error) setError(r.error);
  };
  const field = (k: "to" | "subject" | "body", label: string, multiline = false) =>
    e[k] && (
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">{label}</span>
        {multiline ? (
          <textarea
            value={draft?.[k] ?? ""}
            onChange={(ev) => setDraft({ ...draft, [k]: ev.target.value })}
            rows={compact ? 5 : 8}
            className="resize-none rounded-xl bg-[#F7F7F6] px-3 py-2.5 text-[13.5px] leading-5 outline-none shadow-[inset_0_0_0_1px_#E6E6E3] focus:bg-white focus:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
          />
        ) : (
          <input
            value={draft?.[k] ?? ""}
            onChange={(ev) => setDraft({ ...draft, [k]: ev.target.value })}
            className="rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13.5px] leading-5 outline-none shadow-[inset_0_0_0_1px_#E6E6E3] focus:bg-white focus:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
          />
        )}
      </label>
    );

  return (
    <CardShell bot={b} title={`${b.name} drafted an email`} subtitle={`Read it, edit anything, then send · ${host(read.url)}`} compact={compact} onDismiss={onDismiss}>
      {draft === null ? (
        <span className="py-6 text-center text-[12px] text-[#9A9A98]">Reading the draft…</span>
      ) : (
        <>
          {field("to", "To")}
          {field("subject", "Subject")}
          {field("body", "Message", true)}
        </>
      )}
      {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-2">
        <button disabled={!!busy || draft === null || !e.send} onClick={() => void run("send")} className={primary}>
          {busy === "send" ? "Sending…" : "Send"}
        </button>
        <button disabled={!!busy} onClick={() => void run("discard")} className={secondary}>
          Not yet
        </button>
        <button onClick={onTakeOver} className={secondary}>
          Take over
        </button>
      </div>
      <span className="text-[11px] leading-[15px] text-[#9A9A98]">Send puts your edits into the real draft and presses Send. Nothing goes out until you do.</span>
    </CardShell>
  );
}
