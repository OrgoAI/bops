// Tests for calls to a bot's number answered on this Mac (lib/server/phone-voice.ts): each of the
// caller's turns through AgentPhone's voice agent, answered with OpenAI as the bot. The owner gets the
// whole bot (work handed to its chat as a call in the app does it), anyone else a bot that only takes a
// message; who's calling is Bops Cloud's verdict when there is one; a first call that claimed the line
// links that phone; the call's transcript lands in the bot's chat; slow answers stream a filler first.
// Also the webhook route (a forged verdict on a direct delivery is ignored) and texts that follow the
// cloud's verdict (lib/server/phone.ts). OpenAI is a fake on localhost and the state a throwaway file
// store in a temporary folder: nothing reaches OpenAI, AgentPhone or Orgo, and nobody is texted.
// Usage: node --conditions=react-server scripts/test-phone-voice.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Self-hosting, on a made-up OpenAI key pointed at the fake; the state in a throwaway file store; no other service.
for (const k of ["BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "BOPS_MAIL_DOMAIN", "HONCHO_API_KEY", "COMPOSIO_API_KEY", "TYPESAFE_API_KEY", "ORGO_API_KEY", "TAILSCALE_AUTH_KEY", "BOPS_PHONE_MODEL", "BOPS_CHAT_MODEL", "OPENAI_WEBHOOK_SECRET"])
  delete process.env[k];
Object.assign(process.env, {
  BOPS_SELF_HOSTED: "1",
  OPENAI_API_KEY: "sk-test-not-a-real-key",
  AGENTPHONE_API_KEY: "ap-test-not-a-real-key",
  AGENTPHONE_WEBHOOK_SECRET: "whsec-test",
  BOPS_PHONE_DRY_RUN: "1",
  BOPS_OWNER_PHONES: "+14155550100",
});
const OWNER = "+14155550100";
const LINE = "+14155550199";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded (Codex, the relay's agent) or that Node can't load
// (the desktop look draws the mascot's JSX, mirror.ts has parameter properties) are stand-ins: each of
// their exports does nothing (as scripts/test-plan.mjs).
const STAND_INS = new Set(["codex", "relay", "desktop", "mirror"]);
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
const scratch = mkdtempSync(join(tmpdir(), "bops-test-phone-voice-"));
process.chdir(scratch);
// Signed out, and the Keychain is never asked (lib/server/orgo-auth.ts).
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Infinity;

/* ---------------- A fake OpenAI ---------------- */

/** Every Responses request: the call's turns (tools delegate/take_message) and the bot's chat. */
const asked = [];
/** What a call's next turn answers: the words, tool calls, and how long it takes. */
let phoneReply = () => ({ text: "Hi there." });
const responseOf = (r) => ({
  id: `resp_${asked.length}`,
  object: "response",
  model: "gpt-test",
  status: "completed",
  output: [
    ...(r.text ? [{ id: `msg_${asked.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: r.text, annotations: [] }] }] : []),
    ...(r.tools ?? []).map((t, i) => ({ id: `fc_${i}`, type: "function_call", call_id: `call_${i}`, name: t.name, arguments: JSON.stringify(t.args), status: "completed" })),
  ],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});
const fake = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.method !== "POST" || req.url !== "/v1/responses") return void res.writeHead(404).end("{}");
  const names = (body.tools ?? []).map((t) => t.name);
  const phone = names.includes("end_call");
  asked.push({ phone, body });
  // The bot's chat (handed a call's work): it just answers.
  const r = phone ? phoneReply(body) : { text: "On it, sending now." };
  if (r.delayMs) await new Promise((done) => setTimeout(done, r.delayMs));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(responseOf(r)));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
// Nothing leaves this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error(`not a fake: ${url}`);
  return realFetch(input, init);
};

const S = await import(`${root}/lib/server/store.ts`);
const P = await import(`${root}/lib/server/phone.ts`);
const V = await import(`${root}/lib/server/phone-voice.ts`);
const route = await import(`${root}/app/api/phone/agentphone/route.ts`);

// The main bot (Boppy) has the workspace's number, on AgentPhone agent agt_ws.
S.update((s) => {
  s.owner = { name: "Alex", about: "Lives in Oakland." };
  const ws = (s.workspaces ??= [{ id: "ws_main", name: "Main", createdAt: 1 }]).find((w) => w.id === "ws_main") ?? s.workspaces[0];
  ws.line = { phone: LINE, numberId: "num_ws", agentId: "agt_ws", type: "sms", scope: "sub", at: 1 };
});
const main = S.getState().bots.find((b) => b.isMain);
assert.ok(main, "a fresh state has a main bot");
const chatId = `bot:${main.id}`;
const messages = () => S.getState().messages.filter((m) => m.chatId === chatId);
const lastPhone = () => asked.filter((a) => a.phone).at(-1).body;
let n = 0;
const turn = (from, transcript, callId) => ({ event: "agent.message", channel: "voice", agentId: "agt_ws", data: { callId, from, to: LINE, transcript, direction: "inbound" } });
const until = async (check, what, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/* ---------------- The owner ---------------- */

{
  const call = `call_${++n}`;
  phoneReply = () => ({ text: `Hi Alex, it's ${main.name}. **What's up?**` });
  assert.deepEqual(await V.voiceTurn(turn(OWNER, "", call)), { text: `Hi Alex, it's ${main.name}. What's up?` }, "spoken words only");
  const first = lastPhone();
  // The hello doesn't wait on the whole prompt: a quick one, while the whole one is built for the next turns.
  assert.match(first.instructions, new RegExp(`^You are ${main.name}, Alex's chief of staff in Bops, on a phone call with Alex\\.`));
  assert.match(first.instructions, /Each of your replies is spoken aloud by a voice that reads your text/);
  assert.deepEqual(first.tools.map((t) => t.name), ["delegate", "end_call"]);
  assert.deepEqual(first.reasoning, { effort: "low" });
  assert.equal(first.store, false);
  assert.deepEqual(first.input, [{ role: "user", content: "(The call just connected; the caller hasn't said anything yet. Say hello.)" }]);
  assert.equal(V.callOpen(call), true);

  // Real work goes to the bot's chat, as a call in the app hands it over; the bot says it's on it right away.
  phoneReply = () => ({ tools: [{ name: "delegate", args: { request: "Email Jordan the deck", say: "On it, I'll send it now." } }] });
  assert.deepEqual(await V.voiceTurn(turn(OWNER, "Can you email Jordan the deck?", call)), { text: "On it, I'll send it now." });
  const whole = lastPhone().instructions;
  assert.match(whole, new RegExp(`^You are ${main.name}, Alex's chief of staff in Bops, on a phone call with Alex\\.`));
  assert.match(whole, /Alex called your phone number, and you picked up\. Each of your replies is spoken aloud/, "the whole prompt from the second turn on");
  assert.match(whole, /call delegate with what they asked/);
  assert.doesNotMatch(whole, /Hello\? Can you hear me\?/, "no GPT-Live greeting");
  await until(() => messages().some((m) => m.role === "bot" && m.text === "On it, sending now."), "the bot's chat to take the work");
  assert.ok(messages().some((m) => m.role === "user" && m.text === "Email Jordan the deck"));
  // The next turn knows how it went.
  phoneReply = () => ({ text: "Sent." });
  await V.voiceTurn(turn(OWNER, "Is it done?", call));
  assert.match(lastPhone().instructions, /Work Alex asked for on this call[^\n]*\n- "Email Jordan the deck": your chat said: "On it, sending now\."/);
  assert.deepEqual(lastPhone().input.slice(-3), [
    { role: "user", content: "Can you email Jordan the deck?" },
    { role: "assistant", content: "On it, I'll send it now." },
    { role: "user", content: "Is it done?" },
  ]);
  // A goodbye hangs up, and the call's transcript is in the chat (and its tokens counted as a call's).
  phoneReply = () => ({ tools: [{ name: "end_call", args: { say: "Bye Alex!" } }] });
  assert.deepEqual(await V.voiceTurn(turn(OWNER, "Thanks, bye.", call)), { text: "Bye Alex!", hangup: true });
  assert.equal(V.callOpen(call), false);
  const card = messages().find((m) => m.sms?.id === `call:${call}`);
  assert.ok(card, "the call is in the chat");
  assert.equal(card.role, "system");
  assert.equal(card.sms.from, OWNER);
  assert.equal(card.call.phone, OWNER);
  assert.equal(card.text.split("\n")[0], `${main.name}: Hi Alex, it's ${main.name}. What's up?`);
  assert.ok(card.text.includes("You: Can you email Jordan the deck?\n"));
  assert.ok(card.text.endsWith(`${main.name}: Bye Alex!`));
  assert.equal((S.getState().usage ?? []).filter((u) => u.kind === "model.tokens" && u.source === "call").length, 4, "each of the 4 turns");
  console.log("owner call ->", card.text.split("\n").length, "lines in the chat");
}

/* ---------------- Anyone else ---------------- */

{
  const call = `call_${++n}`;
  const stranger = "+13125550142";
  phoneReply = () => ({
    text: "Sure.",
    tools: [
      { name: "take_message", args: { name: "Jordan", text: "Wants to talk about the quote", callback: "+1 312 555 0142", say: "I'll pass that on." } },
      { name: "end_call", args: { say: "Bye!" } },
    ],
  });
  const before = asked.length;
  assert.deepEqual(await V.voiceTurn(turn(stranger, "Hi, can Alex call me back about the quote?", call)), { text: "Sure. I'll pass that on. Bye!", hangup: true });
  const body = asked.slice(before).find((a) => a.phone).body;
  assert.match(body.instructions, new RegExp(`^You are ${main.name}, an AI assistant who answers this phone number for the person you work for\\.`));
  for (const secret of ["Alex", "Oakland", "Jordan the deck"]) assert.ok(!body.instructions.includes(secret), `the stranger's bot isn't told "${secret}"`);
  assert.deepEqual(body.tools.map((t) => t.name), ["take_message", "end_call"], "no delegate");
  assert.equal(asked.slice(before).filter((a) => !a.phone).length, 0, "nothing reaches the bot's chat");
  const card = messages().find((m) => m.sms?.id === `call:${call}`);
  assert.equal(card.text.split("\n")[0], 'Left a message (Jordan): "Wants to talk about the quote" Reach them at +1 312 555 0142.');
  assert.ok(card.text.includes("Caller: Hi, can Alex call me back about the quote?"));
  assert.equal(card.ping, true);
}

/* ---------------- Bops Cloud's verdict ---------------- */

{
  // The cloud says it isn't the owner, even for a number this Mac counts: the cloud wins.
  const call = `call_${++n}`;
  phoneReply = () => ({ text: "Hello, can I take a message?" });
  await V.voiceTurn(turn(OWNER, "Hi", call), { owner: false });
  assert.match(lastPhone().instructions, /The caller is someone else/);
  V.phoneCallEnded(turn(OWNER, "", call));
  assert.equal(V.callOpen(call), false, "AgentPhone's call_ended ends it");

  // A first call that claimed the line: the phone is the user's here too, and the bot says it's linked.
  const mine = "+16175550123";
  const claimed = `call_${++n}`;
  phoneReply = () => ({ text: "You're linked. Hi Alex!" });
  await V.voiceTurn(turn(mine, "", claimed), { owner: true, claimed: "call" });
  assert.match(lastPhone().instructions, /This caller just linked their phone to you/);
  const saved = S.getState().ownerPhones.find((p) => p.number === mine);
  assert.equal(saved.claimedVia, "call");
  assert.ok(saved.verifiedAt);
  assert.equal(P.isOwner(mine), true, "texts from it count as the user now, and bots text it");
  assert.ok(messages().some((m) => m.role === "system" && m.text.startsWith(`Linked your phone +1 (617) 555-0123 to ${main.name}'s number +1 (415) 555-0199: it called first`)));
  await V.voiceTurn(turn(mine, "Thanks", claimed), { owner: true });
  assert.doesNotMatch(lastPhone().instructions, /just linked/, "said once");
  V.phoneCallEnded(turn(mine, "", claimed));
}

/* ---------------- Timing ---------------- */

{
  const saved = { ...V.voiceTiming };
  // A call nobody speaks on for a while ends by itself.
  V.voiceTiming.idleMs = 30;
  const quiet = `call_${++n}`;
  phoneReply = () => ({ text: "Hello?" });
  await V.voiceTurn(turn(OWNER, "", quiet));
  await until(() => !V.callOpen(quiet), "the quiet call to end");
  assert.ok(messages().some((m) => m.sms?.id === `call:${quiet}`));
  // A turn the model takes too long on asks again instead of leaving the caller in silence.
  V.voiceTiming.turnMs = 50;
  phoneReply = () => ({ text: "Too late.", delayMs: 300 });
  assert.deepEqual(await V.voiceTurn(turn(OWNER, "Hello?", `call_${++n}`)), { text: "Sorry, give me a second. Could you say that again?" });
  Object.assign(V.voiceTiming, saved);
  // Straight from AgentPhone: a quick answer is JSON, a slow one NDJSON with a filler first.
  V.voiceTiming.fillerAfterMs = 20;
  const quick = await V.voiceResponse(Promise.resolve({ text: "Hi." }));
  assert.equal(quick.headers.get("content-type"), "application/json");
  assert.deepEqual(await quick.json(), { text: "Hi." });
  const hello = await V.voiceResponse(new Promise((r) => setTimeout(() => r({ text: "Hi, it's me." }), 100)), false);
  assert.equal(hello.headers.get("content-type"), "application/json", "no filler before the hello");
  const slow = await V.voiceResponse(new Promise((r) => setTimeout(() => r({ text: "Here.", hangup: true }), 100)));
  assert.equal(slow.headers.get("content-type"), "application/x-ndjson");
  assert.deepEqual(
    (await slow.text()).trim().split("\n").map((l) => JSON.parse(l)),
    [{ text: "Mm-hm, one sec.", interim: true }, { text: "Here.", hangup: true }],
  );
  Object.assign(V.voiceTiming, saved);
}

/* ---------------- The webhook route ---------------- */

{
  const post = (event, headers = {}) => {
    const body = JSON.stringify(event);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${createHmac("sha256", "whsec-test").update(`${ts}.${body}`).digest("hex")}`;
    return route.POST(new Request("http://127.0.0.1:3210/api/phone/agentphone", { method: "POST", headers: { "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature": sig, ...headers }, body }));
  };
  // A verdict on a delivery that didn't come through Bops Cloud's tunnel is anyone's to write: ignored.
  const call = `call_${++n}`;
  phoneReply = () => ({ text: "Hi, can I take a message?" });
  const res = await post(turn("+12125550111", "Hi, it's me", call), { "x-bops-caller": JSON.stringify({ owner: true }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "Hi, can I take a message?" });
  assert.match(lastPhone().instructions, /The caller is someone else/, "a forged verdict doesn't make a stranger the owner");
  const ended = await post({ event: "agent.call_ended", agentId: "agt_ws", data: { callId: call } });
  assert.equal(ended.status, 200);
  assert.equal(V.callOpen(call), false);
  // Unsigned: turned away before anything is answered.
  const unsigned = await route.POST(new Request("http://127.0.0.1:3210/api/phone/agentphone", { method: "POST", body: JSON.stringify(turn(OWNER, "Hi", "x")) }));
  assert.equal(unsigned.status, 400);
}

/* ---------------- Texts follow the cloud's verdict ---------------- */

{
  // The cloud says a number this Mac counts isn't the owner: the text is dropped.
  const before = S.getState().messages.length;
  P.agentPhoneEvent({ event: "agent.message", channel: "sms", agentId: "agt_ws", data: { id: "ap_1", from: OWNER, to: LINE, message: "hello" } }, "d1", { owner: false });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(S.getState().messages.length, before, "nothing reaches the chat");
  // A first text that claimed the line: linked, told so by text, and answered as the user.
  const mine = "+15035550177";
  P.agentPhoneEvent({ event: "agent.message", channel: "sms", agentId: "agt_ws", data: { id: "ap_2", from: mine, to: LINE, message: "hey" } }, "d2", { owner: true, claimed: "text" });
  await until(() => messages().some((m) => m.role === "user" && m.text === "hey"), "the text to reach the chat as the user's");
  assert.equal(S.getState().ownerPhones.find((p) => p.number === mine)?.claimedVia, "text");
  await until(() => messages().some((m) => m.text.startsWith(`[dry run] would text +1 (503) 555-0177 from +1 (415) 555-0199 (sms): Linked. Texts and calls from this phone count as you now.`)), "the linked text");
  // P.verdictOf reads only a well-formed verdict.
  assert.deepEqual(P.verdictOf('{"owner":true,"claimed":"text"}'), { owner: true, claimed: "text" });
  assert.deepEqual(P.verdictOf({ owner: false, claimed: "sms" }), { owner: false });
  assert.equal(P.verdictOf("yes"), undefined);
  assert.equal(P.verdictOf({ owner: "true" }), undefined);
  assert.equal(P.verdictOf(null), undefined);
}

console.log(`all phone voice tests passed (${asked.length} fake OpenAI calls, none to the network)`);
fake.close();
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
