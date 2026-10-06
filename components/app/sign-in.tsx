"use client";

import { useEffect, useRef, useState } from "react";
import { PRIVACY, TERMS } from "@/lib/links";
import { Mascot, Spinner } from "./mascot";

/*
 * Sign in with Orgo, the app's first screen until someone is signed in. A Bops user is an Orgo
 * user: the code shown here is approved on orgo.ai in the system browser, the server picks up the
 * key (app/api/auth), and the app opens. Same flow and pacing as Orgo for Mac's sign-in window.
 */

export type AuthStatus = { signedIn: boolean; user: { id: string; email?: string; name?: string } | null; needsSignIn: boolean };

/** Who's signed in, fetched again whenever `key` changes (the state's account, so signing out anywhere shows this screen). */
export function useAuthStatus(key: unknown) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const s = (await (await fetch("/api/auth/status", { cache: "no-store" })).json()) as AuthStatus;
        if (!stop) setStatus(s);
      } catch {
        if (!stop) setTimeout(() => void load(), 1500);
      }
    };
    void load();
    return () => {
      stop = true;
    };
  }, [key, nonce]);
  return [status, () => setNonce((n) => n + 1)] as const;
}

/** Sign out of Orgo on this Mac (for the account page). The app goes back to the sign-in screen. */
export const signOutOfOrgo = () => fetch("/api/auth/signout", { method: "POST" });

type Code = { userCode: string; verificationUrl: string; expiresAt: number; interval: number };
/** What went wrong (the server's word for it, lib/server/orgo-sign-in.ts): no connection, an error on Orgo, or the Keychain refused the key. */
type Problem = "offline" | "orgo" | "keychain";
const problemOf = (error: unknown): Problem => (error === "orgo" || error === "keychain" ? error : "offline");
type Step =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; code: Code; total: number }
  | { kind: "approved"; who: string }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "problem"; problem: Problem };

/** The system browser (desktop/main.cjs hands every window.open to it). */
const openInBrowser = (url: string) => void window.open(url, "_blank", "noopener");

const primary = "flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-[13.5px] font-medium text-white disabled:opacity-50";
const secondary = "flex h-10 w-full items-center justify-center rounded-full text-[13.5px] font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });

  const start = async () => {
    setStep({ kind: "starting" });
    try {
      const res = await fetch("/api/auth/start", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as Code & { error?: string };
      if (!res.ok) return setStep({ kind: "problem", problem: problemOf(body.error) });
      setStep({ kind: "waiting", code: body, total: Math.max(1, body.expiresAt - Date.now()) });
      // The button said "Sign in with Orgo", so go on to Orgo.
      openInBrowser(body.verificationUrl);
    } catch {
      setStep({ kind: "problem", problem: "offline" });
    }
  };

  // The code was approved but the key couldn't be saved: the server still holds it, so saving again needs no new code.
  const saveAgain = async () => {
    setStep({ kind: "starting" });
    try {
      const res = await fetch("/api/auth/poll", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { status?: string; user?: AuthStatus["user"]; error?: string };
      if (!res.ok) return setStep({ kind: "problem", problem: problemOf(body.error) });
      setStep(body.status === "approved" ? { kind: "approved", who: body.user?.name || body.user?.email || "" } : { kind: "expired" });
    } catch {
      setStep({ kind: "problem", problem: "offline" });
    }
  };

  const cancel = () => {
    void fetch("/api/auth/start", { method: "DELETE" });
    setStep({ kind: "idle" });
  };

  // Ask the server on Orgo's interval; it collects the key and signs in when the code is approved.
  const code = step.kind === "waiting" ? step.code : null;
  useEffect(() => {
    if (!code) return;
    let stop = false;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      if (Date.now() >= code.expiresAt) return setStep({ kind: "expired" });
      try {
        const res = await fetch("/api/auth/poll", { method: "POST" });
        const body = (await res.json()) as { status?: string; user?: AuthStatus["user"]; error?: string };
        if (stop) return;
        // Asking again won't help the Keychain; the user has to do something first.
        if (body.error === "keychain") return setStep({ kind: "problem", problem: "keychain" });
        if (!res.ok) throw new Error(body.error);
        misses = 0;
        if (body.status === "approved") return setStep({ kind: "approved", who: body.user?.name || body.user?.email || "" });
        if (body.status === "denied") return setStep({ kind: "denied" });
        if (body.status === "expired" || body.status === "none") return setStep({ kind: "expired" });
      } catch (e) {
        // A blip on the way (wifi waking up) isn't worth a screen; three in a row is.
        if (++misses >= 3) return setStep({ kind: "problem", problem: problemOf((e as Error).message) });
      }
      timer = setTimeout(() => void tick(), code.interval * 1000);
    };
    timer = setTimeout(() => void tick(), code.interval * 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [code]);

  // "You're in" stays up a moment, then the app opens.
  useEffect(() => {
    if (step.kind !== "approved") return;
    const t = setTimeout(onSignedIn, 900);
    return () => clearTimeout(t);
  }, [step.kind, onSignedIn]);

  return (
    <div className="flex h-screen flex-col bg-desk text-ink">
      {/* The window's title bar: drag it like any other. */}
      <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
        <div className="flex w-[400px] animate-[call-in_220ms_ease-out] flex-col items-center rounded-[22px] bg-white px-8 pb-7 pt-9 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]">
          <span className={step.kind === "waiting" || step.kind === "starting" ? "animate-[bob_2.4s_ease-in-out_infinite]" : ""}>
            <Mascot botId="boppy" color="#0A0A0A" size={56} />
          </span>
          {step.kind === "waiting" ? (
            <Waiting step={step} onReopen={() => openInBrowser(step.code.verificationUrl)} onCancel={cancel} />
          ) : step.kind === "approved" ? (
            <Approved who={step.who} />
          ) : (
            <Ask step={step} onStart={() => void (step.kind === "problem" && step.problem === "keychain" ? saveAgain() : start())} />
          )}
        </div>
        <span className="pt-5 text-[12px] leading-4 text-pencil">
          By signing in you agree to Orgo&apos;s{" "}
          <a href={TERMS} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            Terms
          </a>{" "}
          and{" "}
          <a href={PRIVACY} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            Privacy Policy
          </a>
          .
        </span>
      </div>
    </div>
  );
}

function Heading({ title, line }: { title: string; line: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 pb-6 pt-5 text-center">
      <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{title}</span>
      <span className="max-w-[300px] text-[13.5px] leading-[19px] text-pencil">{line}</span>
    </div>
  );
}

const PROBLEMS: Record<Problem, { title: string; line: string; action: string }> = {
  offline: { title: "Couldn't reach Orgo", line: "Check your internet connection, then try again.", action: "Try again" },
  orgo: { title: "Orgo had a problem", line: "Something went wrong on Orgo's side. Try again in a moment.", action: "Try again" },
  keychain: { title: "Couldn't save your sign-in", line: "Your Mac didn't let Bops keep it in the keychain. Unlock your Mac, then try again.", action: "Try again" },
};

/** The first screen, and where expired, declined and failed attempts come back to. */
function Ask({ step, onStart }: { step: Step; onStart: () => void }) {
  const copy =
    step.kind === "expired"
      ? { title: "That code expired", line: "Codes last a few minutes. Get a new one and approve it in your browser.", action: "Get a new code" }
      : step.kind === "denied"
        ? { title: "Sign-in was declined", line: "This Mac wasn't approved. If that was a mistake, start again.", action: "Try again" }
        : step.kind === "problem"
          ? PROBLEMS[step.problem]
          : { title: "Welcome to Bops", line: "Sign in with your Orgo account. Your bots and their computers live there.", action: "Sign in with Orgo" };
  return (
    <>
      <Heading title={copy.title} line={copy.line} />
      <button disabled={step.kind === "starting"} onClick={onStart} className={primary}>
        {step.kind === "starting" && <Spinner size={13} color="#FFFFFF" />}
        {step.kind === "starting" ? "Getting a code" : copy.action}
      </button>
      {(step.kind === "idle" || step.kind === "starting") && (
        <span className="pt-3.5 text-center text-[12px] leading-4 text-pencil">New to Orgo? You can make an account on the next page.</span>
      )}
    </>
  );
}

function Waiting({ step, onReopen, onCancel }: { step: Extract<Step, { kind: "waiting" }>; onReopen: () => void; onCancel: () => void }) {
  // The countdown's clock, ticking once a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const left = Math.max(0, step.code.expiresAt - now);
  const clock = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
  const copy = () => {
    void navigator.clipboard?.writeText(step.code.userCode);
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <>
      <Heading title="Approve this Mac" line="Your browser is open at orgo.ai. Check that it shows this code, then approve." />
      <button
        onClick={copy}
        className="group flex w-full flex-col items-center gap-1 rounded-[14px] bg-[#F7F7F6] py-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F3F3F1]"
      >
        <span className="font-mono text-[26px] font-semibold leading-8 tracking-[0.12em]">{step.code.userCode}</span>
        <span className="text-[11.5px] leading-4 text-pencil">{copied ? "Copied" : "Click to copy"}</span>
      </button>
      <div className="flex w-full flex-col gap-2 pb-5 pt-4">
        <div className="flex items-center justify-between text-[12.5px] leading-4">
          <span className="flex items-center gap-2 text-[#3A3A38]">
            <Spinner size={12} color="#3A3A38" />
            Waiting for you to approve
          </span>
          <span className="tabular-nums text-pencil">{clock}</span>
        </div>
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-rule">
          <div className="h-full rounded-full bg-ink transition-[width] duration-1000 ease-linear" style={{ width: `${(left / step.total) * 100}%` }} />
        </div>
      </div>
      <div className="flex w-full flex-col gap-2">
        <button onClick={onReopen} className={secondary}>
          Open the page again
        </button>
        <button onClick={onCancel} className="h-8 text-[12.5px] font-medium text-pencil hover:text-ink">
          Cancel
        </button>
      </div>
    </>
  );
}

function Approved({ who }: { who: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 pb-2 pt-5 text-center">
      <span className="flex items-center gap-2 text-[20px] font-semibold leading-6 tracking-[-0.01em]">
        <svg width="18" height="18" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="7" fill="#2BB673" />
          <path d="M4 7.2l2 2L10 5" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        You&apos;re in
      </span>
      <span className="text-[13.5px] leading-[19px] text-pencil">{who ? `Signed in as ${who}. Opening Bops.` : "Opening Bops."}</span>
    </div>
  );
}
