import "server-only";
import { onRunner } from "./persist";
import { bankInUse, deleteBank, memoryGoesWith, memoryOn, purgeMemory, type Binding } from "./memory";
import { outbox } from "./sync-outbox";

/**
 * A deleted workspace's memory goes from Honcho too (remove.ts deleteWorkspace; orgo-web's project delete
 * makes no Honcho call, and Bops is what made the bank): its own bank whole when no other workspace uses
 * it, else only its Orbit issues' sessions in the bank it shares (memory.ts memoryGoesWith). Kept in an
 * outbox on disk (sync-outbox.ts) until memory took it, so a quit or memory not answering loses none of
 * it: tried again after a backoff of 1 to 30 minutes and at the next start. A bank another workspace
 * took up meanwhile is never deleted. Memory never taking it (a 400, a 403) is given up on, said in the
 * log. Never on a computer's runner.
 */

/** A bank to delete (no `sessions`), or only these sessions in it. */
type MemoryDelete = { bank: string; peer: string; sessions?: string[] };
const box = outbox<MemoryDelete>("memory-deletes", 50);

const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** An entry memory never took in this long goes (a plan without memory since, say). */
const GIVE_UP_MS = 30 * 24 * 3600_000;

const g = globalThis as unknown as { bopsMemoryDeletes?: { timer?: ReturnType<typeof setTimeout>; tries: number; running?: Promise<boolean> } };
const live = (g.bopsMemoryDeletes ??= { tries: 0 });

/** Memory didn't answer, or answered for now (signed out, a timeout, still busy, too many, 5xx): sent again later. */
const forNow = (status: number | undefined) => status === undefined || status === 401 || status === 408 || status === 409 || status === 429 || status >= 500;

/**
 * What of a workspace's memory goes with it, asked while it's still listed (its binding is read from it):
 * the bank, or the issues' sessions (`issueSessions`, listed by orbit-issues.ts while the bank was still
 * the workspace's). Null when nothing goes.
 */
export function memoryDeleteFor(ws: string, issueSessions: string[]): MemoryDelete | null {
  const goes = memoryGoesWith(ws);
  if (!goes) return null;
  const b: Binding = goes.binding;
  if (goes.whole) return { bank: b.bank, peer: b.peer };
  return issueSessions.length ? { bank: b.bank, peer: b.peer, sessions: [...new Set(issueSessions)].slice(0, 2000) } : null;
}

/** Queue it (the workspace is gone from the list by now) and send it at once. */
export function deleteWorkspaceMemory(ws: string, what: MemoryDelete | null): Promise<boolean> {
  if (!what || onRunner()) return Promise.resolve(true);
  box.add(ws, what);
  return flushMemoryDeletes();
}

/** Send what's waiting, one run at a time. True when nothing is left waiting. */
export function flushMemoryDeletes(): Promise<boolean> {
  return (live.running ??= run().finally(() => (live.running = undefined)));
}

async function run(): Promise<boolean> {
  if (onRunner()) return true;
  let left = false;
  for (const e of box.waiting()) {
    const d = e.item;
    // A bank a workspace listed now uses (taken up again since): only sessions may go there, never the bank.
    if (!d.sessions && bankInUse(d.bank)) {
      box.done([e.id]);
      continue;
    }
    if (Date.now() - e.at > GIVE_UP_MS) {
      console.warn(`[memory] ${e.wsId}'s memory waited a month for memory to take it; not asked again`);
      box.done([e.id]);
      continue;
    }
    if (!memoryOn()) {
      left = true;
      continue;
    }
    try {
      if (d.sessions) {
        const r = await purgeMemory(e.wsId, { facts: [], sessions: d.sessions }, { bank: d.bank, peer: d.peer });
        box.done([e.id]);
        // What memory still has: kept, to be tried again.
        if (r.sessions.length) {
          box.add(e.wsId, { ...d, sessions: r.sessions });
          left = true;
        }
      } else {
        await deleteBank({ bank: d.bank, peer: d.peer });
        box.done([e.id]);
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (forNow(status)) left = true;
      else {
        console.warn(`[memory] memory answered ${status} to deleting ${e.wsId}'s memory; not asked again`);
        box.done([e.id]);
      }
    }
  }
  if (left) later();
  else live.tries = 0;
  return !left;
}

/** Tried again after a backoff (1 minute, doubling to 30), once at a time. */
function later() {
  if (live.timer) return;
  live.tries++;
  live.timer = setTimeout(
    () => {
      live.timer = undefined;
      void flushMemoryDeletes().catch((e: Error) => console.warn(`[memory] deleting a workspace's memory: ${e.message}`));
    },
    Math.min(RETRY_MS * 2 ** (live.tries - 1), RETRY_MAX_MS),
  );
  live.timer.unref?.();
}

/** What waited from an earlier run of Bops goes now (once a start, from workspaces.ts startProjectBinding). */
export function memoryDeletesOnStart() {
  if (onRunner() || !box.restore().length) return;
  void flushMemoryDeletes().catch((e: Error) => console.warn(`[memory] deleting a workspace's memory: ${e.message}`));
}

/** Tests: what's waiting, and the retry. */
export const memoryDeletesForTests = {
  waiting: () => box.waiting(),
  retrying: () => !!live.timer,
  reset: () => {
    if (live.timer) clearTimeout(live.timer);
    live.timer = undefined;
    live.tries = 0;
  },
};
