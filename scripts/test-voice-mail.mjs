// Tests for calls to a bot's number in its own voice, and for an email conversation with someone else kept as one
// thread. Voice: AgentPhone's voices matched to the nine call voices (lib/phone-voices.ts), set on the line's agent when
// a number is made, when the voice is picked on the settings page, and at each start for a number from before
// (lib/server/phone.ts voiceToAgent, lineUpkeep, syncLineVoices), and noted on the workspace for the settings page
// (Workspace.lineVoices). Mail: the bot reads an email with the thread before it (mail.ts threadSoFar), answers with
// AgentMail's reply to it, With your OK asks once with the thread on its card, On its own sends within the loop guard
// (never automatic mail or a bot's, at most 12 an hour), and a send that fails is said in the chat after the client's
// own two more tries (lib/server/mail.ts). OpenAI is a fake on localhost, AgentMail and AgentPhone fakes in this
// process, the state a throwaway file store in a temporary folder: nothing reaches a real service, and nobody is
// called, texted or emailed. Every name, number and address here is made up.
// Usage: node --conditions=react-server scripts/test-voice-mail.mjs
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
const scratch = mkdtempSync(join(tmpdir(), "bops-test-voice-mail-"));
process.chdir(scratch);
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Infinity;

/* ---------------- Fakes: OpenAI on localhost, AgentMail and AgentPhone here ---------------- */

/** Every Responses request's body. */
const asked = [];
/** What an email turn from someone else answers first: a reply_email call (its arguments), or null for words only. */
let replyCall = null;
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const responseOf = (output) => ({ id: `resp_${asked.length}`, object: "response", model: "gpt-test", status: "completed", output, usage });
const said = (text) => [{ id: `msg_${asked.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
const fake = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.method !== "POST" || req.url !== "/v1/responses") return void res.writeHead(404).end("{}");
  asked.push(body);
  const all = JSON.stringify(body);
  const answered = Array.isArray(body.input) && body.input.some((x) => x?.type === "function_call_output");
  const emailTurn = /This turn came from an email from/.test(all) && (body.tools ?? []).some((t) => t.name === "reply_email");
  const output =
    emailTurn && replyCall && !answered
      ? [{ id: `fc_${asked.length}`, type: "function_call", call_id: `call_${asked.length}`, name: "reply_email", arguments: JSON.stringify({ reply_all: null, ...replyCall }), status: "completed" }]
      : said(answered ? "I answered Juno in the thread." : "Juno wrote about the menu.");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(responseOf(output)));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;

const base = Date.now() - 60 * 60_000;
const at = (min) => new Date(base + min * 60_000).toISOString();
/** AgentMail: every message it holds (`list` is what a catch up lists), and each send or reply as asked. */
const mail = { all: [], list: [], sent: [], tries: 0, failWith: 0 };
const email = (id, o = {}) => ({
  inbox_id: "in_1",
  thread_id: o.thread ?? `th_${id}`,
  message_id: id,
  labels: o.labels ?? ["received"],
  timestamp: o.at ?? new Date().toISOString(),
  from: o.from ?? "Juno <juno@acme.example>",
  to: o.to ?? ["sam@bops.bot"],
  subject: o.subject ?? "Dinner menu",
  preview: o.text ?? "Hi there",
  text: o.text ?? "Hi there",
  extracted_text: o.text ?? "Hi there",
  headers: o.headers ?? {},
  size: 100,
  updated_at: o.at ?? new Date().toISOString(),
  created_at: o.at ?? new Date().toISOString(),
});
/** AgentPhone: every request, and what it answers (`agentPhone`, set per test). */
const apGot = [];
let agentPhone = () => [404, { detail: "not in the fake" }];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "api.agentmail.to") {
    const path = url.pathname;
    if (req.method === "POST") {
      mail.tries++;
      if (mail.failWith) return Response.json({ name: "Busy", message: "AgentMail is busy" }, { status: mail.failWith });
      const reply = /\/messages\/([^/]+)\/(reply|reply-all)$/.exec(path);
      const original = reply && mail.all.find((x) => x.message_id === decodeURIComponent(reply[1]));
      const sent = { path, body: JSON.parse((await req.text()) || "{}") };
      mail.sent.push(sent);
      return Response.json({ message_id: `out_${mail.sent.length}`, thread_id: original?.thread_id ?? "th_new" });
    }
    const thread = /^\/v0\/inboxes\/[^/]+\/threads\/([^/]+)$/.exec(path);
    if (thread) {
      const messages = mail.all.filter((x) => x.thread_id === decodeURIComponent(thread[1]));
      return messages.length ? Response.json({ inbox_id: "in_1", thread_id: thread[1], messages, message_count: messages.length }) : Response.json({ name: "NotFoundError", message: "Not found" }, { status: 404 });
    }
    const m = path.match(/^\/v0\/inboxes\/[^/]+\/messages(?:\/([^/]+))?$/);
    if (m && !m[1]) return Response.json({ count: mail.list.length, messages: mail.list });
    const found = m?.[1] && mail.all.find((x) => x.message_id === decodeURIComponent(m[1]));
    return found ? Response.json(found) : Response.json({ name: "NotFoundError", message: "Not found" }, { status: 404 });
  }
  if (url.hostname === "api.agentphone.ai") {
    const got = { method: req.method, path: url.pathname, json: req.method === "GET" ? undefined : JSON.parse((await req.text()) || "{}") };
    apGot.push(got);
    const [status, json] = agentPhone(got);
    return Response.json(json, { status });
  }
  if (url.hostname !== "127.0.0.1") throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
  return realFetch(input, init);
};

const PV = await import(`${root}/lib/phone-voices.ts`);
const W = await import(`${root}/lib/bot-settings.ts`);
const SQ = await import(`${root}/lib/sequences.ts`);
const S = await import(`${root}/lib/server/store.ts`);
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
const ws = () => S.getState().workspaces.find((w) => w.id === "ws_main");
const patch = (body) =>
  route.PATCH(new Request("http://localhost/api/bots", { method: "PATCH", headers: { "content-type": "application/json", "x-bops-window": "window-token-test" }, body: JSON.stringify({ botId: sam().id, ...body }) }));
const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

/* ---------------- AgentPhone's voices, matched to the nine ---------------- */

/** A catalog with OpenAI's own voices in it, by name. */
const OPENAI_CATALOG = { data: ["Cedar", "Ash", "Marin", "Sage"].map((n) => ({ voice_id: `openai-${n}`, voice_name: n, gender: ["Cedar", "Ash"].includes(n) ? "male" : "female", accent: "American", preview_audio_url: "https://voices.example/x.mp3" })) };
/** One without them: other voices, some named like ours. */
const OTHER_CATALOG = {
  data: [
    { voice_id: "11labs-Adrian", voice_name: "Adrian", gender: "male", accent: "American" },
    { voice_id: "11labs-Paul", voice_name: "Paul", gender: "Male", accent: "American" },
    { voice_id: "11labs-Laura", voice_name: "Laura", gender: "female", accent: "American" },
    { voice_id: "11labs-Grace", voice_name: "Grace", gender: "female", accent: "British" },
    { voice_id: "cartesia-Theo", voice_name: "Theo", gender: "male", accent: "Australian" },
    { voice_id: "cartesia-Iris", voice_name: "Iris", gender: "female", accent: "American" },
    { voice_id: "bad" },
    "not a voice",
  ],
};

await test("AgentPhone's voices read from its answer, names shown without dashes", () => {
  const v = PV.phoneVoicesIn(OTHER_CATALOG);
  assert.equal(v.length, 7, "the well formed ones");
  assert.deepEqual(v[0], { id: "11labs-Adrian", name: "Adrian", gender: "male", accent: "American" });
  assert.equal(v[1].gender, "male", "gender in any case");
  assert.deepEqual(v.find((x) => x.id === "bad"), { id: "bad", name: "bad" });
  assert.equal(PV.phoneVoicesIn([{ voice_id: "x-y_z" }])[0].name, "x y z", "a bare list, and an id as the name without a dash");
  assert.deepEqual(PV.phoneVoicesIn(null), []);
  assert.deepEqual(PV.phoneVoicesIn({ detail: "no" }), []);
});

await test("each call voice gets AgentPhone's closest: the same by name, then one like it, then its gender", () => {
  const openai = PV.phoneVoicesIn(OPENAI_CATALOG);
  assert.deepEqual(PV.closestPhoneVoice("cedar", openai), { voice: openai[0], exact: true }, "the same voice by name");
  assert.deepEqual(PV.closestPhoneVoice("sage", openai), { voice: openai[3], exact: true });
  const other = PV.phoneVoicesIn(OTHER_CATALOG);
  const pick = (v) => PV.closestPhoneVoice(v, other);
  assert.deepEqual(pick("cedar"), { voice: other[0], exact: false }, "cedar: Adrian, warm and steady");
  assert.equal(pick("echo").voice.name, "Paul");
  assert.equal(pick("sage").voice.name, "Laura");
  assert.equal(pick("marin").voice.name, "Grace", "a name like it comes before an American accent");
  // Nothing named like them: one of the same gender, American first, spread by their place among the nine.
  const ash = pick("ash").voice;
  const verse = pick("verse").voice;
  assert.equal(ash.gender, "male");
  assert.equal(verse.gender, "male");
  assert.equal(pick("coral").voice.gender, "female");
  assert.equal(pick("shimmer").voice.gender, "female");
  assert.notEqual(pick("coral").voice.id, pick("shimmer").voice.id, "two voices spread over the pool");
  for (const v of ["cedar", "ash", "echo", "ballad", "verse", "marin", "coral", "shimmer", "sage"]) assert.ok(pick(v), v);
  assert.equal(PV.closestPhoneVoice("cedar", []), null, "nothing to pick from");
  // A catalog without genders still gives a voice.
  assert.equal(PV.closestPhoneVoice("ballad", [{ id: "v1", name: "Robin" }]).voice.id, "v1");
});

/* ---------------- Set on the line's agent ---------------- */

/** The fake AgentPhone of this account: its voices, its agent and number, every voice set. */
const phone = { catalog: OTHER_CATALOG, voiceOf: { agt_ws: "11labs-Theo" }, routing: "agent", voicesStatus: 200 };
const setVoice = () => apGot.filter((g) => g.method === "PATCH" && /^\/v1\/agents\/[^/]+$/.test(g.path) && g.json.voice);
agentPhone = (g) => {
  if (g.method === "GET" && g.path === "/v1/agents/voices") return [phone.voicesStatus, phone.voicesStatus === 200 ? phone.catalog : { detail: "Not found" }];
  if (g.method === "GET" && g.path === "/v1/agents") return [200, { data: Object.entries(phone.voiceOf).map(([id, voice]) => ({ id, voiceMode: "webhook", voice })) }];
  if (g.method === "GET" && g.path === "/v1/numbers") return [200, { data: [{ id: "num_ws", phoneNumber: LINE, agentId: "agt_ws", voiceRouting: { method: phone.routing } }] }];
  if (g.method === "POST" && g.path === "/v1/agents") return [200, { id: "agt_new" }];
  if (g.method === "POST" && g.path === "/v1/numbers") return [200, { id: "num_new", phoneNumber: "+16285550123", agentId: g.json.agentId, externalId: g.json.externalId }];
  const agent = /^\/v1\/agents\/([^/]+)$/.exec(g.path);
  if (g.method === "PATCH" && agent) {
    if (g.json.voice) phone.voiceOf[agent[1]] = g.json.voice;
    return [200, { id: agent[1], voice: phone.voiceOf[agent[1]] }];
  }
  if (g.method === "PATCH") return [200, {}];
  return [404, { detail: "not in the fake" }];
};

await test("at a start, a number from before gets its bot's voice, once", async () => {
  globalThis.bopsPhoneVoices = undefined;
  const before = setVoice().length;
  const fixed = await P.lineUpkeep();
  const set = setVoice().slice(before);
  assert.equal(set.length, 1, "the workspace number's agent");
  assert.equal(set[0].path, "/v1/agents/agt_ws");
  assert.deepEqual(set[0].json, { voice: "11labs-Adrian" }, "Sam's voice for its name is Cedar: Adrian is AgentPhone's closest");
  assert.deepEqual(fixed, [`${LINE}: voice → Adrian (cedar)`]);
  assert.deepEqual(ws().lineVoices, { agt_ws: { for: "cedar", id: "11labs-Adrian", name: "Adrian" } }, "noted on the workspace, by agent");
  assert.equal(apGot.some((g) => g.path.endsWith("/voice-routing")), false, "its calls were routed already: left alone");
  // The next start: AgentPhone says it has it, so nothing is set again.
  assert.deepEqual(await P.lineUpkeep(), []);
  assert.equal(setVoice().length, before + 1);
  // Someone changed it elsewhere: put back.
  phone.voiceOf.agt_ws = "cartesia-Theo";
  await P.lineUpkeep();
  assert.equal(setVoice().length, before + 2);
  assert.equal(phone.voiceOf.agt_ws, "11labs-Adrian");
});

await test("picked on the settings page: the line's voice follows, and Picked for its name goes back", async () => {
  const before = setVoice().length;
  assert.equal((await patch({ callVoice: "sage" })).status, 200);
  await until(() => ws().lineVoices?.agt_ws?.for === "sage", "the line's voice for Sage");
  assert.deepEqual(setVoice().slice(before).map((g) => [g.path, g.json.voice]), [["/v1/agents/agt_ws", "11labs-Laura"]]);
  assert.deepEqual(ws().lineVoices.agt_ws, { for: "sage", id: "11labs-Laura", name: "Laura" });
  const s = S.getState();
  assert.equal(W.lineVoiceNote(s, sam(), "agt_ws", "sage", "+1 (415) 555 0199"), "Calls in Bops use this voice. Calls to +1 (415) 555 0199 use Laura, the closest phone voice.");
  assert.equal(W.lineVoiceNote(s, sam(), "agt_ws", "cedar", "+1 (415) 555 0199"), "Calls in Bops use this voice. Calls to +1 (415) 555 0199 use the line's own voice for now.");
  assert.equal(W.lineVoiceNote(s, sam(), undefined, "sage", "+1 (415) 555 0199"), "Calls in Bops use this voice. Calls to +1 (415) 555 0199 use the line's own voice for now.");
  await patch({ callVoice: null });
  await until(() => ws().lineVoices?.agt_ws?.for === "cedar", "back to the one picked for its name");
  assert.equal(phone.voiceOf.agt_ws, "11labs-Adrian");
  // AgentPhone with OpenAI's own voices: the same voice, said so.
  globalThis.bopsPhoneVoices = undefined;
  phone.catalog = OPENAI_CATALOG;
  await patch({ callVoice: "marin" });
  await until(() => ws().lineVoices?.agt_ws?.for === "marin", "Marin");
  assert.deepEqual(ws().lineVoices.agt_ws, { for: "marin", id: "openai-Marin", name: "Marin", exact: true });
  assert.equal(W.lineVoiceNote(S.getState(), sam(), "agt_ws", "marin", "+1 (415) 555 0199"), "Calls in Bops and calls to +1 (415) 555 0199 use this voice.");
  await patch({ callVoice: null });
  await until(() => ws().lineVoices?.agt_ws?.for === "cedar", "Cedar again");
});

await test("without AgentPhone's voices (it can't say, or a Bops Cloud from before), nothing changes", async () => {
  globalThis.bopsPhoneVoices = undefined;
  phone.voicesStatus = 404;
  const before = setVoice().length;
  const kept = structuredClone(ws().lineVoices);
  await patch({ callVoice: "ash" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await P.syncLineVoices(sam().id), []);
  assert.equal(setVoice().length, before, "no voice set");
  assert.deepEqual(ws().lineVoices, kept, "what calls to the number sound like stays as it was");
  assert.equal(W.lineVoiceNote(S.getState(), sam(), "agt_ws", "ash", "+1 (415) 555 0199"), "Calls in Bops use this voice. Calls to +1 (415) 555 0199 use the line's own voice for now.", "so the page says the line's own voice");
  phone.voicesStatus = 200;
  await patch({ callVoice: null });
  await until(() => ws().lineVoices?.agt_ws?.for === "cedar", "Cedar once AgentPhone says again");
});

await test("a bot's own new number speaks in its voice from the first call", async () => {
  S.update((s) => {
    s.bots.push({ id: "bot_nora", name: "Nora", role: "Sales", color: "#4F7BF7", isMain: false, workspaceId: "ws_main" });
    const w = s.workspaces.find((x) => x.id === "ws_main");
    w.botSettings = { ...w.botSettings, bot_nora: { callVoice: "coral" } };
  });
  const before = setVoice().length;
  globalThis.bopsPhoneVoices = undefined;
  assert.equal(await P.ensurePhone("bot_nora", "628"), "+16285550123");
  const set = setVoice().slice(before);
  assert.deepEqual(set.map((g) => g.path), ["/v1/agents/agt_new"]);
  assert.equal(set[0].json.voice, "openai-Sage", "no Coral here, nor one named like it: the woman's voice its place among the nine picks");
  assert.equal(ws().lineVoices.agt_new.for, "coral");
});

/* ---------------- Email: one thread with someone else ---------------- */

const inMail = (id) => S.getState().messages.find((m) => m.email?.dir === "in" && m.email.messageId === id);
const approvals = () => S.getState().appApprovals ?? [];
const outCards = () => S.getState().messages.filter((m) => m.email?.dir === "out");
const turnOf = (n) => asked.slice(n).find((b) => /This turn came from an email from/.test(JSON.stringify(b)));
// Juno wrote, Sam answered in the thread, and Juno wrote back.
mail.all = [
  email("m_first", { thread: "th_dinner", at: at(1), text: "Can you send the dinner menu for Friday?" }),
  email("m_sam", { thread: "th_dinner", at: at(2), labels: ["sent"], from: "Sam <sam@bops.bot>", to: ["juno@acme.example"], subject: "Re: Dinner menu", text: "Sure, I'll check with Ava." }),
  email("m_back", { thread: "th_dinner", at: at(3), subject: "Re: Dinner menu", text: "Thanks! Is the fish course still on?" }),
];

await test("the thread before an email, oldest first, its new text only", async () => {
  const t = await M.threadSoFar("in_1", "th_dinner", "m_back");
  assert.equal(t, [`Juno <juno@acme.example> · ${at(1)} · message_id m_first\nCan you send the dinner menu for Friday?`, `You · ${at(2)} · message_id m_sam\nSure, I'll check with Ava.`].join("\n\n"));
  assert.equal(await M.threadSoFar("in_1", "th_dinner", "m_first"), "", "the first has none before it");
  assert.equal(await M.threadSoFar("in_1", "th_gone", "m_x"), "", "AgentMail can't say: none");
  assert.equal(await M.threadSoFar("in_1", undefined, "m_x"), "");
});

await test("With your OK: the reply is asked once, in the thread, its card showing the thread; nothing goes until yes", async () => {
  assert.equal((await patch({ othersMail: "ask" })).status, 200);
  const n = asked.length;
  const sent = mail.sent.length;
  replyCall = { message_id: "m_back", text: "Yes, the fish course is still on.\n\nSam" };
  mail.list = [mail.all[2]];
  await M.checkMailNow();
  const ask = await until(() => approvals().find((a) => a.kind === "email"), "the email's card");
  const turn = turnOf(n);
  assert.ok(turn, "a turn for Juno's email");
  const words = JSON.stringify(turn);
  assert.match(words, /The newest email is part of a conversation/, "read with the thread before it");
  assert.match(words, /Can you send the dinner menu for Friday\?/);
  assert.match(words, /You · .*message_id m_sam/);
  assert.match(words, /Your Replies to others is With your OK, so each reply waits for Ava's yes/);
  assert.match(words, /reply_email on its newest message_id, so it stays one thread/);
  assert.equal(mail.sent.length, sent, "nothing sent yet");
  assert.deepEqual(ask.resources, ["juno@acme.example"]);
  assert.match(ask.preview, /^From: sam@bops\.bot\nTo: Juno <juno@acme\.example>\nSubject: Re: Dinner menu\n\nYes, the fish course is still on\./, "Re: kept once");
  assert.match(ask.preview, /In reply to:\nJuno <juno@acme\.example> · [^\n]+ · message_id m_first\nCan you send the dinner menu for Friday\?\n\nYou · [^\n]+ · message_id m_sam\nSure, I'll check with Ava\.\n\nJuno <juno@acme\.example> · [^\n]+\nThanks! Is the fish course still on\?$/, "the thread on its card, the email it answers last");
  assert.equal(approvals().filter((a) => a.kind === "email").length, 1, "asked once");
  // Their yes sends it: AgentMail's reply to that email, so it threads (In-Reply-To, References, Re: are AgentMail's).
  const r = await M.replyEmail(sam().id, { message_id: "m_back", text: "Yes, the fish course is still on.\n\nSam" }, { chatId: inMail("m_back").chatId, outside: true }, { approved: true });
  assert.equal(r, "Replied to Juno <juno@acme.example>.");
  assert.equal(mail.sent.at(-1).path, "/v0/inboxes/in_1/messages/m_back/reply");
  assert.equal(mail.sent.at(-1).body.text, "Yes, the fish course is still on.\n\nSam");
  const card = outCards().at(-1);
  assert.equal(card.email.threadId, "th_dinner", "the sent card is in the same thread");
  assert.equal(card.email.subject, "Re: Dinner menu");
  S.update((s) => void (s.appApprovals = []));
  replyCall = null;
});

await test("On its own: the reply goes in the thread by itself, and the bot tells the user", async () => {
  await patch({ othersMail: "allow" });
  mail.all.push(email("m_again", { thread: "th_dinner", at: at(4), subject: "Re: Dinner menu", text: "Great, and dessert?" }));
  const n = asked.length;
  const sent = mail.sent.length;
  replyCall = { message_id: "m_again", text: "Dessert is a lemon tart.\n\nSam" };
  mail.list = [mail.all.at(-1)];
  await M.checkMailNow();
  await until(() => mail.sent.length > sent, "the reply");
  assert.equal(mail.sent.at(-1).path, "/v0/inboxes/in_1/messages/m_again/reply");
  assert.match(JSON.stringify(turnOf(n)), /Your Replies to others is On its own, so a reply goes at once, never to automatic mail or a bot's, at most 12 an hour/);
  assert.match(JSON.stringify(turnOf(n)), /Great, and dessert\?|message_id m_again/);
  assert.equal(approvals().length, 0, "nothing asked");
  await until(() => S.getState().messages.some((m) => m.role === "bot" && m.text === "I answered Juno in the thread."), "the bot tells the user");
  replyCall = null;
});

await test("the loop guard: never automatic mail or a bot's, at most 12 an hour on its own, then it asks", async () => {
  const where = { chatId: inMail("m_back").chatId, outside: true };
  mail.all.push(
    email("m_news", { thread: "th_news", from: "Deals <deals@shop.example>", headers: { "List-Id": "<deals.shop.example>" }, text: "Sale!" }),
    email("m_bot", { thread: "th_bot", from: "Max <max@zed.bops.bot>", text: "Hi Sam, this is Max." }),
    email("m_lee", { thread: "th_lee", from: "Lee <lee@acme.example>", text: "Quick question" }),
  );
  const sent = mail.sent.length;
  await assert.rejects(M.replyEmail(sam().id, { message_id: "m_news", text: "Thanks" }, where), { name: "NeedsOk" }, "automatic mail: asks");
  await assert.rejects(M.replyEmail(sam().id, { message_id: "m_bot", text: "Hi Max" }, where), { name: "NeedsOk" }, "a bot's: asks");
  assert.match(await M.replyEmail(sam().id, { message_id: "m_bot", text: "Hi Max" }, { chatId: where.chatId }), /^Replied to Max/, "on the user's own turn, as they asked");
  // Twelve sent to others this hour: the next on someone else's turn asks.
  S.update((s) => {
    for (let i = 0; i < 12; i++) s.messages.push({ id: `o_${i}`, chatId: where.chatId, role: "system", text: "Sent", at: Date.now() - 60_000, email: { dir: "out", inboxId: "in_1", messageId: `o_${i}`, threadId: "t", from: "sam@bops.bot", to: ["lee@acme.example"], subject: "Re" } });
  });
  const before = mail.sent.length;
  await assert.rejects(M.replyEmail(sam().id, { message_id: "m_lee", text: "Sure" }, where), (e) => e.name === "NeedsOk" && /Quick question/.test(e.ask.preview), "past 12 an hour: asks, its card with the email");
  assert.equal(mail.sent.length, before, "nothing sent");
  assert.match(await M.sendEmail(sam().id, { to: ["ava@acme.example"], subject: "Note", text: "For you" }, where), /^Sent to ava@acme\.example/, "to the user it still goes");
  assert.match(await M.replyEmail(sam().id, { message_id: "m_lee", text: "Sure" }, { chatId: where.chatId }), /^Replied to Lee/, "the user's own turn has no cap");
  assert.equal(mail.sent.length, sent + 3);
  S.update((s) => void (s.messages = s.messages.filter((m) => !/^o_\d+$/.test(m.id))));
});

await test("Never: nothing goes to anyone else, nothing is asked, and the bot is told so", async () => {
  await patch({ othersMail: "never" });
  const sent = mail.sent.length;
  const r = await M.replyEmail(sam().id, { message_id: "m_lee", text: "Sure" }, { chatId: inMail("m_back").chatId, outside: true });
  assert.equal(r, "Not sent: Ava has Sam email only Ava. Tell Ava what you'd have sent instead.");
  assert.equal(mail.sent.length, sent);
  assert.equal(approvals().length, 0);
  await patch({ othersMail: "ask" });
});

await test("If a send fails: AgentMail busy is tried 2 more times, then the chat says so and today counts it", async () => {
  await patch({ othersMail: "allow" });
  const chatId = inMail("m_back").chatId;
  mail.failWith = 503;
  mail.tries = 0;
  const started = Date.now();
  await assert.rejects(M.replyEmail(sam().id, { message_id: "m_lee", text: "Sure" }, { chatId }));
  assert.equal(mail.tries, 3, "once, then 2 more times");
  assert.ok(Date.now() - started >= 2000, "waiting between tries");
  const note = S.getState().messages.filter((m) => m.chatId === chatId && m.role === "system").at(-1);
  assert.match(note.text, /^Couldn't send this email to Lee <lee@acme\.example>: /);
  // A refusal (a bad address, say) isn't tried again: it wouldn't go the next time either.
  mail.failWith = 422;
  mail.tries = 0;
  await assert.rejects(M.sendEmail(sam().id, { to: ["lee@acme.example"], subject: "Hi", text: "Hello" }, { chatId }));
  assert.equal(mail.tries, 1);
  mail.failWith = 0;
  const t = SQ.todayOf(S.getState(), sam());
  assert.equal(t.mailFailed, 2, "both counted as didn't send");
  assert.deepEqual(W.SETTINGS_WORDS.mailFails, ["Tries 2 more times if AgentMail is busy", "Says so in chat"]);
  await patch({ othersMail: "ask" });
});

await test("Everyone else shows the chain in its steps, for each Replies to others", () => {
  const seq = SQ.BUILT_INS.find((x) => x.id === "othersMail");
  const words = (b, s = {}) => seq.steps(b, s).map((x) => x.text);
  assert.deepEqual(words({ permissions: [{ action: "Send an email", resource: "*", effect: "ask" }] }), ["From anyone else", "Reads the thread", "Tells you in chat", "Replies in the thread with your OK"]);
  assert.deepEqual(words({ permissions: [{ action: "Send an email", resource: "*", effect: "allow" }] }), ["From anyone else", "Reads the thread", "Tells you in chat", "Replies in the thread on its own"]);
  assert.deepEqual(words({}, { mailNever: true }), ["From anyone else", "Reads the thread", "Tells you in chat", "Never replies"]);
  // The words: no dashes of any kind, and never the old name.
  const all = JSON.stringify([words({}), W.SETTINGS_WORDS.mailFails, W.SETTINGS_WORDS.voiceNoteSame("+1 (415) 555 0199"), W.SETTINGS_WORDS.voiceNoteClosest("+1 (415) 555 0199", "Adrian")]);
  assert.doesNotMatch(all, /[‐-―-]|Orbit/);
});

fake.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`voice and mail: ${passed} passed`);
process.exit(0);
