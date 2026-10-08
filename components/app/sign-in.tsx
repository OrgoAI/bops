"use client";

import { useEffect, useRef, useState } from "react";
import { PRIVACY, TERMS } from "@/lib/links";
import { Mascot, Spinner } from "./mascot";
import { useTelemetryHere } from "./usage-data";

/*
 * Signing in, the app's first screen until someone is signed in. A Bops user is an Orgo user, but
 * they needn't know it: Continue with Google and Continue with email open Orgo's page straight on
 * that way in, shown as Bops (a new account if they haven't got one), and Sign in with Orgo is there
 * for people who already have an Orgo login. Every way ends the same: the code shown here is approved
 * in the system browser, the server picks up the key (app/api/auth), and the app opens. Same flow
 * and pacing as Orgo for Mac's sign-in window.
 */

/**
 * `cloudProblem`: signed in, but the user's Bops couldn't be loaded from Bops Cloud (offline): the
 * app says so (CloudUnreachable) and keeps asking, the server trying again a little later each time.
 */
export type AuthStatus = { signedIn: boolean; user: { id: string; email?: string; name?: string } | null; needsSignIn: boolean; cloudProblem?: boolean };

/**
 * Who's signed in, fetched again whenever `key` changes (the state's account, so signing out anywhere
 * shows this screen), and every few seconds while Bops Cloud can't be reached. The third value asks
 * the server to try loading the user's Bops again now (Try again).
 */
export function useAuthStatus(key: unknown) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [nonce, setNonce] = useState(0);
  const retry = useRef(false);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const now = retry.current;
        retry.current = false;
        const s = (await (await fetch(`/api/auth/status${now ? "?retry=1" : ""}`, { cache: "no-store" })).json()) as AuthStatus;
        if (stop) return;
        setStatus(s);
        if (s.cloudProblem) timer = setTimeout(() => void load(), 5000);
      } catch {
        if (!stop) timer = setTimeout(() => void load(), 1500);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [key, nonce]);
  const recheck = () => setNonce((n) => n + 1);
  const retryNow = () => {
    retry.current = true;
    recheck();
  };
  return [status, recheck, retryNow] as const;
}

/** What a sign-out asks first when some of the user's changes haven't reached Bops Cloud yet. */
const UNSENT = "Some changes haven't reached Bops Cloud yet. Sign out anyway?";

/**
 * Sign out of Orgo on this Mac (for the account page and the menu). The app goes back to the sign-in
 * screen. When some changes couldn't reach Bops Cloud the user is asked first.
 */
export async function signOutOfOrgo() {
  const send = (force: boolean) => fetch("/api/auth/signout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
  const res = await send(false);
  if (res.status !== 409) return res;
  const body = (await res.json().catch(() => ({}))) as { unsent?: boolean };
  if (!body.unsent || !window.confirm(UNSENT)) return res;
  return send(true);
}

/** Signed in, but the user's Bops couldn't be loaded from Bops Cloud: no state without it, so this says so until it can. */
export function CloudUnreachable({ onRetry }: { onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), 3000);
    return () => clearTimeout(t);
  }, [busy]);
  return (
    <div className="flex h-screen flex-col bg-desk text-ink">
      <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
        <div className="flex w-[400px] animate-[call-in_220ms_ease-out] flex-col items-center rounded-[22px] bg-white px-8 pb-7 pt-9 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]">
          <Mascot botId="boppy" color="#0A0A0A" size={56} />
          <Heading title="Can't reach Bops Cloud" line="Bops can't reach Bops Cloud to load your chats. Check your internet connection." />
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onRetry();
            }}
            className={primary}
          >
            {busy && <Spinner size={13} color="#FFFFFF" />}
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

type Code = { userCode: string; verificationUrl: string; expiresAt: number; interval: number };
/** The way in the user picked: Google or email (lib/server/orgo-sign-in.ts SignInProvider), or their Orgo login. */
type Way = "google" | "email" | "orgo";
/**
 * What went wrong (the server's word for it, lib/server/orgo-sign-in.ts): no connection, an error on
 * Orgo, the Keychain refused the key, or the user's Bops couldn't be loaded from Bops Cloud. The last
 * two keep the key Orgo gave: trying again saves it again, with no new code.
 */
type Problem = "offline" | "orgo" | "keychain" | "cloud";
const problemOf = (error: unknown): Problem => (error === "orgo" || error === "keychain" || error === "cloud" ? error : "offline");
const keepsKey = (step: Step) => step.kind === "problem" && (step.problem === "keychain" || step.problem === "cloud");
type Step =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "saving" }
  | { kind: "waiting"; code: Code; total: number }
  | { kind: "approved"; who: string }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "problem"; problem: Problem };

/** The system browser (desktop/main.cjs hands every window.open to it). */
const openInBrowser = (url: string) => void window.open(url, "_blank", "noopener");

const primary = "flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-[13.5px] font-medium text-white disabled:opacity-50";
const secondary =
  "flex h-10 w-full items-center justify-center gap-2 rounded-full text-[13.5px] font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB] disabled:opacity-50";
const link = "font-medium text-ink underline underline-offset-2 hover:text-[#3A3A38] disabled:opacity-50";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  // The way picked last: what "Try again" and "Get a new code" go back to, and what the waiting screen says.
  const [way, setWay] = useState<Way>("google");
  const telemetryHere = useTelemetryHere();

  const start = async (w: Way) => {
    setWay(w);
    setStep({ kind: "starting" });
    try {
      const res = await fetch("/api/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(w === "orgo" ? {} : { provider: w }),
      });
      const body = (await res.json().catch(() => ({}))) as Code & { error?: string };
      if (!res.ok) return setStep({ kind: "problem", problem: problemOf(body.error) });
      setStep({ kind: "waiting", code: body, total: Math.max(1, body.expiresAt - Date.now()) });
      // The button said where it goes (Google, email or Orgo), so go on there: the page already has the code.
      openInBrowser(body.verificationUrl);
    } catch {
      setStep({ kind: "problem", problem: "offline" });
    }
  };

  // The code was approved but the key couldn't be saved: the server still holds it, so saving again needs no new code.
  const saveAgain = async () => {
    setStep({ kind: "saving" });
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
        // Asking again won't help the Keychain (the user has to do something first), nor a cloud that's away.
        if (body.error === "keychain" || body.error === "cloud") return setStep({ kind: "problem", problem: body.error });
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
          <span className={step.kind === "waiting" || step.kind === "starting" || step.kind === "saving" ? "animate-[bob_2.4s_ease-in-out_infinite]" : ""}>
            <Mascot botId="boppy" color="#0A0A0A" size={56} />
          </span>
          {step.kind === "waiting" ? (
            <Waiting step={step} way={way} onReopen={() => openInBrowser(step.code.verificationUrl)} onCancel={cancel} />
          ) : step.kind === "approved" ? (
            <Approved who={step.who} />
          ) : step.kind === "idle" || step.kind === "starting" ? (
            <Welcome starting={step.kind === "starting" ? way : null} onStart={(w) => void start(w)} />
          ) : step.kind === "saving" ? (
            // Saving the key again stays on the keychain screen, busy: no new code, no way to pick.
            <Retry step={{ kind: "problem", problem: "keychain" }} busy onRetry={() => {}} onBack={() => {}} />
          ) : (
            <Retry
              step={step}
              onRetry={() => void (keepsKey(step) ? saveAgain() : start(way))}
              onBack={() => setStep({ kind: "idle" })}
            />
          )}
        </div>
        <span className="pt-5 text-[12px] leading-4 text-pencil">
          By continuing you agree to Orgo&apos;s{" "}
          <a href={TERMS} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            Terms
          </a>{" "}
          and{" "}
          <a href={PRIVACY} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            Privacy Policy
          </a>
          .
        </span>
        {telemetryHere && <span className="pt-1.5 text-[12px] leading-4 text-pencil">Bops shares usage counts and error reports with Orgo, never your content. You can turn this off in Settings.</span>}
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

/** The first screen: Google first, then email, and a small way in for people who already sign in to Orgo. `starting` is the way that's getting its code. */
function Welcome({ starting, onStart }: { starting: Way | null; onStart: (way: Way) => void }) {
  const busy = starting !== null;
  return (
    <>
      <Heading title="Welcome to Bops" line="Sign in or make an account to get started. It's free." />
      <div className="flex w-full flex-col gap-2">
        <button disabled={busy} onClick={() => onStart("google")} className={primary}>
          {starting === "google" ? <Spinner size={13} color="#FFFFFF" /> : <GoogleMark />}
          Continue with Google
        </button>
        <button disabled={busy} onClick={() => onStart("email")} className={secondary}>
          {starting === "email" ? <Spinner size={13} /> : <MailMark />}
          Continue with email
        </button>
      </div>
      <span className="flex items-center gap-1.5 pt-3.5 text-center text-[12px] leading-4 text-pencil">
        {starting === "orgo" && <Spinner size={11} color="#6B6B6B" />}
        Have an Orgo account?
        <button disabled={busy} onClick={() => onStart("orgo")} className={link}>
          Sign in with Orgo
        </button>
      </span>
    </>
  );
}

const PROBLEMS: Record<Problem, { title: string; line: string; action: string }> = {
  offline: { title: "Couldn't connect", line: "Check your internet connection, then try again.", action: "Try again" },
  orgo: { title: "Something went wrong", line: "Signing in isn't working right now. Try again in a moment.", action: "Try again" },
  keychain: { title: "Couldn't save your sign-in", line: "Your Mac didn't let Bops keep it in the keychain. Unlock your Mac, then try again.", action: "Try again" },
  cloud: { title: "Couldn't load your Bops", line: "Couldn't load your Bops from Bops Cloud. Try again.", action: "Try again" },
};

/** Where expired, declined and failed attempts come back to: again the same way, or back to pick another. */
function Retry({
  step,
  busy = false,
  onRetry,
  onBack,
}: {
  step: Extract<Step, { kind: "expired" | "denied" | "problem" }>;
  busy?: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  const copy =
    step.kind === "expired"
      ? { title: "That code expired", line: "Codes last a few minutes. Get a new one and finish in your browser.", action: "Get a new code" }
      : step.kind === "denied"
        ? { title: "Sign-in was declined", line: "This Mac wasn't approved. If that was a mistake, start again.", action: "Try again" }
        : PROBLEMS[step.problem];
  return (
    <>
      <Heading title={copy.title} line={copy.line} />
      <button disabled={busy} onClick={onRetry} className={primary}>
        {busy && <Spinner size={13} color="#FFFFFF" />}
        {copy.action}
      </button>
      {/* The keychain's and the cloud's retry save the key Orgo already gave; another way would throw it away. */}
      {!keepsKey(step) && (
        <button onClick={onBack} className="mt-1.5 h-8 text-[12.5px] font-medium text-pencil hover:text-ink">
          Choose another way
        </button>
      )}
    </>
  );
}

/** What to do in the browser, by the way picked. Every way lands on Orgo's page shown as Bops; Google and email go straight to that sign-in. */
const FINISH: Record<Way, string> = {
  google: "Sign in with Google, check that the page shows this code, then allow Bops.",
  email: "Sign in with your email, check that the page shows this code, then allow Bops.",
  orgo: "Your browser is open at orgo.ai. Check that it shows this code, then allow Bops.",
};

function Waiting({ step, way, onReopen, onCancel }: { step: Extract<Step, { kind: "waiting" }>; way: Way; onReopen: () => void; onCancel: () => void }) {
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
      <Heading title="Finish in your browser" line={FINISH[way]} />
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

/** Google's "G", in its own colors (they read on the dark button too). */
function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function MailMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" />
      <path d="M2.75 4.75L8 8.5l5.25-3.75" />
    </svg>
  );
}
