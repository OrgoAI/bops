import "server-only";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Composio } from "@composio/core";
import { USAGE_APP_HEADER, USAGE_BOT_HEADER } from "@/cloud/protocol";
import { appLoginKey, CHANNEL_APPS, levelIn, live as running, MAIN_WORKSPACE, openToTeam, outsideThread, workspaceOf, type AccessUse, type AppAccount, type AppConnecting, type AppLevel, type Bot } from "@/lib/types";
import { forMember, logUse, targetNameOf, viaOf, type UseWhere } from "./access-sync";
import { forgetLogin } from "./logins";
import { trackServerEvent } from "./analytics";
import { appHeaders } from "./app-version";
import { cloudOn, cloudProxy, cloudSession, cloudSessionNow, cloudUrl } from "./cloud";
import { lowRisk, movesMoney } from "./judgment";
import { allows, declined, heldAsk, NeedsOk, type AskSpec } from "./permission";
import { addMessage, bot, getState, installId, ownerName, session as threadOf, update } from "./store";
import { DATA_TOOL_NAMES, dataOn, foundByBots, runDataTool } from "./treg";

/**
 * The user's apps (Gmail, Notion, HubSpot… any of Composio's catalog) through Composio. Composio keeps
 * the OAuth tokens and API keys; Bops keeps only which accounts are connected (several per app is
 * fine: a work and a personal Gmail) and which bot may use which account, read only or read and act.
 * Bops is the only thing that holds the Composio key: bots reach apps through two tools that Bops
 * runs (find_app_actions, use_app), and anything that sends, changes, deletes or pays waits for the
 * user to say yes first. Signed in with Orgo, Composio is reached through Bops Cloud
 * (lib/server/cloud.ts), which holds the key and keeps the user to their own Composio user.
 */

/**
 * Whose connected accounts these are in Composio: on Bops Cloud the user's own (their session), else
 * COMPOSIO_USER_ID, else one id per install (so installs sharing a Composio project stay apart).
 */
function userId() {
  if (!cloudOn()) return process.env.COMPOSIO_USER_ID || `bops-${installId()}`;
  const mine = cloudSessionNow()?.composio?.userId;
  if (!mine) throw new Error("Connected apps aren't available right now.");
  return mine;
}

export const composioOn = () => (cloudOn() ? !!cloudSessionNow()?.composio : !!process.env.COMPOSIO_API_KEY);

/**
 * Bops' public address: the "connected" page after an app's sign-in, OAuth callbacks, and the bots'
 * pictures (Slack's icon_url, Telegram's and Discord's profile pictures). Signed in with Orgo, Bops
 * Cloud's (CloudSession.publicUrl: it serves /connected, /oauth/callback, /mascot/* and /brand/*);
 * self-hosted, BOPS_PUBLIC_URL (the self-hoster's front door, edge/), else api.bops.bot.
 */
export const publicUrl = () => (cloudOn() ? (cloudSessionNow()?.publicUrl ?? cloudUrl()) : process.env.BOPS_PUBLIC_URL || "https://api.bops.bot").replace(/\/+$/, "");

/** An action: its tags (readOnlyHint…), name, app and input schema (withConsts). */
type ToolInfo = { tags: string[]; name: string; app?: string; input?: Schema };
/** How Composio is reached: through Bops Cloud (signed in with Orgo) or directly (self-hosted). The catalog differs. */
type Via = "cloud" | "direct";
type Live = {
  client?: Composio;
  /** The key the client was made with: another sign-in makes a new one (and new bot sessions). */
  clientKey?: string;
  sessions: Map<string, { access: string; session: Awaited<ReturnType<Composio["sessions"]["use"]>> }>;
  /** Clients that tell Bops Cloud which bot and app a run is for (cxFor), by key, bot and app. */
  tagged?: Map<string, Composio>;
  tools: Map<string, ToolInfo>;
  catalog?: { at: number; v: number; via: Via; apps: CatalogApp[] };
  loadingCatalog?: { via: Via; apps: Promise<CatalogApp[]> };
};
const g = globalThis as unknown as { bopsComposio2?: Live };
const live: Live = (g.bopsComposio2 ??= { sessions: new Map(), tools: new Map() });

/**
 * Composio on the key in use. Through Bops Cloud the user's Orgo key goes as a Bearer token (how the
 * cloud knows who it is) and as the SDK's key, which the cloud swaps for its own; the SDK's own
 * usage reports stay off, since this Mac reaches Composio only through the cloud.
 */
function cx() {
  const via = cloudProxy("composio");
  const key = via ? via.key : (process.env.COMPOSIO_API_KEY ?? "");
  if (live.client && live.clientKey === key) return live.client;
  live.sessions.clear();
  live.tagged?.clear();
  live.client = via
    ? new Composio({ apiKey: via.key, baseURL: via.url, defaultHeaders: { Authorization: `Bearer ${via.key}`, ...appHeaders() }, allowTracking: false })
    : new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  live.clientKey = key;
  return live.client;
}

/**
 * Composio for one bot and one app (either may be unknown). Through Bops Cloud, the client says which
 * bot and app it's for (x-bops-bot, x-bops-app) so the cloud counts each run for them, and a session
 * it makes is that bot's; directly, the shared client.
 */
function cxFor(botId?: string, app?: string) {
  const via = cloudProxy("composio");
  if (!via || (!botId && !app)) return cx();
  const k = `${via.key}\n${botId ?? ""}\n${app ?? ""}`;
  live.tagged ??= new Map();
  let c = live.tagged.get(k);
  if (!c) {
    if (live.tagged.size > 200) live.tagged.clear();
    const tags = { ...(botId ? { [USAGE_BOT_HEADER]: botId } : {}), ...(app ? { [USAGE_APP_HEADER]: app } : {}) };
    c = new Composio({ apiKey: via.key, baseURL: via.url, defaultHeaders: { Authorization: `Bearer ${via.key}`, ...tags, ...appHeaders() }, allowTracking: false });
    live.tagged.set(k, c);
  }
  return c;
}

/* ---------------- The catalog ---------------- */

/** One app the user can connect, as the app picker shows it. */
export type CatalogApp = { app: string; name: string; about?: string; tags: string[]; auth: "oauth" | "key" | "open"; tools?: number };

/** Composio's own toolkits, not apps a business uses (bots have their computers for code and search). */
const NOT_APPS = new Set(["composio", "composio_search", "codeinterpreter"]);

/** An app's first sentence, cut at a word if it's long. */
const short = (s?: string) => {
  const first = s?.split(/(?<=[.!?])\s/)[0]?.trim();
  return !first || first.length <= 110 ? first : `${first.slice(0, 108).replace(/[\s,;:]+\S*$/, "")}…`;
};

/** Bump when a catalog entry's shape or what the catalog holds changes, so a running server fetches it again. */
const CATALOG_V = 4;

/**
 * An auth scheme where each person signs in with their own key or password, never through an OAuth
 * app: the only kind of sign-in setup Bops Cloud makes for an app Composio doesn't sign people in to
 * itself (OWN_KEY_SCHEME in cloud/proxy.ts). Not SAML: its setup needs the company's own keys first.
 */
const ownKeyScheme = (scheme: string) => scheme !== "NO_AUTH" && scheme !== "SAML" && /^(?!.*OAUTH)[A-Z][A-Z0-9_]{1,40}$/.test(scheme);

/**
 * Every toolkit Composio has, most used first. A page holds at most 1000 and Composio has more, so
 * it's read page by page (the SDK's toolkits.get stops at the first page and drops its cursor).
 */
async function everyToolkit() {
  const page = (cursor?: string) => cx().getClient().toolkits.list({ sort_by: "usage", limit: 1000, ...(cursor ? { cursor } : {}) });
  const all: Awaited<ReturnType<typeof page>>["items"] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 10; n++) {
    const r = await page(cursor);
    all.push(...r.items);
    cursor = r.next_cursor ?? undefined;
    if (!cursor || !r.items.length) break;
  }
  return all;
}

/**
 * The apps with a sign-in setup this Mac may use through Bops Cloud: its GET auth_configs lists only
 * those (Composio's own, Orgo's pinned ones such as its Slack app's, and ones made through the cloud).
 */
async function cloudSetups() {
  const apps = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await cx().authConfigs.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const a of r.items) if (a.status === "ENABLED") apps.add(a.toolkit.slug);
    cursor = r.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return apps;
}

/**
 * Every app the user can connect, most used first. Fetched at most twice a day. Self-hosted, all of
 * Composio's. Signed in with Orgo, only the ones that can connect through Bops Cloud: no sign-in
 * needed, Composio signs people in itself, a setup the cloud offers (Orgo's own OAuth apps), or each
 * person types their own key. The rest would only be turned away at the cloud, so they aren't offered.
 */
export async function catalog(): Promise<CatalogApp[]> {
  if (cloudOn()) await cloudSession().catch(() => null);
  if (!composioOn()) return [];
  const via: Via = cloudOn() ? "cloud" : "direct";
  const have = live.catalog?.v === CATALOG_V && live.catalog.via === via ? live.catalog : undefined;
  if (have && Date.now() - have.at < 12 * 3600_000) return have.apps;
  if (live.loadingCatalog?.via !== via) {
    const apps = (async () => {
      const [all, setups] = await Promise.all([everyToolkit(), via === "cloud" ? cloudSetups() : null]);
      const out: CatalogApp[] = [];
      // Usage can reorder the list between pages: an app seen on an earlier page is listed once.
      const seen = new Set<string>();
      for (const t of all) {
        if (t.is_local_toolkit || NOT_APPS.has(t.slug) || seen.has(t.slug)) continue;
        seen.add(t.slug);
        const schemes = t.auth_schemes ?? [];
        let auth: CatalogApp["auth"] = t.no_auth ? "open" : schemes.some((a) => /OAUTH/.test(a)) ? "oauth" : "key";
        // Through the cloud, an app nobody signs people in to (Composio, or Orgo's own setup) connects only with each person's own key.
        if (setups && auth !== "open" && !t.composio_managed_auth_schemes?.length && !setups.has(t.slug)) {
          if (!schemes.some(ownKeyScheme)) continue;
          auth = "key";
        }
        out.push({ app: t.slug, name: t.name, about: short(t.meta.description), tags: (t.meta.categories ?? []).slice(0, 2).map((c) => c.name), auth, tools: t.meta.tools_count });
      }
      if (cloudOn() === (via === "cloud")) live.catalog = { at: Date.now(), v: CATALOG_V, via, apps: out };
      return out;
    })();
    live.loadingCatalog = { via, apps };
    void apps
      .finally(() => {
        if (live.loadingCatalog?.apps === apps) live.loadingCatalog = undefined;
      })
      .catch(() => {});
  }
  return have?.apps ?? live.loadingCatalog!.apps;
}

const appNameOf = async (app: string) => (await catalog().catch(() => [])).find((a) => a.app === app)?.name ?? app;

/* ---------------- Connecting accounts ---------------- */

/**
 * The project's sign-in setup for an app: Composio's own (most apps), else one that asks the user for
 * their key. Through Bops Cloud the cloud lists only the setups a Mac may use and makes only these two
 * kinds (cloud/proxy.ts signInSetupWithoutSecrets): an app that signs in with OAuth but has no sign-in
 * of Composio's connects once Orgo has set one up in its project.
 */
async function authConfigFor(app: string) {
  const { items } = await cx().authConfigs.list({ toolkit: app });
  // Our own app (Bops' OAuth app for Slack, Google…: the consent screen says Bops) wins over Composio's.
  const ready = items.filter((a) => a.status === "ENABLED").sort((a, b) => Number(!!a.isComposioManaged) - Number(!!b.isComposioManaged))[0];
  if (ready) return ready.id;
  const tk = await cx().toolkits.get(app);
  if (tk.composioManagedAuthSchemes?.length) return (await cx().authConfigs.create(app, { type: "use_composio_managed_auth", name: `${tk.name} (Bops)` })).id;
  // Through Bops Cloud, a setup of our own can only ask each person for their own key (see ownKeyScheme).
  const mode = cloudOn() ? tk.authConfigDetails?.find((d) => ownKeyScheme(d.mode))?.mode : tk.authConfigDetails?.[0]?.mode;
  if (!mode) throw new Error(`${tk.name} can't be connected from Bops yet`);
  return (await cx().authConfigs.create(app, { type: "use_custom_auth", authScheme: mode as never, name: `${tk.name} (Bops)`, credentials: {} })).id;
}

/**
 * Connect an account: Composio's sign-in page opens in the user's browser (it asks for an API key
 * where the app has no sign-in), and the account appears here once they finish. Another account in
 * the same app is fine. `replaces` signs an expired account back in: the bots keep their access.
 */
export async function connectApp(app: string, label?: string, replaces?: string, picked?: AppConnecting["grant"]) {
  if (!composioOn()) throw new Error(cloudOn() ? "Connected apps aren't available right now." : "Add COMPOSIO_API_KEY to .env.local first");
  // Connected in the workspace open now (ui.tsx currentWorkspace): its bots have it by default, and the
  // bots were picked from its team, so its other bots get no access.
  const state = getState();
  const ws = picked?.workspaceId ?? state.workspace ?? state.workspaces?.[0]?.id ?? MAIN_WORKSPACE;
  const grant = picked && { ...picked, workspaceId: ws };
  const info = (await catalog()).find((a) => a.app === app);
  const appName = info?.name ?? (await appNameOf(app));
  const who = getState().account?.user.id;
  if (info?.auth === "open") {
    const accountId = `open:${app}`;
    const isNew = !getState().accounts?.some((a) => a.id === accountId);
    update((s) => {
      if (!s.accounts?.some((a) => a.id === accountId)) (s.accounts ??= []).push({ id: accountId, app, appName, status: "active", at: Date.now(), workspaceId: ws });
      give(s, accountId, grant);
    });
    if (isNew) trackServerEvent("bops_app_connected", { toolkit: app, reconnect: false });
    // Its check first (How often), so the starters offered after leave out the job it does.
    await checkFor(accountId, grant);
    if (isNew) await offerStartersFor(app, grant?.bots);
    return { accountId };
  }
  // Afterwards the browser lands on Bops' own "connected" page, not Composio's (Bops Cloud's, signed in with Orgo).
  if (cloudOn()) await cloudSession();
  const callbackUrl = `${publicUrl()}/connected?app=${encodeURIComponent(appName)}`;
  const req = await cx().connectedAccounts.link(userId(), await authConfigFor(app), { allowMultiple: true, callbackUrl });
  const waitId = req.id;
  update((s) => {
    s.connecting = (s.connecting ?? []).filter((c) => !(c.app === app && c.status === "failed"));
    s.connecting.push({ id: waitId, app, appName, label: label?.trim() || undefined, status: "waiting", at: Date.now(), replaces, grant });
  });
  if (req.redirectUrl) execFile("open", [req.redirectUrl]);
  void req
    .waitForConnection(15 * 60_000)
    .then(async (ca: { id: string }) => {
      let suggestAfter: string[] | undefined;
      let checkWith: AppConnecting["grant"];
      const name = await accountName(ca.id).catch(() => undefined);
      const old = replaces ? getState().accounts?.find((a) => a.id === replaces) : undefined;
      const isNew = !getState().accounts?.some((a) => a.id === ca.id);
      update((s) => {
        const c = s.connecting?.find((x) => x.id === waitId);
        s.connecting = (s.connecting ?? []).filter((x) => x.id !== waitId);
        if (s.accounts?.some((a) => a.id === ca.id)) return;
        // Signed back in: the old one's workspace, so its bots keep the default (one from before stays only its bots').
        const workspaceId = old ? old.workspaceId : ws;
        (s.accounts ??= []).push({ id: ca.id, app, appName, name, label: c?.label ?? old?.label, status: "active", at: Date.now(), ...(workspaceId ? { workspaceId } : {}), ...(old?.onlyGiven ? { onlyGiven: true } : {}) });
        give(s, ca.id, c?.grant);
        // A new account: its bot is offered the app's starter routines, and its check is made when How often
        // was picked (signing back in isn't new). Only now: a sign-in that fails or is given up makes neither.
        if (!old) suggestAfter = c?.grant?.bots;
        if (!old) checkWith = c?.grant;
        // Signed back in: the new account takes the old one's place, with the same access and its checks.
        if (old) {
          for (const b of s.bots) if (b.access?.[old.id] !== undefined) b.access[ca.id] = b.access[old.id];
          for (const r of s.routines) if (r.source?.account === old.id) r.source.account = ca.id;
          // Bots in Slack through this account (the Bops Slack app) move with it.
          for (const l of s.channels ?? []) if (l.slack?.accountId === old.id) l.slack.accountId = ca.id;
          dropAccount(s, old.id);
        }
      });
      if (isNew) trackServerEvent("bops_app_connected", { toolkit: app, reconnect: !!old }, { userId: who });
      if (checkWith) await checkFor(ca.id, checkWith);
      if (suggestAfter) await offerStartersFor(app, suggestAfter);
      if (old) await cx().connectedAccounts.delete(old.id).catch(() => null);
    })
    .catch((e: Error) =>
      update((s) => {
        const c = s.connecting?.find((x) => x.id === waitId);
        if (c) Object.assign(c, { status: "failed", error: /timed out/i.test(e.message) ? "The sign-in wasn't finished." : e.message.slice(0, 200) });
      }),
    );
  return { redirectUrl: req.redirectUrl };
}

/**
 * A new account's bot is offered the app's starter routines (lib/server/routine-suggestions.ts), the main
 * bot first when it's one of them; a failure there never fails the connect.
 */
const offerStartersFor = (app: string, botIds?: string[]) =>
  import("./routine-suggestions")
    .then((m) => m.offerStarters(app, botIds && [...botIds].sort((x, y) => Number(!!bot(y)?.isMain) - Number(!!bot(x)?.isMain))))
    .catch((e: Error) => console.warn(`[apps] starters for ${app}: ${e.message}`));

/**
 * A new account's check, when How often was picked for it (lib/server/routine-suggestions.ts makeCheck);
 * a failure there never fails the connect.
 */
const checkFor = async (accountId: string, grant?: AppConnecting["grant"]) => {
  if (!grant?.check) return;
  const out = await import("./routine-suggestions").then((m) => m.makeCheck(accountId, grant)).catch((e: Error) => ({ error: e.message }));
  if (out.error) console.warn(`[apps] check for ${accountId}: ${out.error}`);
};

/** Stop waiting on a sign-in (or clear one that failed). */
export function cancelConnect(waitId: string) {
  update((s) => void (s.connecting = (s.connecting ?? []).filter((c) => c.id !== waitId)));
  void cx().connectedAccounts.delete(waitId).catch(() => null);
}

/**
 * Access picked while connecting, given once the account exists: Read only is kept for the bots picked
 * (Read & act is the default for the bots of the account's workspace, so nothing is kept for them), and
 * the other bots of the workspace it was picked in get none. Without a grant they all have the default.
 * An app with no sign-in from before that default (openToTeam) has none: the bots picked keep theirs.
 */
function give(s: ReturnType<typeof getState>, accountId: string, grant?: AppConnecting["grant"]) {
  if (!grant) return;
  const a = s.accounts?.find((x) => x.id === accountId);
  const shared = !!a && openToTeam(a);
  for (const b of s.bots) {
    if (grant.bots.includes(b.id)) {
      // A bot outside the account's workspace (an app with no sign-in, connected in another one first) keeps it set.
      if (grant.level === "read" || !shared || workspaceOf(b) !== workspaceOf(a)) (b.access ??= {})[accountId] = grant.level;
    } else if (shared && workspaceOf(b) === (grant.workspaceId ?? MAIN_WORKSPACE)) (b.access ??= {})[accountId] = "none";
  }
}

function dropAccount(s: ReturnType<typeof getState>, accountId: string) {
  s.accounts = (s.accounts ?? []).filter((a) => a.id !== accountId);
  for (const b of s.bots) if (b.access) delete b.access[accountId];
  // Nor is it switched on in any workspace (Used in).
  forgetLogin(s, appLoginKey(accountId));
  // Bots in Slack through it can't be there any more.
  s.channels = (s.channels ?? []).filter((l) => l.slack?.accountId !== accountId);
}

/** Disconnect an account: Composio forgets its tokens, no bot can use it any more, and its checks stop. */
export async function disconnectAccount(accountId: string) {
  if (!accountId.startsWith("open:")) await cx().connectedAccounts.delete(accountId).catch(() => null);
  update((s) => dropAccount(s, accountId));
  await import("./routine-suggestions").then((m) => m.dropChecks(accountId)).catch((e: Error) => console.warn(`[apps] checks of ${accountId}: ${e.message}`));
}

/** The user's own name for an account ("Work"); empty clears it. */
export function labelAccount(accountId: string, label: string) {
  update((s) => {
    const a = s.accounts?.find((x) => x.id === accountId);
    if (a) a.label = label.trim().slice(0, 40) || undefined;
  });
}

/** The account's own name (an email, a workspace) as Composio reports it. Only that: the rest of the record holds its tokens. */
async function accountName(accountId: string) {
  const a = (await cx().connectedAccounts.get(accountId)) as unknown as Record<string, unknown>;
  const pick = (o: unknown, ...path: string[]) => path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
  const found = [pick(a, "data", "displayName"), pick(a, "state", "val", "displayName"), pick(a, "data", "email"), pick(a, "params", "email"), pick(a, "state", "val", "email"), pick(a, "data", "workspace_name"), pick(a, "data", "team", "name")].find(
    (x) => typeof x === "string" && x,
  );
  if (found) return found as string;
  // Google's sign-in carries the address in its ID token (the middle part is plain JSON); nothing else is read from it.
  const idToken = pick(a, "data", "id_token") ?? pick(a, "params", "id_token");
  if (typeof idToken === "string" && idToken.split(".").length === 3) {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as { email?: string };
    if (claims.email) return claims.email;
  }
  return whoIs(accountId, String(pick(a, "toolkit", "slug") ?? ""));
}

/**
 * Else ask the app itself who's signed in: each app's "current user" endpoint (Composio knows it),
 * through Composio's proxy. Only a short name is kept from the answer.
 */
async function whoIs(accountId: string, app: string) {
  if (!app) return undefined;
  const tk = await cx().toolkits.get(app);
  if (!tk.getCurrentUserEndpoint) return undefined;
  const r = (await cx().tools.proxyExecute({ endpoint: tk.getCurrentUserEndpoint, method: (tk.getCurrentUserEndpointMethod ?? "GET") as "GET", connectedAccountId: accountId })) as unknown as { data?: unknown; status?: number };
  const d = (r.data ?? {}) as Record<string, unknown>;
  const at = (o: unknown, k: string) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
  const holders = [d, at(d, "data"), at(d, "user"), at(d, "profile"), at(d, "me")];
  for (const k of ["email", "emailAddress", "mail", "userPrincipalName", "login", "username", "display_name", "displayName", "name", "summary"])
    for (const h of holders) {
      const v = at(h, k);
      if (typeof v === "string" && v.trim() && v.length <= 80) return v.trim();
    }
  return undefined;
}

/** Bring Bops in line with Composio: accounts connected, signed out or removed elsewhere (the Composio dashboard, another device). */
export async function syncApps() {
  if (!composioOn()) return;
  const found = new Map<string, { app: string; status: "active" | "expired" }>();
  let cursor: string | undefined;
  do {
    const page = (await cx().connectedAccounts.list({ userIds: [userId()], limit: 100, ...(cursor ? { cursor } : {}) } as never)) as unknown as {
      items: { id: string; status: string; toolkit?: { slug: string } }[];
      nextCursor?: string | null;
    };
    for (const a of page.items) if (a.toolkit?.slug && (a.status === "ACTIVE" || a.status === "EXPIRED")) found.set(a.id, { app: a.toolkit.slug, status: a.status === "ACTIVE" ? "active" : "expired" });
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const known = new Map((getState().accounts ?? []).map((a) => [a.id, a]));
  const added: AppAccount[] = [];
  for (const [accountId, x] of found) {
    // Only working accounts come in: an old signed-out one is clutter (signing in again makes a new one).
    if (known.has(accountId) || x.status !== "active") continue;
    // Being connected right now: the sign-in finishing adds it, with its label.
    if (getState().connecting?.some((c) => c.app === x.app && c.status === "waiting")) continue;
    // Connected where this Mac didn't see who was picked for it (a Mac still on an older Bops, which Bops
    // Cloud keeps out of your state until it's updated): only the bots you give it, never every bot.
    added.push({ id: accountId, app: x.app, appName: await appNameOf(x.app), name: await accountName(accountId).catch(() => undefined), status: x.status, at: Date.now(), workspaceId: MAIN_WORKSPACE, onlyGiven: true });
  }
  // Accounts whose name wasn't known when they came in.
  const named = new Map<string, string>();
  for (const a of getState().accounts ?? []) if (!a.name && found.get(a.id)?.status === "active") {
    const n = await accountName(a.id).catch(() => undefined);
    if (n) named.set(a.id, n);
  }
  update((s) => {
    for (const a of s.accounts ?? []) if (found.has(a.id)) a.status = found.get(a.id)!.status;
    for (const a of s.accounts ?? []) if (named.has(a.id)) a.name = named.get(a.id);
    // Gone from Composio, or signed out with no bot using it (nothing to sign back in for): off the list.
    for (const a of [...(s.accounts ?? [])])
      if (!a.id.startsWith("open:") && (!found.has(a.id) || (a.status === "expired" && !a.label && !s.bots.some((b) => levelIn(s, b, a))))) dropAccount(s, a.id);
    // Two syncs at once (the Vault opening twice) find the same new accounts: add each once.
    for (const a of added) if (!s.accounts?.some((x) => x.id === a.id)) (s.accounts ??= []).push(a);
  });
}

/* ---------------- What each bot may do ---------------- */

/** How an account reads in a list: its label and its own name, else the app's name. */
export const accountTitle = (a: AppAccount) => [a.label, a.name].filter(Boolean).join(" · ") || a.appName;

/**
 * The accounts this bot may use (working ones only), each with how much it may do (levelIn: every bot's of the
 * workspace it was connected in by default, and of each one it's switched on in).
 */
export function accountsOf(b: Bot): { account: AppAccount; level: AppLevel }[] {
  const out: { account: AppAccount; level: AppLevel }[] = [];
  const s = getState();
  for (const a of s.accounts ?? []) {
    const level = levelIn(s, b, a);
    if (level && a.status === "active") out.push({ account: a, level });
  }
  return out;
}

/** By app: the bot's accounts there, and the most it may do in any of them. */
function appsOf(b: Bot) {
  const apps = new Map<string, { appName: string; level: AppLevel; accounts: { account: AppAccount; level: AppLevel }[] }>();
  for (const x of accountsOf(b)) {
    const e = apps.get(x.account.app) ?? { appName: x.account.appName, level: "read" as AppLevel, accounts: [] };
    e.accounts.push(x);
    if (x.level === "act") e.level = "act";
    apps.set(x.account.app, e);
  }
  return apps;
}

/** Connections that put bots somewhere rather than apps they use (lib/types.ts): bots aren't told about them as apps. */
export { CHANNEL_APPS };

/**
 * The bot's apps for its instructions and tools, from the accounts the user gave it (any app in the
 * catalog): "Gmail (maya@acme.com: read & act; Personal · me@x.com: read only), Notion (read only)".
 * An app with no sign-in is just its name. Not the Slack connection (CHANNEL_APPS).
 */
export function appList(b: Bot) {
  const level = (x: { level: AppLevel }) => (x.level === "read" ? "read only" : "read & act");
  return [...appsOf(b)]
    .filter(([app]) => !CHANNEL_APPS.has(app))
    .map(([, e]) =>
      e.accounts.length === 1 && e.accounts[0].account.id.startsWith("open:")
        ? e.appName
        : `${e.appName} (${e.accounts.map((x) => (accountTitle(x.account) === e.appName ? level(x) : `${accountTitle(x.account)}: ${level(x)}`)).join("; ")})`,
    )
    .join(", ");
}

/**
 * The bot's Composio session, for finding actions: only its apps, and in apps where it may only
 * read, only reading actions; never deleting ones. Remade when its access changes. No sandbox: its
 * raw requests would skip these rules.
 */
async function sessionFor(b: Bot) {
  const apps = appsOf(b);
  if (!apps.size) return null;
  const accounts = Object.fromEntries(
    [...apps].map(([app, e]) => [app, e.accounts.map((x) => x.account.id).filter((x) => !x.startsWith("open:"))] as const).filter(([, ids]) => ids.length),
  );
  const levels = Object.fromEntries([...apps].map(([app, e]) => [app, e.level]));
  const key = JSON.stringify({ levels, accounts });
  const cached = live.sessions.get(b.id);
  if (cached?.access === key) return cached.session;
  let session;
  if (b.composio?.access === key) session = await cxFor(b.id).sessions.use(b.composio.sessionId).catch(() => null);
  if (!session) {
    session = await cxFor(b.id).sessions.create(userId(), {
      toolkits: { enable: [...apps.keys()] },
      tools: Object.fromEntries([...apps].map(([app, e]) => [app, e.level === "read" ? { tags: ["readOnlyHint" as const] } : { tags: { disable: ["destructiveHint" as const] } }])),
      connectedAccounts: accounts,
      multiAccount: { enable: true, maxAccountsPerToolkit: 10 },
      manageConnections: false,
      sandbox: { enable: false },
    });
    const sessionId = session.sessionId;
    update(() => {
      const x = bot(b.id);
      if (x) x.composio = { sessionId, access: key };
    });
  }
  live.sessions.set(b.id, { access: key, session });
  return session;
}

/** A tool's behavior tags, readable name ("Send Email") and app, cached. */
async function toolInfo(slug: string) {
  const hit = live.tools.get(slug);
  if (hit) return hit;
  const t = (await cx().tools.getRawComposioToolBySlug(slug)) as unknown as { tags?: string[]; name?: string; toolkit?: { slug?: string }; inputParameters?: Schema };
  const info = { tags: t.tags ?? [], name: t.name ?? slug, app: t.toolkit?.slug, input: t.inputParameters };
  live.tools.set(slug, info);
  return info;
}

type Schema = {
  type?: string | string[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  $ref?: string;
  $defs?: Record<string, Schema>;
  definitions?: Record<string, Schema>;
};

/**
 * An action's inputs with every field its schema pins to one value (a `const`) filled in where the bot
 * left it out. Some actions list such a field as optional with a default, yet Composio picks which kind
 * of input it is by it and refuses the call without it: NOTION_APPEND_TEXT_BLOCKS takes each block's
 * `type` ("paragraph") as optional, then fails with "Unable to extract tag using discriminator 'type'".
 * Where the schema allows one of several kinds (oneOf), the kind is the only one whose required fields
 * the input has.
 */
export function withConsts(schema: Schema | undefined, value: unknown, root: Schema | undefined = schema): unknown {
  if (!schema || value === null || typeof value !== "object") return value;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() ?? "";
    return withConsts(root?.$defs?.[name] ?? root?.definitions?.[name], value, root);
  }
  if (Array.isArray(value)) return schema.items ? value.map((v) => withConsts(schema.items, v, root)) : value;
  const obj = value as Record<string, unknown>;
  const options = (schema.oneOf ?? schema.anyOf ?? []).map((o) => (o.$ref ? (root?.$defs?.[o.$ref.split("/").pop() ?? ""] ?? root?.definitions?.[o.$ref.split("/").pop() ?? ""] ?? o) : o));
  if (options.length) {
    const kinds = options.filter((o) => o.properties);
    // The one kind it names (a const it set), else the only one whose own required fields it has.
    const named = kinds.filter((o) => Object.entries(o.properties!).some(([k, p]) => p.const !== undefined && obj[k] === p.const));
    const fits = kinds.filter((o) => (o.required ?? []).every((k) => k in obj || o.properties![k]?.const !== undefined));
    const kind = named.length === 1 ? named[0] : fits.length === 1 ? fits[0] : undefined;
    return kind ? withConsts(kind, obj, root) : obj;
  }
  if (!schema.properties) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const [k, p] of Object.entries(schema.properties)) {
    if (k in out) out[k] = withConsts(p, out[k], root);
    else if (p.const !== undefined) out[k] = p.const;
  }
  return out;
}

/* ---------------- The two tools bots get ---------------- */

/** The app tools for bot `b`. `forMember`: a member's turn, where nothing that changes something runs without the owner's yes. */
export const APP_TOOLS = (b: Bot, opts: { forMember?: boolean } = {}) => {
  const list = appList(b);
  if (!list) return [];
  const owner = ownerName();
  return [
    {
      type: "function" as const,
      name: "find_app_actions",
      description: `Search the app gateway (Composio's tool router) for the actions you can take in ${owner}'s apps (${list}) for a job. It answers with each action's exact name, its inputs, how to use it and known pitfalls. Call this before use_app, and again with other words if nothing fits.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", description: "The job in plain words, e.g. \"find emails from Adi this week\"." } },
      },
      strict: false,
    },
    {
      type: "function" as const,
      name: "use_app",
      description: `Run one action in ${owner}'s apps (${list}): an exact name from find_app_actions, with its inputs. Reading runs at once. ${b.autoApprove && !opts.forMember ? `Everything else runs at once too (${owner} set you to "Just do it"), except anything that could move money: that still asks them first.` : `Anything that sends, creates, changes or pays asks ${owner} first; Bops shows them the details.`}`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action", "arguments"],
        properties: {
          action: { type: "string", description: "The exact action name from find_app_actions, e.g. GMAIL_FETCH_EMAILS." },
          arguments: { type: "object", description: "The action's inputs, as find_app_actions described them." },
          account: { type: ["string", "null"], description: "Which account, when you have more than one in that app: its label or name as listed (e.g. \"Work\" or \"maya@acme.com\"). Null when there's one." },
        },
      },
      strict: false,
    },
  ];
};

const clip = (s: string, n = 14_000) => (s.length > n ? `${s.slice(0, n)}… (cut short)` : s);

/**
 * A thread someone outside Bops started (an email, a text or a call to a bot), or a part of one (lib/types.ts
 * outsideThread): it gets no apps, like their turns in the chat (chat.ts), whatever access its bot has. A member's
 * (memberThread) does: they reach the owner's apps through the bots they may tell, and anything that changes something
 * asks the owner (forMember). Asked as each call comes.
 */
const fromOutside = (sessionId?: string) => !!sessionId && outsideThread(threadOf(sessionId), threadOf);
const NOT_FOR_OUTSIDE = () => `Not on this task: someone outside Bops asked for it, and ${ownerName()}'s apps are only for the people ${ownerName()} works with.`;

/** find_app_actions: Composio's search, cut down to what the model needs. */
export async function findAppActions(botId: string, query: string, where: { sessionId?: string } = {}) {
  if (fromOutside(where.sessionId)) return NOT_FOR_OUTSIDE();
  const b = bot(botId);
  const session = b && (await sessionFor(b));
  if (!session) return `You have no apps; ${ownerName()} can give you access in Logins.`;
  const r = (await session.search({ query })) as unknown as {
    results: { useCase: string; primaryToolSlugs: string[]; relatedToolSlugs: string[]; executionGuidance?: string; knownPitfalls?: string[] }[];
    toolSchemas?: Record<string, { description?: string; inputSchema?: unknown }>;
  };
  const slugs = new Set(r.results.flatMap((x) => [...x.primaryToolSlugs, ...x.relatedToolSlugs.slice(0, 2)]));
  return clip(
    JSON.stringify({
      matches: r.results.map((x) => ({ for: x.useCase, actions: x.primaryToolSlugs, also: x.relatedToolSlugs.slice(0, 3), how: x.executionGuidance, pitfalls: x.knownPitfalls })),
      inputs: Object.fromEntries([...slugs].filter((s) => r.toolSchemas?.[s]).map((s) => [s, { what: r.toolSchemas![s].description, input: r.toolSchemas![s].inputSchema }])),
    }),
  );
}

/** Which of the bot's accounts in an app it means: the one it named, or its only one. */
function pickAccount(b: Bot, app: string, hint?: string | null) {
  const mine = accountsOf(b).filter((x) => x.account.app === app);
  if (!mine.length) return { error: `You don't have that app; ${ownerName()} can give you access in Logins.` };
  const h = hint?.trim().toLowerCase();
  const named = h ? mine.filter((x) => [x.account.label, x.account.name, x.account.id].some((v) => v && v.toLowerCase().includes(h))) : [];
  if (named.length === 1) return named[0];
  if (mine.length === 1) return mine[0];
  return { error: `You have ${mine.length} ${mine[0].account.appName} accounts: ${mine.map((x) => `"${accountTitle(x.account)}"`).join(", ")}. Call use_app again with account set to the one you mean.` };
}

/** An account a bot just used, for the Vault (AppAccount.usedAt): at most once an hour, so the state isn't rewritten on every call. */
function markUsed(accountId: string) {
  const a = getState().accounts?.find((x) => x.id === accountId);
  if (!a || (a.usedAt && Date.now() - a.usedAt < 60 * 60_000)) return;
  update((s) => {
    const x = s.accounts?.find((y) => y.id === accountId);
    if (x) x.usedAt = Date.now();
  });
}

/**
 * use_app. Only an action Composio marks read-only (readOnlyHint) runs at once. Anything else asks the user,
 * unless the bot's rules allow it (lib/permission.ts: an Always allow they saved for this action, in this account,
 * whoever it's for; or Just do it, which still asks before what could move money or reaches someone found through
 * business data), or Jev judges it low-stakes, only the user's own and easy to undo (a draft for them, a label):
 * never by its name, so GMAIL_SEND_DRAFT, which sends, asks like any send. Asking is the engine's pause (NeedsOk,
 * lib/server/permission.ts): the run waits for the reply and does it then (`approved`), wherever it runs. Its
 * request shows who and what its inputs name (resourcesOf) and the inputs themselves, for the user to read.
 */
export async function runAppAction(
  botId: string,
  action: string,
  args: Record<string, unknown>,
  where: UseWhere,
  accountHint?: string | null,
  /** `onRead`: told of each read action that ran, with the account it ran in, its inputs and the app's whole answer (chat.ts draft_reply's targets). */
  opts: { readOnly?: boolean; approved?: boolean; onRead?: (r: { accountId: string; app: string; args: Record<string, unknown>; data: unknown }) => void } = {},
): Promise<string> {
  const b = bot(botId);
  if (!b) return "Unknown bot.";
  if (fromOutside(where.sessionId)) return NOT_FOR_OUTSIDE();
  const info = await toolInfo(action).catch(() => null);
  if (!info) return `Unknown action ${action}. Use find_app_actions to get the exact name.`;
  const app = info.app ?? accountsOf(b).find((x) => action.toUpperCase().startsWith(`${x.account.app.toUpperCase()}_`))?.account.app;
  if (!app) return `Unknown action ${action}. Use find_app_actions to get the exact name.`;
  const picked = pickAccount(b, app, accountHint);
  if ("error" in picked) return picked.error;
  const { account, level } = picked;
  const reads = info.tags.includes("readOnlyHint");
  const where_ = account.id.startsWith("open:") ? account.appName : `${account.appName} (${accountTitle(account)})`;
  // What goes to Composio, and what the request shows: the inputs with their fixed values filled in.
  const sent = withConsts(info.input, args) as Record<string, unknown>;
  // Each use, for the Vault and Orgo (access-sync.ts): which bot, which account, where, and how it ended.
  const used = (outcome: AccessUse["outcome"], approvedBy?: AccessUse["approvedBy"]) =>
    logUse({ bot: b.id, kind: "app", target: account.id, targetName: targetNameOf(account), action, ...viaOf(where), outcome, ...(approvedBy ? { approvedBy } : {}) });
  if (level === "read" && !reads) {
    used("refused");
    return `You can only read ${where_}. Ask ${ownerName()} for more access in Logins if you need it.`;
  }
  const run = async (approvedBy?: AccessUse["approvedBy"]) => {
    let res: { data?: unknown; error?: string | null; successful?: boolean };
    try {
      res = (await cxFor(b.id, app).tools.execute(action, {
        userId: userId(),
        ...(account.id.startsWith("open:") ? {} : { connectedAccountId: account.id }),
        arguments: sent,
        dangerouslySkipVersionCheck: true,
      } as never)) as unknown as typeof res;
    } catch (e) {
      used("failed", approvedBy);
      throw e;
    }
    const ok = !res.error && res.successful !== false;
    used(ok ? "ok" : "failed", approvedBy);
    if (ok) markUsed(account.id);
    if (ok && reads) opts.onRead?.({ accountId: account.id, app, args: sent, data: res.data ?? {} });
    return ok ? clip(JSON.stringify(res.data ?? {})) : `Failed: ${res.error ?? "the app said no"}`;
  };
  if (reads) return run();
  // A look for Bops itself (chat.ts BackgroundJob.sample) only reads.
  if (opts.readOnly) return `Not done: this run only reads, and ${info.name} changes something. Use a read action.`;
  // The user said yes to this very call (its run paused for it and carries on now).
  if (opts.approved) return run("user");
  const destructive = info.tags.includes("destructiveHint");
  const what = `${info.name} in ${where_}`;
  // For a member (their turn, or a thread of theirs): it asks the owner, whose app it is, every time, named as theirs.
  const asker = forMember(where);
  const ask: AskSpec = { action: what, resources: resourcesOf(sent), preview: describe(sent), kind: "app", ...(asker ? { askedFor: asker } : {}) };
  // Done without asking, and said so in the chat: what the user always allows (a rule they saved for this action); with
  // Just do it on, anything but what could move money (by what it is, or as Jev judges it) or reaches someone found
  // through business data (treg.ts); otherwise what Jev judges low-stakes and easy to undo, only touching the user's own
  // things (marking read, a label, an event only they attend): never anything that reaches someone else, deletes, or
  // costs money (strict; if it can't tell, the user is asked). None of that for a member's: those are the owner's to allow.
  const saved = !asker && allows(b, ask, { justDoIt: false });
  const just = !asker && !saved && !!b.autoApprove && allows(b, ask, { guarded: foundByBots(JSON.stringify(sent)) || surelyMoney(action, app) || (await movesMoney(what, ask.preview)) });
  const low = !asker && !saved && !b.autoApprove && !destructive && !surelyMoney(action, app) && (await lowRisk(what, ask.preview));
  if (saved || just || low) {
    const out = await run("auto");
    const chatId = where.chatId ?? (where.sessionId ? getState().sessions.find((x) => x.id === where.sessionId)?.chatId : undefined);
    const why = saved ? "you always allow it" : just ? "Just do it is on" : "low risk";
    if (chatId && !out.startsWith("Failed")) addMessage({ chatId, role: "system", text: `${b.name}: ${info.name} in ${where_} · ${why}, so didn't ask` });
    return out;
  }
  used("waiting");
  throw new NeedsOk(ask);
}

/** An input's name in snake case (toRecipients is to_recipients). */
const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
/** Inputs that name to whom or what an action goes, by name (snake case). */
const WHO =
  /^(?:(?:.+_)?(?:to|cc|bcc|recipients?|emails?|email_address(?:es)?|attendees?|invitees?|participants?|guests?|members?|users?|channels?|phones?|phone_numbers?|ids)|(?:to|recipient|mobile|whatsapp|sms|contact|destination)_numbers?|(?:user|chat|conversation|database|page|parent|board|list|calendar|project|team|channel|contact|recipient|member|participant)_id|channel_name|number|url|link|repo|repository|owner)$/;

/** The addresses `v` is made of ("ava@acme.example", "Ava <ava@acme.example>, max@acme.example"), or null when it's anything more. */
function addressesIn(v: string): string[] | null {
  if (!v.includes("@")) return null;
  const parts = v.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const addresses = parts.map((x) => x.match(/^(?:[^<>@]*<)?\s*([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+?)\s*>?$/)?.[1]);
  return parts.length && addresses.every(Boolean) ? (addresses as string[]) : null;
}

/**
 * To whom or what an action goes, as a request names it (AppApproval.resources): every recipient, channel, address
 * or place its inputs name, lowercased. Found two ways, so an input Bops doesn't know by name still counts: by its
 * name, at any depth (to, cc_emails, extra_recipients, invitees, user_ids, channel, …), and any value anywhere that is
 * only email addresses (a body or subject that mentions one reaches no one). None for an action whose inputs name no
 * one. Shown on its card for the user to read; a rule is for the action, whoever it's for (lib/permission.ts).
 */
export function resourcesOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    const x = v.trim().toLowerCase().slice(0, 200);
    if (x && !out.includes(x)) out.push(x);
  };
  const walk = (v: unknown, who: boolean) => {
    if (typeof v === "string") {
      const addresses = addressesIn(v);
      if (addresses) addresses.forEach(add);
      else if (who) add(v);
    } else if (typeof v === "number") {
      if (who) add(String(v));
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, who));
    // Someone named by an object (an attendee): its address or id; any address deeper in it counts anyway.
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, WHO.test(snake(k)) || (who && /^(email|address|id|phone|number)$/i.test(k)));
  };
  walk(args, false);
  return out;
}

/** An action's inputs for the user to check, short: who it goes to, the subject, the start of the text. */
function describe(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 400)}`)
    .join("\n")
    .slice(0, 1500);
}

/** Apps where every change is about money: payments, banking, payroll, accounting and billing. */
const MONEY_APPS = new Set(["stripe", "paypal", "square", "braintree", "adyen", "wise", "plaid", "mercury", "brex", "ramp", "coinbase", "quickbooks", "xero", "freshbooks", "zoho_books", "chargebee", "recurly", "paddle", "lemon_squeezy", "gumroad", "razorpay", "venmo", "revolut", "expensify", "gusto", "deel", "payoneer", "bill"]);
/** Actions whose name says they move money or commit to a payment. */
const MONEY = /(?:^|_)(?:PAY|PAYS|PAYMENTS?|PAYOUTS?|PAYROLL|CHARGES?|REFUNDS?|TRANSFERS?|INVOICES?|PURCHASES?|BUY|ORDERS?|CHECKOUTS?|SUBSCRIBE|SUBSCRIPTIONS?|WITHDRAW(?:AL)?S?|DEPOSITS?|DONATE|DONATIONS?|BILLS?|BILLING)(?:_|$)/;

/**
 * Whether app action `slug` in `app` could move money by what it is, whatever its inputs say: one in a payments,
 * banking or accounting app, or one whose name says so (a charge, a refund, an invoice, an order). Just do it never
 * covers these, without Jev being asked (lib/server/judgment.ts movesMoney): its inputs are the bot's own words, which
 * could talk Jev out of it.
 */
const surelyMoney = (slug: string, app: string) => MONEY_APPS.has(app.toLowerCase()) || MONEY.test(slug.toUpperCase());

/**
 * Run an action for Bops itself (not a bot's request), in one of the user's accounts: posting a bot's
 * Slack reply, listing Slack channels. Callers decide what's allowed. Counted by Bops Cloud for the
 * action's app (its slug's first word, "SLACKBOT_…" is slackbot) and the bot it's for, when it's for one.
 */
export async function runAs(accountId: string, action: string, args: Record<string, unknown>, botId?: string) {
  const res = (await cxFor(botId, action.split("_")[0].toLowerCase() || undefined).tools.execute(action, { userId: userId(), connectedAccountId: accountId, arguments: args, dangerouslySkipVersionCheck: true } as never)) as unknown as {
    data?: unknown;
    error?: string | null;
    successful?: boolean;
  };
  if (res.error || res.successful === false) throw new Error(res.error ?? `${action} failed`);
  return res.data as Record<string, unknown>;
}

/** Composio's client, for the other parts of Bops that listen to apps (Slack messages for channels.ts): for a bot and an app when they're known, so Bops Cloud counts its calls for them. */
export const composio = (botId?: string, app?: string) => cxFor(botId, app);
export const composioUser = userId;

/* ---------------- Apps inside threads ---------------- */

/** The secret a bot's threads present to /api/apps/call. Made once per bot. */
export function appsKeyFor(botId: string) {
  const b = bot(botId);
  if (!b) return "";
  if (!b.appsKey) {
    const key = randomBytes(24).toString("hex");
    update(() => (bot(botId)!.appsKey = key));
  }
  return bot(botId)!.appsKey!;
}

/**
 * Whether bot computers can reach this server at all. The Mac app's bundled server listens on
 * 127.0.0.1 only (desktop/main.cjs) unless its settings say BOPS_LISTEN_ALL=1, and then a tailnet
 * address leads nowhere: Orgo threads get no app tools rather than ones that can't connect.
 */
export const reachableFromComputers = () => !["127.0.0.1", "localhost", "::1"].includes(process.env.HOSTNAME ?? "");

/** Where a bot computer reaches Bops: this Mac on the tailnet. */
export function bopsAddress() {
  if (!reachableFromComputers()) return null;
  const cli = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"];
  for (const c of cli) {
    try {
      const ip = execFileSync(/*turbopackIgnore: true*/ c, ["ip", "-4"], { timeout: 4000 }).toString().trim().split("\n")[0];
      if (ip) return `${ip}:${process.env.PORT ?? 3210}`;
    } catch {}
  }
  return null;
}

/** A thread's app call (from screen_mcp.py on a bot computer: a thread its brain runs). It waits for the user when asked (held). */
export async function appCall(sessionId: string, key: string, tool: string, args: Record<string, unknown>) {
  const s = threadOf(sessionId);
  const b = s && bot(s.botId);
  const want = b?.appsKey ? Buffer.from(b.appsKey) : null;
  // Only a thread that's running calls its apps: a finished one's id (seen in a process list) opens nothing.
  if (!s || !running(s) || !b || !want || want.length !== Buffer.byteLength(key) || !timingSafeEqual(want, Buffer.from(key))) return { status: 403, text: "not allowed" };
  // Signing in on one of its computer's screens from the vault (the screen tools' sign_in_from_vault).
  if (tool === "vault_sign_in") return { status: 200, text: await (await import("./vault")).vaultSignIn(b.id, Number(args.display), sessionId) };
  // A thread its brain runs asking the user before a tool it may not use by itself (the screen tools' approve: cli-agents.ts).
  if (tool === "approve") return { status: 200, text: await (await import("./cli-agents")).approveTool(b.id, sessionId, args) };
  return threadApps(b.id, sessionId, tool, args);
}

async function threadApps(botId: string, sessionId: string, tool: string, args: Record<string, unknown>) {
  // Business data (treg.ts), when the bot has it.
  if (DATA_TOOL_NAMES.has(tool)) {
    const b = bot(botId);
    return b && dataOn(b) ? { status: 200, text: await held(botId, sessionId, (approved) => runDataTool(botId, tool, args, { sessionId }, { approved })) } : { status: 403, text: "You don't have business data." };
  }
  if (tool === "find_app_actions") return { status: 200, text: await findAppActions(botId, String(args.query ?? ""), { sessionId }) };
  if (tool === "use_app")
    return {
      status: 200,
      text: await held(botId, sessionId, (approved) => runAppAction(botId, String(args.action ?? ""), (args.arguments as Record<string, unknown>) ?? {}, { sessionId }, (args.account as string | null) ?? null, { approved })),
    };
  return { status: 404, text: `unknown tool ${tool}` };
}

/** How long a call through the screen tools waits for the user's reply (screen_mcp.py waits 20 minutes for Bops). */
export const HELD_ASK_MS = 19 * 60_000;

/**
 * A call through the screen tools (a thread its brain runs: Claude Code holds the call until Bops answers) that
 * needs the user's OK: it can't pause, so it waits for the reply (permission.ts heldAsk), HELD_ASK_MS at most or
 * while its thread runs, and is done on a yes. Every engine Bops runs itself pauses instead (askFor).
 */
async function held(botId: string, sessionId: string, work: (approved: boolean) => Promise<string>): Promise<string> {
  try {
    return await work(false);
  } catch (e) {
    if (!(e instanceof NeedsOk)) throw e;
    const answer = await heldAsk(e.ask, { botId, threadId: sessionId }, { ms: HELD_ASK_MS, alive: () => !!threadOf(sessionId) && running(threadOf(sessionId)!) });
    if (answer === "late") return `${ownerName()} didn't answer in time, so it wasn't done. Don't do it another way: say in your answer what you needed.`;
    if (answer === "gone") return "This task was stopped.";
    return answer.reply === "reject" ? declined({ reply: answer }) : work(true);
  }
}
