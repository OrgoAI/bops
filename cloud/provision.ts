import { trackCloudEvent } from "./analytics.ts";
import { config } from "./config.ts";
import { seal } from "./crypto.ts";
import { query } from "./db.ts";
import { claimHandle, MAIN_WORKSPACE } from "./handles.ts";
import { lineDigits, recordLine } from "./lines.ts";
import type { MailHandleClaim, PlanInbox, PlanItemStatus, PlanPhone } from "./protocol.ts";
import { accountFor, agentmail, agentphone, listOf, mailDomain, ProviderError } from "./session.ts";
import { loadState } from "./state.ts";
import { recordUsage } from "./usage.ts";

/**
 * What a paid plan brings the user's main bot (the default workspace's), set up here in the cloud,
 * so it happens while the Mac is closed too: one phone number in the user's AgentPhone sub-account,
 * and one inbox in their AgentMail pod. Done the way the app does it (lib/server/phone.ts ensurePhone,
 * lib/server/mail.ts makeInbox), with the same tags and client ids, so the app finds them as its own:
 *
 * - **The number:** an agent in voice mode "webhook" whose webhook is the cloud (its secret sealed
 *   in bops.cloud_agents, as proxy.ts keeps one), a number bought in BOPS_PHONE_AREA with the tag
 *   bops-<install>-<bot> and attached to it, its calls routed to the agent, and its line in
 *   bops.phone_lines (plan = true). Its 15 minutes for the first caller to claim it open only when
 *   the app shows the user the number (lib/server/cloud-plan.ts), never while nobody is watching.
 * - **The inbox:** <bot>@<handle>.bops.bot, on the default workspace's handle (handles.ts; claimed
 *   from the suggestion when it has none, and the app offers to change it), in bops.mail_inboxes.
 *
 * Each is "setting_up" while it's made and "ready" only once read back from the provider ("broken",
 * with the problem, otherwise; the next reconcile tries again). Every step is found again before
 * it's made (the number by its tag, the agent by its description, the inbox by its client id), so a
 * setup cut short never buys a second number. A main bot that already has a number or an inbox (the
 * user's own, from before) gets none from the plan.
 *
 * When the plan ends, its number and inbox are paused (plans.ts stops answering on them), and given
 * back 30 days later (releaseAfterPause). Upgrading again before then picks them up as they were.
 */

/** What the Mac keeps for a bot, as far as the plan cares (lib/types.ts Bot). */
type StateBot = {
  id: string;
  name?: string;
  isMain?: boolean;
  workspaceId?: string;
  phone?: string;
  phoneLine?: { numberId: string; agentId: string };
  email?: string;
  mail?: { inboxId: string; podId: string; past?: string[] };
};
type StateLike = { installId?: string; bots?: StateBot[]; workspaces?: { id: string; line?: { phone?: string } }[] };

/** The default workspace's main bot, from the user's last state upload, with the install it's on. */
export type MainBot = { bot: StateBot & { name: string }; installId: string; state: StateLike };

/** Null before the Mac has uploaded a state with a main bot (then the next upload, or session, sets it up). */
export async function mainBotOf(userId: string): Promise<MainBot | null> {
  const state = (await loadState(userId))?.state as StateLike | undefined;
  const bot = state?.bots?.find((b) => b?.isMain && (b.workspaceId ?? MAIN_WORKSPACE) === MAIN_WORKSPACE && typeof b.id === "string");
  if (!state?.installId || !bot) return null;
  return { bot: { ...bot, name: typeof bot.name === "string" && bot.name.trim() ? bot.name.trim() : "Boppy" }, installId: state.installId, state };
}

/** A bot's name as the app makes its address from it (lib/server/mail.ts slugify): "Boppy" → "boppy". */
export const addressName = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "team";

/** What a provider failure says, for bops.*.problem (never a key or a body). */
const why = (e: unknown) => (e instanceof ProviderError ? e.message : `${(e as Error)?.message ?? e}`).slice(0, 300);

/* ---------------- The number ---------------- */

type ApNumber = { id: string; phoneNumber: string; agentId?: string | null; externalId?: string | null; voiceRouting?: { method?: string } | null };
type ApAgent = { id: string; description?: string | null };
type LineRow = { digits: string; number_id: string | null; e164: string; agent_id: string | null; status: PlanItemStatus; problem: string | null };

const phoneOut = (r: LineRow): PlanPhone => ({ number: r.e164, numberId: r.number_id ?? "", agentId: r.agent_id ?? "", status: r.status, ...(r.problem ? { problem: r.problem } : {}) });

/** The plan's line that's still the user's (not given back), newest first. */
async function planLine(userId: string): Promise<LineRow | null> {
  const r = await query<LineRow>(
    "SELECT digits, number_id, e164, agent_id, status, problem FROM bops.phone_lines WHERE user_id = $1 AND plan AND status <> 'released' ORDER BY created_at DESC LIMIT 1",
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Whether the main bot has a number that isn't the plan's: its own (Bot.phone), the workspace's, or a line the cloud has for it. */
async function ownNumberOf(userId: string, main: MainBot): Promise<boolean> {
  // A plan's number given back while the Mac was away is still on the bot in its last upload: that one isn't its own.
  const given = main.bot.phoneLine?.numberId
    ? await query("SELECT 1 FROM bops.phone_lines WHERE user_id = $1 AND number_id = $2 AND plan AND status = 'released'", [userId, main.bot.phoneLine.numberId])
    : null;
  if ((main.bot.phone || main.bot.phoneLine) && !given?.rowCount) return true;
  if (main.state.workspaces?.find((w) => w?.id === MAIN_WORKSPACE)?.line?.phone) return true;
  const r = await query("SELECT 1 FROM bops.phone_lines WHERE user_id = $1 AND NOT plan AND status <> 'released' AND (bot_id = $2 OR workspace_id = $3) LIMIT 1", [userId, main.bot.id, MAIN_WORKSPACE]);
  return !!r.rowCount;
}

async function setLine(digits: string, status: PlanItemStatus, problem: string | null) {
  await query("UPDATE bops.phone_lines SET status = $2, problem = $3, checked_at = now(), updated_at = now() WHERE digits = $1", [digits, status, problem]);
}

/**
 * The plan's number for the main bot: made (or picked up again: paused, broken, cut short) and read
 * back. Null when there's nothing to do: AgentPhone isn't set up here, or the bot has a number of its own.
 * `changed`: something was made or its status moved, so the Mac should hear about it.
 */
export async function ensurePlanPhone(userId: string, main: MainBot): Promise<{ phone: PlanPhone; changed: boolean } | null> {
  const sub = (await accountFor(userId))?.agentphoneSubAccount;
  if (!config.agentphoneKey() || !sub) return null;
  const kept = await planLine(userId);
  if (kept?.status === "ready") return { phone: phoneOut(kept), changed: false };
  if (!kept && (await ownNumberOf(userId, main))) return null;
  const ap = <T>(method: string, path: string, body?: unknown) => agentphone<T>(path, method, body, sub);
  const tag = `bops-${main.installId}-${main.bot.id}`;
  let digits = kept?.digits ?? "";
  try {
    const numbers = listOf<ApNumber>(await ap("GET", "/v1/numbers?limit=100"));
    let number = kept ? numbers.find((n) => n.id === kept.number_id) : numbers.find((n) => n.externalId === tag);
    if (kept && !number) {
      // AgentPhone no longer has it (given back by hand): it's gone, and a new one is bought below.
      await setLine(kept.digits, "released", "AgentPhone no longer has this number");
      digits = "";
    }
    const agents = number?.agentId ? [] : listOf<ApAgent>(await ap("GET", "/v1/agents?limit=100"));
    const agentId =
      number?.agentId ??
      (kept && number ? kept.agent_id : null) ??
      agents.find((a) => a.description === tag)?.id ??
      (await ap<{ id: string }>("POST", "/v1/agents", { name: `${main.bot.name} (Bops)`, description: tag, voiceMode: "webhook", enableMessaging: true })).id;
    const bought = !number;
    if (!number) {
      number = await ap<ApNumber>("POST", "/v1/numbers", { country: "US", areaCode: config.phoneArea(), type: "sms", externalId: tag, agentId });
      // Included in the plan: counted, but not taken from the AI credit (pricing.ts has no price for this kind).
      await recordUsage(userId, "agentphone.plan_numbers", 1, { numberId: number.id }).catch((e: Error) => console.warn(`[provision] ${userId}: usage: ${e.message}`));
      trackCloudEvent(userId, "bops_phone_number_added", { added_via: "plan" }, { once: number.id });
    }
    // Bought on its agent. One found again, or bought and answered as on no agent, is put on it.
    if (number.agentId !== agentId && !(bought && number.agentId === undefined)) await ap("POST", `/v1/agents/${encodeURIComponent(agentId)}/numbers`, { numberId: number.id });
    digits = lineDigits(number.phoneNumber);
    if (!digits) throw new Error(`${number.phoneNumber} isn't a US or Canadian number`);
    // Kept before it's wired, so a call that comes in meanwhile finds its user.
    await query(
      `INSERT INTO bops.cloud_numbers (digits, user_id, number_id, e164) VALUES ($1, $2, $3, $4)
       ON CONFLICT (digits) DO UPDATE SET user_id = EXCLUDED.user_id, number_id = EXCLUDED.number_id, e164 = EXCLUDED.e164, updated_at = now()`,
      [digits, userId, number.id, number.phoneNumber],
    );
    // No window for a first caller yet: nobody may be watching (the Mac can be closed), and a stranger
    // texting a new number in those 15 minutes would become its owner. The app opens it when it shows
    // the user the number (lib/server/cloud-plan.ts); the user's verified numbers count as them meanwhile.
    await recordLine(userId, number, { botId: main.bot.id, workspaceId: MAIN_WORKSPACE });
    await query("UPDATE bops.phone_lines SET plan = true, agent_id = $2, status = 'setting_up', paused_at = NULL, problem = NULL, updated_at = now() WHERE digits = $1", [digits, agentId]);
    // Its texts and calls come to the cloud through the agent's webhook, whose secret the cloud keeps.
    // One already there is left as it is: registering it again would change its secret under
    // deliveries on their way.
    const hookUrl = `${config.publicUrl()}/hooks/agentphone`;
    if (!config.publicUrl()) throw new Error("this cloud has no public address for webhooks (BOPS_CLOUD_PUBLIC_URL)");
    const hooked =
      (await ap<{ url?: string }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/webhook`).catch(() => null))?.url === hookUrl &&
      !!(await query("SELECT 1 FROM bops.cloud_agents WHERE agent_id = $1 AND user_id = $2 AND secret_sealed IS NOT NULL", [agentId, userId])).rowCount;
    if (!hooked) {
      const hook = await ap<{ secret?: string }>("POST", `/v1/agents/${encodeURIComponent(agentId)}/webhook`, { url: hookUrl, contextLimit: 10, timeout: 30 });
      if (!hook.secret) throw new Error("AgentPhone didn't give its webhook's secret");
      await query(
        `INSERT INTO bops.cloud_agents (agent_id, user_id, secret_sealed) VALUES ($1, $2, $3)
         ON CONFLICT (agent_id) DO UPDATE SET user_id = EXCLUDED.user_id, secret_sealed = EXCLUDED.secret_sealed, updated_at = now()`,
        [agentId, userId, seal(hook.secret)],
      );
    }
    await ap("PATCH", `/v1/agents/${encodeURIComponent(agentId)}`, { voiceMode: "webhook" });
    const routed = await ap<ApNumber>("PATCH", `/v1/numbers/${encodeURIComponent(number.id)}/voice-routing`, { method: "agent" });
    // Ready only once AgentPhone says so: the number on the agent (read from its list, as the app's
    // lineUpkeep reads it), its calls going to the agent, and the agent's webhook the cloud's.
    const back = listOf<ApNumber>(await ap("GET", "/v1/numbers?limit=100")).find((n) => n.id === number.id);
    const webhook = await ap<{ url?: string }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/webhook`);
    const routing = back?.voiceRouting?.method ?? routed?.voiceRouting?.method;
    // A list that doesn't say a number's agent at all (no agentId field) can't be checked for it; one
    // that says none (null) or another is a number not on its agent.
    const onAgent = back?.agentId === agentId || back?.agentId === undefined;
    const problem = !back
      ? "AgentPhone doesn't list the number"
      : !onAgent
        ? back.agentId
          ? "the number is attached to another agent"
          : "the number isn't on its agent"
        : routing !== "agent"
          ? routing
            ? "its calls don't go to its agent"
            : "AgentPhone didn't say where its calls go"
          : webhook.url !== hookUrl
            ? "its texts and calls don't come to Bops Cloud"
            : null;
    await setLine(digits, problem ? "broken" : "ready", problem);
  } catch (e) {
    console.warn(`[provision] ${userId}: the plan's number: ${why(e)}`);
    if (!digits) return { phone: { number: "", numberId: "", agentId: "", status: "broken", problem: why(e) }, changed: false };
    await setLine(digits, "broken", why(e));
  }
  const row = (await query<LineRow>("SELECT digits, number_id, e164, agent_id, status, problem FROM bops.phone_lines WHERE digits = $1", [digits])).rows[0];
  return { phone: phoneOut(row), changed: true };
}

/* ---------------- The inbox ---------------- */

type InboxRow = { inbox_id: string; pod_id: string; email: string; handle: string | null; status: PlanItemStatus; problem: string | null };
type AmInbox = { inbox_id?: string; email?: string; pod_id?: string };

const inboxOut = (r: InboxRow): PlanInbox => ({
  email: r.email,
  inboxId: r.inbox_id,
  podId: r.pod_id,
  handle: r.handle ?? r.email.split("@")[1]?.split(".")[0] ?? "",
  status: r.status,
  ...(r.problem ? { problem: r.problem } : {}),
});

async function planInbox(userId: string): Promise<InboxRow | null> {
  const r = await query<InboxRow>("SELECT inbox_id, pod_id, email, handle, status, problem FROM bops.mail_inboxes WHERE user_id = $1 AND plan AND status <> 'released' ORDER BY created_at DESC LIMIT 1", [userId]);
  return r.rows[0] ?? null;
}

async function setInbox(inboxId: string, status: PlanItemStatus, problem: string | null) {
  await query("UPDATE bops.mail_inboxes SET status = $2::text, problem = $3, checked_at = now(), paused_at = CASE WHEN $2::text = 'paused' THEN paused_at END, updated_at = now() WHERE inbox_id = $1", [
    inboxId,
    status,
    problem,
  ]);
}

/** Whether AgentMail has the inbox (null: it couldn't be asked). */
async function inboxThere(podId: string, inboxId: string): Promise<boolean | null> {
  try {
    const got = await agentmail<AmInbox>(`/v0/pods/${encodeURIComponent(podId)}/inboxes/${encodeURIComponent(inboxId)}`);
    return got.inbox_id === inboxId || got.email?.toLowerCase() === inboxId.toLowerCase();
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) return false;
    return null;
  }
}

/**
 * The plan's inbox for the main bot, on the default workspace's handle (claimed from the suggestion
 * when it has none: `handle.auto`). Null when there's nothing to do: AgentMail or bops.bot isn't
 * ready here, or the bot has an inbox of its own.
 */
export async function ensurePlanInbox(userId: string, main: MainBot): Promise<{ email: PlanInbox; changed: boolean; handle?: MailHandleClaim } | null> {
  const podId = (await accountFor(userId))?.agentmailPodId;
  if (!config.agentmailKey() || !podId) return null;
  const kept = await planInbox(userId);
  if (kept?.status === "ready") return { email: inboxOut(kept), changed: false };
  if (!kept && (main.bot.mail || main.bot.email)) {
    // Its own inbox, unless it's a plan's that was given back while the Mac was away (still in its last upload).
    const given = main.bot.mail?.inboxId
      ? await query("SELECT 1 FROM bops.mail_inboxes WHERE user_id = $1 AND inbox_id = $2 AND plan AND status = 'released'", [userId, main.bot.mail.inboxId])
      : null;
    if (!given?.rowCount) return null;
  }
  if (kept) {
    const there = await inboxThere(kept.pod_id, kept.inbox_id);
    if (there) {
      await setInbox(kept.inbox_id, "ready", null);
      return { email: inboxOut({ ...kept, status: "ready", problem: null }), changed: true };
    }
    if (there === null) return { email: inboxOut(kept), changed: false };
    await setInbox(kept.inbox_id, "released", "AgentMail no longer has this inbox");
  }
  const domain = await mailDomain();
  if (!domain) return null;
  const handle = await claimHandle({ id: userId }, MAIN_WORKSPACE);
  const user = addressName(main.bot.name);
  // The app's client id for this bot's inbox on this handle (lib/server/mail.ts makeInbox): AgentMail hands back the same inbox for it, so the app and the cloud never make two.
  const clientId = `bops-${main.installId}-${main.bot.id}-own${user === addressName(main.bot.id.replace(/-\d+$/, "")) ? "" : `-${user}`}-${handle.handle}`;
  let made: AmInbox | null = null;
  try {
    // An address someone had on this subdomain before handles (sam@acme.bops.bot) is taken: sam2, sam3…
    for (let n = 1; n <= 5 && !made; n++) {
      try {
        made = await agentmail<AmInbox>(`/v0/pods/${encodeURIComponent(podId)}/inboxes`, "POST", {
          username: n === 1 ? user : `${user}${n}`,
          domain: `${handle.handle}.${domain}`,
          display_name: main.bot.name,
          client_id: n === 1 ? clientId : `${clientId}-${n}`,
          metadata: { bops_install: main.installId, bops_workspace: MAIN_WORKSPACE, bops_bot: main.bot.id, bops_plan: "1" },
        });
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 409)) throw e;
      }
    }
    if (!made?.inbox_id || !made.email) throw new Error("AgentMail made no inbox (every address tried was taken)");
  } catch (e) {
    console.warn(`[provision] ${userId}: the plan's inbox: ${why(e)}`);
    return { email: { email: "", inboxId: "", podId, handle: handle.handle, status: "broken", problem: why(e) }, changed: false, handle };
  }
  await query(
    `INSERT INTO bops.mail_inboxes (inbox_id, user_id, pod_id, email, bot_id, workspace_id, handle, plan, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'setting_up')
     ON CONFLICT (inbox_id) DO UPDATE SET user_id = EXCLUDED.user_id, pod_id = EXCLUDED.pod_id, email = EXCLUDED.email, bot_id = EXCLUDED.bot_id,
       workspace_id = EXCLUDED.workspace_id, handle = EXCLUDED.handle, plan = true, status = 'setting_up', problem = NULL, paused_at = NULL, updated_at = now()`,
    [made.inbox_id, userId, podId, made.email, main.bot.id, MAIN_WORKSPACE, handle.handle],
  );
  const there = await inboxThere(podId, made.inbox_id);
  await setInbox(made.inbox_id, there ? "ready" : "broken", there ? null : there === false ? "AgentMail doesn't have the inbox it just made" : "AgentMail couldn't be asked about the inbox");
  const row = (await query<InboxRow>("SELECT inbox_id, pod_id, email, handle, status, problem FROM bops.mail_inboxes WHERE inbox_id = $1", [made.inbox_id])).rows[0];
  return { email: inboxOut(row), changed: true, handle };
}

/* ---------------- Paused and given back ---------------- */

/** The plan ended: its number and inbox are paused (calls, texts and mail on them aren't answered). What changed. */
export async function pausePlanItems(userId: string): Promise<{ phone?: PlanPhone; email?: PlanInbox }> {
  const lines = await query<LineRow>(
    `UPDATE bops.phone_lines SET status = 'paused', paused_at = COALESCE(paused_at, now()), checked_at = now(), updated_at = now()
     WHERE user_id = $1 AND plan AND status IN ('setting_up', 'ready', 'broken')
     RETURNING digits, number_id, e164, agent_id, status, problem`,
    [userId],
  );
  const inboxes = await query<InboxRow>(
    `UPDATE bops.mail_inboxes SET status = 'paused', paused_at = COALESCE(paused_at, now()), checked_at = now(), updated_at = now()
     WHERE user_id = $1 AND plan AND status IN ('setting_up', 'ready', 'broken')
     RETURNING inbox_id, pod_id, email, handle, status, problem`,
    [userId],
  );
  return { ...(lines.rows[0] ? { phone: phoneOut(lines.rows[0]) } : {}), ...(inboxes.rows[0] ? { email: inboxOut(inboxes.rows[0]) } : {}) };
}

/** How long a paused plan's number and inbox are kept before they're given back. */
export const RELEASE_AFTER_DAYS = 30;

/** Runs one user's release holding their plan lock (plans.ts), so a plan setting things up again can't run at the same time. */
type Guard = <T>(userId: string, work: () => Promise<T>) => Promise<T>;

/**
 * Give back what was paused 30 days ago and still is (the user is still on Free): the number to
 * AgentPhone (DELETE /v1/numbers/{id}), the inbox to AgentMail. Each is looked at again under the
 * user's lock (`guard`) before it goes, so an upgrade that came meanwhile keeps it. Each released one
 * is told to its user's Mac through `tell`. A provider that fails, or isn't set up here, leaves it
 * paused (and still the user's), for the next sweep.
 */
export async function releaseAfterPause(tell: (userId: string, item: { phone?: PlanPhone; email?: PlanInbox }) => Promise<void>, guard: Guard = (_userId, work) => work()): Promise<number> {
  let released = 0;
  const lines = await query<LineRow & { user_id: string }>(
    `SELECT l.digits, l.number_id, l.e164, l.agent_id, l.status, l.problem, l.user_id
     FROM bops.phone_lines l
     JOIN bops.cloud_accounts a ON a.user_id = l.user_id
     LEFT JOIN bops.plans p ON p.user_id = l.user_id
     WHERE l.plan AND l.status = 'paused' AND l.paused_at < now() - make_interval(days => $1) AND COALESCE(p.tier, 'free_bops') = 'free_bops'
     LIMIT 100`,
    [RELEASE_AFTER_DAYS],
  );
  for (const l of lines.rows) {
    const gone = await guard(l.user_id, async () => {
      const still = await query<{ sub: string | null }>(
        `SELECT a.agentphone_sub_account AS sub FROM bops.phone_lines l
         JOIN bops.cloud_accounts a ON a.user_id = l.user_id
         LEFT JOIN bops.plans p ON p.user_id = l.user_id
         WHERE l.digits = $1 AND l.user_id = $2 AND l.plan AND l.status = 'paused' AND l.paused_at < now() - make_interval(days => $3) AND COALESCE(p.tier, 'free_bops') = 'free_bops'`,
        [l.digits, l.user_id, RELEASE_AFTER_DAYS],
      );
      const sub = still.rows[0]?.sub;
      if (!still.rowCount) return false;
      if (!l.number_id || !sub || !config.agentphoneKey()) {
        console.warn(`[provision] ${l.user_id}: couldn't give back ${l.e164}: AgentPhone isn't set up here`);
        return false;
      }
      try {
        await agentphone(`/v1/numbers/${encodeURIComponent(l.number_id)}`, "DELETE", undefined, sub);
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 404)) {
          console.warn(`[provision] ${l.user_id}: couldn't give back ${l.e164}: ${why(e)}`);
          return false;
        }
      }
      await query("UPDATE bops.phone_lines SET status = 'released', problem = NULL, checked_at = now(), updated_at = now() WHERE digits = $1 AND status = 'paused'", [l.digits]);
      await query("DELETE FROM bops.cloud_numbers WHERE digits = $1 AND user_id = $2", [l.digits, l.user_id]);
      return true;
    }).catch((e: Error) => (console.warn(`[provision] ${l.user_id}: couldn't give back ${l.e164}: ${e.message}`), false));
    if (!gone) continue;
    released++;
    await tell(l.user_id, { phone: phoneOut({ ...l, status: "released", problem: null }) }).catch(() => {});
  }
  const inboxes = await query<InboxRow & { user_id: string }>(
    `SELECT i.inbox_id, i.pod_id, i.email, i.handle, i.status, i.problem, i.user_id
     FROM bops.mail_inboxes i LEFT JOIN bops.plans p ON p.user_id = i.user_id
     WHERE i.plan AND i.status = 'paused' AND i.paused_at < now() - make_interval(days => $1) AND COALESCE(p.tier, 'free_bops') = 'free_bops'
     LIMIT 100`,
    [RELEASE_AFTER_DAYS],
  );
  for (const i of inboxes.rows) {
    const gone = await guard(i.user_id, async () => {
      const still = await query(
        `SELECT 1 FROM bops.mail_inboxes i LEFT JOIN bops.plans p ON p.user_id = i.user_id
         WHERE i.inbox_id = $1 AND i.plan AND i.status = 'paused' AND i.paused_at < now() - make_interval(days => $2) AND COALESCE(p.tier, 'free_bops') = 'free_bops'`,
        [i.inbox_id, RELEASE_AFTER_DAYS],
      );
      if (!still.rowCount) return false;
      if (!config.agentmailKey()) {
        console.warn(`[provision] ${i.user_id}: couldn't give back ${i.email}: AgentMail isn't set up here`);
        return false;
      }
      try {
        await agentmail(`/v0/pods/${encodeURIComponent(i.pod_id)}/inboxes/${encodeURIComponent(i.inbox_id)}`, "DELETE");
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 404)) {
          console.warn(`[provision] ${i.user_id}: couldn't give back ${i.email}: ${why(e)}`);
          return false;
        }
      }
      await query("UPDATE bops.mail_inboxes SET status = 'released', problem = NULL, checked_at = now(), updated_at = now() WHERE inbox_id = $1 AND status = 'paused'", [i.inbox_id]);
      return true;
    }).catch((e: Error) => (console.warn(`[provision] ${i.user_id}: couldn't give back ${i.email}: ${e.message}`), false));
    if (!gone) continue;
    released++;
    await tell(i.user_id, { email: inboxOut({ ...i, status: "released", problem: null }) }).catch(() => {});
  }
  return released;
}
