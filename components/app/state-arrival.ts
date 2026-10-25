"use client";

import { useSyncExternalStore } from "react";

let arrivedAt = 0;
const listeners = new Set<() => void>();

/** A new state just came in from the app's server (useAppState): the time it did. */
export function stateArrived(now: number) {
  arrivedAt = now;
  for (const l of listeners) l();
}

const subscribe = (changed: () => void) => {
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
  };
};

/**
 * When the app's state last came in, read as the time now by what goes by a message's age (a bot's
 * blush after a thanks, BotMoodsFrom): a message synced in late, after the Mac wakes or from another
 * device, is as old as it is, and one stamped by a clock ahead of this Mac's isn't fresh for longer.
 */
export const useStateArrival = () =>
  useSyncExternalStore(
    subscribe,
    () => arrivedAt,
    () => 0,
  );
