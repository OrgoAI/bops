import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The chat turn a computer's runner is answering now (runner-chat.ts), carried through everything the turn awaits
 * (chat.ts turn, its tools, the messages it adds), so what it writes is the turn's:
 *
 * - each message its bot adds in the turn's chat carries the turn's id and Bops Cloud's clock (stamp), never before the
 *   message it answers: Bops Cloud takes such a row only from the device that holds the turn (cloud/turns.ts), and a
 *   computer's own clock can lag after it wakes;
 * - the first thing it does that can't be done twice (a tool that sends, writes or starts something) is said once
 *   (noteActing), so a runner that goes quiet after that never has the turn run again;
 * - a turn Bops Cloud took back (its member removed, its lease lost) stops where it is and writes nothing more
 *   (cancelled, and chat.ts's own check of whose turn it is).
 *
 * Nothing here on the Mac: no turn is ever in it there. No imports, so the store and chat.ts take it without a cycle.
 */
export type TurnContext = {
  id: string;
  chatId: string;
  botId: string;
  /** Bops Cloud's clock less this computer's, at the claim (ms). */
  offsetMs: number;
  /** The time of the message it answers: its rows come after. */
  humanAt: number;
  acting: boolean;
  cancelled: boolean;
  /** Told once, the first time it does something that can't be done twice. */
  onActing?: () => void;
};

const als = new AsyncLocalStorage<TurnContext>();
/** How many turns run on this server now (free-hours.ts: its computer is in use meanwhile). */
let running = 0;

/** Run `fn` as turn `ctx`: everything it awaits is that turn's. */
export async function runInTurn<T>(ctx: TurnContext, fn: () => Promise<T>): Promise<T> {
  running++;
  try {
    return await als.run(ctx, fn);
  } finally {
    running--;
  }
}

export const currentTurn = (): TurnContext | undefined => als.getStore();
export const turnsRunning = () => running > 0;

/** The turn did something that can't be done twice: said once. */
export function noteActing() {
  const t = als.getStore();
  if (!t || t.acting) return;
  t.acting = true;
  t.onActing?.();
}

/** Whose turn this still is: `ours` (the state's own check), and not one Bops Cloud took back. */
export const stillTurn = (ours: () => boolean) => {
  const t = als.getStore();
  return () => ours() && !t?.cancelled;
};

/**
 * A message the turn adds: its bot's words or Bops' note in the turn's chat carry the turn's id and Bops Cloud's time
 * (after the message it answers). Anything else, or with no turn, as it is.
 */
export function stamp<M extends { chatId: string; at: number; role: string; botId?: string }>(m: M): M & { turn?: string } {
  const t = als.getStore();
  if (!t || m.chatId !== t.chatId || (m.role !== "bot" && m.role !== "system") || (m.botId !== undefined && m.botId !== t.botId)) return m;
  return { ...m, turn: t.id, at: Math.max(m.at + t.offsetMs, t.humanAt + 1) };
}
