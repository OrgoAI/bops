"use client";

import { useEffect, useRef, useState } from "react";
import { runnerNeedsKey, workBot, type AppState, type Bot, type ComputerOrgoKey, type RunnerState } from "@/lib/types";
import { Your, yourMac } from "@/lib/shared";
import { Mascot } from "./mascot";
import { since } from "./side-group";
import { teamOf } from "./ui";

/** What /api/runs-on/keys says: each computer's own Orgo key (null: it has none; left out: Orgo couldn't say), and where to manage it on Orgo. */
export type ComputerKeys = { keys: Record<string, ComputerOrgoKey | null>; manage: string };

/**
 * Whether the bots listed work in browsers on this Mac: the user's own, with Bops set to this Mac. Never a
 * workspace shared with them's (state.host is the viewer's own app's; the owner's bots never work here).
 */
const onThisMac = (state: AppState) => !state.shared && state.host === "mac";

/** A bot's computer, in plain words. A bot that shares says whose computer it works on. */
const computerNow = (state: AppState, b: Bot) => {
  const c = workBot(b, state.bots);
  if (onThisMac(state)) return "Uses this Mac";
  // A shared workspace's bot set to its owner's Mac works there, as its Details say (computer.tsx ComputerSummary).
  if (state.shared && b.runsOn === "mac") return `Works on ${yourMac(state)}`;
  if (c.id !== b.id) return `Works on ${c.name}'s computer`;
  return b.computerStatus === "ready" ? "Ready" : b.computerStatus === "cloning" ? "Setting up" : b.computerStatus === "none" ? "Set up on its first task" : "Couldn't be set up yet";
};

/** The computer that's the bot's own (not one it works on of another bot's), if it has one. */
const ownComputer = (state: AppState, b: Bot) => (b.computerId && workBot(b, state.bots).id === b.id ? b.computerId : undefined);

/**
 * Whether a computer holds its own Orgo key, in a line under its bot: "Own Orgo key sk_live_ab12…" and
 * when it was last used, or "No Orgo key" when it has none and its runner counts on one. Null: say
 * nothing (it has none and nothing needs it, or Orgo couldn't say).
 */
export function keyLine(k: ComputerOrgoKey | null | undefined, x: RunnerState | undefined, now = Date.now()): string | null {
  if (k === undefined) return null;
  if (k === null) return runnerNeedsKey(x) ? "No Orgo key" : null;
  const when = k.lastUsed === null ? "" : since(k.lastUsed);
  const used = k.expiresAt !== null && k.expiresAt <= now ? "expired" : !when ? "never used" : `used ${when === "just now" || when.endsWith(" ago") ? when : `on ${when}`}`;
  return `Own Orgo key${k.prefix ? ` ${k.prefix}…` : ""} · ${used}`;
}

/** What a runner on its computer's Orgo identity says it signs in with (RunnerState.auth), above its key line while the computer still holds one. */
export const IDENTITY_LINE = "Orgo identity (this computer only)";

/**
 * Settings, Your bots' computers: each of the workspace's bots and how its computer is, and under a bot
 * that has its own computer, whether its runner signs in with that computer's Orgo identity and whether
 * the computer holds its own Orgo key (`keys`, from /api/runs-on/keys; null until it answers, and
 * nothing said meanwhile). A bot that works on another bot's computer says only whose. Exported for the
 * tests.
 */
export function BotComputersList({ state, keys, padded }: { state: AppState; keys: ComputerKeys | null; padded: boolean }) {
  return (
    <div className={`flex flex-col px-[22px] pt-4 ${padded ? "pb-5" : ""}`}>
      <span className="pb-1 text-[13px] font-semibold">{`${Your(state)} bots' computers`}</span>
      {teamOf(state).map((b) => {
        const own = ownComputer(state, b);
        const key = own ? keys?.keys[own] : undefined;
        const line = own ? keyLine(key, state.runners?.[own]) : null;
        const identity = !!own && state.runners?.[own]?.status === "running" && state.runners[own].auth === "identity";
        return (
          <div key={b.id} className="flex items-center border-b border-[color:var(--c-f0f0ee)] py-2.5 last:border-0">
            <span className="flex w-[200px] items-center gap-2">
              <Mascot botId={b.id} color={b.color} size={20} />
              <span className="text-[13.5px] font-medium">{b.name}</span>
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[12.5px] text-[color:var(--c-3a3a38)]">
                <span
                  className={`size-[7px] rounded-full ${onThisMac(state) || workBot(b, state.bots).computerStatus === "ready" ? "bg-[#2BB673]" : workBot(b, state.bots).computerStatus === "cloning" ? "bg-[#E59A0B]" : "bg-[color:var(--c-c9c9c6)]"}`}
                />
                {computerNow(state, b)}
              </span>
              {identity && <span className="min-w-0 truncate pl-[13px] text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">{IDENTITY_LINE}</span>}
              {line && (
                <span className="flex min-w-0 items-center gap-2 pl-[13px] text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">
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
  );
}

/**
 * Settings, Your bots' computers, in every mode. Each bot's own computer listed is asked about once while
 * Settings is open, whether it holds its own Orgo key (Bops asks Orgo, never the window; not when
 * `askKeys` is off); a row never waits on that.
 */
export function BotComputers({ state, padded, askKeys }: { state: AppState; padded: boolean; askKeys: boolean }) {
  const [keys, setKeys] = useState<ComputerKeys | null>(null);
  const asked = useRef(new Set<string>());
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const ids = askKeys
    ? teamOf(state)
        .map((b) => ownComputer(state, b))
        .filter((id): id is string => !!id)
        .join(",")
    : "";
  useEffect(() => {
    const want = ids.split(",").filter((id) => id && !asked.current.has(id));
    if (!want.length) return;
    for (const id of want) asked.current.add(id);
    fetch(`/api/runs-on/keys?ids=${encodeURIComponent(want.join(","))}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<ComputerKeys>) : null))
      .then((j) => open.current && j && setKeys((k) => ({ manage: j.manage, keys: { ...k?.keys, ...j.keys } })))
      .catch(() => {});
  }, [ids]);
  return <BotComputersList state={state} keys={keys} padded={padded} />;
}
