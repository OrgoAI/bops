// Tests for the bots' moods while they work: which one each bot shows (lib/bot-mood.ts moodOf, from the
// app's state and the call: speaking, then coding, writing, shy after a thanks, thinking, working, idle), each
// mood's pose (lib/mascot.ts), the idle and awake pictures (Slack, Telegram and Discord show them: the other bots'
// as before, the main bot's as redrawn), the mascots that move and those that only open their eyes
// (components/app/mascot.tsx, ChatAvatar), the motions in app/globals.css (transform and opacity only,
// held still with reduced motion), when the call bar says the bot is talking (components/app/call-bar.tsx
// botTalking), and the blush wearing off on its own (BotMoodsFrom). And coding bots: which bots are coders
// (codersOf), the coder's mark on every mascot of theirs big enough to read it, and when a thread is coding
// (codingThread: running on one of the workspace's apps, the user's own ask, where apps show). Last, the mascots people
// face (Mascot's life: the chat's header, an empty chat, a bot's profile): every drawing they start from as it was,
// the blink's timing, the breath and the settle, the listening pose while the person writes, held still with reduced
// motion, resting while the window is hidden, and never on a list's rows.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-bot-moods.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});

// A window, enough of one (nothing here runs effects: it's rendered to HTML).
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { BLINK_LOOP_S, blinkPhase, CODER_MIN_SIZE, faceOf, mascotMarkup, mascotSvg, MOVING_MOODS, PICTURE_COLORS, PICTURE_SHAPES } = await import(pathToFileURL(`${root}/lib/mascot.ts`).href);
const { codersOf, codingThread, isPraise, moodOf, moodSignals, NO_SIGNALS, SHY_MS } = await import(pathToFileURL(`${root}/lib/bot-mood.ts`).href);
const { BotMoods, BotMoodsFrom, BREATH_MIN_SIZE, CallTalking, LIFE_MIN_SIZE, Mascot, talkingStore } = await import(pathToFileURL(`${root}/components/app/mascot.tsx`).href);
const { stateArrived } = await import(pathToFileURL(`${root}/components/app/state-arrival.ts`).href);
const { ChatAvatar } = await import(pathToFileURL(`${root}/components/app/ui.tsx`).href);
const { ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { botTalking, BOT_TALKING } = await import(pathToFileURL(`${root}/components/app/call-bar.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

const session = (botId, status = "running", extra = {}) => ({ id: `s-${botId}-${status}`, botId, chatId: `chat-${botId}`, status, steps: [], ...extra });
const chat = (id, typing = [], botIds = typing) => ({ id, kind: botIds.length > 1 ? "group" : "bot", botIds, typing, createdAt: 0 });
const state = (sessions = [], chats = []) => ({ sessions, chats });

await test("the idle and awake pictures are exactly what they were (every bot shape, color, headphones and size), the main bot's as redrawn", () => {
  // The same drawings Slack, Telegram and Discord show (scripts/render-mascots.mjs) and the bots'
  // desktops use (mascotSvg): their markup, hashed. The other bots' from before the moods came in; the
  // main bot's flat like the app icon (white oval eyes, ink outlined headphones and band), awake as its
  // "ooh" (tilted, eyes glancing up, a small round mouth).
  const pictures = (ids) => {
    const colors = ["#0A0A0A", "#FF9F43", "#2EC4B6", "#E9FF3B"];
    let all = "";
    for (const id of ids)
      for (const c of colors)
        for (const mood of [undefined, "idle", "awake"])
          for (const accent of [undefined, true, false]) all += mascotMarkup(id, c, { ...(mood ? { mood } : {}), ...(accent === undefined ? {} : { accent }) }) + "\n";
    for (const id of ids) all += mascotSvg(id, "#FF6FB5", 104) + mascotSvg(id, "#47C46B", 32, "awake") + "\n";
    assert.doesNotMatch(all, /mascot-/, "no motion classes in the pictures");
    return createHash("sha256").update(all).digest("hex");
  };
  assert.equal(pictures(["penny", "otto", "rook", "bot", "max", "ivy-2", "writer", "zed"]), "b4d196e8d6593177a46c436ad79a04d5675d63b4d4516a21272202c0af8d8637", "the other bots");
  assert.equal(pictures(["boppy", "sam", "sam-2", "boppy-3"]), "8048cae8c1a81111749d191c79f20445af256ede668eb472eb776856cdfe82eb", "the main bot");
  // Flat: no blush, gloss or shine on the main bot in any mood (but shy, whose blush is the point).
  for (const mood of ["idle", "awake", "listening", ...MOVING_MOODS.filter((m) => m !== "shy")]) assert.doesNotMatch(mascotMarkup("boppy", "#0A0A0A", { mood }).replace(/<g class="mascot-(thought|pencil|laptop)[\s\S]*$/, ""), /opacity|#FF8FB8/, mood);
});

await test("each moving mood is its own pose, still on its own, with the classes the app's motions use", () => {
  for (const id of ["boppy", "max", "penny", "otto"]) {
    const awake = mascotMarkup(id, "#FF9F43", { mood: "awake" });
    const of = (mood) => mascotMarkup(id, "#FF9F43", { mood });
    // Thinking: eyes glancing up (already, without motion) under a bubble of three dots.
    assert.match(of("thinking"), /<g class="mascot-glance" transform="translate\(\.6 -1\.4\)">/);
    assert.equal(of("thinking").match(/class="mascot-thought-dot"/g).length, 3);
    // Writing: eyes down toward the pencil, the pencil (highlighter body, pink eraser) on a line of writing.
    assert.match(of("writing"), /<g transform="translate\(-\.6 \.9\)">/);
    assert.match(of("writing"), /class="mascot-pencil".*fill="#E9FF3B".*fill="#FF8FB8"/);
    assert.match(of("writing"), /class="mascot-scribble"/);
    // Speaking: an open mouth (in the eyes' color) and two sound arcs.
    assert.match(of("speaking"), new RegExp(`class="mascot-mouth"[^>]*fill="${id === "boppy" ? "#fff" : "#1C1C1B"}"`));
    assert.equal(of("speaking").match(/<g class="mascot-sound"[^>]*>(.*?)<\/g>/)[1].match(/<path/g).length, 2);
    // Shy: eyes looking down and away, two cheeks glowing (pink on the main bot's black, a deeper rose on a colored body).
    assert.match(of("shy"), /<g transform="translate\(-\.6 \.9\)">/);
    assert.equal(of("shy").match(new RegExp(`<g class="mascot-blush" fill="${id === "boppy" ? "#FF8FB8" : "#E0245E"}">(.*?)</g>`))[1].match(/<ellipse/g).length, 2);
    // Coding: eyes down toward its laptop (as writing), its cups bouncing as at work, and on the laptop's dark
    // screen three short lines of code, each typing in on its own delay, with a caret after the last.
    assert.match(of("coding"), /<g transform="translate\(-\.6 \.9\)">/);
    assert.equal(of("coding").match(/class="mascot-cup( mascot-cup-r)?"/g).length, 2);
    assert.equal(of("coding").match(/<rect class="mascot-code-line"[^>]*style="animation-delay:-?[\d.]+s"\/>/g).length, 3);
    assert.equal(of("coding").match(/class="mascot-caret"/g).length, 1);
    // Working: the awake face and its cups on their own, bouncing, the whole bot bopping.
    assert.match(of("working"), /^<g class="mascot-working">/);
    assert.equal(of("working").match(/class="mascot-cup( mascot-cup-r)?"/g).length, 2);
    assert.equal(of("working").replace(/<\/?g( class="[^"]*")?>/g, "").length, awake.replace(/<\/?g( class="[^"]*")?>/g, "").length, "the same shapes as awake, the cups' pads drawn with their cups");
    // Only its own extras: no bubble while writing, no pencil while talking.
    for (const mood of MOVING_MOODS) {
      const m = of(mood);
      assert.equal(/mascot-thought/.test(m), mood === "thinking", `${mood}: bubble`);
      assert.equal(/mascot-pencil/.test(m), mood === "writing", `${mood}: pencil`);
      assert.equal(/mascot-laptop/.test(m), mood === "coding", `${mood}: laptop`);
      assert.equal(/mascot-sound/.test(m), mood === "speaking", `${mood}: sound`);
      assert.equal(/mascot-blush/.test(m), mood === "shy", `${mood}: cheeks`);
      assert.match(m, new RegExp(`^<g class="mascot-${mood}">`));
    }
  }
});

await test("the main bot awake is the app icon's \"ooh\": tilted, eyes glancing up, a small round mouth; thinking and working keep it", () => {
  const ooh = /^<g transform="translate\(20 21\.4\) scale\(\.92\) translate\(-20 -20\)"><g transform="rotate\(-9 20 20\)">.*transform="translate\(\.6 -1\.4\)">.*<ellipse cx="20\.8" cy="26\.6" rx="1\.35" ry="1\.65" fill="#fff"\/>/;
  assert.match(mascotMarkup("boppy", "#0A0A0A", { mood: "awake" }), ooh);
  for (const mood of ["thinking", "working"]) assert.match(mascotMarkup("boppy", "#0A0A0A", { mood }).replace(/^<g class="mascot-[a-z]+">/, ""), ooh, mood);
  // Idle stands up straight, eyes shut, no mouth; speaking faces you with its round mouth moving.
  assert.doesNotMatch(mascotMarkup("boppy", "#0A0A0A", { mood: "idle" }), /rotate|ellipse/);
  assert.match(mascotMarkup("boppy", "#0A0A0A", { mood: "speaking" }), /<ellipse class="mascot-mouth"[^>]*fill="#fff"\/>/);
  assert.doesNotMatch(mascotMarkup("boppy", "#0A0A0A", { mood: "speaking" }), /rotate\(/);
  // Coding leans toward its laptop as writing leans toward its pencil, looking down, no mouth; the laptop's
  // lid is its cups' highlighter, or light with its headphones in ink (the dark grey would be lost on its head).
  const codes = mascotMarkup("boppy", "#0A0A0A", { mood: "coding" });
  assert.match(codes, /<g transform="rotate\(-5 20 20\)">.*<g transform="translate\(-\.6 \.9\)">/);
  assert.doesNotMatch(codes, /cy="2[56]\.[68]"/, "no mouth");
  assert.match(codes, /<g class="mascot-laptop"><rect [^>]*fill="#E9FF3B" stroke="#0A0A0A"/);
  assert.match(mascotMarkup("boppy", "#0A0A0A", { mood: "coding", accent: false }), /<g class="mascot-laptop"><rect [^>]*fill="#E4E4DE" stroke="#0A0A0A"/);
});

await test("speaking beats writing beats thinking beats working beats idle", () => {
  const all = moodSignals(state([session("max", "running", { activity: "writing" })], [chat("chat-max", ["max"])]), { botId: "max", speaking: true });
  assert.equal(moodOf(all, "max"), "speaking");
  const noCall = moodSignals(state([session("max", "running", { activity: "writing" })], [chat("chat-max", ["max"])]));
  assert.equal(moodOf(noCall, "max"), "writing");
  const reply = moodSignals(state([session("max", "running", { activity: "searching" })], [chat("chat-max", ["max"])]));
  assert.equal(moodOf(reply, "max"), "thinking");
  const thread = moodSignals(state([session("max", "running", { activity: "searching" })], [chat("chat-max")]));
  assert.equal(moodOf(thread, "max"), "working");
  assert.equal(moodOf(thread, "ivy"), "idle", "a bot with nothing going on");
  assert.equal(moodOf(NO_SIGNALS, "max"), "idle");
});

await test("each signal: a live thread works, a writing one writes, a reply thinks, a call works and talks while the bot's voice comes through", () => {
  for (const status of ["queued", "starting", "running"]) assert.equal(moodOf(moodSignals(state([session("max", status)])), "max"), "working", status);
  for (const status of ["done", "failed", "stopped"]) {
    assert.equal(moodOf(moodSignals(state([session("max", status)])), "max"), "idle", `${status}: not at work`);
    assert.equal(moodOf(moodSignals(state([session("max", status, { activity: "writing" })])), "max"), "idle", `${status}: its last caption doesn't count`);
  }
  assert.equal(moodOf(moodSignals(state([session("max", "running", { askWhere: true })])), "max"), "idle", "a thread waiting to be told where to run isn't running");
  // Paused for the user's OK (its request unanswered: lib/types.ts waitsForOk), queued and doing nothing: no work. Answered, it's on again.
  const ask = { id: "apr_1", threadId: "s-max-queued", botId: "max", action: "Send an email", resources: [], preview: "", at: 1 };
  assert.equal(moodOf(moodSignals({ ...state([session("max", "queued")]), appApprovals: [ask] }), "max"), "idle", "waiting for the OK isn't working");
  assert.equal(moodOf(moodSignals({ ...state([session("max", "queued")]), appApprovals: [{ ...ask, reply: { reply: "once", at: 2 } }] }), "max"), "working", "answered: going on");
  assert.equal(moodOf(moodSignals(state([session("max", "running", { activity: "filling a form" })])), "max"), "working", "only writing text is writing");
  assert.equal(moodOf(moodSignals(state([], [chat("g1", ["max"], ["max", "ivy"])])), "max"), "thinking", "a reply in a group");
  assert.equal(moodOf(moodSignals(state(), { botId: "max", speaking: false }), "max"), "working", "on a call, listening");
  assert.equal(moodOf(moodSignals(state(), { botId: "max", speaking: true }), "max"), "speaking");
  assert.equal(moodOf(moodSignals(state(), { botId: "max", speaking: true }), "ivy"), "idle", "only the bot on the call");
  assert.equal(moodSignals(state()).call, undefined);
  assert.equal(moodSignals(state(), null).call, undefined);
});

const said = (chatId, text, at, role = "user") => ({ id: `m-${at}-${text}`, chatId, role, text, at });

await test("thanks and praise make a bot shy for a few seconds, every bot in that chat, and nothing else does", () => {
  for (const t of ["thanks!", "Thank you so much", "thank you so much Max!", "thx", "ty", "great job", "nice work Max", "nice one", "you're the best", "love it", "I love it", "perfect, ship it", "🙏", "❤️", "🙏🙏", "well done!", "appreciate it", "No problem, thanks!", "no worries, thanks!", "ok thanks", "thanks for the summary", "Thanks, that's exactly it."])
    assert.ok(isPraise(t), t);
  // Not a thanks: requests and complaints that only mention one, and thanks that go on to ask for something.
  for (const t of ["no thanks", "nope, thanks anyway", "not perfect yet", "that wasn't great", "don't love it", "fix the login page", "what's the weather", "x".repeat(200) + " thanks",
    "add a legend to the chart", "write a thank you note to my landlord", "draft a thank-you email to Sarah", "email John and thank him for the intro", "find me the perfect gift for my mom",
    "I'd love it if you could book me a flight", "find a good one under $50", "can you do this asap 🙏", "Thanks, but that's wrong, redo it", "thanks! now book the flight",
    "thanks, can you also send it to Sarah?", "perfect the copy on the landing page and the pricing table", "thanks for the summary, now draft the email to the whole team"])
    assert.ok(!isPraise(t), t);
  const now = 1_000_000;
  const chats = [chat("chat-max", [], ["max"]), chat("g1", [], ["max", "ivy"])];
  const sig = (messages) => moodSignals({ sessions: [], chats, messages }, null, now);
  assert.equal(moodOf(sig([said("chat-max", "thanks!", now - 1000)]), "max"), "shy");
  assert.equal(moodOf(sig([said("chat-max", "thanks!", now - 1000)]), "ivy"), "idle", "only the bots in that chat");
  assert.equal(sig([said("chat-max", "thanks!", now - 1000)]).shyUntil, now - 1000 + SHY_MS, "when it wears off");
  assert.equal(moodOf(sig([said("chat-max", "thanks!", now - SHY_MS)]), "max"), "idle", "worn off");
  assert.equal(sig([said("chat-max", "thanks!", now - SHY_MS)]).shyUntil, undefined);
  assert.equal(moodOf(sig([said("chat-max", "thanks!", now - 1000, "bot")]), "max"), "idle", "the bot thanking you");
  assert.equal(moodOf(sig([said("chat-max", "fix the login page", now - 1000)]), "max"), "idle");
  const group = sig([said("g1", "thanks team", now - 500)]);
  assert.equal(moodOf(group, "max"), "shy");
  assert.equal(moodOf(group, "ivy"), "shy");
  // Writing (and talking) beat shy; shy beats a reply on its way.
  const busy = moodSignals({ sessions: [session("max", "running", { activity: "writing" })], chats: [chat("chat-max", ["max"], ["max"])], messages: [said("chat-max", "thanks!", now - 500)] }, null, now);
  assert.equal(moodOf(busy, "max"), "writing");
  const replying = moodSignals({ sessions: [], chats: [chat("chat-max", ["max"], ["max"])], messages: [said("chat-max", "thanks!", now - 500)] }, null, now);
  assert.equal(moodOf(replying, "max", "chat-max"), "shy");
  // No messages in the state at all: nobody's shy.
  assert.equal(moodSignals(state()).shy.size, 0);
  assert.equal(NO_SIGNALS.shy.size, 0);
});

await test("Otto's cheeks sit clear of its glasses", () => {
  assert.match(mascotMarkup("otto", "#E9FF3B", { mood: "shy" }), /<g class="mascot-blush" fill="#E0245E"><ellipse cx="12\.2" cy="29\.2"/);
});

await test("BotMoodsFrom gives every mascot inside the moods from the state, a fresh thanks making its bot shy", () => {
  const st = { sessions: [], chats: [chat("chat-max", [], ["max"])], messages: [said("chat-max", "thank you!", Date.now())] };
  const html = renderToStaticMarkup(h(BotMoodsFrom, { state: st, call: null }, h(Mascot, { botId: "max", color: "#FF9F43", live: true })));
  assert.ok(html.includes(mascotMarkup("max", "#FF9F43", { mood: "shy" })));
  const at = (messages) => renderToStaticMarkup(h(BotMoodsFrom, { state: { ...st, messages }, call: null }, h(Mascot, { botId: "max", color: "#FF9F43", live: true })));
  const idle = mascotMarkup("max", "#FF9F43", { mood: "idle" });
  assert.ok(at([said("chat-max", "thank you!", Date.now() - SHY_MS - 1)]).includes(idle), "worn off");
  // Read at when the state came in: a thanks synced in an hour late (the Mac waking) is an hour old,
  // even with the bot's reply to it just behind; one stamped a minute ahead (another clock) isn't fresh.
  stateArrived(Date.now());
  assert.ok(at([said("chat-max", "thanks!", Date.now() - 3_600_000), said("chat-max", "anytime!", Date.now() - 3_597_000, "bot")]).includes(idle), "synced in late");
  assert.ok(at([said("chat-max", "thanks!", Date.now() + 60_000)]).includes(idle), "a clock ahead");
  assert.ok(at([said("chat-max", "thanks!", Date.now() - 500)]).includes(mascotMarkup("max", "#FF9F43", { mood: "shy" })), "just sent");
});

await test("a chat's mascot thinks over a reply in that chat; one in another chat keeps it working", () => {
  const sig = moodSignals(state([], [chat("chat-max", []), chat("g1", ["max"], ["max", "ivy"])]));
  assert.equal(moodOf(sig, "max", "g1"), "thinking");
  assert.equal(moodOf(sig, "max", "chat-max"), "working");
  assert.equal(moodOf(sig, "ivy", "g1"), "idle", "a member who isn't replying");
  // Writing (a thread of its own) shows wherever the bot does, its typing line too.
  const writes = moodSignals(state([session("max", "running", { activity: "writing" })], [chat("g1", ["max"], ["max", "ivy"])]));
  assert.equal(moodOf(writes, "max", "g1"), "writing");
});

const withMoods = (signals, el) => renderToStaticMarkup(h(BotMoods.Provider, { value: signals }, el));

await test("only live mascots move; the rest open their eyes as before, and idle ones vibe", () => {
  const sig = moodSignals(state([], [chat("chat-max", ["max"])]));
  const live = withMoods(sig, h(Mascot, { botId: "max", color: "#FF9F43", size: 44, live: true, chatId: "chat-max" }));
  assert.ok(live.includes(mascotMarkup("max", "#FF9F43", { mood: "thinking" })), "thinking in its chat's row");
  assert.doesNotMatch(live, /mascot-paused/, "moving while the window is on screen");
  const still = withMoods(sig, h(Mascot, { botId: "max", color: "#FF9F43", size: 18, antenna: false }));
  assert.ok(still.includes(mascotMarkup("max", "#FF9F43", { mood: "awake", accent: false })), "elsewhere: awake, still");
  assert.doesNotMatch(still, /mascot-/);
  const idle = withMoods(sig, h(Mascot, { botId: "ivy", color: "#60A5FA", live: true }));
  assert.ok(idle.includes(mascotMarkup("ivy", "#60A5FA", { mood: "idle" })));
  // With no app around it (the sign-in screen, setup), every mascot is idle.
  assert.ok(renderToStaticMarkup(h(Mascot, { botId: "boppy", color: "#0A0A0A", live: true })).includes(mascotMarkup("boppy", "#0A0A0A")));
});

await test("the sidebar's rows and the chat's header (ChatAvatar) move, each bot of a group by its own mood in that chat", () => {
  const bots = [
    { id: "max", color: "#FF9F43" },
    { id: "ivy", color: "#60A5FA" },
  ];
  const sig = moodSignals(state([session("ivy")], [chat("g1", ["max"], ["max", "ivy"])]), { botId: "boppy", speaking: true });
  const group = withMoods(sig, h(ChatAvatar, { chat: chat("g1", ["max"], ["max", "ivy"]), bots, size: 44 }));
  assert.match(group, /mascot-thinking/, "Max, replying");
  assert.match(group, /mascot-working/, "Ivy, on a thread");
  const solo = withMoods(sig, h(ChatAvatar, { chat: chat("chat-max", [], ["max"]), bots, size: 40 }));
  assert.match(solo, /mascot-working/, "Max replying in the group: working in its own chat's row");
});

await test("the motions: every moving class has one, transform and opacity only, 0.7 to 2 s loops, and none with reduced motion", () => {
  const css = readFileSync(`${root}/app/globals.css`, "utf8");
  const markup = MOVING_MOODS.map((m) => mascotMarkup("max", "#FF9F43", { mood: m })).join("");
  // The bubble and the laptop only hold what moves in them.
  const classes = [...new Set([...markup.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(" ")))].filter((c) => c !== "mascot-thought" && c !== "mascot-laptop");
  // What moves: the class itself, or (the sound arcs) its paths.
  const rule = (c) => css.match(new RegExp(`\\.${c}(?: path)? \\{([^}]*)\\}`))?.[1] ?? "";
  for (const c of classes.filter((c) => c !== "mascot-cup-r")) {
    const anim = rule(c).match(/animation: (mascot-[a-z]+) ([\d.]+)s [a-z-]+ infinite;/);
    assert.ok(anim, `${c} moves`);
    const secs = Number(anim[2]);
    assert.ok(secs >= 0.7 && secs <= 2, `${c}: a calm loop (${secs}s)`);
    const frames = css.match(new RegExp(`@keyframes ${anim[1]} \\{([\\s\\S]*?)\\n\\}`))[1];
    for (const prop of frames.matchAll(/^\s+([a-z-]+):/gm)) assert.ok(["transform", "opacity"].includes(prop[1]), `${anim[1]}: ${prop[1]}`);
  }
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mascot-glance,[\s\S]*?\{\s*animation: none;\s*\}/)?.[0];
  assert.ok(reduced, "a reduced-motion block for the moods");
  for (const c of classes.filter((c) => c !== "mascot-cup-r")) assert.match(reduced, new RegExp(`\\.${c}[ ,{]`), `${c} holds still with reduced motion`);
  // Resting while the window is hidden: .mascot-paused * outranks a class's own rule, but not one on its
  // paths (the sound arcs), whose animation shorthand would set them running again; those need their own.
  const paused = css.match(/\n([^{}]*\.mascot-paused \*[^{}]*)\{\s*animation-play-state: paused;\s*\}/)?.[1];
  assert.ok(paused, "resting while the window is hidden");
  for (const c of classes) if (css.includes(`.${c} path {`)) assert.match(paused, new RegExp(`\\.mascot-paused \\.${c} path[ ,]`), `${c}'s paths rest too`);
  // The code lines type in one after another: each starts a third of the loop after the one above it.
  const loop = Number(rule("mascot-code-line").match(/animation: mascot-type ([\d.]+)s/)[1]);
  const starts = [...mascotMarkup("max", "#FF9F43", { mood: "coding" }).matchAll(/class="mascot-code-line"[^>]*animation-delay:(-?[\d.]+)s/g)].map((m) => +(((Number(m[1]) % loop) + loop) % loop).toFixed(2));
  assert.deepEqual(starts, [0, loop / 3, (2 * loop) / 3].map((x) => +x.toFixed(2)));
  // Each grows from its left end (its own box), as text types in.
  assert.match(rule("mascot-code-line"), /transform-box: fill-box;\s*transform-origin: 0 50%;/);
});

await test("the call's bot talks from its own store, and a word starting or ending wakes only that store's listeners", () => {
  const talk = talkingStore();
  let heard = 0;
  const stop = talk.subscribe(() => heard++);
  talk.set(true);
  talk.set(true);
  assert.equal(heard, 1, "told once per change");
  const sig = moodSignals(state(), { botId: "max", speaking: false });
  const withTalk = (el) => renderToStaticMarkup(h(CallTalking.Provider, { value: talk }, h(BotMoods.Provider, { value: sig }, el)));
  assert.ok(withTalk(h(Mascot, { botId: "max", color: "#FF9F43", live: true })).includes(mascotMarkup("max", "#FF9F43", { mood: "speaking" })), "talking");
  assert.ok(withTalk(h(Mascot, { botId: "ivy", color: "#60A5FA", live: true })).includes(mascotMarkup("ivy", "#60A5FA", { mood: "idle" })), "only the bot on the call");
  talk.set(false);
  assert.equal(heard, 2);
  assert.ok(withTalk(h(Mascot, { botId: "max", color: "#FF9F43", live: true })).includes(mascotMarkup("max", "#FF9F43", { mood: "working" })), "listening");
  stop();
  talk.set(true);
  assert.equal(heard, 2, "no one listening after unsubscribing");
});

await test("the typing line has the bot's mascot beside the dots, thinking, in a 1:1 chat as in a group", () => {
  const noop = () => {};
  const bots = [
    { id: "max", name: "Max", color: "#FF9F43", role: "", status: "idle" },
    { id: "ivy", name: "Ivy", color: "#60A5FA", role: "", status: "idle" },
  ];
  for (const c of [chat("chat-max", ["max"], ["max"]), chat("g1", ["max"], ["max", "ivy"])]) {
    const st = { bots, brains: [], sessions: [], chats: [c], messages: [], host: "orgo" };
    const html = withMoods(moodSignals(st), h(ChatView, { state: st, chat: c, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop }));
    const beside = html.match(/<svg viewBox="0 0 40 40" style="width:24px;height:24px;flex-shrink:0">([\s\S]*?)<\/svg><div class="flex items-center gap-\[5px\]/)?.[1];
    assert.ok(beside?.includes(mascotMarkup("max", "#FF9F43", { mood: "thinking" })), `${c.kind}: Max thinks beside the dots`);
  }
});

await test("the call bar says the bot is talking while its voice comes through, and through short gaps between words", () => {
  assert.equal(botTalking(0.5, 0, 10_000), true, "loud");
  assert.equal(botTalking(0.01, 0, 10_000), false, "quiet for long");
  assert.equal(botTalking(0.01, 10_000 - BOT_TALKING.holdMs + 50, 10_000), true, "a short gap");
  assert.equal(botTalking(0.01, 10_000 - BOT_TALKING.holdMs, 10_000), false, "a pause");
  assert.equal(botTalking(BOT_TALKING.level, 0, 10_000), false, "the waveform's own quiet");
});

await test("the loading scene sings, looks about and blinks, the window's splash and the app's first load alike, on the awake face's own shapes", () => {
  const splash = readFileSync(`${root}/desktop/splash.html`, "utf8");
  const css = readFileSync(`${root}/app/globals.css`, "utf8");
  const awake = mascotMarkup("boppy", "#0A0A0A", { mood: "awake" });
  // The splash draws exactly the awake picture, so the same selectors find its eyes and mouth in both.
  assert.ok(splash.includes(`<svg class="boppy" viewBox="0 0 40 40">${awake}</svg>`), "the splash's Boppy is the awake picture");
  assert.equal(awake.match(/<g transform="translate\(\.6 -1\.4\)">(<ellipse [^>]*\/>){2}<\/g>/g)?.length, 1, "its two eyes, in their own group");
  assert.equal(awake.match(/<ellipse [^>]*cy="26\.6"/g)?.length, 1, "its one mouth");
  // The same motion in both, so one hands over to the other without a jump: transform only.
  const frames = (src, name, close) => src.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n${close}\\}`))?.[1].replace(/\s+/g, "");
  for (const [mine, theirs, secs] of [["sing", "boppy-sing", "4.4"], ["look", "boppy-look", "4.4"], ["blink", "boppy-blink", "5.3"]]) {
    const a = frames(splash, mine, "  "), b = frames(css, theirs, "");
    assert.ok(a && a === b, `${mine}: the same keyframes`);
    assert.deepEqual([...new Set([...a.matchAll(/([a-z-]+):/g)].map((m) => m[1]))], ["transform"], `${mine}: transform only`);
    assert.ok(splash.includes(`animation: ${mine} ${secs}s ease-in-out infinite;`) && css.includes(`animation: ${theirs} ${secs}s ease-in-out infinite;`), `${mine}: the same timing`);
  }
  // The eyes look about as a pair, so a look moves their group, keeping its own translate(.6 -1.4) (a CSS
  // transform replaces the attribute's) at rest and wherever it isn't looking away.
  const look = frames(splash, "look", "  ");
  assert.match(look, /^0%,[^{]*100%\{transform:translate\(0\.6px,-1\.4px\);\}/, "a look starts and ends on the eyes' own place");
  for (const [src, sel] of [[splash, ".boppy"], [css, ".boppy-loading-boppy"]]) {
    assert.ok(src.includes(`${sel} g[transform="translate(.6 -1.4)"] {`), `${sel}: on the eyes' group`);
    assert.ok(src.includes(`${sel} g[transform="translate(.6 -1.4)"] ellipse {`) && src.includes(`${sel} ellipse[cy="26.6"] {`), `${sel}: on the eyes and the mouth`);
    const reduced = src.match(/@media \(prefers-reduced-motion: reduce\) \{[^@]*/g)?.find((m) => m.includes(sel)) ?? "";
    // Each face rule by its own selector: a plainer one (".boppy ellipse") is less specific, so it loses.
    for (const part of ['g[transform="translate(.6 -1.4)"]', 'g[transform="translate(.6 -1.4)"] ellipse', 'ellipse[cy="26.6"]']) {
      assert.ok(src.includes(`${sel} ${part} {`), `${sel} ${part}: animated`);
      assert.ok([",", " {"].some((end) => reduced.includes(`${sel} ${part}${end}`)), `${sel} ${part}: still with reduced motion`);
    }
  }
});

/* ---------------- Coding bots ---------------- */

// A workspace with apps (open to Orgo's own team): Recipe Box, with a second site, on Max's computer; an older app
// that lost its home, still naming Ivy; Zed works on Recipe Box's second site, Kay on a site that's gone, Lou on an
// app that's gone.
const TEAM = { user: { id: "u1", email: "tess@orgo.ai" }, signedInAt: 1 };
const apps = (over = {}) => ({
  account: TEAM,
  workspace: "ws_main",
  workspaces: [
    {
      id: "ws_main",
      name: "Main",
      createdAt: 1,
      hostedApps: { "recipe-box": { botId: "max", computerId: "comp_a", sites: [{ name: "site-a" }] }, "old-app": { botId: "ivy", computerId: "comp_b", lost: 5 } },
      botSites: { zed: { app: "recipe-box", site: "site-a" }, kay: { app: "recipe-box", site: "site-b" }, lou: { app: "old-site", site: "old-site" } },
    },
  ],
  bots: ["max", "ivy", "zed", "kay", "lou", "pat"].map((id) => ({ id, name: id, color: "#FF9F43", role: "", isMain: false })),
  sessions: [],
  chats: [],
  ...over,
});
const onApp = (botId = "max", extra = {}) => session(botId, "running", { app: { wsId: "ws_main", name: "recipe-box" }, ...extra });

await test("coders: where apps show, a bot whose Works on names a site that's there, or the bot an app's home names", () => {
  assert.deepEqual([...codersOf(apps())].sort(), ["max", "zed"], "Max holds Recipe Box, Zed works on its site-a");
  // Not Ivy (its app lost its home), Kay (its site is gone), Lou (its app is gone), Pat (nothing).
  assert.deepEqual([...codersOf(apps({ account: { user: { id: "u2", email: "sam@example.com" }, signedInAt: 1 } }))], [], "apps not open to the account");
  assert.deepEqual([...codersOf(apps({ account: undefined }))], [], "signed out");
  const home = apps();
  home.workspaces[0].hostedApps["old-app"].lost = undefined;
  assert.ok(codersOf(home).has("ivy"), "its app home again");
  // A workspace shared with the user: what its owner's apps (SharedOpen.apps) name, when they gave Your Apps.
  const shared = { owner: "tess@orgo.ai", wsId: "ws_main", projectId: "p1", name: "Acme", role: "member", levels: {}, apps: { level: "read", at: 1, list: [{ name: "recipe-box", siteNames: ["site-a"] }] } };
  assert.deepEqual([...codersOf(apps({ account: { user: { id: "u2", email: "sam@example.com" }, signedInAt: 1 }, shared }))].sort(), ["max", "zed"]);
  assert.deepEqual([...codersOf(apps({ shared: { ...shared, apps: undefined } }))], [], "shared without Your Apps");
  // An owner apps aren't open to: hidden from a viewer outside Orgo's team, shown to one of the team (owner, 11-02).
  const outsider = { account: { user: { id: "u2", email: "sam@example.com" }, signedInAt: 1 } };
  assert.deepEqual([...codersOf(apps({ ...outsider, shared: { ...shared, owner: "sam@example.com" } }))], [], "an owner apps aren't open to, a viewer outside the team");
  assert.deepEqual([...codersOf(apps({ shared: { ...shared, owner: "sam@example.com" } }))].sort(), ["max", "zed"], "an owner apps aren't open to, a viewer of the team");
  // Read once, with the rest of the moods.
  assert.deepEqual([...moodSignals(apps()).coders].sort(), ["max", "zed"]);
  assert.equal(moodSignals(state()).coders.size, 0);
  assert.equal(NO_SIGNALS.coders.size, 0);
});

await test("the coder's mark: an ink pill with </> in highlighter at the top left, still, on top of every mood, never on a picture", () => {
  for (const id of ["boppy", "max", "otto", "penny"])
    for (const mood of ["idle", "awake", ...MOVING_MOODS]) {
      const plain = mascotMarkup(id, "#2EC4B6", { mood });
      const marked = mascotMarkup(id, "#2EC4B6", { mood, coder: true });
      assert.ok(marked.startsWith(plain), `${id} ${mood}: the same mascot under it`);
      const mark = marked.slice(plain.length);
      const [, x, y, w, ht] = mark.match(/^<g class="coder-mark"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="[\d.]+" fill="#1C1C1B" stroke="#fff"\/><path d="[^"]+" fill="none" stroke="#E9FF3B"[^>]*\/><\/g>$/).map(Number);
      // Top left, clear of the thought bubble and the sound (top right), the pencil and the laptop (bottom left).
      assert.ok(x + w <= 20 && y + ht <= 12, `${id} ${mood}: at the top left`);
      assert.doesNotMatch(mark, /mascot-/, "it stays still");
    }
  assert.equal(mascotMarkup("max", "#2EC4B6", { coder: false }), mascotMarkup("max", "#2EC4B6"));
  assert.doesNotMatch(mascotSvg("max", "#2EC4B6", 104) + mascotSvg("boppy", "#0A0A0A", 104, "awake"), /coder-mark/, "the pictures never");
});

await test("every mascot of a coder wears the mark (BotMoods), at 18 px and up: smaller, it's a smudge", () => {
  assert.equal(CODER_MIN_SIZE, 18);
  const sig = moodSignals(apps());
  for (const [size, shown] of [[13, false], [16, false], [17, false], [18, true], [24, true], [44, true]]) {
    assert.equal(withMoods(sig, h(Mascot, { botId: "max", color: "#FF9F43", size })).includes('class="coder-mark"'), shown, `${size} px`);
    assert.equal(withMoods(sig, h(Mascot, { botId: "max", color: "#FF9F43", size, live: true })).includes('class="coder-mark"'), shown, `${size} px, live`);
  }
  assert.ok(!withMoods(sig, h(Mascot, { botId: "pat", color: "#FF9F43", size: 44 })).includes("coder-mark"), "only a coder's");
  assert.ok(!withMoods(NO_SIGNALS, h(Mascot, { botId: "max", color: "#FF9F43", size: 44 })).includes("coder-mark"), "outside the app");
  // A group's avatar too: each bot by its own.
  const group = withMoods(sig, h(ChatAvatar, { chat: chat("g1", [], ["max", "pat"]), bots: [{ id: "max", color: "#FF9F43" }, { id: "pat", color: "#60A5FA" }], size: 44 }));
  assert.equal(group.match(/class="coder-mark"/g).length, 1);
});

await test("coding: a thread running on one of the workspace's apps, the user's own, nothing in its way, where apps show", () => {
  const mood = (sessions, over = {}) => moodOf(moodSignals(apps({ sessions, ...over })), "max");
  assert.equal(mood([onApp()]), "coding");
  assert.ok(codingThread(onApp(), apps()));
  // Not yet running, or stopped at something: at work, not coding.
  assert.equal(mood([onApp("max", { status: "queued" })]), "working", "queued");
  assert.equal(mood([onApp("max", { status: "starting" })]), "working", "starting");
  assert.equal(mood([onApp("max", { blocker: { kind: "signin", detail: "Sign in" } })]), "working", "at a sign in only the user can get past");
  assert.equal(mood([onApp("max", { askWhere: true })]), "idle", "waiting to be told where to run");
  const ask = { id: "apr_1", threadId: "s-max-running", botId: "max", action: "Deploy", resources: [], preview: "", at: 1 };
  assert.equal(mood([onApp()], { appApprovals: [ask] }), "idle", "waiting for the user's OK");
  assert.equal(mood([onApp()], { appApprovals: [{ ...ask, reply: { reply: "once", at: 2 } }] }), "coding", "answered: on again");
  // Not on an app, or not the user's own ask.
  assert.equal(mood([session("max", "running")]), "working", "no app");
  assert.equal(mood([onApp("max", { routineId: "r1" })]), "working", "a routine's run");
  assert.equal(mood([onApp("max", { fromOutside: true })]), "working", "someone outside Bops started it");
  // Where the window doesn't show apps, nothing of them: at work.
  assert.equal(mood([onApp()], { account: { user: { id: "u2", email: "sam@example.com" }, signedInAt: 1 } }), "working", "apps not open to the account");
  for (const status of ["done", "failed", "stopped"]) assert.equal(mood([onApp("max", { status })]), "idle", status);
  // Still a thread at work, for whatever reads that.
  assert.ok(moodSignals(apps({ sessions: [onApp()] })).working.has("max"));
  assert.ok(!moodSignals(apps({ sessions: [onApp()] })).coding.has("zed"), "only the bot coding");
});

await test("speaking beats coding beats writing, shy, thinking and working", () => {
  const at = 1_000_000;
  const sig = (sessions, extra = {}, call = null) => moodSignals(apps({ sessions, chats: [chat("chat-max", [], ["max"])], ...extra }), call, at);
  assert.equal(moodOf(sig([onApp()], {}, { botId: "max", speaking: true }), "max"), "speaking");
  assert.equal(moodOf(sig([onApp("max", { activity: "writing" })]), "max"), "coding", "whatever its caption says");
  assert.equal(moodOf(sig([onApp(), { ...session("max", "running", { activity: "writing" }), id: "s-max-notes" }]), "max"), "coding", "another thread writing");
  assert.equal(moodOf(sig([onApp()], { messages: [said("chat-max", "thanks!", at - 500)] }), "max"), "coding", "just thanked");
  const typing = moodSignals(apps({ sessions: [onApp()], chats: [chat("chat-max", ["max"], ["max"])] }));
  assert.equal(moodOf(typing, "max", "chat-max"), "coding", "a reply on the way in its own chat");
  assert.equal(moodOf(typing, "max"), "coding");
  assert.equal(moodOf(moodSignals(apps({ sessions: [onApp()], liveMoods: { max: { mood: "writing" } } })), "max"), "coding", "what it does elsewhere");
  assert.equal(moodOf(sig([session("max", "running")]), "max"), "working");
});

await test("BotMoodsFrom: a coder at work on its app codes, mark and laptop, every mascot of it without being told", () => {
  const st = apps({ sessions: [onApp()], chats: [chat("chat-max", [], ["max"])], messages: [] });
  const html = renderToStaticMarkup(h(BotMoodsFrom, { state: st, call: null }, h(Mascot, { botId: "max", color: "#FF9F43", live: true })));
  assert.ok(html.includes(mascotMarkup("max", "#FF9F43", { mood: "coding", coder: true })));
  // Not live: awake, with its mark.
  const still = renderToStaticMarkup(h(BotMoodsFrom, { state: st, call: null }, h(Mascot, { botId: "max", color: "#FF9F43", size: 20 })));
  assert.ok(still.includes(mascotMarkup("max", "#FF9F43", { mood: "awake", coder: true })));
});


/* ---------------- The mascots people face ---------------- */

const mainCss = readFileSync(`${root}/app/globals.css`, "utf8");
/** A rule's body by its exact selector, and a keyframes block's frames (offset 0 to 1, its declarations). */
const ruleOf = (sel) => mainCss.match(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
const framesOf = (name) => {
  const body = mainCss.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
  return [...body.matchAll(/((?:\s*[\d.]+%,?)+)\s*\{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/([\d.]+)%/g)].map((p) => ({ at: Number(p[1]) / 100, decl: m[2] })));
};
const scaleOf = (decl) => {
  const m = decl.match(/transform: scale\(([\d.]+), ([\d.]+)\);/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

await test("every pose the app draws today is exactly what it was, for every picture color and shape: life only adds where it's asked", () => {
  // Hashed from main before the mascots people face came in: idle, awake and each moving mood, the main bot in both
  // headphones, a blob in each picture color, the seed bots' own shapes, and the coder's mark.
  const moods = ["idle", "awake", ...MOVING_MOODS];
  let all = "";
  for (const mood of moods) {
    for (const accent of [true, false]) all += mascotMarkup("boppy", "#0A0A0A", { mood, accent }) + "\n";
    for (const c of PICTURE_COLORS) for (const id of ["bot", "max", "ivy-2"]) all += mascotMarkup(id, c, { mood }) + "\n";
    for (const [id, c] of Object.entries(PICTURE_SHAPES)) all += mascotMarkup(id, c, { mood }) + "\n";
    all += mascotMarkup("max", "#FF9F43", { mood, coder: true }) + "\n";
  }
  assert.equal(createHash("sha256").update(all).digest("hex"), "5a323960564d0ad4f31f2e42a17c7960d5c647a9c93aafec52083c44366c318d");
  // Blinking only marks the open eyes: take the class away and it's the same drawing.
  for (const id of ["boppy", "max", "penny", "otto", "rook", "ivy-2"])
    for (const mood of [...moods, "listening"]) assert.equal(mascotMarkup(id, "#47C46B", { mood, blink: true }).replaceAll(' class="mascot-eye"', ""), mascotMarkup(id, "#47C46B", { mood }), `${id} ${mood}`);
});

await test("an idle bot listening (its person writing to it) opens its eyes and looks down at the box: a still pose, no mouth, nothing else", () => {
  for (const id of ["boppy", "max", "penny", "otto"]) {
    const listening = mascotMarkup(id, "#FF9F43", { mood: "listening" });
    assert.match(listening, /<g transform="translate\(0 1\)">/, `${id}: eyes down`);
    assert.doesNotMatch(listening, /mascot-|<g transform="rotate\(/, `${id}: still, its head upright`);
    assert.notEqual(listening, mascotMarkup(id, "#FF9F43", { mood: "idle" }));
    assert.notEqual(listening, mascotMarkup(id, "#FF9F43", { mood: "awake" }));
  }
  assert.doesNotMatch(mascotMarkup("boppy", "#0A0A0A", { mood: "listening" }), /cy="2[56]\.[68]"/, "no mouth");
});

await test("the mascots people face blink: every open eye, about 18 a minute at uneven gaps with one double, shut fast and open slower, each bot on its own beat", () => {
  // Which eyes: both open ones, the winker's one, none on a smile (its eyes are arcs) or while it vibes (shut).
  const open = (id) => (faceOf(id) === "happy" ? 0 : faceOf(id) === "wink" ? 1 : 2);
  const ids = ["boppy", "max", "penny", "otto", "rook", "zed", "writer", "ivy"];
  assert.deepEqual([...new Set(ids.map(faceOf))].sort(), ["happy", "open", "wink"], "every face among them");
  for (const id of ids)
    for (const mood of ["idle", "awake", "listening", ...MOVING_MOODS]) {
      const eyes = mascotMarkup(id, "#2EC4B6", { mood, blink: true }).match(/<[a-z]+ class="mascot-eye"/g) ?? [];
      assert.equal(eyes.length, mood === "idle" ? 0 : open(id), `${id} ${mood}`);
      assert.ok(eyes.every((e) => e === '<ellipse class="mascot-eye"'), `${id} ${mood}: eyes only`);
    }
  // The round: its length is lib/mascot.ts's, each eye shrinking from its own middle, on the bot's own place in it.
  const loop = Number(ruleOf(".mascot-eye").match(/animation: mascot-blink ([\d.]+)s linear var\(--mascot-blink-at, 0s\) infinite;/)?.[1]);
  assert.equal(loop, BLINK_LOOP_S, "the round as lib/mascot.ts has it");
  assert.match(ruleOf(".mascot-eye"), /transform-box: fill-box;\s*transform-origin: center;/);
  const frames = framesOf("mascot-blink").map((f) => ({ at: f.at * loop, y: Number(f.decl.match(/scaleY\(([\d.]+)\)/)?.[1]), ease: f.decl.match(/cubic-bezier\(([^)]*)\)/)?.[1].split(",").map(Number) }));
  frames.sort((a, b) => a.at - b.at);
  assert.ok(frames.length && frames.every((f) => Number.isFinite(f.y)), "transform: scaleY only");
  const blinks = [];
  for (let i = 1; i < frames.length; i++)
    if (frames[i].y <= 0.2 && frames[i - 1].y === 1) {
      let j = i;
      while (frames[j + 1].y <= 0.2) j++;
      blinks.push({ start: frames[i - 1].at, close: frames[i].at - frames[i - 1].at, open: frames[j + 1].at - frames[j].at, end: frames[j + 1].at, closeEase: frames[i - 1].ease, openEase: frames[j].ease });
    }
  const perMinute = (blinks.length / loop) * 60;
  assert.ok(perMinute >= 15 && perMinute <= 24, `about 18 a minute (${perMinute})`);
  for (const b of blinks) {
    assert.ok(b.end - b.start >= 0.2 && b.end - b.start <= 0.4, `a blink of 0.2 to 0.4 s (${(b.end - b.start).toFixed(2)})`);
    assert.ok(b.close <= 0.12 && b.close < b.open, `shut fast (${b.close.toFixed(2)} s), open slower (${b.open.toFixed(2)} s)`);
    // Speeding up as the lid falls, slowing as it lifts (a cubic-bezier's first handle under or over the line).
    assert.ok(b.closeEase && b.closeEase[1] < b.closeEase[0], "shutting eases in");
    assert.ok(b.openEase && b.openEase[1] > b.openEase[0], "opening eases out");
  }
  // Uneven gaps, start to start (around the round's end too): one double, the rest 2.5 to 5 s, no two the same.
  const gaps = blinks.map((b, i) => +((blinks[i + 1]?.start ?? blinks[0].start + loop) - b.start).toFixed(2));
  assert.equal(gaps.filter((g) => g < 0.6).length, 1, `one double blink (${gaps})`);
  const rest = gaps.filter((g) => g >= 0.6);
  assert.ok(rest.every((g) => g >= 2.5 && g <= 5), `gaps of 2.5 to 5 s (${gaps})`);
  assert.equal(new Set(rest).size, rest.length, "no two gaps alike");
  // Each bot's place in the round, from its id: inside the round, the same every time, spread across bots.
  const phases = ids.map((id) => -parseFloat(blinkPhase(id)));
  assert.ok(phases.every((p) => p >= 0 && p < BLINK_LOOP_S), `${phases}`);
  assert.equal(blinkPhase("max"), blinkPhase("max"));
  assert.ok(new Set(phases).size >= 7, "bots blink out of step");
});

await test("they breathe while they vibe and settle into each new pose: slow and small from the base, once and quick; still with reduced motion, resting while hidden", () => {
  const breath = framesOf("mascot-breath");
  const loop = Number(ruleOf(".mascot-breath").match(/animation: mascot-breath ([\d.]+)s ease-in-out infinite;/)?.[1]);
  assert.ok(loop >= 3.3 && loop <= 5, `a resting breath (${loop} s)`);
  const settle = framesOf("mascot-settle");
  const once = Number(ruleOf(".mascot-settle").match(/animation: mascot-settle ([\d.]+)s ease-in-out;/)?.[1]);
  assert.ok(once >= 0.25 && once <= 0.5, `quick, and once (${once} s)`);
  for (const [name, frames, most] of [["breath", breath, 0.02], ["settle", settle, 0.05]]) {
    assert.ok(frames.length >= 2 && frames.every((f) => scaleOf(f.decl) && /^\s*transform: [^;]+;\s*$/.test(f.decl)), `${name}: transform only`);
    const reach = Math.max(...frames.flatMap((f) => scaleOf(f.decl).map((v) => Math.abs(v - 1))));
    assert.ok(reach > 0 && reach <= most, `${name}: small (${reach})`);
    assert.deepEqual(scaleOf(frames.find((f) => f.at === 1).decl), [1, 1], `${name}: ends where it started`);
    assert.match(ruleOf(`.mascot-${name}`), /transform-origin: 20px 3[4-6]px;/, `${name}: from the base`);
  }
  // With reduced motion each holds its pose; while the window is hidden each rests: .mascot-paused * is as specific
  // as their rules, so it has to come after them.
  const reduced = mainCss.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mascot-glance,[\s\S]*?\{\s*animation: none;\s*\}/)?.[0] ?? "";
  const paused = mainCss.indexOf("\n.mascot-paused *,");
  for (const c of ["mascot-eye", "mascot-breath", "mascot-settle"]) {
    assert.match(reduced, new RegExp(`\\.${c}[ ,{]`), `${c}: still with reduced motion`);
    assert.ok(mainCss.indexOf(`\n.${c} {`) > 0 && mainCss.indexOf(`\n.${c} {`) < paused, `${c}: rests while hidden`);
  }
});

await test("only the mascots people face come alive, big enough to see: blinking open-eyed, breathing idle at the larger sizes, listening while their person writes", () => {
  const bots = [
    { id: "max", name: "Max", color: "#FF9F43", role: "", status: "idle" },
    { id: "ivy", name: "Ivy", color: "#60A5FA", role: "", status: "idle" },
  ];
  const sig = moodSignals(state([], [chat("chat-max", ["max"])]));
  const face = (props) => withMoods(sig, h(Mascot, { live: true, life: true, ...props }));
  // A profile (70 px), idle: breathing, eyes shut (nothing to blink), on its own beat; its first pose just shows.
  const hero = face({ botId: "ivy", color: "#60A5FA", size: 70 });
  assert.ok(hero.includes(mascotMarkup("ivy", "#60A5FA", { mood: "idle", blink: true, breathe: true })), "breathing");
  assert.ok(hero.includes(`--mascot-blink-at:${blinkPhase("ivy")}`), "its own beat");
  assert.doesNotMatch(hero, /mascot-settle/, "the first pose just shows");
  // The chat's header (40 px): too small to breathe; thinking over its reply, it blinks.
  assert.ok(BREATH_MIN_SIZE > 40 && BREATH_MIN_SIZE <= 64 && LIFE_MIN_SIZE <= 40);
  assert.ok(face({ botId: "ivy", color: "#60A5FA", size: 40 }).includes(mascotMarkup("ivy", "#60A5FA", { mood: "idle", blink: true })), "no breath at 40");
  assert.ok(face({ botId: "max", color: "#FF9F43", size: 40, chatId: "chat-max" }).includes(mascotMarkup("max", "#FF9F43", { mood: "thinking", blink: true })), "thinking, blinking");
  // Listening: an idle bot looks down at the box; a busy one keeps doing what it does; a mascot that isn't live never listens.
  assert.ok(face({ botId: "ivy", color: "#60A5FA", size: 40, listening: true }).includes(mascotMarkup("ivy", "#60A5FA", { mood: "listening", blink: true })), "listening");
  assert.ok(face({ botId: "max", color: "#FF9F43", size: 40, chatId: "chat-max", listening: true }).includes(mascotMarkup("max", "#FF9F43", { mood: "thinking", blink: true })), "busy");
  assert.ok(withMoods(sig, h(Mascot, { botId: "ivy", color: "#60A5FA", size: 40, listening: true })).includes(mascotMarkup("ivy", "#60A5FA", { mood: "idle" })), "not live");
  // The sidebar's rows (live, 44 px) and a group's small mascots (27 px, under LIFE_MIN_SIZE) stay as they were.
  const row = withMoods(sig, h(ChatAvatar, { chat: chat("chat-max", ["max"], ["max"]), bots, size: 44 }));
  assert.ok(row.includes(mascotMarkup("max", "#FF9F43", { mood: "thinking" })) && !/mascot-eye|mascot-breath|--mascot-blink-at/.test(row), "a row: calm");
  const group = withMoods(sig, h(ChatAvatar, { chat: chat("g1", ["max"], ["max", "ivy"]), bots, size: 40, life: true, listening: true }));
  assert.doesNotMatch(group, /mascot-eye|mascot-breath|--mascot-blink-at/, "a group's small mascots: calm");
  assert.ok(group.includes(mascotMarkup("ivy", "#60A5FA", { mood: "listening" })), "but listening, still");
  // In the chat itself: the header (40 px) and the empty chat's mascot (64 px) come alive; the typing line's (24 px) doesn't.
  const c = chat("chat-max", ["max"], ["max"]);
  const st = { bots, brains: [], sessions: [], chats: [c], messages: [], host: "orgo" };
  const noop = () => {};
  const html = withMoods(moodSignals(st), h(ChatView, { state: st, chat: c, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop }));
  const svgs = [...html.matchAll(/<svg viewBox="0 0 40 40"[^>]*style="width:(\d+)px;height:\d+px;flex-shrink:0(;--mascot-blink-at:[^"]+)?"/g)].map((m) => [Number(m[1]), !!m[2]]);
  assert.deepEqual(svgs.filter(([px]) => px === 40 || px === 64).map(([, alive]) => alive), [true, true], `header and empty chat (${JSON.stringify(svgs)})`);
  assert.ok(svgs.some(([px, alive]) => px === 24 && !alive), "the typing line: calm");
});

console.log(`\n${passed} passed`);
