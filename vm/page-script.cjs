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
const { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } = require("node:fs");
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
  // Downloads still saving: given a while to land (a script that waited for its download has it already), with any that
  // start meanwhile.
  const until = Date.now() + SAVE_WAIT_MS;
  let late = false;
  for (let seen = -1; seen !== saving.length && !late; ) {
    seen = saving.length;
    late = await Promise.race([Promise.allSettled(saving).then(() => false), new Promise((r) => setTimeout(() => r(true), Math.max(0, until - Date.now())))]);
  }
  if (late) happened.unsaved.push(`still downloading ${SAVE_WAIT_MS / 1000} seconds after the script ended; wait for it in the script: const d = await page.waitForEvent("download"), then await d.path()`);
  // Where it ended: the tab in front now (a script can bring another to the front without navigating it).
  if (browsing) current = (await Promise.race([front(browsing), new Promise((r) => setTimeout(r, 2000))]).catch(() => undefined)) ?? current;
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

/**
 * A path in Downloads for a file the site named `name` (its last part only, no leading dot; "name (1).ext" when that's
 * taken), reserved by creating it, so another download, here or in another screen's task, never gets the same one.
 */
function savePath(name) {
  const file = basename(String(name || "")).replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "") || "download";
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length) || "download";
  for (let i = 0; ; i++) {
    const to = join(DOWNLOADS, i ? `${stem} (${i})${ext}` : file);
    try {
      closeSync(openSync(to, "wx"));
      return to;
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    }
  }
}

/** A download, saved where the bot can find it (the receipt says where, or why not). */
function keep(d) {
  const name = d.suggestedFilename();
  saving.push(
    (async () => {
      let to;
      try {
        mkdirSync(DOWNLOADS, { recursive: true });
        to = savePath(name);
        await d.saveAs(to);
        happened.downloads.push(to);
        // Playwright's own copy in its temp folder: not needed once saved.
        await d.delete().catch(() => {});
      } catch (e) {
        if (to) {
          try {
            unlinkSync(to);
          } catch {}
        }
        happened.unsaved.push(`${name}: ${String(e && e.message ? e.message : e).split("\n")[0].slice(0, 300)}`);
      }
    })(),
  );
}

/**
 * Two pages side by side (the script's sideBySide): `left` in its window on the left half of the screen, `right` (a
 * page, or an address to open) in a window of its own on the right half, so one look at the screen shows both and a
 * drag can go from one to the other. A right page in the same window as the left one opens again at its address in a
 * window of its own, and its tab closes (anything not saved on it is lost). Resolves to both pages.
 */
async function sideBySide(browser, context, left, right) {
  if (right === left) throw new Error("sideBySide needs two different pages: pass another page, or an address to open.");
  const cdp = await browser.newBrowserCDPSession();
  try {
    const targetOf = async (p) => {
      const s = await context.newCDPSession(p);
      try {
        return (await s.send("Target.getTargetInfo")).targetInfo.targetId;
      } finally {
        await s.detach().catch(() => {});
      }
    };
    const windowOf = async (p) => (await cdp.send("Browser.getWindowForTarget", { targetId: await targetOf(p) })).windowId;
    const leftWindow = await windowOf(left);
    let other = typeof right === "string" ? null : right;
    if (!other || (await windowOf(other)) === leftWindow) {
      const was = other;
      other = null;
      const { targetId } = await cdp.send("Target.createTarget", { url: typeof right === "string" ? right : right.url(), newWindow: true });
      // The page Chrome made for it, by its id (not the next page to open: a popup could beat it).
      const seen = new Set([left, was]);
      for (const until = Date.now() + 10_000; !other; await new Promise((r) => setTimeout(r, 100))) {
        for (const p of context.pages()) if (!seen.has(p) && (seen.add(p), (await targetOf(p).catch(() => null)) === targetId)) other = p;
        if (!other && Date.now() > until) throw new Error("The new window for the right-hand page didn't open.");
      }
      await other.waitForLoadState().catch(() => {});
      if (was) await was.close();
    }
    const { x, y, width, height } = await left.evaluate(() => ({ x: screen.availLeft, y: screen.availTop, width: screen.availWidth, height: screen.availHeight }));
    const half = Math.floor(width / 2);
    // A maximized window takes bounds only once it's back to normal, and the window manager can still be placing a
    // window (restoring its old size, or a new one where it likes) after Chrome says yes: set, read back, until it holds.
    const place = async (windowId, at, w) => {
      const want = { left: x + at, top: y, width: w, height };
      for (let i = 0; i < 20; i++) {
        const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
        if (bounds.windowState === "normal" && ["left", "top", "width", "height"].every((k) => Math.abs(bounds[k] - want[k]) <= 16)) return;
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: bounds.windowState === "normal" ? want : { windowState: "normal" } });
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error("Chrome's windows didn't move side by side on this screen.");
    };
    await place(leftWindow, 0, half);
    await place(await windowOf(other), half, width - half);
    // Each the tab in front in its window, so both show.
    await left.bringToFront();
    await other.bringToFront();
    return { left, right: other };
  } finally {
    await cdp.detach().catch(() => {});
  }
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
    run = new AsyncFunction("page", "context", "screenshot", "sideBySide", readFileSync(file, "utf8"));
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
    await done({ ok: true, value: shown(await run(page, context, screenshot, (left, right) => sideBySide(browser, context, left, right))) });
  } catch (e) {
    await done({ ok: false, error: said(e) });
  }
})().catch((e) => done({ ok: false, error: `Couldn't reach the screen's Chrome: ${String(e && e.message ? e.message : e).slice(0, 500)}` }));
