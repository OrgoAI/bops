import "server-only";
import { randomBytes } from "node:crypto";
import { MEMBER_NO_KEYS, OWNERS_KEY_LINE, type MemberAct, type SharedKey } from "@/cloud/protocol";
import { KEYS_GIVEN_LINE } from "@/lib/shared";
import { orgoHeaders } from "./app-version";
import { KEY_PROVIDERS, KeysError, keyName, keyProvider } from "./keys";
import { apiKey } from "./orgo";
import { orgoOrigin } from "./orgo-auth";
import { actShared, sharedKeysOpen } from "./shared";

/*
 * Keys in a workspace shared with the user, for someone with Keys there (cloud/ws-slice.ts keysOf: an Admin always, a
 * Member the owner or an Admin gave it in People). This workspace's own keys are the owner's vault's, scoped to the
 * workspace's Orgo project, and orgo-web lets a Keys holder list, add, replace, remove and see them with their own Orgo key
 * (its /api/projects/<id>/bops-keys routes), so none of that waits for the owner's Mac. Which bots use a key is the
 * owner's state's (Bot.keys), switched by the "key" act through Bops Cloud, which the owner's Mac does
 * (lib/server/member-acts.ts). The owner's keys for all their workspaces stay theirs: named here, as the owner's Mac last
 * said them (Workspace.keysForMembers), with their bots' switches, never shown, replaced or removed. A value passes through
 * here on its way to Orgo or back to the window, as for the user's own keys (keys.ts), and is never kept or logged.
 */

/** orgo-web's codes: a caller without Keys (its bops-keys routes), and an orgo-web that can't keep Keys yet (its members route). */
export const KEYS_NOT_ALLOWED = "KEYS_NOT_ALLOWED";
export const KEYS_UNAVAILABLE = "KEYS_UNAVAILABLE";

/** What the Keys page says when orgo-web has no bops-keys routes yet (an older orgo-web). */
export const KEYS_NOT_ON_ORGO = "Orgo can't keep this workspace's keys yet.";
/** What the window says when orgo-web can't link keys to apps yet (no bops-keys/apps route, or no table for it: lib/server/app-keys.ts). */
export const APP_KEYS_NOT_ON_ORGO = "Orgo can't link keys to apps yet.";
const NOT_SIGNED_IN = "Sign in to Orgo to use Keys: they're kept in your Orgo vault.";
/** The owner's keys for all their workspaces, as the window's rows say whose they are. */
export const OWNERS_KEY = "That's the owner's key. Only they can see, replace or remove it.";

/**
 * What orgo-web's bops-keys routes say when they don't do it, by their code, in the window's words. A reveal is limited
 * (30 an hour a person: 429), takes only a sign in with Orgo (app_key_required), and never sends a value it couldn't log
 * (audit_unavailable).
 */
const SAID: Record<string, { status: number; words: string }> = {
  KEY_NOT_FOUND: { status: 404, words: "That key isn't in this workspace anymore." },
  invalid_name: { status: 400, words: "Bops can't call that service yet. Pick one from the list." },
  value_required: { status: 400, words: "Paste the key first." },
  value_too_long: { status: 400, words: "That key is too long." },
  app_key_required: { status: 403, words: "Orgo shows a key only to a Bops signed in with Orgo. Sign out, then sign in again." },
  audit_unavailable: { status: 503, words: "Orgo couldn't note who looked just now, so it didn't send the key. Try again in a minute." },
  // The links of keys to apps (bops-keys/apps, lib/server/app-keys.ts).
  APP_KEYS_UNAVAILABLE: { status: 503, words: APP_KEYS_NOT_ON_ORGO },
  every_app_name: { status: 400, words: "A key for every app keeps its own name." },
  too_many: { status: 400, words: "An app can use at most 64 keys from Keys." },
};

/**
 * One call to a workspace's bops-keys routes on orgo-web, with the user's own Orgo key (a Keys holder's in a shared
 * workspace; the owner's own for app links, lib/server/app-keys.ts). Never logs what it sent or got.
 */
export async function projectKeys<T>(projectId: string, method: "GET" | "POST" | "PUT" | "DELETE", path = "", body?: unknown): Promise<T> {
  let key: string;
  try {
    key = await apiKey();
  } catch {
    throw new KeysError(NOT_SIGNED_IN, 401);
  }
  let res: Response;
  try {
    res = await fetch(`${orgoOrigin()}/api/projects/${encodeURIComponent(projectId)}/bops-keys${path}`, {
      method,
      headers: { ...orgoHeaders(), Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new KeysError("Bops couldn't reach Orgo. Check the internet and try again.", 502);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null;
  if (res.ok && json) return json;
  if (res.status === 401) throw new KeysError(NOT_SIGNED_IN, 401);
  const said = typeof json?.code === "string" && Object.hasOwn(SAID, json.code) ? SAID[json.code] : undefined;
  if (said) throw new KeysError(said.words, said.status);
  // Keys taken away meanwhile: the copy is read again, so the page says so.
  if (res.status === 403 && json?.code === KEYS_NOT_ALLOWED) {
    void sharedKeysOpen()?.refresh().catch(() => {});
    throw new KeysError(KEYS_GIVEN_LINE, 403);
  }
  // A method the route doesn't have: an orgo-web from before it (bops-keys/apps falls into bops-keys/{name}, DELETE only).
  if (res.status === 405) throw new KeysError(KEYS_NOT_ON_ORGO, 503);
  // No such route (an orgo-web before it answers a page, not JSON), or not a member of it any more.
  if (res.status === 404) throw json && typeof json.error === "string" ? new KeysError("This workspace isn't shared with you anymore.", 404) : new KeysError(KEYS_NOT_ON_ORGO, 503);
  if (res.status === 429) throw new KeysError("You've looked at a lot of keys this hour. Try again later.", 429);
  throw new KeysError(json && typeof json.error === "string" ? json.error : `Orgo answered ${res.status}.`, res.ok ? 502 : res.status);
}

/** The shared workspace open now with Keys there, else why not (none open: 409; no Keys: 403, MEMBER_NO_KEYS). */
function withKeys() {
  const open = sharedKeysOpen();
  if (!open) throw new KeysError("Open the workspace again.", 409);
  if (!open.keys) throw Object.assign(new KeysError(KEYS_GIVEN_LINE, 403), { code: MEMBER_NO_KEYS });
  return open;
}

/** A key as the Keys page lists it (components/app/keys.tsx KeyRow): `owner`, the owner's own, which only switches bots. */
export type SharedKeyRow = {
  name: string;
  label: string;
  where: string;
  tip: string;
  readOnly: boolean;
  updatedAt: string | null;
  scope: "workspace" | "all";
  bots: string[];
  owner?: true;
  from?: string;
};

const providerOf = (name: string) => {
  const p = keyProvider(name)!;
  return { name: p.name, label: p.label, where: p.where, tip: p.tip, readOnly: !!p.readOnly };
};

/**
 * GET /api/keys in a shared workspace: This workspace's keys as orgo-web lists them now, then the owner's (for all their
 * workspaces, and another workspace's of theirs switched on here) as the owner's Mac said them, each with the bots that
 * may use it (as switched here). Without Keys, none, and `keys` false: the page says who gives it. `error`: orgo-web
 * couldn't list This workspace's (the owner's still show).
 */
export async function sharedKeysList(): Promise<{ keys: SharedKeyRow[]; scope: { keys: boolean; acts: boolean }; error?: string }> {
  const open = sharedKeysOpen();
  if (!open) throw new KeysError("Open the workspace again.", 409);
  if (!open.keys) return { keys: [], scope: { keys: false, acts: false } };
  const botsOf = (name: string) => open.bots.filter((b) => b.keys.includes(name)).map((b) => b.id);
  let error: string | undefined;
  const live = await projectKeys<{ keys?: unknown }>(open.projectId, "GET").catch((e: unknown) => {
    if (e instanceof KeysError && e.status === 401) throw e;
    error = e instanceof Error ? e.message : "Couldn't read this workspace's keys.";
    return { keys: [] };
  });
  const rows: SharedKeyRow[] = [];
  for (const k of Array.isArray(live.keys) ? live.keys : []) {
    if (!k || typeof k !== "object") continue;
    const { name, updated_at } = k as { name?: unknown; updated_at?: unknown };
    if (typeof name !== "string" || !keyProvider(name) || rows.some((r) => r.name === name)) continue;
    rows.push({ ...providerOf(name), updatedAt: typeof updated_at === "string" ? updated_at : null, scope: "workspace", bots: botsOf(name) });
  }
  for (const k of open.keyNames) {
    if (!keyProvider(k.name)) continue;
    // This workspace's own as the owner's Mac last saw them: orgo-web's list now says what's there.
    if (k.scope === "workspace" && !k.from) continue;
    if (rows.some((r) => r.name === k.name && r.scope === k.scope)) continue;
    rows.push({ ...providerOf(k.name), updatedAt: null, scope: k.scope, bots: botsOf(k.name), owner: true, ...(k.from ? { from: "owner" } : {}) });
  }
  return { keys: rows, scope: { keys: true, acts: open.keyActs }, ...(error ? { error } : {}) };
}

/** An act's key (cloud/protocol.ts MemberActBody.key): a new one each time. */
const actKey = () => `key_${randomBytes(12).toString("base64url")}`;

/** Whether the keys the workspace's bots see have `name` only as the owner's own (for all their workspaces, or another workspace's of theirs). */
const ownersOnly = (names: SharedKey[], name: string) => {
  const of = names.filter((k) => k.name === name);
  return of.length > 0 && !of.some((k) => k.scope === "workspace" && !k.from);
};

/**
 * Let a bot of the shared workspace use a key, or stop it (the "key" act, through Bops Cloud): null, or why not. On, only
 * one of the workspace's own: one the owner's Mac said is the owner's alone is refused here first, unless orgo-web lists it
 * as the workspace's now (added since), and Bops Cloud and the owner's Mac check again. `saved`: a key of This workspace
 * just saved here, which orgo-web has. Off goes for any.
 */
export async function sharedGrant(name: string, botId: string, on: boolean, o: { saved?: boolean } = {}): Promise<{ status: number; error: string } | null> {
  const n = keyName(name);
  if (!keyProvider(n)) return { status: 404, error: "No such key." };
  const open = withKeys();
  if (!open.bots.some((b) => b.id === botId)) return { status: 404, error: "That bot isn't here." };
  if (on && !o.saved && ownersOnly(open.keyNames, n)) {
    const live = await projectKeys<{ keys?: unknown }>(open.projectId, "GET").catch(() => null);
    const here = !!live && Array.isArray(live.keys) && live.keys.some((k) => !!k && typeof k === "object" && (k as { name?: unknown }).name === n);
    if (!here) return { status: 403, error: OWNERS_KEY_LINE };
  }
  const act: MemberAct = { act: "key", botId, name: n, on };
  const r = await actShared(act, actKey());
  return r.ok ? null : { status: r.status || 502, error: r.error };
}

/**
 * Save a key to This workspace (orgo-web, with the user's own key: the same name replaces it), then let `botIds` use it
 * ("key" acts). `note`: the key saved, but a bot's switch didn't go (the owner's Bops needs an update, say).
 */
export async function sharedSave(name: string, value: string, botIds: string[]): Promise<{ name: string; note?: string }> {
  const n = keyName(name);
  if (!keyProvider(n)) throw new KeysError("Bops can't call that service yet. Pick one from the list.", 400);
  const v = value.trim();
  if (!v) throw new KeysError("Paste the key first.", 400);
  if (v.length > 8192) throw new KeysError("That key is too long.", 400);
  const open = withKeys();
  await projectKeys(open.projectId, "POST", "", { name: n, value: v });
  let note: string | undefined;
  for (const botId of botIds.filter((id, i, all) => all.indexOf(id) === i && open.bots.some((b) => b.id === id && !b.keys.includes(n)))) {
    const no = await sharedGrant(n, botId, true, { saved: true }).catch((e: unknown) => ({ status: 502, error: e instanceof Error ? e.message : "That didn't go." }));
    if (no) note ??= `Saved. The bots you picked didn't get it: ${no.error}`;
  }
  return { name: n, ...(note ? { note } : {}) };
}

/**
 * Take a key out of This workspace (orgo-web), and from every bot that uses it: one by that name the owner has for all
 * their workspaces would be what those bots use next, and that's the owner's to give (OWNERS_KEY_LINE).
 */
export async function sharedRemove(name: string): Promise<void> {
  const n = keyName(name);
  if (!keyProvider(n)) throw new KeysError("No such key.", 404);
  const open = withKeys();
  await projectKeys(open.projectId, "DELETE", `/${encodeURIComponent(n)}`);
  for (const b of open.bots) if (b.keys.includes(n)) await sharedGrant(n, b.id, false).catch(() => null);
}

/** A key of This workspace's value, to see or copy (orgo-web limits and logs it). Never the owner's for all their workspaces. */
export async function sharedReveal(name: string, scope: "workspace" | "all"): Promise<{ name: string; value: string }> {
  const n = keyName(name);
  if (!keyProvider(n)) throw new KeysError("No such key.", 404);
  if (scope !== "workspace") throw new KeysError(OWNERS_KEY, 403);
  const open = withKeys();
  const got = await projectKeys<{ value?: unknown }>(open.projectId, "POST", "/reveal", { name: n });
  if (typeof got.value !== "string") throw new KeysError("Orgo didn't send the key. Try again.", 502);
  return { name: n, value: got.value };
}

/** The services Bops can call, as the Keys page lists them. */
export const providersShown = () => KEY_PROVIDERS.map(({ name, label, where, tip, readOnly }) => ({ name, label, where, tip, readOnly: !!readOnly }));
