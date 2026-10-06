"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Typing back a code we sent, to the user's mobile (owner-phone.tsx) or to an email address
 * (owner-email.tsx): the six boxes, "Send a new code" with its wait, the wait after too many codes,
 * the call to a verify route, and reading the settings they belong to.
 */

const CODE_LENGTH = 6;

/** A verify route's answer: ok, or why not, when to try again, and whether only a new code can help now. */
export type CodeAnswer = { ok: boolean; error?: string; retryInSec?: number; resendInSec?: number; attemptsLeft?: number; restart?: boolean; expiresAt?: number };

const UNREACHABLE = "Couldn't reach Bops. Try again.";

/** POST to a verify route. Not reaching Bops is an answer too, so there's always something to show. */
export async function postJson<A extends CodeAnswer>(url: string, body: Record<string, unknown>): Promise<A> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as A;
  } catch {
    return { ok: false, error: UNREACHABLE } as A;
  }
}

/**
 * GET a settings route once (/api/phone, /api/owner-email). `failed` when Bops couldn't be reached or
 * didn't answer with JSON (a restart, say), and `retry` reads it again: a row never sits at
 * "Checking" for good.
 */
export function useInfo<T>(url: string) {
  const [info, setInfo] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    fetch(url, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<T>;
      })
      .then((j) => current && setInfo(j))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [url, attempt]);
  const retry = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };
  return [info, setInfo, { failed, retry }] as const;
}

/** A wait as "11:42" (minutes and seconds). */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** What went wrong, read out by screen readers as it appears. */
export function ErrorLine({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
      {text}
    </span>
  );
}

/**
 * "Send a new code" once the wait is over, counting down until then: "in 30s", or "in 1:00" for a
 * wait of a minute or more. `refused`: the wait is a refusal (too many codes), not the usual pause
 * between sends, and reads "Try again in 38:59" like the Send button's (RetryLabel). Keyed by its
 * parent, so a new send starts a new wait.
 */
export function ResendButton({ seconds, disabled, onResend, refused }: { seconds: number; disabled: boolean; onResend: () => void; refused?: boolean }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setLeft((x) => (x <= 1 ? (clearInterval(t), 0) : x - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  if (left > 0)
    return (
      <span className="tabular-nums text-[#9A9A98]">{refused ? `Try again in ${clock(left)}` : `Send a new code in ${seconds >= 60 ? clock(left) : `${left}s`}`}</span>
    );
  return (
    <button disabled={disabled} onClick={onResend} className="font-medium text-ink underline-offset-2 hover:underline disabled:opacity-40">
      Send a new code
    </button>
  );
}

/**
 * "Try again in 11:42" on a Send button after too many codes, counting down; `onDone` once the wait
 * is over. Keyed by its parent, so a new refusal starts a new wait.
 */
export function RetryLabel({ seconds, onDone }: { seconds: number; onDone: () => void }) {
  const [left, setLeft] = useState(seconds);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setLeft((x) => (x <= 1 ? (clearInterval(t), 0) : x - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  useEffect(() => {
    if (left <= 0) done.current();
  }, [left]);
  return <>{`Try again in ${clock(left)}`}</>;
}

/** Six boxes for the code: typing moves on, backspace moves back, a pasted code fills them all. `ariaLabel` says where the code came from. */
export function CodeInput({ disabled, onComplete, ariaLabel = "Code from the text" }: { disabled: boolean; onComplete: (code: string) => void; ariaLabel?: string }) {
  const [digits, setDigits] = useState<string[]>(() => Array(CODE_LENGTH).fill(""));
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const fill = (from: number, typed: string) => {
    const incoming = typed.replace(/\D/g, "").slice(0, CODE_LENGTH - from);
    if (!incoming) return;
    const next = [...digits];
    for (let i = 0; i < incoming.length; i++) next[from + i] = incoming[i];
    setDigits(next);
    const end = Math.min(from + incoming.length, CODE_LENGTH - 1);
    boxes.current[end]?.focus();
    if (next.every(Boolean)) onComplete(next.join(""));
  };
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={ariaLabel}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          autoFocus={i === 0}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          maxLength={CODE_LENGTH}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            if (!v) {
              const next = [...digits];
              next[i] = "";
              setDigits(next);
              return;
            }
            // A digit typed over one already there, or an autofilled code.
            fill(i, v.length > 1 && d ? v.replace(d, "") || v : v);
          }}
          onPaste={(e) => {
            e.preventDefault();
            fill(0, e.clipboardData.getData("text"));
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digits[i] && i > 0) {
              const next = [...digits];
              next[i - 1] = "";
              setDigits(next);
              boxes.current[i - 1]?.focus();
              e.preventDefault();
            } else if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
            else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) boxes.current[i + 1]?.focus();
          }}
          className="h-9 w-8 rounded-[10px] bg-[#F7F7F6] text-center text-[15px] font-medium tabular-nums outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-50"
        />
      ))}
    </div>
  );
}
