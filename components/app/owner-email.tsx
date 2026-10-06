"use client";

import { useState } from "react";
import { CodeInput, ErrorLine, postJson, ResendButton, RetryLabel, useInfo, type CodeAnswer } from "./code-entry";

/** Where one of the user's addresses comes from (ownerEmailSources in lib/server/mail.ts). */
export type EmailSource = "sign-in" | "gmail" | "outlook" | "env" | "code";
/** One of the user's addresses; `off`: it's the sign-in email and the user hasn't counted it. */
export type OwnerAddress = { address: string; sources: EmailSource[]; verifiedAt?: number; off?: boolean };
export type PendingEmail = { recipient: string; resendInSec: number; expiresAt: number };
/** GET /api/owner-email (ownerEmailStatus in lib/server/owner-email.ts). */
export type OwnerEmailInfo = { on: boolean; codes: boolean; add: "on" | "hosted"; emails: OwnerAddress[]; pending: PendingEmail[] };

type Answer = CodeAnswer & { recipient?: string; email?: OwnerEmailInfo | null };

/** /api/owner-email, read once (Settings), with `failed` and `retry`. */
export const useOwnerEmailInfo = () => useInfo<OwnerEmailInfo>("/api/owner-email");

const CHIP: Record<EmailSource, string> = { "sign-in": "Your sign-in email", gmail: "Connected Gmail", outlook: "Connected Outlook", env: "Set on this server", code: "Verified" };
const chip = "rounded-full px-2 py-0.5 text-[11.5px]";
const quiet = "text-[12px] text-[#9A9A98] hover:text-ink disabled:opacity-40";
const link = "text-[12px] font-medium text-ink underline-offset-2 hover:underline disabled:opacity-40";
const note = "text-[12px] leading-4 text-[#6B6B6B]";

/** What keeps an address counting as the user: each source, less the sign-in email until it's counted. */
const countingSources = (e: OwnerAddress) => e.sources.filter((s) => s !== "sign-in" || !e.off);

/**
 * Your email, in How your bots reach you. The addresses that count as you are listed, each with where
 * it comes from: the Gmail or Outlook you connected, this server's setting, ones added with a code emailed to
 * them, and your sign-in email once you count it. Until then the sign-in email is offered below them
 * ("Count it"). An email from an address that counts is you only when it proves where it came from
 * (the server checks). Codes are offered only while they can be emailed from here (`codes`); a hosted
 * server can't add any yet, or show them (`add`).
 */
export function OwnerEmail({ info, onInfo }: { info: OwnerEmailInfo; onInfo: (i: OwnerEmailInfo) => void }) {
  const [address, setAddress] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The address a code was emailed to, waiting for the code, and how long until another may be sent (`refused`: that wait is a refusal).
  const [sentTo, setSentTo] = useState<{ address: string; resendInSec: number; refused?: boolean } | null>(null);
  // A code sent before a reload, still waiting (until the user moves on from it).
  const [dismissed, setDismissed] = useState(false);
  // Bumped on every send and every failed check: a fresh code box. `sends`: a fresh resend wait (a wrong code leaves it running).
  const [round, setRound] = useState(0);
  const [sends, setSends] = useState(0);
  const [justVerified, setJustVerified] = useState<string | null>(null);
  // Refused for a while (too many codes), with no code out: the Send button counts down instead.
  const [retry, setRetry] = useState<{ seconds: number; at: number } | null>(null);
  const resumed = info.pending?.[0];
  const waiting = sentTo ?? (!dismissed && resumed ? { address: resumed.recipient, resendInSec: resumed.resendInSec, refused: undefined } : null);
  const emails = info.emails ?? [];
  const canChange = info.add === "on";
  // Rows: the addresses that count. The sign-in email that doesn't (yet) is offered on its own line.
  const rows = emails.filter((e) => countingSources(e).length > 0);
  const offer = emails.find((e) => !countingSources(e).length && e.sources.includes("sign-in"));

  const take = (a: Answer) => {
    if (a.email) onInfo(a.email);
  };

  const send = async (to: string) => {
    setBusy(true);
    setError(null);
    setJustVerified(null);
    const a = await postJson<Answer>("/api/owner-email/verify/start", { address: to });
    take(a);
    setBusy(false);
    if (a.ok) {
      setSentTo({ address: a.recipient ?? to.trim().toLowerCase(), resendInSec: a.resendInSec ?? 60 });
      setRound((r) => r + 1);
      setSends((n) => n + 1);
      setAddress("");
      setRetry(null);
      return;
    }
    setError(a.error ?? "Couldn't send a code.");
    if (!a.retryInSec) return;
    // "Send a new code" for the code that's out: its link waits. A new address: the Send button.
    if (waiting && to.trim().toLowerCase() === waiting.address) {
      setSentTo({ ...waiting, resendInSec: a.retryInSec, refused: true });
      setRound((r) => r + 1);
      setSends((n) => n + 1);
    } else setRetry({ seconds: a.retryInSec, at: Date.now() });
  };

  const check = async (code: string) => {
    if (!waiting) return;
    setBusy(true);
    setError(null);
    const a = await postJson<Answer>("/api/owner-email/verify/check", { address: waiting.address, code });
    take(a);
    setBusy(false);
    if (a.ok) {
      setJustVerified(waiting.address);
      setSentTo(null);
      setDismissed(true);
      setAdding(false);
      return;
    }
    setError(a.error ?? "That code didn't work.");
    // A fresh code box; after a code that can't be used anymore, "Send a new code" right away.
    setSentTo({ ...waiting, resendInSec: a.restart ? 0 : waiting.resendInSec, refused: a.restart ? undefined : waiting.refused });
    setRound((r) => r + 1);
    if (a.restart) setSends((n) => n + 1);
  };

  /** Remove an address added with a code, or say whether the sign-in email counts. */
  const change = async (body: Record<string, unknown>, failed: string) => {
    setBusy(true);
    setError(null);
    setJustVerified(null);
    const a = await postJson<Answer>("/api/owner-email", body);
    take(a);
    if (!a.ok) setError(a.error && a.error !== "unknown action" ? a.error : failed);
    setBusy(false);
  };

  const sendNew = () => {
    if (address.trim() && !busy && !retry) void send(address);
  };

  const cancel = () => {
    setAdding(false);
    setAddress("");
    setRetry(null);
    setError(null);
  };

  // A hosted server: nothing to list or change from here.
  if (!canChange)
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium leading-4">Your email</span>
        <span className={note}>Adding an email only works in the app on your Mac for now.</span>
      </div>
    );

  const canAdd = info.codes;
  const line = rows.length
    ? "Emails you send from these addresses count as you. Bops checks that each one really came from you. Your bots can email you here without asking first."
    : offer
      ? "Count an email you write from, and emails you send from it count as you. Bops checks that each one really came from you."
      : canAdd || waiting
        ? "Add the email you write from, so emails from it count as you."
        : "Connect Gmail or Outlook in the Vault, and emails you send from it count as you.";

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium leading-4">Your email</span>
      <span className={note}>{line}</span>

      {rows.map((e) => {
        const has = (s: EmailSource) => e.sources.includes(s);
        const counts = countingSources(e);
        return (
          <span key={e.address} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-4 text-[#3A3A38]">
            <span className="break-all font-medium text-ink">{e.address}</span>
            {e.sources.map((s) =>
              s === "code" ? (
                <span key={s} className={`inline-flex items-center gap-1 ${chip} bg-[#E9F6EE] font-medium text-[#1E7A44]`}>
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 5.2 4.1 7.2 8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {CHIP[s]}
                </span>
              ) : (
                <span key={s} className={`${chip} bg-[#F2F2F0] text-[#6B6B6B]`}>
                  {CHIP[s]}
                </span>
              ),
            )}
            {has("sign-in") && !e.off && (
              <button disabled={busy} onClick={() => void change({ action: "sign-in", on: false }, "Couldn't change it. Try again.")} className={quiet}>
                Don&apos;t count it
              </button>
            )}
            {has("code") && (
              <button
                disabled={busy}
                onClick={() => void change({ action: "remove", address: e.address }, "Couldn't remove it. Try again.")}
                className="text-[12px] text-[#9A9A98] hover:text-[#B42318] disabled:opacity-40"
              >
                Remove
              </button>
            )}
            {/* Only when a connected Gmail or Outlook alone keeps it counting: then disconnecting it is what removes it. */}
            {has("gmail") && counts.length === 1 && <span className="text-[12px] text-[#9A9A98]">Disconnect Gmail to remove it.</span>}
            {has("outlook") && counts.length === 1 && <span className="text-[12px] text-[#9A9A98]">Disconnect Outlook to remove it.</span>}
          </span>
        );
      })}
      {offer && (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-4 text-[#3A3A38]">
          <span>
            Your sign-in email, <span className="break-all font-medium text-ink">{offer.address}</span>, doesn&apos;t count as you yet.
          </span>
          <button disabled={busy} onClick={() => void change({ action: "sign-in", on: true }, "Couldn't change it. Try again.")} className={link}>
            Count it
          </button>
        </span>
      )}
      {justVerified && (
        <span role="status" className="text-[12px] leading-4 text-[#1E7A44]">
          Verified. Emails you send from this address now count as you.
        </span>
      )}

      {waiting ? (
        <div className="flex flex-col gap-2 pt-1">
          <span role="status" className="text-[12.5px] leading-4 text-[#3A3A38]">
            Enter the code we emailed to <span className="break-all font-medium text-ink">{waiting.address}</span>.
          </span>
          <span className="text-[12px] leading-4 text-[#9A9A98]">Not there in a minute? Check spam, or send a new code.</span>
          <CodeInput key={round} ariaLabel="Code from the email" disabled={busy} onComplete={(c) => void check(c)} />
          <span className="flex items-center gap-3 text-[12px] leading-4">
            <ResendButton key={sends} seconds={waiting.resendInSec} refused={waiting.refused} disabled={busy} onResend={() => void send(waiting.address)} />
            <button
              disabled={busy}
              onClick={() => {
                setSentTo(null);
                setDismissed(true);
                setError(null);
              }}
              className="text-[#9A9A98] hover:text-ink disabled:opacity-40"
            >
              Use a different email
            </button>
          </span>
        </div>
      ) : !canAdd ? (
        // With nothing listed, the line above already says what to do.
        rows.length > 0 && <span className="text-[12px] leading-4 text-[#9A9A98]">Adding another email by code isn&apos;t available yet.</span>
      ) : adding || (!rows.length && !offer) ? (
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setRetry(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendNew();
              }}
              disabled={busy}
              autoFocus={adding}
              placeholder="you@example.com"
              aria-label="Email address"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              className="h-8 w-[240px] rounded-full bg-[#F7F7F6] px-3 text-[13px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-50"
            />
            <button
              disabled={busy || !!retry || !address.trim()}
              onClick={sendNew}
              className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 tabular-nums text-white disabled:opacity-40"
            >
              {retry ? <RetryLabel key={retry.at} seconds={retry.seconds} onDone={() => setRetry(null)} /> : busy ? "Sending…" : "Send code"}
            </button>
            {adding && (
              <button disabled={busy} onClick={cancel} className={quiet}>
                Cancel
              </button>
            )}
          </div>
          <span className="text-[12px] leading-4 text-[#9A9A98]">We email you a code to make sure it&apos;s yours.</span>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="self-start pt-0.5 text-[12px] font-medium text-ink underline-offset-2 hover:underline">
          Add an email
        </button>
      )}
      <ErrorLine text={error} />
    </div>
  );
}
