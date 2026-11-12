import { createHash } from "node:crypto";

/**
 * The key a group of bots is sent by (protocol.ts SharedGroup.key), from its workspace and its name's key (lib/bot-groups.ts
 * groupNameKey: the computer's id, with "/<app>" for one app's bots): the computer's id never leaves, and the owner's Mac
 * finds the group a rename names by it (lib/server/change-acts.ts). Imported by Bops Cloud (ws-slice.ts computersOf) and
 * the app, so it imports only node's own.
 */
export const groupKeyOf = (ws: string, nameKey: string) => `c${createHash("sha256").update(`${ws}:${nameKey}`).digest("hex").slice(0, 16)}`;
