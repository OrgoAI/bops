/*
 * A client's Canva app (Canva Connect) in Keys: its client ID and client secret, a pair of This workspace's keys named by
 * the client, so one workspace keeps one for each client it onboards (each client's Canva workspace has its own app, made
 * by someone in it). Apps link their variables to these names (lib/server/app-keys.ts); Canva's Allow step and its refresh
 * token stay with the app. Only apps use them: no bot calls Canva with them (lib/server/keys.ts APP_KEY_PROVIDERS).
 */

/** How the pair's names start: CANVA_CLIENT_ID__ACME_TEST and CANVA_CLIENT_SECRET__ACME_TEST. */
export const CANVA_ID = "CANVA_CLIENT_ID__";
export const CANVA_SECRET = "CANVA_CLIENT_SECRET__";
/** The longest a client's part may be: the secret's name stays within a vault name's 64 characters (cloud/protocol.ts KEY_NAME). */
export const CANVA_CLIENT_MAX = 64 - CANVA_SECRET.length;
/** UPPER_SNAKE words, one underscore between them: what's after the name's "__" never holds another. */
const CLIENT = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/** A client's name as its keys carry it: "Acme Test" is ACME_TEST, "Café Nord" is CAFE_NORD. Empty when no letter or digit is left. */
export const canvaClient = (label: string) =>
  label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Whether a client's part makes a pair of names a vault keeps. */
export const canvaClientOk = (client: string) => CLIENT.test(client) && client.length <= CANVA_CLIENT_MAX;

/** A Canva key's client and which of the pair it is; null for any other name. */
export function canvaOf(name: string): { client: string; part: "id" | "secret" } | null {
  const part = name.startsWith(CANVA_ID) ? "id" : name.startsWith(CANVA_SECRET) ? "secret" : null;
  if (!part) return null;
  const client = name.slice(part === "id" ? CANVA_ID.length : CANVA_SECRET.length);
  return canvaClientOk(client) ? { client, part } : null;
}

/** A client's pair of names. */
export const canvaNames = (client: string) => ({ id: `${CANVA_ID}${client}`, secret: `${CANVA_SECRET}${client}` });

/** A client's name for the page, from its keys' (the vault keeps names alone): ACME_TEST is "Acme Test". */
export const canvaLabel = (client: string) =>
  client
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
