"use client";

import { useState } from "react";
import { proposalLines, proposalStatus, type DiffLine } from "@/lib/skill-proposals";
import type { AppState, Message, SkillProposal } from "@/lib/types";
import { Spinner } from "./mascot";
import { clockTime, post } from "./ui";
import { BRAND } from "@/lib/brand";

/*
 * Changes a bot proposed to its workspace's skills (Message.skillProposals, lib/server/skill-proposals.ts), as cards
 * under its message: in the chat (chat-view.tsx) and in a routine's reports (routine-reports.tsx). Each says which
 * skill and file, why, the change as a diff, who proposed it and where (its chat, or the routine whose run it was),
 * and, when the turn read something from outside Bops, whose words those were. Accept makes it the skill's next
 * version and Reject drops it, only for the owner in the window: in a workspace shared with the user they're read
 * only (the server refuses it too: app/api/skills). When the skill changed since, Accept shows the change on what it
 * is now and asks again before it applies.
 */

const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";

type Stale = { why: string; lines?: DiffLine[]; seen?: string };

export function SkillProposals({ message: m, state, className = "" }: { message: Message; state: AppState; className?: string }) {
  if (!m.skillProposals?.length) return null;
  return (
    <div data-skill-proposals className={`flex w-[420px] min-w-0 max-w-full flex-col gap-2 ${className}`}>
      {m.skillProposals.map((p) => (
        <ProposalCard key={p.id} messageId={m.id} proposal={p} state={state} readOnly={!!state.shared} />
      ))}
    </div>
  );
}

/** Diff lines as a block: taken out in red, put in in green, kept in grey. */
function Diff({ lines }: { lines: DiffLine[] }) {
  const shown = lines.slice(0, 400);
  return (
    <pre data-proposal-diff className="max-h-[280px] overflow-auto rounded-xl bg-[color:var(--c-f7f7f6)] py-1.5 font-mono text-[11.5px] leading-4 text-[color:var(--c-3a3a38)]">
      {shown.map((l, i) => (
        <div key={i} className={`whitespace-pre-wrap px-3 [overflow-wrap:anywhere] ${l.t === "-" ? "bg-[#FEF3F2] text-[#912018]" : l.t === "+" ? "bg-[#ECFDF3] text-[#05603A]" : ""}`}>
          <span aria-hidden className="select-none pr-1.5 opacity-60">
            {l.t === " " ? " " : l.t}
          </span>
          {l.s || " "}
        </div>
      ))}
      {lines.length > shown.length && <div className="px-3 text-[color:var(--c-9a9a98)]">and {lines.length - shown.length} more lines</div>}
    </pre>
  );
}

function ProposalCard({ messageId, proposal: p, state, readOnly }: { messageId: string; proposal: SkillProposal; state: AppState; readOnly: boolean }) {
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState<Stale>();
  const status = proposalStatus(p);
  const by = state.bots.find((b) => b.id === p.botId)?.name ?? "A bot";
  const routine = p.routineId ? state.routines?.find((r) => r.id === p.routineId)?.title : undefined;
  const where = p.routineId ? `in a run of ${routine ? `the routine “${routine}”` : "a routine"}` : "in this chat";
  const what = p.content !== undefined ? (p.replaces ? "Replaces the whole file" : "A new file") : `${p.edits?.length ?? 0} edit${p.edits?.length === 1 ? "" : "s"}`;

  const act = async (what: "accept" | "reject", seen?: string) => {
    if (busy || readOnly) return;
    setBusy(what);
    setError(undefined);
    try {
      const res = await post("/api/skills", { action: "proposal", do: what, messageId, proposalId: p.id, ...(seen ? { seen } : {}) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; stale?: Stale };
      if (res.ok) setStale(undefined);
      else if (json.stale) {
        setStale(json.stale);
        if (!json.stale.lines) setError(json.error);
      } else setError(json.error ?? "That didn't work. Try again.");
    } catch {
      setError(`Couldn't reach ${BRAND.name}. Try again.`);
    }
    setBusy(null);
  };

  if (status !== "open")
    return (
      <div data-proposal={p.id} data-proposal-status={status} className="flex min-w-0 items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 shadow-[0_0_0_1px_var(--c-e2e2df)]">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-4 text-[color:var(--c-3a3a38)]">
          {status === "accepted" ? `Accepted: ${p.name}${p.version ? ` is at v${p.version}` : ""}` : `Rejected the change to ${p.name}`}
          {p.doneAt ? ` · ${clockTime(p.doneAt)}` : ""}
        </span>
      </div>
    );

  return (
    <div data-proposal={p.id} data-proposal-status="open" className="flex flex-col gap-2.5 rounded-2xl bg-white p-3.5 shadow-[0_0_0_1px_#0000000F,0_10px_30px_-16px_#00000059]">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13.5px] font-semibold leading-[18px] [overflow-wrap:anywhere]">Change to the skill {p.name}</span>
        <span className="flex flex-wrap items-center gap-1 text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">
          <code className="rounded-md bg-[color:var(--c-f7f7f6)] px-1.5 py-0.5 text-[11.5px] leading-4 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">{p.file}</code>
          <span>
            · {what} · proposed by {by} {where}
          </span>
        </span>
      </div>
      <p className="text-[13px] leading-[19px] text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">{p.summary}</p>
      {!!p.read?.length && (
        <div data-proposal-read className="flex flex-col gap-0.5 rounded-xl bg-[#FFF8E6] px-3 py-2 text-[12px] leading-4 text-[#7A4D00]">
          <span className="font-medium">This turn read words from outside {BRAND.name}. Check the change is yours to make:</span>
          {p.read.map((x) => (
            <span key={x} className="[overflow-wrap:anywhere]">
              {x}
            </span>
          ))}
        </div>
      )}
      <Diff lines={stale?.lines ?? proposalLines(p)} />
      {stale && (
        <span role="status" className="text-[12px] leading-4 text-[#9A5B00] [overflow-wrap:anywhere]">
          {stale.why} {stale.lines ? "Above is the change on what it is now." : ""}
        </span>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318] [overflow-wrap:anywhere]">
          {error}
        </span>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1.5">
          {!(stale && !stale.lines) && (
            <button onClick={() => void act("accept", stale?.seen)} disabled={!!busy} className={`${btn} flex items-center gap-1.5 bg-ink text-white`}>
              {busy === "accept" ? (
                <>
                  <Spinner size={11} color="#FFFFFF" />
                  Applying
                </>
              ) : stale?.lines ? (
                "Accept this"
              ) : (
                "Accept"
              )}
            </button>
          )}
          <button onClick={() => void act("reject")} disabled={!!busy} className={`${btn} bg-[color:var(--c-f2f2f0)] hover:bg-[color:var(--c-eaeae7)]`}>
            {busy === "reject" ? "Rejecting" : "Reject"}
          </button>
          <span className="text-[11.5px] leading-4 text-[color:var(--c-9a9a98)]">Accept publishes it as the next version.</span>
        </div>
      )}
    </div>
  );
}
