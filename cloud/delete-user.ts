import type { IncomingMessage } from "node:http";
import type pg from "pg";
import { config } from "./config.ts";
import { clearDeleted, markDeleted, query, tx } from "./db.ts";
import { HttpError, readBody, sendJson, type Route } from "./http.ts";
import { hub } from "./live.ts";
import { locked, planSigned } from "./plans.ts";
import { callsEnded, closeSidebands } from "./proxy.ts";
import { agentmail, agentphone, callProvider, findPod, listOf, ownsWorkspace, ProviderError } from "./session.ts";
import { closeFor } from "./tunnel.ts";
import { forgetUser } from "./turn-guard.ts";

/**
 * Deleting a user: orgo-web's account deletion (lib/account-deletion/job.ts, its bops_cloud step) asks
 * Bops Cloud to delete everything it holds for an Orgo user who deleted their account:
 *
 *   POST /v1/internal/delete-user {userId}
 *   x-bops-timestamp: <Unix seconds>
 *   x-bops-signature: sha256=<hex HMAC-SHA256 of "{timestamp}.{raw body}", keyed with BOPS_CLOUD_PLAN_SECRET>
 *
 * Signed as its plan notices are (plans.ts planSigned, at most 5 minutes off): 404 with no secret set,
 * 401 unsigned, signed wrong or stale. The body is exactly {userId}, an Orgo user's id (a lowercase
 * UUID), and nothing else, else 400: what's signed names neither this route nor what it's for, so a
 * plan notice {userId, tier, at} or a member notice {projectId, userId} signed with the same secret
 * would otherwise be good here for its 5 minutes, as a delete of that user (userIdOf).
 *
 * For orgo-web a 2xx means done, and anything else keeps it pending and sends it again every 6 hours
 * (and it waits 60 seconds for an answer). So it's idempotent, and it's 200 only once nothing is left
 * that a retry could still delete: `{deleted: {table: n}, kept: {table: n},
 * providers: {provider: {what: n}}}`. A provider that failed is 502 with the same and its `error`; one
 * still going after ANSWER_WITHIN_MS is 503 (`pending`), and it goes on: a call meanwhile waits for the
 * same run, and the next one after it finishes what's left. A user Bops Cloud never heard of is 200 with zeros.
 *
 * In order:
 *
 * 1. **Nothing of theirs is written again** (db.ts markDeleted, bops.deleted_users, kept DELETED_KEEP_DAYS
 *    after the last call unless undelete-user lifts it, below): their sign-ins are turned down (auth.ts,
 *    401 ACCOUNT_DELETED, from the table, so a restart changes nothing), a state write (state.ts lockUser)
 *    or anything that would make their state row again (db.ts ensureUserRow: a session, a plan, a handle,
 *    a waiting event) is refused, and so is a use counted (usage.ts) or an object recorded (db.ts
 *    ownObject) for them. Their Mac's tunnel, their sockets here (proxy.ts closeSidebands: a task's
 *    Responses socket, a call's sideband), every live stream of theirs and the guard's watch on their
 *    turns (turn-guard.ts forgetUser) end now. What this leans on first is orgo-web: it deleted their
 *    Orgo keys when they asked to be deleted (lib/account-deletion.ts), well before the job calls, so
 *    Orgo turns their key down, and a Mac still signed in can't write its stale copy back. The tombstone
 *    covers what Orgo still vouches for (a bot computer's identity token, until the job's next step
 *    deletes the computer), the cloud's own work under way (a phone turn's answer, a plan's setup, a turn
 *    read back) and a plan notice from the Stripe cancel that came with the deletion (answered as taken,
 *    and ignored).
 * 2. **Their content, at once**, in one transaction under the user's plan lock (plans.ts locked: a plan's
 *    number being bought is bought and recorded first, and with their plan gone none is bought after) and
 *    their state row's lock (a state write waiting on it finds them gone): what's below as "deleted at once".
 * 3. **The providers**, best effort, all at once, with the cloud's own keys. First their calls under way
 *    here that may make something there end (proxy.ts callsEnded: a stored response, which is recorded
 *    only once its whole answer is in, a number, an inbox, a memory bank, a connected account), so what
 *    they made is recorded or listed by then: none starts now (step 1). That wait is short (callsWithinMs,
 *    30 seconds): a call still going after it goes on, its record is kept when it's done, and its
 *    provider's `error` says so (502), so the retry deletes what it made. Each provider deletes there first
 *    and its record here only after, so a provider that fails keeps what the retry needs (a number's id,
 *    the pod, a response's id) and makes the answer 502; one that says it has no such thing (404) counts as
 *    done. A provider not set up on this cloud fails the same way when the cloud recorded something there.
 *    - **AgentPhone:** every number in their sub-account (the ones recorded, and the ones it lists)
 *      given back (DELETE /v1/numbers/{id}), as a plan's is 30 days after it's paused. The sub-account
 *      itself and its agents stay: AgentPhone has no delete for them that the cloud uses.
 *    - **AgentMail:** every inbox in their pod (the Mac makes most itself, so they're listed), then the
 *      pod, which takes its key with it. Their pod is found by its client id when the account row has none.
 *    - **Honcho:** every workspace (memory bank) under their prefix (session.ts honchoPrefix: `u-<id>` and
 *      `u-<id>-…`, the only ones the proxy ever let them make), found in the list and deleted.
 *    - **OpenAI:** every stored response the cloud saw made for them (DELETE /v1/responses/{id}). Agent
 *      sessions, turns and helpers, and live calls, have no delete: their rows go at once.
 *    - **Composio:** every connected account the cloud saw made for them (DELETE connected_accounts/{id}):
 *      each holds a sign-in to one of their apps.
 * 4. **The rest, once every provider is done**, in one transaction: what step 2 deletes, again (anything a
 *    turn under way wrote meanwhile), and the records the providers needed, their account row and their
 *    state row last. Unless something a provider deletes was recorded meanwhile that step 3 never saw
 *    (what its wait doesn't cover: the last answer on a task's Responses socket as it closed, the cloud's
 *    own work): then only what step 2 deletes goes, that record stays, and it's 502 with that provider's
 *    `error`, so the retry deletes it there too. Each transaction on the user (step 2 and step 4) is tried
 *    again when Postgres stops it for a deadlock: the hourly sweep of removed messages (state.ts) takes
 *    chat rows and then state rows, the other way round from here.
 *
 * **Undoing the tombstone:** `POST /v1/internal/undelete-user {userId}`, signed the same way but with
 * the route in what's signed ("{timestamp}.POST /v1/internal/undelete-user.{raw body}", so a signature
 * for one is never good for the other), takes the user out of bops.deleted_users at once: for a deletion
 * staff cancel in orgo-web after its bops_cloud step ran. Nothing deleted comes back; they can sign in and
 * use Bops again from what their Mac still has. 200 `{ok: true, lifted}` (lifted: whether there was one),
 * 409 while a delete of theirs still runs. orgo-web doesn't call it yet.
 *
 * Each table, and why:
 *
 * - Deleted at once: `chat_messages` (their chats), `app_state_backups` (whole copies before Start over),
 *   `owner_phones` and `owner_emails` (their own number and address: someone else may verify that
 *   number now), `cloud_pending` (texts, calls and events waiting for their Mac, and what they did as a
 *   member that waits for another owner's), `slack_links`, `plans`
 *   (orgo-web keeps the plan itself), `notice_dismissals`, `cloud_usage` (what they used, for their
 *   account page: what it cost is orgo-web's AI credit ledger, which orgo-web deletes or keeps itself),
 *   `cloud_limits` (the counts that name them; a verify count by recipient alone is no one's and goes
 *   within 2 hours), `cloud_agents` (sealed webhook secrets: a text to a number not given back yet is
 *   then refused, never kept), and their `cloud_objects` that name nothing a provider deletes (agent
 *   sessions, turns, helpers, live calls, Composio sessions, a code's hold on a recipient).
 * - `app_state` (their whole state): emptied at once ('{}', version 0, as the row other tables need
 *   before a first upload), deleted last, as their account row hangs off it until the providers are done.
 * - `cloud_accounts` (their pod and its sealed key, their sub-account): their email, the pod key and the
 *   app versions go at once; the pod and sub-account ids stay until the providers are done.
 * - `phone_lines`, `cloud_numbers`: deleted as each number is given back, and none kept to say it was: a
 *   number AgentPhone gives out again must be free to be someone else's line, there's nobody left to tell,
 *   and a line names its owner's own phone, which goes at once from those still waiting.
 * - `mail_inboxes`: deleted once AgentMail deleted the pod.
 * - `mail_handles` **kept**, retired and nobody's (user_id NULL, workspace_id ''; migration 0014): a
 *   handle is never claimed twice, so mail written to their old addresses never reaches whoever would
 *   take it next. Nothing ties it to them after.
 * - `cloud_objects` of a Composio sign-in setup (`auth_config`) **kept**, nobody's (user_id ''): it serves
 *   every user (one made through the cloud is offered to anyone) and holds no one's secret.
 * - `deleted_users`: the tombstone above, their user id alone, swept DELETED_KEEP_DAYS after the last call
 *   (db.ts says why that long), or gone at once with undelete-user.
 */

/**
 * How long the route waits for a delete before answering 503 (it goes on): orgo-web waits 60 seconds.
 * And how long a delete waits for the user's calls under way that may make something at a provider
 * (step 3), before it asks the providers anyway and answers 502: short, so the answer comes in one call
 * as a rule, and a call still going after it (a long reasoning answer) is the retry's. Tests shorten them.
 */
export const deleteTiming = { answerWithinMs: 45_000, callsWithinMs: 30_000 };
/** How many deletes go to one provider at once (stored responses run to thousands for someone who used Bops a lot). */
const AT_ONCE = 8;

type Counts = Record<string, number>;
/** What one provider's step did there (how many of each it deleted), and why it stopped short, if it did. */
type ProviderStep = { done: Counts; error?: string };
/** One provider's step as answered: how many of each it deleted there, and `error` when it stopped short. */
type ProviderReport = Record<string, number | string>;
/** What a delete did. `left`: a provider stopped short, and a retry has something to finish. */
export type DeleteOutcome = { deleted: Counts; kept: Counts; providers: Record<string, ProviderReport>; left: boolean };

/**
 * What goes at once (step 2), and again at the end (step 4): [table, statement on the user ($1)], in an
 * order the foreign keys allow. Each one's rowCount is what it deleted.
 */
const CONTENT: [string, string][] = [
  ["chat_messages", "DELETE FROM bops.chat_messages WHERE user_id = $1"],
  ["app_state_backups", "DELETE FROM bops.app_state_backups WHERE user_id = $1"],
  ["owner_phones", "DELETE FROM bops.owner_phones WHERE orgo_user_id = $1"],
  ["owner_emails", "DELETE FROM bops.owner_emails WHERE orgo_user_id = $1"],
  // And what they did as a member in someone else's workspace (members.ts act), still waiting for that owner's Mac or
  // kept after it was taken (a week, for its dedupe key: tunnel.ts clearOldEvents): it names them and has their words.
  // Nothing of theirs is sent again once they're gone, so the key isn't needed.
  ["cloud_pending", "DELETE FROM bops.cloud_pending WHERE user_id = $1 OR (kind = 'member' AND payload->'member'->>'userId' = $1)"],
  ["slack_links", "DELETE FROM bops.slack_links WHERE user_id = $1"],
  ["plans", "DELETE FROM bops.plans WHERE user_id = $1"],
  ["notice_dismissals", "DELETE FROM bops.notice_dismissals WHERE user_id = $1"],
  ["cloud_usage", "DELETE FROM bops.cloud_usage WHERE user_id = $1"],
  // The counts that name them (agent.ts countSend; members.ts countAct; verify.ts per user, and per user and recipient).
  [
    "cloud_limits",
    `DELETE FROM bops.cloud_limits WHERE key IN ('agent:send:' || $1, 'member:act:' || $1, 'verify:user:' || $1)
       OR (split_part(key, ':', 1) = 'verify' AND split_part(key, ':', 2) IN ('last', 'slot', 'check') AND split_part(key, ':', 4) = $1)`,
  ],
  ["cloud_agents", "DELETE FROM bops.cloud_agents WHERE user_id = $1"],
  // Everything but what a provider deletes (step 3) and the sign-in setups everyone uses (KEPT).
  ["cloud_objects", "DELETE FROM bops.cloud_objects WHERE user_id = $1 AND NOT (provider = 'openai' AND kind = 'response') AND NOT (provider = 'composio' AND kind IN ('connected_account', 'auth_config'))"],
  // A number or inbox already given back is only a record that it was.
  ["phone_lines", "DELETE FROM bops.phone_lines WHERE user_id = $1 AND status = 'released'"],
  ["mail_inboxes", "DELETE FROM bops.mail_inboxes WHERE user_id = $1 AND status = 'released'"],
];

/** What stays, nobody's (step 2 and 4). */
const KEPT: [string, string][] = [
  ["mail_handles", "UPDATE bops.mail_handles SET user_id = NULL, workspace_id = '', retired_at = COALESCE(retired_at, now()) WHERE user_id = $1"],
  ["cloud_objects", "UPDATE bops.cloud_objects SET user_id = '' WHERE user_id = $1 AND provider = 'composio' AND kind = 'auth_config'"],
];

/** What only stays while the providers need it: whatever names the person goes at once (step 2). */
const SCRUB = [
  "UPDATE bops.cloud_accounts SET email = NULL, agentmail_key_sealed = NULL, app_version = NULL, app_seen_at = NULL, ios_version = NULL, ios_seen_at = NULL, updated_at = now() WHERE user_id = $1",
  "UPDATE bops.phone_lines SET owner_number = NULL, claimed_at = NULL, claimed_via = NULL, claim_until = NULL, bot_id = NULL, workspace_id = NULL, updated_at = now() WHERE user_id = $1",
  "UPDATE bops.app_state SET state = '{}'::jsonb, version = 0, writer = NULL, updated_at = now() WHERE user_id = $1",
];

/** The records the providers needed, then the account and the state rows (step 4), children first. */
const LAST: [string, string][] = [
  ["phone_lines", "DELETE FROM bops.phone_lines WHERE user_id = $1"],
  ["cloud_numbers", "DELETE FROM bops.cloud_numbers WHERE user_id = $1"],
  ["mail_inboxes", "DELETE FROM bops.mail_inboxes WHERE user_id = $1"],
  ["cloud_objects", "DELETE FROM bops.cloud_objects WHERE user_id = $1"],
  ["cloud_accounts", "DELETE FROM bops.cloud_accounts WHERE user_id = $1"],
  ["app_state", "DELETE FROM bops.app_state WHERE user_id = $1"],
];

/** Every table a delete reports, at 0 when it had nothing. */
const TABLES = [...new Set([...CONTENT, ...LAST].map(([t]) => t))].sort();

const add = (counts: Counts, table: string, n: number | null) => void (counts[table] = (counts[table] ?? 0) + (n ?? 0));

/** What Postgres answers a transaction it stopped so another could go on (a deadlock, a serialization failure): tried again. */
const LOST = new Set(["40P01", "40001"]);
/** How many times a transaction on the user is tried. */
const TRIES = 3;

/**
 * What the provider steps delete from, each as "<provider>:<id>" (a number's, a pod's, a response's, a
 * connected account's): what step 4 holds against what they saw. A line or an inbox already given back
 * is CONTENT's.
 */
const AT_PROVIDERS = `
  SELECT 'openai:' || object_id AS k FROM bops.cloud_objects WHERE user_id = $1 AND provider = 'openai' AND kind = 'response'
  UNION ALL SELECT 'composio:' || object_id FROM bops.cloud_objects WHERE user_id = $1 AND provider = 'composio' AND kind = 'connected_account'
  UNION ALL SELECT 'agentphone:' || number_id FROM bops.phone_lines WHERE user_id = $1 AND number_id IS NOT NULL AND status <> 'released'
  UNION ALL SELECT 'agentphone:' || number_id FROM bops.cloud_numbers WHERE user_id = $1 AND number_id IS NOT NULL
  UNION ALL SELECT 'agentmail:' || pod_id FROM bops.mail_inboxes WHERE user_id = $1 AND status <> 'released'
  UNION ALL SELECT 'agentmail:' || agentmail_pod_id FROM bops.cloud_accounts WHERE user_id = $1 AND agentmail_pod_id IS NOT NULL`;

/** The providers something of the user's was recorded for that the provider steps never saw (`seen`). */
async function madeMeanwhile(c: pg.PoolClient, userId: string, seen: Set<string>): Promise<string[]> {
  const late = (await c.query<{ k: string }>(AT_PROVIDERS, [userId])).rows.filter((r) => !seen.has(r.k));
  return [...new Set(late.map((r) => r.k.slice(0, r.k.indexOf(":"))))].sort();
}

/**
 * Run `statements` on the user, holding their state row (a write waiting on it then finds them gone:
 * state.ts lockUser), adding to `counts` once it's committed. What's KEPT is made nobody's first, so
 * deleting their rows (the state row's cascade among them) never takes it.
 *
 * With `seen` (step 4: what the provider steps saw), their account row is held too, so a number, a line
 * or an inbox being recorded waits for this (its foreign key takes that row; an object a provider
 * deletes waits on the state row: db.ts ownObject). If anything a provider deletes was recorded that
 * isn't in `seen`, only CONTENT runs (and SCRUB), and the providers it's for are returned.
 *
 * Tried again, from the start, when Postgres stops it for a deadlock (LOST): the hourly sweep of removed
 * messages (state.ts sweepRemovedMessages) takes old chat rows and then their state rows, the other way
 * round from here.
 */
async function onUser(userId: string, statements: [string, string][], counts: Counts, kept: Counts, opts: { scrub?: boolean; seen?: Set<string> } = {}): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    const done: Counts = {};
    const keptNow: Counts = {};
    try {
      const late = await tx(async (c) => {
        await c.query("SELECT 1 FROM bops.app_state WHERE user_id = $1 FOR UPDATE", [userId]);
        let late: string[] = [];
        if (opts.seen) {
          await c.query("SELECT 1 FROM bops.cloud_accounts WHERE user_id = $1 FOR UPDATE", [userId]);
          late = await madeMeanwhile(c, userId, opts.seen);
        }
        for (const [table, sql] of KEPT) add(keptNow, table, (await c.query(sql, [userId])).rowCount);
        for (const [table, sql] of late.length ? CONTENT : statements) add(done, table, (await c.query(sql, [userId])).rowCount);
        if (opts.scrub || late.length) for (const sql of SCRUB) await c.query(sql, [userId]);
        return late;
      });
      for (const [table, n] of Object.entries(done)) add(counts, table, n);
      for (const [table, n] of Object.entries(keptNow)) add(kept, table, n);
      return late;
    } catch (e) {
      if (attempt >= TRIES || !LOST.has(String((e as { code?: unknown })?.code))) throw e;
      console.warn(`[delete-user] ${userId}: ${(e as Error).message} (try ${attempt}), trying again`);
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200));
    }
  }
}

/** What a provider's failure says (its name, status and route: never a key or a body). */
const why = (e: unknown) => (e instanceof ProviderError ? e.message : `${(e as Error)?.message ?? e}`).slice(0, 300);
/** A provider that says it has no such thing: already gone, so done. */
const gone = (e: unknown) => e instanceof ProviderError && e.status === 404;
const enc = encodeURIComponent;

/** `work` for each of `items`, `n` at a time. */
async function inTurns<T>(items: T[], n: number, work: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/* ---------------- The providers ---------------- */

/** AgentPhone: every number in their sub-account given back; each one's line and routing row go after. */
async function agentphoneStep(userId: string, deleted: Counts, seen: Set<string>): Promise<ProviderStep> {
  const done = { numbers: 0 };
  const sub = (await query<{ sub: string | null }>("SELECT agentphone_sub_account AS sub FROM bops.cloud_accounts WHERE user_id = $1", [userId])).rows[0]?.sub ?? null;
  const recorded = (
    await query<{ number_id: string }>(
      "SELECT number_id FROM bops.phone_lines WHERE user_id = $1 AND number_id IS NOT NULL UNION SELECT number_id FROM bops.cloud_numbers WHERE user_id = $1 AND number_id IS NOT NULL",
      [userId],
    )
  ).rows.map((r) => r.number_id);
  for (const id of recorded) seen.add(`agentphone:${id}`);
  // Their numbers live in their sub-account: with none, nothing of theirs is there to give back.
  if (!sub) return { done };
  if (!config.agentphoneKey()) return { done, error: "AgentPhone isn't set up on this cloud" };
  let listed: { id?: string }[];
  try {
    listed = listOf<{ id?: string }>(await agentphone("/v1/numbers?limit=100", "GET", undefined, sub));
  } catch (e) {
    return { done, error: why(e) };
  }
  let error: string | undefined;
  for (const id of new Set([...recorded, ...listed.flatMap((n) => (typeof n.id === "string" ? [n.id] : []))])) {
    seen.add(`agentphone:${id}`);
    try {
      await agentphone(`/v1/numbers/${enc(id)}`, "DELETE", undefined, sub);
      done.numbers++;
    } catch (e) {
      if (!gone(e)) {
        error ??= why(e);
        continue;
      }
    }
    add(deleted, "phone_lines", (await query("DELETE FROM bops.phone_lines WHERE user_id = $1 AND number_id = $2", [userId, id])).rowCount);
    add(deleted, "cloud_numbers", (await query("DELETE FROM bops.cloud_numbers WHERE user_id = $1 AND number_id = $2", [userId, id])).rowCount);
  }
  return { done, ...(error ? { error } : {}) };
}

/** AgentMail: every inbox in their pod, then the pod (its key goes with it); their inbox rows and the pod's id go after. */
async function agentmailStep(userId: string, deleted: Counts, seen: Set<string>): Promise<ProviderStep> {
  const done = { inboxes: 0, pods: 0 };
  const account = (await query<{ pod: string | null }>("SELECT agentmail_pod_id AS pod FROM bops.cloud_accounts WHERE user_id = $1", [userId])).rows[0];
  const recorded = (await query<{ pod_id: string }>("SELECT DISTINCT pod_id FROM bops.mail_inboxes WHERE user_id = $1", [userId])).rows.map((r) => r.pod_id);
  const pods = new Set(account?.pod ? [account.pod, ...recorded] : recorded);
  if (!pods.size) {
    // A setup cut short can leave a pod AgentMail made that the account row never got: looked for by its
    // client id. Without a key here, or without an account, the cloud never made one.
    if (!account || !config.agentmailKey()) return { done };
    try {
      const found = await findPod(userId);
      if (found) pods.add(found);
    } catch (e) {
      return { done, error: why(e) };
    }
  }
  if (pods.size && !config.agentmailKey()) return { done, error: "AgentMail isn't set up on this cloud" };
  let error: string | undefined;
  for (const pod of pods) {
    seen.add(`agentmail:${pod}`);
    try {
      const base = `/v0/pods/${enc(pod)}`;
      const inboxes: string[] = [];
      try {
        for (let page = 0, token = ""; page < 100; page++) {
          const r = await agentmail<{ inboxes?: { inbox_id?: string }[]; next_page_token?: string | null }>(`${base}/inboxes?limit=100${token ? `&page_token=${enc(token)}` : ""}`);
          for (const i of r.inboxes ?? []) if (typeof i.inbox_id === "string") inboxes.push(i.inbox_id);
          if (!r.next_page_token) break;
          token = r.next_page_token;
        }
      } catch (e) {
        // No such pod: nothing in it either.
        if (!gone(e)) throw e;
      }
      for (const inbox of inboxes) {
        try {
          await agentmail(`${base}/inboxes/${enc(inbox)}`, "DELETE");
          done.inboxes++;
        } catch (e) {
          if (!gone(e)) throw e;
        }
      }
      try {
        await agentmail(base, "DELETE");
        done.pods++;
      } catch (e) {
        if (!gone(e)) throw e;
      }
    } catch (e) {
      error ??= why(e);
      continue;
    }
    add(deleted, "mail_inboxes", (await query("DELETE FROM bops.mail_inboxes WHERE user_id = $1 AND pod_id = $2", [userId, pod])).rowCount);
    await query("UPDATE bops.cloud_accounts SET agentmail_pod_id = NULL, updated_at = now() WHERE user_id = $1 AND agentmail_pod_id = $2", [userId, pod]);
  }
  return { done, ...(error ? { error } : {}) };
}

/** Honcho: every workspace (memory bank) under their prefix. Nothing of it is recorded here, so a retry lists them again. */
async function honchoStep(userId: string): Promise<ProviderStep> {
  const done = { workspaces: 0 };
  // Without a key here, nothing was ever made at Honcho through this cloud.
  if (!config.honchoKey()) return { done };
  const honcho = <T>(method: string, path: string, body?: unknown) =>
    callProvider<T>("Honcho", `${config.upstream.honcho().replace(/\/+$/, "")}${path}`, { authorization: `Bearer ${config.honchoKey()}` }, method, body);
  const theirs: string[] = [];
  try {
    for (let page = 1, pages = 1; page <= pages && page <= 1000; page++) {
      const r = await honcho<{ items?: { id?: unknown }[]; pages?: unknown }>("POST", `/v3/workspaces/list?page=${page}&size=100`, {});
      for (const w of r.items ?? []) if (typeof w.id === "string" && ownsWorkspace(userId, w.id)) theirs.push(w.id);
      pages = typeof r.pages === "number" ? r.pages : page;
    }
  } catch (e) {
    return { done, error: why(e) };
  }
  let error: string | undefined;
  for (const id of theirs) {
    try {
      await honcho("DELETE", `/v3/workspaces/${enc(id)}`);
      done.workspaces++;
    } catch (e) {
      if (!gone(e)) error ??= why(e);
    }
  }
  return { done, ...(error ? { error } : {}) };
}

/** OpenAI: every stored response the cloud saw made for them; each one's row goes after. */
async function openaiStep(userId: string, deleted: Counts, seen: Set<string>): Promise<ProviderStep> {
  const done = { responses: 0 };
  const ids = (await query<{ object_id: string }>("SELECT object_id FROM bops.cloud_objects WHERE user_id = $1 AND provider = 'openai' AND kind = 'response'", [userId])).rows.map((r) => r.object_id);
  for (const id of ids) seen.add(`openai:${id}`);
  if (!ids.length) return { done };
  if (!config.openaiKey()) return { done, error: "OpenAI isn't set up on this cloud" };
  let error: string | undefined;
  await inTurns(ids, AT_ONCE, async (id) => {
    try {
      await callProvider("OpenAI", `${config.upstream.openai()}/v1/responses/${enc(id)}`, { authorization: `Bearer ${config.openaiKey()}` }, "DELETE");
      done.responses++;
    } catch (e) {
      if (!gone(e)) return void (error ??= why(e));
    }
    add(deleted, "cloud_objects", (await query("DELETE FROM bops.cloud_objects WHERE provider = 'openai' AND object_id = $1 AND user_id = $2", [id, userId])).rowCount);
  });
  return { done, ...(error ? { error } : {}) };
}

/** Composio: every connected account the cloud saw made for them (each a sign-in to one of their apps); each one's row goes after. */
async function composioStep(userId: string, deleted: Counts, seen: Set<string>): Promise<ProviderStep> {
  const done = { connectedAccounts: 0 };
  const ids = (await query<{ object_id: string }>("SELECT object_id FROM bops.cloud_objects WHERE user_id = $1 AND provider = 'composio' AND kind = 'connected_account'", [userId])).rows.map((r) => r.object_id);
  for (const id of ids) seen.add(`composio:${id}`);
  if (!ids.length) return { done };
  if (!config.composioKey()) return { done, error: "Composio isn't set up on this cloud" };
  let error: string | undefined;
  await inTurns(ids, AT_ONCE, async (id) => {
    try {
      await callProvider("Composio", `${config.upstream.composio()}/api/v3.1/connected_accounts/${enc(id)}`, { "x-api-key": config.composioKey() }, "DELETE");
      done.connectedAccounts++;
    } catch (e) {
      if (!gone(e)) return void (error ??= why(e));
    }
    add(deleted, "cloud_objects", (await query("DELETE FROM bops.cloud_objects WHERE provider = 'composio' AND object_id = $1 AND user_id = $2", [id, userId])).rowCount);
  });
  return { done, ...(error ? { error } : {}) };
}

/* ---------------- The delete ---------------- */

/** What a provider's step is answered when something of theirs was recorded there while it ran (step 4). */
const MADE_MEANWHILE = "Something of theirs was made there while this ran: ask again to delete it";
/** What a provider's step is answered when a call of theirs there was still going when it ran (step 3). */
const CALL_GOING = "A call of theirs there was still going: ask again to delete what it made";

/** Delete everything of the user's (the steps at the top). Throws only when Postgres does (the route answers 500, and orgo-web asks again). */
export async function deleteUser(userId: string): Promise<DeleteOutcome> {
  // 1. Nothing of theirs is written again, and what they have open ends.
  await markDeleted(userId);
  closeFor(userId);
  closeSidebands(userId);
  hub.closeAccount(userId);
  forgetUser(userId);
  const deleted: Counts = Object.fromEntries(TABLES.map((t) => [t, 0]));
  const kept: Counts = { mail_handles: 0, cloud_objects: 0 };
  // 2. Their content, under their plan lock.
  await locked(userId, () => onUser(userId, CONTENT, deleted, kept, { scrub: true }));
  // 3. Their calls under way that may make something at a provider end first (none starts now), so what they made is there to delete.
  const going = await callsEnded(userId, deleteTiming.callsWithinMs);
  // Then the providers, all at once. What each one saw, for step 4.
  const seen = new Set<string>();
  const steps: [string, Promise<ProviderStep>][] = [
    ["agentphone", agentphoneStep(userId, deleted, seen)],
    ["agentmail", agentmailStep(userId, deleted, seen)],
    ["honcho", honchoStep(userId)],
    ["openai", openaiStep(userId, deleted, seen)],
    ["composio", composioStep(userId, deleted, seen)],
  ];
  const providers: DeleteOutcome["providers"] = {};
  for (const [name, step] of steps) {
    const s = await step.catch((e: unknown): ProviderStep => ({ done: {}, error: why(e) }));
    providers[name] = { ...s.done, ...(s.error ? { error: s.error } : {}) };
  }
  // A call still going may still make something there: its record is kept (their state row stays), and the retry deletes it.
  for (const name of going) providers[name] = { ...providers[name], error: providers[name]?.error ?? CALL_GOING };
  let left = Object.values(providers).some((p) => "error" in p);
  // 4. The rest, once nothing is left anywhere that their records are needed for (and nothing new was made there meanwhile).
  if (!left) {
    const late = await onUser(userId, [...CONTENT, ...LAST], deleted, kept, { seen });
    for (const name of late) providers[name] = { ...providers[name], error: MADE_MEANWHILE };
    left = late.length > 0;
  }
  return { deleted, kept, providers, left };
}

/** A delete per user at a time: a call while one runs waits for that one (orgo-web's retry may come while a long one still goes). */
const runs = new Map<string, Promise<DeleteOutcome>>();

function runFor(userId: string): Promise<DeleteOutcome> {
  let run = runs.get(userId);
  if (run) return run;
  run = deleteUser(userId).finally(() => {
    if (runs.get(userId) === run) runs.delete(userId);
  });
  runs.set(userId, run);
  void run.then(
    (o) => console.log(`[delete-user] ${userId}: ${o.left ? "not finished" : "done"}: ${JSON.stringify({ deleted: o.deleted, kept: o.kept, providers: o.providers })}`),
    (e: Error) => console.warn(`[delete-user] ${userId}: ${e.message}`),
  );
  return run;
}

/** The outcome, or null when it's still going after `ms`. */
function within(run: Promise<DeleteOutcome>, ms: number): Promise<DeleteOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
/** An Orgo user's id, as orgo-web sends it: a UUID, lowercase as Postgres writes one. */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The user a signed call is for. The body is exactly {userId} and nothing else (400 otherwise): what
 * orgo-web signs here is "{timestamp}.{raw body}" (plans.ts planSigned), which names neither the route
 * nor what it's for, and its plan notices ({userId, tier, at}, POST /v1/internal/plan-changed) and member
 * notices ({projectId, userId}, POST /v1/internal/members-changed) are signed the same way with the same
 * secret. Any of them, seen on the way and sent here within its 5 minutes, would otherwise delete that
 * user. Binding the route into what's signed, as GET /v1/internal/ops/handles does (ops.ts) and
 * undelete-user does, needs orgo-web's caller to sign it (lib/account-deletion/job.ts, with
 * signBopsCloud): a follow-up there, then here.
 */
function userIdOf(body: Buffer): string {
  let n: unknown;
  try {
    n = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Body isn't JSON");
  }
  const userId = n && typeof n === "object" && !Array.isArray(n) && Object.keys(n).length === 1 ? (n as { userId?: unknown }).userId : undefined;
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new HttpError(400, "Send {userId}, and nothing else");
  return userId;
}

/**
 * A signed call's body: 404 with no secret set, then 401 unless it's signed over `signed` (the raw body,
 * or what a route signs in its place) with it, at most 5 minutes off.
 */
async function signedBody(req: IncomingMessage, signed: (body: Buffer) => Buffer = (body) => body): Promise<Buffer> {
  const secret = config.planSecret();
  if (!secret) throw new HttpError(404, "Not found");
  const body = await readBody(req, 4 * 1024);
  if (!planSigned(secret, one(req.headers["x-bops-timestamp"]), signed(body), one(req.headers["x-bops-signature"]))) throw new HttpError(401, "Bad signature");
  return body;
}

export const UNDELETE_USER_PATH = "/v1/internal/undelete-user";
/** What undelete-user signs in place of the raw body: the route, a dot, then the body ("{timestamp}." comes first, as planSigned adds it). */
export const undeleteSigned = (body: Buffer | string) => Buffer.concat([Buffer.from(`POST ${UNDELETE_USER_PATH}.`), Buffer.from(body)]);

export const routes: Route[] = [
  {
    method: "POST",
    path: "/v1/internal/delete-user",
    auth: "public",
    handle: async (req, res) => {
      const userId = userIdOf(await signedBody(req));
      const outcome = await within(runFor(userId), deleteTiming.answerWithinMs);
      if (!outcome) return sendJson(res, 503, { error: "Still deleting: ask again later", pending: true });
      const { deleted, kept, providers } = outcome;
      if (outcome.left) return sendJson(res, 502, { error: "Couldn't delete everything at the providers yet: ask again later", deleted, kept, providers });
      sendJson(res, 200, { deleted, kept, providers });
    },
  },
  {
    // The tombstone lifted, for a deletion staff cancel in orgo-web after its bops_cloud step ran (see the top).
    method: "POST",
    path: UNDELETE_USER_PATH,
    auth: "public",
    handle: async (req, res) => {
      const userId = userIdOf(await signedBody(req, undeleteSigned));
      if (runs.has(userId)) throw new HttpError(409, "Still deleting: ask again once it's done");
      const lifted = await clearDeleted(userId);
      console.log(`[delete-user] ${userId}: undeleted (${lifted ? "the tombstone is lifted" : "there was none"})`);
      sendJson(res, 200, { ok: true, lifted });
    },
  },
];
