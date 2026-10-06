import "server-only";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Composio } from "@composio/core";
import { live as running, type AppAccount, type AppApproval, type AppConnecting, type AppLevel, type Bot } from "@/lib/types";
import { cloudOn, cloudProxy, cloudSession, cloudSessionNow, cloudUrl } from "./cloud";
import { lowRisk } from "./judgment";
import { addMessage, bot, getState, id, installId, ownerName, session as threadOf, update } from "./store";

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

type ToolInfo = { tags: string[]; name: string; app?: string };
/** How Composio is reached: through Bops Cloud (signed in with Orgo) or directly (self-hosted). The catalog differs. */
type Via = "cloud" | "direct";
type Live = {
  client?: Composio;
  /** The key the client was made with: another sign-in makes a new one (and new bot sessions). */
  clientKey?: string;
  sessions: Map<string, { access: string; session: Awaited<ReturnType<Composio["sessions"]["use"]>> }>;
  tools: Map<string, ToolInfo>;
  waiting: Map<string, (yes: boolean) => void>;
  catalog?: { at: number; v: number; via: Via; apps: CatalogApp[] };
  loadingCatalog?: { via: Via; apps: Promise<CatalogApp[]> };
};
const g = globalThis as unknown as { bopsComposio2?: Live };
const live: Live = (g.bopsComposio2 ??= { sessions: new Map(), tools: new Map(), waiting: new Map() });

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
  live.client = via
    ? new Composio({ apiKey: via.key, baseURL: via.url, defaultHeaders: { Authorization: `Bearer ${via.key}` }, allowTracking: false })
    : new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  live.clientKey = key;
  return live.client;
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

/** Bump when a catalog entry's shape changes, so a running server fetches it again. */
const CATALOG_V = 3;

/**
 * An auth scheme where each person signs in with their own key or password, never through an OAuth
 * app: the only kind of sign-in setup Bops Cloud makes for an app Composio doesn't sign people in to
 * itself (OWN_KEY_SCHEME in cloud/proxy.ts).
 */
const ownKeyScheme = (scheme: string) => scheme !== "NO_AUTH" && /^(?!.*OAUTH)[A-Z][A-Z0-9_]{1,40}$/.test(scheme);

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
      const [all, setups] = await Promise.all([cx().toolkits.get({ sortBy: "usage", limit: 1000 }), via === "cloud" ? cloudSetups() : null]);
      const out: CatalogApp[] = [];
      for (const t of all) {
        if (t.isLocalToolkit || NOT_APPS.has(t.slug)) continue;
        let auth: CatalogApp["auth"] = t.noAuth ? "open" : (t.authSchemes ?? []).some((a) => /OAUTH/.test(a)) ? "oauth" : "key";
        // Through the cloud, an app nobody signs people in to (Composio, or Orgo's own setup) connects only with each person's own key.
        if (setups && auth !== "open" && !t.composioManagedAuthSchemes?.length && !setups.has(t.slug)) {
          if (!(t.authSchemes ?? []).some(ownKeyScheme)) continue;
          auth = "key";
        }
        out.push({ app: t.slug, name: t.name, about: short(t.meta.description), tags: (t.meta.categories ?? []).slice(0, 2).map((c) => c.name), auth, tools: t.meta.toolsCount });
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
export async function connectApp(app: string, label?: string, replaces?: string, grant?: AppConnecting["grant"]) {
  if (!composioOn()) throw new Error(cloudOn() ? "Connected apps aren't available right now." : "Add COMPOSIO_API_KEY to .env.local first");
  const info = (await catalog()).find((a) => a.app === app);
  const appName = info?.name ?? (await appNameOf(app));
  if (info?.auth === "open") {
    const accountId = `open:${app}`;
    update((s) => {
      if (!s.accounts?.some((a) => a.id === accountId)) (s.accounts ??= []).push({ id: accountId, app, appName, status: "active", at: Date.now() });
      give(s, accountId, grant);
    });
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
      const name = await accountName(ca.id).catch(() => undefined);
      const old = replaces ? getState().accounts?.find((a) => a.id === replaces) : undefined;
      update((s) => {
        const c = s.connecting?.find((x) => x.id === waitId);
        s.connecting = (s.connecting ?? []).filter((x) => x.id !== waitId);
        if (s.accounts?.some((a) => a.id === ca.id)) return;
        (s.accounts ??= []).push({ id: ca.id, app, appName, name, label: c?.label ?? old?.label, status: "active", at: Date.now() });
        give(s, ca.id, c?.grant);
        // Signed back in: the new account takes the old one's place, with the same access.
        if (old) {
          for (const b of s.bots) if (b.access?.[old.id]) b.access[ca.id] = b.access[old.id];
          // Bots in Slack through this account (the Bops Slack app) move with it.
          for (const l of s.channels ?? []) if (l.slack?.accountId === old.id) l.slack.accountId = ca.id;
          dropAccount(s, old.id);
        }
      });
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

/** Stop waiting on a sign-in (or clear one that failed). */
export function cancelConnect(waitId: string) {
  update((s) => void (s.connecting = (s.connecting ?? []).filter((c) => c.id !== waitId)));
  void cx().connectedAccounts.delete(waitId).catch(() => null);
}

/** Access picked while connecting, given once the account exists. */
function give(s: ReturnType<typeof getState>, accountId: string, grant?: AppConnecting["grant"]) {
  for (const b of s.bots) if (grant?.bots.includes(b.id)) (b.access ??= {})[accountId] = grant.level;
}

function dropAccount(s: ReturnType<typeof getState>, accountId: string) {
  s.accounts = (s.accounts ?? []).filter((a) => a.id !== accountId);
  for (const b of s.bots) if (b.access) delete b.access[accountId];
  // Bots in Slack through it can't be there any more.
  s.channels = (s.channels ?? []).filter((l) => l.slack?.accountId !== accountId);
}

/** Disconnect an account: Composio forgets its tokens, and no bot can use it any more. */
export async function disconnectAccount(accountId: string) {
  if (!accountId.startsWith("open:")) await cx().connectedAccounts.delete(accountId).catch(() => null);
  update((s) => dropAccount(s, accountId));
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
    added.push({ id: accountId, app: x.app, appName: await appNameOf(x.app), name: await accountName(accountId).catch(() => undefined), status: x.status, at: Date.now() });
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
      if (!a.id.startsWith("open:") && (!found.has(a.id) || (a.status === "expired" && !a.label && !s.bots.some((b) => b.access?.[a.id])))) dropAccount(s, a.id);
    // Two syncs at once (the Vault opening twice) find the same new accounts: add each once.
    for (const a of added) if (!s.accounts?.some((x) => x.id === a.id)) (s.accounts ??= []).push(a);
  });
}

/* ---------------- What each bot may do ---------------- */

/** How an account reads in a list: its label and its own name, else the app's name. */
export const accountTitle = (a: AppAccount) => [a.label, a.name].filter(Boolean).join(" · ") || a.appName;

/** The accounts this bot may use (working ones only), each with how much it may do. */
export function accountsOf(b: Bot): { account: AppAccount; level: AppLevel }[] {
  const out: { account: AppAccount; level: AppLevel }[] = [];
  for (const a of getState().accounts ?? []) {
    const level = b.access?.[a.id];
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

/**
 * Connections that put bots somewhere rather than apps they use: Bops' Slack app ("slackbot"), how
 * bots get into Slack (channels.ts). Bots aren't told about them as apps.
 */
export const CHANNEL_APPS = new Set(["slackbot"]);

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
  if (b.composio?.access === key) session = await cx().sessions.use(b.composio.sessionId).catch(() => null);
  if (!session) {
    session = await cx().sessions.create(userId(), {
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
  const t = (await cx().tools.getRawComposioToolBySlug(slug)) as unknown as { tags?: string[]; name?: string; toolkit?: { slug?: string } };
  const info = { tags: t.tags ?? [], name: t.name ?? slug, app: t.toolkit?.slug };
  live.tools.set(slug, info);
  return info;
}

/* ---------------- The two tools bots get ---------------- */

export const APP_TOOLS = (b: Bot) => {
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
      description: `Run one action in ${owner}'s apps (${list}): an exact name from find_app_actions, with its inputs. Reading runs at once. Anything that sends, creates, changes or pays asks ${owner} first; Bops shows them the details.`,
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

/** find_app_actions: Composio's search, cut down to what the model needs. */
export async function findAppActions(botId: string, query: string) {
  const b = bot(botId);
  const session = b && (await sessionFor(b));
  if (!session) return `You have no apps; ${ownerName()} can give you access in the Vault.`;
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
  if (!mine.length) return { error: `You don't have that app; ${ownerName()} can give you access in the Vault.` };
  const h = hint?.trim().toLowerCase();
  const named = h ? mine.filter((x) => [x.account.label, x.account.name, x.account.id].some((v) => v && v.toLowerCase().includes(h))) : [];
  if (named.length === 1) return named[0];
  if (mine.length === 1) return mine[0];
  return { error: `You have ${mine.length} ${mine[0].account.appName} accounts: ${mine.map((x) => `"${accountTitle(x.account)}"`).join(", ")}. Call use_app again with account set to the one you mean.` };
}

/**
 * use_app. Only an action Composio marks read-only (readOnlyHint) runs at once. Anything else waits
 * for the user, unless Jev judges it low-stakes, only the user's own and easy to undo (a draft for
 * them, a label): never by its name, so GMAIL_SEND_DRAFT, which sends, asks like any send. `onAsk`
 * lets a chat turn go on while the user decides; a thread just waits.
 */
export async function runAppAction(
  botId: string,
  action: string,
  args: Record<string, unknown>,
  where: { chatId?: string; sessionId?: string },
  onAsk?: (ask: Promise<string>) => void,
  accountHint?: string | null,
): Promise<string> {
  const b = bot(botId);
  if (!b) return "Unknown bot.";
  const info = await toolInfo(action).catch(() => null);
  if (!info) return `Unknown action ${action}. Use find_app_actions to get the exact name.`;
  const app = info.app ?? accountsOf(b).find((x) => action.toUpperCase().startsWith(`${x.account.app.toUpperCase()}_`))?.account.app;
  if (!app) return `Unknown action ${action}. Use find_app_actions to get the exact name.`;
  const picked = pickAccount(b, app, accountHint);
  if ("error" in picked) return picked.error;
  const { account, level } = picked;
  const reads = info.tags.includes("readOnlyHint");
  const where_ = account.id.startsWith("open:") ? account.appName : `${account.appName} (${accountTitle(account)})`;
  if (level === "read" && !reads) return `You can only read ${where_}. Ask ${ownerName()} for more access in the Vault if you need it.`;
  const run = async () => {
    const res = (await cx().tools.execute(action, {
      userId: userId(),
      ...(account.id.startsWith("open:") ? {} : { connectedAccountId: account.id }),
      arguments: args,
      dangerouslySkipVersionCheck: true,
    } as never)) as unknown as { data?: unknown; error?: string | null; successful?: boolean };
    return res.error || res.successful === false ? `Failed: ${res.error ?? "the app said no"}` : clip(JSON.stringify(res.data ?? {}));
  };
  if (reads) return run();
  const destructive = info.tags.includes("destructiveHint");
  // Low-stakes and easy to undo, only touching the user's own things (marking read, a label, an event
  // only they attend): done without asking, and said so in the chat. Never anything that reaches
  // someone else, deletes, or costs money (Jev, strict; if it can't tell, the user is asked).
  if (!destructive && (await lowRisk(`${info.name} in ${where_}`, describe(args)))) {
    const out = await run();
    const chatId = where.chatId ?? (where.sessionId ? getState().sessions.find((x) => x.id === where.sessionId)?.chatId : undefined);
    if (chatId && !out.startsWith("Failed")) addMessage({ chatId, role: "system", text: `${b.name}: ${info.name} in ${where_} · low risk, so didn't ask` });
    return out;
  }

  const ask = askOwner({ botId, app, action, title: `${info.name} in ${where_}`, detail: describe(args), ...where }).then(async (yes) => {
    if (!yes) return `Not approved: ${ownerName()} said no. Don't do it.`;
    return run();
  });
  if (onAsk) {
    onAsk(ask);
    return `This needs ${ownerName()}'s approval first: ${info.name} in ${where_}. Bops is showing them the details. Tell them in one short line, and don't call it again.`;
  }
  return ask;
}

/** The action's inputs for the user to check, short: who it goes to, the subject, the start of the text. */
function describe(args: Record<string, unknown>) {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 400)}`)
    .join("\n")
    .slice(0, 1500);
}

/**
 * Run an action for Bops itself (not a bot's request), in one of the user's accounts: posting a bot's
 * Slack reply, listing Slack channels. Callers decide what's allowed.
 */
export async function runAs(accountId: string, action: string, args: Record<string, unknown>) {
  const res = (await cx().tools.execute(action, { userId: userId(), connectedAccountId: accountId, arguments: args, dangerouslySkipVersionCheck: true } as never)) as unknown as {
    data?: unknown;
    error?: string | null;
    successful?: boolean;
  };
  if (res.error || res.successful === false) throw new Error(res.error ?? `${action} failed`);
  return res.data as Record<string, unknown>;
}

/** Composio's client, for the other parts of Bops that listen to apps (Slack messages for channels.ts). */
export const composio = cx;
export const composioUser = userId;

/* ---------------- Asking the user ---------------- */

export function askOwner(a: Omit<AppApproval, "id" | "at">) {
  const approval: AppApproval = { ...a, id: id("apr"), at: Date.now() };
  update((s) => (s.appApprovals ??= []).push(approval));
  return new Promise<boolean>((resolve) => live.waiting.set(approval.id, resolve));
}

/** The user's answer to an app approval. */
export function answerApp(approvalId: string, yes: boolean) {
  update((s) => {
    s.appApprovals = (s.appApprovals ?? []).filter((x) => x.id !== approvalId);
  });
  live.waiting.get(approvalId)?.(yes);
  live.waiting.delete(approvalId);
}

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
      const ip = execFileSync(c, ["ip", "-4"], { timeout: 4000 }).toString().trim().split("\n")[0];
      if (ip) return `${ip}:${process.env.PORT ?? 3210}`;
    } catch {}
  }
  return null;
}

/** A thread's app call (from screen_mcp.py on a bot computer, or apps-mcp on the Mac). It waits for the user when asked. */
export async function appCall(sessionId: string, key: string, tool: string, args: Record<string, unknown>) {
  const s = threadOf(sessionId);
  const b = s && bot(s.botId);
  const want = b?.appsKey ? Buffer.from(b.appsKey) : null;
  // Only a thread that's running calls its apps: a finished one's id (seen in a process list) opens nothing.
  if (!s || !running(s) || !b || !want || want.length !== Buffer.byteLength(key) || !timingSafeEqual(want, Buffer.from(key))) return { status: 403, text: "not allowed" };
  if (tool === "find_app_actions") return { status: 200, text: await findAppActions(b.id, String(args.query ?? "")) };
  if (tool === "use_app")
    return { status: 200, text: await runAppAction(b.id, String(args.action ?? ""), (args.arguments as Record<string, unknown>) ?? {}, { sessionId }, undefined, (args.account as string | null) ?? null) };
  return { status: 404, text: `unknown tool ${tool}` };
}
