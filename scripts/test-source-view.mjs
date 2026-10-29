// Tests for the email or thread on an issue's page (lib/source-parse.ts, lib/source-view.ts, components/app/source-view.tsx)
// and under a drafted reply's card (components/app/reply-drafts.tsx): where a thread is from an issue's id and link (Gmail's
// thread id or its address; Slack's "C…/ts", "C…:ts", a permalink, a reply's permalink, a ts with the channel in the link, a
// ts alone that can't be read; Discord's link and ids); a Gmail thread as Composio answers it (plain and HTML only, the HTML
// made text with its script, picture and hidden parts gone, its link as words and address, quoted history set apart in
// either, files by name and size, drafts left out, the user's own messages and who a reply goes to); Slack's and Discord's
// threads and their light marks; and, drawn in a DOM (linkedom), Gmail's view (the newest open, a click opening and folding
// each, Expand all and Collapse all, to me +2, Show quoted text, nothing of an email's ever HTML: no script, no picture, a
// tag in its words shown as text), Slack's (the parent, N more replies folded, the newest three, a click for all, the marks
// as text elements, reactions), the Reply box (who it goes to before Send, Reply all, the drafted reply to start from, Send
// once however fast it's clicked, a new click its own, what failed), the errors in plain words with Try again, a shared
// workspace never asking, and a drafted reply's Show the email. No dashes in what any of it says.
//
// Nothing reaches a server: fetch is a fake. The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-source-view.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
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
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

/* ---------------- A window, enough of one ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollIntoView = () => {};
doc.oninput = null;
// A text box's starting words, as a browser keeps them (its text); linkedom has no defaultValue.
Object.defineProperty(win.HTMLTextAreaElement.prototype, "defaultValue", {
  configurable: true,
  get() {
    return this.textContent;
  },
  set(v) {
    this.textContent = v;
  },
});

/** The fake server: what was asked, and how to answer (a function of the url, method and body; it may wait). */
const calls = [];
let answer = () => ({ status: 404, body: { error: "no" } });
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url: String(url), method: init.method ?? "GET", body });
  const a = await answer(String(url), init.method ?? "GET", body);
  return { ok: a.status < 400, status: a.status, json: async () => a.body };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act, createElement: h } = await import("react");
const P = await import(`${root}/lib/source-parse.ts`);
const V = await import(`${root}/lib/source-view.ts`);
const { IssueSource, SourceThread } = await import(pathToFileURL(`${root}/components/app/source-view.tsx`).href);
const { ReplyDrafts } = await import(pathToFileURL(`${root}/components/app/reply-drafts.tsx`).href);
const { viewOnly } = await import(pathToFileURL(`${root}/components/app/view-only.ts`).href);

async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  return { box, done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
const typeIn = (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
const buttons = (box, text) => [...box.querySelectorAll("button")].filter((b) => (text instanceof RegExp ? text.test(b.textContent) : b.textContent === text));
/** What's shown, each piece of text apart (textContent runs them together). */
const said = (el) => {
  const out = [];
  const walk = (n) => (n.nodeType === 3 ? out.push(n.data) : [...n.childNodes].forEach(walk));
  walk(el);
  return out.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
};

let passed = 0;
const test = async (name, f) => {
  calls.length = 0;
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const DASHES = /[–—]/;
/** Every word the window showed, checked for dashes and for "Orbit" at the end. */
const shown = [];

/* ---------------- Fixtures: a Gmail thread as Composio answers it ---------------- */

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const T0 = Date.parse("2026-10-19T13:14:00Z");
const THREAD = "18c0a1b2c3d4e5f6";
const plainPart = (text) => ({ mimeType: "text/plain", body: { data: b64(text), size: text.length } });
const htmlPart = (html) => ({ mimeType: "text/html", body: { data: b64(html), size: html.length } });
const headers = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
const KEVIN_HTML = [
  "<html><head><title>Re: Invoice</title><style>p{color:red}</style><script>window.stolen = document.cookie; alert(1)</script></head><body>",
  '<div style="display:none;max-height:0">a hidden preheader</div>',
  "<p>Thanks Alex!</p>",
  '<p>Here is the <a href="https://example.com/invoices/fixed">fixed invoice</a>, and <a href="https://example.com/help">https://example.com/help</a>.<br>Call me at 555 0100.</p>',
  '<img src="https://tracker.example.com/open.gif?u=1" width="1" height="1">',
  '<a href="https://example.com/"><img src="https://example.com/logo.png"></a>',
  "<ul><li>Line one</li><li>Line two</li></ul>",
  "<p>A tag in my words: &lt;img src=x onerror=alert(2)&gt; stays words.</p>",
  '<div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 19, 2026 at 10:02 AM Alex Owner &lt;alex@example.com&gt; wrote:</div>',
  "<blockquote>Hi Kevin, looking at it now.</blockquote></div>",
  '<a href="javascript:alert(3)">click</a>',
  "</body></html>",
].join("");
const gmailThread = () => ({
  messages: [
    {
      messageId: "m3",
      threadId: THREAD,
      labelIds: ["INBOX", "UNREAD"],
      internalDate: String(T0 + 2 * 3600_000),
      snippet: "Thanks Alex! Here is the fixed invoice",
      payload: {
        mimeType: "multipart/related",
        headers: headers({ From: "Kevin Example <kevin@example.com>", To: "Alex Owner <alex@example.com>", Cc: "Ava Lee <ava@example.org>, Max Doe <max@example.net>", Subject: "Re: Invoice for October" }),
        parts: [
          htmlPart(KEVIN_HTML),
          { mimeType: "image/png", filename: "logo.png", headers: headers({ "Content-Disposition": "inline", "Content-ID": "<logo>" }), body: { attachmentId: "att_logo", size: 2048 } },
        ],
      },
    },
    {
      messageId: "m1",
      threadId: THREAD,
      labelIds: ["INBOX"],
      internalDate: String(T0),
      snippet: "Hi Alex, The invoice for October looks wrong.",
      payload: {
        mimeType: "multipart/mixed",
        headers: headers({ From: '"Kevin Example" <Kevin@Example.com>', To: "alex@example.com", Subject: "Invoice for October" }),
        parts: [
          { mimeType: "multipart/alternative", parts: [plainPart("Hi Alex,\r\n\r\nThe invoice for October looks wrong: it says 12 seats.\r\n\r\nKevin"), htmlPart("<p>Hi Alex,</p><p>The invoice for October looks wrong</p>")] },
          { mimeType: "application/pdf", filename: "invoice-october.pdf", headers: headers({ "Content-Disposition": 'attachment; filename="invoice-october.pdf"' }), body: { attachmentId: "att_1", size: 48213 } },
        ],
      },
    },
    {
      messageId: "m2",
      threadId: THREAD,
      labelIds: ["SENT"],
      internalDate: String(T0 + 3600_000),
      snippet: "Hi Kevin, looking at it now.",
      payload: {
        mimeType: "text/plain",
        headers: headers({ From: "Alex Owner <alex@example.com>", To: "Kevin Example <kevin@example.com>", Subject: "Re: Invoice for October" }),
        body: { data: b64("Hi Kevin, looking at it now.\n\nOn Mon, Oct 19, 2026 at 9:14 AM Kevin Example <kevin@example.com>\nwrote:\n> Hi Alex,\n>\n> The invoice for October looks wrong.\n") },
      },
    },
    { messageId: "m4", threadId: THREAD, labelIds: ["DRAFT"], internalDate: String(T0 + 3 * 3600_000), payload: { mimeType: "text/plain", headers: headers({ From: "alex@example.com" }), body: { data: b64("a draft nobody sent") } } },
  ],
});

const account = { id: "ca_gmail_work", title: "Work · alex@example.com" };
const mailSource = () => {
  const { subject, messages } = P.parseGmailThread(gmailThread(), ["alex@example.com"]);
  return { app: "gmail", account, threadId: THREAD, subject, messages, reply: P.gmailReply(messages) };
};

/* ---------------- Where it is ---------------- */

await test("where a thread is: Gmail's id or its address; Slack's channel and ts in any of its forms; Discord's link and ids; what can't be told is left out", () => {
  assert.equal(P.gmailThreadIdOf("18C0A1B2C3D4E5F6"), THREAD);
  assert.equal(P.gmailThreadIdOf("thread-f:18c0a1b2c3d4e5f6"), THREAD);
  assert.equal(P.gmailThreadIdOf("not an id", `https://mail.google.com/mail/u/0/#inbox/${THREAD}`), THREAD);
  assert.equal(P.gmailThreadIdOf("FMfcgzQfBZdVqKZcSVBhqwWLKWCtDdWQ", "https://mail.google.com/mail/u/0/#inbox/FMfcgzQfBZdVqKZcSVBhqwWLKWCtDdWQ"), undefined, "Gmail's web ids aren't the API's");
  const ts = "1700000000.000100";
  assert.deepEqual(P.slackRefOf(`C0123ABCD/${ts}`), { channel: "C0123ABCD", ts });
  assert.deepEqual(P.slackRefOf(`C0123ABCD:${ts}`), { channel: "C0123ABCD", ts });
  assert.deepEqual(P.slackRefOf(`slack-G0123ABCD-${ts}`), { channel: "G0123ABCD", ts });
  assert.deepEqual(P.slackRefOf("https://acme-example.slack.com/archives/C0123ABCD/p1700000000000100"), { channel: "C0123ABCD", ts });
  // A reply's permalink: its thread is the thread_ts.
  assert.deepEqual(P.slackRefOf("x", "https://acme-example.slack.com/archives/C0123ABCD/p1700000099000200?thread_ts=1700000000.000100&cid=C0123ABCD"), { channel: "C0123ABCD", ts });
  assert.deepEqual(P.slackRefOf(ts, "https://acme-example.slack.com/archives/C0123ABCD"), { channel: "C0123ABCD", ts });
  assert.deepEqual(P.slackRefOf(ts), { ts }, "a ts alone: no channel, no thread to read");
  assert.deepEqual(P.slackRefOf("D0456EFGH 1700000000.000100"), { channel: "D0456EFGH", ts });
  assert.deepEqual(P.discordRefOf("x", "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"), { channel: "222222222222222222", message: "333333333333333333" });
  assert.deepEqual(P.discordRefOf("222222222222222222/333333333333333333"), { channel: "222222222222222222", message: "333333333333333333" });
  assert.deepEqual(P.discordRefOf("222222222222222222"), { channel: "222222222222222222" });
  assert.deepEqual(P.discordRefOf("thread one"), {});
  assert.equal(V.sourceAppOf("Gmail"), "gmail");
  assert.equal(V.sourceAppOf("discordbot"), "discord");
  assert.equal(V.sourceAppOf("plain"), null);
});

/* ---------------- Gmail, parsed ---------------- */

await test("a Gmail thread: oldest first, drafts left out, who and when, the subject, the user's own messages, files by name and size (not the pictures in its words)", () => {
  const { subject, messages } = P.parseGmailThread(gmailThread(), ["alex@example.com"]);
  assert.equal(subject, "Re: Invoice for October");
  assert.deepEqual(messages.map((m) => m.id), ["m1", "m2", "m3"]);
  assert.deepEqual(messages[0].from, { name: "Kevin Example", email: "kevin@example.com" });
  assert.deepEqual(messages[0].to, [{ email: "alex@example.com", me: true }]);
  assert.equal(messages[0].at, T0);
  assert.equal(messages[1].mine, true);
  assert.equal(messages[1].from.me, true);
  assert.deepEqual(messages[2].cc.map((p) => p.email), ["ava@example.org", "max@example.net"]);
  assert.deepEqual(messages[0].files, [{ name: "invoice-october.pdf", size: 48213, type: "application/pdf" }]);
  assert.deepEqual(messages[2].files, [], "an inline logo isn't an attachment");
  assert.ok(!JSON.stringify(messages).includes("a draft nobody sent"));
});

await test("a plain email: its text/plain part, its quoted history from an \"On … wrote:\" line over two lines set apart", () => {
  const { messages } = P.parseGmailThread(gmailThread(), []);
  const m1 = messages.find((m) => m.id === "m1");
  assert.equal(m1.body, "Hi Alex,\n\nThe invoice for October looks wrong: it says 12 seats.\n\nKevin");
  assert.equal(m1.quoted, undefined);
  const m2 = messages.find((m) => m.id === "m2");
  assert.equal(m2.body, "Hi Kevin, looking at it now.");
  assert.match(m2.quoted, /^On Mon, Oct 19, 2026 at 9:14 AM Kevin Example <kevin@example.com>\nwrote:\n> Hi Alex,/);
  // The ">" lines it ends with, without the wrote line.
  assert.deepEqual(P.splitQuoted("Sounds good.\n\n> earlier\n> words\n"), { body: "Sounds good.", quoted: "> earlier\n> words" });
  // Outlook's header.
  assert.deepEqual(P.splitQuoted("Done.\n\nFrom: Kevin Example\nSent: Monday\nTo: Alex\nSubject: Re: x\n\nold"), { body: "Done.", quoted: "From: Kevin Example\nSent: Monday\nTo: Alex\nSubject: Re: x\n\nold" });
  // All quote (a forward with nothing added): kept whole.
  assert.deepEqual(P.splitQuoted("> only quoted"), { body: "> only quoted" });
});

await test("an HTML only email made text: no script, style, title, picture or hidden part; a link as its words and address; lines kept; Gmail's quote block set apart; javascript: links not kept", () => {
  const m3 = P.parseGmailThread(gmailThread(), []).messages.find((m) => m.id === "m3");
  assert.equal(
    m3.body,
    [
      "Thanks Alex!",
      "",
      "Here is the fixed invoice (https://example.com/invoices/fixed), and https://example.com/help.",
      "Call me at 555 0100.",
      "",
      "• Line one",
      "• Line two",
      "",
      "A tag in my words: <img src=x onerror=alert(2)> stays words.",
    ].join("\n"),
  );
  for (const gone of ["alert(1)", "stolen", "color:red", "Re: Invoice</title", "hidden preheader", "tracker.example.com", "logo.png", "<p>", "<a "]) assert.ok(!m3.body.includes(gone) && !(m3.quoted ?? "").includes(gone), `no "${gone}"`);
  assert.equal(m3.quoted, "On Mon, Oct 19, 2026 at 10:02 AM Alex Owner <alex@example.com> wrote:\n\nHi Kevin, looking at it now.\n\nclick");
  assert.ok(!m3.quoted.includes("javascript"));
  // Composio's own text when there's no part: HTML made text the same way.
  const only = P.parseGmailThread({ messages: [{ messageId: "x", messageText: "<div>Hello <b>there</b></div><script>bad()</script>", sender: "Ava Lee <ava@example.org>", to: "alex@example.com", subject: "Hi" }] }, []);
  assert.equal(only.messages[0].body, "Hello there");
  assert.equal(only.subject, "Hi");
  assert.equal(P.decodeEntities("Tom &amp; Jerry&#39;s &#x2019; &nbsp;x &bogus;"), "Tom & Jerry's ’  x &bogus;");
});

await test("who a reply goes to: the newest message's sender that isn't the user; Reply all the others on it, never the user; with only the user's own, the one they wrote to", () => {
  const { messages } = P.parseGmailThread(gmailThread(), ["alex@example.com"]);
  assert.deepEqual(P.gmailReply(messages), { to: { name: "Kevin Example", email: "kevin@example.com" }, all: { to: [], cc: [{ name: "Ava Lee", email: "ava@example.org" }, { name: "Max Doe", email: "max@example.net" }] } });
  const mineOnly = messages.filter((m) => m.mine);
  assert.deepEqual(P.gmailReply(mineOnly), { to: { name: "Kevin Example", email: "kevin@example.com" }, all: { to: [], cc: [] } });
  // Reply-To wins over From.
  const withReplyTo = P.parseGmailThread({ messages: [{ messageId: "r", payload: { headers: headers({ From: "Support Bot <noreply@example.com>", "Reply-To": "Help Desk <help@example.com>", To: "alex@example.com" }), mimeType: "text/plain", body: { data: b64("Hi") } } }] }, ["alex@example.com"]);
  assert.equal(P.gmailReply(withReplyTo.messages).to.email, "help@example.com");
});

/* ---------------- Slack and Discord, parsed ---------------- */

const TS = "1700000000.000100";
const slackThread = () => ({
  ok: true,
  messages: [
    { ts: TS, thread_ts: TS, user: "U01KEVIN", text: "*Outage*: the dashboard is down for <@U02AVA>, see <https://status.example.com|the status page>", reply_count: 6, reactions: [{ name: "eyes", count: 2, users: ["U02AVA", "U03MAX"] }, { name: "+1", users: ["U03MAX"] }] },
    { ts: "1700000060.000200", thread_ts: TS, user: "U02AVA", text: "Looking. Logs say:\n```Error: pool exhausted\n  at db.connect```" },
    { ts: "1700000120.000300", thread_ts: TS, user: "U03MAX", text: "_maybe_ the ~old~ new pool? try `SET max=50`" },
    { ts: "1700000180.000400", thread_ts: TS, user: "U01KEVIN", text: "Moving this to <#C0999OPS|ops>. &lt;b&gt;not html&lt;/b&gt; &amp; fine" },
    { ts: "1700000240.000500", thread_ts: TS, user: "U02AVA", text: "&gt; is it back?\nYes, back now.", files: [{ name: "graph.png", size: 120000, mimetype: "image/png" }] },
    { ts: "1700000300.000600", thread_ts: TS, bot_id: "B01", username: "Status Bot", text: "Resolved" },
    { ts: "1700000360.000700", thread_ts: TS, user: "U03MAX", text: "Thanks all <!here>", edited: { ts: "1700000370.000000" } },
    { ts: "1700000400.000800", subtype: "channel_join", user: "U09", text: "joined" },
  ],
});
const NAMES = { U01KEVIN: "Kevin Example", U02AVA: "Ava Lee", U03MAX: "Max Doe" };

await test("a Slack thread: the first message then its replies, names from the lookups, a bot by its name, reactions and files; who to look up", () => {
  assert.deepEqual(P.slackUserIds(slackThread()), ["U01KEVIN", "U02AVA", "U03MAX", "U09"]);
  const ms = P.parseSlackMessages(slackThread(), NAMES);
  assert.equal(ms.length, 7, "a join isn't a message");
  assert.deepEqual(ms[0].user, { id: "U01KEVIN", name: "Kevin Example" });
  assert.deepEqual(ms[0].reactions, [{ name: "eyes", count: 2 }, { name: "+1", count: 1 }]);
  assert.equal(ms[0].at, 1700000000000);
  assert.deepEqual(ms[4].files, [{ name: "graph.png", size: 120000, type: "image/png" }]);
  assert.deepEqual(ms[5].user, { name: "Status Bot", bot: true });
  assert.equal(ms[6].edited, true);
});

await test("Slack's marks read as text spans: bold, italic, struck, code, code blocks, quotes, links, mentions by name; an escaped tag stays text; only safe links", () => {
  const ms = P.parseSlackMessages(slackThread(), NAMES);
  const [b0] = V.chatBlocks(ms[0].text, "slack", NAMES, {});
  assert.deepEqual(b0.spans, [
    { t: "b", text: "Outage" },
    { t: "text", text: ": the dashboard is down for " },
    { t: "mention", text: "@Ava Lee" },
    { t: "text", text: ", see " },
    { t: "link", text: "the status page", href: "https://status.example.com" },
  ]);
  assert.deepEqual(V.chatBlocks(ms[1].text, "slack"), [{ t: "p", spans: [{ t: "text", text: "Looking. Logs say:" }] }, { t: "pre", text: "Error: pool exhausted\n  at db.connect" }]);
  assert.deepEqual(V.chatBlocks(ms[2].text, "slack")[0].spans, [
    { t: "i", text: "maybe" },
    { t: "text", text: " the " },
    { t: "s", text: "old" },
    { t: "text", text: " new pool? try " },
    { t: "code", text: "SET max=50" },
  ]);
  assert.deepEqual(V.chatBlocks(ms[3].text, "slack")[0].spans, [{ t: "text", text: "Moving this to " }, { t: "mention", text: "#ops" }, { t: "text", text: ". <b>not html</b> & fine" }]);
  assert.deepEqual(V.chatBlocks(ms[4].text, "slack"), [{ t: "quote", spans: [{ t: "text", text: "is it back?" }] }, { t: "p", spans: [{ t: "text", text: "Yes, back now." }] }]);
  assert.deepEqual(V.chatBlocks("<@U0NOBODY> and <#C0NOPE>", "slack")[0].spans, [{ t: "mention", text: "@U0NOBODY" }, { t: "text", text: " and " }, { t: "mention", text: "#C0NOPE" }]);
  assert.deepEqual(V.chatBlocks("<javascript:alert(1)|click me>", "slack")[0].spans, [{ t: "text", text: "click me" }]);
  assert.equal(V.safeHref("javascript:alert(1)"), undefined);
  assert.equal(V.safeHref("mailto:ava@example.org"), "mailto:ava@example.org");
});

await test("a Discord channel's messages: oldest first, names (a nickname first), mentions, embeds' words when there are none, its markdown", () => {
  const { messages, names } = P.parseDiscordMessages([
    { id: "333333333333333334", author: { id: "444444444444444444", username: "max", global_name: "Max Doe" }, content: "**fixed** now, <@555555555555555555>", timestamp: "2026-10-20T10:05:00Z", mentions: [{ id: "555555555555555555", username: "ava" }], reactions: [{ count: 3, emoji: { name: "🎉" } }] },
    { id: "333333333333333333", author: { id: "555555555555555555", username: "ava" }, member: { nick: "Ava L" }, content: "", embeds: [{ title: "Build failed", description: "main is red" }], timestamp: "2026-10-20T10:00:00Z" },
  ]);
  assert.deepEqual(messages.map((m) => m.id), ["333333333333333333", "333333333333333334"]);
  assert.equal(messages[0].user.name, "Ava L");
  assert.equal(messages[0].text, "Build failed\nmain is red");
  assert.equal(names["555555555555555555"], "Ava L");
  assert.deepEqual(V.chatBlocks(messages[1].text, "discord", names)[0].spans, [{ t: "b", text: "fixed" }, { t: "text", text: " now, " }, { t: "mention", text: "@Ava L" }]);
  assert.deepEqual(messages[1].reactions, [{ name: "🎉", count: 3 }]);
});

await test("the small words: to me, +2; a file's size; the drafted reply to start from (none once a reply went)", () => {
  const p = (name, email, me) => ({ name, email, ...(me ? { me } : {}) });
  assert.equal(V.recipientsLine([p("Alex", "alex@example.com", true)], []), "to me");
  assert.equal(V.recipientsLine([p("Kevin Example", "kevin@example.com"), p("Alex", "alex@example.com", true)], []), "to me, Kevin");
  assert.equal(V.recipientsLine([p("Alex", "alex@example.com", true)], [p("Ava Lee", "ava@example.org"), p("Max", "max@example.net")]), "to me, +2");
  assert.deepEqual([V.fileSize(820), V.fileSize(48213), V.fileSize(2_400_000), V.fileSize(undefined)], ["820 B", "48 KB", "2.4 MB", ""]);
  const h1 = [
    { at: 1, who: "Boppy", text: "Opened: Invoice", kind: "opened" },
    { at: 2, who: "Boppy", text: "Reply drafted: Yes, it's 10 seats. Fixing it.", kind: "reply" },
  ];
  assert.deepEqual(V.draftedReply(h1), { text: "Yes, it's 10 seats. Fixing it.", who: "Boppy" });
  assert.equal(V.draftedReply([...h1, { at: 3, who: "Alex", text: "Replied: Fixed.", kind: "reply" }]), undefined);
});

/* ---------------- Gmail, drawn ---------------- */

await test("Gmail's view: the subject and how many, the newest open and the older folded to a line, a click opening and folding each, Expand all and Collapse all", async () => {
  const m = await mount(h(SourceThread, { source: mailSource() }));
  try {
    shown.push(said(m.box));
    assert.equal(m.box.querySelector("[data-subject]").textContent, "Re: Invoice for October");
    assert.match(said(m.box), /3 messages · Work · alex@example\.com/);
    const open = () => [...m.box.querySelectorAll("[data-mail][data-open]")].map((x) => x.getAttribute("data-mail"));
    assert.deepEqual(open(), ["m3"]);
    const folded = m.box.querySelector('button[data-mail="m1"]');
    assert.match(said(folded), /^K Kevin Example Hi Alex, The invoice for October looks wrong\./);
    assert.ok(folded.querySelector('[aria-label="Has files"]'), "a clip for its file");
    await click(folded);
    assert.deepEqual(open(), ["m1", "m3"]);
    // Its name folds it again.
    await click(m.box.querySelector('[data-mail="m1"][data-open] button[title="Fold"]'));
    assert.deepEqual(open(), ["m3"]);
    await click(buttons(m.box, "Expand all")[0]);
    assert.deepEqual(open(), ["m1", "m2", "m3"]);
    assert.equal(buttons(m.box, "Expand all").length, 0);
    await click(buttons(m.box, "Collapse all")[0]);
    assert.deepEqual(open(), []);
  } finally {
    await m.done();
  }
});

await test("an open email: who it went to folded (to me, +2) and opened; its words as text, links that open, its quoted history behind Show quoted text, its files", async () => {
  const m = await mount(h(SourceThread, { source: mailSource() }));
  try {
    const m3 = m.box.querySelector('[data-mail="m3"][data-open]');
    assert.equal(m3.querySelector("[data-to]").textContent, "to me, +2");
    assert.ok(!m3.querySelector("[data-details]"));
    await click(m3.querySelector("[data-to]"));
    assert.match(said(m3.querySelector("[data-details]")), /From Kevin Example <kevin@example\.com> To me Cc Ava Lee <ava@example\.org>, Max Doe <max@example\.net> Date /);
    const body = m3.querySelector("[data-body]");
    assert.match(body.textContent, /Here is the fixed invoice \(https:\/\/example\.com\/invoices\/fixed\)/);
    assert.deepEqual([...body.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.getAttribute("target")]), [["https://example.com/invoices/fixed", "_blank"], ["https://example.com/help", "_blank"]]);
    assert.ok(!m3.querySelector("[data-quoted]"));
    await click(m3.querySelector("[data-quoted-toggle]"));
    assert.match(m3.querySelector("[data-quoted]").textContent, /^On Mon, Oct 19, 2026 at 10:02 AM Alex Owner <alex@example\.com> wrote:/);
    assert.equal(m3.querySelector("[data-quoted-toggle]").textContent, "Hide quoted text");
    await click(m.box.querySelector('button[data-mail="m1"]'));
    assert.match(said(m.box.querySelector('[data-mail="m1"] [data-files]')), /invoice-october\.pdf 48 KB/);
    shown.push(said(m.box));
  } finally {
    await m.done();
  }
});

await test("nothing of an email is ever HTML: no script runs, no picture loads, a tag in its words is shown as words", async () => {
  delete globalThis.stolen;
  const m = await mount(h(SourceThread, { source: mailSource() }));
  try {
    await click(buttons(m.box, "Expand all")[0]);
    for (const b of m.box.querySelectorAll("[data-quoted-toggle]")) await click(b);
    assert.equal(m.box.querySelectorAll("script, img, style, iframe, object, embed, b, p, ul, li, blockquote").length, 0);
    assert.ok(m.box.textContent.includes("A tag in my words: <img src=x onerror=alert(2)> stays words."));
    assert.ok(!m.box.innerHTML.includes("<img"), "only as escaped text");
    assert.ok(![...m.box.querySelectorAll("a")].some((a) => /^javascript:/i.test(a.getAttribute("href") ?? "")));
    assert.equal(globalThis.stolen, undefined);
    // And the view never uses dangerouslySetInnerHTML at all.
    assert.ok(!readFileSync(`${root}/components/app/source-view.tsx`, "utf8").includes("dangerouslySetInnerHTML"));
  } finally {
    await m.done();
  }
});

/* ---------------- Slack, drawn ---------------- */

const slackSource = (extra = {}) => ({
  app: "slack",
  account: { id: "ca_slack", title: "Acme" },
  channel: { id: "C0123ABCD", name: "support" },
  thread: TS,
  messages: P.parseSlackMessages(slackThread(), NAMES),
  names: NAMES,
  channels: { C0123ABCD: "support" },
  ...extra,
});

await test("Slack's view: the channel, the first message, N more replies folded in the middle and the newest three, a click for all; marks as text elements, reactions as counts", async () => {
  const m = await mount(h(SourceThread, { source: slackSource() }));
  try {
    shown.push(said(m.box));
    assert.equal(m.box.querySelector("[data-channel]").textContent, "#support");
    assert.match(said(m.box), /6 replies · Acme/);
    const lines = () => [...m.box.querySelectorAll("[data-chat]")].map((x) => x.getAttribute("data-chat"));
    assert.deepEqual(lines(), [TS, "1700000240.000500", "1700000300.000600", "1700000360.000700"]);
    const more = m.box.querySelector("[data-more]");
    assert.equal(more.textContent, "3 more replies");
    const first = m.box.querySelector(`[data-chat="${TS}"]`);
    assert.equal(first.querySelector("strong").textContent, "Outage");
    assert.equal(first.querySelector("a").getAttribute("href"), "https://status.example.com");
    assert.match(said(first.querySelector("[data-reactions]")), /^👀 2 👍 1$/);
    assert.match(said(m.box.querySelector('[data-chat="1700000300.000600"]')), /^S Status Bot App/);
    assert.match(said(m.box.querySelector('[data-chat="1700000360.000700"]')), /\(edited\) Thanks all @here$/);
    await click(more);
    assert.equal(lines().length, 7);
    assert.ok(!m.box.querySelector("[data-more]"));
    assert.equal(m.box.querySelector('[data-chat="1700000060.000200"] pre').textContent, "Error: pool exhausted\n  at db.connect");
    assert.ok(m.box.querySelector('[data-chat="1700000060.000200"] pre').className.includes("overflow-x-auto"), "a code block scrolls in itself");
    const m3 = m.box.querySelector('[data-chat="1700000120.000300"]');
    assert.deepEqual([m3.querySelector("em").textContent, m3.querySelector("s").textContent, m3.querySelector("code").textContent], ["maybe", "old", "SET max=50"]);
    assert.equal(m.box.querySelectorAll("b").length, 0, "Slack's escaped tag stays words");
    assert.ok(m.box.textContent.includes("<b>not html</b> & fine"));
    shown.push(said(m.box));
  } finally {
    await m.done();
  }
});

/* ---------------- On an issue's page: reading, errors, a shared workspace ---------------- */

const ISSUE = { id: "issue-11111111-2222-4333-8444-555555555555", sourceApp: "gmail", url: `https://mail.google.com/mail/u/0/#inbox/${THREAD}`, history: [] };
const SRC_URL = `/api/orbit/issues/${ISSUE.id}/source?ws=w1`;

await test("the issue's email is read once as it opens, \"Reading the email…\" until it comes, then the thread with its Reply box", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  answer = async (url) => (url.startsWith(SRC_URL) ? (await gate, { status: 200, body: { source: mailSource() } }) : { status: 404, body: {} });
  const m = await mount(h(IssueSource, { issue: ISSUE, ws: "w1" }));
  try {
    assert.equal(m.box.querySelector("[data-source]").getAttribute("data-source"), "loading");
    assert.match(said(m.box), /^Email Reading the email…$/);
    await act(async () => {
      release();
      await settle();
    });
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [["GET", SRC_URL]]);
    assert.equal(m.box.querySelector("[data-source]").getAttribute("data-source"), "shown");
    assert.ok(m.box.querySelector('[data-thread="gmail"] [data-reply]'));
    assert.match(said(m.box.querySelector("[data-reply]")), /^Reply Reply all To Kevin Example <kevin@example\.com>/);
    shown.push(said(m.box));
  } finally {
    await m.done();
  }
});

await test("what failed, in plain words: signed out (Sign in again in Logins), gone or down with Try again, which reads it again now", async () => {
  const say = { signed_out: [409, "Gmail (Work) is signed out. Sign in to Gmail again in Logins to see the email here."], down: [502, "Couldn't reach Gmail just now."] };
  for (const [code, [status, error]] of Object.entries(say)) {
    answer = (url) => (url.startsWith(SRC_URL) ? { status, body: { error, code } } : { status: 404, body: {} });
    calls.length = 0;
    const m = await mount(h(IssueSource, { issue: ISSUE, ws: "w1" }));
    try {
      assert.equal(m.box.querySelector("[data-source]").getAttribute("data-source"), code);
      assert.ok(said(m.box).includes(error));
      shown.push(said(m.box));
      const again = buttons(m.box, "Try again")[0];
      if (code === "signed_out") assert.ok(!again, "nothing to try again: sign in first");
      else {
        answer = (url) => (url.startsWith(SRC_URL) ? { status: 200, body: { source: mailSource() } } : { status: 404, body: {} });
        await click(again);
        assert.equal(calls.at(-1).url, `${SRC_URL}&fresh=1`);
        assert.equal(m.box.querySelector("[data-source]").getAttribute("data-source"), "shown");
      }
    } finally {
      await m.done();
    }
  }
});

await test("an issue from an app Bops can't show: nothing read, nothing drawn (its summary and Open link stay)", async () => {
  const m = await mount(h(IssueSource, { issue: { ...ISSUE, sourceApp: "plain" }, ws: "w1" }));
  try {
    assert.equal(calls.length, 0);
    assert.equal(m.box.innerHTML, "");
  } finally {
    await m.done();
  }
});

/* ---------------- Replying ---------------- */

await test("the Reply box: the drafted reply to start from; Send sends once however fast it's clicked; sent, it says to whom; a new click is its own", async () => {
  let release;
  let gate = new Promise((r) => (release = r));
  const posts = [];
  answer = async (url, method, body) => {
    if (!url.startsWith(SRC_URL)) return { status: 404, body: {} };
    if (method === "GET") return { status: 200, body: { source: mailSource() } };
    posts.push(body);
    await gate;
    return { status: 200, body: { ok: true, sent: { at: Date.parse("2026-10-20T14:00:00Z"), to: "kevin@example.com" }, logged: true } };
  };
  let replied = 0;
  const issue = { ...ISSUE, history: [{ at: 1, who: "Boppy", text: "Opened: Invoice", kind: "opened" }, { at: 2, who: "Boppy", text: "Reply drafted: Yes, it's 10 seats. Fixing it now.", kind: "reply" }] };
  const m = await mount(h(IssueSource, { issue, ws: "w1", onReplied: () => replied++ }));
  try {
    const box = m.box.querySelector("textarea");
    assert.equal(box.value, "Yes, it's 10 seats. Fixing it now.");
    assert.match(said(m.box.querySelector("[data-reply]")), /Boppy drafted this reply\. Change it as you like\./);
    await typeIn(box, "Yes, 10 seats. Fixed in the new invoice.");
    const send = buttons(m.box, "Send")[0];
    await act(async () => {
      send.dispatchEvent(new win.Event("click", { bubbles: true }));
      send.dispatchEvent(new win.Event("click", { bubbles: true }));
      await settle();
    });
    await click(buttons(m.box, /Send|Sending/)[0]);
    assert.equal(posts.length, 1, "one send, however many clicks");
    assert.deepEqual(Object.keys(posts[0]).sort(), ["all", "nonce", "text", "ws"]);
    assert.deepEqual([posts[0].ws, posts[0].text, posts[0].all], ["w1", "Yes, 10 seats. Fixed in the new invoice.", false]);
    assert.match(posts[0].nonce, /^[A-Za-z0-9_-]{8,80}$/);
    assert.equal(box.disabled, true, "while it goes");
    await act(async () => {
      release();
      await settle();
    });
    assert.equal(replied, 1);
    assert.equal(m.box.querySelector("textarea").value, "");
    assert.match(said(m.box.querySelector("[data-sent]")), /^Sent to kevin@example\.com · /);
    shown.push(said(m.box));
    // Another reply: its own click, its own nonce; Reply all this time.
    gate = Promise.resolve();
    await click(buttons(m.box, "Reply all")[0]);
    assert.match(said(m.box.querySelector("[data-reply-to]")), /^To Kevin Example <kevin@example\.com> Cc Ava Lee <ava@example\.org> Max Doe <max@example\.net>$/);
    await typeIn(m.box.querySelector("textarea"), "Copying everyone.");
    await click(buttons(m.box, "Send")[0]);
    assert.equal(posts.length, 2);
    assert.equal(posts[1].all, true);
    assert.notEqual(posts[1].nonce, posts[0].nonce);
  } finally {
    await m.done();
  }
});

await test("a reply that didn't go says why and keeps the words; Slack's box says where it goes; with no one to reply to, it says so", async () => {
  answer = (url, method) => {
    if (!url.startsWith(SRC_URL)) return { status: 404, body: {} };
    if (method === "GET") return { status: 200, body: { source: slackSource() } };
    return { status: 502, body: { ok: false, error: "Slack didn't take it: channel_not_found" } };
  };
  const m = await mount(h(IssueSource, { issue: { ...ISSUE, sourceApp: "slack" }, ws: "w1" }));
  try {
    assert.equal(said(m.box.querySelector("[data-reply-to]")), "In #support, in its thread");
    assert.equal(m.box.querySelector("textarea").getAttribute("placeholder"), "Reply in the thread");
    await typeIn(m.box.querySelector("textarea"), "On it.");
    await click(buttons(m.box, "Send")[0]);
    assert.equal(m.box.querySelector('[role="alert"]').textContent, "Slack didn't take it: channel_not_found");
    assert.equal(m.box.querySelector("textarea").value, "On it.");
    shown.push(said(m.box));
  } finally {
    await m.done();
  }
  answer = (url) => (url.startsWith(SRC_URL) ? { status: 200, body: { source: { ...mailSource(), reply: undefined } } } : { status: 404, body: {} });
  const n = await mount(h(IssueSource, { issue: ISSUE, ws: "w1" }));
  try {
    assert.ok(!n.box.querySelector("textarea"));
    assert.ok(said(n.box).includes("Bops can't tell who to reply to here. Reply in Gmail."));
  } finally {
    await n.done();
  }
});

/* ---------------- A drafted reply's card ---------------- */

await test("a drafted reply's card: Show the email reads its thread from the account it goes from, read only; in a shared workspace, no such button", async () => {
  const draft = { id: "drf_k", app: "gmail", accountId: "ca_gmail_work", threadId: THREAD, to: "kevin@example.com", subject: "Invoice for October", toName: "Kevin Example", text: "Yes, it's right." };
  const message = { id: "m_bot", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Here's a reply.", at: 5, drafts: [draft] };
  const DRAFT_URL = "/api/drafts/source?messageId=m_bot&draftId=drf_k";
  answer = (url) => (url === DRAFT_URL ? { status: 200, body: { source: mailSource() } } : { status: 404, body: {} });
  const m = await mount(h(ReplyDrafts, { message, state: { accounts: [] } }));
  try {
    assert.equal(calls.length, 0, "nothing read until asked");
    await click(m.box.querySelector("[data-draft-show]"));
    assert.deepEqual(calls.map((c) => c.url), [DRAFT_URL]);
    assert.ok(m.box.querySelector('[data-thread="gmail"]'));
    assert.ok(!m.box.querySelector("[data-reply]"), "the card is its reply");
    assert.equal(m.box.querySelector("[data-draft-show]").textContent, "Hide the email");
    shown.push(said(m.box));
  } finally {
    await m.done();
  }
  const s = await mount(h(ReplyDrafts, { message: { ...message, drafts: [{ ...draft, accountId: undefined, threadId: undefined }] }, state: { accounts: [], shared: { role: "viewer" } } }));
  try {
    assert.ok(!s.box.querySelector("[data-draft-show]"));
  } finally {
    await s.done();
  }
});

/* ---------------- A shared workspace ---------------- */

await test("in a workspace shared with the user: the issue's email is never asked for, a plain line says only its owner can see it, and the window refuses it anyway", async () => {
  viewOnly("This workspace is view only.");
  try {
    calls.length = 0;
    answer = () => ({ status: 200, body: { source: mailSource() } });
    const m = await mount(h(IssueSource, { issue: ISSUE, ws: "w1" }));
    try {
      assert.equal(calls.length, 0, "nothing asked for");
      assert.equal(m.box.querySelector("[data-source]").getAttribute("data-source"), "shared");
      assert.equal(said(m.box), "Email Only the workspace's owner can see the original email.");
      shown.push(said(m.box));
    } finally {
      await m.done();
    }
    // And a call made anyway is answered here, without going out.
    const r = await fetch(SRC_URL);
    assert.equal(r.status, 403);
    const d = await fetch("/api/drafts/source?messageId=m&draftId=d");
    assert.equal(d.status, 403);
    assert.equal(calls.length, 0);
  } finally {
    viewOnly(null);
  }
});

await test("plain words: no dashes in anything shown or said, no Orbit in the window, and no dashes in the files' text", () => {
  for (const s of shown) {
    assert.ok(!DASHES.test(s), `a dash in: ${s}`);
    assert.ok(!/\bOrbit\b/.test(s), `Orbit in: ${s}`);
  }
  for (const code of ["signed_out", "no_account", "gone", "down", "unparsed", "shared", "window", "runner", "unsupported"])
    for (const app of ["gmail", "slack", "discord"]) assert.ok(!DASHES.test(V.sourceError(code, app, "Work")));
  for (const file of ["components/app/source-view.tsx", "lib/source-view.ts", "lib/source-parse.ts", "lib/server/issue-source.ts", "app/api/orbit/issues/[id]/source/route.ts", "app/api/drafts/source/route.ts"])
    readFileSync(`${root}/${file}`, "utf8")
      .split("\n")
      .forEach((line, n) => assert.ok(!DASHES.test(line), `${file}:${n + 1} has a dash`));
});

console.log(`\nsource view: ${passed} passed`);
process.exit(0);
