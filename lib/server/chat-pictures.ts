import "server-only";
import { readFileSync } from "node:fs";
import { safeFetchPicture } from "./safe-fetch";
import { getState } from "./store";
import { uploadPath } from "./uploads";

/**
 * The pictures people put in a chat, for the bot to look at and for a change of files (repo-change.ts change_files):
 * the ones they attached (Message.images on their own messages, never a picture a bot made), numbered 1, 2, 3 in the
 * order they came, and the ones they linked in their own words, fetched through safe-fetch's checks (public addresses
 * only, PNG, JPEG, WebP or GIF, 12 MB at most). A link counts only when a person wrote it in this chat: never one a
 * bot found on a page, in an email or in an app's answer.
 */

/** A picture, its bytes in hand. */
export type Picture = { type: string; bytes: Buffer };

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
export const linkedByPerson = (chatId: string, url: string) => getState().messages.some((m) => m.chatId === chatId && m.role === "user" && linksIn(m.text ?? "").includes(url));

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
 * The pictures behind the picture links (namesPicture) in a person's newest messages in chat `chatId`, by link, as data
 * URLs the model can look at: the newest message's fetched now (LOOK_MS at most), the ones before only as already had.
 * A link that isn't a picture, or can't be had, is left out. Any other link is the bot's to read (web_fetch) or to put in
 * a change (change_files' imageUrl), never fetched on every turn.
 */
export async function linkedPictures(chatId: string): Promise<Map<string, string>> {
  const said = getState()
    .messages.filter((m) => m.chatId === chatId && m.role === "user" && m.text)
    .slice(-LOOKED_AT);
  const links = (m: { text: string } | undefined) => (m ? linksIn(m.text).filter(namesPicture).slice(0, LINKS_EACH) : []);
  const now = new Set(links(said.at(-1)));
  const all = [...new Set(said.flatMap(links))].filter((u) => now.has(u) || cache.has(u));
  const out = new Map<string, string>();
  await Promise.all(
    all.map((url) =>
      linkedPicture(url, LOOK_MS).then(
        (p) => void out.set(url, `data:${p.type};base64,${p.bytes.toString("base64")}`),
        () => {},
      ),
    ),
  );
  return out;
}
