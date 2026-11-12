"use client";

import { createContext, useContext } from "react";
import { sharedSkillsWho } from "@/lib/shared";
import type { AppState, Message } from "@/lib/types";

/*
 * Skills a bot saved as drafts in a chat (Message.skillDrafts, chat.ts create_skill), as cards under its message: which
 * skill, and Review and publish, which opens it in Skills, in Knowledge (skills.tsx), where the person reads it and
 * publishes it with their own sign in. The card itself never publishes anything. Shown to the owner, and in a workspace
 * shared with the user to an Admin there (lib/shared.ts sharedSkillsWho); nobody else sees it.
 */

/** Opens Knowledge, Skills on one skill ("skill:<slug>"): bops-app.tsx gives it, as it gives OpenCrm. */
export const OpenSkill = createContext<((item?: string) => void) | null>(null);

const btn = "shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white disabled:opacity-50";

export function SkillDrafts({ message: m, state, className = "" }: { message: Message; state: AppState; className?: string }) {
  const open = useContext(OpenSkill);
  if (!m.skillDrafts?.length) return null;
  if (state.shared && !sharedSkillsWho(state.shared)) return null;
  // On the owner's own Bops its state says whether it was published since (a shared workspace's skills are Orgo's, read in Skills).
  const refs = state.shared ? [] : (state.workspaces ?? []).flatMap((w) => [...(w.skills ?? []), ...(w.apps ?? [])]);
  return (
    <div data-skill-drafts className={`flex w-[420px] min-w-0 max-w-full flex-col gap-2 ${className}`}>
      {m.skillDrafts.map((d) => {
        const published = refs.find((r) => r.kind === d.kind && r.slug === d.slug)?.status === "published";
        return (
          <div key={`${d.kind}:${d.slug}`} data-skill-draft={d.slug} className="flex min-w-0 items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 shadow-[0_0_0_1px_#E2E2DF]">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-4 text-[#3A3A38]" title={d.name}>
              {published ? `Published: ${d.name}` : `Saved as a draft: ${d.name}`}
            </span>
            {open && (
              <button type="button" onClick={() => open(`${d.kind}:${d.slug}`)} className={published ? `${btn} bg-[#F2F2F0] text-ink hover:bg-[#EAEAE7]` : btn}>
                {published ? "Open in Skills" : "Review and publish"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
