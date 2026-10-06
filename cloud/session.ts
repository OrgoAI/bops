import type { CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { welcome } from "./credit.ts";
import { open, seal } from "./crypto.ts";
import { ensureUserRow, query, tx } from "./db.ts";
import { HttpError, sendJson, type Route } from "./http.ts";
import type { CloudSession } from "./protocol.ts";
import { verifyChannels } from "./verify.ts";

/**
 * POST /v1/session: set a user up on first contact (their AgentMail pod and pod key, their AgentPhone
 * sub-account) and answer a CloudSession (protocol.ts). Safe to call at every app
 * start: what was made is kept in bops.cloud_accounts and handed back, and the account row is locked
 * while it's being made, so two calls at once never make two of anything. A new user's first session
 * gives them Free's one-time AI credit (credit.ts), if the gate hasn't already.
 */

export type CloudAccount = {
  userId: string;
  email: string | null;
  agentmailPodId: string | null;
  agentphoneSubAccount: string | null;
};

/** The user's cloud account row, or null before their first /v1/session. */
export async function accountFor(userId: string): Promise<CloudAccount | null> {
  const r = await query<AccountRow>("SELECT user_id, email, agentmail_pod_id, agentphone_sub_account FROM bops.cloud_accounts WHERE user_id = $1", [userId]);
  const row = r.rows[0];
  return row ? { userId: row.user_id, email: row.email, agentmailPodId: row.agentmail_pod_id, agentphoneSubAccount: row.agentphone_sub_account } : null;
}

/** The user's Composio user id: every Composio call through the cloud acts as this user only. */
export const composioUserId = (userId: string) => `bops-${userId}`;

/**
 * The start of every Honcho workspace id this user may touch: "u-" and their user id. Honcho ids
 * allow letters, digits, "-" and "_", so anything else in the user id is written as "_" and its
 * UTF-8 bytes in hex ("a.b" → "a_2eb", "_" → "_5f", "-" → "_2d"). That keeps two users' prefixes
 * from ever being the same, and keeps "-" out of the prefix, so "<prefix>-…" can only be this user's.
 */
export function honchoPrefix(userId: string) {
  let id = "";
  for (const ch of userId) id += /^[A-Za-z0-9]$/.test(ch) ? ch : [...Buffer.from(ch, "utf8")].map((b) => `_${b.toString(16).padStart(2, "0")}`).join("");
  return `u-${id}`;
}

/** Whether a Honcho workspace id is this user's: the prefix itself, or the prefix, "-" and anything. */
export function ownsWorkspace(userId: string, workspaceId: string) {
  const prefix = honchoPrefix(userId);
  return workspaceId === prefix || workspaceId.startsWith(`${prefix}-`);
}

type AccountRow = {
  user_id: string;
  email: string | null;
  agentmail_pod_id: string | null;
  agentmail_key_sealed: string | null;
  agentphone_sub_account: string | null;
};

/** A provider call during setup that didn't work: which provider and how it answered (0: unreachable). */
class ProviderError extends Error {
  status: number;
  constructor(provider: string, status: number, what: string) {
    super(`${provider} ${status ? `answered ${status}` : "couldn't be reached"} for ${what}`);
    this.status = status;
  }
}

/** One JSON call to a provider with the cloud's own key. Keys and bodies are never logged, only the method, path and status. */
async function callProvider<T>(provider: string, url: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<T> {
  const what = `${method} ${new URL(url).pathname}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ProviderError(provider, 0, what);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(provider, res.status, what);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new ProviderError(provider, res.status, `${what} (not JSON)`);
  }
}

/* ---------------- AgentMail: a pod per user, and one key that reaches only that pod ---------------- */

const agentmail = <T>(path: string, method?: string, body?: unknown) =>
  callProvider<T>("AgentMail", `${config.upstream.agentmail()}${path}`, { authorization: `Bearer ${config.agentmailKey()}` }, method, body);

type Pod = { pod_id?: string; client_id?: string | null };

/**
 * What the Mac's pod key may do: everything the app does with mail in its own pod (inboxes, reading
 * and sending, drafts, labels), and nothing that reaches past the mail itself (no more keys, pods,
 * domains, webhooks, apps or account changes).
 */
const POD_KEY_PERMISSIONS = Object.fromEntries(
  [
    "inbox_read", "inbox_create", "inbox_update", "inbox_delete",
    "message_read", "message_send", "message_update", "message_delete",
    "label_spam_read", "label_blocked_read", "label_unauthenticated_read", "label_trash_read",
    "draft_read", "draft_create", "draft_update", "draft_delete", "draft_send",
    "domain_read", "pod_read",
  ].map((p) => [p, true]),
);

/** The user's pod, found by its client id `bops-<userId>` or made with it (the same way lib/server/mail.ts does it). */
async function findOrMakePod(userId: string): Promise<string> {
  const clientId = `bops-${userId}`;
  try {
    const made = await agentmail<Pod>("/v0/pods", "POST", { name: clientId, client_id: clientId });
    if (made.pod_id) return made.pod_id;
  } catch (e) {
    // AgentMail refuses a second pod with the same client id: look for the first. Anything else is a real failure.
    if (!(e instanceof ProviderError) || e.status < 400 || e.status >= 500) throw e;
  }
  let pageToken = "";
  for (let page = 0; page < 100; page++) {
    const r = await agentmail<{ pods?: Pod[]; next_page_token?: string | null }>(`/v0/pods?limit=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`);
    const mine = r.pods?.find((p) => p.client_id === clientId && p.pod_id);
    if (mine?.pod_id) return mine.pod_id;
    if (!r.next_page_token) break;
    pageToken = r.next_page_token;
  }
  throw new Error(`AgentMail made no pod for ${clientId} and has none`);
}

/** Whether bots' addresses can go on BOPS_MAIL_DOMAIN, last checked (at most every 5 minutes). */
let mailDomainSeen: { at: number; ready: boolean } | undefined;

/**
 * The domain for bots' addresses (bops.bot) when AgentMail has it verified with subdomains on, else
 * null. Checked with the cloud's own key: a pod's key sees none of the account's domains. If AgentMail
 * can't be asked, the last answer stands (or the domain, never asked yet), so a blip doesn't put a
 * new bot on agentmail.to for good.
 */
async function mailDomain(): Promise<string | null> {
  const domain = config.mailDomain();
  if (!mailDomainSeen || Date.now() - mailDomainSeen.at > 5 * 60_000) {
    try {
      const r = await agentmail<{ domains?: { domain?: string; status?: string; subdomains_enabled?: boolean }[] }>("/v0/domains?limit=100");
      const d = r.domains?.find((x) => x.domain?.toLowerCase() === domain);
      mailDomainSeen = { at: Date.now(), ready: d?.status === "VERIFIED" && !!d.subdomains_enabled };
      if (!mailDomainSeen.ready) console.warn(`[session] ${domain} isn't ready at AgentMail (${d ? `${d.status}, subdomains ${d.subdomains_enabled ? "on" : "off"}` : "not added"}): bots' addresses go on agentmail.to`);
    } catch (e) {
      console.warn(`[session] couldn't check ${domain} at AgentMail: ${(e as Error).message}`);
      return mailDomainSeen?.ready === false ? null : domain;
    }
  }
  return mailDomainSeen.ready ? domain : null;
}

/** A new key scoped to the pod. AgentMail shows a key only once, so the cloud keeps it sealed and hands back the same one every time. */
async function makePodKey(podId: string, userId: string): Promise<string> {
  const r = await agentmail<{ api_key?: string }>(`/v0/pods/${encodeURIComponent(podId)}/api-keys`, "POST", { name: `bops-${userId}`, permissions: POD_KEY_PERMISSIONS });
  if (!r.api_key) throw new Error("AgentMail made a pod key but didn't return it");
  return r.api_key;
}

/** The pod key kept for this user, or null when there's none or it can't be opened (BOPS_CLOUD_SECRET changed): then a new one is made. */
function keptKey(sealed: string | null, userId: string) {
  if (!sealed) return null;
  try {
    return open(sealed);
  } catch {
    console.warn(`[session] ${userId}'s AgentMail key can't be opened with this BOPS_CLOUD_SECRET; making a new one`);
    return null;
  }
}

/* ---------------- AgentPhone: a sub-account per user (and, when trunks are on, a SIP trunk to OpenAI in it) ---------------- */

const agentphone = <T>(path: string, method?: string, body?: unknown, subAccount?: string) =>
  callProvider<T>(
    "AgentPhone",
    `${config.upstream.agentphone()}${path}`,
    { authorization: `Bearer ${config.agentphoneKey()}`, ...(subAccount ? { "x-sub-account-id": subAccount } : {}) },
    method,
    body,
  );

type SubAccount = { id?: string; name?: string };
/** AgentPhone doesn't document its list shape: a bare array, or the array under a key. */
const listOf = <T>(r: unknown): T[] => {
  if (Array.isArray(r)) return r as T[];
  const o = (r ?? {}) as Record<string, unknown>;
  const found = [o.data, o.subAccounts, o.sub_accounts, o.items].find(Array.isArray);
  return (found ?? []) as T[];
};

/** The user's sub-account, found by its name `bops-<userId>` first (so a setup cut short never leaves two), else made. */
async function findOrMakeSubAccount(userId: string): Promise<string> {
  const name = `bops-${userId}`;
  // AgentPhone allows 500 sub-accounts per account.
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = listOf<SubAccount>(await agentphone(`/v1/sub-accounts?limit=100&offset=${offset}`));
    const mine = page.find((a) => a.name === name && a.id);
    if (mine?.id) return mine.id;
    if (page.length < 100) break;
  }
  const made = await agentphone<SubAccount & { data?: SubAccount; subAccount?: SubAccount }>("/v1/sub-accounts", "POST", { name });
  const id = made.id ?? made.data?.id ?? made.subAccount?.id;
  if (!id) throw new Error("AgentPhone made a sub-account but didn't say its id");
  return id;
}

type Trunk = { id: string; name?: string; originationUris?: { sip_uri?: string }[] | null };

/** Sub-accounts (and the SIP address) whose trunk this process has already seen in place. */
const trunksReady = new Set<string>();

/**
 * A SIP trunk in the user's sub-account that sends calls to OpenAI (OPENAI_SIP_URI), only when SIP
 * trunks are on (BOPS_SIP_TRUNKS=1). Dormant otherwise: AgentPhone hasn't turned SIP on for new
 * sub-accounts (it answers 403), and Bops' numbers take calls through their agents instead (each
 * turn to /hooks/agentphone). AgentPhone ignores the destination on create, so it's set after
 * (PATCH). Best effort: a failure mustn't stop the rest; the next session tries again.
 */
async function ensureSipTrunk(userId: string, subAccount: string) {
  const uri = config.openaiSipUri();
  const key = `${subAccount} ${uri}`;
  if (!config.sipTrunks() || !uri || trunksReady.has(key)) return;
  const name = `bops-${userId}`;
  const sendsToOpenAI = (t: Trunk) => !!t.originationUris?.some((o) => o.sip_uri === uri);
  try {
    const trunks = listOf<Trunk>(await agentphone("/v1/sip-trunks", "GET", undefined, subAccount));
    let trunk = trunks.find(sendsToOpenAI) ?? trunks.find((t) => t.name === name);
    trunk ??= await agentphone<Trunk>("/v1/sip-trunks", "POST", { name, origination: { uris: [{ sip_uri: uri, name: "OpenAI" }] } }, subAccount);
    if (!sendsToOpenAI(trunk))
      await agentphone(`/v1/sip-trunks/${encodeURIComponent(trunk.id)}`, "PATCH", { origination: { uris: [{ sip_uri: uri, name: "OpenAI" }] } }, subAccount);
    trunksReady.add(key);
  } catch (e) {
    console.warn(`[session] no SIP trunk for ${userId} yet: ${(e as Error).message}`);
  }
}

/* ---------------- The session ---------------- */

/** OPENAI_EXECUTOR_API_KEY goes onto bot computers, where users have root: never hand out the main key, even when it's set by mistake. */
let warnedExecutor = false;
function executorKey() {
  const key = config.openaiExecutorKey();
  if (key && key === config.openaiKey()) {
    if (!warnedExecutor) console.warn("[session] OPENAI_EXECUTOR_API_KEY is the main OpenAI key: not handing it out");
    warnedExecutor = true;
    return null;
  }
  return key || null;
}

/** Make whatever the user doesn't have yet. A provider that fails leaves the rest saved, and the call answers 502 so the Mac tries again. */
async function setUp(user: CloudUser): Promise<CloudSession> {
  await ensureUserRow(user.id);
  await welcome(user.id);
  const failed: string[] = [];
  const { row, mailKey } = await tx(async (c) => {
    await c.query("INSERT INTO bops.cloud_accounts (user_id, email) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING", [user.id, user.email ?? null]);
    const row = (
      await c.query<AccountRow>(
        "SELECT user_id, email, agentmail_pod_id, agentmail_key_sealed, agentphone_sub_account FROM bops.cloud_accounts WHERE user_id = $1 FOR UPDATE",
        [user.id],
      )
    ).rows[0];
    let mailKey: string | null = null;
    if (config.agentmailKey()) {
      try {
        row.agentmail_pod_id ??= await findOrMakePod(user.id);
        mailKey = keptKey(row.agentmail_key_sealed, user.id);
        if (!mailKey) {
          mailKey = await makePodKey(row.agentmail_pod_id, user.id);
          row.agentmail_key_sealed = seal(mailKey);
        }
      } catch (e) {
        failed.push("email");
        console.warn(`[session] AgentMail setup for ${user.id}: ${(e as Error).message}`);
      }
    }
    if (config.agentphoneKey()) {
      try {
        row.agentphone_sub_account ??= await findOrMakeSubAccount(user.id);
        await ensureSipTrunk(user.id, row.agentphone_sub_account);
      } catch (e) {
        failed.push("phone");
        console.warn(`[session] AgentPhone setup for ${user.id}: ${(e as Error).message}`);
      }
    }
    await c.query(
      `UPDATE bops.cloud_accounts
       SET email = COALESCE($2, email), agentmail_pod_id = $3, agentmail_key_sealed = $4, agentphone_sub_account = $5,
           updated_at = CASE WHEN (email, agentmail_pod_id, agentmail_key_sealed, agentphone_sub_account) IS DISTINCT FROM (COALESCE($2, email), $3, $4, $5) THEN now() ELSE updated_at END,
           last_seen_at = now()
       WHERE user_id = $1`,
      [user.id, user.email ?? null, row.agentmail_pod_id, row.agentmail_key_sealed, row.agentphone_sub_account],
    );
    return { row, mailKey };
  });
  if (failed.length) throw new HttpError(502, `Couldn't set up your ${failed.join(" and ")} right now. Try again in a minute.`);
  const publicUrl = config.publicUrl();
  return {
    userId: user.id,
    ...(user.email ? { email: user.email } : {}),
    publicUrl,
    agentmail: row.agentmail_pod_id && mailKey ? { podId: row.agentmail_pod_id, apiKey: mailKey, domain: await mailDomain() } : null,
    agentphone: config.agentphoneKey() && row.agentphone_sub_account ? { subAccountId: row.agentphone_sub_account, hookUrl: publicUrl ? `${publicUrl}/hooks/agentphone` : "" } : null,
    honcho: config.honchoKey() ? { workspacePrefix: honchoPrefix(user.id) } : null,
    composio: config.composioKey() ? { userId: composioUserId(user.id) } : null,
    openai: config.openaiKey() ? { executorKey: executorKey() } : null,
    typesafe: !!config.typesafeKey(),
    verify: verifyChannels(),
    slack: slackApp(),
  };
}

/** Bops' Slack app, when this cloud takes its events: they're checked with its signing secret, and where they go is checked through Composio. */
function slackApp(): CloudSession["slack"] {
  const appId = config.slackAppId();
  return appId && config.slackSigningSecret() && config.composioKey() ? { appId } : null;
}

export const routes: Route[] = [
  {
    method: "POST",
    path: "/v1/session",
    auth: "user",
    handle: async (_req, res, { user }) => sendJson(res, 200, await setUp(user!)),
  },
];
