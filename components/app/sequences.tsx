"use client";

import { useState } from "react";
import { SETTINGS_WORDS as W } from "@/lib/bot-settings";
import { builtInsFor, type BuiltIn, type Step, type Today } from "@/lib/sequences";
import type { Bot, BotSettings } from "@/lib/types";
import { post } from "./ui";
import { undash } from "./side-group";

/*
 * A bot's sequences on its settings page (bot-settings.tsx): each built in one as a row with its switch, its title, a
 * Built in tag and today's count, then its trigger and steps as chips. The locked ones are on for good (a fact, not a
 * setting); the others save at once (PATCH /api/bots { sequence }). Also the small parts the Email and Phone cards
 * share: the inner labels, the Loop guard and If a send fails chips, and the Today row.
 */

/** A change to the bot through PATCH /api/bots: sending while it's on its way, and what went wrong under the control. */
export function useBotSave(botId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/bots", { botId, ...body }, "PATCH");
      if (res.ok) return true;
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ? undash(j.error) : W.failed);
      return false;
    } catch {
      setError(W.offline);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, send };
}

/** The small switch of a sequence's row (30 by 18). */
export function Toggle({ label, on, onFlip, disabled, tip }: { label: string; on: boolean; onFlip?: (on: boolean) => void; disabled?: boolean; tip?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-tip={tip}
      disabled={disabled}
      onClick={() => onFlip?.(!on)}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:cursor-default ${on ? "bg-ink" : "bg-[#D9D9D5]"} ${disabled && !tip ? "opacity-50" : ""}`}
    >
      <span className={`absolute top-0.5 size-[14px] rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-all ${on ? "left-[14px]" : "left-0.5"}`} />
    </button>
  );
}

/** A card's inner label ("SEQUENCES"), with an action on its right. */
export function InnerLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-2.5 flex items-center justify-between gap-2">
      <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.02em] text-[#9A9A97]">{children}</span>
      {action}
    </div>
  );
}

/** The trigger's small mark: a letter or a phone. */
function TriggerIcon({ channel }: { channel: "email" | "phone" }) {
  return channel === "email" ? (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      <rect x="1.5" y="3" width="11" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 4l5 4 5-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      <path d="M3 2.2h2.6l1 2.6-1.6 1a7 7 0 003 3l1-1.6 2.6 1V11a.9.9 0 01-.9.9A9.6 9.6 0 012.1 3.1.9.9 0 013 2.2z" fill="currentColor" />
    </svg>
  );
}

function Chip({ step, channel }: { step: Step; channel: "email" | "phone" }) {
  const look =
    step.kind === "trigger"
      ? "bg-ink text-white"
      : step.kind === "ok"
        ? "bg-[#EEF4FF] text-[#1D4ED8] shadow-[inset_0_0_0_1px_#CFE0FF]"
        : "bg-[#F6F6F4] text-[#3A3A38] shadow-[inset_0_0_0_1px_#E8E8E5]";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-[9px] py-1 text-[11.5px] leading-4 ${look}`}>
      {step.kind === "trigger" && <TriggerIcon channel={channel} />}
      {step.text}
    </span>
  );
}

/** One sequence: its switch, title, Built in, today's count (or what off means), then its steps. */
export function SequenceRow({ seq, bot: b, set, today, onFlip, busy }: { seq: BuiltIn; bot: Bot; set: BotSettings; today: Today; onFlip: (on: boolean) => void; busy?: boolean }) {
  const on = seq.on(set);
  const steps = seq.steps(b, set);
  return (
    <div data-seq={seq.id} data-on={on} className={`rounded-xl bg-white px-3 py-2.5 shadow-[0_0_0_1px_#ECECEA] ${on ? "" : "opacity-[0.55]"}`}>
      <div className="flex items-center gap-2.5">
        <Toggle label={seq.title} on={on} disabled={seq.locked || busy} tip={seq.locked ? W.locked : undefined} onFlip={seq.locked ? undefined : onFlip} />
        <span className="text-[13px] font-semibold leading-4">{seq.title}</span>
        <span className="rounded-full px-[7px] py-px text-[10px] leading-[14px] text-[#6B6B6B] shadow-[inset_0_0_0_1px_#E8E8E5]">{W.builtIn}</span>
        <span className="ml-auto truncate text-[11.5px] leading-4 text-[#6B6B6B]" data-seq-count>
          {on ? seq.count(today) : seq.offLine}
        </span>
      </div>
      <div className="mt-[9px] flex flex-wrap items-center gap-1.5">
        {steps.map((s, i) => (
          <span key={s.text} className="inline-flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-[11px] text-[#B5B5B1]">
                →
              </span>
            )}
            <Chip step={s} channel={seq.channel} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** A channel's sequences: the label with how many are on, then each built in one (a sequence of your own is to come, not shown yet). */
export function Sequences({ bot: b, set, channel, today }: { bot: Bot; set: BotSettings; channel: "email" | "phone"; today: Today }) {
  const { busy, error, send } = useBotSave(b.id);
  const list = builtInsFor(channel);
  const on = list.filter((s) => s.on(set)).length;
  return (
    <div data-sequences={channel}>
      <InnerLabel>
        {W.sequences} <span className="ml-1 normal-case tracking-normal">{W.nOn(on)}</span>
      </InnerLabel>
      <div className="flex flex-col gap-2">
        {list.map((s) => (
          <SequenceRow key={s.id} seq={s} bot={b} set={set} today={today} busy={busy} onFlip={(v) => void send({ sequence: { id: s.id, on: v } })} />
        ))}
      </div>
      {error && (
        <span role="alert" className="mt-1.5 block text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

/** Facts as green chips with a tick (Loop guard), or plain white ones. */
export function FactChips({ items, plain }: { items: readonly string[]; plain?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((x) => (
        <span
          key={x}
          className={`inline-flex items-center gap-1 rounded-full px-[9px] py-1 text-[11.5px] leading-4 ${plain ? "bg-white text-[#3A3A38] shadow-[inset_0_0_0_1px_#E8E8E5]" : "bg-[#F2F7F2] text-[#1F6F3A] shadow-[inset_0_0_0_1px_#D5E8D7]"}`}
        >
          {!plain && (
            <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 8.5l3 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {x}
        </span>
      ))}
    </div>
  );
}

/** Today's row: the counts, and an action on its right. */
export function TodayRow({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div data-today className="mt-3 flex items-center gap-3 rounded-xl bg-[#F6F6F4] px-3.5 py-3">
      <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-[#3A3A38]">{text}</span>
      {action}
    </div>
  );
}
