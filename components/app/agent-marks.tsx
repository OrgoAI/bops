"use client";

import { useId } from "react";
import { AGENTS, agentLabel } from "@/lib/agents";
import { BRAINS_ON, type AgentKind, type BotAgent } from "@/lib/types";

/**
 * The marks of the agents a bot's threads run on (lib/agents.ts), drawn here as rough shapes of their own: six
 * petals for OpenAI, twelve rays for Claude, a prompt for Codex, brackets for OpenCode, a four point star for agy.
 * They are drawings, not the companies' files, and show only in a build with brains (BRAINS_ON): a release
 * build shows a plain mark for Bops agent until the makers' brand rules are checked.
 */

type Size = { size?: number };

export function OpenAiMark({ size = 16 }: Size) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <ellipse key={a} cx="12" cy="7.2" rx="3.3" ry="5.6" transform={`rotate(${a} 12 12)`} fill="none" stroke="#0A0A0A" strokeWidth="1.7" />
      ))}
    </svg>
  );
}

export function ClaudeMark({ size = 16 }: Size) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <path key={i} d="M12 12 L11.1 2.6 Q12 1.6 12.9 2.6 Z" transform={`rotate(${i * 30} 12 12)`} fill="#D97757" />
      ))}
      <circle cx="12" cy="12" r="2.4" fill="#D97757" />
    </svg>
  );
}

export function CodexMark({ size = 16 }: Size) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#FFFFFF" stroke="#0A0A0A" strokeWidth="1.6" />
      <path d="M7 9 L10 12 L7 15" stroke="#0A0A0A" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15.5 H17" stroke="#0A0A0A" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function OpenCodeMark({ size = 16 }: Size) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#0A0A0A" />
      <path d="M8.5 8 L5.5 12 L8.5 16 M15.5 8 L18.5 12 L15.5 16" stroke="#FFFFFF" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 7.5 L11 16.5" stroke="#6EE7B7" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function AgyMark({ size = 16 }: Size) {
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4F8BFF" />
          <stop offset=".55" stopColor="#9B6BFF" />
          <stop offset="1" stopColor="#FF6FA8" />
        </linearGradient>
      </defs>
      <path d="M12 1.5 C12.9 7.6 16.4 11.1 22.5 12 C16.4 12.9 12.9 16.4 12 22.5 C11.1 16.4 7.6 12.9 1.5 12 C7.6 11.1 11.1 7.6 12 1.5 Z" fill={`url(#${id})`} />
    </svg>
  );
}

/** Bops agent's plain mark, where the drawn ones don't show (a build without brains). */
function PlainMark({ size = 16 }: Size) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="7" fill="#F2F2F0" stroke="#0A0A0A" strokeOpacity=".15" />
      <path d="M12 6.5 L13.4 10.6 L17.5 12 L13.4 13.4 L12 17.5 L10.6 13.4 L6.5 12 L10.6 10.6 Z" fill="#0A0A0A" />
    </svg>
  );
}

const MARKS: Record<AgentKind, (p: Size) => React.ReactElement> = { bops: OpenAiMark, claude: ClaudeMark, codex: CodexMark, opencode: OpenCodeMark, agy: AgyMark };

/** How a thread is, for the dot on its mark: herdr's words, worst first. */
export type MarkState = "needs" | "failed" | "working" | "done";
const DOT: Record<MarkState, string> = { needs: "#E8A13A", failed: "#D92D20", working: "#22A55B", done: "#C9C9C6" };

/** An agent's mark, with a thread's state as a dot on its corner when given: one helper, so the profile, the chip and the sheet agree. */
export function AgentMark({ kind, size = 16, state }: { kind: AgentKind; size?: number; state?: MarkState }) {
  const Mark = BRAINS_ON ? MARKS[kind] : PlainMark;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <Mark size={size} />
      {state && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 rounded-full shadow-[0_0_0_1.5px_#FFFFFF]"
          style={{ width: Math.max(6, Math.round(size * 0.42)), height: Math.max(6, Math.round(size * 0.42)), background: DOT[state] }}
        />
      )}
    </span>
  );
}

/**
 * An agent as a small chip: its mark and "Claude Code · Opus 5.5" (`label`: its name in its bot's profile, when
 * that tells it from another of its kind). `title`: more about it on hover (how it pays).
 */
export function AgentChip({ agent, label, title, className = "bg-[#F2F2F0]" }: { agent: Pick<BotAgent, "kind" | "model">; label?: string; title?: string; className?: string }) {
  return (
    <span title={title ?? label ?? agentLabel(agent)} className={`inline-flex shrink-0 items-center gap-1 rounded-full py-px pl-1 pr-1.5 text-[11px] leading-[14px] text-[#3A3A38] ${className}`}>
      <AgentMark kind={agent.kind} size={12} />
      {label ?? agentLabel(agent)}
    </span>
  );
}

/** An agent's name, as its tile says it ("Bops agent", "Claude Code"). */
export const agentName = (kind: AgentKind) => AGENTS[kind].name;
