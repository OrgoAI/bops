"use client";

import { useEffect, useState } from "react";
import type { BopsPlan } from "@/lib/account";
import { planFix, type OrgoPlan, type PlanShort } from "@/lib/orgo-plans";
import type { AppState } from "@/lib/types";

/** What GET /api/plan answers: the user's Orgo plan (null when Orgo couldn't be asked), Orgo's pages to change it, and the Bops plan when it was read. */
export type PlanInfo = { plan: OrgoPlan | null; links: { plan: string; usage: string }; bops?: BopsPlan | null };

/**
 * The user's Orgo plan (lib/server/plan.ts), read when this shows, again whenever one of the bots'
 * computers comes or goes (that changes the count in use), and fresh when the app comes back to the
 * front (the user may have just changed plans on Orgo). Null until Orgo answers.
 */
export function usePlan(state: AppState) {
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const computers = state.bots.map((b) => b.computerId ?? "").join();
  useEffect(() => {
    let stop = false;
    const load = (fresh: boolean) =>
      void fetch(`/api/plan${fresh ? "?fresh=1" : ""}`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<PlanInfo>) : null))
        .then((j) => {
          if (j && !stop) setInfo(j);
        })
        .catch(() => {});
    const onFocus = () => load(true);
    load(false);
    window.addEventListener("focus", onFocus);
    return () => {
      stop = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [computers]);
  return info;
}

/**
 * Why the plan has no room for a computer, in plain words, and where to change that: on Orgo, or, when
 * the Bops plan decides (`short` "bops"), Upgrade to Max in the app (`onUpgrade` opens the plans; none
 * on Max, which has nothing more).
 */
export function PlanNote({ info, short, text, className = "", onUpgrade }: { info: PlanInfo; short: PlanShort; text: string; className?: string; onUpgrade?: () => void }) {
  if (short === "bops")
    return (
      <span className={`text-[12px] leading-4 text-[#6B6B6B] ${className}`}>
        {text}{" "}
        {onUpgrade && (
          <button onClick={onUpgrade} className="font-medium text-ink underline underline-offset-2">
            Upgrade to Max
          </button>
        )}
      </span>
    );
  const fix = planFix(short, info.plan);
  return (
    <span className={`text-[12px] leading-4 text-[#6B6B6B] ${className}`}>
      {text}{" "}
      <a href={info.links[fix.tab]} target="_blank" rel="noreferrer" className="font-medium text-ink underline underline-offset-2">
        {fix.label}
      </a>
    </span>
  );
}

