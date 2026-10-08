"use client";

import { useEffect, useRef, useState } from "react";
import type { MailHandleCheck } from "@/cloud/protocol";
import { MAIN_WORKSPACE, workspaceOf, type AppState } from "@/lib/types";
import { Spinner } from "./mascot";
import { currentWorkspace, post } from "./ui";

/*
 * "Pick your Bops address": a workspace's part of its bots' addresses (tiger in boppy@tiger.bops.bot),
 * unique across every Bops user (lib/server/mail.ts, cloud/handles.ts).
 *
 * Why it's asked like this. Not at sign-up: an address is worth picking once there's mail to get, and
 * a question before Bops has done anything for you is friction before the value. Not as an empty
 * field: a blank box makes people stop and think up a name (choice paralysis), so it comes prefilled
 * with a suggestion that's already free (your Orgo name, or the workspace's), and most people just
 * press the one button. It's checked as you type, so "taken" never arrives after you've committed, and
 * the rules are in plain words. "Choose later" takes the suggestion for you, so nothing ever waits on
 * this step; Settings, Email changes it later (old addresses keep getting mail). When a plan set the
 * address up while the Mac was closed, the same step comes after, offering to change it.
 */

type Check = MailHandleCheck & { address: string; bot: string };
type Mode = "pick" | "offer" | "change";

/** What can be typed: lowercase letters, digits and dashes (a space, dot or underscore becomes a dash), at most 30. */
const tidy = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s._]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30);

async function ask(workspaceId: string, tried: string): Promise<Check | { error: string }> {
  const r = await fetch(`/api/mail/handle?${new URLSearchParams({ workspace: workspaceId, try: tried })}`, { cache: "no-store" }).catch(() => null);
  if (!r) return { error: "Couldn't reach Bops." };
  const j = (await r.json().catch(() => ({}))) as Check & { error?: string };
  return r.ok ? j : { error: j.error ?? "Couldn't check that right now." };
}

/**
 * The step itself, as a small sheet over the app. `pick`: the workspace's first address; `offer`:
 * Bops picked one, keep it or pick another; `change`: from Settings.
 */
export function AddressSheet({ workspaceId, workspaceName, mode, onClose }: { workspaceId: string; workspaceName?: string; mode: Mode; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"use" | "later" | null>(null);
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);

  // Checked as it's typed, a moment after the typing stops; an older answer never overwrites a newer one.
  const type = (next: string) => {
    setValue(next);
    clearTimeout(timer.current);
    const n = ++asked.current;
    if (!next) return;
    timer.current = setTimeout(() => {
      void ask(workspaceId, next).then((r) => {
        if (n !== asked.current) return;
        if ("error" in r) setError(r.error);
        else {
          setError(null);
          setCheck(r);
        }
      });
    }, 300);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  // Never in the way: Escape or a click outside puts it away for now (a first address is asked again
  // next time Bops opens, and claimed for the user after a day).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Prefilled: the suggestion for a first address, the address now for an offer or a change.
  useEffect(() => {
    void ask(workspaceId, "").then((r) => {
      if ("error" in r) return setError(r.error);
      const start = mode === "pick" ? r.suggestion : (r.current?.handle ?? r.suggestion);
      setCurrent(r.current?.handle ?? null);
      setCheck({ ...r, handle: start, status: r.current?.handle === start ? "yours" : "available", address: r.address });
      setValue(start);
      input.current?.focus();
      input.current?.select();
    });
  }, [workspaceId, mode]);

  const fresh = !!value && check?.handle === value;
  const usable = fresh && (check.status === "available" || check.status === "yours");
  const unchanged = !!current && value === current;
  const changesLeft = check?.current?.changesLeft;
  const outOfChanges = mode !== "pick" && !unchanged && changesLeft === 0;

  const use = async () => {
    if (!usable || busy || outOfChanges) return;
    if (unchanged && mode !== "pick") {
      if (mode === "offer") await post("/api/mail/handle", { workspaceId, keep: true });
      return onClose();
    }
    setBusy("use");
    setError(null);
    const r = await post("/api/mail/handle", { workspaceId, handle: value });
    const j = (await r.json().catch(() => ({}))) as { error?: string; suggestion?: string };
    setBusy(null);
    if (r.ok) return onClose();
    setError(j.error ?? "Couldn't save that address. Try again.");
    if (j.suggestion) setCheck((c) => (c ? { ...c, status: "taken", suggestion: j.suggestion! } : c));
  };
  const later = async () => {
    if (busy) return;
    if (mode === "change") return onClose();
    setBusy("later");
    const r = await post("/api/mail/handle", mode === "offer" ? { workspaceId, keep: true } : { workspaceId });
    setBusy(null);
    if (r.ok) return onClose();
    setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save that. Try again.");
  };

  const bot = check?.bot ?? "Boppy";
  const title = mode === "pick" ? "Pick your Bops address" : mode === "offer" ? "Your Bops address" : "Change your Bops address";
  const intro =
    mode === "pick"
      ? `Your bots get email at this address. Anyone can write to ${bot} here.`
      : mode === "offer"
        ? `Bops picked ${current ?? "this"}.bops.bot for you. Keep it, or change your address now.`
        : `${bot}'s main address moves to the new one. Mail to the old addresses still arrives.`;
  const note = !value
    ? null
    : !fresh
      ? { tone: "quiet", text: "Checking" }
      : check.status === "available"
        ? { tone: "good", text: "It's free" }
        : check.status === "yours"
          ? { tone: "good", text: unchanged ? "Your address now" : "Yours from before" }
          : { tone: "bad", text: check.problem ?? "That one can't be used." };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="mail-address-title"
        className="flex w-[440px] flex-col gap-4 rounded-[22px] bg-white px-[22px] pb-5 pt-[18px] shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <div className="flex flex-col gap-1">
          <span id="mail-address-title" className="text-[18px] font-semibold leading-[22px]">
            {title}
          </span>
          <span className="text-[13px] leading-[18px] text-[#6B6B6B]">
            {intro}
            {workspaceName && workspaceId !== MAIN_WORKSPACE ? <span className="text-[#9A9A98]"> For {workspaceName}.</span> : null}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {/* The handle, inline in its address: [ tiger ].bops.bot */}
          <label className="flex h-11 cursor-text items-center rounded-full bg-[#F7F7F6] pl-4 pr-4 font-mono text-[14px] shadow-[0_0_0_1px_#E6E6E3] focus-within:bg-white focus-within:shadow-[0_0_0_1.5px_#0A0A0A]">
            <input
              ref={input}
              value={value}
              onChange={(e) => type(tidy(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && void use()}
              aria-label="Your address"
              spellCheck={false}
              autoComplete="off"
              maxLength={30}
              style={{ width: `calc(${Math.max(value.length, 3)}ch + 2px)` }}
              className="min-w-0 bg-transparent font-medium text-ink outline-none"
            />
            <span className="select-none text-[#9A9A98]">.bops.bot</span>
            <span className="ml-auto flex items-center pl-2">{value && !fresh && !error ? <Spinner size={12} color="#9A9A98" /> : null}</span>
          </label>
          <div className="flex min-h-[18px] flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[12.5px] leading-[18px]">
            <span className="min-w-0 truncate text-[#3A3A38]">
              {usable ? (
                <span className="select-all font-mono">{check.address}</span>
              ) : check && fresh && check.status !== "available" && check.suggestion && check.suggestion !== value ? (
                <>
                  Try{" "}
                  <button onClick={() => type(check.suggestion)} className="font-mono font-medium text-ink underline underline-offset-2">
                    {check.suggestion}
                  </button>
                </>
              ) : null}
            </span>
            {note && (
              <span className={`flex shrink-0 items-center gap-1.5 ${note.tone === "bad" ? "text-[#B42318]" : note.tone === "good" ? "text-[#1F7A4D]" : "text-[#9A9A98]"}`}>
                {note.tone === "good" && <span className="size-[7px] rounded-full bg-[#2BB673]" />}
                {note.text}
              </span>
            )}
          </div>
          <span className="px-1 text-[12px] leading-4 text-[#9A9A98]">
            Letters, numbers and dashes, 3 to 30 characters.
            {mode !== "pick" && changesLeft !== undefined ? ` ${changesLeft === 0 ? "It can't be changed again." : `You can change it ${changesLeft} more time${changesLeft === 1 ? "" : "s"}.`}` : ""}
          </span>
        </div>

        {error && (
          <span role="alert" className="text-[12.5px] leading-[18px] text-[#B42318]">
            {error}
          </span>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <button onClick={() => void later()} disabled={!!busy} className="text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:text-ink disabled:opacity-50">
            {mode === "pick" ? (busy === "later" ? "Saving" : "Choose later") : mode === "offer" ? `Keep ${current ?? "it"}` : "Cancel"}
          </button>
          <button
            onClick={() => void use()}
            disabled={!usable || !!busy || outOfChanges}
            className="rounded-full bg-ink px-4 py-2 text-[13px] font-medium leading-4 text-white disabled:opacity-40"
          >
            {busy === "use" ? "Saving" : "Use this address"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shows the step when a workspace is waiting for its address (or has one Bops picked, to offer a
 * change): the workspace being looked at first. Gone once the user answers (the state says so).
 */
export function MailAddressStep({ state }: { state: AppState }) {
  const [closed, setClosed] = useState<string | null>(null);
  const waiting = (state.workspaces ?? []).filter((w) => w.mailPick && `${w.id}:${w.mailPick.at}` !== closed);
  const w = waiting.find((x) => x.id === currentWorkspace(state)) ?? waiting[0];
  if (!w?.mailPick) return null;
  return <AddressSheet key={w.id} workspaceId={w.id} workspaceName={w.name} mode={w.mailPick.offer ? "offer" : "pick"} onClose={() => setClosed(`${w.id}:${w.mailPick!.at}`)} />;
}

/** Settings, Email (Bops Cloud): each workspace's address, with Change, or Pick for one that has none yet. */
export function EmailAddresses({ state }: { state: AppState }) {
  const [open, setOpen] = useState<{ id: string; name: string; mode: Mode } | null>(null);
  const rows = (state.workspaces ?? []).filter((w) => w.mailClaimed || w.mailPick);
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-semibold">Email</span>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">Your bots&apos; addresses. Each workspace has its own part, yours alone.</span>
      </div>
      <div className="flex flex-col rounded-[14px] px-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        {rows.map((w) => {
          const main = state.bots.find((b) => b.isMain && workspaceOf(b) === w.id);
          const onHandle = main?.email?.endsWith(`@${w.mailSlug}.bops.bot`) ? main.email : null;
          return (
            <div key={w.id} className="flex items-center gap-3 border-b border-[#F0F0EE] py-2.5 last:border-0">
              <span className="w-[120px] shrink-0 truncate text-[13px] font-medium">{w.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[#3A3A38]">
                {w.mailClaimed && w.mailSlug ? (onHandle ?? `${w.mailSlug}.bops.bot`) : <span className="font-sans text-[#9A9A98]">No address yet</span>}
              </span>
              <button
                onClick={() => setOpen({ id: w.id, name: w.name, mode: w.mailClaimed ? "change" : "pick" })}
                className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]"
              >
                {w.mailClaimed ? "Change" : "Pick your address"}
              </button>
            </div>
          );
        })}
      </div>
      {open && <AddressSheet workspaceId={open.id} workspaceName={open.name} mode={open.mode} onClose={() => setOpen(null)} />}
    </div>
  );
}
