import "server-only";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id, userDir } from "./store";

/**
 * Images the user attaches in chat, kept on this Mac in the signed-in user's folder
 * (.data/users/<id>/uploads): another account signed in here can't open them. Messages refer to them
 * by id; the page shows them from /api/uploads/<id>, and bots see them as images (dataUrlOf).
 */
export const uploadsDir = () => {
  const dir = userDir();
  return dir ? join(dir, "uploads") : null;
};
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_BYTES = 12 * 1024 * 1024;

/** Save an image sent as a data URL (data:image/png;base64,…). Returns its id. */
export function saveUpload(dataUrl: string) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m || !TYPES[m[1].toLowerCase()]) throw new Error("only PNG, JPEG, WebP or GIF images");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_BYTES) throw new Error("that image is too big (12 MB at most)");
  const DIR = uploadsDir();
  if (!DIR) throw new Error("sign in to Bops first");
  mkdirSync(DIR, { recursive: true });
  const upId = id("img");
  writeFileSync(join(/*turbopackIgnore: true*/ DIR, `${upId}.${TYPES[m[1].toLowerCase()]}`), buf);
  return { id: upId, type: m[1].toLowerCase() };
}

/** A change card's copy of a picture someone linked (keepCopy): named by its bytes, so the same picture is one file. */
export const COPY_ID = /^img_c[0-9a-f]{32}$/;

/**
 * Keep a copy of a picture a change card shows (lib/server/repo-change.ts: one someone linked in a chat), for its
 * thumbnail and the yes. The same picture asked for again is the same copy, made fresh. Copies older than `olderMs` that
 * nothing uses (`kept`: what messages show, and waiting cards) go first: a card that never got an answer leaves none
 * behind for long. Returns its id.
 */
export function keepCopy(type: string, bytes: Buffer, sweep: { kept: Set<string>; olderMs: number }): string {
  const ext = TYPES[type];
  if (!ext) throw new Error("only PNG, JPEG, WebP or GIF images");
  if (bytes.length > MAX_BYTES) throw new Error("that image is too big (12 MB at most)");
  const DIR = uploadsDir();
  if (!DIR) throw new Error("sign in to Bops first");
  mkdirSync(DIR, { recursive: true });
  const now = Date.now();
  for (const name of readdirSync(/*turbopackIgnore: true*/ DIR)) {
    const upId = name.replace(/\.[a-z]+$/, "");
    if (!COPY_ID.test(upId) || sweep.kept.has(upId)) continue;
    const at = join(/*turbopackIgnore: true*/ DIR, name);
    try {
      if (now - statSync(/*turbopackIgnore: true*/ at).mtimeMs > sweep.olderMs) rmSync(/*turbopackIgnore: true*/ at, { force: true });
    } catch {
      // Gone meanwhile: nothing to do.
    }
  }
  const upId = `img_c${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
  const at = join(/*turbopackIgnore: true*/ DIR, `${upId}.${ext}`);
  if (existsSync(/*turbopackIgnore: true*/ at)) utimesSync(/*turbopackIgnore: true*/ at, new Date(now), new Date(now));
  else writeFileSync(/*turbopackIgnore: true*/ at, bytes);
  return upId;
}

/** An upload's file on disk, if it exists (ids are only letters, digits and _). */
export function uploadPath(upId: string) {
  const DIR = uploadsDir();
  if (!DIR || !/^img_[a-z0-9]+$/i.test(upId)) return null;
  for (const [type, ext] of Object.entries(TYPES)) {
    const p = join(/*turbopackIgnore: true*/ DIR, `${upId}.${ext}`);
    if (existsSync(/*turbopackIgnore: true*/ p)) return { path: p, type };
  }
  return null;
}

/** An upload as a data URL, for a model to see. */
export function dataUrlOf(upId: string) {
  const f = uploadPath(upId);
  return f ? `data:${f.type};base64,${readFileSync(/*turbopackIgnore: true*/ f.path).toString("base64")}` : null;
}

/**
 * Delete images from this Mac (their messages went for good: lib/server/remove.ts), but never one a message
 * still in the chats shows (`kept`: their ids). How many went.
 */
export function dropUploads(ids: Iterable<string>, kept: Set<string>): number {
  let n = 0;
  for (const upId of ids) {
    if (kept.has(upId)) continue;
    const f = uploadPath(upId);
    if (!f) continue;
    rmSync(/*turbopackIgnore: true*/ f.path, { force: true });
    n++;
  }
  return n;
}
