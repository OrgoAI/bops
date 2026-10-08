import "server-only";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppState } from "@/lib/types";
import { legacyStateFile, moveLegacyState, userDataDir } from "./user-paths";

/**
 * Where the state lives between starts, and whose it is.
 *
 * - The Mac app, signed in with Orgo (the usual case): in Bops Cloud, under the user's Orgo id
 *   (persist-cloud.ts). Nothing is kept on the Mac (but changes the cloud couldn't take yet, in the
 *   user's folder until they're up): signing in loads that user's state, signing out lets it go, and
 *   until someone is signed in there is no state to work on (ready() is false).
 * - A self-hosted install (BOPS_SELF_HOSTED=1, no cloud): files on this Mac, one per Orgo user
 *   (.data/users/<id>/state.json), and .data/state.json while nobody's signed in (it runs on its own key).
 * - A hosted server (BOPS_DATABASE_URL): each user's row in Postgres (persist-pg.ts).
 *
 * Either way the state in memory is what everything reads: these only load it and save it behind.
 */
export type Persistence = {
  /** The saved state to start from at module init, or null to start fresh (the cloud and Postgres load later). */
  initial(): Record<string, unknown> | null;
  /** Something changed: save soon, in the background. */
  changed(): void;
  /** Keep a copy of the current state (before a reset). */
  backup(): Promise<void>;
  /** Load the saved state before the first request (Postgres pinned to a user). */
  hydrate(): Promise<void>;
  /**
   * Before a sign-in lands: make the state in memory this user's, loading it (`key`: their Orgo key,
   * which the cloud needs). Throws StateLoadError to refuse the sign-in when it can't.
   */
  signIn(userId: string, key?: string): Promise<void>;
  /** Signing out: save what's left (the cloud keeps trying in the background) and let the state go from memory. */
  signOut(): Promise<void>;
  /** Whether there is a state to work on: a user's is loaded, or this kind of store works without one. */
  ready(): boolean;
  /** Whose state is in memory (null: nobody's). */
  user(): string | null;
  /**
   * Save what's changed now and wait for it to land, up to `ms`: true when nothing is left unsaved (a
   * sign-out asks before going on without; Restart Bops, lib/server/restart.ts, saves first).
   */
  flush(ms: number): Promise<boolean>;
  /** Changes not saved yet. */
  unsent(): boolean;
  /** Read what changed elsewhere (another Mac of the user's) now. */
  pull(): Promise<void>;
};

/** What a backend needs from the store: the state, a way to swap in one loaded from elsewhere, and to say it changed. */
export type StateAccess = {
  get(): AppState;
  /** Replace the state in memory with a saved one (null: start fresh), brought up to the current shape. A new epoch: work in flight is dropped. */
  replace(raw: Record<string, unknown> | null): void;
  /** The state in memory changed in place (another Mac's changes merged in): the app polls it again. Not a new epoch. */
  touch(): void;
};

/** A sign-in's state couldn't be loaded (Bops Cloud down, or this Mac offline): the sign-in is refused, and the app says so. */
export class StateLoadError extends Error {}

export const onPostgres = () => !!process.env.BOPS_DATABASE_URL;
/** Self-hosting: keys in .env.local, no Bops Cloud, the state in files on this Mac. */
export const selfHosted = () => process.env.BOPS_SELF_HOSTED === "1";

const gx = globalThis as unknown as { __bopsExitWork?: Map<string, () => Promise<unknown>>; __bopsExitHooked?: boolean };
const exitWork = (gx.__bopsExitWork ??= new Map());

/**
 * Work that has to finish on the way out (the last state save to Bops Cloud, closing its tunnel), by
 * name so a code reload replaces it. On SIGINT or SIGTERM the desktop server gives it up to 5
 * seconds, then exits. Next exits on those signals by itself unless NEXT_MANUAL_SIG_HANDLE is set, as
 * the Mac app sets it (desktop/main.cjs); without it this is best effort.
 */
export const onExit = (name: string, fn: () => Promise<unknown>) => void exitWork.set(name, fn);

const lastWork = () => Promise.race([Promise.allSettled([...exitWork.values()].map((fn) => Promise.resolve().then(fn))), new Promise((r) => setTimeout(r, 5000))]);

/** On SIGINT or SIGTERM: `first` (a last synchronous save), then the exit work, then `last`, then exit. Once per process. */
export function hookExit(first: () => void = () => {}, last: () => Promise<unknown> = async () => {}) {
  if (gx.__bopsExitHooked) return;
  gx.__bopsExitHooked = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.once(sig, () => {
      first();
      void lastWork()
        .then(last)
        .finally(() => process.exit(0));
    });
}

/**
 * A self-hosted install's files: saved at most every quarter second, in the background, compact.
 * Writing the whole state (hundreds of KB) synchronously on every change held up every request
 * behind it. The state in memory is what everything reads; the file is for the next start (written
 * to a temp file, then renamed, so it's never half-written). Flushed on exit. One file per Orgo user
 * who signs in, so one account's state never shows for another; .data/state.json while nobody is.
 */
export function fileStore({ get, replace }: StateAccess): Persistence {
  const g2 = globalThis as unknown as {
    __bopsSave?: { timer?: ReturnType<typeof setTimeout>; writing?: Promise<void>; again?: boolean; hooked?: boolean; user?: string };
  };
  const save = (g2.__bopsSave ??= {});
  const fileOf = (user: string | undefined) => (user ? join(userDataDir(user), "state.json") : legacyStateFile());
  const read = (file: string) => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null);

  function persist() {
    if (save.timer) return;
    save.timer = setTimeout(() => {
      save.timer = undefined;
      if (save.writing) {
        save.again = true;
        return;
      }
      const file = fileOf(save.user);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      save.writing = writeFile(tmp, JSON.stringify(get()))
        .then(() => rename(tmp, file))
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
  /** Save now, whole: to a temp file of its own (a background save may be writing the other), then renamed over the file. */
  function flushNow() {
    if (save.timer) clearTimeout(save.timer);
    save.timer = undefined;
    try {
      const file = fileOf(save.user);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.now.tmp`;
      writeFileSync(tmp, JSON.stringify(get()));
      renameSync(tmp, file);
    } catch (e) {
      console.warn(`[store] save: ${(e as Error).message}`);
    }
  }
  /**
   * Save now and wait for it. A background save already under way lands first: it holds an older
   * state, and landing after this one it would put that back.
   */
  async function flush() {
    while (save.writing) await save.writing;
    flushNow();
  }
  if (!save.hooked) {
    save.hooked = true;
    process.once("beforeExit", flushNow);
    // On SIGINT or SIGTERM: saved now, then once more last, after the exit work (persist.ts hookExit),
    // with what changed while it ran (bots still at work) and after any background save under way,
    // which could otherwise land after the one before.
    hookExit(flushNow, flush);
  }
  /** Save the state in memory to its file now (after a background save under way, see flush), then take `user`'s (null: nobody's). */
  async function switchTo(user: string | undefined) {
    while (save.writing) await save.writing;
    flushNow();
    save.user = user;
    replace(read(fileOf(user)));
  }
  return {
    initial() {
      // A file from before that names one user goes to that user's folder (a file that names none, or
      // several, stays: it's what this install runs on while nobody is signed in).
      const moved = moveLegacyState("state.json", false);
      if (moved) console.info(`[store] the state from before is ${moved.owner ? `Orgo user ${moved.owner}'s now` : "kept aside"}: ${moved.to}`);
      return read(legacyStateFile());
    },
    changed: persist,
    async backup() {
      const file = fileOf(save.user);
      const dir = join(dirname(file), "backups");
      mkdirSync(dir, { recursive: true });
      if (existsSync(file)) copyFileSync(file, join(dir, `state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    },
    hydrate: async () => {},
    signIn: async (userId) => {
      if (save.user !== userId) await switchTo(userId);
    },
    signOut: async () => {
      if (save.user) await switchTo(undefined);
    },
    ready: () => true,
    user: () => save.user ?? null,
    // A background save under way lands first (flush), then this one; on a slow disk it's still saved after `ms`.
    flush: (ms) => Promise.race([flush().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.())]),
    unsent: () => !!save.timer || !!save.writing,
    pull: async () => {},
  };
}
