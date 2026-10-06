import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id } from "./store";

/**
 * Images the user attaches in chat, kept on this Mac (.data/uploads). Messages refer to them by id; the
 * page shows them from /api/uploads/<id>, and bots see them as images (dataUrlOf).
 */
const DIR = join(process.cwd(), ".data", "uploads");
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_BYTES = 12 * 1024 * 1024;

/** Save an image sent as a data URL (data:image/png;base64,…). Returns its id. */
export function saveUpload(dataUrl: string) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m || !TYPES[m[1].toLowerCase()]) throw new Error("only PNG, JPEG, WebP or GIF images");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_BYTES) throw new Error("that image is too big (12 MB at most)");
  mkdirSync(DIR, { recursive: true });
  const upId = id("img");
  writeFileSync(join(DIR, `${upId}.${TYPES[m[1].toLowerCase()]}`), buf);
  return { id: upId, type: m[1].toLowerCase() };
}

/** An upload's file on disk, if it exists (ids are only letters, digits and _). */
export function uploadPath(upId: string) {
  if (!/^img_[a-z0-9]+$/i.test(upId)) return null;
  for (const [type, ext] of Object.entries(TYPES)) {
    const p = join(DIR, `${upId}.${ext}`);
    if (existsSync(p)) return { path: p, type };
  }
  return null;
}

/** An upload as a data URL, for a model to see. */
export function dataUrlOf(upId: string) {
  const f = uploadPath(upId);
  return f ? `data:${f.type};base64,${readFileSync(f.path).toString("base64")}` : null;
}
