import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the code running now is a change someone made from their own window, being done by this Mac through the owner's
 * own route (lib/server/change-acts.ts): such a route acts on the owner's own workspace, whatever the owner's window has
 * open (lib/server/shared.ts sharedOpen reads no shared workspace for it). Who made it, for what's said of it.
 */
const doing = new AsyncLocalStorage<{ name: string }>();

export const changeBy = () => doing.getStore() ?? null;
export const asChange = <T>(who: { name: string }, run: () => Promise<T>): Promise<T> => doing.run(who, run);
