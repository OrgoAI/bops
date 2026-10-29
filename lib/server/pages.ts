import "server-only";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id, userDir } from "./store";

/**
 * Pages bots make: a single-file HTML explanation ("explain in HTML"), kept in the signed-in user's
 * folder on this Mac (.data/users/<id>/pages) and opened in a Bops tab. Written by a model, so
 * they're served locked down (see the pages route).
 */
export const pagesDir = () => {
  const dir = userDir();
  return dir ? join(dir, "pages") : null;
};

export function savePage(title: string, html: string) {
  const DIR = pagesDir();
  if (!DIR) throw new Error("Sign in to Bops first.");
  mkdirSync(DIR, { recursive: true });
  const pageId = id("page");
  const doc = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<>&"]/g, "")}</title></head><body>${html}</body></html>`;
  writeFileSync(join(DIR, `${pageId}.html`), doc.slice(0, 400_000));
  return pageId;
}

export function readPage(pageId: string) {
  const DIR = pagesDir();
  if (!DIR || !/^page_[a-z0-9]+$/i.test(pageId)) return null;
  const file = join(DIR, `${pageId}.html`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** Where a page is on this Mac (null: no such page, or not one Bops named). */
export function pagePath(pageId: string) {
  const DIR = pagesDir();
  if (!DIR || !/^page_[a-z0-9]+$/i.test(pageId)) return null;
  const file = join(/*turbopackIgnore: true*/ DIR, `${pageId}.html`);
  return existsSync(/*turbopackIgnore: true*/ file) ? file : null;
}

/**
 * The pages of a delete that nothing left links to (`kept`: lib/privacy.ts inUse), off this Mac, as uploads.ts
 * dropUploads does for images. How many went.
 */
export function dropPages(ids: Iterable<string>, kept: ReadonlySet<string>): number {
  let n = 0;
  for (const pageId of ids) {
    if (kept.has(pageId)) continue;
    const file = pagePath(pageId);
    if (!file) continue;
    rmSync(/*turbopackIgnore: true*/ file, { force: true });
    n++;
  }
  return n;
}
