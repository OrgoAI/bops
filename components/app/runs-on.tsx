"use client";

import { useEffect, useState } from "react";
import { workBot, type AppState, type Bot, type RunnerState } from "@/lib/types";
import { Mascot } from "./mascot";
import { undash } from "./side-group";
import { option, post, radio, teamOf } from "./ui";

/** What /api/runs-on says: where routines run (null: Orgo didn't answer), whether Orgo can keep it yet, and which computers with a runner up are asleep. */
export type RunsOnInfo = { runsOn: "cloud" | "mac" | null; missing: boolean; asleep: string[] };

const CHOICES = [
  { id: "cloud", name: "Cloud", line: "Keeps working when your Mac is closed." },
  { id: "mac", name: "This Mac", line: "Only while Bops is open on this Mac." },
] as const;

/** A computer's runner in plain words, with its dot: up (or asleep till a routine wakes it), being set up or stopped, or why it couldn't start. */
export function runnerNow(x: RunnerState | undefined, asleep: boolean): { text: string; dot: string } {
  if (!x) return { text: "Not set up yet", dot: "bg-[#C9C9C6]" };
  if (x.status === "running") return asleep ? { text: "Asleep", dot: "bg-[#C9C9C6]" } : { text: "Running", dot: "bg-[#2BB673]" };
  if (x.status === "installing") return { text: "Setting up", dot: "bg-[#E59A0B]" };
  if (x.status === "stopping") return { text: "Stopping", dot: "bg-[#C9C9C6]" };
  return { text: x.error?.trim() ? `Couldn't start: ${undash(x.error.trim())}` : "Couldn't start", dot: "bg-[#D92D20]" };
}

/** The computers this workspace's bots work on, each once, as the bot whose computer it is. */
function computersOf(state: AppState): { id: string; host: Bot }[] {
  const out = new Map<string, Bot>();
  for (const b of teamOf(state)) {
    const host = workBot(b, state.bots);
    if (host.computerId && !out.has(host.computerId)) out.set(host.computerId, host);
  }
  return [...out].map(([id, host]) => ({ id, host }));
}

/**
 * Settings, Where routines run: Cloud (the default: each computer's own Bops runs its bots' routines, so
 * they keep running with the Mac closed) or This Mac, as Orgo keeps it for every Mac of the user's. An
 * Orgo that can't keep it yet shows This Mac and says so; one that didn't answer shows neither picked,
 * and says so. In the Cloud, each computer's runner and how it is. `info` is null until /api/runs-on
 * answers: nothing is picked yet. Exported for the tests.
 */
export function RunsOnChoice({ state, info, busy, error, onPick }: { state: AppState; info: RunsOnInfo | null; busy: boolean; error: string | null; onPick: (to: "cloud" | "mac") => void }) {
  const on = info?.missing ? "mac" : (info?.runsOn ?? undefined);
  const unheard = !!info && !info.missing && !info.runsOn;
  const computers = computersOf(state);
  const shown = computers.filter((c) => on === "cloud" || state.runners?.[c.id]);
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <span className="text-[13px] font-semibold">Where routines run</span>
      <div className="flex gap-2.5">
        {CHOICES.map((c) => (
          <button
            key={c.id}
            disabled={!info || busy || (c.id === "cloud" && info.missing)}
            onClick={() => on !== c.id && onPick(c.id)}
            className={`flex flex-1 flex-col gap-1.5 rounded-[14px] p-3.5 text-left disabled:cursor-default ${option(on === c.id)} ${c.id === "cloud" && info?.missing ? "opacity-50" : ""}`}
          >
            <span className="flex items-center justify-between">
              <span className="text-[14px] font-semibold">{c.name}</span>
              {radio(on === c.id)}
            </span>
            <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{c.line}</span>
          </button>
        ))}
      </div>
      {info?.missing && <span className="text-[12px] leading-4 text-[#6B6B6B]">Cloud isn&apos;t available yet.</span>}
      {unheard && !error && <span className="text-[12px] leading-4 text-[#B42318]">Couldn&apos;t reach Orgo. Try again.</span>}
      {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
      {!!shown.length && (
        <div className="flex flex-col">
          {shown.map(({ id, host }) => {
            const now = runnerNow(state.runners?.[id], !!info?.asleep.includes(id));
            return (
              <div key={id} className="flex items-center border-b border-[#F0F0EE] py-2.5 last:border-0">
                <span className="flex w-[200px] items-center gap-2">
                  <Mascot botId={host.id} color={host.color} size={20} />
                  <span className="text-[13.5px] font-medium">{host.name}&apos;s computer</span>
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-[#3A3A38]">
                  <span className={`size-[7px] shrink-0 rounded-full ${now.dot}`} />
                  <span className="min-w-0 truncate" data-tip={now.text.length > 60 ? now.text : undefined}>
                    {now.text}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Settings, Where routines run: reads it when Settings opens, and sets it when a card is picked. */
export function RunsOnSettings({ state }: { state: AppState }) {
  const [info, setInfo] = useState<RunsOnInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    fetch("/api/runs-on", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<RunsOnInfo>) : null))
      .then((j) => !stop && j && setInfo(j))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  const pick = async (to: "cloud" | "mac") => {
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/runs-on", { runsOn: to });
      const j = (await res.json().catch(() => ({}))) as { runsOn?: RunsOnInfo["runsOn"]; missing?: boolean; error?: string };
      if (j.runsOn !== undefined) setInfo((i) => ({ asleep: i?.asleep ?? [], runsOn: j.runsOn ?? null, missing: !!j.missing }));
      if (!res.ok && !j.missing) setError(undash(j.error ?? "Couldn't change it. Try again."));
    } catch {
      setError("Couldn't change it. Try again.");
    }
    setBusy(false);
  };
  return <RunsOnChoice state={state} info={info} busy={busy} error={error} onPick={(to) => void pick(to)} />;
}
