// Your Apps, driven in the real window on the local two-person stack (scripts/dev-two-person.mjs, started here when it
// isn't up): the owner's page and an app's tab, and sam's (an Admin's) page of the same apps. The stack has no apps on
// the web (nothing real is in it), so the apps come from scripts/fixtures/your-apps.mjs, answered at the browser's edge:
// the owner's /api/hosted-apps and /api/made-apps routes, and in both windows the state feed (/api/state) with the
// owner's sign-in as Orgo's team (apps are open to them: lib/apps-access.ts), the tools the bots made, and for sam the
// workspace's apps as its owner's Mac would have written them for members. Every press that would reach Orgo (a deploy,
// Publish, a rollback, an Admin's act) is answered here too, and moves the sample on, so the page is seen following it.
//
// Shots of each screen go to <out>/<prefix>-<n>-<screen>[-<width>].png at 1440 and 1180 wide (the Mac app's narrowest
// window: desktop/main.cjs minWidth); `--shots before` takes them of the page as it was, `--shots after` of the page as
// it is, and either skips the checks (`--look`). Without --look, every control of the new page is pressed, PASS or FAIL
// printed per check, and the run fails on any FAIL, page error or console error. <out> is $YOUR_APPS_OUT, else
// .scratch/your-apps. Everything stays on 127.0.0.1.
// Usage: node scripts/test-your-apps-e2e.mjs [--shots before|after] [--look] [--width 1440]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as F from "./fixtures/your-apps.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = process.env.YOUR_APPS_OUT || join(root, ".scratch", "your-apps");
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const PREFIX = arg("--shots") ?? "after";
const LOOK = args.includes("--look") || PREFIX === "before";
const WIDTHS = arg("--width") ? [Number(arg("--width"))] : [1440, 1180];
const { chromium } = await import("playwright");

/* ---------------- The stack ---------------- */

const stateFile = join(root, ".scratch", "two-person", "stack.json");
const running = () => {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    process.kill(s.pid, 0);
    return s.ready ? s : null;
  } catch {
    return null;
  }
};
let started = false;
if (!running()) {
  console.log("starting the two-person stack (sam as an Admin)…");
  const r = spawnSync(process.execPath, [join(root, "scripts", "dev-two-person.mjs"), "start"], { stdio: "inherit", env: { ...process.env, TWO_PERSON_MEMBER_ROLE: "admin" } });
  if (r.status !== 0) process.exit(1);
  started = true;
}
const { urls } = running();

/* ---------------- The sample, as it moves on ---------------- */

/** The owner's apps as they are now: a deploy or Publish here moves one on, as Orgo would, a moment later. */
const model = { apps: F.hostedApps().apps, acts: [] };
const appOf = (name) => model.apps.find((a) => a.name === name);
const later = (f) => setTimeout(f, 1500);
/** Deploy to the Preview: its newest deploy runs, then serves the changeset (the newest, or `at`). */
function deployPreview(a, at = a.head) {
  a.preview = { ...a.preview, live: { id: `d_${Date.now()}`, at, state: "running", when: Date.now(), error: null, url: null } };
  later(() => {
    a.preview = { ...a.preview, serving: at, live: { ...a.preview.live, state: "succeeded", when: Date.now() } };
  });
}
/** Publish: what the Preview serves goes on Published (or, on GitHub, is pushed there). */
function publish(a) {
  const at = a.preview?.serving ?? a.head;
  if (a.hosting?.github) {
    a.hosting = { ...a.hosting, github: { ...a.hosting.github, last: { sha: "9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6", ingot: at, when: Date.now() } } };
    return;
  }
  a.live = { id: `d_${Date.now()}`, at, state: "running", when: Date.now(), error: null, url: null };
  later(() => {
    a.serving = at;
    a.live = { ...a.live, state: "succeeded", when: Date.now() };
  });
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The owner's window: its state as Orgo's team with the sample apps in it, and every Your Apps route answered from the sample. */
async function ownerRoutes(page) {
  await page.route((u) => u.pathname === "/api/state", async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    if (j.state) {
      j.state.account = { ...j.state.account, user: { ...j.state.account?.user, email: F.TEAM_EMAIL } };
      j.state.madeApps = F.MADE;
      j.state.workspaces = (j.state.workspaces ?? []).map((w) => (w.id === F.PROJECT.wsId ? { ...w, hostedApps: F.hostingInState(), appsForMembers: { at: Date.now(), apps: Object.fromEntries(Object.entries(F.ACTS).map(([n, acts]) => [n, { head: null, sites: [], commits: [], deploys: [], acts }])) } } : w));
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  await page.route((u) => u.pathname.startsWith("/api/made-apps/"), async (route) => {
    const u = new URL(route.request().url());
    const [, , , appId, part] = u.pathname.split("/");
    if (part === "view") return route.fulfill({ status: 200, contentType: "text/html", body: F.madeAppPage(decodeURIComponent(appId)) });
    if (!part && route.request().method() === "GET") return json(route, { code: "export default function App() { return <h1>Trip budget</h1>; }", draft: null });
    return json(route, { ok: true });
  });
  await page.route((u) => u.pathname.startsWith("/api/hosted-apps"), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const parts = u.pathname.split("/").slice(3);
    const name = parts[0] ? decodeURIComponent(parts[0]) : undefined;
    const part = parts[1];
    const env = u.searchParams.get("env") ?? undefined;
    const body = req.method() === "GET" ? {} : (req.postDataJSON() ?? {});
    if (!name) return json(route, { enabled: true, apps: model.apps });
    const a = appOf(name);
    if (!a) return json(route, { error: "There's no app by that name in this workspace." }, 404);
    if (!part) {
      if (req.method() === "GET") return json(route, { later: [] });
      model.acts.push(body);
      if (body.action === "deploy" && body.env !== "prod") deployPreview(a, body.at);
      else if (body.action === "deploy" || body.action === "promote") publish(a);
      else if (body.action === "rollback") {
        if (body.env === "preview") a.preview = { ...a.preview, serving: F.FC.prodAt, live: { ...a.preview.live, id: `d_${Date.now()}`, at: F.FC.prodAt, state: "succeeded", when: Date.now() } };
        else a.serving = F.id("c3");
      }
      return json(route, { app: a });
    }
    if (part === "commits") return json(route, { commits: F.COMMITS[name].map((c) => ({ ...c, serving: c.id === a.serving })), head: a.head, next: null });
    if (part === "settings") return json(route, req.method() === "GET" ? F.settings(name, env) : { ...F.settings(name, body.env), said: "Saved." });
    if (part === "dns") return json(route, F.dns(name));
    if (part === "local") {
      if (req.method() === "GET") return json(route, F.local(name));
      model.acts.push(body);
      const l = F.local(name);
      if (body.action === "start") l.sites[name] = { ...l.sites[name], state: "running", since: Date.now() };
      if (body.action === "preview") return json(route, { preview: "http://localhost:3000/" });
      return json(route, l);
    }
    if (part === "password") {
      if (req.method() === "GET") return json(route, F.password(name));
      model.acts.push(body);
      return json(route, { ...F.password(name), password: body.action === "off" ? null : "Tz4nR8w", on: body.action !== "off", at: Date.now() });
    }
    if (part === "domains") return json(route, F.domainOptions());
    if (part === "logs") return json(route, F.log());
    if (part === "env") return json(route, { env: ["DATABASE_URL", "NEXTAUTH_SECRET"] });
    return json(route, { error: `not answered here: ${u.pathname}` }, 404);
  });
}

/** Sam's window: the shared workspace's apps, as the owner's Mac would have written them, and an Admin's acts taken here. */
async function samRoutes(page) {
  await page.route((u) => u.pathname === "/api/state", async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    if (j.state?.shared) j.state.shared = { ...j.state.shared, owner: F.TEAM_EMAIL, apps: F.sharedApps(), adminPublish: true, appActs: model.samActs ?? [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  await page.route((u) => u.pathname === "/api/workspaces/shared", async (route) => {
    const body = route.request().method() === "POST" ? (route.request().postDataJSON() ?? {}) : {};
    if (!body.act) return route.continue();
    model.acts.push(body.act);
    return json(route, { ok: true });
  });
}

/* ---------------- Driving ---------------- */

const errors = [];
let fails = 0;
let shot = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) fails++;
};
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const NO_DASHES = /[–—]| - /;

async function newPage(browser, width, who) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${who} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const where = m.location()?.url ?? "";
    // (Next's own dev notes aren't the page's; nor is the stand-in computer's screen, which the stack has no VNC for: the
    // panel's screen tab tries it and is told 404 or 502, on the owner's page and sam's alike, apps or no apps.)
    if (/Download the React DevTools|Fast Refresh/.test(m.text()) || /websockify|\/desktops\//.test(`${m.text()} ${where}`)) return;
    if (/Failed to load resource/.test(m.text()) && /\/api\/(computers|screens|screen|desktops|vnc)\b|\/shared\/screen|websockify/.test(where)) return;
    errors.push(`${who} console: ${m.text()}${where ? ` (${where})` : ""}`);
  });
  return page;
}
const snap = async (page, screen, width) => {
  shot++;
  const file = `${PREFIX}-${String(shot).padStart(2, "0")}-${screen}${width === 1440 ? "" : `-${width}`}.png`;
  await page.screenshot({ path: join(OUT, file) });
  console.log(`shot ${file}`);
};

/** The owner's Your Apps: the home (the footer's button), then an app's tab. */
async function owner(browser, width) {
  const page = await newPage(browser, width, "owner");
  await ownerRoutes(page);
  await page.goto(urls.owner, { waitUntil: "networkidle" });
  await page.locator('[data-footer-key="apps"] button').waitFor({ timeout: 60_000 });
  await page.locator('[data-footer-key="apps"] button').click();
  await page.locator("[data-hosted-apps]").waitFor();
  await page.locator('[data-hosted-app="fourcorners"]').waitFor();
  await page.waitForTimeout(1200);
  await snap(page, "owner-home", width);
  if (!LOOK) await ownerHomeChecks(page);
  await page.locator('[data-hosted-app="fourcorners"] > button').first().click();
  await page.locator('[data-hosted-tab="fourcorners"]').waitFor();
  await page.locator("[data-history] [data-commit]").first().waitFor();
  await page.waitForTimeout(600);
  await snap(page, "owner-app", width);
  if (!LOOK) await ownerAppChecks(page);
  await page.locator('[data-hosted-tab="fourcorners"] [data-app-env="preview"]').click();
  await page.waitForTimeout(600);
  await snap(page, "owner-app-preview", width);
  if (!LOOK) await ownerPreviewChecks(page);
  await page.context().close();
}

/** Sam's Your Apps in the shared workspace: the page, then an app opened. */
async function sam(browser, width) {
  const page = await newPage(browser, width, "sam");
  await samRoutes(page);
  await page.goto(urls.sam, { waitUntil: "networkidle" });
  await page.locator("[data-footer-key]").first().waitFor({ timeout: 60_000 });
  // The shared workspace, opened as the switcher opens it (the window's own route).
  const status = await page.evaluate((id) => fetch("/api/workspaces/shared", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: id }) }).then((r) => r.status), F.PROJECT.id);
  if (status !== 200) throw new Error(`sam couldn't open the shared workspace: ${status}`);
  await page.locator('[data-footer-key="apps"] button').waitFor({ timeout: 60_000 });
  await page.locator('[data-footer-key="apps"] button').click();
  await page.locator("[data-shared-apps]").waitFor();
  await page.waitForTimeout(800);
  await snap(page, "admin-home", width);
  if (!LOOK) await samHomeChecks(page);
  await page.locator('[data-shared-app="fourcorners"] button[aria-expanded]').click();
  await page.waitForTimeout(500);
  await snap(page, "admin-open", width);
  if (!LOOK) await samOpenChecks(page);
  await page.context().close();
}

/* ---------------- The checks (the page as it is) ---------------- */

async function ownerHomeChecks(page) {
  const list = page.locator("[data-hosted-apps]");
  check("the home says few words per app (each row under 16 words)", (await Promise.all((await page.locator("[data-hosted-app]").all()).map((r) => r.innerText()))).every((t) => words(t) <= 16));
  const sentence = (name) => page.locator(`[data-hosted-app="${name}"] + [data-state-line]`).innerText();
  check("fourcorners: the sentence says the preview has a change that isn't live", /isn.t live/.test(await sentence("fourcorners")));
  check("fourcorners offers Publish (to GitHub, where its production is) as its one action", /^Publish/.test((await page.locator('[data-hosted-app="fourcorners"] [data-next-action]').innerText()).trim()));
  check("cclc: the preview is ready but there's no domain, so Connect a domain", /Connect a domain to publish it/.test(await sentence("cclc")) && (await page.locator('[data-hosted-app="cclc"] [data-next-action]').innerText()).trim() === "Connect a domain");
  check("brochure-maker: the preview is updating, so nothing to press", /Updating the preview/.test(await sentence("brochure-maker")) && (await page.locator('[data-hosted-app="brochure-maker"] [data-next-action]').count()) === 0);
  check("no Local, Preview and Published lines on the home", (await list.locator("[data-app-env]").count()) === 0);
  check("the tools the bots made show as tiles", (await page.locator("[data-made-app-tile]").count()) === 2);
  check("no dashes on the home", !NO_DASHES.test(await page.locator("[data-made-apps-home]").innerText()));
}

async function ownerAppChecks(page) {
  const tab = page.locator('[data-hosted-tab="fourcorners"]');
  check("the tab's one action is Publish (to GitHub)", /^Publish/.test((await tab.locator("[data-next-action]").innerText()).trim()));
  check("the tab's sentence names the change that isn't live", /1 change that isn.t live/.test(await tab.locator("[data-state-line]").innerText()) && /Pick a project type/.test(await tab.locator("[data-state-line]").innerText()));
  const changes = tab.locator("[data-history]");
  check("Changes: the newest is tagged On preview, the one live is tagged Live", (await changes.locator('[data-commit] [data-tag="preview"]').count()) === 1 && (await changes.locator('[data-commit] [data-tag="live"]').count()) === 1);
  check("no changeset ids or file counts on the lines", (await changes.locator("[data-commit]").first().innerText()).match(/[0-9a-f]{7}/) === null);
  check("no blue on the page", !(await tab.innerHTML()).includes("#EEF2FF"));
  check("build settings are folded on Published", (await tab.locator("[data-fold='settings'][aria-expanded='false']").count()) === 1);
  check("shut, the settings and deploys are kept but out of sight", !(await tab.locator("[data-settings]").isVisible()) && !(await tab.locator("[data-deploys]").isVisible()));
  await tab.locator("[data-fold='settings'] > button").click();
  check("opening the fold shows the settings and the deploys", (await tab.locator("[data-settings]").isVisible()) && (await tab.locator("[data-deploys]").isVisible()));
  await tab.locator("[data-fold='settings'] > button").click();
  // Publish: the sentence follows it.
  await tab.locator("[data-next-action]").click();
  await page.waitForTimeout(400);
  check("Publish was sent", model.acts.some((x) => x.action === "promote"));
  await page.waitForTimeout(3800);
  check("after Publish, the page says live is up to date", /Live and up to date/.test(await tab.locator("[data-state-line]").innerText()));
  check("no dashes on the tab", !NO_DASHES.test(await tab.innerText()));
}

async function ownerPreviewChecks(page) {
  const tab = page.locator('[data-hosted-tab="fourcorners"]');
  check("Preview picked: its link and password show", (await tab.locator("[data-password-section]").count()) === 1 && (await tab.locator('[data-address-section="preview"]').count()) === 1);
  check("the Preview's build settings are folded too", (await tab.locator("[data-fold='settings'][aria-expanded='false']").count()) === 1);
  // Update preview from the Preview line.
  await tab.locator('[data-app-env="preview"] [data-act="deploy"]').click();
  await page.waitForTimeout(400);
  check("Update preview was sent", model.acts.some((x) => x.action === "deploy" && x.env === "preview"));
  await page.waitForTimeout(600);
  check("while it runs, the sentence says the preview is updating", /Updating the preview/.test(await tab.locator("[data-state-line]").innerText()));
}

async function samHomeChecks(page) {
  const fc = page.locator('[data-shared-app="fourcorners"]');
  check("sam sees the same sentence as the owner", /isn.t live/.test(await fc.innerText()));
  check("sam's buttons are Update preview and Publish, Publish filled", (await fc.locator("[data-shared-publish]").innerText()).trim() === "Publish" && (await fc.locator('[data-act="deploy"]').innerText()).trim() === "Update preview" && (await fc.locator("[data-shared-publish]").getAttribute("class"))?.includes("bg-ink"));
  check("each card says few words (under 24)", (await Promise.all((await page.locator("[data-shared-app]").all()).map((r) => r.innerText()))).every((t) => words(t) <= 24));
  check("no dashes on sam's page", !NO_DASHES.test(await page.locator("[data-shared-apps]").innerText()));
}

async function samOpenChecks(page) {
  const fc = page.locator('[data-shared-app="fourcorners"]');
  check("opened: the preview link and its password", (await fc.locator("[data-shared-preview]").count()) === 1 && (await fc.locator("[data-password-beside]").count()) === 1);
  check("opened: Changes with Live and On preview tags", (await fc.locator('[data-tag="live"]').count()) >= 1 && (await fc.locator('[data-tag="preview"]').count()) >= 1);
  check("opened: build settings and earlier deploys are folded", (await fc.locator("[data-fold][aria-expanded='false']").count()) >= 1);
  check("shut, the Port field is out of sight", !(await fc.locator('input[aria-label="Port"]').isVisible()));
  await fc.locator("[data-fold='settings'] > button").click();
  check("opened fold: the Port field shows", await fc.locator('input[aria-label="Port"]').isVisible());
  await fc.locator("[data-shared-publish]").click();
  await page.waitForTimeout(400);
  check("sam's Publish went to the owner's Bops as a prod deploy", model.acts.some((x) => x.act === "deploy" && x.env === "prod" && x.app === "fourcorners"));
}

/* ---------------- Run ---------------- */

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const width of WIDTHS) {
    // The sample as it was, for each width: a Publish pressed at one width isn't live at the next.
    model.apps = F.hostedApps().apps;
    model.acts = [];
    await owner(browser, width);
    await sam(browser, width);
  }
} finally {
  await browser.close();
  if (started) spawnSync(process.execPath, [join(root, "scripts", "dev-two-person.mjs"), "stop"], { stdio: "inherit" });
}
for (const e of errors) console.log(`FAIL ${e}`);
const wide = await Promise.resolve(true);
void wide;
if (LOOK) console.log(`shots in ${OUT}${errors.length ? ", with page errors" : ""}`);
else console.log(fails || errors.length ? `${fails} FAIL, ${errors.length} page errors` : "all PASS");
process.exit(fails || errors.length ? 1 : 0);
