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
// `--hold` instead opens the two windows (the owner's and sam's) in a Chrome you can see, each at Your Apps with the
// sample in it, and keeps them answered until that Chrome is closed: for a person to click around, not a check.
// Usage: node scripts/test-your-apps-e2e.mjs [--shots before|after] [--look] [--width 1440] [--hold]
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
const HOLD = args.includes("--hold");
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
    // (A read still in flight as the window closes: let it go, don't fail the run on it.)
    const r = await route.fetch().catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (!j) return route.abort().catch(() => {});
    if (j.state) {
      j.state.account = { ...j.state.account, user: { ...j.state.account?.user, email: F.TEAM_EMAIL } };
      j.state.madeApps = F.MADE;
      j.state.workspaces = (j.state.workspaces ?? []).map((w) => (w.id === F.PROJECT.wsId ? { ...w, hostedApps: F.hostingInState(), appsForMembers: { at: Date.now(), apps: Object.fromEntries(Object.entries(F.ACTS).map(([n, acts]) => [n, { head: null, sites: [], commits: [], deploys: [], acts }])) } } : w));
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) }).catch(() => {});
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
    const r = await route.fetch().catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (!j) return route.abort().catch(() => {});
    if (j.state?.shared) j.state.shared = { ...j.state.shared, owner: F.TEAM_EMAIL, apps: F.sharedApps(), adminPublish: true, appActs: model.samActs ?? [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) }).catch(() => {});
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
  // (Held for a person, the page fills whatever size they make the window.)
  const context = await browser.newContext(HOLD ? { viewport: null, colorScheme: "light" } : { viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
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
  if (args.includes("--mock")) { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350); }
  shot++;
  const file = `${PREFIX}-${String(shot).padStart(2, "0")}-${screen}${width === 1440 ? "" : `-${width}`}.png`;
  await page.screenshot({ path: join(OUT, file), ...(args.includes("--mock") ? { style: "[data-mock-navigation] { visibility: hidden; }" } : {}) });
  console.log(`shot ${file}`);
};

/** The owner's Your Apps: the home (the footer's button), then an app's tab. */
async function owner(browser, width) {
  const page = await newPage(browser, width, "owner");
  await ownerRoutes(page);
  await page.goto(urls.owner, { waitUntil: "networkidle" });
  if (args.includes("--mock")) {
    await page.goto(`${urls.owner}/your-apps-v4`, {waitUntil:"networkidle"});
    await page.locator('[data-mock-go="home"]').waitFor();
    await mockEntryChecks(page, width);
    if (args.includes("--mock-intuition-only")) { await page.context().close(); return; }
    await snap(page, 'mock-owner-home', width);
    await mockChecks(page, `home ${width}`);
    await page.getByRole('button',{name:'Review changes',exact:true}).click();
    await snap(page, 'mock-owner-app', width);
    await mockChecks(page, `app ${width}`);
    await mockInteractionChecks(page, width);
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await snap(page, 'mock-owner-settings', width);
    await page.getByRole('button',{name:'Technical settings',exact:true}).click();
    check(`technical settings remain one click away ${width}`, await page.locator('[data-technical-settings] input').count() === 4);
    await snap(page, 'mock-owner-technical-settings', width);
    await page.context().close();
    return;
  }
  if (args.includes("--siblings")) {
    const data = {name:"Sample pipeline", columns:["Name","Stage","Value"], rows:[["Jordan Lee","Proposal","12000"],["Priya Shah","Won","4800"]], version:"sample-v1", updatedAt:Date.now()};
    await page.route(u => u.pathname === "/api/crm/file", r => json(r, data));
    await page.goto(`${urls.owner}/your-apps-v4/references`, {waitUntil:"networkidle"});
    for (const screen of ["chat", "computer", "crm", "issues", "team"]) {
      await page.locator(`[data-reference="${screen}"]`).click();
      await page.waitForTimeout(800);
      await snap(page, `sibling-${screen}`, width);
    }
    await page.context().close();
    return;
  }
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
  if (PREFIX === "before") {
    // Main has environment sections inline. Capture the actual layout, without requiring v3's controls.
    for (const env of ["preview", "local", "prod"]) {
      await page.locator(`[data-hosted-tab="fourcorners"] [data-app-env="${env}"]`).click();
      await page.waitForTimeout(500);
      await snap(page, `owner-app-${env}-settings`, width);
    }
    await page.locator('[data-footer-key="apps"] button').click();
    await page.locator('[data-hosted-app="cclc"] > button').first().click();
    await page.locator('[data-hosted-tab="cclc"] [data-app-envs]').waitFor();
    await page.waitForTimeout(500);
    await snap(page, "owner-app-unpublished", width);
  } else {
  // Settings: Local, Preview and Published, the picked place's sections.
  await page.locator('[data-hosted-tab="fourcorners"] [data-tab-settings]').click();
  await page.locator('[data-hosted-tab="fourcorners"] [data-app-settings]').waitFor();
  await page.locator('[data-hosted-tab="fourcorners"] [data-app-env="preview"]').click();
  await page.waitForTimeout(600);
  await snap(page, "owner-app-settings", width);
  if (!LOOK) await ownerSettingsChecks(page);
  // An app not published yet (cclc): its Live card says so and offers Add a domain, which opens Settings at the form.
  await page.locator('[data-footer-key="apps"] button').click();
  await page.locator('[data-hosted-app="cclc"]').waitFor();
  await page.locator('[data-hosted-app="cclc"] > button').first().click();
  await page.locator('[data-hosted-tab="cclc"] [data-places]').waitFor();
  await page.waitForTimeout(500);
  await snap(page, "owner-app-unpublished", width);
  if (!LOOK) await ownerUnpublishedChecks(page);
  }
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
  if (args.includes("--mock")) {
    await page.goto(`${urls.sam}/your-apps-v4`, {waitUntil:"networkidle"});
    await page.locator('[data-mock-go="admin"]').click();
    await snap(page, 'mock-admin-open', width);
    await mockChecks(page, `admin ${width}`);
    await page.getByRole('button',{name:'Show password',exact:true}).click();
    check(`Admin can find preview password ${width}`, (await page.locator('[data-preview-password]').innerText()) === 'Kw7mQ2p');
    await page.keyboard.press('Escape');
    check(`password action keeps Admin row open ${width}`, await page.getByRole('tab',{name:'Preview',exact:true}).isVisible());
    await page.getByRole('button',{name:'Technical details',exact:true}).click();
    check(`Admin never gets owner Local controls ${width}`, await page.locator('[data-local-details]').count() === 0);
    await page.context().close();
    return;
  }

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

// The review-first, nontechnical path is acceptance behavior, not a visual snapshot assertion.
async function mockEntryChecks(page, width) {
  check(`home offers Review changes rather than an unexplained publish ${width}`, await page.getByRole('button', {name:'Review changes', exact:true}).count() === 1 && await page.getByRole('button', {name:/^Publish/}).count() === 0);
  const review = page.getByRole('button',{name:'Review changes',exact:true});
  if (await review.count()) await review.click();
  else await page.locator('[data-mock-go="app"]').click();
  check(`Preview and Live are the two primary choices ${width}`, await page.getByRole('tab', {name:'Preview',exact:true}).count() === 1 && await page.getByRole('tab', {name:'Live',exact:true}).count() === 1);
  check(`preview password has a named visible control ${width}`, await page.getByRole('button', {name:'Show password',exact:true}).count() === 1);
  check(`Local and GitHub stay out of the default content ${width}`, await page.locator('main').getByText('Local',{exact:true}).count() === 0 && !(await page.locator('main').innerText()).includes('OrgoAI/orgo-brandlord'));
  await page.locator('[data-mock-go="home"]').click();
}

// Driven prototype controls. All publication/restoration stays in this page's sample state.
async function mockInteractionChecks(page, width) {
  const suffix = String(width);
  const pass = page.getByRole('button',{name:'Show password',exact:true});
  await pass.click();
  check(`password is revealed next to its named control ${suffix}`, await page.getByRole('dialog',{name:'Preview password'}).isVisible() && (await page.locator('[data-preview-password]').innerText()) === 'Kw7mQ2p');
  await snap(page,'mock-owner-password',width);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.getByRole('button',{name:'Copy password',exact:true}).click();
  check(`Copy password copies exactly the revealed password ${suffix}`, await page.evaluate(()=>navigator.clipboard.readText()) === 'Kw7mQ2p');
  await page.keyboard.press('Escape');
  check(`Escape closes password and restores focus ${suffix}`, await page.getByRole('dialog',{name:'Preview password'}).count() === 0 && await pass.evaluate(x=>x===document.activeElement));
  const [preview] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link',{name:'Open preview',exact:true}).click()]);
  await preview.waitForLoadState('domcontentloaded');
  check(`Open preview opens the local preview sample ${suffix}`, new URL(preview.url()).pathname === '/your-apps-v4/preview' && await preview.locator('[data-sample-preview]').count() === 1);
  await preview.close();
  await page.getByRole('tab',{name:'Live',exact:true}).click();
  check(`Live switches to the visitor website action ${suffix}`, await page.getByRole('link',{name:'Open website',exact:true}).isVisible() && await page.getByRole('button',{name:'Show password',exact:true}).count() === 0);
  await snap(page,'mock-owner-live',width);
  await page.getByRole('tab',{name:'Preview',exact:true}).click();
  await page.getByRole('button',{name:'About preview and live',exact:true}).click();
  check(`Preview and Live have click-accessible explanations ${suffix}`, (await page.locator('[data-view-help]').innerText()).includes('private review copy'));
  await page.getByRole('button',{name:'About preview and live',exact:true}).click();
  await page.locator('[data-review-publish]').click();
  const confirmation = page.getByRole('group',{name:'Publish this preview?',exact:true});
  check(`publishing names the version and GitHub destination before confirmation ${suffix}`, (await confirmation.innerText()).includes('Updated the home page introduction') && (await confirmation.innerText()).includes('OrgoAI/orgo-brandlord') && (await confirmation.innerText()).includes('may update automatically'));
  await snap(page,'mock-owner-publish-confirmation',width);
  await page.getByRole('button',{name:'Keep reviewing',exact:true}).click();
  check(`cancel keeps changes unpublished ${suffix}`, (await page.locator('[data-review-state]').innerText()) === '1 unpublished change');
  await page.getByRole('button',{name:'Version history',exact:true}).click();
  await page.locator('[data-mock-version]').nth(2).getByRole('button').click();
  check(`Restore says preview and keeps publication separate ${suffix}`, (await page.locator('[data-mock-version]').nth(2).innerText()).includes('Preview') && (await page.locator('[data-review-state]').innerText()) === '1 unpublished change' && await page.locator('[data-review-publish]').isEnabled());
  await snap(page,'mock-owner-restored-preview',width);
  await mockChecks(page,`versions ${width}`);
  await page.getByRole('button',{name:'Technical details',exact:true}).click();
  check(`Local and version IDs remain available in details ${suffix}`, (await page.locator('[data-technical-details]').innerText()).includes('working copy (Local)') && (await page.locator('[data-technical-details]').innerText()).includes('c3c3c3c'));
  await snap(page,'mock-owner-technical-details',width);
  await page.locator('[data-mock-go="app"]').click();
  await page.locator('[data-mock-stage="current"]').click();
  check(`no unpublished changes cannot be republished ${suffix}`, (await page.locator('[data-review-state]').innerText()) === 'Up to date' && await page.locator('[data-review-publish]').isDisabled());
  await snap(page,'mock-owner-up-to-date',width);
  await page.locator('[data-mock-stage="behind"]').click();
  check(`unreviewed work must update preview before publish ${suffix}`, (await page.locator('[data-review-publish]').innerText()) === 'Update preview' && await page.locator('[data-publish-confirmation]').count() === 0);
  await snap(page,'mock-owner-preview-behind',width);
  await page.locator('[data-review-publish]').click();
  check(`Update preview returns to review before publishing ${suffix}`, (await page.locator('[data-review-publish]').innerText()) === 'Publish changes' && await page.locator('[data-publish-confirmation]').count() === 0);
  await page.locator('[data-review-publish]').click();
  await page.getByRole('group',{name:'Publish this preview?',exact:true}).getByRole('button',{name:'Publish changes',exact:true}).click();
  check(`sample publish reports GitHub delivery without claiming website success ${suffix}`, (await page.getByRole('status').innerText()) === 'Preview sent to GitHub' && await page.locator('[data-review-publish]').isDisabled());
  await page.locator('[data-mock-go="home"]').click();
  check(`home reflects published state instead of offering stale changes ${suffix}`, (await page.locator('[data-mock-row]').first().innerText()).includes('Up to date') && await page.getByRole('button',{name:'Review changes',exact:true}).count() === 0);
  await page.locator('[data-mock-stage="ready"]').click();
  await page.locator('[data-mock-go="app"]').click();
}

// Static mock checks only; these do not prove publishing, rollback or request bodies.
async function mockChecks(page, name) {
  const sizes = await page.locator('[data-mock-row]').evaluateAll(xs=>xs.map(x=>x.getBoundingClientRect().height));
  if (sizes.length) check(`mock equal row heights ${name}`, Math.max(...sizes)-Math.min(...sizes)<1);
  const tags = await page.locator('[data-mock-tag]').evaluateAll(xs=>xs.map(x=>x.getBoundingClientRect().x));
  if (tags.length) check(`mock aligned version tags ${name}`, Math.max(...tags)-Math.min(...tags)<1);
  check(`mock content fits ${name}`, await page.locator('main').evaluate(x=>x.scrollWidth<=x.clientWidth));
  check(`mock fixed lucide icons ${name}`, await page.locator('main svg.lucide').evaluateAll(xs=>xs.every(x=>x.getAttribute('width')==='16'&&x.getAttribute('height')==='16'&&x.getAttribute('stroke-width')==='1.5')));
}

/* ---------------- The checks (the page as it is) ---------------- */

async function ownerHomeChecks(page) {
  const list = page.locator("[data-hosted-apps]");
  check("the home says few words per app (each line under 10 words)", (await Promise.all((await page.locator("[data-hosted-app]").all()).map((r) => r.innerText()))).every((t) => words(t) <= 10));
  check("fourcorners: Publish with its dot on, and nothing else", (await page.locator('[data-hosted-app="fourcorners"] [data-next-action="publish"][data-waits]').count()) === 1 && (await page.locator('[data-hosted-app="fourcorners"] [data-next-action="publish"]').innerText()).startsWith("Publish"));
  check("cclc: Not published, quietly", (await page.locator('[data-hosted-app="cclc"] [data-motion="unpublished"]').innerText()).trim() === "Not published" && (await page.locator('[data-hosted-app="cclc"] button[data-next-action]').count()) === 0);
  check("brochure-maker: a spinner and Updating the preview", /Updating the preview/.test(await page.locator('[data-hosted-app="brochure-maker"] [data-motion="working"]').innerText()) && (await page.locator('[data-hosted-app="brochure-maker"] button[data-next-action]').count()) === 0);
  check("no sentences, no Local, Preview and Published lines, no changeset ids on the home", (await list.locator("[data-app-env], [data-state-line]").count()) === 0 && !/[0-9a-f]{7}/.test(await list.innerText()));
  check("the tools the bots made are rows in the same list, saying In Bops", (await page.locator("[data-made-app]").count()) === 2 && (await Promise.all((await page.locator("[data-made-app]").all()).map((r) => r.innerText()))).every((t) => t.includes("In Bops")));
  const heights = await Promise.all((await page.locator("[data-hosted-app], [data-made-app]").all()).map(async (r) => Math.round((await r.boundingBox())?.height ?? 0)));
  check("one row shape: every app's row the same height", heights.length === 5 && heights.every((x) => x === heights[0]));
  const home = await page.locator("[data-made-apps-home]").innerText();
  check("no section labels on the home", !/On the web|Made by your bots/.test(home));
  check("no dashes on the home", !NO_DASHES.test(home));
}

async function ownerAppChecks(page) {
  const tab = page.locator('[data-hosted-tab="fourcorners"]');
  check("the title: Ask the bot, Publish with its dot, Settings; no places in it", ((await tab.locator("[data-work]").getAttribute("aria-label")) ?? "").startsWith("Ask ") && (await tab.locator('[data-next-action="publish"][data-waits]').count()) === 1 && (await tab.locator("[data-tab-settings]").count()) === 1 && (await tab.locator("[data-tab-settings]").locator("xpath=..").locator("[data-place]").count()) === 0);
  check("the app's name is readable in the title (not cut to a few letters)", await tab.locator("[data-app-title]").evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  check("the title says few words (under 12)", words(await tab.locator("[data-tab-settings]").locator("xpath=..").innerText()) <= 12);
  check("Live and Preview as cards, each opening its address", (await tab.locator('[data-places] [data-place="live"] a').getAttribute("href")) === "https://fourcorners.brandlord.agency" && (await tab.locator('[data-places] [data-place="preview"] a').getAttribute("href")) === "https://ggn7sjpkwnz8.orgo.dev");
  const liveSays = await tab.locator('[data-place="live"] [data-place-serving]').innerText();
  const previewSays = await tab.locator('[data-place="preview"] [data-place-serving]').innerText();
  check("each card says which version it serves, in words, no ids", /IMPROVING/.test(liveSays) && /Home line/.test(previewSays) && !/[0-9a-f]{7}/.test(liveSays + previewSays));
  await tab.locator("[data-password-lock]").click();
  await page.waitForTimeout(300);
  check("the lock opens the preview's password", (await tab.locator("[data-password-popover] [data-preview-password]").innerText()).trim() === "Kw7mQ2p");
  await page.keyboard.press("Escape");
  await tab.locator("[data-history]").click({ position: { x: 4, y: 4 } });
  const versions = tab.locator("[data-history]");
  check("Versions: the newest tagged Preview, the one live tagged Live", (await versions.locator('[data-commit] [data-tag="preview"]').count()) === 1 && (await versions.locator('[data-commit] [data-tag="live"]').count()) === 1);
  const tagX = await Promise.all((await versions.locator("[data-commit] [data-tag]").all()).map(async (t) => Math.round((await t.boundingBox())?.x ?? -1)));
  const whenX = await Promise.all((await versions.locator("[data-commit]").all()).map(async (r) => Math.round(((await r.boundingBox())?.x ?? 0) + ((await r.boundingBox())?.width ?? 0))));
  check("the tags sit in one column, and every line ends at the same edge", tagX.length === 2 && tagX[0] === tagX[1] && whenX.every((x) => x === whenX[0]));
  check("no changeset ids or file counts on the lines", !/[0-9a-f]{7}/.test(await versions.innerText()) && !/\+\d/.test(await versions.innerText()));
  check("no blue on the page, no sentence, nothing moving", !(await tab.innerHTML()).includes("#EEF2FF") && (await tab.locator("[data-state-line], [data-motion]").count()) === 0);
  check("no domains, settings or deploys on the versions page", (await tab.locator("[data-domains], [data-settings], [data-deploys], [data-app-envs]").count()) === 0);
  await tab.locator('[data-commit] >> nth=2').hover();
  await page.waitForTimeout(250);
  const restore = tab.locator('[data-commit] >> nth=2').locator("button", { hasText: "Restore" });
  check("an older version offers Restore as it's pointed at", (await restore.count()) === 1 && (await restore.evaluate((b) => getComputedStyle(b.parentElement.parentElement).opacity)) === "1");
  await page.mouse.move(0, 0);
  await restore.focus();
  await page.waitForTimeout(250);
  check("Restore is reached by the keyboard too: focused, it shows", (await restore.evaluate((b) => document.activeElement === b && getComputedStyle(b.parentElement.parentElement).opacity === "1")) === true);
  check("the live version offers Restore too, to put it back on the preview", (await tab.locator('[data-commit][data-serving]').locator("button", { hasText: "Restore" }).count()) === 1);
  // Publish: the dot goes, and the page stays quiet.
  const previewAt = appOf("fourcorners").preview.serving;
  await tab.locator('[data-next-action="publish"]').click();
  await page.waitForTimeout(400);
  // (The exact version: what the sample's Preview served as Publish was pressed, read before the press moved the sample on.)
  check("Publish was sent as a promote of exactly what the preview serves", model.acts.some((x) => x.action === "promote" && x.site === "fourcorners" && x.at === previewAt));
  await page.waitForTimeout(3800);
  check("after Publish, the dot is off and the newest version is Live", (await tab.locator('[data-next-action="publish"][data-waits]').count()) === 0 && (await tab.locator('[data-commit] >> nth=0').locator('[data-tag="live"]').count()) === 1);
  check("and the Live card now says that version", /Home line/.test(await tab.locator('[data-place="live"] [data-place-serving]').innerText()));
  // Ask the bot: its chat beside the tab, the message begun, the tab still showing.
  await tab.locator("[data-work]").click();
  await page.waitForTimeout(500);
  const composer = page.locator("#composer");
  check("Ask the bot: the message box has the ask begun, and the app's tab is still open", /^Change the app/.test((await composer.inputValue().catch(() => "")) ?? "") && (await tab.isVisible()));
  await composer.fill("").catch(() => {});
  check("no dashes on the tab", !NO_DASHES.test(await tab.innerText()));
}

async function ownerSettingsChecks(page) {
  const tab = page.locator('[data-hosted-tab="fourcorners"]');
  check("Settings: Local, Preview and Published, with the Preview picked", (await tab.locator("[data-app-envs]").count()) === 1 && (await tab.locator('[data-app-env="preview"][data-app-env-picked]').count()) === 1);
  check("Settings, Preview picked: its link, password and build settings", (await tab.locator('[data-address-section="preview"]').count()) === 1 && (await tab.locator("[data-password-section]").count()) === 1 && (await tab.locator("[data-settings]").count()) === 1);
  await tab.locator('[data-app-env="preview"] [data-act="deploy"]').click();
  await page.waitForTimeout(400);
  check("Update preview was sent", model.acts.some((x) => x.action === "deploy" && x.env === "preview"));
  await tab.locator("[data-tab-settings]").click();
  await page.waitForTimeout(500);
  check("back on versions while it runs: the Preview card says Updating the preview, and nothing to publish yet", /Updating the preview/.test(await tab.locator('[data-place="preview"] [data-place-serving]').innerText()) && (await tab.locator('[data-next-action="publish"][data-waits]').count()) === 0);
}

async function ownerUnpublishedChecks(page) {
  const tab = page.locator('[data-hosted-tab="cclc"]');
  check("cclc: the Live card says Not published yet and offers Add a domain; no address to open", (await tab.locator('[data-place="live"] [data-place-empty]').innerText()).trim() === "Not published yet" && (await tab.locator('[data-place="live"] [data-place-action]').innerText()).trim() === "Add a domain" && (await tab.locator('[data-place="live"] a').count()) === 0);
  check("cclc: Publish greyed, with why", (await tab.locator('[data-next-action="publish"]').isDisabled()) && !!(await tab.locator('[data-next-action="publish"]').locator("xpath=..").getAttribute("data-tip")));
  await tab.locator('[data-place="live"] [data-place-action]').click();
  await page.waitForTimeout(900);
  await snap(page, "owner-app-add-domain", (await page.viewportSize())?.width ?? 1440);
  const got = [(await tab.locator("[data-app-settings]").count()) === 1, (await tab.locator("[data-add-domain-panel]").count()) === 1, (await tab.locator('[data-tab-settings][aria-pressed="true"]').count()) === 1];
  check(`Add a domain opens Settings with the domain form (settings ${got[0]}, form ${got[1]}, pressed ${got[2]})`, got.every(Boolean));
}

async function samHomeChecks(page) {
  const fc = page.locator('[data-shared-app="fourcorners"]');
  check("sam sees Publish with its dot on fourcorners, as the owner does", (await fc.locator('[data-next-action="publish"][data-waits]').count()) === 1 && (await fc.locator('[data-next-action="publish"]').innerText()).trim() === "Publish");
  check("cclc: Not published; brochure-maker: Updating the preview", (await page.locator('[data-shared-app="cclc"] [data-motion="unpublished"]').count()) === 1 && (await page.locator('[data-shared-app="brochure-maker"] [data-motion="working"]').count()) === 1);
  check("each card says few words (under 10)", (await Promise.all((await page.locator("[data-shared-app]").all()).map((r) => r.innerText()))).every((t) => words(t) <= 10));
  check("no dashes on sam's page", !NO_DASHES.test(await page.locator("[data-shared-apps]").innerText()));
}

async function samOpenChecks(page) {
  const fc = page.locator('[data-shared-app="fourcorners"]');
  check("opened: Live and the Preview as cards, the password behind a lock", (await fc.locator('[data-places] [data-place="preview"] a').getAttribute("href")) === "https://ggn7sjpkwnz8.orgo.dev" && (await fc.locator('[data-places] [data-place="live"] a').getAttribute("href")) === "https://fourcorners.brandlord.agency" && (await fc.locator("[data-password-lock]").count()) === 1);
  await fc.locator("[data-password-lock]").click();
  await page.waitForTimeout(300);
  check("the lock shows the password", (await fc.locator("[data-password-popover] [data-preview-password]").innerText()).trim() === "Kw7mQ2p");
  await page.keyboard.press("Escape");
  check("opened: Versions with Live and Preview tags, no ids", (await fc.locator('[data-tag="live"]').count()) >= 1 && (await fc.locator('[data-tag="preview"]').count()) >= 1 && !/[0-9a-f]{7}/.test(await fc.locator("[data-history], [data-commit]").first().innerText()));
  check("opened: Settings folded (its button says so)", (await fc.locator("[data-fold='settings'] > button[aria-expanded='false']").count()) === 1 && !(await fc.locator('input[aria-label="Port"]').isVisible()));
  await fc.locator("[data-fold='settings'] > button").click();
  check("opened fold: Update preview, earlier deploys, the Port field, a domain to use", (await fc.locator('[data-fold="settings"] [data-act="deploy"]').isVisible()) && (await fc.locator('input[aria-label="Port"]').isVisible()) && (await fc.locator("[data-shared-domain]").isVisible()));
  await fc.locator('[data-next-action="publish"]').click();
  await page.waitForTimeout(400);
  check("sam's Publish went to the owner's Bops as a prod deploy", model.acts.some((x) => x.act === "deploy" && x.env === "prod" && x.app === "fourcorners"));
}

/**
 * The two windows open for a person, at Your Apps, the sample answered behind them (every press moves it on as the checks'
 * do), until the Chrome is closed. Each window is its own, so a Publish pressed as the owner is seen by sam too.
 */
async function hold(browser) {
  const ownerPage = await newPage(browser, WIDTHS[0], "owner");
  await ownerRoutes(ownerPage);
  await ownerPage.goto(urls.owner, { waitUntil: "networkidle" });
  // (A cold dev server compiles the window on its first opening: minutes, not seconds. A window that never shows the
  // button leaves a shot of itself and what the page said, so the reason is seen.)
  const footer = async (page, who) => {
    try {
      await page.locator('[data-footer-key="apps"] button').waitFor({ timeout: 240_000 });
    } catch (e) {
      await page.screenshot({ path: join(OUT, `hold-${who}-no-apps-button.png`) }).catch(() => {});
      console.log(`${who}: no Your Apps button at ${page.url()}; the page says: ${(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400)}`);
      for (const x of errors) console.log(`  ${x}`);
      throw e;
    }
    await page.locator('[data-footer-key="apps"] button').click();
  };
  await footer(ownerPage, "owner");
  const samPage = await newPage(browser, WIDTHS[0], "sam");
  await samRoutes(samPage);
  await samPage.goto(urls.sam, { waitUntil: "networkidle" });
  await samPage.locator("[data-footer-key]").first().waitFor({ timeout: 240_000 });
  // The shared workspace, opened as the switcher opens it: only there does sam have Your Apps.
  const status = await samPage.evaluate((id) => fetch("/api/workspaces/shared", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: id }) }).then((r) => r.status), F.PROJECT.id);
  if (status !== 200) throw new Error(`sam couldn't open the shared workspace: ${status}`);
  await footer(samPage, "sam");
  await ownerPage.bringToFront();
  console.log(`open: the owner's Bops (${urls.owner}) and sam's, an Admin's (${urls.sam}), each at Your Apps. Close that Chrome to end.`);
  await new Promise((resolve) => browser.on("disconnected", resolve));
}

/* ---------------- Run ---------------- */

if (args.includes("--mock") || args.includes("--siblings")) {
  // A gallery import error must stop the run before screenshots can be mistaken for proof.
  const types = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {cwd:root, stdio:"inherit"});
  if (types.status !== 0) process.exit(types.status ?? 1);
  const lint = spawnSync("npx", ["eslint", "app/your-apps-v4/page.tsx", "app/your-apps-v4/references/page.tsx", "app/your-apps-v4/preview/page.tsx"], {cwd:root, stdio:"inherit"});
  if (lint.status !== 0) process.exit(lint.status ?? 1);
  const scope = spawnSync("git", ["diff", "--name-only", "HEAD", "--", "components", "lib"], {cwd:root, encoding:"utf8"});
  if (scope.status !== 0 || scope.stdout.trim()) throw new Error("Mock approval gate: real components or state logic changed before approval.");
  for (const p of ["app/your-apps-v4/page.tsx", "app/your-apps-v4/references/page.tsx", "app/your-apps-v4/preview/page.tsx"]) {
    if (/<svg\b/.test(readFileSync(join(root,p),"utf8"))) throw new Error(`Mock approval gate: handwritten icon in ${p}`);
  }
  console.log("PASS mock approval scope, types, lint and icon source");
}

const browser = await chromium.launch({ channel: "chrome", headless: !HOLD, args: HOLD ? [`--window-size=${WIDTHS[0]},960`] : [] });
try {
  if (HOLD) await hold(browser);
  else for (const width of WIDTHS) {
    // The sample as it was, for each width: a Publish pressed at one width isn't live at the next.
    model.apps = F.hostedApps().apps;
    model.acts = [];
    await owner(browser, width);
    if (!args.includes("--siblings") && !args.includes("--mock-intuition-only")) await sam(browser, width);
  }
} finally {
  await browser.close();
  if (started) spawnSync(process.execPath, [join(root, "scripts", "dev-two-person.mjs"), "stop"], { stdio: "inherit" });
}
for (const e of errors) console.log(`FAIL ${e}`);
if (LOOK) console.log(`shots in ${OUT}${errors.length ? ", with page errors" : ""}`);
else console.log(fails || errors.length ? `${fails} FAIL, ${errors.length} page errors` : "all PASS");
process.exit(fails || errors.length ? 1 : 0);
