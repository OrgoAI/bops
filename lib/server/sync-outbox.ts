import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onExit } from "./persist";
import * as store from "./store";

/**
 * What a mirror to Orgo still has to send, kept with the signed-in account's folder
 * (<userDir>/outbox/<name>.json), so a quit or a crash while Orgo is away loses none of it: routine-sync.ts
 * keeps its finished runs here, access-sync.ts its logged uses, workspace-skills.ts its deletes. Each
 * entry is added when it's queued and taken out once Orgo took it (or said it never will); what's left
 * when Bops starts is handed back once (restore) and queued again. At most `max` per workspace (the
 * newest). Another account's folder has its own. Never throws: an outbox that can't be written is only
 * in memory, as before it existed. Written half a second after a change, and at once on the way out
 * (persist.ts onExit), so a quit right after Orgo took something doesn't send it again at the next start
 * (orgo-web's access log only appends: each use also carries its entry's id, `clientId`, access-sync.ts).
 */

export type OutboxEntry<T> = { id: string; wsId: string; at: number; item: T };

type Box<T> = { file: string | null; entries: Map<string, OutboxEntry<T>>; timer?: ReturnType<typeof setTimeout> };

const g = globalThis as unknown as { __bopsOutboxes?: Map<string, { box?: Box<unknown>; restored: Set<string> }> };
const boxes = (g.__bopsOutboxes ??= new Map());

/** The account's folder, or null signed out (a test's store may not have one). */
const dirOf = () => {
  try {
    return typeof store.userDir === "function" ? store.userDir() : null;
  } catch {
    return null;
  }
};

export type Outbox<T> = {
  /** Keep `item` for `wsId` until done(): its id. */
  add(wsId: string, item: T): string;
  /** These went (or never will): out of the outbox. */
  done(ids: Iterable<string | undefined>): void;
  /** What's waiting, oldest first (`wsId` for one workspace's). */
  waiting(wsId?: string): OutboxEntry<T>[];
  /** Once per account folder and run of Bops: what was left waiting before this run, to queue again. */
  restore(): OutboxEntry<T>[];
};

export function outbox<T>(name: string, max: number): Outbox<T> {
  const slot = boxes.get(name) ?? { restored: new Set<string>() };
  boxes.set(name, slot);
  const fileFor = (dir: string | null) => (dir ? join(/*turbopackIgnore: true*/ dir, "outbox", `${name}.json`) : null);

  /** The box for the account signed in now, read from its file the first time. */
  const box = (): Box<T> => {
    const file = fileFor(dirOf());
    const had = slot.box as Box<T> | undefined;
    if (had && had.file === file) return had;
    if (had?.timer) {
      clearTimeout(had.timer);
      write(had);
    }
    const entries = new Map<string, OutboxEntry<T>>();
    if (file && existsSync(/*turbopackIgnore: true*/ file)) {
      try {
        const read = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as { entries?: OutboxEntry<T>[] };
        for (const e of Array.isArray(read?.entries) ? read.entries : []) if (e && typeof e.id === "string" && typeof e.wsId === "string") entries.set(e.id, e);
      } catch (e) {
        console.warn(`[outbox] ${name}: unreadable, starting over (${(e as Error).message})`);
      }
    }
    const made: Box<T> = { file, entries };
    slot.box = made as Box<unknown>;
    return made;
  };

  function write(b: Box<T>) {
    if (!b.file) return;
    const tmp = `${b.file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      if (!b.entries.size) {
        rmSync(/*turbopackIgnore: true*/ b.file, { force: true });
        return;
      }
      mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ b.file, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify({ entries: [...b.entries.values()] }), { mode: 0o600 });
      renameSync(/*turbopackIgnore: true*/ tmp, b.file);
    } catch (e) {
      rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
      console.warn(`[outbox] ${name}: keeping it: ${(e as Error).message}`);
    }
  }

  // On the way out (a quit, a restart): what's due to be written is written now.
  onExit(`outbox:${name}`, async () => {
    const b = slot.box as Box<T> | undefined;
    if (!b?.timer) return;
    clearTimeout(b.timer);
    b.timer = undefined;
    write(b);
  });

  /** Written a moment after a change, once for a burst. */
  const saveSoon = (b: Box<T>) => {
    if (!b.file || b.timer) return;
    b.timer = setTimeout(() => {
      b.timer = undefined;
      write(b);
    }, 500);
    b.timer.unref?.();
  };

  return {
    add(wsId, item) {
      try {
        const b = box();
        const id = randomBytes(8).toString("hex");
        b.entries.set(id, { id, wsId, at: Date.now(), item });
        const mine = [...b.entries.values()].filter((e) => e.wsId === wsId);
        for (const e of mine.slice(0, Math.max(0, mine.length - max))) b.entries.delete(e.id);
        saveSoon(b);
        return id;
      } catch (e) {
        console.warn(`[outbox] ${name}: ${(e as Error).message}`);
        return "";
      }
    },
    done(ids) {
      try {
        const b = box();
        let changed = false;
        for (const id of ids) if (id && b.entries.delete(id)) changed = true;
        if (changed) saveSoon(b);
      } catch (e) {
        console.warn(`[outbox] ${name}: ${(e as Error).message}`);
      }
    },
    waiting(wsId) {
      try {
        return [...box().entries.values()].filter((e) => wsId === undefined || e.wsId === wsId).sort((a, b) => a.at - b.at);
      } catch {
        return [];
      }
    },
    restore() {
      try {
        const b = box();
        const key = b.file ?? "";
        if (slot.restored.has(key)) return [];
        slot.restored.add(key);
        return [...b.entries.values()].sort((a, c) => a.at - c.at);
      } catch {
        return [];
      }
    },
  };
}

/** Tests: write every outbox now, or forget them in memory as a restart would (the files stay). */
export const outboxForTests = {
  writeAll: () => {
    for (const slot of boxes.values()) {
      const b = slot.box;
      if (!b) continue;
      if (b.timer) clearTimeout(b.timer);
      b.timer = undefined;
      if (!b.file) continue;
      try {
        if (!b.entries.size) rmSync(b.file, { force: true });
        else {
          mkdirSync(join(b.file, ".."), { recursive: true, mode: 0o700 });
          writeFileSync(b.file, JSON.stringify({ entries: [...b.entries.values()] }), { mode: 0o600 });
        }
      } catch {
        // Only a test's copy.
      }
    }
  },
  restart: () => {
    outboxForTests.writeAll();
    for (const slot of boxes.values()) {
      slot.box = undefined;
      slot.restored.clear();
    }
  },
};
