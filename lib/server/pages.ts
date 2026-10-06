import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id } from "./store";

/**
 * Pages bots make: a single-file HTML explanation ("explain in HTML"), kept in .data/pages and
 * opened in a Bops tab. Written by a model, so they're served locked down (see the pages route).
 */
const DIR = join(process.cwd(), ".data", "pages");

export function savePage(title: string, html: string) {
  mkdirSync(DIR, { recursive: true });
  const pageId = id("page");
  const doc = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<>&"]/g, "")}</title></head><body>${html}</body></html>`;
  writeFileSync(join(DIR, `${pageId}.html`), doc.slice(0, 400_000));
  return pageId;
}

export function readPage(pageId: string) {
  if (!/^page_[a-z0-9]+$/i.test(pageId)) return null;
  const file = join(DIR, `${pageId}.html`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
