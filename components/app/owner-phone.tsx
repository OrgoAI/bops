"use client";

import { useState } from "react";
import { PRIVACY, TERMS } from "@/lib/links";
import { CodeInput, ErrorLine, postJson, ResendButton, RetryLabel, useInfo, type CodeAnswer } from "./code-entry";

/** One of the user's numbers, as /api/phone lists it. */
export type OwnerNumber = { number: string; pretty: string; consentAt?: number; verifiedAt?: number; claimedVia?: "call" | "text"; fromEnv?: boolean };
export type PendingCode = { number: string; pretty: string; resendInSec: number; expiresAt: number };
/** What the mobile needs from /api/phone: texting is on, the user's numbers, any code out, and whether numbers can be added here. */
export type PhoneCodeInfo = { on?: boolean; owners?: OwnerNumber[]; pending?: PendingCode[]; verify?: boolean };

type Answer<P> = CodeAnswer & { recipient?: string; phone?: P | null };

/**
 * Where a send, a check or a removal was asked from, so its answer shows there: the form for a new
 * number, the banner (or the setup card) for a saved number, a saved number's own row, or the code
 * being typed.
 */
export type PhoneAction = "form" | "banner" | "row" | "code";

/** /api/phone, read once (Settings, and the setup screen's mobile card), with `failed` and `retry`. */
export const usePhoneInfo = <P,>() => useInfo<P>("/api/phone");

/** A saved number that isn't verified yet (one saved before codes existed, say): it doesn't count as the user. */
export const unverified = (owners: OwnerNumber[] | undefined) => (owners ?? []).filter((o) => !o.verifiedAt && !o.fromEnv);

/**
 * Adding the user's mobile: their OK to texts, a code texted to it, the code typed back. Only then do
 * texts and calls from it count as them (and bots text it). Kept in a hook so the mobile row, the
 * banner above it and the setup screen's card can all send a code and show where it stands.
 */
export function useOwnerPhone<P extends PhoneCodeInfo>(info: P, onInfo: (p: P) => void) {
  const [number, setNumber] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  // What went wrong, and where it was asked from (it shows there).
  const [error, setError] = useState<{ text: string; from: PhoneAction } | null>(null);
  // The number a code was texted to, waiting for the code, and how long until another may be sent
  // (`refused`: that wait is a refusal, too many codes). consent: the user ticked the box for this
  // number, so "Send a new code" carries it too (the server may have lost it in a restart).
  const [sentTo, setSentTo] = useState<{ number: string; pretty: string; resendInSec: number; consent?: boolean; refused?: boolean } | null>(null);
  // A code sent before a reload, still waiting (until the user moves on from it).
  const [dismissed, setDismissed] = useState(false);
  // Bumped on every send and every failed check: a fresh code box.
  const [round, setRound] = useState(0);
  // Bumped on every send, and when only a new code can help: a fresh resend wait. A wrong code leaves the wait running.
  const [sends, setSends] = useState(0);
  const [justVerified, setJustVerified] = useState<string | null>(null);
  // Refused for a while (too many codes), with no code out: the button that asked counts down
  // instead, and only that one (the form, or the banner or row for that saved number).
  const [retry, setRetry] = useState<{ seconds: number; at: number; from: PhoneAction; number?: string } | null>(null);
  // "Add another number" was opened.
  const [adding, setAdding] = useState(false);
  const resumed = info.pending?.[0];
  const waiting = sentTo ?? (!dismissed && resumed ? { number: resumed.number, pretty: resumed.pretty, resendInSec: resumed.resendInSec, consent: undefined, refused: undefined } : null);

  const take = (a: Answer<P>) => {
    if (a.phone) onInfo(a.phone);
  };

  /** Text a code to `to`: a new number from the form (with the box ticked), or a saved one (its OK to texts is on record). */
  const send = async (to: string, consent: boolean, pretty?: string, from: PhoneAction = "form") => {
    setBusy(true);
    setError(null);
    setJustVerified(null);
    const a = await postJson<Answer<P>>("/api/phone/verify/start", { number: to, consent });
    take(a);
    setBusy(false);
    if (a.ok) {
      // The number as the server read it (E.164), shown the way Settings lists numbers.
      const e164 = a.recipient ?? to;
      const shown = a.phone?.pending?.find((p) => p.number === e164)?.pretty ?? pretty ?? to;
      setSentTo({ number: e164, pretty: shown, resendInSec: a.resendInSec ?? 30, consent: consent || (waiting?.number === e164 && waiting.consent) });
      setRound((r) => r + 1);
      setSends((n) => n + 1);
      if (from === "form") {
        setNumber("");
        setAgree(false);
      }
      setRetry(null);
      return;
    }
    setError({ text: a.error ?? "Couldn't send a code.", from });
    if (!a.retryInSec) return;
    // "Send a new code" for the code that's out: its link waits. Anything else: the button that asked.
    if (waiting && to === waiting.number) {
      setSentTo({ ...waiting, resendInSec: a.retryInSec, refused: true });
      setRound((r) => r + 1);
      setSends((n) => n + 1);
    } else setRetry({ seconds: a.retryInSec, at: Date.now(), from, number: from === "form" ? undefined : to });
  };

  const check = async (code: string) => {
    if (!waiting) return;
    setBusy(true);
    setError(null);
    const a = await postJson<Answer<P>>("/api/phone/verify/check", { number: waiting.number, code });
    take(a);
    setBusy(false);
    if (a.ok) {
      setJustVerified(waiting.number);
      setSentTo(null);
      setDismissed(true);
      setAdding(false);
      return;
    }
    setError({ text: a.error ?? "That code didn't work.", from: "code" });
    // A fresh code box; after a code that can't be used anymore, "Send a new code" right away.
    setSentTo({ ...waiting, resendInSec: a.restart ? 0 : waiting.resendInSec, refused: a.restart ? undefined : waiting.refused });
    setRound((r) => r + 1);
    if (a.restart) setSends((n) => n + 1);
  };

  const remove = async (n: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove-owner", number: n }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as (P & { error?: string }) | null;
    if (!j || j.error) setError({ text: j?.error ?? "Couldn't remove it. Try again.", from: "row" });
    else onInfo(j);
    if (waiting?.number === n) {
      setSentTo(null);
      setDismissed(true);
    }
    setBusy(false);
  };

  /** "Use a different number": back to the form, the code left to run out. */
  const leave = () => {
    setSentTo(null);
    setDismissed(true);
    setError(null);
  };

  /** "Cancel" on the form opened with "Add another number": put it away again. */
  const cancelAdding = () => {
    setAdding(false);
    setNumber("");
    setAgree(false);
    if (error?.from === "form") setError(null);
    if (retry?.from === "form") setRetry(null);
  };

  /** A wait that's on, for a button: the form's, or the one for a saved number asked from the banner or its row. */
  const retryFor = (from: PhoneAction, n?: string) => (retry && retry.from === from && (from === "form" || retry.number === n) ? retry : null);
  /** The error to show in the banner (`banner`), or under the row (everything else). */
  const errorFor = (where: "banner" | "below") => (error && (error.from === "banner") === (where === "banner") ? error.text : null);

  return { number, setNumber, agree, setAgree, busy, error, errorFor, waiting, round, sends, justVerified, retry, setRetry, retryFor, adding, setAdding, cancelAdding, send, check, remove, leave };
}
export type OwnerPhoneState = ReturnType<typeof useOwnerPhone<PhoneCodeInfo>>;

const chip = "rounded-full px-2 py-0.5 text-[11.5px]";
const quiet = "text-[12px] text-[#9A9A98] hover:text-ink disabled:opacity-40";

/**
 * Your mobile: add it with your OK to texts, prove it's yours with the code texted to it, and only
 * then do texts and calls from it count as you (and bots text it). Numbers saved before codes existed
 * show as not verified, with a button to verify them (or the banner above, for the first one).
 *
 * - `mode` "settings" (How your bots reach you): your numbers, then the form or the code. Once a
 *   number is saved, `collapseWhenSaved` tucks the form behind "Add another number" (with Cancel to
 *   put it back), so a number still to verify has one way forward: the banner's, `bannerFor`.
 * - `mode` "setup" (the setup screen's card, which shows where it stands): only the form or the code,
 *   with `onNotNow` to put it away.
 */
export function OwnerPhone({
  info,
  phone,
  mode = "settings",
  recommended,
  collapseWhenSaved,
  bannerFor,
  onNotNow,
}: {
  info: PhoneCodeInfo;
  phone: OwnerPhoneState;
  mode?: "settings" | "setup";
  recommended?: boolean;
  collapseWhenSaved?: boolean;
  /** The saved number the banner above offers a code for: its row doesn't offer one too. */
  bannerFor?: string;
  onNotNow?: () => void;
}) {
  // Removing the last number that counts as you asks first.
  const [confirming, setConfirming] = useState<string | null>(null);
  const { number, agree, busy, waiting } = phone;
  const formRetry = phone.retryFor("form");
  const owners = info.owners ?? [];
  const canVerify = info.verify !== false;
  const counts = owners.some((o) => o.verifiedAt || o.fromEnv);
  const toVerify = unverified(owners);
  const collapsible = !!collapseWhenSaved && (counts || toVerify.length > 0);
  const lastCounting = (n: string) => !owners.some((o) => o.number !== n && (o.verifiedAt || o.fromEnv));
  const sendNew = () => {
    if (number.trim() && agree && !busy && !formRetry) void phone.send(number, true, number, "form");
  };

  const codeEntry = waiting && (
    <div className="flex flex-col gap-2 pt-1">
      <span role="status" className="text-[12.5px] leading-4 text-[#3A3A38]">
        Enter the code we texted to <span className="font-medium text-ink">{waiting.pretty}</span>.
      </span>
      <CodeInput key={phone.round} disabled={busy} onComplete={(c) => void phone.check(c)} />
      <span className="flex items-center gap-3 text-[12px] leading-4">
        <ResendButton
          key={phone.sends}
          seconds={waiting.resendInSec}
          refused={waiting.refused}
          disabled={busy}
          onResend={() => void phone.send(waiting.number, !!waiting.consent, waiting.pretty, "code")}
        />
        <button disabled={busy} onClick={phone.leave} className="text-[#9A9A98] hover:text-ink disabled:opacity-40">
          Use a different number
        </button>
      </span>
    </div>
  );

  const form = (
    <>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <input
          value={number}
          onChange={(e) => {
            phone.setNumber(e.target.value);
            if (formRetry) phone.setRetry(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendNew();
          }}
          disabled={busy}
          autoFocus={mode === "setup" || phone.adding}
          placeholder="+1 (555) 123-4567"
          aria-label="Your mobile number"
          inputMode="tel"
          autoComplete="tel"
          className="h-8 w-[190px] rounded-full bg-[#F7F7F6] px-3 text-[13px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-50"
        />
        <button
          disabled={busy || !!formRetry || !number.trim() || !agree}
          onClick={sendNew}
          className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 tabular-nums text-white disabled:opacity-40"
        >
          {formRetry ? <RetryLabel key={formRetry.at} seconds={formRetry.seconds} onDone={() => phone.setRetry(null)} /> : busy ? "Sending…" : "Send code"}
        </button>
        {onNotNow && (
          <button disabled={busy} onClick={onNotNow} className={quiet}>
            Not now
          </button>
        )}
        {mode === "settings" && collapsible && phone.adding && (
          <button disabled={busy} onClick={phone.cancelAdding} className={quiet}>
            Cancel
          </button>
        )}
      </div>
      <label className="flex max-w-[560px] cursor-pointer items-start gap-2 text-[12px] leading-[17px] text-[#6B6B6B]">
        <input type="checkbox" checked={agree} disabled={busy} onChange={(e) => phone.setAgree(e.target.checked)} className="mt-[2px] accent-[#0A0A0A]" />
        <span>
          Yes, text me from my Bops bots (Bops by Orgo): replies to my texts, finished tasks and heads-ups. How often depends on what I ask for. Message and data rates may apply. Reply STOP to opt out, HELP for help. Texts and calls from this number count as me.{" "}
          <a href={PRIVACY} target="_blank" rel="noreferrer" className="underline">Privacy</a> ·{" "}
          <a href={TERMS} target="_blank" rel="noreferrer" className="underline">Terms</a>
        </span>
      </label>
    </>
  );

  const errorLine = <ErrorLine text={phone.errorFor("below")} />;

  if (mode === "setup")
    return (
      <div className="flex flex-col gap-1.5">
        {waiting ? codeEntry : canVerify ? form : null}
        {errorLine}
      </div>
    );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <span className="text-[13px] font-medium leading-4">Your mobile</span>
        {recommended && <span className={`${chip} bg-[#F2F2F0] font-medium text-[#3A3A38]`}>Recommended</span>}
      </span>
      <span className="text-[12px] leading-4 text-[#6B6B6B]">Text and call your bots from it, and get texts from them. We text you a code to make sure it&apos;s yours.</span>

      {owners.map((o) => (
        <div key={o.number} className="flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-4 text-[#3A3A38]">
            <span className="font-medium text-ink">{o.pretty}</span>
            {o.verifiedAt ? (
              <span className={`inline-flex items-center gap-1 ${chip} bg-[#E9F6EE] font-medium text-[#1E7A44]`}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 5.2 4.1 7.2 8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {o.claimedVia ? "Linked" : "Verified"}
              </span>
            ) : o.fromEnv ? (
              <span className={`${chip} bg-[#F2F2F0] text-[#6B6B6B]`}>Set on this server</span>
            ) : (
              <span className={`${chip} bg-[#FFF4E5] font-medium text-[#9A5B00]`}>Not verified</span>
            )}
            {o.claimedVia && o.verifiedAt ? (
              <span className="text-[#9A9A98]">{`${o.claimedVia === "call" ? "called" : "texted"} your bot first ${new Date(o.verifiedAt).toLocaleDateString()}`}</span>
            ) : (
              o.consentAt && <span className="text-[#9A9A98]">{`agreed to texts ${new Date(o.consentAt).toLocaleDateString()}`}</span>
            )}
            {!o.verifiedAt && !o.fromEnv && canVerify && waiting?.number !== o.number && bannerFor !== o.number && (
              <VerifyButton phone={phone} owner={o} />
            )}
            {!o.fromEnv && canVerify && confirming !== o.number && (
              <button
                disabled={busy}
                onClick={() => (o.verifiedAt && lastCounting(o.number) ? setConfirming(o.number) : void phone.remove(o.number))}
                className="text-[12px] text-[#9A9A98] hover:text-[#B42318] disabled:opacity-40"
              >
                Remove
              </button>
            )}
          </span>
          {confirming === o.number && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] bg-[#F7F7F6] px-2.5 py-2 text-[12px] leading-4 text-[#3A3A38]">
              <span>{`Remove ${o.pretty}? Texts and calls from it won't count as you anymore.`}</span>
              <span className="flex items-center gap-3">
                <button
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    void phone.remove(o.number);
                  }}
                  className="font-medium text-[#B42318] disabled:opacity-40"
                >
                  Remove
                </button>
                <button onClick={() => setConfirming(null)} className="font-medium text-ink">
                  Keep
                </button>
              </span>
            </span>
          )}
        </div>
      ))}
      {/* The banner above says this already while it's showing. */}
      {toVerify.length > 0 && !bannerFor && (
        <span className="text-[12px] leading-4 text-[#9A5B00]">Until a number is verified, texts and calls from it don&apos;t count as you, and your bots won&apos;t text it.</span>
      )}
      {phone.justVerified && (
        <span role="status" className="text-[12px] leading-4 text-[#1E7A44]">
          Verified. Texts and calls from this number now count as you.
        </span>
      )}

      {waiting ? (
        codeEntry
      ) : !canVerify ? (
        <span className="text-[12px] leading-4 text-[#6B6B6B]">Adding or changing a number isn&apos;t available on this server yet.</span>
      ) : collapsible && !phone.adding ? (
        <button onClick={() => phone.setAdding(true)} className="self-start pt-0.5 text-[12px] font-medium text-ink underline-offset-2 hover:underline">
          Add another number
        </button>
      ) : (
        form
      )}
      {errorLine}
    </div>
  );
}

/** A saved number's "Verify": texts it a code (its OK to texts is on record), or counts down after too many codes. */
function VerifyButton({ phone, owner }: { phone: OwnerPhoneState; owner: OwnerNumber }) {
  const wait = phone.retryFor("row", owner.number);
  return (
    <button
      disabled={phone.busy || !!wait}
      onClick={() => void phone.send(owner.number, false, owner.pretty, "row")}
      className="text-[12px] font-medium tabular-nums text-ink underline-offset-2 hover:underline disabled:opacity-40"
    >
      {wait ? <RetryLabel key={wait.at} seconds={wait.seconds} onDone={() => phone.setRetry(null)} /> : "Verify"}
    </button>
  );
}
