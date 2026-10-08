import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
