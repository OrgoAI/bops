// Tests for the landing page's download buttons (site/download.js) in a real browser: on a Mac they open
// Get First Access (email or skip, then the download and the done state) with what's new in the newest
// release at its foot, anywhere else the old note, and without JS they simply download. And its pricing:
// the same three plans, in the same words, as the app's (lib/plan-includes.ts PLAN_CARDS). The page is served
// from site/ by python3's http.server; PostHog is a stub that records its calls (nothing reaches
// posthog.com), the DMG is a fake attachment, and /download/latest.json is missing unless a test serves it.
// Usage: node scripts/test-site.mjs   (SHOTS=<folder> also saves screenshots of the card and its done state)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { chromium, devices } from "playwright";

// The app's plan cards, to hold the page's pricing to: lib/plan-includes.ts imports "@/cloud/protocol" the way Next resolves it.
const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return next(pathToFileURL(`${repo}/${specifier.slice(2)}.ts`).href, context);
    return next(specifier, context);
  },
});
const { PLAN_CARDS } = await import(`${repo}/lib/plan-includes.ts`);

const site = new URL("../site", import.meta.url).pathname;
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const port = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", site], { stdio: "ignore" });
const url = `http://127.0.0.1:${port}/`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {}
  if (i > 50) throw new Error("http.server didn't start");
  await new Promise((r) => setTimeout(r, 100));
}

// The system Chrome when there is one, else Playwright's own Chromium.
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${String(e.stack || e).split("\n").join("\n  ")}`);
  }
}

// A page with the stubbed PostHog (mode "throw": every call throws, like a broken blocker shim; "none": no
// PostHog at all) and a fake DMG. Chrome says x86 for the architecture once the user agent is overridden,
// so the Mac is made Apple silicon again (arch "arm") or left an Intel one (arch "x86"). latest, when
// given, is the body bops.bot serves at /download/latest.json (an attachment, as Caddy sends it).
async function page(opts = {}, mode = "stub", arch = "arm", latest) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: MAC, ...opts });
  await context.addInitScript(({ mode, arch }) => {
    if (window.NavigatorUAData) {
      const proto = NavigatorUAData.prototype;
      const real = proto.getHighEntropyValues;
      proto.getHighEntropyValues = function (hints) {
        return real.call(this, hints).then((v) => ({ ...v, architecture: arch }));
      };
    }
    window.__ph = [];
    if (mode === "none") {
      // The snippet in index.html makes its own stub; take it away again once it has, as a blocker would.
      document.addEventListener("DOMContentLoaded", () => { delete window.posthog; });
      return;
    }
    // __SV tells the snippet PostHog is already here, so it leaves this stub alone and loads nothing.
    window.posthog = { __SV: 1 };
    for (const m of ["init", "register", "identify", "setPersonProperties", "capture"])
      window.posthog[m] = (...args) => {
        if (mode === "throw" && m !== "init" && m !== "register") throw new Error("blocked");
        window.__ph.push([m, ...args]);
      };
  }, { mode, arch });
  await context.route(/posthog\.com/, (r) => r.abort());
  await context.route("**/download/Bops.dmg", (r) =>
    r.fulfill({ status: 200, contentType: "application/x-apple-diskimage", headers: { "Content-Disposition": 'attachment; filename="Bops.dmg"' }, body: "dmg" }),
  );
  if (latest !== undefined)
    await context.route("**/download/latest.json", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", headers: { "Content-Disposition": "attachment" }, body: latest }),
    );
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e));
  await p.goto(url);
  p.errors = errors;
  return p;
}
const calls = (p) => p.evaluate(() => window.__ph.filter(([m]) => m === "capture" || m === "identify" || m === "setPersonProperties"));
/** The site never identifies a visitor: only the app does, by their Orgo user id. */
const noIdentify = (p) => p.evaluate(() => window.__ph.some(([m]) => m === "identify")).then((x) => assert.equal(x, false, "the site never calls identify"));
const card = (p) => p.locator("dialog.mac-note[open]");
const heroButton = (p) => p.locator(".hero a.pill");

await test("on a Mac, a Download button opens Get First Access instead of downloading", async () => {
  const p = await page();
  let downloaded = false;
  p.on("download", () => (downloaded = true));
  await heroButton(p).click();
  await card(p).waitFor();
  assert.equal(await card(p).locator("h2:visible").textContent(), "Get First Access");
  assert.equal(await card(p).locator(".access-chip").textContent(), "Free for now (not forever)");
  assert.equal(await card(p).locator("#access-body").textContent(), "Leave your email and your download starts right away.");
  const input = card(p).locator("input");
  for (const [k, v] of Object.entries({ type: "email", autocomplete: "email", inputmode: "email", placeholder: "you@company.com" })) assert.equal(await input.getAttribute(k), v);
  assert.equal(await input.evaluate((el) => el.required), true);
  assert.equal(await input.evaluate((el) => el === document.activeElement), true, "the field has focus");
  assert.equal(await card(p).locator("button[type=submit]").textContent(), "Download");
  assert.equal(await card(p).locator(".access-skip").textContent(), "Skip and download");
  await p.waitForTimeout(300);
  assert.equal(downloaded, false);
  assert.deepEqual(await calls(p), [["capture", "bops_download_click", { button: "hero" }]]);
  assert.deepEqual(await p.evaluate(() => window.__ph.find(([m]) => m === "register")), ["register", { site: "bops.bot", app: "bops", environment: "production" }]);
  if (process.env.SHOTS) {
    mkdirSync(process.env.SHOTS, { recursive: true });
    await input.fill("ada@company.com");
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${process.env.SHOTS}/bops-email-modal-desktop.png` });
  }
  assert.deepEqual(p.errors, []);
  await noIdentify(p);
  await p.context().close();
});

await test("the email is checked inline, and the message doesn't move the card", async () => {
  const p = await page();
  await p.locator(".nav a.pill").click();
  const c = card(p);
  await c.waitFor();
  await p.waitForTimeout(350);
  const before = await c.boundingBox();
  await c.locator("button[type=submit]").click();
  assert.equal(await c.locator(".access-error").textContent(), "Enter your email first.");
  assert.equal(await c.locator("input").getAttribute("aria-invalid"), "true");
  assert.deepEqual(await c.boundingBox(), before, "no layout jump");
  await c.locator("input").fill("ada@company");
  await c.locator("input").press("Enter");
  assert.equal(await c.locator(".access-error").textContent(), "That doesn't look like an email address.");
  assert.deepEqual(await c.boundingBox(), before, "no layout jump");
  await c.locator("input").pressSequentially(".com");
  assert.equal(await c.locator(".access-error").textContent(), "", "fixing it clears the message");
  assert.equal(await c.locator("input").getAttribute("aria-invalid"), null);
  assert.equal((await calls(p)).filter(([, e]) => e !== "bops_download_click").length, 0, "nothing sent for a bad email");
  await noIdentify(p);
  await p.context().close();
});

await test("a valid email goes on the visitor (never identify), captures, downloads and shows the done state", async () => {
  const p = await page();
  await p.locator(".nav a.pill").click();
  await card(p).locator("input").fill("ada@company.com");
  const [dl] = await Promise.all([p.waitForEvent("download"), card(p).locator("input").press("Enter")]);
  assert.equal(new URL(dl.url()).pathname, "/download/Bops.dmg");
  const done = card(p).locator(".access-done");
  await done.waitFor();
  assert.equal(await done.locator("h2").textContent(), "Your download has started");
  assert.equal(await done.locator("h2").evaluate((el) => el === document.activeElement), true);
  const again = done.locator("a");
  assert.equal(await again.textContent(), "Didn't start? Download again");
  assert.equal(await again.getAttribute("href"), "/download/Bops.dmg");
  assert.equal(await card(p).locator(".access-ask").isVisible(), false);
  assert.deepEqual(await calls(p), [
    ["capture", "bops_download_click", { button: "nav" }],
    ["setPersonProperties", { email: "ada@company.com", source: "bops.bot" }],
    ["capture", "bops_download_email", { email: "ada@company.com", button: "nav" }],
  ]);
  if (process.env.SHOTS) {
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${process.env.SHOTS}/bops-email-modal-done.png` });
  }
  const [again2] = await Promise.all([p.waitForEvent("download"), again.click()]);
  assert.equal(new URL(again2.url()).pathname, "/download/Bops.dmg");
  assert.deepEqual(p.errors, []);
  await noIdentify(p);
  await p.context().close();
});

await test("Skip and download captures the skip, downloads and shows the done state", async () => {
  const p = await page();
  await p.locator(".s5 a.pill").click();
  const [dl] = await Promise.all([p.waitForEvent("download"), card(p).locator(".access-skip").click()]);
  assert.equal(new URL(dl.url()).pathname, "/download/Bops.dmg");
  await card(p).locator(".access-done").waitFor();
  assert.deepEqual(await calls(p), [
    ["capture", "bops_download_click", { button: "footer" }],
    ["capture", "bops_download_skip_email", { button: "footer" }],
  ]);
  await noIdentify(p);
  await p.context().close();
});

await test("Escape, the close button and the backdrop close it; focus goes back; it opens fresh again", async () => {
  const p = await page();
  const hero = heroButton(p);
  await hero.click();
  await card(p).waitFor();
  await p.keyboard.press("Escape");
  await card(p).waitFor({ state: "detached" });
  assert.equal(await hero.evaluate((el) => el === document.activeElement), true, "focus back on the button");
  await hero.click();
  await card(p).locator(".mac-note-close").click();
  await card(p).waitFor({ state: "detached" });
  await hero.click();
  await card(p).waitFor();
  await p.mouse.click(20, 20);
  await card(p).waitFor({ state: "detached" });
  // After a skip, the next click asks again (the done state doesn't stick).
  await hero.click();
  await Promise.all([p.waitForEvent("download"), card(p).locator(".access-skip").click()]);
  await p.keyboard.press("Escape");
  await hero.click();
  assert.equal(await card(p).locator(".access-ask").isVisible(), true);
  await noIdentify(p);
  await p.context().close();
});

await test("in a narrow window the card fits, and Download goes under the field", async () => {
  const p = await page({ viewport: { width: 340, height: 640 } });
  await heroButton(p).click();
  const c = card(p);
  await c.waitFor();
  await p.waitForTimeout(350);
  const box = await c.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 340, "inside the window");
  const field = await c.locator("input").boundingBox();
  const button = await c.locator("button[type=submit]").boundingBox();
  assert.ok(button.y >= field.y + field.height, "wrapped under the field");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await noIdentify(p);
  await p.context().close();
});

await test("a PostHog that throws, or none at all, doesn't break the card", async () => {
  for (const mode of ["throw", "none"]) {
    const p = await page({}, mode);
    await heroButton(p).click();
    await card(p).locator("input").fill("ada@company.com");
    const [dl] = await Promise.all([p.waitForEvent("download"), card(p).locator("button[type=submit]").click()]);
    assert.equal(new URL(dl.url()).pathname, "/download/Bops.dmg");
    await card(p).locator(".access-done").waitFor();
    assert.deepEqual(p.errors, [], mode);
    await noIdentify(p);
    await p.context().close();
  }
});

await test("on an iPhone the buttons still open the Mac note", async () => {
  const p = await page({ ...devices["iPhone 15"] });
  await heroButton(p).tap();
  await card(p).waitFor();
  assert.equal(await card(p).locator("h2").textContent(), "Bops is a Mac app");
  assert.equal(await p.locator(".access-ask").count(), 0, "no email card");
  assert.deepEqual(await calls(p), [["capture", "bops_download_note", { kind: "other", button: "hero" }]]);
  await noIdentify(p);
  await p.context().close();
});

await test("an Intel Mac gets the Apple silicon note", async () => {
  const p = await page({}, "stub", "x86");
  await p.waitForTimeout(100);
  await heroButton(p).click();
  await card(p).waitFor();
  assert.equal(await card(p).locator("h2").textContent(), "Bops needs Apple silicon");
  assert.equal(await p.locator(".access-ask").count(), 0, "no email card");
  assert.deepEqual(await calls(p), [["capture", "bops_download_note", { kind: "intel", button: "hero" }]]);
  await noIdentify(p);
  await p.context().close();
});

// latest.json as scripts/download-publish.sh writes it (jq, ASCII with \u escapes), with notes that have
// quotes, an apostrophe, other scripts, an emoji and markup, and one line more than the card shows.
const NOTES = ['Say "hi" to Boppy\'s new voice', "Números en español, 日本語 and 🎧", '<b>Not bold</b> & <img src=x onerror="window.__xss=1">', "Four", "Five", "Six"];
const LATEST = JSON.stringify({ version: "0.0.11", url: "https://bops.bot", dmg: "https://bops.bot/download/Bops.dmg", released: "2026-10-06T17:00:00Z", notes: NOTES }).replace(
  /[\u007f-\uffff]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
const news = (p) => card(p).locator(".access-new");

await test("on a Mac the card ends with what's new in the newest release, as plain text", async () => {
  const p = await page({}, "stub", "arm", LATEST);
  await heroButton(p).click();
  await news(p).waitFor();
  assert.equal(await news(p).locator("h3").textContent(), "What's new in 0.0.11");
  assert.equal(await news(p).locator("h3").evaluate((el) => getComputedStyle(el).textTransform), "uppercase");
  assert.deepEqual(await news(p).locator("li").allTextContents(), NOTES.slice(0, 5));
  assert.equal(await news(p).locator("b, img").count(), 0, "markup in a note stays text");
  assert.equal(await p.evaluate(() => window.__xss), undefined);
  assert.equal(await card(p).locator("input").evaluate((el) => el === document.activeElement), true, "the field still has focus");
  if (process.env.SHOTS) {
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${process.env.SHOTS}/bops-email-modal-whats-new.png` });
  }
  // It stays under the done state too.
  await Promise.all([p.waitForEvent("download"), card(p).locator(".access-skip").click()]);
  await card(p).locator(".access-done").waitFor();
  assert.equal(await news(p).isVisible(), true);
  assert.deepEqual(p.errors, []);
  await noIdentify(p);
  await p.context().close();
});

await test("without latest.json, an older one with no notes, or a broken one, the card is as it was", async () => {
  const old = JSON.stringify({ version: "0.0.10", url: "https://bops.bot", dmg: "https://bops.bot/download/Bops.dmg", released: "2026-10-06T16:37:57Z" });
  for (const latest of [undefined, old, "{", JSON.stringify({ version: "0.0.11", notes: [] }), JSON.stringify({ version: "soon", notes: ["x"] })]) {
    const p = await page({}, "stub", "arm", latest);
    await heroButton(p).click();
    await card(p).waitFor();
    await p.waitForTimeout(300);
    assert.equal(await news(p).isVisible(), false, String(latest));
    assert.deepEqual(p.errors, [], String(latest));
    await noIdentify(p);
    await p.context().close();
  }
});

await test("the card's what's new is left out on a short screen", async () => {
  const p = await page({ viewport: { width: 900, height: 480 } }, "stub", "arm", LATEST);
  await heroButton(p).click();
  await card(p).waitFor();
  await p.waitForTimeout(300);
  assert.equal(await news(p).isVisible(), false);
  await noIdentify(p);
  await p.context().close();
});

await test("without JS, a button simply downloads", async () => {
  const p = await page({ javaScriptEnabled: false });
  const [dl] = await Promise.all([p.waitForEvent("download"), heroButton(p).click()]);
  assert.equal(new URL(dl.url()).pathname, "/download/Bops.dmg");
  await noIdentify(p);
  await p.context().close();
});

await test("pricing shows the app's three plans, line for line, and fits from a phone to a desktop", async () => {
  const want = PLAN_CARDS.map((c) => ({ tier: c.tier, name: c.name, price: `${c.price}${c.per ?? ""}`, computers: c.computers, lines: c.lines.map((l) => ({ text: l.text, no: !!l.no })) }));
  for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    const p = await page({ viewport });
    const got = await p.locator("#pricing .plan").evaluateAll((plans) =>
      plans.map((el) => ({
        tier: el.dataset.tier,
        name: el.querySelector(".plan-name").textContent.trim(),
        price: el.querySelector(".plan-price").textContent.trim(),
        // How many computers, set apart before the lines.
        computers: { title: el.querySelector(".plan-computers b").textContent.trim(), detail: el.querySelector(".plan-computers span").textContent.trim() },
        lines: [...el.querySelectorAll("li")].map((li) => ({ text: li.textContent.trim(), no: li.classList.contains("no") })),
      })),
    );
    assert.deepEqual(got, want, `${viewport.width}px`);
    assert.deepEqual(
      got.map((c) => c.computers.title),
      ["1 computer included", "1 computer included", "Up to 3 computers"],
    );
    // The count is the first thing under the price, ahead of the lines.
    const first = await p.locator("#pricing .plan").evaluateAll((plans) => plans.map((el) => el.children[1]?.className));
    assert.deepEqual(first, ["plan-computers", "plan-computers", "plan-computers"]);
    // Nothing runs off the side, and no dashes in the copy.
    const wide = await p.evaluate(() => [...document.querySelectorAll("#pricing .plan")].some((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1));
    assert.equal(wide, false, `${viewport.width}px: a plan runs off the screen`);
    assert.doesNotMatch(await p.locator("#pricing").innerText(), /[\u2013\u2014]/);
    // Side by side on a desktop, one under another on a phone.
    const tops = await p.locator("#pricing .plan").evaluateAll((plans) => plans.map((el) => Math.round(el.getBoundingClientRect().top)));
    if (viewport.width >= 1180) assert.equal(new Set(tops).size, 1, "three across");
    if (viewport.width < 900) assert.equal(new Set(tops).size, 3, "stacked");
    assert.deepEqual(p.errors, []);
    await noIdentify(p);
    await p.context().close();
  }
  const p = await page();
  await p.locator('.nav-link[href="#pricing"]').click();
  await p.waitForFunction(() => location.hash === "#pricing");
  await noIdentify(p);
  await p.context().close();
});

await browser.close();
server.kill();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
