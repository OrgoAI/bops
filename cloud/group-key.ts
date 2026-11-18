import { createHash } from "node:crypto";

/**
 * The key a group of bots is sent by (protocol.ts SharedGroup.key), from its workspace and its name's key (lib/bot-groups.ts
 * groupNameKey: the computer's id, with "/<app>" for one app's bots): the computer's id never leaves, and the owner's Mac
 * finds the group a rename names by it (lib/server/change-acts.ts). Imported by Bops Cloud (ws-slice.ts computersOf) and
 * the app, so it imports only node's own.
 */
export const groupKeyOf = (ws: string, nameKey: string) => `c${createHash("sha256").update(`${ws}:${nameKey}`).digest("hex").slice(0, 16)}`;

/**
 * The key a computer's room for more apps is sent by (protocol.ts SharedApps.room), from its workspace and the computer's
 * id: never the id, and never a group's key (another seed and an "r", which no rename takes: lib/server/change-acts.ts
 * finds a group only by a "c" key). A room goes to every member with Your Apps, a computer whose bots they don't see too,
 * so its key must never name that group to rename it. The window uses it only to tell the lines apart.
 */
export const roomKeyOf = (ws: string, computerId: string) => `r${createHash("sha256").update(`room:${ws}:${computerId}`).digest("hex").slice(0, 16)}`;
