// Bops: runs a bot's page script (lib/server/computer-task.ts page_script) on the Chrome of one screen
// of its computer, over CDP, and prints what it returned after a marker line. The script is the body
// of an async function of (page, context): the tab in front of that screen, and its browser's context.
// It works on the Chrome the user watches, so a page it opens comes to the front (as browser-front.cjs
// does for the browser tools). It never closes Chrome: when it's done, it only disconnects.
// With what it returned comes a receipt (whether the page changed, a dialog, a download, a new tab), so
// the bot can tell a script that did nothing from one that worked, and whether the bot asked to see the
// screen (screenshot(), the script's third argument), which Bops then sends it. Once the browser has two
// or more tabs, the receipt lists them (title, address, which is in front). A file the page downloads is
// saved to the computer's Downloads under the name the site gave it, never over another, and the receipt
// gives the path: Playwright, attached over CDP, would otherwise leave it in a temp folder of its own under
// a random name, where the bot can't find it.
// Usage: node page-script.cjs <CDP port> <seconds> <script file>
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS, run by node on the computer (as desktop/ is) */
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { basename, extname, join } = require("node:path");
const { chromium } = require(join(__dirname, "node_modules", "playwright-core"));

const MARK = "@@bops-page@@";
const [port, seconds, file] = process.argv.slice(2);
const limit = Math.max(1, Number(seconds) || 60) * 1000;
const AsyncFunction = (async () => {}).constructor;

let current;
/** The browser's context once attached: its tabs go in the receipt. */
let browsing;
/** What happened while it ran, for its receipt: dialogs (dismissed unless the script answered them), downloads (where each was saved), downloads that couldn't be saved (and why), tabs opened. */
const happened = { dialogs: [], downloads: [], unsaved: [], opened: 0 };
/**
 * Downloads being saved: the receipt waits for them, up to SAVE_WAIT_MS after the script ends. Bops gives the whole
 * run 30 seconds past the script's limit (computer-task.ts pageScript), and the receipt's own reads take up to 2.5 more:
 * this keeps a script stopped at its limit inside that.
 */
const saving = [];
const SAVE_WAIT_MS = 15_000;
/** The tabs the receipt lists, at most. */
const TABS_LISTED = 12;
/** Where downloads go: the computer's own Downloads, as Chrome's would. */
const DOWNLOADS = join(homedir(), "Downloads");
/** Paths given out during this run, so two downloads of the same name never get the same one. */
const taken = new Set();
/** The page before the script ran (see stateOf), and whether it asked to see the screen. */
let before;
let look = false;
let finished = false;

/** A page as the receipt compares it: where it is, and a cheap print of what's on it (elements, text, focus). */
async function stateOf(page) {
  if (!page || page.isClosed()) return undefined;
  const print = await page
    .evaluate(() => [document.querySelectorAll("*").length, (document.body ? document.body.innerText : "").length, document.activeElement ? document.activeElement.tagName : ""].join(":"))
    .catch(() => "");
  return { url: page.url(), print };
}

/** What it returned (or why it failed), the page it ended on, and its receipt, as one line after the marker. */
async function done(out) {
  if (finished) return;
  finished = true;
  // Downloads still saving: given a while to land (a script that waited for its download has it already).
  const late = await Promise.race([Promise.allSettled(saving).then(() => false), new Promise((r) => setTimeout(() => r(true), SAVE_WAIT_MS))]);
  if (late) happened.unsaved.push(`still downloading ${SAVE_WAIT_MS / 1000} seconds after the script ended; wait for it in the script: const d = await page.waitForEvent("download"), then await d.path()`);
  const url = current && !current.isClosed() ? current.url() : undefined;
  const after = await Promise.race([stateOf(current), new Promise((r) => setTimeout(r, 1500))]).catch(() => undefined);
  const changed = !!(before && after && (before.url !== after.url || before.print !== after.print)) || happened.opened > 0 || happened.dialogs.length > 0 || happened.downloads.length > 0;
  const tabs = await tabsNow();
  process.stdout.write(`\n${MARK}${JSON.stringify({ ...out, url, changed, ...happened, ...(tabs ? { tabs } : {}), look })}\n`, () => process.exit(0));
}

/** The browser's tabs once there are two or more (title, address, whether it's the one in front), else undefined. */
async function tabsNow() {
  const pages = browsing ? browsing.pages().filter((p) => !p.isClosed()) : [];
  if (pages.length < 2) return undefined;
  return Promise.all(
    pages.slice(0, TABS_LISTED).map(async (p) => ({
      title: await Promise.race([p.title(), new Promise((r) => setTimeout(() => r(""), 1000))]).catch(() => ""),
      url: p.url(),
      front: p === current,
    })),
  );
}

/** A path in Downloads for a file the site named `name`: its last part only, no leading dot, and "name (1).ext" when that's taken. */
function savePath(name) {
  const file = basename(String(name || "")).replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "") || "download";
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length) || "download";
  for (let i = 0; ; i++) {
    const to = join(DOWNLOADS, i ? `${stem} (${i})${ext}` : file);
    if (!taken.has(to) && !existsSync(to)) {
      taken.add(to);
      return to;
    }
  }
}

/** A download, saved where the bot can find it (the receipt says where, or why not). */
function keep(d) {
  const name = d.suggestedFilename();
  saving.push(
    (async () => {
      try {
        mkdirSync(DOWNLOADS, { recursive: true });
        const to = savePath(name);
        await d.saveAs(to);
        happened.downloads.push(to);
        // Playwright's own copy in its temp folder: not needed once saved.
        await d.delete().catch(() => {});
      } catch (e) {
        happened.unsaved.push(`${name}: ${String(e && e.message ? e.message : e).split("\n")[0].slice(0, 300)}`);
      }
    })(),
  );
}

/** An error in the bot's terms: a click on something covered says what's on top, and what to do. */
function said(e) {
  const m = String(e && e.message ? e.message : e).slice(0, 2000);
  const on = m.match(/(<[^\n]{1,200}?>)[^\n]*? intercepts pointer events/);
  return on ? `${m}\nSomething is on top of it (${on[1]}): close or dismiss that first, or click it on the screen.` : m;
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

/** Each page comes to the front of the screen when it navigates, so the user sees what the bot is on; its dialogs and downloads go in the receipt. */
function follow(page) {
  page.on("dialog", (d) => {
    happened.dialogs.push(`${d.type()}: ${d.message().slice(0, 200)}`);
    // After the script's own handler, if it has one (page.once("dialog", …)): what's left is dismissed, so nothing waits on it.
    setTimeout(() => d.dismiss().catch(() => {}), 0);
  });
  page.on("download", keep);
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
    run = new AsyncFunction("page", "context", "screenshot", readFileSync(file, "utf8"));
  } catch (e) {
    return done({ ok: false, error: `The script doesn't parse: ${e.message}` });
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  browsing = context;
  context.setDefaultTimeout(Math.min(30_000, limit));
  current = (await front(context)) ?? (await context.newPage());
  const page = current;
  for (const p of context.pages()) follow(p);
  context.on("page", (p) => {
    follow(p);
    happened.opened++;
    current = p;
    p.bringToFront().catch(() => {});
  });
  before = await stateOf(page);
  const screenshot = () => {
    look = true;
    return "(Bops sends you the screen with this script's answer.)";
  };
  try {
    await done({ ok: true, value: shown(await run(page, context, screenshot)) });
  } catch (e) {
    await done({ ok: false, error: said(e) });
  }
})().catch((e) => done({ ok: false, error: `Couldn't reach the screen's Chrome: ${String(e && e.message ? e.message : e).slice(0, 500)}` }));
