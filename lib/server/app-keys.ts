import "server-only";
import { KEY_NAME } from "@/cloud/protocol";
import { appsOpen } from "@/lib/apps-access";
import { ENV_NAME, ENV_RESERVED, isAppName } from "@/lib/hosted-apps";
import { KEYS_GIVEN_LINE } from "@/lib/shared";
import { KeysError, keyName, keysProject } from "./keys";
import { sharedKeysOpen, sharedOpen } from "./shared";
import { APP_KEYS_NOT_ON_ORGO, KEYS_NOT_ON_ORGO, projectKeys } from "./shared-keys";
import { getState } from "./store";

/*
 * An app can use a key from Keys (orgo-web's bops-keys/apps, lib/deploys/key-links.ts there): an app variable that points
 * at one of the workspace's own keys (This workspace) by name, so nobody copies ANTHROPIC_API_KEY into each new app. A link
 * is for one app, or for every app in the workspace ("*": today's and every new one, with nobody acting and the owner's
 * Mac off). orgo-web fills the value in at each build from the owner's vault row for the workspace, whoever deployed it
 * (the owner's Mac, a member, a runner of any version), and builds the live Previews that use a key again when it's saved;
 * Published gets it at its next Publish.
 *
 * Only names pass through here: a link is (app, variable, key's name), and no value is sent, read, kept or logged. Who may:
 * someone with Keys (the owner, an Admin, a Member given Keys), as orgo-web decides it again with their own Orgo key; one
 * app's link also needs Your Apps at Write in a shared workspace. The owner's keys for all their workspaces are never
 * linked: orgo-web takes This workspace's only. The Orgo project is the open workspace's (keysProject, or the shared
 * copy's), never one from the request.
 *
 * An orgo-web from before links answers 405 (bops-keys/apps falls into bops-keys/{name}) or 503 APP_KEYS_UNAVAILABLE: the
 * list then says `old`, and the window hides the switches with APP_KEYS_NOT_ON_ORGO.
 */

/** One link as the window shows it: the app ("*": every app), the variable, the key, and `missing` when Keys has no such key now. */
export type AppKeyLink = { app: string; name: string; key: string; missing?: true };
/**
 * GET /api/keys/apps: the links (one app's and every app's, or all), and what the user may change here (`can.every`: a
 * link for every app; `can.app`: one app's). `old`: orgo-web can't link keys to apps yet (`said` says so).
 */
export type AppKeysAnswer = { links: AppKeyLink[]; can: { every: boolean; app: boolean }; old?: true; said?: string };

export const EVERY_APP = "*";

/** Where the open workspace's links are, and what the user may change there. Refused without Keys, or where apps aren't. */
function linksHome(): { projectId: string; can: AppKeysAnswer["can"] } {
  if (sharedOpen()) {
    const open = sharedKeysOpen();
    if (!open) throw new KeysError("Open the workspace again.", 409);
    if (!open.keys) throw new KeysError(KEYS_GIVEN_LINE, 403);
    return { projectId: open.projectId, can: { every: true, app: open.appsWrite } };
  }
  if (!appsOpen(getState())) throw new KeysError("Not found", 404);
  const projectId = keysProject();
  if (!projectId) throw new KeysError("This workspace isn't on Orgo yet, so its keys can't go to its apps.", 409);
  return { projectId, can: { every: true, app: true } };
}

/** The links as orgo-web answered them, names only: anything else it sent is dropped. */
function linksOf(v: unknown): AppKeyLink[] {
  if (!Array.isArray(v)) return [];
  const out: AppKeyLink[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const { app, name, key, missing } = x as Record<string, unknown>;
    if (typeof app !== "string" || (app !== EVERY_APP && !isAppName(app))) continue;
    if (typeof name !== "string" || !ENV_NAME.test(name) || typeof key !== "string" || !KEY_NAME.test(key)) continue;
    out.push({ app, name, key, ...(missing === true ? { missing: true as const } : {}) });
  }
  return out;
}

/** An orgo-web that can't link keys to apps yet. */
const isOld = (e: unknown) => e instanceof KeysError && e.status === 503 && (e.message === KEYS_NOT_ON_ORGO || e.message === APP_KEYS_NOT_ON_ORGO);

/** The app asked for: "*" or an app's name; anything else is refused. */
function appArg(v: unknown): string {
  if (v === EVERY_APP || isAppName(v)) return v;
  throw new KeysError("Pick an app.", 400);
}

/** The links of the open workspace: one app's and every app's (`app`), or all of them. */
export async function listAppKeys(app?: unknown): Promise<AppKeysAnswer> {
  const a = app === undefined || app === null || app === "" ? undefined : appArg(app);
  const home = linksHome();
  try {
    const got = await projectKeys<{ links?: unknown }>(home.projectId, "GET", `/apps${a ? `?app=${encodeURIComponent(a)}` : ""}`);
    return { links: linksOf(got.links), can: home.can };
  } catch (e) {
    if (isOld(e)) return { links: [], can: { every: false, app: false }, old: true, said: APP_KEYS_NOT_ON_ORGO };
    throw e;
  }
}

/**
 * Link a variable of one app, or of every app ("*"), to a key of This workspace, or take the link away (`key` null).
 * `name`: the variable (default: the key's name; for every app always the key's). Answers that app's links as listAppKeys.
 */
export async function linkAppKey(b: { app?: unknown; name?: unknown; key?: unknown }): Promise<AppKeysAnswer> {
  const app = appArg(b.app);
  const key = b.key === null ? null : typeof b.key === "string" ? keyName(b.key) : "";
  if (key !== null && !KEY_NAME.test(key)) throw new KeysError("Pick a key from Keys.", 400);
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : key;
  if (!name) throw new KeysError("Which variable?", 400);
  if (ENV_RESERVED.has(name)) throw new KeysError(`${name} is set by Orgo. Pick another name.`, 400);
  if (!ENV_NAME.test(name)) throw new KeysError("Use capital letters, digits and underscores for its name.", 400);
  if (app === EVERY_APP && key !== null && name !== key) throw new KeysError("A key for every app keeps its own name.", 400);
  const home = linksHome();
  if (app !== EVERY_APP && !home.can.app) throw new KeysError("You can link a key to an app once you have Write on Your Apps.", 403);
  try {
    const got = await projectKeys<{ links?: unknown }>(home.projectId, "PUT", "/apps", { app, var: name, key });
    return { links: linksOf(got.links), can: home.can };
  } catch (e) {
    if (isOld(e)) throw new KeysError(APP_KEYS_NOT_ON_ORGO, 503);
    throw e;
  }
}
