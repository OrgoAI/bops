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
 * address up while the Mac was closed, the same step comes after, offering to change it. Not as a
 * dialog over the app either: a card in the sidebar, beside whatever you're doing.
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
 * The step itself, never over the app: `card`, a card in the sidebar above its footer (MailAddressStep, unasked: it
 * takes no focus), or `inline`, in place under its row in Settings, Email and phone (EmailAddresses). `pick`: the
 * workspace's first address; `offer`: Bops picked one, keep it or pick another; `change`: from Settings. It rises in as
 * it opens, unless `still` (see MailAddressStep). Esc in it puts it away for now, and only it.
 */
export function AddressForm({
  workspaceId,
  workspaceName,
  mode,
  place = "inline",
  still = false,
  onClose,
}: {
  workspaceId: string;
  workspaceName?: string;
  mode: Mode;
  place?: "card" | "inline";
  still?: boolean;
  onClose: () => void;
}) {
  // Decided once, as it opens.
  const [eases] = useState(!still);
  const card = place === "card";
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
  // Never in the way: Esc in it puts it away for now (a first address is asked again next time Bops opens, and
  // claimed for the user after a day), and only it: preventDefault keeps the page it's on.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    onClose();
  };

  // Prefilled: the suggestion for a first address, the address now for an offer or a change.
  useEffect(() => {
    void ask(workspaceId, "").then((r) => {
      if ("error" in r) return setError(r.error);
      const start = mode === "pick" ? r.suggestion : (r.current?.handle ?? r.suggestion);
      setCurrent(r.current?.handle ?? null);
      setCheck({ ...r, handle: start, status: r.current?.handle === start ? "yours" : "available", address: r.address });
      setValue(start);
      // Asked for (Change, Pick in Settings): the field is ready to type in. The sidebar's card, unasked, takes no focus.
      if (!card) {
        input.current?.focus();
        input.current?.select();
      }
    });
  }, [workspaceId, mode, card]);

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

  const titleId = `mail-address-${place}-${workspaceId}`;
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
      <div
        role="group"
        aria-labelledby={titleId}
        data-mail-address={place}
        onKeyDown={onKey}
        className={`flex flex-col bg-white ${card ? "mx-1 mt-3 gap-3 rounded-[14px] px-3.5 pb-3.5 pt-3 shadow-[0_0_0_1px_#E6E6E3,0_8px_20px_-14px_#00000040]" : "gap-4 rounded-[14px] px-4 pb-4 pt-3.5 shadow-[0_0_0_1px_#E6E6E3]"} ${eases ? "motion-rise-in" : ""}`}
      >
        <div className="flex flex-col gap-1">
          <span id={titleId} className={card ? "text-[14px] font-semibold leading-[18px]" : "text-[15px] font-semibold leading-5"}>
            {title}
          </span>
          <span className={card ? "text-[12px] leading-4 text-[#6B6B6B]" : "text-[13px] leading-[18px] text-[#6B6B6B]"}>
            {intro}
            {workspaceName && workspaceId !== MAIN_WORKSPACE ? <span className="text-[#9A9A98]"> For {workspaceName}.</span> : null}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {/* The handle, inline in its address: [ tiger ].bops.bot */}
          <label className={`flex cursor-text items-center rounded-full bg-[#F7F7F6] font-mono shadow-[0_0_0_1px_#E6E6E3] focus-within:bg-white focus-within:shadow-[0_0_0_1.5px_#0A0A0A] ${card ? "h-9 px-3 text-[13px]" : "h-11 px-4 text-[14px]"}`}>
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
            className={`rounded-full bg-ink font-medium leading-4 text-white disabled:opacity-40 ${card ? "px-3 py-1.5 text-[12.5px]" : "px-4 py-2 text-[13px]"}`}
          >
            {busy === "use" ? "Saving" : "Use this address"}
          </button>
        </div>
      </div>
  );
}

/**
 * Steps that have been on screen, kept while the step is away (it's unmounted while the sidebar is folded
 * to its rail, and comes back when it opens). Only one not shown before rises in, and not as Bops opens.
 */
const shownSteps = new Set<string>();
let stepMounted = false;
/** Steps put away for now (Choose later aside: Esc, or Settings answering it), by "workspace:asked at", for this window. */
const putAway = new Set<string>();
const awayListeners = new Set<() => void>();

/** The workspace whose address waits to be picked (or has one Bops picked, to offer a change), the one looked at first. */
function useMailStep(state: AppState) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const f = () => redraw((n) => n + 1);
    awayListeners.add(f);
    return () => void awayListeners.delete(f);
  }, []);
  const waiting = (state.workspaces ?? []).filter((w) => w.mailPick && !putAway.has(`${w.id}:${w.mailPick.at}`));
  const w = waiting.find((x) => x.id === currentWorkspace(state)) ?? waiting[0];
  const step = w?.mailPick ? `${w.id}:${w.mailPick.at}` : null;
  const close = () => {
    if (!step) return;
    putAway.add(step);
    awayListeners.forEach((f) => f());
  };
  return { w, step, close };
}

/**
 * Shows the step when a workspace is waiting for its address (or has one Bops picked, to offer a
 * change), as a card in the sidebar above its footer (sidebar.tsx): never over the app, and it takes no
 * focus. Gone once the user answers (the state says so).
 */
export function MailAddressStep({ state }: { state: AppState }) {
  const { w, step, close } = useMailStep(state);
  useEffect(() => {
    stepMounted = true;
    if (step) shownSteps.add(step);
  }, [step]);
  if (!w?.mailPick || !step) return null;
  return <AddressForm key={w.id} place="card" workspaceId={w.id} workspaceName={w.name} mode={w.mailPick.offer ? "offer" : "pick"} still={!stepMounted || shownSteps.has(step)} onClose={close} />;
}

/** The step on the folded sidebar (sidebar-rail.tsx): a round button with a blue dot, which opens the sidebar where the card is. */
export function MailAddressRail({ state, onOpen }: { state: AppState; onOpen: () => void }) {
  const { w } = useMailStep(state);
  if (!w?.mailPick) return null;
  const tip = w.mailPick.offer ? "Your Bops address: keep it or change it" : "Pick your Bops address";
  return (
    <button
      onClick={onOpen}
      aria-label={tip}
      data-tip={tip}
      data-mail-address="rail"
      className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB] active:scale-[.96]"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
        <path d="M2 3.5h12v9H2zM2 4l6 4.5L14 4" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <span aria-hidden className="absolute -right-px -top-px size-2.5 rounded-full bg-[#2F7BFF] shadow-[0_0_0_2px_#F9F9F8]" />
    </button>
  );
}

/** Settings, Email (Bops Cloud): each workspace's address (`only`: one workspace's), with Change, or Pick for one that has none yet. */
export function EmailAddresses({ state, only }: { state: AppState; only?: string }) {
  const [open, setOpen] = useState<{ id: string; name: string; mode: Mode } | null>(null);
  const rows = (state.workspaces ?? []).filter((w) => (w.mailClaimed || w.mailPick) && (!only || w.id === only));
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
              {open?.id !== w.id && (
                <button
                  onClick={() => setOpen({ id: w.id, name: w.name, mode: w.mailClaimed ? "change" : "pick" })}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]"
                >
                  {w.mailClaimed ? "Change" : "Pick your address"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* Change or Pick: the form in place under the rows, never over the page. */}
      {open && <AddressForm key={open.id} workspaceId={open.id} workspaceName={open.name} mode={open.mode} onClose={() => setOpen(null)} />}
    </div>
  );
}
