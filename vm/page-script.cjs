// Bops: runs a bot's page script (lib/server/computer-task.ts page_script) on the Chrome of one screen
// of its computer, over CDP, and prints what it returned after a marker line. The script is the body
// of an async function of (page, context): the tab in front of that screen, and its browser's context.
// It works on the Chrome the user watches, so a page it opens comes to the front (as browser-front.cjs
// does for the browser tools). It never closes Chrome: when it's done, it only disconnects.
// Usage: node page-script.cjs <CDP port> <seconds> <script file>
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS, run by node on the computer (as desktop/ is) */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require(join(__dirname, "node_modules", "playwright-core"));

const MARK = "@@bops-page@@";
const [port, seconds, file] = process.argv.slice(2);
const limit = Math.max(1, Number(seconds) || 60) * 1000;
const AsyncFunction = (async () => {}).constructor;

let current;
/** What it returned (or why it failed), and the page it ended on, as one line after the marker. */
function done(out) {
  const url = current && !current.isClosed() ? current.url() : undefined;
  process.stdout.write(`\n${MARK}${JSON.stringify({ ...out, url })}\n`, () => process.exit(0));
}

/** A value as the bot reads it: text as it is, anything else as JSON. */
function shown(value) {
  if (value === undefined) return "(The script returned nothing. End it with return and what you need.)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 1);
  } catch {
    return String(value);
  }
}

/** Each page comes to the front of the screen when it navigates, so the user sees what the bot is on. */
function follow(page) {
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      current = page;
      page.bringToFront().catch(() => {});
    }
  });
}

/**
 * The tab in front of the screen: of the tabs the page itself says are visible (all of them, when
 * none says so), the one Chrome used last. Chrome's DevTools list (/json/list) puts the most recently
 * used tab first; headless, every tab says it's visible.
 */
async function front(context) {
  const pages = context.pages();
  if (!pages.length) return undefined;
  const used = await fetch(`http://127.0.0.1:${port}/json/list`)
    .then((r) => r.json())
    .then((list) => list.filter((t) => t.type === "page").map((t) => t.id))
    .catch(() => []);
  const seen = await Promise.all(
    pages.map(async (p) => {
      const visible = await p.evaluate(() => document.visibilityState === "visible").catch(() => false);
      const id = await context
        .newCDPSession(p)
        .then(async (s) => {
          const { targetInfo } = await s.send("Target.getTargetInfo");
          await s.detach().catch(() => {});
          return targetInfo.targetId;
        })
        .catch(() => undefined);
      return { p, visible, rank: used.includes(id) ? used.indexOf(id) : Infinity };
    }),
  );
  const pool = seen.some((x) => x.visible) ? seen.filter((x) => x.visible) : seen;
  return pool.reduce((best, x) => (x.rank < best.rank ? x : best)).p;
}

(async () => {
  setTimeout(() => done({ ok: false, error: `The script ran past ${limit / 1000} seconds and was stopped.` }), limit).unref();
  let run;
  try {
    run = new AsyncFunction("page", "context", readFileSync(file, "utf8"));
  } catch (e) {
    return done({ ok: false, error: `The script doesn't parse: ${e.message}` });
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  context.setDefaultTimeout(Math.min(30_000, limit));
  current = (await front(context)) ?? (await context.newPage());
  const page = current;
  for (const p of context.pages()) follow(p);
  context.on("page", (p) => {
    follow(p);
    current = p;
    p.bringToFront().catch(() => {});
  });
  try {
    done({ ok: true, value: shown(await run(page, context)) });
  } catch (e) {
    done({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 2000) });
  }
})().catch((e) => done({ ok: false, error: `Couldn't reach the screen's Chrome: ${String(e && e.message ? e.message : e).slice(0, 500)}` }));
