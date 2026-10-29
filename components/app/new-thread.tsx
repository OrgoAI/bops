"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as KeyEvent, type RefObject } from "react";
import { AGENTS, agentLabel, agentName, agentState, aiOf, modelsFor, modelShort, OPENCODE_OTHER, paysLabel, readyAgents, upper, type AgentState } from "@/lib/agents";
import { workBot, workspaceOf, type AppState, type Bot, type BotAgent, type Session } from "@/lib/types";
import { AgentMark } from "./agent-marks";
import { useVaultKeyNames } from "./keys";
import { undash } from "./side-group";
import { post } from "./ui";

/**
 * Picking the agent a new thread runs on: the New thread sheet (from the profile's New thread, and the bot menu),
 * and the agent chip in the message box. Every thread keeps the agent it starts on; the bot's Default is marked,
 * whatever its state, and an agent that isn't ready says why.
 */

/** A menu or popover that closes on Escape or a press outside `ref`, before anything behind it hears the key. */
export function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  const last = useRef(close);
  useEffect(() => {
    last.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      last.current();
    };
    const down = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) last.current();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
    };
  }, [open, ref]);
}

/** The Vault's key names for a bot's agents on a key (undefined until read, or when it has none on one). */
export function useBotKeys(state: AppState, b: Bot | undefined) {
  return useVaultKeyNames(b ? workspaceOf(b) : "", !!b && !state.shared && aiOf(b, state).agents.some((x) => x.pays === "key"));
}

/** An agent that isn't ready, in a word or two, for a chip: "not signed in", "no key". */
export function notReadyWords(st: AgentState) {
  return st.button === "sign_in" ? "not signed in" : st.button === "add_key" ? "no key" : st.button === "show" ? "signing in" : st.button === "retry" ? "sign in didn't finish" : "not ready";
}

/** The Default's own mark on a tile, whatever its state. */
export const DefaultPill = () => <span className="shrink-0 rounded-full bg-[#F2F2F0] px-1.5 text-[10.5px] font-medium leading-[14px] text-[#3A3A38]">Default</span>;

/** The bot's agents as tiles to pick one from. `onSetUp`: an agent that isn't ready, to its editor in the profile. */
export function AgentPick({ state, bot: b, value, keys, onPick, onSetUp }: { state: AppState; bot: Bot; value: string; keys?: ReadonlySet<string>; onPick: (x: BotAgent) => void; onSetUp?: (agentId: string) => void }) {
  const ai = aiOf(b, state);
  const at = { bot: b, state };
  return (
    <div role="group" aria-label="Agent" className="flex flex-wrap gap-2">
      {ai.agents.map((x) => {
        const st = agentState(x, b, state, keys);
        const on = x.id === value;
        return (
          <div key={x.id} className={`flex min-w-[140px] max-w-full flex-col rounded-[14px] bg-white ${on ? "shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:shadow-[0_0_0_1px_#C9C9C6]"}`}>
            <button
              type="button"
              aria-pressed={on}
              aria-disabled={!st.ready || undefined}
              onClick={() => st.ready && onPick(x)}
              title={st.ready ? `${agentLabel(x, at)} · ${paysLabel(x, state, workBot(b, state.bots).computerId)}` : st.line}
              className={`flex items-center gap-2.5 px-3 py-2 text-left ${st.ready ? "" : "cursor-default opacity-60"}`}
            >
              <AgentMark kind={x.kind} size={18} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-[13px] font-medium leading-4">
                  <span className="truncate">{agentName(x, at)}</span>
                  {x.id === ai.default && <DefaultPill />}
                </span>
                <span className="truncate text-[11.5px] leading-[15px] text-[#6B6B6B]">{st.ready ? modelShort(x.kind, x.model) || "Auto" : st.line}</span>
              </span>
            </button>
            {!st.ready && onSetUp && (
              <button type="button" onClick={() => onSetUp(x.id)} className="self-start px-3 pb-2 text-[12px] font-medium leading-4 text-ink underline decoration-[#C9C9C6] underline-offset-2 hover:decoration-ink">
                Set up
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * New thread for a bot: the agent, its model, how it pays, and what to do. Starts it and opens it. `agentId`: the
 * agent it starts on (else the Default, else the first one ready). Always drawn where it is (the profile's AI, or over
 * the chat's message box from the bot's menu), never over the window; `inline`: a picture of it, which takes no focus.
 * `onSetUp`: an agent that isn't ready, to its editor in the profile (this closes). Esc in it closes it, and only it.
 */
export function NewThread({
  state,
  bot: b,
  agentId,
  inline = false,
  onClose,
  onStarted,
  onSetUp,
}: {
  state: AppState;
  bot: Bot;
  agentId?: string;
  inline?: boolean;
  onClose: () => void;
  onStarted: (s: Session) => void;
  onSetUp?: (agentId: string) => void;
}) {
  const ai = aiOf(b, state);
  const keys = useBotKeys(state, b);
  const ready = readyAgents(b, state, keys);
  const first = ready.find((x) => x.id === agentId) ?? ready.find((x) => x.id === ai.default) ?? ready[0] ?? ai.agents[0];
  const [agent, setAgent] = useState<BotAgent>(first);
  const [model, setModel] = useState<string>(first.model ?? modelsFor(first.kind)[0]?.id ?? "");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const models = modelsFor(agent.kind);
  // Its own Escape, from inside it: it closes, and nothing behind it (the profile's tab, the chat) hears it.
  const onKey = (e: KeyEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  const start = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    try {
      const res = await post("/api/sessions", { botId: b.id, goal: goal.trim(), agentId: agent.id, ...(model && model !== "auto" ? { model } : {}) });
      const j = (await res.json().catch(() => ({}))) as Session & { error?: string };
      if (res.ok && j.id) onStarted(j);
      else setError(undash(j.error ?? "It didn't start. Try again."));
    } catch {
      setError("Couldn't reach Bops. Try again.");
    }
    setBusy(false);
  };
  return (
    <div className="flex w-full justify-center">
      <div
        ref={panel}
        role="region"
        aria-labelledby={titleId}
        data-new-thread
        onKeyDown={onKey}
        className="motion-rise-in flex w-full max-w-[560px] flex-col gap-3.5 rounded-[24px] bg-white p-5 shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000038]"
      >
        <div className="flex items-center">
          <span id={titleId} className="flex-1 text-[17px] font-semibold leading-6">
            New thread for {b.name}
          </span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-7 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0]">
            ×
          </button>
        </div>
        <AgentPick
          state={state}
          bot={b}
          value={agent.id}
          keys={keys}
          onSetUp={onSetUp ? (id) => (onClose(), onSetUp(id)) : undefined}
          onPick={(x) => {
            setAgent(x);
            setModel(x.model ?? modelsFor(x.kind)[0]?.id ?? "");
          }}
        />
        <label className="flex items-center gap-3 rounded-[12px] bg-white px-3 py-2 shadow-[0_0_0_1px_#E6E6E3]">
          <span className="flex-1 text-[13px] leading-4">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="appearance-none bg-transparent text-right text-[13px] font-semibold leading-4 outline-none">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {agent.kind === "opencode" && model && !models.some((m) => m.id === model) && OPENCODE_OTHER.test(model) && <option value={model}>{model}</option>}
          </select>
          <span aria-hidden className="text-[10px] text-[#9A9A98]">
            ▾
          </span>
        </label>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">Pays with: {paysLabel(agent, state, workBot(b, state.bots).computerId)}</span>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="What should it do?"
          aria-label="What should it do?"
          autoFocus={!inline}
          rows={3}
          className="resize-none rounded-[14px] bg-[#FAFAF9] px-3.5 py-2.5 text-[14px] leading-5 shadow-[0_0_0_1px_#E6E6E3] outline-none placeholder:text-[#9A9A98]"
        />
        <div className="flex items-center gap-2">
          {error && (
            <span role="alert" className="min-w-0 flex-1 text-[12px] leading-4 text-[#B42318]">
              {error}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-full bg-[#F2F2F0] px-3.5 py-2 text-[13px] font-medium leading-4 hover:bg-[#EAEAE7]">
            Cancel
          </button>
          <button type="button" disabled={busy || !goal.trim() || !ready.some((x) => x.id === agent.id)} onClick={() => void start()} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-medium leading-4 text-white hover:bg-[#2A2A28] disabled:opacity-40">
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The agent new tasks from the message box run on, for its chip: the pick when it's ready, else the Default, as it
 * is (the server starts them there, ready or not), and the agents there are to pick from: the ready ones and the
 * Default. Shown only to the owner, and only when there's a choice.
 */
export function boxAgents(state: AppState, b: Bot, value: string | null, keys?: ReadonlySet<string>) {
  const ai = aiOf(b, state);
  const ready = readyAgents(b, state, keys);
  const def = ai.agents.find((x) => x.id === ai.default) ?? ai.agents[0];
  const options = ready.some((x) => x.id === def.id) ? ready : [def, ...ready];
  const picked = ready.find((x) => x.id === value);
  return { ready, def, options, picked, now: picked ?? def, defReady: ready.some((x) => x.id === def.id) };
}

/**
 * The message box's agent chip (Warp's split chip): only for the owner, and only when there's a choice of agent.
 * The pick holds for this chat in this window until changed (or until it isn't ready), and goes with each message
 * as the agent the threads it starts run on (Message.agent). The Default that isn't ready shows as it is.
 */
export function AgentChipPick({ state, bot: b, value, keys, defaultOpen = false, onPick }: { state: AppState; bot: Bot; value: string | null; keys?: ReadonlySet<string>; defaultOpen?: boolean; onPick: (agentId: string | null) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const box = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useDismiss(open, () => setOpen(false), box);
  const { options, now, def, defReady } = boxAgents(state, b, value, keys);
  if (options.length < 2 || state.shared) return null;
  const at = { bot: b, state };
  const off = (x: BotAgent) => (x.id === def.id && !defReady ? notReadyWords(agentState(x, b, state, keys)) : "");
  // Its name, or (not ready) its kind and why, which a narrow chip mustn't cut off; the menu and its name say which.
  const label = off(now) ? `${AGENTS[now.kind].name} · ${off(now)}` : agentName(now, at);
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Agent for new tasks: ${agentName(now, at)}${off(now) ? `, ${off(now)}` : ""}`}
        title={value && now.id === value ? `Tasks from this message run on ${agentLabel(now, at)}` : `Tasks run on ${b.name}'s Default, ${agentLabel(now, at)}${off(now) ? `, which is ${off(now)}` : ""}`}
        className="flex h-[30px] items-center gap-1.5 rounded-full px-2 text-[12.5px] leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]"
      >
        <AgentMark kind={now.kind} size={15} />
        <span className={`max-w-[170px] truncate ${off(now) ? "text-[#B54708]" : ""}`}>{label}</span>
        <span aria-hidden className="text-[9px] text-[#9A9A98]">
          ▾
        </span>
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Agent for new tasks" className="absolute bottom-[calc(100%+6px)] right-0 z-20 flex min-w-[280px] flex-col rounded-[14px] bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]">
          {options.map((x) => (
            <button
              key={x.id}
              type="button"
              role="menuitemradio"
              aria-checked={x.id === now.id}
              aria-disabled={!!off(x) || undefined}
              onClick={() => {
                if (off(x)) return;
                onPick(x.id === def.id ? null : x.id);
                setOpen(false);
              }}
              className={`flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] leading-4 hover:bg-[#F6F6F4] ${x.id === now.id ? "bg-[#F6F6F4]" : ""} ${off(x) ? "cursor-default opacity-60" : ""}`}
            >
              <AgentMark kind={x.kind} size={15} />
              <span className="flex-1">
                {agentLabel(x, at)}
                {off(x) ? ` · ${off(x)}` : ""}
              </span>
              {x.id === def.id && <span className="text-[11px] text-[#6B6B6B]">Default</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The line above the box while a pick other than the Default holds: what runs the tasks this message starts. */
export const pickLine = (x: BotAgent, b?: Bot, state?: Pick<AppState, "bots" | "brains">) => `Tasks from this message run on ${upper(agentLabel(x, b && state ? { bot: b, state } : undefined))}`;
