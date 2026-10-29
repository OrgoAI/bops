/*
 * The email or thread an issue came from (and a drafted reply's), as the window shows it: read live from the
 * user's own account when it opens (lib/server/issue-source.ts), never kept. Everything in it is plain text:
 * an email's HTML is made text on the server (lib/source-parse.ts), and a Slack or Discord message's marks are
 * read here into spans the window draws as text (components/app/source-view.tsx), never as HTML. Imported by
 * the window and the server alike: no server imports here.
 */

export type SourceApp = "gmail" | "slack" | "discord";

/** The app an issue's sourceApp names, when Bops can show its thread; null for any other (Plain, a web page). */
export function sourceAppOf(app?: string | null): SourceApp | null {
  const a = (app ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (a === "gmail" || a === "googlemail" || a === "googleworkspace" || a === "email") return "gmail";
  if (a === "slack") return "slack";
  if (a === "discord" || a === "discordbot") return "discord";
  return null;
}

export const SOURCE_NAME: Record<SourceApp, string> = { gmail: "Gmail", slack: "Slack", discord: "Discord" };

/** Someone on an email: their name and address as its headers have them, and whether it's the user (one of their own addresses). */
export type Person = { name?: string; email?: string; me?: boolean };
/** A file on a message: its name and size, never its contents (nothing is downloaded). */
export type SourceFile = { name: string; size?: number; type?: string };

export type MailMessage = {
  id: string;
  from: Person;
  to: Person[];
  cc: Person[];
  replyTo?: Person[];
  at?: number;
  /** One line of it, for the folded row. */
  snippet: string;
  /** What it says, as plain text, without the quoted history under it. */
  body: string;
  /** The quoted history ("On … wrote:" and what follows), folded behind Show quoted text. */
  quoted?: string;
  files: SourceFile[];
  /** Sent by the user. */
  mine?: boolean;
};

/** Who a reply goes to: the newest message's sender that isn't the user, and with Reply all the others on it too. */
export type MailReply = { to: Person; all: { to: Person[]; cc: Person[] } };

export type SourceAccount = { id: string; title: string };

export type MailThread = {
  app: "gmail";
  account: SourceAccount;
  threadId: string;
  subject: string;
  /** Oldest first. */
  messages: MailMessage[];
  reply?: MailReply;
  url?: string;
  /** More of it than was read (a very long thread). */
  more?: boolean;
};

export type ChatMessage = {
  /** Slack's ts, or Discord's message id. */
  id: string;
  user: { id?: string; name: string; bot?: boolean };
  at?: number;
  /** The words as the app has them (Slack's mrkdwn, Discord's markdown): drawn as text, its marks read by chatBlocks. */
  text: string;
  reactions: { name: string; count: number }[];
  files: SourceFile[];
  edited?: boolean;
};

export type ChatThread = {
  app: "slack" | "discord";
  account: SourceAccount;
  channel: { id: string; name?: string; dm?: boolean };
  /** Slack: the thread's first message (its ts), where a reply goes. */
  thread?: string;
  /** Discord: the message the issue is about, which a reply answers. */
  message?: string;
  /** Oldest first; for Slack, the thread's first message, then its replies. */
  messages: ChatMessage[];
  /** Names by user id, and channels' names by id, for the mentions in the words. */
  names: Record<string, string>;
  channels: Record<string, string>;
  url?: string;
  more?: boolean;
};

export type IssueSource = MailThread | ChatThread;

/** Why there's nothing to show, as the window says it. */
export type SourceCode = "signed_out" | "no_account" | "gone" | "down" | "unparsed" | "unsupported" | "shared" | "window" | "runner";
export type SourceAnswer = { source: IssueSource } | { error: string; code: SourceCode };

/** "the email" for Gmail, "the thread" for Slack and Discord. */
export const sourceNoun = (app: SourceApp) => (app === "gmail" ? "email" : "thread");

/** What a failed read says, in plain words. `account`: the one it's about, when it's one ("Work"). */
export function sourceError(code: SourceCode, app: SourceApp, account?: string): string {
  const name = SOURCE_NAME[app];
  const noun = sourceNoun(app);
  switch (code) {
    case "signed_out":
      return `${account ? `${name} (${account})` : name} is signed out. Sign in to ${name} again in Logins to see the ${noun} here.`;
    case "no_account":
      return app === "discord" ? "No Discord bot is connected. Connect one in Logins to see the thread here." : `No ${name} account is connected. Connect one in Logins to see the ${noun} here.`;
    case "gone":
      return app === "gmail" ? "This email isn't in your Gmail anymore." : `Bops can't find this thread in ${name}. It may be deleted, or in a channel your account can't see.`;
    case "down":
      return `Couldn't reach ${name} just now.`;
    case "unparsed":
      return `Bops can't tell which ${app === "gmail" ? "email" : `${name} thread`} this is.`;
    case "shared":
      return `Only the workspace's owner can see the original ${noun}.`;
    case "window":
      return `Only the Bops app can show the ${noun}.`;
    case "runner":
      return `Open Bops on your Mac to see the ${noun}.`;
    default:
      return `Bops can't show the ${noun} from ${name}.`;
  }
}

/* ---------------- Words, for the window ---------------- */

/** A piece of a line: plain, bold, italic, struck, code, a link (only http, https and mailto ones go anywhere), or a mention. */
export type Span = { t: "text" | "b" | "i" | "s" | "code" | "link" | "mention"; text: string; href?: string };
/** A paragraph of spans, a code block, or a quote. */
export type Block = { t: "p"; spans: Span[] } | { t: "pre"; text: string } | { t: "quote"; spans: Span[] };

const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s<>"]+$/i;
/** A link worth opening: http, https or mailto, nothing else (no javascript:, no file:). */
export const safeHref = (href: string) => (SAFE_HREF.test(href.trim()) ? href.trim() : undefined);

const URL_IN = /https?:\/\/[^\s<>"]+[^\s<>"'.,;:!?)\]}]/g;

/** Plain text with its web addresses as links (an email's body). */
export function linkSpans(text: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_IN)) {
    if (m.index! > at) out.push({ t: "text", text: text.slice(at, m.index) });
    out.push({ t: "link", text: m[0], href: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ t: "text", text: text.slice(at) });
  return merge(out);
}

const merge = (spans: Span[]) => {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (s.t === "text" && last?.t === "text") last.text += s.text;
    else if (s.text) out.push(s);
  }
  return out;
};

const unescapeSlack = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** A Slack `<…>` (a link, a mention, a channel, @here) or a Discord one (a mention, a channel, an emoji, a time) as a span. */
function angle(inner: string, app: "slack" | "discord", names: Record<string, string>, channels: Record<string, string>): Span {
  const [head, label] = [inner.split("|")[0], inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : ""];
  if (app === "slack") {
    if (/^@[UW][A-Z0-9]+$/.test(head)) return { t: "mention", text: `@${label || names[head.slice(1)] || head.slice(1)}` };
    if (/^#[CGD][A-Z0-9]+$/.test(head)) return { t: "mention", text: `#${label || channels[head.slice(1)] || head.slice(1)}` };
    if (/^!(here|channel|everyone)$/.test(head)) return { t: "mention", text: `@${head.slice(1)}` };
    if (head.startsWith("!subteam^")) return { t: "mention", text: label || "@team" };
    if (head.startsWith("!date^")) return { t: "text", text: unescapeSlack(label || "") };
    const href = safeHref(unescapeSlack(head));
    if (href) return { t: "link", text: unescapeSlack(label || head.replace(/^mailto:/i, "")), href };
    return { t: "text", text: unescapeSlack(label || head) };
  }
  let m = /^@!?(\d{5,25})$/.exec(inner);
  if (m) return { t: "mention", text: `@${names[m[1]] ?? "someone"}` };
  m = /^#(\d{5,25})$/.exec(inner);
  if (m) return { t: "mention", text: `#${channels[m[1]] ?? "channel"}` };
  if (/^@&\d{5,25}$/.test(inner)) return { t: "mention", text: "@role" };
  m = /^a?:([A-Za-z0-9_~-]{1,40}):\d{5,25}$/.exec(inner);
  if (m) return { t: "text", text: `:${m[1]}:` };
  m = /^t:(-?\d{1,12})(?::[tTdDfFR])?$/.exec(inner);
  if (m) return { t: "text", text: new Date(Number(m[1]) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) };
  const href = safeHref(inner);
  if (href) return { t: "link", text: href, href };
  return { t: "text", text: `<${inner}>` };
}

/** Bold, italic, struck and inline code in a run of text (Slack's single marks, Discord's double ones), then its web addresses. */
function inline(s: string, app: "slack" | "discord"): Span[] {
  const re =
    app === "slack"
      ? /`([^`\n]+)`|(^|[\s([{"'])\*(?!\s)([^*\n]+?)\*(?=$|[\s.,!?;:)\]}"'])|(^|[\s([{"'])_(?!\s)([^_\n]+?)_(?=$|[\s.,!?;:)\]}"'])|(^|[\s([{"'])~(?!\s)([^~\n]+?)~(?=$|[\s.,!?;:)\]}"'])/g
      : /`([^`\n]+)`|\*\*(?!\s)([^*\n]+?)\*\*|__(?!\s)([^_\n]+?)__|~~(?!\s)([^~\n]+?)~~|(^|[\s([{"'])\*(?!\s)([^*\n]+?)\*(?=$|[\s.,!?;:)\]}"'])|(^|[\s([{"'])_(?!\s)([^_\n]+?)_(?=$|[\s.,!?;:)\]}"'])/g;
  const out: Span[] = [];
  let at = 0;
  const text = (x: string) => out.push(...linkSpans(app === "slack" ? unescapeSlack(x) : x));
  for (const m of s.matchAll(re)) {
    if (m.index! > at) text(s.slice(at, m.index));
    const g = (k: number) => m[k];
    if (g(1) !== undefined) out.push({ t: "code", text: app === "slack" ? unescapeSlack(g(1)) : g(1) });
    else if (app === "slack") {
      const [pre, body, t] = g(3) !== undefined ? [g(2), g(3), "b"] : g(5) !== undefined ? [g(4), g(5), "i"] : [g(6), g(7), "s"];
      if (pre) text(pre);
      out.push({ t: t as Span["t"], text: unescapeSlack(body) });
    } else {
      if (g(2) !== undefined) out.push({ t: "b", text: g(2) });
      else if (g(3) !== undefined) out.push({ t: "b", text: g(3) });
      else if (g(4) !== undefined) out.push({ t: "s", text: g(4) });
      else {
        const [pre, body] = g(6) !== undefined ? [g(5), g(6)] : [g(7), g(8)];
        if (pre) text(pre);
        out.push({ t: "i", text: body });
      }
    }
    at = m.index! + m[0].length;
  }
  if (at < s.length) text(s.slice(at));
  return out;
}

/** A line's spans: its `<…>` pieces first (Slack's links and mentions; Discord's), then the marks in the text between. */
function spansOf(line: string, app: "slack" | "discord", names: Record<string, string>, channels: Record<string, string>): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const m of line.matchAll(/<([^<>\n]{1,600})>/g)) {
    if (m.index! > at) out.push(...inline(line.slice(at, m.index), app));
    out.push(angle(m[1], app, names, channels));
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push(...inline(line.slice(at), app));
  return merge(out);
}

/**
 * A Slack or Discord message's words as blocks the window draws as text: code blocks (```), quotes (lines
 * starting with >), and paragraphs with light marks (bold, italic, struck, inline code, links, and mentions as
 * @name and #channel when their names are known). Nothing in it is ever HTML.
 */
export function chatBlocks(text: string, app: "slack" | "discord", names: Record<string, string> = {}, channels: Record<string, string> = {}): Block[] {
  const blocks: Block[] = [];
  const parts = text.replace(/\r\n?/g, "\n").split("```");
  parts.forEach((part, k) => {
    // Inside a fence (an odd piece, with its closing fence after it): code as it is.
    if (k % 2 === 1 && k < parts.length - 1) {
      let code = app === "slack" ? unescapeSlack(part) : part;
      // Discord's fence may name its language on its first line.
      if (app === "discord") code = code.replace(/^[A-Za-z0-9+#-]{1,20}\n/, "");
      code = code.replace(/^\n/, "").replace(/\n$/, "");
      if (code) blocks.push({ t: "pre", text: code });
      return;
    }
    // A fence never closed: its marks are just text.
    const piece = k % 2 === 1 ? `\`\`\`${part}` : part;
    let lines: string[] = [];
    let mode: "p" | "quote" = "p";
    const flush = () => {
      const s = lines.join("\n").replace(/^\n+|\n+$/g, "");
      if (s) blocks.push({ t: mode, spans: spansOf(s, app, names, channels) });
      lines = [];
    };
    for (const line of piece.split("\n")) {
      const q = /^(?:&gt;|>)\s?(.*)$/.exec(line);
      const now = q ? "quote" : "p";
      if (now !== mode) {
        flush();
        mode = now;
      }
      lines.push(q ? q[1] : line);
    }
    flush();
  });
  return blocks;
}

/** A few of the reactions people use most, as their emoji; any other by its name (":party_parrot:"). */
const EMOJI: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  heart: "❤️",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  eyes: "👀",
  tada: "🎉",
  joy: "😂",
  pray: "🙏",
  fire: "🔥",
  rocket: "🚀",
  raised_hands: "🙌",
  "100": "💯",
  smile: "😄",
  slightly_smiling_face: "🙂",
  ok_hand: "👌",
  clap: "👏",
  thinking_face: "🤔",
  wave: "👋",
  x: "❌",
  warning: "⚠️",
};
export const emojiOf = (name: string) => EMOJI[name.replace(/::skin-tone-\d$/, "")] ?? (/^[\w+-]+$/.test(name) ? `:${name}:` : name);

/** A file's size in a few characters: "820 B", "14 KB", "2.4 MB". */
export function fileSize(n?: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

/** How someone reads in a line: "me" for the user, else their name, else their address. */
export const personName = (p: Person, me = "me") => (p.me ? me : p.name?.trim() || p.email || "Someone");

/** Gmail's folded line of who an email went to: "to me", "to Kevin, me", "to Kevin, +2". */
export function recipientsLine(to: Person[], cc: Person[]): string {
  const all = [...to, ...cc];
  if (!all.length) return "";
  // The user first, as Gmail puts it, then whoever else; two names at most before the count.
  const shown = [...all].sort((a, b) => Number(!!b.me) - Number(!!a.me)).slice(0, all.length > 2 ? 1 : 2);
  const rest = all.length - shown.length;
  return `to ${shown.map((p) => (p.me ? "me" : (p.name?.split(/\s+/)[0] ?? p.email ?? "someone"))).join(", ")}${rest > 0 ? `, +${rest}` : ""}`;
}

/** The letter in someone's round mark. */
export const initialOf = (name?: string, email?: string) => ((name ?? "").trim().match(/[\p{L}\p{N}]/u)?.[0] ?? (email ?? "").trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

/**
 * The newest reply drafted for an issue (its history's "Reply drafted: …" line), unless a reply went after it:
 * the reply box's starting words, and who drafted it.
 */
export function draftedReply(history: readonly { at: number; who?: string; text: string; kind?: string }[] = []): { text: string; who?: string } | undefined {
  const sorted = [...history].sort((a, b) => a.at - b.at);
  let found: { text: string; who?: string } | undefined;
  for (const h of sorted) {
    if (h.kind !== "reply") continue;
    if (h.text.startsWith("Reply drafted: ")) found = { text: h.text.slice("Reply drafted: ".length).trim(), who: h.who };
    else if (h.text.startsWith("Replied: ")) found = undefined;
  }
  return found?.text ? found : undefined;
}
