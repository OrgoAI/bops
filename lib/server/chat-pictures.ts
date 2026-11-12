import "server-only";
import { readFileSync } from "node:fs";
import { safeFetchPicture } from "./safe-fetch";
import { getState } from "./store";
import { uploadPath } from "./uploads";

/**
 * The pictures people put in a chat, for the bot to look at and for a change of files (repo-change.ts change_files):
 * the ones they attached (Message.images on their own messages, never a picture a bot made), numbered 1, 2, 3 in the
 * order they came, and the ones they linked in their own words, fetched through safe-fetch's checks (public addresses
 * only, PNG, JPEG, WebP or GIF, 12 MB at most). A link counts only when a person wrote it in this chat, as someone the
 * bot may act for: never one a bot found on a page, in an email or in an app's answer, nor one from a member the owner
 * hasn't let use the bot's computer (MemberSaid.noUse: their words are information only).
 */

/** A person's own message in a chat, whose words the bot may act on (not a fenced member's). */
const ownWords = (m: { chatId: string; role: string; member?: { noUse?: boolean } }, chatId: string) => m.chatId === chatId && m.role === "user" && !m.member?.noUse;

/** A picture, its bytes in hand. */
export type Picture = { type: string; bytes: Buffer };

/**
 * A picture's size in pixels, from its own header (PNG's IHDR, a JPEG's frame, GIF's screen, WebP's VP8/VP8L/VP8X), or
 * null when it doesn't say: what a change card shows beside the file's size, never trusted for anything else.
 */
export function pixelSize(b: Buffer): { w: number; h: number } | null {
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : null);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR") return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && b.toString("latin1", 0, 4) === "GIF8") return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8 ") return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (kind === "VP8L") {
      const v = b.readUInt32LE(21);
      return ok((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1);
    }
    if (kind === "VP8X") return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // The first start-of-frame marker (C0 to CF but C4, C8 and CC) holds the height, then the width.
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** The pictures people attached in chat `chatId`, oldest first: picture n is the n-th (1 the first). */
export function chatPictures(chatId: string): { id: string; type: string; messageId: string }[] {
  return getState()
    .messages.filter((m) => m.chatId === chatId && m.role === "user" && m.images?.length)
    .flatMap((m) => m.images!.map((i) => ({ id: i.id, type: i.type, messageId: m.id })));
}

/** An attached picture's bytes, from this computer's uploads; null when it isn't here (sent from another Mac). */
export function uploadBytes(upId: string): Picture | null {
  const f = uploadPath(upId);
  return f ? { type: f.type, bytes: readFileSync(/*turbopackIgnore: true*/ f.path) } : null;
}

/** The links in someone's words, as they wrote them (a sentence's last full stop or comma isn't part of one). */
export const linksIn = (text: string) => [...text.matchAll(/https?:\/\/[^\s<>"'`]+/g)].map((m) => m[0].replace(/[.,;:!?)\]]+$/, ""));

/** Whether `url` is a link a person wrote in chat `chatId` (their own message's words). */
export const linkedByPerson = (chatId: string, url: string) => getState().messages.some((m) => ownWords(m, chatId) && linksIn(m.text ?? "").includes(url));

/** Each link's picture (or why not) for a while, so the turn that looks at it and the change that uses it get the same bytes. */
const CACHE_MS = 15 * 60_000;
const g = globalThis as unknown as { bopsLinkedPictures?: Map<string, { at: number; got: Promise<Picture> }> };
const cache = (g.bopsLinkedPictures ??= new Map());

/** The picture at a link a person wrote, fetched once a while (CACHE_MS). Throws in plain words when it can't be had. */
export function linkedPicture(url: string, timeoutMs?: number): Promise<Picture> {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  const had = cache.get(url);
  if (had) return had.got;
  const got = safeFetchPicture(url, { timeoutMs }).then((r) => ({ type: r.type, bytes: r.bytes }));
  const entry = { at: now, got };
  cache.set(url, entry);
  // A link that isn't one, or can't be had, is kept a minute only: a later turn tries again.
  got.catch(() => void (entry.at = now - CACHE_MS + 60_000));
  return got;
}

/** A link that names a picture file (".../logo.png", "...photo_n.jpg?stp=..."): the ones a turn looks at by itself. */
const PICTURE_LINK = /\.(png|jpe?g|webp|gif)$/i;
const namesPicture = (url: string) => {
  try {
    return PICTURE_LINK.test(new URL(url).pathname);
  } catch {
    return false;
  }
};
/** How many of a person's newest messages a turn shows linked pictures for, the links in each at most, and how long it waits for one. */
const LOOKED_AT = 3;
const LINKS_EACH = 3;
const LOOK_MS = 10_000;
/**
 * The most of the linked pictures a turn shows the model, together (their bytes; as data URLs, 4/3 of it): the newest
 * links first, one past it left out. A turn's request goes through Bops Cloud's proxy, 25 MB at most (cloud/proxy.ts),
 * beside the pictures people attached; a picture is still the bot's to put in a change (change_files' imageUrl).
 */
const LOOK_BYTES = 6 * 1024 * 1024;

/**
 * The pictures behind the picture links (namesPicture) in a person's newest messages in chat `chatId`, by link, as data
 * URLs the model can look at: the newest message's fetched now (LOOK_MS at most), the ones before only as already had,
 * LOOK_BYTES at most in all. A link that isn't a picture, or can't be had, is left out. Any other link is the bot's to read (web_fetch) or to put in
 * a change (change_files' imageUrl), never fetched on every turn.
 */
export async function linkedPictures(chatId: string): Promise<Map<string, string>> {
  const said = getState()
    .messages.filter((m) => ownWords(m, chatId) && m.text)
    .slice(-LOOKED_AT);
  const links = (m: { text: string } | undefined) => (m ? linksIn(m.text).filter(namesPicture).slice(0, LINKS_EACH) : []);
  const now = new Set(links(said.at(-1)));
  const all = [...new Set(said.flatMap(links))].filter((u) => now.has(u) || cache.has(u));
  const got = new Map<string, Picture>();
  await Promise.all(
    all.map((url) =>
      linkedPicture(url, LOOK_MS).then(
        (p) => void got.set(url, p),
        () => {},
      ),
    ),
  );
  const out = new Map<string, string>();
  let bytes = 0;
  for (const url of [...all].reverse()) {
    const p = got.get(url);
    if (!p || bytes + p.bytes.length > LOOK_BYTES) continue;
    bytes += p.bytes.length;
    out.set(url, `data:${p.type};base64,${p.bytes.toString("base64")}`);
  }
  return out;
}
