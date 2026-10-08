import assert from "node:assert/strict";
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { seal } from "../crypto.ts";
import { closeDb, query } from "../db.ts";
import { planTiming, settle, sweep } from "../plans.ts";
import { releaseAfterPause } from "../provision.ts";
import { call, dropUsers, fakeProvider, gate, keyOf, listen, newUserId, prepareDb, startCloud, until, type Got, type Listening } from "./core-fakes.ts";

/**
 * Plans (plans.ts, provision.ts): orgo-web's signed notice, and the cloud's own read at a session
 * start, set up the main bot's number and inbox with the Mac closed, read each back before calling
 * it ready, tell the Mac, pause both when the plan ends (calls and texts go unanswered, texts out are
 * refused), give them back 30 days later, and, with plan limits on, keep Free from buying a number.
 * Never two numbers: not for notices and sessions at once, a purchase whose answer was lost, or the
 * app buying the main bot's own meanwhile. A first caller can't claim the number before the app shows
 * it, and a burst of users never takes the whole database pool.
 */

const SECRET = randomBytes(32).toString("base64");
const users: string[] = [];
let orgo: Listening, cloud: Listening;
let agentphone: Awaited<ReturnType<typeof fakeProvider>>, agentmail: Awaited<ReturnType<typeof fakeProvider>>;

/** What orgo-web says each user's plan is (GET /api/bops/plan). */
const orgoTiers = new Map<string, string>();

/** AgentPhone, per sub-account: numbers (with their agent and routing), agents (with their webhook). */
type FakeNumber = { id: string; phoneNumber: string; externalId?: string; agentId?: string | null; voiceRouting: { method: string }; sub: string; released?: boolean };
type FakeAgent = { id: string; name: string; description?: string; voiceMode?: string; webhook?: { url: string; secret: string }; sub: string };
const numbers: FakeNumber[] = [];
const agents: FakeAgent[] = [];
/**
 * Breaks one step for a test: AgentPhone ignores the change to where a number's calls go
 * (`routingIgnored`), buys a number but its answer never arrives (`buyAnswerLost`), buys it on no
 * agent (`buyOffAgent`), ignores putting a number on an agent (`attachIgnored`), or holds each
 * purchase until the test lets it go (`buyHeld`; `buysWaiting` counts the ones held).
 */
const breaks = { routingIgnored: false, buyAnswerLost: false, buyOffAgent: false, attachIgnored: false, buyHeld: null as Promise<void> | null };
let buysWaiting = 0;
/** AgentMail: inboxes by id, per pod; an address another pod has is taken (409). */
const inboxes: { inbox_id: string; email: string; pod_id: string; client_id?: string }[] = [];

const posts = (p: { got: Got[] }, path: RegExp) => p.got.filter((g) => g.method === "POST" && path.test(g.path));

before(async () => {
  await prepareDb();
  orgo = await listen(
    createServer((req, res) => {
      const userId = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (!userId) return void res.writeHead(401).end("{}");
      if (req.url === "/api/user/profile") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: userId, email: `${userId}@example.com` }));
      if (req.url === "/api/bops/plan" && orgoTiers.has(userId)) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tier: orgoTiers.get(userId) }));
      res.writeHead(404).end("{}");
    }),
  );
  agentphone = await fakeProvider(async (g) => {
    const sub = String(g.headers["x-sub-account-id"] ?? "");
    const mine = numbers.filter((n) => n.sub === sub && !n.released);
    if (g.method === "GET" && g.path === "/v1/numbers") return { json: { data: mine } };
    if (g.method === "POST" && g.path === "/v1/numbers") {
      if (breaks.buyHeld) {
        buysWaiting++;
        await breaks.buyHeld;
        buysWaiting--;
      }
      const n: FakeNumber = {
        id: `num_${numbers.length + 1}`,
        phoneNumber: `+1415555${String(randomInt(0, 10_000)).padStart(4, "0")}`,
        externalId: g.json.externalId,
        agentId: breaks.buyOffAgent ? null : (g.json.agentId ?? null),
        voiceRouting: { method: "none" },
        sub,
      };
      numbers.push(n);
      if (breaks.buyAnswerLost) {
        breaks.buyAnswerLost = false;
        return { status: 504, json: { detail: "timed out" } };
      }
      return { json: n };
    }
    if (g.method === "POST" && g.path === "/v1/messages") return { json: { id: `msg_${randomBytes(4).toString("hex")}`, status: "queued" } };
    let m = /^\/v1\/numbers\/([^/]+)$/.exec(g.path);
    if (m) {
      const n = mine.find((x) => x.id === m![1]);
      if (!n) return { status: 404, json: { detail: "not found" } };
      if (g.method === "DELETE") {
        n.released = true;
        return { json: { ok: true } };
      }
      return { json: n };
    }
    m = /^\/v1\/numbers\/([^/]+)\/voice-routing$/.exec(g.path);
    if (m && g.method === "PATCH") {
      const n = mine.find((x) => x.id === m![1]);
      if (!n) return { status: 404 };
      if (!breaks.routingIgnored) n.voiceRouting = { method: g.json.method };
      return { json: n };
    }
    if (g.method === "GET" && g.path === "/v1/agents") return { json: { data: agents.filter((a) => a.sub === sub) } };
    if (g.method === "POST" && g.path === "/v1/agents") {
      const a: FakeAgent = { id: `agent_${agents.length + 1}`, name: g.json.name, description: g.json.description, voiceMode: g.json.voiceMode, sub };
      agents.push(a);
      return { json: a };
    }
    m = /^\/v1\/agents\/([^/]+)(\/webhook|\/numbers)?$/.exec(g.path);
    const agent = m ? agents.find((a) => a.id === m![1] && a.sub === sub) : undefined;
    if (m && !agent) return { status: 404 };
    if (agent && m![2] === "/webhook") {
      if (g.method === "POST") agent.webhook = { url: g.json.url, secret: `whsec_${agent.id}` };
      return { json: { url: agent.webhook?.url, secret: agent.webhook?.secret } };
    }
    if (agent && m![2] === "/numbers" && g.method === "POST") {
      const n = mine.find((x) => x.id === g.json.numberId);
      if (n && !breaks.attachIgnored) n.agentId = agent.id;
      return { json: { ...agent, numbers: n ? [n] : [] } };
    }
    if (agent && g.method === "PATCH") {
      Object.assign(agent, g.json);
      return { json: agent };
    }
    return { status: 418 };
  });
  agentmail = await fakeProvider((g) => {
    if (g.method === "GET" && g.path === "/v0/domains") return { json: { domains: [{ domain: "bops.bot", status: "VERIFIED", subdomains_enabled: true }] } };
    const m = /^\/v0\/pods\/([^/]+)\/inboxes(?:\/([^/]+))?$/.exec(g.path);
    if (!m) return { status: 418 };
    const [, pod, id] = m;
    if (g.method === "POST" && !id) {
      const same = inboxes.find((x) => x.pod_id === pod && x.client_id && x.client_id === g.json.client_id);
      if (same) return { json: same };
      const email = `${g.json.username}@${g.json.domain}`;
      if (inboxes.some((x) => x.email === email)) return { status: 409, json: { name: "AlreadyExistsError" } };
      const inbox = { inbox_id: email, email, pod_id: pod, client_id: g.json.client_id };
      inboxes.push(inbox);
      return { json: inbox };
    }
    const inbox = inboxes.find((x) => x.pod_id === pod && x.inbox_id === decodeURIComponent(id ?? ""));
    if (!inbox) return { status: 404, json: { name: "NotFoundError" } };
    if (g.method === "DELETE") {
      inboxes.splice(inboxes.indexOf(inbox), 1);
      return { json: {} };
    }
    return { json: inbox };
  });
  Object.assign(process.env, {
    BOPS_ORGO_ORIGIN: orgo.url,
    BOPS_UPSTREAM_AGENTPHONE: agentphone.url,
    BOPS_UPSTREAM_AGENTMAIL: agentmail.url,
    AGENTPHONE_API_KEY: "ap-test-not-a-real-key",
    AGENTMAIL_API_KEY: "am-test-not-a-real-key",
    BOPS_CLOUD_PLAN_SECRET: SECRET,
  });
  planTiming.settleGapMs = 0;
  cloud = await startCloud();
});

after(async () => {
  await dropUsers(users);
  await Promise.all([cloud?.close(), orgo?.close(), agentphone?.close(), agentmail?.close()]);
  await closeDb();
});

beforeEach(() => {
  Object.assign(breaks, { routingIgnored: false, buyAnswerLost: false, buyOffAgent: false, attachIgnored: false, buyHeld: null });
  delete process.env.BOPS_PLAN_LIMITS;
});

/** A user as their first session and state upload leave them: a pod (and its key), a sub-account, and a main bot. */
async function paidUser(opts: { mainBot?: Record<string, unknown>; noState?: boolean } = {}) {
  const id = newUserId("plan");
  users.push(id);
  const name = `Tiger ${randomBytes(3).toString("hex")}`;
  const state = { installId: "inst1", account: { user: { id, name } }, bots: [{ id: "boppy", name: "Boppy", isMain: true, computerStatus: "none", ...opts.mainBot }, { id: "sam", name: "Sam", isMain: false }] };
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, $2::jsonb, 1)", [id, JSON.stringify(opts.noState ? {} : state)]);
  await query("INSERT INTO bops.cloud_accounts (user_id, email, agentmail_pod_id, agentmail_key_sealed, agentphone_sub_account) VALUES ($1, $2, $3, $4, $5)", [
    id,
    `${id}@example.com`,
    `pod_${id}`,
    seal("am_pod_key"),
    `sub_${id}`,
  ]);
  return { id, handle: name.toLowerCase().replace(" ", "-"), state };
}

/** orgo-web's notice, signed as lib/billing/bops-cloud-notify.ts signs it. */
function notice(body: Record<string, unknown>, opts: { secret?: string; at?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const sig = `sha256=${createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${raw}`).digest("hex")}`;
  return fetch(`${cloud.url}/v1/internal/plan-changed`, { method: "POST", headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": sig }, body: raw }).then(async (r) => ({
    status: r.status,
    json: (await r.json().catch(() => null)) as Record<string, unknown> | null,
  }));
}
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

const line = async (userId: string) =>
  (await query<{ digits: string; number_id: string; e164: string; bot_id: string; workspace_id: string; plan: boolean; status: string; problem: string | null; claim_until: Date | null; agent_id: string; paused_at: Date | null }>(
    "SELECT digits, number_id, e164, bot_id, workspace_id, plan, status, problem, claim_until, agent_id, paused_at FROM bops.phone_lines WHERE user_id = $1 ORDER BY created_at",
    [userId],
  )).rows;
const inbox = async (userId: string) =>
  (await query<{ inbox_id: string; email: string; bot_id: string; handle: string; status: string; problem: string | null; paused_at: Date | null }>(
    "SELECT inbox_id, email, bot_id, handle, status, problem, paused_at FROM bops.mail_inboxes WHERE user_id = $1 ORDER BY created_at",
    [userId],
  )).rows;
const planEvents = async (userId: string) =>
  (await query<{ payload: Record<string, unknown> }>("SELECT payload FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'plan' ORDER BY id", [userId])).rows.map((r) => r.payload);
const bought = (userId: string) => posts(agentphone, /^\/v1\/numbers$/).filter((g) => g.headers["x-sub-account-id"] === `sub_${userId}`);

test("the notice is refused unsigned, signed wrong, too old or malformed; and is 404 with no secret set", async () => {
  const { id } = await paidUser();
  assert.equal((await fetch(`${cloud.url}/v1/internal/plan-changed`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await notice({ userId: id, tier: "pro_bops", at: at() }, { secret: "not-it" })).status, 401);
  assert.equal((await notice({ userId: id, tier: "pro_bops", at: at() }, { at: Date.now() - 10 * 60_000 })).status, 401);
  assert.equal((await notice({ userId: id, tier: "gold", at: at() })).status, 400);
  assert.equal((await notice({ userId: id, tier: "pro_bops" })).status, 400);
  delete process.env.BOPS_CLOUD_PLAN_SECRET;
  try {
    assert.equal((await notice({ userId: id, tier: "pro_bops", at: at() })).status, 404);
  } finally {
    process.env.BOPS_CLOUD_PLAN_SECRET = SECRET;
  }
  assert.equal(bought(id).length, 0);
});

test("an upgrade gives the main bot one number and one inbox with the Mac closed, ready only once read back, and tells the Mac", async () => {
  const { id, handle } = await paidUser();
  const r = await notice({ userId: id, tier: "pro_bops", at: at() });
  assert.deepEqual(r, { status: 200, json: { ok: true, applied: true } });
  const [l] = await until(async () => ((await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready" ? line(id) : null), "the number and inbox");
  // The number: bought once in the user's own sub-account, tagged as the app tags it, on an agent whose webhook is the cloud.
  const [buy] = bought(id);
  assert.equal(bought(id).length, 1);
  assert.deepEqual({ ...buy.json, areaCode: undefined }, { country: "US", areaCode: undefined, type: "sms", externalId: "bops-inst1-boppy", agentId: l.agent_id });
  const agent = agents.find((a) => a.id === l.agent_id)!;
  assert.equal(agent.description, "bops-inst1-boppy");
  assert.equal(agent.voiceMode, "webhook");
  assert.equal(agent.webhook?.url, "https://bops-api.test/hooks/agentphone");
  assert.equal(numbers.find((n) => n.id === l.number_id)?.voiceRouting.method, "agent");
  assert.deepEqual([l.plan, l.bot_id, l.workspace_id, l.problem], [true, "boppy", "ws_main", null]);
  assert.equal(l.claim_until, null, "no 15 minutes for a first caller until the app shows the user the number");
  // Its secret is the cloud's, sealed, so the webhook's deliveries check out.
  assert.equal((await query("SELECT user_id FROM bops.cloud_agents WHERE agent_id = $1", [l.agent_id])).rows[0]?.user_id, id);
  // Included with the plan: counted, nothing taken from the credit.
  assert.deepEqual((await query("SELECT kind, cost_micros::int AS cost FROM bops.cloud_usage WHERE user_id = $1", [id])).rows, [{ kind: "agentphone.plan_numbers", cost: 0 }]);
  // The inbox: on the user's own handle (from their Orgo name), with the client id the app would use.
  const [i] = await inbox(id);
  assert.equal(i.email, `boppy@${handle}.bops.bot`);
  assert.equal(inboxes.find((x) => x.email === i.email)?.client_id, `bops-inst1-boppy-own-${handle}`);
  assert.deepEqual((await query("SELECT handle, workspace_id, auto FROM bops.mail_handles WHERE user_id = $1", [id])).rows, [{ handle, workspace_id: "ws_main", auto: true }]);
  // The Mac hears about both.
  const last = await until(async () => (await planEvents(id)).find((e) => (e.email as { status?: string } | undefined)?.status === "ready"), "told the Mac");
  assert.equal(last.tier, "pro_bops");
  assert.equal(last.botId, "boppy");
  assert.deepEqual(last.phone, { number: l.e164, numberId: l.number_id, agentId: l.agent_id, status: "ready" });
  assert.deepEqual(last.email, { email: i.email, inboxId: i.inbox_id, podId: `pod_${id}`, handle, status: "ready" });
  assert.deepEqual(last.handle, { handle, auto: true, changesLeft: 3 });
});

test("the same notice again changes nothing; an older one never undoes a newer one", async () => {
  const { id } = await paidUser();
  const first = { userId: id, tier: "max_bops", at: at() };
  assert.equal((await notice(first)).json?.applied, true);
  await until(async () => (await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready" && (await planEvents(id)).length > 0, "set up and told");
  const events = (await planEvents(id)).length;
  assert.equal((await notice(first)).json?.applied, false, "the same notice is no news");
  assert.equal((await notice({ userId: id, tier: "free_bops", at: at(-60_000) })).json?.applied, false, "older than what's kept");
  // A newer notice of the same plan runs a check, which finds everything in place.
  assert.equal((await notice({ userId: id, tier: "max_bops", at: at(1000) })).json?.applied, true);
  await settle(id);
  assert.equal(bought(id).length, 1);
  assert.equal((await inbox(id)).length, 1);
  assert.equal((await line(id))[0].status, "ready");
  assert.equal((await planEvents(id)).length, events, "nothing new to tell the Mac");
});

test("a read-back that doesn't check out is broken, with the problem; the next check makes it ready", async () => {
  const { id } = await paidUser();
  breaks.routingIgnored = true;
  await notice({ userId: id, tier: "pro_bops", at: at() });
  const [l] = await until(async () => ((await line(id))[0]?.status === "broken" ? line(id) : null), "broken");
  assert.equal(l.problem, "its calls don't go to its agent");
  breaks.routingIgnored = false;
  await settle(id, { force: true });
  assert.equal((await line(id))[0].status, "ready");
  assert.equal(bought(id).length, 1, "the same number, set up again");
  assert.equal(posts(agentphone, new RegExp(`^/v1/agents/${l.agent_id}/webhook$`)).length, 1, "its webhook (and secret) left as it was");
});

test("a main bot with a number or an inbox of its own gets none from the plan", async () => {
  const { id } = await paidUser({ mainBot: { phone: "+14155550100", phoneLine: { numberId: "n_own", agentId: "a_own" }, email: "boppy@old.bops.bot", mail: { inboxId: "boppy@old.bops.bot", podId: "p" } } });
  await notice({ userId: id, tier: "pro_bops", at: at() });
  await until(async () => (await planEvents(id)).length > 0, "told the Mac");
  assert.equal(bought(id).length, 0);
  assert.equal((await inbox(id)).length, 0);
  assert.deepEqual((await planEvents(id)).at(-1), { tier: "pro_bops", botId: "boppy", workspaceId: "ws_main" });
});

test("before the Mac's first state upload the plan waits; the upload sets it up", async () => {
  const { id, state } = await paidUser({ noState: true });
  await notice({ userId: id, tier: "pro_bops", at: at() });
  await until(async () => (await planEvents(id)).length > 0, "told the Mac about the plan");
  assert.equal(bought(id).length, 0);
  const put = await call(cloud.url, "PUT", "/v1/state", { key: keyOf(id), json: { version: 2, state } });
  assert.equal(put.status, 200, put.text);
  await until(async () => (await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready", "set up after the upload");
});

test("the session start asks orgo-web, so an upgrade whose notice never came is set up when the app opens", async () => {
  const { id } = await paidUser();
  orgoTiers.set(id, "pro_bops");
  const r = await call(cloud.url, "POST", "/v1/session", { key: keyOf(id) });
  assert.equal(r.status, 200, r.text);
  await until(async () => (await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready", "set up from the session");
  assert.equal((await query("SELECT tier, source FROM bops.plans WHERE user_id = $1", [id])).rows[0].source, "session");
  // The next session says so, with the handle the inbox went on.
  const again = await call(cloud.url, "POST", "/v1/session", { key: keyOf(id) });
  assert.deepEqual(again.json.plan, { tier: "pro_bops", limits: false });
  assert.equal(again.json.agentmail.handle, (await inbox(id))[0].handle);
});

/** A delivery to one of the user's numbers, signed with its agent's secret (the fake's whsec_<agent>). */
function delivery(agentId: string, data: Record<string, unknown>, channel = "sms") {
  const body = JSON.stringify({ event: "agent.message", channel, agentId, data });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${cloud.url}/hooks/agentphone`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-id": `whd_${randomBytes(6).toString("hex")}`, "x-webhook-signature": `sha256=${createHmac("sha256", `whsec_${agentId}`).update(`${ts}.${body}`).digest("hex")}` },
    body,
  });
}

test("back to Free pauses both (calls and texts go unanswered); upgrading again picks them up; 30 days later they're given back", async () => {
  const { id } = await paidUser();
  await notice({ userId: id, tier: "pro_bops", at: at() });
  const [l] = await until(async () => ((await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready" ? line(id) : null), "set up");
  await notice({ userId: id, tier: "free_bops", at: at(1000) });
  const paused = await until(async () => (await planEvents(id)).find((e) => e.tier === "free_bops"), "paused and told");
  assert.deepEqual([(await line(id))[0].status, (await inbox(id))[0].status], ["paused", "paused"]);
  assert.equal(paused.tier, "free_bops");
  assert.equal((paused.phone as { status: string }).status, "paused");
  assert.equal((paused.email as { status: string }).status, "paused");
  // A text to it isn't kept for the Mac; a call is told the number is paused and ends.
  const text = await delivery(l.agent_id, { from: "+12125550123", to: l.e164, body: "hi" });
  assert.equal(text.status, 200);
  assert.equal((await query("SELECT count(*)::int AS n FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'agentphone'", [id])).rows[0].n, 0);
  const voice = await delivery(l.agent_id, { from: "+12125550123", to: l.e164, transcript: "hello" }, "voice");
  assert.deepEqual(await voice.json(), { text: "This number is paused right now. Goodbye.", hangup: true });
  // Upgrading within the 30 days: the same number and inbox, ready again.
  await notice({ userId: id, tier: "max_bops", at: at(2000) });
  await until(async () => (await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready", "resumed");
  assert.equal(bought(id).length, 1);
  assert.equal((await inbox(id)).length, 1);
  // Free again, and 30 days on: given back.
  await notice({ userId: id, tier: "free_bops", at: at(3000) });
  await until(async () => (await planEvents(id)).filter((e) => e.tier === "free_bops").length === 2, "paused again and told");
  await sweep();
  assert.equal((await line(id))[0].status, "paused", "not before 30 days");
  await query("UPDATE bops.phone_lines SET paused_at = now() - interval '31 days' WHERE user_id = $1", [id]);
  await query("UPDATE bops.mail_inboxes SET paused_at = now() - interval '31 days' WHERE user_id = $1", [id]);
  await sweep();
  assert.equal((await line(id))[0].status, "released");
  assert.equal((await inbox(id))[0].status, "released");
  assert.ok(agentphone.got.some((g) => g.method === "DELETE" && g.path === `/v1/numbers/${l.number_id}` && g.headers["x-sub-account-id"] === `sub_${id}`));
  assert.ok(numbers.find((n) => n.id === l.number_id)?.released);
  assert.equal(inboxes.some((x) => x.pod_id === `pod_${id}`), false);
  assert.equal((await query("SELECT count(*)::int AS n FROM bops.cloud_numbers WHERE user_id = $1", [id])).rows[0].n, 0);
  const released = (await planEvents(id)).slice(-2);
  assert.deepEqual(released.map((e) => (e.phone as { status?: string } | undefined)?.status ?? (e.email as { status?: string } | undefined)?.status), ["released", "released"]);
  // Upgrading after that, with the Mac's last upload still showing what was given back: a new number and inbox.
  const [gone] = await inbox(id);
  await query("UPDATE bops.app_state SET state = jsonb_set(jsonb_set(state, '{bots,0,phoneLine}', $2::jsonb), '{bots,0,mail}', $3::jsonb) WHERE user_id = $1", [
    id,
    JSON.stringify({ numberId: l.number_id, agentId: l.agent_id }),
    JSON.stringify({ inboxId: gone.inbox_id, podId: `pod_${id}` }),
  ]);
  await notice({ userId: id, tier: "pro_bops", at: at(4000) });
  await until(async () => (await line(id)).some((x) => x.status === "ready") && (await inbox(id)).some((x) => x.status === "ready"), "a new number and inbox");
  assert.equal(bought(id).length, 2);
});

test("with plan limits on, Free can't buy a number; a plan orgo-web just started can", async () => {
  const { id } = await paidUser();
  process.env.BOPS_PLAN_LIMITS = "1";
  const buy = () => call(cloud.url, "POST", "/proxy/agentphone/v1/numbers", { key: keyOf(id), json: { country: "US", areaCode: "415", type: "sms" } });
  let r = await buy();
  assert.equal(r.status, 402);
  assert.deepEqual([r.json.code, r.json.upgrade, r.json.upgradeTo], ["plan_required", true, "pro_bops"]);
  assert.equal(r.json.error, "Free doesn't include a phone number. Pro includes 1, and Max up to 5.");
  assert.equal(bought(id).length, 0, "nothing reached AgentPhone");
  // orgo-web says Max before its notice came: asked, and allowed (the plan's own number for the main
  // bot, which the session starts setting up, is one of Max's five).
  orgoTiers.set(id, "max_bops");
  r = await call(cloud.url, "POST", "/v1/session", { key: keyOf(id) });
  assert.deepEqual(r.json.plan, { tier: "free_bops", limits: true }, "the session before orgo-web was asked");
  await until(async () => (await query("SELECT tier FROM bops.plans WHERE user_id = $1", [id])).rows[0]?.tier === "max_bops", "the session's read");
  r = await buy();
  assert.equal(r.status, 200, r.text);
  delete process.env.BOPS_PLAN_LIMITS;
  // The plan's own setup, which the session started, finishes before the fakes go.
  await settle(id);
});

test("with plan limits on, Pro holds 1 number and Max up to 5, the plan's own included", async () => {
  const { id } = await paidUser();
  process.env.BOPS_PLAN_LIMITS = "1";
  orgoTiers.set(id, "pro_bops");
  await notice({ userId: id, tier: "pro_bops", at: at() });
  // The plan's number for the main bot: Pro's one.
  await until(async () => (await line(id))[0]?.status === "ready", "the plan's number");
  const buy = () => call(cloud.url, "POST", "/proxy/agentphone/v1/numbers", { key: keyOf(id), json: { country: "US", areaCode: "415", type: "sms" } });
  const before = bought(id).length;
  let r = await buy();
  assert.equal(r.status, 402, r.text);
  assert.deepEqual([r.json.code, r.json.upgrade, r.json.upgradeTo], ["plan_required", true, "max_bops"]);
  assert.equal(r.json.error, "Pro includes 1 phone number. Max includes up to 5.");
  assert.equal(bought(id).length, before, "nothing reached AgentPhone");
  // On Max, four more, one at a time as the user asks; a fifth more is refused, with nothing to upgrade to.
  orgoTiers.set(id, "max_bops");
  await notice({ userId: id, tier: "max_bops", at: at(1000) });
  for (let i = 0; i < 4; i++) {
    r = await buy();
    assert.equal(r.status, 200, r.text);
  }
  r = await buy();
  assert.equal(r.status, 402, r.text);
  assert.equal(r.json.code, "plan_limit");
  assert.equal(r.json.upgrade, undefined);
  assert.equal(r.json.error, "Max includes up to 5 phone numbers, and you have 5.");
  assert.equal((await line(id)).filter((l) => l.status !== "released").length, 5);
  assert.equal(bought(id).length, before + 4);
  delete process.env.BOPS_PLAN_LIMITS;
  await settle(id);
});

test("with plan limits on, a Pro user whose Max orgo-web hasn't announced yet is asked about before a refusal", async () => {
  const { id } = await paidUser();
  process.env.BOPS_PLAN_LIMITS = "1";
  orgoTiers.set(id, "pro_bops");
  await notice({ userId: id, tier: "pro_bops", at: at() });
  await until(async () => (await line(id))[0]?.status === "ready", "the plan's number");
  // Paid for Max a moment ago: orgo-web says so, its notice hasn't come.
  orgoTiers.set(id, "max_bops");
  const r = await call(cloud.url, "POST", "/proxy/agentphone/v1/numbers", { key: keyOf(id), json: { country: "US", areaCode: "415", type: "sms" } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await query<{ tier: string }>("SELECT tier FROM bops.plans WHERE user_id = $1", [id])).rows[0]?.tier, "max_bops");
  delete process.env.BOPS_PLAN_LIMITS;
  await settle(id);
});

const setUp = (id: string) => until(async () => ((await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready" ? (await line(id))[0] : null), "the number and inbox");
const tierKept = async (id: string) => (await query<{ tier: string }>("SELECT tier FROM bops.plans WHERE user_id = $1", [id])).rows[0]?.tier;

test("a plan's number set up with the Mac closed has no window for a first caller: a stranger texting it isn't its owner until the app shows it", async () => {
  const { id } = await paidUser();
  await notice({ userId: id, tier: "pro_bops", at: at() });
  const l = await setUp(id);
  const r = await delivery(l.agent_id, { from: "+12125550199", to: l.e164, body: "hello" });
  assert.equal(r.status, 200);
  const kept = await until(
    async () => (await query<{ payload: { bopsCaller?: unknown } }>("SELECT payload FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'agentphone'", [id])).rows[0],
    "the text kept for the Mac",
  );
  assert.deepEqual(kept.payload.bopsCaller, { owner: false });
  assert.equal((await query("SELECT owner_number FROM bops.phone_lines WHERE digits = $1", [l.digits])).rows[0].owner_number, null);
  // The app shows the user the number (lib/server/cloud-plan.ts): its 15 minutes start then.
  const put = await call(cloud.url, "PUT", "/v1/phone/lines", { key: keyOf(id), json: { numberId: l.number_id, botId: "boppy", open: true } });
  assert.equal(put.status, 200, put.text);
  assert.ok(Date.parse(put.json.line.claimUntil) > Date.now());
});

test("a notice, two session starts and a check at once buy one number and make one inbox", async () => {
  const { id } = await paidUser();
  orgoTiers.set(id, "pro_bops");
  const held = gate();
  breaks.buyHeld = held.promise;
  await Promise.all([
    notice({ userId: id, tier: "pro_bops", at: at() }),
    call(cloud.url, "POST", "/v1/session", { key: keyOf(id) }),
    call(cloud.url, "POST", "/v1/session", { key: keyOf(id) }),
  ]);
  void settle(id, { force: true });
  await until(() => buysWaiting > 0, "the purchase on its way");
  // Long enough for a second run to reach AgentPhone, if one could.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bought(id).length, 1);
  breaks.buyHeld = null;
  held.open();
  await setUp(id);
  await new Promise((r) => setTimeout(r, 100));
  await settle(id, { force: true });
  assert.equal(bought(id).length, 1);
  assert.equal(agents.filter((a) => a.sub === `sub_${id}`).length, 1);
  assert.equal((await line(id)).length, 1);
  assert.equal((await inbox(id)).length, 1);
});

test("a purchase whose answer was lost is found again by its tag, never bought twice", async () => {
  const { id } = await paidUser();
  breaks.buyAnswerLost = true;
  await notice({ userId: id, tier: "pro_bops", at: at() });
  await until(async () => (await planEvents(id)).length > 0, "told the Mac");
  assert.equal(bought(id).length, 1);
  assert.equal((await line(id)).length, 0, "nothing kept for a purchase that didn't answer");
  await settle(id, { force: true });
  assert.equal(bought(id).length, 1, "found by its tag, not bought again");
  assert.equal((await line(id))[0]?.status, "ready");
});

test("the app's own purchase for the main bot is refused while the plan sets one up or has one; another bot's goes through", async () => {
  const { id } = await paidUser();
  const held = gate();
  breaks.buyHeld = held.promise;
  await notice({ userId: id, tier: "pro_bops", at: at() });
  await until(() => bought(id).length === 1, "the plan's purchase on its way");
  const buy = (externalId: string) => call(cloud.url, "POST", "/proxy/agentphone/v1/numbers", { key: keyOf(id), json: { country: "US", areaCode: "415", type: "sms", externalId } });
  let r = await buy("bops-inst1-boppy");
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, "plan_number");
  breaks.buyHeld = null;
  held.open();
  await setUp(id);
  r = await buy("bops-inst1-boppy");
  assert.equal(r.status, 409, r.text);
  assert.match(r.json.error, /comes with your plan/);
  assert.equal(bought(id).length, 1);
  r = await buy("bops-inst1-sam");
  assert.equal(r.status, 200, r.text);
  assert.equal(bought(id).length, 2);
});

test("a paused number's texts out are refused at the proxy, before AgentPhone; back on a plan, they go out again", async () => {
  const { id } = await paidUser();
  await notice({ userId: id, tier: "pro_bops", at: at() });
  const l = await setUp(id);
  await notice({ userId: id, tier: "free_bops", at: at(1000) });
  await until(async () => (await line(id))[0]?.status === "paused", "paused");
  const text = (json: Record<string, unknown>) => call(cloud.url, "POST", "/proxy/agentphone/v1/messages", { key: keyOf(id), json: { to_number: "+12125550123", body: "hi", ...json } });
  const sent = () => posts(agentphone, /^\/v1\/messages$/).filter((g) => g.headers["x-sub-account-id"] === `sub_${id}`).length;
  let r = await text({ agent_id: l.agent_id, number_id: l.number_id });
  assert.equal(r.status, 402, r.text);
  assert.deepEqual([r.json.code, r.json.upgrade], ["plan_required", true]);
  r = await text({ agent_id: l.agent_id });
  assert.equal(r.status, 402, "by its agent when the text doesn't say the number");
  assert.equal(sent(), 0, "nothing reached AgentPhone");
  await notice({ userId: id, tier: "pro_bops", at: at(2000) });
  await setUp(id);
  r = await text({ agent_id: l.agent_id, number_id: l.number_id });
  assert.equal(r.status, 200, r.text);
  assert.equal(sent(), 1);
});

test("with plan limits on, orgo-web's answer from before a later notice never undoes it", async () => {
  const { id } = await paidUser();
  process.env.BOPS_PLAN_LIMITS = "1";
  orgoTiers.set(id, "pro_bops");
  // The session reads Pro, and that answer stands for a minute...
  assert.equal((await call(cloud.url, "POST", "/v1/session", { key: keyOf(id) })).status, 200);
  await until(async () => (await tierKept(id)) === "pro_bops", "the session's read");
  await setUp(id);
  // ...then the plan ends, and orgo-web says so.
  orgoTiers.set(id, "free_bops");
  await notice({ userId: id, tier: "free_bops", at: at() });
  await until(async () => (await line(id))[0]?.status === "paused", "paused");
  // A purchase in that minute is checked against the minute's answer (Pro), which is older than the notice.
  const r = await call(cloud.url, "POST", "/proxy/agentphone/v1/numbers", { key: keyOf(id), json: { country: "US", areaCode: "415", type: "sms" } });
  assert.equal(r.status, 402, r.text);
  assert.equal(await tierKept(id), "free_bops");
  await settle(id);
  assert.equal((await line(id))[0].status, "paused");
});

test("a number answered as on no agent is put on it before it's ready; one that stays off it is broken, then fixed", async () => {
  const one = await paidUser();
  breaks.buyOffAgent = true;
  await notice({ userId: one.id, tier: "pro_bops", at: at() });
  const l = await setUp(one.id);
  assert.equal(numbers.find((n) => n.id === l.number_id)?.agentId, l.agent_id);
  const two = await paidUser();
  breaks.attachIgnored = true;
  await notice({ userId: two.id, tier: "pro_bops", at: at() });
  const [b] = await until(async () => ((await line(two.id))[0]?.status === "broken" ? line(two.id) : null), "broken");
  assert.equal(b.problem, "the number isn't on its agent");
  breaks.attachIgnored = false;
  await settle(two.id, { force: true });
  assert.equal((await line(two.id))[0].status, "ready");
  assert.equal(bought(two.id).length, 1);
});

test("the hourly sweep tries a paid plan's broken number again, without buying another", async () => {
  const { id } = await paidUser();
  breaks.routingIgnored = true;
  await notice({ userId: id, tier: "pro_bops", at: at() });
  await until(async () => (await line(id))[0]?.status === "broken", "broken");
  breaks.routingIgnored = false;
  await sweep();
  assert.equal((await line(id))[0].status, "broken", "not within its first 5 minutes");
  await query("UPDATE bops.phone_lines SET updated_at = now() - interval '6 minutes' WHERE user_id = $1", [id]);
  await sweep();
  assert.equal((await line(id))[0].status, "ready");
  assert.equal(bought(id).length, 1);
});

test("a release that finds the user upgraded meanwhile (looked at again under the lock) keeps the number and inbox", async () => {
  const { id } = await paidUser();
  await notice({ userId: id, tier: "pro_bops", at: at() });
  const l = await setUp(id);
  await notice({ userId: id, tier: "free_bops", at: at(1000) });
  await until(async () => (await line(id))[0]?.status === "paused" && (await inbox(id))[0]?.status === "paused", "paused");
  await query("UPDATE bops.phone_lines SET paused_at = now() - interval '31 days' WHERE user_id = $1", [id]);
  await query("UPDATE bops.mail_inboxes SET paused_at = now() - interval '31 days' WHERE user_id = $1", [id]);
  // The upgrade lands between the sweep's list and its look under the user's lock.
  const told: string[] = [];
  await releaseAfterPause(
    async (userId) => void told.push(userId),
    async (userId, work) => {
      if (userId === id) await query("UPDATE bops.plans SET tier = 'pro_bops', changed_at = now() WHERE user_id = $1", [id]);
      return work();
    },
  );
  assert.deepEqual([(await line(id))[0].status, (await inbox(id))[0].status], ["paused", "paused"]);
  assert.equal(told.includes(id), false);
  assert.equal(agentphone.got.some((g) => g.method === "DELETE" && g.path === `/v1/numbers/${l.number_id}`), false);
  assert.ok(numbers.find((n) => n.id === l.number_id && !n.released));
});

test("many users' plans at once leave the database pool free for everything else", async () => {
  const many = await Promise.all(Array.from({ length: 12 }, () => paidUser()));
  const held = gate();
  breaks.buyHeld = held.promise;
  await Promise.all(many.map(({ id }) => notice({ userId: id, tier: "pro_bops", at: at() })));
  await until(() => buysWaiting > 0, "purchases on their way");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(buysWaiting > 0 && buysWaiting < 10, `${buysWaiting} users' plans held at once`);
  const t0 = Date.now();
  await query("SELECT 1");
  assert.ok(Date.now() - t0 < 1000, "the pool still answers");
  breaks.buyHeld = null;
  held.open();
  for (const { id } of many) await until(async () => (await line(id))[0]?.status === "ready" && (await inbox(id))[0]?.status === "ready", `${id} set up`, 15_000);
  for (const { id } of many) assert.equal(bought(id).length, 1);
});

test("after a number is given back, the plan's next one goes on the same agent and is answered, even for a delivery that doesn't say the number", async () => {
  const { id } = await paidUser();
  await notice({ userId: id, tier: "pro_bops", at: at() });
  const old = await setUp(id);
  await notice({ userId: id, tier: "free_bops", at: at(1000) });
  await until(async () => (await line(id))[0]?.status === "paused" && (await inbox(id))[0]?.status === "paused", "paused");
  await query("UPDATE bops.phone_lines SET paused_at = now() - interval '31 days' WHERE user_id = $1", [id]);
  await query("UPDATE bops.mail_inboxes SET paused_at = now() - interval '31 days' WHERE user_id = $1", [id]);
  await sweep();
  assert.equal((await line(id))[0].status, "released");
  await notice({ userId: id, tier: "pro_bops", at: at(2000) });
  const fresh = await until(async () => (await line(id)).find((x) => x.status === "ready"), "a new number");
  assert.notEqual(fresh.number_id, old.number_id);
  assert.equal(fresh.agent_id, old.agent_id, "on the agent the old number left behind");
  const kept = async () => (await query<{ n: number }>("SELECT count(*)::int AS n FROM bops.cloud_pending WHERE user_id = $1 AND kind = 'agentphone'", [id])).rows[0].n;
  const before = await kept();
  assert.equal((await delivery(fresh.agent_id, { from: "+12125550123", body: "still there?" })).status, 200);
  assert.equal(await kept(), before + 1, "kept for the Mac, not taken for the number given back");
});
