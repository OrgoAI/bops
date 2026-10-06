import "server-only";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { AppState } from "@/lib/types";

/**
 * Where the state lives between starts. The desktop app keeps it in .data/state.json; a hosted
 * server (BOPS_DATABASE_URL set) keeps each user's in Postgres (lib/server/persist-pg.ts). Either
 * way the state in memory is what everything reads: this only loads it and saves it behind.
 */
export type Persistence = {
  /** The saved state to start from at module init, or null to start fresh. Postgres starts fresh and hydrates later. */
  initial(): Record<string, unknown> | null;
  /** Something changed: save soon, in the background. */
  changed(): void;
  /** Keep a copy of the current state (before a reset). */
  backup(): void;
  /** Load the saved state before the first request (Postgres; the file loads at module init). */
  hydrate(): Promise<void>;
  /** Before a sign-in lands: make the state in memory this user's (Postgres; throws to refuse the sign-in). */
  signIn(userId: string): Promise<void>;
  /** Before a sign-out: save the user's state and let it go from memory (Postgres). */
  signOut(): Promise<void>;
};

/** What a backend needs from the store: the state, and a way to swap in one loaded from elsewhere. */
export type StateAccess = {
  get(): AppState;
  /** Replace the state in memory with a saved one (null: start fresh), brought up to the current shape. */
  replace(raw: Record<string, unknown> | null): void;
};

export const onPostgres = () => !!process.env.BOPS_DATABASE_URL;

const FILE = `${process.cwd()}/.data/state.json`;

const gx = globalThis as unknown as { __bopsExitWork?: Map<string, () => Promise<unknown>> };
const exitWork = (gx.__bopsExitWork ??= new Map());

/**
 * Work that has to finish on the way out (Bops Cloud's last state upload), by name so a code reload
 * replaces it. On SIGINT or SIGTERM the desktop server gives it up to 5 seconds, then exits. Next
 * exits on those signals by itself unless NEXT_MANUAL_SIG_HANDLE is set, as the Mac app sets it
 * (desktop/main.cjs); without it this is best effort.
 */
export const onExit = (name: string, fn: () => Promise<unknown>) => void exitWork.set(name, fn);

const lastWork = () => Promise.race([Promise.allSettled([...exitWork.values()].map((fn) => Promise.resolve().then(fn))), new Promise((r) => setTimeout(r, 5000))]);

/**
 * Saving to disk: at most every quarter second, in the background, and compact. Writing the whole
 * state (hundreds of KB) synchronously on every change held up every request behind it. The state
 * in memory is what everything reads; the file is for the next start (written to a temp file, then
 * renamed, so it's never half-written). Flushed on exit.
 */
export function fileStore({ get }: StateAccess): Persistence {
  const g2 = globalThis as unknown as { __bopsSave?: { timer?: ReturnType<typeof setTimeout>; writing?: Promise<void>; again?: boolean; hooked?: boolean } };
  const save = (g2.__bopsSave ??= {});
  function persist() {
    if (save.timer) return;
    save.timer = setTimeout(() => {
      save.timer = undefined;
      if (save.writing) {
        save.again = true;
        return;
      }
      mkdirSync(`${process.cwd()}/.data`, { recursive: true });
      const tmp = `${FILE}.tmp`;
      save.writing = writeFile(tmp, JSON.stringify(get()))
        .then(() => rename(tmp, FILE))
        .catch((e: Error) => console.warn(`[store] save: ${e.message}`))
        .finally(() => {
          save.writing = undefined;
          if (save.again) {
            save.again = false;
            persist();
          }
        });
    }, 250);
  }
  function flushNow() {
    if (save.timer) clearTimeout(save.timer);
    save.timer = undefined;
    try {
      writeFileSync(FILE, JSON.stringify(get()));
    } catch {
      /* nothing more to do on the way out */
    }
  }
  if (!save.hooked) {
    save.hooked = true;
    process.once("beforeExit", flushNow);
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.once(sig, () => {
        flushNow();
        void lastWork().finally(() => process.exit(0));
      });
  }
  return {
    initial: () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null),
    changed: persist,
    backup() {
      mkdirSync(`${process.cwd()}/.data/backups`, { recursive: true });
      if (existsSync(FILE)) copyFileSync(FILE, `${process.cwd()}/.data/backups/state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    },
    hydrate: async () => {},
    // The desktop app is one person's: their state stays put across sign-ins.
    signIn: async () => {},
    signOut: async () => {},
  };
}
