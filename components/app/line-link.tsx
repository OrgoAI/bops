"use client";

import { useCallback, useEffect, useState } from "react";

/** One of the bots' numbers and the phone it's linked to, as /api/phone/lines answers it. */
type Line = {
  numberId: string;
  phone: string;
  pretty: string;
  botId: string | null;
  botName: string | null;
  owner: { number: string; pretty: string; via: string } | null;
  /** While it has no owner: until when the first phone to call or text it becomes its owner (ms), or null. */
  claimUntil: number | null;
};
type Lines = { on: boolean; lines: Line[]; error?: string };

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
const quiet = "text-[12px] font-medium text-ink underline-offset-2 hover:underline disabled:opacity-40";

/**
 * /api/phone/lines, read when shown and again every 4 seconds while a number waits for its first
 * call or text (so "Linked to …" shows as soon as it comes in), and every minute otherwise.
 */
function useLines() {
  const [info, setInfo] = useState<Lines | null>(null);
  const read = useCallback(async () => {
    const res = await fetch("/api/phone/lines", { cache: "no-store" }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as Lines | null;
    if (j) setInfo(j);
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void read(), 0);
    return () => clearTimeout(first);
  }, [read]);
  // Each answer schedules the next read.
  useEffect(() => {
    const waiting = !!info?.lines.some((l) => !l.owner && l.claimUntil && l.claimUntil > Date.now());
    const t = setTimeout(() => void read(), waiting ? 4000 : 60_000);
    return () => clearTimeout(t);
  }, [info, read]);
  return [info, setInfo] as const;
}

/** "in the next 15 minutes", "in the next minute". */
function minutesLeft(until: number, now: number) {
  const m = Math.min(15, Math.max(1, Math.ceil((until - now) / 60_000)));
  return m === 1 ? "in the next minute" : `in the next ${m} minutes`;
}

/**
 * Whose phone a bot's number is linked to: the first phone to call or text a new number in its 15
 * minutes becomes the user's (Bops Cloud keeps it), and calls and texts from it count as them. Shows
 * "Call or text … from your phone in the next 15 minutes to make it yours" while that runs, then
 * "Linked to …" with a way to unlink it; a number with neither offers to start the 15 minutes. Shows
 * nothing where numbers aren't linked this way (not signed in with Orgo, or self-hosting).
 */
export function LineLink({ phone, className = "" }: { phone: string; className?: string }) {
  const [info, setInfo] = useLines();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const line = info?.on ? info.lines.find((l) => digits(l.phone) === digits(phone)) : undefined;
  const open = !!line && !line.owner && !!line.claimUntil && line.claimUntil > now;
  // The minutes count down while the window is open (from now, not from when this was first shown).
  useEffect(() => {
    if (!open) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [open]);
  if (!line) return null;

  const act = async (action: "open" | "unlink") => {
    setBusy(true);
    setError(null);
    setConfirming(false);
    const res = await fetch("/api/phone/lines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, numberId: line.numberId }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as (Lines & { error?: string }) | null;
    if (!res?.ok || !j || j.error) setError(j?.error ?? "Couldn't do that. Try again.");
    else setInfo(j);
    setBusy(false);
  };

  return (
    <div className={`flex flex-col gap-1.5 text-[12px] leading-4 ${className}`}>
      {line.owner ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[#3A3A38]">
          <span>
            Linked to <span className="font-medium text-ink">{line.owner.pretty}</span>
          </span>
          {!confirming && (
            <button disabled={busy} onClick={() => setConfirming(true)} className="text-[#9A9A98] hover:text-[#B42318] disabled:opacity-40">
              Remove
            </button>
          )}
        </span>
      ) : open ? (
        <span role="status" className="text-[#3A3A38]">
          Call or text <span className="font-medium text-ink">{line.pretty}</span> from your phone {minutesLeft(line.claimUntil!, now)} to make it yours.
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[#6B6B6B]">
          <span>Not linked to your phone yet.</span>
          <button disabled={busy} onClick={() => void act("open")} className={quiet}>
            {busy ? "One moment…" : "Link my phone"}
          </button>
        </span>
      )}
      {confirming && line.owner && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] bg-[#F7F7F6] px-2.5 py-2 text-[#3A3A38]">
          <span>{`Unlink ${line.owner.pretty}? Calls and texts from it won't count as you anymore, and the next phone to call or text ${line.pretty} in 15 minutes becomes yours.`}</span>
          <span className="flex items-center gap-3">
            <button disabled={busy} onClick={() => void act("unlink")} className="font-medium text-[#B42318] disabled:opacity-40">
              Unlink
            </button>
            <button onClick={() => setConfirming(false)} className="font-medium text-ink">
              Keep
            </button>
          </span>
        </span>
      )}
      {error && (
        <span role="alert" className="text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}
