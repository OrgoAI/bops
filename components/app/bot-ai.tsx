"use client";

import { useRef, useState } from "react";
import {
  accountOf,
  AGENTS,
  agentLabel,
  agentName,
  agentState,
  agentTag,
  aiOf,
  defaultModel,
  isCli,
  MAX_AGENTS,
  modelsFor,
  OPENCODE_OTHER,
  PAYS_NAMES,
  PAYS_SHOWN,
  PAYS_SOON,
  paysLabel,
  sharesComputerWithLogins,
  upper,
} from "@/lib/agents";
import { BRAINS_ON, brainRuns, live, threadRunner, waitsForOk, workBot, type AgentKind, type AgentPays, type AppState, type Bot, type BotAgent, type Session } from "@/lib/types";
import { AgentMark, OpenAiMark, type MarkState } from "./agent-marks";
import { brainSignIn } from "./brains";
import { Fold } from "./fold";
import { DefaultPill, NewThread, useBotKeys, useDismiss } from "./new-thread";
import { undash } from "./side-group";
import { post } from "./ui";

/**
 * A bot's AI, in its profile (lib/agents.ts): the agents it can run as tiles, the Default marked; tap one to change
 * its model, how it pays and its account; how hard it thinks; the threads it has going now, each with its agent's
 * mark; a new thread on the agent of your pick; its own terminal; and which AI takes its calls. A bot is the window
 * and each thread a tab: every thread runs on the agent picked for it, with this bot's own accounts.
 */

const glassRow = "flex w-full items-center gap-3";
const pill = "rounded-full px-2.5 py-1 text-[12px] leading-4";
const btnDark = "rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white hover:bg-[#2A2A28] disabled:opacity-50";
const btnLight = "rounded-full bg-[#F2F2F0] px-3 py-1.5 text-[12.5px] font-medium leading-4 text-ink hover:bg-[#EAEAE7] disabled:opacity-50";
const quiet = "text-[12px] leading-4 text-[#6B6B6B]";

/** A change to the bot's AI (POST /api/bots/ai): why not, or the agent it added. */
async function change(botId: string, body: Record<string, unknown>): Promise<{ error: string | null; added?: string }> {
  try {
    const res = await post("/api/bots/ai", { botId, ...body });
    const j = (await res.json().catch(() => ({}))) as { error?: string; added?: string };
    return res.ok ? { error: null, ...(j.added ? { added: j.added } : {}) } : { error: undash(j.error ?? "That didn't change. Try again.") };
  } catch {
    return { error: "Couldn't reach Bops. Try again." };
  }
}

/** The agent a thread runs on, for its mark: the CLI that ran it, else the one it was given, else Bops agent. */
export function threadKind(s: Pick<Session, "agent" | "brainRun" | "onBopsAgent" | "agentSessionId" | "responseId">): AgentKind {
  const r = threadRunner(s);
  if (r && r !== "agent") return r;
  if (r === "agent") return "bops";
  return BRAINS_ON && s.agent ? s.agent.kind : "bops";
}

/**
 * The agent a thread runs on, in words: "Claude Code · Opus 5.5", and how it pays ("your Max plan", "Bops AI credit"),
 * when its bot's profile still has it; beside another of its kind on the bot, what tells them apart ("your Max plan 2").
 */
export function threadAgentWords(s: Session, b: Bot | undefined, state: AppState): { label: string; pays?: string } {
  const kind = threadKind(s);
  const model = s.agent?.kind === kind ? s.agent.model : undefined;
  if (kind === "bops") return { label: agentLabel({ kind, model }), pays: "Bops AI credit" };
  const x = b ? aiOf(b, state).agents.find((y) => y.id === (s.brainRun?.agentId ?? s.agent?.id) && y.kind === kind) : undefined;
  if (!b || !x) return { label: agentLabel({ kind, model }) };
  const tag = agentTag(x, { bot: b, state });
  return { label: agentLabel({ kind, model: model ?? x.model }), pays: tag && x.pays !== "credit" ? `your ${tag}` : paysLabel(x, state, s.brainRun?.computerId) };
}

/** How a thread is now, for the dot on its mark (herdr's rule: it needs you only when it asked). */
export function markState(s: Session, state: Pick<AppState, "appApprovals">): MarkState {
  if (!s.dismissed && (s.waitingOnYou || s.blocker || waitsForOk(s, state) || (!!s.brainRun?.waits && !live(s)))) return "needs";
  if (live(s)) return "working";
  if (s.status === "failed" && !/stopped|dismissed|moved|paused/i.test(s.error ?? "")) return "failed";
  return "done";
}

/**
 * A thread's state in a word or two, after its title, when it isn't plain working: "needs your OK" only for an approval.
 * In a workspace someone shared with the viewer, it's the owner it waits on, never the viewer ("needs the owner").
 */
export function stateWords(s: Session, state: Pick<AppState, "appApprovals" | "shared">) {
  const ms = markState(s, state);
  if (ms === "needs") return waitsForOk(s, state) ? (state.shared ? "needs the owner's OK" : "needs your OK") : state.shared ? "needs the owner" : "needs you";
  if (ms === "failed") return "didn't finish";
  if (ms === "working") return "";
  const why = s.status === "failed" ? (s.error ?? "") : "";
  if (/open in the terminal/i.test(why)) return "in its terminal";
  if (/^paused/i.test(why)) return "paused";
  if (/^stopped/i.test(why)) return "stopped";
  return "done";
}
const WORST: MarkState[] = ["needs", "failed", "working", "done"];

/** The bot's threads worth showing now: going, waiting on you, or ended in the last day and not dismissed. Going and waiting first. */
function threadsNow(state: AppState, b: Bot) {
  const day = Date.now() - 24 * 3600_000;
  return state.sessions
    .filter((s) => s.botId === b.id && !s.replacedBy && !s.dismissed && (live(s) || markState(s, state) === "needs" || (s.endedAt ?? s.createdAt) > day))
    .sort((x, y) => WORST.indexOf(markState(x, state)) - WORST.indexOf(markState(y, state)) || (y.endedAt ?? y.createdAt) - (x.endedAt ?? x.createdAt));
}

/** One agent of the profile as a tile: its mark, name and how it is, the Default marked whatever its state. `on`: its editor is open. */
export function AgentTile({ agent: x, bot: b, state, isDefault, on, keys, onClick }: { agent: BotAgent; bot: Bot; state: AppState; isDefault: boolean; on?: boolean; keys?: ReadonlySet<string>; onClick?: () => void }) {
  const st = agentState(x, b, state, keys);
  const soon = !!st.soon;
  const at = { bot: b, state };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={onClick ? !!on : undefined}
      aria-disabled={soon || undefined}
      title={soon ? `Soon: ${st.soon}` : `${agentLabel(x, at)} · ${paysLabel(x, state, workBot(b, state.bots).computerId)}`}
      className={`flex min-w-[148px] max-w-full items-center gap-2.5 rounded-[14px] bg-white px-3 py-2 text-left ${on ? "shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:shadow-[0_0_0_1px_#C9C9C6]"} ${soon ? "opacity-55" : ""}`}
    >
      <AgentMark kind={x.kind} size={18} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-[13px] font-medium leading-4 text-ink">
          <span className="truncate">{agentName(x, at)}</span>
          {soon && <span className="shrink-0 rounded-full bg-[#F2F2F0] px-1.5 text-[10.5px] font-normal leading-[14px] text-[#6B6B6B]">Soon</span>}
          {isDefault && <DefaultPill />}
        </span>
        <span className={`truncate text-[11.5px] leading-[15px] ${!st.ready && !soon && st.button ? "text-[#B54708]" : "text-[#6B6B6B]"}`}>{st.line}</span>
      </span>
    </button>
  );
}

/** The model an agent's threads start on: its list, and for OpenCode any other provider/model. */
function ModelRow({ agent: x, disabled, onPick }: { agent: BotAgent; disabled?: boolean; onPick: (model: string | null) => void }) {
  const list = modelsFor(x.kind);
  const current = x.model ?? list[0]?.id ?? "";
  const other = x.kind === "opencode" && !!x.model && !list.some((m) => m.id === x.model);
  const [typing, setTyping] = useState(other ? (x.model ?? "") : "");
  const [otherOpen, setOtherOpen] = useState(other);
  return (
    <div className="flex flex-col gap-1.5">
      <label className={`${glassRow} rounded-[12px] bg-white px-3 py-2 shadow-[0_0_0_1px_#E6E6E3]`}>
        <span className="flex-1 text-[13px] leading-4">Model</span>
        <select
          disabled={disabled}
          value={otherOpen ? "__other" : current}
          onChange={(e) => {
            if (e.target.value === "__other") return setOtherOpen(true);
            setOtherOpen(false);
            onPick(e.target.value === "auto" ? null : e.target.value);
          }}
          className="max-w-[60%] appearance-none bg-transparent text-right text-[13px] font-semibold leading-4 outline-none"
        >
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.note ? ` · ${m.note}` : ""}
            </option>
          ))}
          {x.kind === "opencode" && <option value="__other">Other model</option>}
        </select>
        <span aria-hidden className="text-[10px] text-[#9A9A98]">
          ▾
        </span>
      </label>
      {otherOpen && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (OPENCODE_OTHER.test(typing.trim())) onPick(typing.trim());
          }}
        >
          <input
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            aria-label="Other model"
            placeholder="provider/model, like deepinfra/qwen3"
            className="min-w-0 flex-1 rounded-[10px] bg-white px-3 py-1.5 text-[12.5px] leading-4 shadow-[0_0_0_1px_#E6E6E3] outline-none"
          />
          <button type="submit" disabled={!OPENCODE_OTHER.test(typing.trim())} className={btnLight}>
            Use it
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * The editor for one agent, under the tiles: its model, how it pays, its account, how it is, Make default and
 * Remove. What stops its threads (another way to pay, another account, Remove) asks first while it has some going.
 */
function AgentEditor({
  state,
  bot: b,
  agent: x,
  isDefault,
  ro,
  keys,
  onShowScreen,
  onAddKey,
}: {
  state: AppState;
  bot: Bot;
  agent: BotAgent;
  isDefault: boolean;
  ro: boolean;
  keys?: ReadonlySet<string>;
  onShowScreen?: (botId: string, display: number) => void;
  onAddKey?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ body: Record<string, unknown>; words: string } | null>(null);
  const st = agentState(x, b, state, keys);
  const acct = accountOf(x, state);
  const at = { bot: b, state };
  const accounts = (state.brains ?? []).filter((y) => y.kind === x.kind && y.auth === x.pays && y.workspaceId === (b.workspaceId ?? acct?.workspaceId));
  // One account is one agent of the bot's: one its other agent of this kind uses isn't offered.
  const usedBy = (accountId: string) => aiOf(b, state).agents.find((y) => y.id !== x.id && y.kind === x.kind && y.account === accountId);
  const running = state.sessions.filter((s) => s.botId === b.id && live(s) && (s.brainRun?.agentId ?? s.agent?.id) === x.id).length;
  const stops = running ? `This stops ${running} thread${running === 1 ? "" : "s"} on ${agentName(x, at)}. ` : "";
  const go = async (body: Record<string, unknown>) => {
    setAsk(null);
    setBusy(true);
    setError((await change(b.id, body)).error);
    setBusy(false);
  };
  const guard = (body: Record<string, unknown>, then = "Go ahead?") => (stops ? setAsk({ body, words: `${stops}${then}` }) : void go(body));
  const going = acct?.signingIn && !acct.signingIn.failed ? acct.signingIn : undefined;
  const soons = PAYS_SHOWN[x.kind].map((p) => PAYS_SOON[x.kind]?.[p]).filter(Boolean);
  return (
    <div className="flex flex-col gap-2 rounded-[16px] bg-[#FAFAF9] p-3 shadow-[0_0_0_1px_#EFEFEC]">
      <ModelRow key={`${x.id}:${x.pays}`} agent={x} disabled={ro || busy} onPick={(model) => void go({ op: "update", agentId: x.id, model })} />
      <div className={`${glassRow} flex-wrap gap-y-1.5`}>
        <span className="min-w-[72px] flex-1 text-[13px] leading-4">Pays with</span>
        <div role="group" aria-label="Pays with" className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
          {PAYS_SHOWN[x.kind].map((p: AgentPays) => {
            const soon = PAYS_SOON[x.kind]?.[p];
            const name = p === "plan" ? (x.kind === "codex" ? "OpenAI plan" : x.pays === "plan" && acct?.signIns?.[0]?.account?.plan ? `${upper(acct.signIns[0].account.plan)} plan` : "Claude plan") : p === "key" ? "Your key" : PAYS_NAMES[p];
            const off = ro || busy || !!soon || x.kind === "bops";
            return (
              <button
                key={p}
                type="button"
                aria-pressed={x.pays === p}
                aria-disabled={off || undefined}
                title={soon ? `Soon: ${soon}` : undefined}
                onClick={() => !off && p !== x.pays && guard({ op: "update", agentId: x.id, pays: p })}
                className={`${pill} ${off ? "cursor-default" : ""} ${x.pays === p ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : soon ? "text-[#B5B5B3]" : "text-[#6B6B6B] hover:text-ink"}`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
      {soons.length > 0 && <span className={quiet}>Soon: {soons.join(" ")}</span>}
      {(x.kind === "claude" || x.kind === "codex") && (accounts.length > 1 || x.pays === "plan") && (
        <div className="flex flex-col items-end gap-1">
        <div className={glassRow}>
          <span className="flex-1 text-[13px] leading-4">Account</span>
          {accounts.length > 1 ? (
            <select
              aria-label="Account"
              disabled={ro || busy}
              value={x.account}
              onChange={(e) => guard({ op: "update", agentId: x.id, account: e.target.value })}
              className="max-w-[60%] appearance-none bg-transparent text-right text-[13px] font-semibold leading-4 outline-none"
            >
              {accounts.map((y) => (
                <option key={y.id} value={y.id} disabled={!!usedBy(y.id)}>
                  {y.name}
                  {usedBy(y.id) ? ` · ${b.name}'s other ${AGENTS[x.kind].name} uses it` : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[13px] font-semibold leading-4">{acct?.name ?? AGENTS[x.kind].name}</span>
          )}
        </div>
          {x.pays === "plan" && !ro && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setAsk({ body: { op: "update", agentId: x.id, newAccount: true }, words: `${stops}${agentName(x, at)} moves to a new account, which signs in on its own. For another account beside this one, use + Add. Go ahead?` })}
              className="text-[12px] leading-4 text-[#6B6B6B] underline decoration-[#C9C9C6] underline-offset-2 hover:text-ink"
            >
              Move to another account
            </button>
          )}
        </div>
      )}
      {x.kind === "opencode" && <span className={quiet}>OpenCode picks how hard to think by itself.</span>}
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 text-[12px] leading-4 ${st.ready ? "text-[#3A3A38]" : "text-[#B54708]"}`}>{st.line}</span>
        {!ro && st.button === "show" && going && onShowScreen && (
          <button type="button" onClick={() => onShowScreen(going.botId, going.display)} className={btnLight}>
            Show
          </button>
        )}
        {!ro && (st.button === "sign_in" || st.button === "retry") && acct && onShowScreen && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(await brainSignIn(acct.id, b.id, onShowScreen));
              setBusy(false);
            }}
            className={btnDark}
          >
            {st.button === "retry" ? "Try again" : "Sign in"}
          </button>
        )}
        {!ro && st.button === "add_key" && onAddKey && (
          <button type="button" onClick={onAddKey} className={btnDark}>
            Add key
          </button>
        )}
      </div>
      {ask && (
        <div role="alertdialog" aria-label={ask.words} className="flex flex-col gap-2 rounded-[12px] bg-[#FFF8EB] px-3 py-2.5">
          <span className="text-[12px] leading-4 text-[#7A4B00]">{ask.words}</span>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void go(ask.body)} className={btnDark}>
              Go ahead
            </button>
            <button type="button" onClick={() => setAsk(null)} className={btnLight}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!ro && (
        <div className="flex items-center gap-2 pt-0.5">
          {!isDefault && (
            <button type="button" disabled={busy} onClick={() => void go({ op: "default", agentId: x.id })} className={btnLight}>
              Make default
            </button>
          )}
          <span className="flex-1" />
          {x.kind !== "bops" && (
            <button type="button" disabled={busy} onClick={() => guard({ op: "remove", agentId: x.id })} className="rounded-full px-3 py-1.5 text-[12.5px] leading-4 text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50">
              Remove
            </button>
          )}
        </div>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

/** + Add: what can be added (another Claude Code account, another OpenCode model, when it has one); the new agent's editor opens. */
function AddMenu({ bot: b, agents, onAdded }: { bot: Bot; agents: BotAgent[]; onAdded: (r: { error: string | null; added?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const has = (k: AgentKind) => agents.some((x) => x.kind === k);
  // Another OpenCode is on a model the bot's OpenCode agents aren't on yet (else it would be the same one).
  const ocModels = new Set(agents.filter((x) => x.kind === "opencode").map((x) => x.model ?? defaultModel("opencode")));
  const ocNext = modelsFor("opencode").find((m) => !ocModels.has(m.id));
  const items: { label: string; body: Record<string, unknown> }[] = [
    { label: has("claude") ? "Another Claude Code account" : "Claude Code", body: { kind: "claude", pays: "plan", ...(has("claude") ? { newAccount: true } : {}) } },
    ...(!has("codex") ? [{ label: "Codex", body: { kind: "codex", pays: "key" } }] : []),
    ...(!has("opencode") ? [{ label: "OpenCode", body: { kind: "opencode", pays: "key" } }] : ocNext ? [{ label: `OpenCode on ${ocNext.short}`, body: { kind: "opencode", pays: "key", model: ocNext.id } }] : []),
  ];
  if (agents.length >= MAX_AGENTS) return null;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:shadow-[0_0_0_1px_#C9C9C6]"
      >
        + Add
      </button>
      {open && (
        <div role="menu" aria-label="Add an agent" className="absolute left-0 top-[calc(100%+6px)] z-10 flex min-w-[220px] flex-col rounded-[14px] bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                onAdded(await change(b.id, { op: "add", ...it.body }));
              }}
              className="flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] leading-4 hover:bg-[#F6F6F4]"
            >
              <AgentMark kind={it.body.kind as AgentKind} size={14} />
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The bot's threads now, each a chip with its agent's mark and state; up to six, then how many more (its chat, where they all are). */
export function ThreadsNow({ state, bot: b, onOpenThread, onMore }: { state: AppState; bot: Bot; onOpenThread?: (s: Session) => void; onMore?: () => void }) {
  const all = threadsNow(state, b);
  if (!all.length) return <span className="text-[12.5px] leading-4 text-[#9A9A98]">Nothing going right now.</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.slice(0, 6).map((s) => {
        const ms = markState(s, state);
        const words = stateWords(s, state);
        const who = threadAgentWords(s, b, state);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpenThread?.(s)}
            title={[who.label, who.pays].filter(Boolean).join(" · ")}
            className="flex max-w-full items-center gap-2 rounded-full bg-white py-1.5 pl-2 pr-3 text-[12.5px] leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:shadow-[0_0_0_1px_#C9C9C6]"
          >
            <AgentMark kind={threadKind(s)} size={15} state={ms} />
            <span className="sr-only">{who.label}: </span>
            <span className="truncate">{s.title}</span>
            {words && <span className="shrink-0 text-[#6B6B6B]">· {words}</span>}
          </button>
        );
      })}
      {all.length > 6 &&
        (onMore ? (
          <button type="button" onClick={onMore} className="self-center px-1 text-[12.5px] leading-4 text-[#6B6B6B] underline decoration-[#C9C9C6] underline-offset-2 hover:text-ink">
            and {all.length - 6} more
          </button>
        ) : (
          <span className="self-center px-1 text-[12.5px] leading-4 text-[#6B6B6B]">and {all.length - 6} more</span>
        ))}
    </div>
  );
}

/** The section's header summary, worst first: "1 needs you · 1 didn't finish · 2 running" ("needs the owner" in a shared workspace). */
function summary(state: AppState, b: Bot) {
  const all = threadsNow(state, b);
  const n = (k: MarkState) => all.filter((s) => markState(s, state) === k).length;
  const running = all.filter((s) => live(s)).length;
  return [n("needs") ? `${n("needs")} need${n("needs") === 1 ? "s" : ""} ${state.shared ? "the owner" : "you"}` : "", n("failed") ? `${n("failed")} didn't finish` : "", running ? `${running} running` : ""].filter(Boolean).join(" · ");
}

/** The shared computer's warning, with Own computer (PATCH /api/bots), for a bot that works on another's computer. */
function SharedWarning({ bot: b, words, ro }: { bot: Bot; words: string; ro: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = async () => {
    setBusy(true);
    try {
      const res = await post("/api/bots", { botId: b.id, computer: "own" }, "PATCH");
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(res.ok ? null : undash(j.error ?? "That didn't change. Try again."));
      if (res.ok) setAsking(false);
    } catch {
      setError("Couldn't reach Bops. Try again.");
    }
    setBusy(false);
  };
  const canMove = !ro && !b.isMain;
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-[#FFF8EB] px-3 py-2">
      <span className="text-[12px] leading-4 text-[#7A4B00]">{words}</span>
      {canMove && !asking && (
        <button type="button" onClick={() => setAsking(true)} className={`${btnDark} self-start`}>
          Own computer
        </button>
      )}
      {canMove && asking && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] leading-4 text-[#7A4B00]">{b.name} gets a computer of its own, set up on its next task. Go ahead?</span>
          <button type="button" disabled={busy} onClick={() => void own()} className={btnDark}>
            Go ahead
          </button>
          <button type="button" onClick={() => setAsking(false)} className={btnLight}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

export function BotAiSection({
  state,
  bot: b,
  className = "",
  defaultOpen = true,
  editing: editingAt,
  newThread: newThreadAt = false,
  onShowScreen,
  onOpenThread,
  onOpenChat,
  onAddKey,
  bare = false,
}: {
  state: AppState;
  bot: Bot;
  className?: string;
  defaultOpen?: boolean;
  /** Its body alone, always open, with no header of its own: the AI card of a bot's settings page, which folds itself. */
  bare?: boolean;
  /** The agent whose editor is open as it first shows (a picture of it). */
  editing?: string;
  /** The New thread sheet is open as it first shows (a picture of it). */
  newThread?: boolean;
  onShowScreen?: (botId: string, display: number) => void;
  onOpenThread?: (s: Session) => void;
  /** The bot's chat, where all its threads are (Threads now's "and 4 more"). */
  onOpenChat?: () => void;
  /** The Vault, to add a key for this bot (an agent on a key with none there). */
  onAddKey?: () => void;
}) {
  const [opened, setOpen] = useState(defaultOpen);
  const open = bare || opened;
  const [editing, setEditing] = useState<string | null>(editingAt ?? null);
  const [newThread, setNewThread] = useState(newThreadAt);
  const [error, setError] = useState<string | null>(null);
  const [termBusy, setTermBusy] = useState(false);
  const keys = useBotKeys(state, b);
  const ai = aiOf(b, state);
  const ro = !!state.shared;
  const def = ai.agents.find((x) => x.id === ai.default) ?? ai.agents[0];
  const edited = ai.agents.find((x) => x.id === editing);
  const said = summary(state, b);
  const shared = BRAINS_ON ? sharesComputerWithLogins(b, state) : undefined;
  const cloud = state.host !== "mac" && b.runsOn !== "mac";
  const cliAgent = ai.agents.find((x) => x.id === ai.default && isCli(x.kind)) ?? ai.agents.find((x) => isCli(x.kind));
  const where = brainRuns(b, state);
  const owner = state.owner?.name ?? "the owner";
  const agy: BotAgent = { id: "agy", kind: "agy", pays: "key" };
  return (
    <div className={`flex w-full flex-col ${bare ? "" : "rounded-2xl"} ${className}`} data-ai-section>
      {!bare && (
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-2.5 px-4 py-3 text-left">
        <span aria-hidden className={`flex size-5 items-center justify-center rounded-full bg-white text-[9px] text-[#6B6B6B] shadow-[0_0_0_1px_#E6E6E3] transition-transform ${open ? "" : "-rotate-90"}`}>
          ▾
        </span>
        <span className="text-[14px] font-semibold leading-5">AI</span>
        {/* The Default by its kind (its tile says which), then its threads worst first: on a narrow row the name gives way first. */}
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-[12px] leading-4 text-[#6B6B6B]">
          <span className="shrink-0">Default</span>
          <AgentMark kind={def.kind} size={14} />
          <span className="min-w-0 shrink-[10] truncate">{AGENTS[def.kind].name}</span>
          {said && <span className="min-w-0 truncate">· {said}</span>}
        </span>
      </button>
      )}
      <Fold open={open}>
        <div className={bare ? "flex flex-col gap-3" : "flex flex-col gap-3 border-t border-black/[0.05] px-4 pb-4 pt-3"}>
          <span className="text-[11px] font-medium uppercase leading-4 tracking-[0.04em] text-[#8A8A88]">Agents it can run</span>
          <div className="flex flex-wrap gap-2">
            {ai.agents.map((x) => (
              <AgentTile key={x.id} agent={x} bot={b} state={state} keys={keys} isDefault={x.id === ai.default} on={x.id === editing} onClick={() => setEditing((e) => (e === x.id ? null : x.id))} />
            ))}
            {BRAINS_ON && <AgentTile agent={agy} bot={b} state={state} isDefault={false} on={editing === "agy"} onClick={() => setEditing((e) => (e === "agy" ? null : "agy"))} />}
          </div>
          {BRAINS_ON && editing === "agy" && <span className={quiet}>Soon: {AGENTS.agy.soon}</span>}
          {BRAINS_ON && !ro && (
            <div className="flex">
              <AddMenu
                bot={b}
                agents={ai.agents}
                onAdded={(r) => {
                  setError(r.error);
                  if (r.added) setEditing(r.added);
                }}
              />
            </div>
          )}
          {edited && <AgentEditor key={edited.id} state={state} bot={b} agent={edited} isDefault={edited.id === ai.default} ro={ro} keys={keys} onShowScreen={onShowScreen} onAddKey={onAddKey} />}
          <div className={`${glassRow} flex-wrap gap-y-1.5`}>
            <div className="flex min-w-[150px] flex-1 flex-col">
              <span className="text-[13px] font-semibold leading-4">Thinking</span>
              <span className={quiet}>{THINKING[b.effort ?? "auto"]}</span>
            </div>
            <div role="group" aria-label="Thinking" className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
              {(["auto", "low", "medium", "high"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  disabled={ro}
                  aria-pressed={(b.effort ?? "auto") === e}
                  onClick={() => void post("/api/bots", { botId: b.id, effort: e }, "PATCH")}
                  className={`${pill} capitalize ${(b.effort ?? "auto") === e ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <span className="text-[11px] font-medium uppercase leading-4 tracking-[0.04em] text-[#8A8A88]">Threads now</span>
          <ThreadsNow state={state} bot={b} onOpenThread={onOpenThread} onMore={onOpenChat} />
          <div className="flex items-center gap-2">
            {BRAINS_ON && !ro && (
              <button type="button" onClick={() => setNewThread(true)} className="rounded-full border border-dashed border-[#C9C9C6] bg-white/70 px-3 py-1.5 text-[12.5px] font-medium leading-4 hover:border-[#9A9A98]">
                + New thread
              </button>
            )}
            <span className="flex-1" />
            {BRAINS_ON && !ro && cloud && cliAgent && onShowScreen && (
              <button
                type="button"
                disabled={termBusy}
                onClick={async () => {
                  setTermBusy(true);
                  try {
                    const res = await post("/api/bots/terminal", { botId: b.id });
                    const j = (await res.json().catch(() => ({}))) as { botId?: string; display?: number; error?: string };
                    if (res.ok && j.botId && typeof j.display === "number") onShowScreen(j.botId, j.display);
                    else setError(undash(j.error ?? "Its terminal didn't open. Try again."));
                  } catch {
                    setError("Couldn't reach Bops. Try again.");
                  }
                  setTermBusy(false);
                }}
                className="text-[12.5px] leading-4 text-[#3A3A38] underline decoration-[#C9C9C6] underline-offset-2 hover:text-ink disabled:opacity-50"
              >
                Open its terminal
              </button>
            )}
          </div>
          <div className={`${glassRow} rounded-[12px] bg-white px-3 py-2 shadow-[0_0_0_1px_#E6E6E3]`} title="Calls and texts by voice use OpenAI live voice for now.">
            <span className="flex-1 text-[13px] leading-4">Calls</span>
            {BRAINS_ON ? <OpenAiMark size={14} /> : null}
            <span className="text-[13px] font-medium leading-4">OpenAI live voice</span>
          </div>
          {shared && <SharedWarning bot={b} words={shared} ro={ro || workBot(b, state.bots).id === b.id} />}
          <span className={quiet}>
            {BRAINS_ON ? `Each thread runs on the agent you pick, with ${b.name}'s own accounts. Chat, memory and calls stay on Bops AI credit.` : "Chat, threads, memory and calls run on Bops AI credit."}
            {BRAINS_ON && where === "some" ? " Threads on your Mac use Bops agent." : ""}
          </span>
          {ro && (
            <span className={quiet}>
              Only {owner} changes {b.name}&apos;s AI.
            </span>
          )}
          {error && (
            <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
              {error}
            </span>
          )}
        </div>
      </Fold>
      {newThread && !ro && (
        <NewThread
          state={state}
          bot={b}
          onClose={() => setNewThread(false)}
          onStarted={(s) => (setNewThread(false), onOpenThread?.(s))}
          onSetUp={(id) => {
            setOpen(true);
            setEditing(id);
          }}
        />
      )}
    </div>
  );
}

const THINKING: Record<string, string> = {
  auto: "Thinks hard on tough tasks, quick on simple ones",
  low: "Fastest; fine for quick lookups",
  medium: "Balanced for most work",
  high: "Slower and more careful on every task",
};
