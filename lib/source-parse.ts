import type { ChatMessage, MailMessage, MailReply, Person, SourceFile } from "./source-view";

/*
 * What Gmail, Slack and Discord answer (through Composio) made into what the window shows (lib/source-view.ts),
 * and where an issue's thread is from its id and link. All of it plain text: an email's HTML becomes text here,
 * its scripts, styles, images and hidden parts dropped, its links kept as "label (address)", its quoted history
 * set apart. lib/server/issue-source.ts reads; this only parses, and touches nothing.
 */

/* ---------------- Where it is ---------------- */

/** A Gmail thread's id (hex, as the Gmail API has it) from an issue's id there, or the thread's address ("#inbox/<id>"). */
export function gmailThreadIdOf(externalId?: string, url?: string): string | undefined {
  const id = (externalId ?? "").trim().replace(/^(?:thread-f:|msg-f:|thread:|gmail:)/i, "");
  if (/^[0-9a-f]{10,24}$/i.test(id)) return id.toLowerCase();
  const fromUrl = /^https:\/\/mail\.google\.com\/mail\/.*#[^/?]+\/(?:[^/?]+\/)?([0-9a-f]{10,24})(?:[/?]|$)/i.exec((url ?? "").trim())?.[1];
  return fromUrl?.toLowerCase();
}

const SLACK_CHANNEL = /(?:^|[^A-Za-z0-9])([CGD][A-Z0-9]{6,14})(?![A-Za-z0-9])/;
const SLACK_TS = /(?:^|[^\d.])(\d{9,11}\.\d{6})(?![\d.])/;

/**
 * A Slack thread from an issue's id and link: "C0123ABCD/1700000000.000100", "C0123ABCD:1700…", a permalink
 * (".../archives/C0123ABCD/p1700000000000100", with ?thread_ts= when it's a reply), or a ts alone with the
 * channel in the link. What can't be told is left out (a ts and no channel: no thread to read).
 */
export function slackRefOf(externalId?: string, url?: string): { channel?: string; ts?: string } {
  for (const s of [externalId, url]) {
    const link = /\/archives\/([CGD][A-Z0-9]{6,14})\/p(\d{10})(\d{6})/.exec(s ?? "");
    if (link) return { channel: link[1], ts: /[?&]thread_ts=(\d{9,11}\.\d{6})/.exec(s ?? "")?.[1] ?? `${link[2]}.${link[3]}` };
  }
  const id = (externalId ?? "").trim();
  const channel = SLACK_CHANNEL.exec(id)?.[1] ?? /\/archives\/([CGD][A-Z0-9]{6,14})(?:[/?]|$)/.exec(url ?? "")?.[1];
  const ts = SLACK_TS.exec(id)?.[1];
  return { ...(channel ? { channel } : {}), ...(ts ? { ts } : {}) };
}

/** A Discord channel (a thread is one too) and the message, from an issue's link (".../channels/<server>/<channel>/<message>") or its id ("<channel>/<message>", or a channel's alone). */
export function discordRefOf(externalId?: string, url?: string): { channel?: string; message?: string } {
  const link = /discord(?:app)?\.com\/channels\/(?:\d{15,21}|@me)\/(\d{15,21})(?:\/(\d{15,21}))?/.exec(url ?? "") ?? /discord(?:app)?\.com\/channels\/(?:\d{15,21}|@me)\/(\d{15,21})(?:\/(\d{15,21}))?/.exec(externalId ?? "");
  if (link) return { channel: link[1], ...(link[2] ? { message: link[2] } : {}) };
  const ids = (externalId ?? "").match(/\d{15,21}/g) ?? [];
  if (ids.length >= 2) return { channel: ids[0], message: ids[1] };
  return ids.length ? { channel: ids[0] } : {};
}

/* ---------------- HTML, as text ---------------- */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: String.fromCharCode(0x2014),
  ndash: String.fromCharCode(0x2013),
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  rarr: "→",
  larr: "←",
};

/** HTML's character references (&amp;, &#39;, &#x2019;) as the characters they are. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (all, ref: string) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    const named = NAMED[ref.toLowerCase()];
    return named !== undefined && (all.endsWith(";") || ref.length <= 4) ? named : all;
  });
}

/** Marks where an email's quoted history begins in its text (a Gmail quote block, a blockquote): splitQuoted folds from there. */
export const QUOTE_MARK = String.fromCharCode(0xe000);

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** What starts on its own line. */
const BLOCK = new Set(["address", "article", "aside", "center", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "header", "li", "main", "nav", "ol", "section", "table", "tbody", "thead", "tfoot", "tr", "ul"]);
/** What has a blank line around it. */
const PARA = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"]);
/** What says nothing (and whatever is in it). */
const DROP = /<(script|style|head|title|noscript|template|svg|math|object|iframe|frame|frameset|canvas|video|audio|map|select|textarea|button|xml)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;

const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
};
const isQuoteRoot = (tag: string, attrs: string) =>
  tag === "blockquote" ||
  (tag === "div" && (/\b(gmail_quote|yahoo_quoted|moz-cite-prefix|protonmail_quote)\b/i.test(attr(attrs, "class") ?? "") || /^(divRplyFwdMsg|appendonsend)$/i.test(attr(attrs, "id") ?? "")));
const hidden = (attrs: string) => /display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0|mso-hide\s*:\s*all/i.test(attr(attrs, "style") ?? "") || /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs);

/**
 * An email's HTML as plain text, for the window to show as text (it never renders the HTML): scripts, styles,
 * images and hidden parts dropped; paragraphs, line breaks, rows and list items kept as lines; a link as its
 * words and its address, "label (https://...)" (just the address when that's its words; nothing when it has no
 * words, a linked logo). The first quote block (Gmail's, a blockquote, Outlook's reply header) starts with
 * QUOTE_MARK, for splitQuoted.
 */
export function htmlToText(html: string): string {
  const src = html.replace(DROP, " ");
  let out = "";
  type Open = { tag: string; hide?: boolean; quote?: boolean; href?: string; at?: number };
  const stack: Open[] = [];
  let hide = 0;
  let pre = 0;
  let quoted = false;
  const nl = (n = 1) => {
    out = out.replace(/[ \t]+$/, "");
    const have = /\n*$/.exec(out)![0].length;
    if (out && have < n) out += "\n".repeat(n - have);
  };
  const close = (o: Open) => {
    if (o.hide) hide--;
    if (o.tag === "pre") pre--;
    if (hide) return;
    if (o.tag === "a" && o.at !== undefined) {
      const label = out.slice(o.at).replace(/\s+/g, " ").trim();
      const href = o.href && /^(?:https?:\/\/|mailto:)/i.test(o.href) ? o.href.trim() : undefined;
      if (!label) out = out.slice(0, o.at);
      else if (href) {
        const bare = href.replace(/^mailto:/i, "").replace(/\/$/, "");
        const short = bare.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
        if (label.replace(/\/$/, "") !== bare && !label.includes(bare) && !label.includes(short)) out += ` (${href.replace(/^mailto:/i, "")})`;
      }
    }
    if (PARA.has(o.tag)) nl(2);
    else if (BLOCK.has(o.tag)) nl(1);
    else if (o.tag === "td" || o.tag === "th") out += "  ";
  };
  for (const m of src.matchAll(TAG)) {
    const token = m[0];
    if (token.startsWith("<!") || token.startsWith("<?")) continue;
    const tag = m[2]?.toLowerCase();
    if (!tag) {
      if (hide) continue;
      const text = decodeEntities(token === "<" ? "<" : token);
      out += pre ? text : text.replace(/\s+/g, " ");
      continue;
    }
    const attrs = m[3] ?? "";
    if (m[1]) {
      // A closing tag: what's open down to it closes (one that was never opened is nothing).
      const k = stack.map((o) => o.tag).lastIndexOf(tag);
      if (k < 0) continue;
      for (const o of stack.splice(k).reverse()) close(o);
      continue;
    }
    const selfClosing = /\/\s*$/.test(attrs);
    if (tag === "br") {
      if (!hide) out += "\n";
      continue;
    }
    if (tag === "hr") {
      if (!hide) nl(2);
      continue;
    }
    if (VOID.has(tag) || selfClosing) continue;
    const o: Open = { tag };
    if (hidden(attrs)) {
      o.hide = true;
      hide++;
    }
    if (!hide) {
      if (!quoted && isQuoteRoot(tag, attrs)) {
        quoted = true;
        nl(2);
        out += `${QUOTE_MARK}\n`;
      }
      if (PARA.has(tag)) nl(2);
      else if (BLOCK.has(tag)) nl(1);
      if (tag === "li") out += "• ";
      if (tag === "a") {
        o.href = attr(attrs, "href");
        o.at = out.length;
      }
    }
    if (tag === "pre") pre++;
    stack.push(o);
  }
  for (const o of stack.reverse()) close(o);
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t ]+$/g, "").replace(/^[ \t ]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Whether an email's text is HTML (some come as only that). */
export const looksHtml = (s: string) => /<(?:html|body|div|p|br|table|span|a|font|td|blockquote)\b[^>]*>/i.test(s);

/* ---------------- Quoted history ---------------- */

const WROTE = /^(?:On|Am|Le|El|Il|Op|Em)\s.{4,300}\s(?:wrote|schrieb|a écrit|escribió|ha scritto|scritto|schreef|escreveu)\s?:\s*$/i;

/**
 * An email's own words and the quoted history under them: from its quote mark (htmlToText), else from an
 * "On … wrote:" line (on one line or two), a "Original Message" line, Outlook's From: and Sent: header, or
 * the run of "> " lines it ends with. None when it's all quote (a forward with nothing added keeps it all).
 */
export function splitQuoted(text: string): { body: string; quoted?: string } {
  const t = text.replace(/\r\n?/g, "\n");
  const lines = t.split("\n");
  let at = lines.findIndex((l) => l.includes(QUOTE_MARK));
  if (at < 0)
    at = lines.findIndex(
      (l, i) =>
        WROTE.test(l.trim()) ||
        (/^(?:On|Am|Le|El|Il|Op|Em)\s/.test(l.trim()) && i + 1 < lines.length && WROTE.test(`${l.trim()} ${lines[i + 1].trim()}`)) ||
        /^-{2,}\s*Original Message\s*-{2,}$/i.test(l.trim()) ||
        (/^From:\s+\S/.test(l.trim()) && lines.slice(i + 1, i + 5).some((x) => /^(?:Sent|Date):\s+\S/.test(x.trim())) && lines.slice(i + 1, i + 6).some((x) => /^(?:To|Subject):\s/.test(x.trim()))),
    );
  if (at < 0) {
    // The ">" lines it ends with.
    let k = lines.length - 1;
    while (k >= 0 && !lines[k].trim()) k--;
    let first = -1;
    while (k >= 0 && (/^\s*>/.test(lines[k]) || !lines[k].trim())) {
      if (/^\s*>/.test(lines[k])) first = k;
      k--;
    }
    at = first;
  }
  const clean = (s: string) => s.replaceAll(QUOTE_MARK, "").replace(/\n{3,}/g, "\n\n").trim();
  if (at < 0) return { body: clean(t) };
  const body = clean(lines.slice(0, at).join("\n"));
  const quoted = clean(lines.slice(at).join("\n"));
  if (!body) return { body: clean(t) };
  return quoted ? { body, quoted } : { body };
}

/* ---------------- Gmail ---------------- */

type Part = { mimeType?: string; filename?: string; headers?: { name?: string; value?: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
type GmailMessage = {
  id?: string;
  messageId?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string | number;
  messageTimestamp?: string;
  sender?: string;
  to?: string;
  subject?: string;
  messageText?: string;
  preview?: { body?: string; subject?: string };
  payload?: Part;
  attachmentList?: { filename?: string; name?: string; mimeType?: string; size?: number; attachmentId?: string }[];
};

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** The people in an address header ("Kevin Example <kevin@example.com>, ava@example.org"), addresses lowercased. */
export function addressesOf(header?: string | string[]): Person[] {
  const s = Array.isArray(header) ? header.join(", ") : (header ?? "");
  const out: Person[] = [];
  // Split on commas outside quotes and angle brackets.
  let cur = "";
  let q = false;
  let angleOpen = false;
  const parts: string[] = [];
  for (const c of s) {
    if (c === '"') q = !q;
    if (!q && c === "<") angleOpen = true;
    if (!q && c === ">") angleOpen = false;
    if ((c === "," || c === ";") && !q && !angleOpen) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(p);
    if (m) {
      const name = m[1].trim().replace(/^"|"$/g, "").replace(/\\"/g, '"').trim();
      out.push({ ...(name && name.toLowerCase() !== m[2].toLowerCase() ? { name: name.slice(0, 120) } : {}), email: m[2].toLowerCase() });
    } else if (EMAIL.test(p)) out.push({ email: p.toLowerCase() });
    else if (p.length <= 120) out.push({ name: p.replace(/^"|"$/g, "") });
  }
  return out.slice(0, 100);
}

/** A part's base64url data as text, in its charset (UTF-8 when it says none, or one this can't read). */
function decodeData(data: string, charset?: string): string {
  try {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    try {
      return new TextDecoder(charset || "utf-8").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  } catch {
    return "";
  }
}

const headerOf = (p: Part | undefined, name: string) => p?.headers?.find((h) => h.name?.toLowerCase() === name)?.value;
const partsOf = (p: Part | undefined, depth = 0): Part[] => (!p || depth > 12 ? [] : [p, ...(p.parts ?? []).flatMap((x) => partsOf(x, depth + 1))]);
const isAttachment = (p: Part) => !!p.filename || /^attachment/i.test(headerOf(p, "content-disposition") ?? "");
const charsetOf = (p: Part) => /charset="?([A-Za-z0-9_.:-]+)"?/i.exec(headerOf(p, "content-type") ?? "")?.[1];

/** What an email says, as text: its text/plain part, else its HTML made text, else what Composio extracted. */
function textOf(m: GmailMessage): string {
  const parts = partsOf(m.payload).filter((p) => !isAttachment(p) && p.body?.data);
  const plain = parts.find((p) => p.mimeType?.toLowerCase() === "text/plain");
  if (plain) {
    const t = decodeData(plain.body!.data!, charsetOf(plain));
    if (t.trim()) return looksHtml(t) ? htmlToText(t) : t;
  }
  const html = parts.find((p) => p.mimeType?.toLowerCase() === "text/html");
  if (html) return htmlToText(decodeData(html.body!.data!, charsetOf(html)));
  const extracted = typeof m.messageText === "string" ? m.messageText : "";
  return looksHtml(extracted) ? htmlToText(extracted) : extracted;
}

/** Its files, by name and size: the attachments, not the pictures shown in its words. */
function filesOf(m: GmailMessage): SourceFile[] {
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined, size?: number, type?: string) => {
    const n = (name ?? "").trim();
    if (!n || seen.has(n) || out.length >= 50) return;
    seen.add(n);
    out.push({ name: n.slice(0, 200), ...(typeof size === "number" && size >= 0 ? { size } : {}), ...(type ? { type } : {}) });
  };
  const parts = partsOf(m.payload);
  for (const p of parts) {
    if (!p.filename) continue;
    const inline = /^inline/i.test(headerOf(p, "content-disposition") ?? "") && !!headerOf(p, "content-id") && /^image\//i.test(p.mimeType ?? "");
    if (!inline) add(p.filename, p.body?.size, p.mimeType);
  }
  for (const a of m.attachmentList ?? []) {
    const name = a?.filename ?? a?.name;
    const part = parts.find((p) => p.filename === name);
    if (part && /^inline/i.test(headerOf(part, "content-disposition") ?? "") && headerOf(part, "content-id")) continue;
    add(name, a?.size ?? part?.body?.size, a?.mimeType);
  }
  return out;
}

const MAX_TEXT = 100_000;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Where a Composio answer keeps its messages (its own data, or the app's under response_data). */
export const messagesIn = (data: unknown): unknown[] => {
  const d = (data ?? {}) as Record<string, unknown>;
  for (const x of [d, d.response_data, d.data] as Record<string, unknown>[]) if (Array.isArray(x?.messages)) return x.messages;
  return Array.isArray(data) ? data : [];
};

/**
 * A Gmail thread as Composio's GMAIL_FETCH_MESSAGE_BY_THREAD_ID answers it: its messages oldest first (drafts
 * left out), each with who, when, its words as text and the quoted history apart, and its files. `me`: the
 * user's own addresses (the account's), to which the sender of each message they sent (SENT) is added.
 */
export function parseGmailThread(data: unknown, me: Iterable<string> = []): { subject: string; messages: MailMessage[] } {
  const raw = messagesIn(data).filter((m): m is GmailMessage => !!m && typeof m === "object") as GmailMessage[];
  const mine = new Set([...me].map((x) => x.toLowerCase()));
  const kept = raw.filter((m) => !(m.labelIds ?? []).includes("DRAFT"));
  for (const m of kept) if ((m.labelIds ?? []).includes("SENT")) for (const p of addressesOf(headerOf(m.payload, "from") ?? m.sender)) if (p.email) mine.add(p.email);
  const mark = (ps: Person[]) => ps.map((p) => (p.email && mine.has(p.email) ? { ...p, me: true } : p));
  let subject = "";
  const messages: MailMessage[] = kept.map((m, k) => {
    const from = mark(addressesOf(headerOf(m.payload, "from") ?? m.sender))[0] ?? {};
    const at = Number(m.internalDate) || Date.parse(m.messageTimestamp ?? "") || Date.parse(headerOf(m.payload, "date") ?? "") || undefined;
    const s = headerOf(m.payload, "subject") ?? m.subject ?? m.preview?.subject;
    if (s?.trim() && !subject) subject = oneLine(s).slice(0, 300);
    const split = splitQuoted(textOf(m).slice(0, MAX_TEXT));
    const snippet = oneLine(decodeEntities(m.snippet ?? m.preview?.body ?? "")) || oneLine(split.body).slice(0, 200);
    const replyTo = mark(addressesOf(headerOf(m.payload, "reply-to")));
    return {
      id: String(m.messageId ?? m.id ?? `m${k}`),
      from,
      to: mark(addressesOf(headerOf(m.payload, "to") ?? m.to)),
      cc: mark(addressesOf(headerOf(m.payload, "cc"))),
      ...(replyTo.length ? { replyTo } : {}),
      ...(at ? { at } : {}),
      snippet: snippet.slice(0, 300),
      body: split.body,
      ...(split.quoted ? { quoted: split.quoted } : {}),
      files: filesOf(m),
      ...(from.me || (m.labelIds ?? []).includes("SENT") ? { mine: true } : {}),
    };
  });
  messages.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { subject, messages };
}

/**
 * Who a reply goes to: the sender of the newest message that isn't the user's (its Reply-To when it has one),
 * and for Reply all, the others it went to and was copied to, never the user. With only the user's own
 * messages, the first person the newest went to. None when no one has an address.
 */
export function gmailReply(messages: MailMessage[]): MailReply | undefined {
  const theirs = [...messages].reverse().find((m) => !m.mine && !m.from.me);
  if (!theirs) {
    const last = messages.at(-1);
    const to = last?.to.find((p) => p.email && !p.me);
    return to ? { to, all: { to: [], cc: [] } } : undefined;
  }
  const primary = theirs.replyTo?.find((p) => p.email && !p.me) ?? (theirs.from.email && !theirs.from.me ? theirs.from : undefined);
  if (!primary?.email) return undefined;
  const seen = new Set([primary.email]);
  const others = (ps: Person[]) => ps.filter((p) => p.email && !p.me && !seen.has(p.email) && !!seen.add(p.email));
  return { to: primary, all: { to: others(theirs.to), cc: others(theirs.cc) } };
}

/* ---------------- Slack ---------------- */

type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
  text?: string;
  user_profile?: { display_name?: string; real_name?: string };
  bot_profile?: { name?: string };
  reactions?: { name?: string; count?: number; users?: string[] }[];
  files?: { name?: string; title?: string; size?: number; mimetype?: string }[];
  attachments?: { fallback?: string; text?: string; pretext?: string; title?: string }[];
  edited?: unknown;
};

/** The ids of the people in a Slack thread: who wrote, and who's mentioned (<@U…>). */
export function slackUserIds(data: unknown): string[] {
  const ids = new Set<string>();
  for (const m of messagesIn(data) as SlackMessage[]) {
    if (m?.user && /^[UW][A-Z0-9]+$/.test(m.user)) ids.add(m.user);
    for (const x of (m?.text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(x[1]);
  }
  return [...ids];
}

/** The first message in a Slack answer (to tell a reply's ts from its thread's). */
export const slackFirst = (data: unknown) => (messagesIn(data)[0] ?? undefined) as SlackMessage | undefined;
export const slackMessagesIn = (data: unknown) => messagesIn(data) as SlackMessage[];

/** A Slack thread as SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION answers it, oldest first; `names`: people's names by id. */
export function parseSlackMessages(data: unknown, names: Record<string, string> = {}): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const m of messagesIn(data) as SlackMessage[]) {
    if (!m || typeof m !== "object" || !m.ts || seen.has(m.ts)) continue;
    if (m.subtype === "channel_join" || m.subtype === "channel_leave" || m.subtype === "group_join") continue;
    seen.add(m.ts);
    const name = (m.user && names[m.user]) || m.user_profile?.display_name || m.user_profile?.real_name || m.username || m.bot_profile?.name || m.user || "Someone";
    let text = typeof m.text === "string" ? m.text : "";
    if (!text.trim()) text = (m.attachments ?? []).map((a) => a?.fallback || a?.text || a?.pretext || a?.title || "").filter(Boolean).join("\n");
    const at = Math.round(Number(m.ts) * 1000);
    out.push({
      id: m.ts,
      user: { ...(m.user ? { id: m.user } : {}), name: String(name).slice(0, 80), ...(m.bot_id && !m.user ? { bot: true } : {}) },
      ...(Number.isFinite(at) ? { at } : {}),
      text: text.slice(0, 40_000),
      reactions: (m.reactions ?? []).filter((r) => r?.name).map((r) => ({ name: String(r.name), count: r.count ?? r.users?.length ?? 1 })),
      files: (m.files ?? []).map((f) => ({ name: String(f?.name || f?.title || "File").slice(0, 200), ...(typeof f?.size === "number" ? { size: f.size } : {}), ...(f?.mimetype ? { type: f.mimetype } : {}) })),
      ...(m.edited ? { edited: true } : {}),
    });
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/* ---------------- Discord ---------------- */

type DiscordUser = { id?: string; username?: string; global_name?: string | null; bot?: boolean };
type DiscordMessage = {
  id?: string;
  author?: DiscordUser;
  member?: { nick?: string | null };
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  mentions?: DiscordUser[];
  reactions?: { count?: number; emoji?: { name?: string | null } }[];
  attachments?: { filename?: string; size?: number; content_type?: string }[];
  embeds?: { title?: string; description?: string }[];
};

/** A Discord channel's messages as DISCORDBOT_LIST_MESSAGES answers them (newest first there), oldest first; and the names of who wrote and who's mentioned. */
export function parseDiscordMessages(data: unknown): { messages: ChatMessage[]; names: Record<string, string> } {
  const names: Record<string, string> = {};
  const nameOf = (u?: DiscordUser) => (u?.global_name || u?.username || "Someone").slice(0, 80);
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const m of messagesIn(data) as DiscordMessage[]) {
    if (!m || typeof m !== "object" || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    for (const u of m.mentions ?? []) if (u?.id) names[u.id] = nameOf(u);
    if (m.author?.id) names[m.author.id] = m.member?.nick || nameOf(m.author);
    let text = typeof m.content === "string" ? m.content : "";
    if (!text.trim()) text = (m.embeds ?? []).map((e) => [e?.title, e?.description].filter(Boolean).join("\n")).filter(Boolean).join("\n");
    const at = Date.parse(m.timestamp ?? "");
    out.push({
      id: m.id,
      user: { ...(m.author?.id ? { id: m.author.id } : {}), name: (m.member?.nick || nameOf(m.author)).slice(0, 80), ...(m.author?.bot ? { bot: true } : {}) },
      ...(Number.isFinite(at) ? { at } : {}),
      text: text.slice(0, 40_000),
      reactions: (m.reactions ?? []).filter((r) => r?.emoji?.name).map((r) => ({ name: String(r.emoji!.name), count: r.count ?? 1 })),
      files: (m.attachments ?? []).map((a) => ({ name: String(a?.filename || "File").slice(0, 200), ...(typeof a?.size === "number" ? { size: a.size } : {}), ...(a?.content_type ? { type: a.content_type } : {}) })),
      ...(m.edited_timestamp ? { edited: true } : {}),
    });
  }
  return { messages: out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), names };
}
