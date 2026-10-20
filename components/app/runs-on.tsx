"use client";

import { useEffect, useRef, useState } from "react";
import { runnerNeedsKey, workBot, type AppState, type Bot, type ComputerOrgoKey, type RunnerState } from "@/lib/types";
import { Mascot } from "./mascot";
import { since, undash } from "./side-group";
import { option, post, radio, teamOf } from "./ui";

/** What /api/runs-on says: where routines run (null: Orgo didn't answer), whether Orgo can keep it yet, and which computers with a runner up are asleep. */
export type RunsOnInfo = { runsOn: "cloud" | "mac" | null; missing: boolean; asleep: string[] };

/** What /api/runs-on/keys says: each computer's own Orgo key (null: it has none; left out: Orgo couldn't say), and where to manage it on Orgo. */
export type RunsOnKeys = { keys: Record<string, ComputerOrgoKey | null>; manage: string };

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

/**
 * Whether a computer holds its own Orgo key, in a line under its runner: "Own Orgo key sk_live_ab12…"
 * and when it was last used, or "No Orgo key" when it has none and its runner counts on one. Null: say
 * nothing (it has none and nothing needs it, or Orgo couldn't say).
 */
export function keyLine(k: ComputerOrgoKey | null | undefined, x: RunnerState | undefined, now = Date.now()): string | null {
  if (k === undefined) return null;
  if (k === null) return runnerNeedsKey(x) ? "No Orgo key" : null;
  const when = k.lastUsed === null ? "" : since(k.lastUsed);
  const used = k.expiresAt !== null && k.expiresAt <= now ? "expired" : !when ? "never used" : `used ${when === "just now" || when.endsWith(" ago") ? when : `on ${when}`}`;
  return `Own Orgo key${k.prefix ? ` ${k.prefix}…` : ""} · ${used}`;
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

/** Where routines run as picked (an Orgo that can't keep it yet: This Mac; undefined until Bops says). */
const pickedOf = (info: RunsOnInfo | null) => (info?.missing ? "mac" : (info?.runsOn ?? undefined));

/** The computers Settings lists: every one in the Cloud, else only those with a runner (one still being stopped). */
const shownComputers = (state: AppState, info: RunsOnInfo | null) => computersOf(state).filter((c) => pickedOf(info) === "cloud" || state.runners?.[c.id]);

/**
 * Settings, Where routines run: Cloud (the default: each computer's own Bops runs its bots' routines, so
 * they keep running with the Mac closed) or This Mac, as Orgo keeps it for every Mac of the user's. An
 * Orgo that can't keep it yet shows This Mac and says so; one that didn't answer shows neither picked,
 * and says so. In the Cloud, each computer's runner and how it is, and whether the computer holds its
 * own Orgo key (`keys`, from /api/runs-on/keys; null until it answers, and nothing said meanwhile). `info`
 * is null until /api/runs-on answers: nothing is picked yet. Exported for the tests.
 */
export function RunsOnChoice({
  state,
  info,
  keys = null,
  busy,
  error,
  onPick,
}: {
  state: AppState;
  info: RunsOnInfo | null;
  keys?: RunsOnKeys | null;
  busy: boolean;
  error: string | null;
  onPick: (to: "cloud" | "mac") => void;
}) {
  const on = pickedOf(info);
  const unheard = !!info && !info.missing && !info.runsOn;
  const shown = shownComputers(state, info);
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
            const x = state.runners?.[id];
            const now = runnerNow(x, !!info?.asleep.includes(id));
            const key = keys?.keys[id];
            const line = keyLine(key, x);
            return (
              <div key={id} className="flex items-center border-b border-[#F0F0EE] py-2.5 last:border-0">
                <span className="flex w-[200px] items-center gap-2">
                  <Mascot botId={host.id} color={host.color} size={20} />
                  <span className="text-[13.5px] font-medium">{host.name}&apos;s computer</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-[#3A3A38]">
                    <span className={`size-[7px] shrink-0 rounded-full ${now.dot}`} />
                    <span className="min-w-0 truncate" data-tip={now.text.length > 60 ? now.text : undefined}>
                      {now.text}
                    </span>
                  </span>
                  {line && (
                    <span className="flex min-w-0 items-center gap-2 pl-[13px] text-[12px] leading-4 text-[#6B6B6B]">
                      <span className="min-w-0 truncate" data-tip={key?.name || undefined}>
                        {line}
                      </span>
                      {key && keys?.manage && (
                        <a href={keys.manage} target="_blank" rel="noreferrer" className="shrink-0 underline underline-offset-2 hover:text-ink">
                          Manage in Orgo
                        </a>
                      )}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Settings, Where routines run: reads it when Settings opens, and sets it when a card is picked. Each
 * computer listed is asked about once while Settings is open, whether it holds its own Orgo key (Bops
 * asks Orgo, never the window); a row never waits on that.
 */
export function RunsOnSettings({ state }: { state: AppState }) {
  const [info, setInfo] = useState<RunsOnInfo | null>(null);
  const [keys, setKeys] = useState<RunsOnKeys | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    let stop = false;
    fetch("/api/runs-on", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<RunsOnInfo>) : null))
      .then((j) => !stop && j && setInfo(j))
      .catch(() => {});
    return () => {
      stop = true;
      open.current = false;
    };
  }, []);
  const ids = shownComputers(state, info)
    .map((c) => c.id)
    .join(",");
  useEffect(() => {
    const want = ids.split(",").filter((id) => id && !asked.current.has(id));
    if (!want.length) return;
    for (const id of want) asked.current.add(id);
    fetch(`/api/runs-on/keys?ids=${encodeURIComponent(want.join(","))}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<RunsOnKeys>) : null))
      .then((j) => open.current && j && setKeys((k) => ({ manage: j.manage, keys: { ...k?.keys, ...j.keys } })))
      .catch(() => {});
  }, [ids]);
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
  return <RunsOnChoice state={state} info={info} keys={keys} busy={busy} error={error} onPick={(to) => void pick(to)} />;
}
