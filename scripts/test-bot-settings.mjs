// Tests for what a bot's settings page changes on the server: PATCH /api/bots with its call voice, Answers calls, its
// built in sequences and Replies to others (app/api/bots/route.ts); the voice calls speak in (lib/server/call.ts
// voiceFor), which never rewrites Bot.voice; calls turned away (lib/server/phone-voice.ts); mail past the hour's cap
// held, outside mail kept quiet, and Never for emails to others (lib/server/mail.ts); the site a bot works on (its
// Works on row) and a computer's name (PATCH /api/workspaces computerName), kept on the workspace. OpenAI is a fake on localhost,
// AgentMail and AgentPhone fakes in this process, the state a throwaway file store in a temporary folder: nothing
// reaches a real service, and nobody is called, texted or emailed.
// Usage: node --conditions=react-server scripts/test-bot-settings.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  BOPS_SELF_HOSTED: "1",
  OPENAI_API_KEY: "sk-test-not-a-real-key",
  AGENTPHONE_API_KEY: "ap-test-not-a-real-key",
  AGENTPHONE_WEBHOOK_SECRET: "whsec-test",
  AGENTMAIL_API_KEY: "am-test-not-a-real-key",
  BOPS_PHONE_DRY_RUN: "1",
  BOPS_OWNER_PHONES: "+14155550100",
  BOPS_OWNER_EMAILS: "ava@acme.example",
  BOPS_UI_TOKEN: "window-token-test",
});
const OWNER = "+14155550100";
const LINE = "+14155550199";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "sessions"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-bot-settings-"));
process.chdir(scratch);
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Infinity;

/* ---------------- Fakes: OpenAI on localhost, AgentMail and AgentPhone here ---------------- */

/** Every Responses request: whether it was a phone call's turn, and its body. */
const asked = [];
/** Every Live session control a call sent (accept, reject), by its path. */
const live = [];
const responseOf = (text) => ({
  id: `resp_${asked.length}`,
  object: "response",
  model: "gpt-test",
  status: "completed",
  output: [{ id: `msg_${asked.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});
const fake = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.method === "POST" && /\/live\/sessions\//.test(req.url)) {
    live.push({ path: req.url, body });
    return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }
  if (req.method !== "POST" || req.url !== "/v1/responses") return void res.writeHead(404).end("{}");
  asked.push({ phone: (body.tools ?? []).some((t) => t.name === "end_call"), body });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(responseOf("Got it.")));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;

const MAIL_AT = new Date().toISOString();
/** AgentMail: the messages catch-up lists and gets, and every send. */
const mail = { list: [], sent: [] };
const email = (id, o = {}) => ({
  inbox_id: "in_1",
  thread_id: `th_${id}`,
  message_id: id,
  labels: ["received"],
  timestamp: MAIL_AT,
  from: o.from ?? "Juno <juno@acme.example>",
  to: ["sam@bops.bot"],
  subject: o.subject ?? "Hello",
  preview: "Hi there",
  text: "Hi there",
  headers: o.headers ?? {},
  size: 100,
  updated_at: MAIL_AT,
  created_at: MAIL_AT,
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "api.agentmail.to") {
    const m = url.pathname.match(/^\/v0\/inboxes\/[^/]+\/messages(?:\/([^/]+))?(\/send)?$/);
    if (req.method === "POST") {
      mail.sent.push({ path: url.pathname, body: await req.text() });
      return Response.json({ message_id: `out_${mail.sent.length}`, thread_id: "th_out" });
    }
    if (m && !m[1]) return Response.json({ count: mail.list.length, messages: mail.list });
    const found = m?.[1] && mail.list.find((x) => x.message_id === decodeURIComponent(m[1]));
    return found ? Response.json(found) : Response.json({ name: "NotFoundError", message: "Not found" }, { status: 404 });
  }
  if (url.hostname === "api.agentphone.ai") return Response.json({});
  if (url.hostname !== "127.0.0.1") throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
  return realFetch(input, init);
};

const S = await import(`${root}/lib/server/store.ts`);
const V = await import(`${root}/lib/server/phone-voice.ts`);
const C = await import(`${root}/lib/server/call.ts`);
const M = await import(`${root}/lib/server/mail.ts`);
const P = await import(`${root}/lib/server/phone.ts`);
const route = await import(`${root}/app/api/bots/route.ts`);

S.update((s) => {
  s.owner = { name: "Ava", about: "" };
  const ws = (s.workspaces ??= [{ id: "ws_main", name: "Main", createdAt: 1 }]).find((w) => w.id === "ws_main") ?? s.workspaces[0];
  ws.line = { phone: LINE, numberId: "num_ws", agentId: "agt_ws", type: "sms", scope: "sub", at: 1 };
  const main = s.bots.find((b) => b.isMain);
  main.name = "Sam";
  main.email = "sam@bops.bot";
  main.mail = { inboxId: "in_1", podId: "pod_1" };
});
const sam = () => S.getState().bots.find((b) => b.isMain);
const patch = (body, window = true) =>
  route.PATCH(new Request("http://localhost/api/bots", { method: "PATCH", headers: { "content-type": "application/json", ...(window ? { "x-bops-window": "window-token-test" } : {}) }, body: JSON.stringify({ botId: sam().id, ...body }) }));
const until = async (check, what, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/* ---------------- PATCH /api/bots ---------------- */

/** Sam's settings page settings, where they're kept: on its workspace, by bot id (Workspace.botSettings). */
const set = () => S.getState().workspaces?.find((w) => w.id === "ws_main")?.botSettings?.[sam().id];
const NEW_ON_BOT = ["callVoice", "answersCalls", "sequencesOff", "mailNever"];
{
  assert.equal((await patch({ callVoice: "sage" }, false)).status, 403, "only from the Bops window");
  assert.equal(set(), undefined);
  assert.equal((await patch({ callVoice: "sage" })).status, 200);
  assert.deepEqual(set(), { callVoice: "sage" }, "kept on its workspace, by bot id");
  const bad = await patch({ callVoice: "robot" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Pick one of the nine voices." });
  assert.equal(set().callVoice, "sage", "a refused voice changes nothing");

  await patch({ answersCalls: false });
  assert.equal(set().answersCalls, false);
  await patch({ answersCalls: true });
  assert.equal("answersCalls" in set(), false, "on is no field, as before");

  await patch({ sequence: { id: "othersMail", on: false } });
  await patch({ sequence: { id: "othersCalls", on: false } });
  assert.deepEqual(set().sequencesOff, { othersMail: true, othersCalls: true });
  await patch({ sequence: { id: "othersMail", on: true } });
  assert.deepEqual(set().sequencesOff, { othersCalls: true });
  await patch({ sequence: { id: "othersCalls", on: true } });
  assert.equal("sequencesOff" in set(), false, "an empty one is removed");
  assert.equal((await patch({ sequence: { id: "mailFromYou", on: false } })).status, 400, "a locked one can't be turned off");

  const other = { action: "Call Stripe", resource: "*", effect: "allow" };
  const ask = { action: "Send an email", resource: "*", effect: "ask" };
  S.update(() => void (sam().permissions = [{ action: "Send an email", resource: "juno@acme.example", effect: "allow" }, other]));
  await patch({ othersMail: "never" });
  assert.deepEqual(sam().permissions, [other, ask], "Never: an ask rule, which a Bops from before reads as it is; others kept");
  assert.equal(set().mailNever, true, "and Never itself on the workspace");
  await patch({ othersMail: "ask" });
  assert.deepEqual(sam().permissions, [other, ask], "With your OK: an ask rule, even with Just do it off");
  assert.equal("mailNever" in set(), false);
  await patch({ autoApprove: true });
  assert.deepEqual(sam().permissions, [other, ask], "so Just do it on later still asks");
  await patch({ othersMail: "allow" });
  assert.deepEqual(sam().permissions, [other, { action: "Send an email", resource: "*", effect: "allow" }]);
  assert.equal((await patch({ othersMail: "sometimes" })).status, 400);
  await patch({ autoApprove: false, othersMail: "ask" });
  for (const k of NEW_ON_BOT) assert.equal(k in sam(), false, `nothing of it on the bot itself (${k})`);
  console.log("PATCH /api/bots: voice, calls, sequences, replies to others, kept on the workspace");
}

/* ---------------- The voice: its own field, Bot.voice untouched ---------------- */

{
  assert.equal(await C.voiceFor(sam()), "sage", "the picked voice");
  assert.equal(sam().voice, "cedar", "Bot.voice stays what a Bops from before writes for its name");
  await patch({ callVoice: null });
  assert.equal(set(), undefined, "Picked for its name clears it, and an empty entry goes");
  assert.equal(S.getState().workspaces.find((w) => w.id === "ws_main").botSettings, undefined, "and an empty map");
  assert.equal(await C.voiceFor(sam()), "cedar");
  assert.equal(sam().voice, "cedar");
  console.log("voiceFor: picked voice used, Bot.voice kept");
}

/* ---------------- Calls turned away ---------------- */

const turn = (from, transcript, callId) => ({ event: "agent.message", channel: "voice", agentId: "agt_ws", data: { callId, from, to: LINE, transcript, direction: "inbound" } });
const calls = () => S.getState().messages.filter((m) => m.sms?.id?.startsWith("call:"));
{
  await patch({ answersCalls: false });
  const before = asked.length;
  assert.deepEqual(await V.voiceTurn(turn(OWNER, "", "call_off_1")), { text: "Sorry, Sam isn't taking calls right now. You can text this number. Bye!", hangup: true }, "the user too");
  assert.deepEqual(await V.voiceTurn(turn("+13125550142", "", "call_off_2")), { text: "Sorry, this number isn't taking calls right now. Bye!", hangup: true }, "and anyone else, not told to text: their texts aren't answered");
  assert.equal(asked.length, before, "no OpenAI request");
  assert.equal(V.callOpen("call_off_1"), false, "hung up");
  await until(() => calls().length >= 2, "both calls' cards");
  await patch({ answersCalls: true, sequence: { id: "othersCalls", on: false } });
  assert.deepEqual(await V.voiceTurn(turn("+13125550143", "", "call_off_3")), { text: "Sorry, this number isn't taking calls right now. Bye!", hangup: true }, "Someone else calls off: a stranger hears a short no");
  assert.equal(asked.length, before, "still no model");
  const card = await until(() => calls().find((m) => m.sms.id === "call:call_off_3"), "the stranger's card");
  assert.match(card.text, /this number isn't taking calls/);
  const owner = await V.voiceTurn(turn(OWNER, "", "call_on_4"));
  assert.equal(owner.hangup, undefined, "the user still gets through");
  assert.equal(asked.length, before + 1, "and is answered by the model");
  await patch({ sequence: { id: "othersCalls", on: true } });
  assert.equal(V.callsOff({ name: "Sam" }, {}, false), null, "nothing set: answers, as before");
  // A number routed to a trunk by hand (phone.ts incomingCall): Answers calls off turns the user's call away as busy.
  const sip = (id) => ({ type: "live.transport.incoming", data: { session_id: id, sip_headers: [{ name: "From", value: `<sip:${OWNER}@carrier.example>` }, { name: "To", value: `<sip:${LINE}@sip.example>` }] } });
  await patch({ answersCalls: false });
  await P.incomingCall(sip("sess_off_1"), { owner: true });
  const said = await until(() => live.find((x) => x.path.includes("sess_off_1")), "the trunk call's answer");
  assert.match(said.path, /\/reject$/);
  assert.equal(said.body.status_code, 486, "busy, before it connects");
  await patch({ answersCalls: true });
  console.log("calls: Answers calls off and Someone else calls off");
}

/* ---------------- Mail: the hour's cap held, outside mail quiet, the user's still answered ---------------- */

const inMail = (id) => S.getState().messages.find((m) => m.email?.dir === "in" && m.email.messageId === id);
const settle = () => new Promise((r) => setTimeout(r, 50));
{
  // Twelve already this hour: the 13th is a card marked held, and the bot stays quiet.
  globalThis.bopsMail.arrivals.set(sam().id, Array(12).fill(Date.now()));
  let before = asked.length;
  mail.list = [email("m_13")];
  await M.checkMailNow();
  await settle();
  assert.equal(inMail("m_13")?.email.held, true, "held by the loop guard");
  assert.equal(asked.length, before, "no turn");
  globalThis.bopsMail.arrivals.set(sam().id, []);

  // Everyone else off: a card, no turn, no ping.
  await patch({ sequence: { id: "othersMail", on: false } });
  before = asked.length;
  mail.list = [email("m_quiet")];
  await M.checkMailNow();
  await settle();
  assert.ok(inMail("m_quiet"), "shown as a card");
  assert.equal(inMail("m_quiet").email.held, undefined);
  assert.equal(asked.length, before, "the bot stays quiet");
  assert.equal(S.getState().messages.some((m) => m.chatId === inMail("m_quiet").chatId && m.at >= inMail("m_quiet").at && m.ping), false, "no chime");

  // The user's own email is still answered.
  mail.list = [email("m_ava", { from: "Ava <ava@acme.example>", headers: { "Authentication-Results": "mx.agentmail.to; dmarc=pass header.from=acme.example" } })];
  await M.checkMailNow();
  await until(() => asked.length > before, "a turn for the user's email");
  assert.equal(inMail("m_ava").email.fromOwner, true);
  await patch({ sequence: { id: "othersMail", on: true } });
  before = asked.length;
  mail.list = [email("m_juno")];
  await M.checkMailNow();
  await until(() => asked.length > before, "a turn for outside mail once it's on again");
  console.log("mail: held past 12 an hour, outside mail quiet while off");
}

/* ---------------- Never: no email to anyone but the user, and nothing asked ---------------- */

{
  await patch({ othersMail: "never" });
  const sent = mail.sent.length;
  const said = await M.sendEmail(sam().id, { to: ["juno@acme.example"], subject: "Hi", text: "Hello" }, {});
  assert.equal(said, "Not sent: Ava has Sam email only Ava. Tell Ava what you'd have sent instead.");
  assert.equal(mail.sent.length, sent, "nothing sent");
  assert.equal(S.getState().approvals?.length ?? 0, 0, "nothing asked");
  const mine = await M.sendEmail(sam().id, { to: ["ava@acme.example"], subject: "Hi", text: "Hello" }, {});
  assert.match(mine, /^Sent to ava@acme\.example/, "to the user's own address it still goes");
  assert.equal(mail.sent.length, sent + 1);
  await patch({ othersMail: "ask" });
  console.log("mail: Never sends nothing to others and asks nothing");
}

/* ---------------- Works on, and a computer's name (lib/server/bot-groups.ts) ---------------- */

{
  const ws = () => S.getState().workspaces.find((w) => w.id === "ws_main");
  S.update((s) => {
    s.workspaces.find((w) => w.id === "ws_main").hostedApps = { shop: { botId: sam().id, computerId: "comp_test", sites: [{ name: "blog" }] } };
    s.bots.find((b) => b.isMain).computerId = "comp_test";
  });
  const said = async (r) => ({ status: r.status, ...(await r.json()) });
  assert.equal((await patch({ site: { app: "shop", site: "blog" } })).status, 200);
  assert.deepEqual(ws().botSites, { [sam().id]: { app: "shop", site: "blog" } }, "kept on its workspace");
  assert.equal(sam().site, undefined, "never on the bot");
  assert.equal((await patch({ site: { app: "shop" } })).status, 200);
  assert.deepEqual(ws().botSites[sam().id], { app: "shop", site: "shop" }, "the app's own site when none is named");
  assert.deepEqual(await said(await patch({ site: { app: "shop", site: "nope" } })), { status: 404, error: "There's no site by that name in this workspace's apps." });
  assert.equal((await patch({ site: "shop" })).status, 400);
  assert.equal((await patch({ site: null }, false)).status, 403, "only from the Bops window");
  assert.deepEqual(ws().botSites[sam().id], { app: "shop", site: "shop" }, "unchanged");
  assert.equal((await patch({ site: null })).status, 200);
  assert.equal(ws().botSites, undefined, "None: gone, and the map with it");

  const wsRoute = await import(`${root}/app/api/workspaces/route.ts`);
  const name = (body, window = true) =>
    wsRoute.PATCH(new Request("http://localhost/api/workspaces", { method: "PATCH", headers: { "content-type": "application/json", ...(window ? { "x-bops-window": "window-token-test" } : {}) }, body: JSON.stringify(body) }));
  assert.deepEqual(await said(await name({ id: "ws_main", computerName: { computer: "comp_test", name: "  Front   desk " } })), { status: 200, ok: true, name: "Front desk" });
  assert.deepEqual(ws().computerNames, { comp_test: "Front desk" });
  assert.equal((await name({ id: "ws_main", computerName: { computer: "comp_test", name: "Mine" } }, false)).status, 403, "only the owner's window names it");
  assert.equal((await name({ id: "ws_main", computerName: { computer: "comp_elsewhere", name: "Mine" } })).status, 404, "only a computer its bots work on");
  assert.equal((await name({ computerName: { computer: "comp_test", name: "Mine" } })).status, 400);
  assert.deepEqual(ws().computerNames, { comp_test: "Front desk" }, "unchanged by any of those");
  assert.deepEqual(await said(await name({ id: "ws_main", computerName: { computer: "comp_test", name: "" } })), { status: 200, ok: true, name: "" });
  assert.equal(ws().computerNames, undefined, "empty: its default back");
  console.log("Works on and a computer's name: kept on the workspace, the owner's window only");
}

fake.close();
rmSync(scratch, { recursive: true, force: true });
console.log("bot settings: all tests passed");
process.exit(0);
