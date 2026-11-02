"use client";

import { useEffect, useRef, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import type { ComputerSize, ComputerSizeChange, SizeOffer, UsageTerms } from "@/lib/bops-billing";
import { computerResized, confirmWords, doneWords, offerWords, PHASE_WORDS, PICK_WORDS, RESTART_WORDS, SIZE_REFUSED, settingsHint, type SizePhase, type SizeView } from "@/lib/computer-size";
import type { AppState } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
import { Segmented } from "./segmented";
import { AskInPlace, refreshState } from "./ui";

/*
 * The size of the user's free Bops computer, billed by use (lib/computer-size.ts): Pick your computer, asked
 * once per account as Bops opens (Medium first for someone new, the computer's own size for someone who has
 * one), and Your computer in Settings, Your plan, to switch it any time. Prices and hours are Orgo's, from
 * its plan read; the local server does the switching (app/api/computer/size).
 */

/** What a switch said last: done, or why not (and where to add credit, when that's why). */
type Said = { ok: true; text: string } | { ok: false; text: string; topUpUrl?: string };

/**
 * Switching the size: POST /api/computer/size, with how far it has got (GET ?phase=1) while it waits, so the
 * button says Waking or Restarting when it does. Done, the computer's live views stream afresh and the state
 * is read again. `keep`: the size the computer already is, answered without asking Orgo (nothing to switch).
 */
function useSizeSwitch() {
  const [busy, setBusy] = useState<ComputerSize | null>(null);
  const [phase, setPhase] = useState<SizePhase>("switching");
  const [said, setSaid] = useState<Said | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      void fetch("/api/computer/size?phase=1", { cache: "no-store" })
        .then((r) => r.json() as Promise<Partial<SizeView>>)
        .then((v) => live.current && v.switching && setPhase(v.switching))
        .catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [busy]);
  const run = async (offer: SizeOffer, { keep = false } = {}): Promise<boolean> => {
    setBusy(offer.key);
    setPhase("switching");
    setSaid(null);
    try {
      const res = await fetch("/api/computer/size", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(keep ? { size: offer.key, keep: true } : { size: offer.key }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; changed?: boolean; computerId?: string; error?: string; topUpUrl?: string };
      // Every live view of that computer in the window streams it afresh, whether or not this one is still open.
      if (j.ok && j.changed) computerResized(j.computerId);
      if (!live.current) return !!j.ok;
      if (j.ok) {
        if (j.changed) setSaid({ ok: true, text: doneWords(offer) });
        await refreshState();
        return true;
      }
      setSaid({ ok: false, text: j.error ?? SIZE_REFUSED.failed, ...(j.topUpUrl ? { topUpUrl: j.topUpUrl } : {}) });
      return false;
    } catch {
      if (live.current) setSaid({ ok: false, text: SIZE_REFUSED.failed });
      return false;
    } finally {
      if (live.current) setBusy(null);
    }
  };
  return { busy, phase, said, run, clear: () => setSaid(null) };
}

/** Orgo's top up, in the browser, under a refusal for want of credit. */
function AddCredit({ url, surface }: { url: string; surface: "account" | "computer" }) {
  return (
    <button
      onClick={() => {
        trackEvent("bops_add_credit_clicked", { surface });
        window.open(url, "_blank");
      }}
      className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white"
    >
      Add credit on Orgo
    </button>
  );
}

/**
 * Pick your computer, asked once per account when Bops opens (`view.needed`), for a user billed by use:
 * each size with its price, about how long $5 runs it and what it's for (on the Orgo plan, that it's part
 * of the plan instead), the computer's own size (or Medium for someone new) picked first. Continue keeps
 * that size, answered without asking Orgo, or switches to the one picked, said first to maybe restart the
 * computer; with no computer yet, it's the size one is made at. After a try that didn't work, the computer
 * can be kept as it is, or the card closed for now (it's asked again next time Bops opens).
 */
export function PickComputer({ view, onDone }: { view: SizeView; onDone: () => void }) {
  const [pick, setPick] = useState<ComputerSize>(view.preselect ?? view.sizes[0].key);
  const { busy, phase, said, run } = useSizeSwitch();
  const offer = view.sizes.find((s) => s.key === pick) ?? view.sizes[0];
  const kept = view.current ? view.sizes.find((s) => s.key === view.current) : undefined;
  const plan = view.change === "plan";
  const switching = !!view.current && pick !== view.current;
  const go = async (o: SizeOffer) => {
    if (await run(o, { keep: !!view.current && o.key === view.current })) onDone();
  };
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-desk text-ink" data-pick-computer>
      <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-16">
        <div className="flex w-[440px] max-w-full animate-[call-in_220ms_ease-out] flex-col items-center rounded-[22px] bg-white px-8 pb-7 pt-9 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]">
          <Mascot botId="boppy" color="#0A0A0A" size={56} />
          <div className="flex flex-col items-center gap-1.5 pb-5 pt-5 text-center">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{PICK_WORDS.title}</span>
            <span className="max-w-[320px] text-[13.5px] leading-[19px] text-pencil">{plan ? PICK_WORDS.planLine : PICK_WORDS.line}</span>
          </div>
          <div role="radiogroup" aria-label={PICK_WORDS.title} className="flex w-full flex-col gap-2">
            {view.sizes.map((s) => {
              const w = offerWords(s, view.change);
              const on = s.key === pick;
              return (
                <button
                  key={s.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!!busy}
                  onClick={() => setPick(s.key)}
                  className={`flex w-full flex-col gap-0.5 rounded-[14px] px-4 py-3 text-left disabled:opacity-60 ${on ? "shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-semibold leading-5">{w.name}</span>
                    <span className="flex items-center gap-2">
                      {view.current === s.key && <span className="rounded-full bg-[#F2F2F0] px-2 py-0.5 text-[11px] font-medium leading-4 text-[#3A3A38]">Current</span>}
                      {w.price && <span className="text-[13px] font-medium leading-5 tabular-nums">{w.price}</span>}
                    </span>
                  </span>
                  {w.specs && <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">{w.specs}</span>}
                  <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">
                    {w.lasts}
                    {w.blurb ? ` ${w.blurb}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <span className="pt-3 text-center text-[12px] leading-4 text-pencil">{PICK_WORDS.ai}</span>
          <span className="pb-5 pt-1 text-center text-[12px] leading-4 text-pencil">{PICK_WORDS.later}</span>
          {switching && (
            <span className="pb-3 text-center text-[12.5px] leading-[18px] text-[#3A3A38]" data-pick-restart>
              {RESTART_WORDS}
            </span>
          )}
          <button
            disabled={!!busy}
            onClick={() => void go(offer)}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-[13.5px] font-medium text-white disabled:opacity-50"
          >
            {busy && <Spinner size={13} color="#FFFFFF" />}
            {busy ? PHASE_WORDS[phase] : PICK_WORDS.action}
          </button>
          {said && !said.ok && (
            <div className="flex w-full flex-col items-center gap-2 pt-3 text-center">
              <span className="text-[12.5px] leading-[18px] text-[#B42318]">{said.text}</span>
              {said.topUpUrl && <AddCredit url={said.topUpUrl} surface="computer" />}
              {kept && kept.key !== pick && (
                <button disabled={!!busy} onClick={() => void go(kept)} className="text-[12.5px] font-medium text-ink underline underline-offset-2 disabled:opacity-50">
                  Keep {kept.name}
                </button>
              )}
              <button disabled={!!busy} onClick={onDone} className="text-[12.5px] font-medium text-pencil underline underline-offset-2 disabled:opacity-50" data-pick-not-now>
                {PICK_WORDS.notNow}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Whether to ask Pick your computer now: once the state is in, for a signed in account that hasn't answered
 * it, the local server says whether it's needed (billed by use, Orgo lists sizes). Null otherwise, and when
 * the answer didn't come: it never stands in the way.
 */
export function useSizePick(state: AppState | null) {
  const [view, setView] = useState<SizeView | null>(null);
  const ask = !!state?.account && !state.computerSizeChosenAt;
  useEffect(() => {
    if (!ask) return;
    let gone = false;
    void fetch("/api/computer/size", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SizeView>) : null))
      .then((v) => !gone && setView(v?.needed && v.sizes.length > 1 ? v : null))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [ask]);
  return { view: ask ? view : null, done: () => setView(null) };
}

/**
 * Settings, Your plan: the computer's size, with a switch between the sizes Orgo lists, asked first with what
 * the new size costs (never on the Orgo plan, whose price stands) and that the computer may restart. Only for
 * a user billed by use with a computer, when Orgo lists sizes; while it's set up, a line says so instead.
 */
export function YourComputer({ usage }: { usage: UsageTerms }) {
  const sizes = usage.sizes ?? [];
  const key = usage.computer.key;
  const [asking, setAsking] = useState<SizeOffer | null>(null);
  // Switched here: shown at once, before Orgo's plan is read again (the sheet does when Bops comes back to the front).
  const [switched, setSwitched] = useState<{ from: ComputerSize; to: ComputerSize } | null>(null);
  const { busy, phase, said, run, clear } = useSizeSwitch();
  if (sizes.length < 2 || !key || !usage.computer.id) return null;
  const change: ComputerSizeChange | undefined = usage.computer.change;
  const now = sizes.find((s) => s.key === (switched?.from === key ? switched.to : key));
  if (!now) return null;
  const shown = busy ? (sizes.find((s) => s.key === busy) ?? now) : now;
  const pending = change === null;
  return (
    <div className="flex flex-col gap-2 rounded-[14px] p-4 shadow-[0_0_0_1px_#E6E6E3]" data-your-computer>
      <Segmented
        title="Your computer"
        hint={settingsHint(shown, change)}
        value={shown.key}
        options={sizes.map((s) => [s.key, s.name] as const)}
        disabled={!!busy || pending || !!asking}
        onPick={(k) => {
          clear();
          setAsking(sizes.find((s) => s.key === k) ?? null);
        }}
      />
      {pending && <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{SIZE_REFUSED.pending}</span>}
      {asking &&
        (() => {
          const w = confirmWords(asking, change);
          return (
            <AskInPlace
              compact
              title={w.title}
              line={w.line}
              action={w.action}
              onCancel={() => setAsking(null)}
              onConfirm={() => {
                const o = asking;
                setAsking(null);
                void run(o).then((ok) => ok && setSwitched({ from: key, to: o.key }));
              }}
            />
          );
        })()}
      {busy && (
        <span className="flex items-center gap-1.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
          <Spinner size={11} color="#6B6B6B" />
          {PHASE_WORDS[phase]}
        </span>
      )}
      {said && (
        <div className="flex flex-col items-start gap-2">
          <span className={`text-[12.5px] leading-[18px] ${said.ok ? "text-[#3A3A38]" : "text-[#B42318]"}`}>{said.text}</span>
          {!said.ok && said.topUpUrl && <AddCredit url={said.topUpUrl} surface="account" />}
        </div>
      )}
    </div>
  );
}
