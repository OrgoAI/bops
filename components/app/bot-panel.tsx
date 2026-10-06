"use client";

import { useEffect, useState } from "react";
import { botChatId, live, sharesComputer, workBot, workspaceOf, type AppState, type Bot, type Routine, type Session } from "@/lib/types";
import { mainOwnShort, ownComputerShort } from "@/lib/orgo-plans";
import { BotMemory } from "./bot-memory";
import { ComputerSummary } from "./computer";
import { Mascot } from "./mascot";
import { PlanNote, usePlan } from "./plan-note";
import { KeyIcon } from "./screen-cards";
import { LineLink } from "./line-link";
import { botWash, post } from "./ui";
import { accountTitle, AppLogo, botApps } from "./apps";
import { WhereToFind } from "./channels";
import { BOOK_A_CALL } from "@/lib/links";

/** The parts of a bot's profile. Its computer has a tab of its own (see panel-tabs.tsx). */
export type Section = "details" | "memory" | "phone";
const SECTIONS: Section[] = ["details", "memory", "phone"];

export function BotPanel({
  state,
  bot: b,
  section: tab,
  onSection: onTab,
  onOpenChat,
  onOpenThread,
  onOpenVault,
  onOpenComputer,
}: {
  state: AppState;
  bot: Bot;
  section: Section;
  onSection: (t: Section) => void;
  onOpenChat: (chatId: string) => void;
  onOpenThread: (s: Session) => void;
  onOpenVault: () => void;
  /** Open this bot's computer tab. */
  onOpenComputer: (botId: string) => void;
}) {
  const tabs = (
    <div className="flex gap-1">
      {SECTIONS.map((t) => (
        <button
          key={t}
          onClick={() => onTab(t)}
          className={`rounded-[10px] px-3 py-1.5 text-[14px] capitalize leading-[18px] ${
            tab === t ? (t === "details" ? "bg-white/70 font-medium text-ink shadow-[0_0_0_1px_#0000000F]" : "bg-[#EEEEEC] font-medium text-ink") : "text-[#6B6B6B] hover:text-ink"
          }`}
        >
          {t}
          {t === "phone" && <span className="ml-1 align-[1px] text-[10px] font-semibold uppercase tracking-[0.04em] text-[#9A9A98]">soon</span>}
        </button>
      ))}
    </div>
  );

  if (tab === "details") return <Details state={state} bot={b} tabs={tabs} onOpenChat={onOpenChat} onOpenVault={onOpenVault} onOpenComputer={onOpenComputer} />;

  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto bg-white px-5 py-4">
      <div className="flex flex-col items-center gap-2">
        <Mascot botId={b.id} color={b.color} size={52} />
        <div className="flex flex-col items-center gap-px">
          <div className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{b.name}</div>
          <div className="text-[13px] leading-4 text-[#6B6B6B]">{b.isMain ? "Chief of Staff · runs the team" : `${b.role} · Bops team`}</div>
        </div>
        {tabs}
      </div>
      {tab === "memory" && <BotMemory state={state} bot={b} onOpenThread={onOpenThread} />}
      {tab === "phone" && <Phone bot={b} />}
    </section>
  );
}

/* ---------------- Details: the bot's contact card ---------------- */

const EFFORT_HINT: Record<string, string> = {
  auto: "Thinks hard on tough tasks, quick on simple ones",
  low: "Fastest; fine for quick lookups",
  medium: "Balanced for most work",
  high: "Slower and more careful on every task",
};

function Details({
  state,
  bot: b,
  tabs,
  onOpenChat,
  onOpenVault,
  onOpenComputer,
}: {
  state: AppState;
  bot: Bot;
  tabs: React.ReactNode;
  onOpenChat: (chatId: string) => void;
  onOpenVault: () => void;
  onOpenComputer: (botId: string) => void;
}) {
  const routines = state.routines.filter((r) => r.botId === b.id);
  const running = state.sessions.filter((s) => s.botId === b.id && live(s)).length;
  // The workspace's number belongs to its main bot; the other bots are reached through it.
  const line = state.workspaces?.find((w) => w.id === workspaceOf(b))?.line;
  const main = state.bots.find((x) => x.isMain && workspaceOf(x) === workspaceOf(b));
  const reach = line ? (b.isMain ? line.phone : undefined) : b.phone;
  const [copied, setCopied] = useState(false);
  const glass = "bg-white/60 shadow-[inset_0_0_0_1px_#FFFFFF,0_0_0_1px_#0000000F]";

  const share = async () => {
    await navigator.clipboard.writeText([`${b.name} (${b.role}, Bops)`, b.phone, b.email].filter(Boolean).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col items-center gap-3.5 overflow-y-auto px-6 pb-5 pt-6" style={{ backgroundImage: `linear-gradient(180deg, transparent 40%, #FFFFFF 100%), ${botWash(b)}`, backgroundSize: "100% 520px", backgroundRepeat: "no-repeat", backgroundColor: "#FFFFFF" }}>
      <div className={`flex size-[104px] items-center justify-center rounded-full ${glass} shadow-[inset_0_0_0_2px_#FFFFFF,0_14px_30px_-12px_#2832002E,0_0_0_1px_#0000000F]`}>
        <Mascot botId={b.id} color={b.color} size={70} />
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <div className="text-[26px] font-bold leading-[30px] tracking-[-0.02em]">{b.name}</div>
        <div className="text-[13px] font-medium leading-4 text-[#3A3A38]">{b.isMain ? "Chief of Staff · runs the team" : `${b.role} · Bops team`}</div>
      </div>
      <div className="flex gap-3">
        {/* With a number, it texts the bot from Messages (it answers by text, as it would anyone); without one, its chat here. */}
        <ActionButton
          label={reach ? `Text ${prettyPhone(reach)}` : `Message ${b.name}`}
          onClick={() => (reach ? window.open(`sms:${reach}`) : onOpenChat(botChatId(b.id)))}
        >
          <path d="M2 6.5C2 4 4.2 2 7 2s5 2 5 4.5S9.8 11 7 11c-.6 0-1.2-.1-1.7-.2L2.5 12l.7-2.3C2.4 8.8 2 7.7 2 6.5z" fill="#0A0A0A" />
        </ActionButton>
        {/* Every number takes calls: the workspace's (the main bot's), or the bot's own. */}
        <ActionButton label={reach ? `Call ${prettyPhone(reach)}` : "Calling arrives with its phone"} disabled={!reach} onClick={() => reach && window.open(`tel:${reach}`)}>
          <path d="M3 2.2h2.6l1 2.6-1.6 1a7 7 0 003 3l1-1.6 2.6 1V11a.9.9 0 01-.9.9A9.6 9.6 0 012.1 3.1.9.9 0 013 2.2z" fill="#0A0A0A" />
        </ActionButton>
        {/* Video calls with bots aren't here yet; meanwhile it books a video call with the Bops team. */}
        <ActionButton label="Book a 20-minute video call with the Bops team" onClick={() => window.open(BOOK_A_CALL)}>
          <rect x="1.2" y="3.5" width="8" height="7" rx="1.5" fill="#0A0A0A" />
          <path d="M9.6 6.2l3.2-2v5.6L9.6 7.8z" fill="#0A0A0A" />
        </ActionButton>
        <ActionButton label={b.email ? `Email ${b.email}` : "Its inbox is coming"} disabled={!b.email} onClick={() => b.email && window.open(`mailto:${b.email}`)}>
          <rect x="1.5" y="3" width="11" height="8.5" rx="1.5" fill="none" stroke="#0A0A0A" strokeWidth="1.3" />
          <path d="M2 4l5 4 5-4" fill="none" stroke="#0A0A0A" strokeWidth="1.3" strokeLinejoin="round" />
        </ActionButton>
      </div>
      {tabs}

      <div className={`flex w-full flex-col rounded-2xl ${glass}`}>
        <Field
          label={line && b.isMain ? `mobile · ${line.type === "imessage" ? "iMessage" : "texts"} · the team's number` : "mobile · texts and calls"}
          value={reach ? prettyPhone(reach) : undefined}
          empty={line && main ? `Text ${main.name} at ${prettyPhone(line.phone)}: ${main.name} passes work to ${b.name}.` : "No number yet."}
        />
        {!line && !b.phone && <GetNumber bot={b} />}
        {/* Whose phone the number is linked to: the first to call or text it, then calls and texts from it count as the user. */}
        {reach && <LineLink key={reach} phone={reach} className="px-4 pb-[11px]" />}
        <div className="h-px bg-black/[0.05]" />
        <Field label="email" value={b.email} empty="No inbox yet." />
      </div>

      <ComputerSummary state={state} bot={b} className={`w-full ${glass}`} onOpen={() => onOpenComputer(b.id)} />
      <Uses state={state} bot={b} onOpenVault={onOpenVault} className={glass} />

      <div className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 ${glass}`}>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold leading-4">Thinking</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">{EFFORT_HINT[b.effort ?? "auto"]}</span>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
          {(["auto", "low", "medium", "high"] as const).map((e) => (
            <button
              key={e}
              onClick={() => void post("/api/bots", { botId: b.id, effort: e }, "PATCH")}
              className={`rounded-full px-2.5 py-1 text-[12px] capitalize leading-4 ${(b.effort ?? "auto") === e ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 ${glass}`}>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold leading-4">Works on</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">
            {(b.runsOn ?? "auto") === "auto" ? "Its cloud computer, or your Mac when a task needs it" : b.runsOn === "mac" ? "Your Mac, always" : "Its cloud computer, always"}
          </span>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
          {([["auto", "Auto"], ["cloud", "Cloud"], ["mac", "Your Mac"]] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => void post("/api/bots", { botId: b.id, runsOn: v }, "PATCH")}
              className={`rounded-full px-2.5 py-1 text-[12px] leading-4 ${(b.runsOn ?? "auto") === v ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {(!b.isMain || sharesComputer(b)) && state.host !== "mac" && <ComputerChoice state={state} bot={b} className={glass} />}

      <div className={`flex w-full flex-col rounded-2xl ${glass}`}>
        <div className="flex items-center justify-between px-4 pb-1 pt-[11px]">
          <span className="text-[13px] font-semibold leading-4">Routines and scheduled</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">Ask {b.name} to add one</span>
        </div>
        {routines.length === 0 ? (
          <div className="px-4 pb-3.5 pt-1 text-[13px] leading-5 text-[#6B6B6B]">
            Nothing scheduled. Try texting {b.name}: &ldquo;every weekday at 9, {b.isMain ? "send me a summary of what the team did" : "check on anything waiting"}.&rdquo;
          </div>
        ) : (
          routines.map((r, i) => <RoutineRow key={r.id} routine={r} last={i === routines.length - 1} />)
        )}
      </div>

      <WhereToFind state={state} bot={b} />

      <div className="flex w-full gap-2">
        <button onClick={() => void share()} className={`flex-1 rounded-[14px] px-4 py-[11px] text-left text-[14px] leading-[18px] ${glass}`}>
          {copied ? "Copied" : "Share contact"}
        </button>
        <button
          onClick={() => void post("/api/sessions", { botId: b.id }, "DELETE")}
          disabled={!running}
          className={`flex-1 rounded-[14px] px-4 py-[11px] text-left text-[14px] leading-[18px] text-[#B42318] disabled:text-[#C9C9C6] ${glass}`}
        >
          {running ? `Pause ${b.name} · ${running} running` : `${b.name} is idle`}
        </button>
      </div>

      {!b.isMain && <DeleteBot bot={b} />}
    </section>
  );
}

/**
 * Which computer a bot works on: the main bot's (the default; it uses free screens there) or its own,
 * a copy of the main bot's made on its first task. Its own is offered only when the user's Orgo plan
 * has room for it; else this says why, with the numbers and the plan that has room. Leaving its own
 * computer deletes it, so that asks once more. The server refuses while the bot has cloud work going
 * and says why. A main bot shows this only while it works on the free Bops computer another
 * workspace's main bot has: it can move to its own on the plan (with its team), never back.
 */
function ComputerChoice({ state, bot: b, className }: { state: AppState; bot: Bot; className: string }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shared = sharesComputer(b);
  const main = workBot({ ...b, computer: "shared" }, state.bots);
  const plan = usePlan(state);
  // A bot that has its own computer already isn't asking the plan for one.
  const noRoom = plan && !b.computerId ? (b.isMain ? mainOwnShort(plan.plan, state.bots, b) : ownComputerShort(plan.plan, state.bots, workspaceOf(b))) : null;
  const pick = async (mode: "shared" | "own") => {
    if ((mode === "shared") === shared) return;
    // Its own computer goes away when it moves to the main bot's: say so first.
    if (mode === "shared" && b.computerId && !sure) return setSure(true);
    setBusy(true);
    setError(null);
    const res = await post("/api/bots", { botId: b.id, computer: mode }, "PATCH");
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? "Couldn't change it");
    setBusy(false);
    setSure(false);
  };
  return (
    <div className={`flex w-full flex-col gap-2.5 rounded-2xl px-4 py-3 ${className}`}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold leading-4">Computer</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">
            {b.isMain
              ? `Works on your free Bops computer, which ${main.name} has, with ${b.name}'s team`
              : shared
                ? `Works on ${main.name}'s computer, on screens no one else is using`
                : "Its own cloud computer, a copy of the main bot's"}
          </span>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
          {([["shared", "Shared"], ["own", "Its own"]] as const).map(([v, label]) => (
            <button
              key={v}
              disabled={busy || (v === "own" && shared && !!noRoom)}
              onClick={() => void pick(v)}
              className={`rounded-full px-2.5 py-1 text-[12px] leading-4 disabled:opacity-60 ${(v === "shared") === shared ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {sure && (
        <div className="flex flex-col gap-2 rounded-xl bg-[#FEF3F2] px-3 py-2.5 shadow-[0_0_0_1px_#FECDCA]">
          <span className="text-[12.5px] leading-[17px] text-[#3A3A38]">
            {`Move ${b.name} to ${main.name}'s computer? Its own computer is deleted, with anything saved on it that ${main.name}'s doesn't have.`}
          </span>
          <div className="flex gap-2">
            <button onClick={() => void pick("shared")} disabled={busy} className="rounded-full bg-[#B42318] px-3 py-1 text-[12.5px] font-semibold text-white disabled:opacity-60">
              {busy ? "Moving…" : "Move and delete"}
            </button>
            <button onClick={() => setSure(false)} disabled={busy} className="rounded-full px-3 py-1 text-[12.5px] font-medium shadow-[0_0_0_1px_#E6E6E3]">
              Keep its own
            </button>
          </div>
        </div>
      )}
      {plan && noRoom && <PlanNote info={plan} short={noRoom.short} text={shared ? noRoom.text : `It will work on ${main.name}'s computer instead. ${noRoom.text}`} />}
      {error && error !== noRoom?.text && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
    </div>
  );
}

/** Deleting a bot takes its computer with it, so it asks once more, saying exactly that. */
function DeleteBot({ bot: b }: { bot: Bot }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    const res = await post("/api/bots", { botId: b.id }, "DELETE");
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Couldn't delete it");
      setBusy(false);
    }
  };
  if (!sure)
    return (
      <button onClick={() => setSure(true)} className="self-center py-1 text-[13px] text-[#9A9A98] hover:text-[#B42318]">
        Delete {b.name}
      </button>
    );
  return (
    <div className="flex w-full flex-col gap-2.5 rounded-2xl bg-[#FEF3F2] px-4 py-3 shadow-[0_0_0_1px_#FECDCA]">
      <span className="text-[13px] leading-[18px] text-[#3A3A38]">
        {sharesComputer(b)
          ? `Delete ${b.name}? Its chat, threads and routines go with it; the computer it works on stays. This can't be undone.`
          : `Delete ${b.name}? Its computer, chat, threads and routines go with it. This can't be undone.`}
      </span>
      {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
      <div className="flex gap-2">
        <button onClick={() => void remove()} disabled={busy} className="rounded-full bg-[#B42318] px-3.5 py-1.5 text-[13px] font-semibold text-white disabled:opacity-60">
          {busy ? "Deleting…" : `Delete ${b.name}`}
        </button>
        <button onClick={() => setSure(false)} disabled={busy} className="rounded-full px-3.5 py-1.5 text-[13px] font-medium shadow-[0_0_0_1px_#E6E6E3]">
          Keep
        </button>
      </div>
    </div>
  );
}

function ActionButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-[50px] items-center justify-center rounded-full bg-white/60 shadow-[inset_0_0_0_1px_#FFFFFF,0_0_0_1px_#0000000F] hover:bg-white/80 disabled:opacity-40"
    >
      <svg width="20" height="20" viewBox="0 0 14 14">
        {children}
      </svg>
    </button>
  );
}

/** "+15551234567" → "+1 (555) 123-4567". */
const prettyPhone = (n: string) => {
  const d = n.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : n;
};

/** Give the bot its own phone number (AgentPhone, about $3 a month), when phones are set up. */
function GetNumber({ bot: b }: { bot: Bot }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/api/phone")
      .then((r) => r.json())
      .then((j: { on?: boolean }) => setOn(!!j.on));
  }, []);
  if (!on) return null;
  const get = async () => {
    setBusy(true);
    setError(null);
    const res = await post("/api/phone", { action: "provision", botId: b.id });
    const j = (await res.json()) as { error?: string };
    if (j.error) setError(j.error);
    setBusy(false);
  };
  return (
    <div className="flex items-center gap-2 px-4 pb-[11px]">
      <button
        onClick={() => void get()}
        disabled={busy}
        data-tip="A real number anyone can text or call."
        className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white disabled:opacity-50"
      >
        {busy ? "Getting a number…" : `Get ${b.name} a number`}
      </button>
      {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
    </div>
  );
}

function Field({ label, value, empty }: { label: string; value?: string; empty: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center gap-2 px-4 py-[11px]">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[12px] leading-[15px] text-[#6B6B6B]">{label}</span>
        <span className={`select-text truncate text-[16px] leading-[21px] ${value ? "text-ink" : "text-[14px] text-[#9A9A98]"}`}>{value ?? empty}</span>
      </div>
      {value && (
        <button
          onClick={copy}
          aria-label={copied ? "Copied" : `Copy ${label.split(" ")[0]}`}
          className={`flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium leading-4 transition-colors ${copied ? "bg-[#2BB673]/15 text-[#1E8A55]" : "text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink"}`}
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 8.5l3 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
              <rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 3.2A1.6 1.6 0 0 0 9 2.5H4.1A1.6 1.6 0 0 0 2.5 4.1V9a1.6 1.6 0 0 0 .7 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

function RoutineRow({ routine: r, last }: { routine: Routine; last: boolean }) {
  return (
    <div className={`group flex items-center gap-2.5 px-4 py-[9px] ${last ? "" : "border-b border-black/[0.05]"}`}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] leading-[18px]">{r.title}</span>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">
          {describe(r)}
          {r.nextRunAt && r.enabled ? ` · next ${new Date(r.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
        </span>
      </div>
      <button onClick={() => void post("/api/routines", { id: r.id }, "DELETE")} className="hidden text-[12px] text-[#9A9A98] hover:text-[#B42318] group-hover:block">
        Delete
      </button>
      {r.schedule.kind === "once" && !r.enabled ? (
        <span className="rounded-full bg-[#F2F2F0] px-2.5 py-0.5 text-[12px] leading-4 text-[#3A3A38]">Done</span>
      ) : (
        <button
          onClick={() => void post("/api/routines", { id: r.id, enabled: !r.enabled }, "PATCH")}
          aria-label={r.enabled ? "Turn off" : "Turn on"}
          className={`flex h-[22px] w-[38px] items-center rounded-full p-0.5 ${r.enabled ? "justify-end bg-ink" : "justify-start bg-[#D9D9D6]"}`}
        >
          <span className={`size-[18px] rounded-full ${r.enabled ? "bg-highlighter" : "bg-white"}`} />
        </button>
      )}
    </div>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function describe(r: Routine) {
  const s = r.schedule;
  const clock = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  if (s.kind === "daily") return `Every day ${clock(s.time)}`;
  if (s.kind === "weekdays") return `Weekdays ${clock(s.time)}`;
  if (s.kind === "weekly") return `${DAYS[s.day]}s ${clock(s.time)}`;
  return `Once · ${new Date(s.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/* ---------------- What the bot uses, and where to find it ---------------- */

/** The apps and logins this bot can use, at a glance; they're managed together in the Vault. */
function Uses({ state, bot: b, onOpenVault, className }: { state: AppState; bot: Bot; onOpenVault: () => void; className: string }) {
  const apps = botApps(state, b);
  const logins = (state.vault ?? []).filter((l) => l.bots === "all" || l.bots.includes(b.id));
  return (
    <button onClick={onOpenVault} className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left hover:bg-white/80 ${className}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[13px] font-semibold leading-4">Uses</span>
        {apps.length || logins.length ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {apps.map((x) => (
              <span key={x.app} title={`${x.appName}: ${x.accounts.map((a) => `${accountTitle(a.account)} (${a.level === "read" ? "read only" : "read & act"})`).join(", ")}`}>
                <AppLogo app={x.app} name={x.appName} size={22} />
              </span>
            ))}
            {logins.map((l) => (
              <span key={l.id} title={`${l.username} on ${l.site}`} className="flex h-[22px] items-center gap-1 rounded-full bg-black/[0.05] px-2 text-[11.5px] leading-4">
                <KeyIcon />
                {l.site}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-[12px] leading-4 text-[#6B6B6B]">No apps or logins yet</span>
        )}
      </div>
      <span className="shrink-0 text-[12px] font-medium leading-4 text-ink">Manage in Vault ›</span>
    </button>
  );
}

/** Not built yet: a label that says so, wherever a feature is shown ahead of time. */
function ComingSoon() {
  return <span className="rounded-full bg-highlighter px-2 py-[3px] text-[10.5px] font-semibold uppercase leading-3 tracking-[0.05em] text-ink">Coming soon</span>;
}

/* ---------------- Phone ---------------- */

function Phone({ bot: b }: { bot: Bot }) {
  return (
    <div className="flex gap-4">
      <div className="flex w-[260px] shrink-0 items-center justify-center rounded-[20px] py-6" style={{ backgroundImage: botWash(b) }}>
        <div className="flex h-[400px] w-[196px] rounded-[38px] bg-ink p-[7px] shadow-[0_22px_44px_-16px_#28320073]">
          <div className="flex flex-1 flex-col items-center gap-3 rounded-[31px] bg-white px-4 pt-3">
            <span className="h-[18px] w-[62px] rounded-full bg-ink" />
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <Mascot botId={b.id} color={b.color} size={48} />
              <span className="text-[13px] font-semibold">{b.name}&apos;s phone</span>
              <span className="text-[11.5px] leading-4 text-[#6B6B6B]">Coming soon</span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 py-1">
        <span className="flex items-center gap-2">
          <span className="text-[14px] font-semibold leading-[18px]">A real phone, not a simulator</span>
          <ComingSoon />
        </span>
        <span className="text-[13px] leading-5 text-[#3A3A38]">
          Soon {b.name} will get its own physical phone in the cloud, with its own number for calls, texts, iMessage and two-factor codes. It will drive the phone the same way it drives its computer.
        </span>
        <div className="flex flex-wrap gap-1.5">
          {["Calls", "SMS", "iMessage", "2FA codes", "Apps"].map((x) => (
            <span key={x} className="rounded-full bg-[#F2F2F0] px-2.5 py-1 text-[12px] leading-4">
              {x}
            </span>
          ))}
        </div>
        <span className="text-[12px] leading-[17px] text-[#9A9A98]">
          Not available yet. Until then, you can text and call {b.isMain ? b.name : "your main bot"} on its number (Settings, How your bots reach you).
        </span>
      </div>
    </div>
  );
}
