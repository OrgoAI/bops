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
/** Which of the sample's apps use keys from Keys (app-key-links.tsx reads it in Settings): none, nothing to change. The stack's own server has no apps open to answer it. */
const noKeyLinks = (page) => page.route((u) => u.pathname === "/api/keys/apps", (route) => json(route, { links: [], can: { every: false, app: false } }));

/** The owner's window: its state as Orgo's team with the sample apps in it, and every Your Apps route answered from the sample. */
async function ownerRoutes(page) {
  await noKeyLinks(page);
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
    if (part === "settings") { if (req.method() !== "GET") model.acts.push(body); return json(route, req.method() === "GET" ? F.settings(name, env) : { ...F.settings(name, body.env), said: "Saved." }); }
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
  await noKeyLinks(page);
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
  await page.evaluate(() => document.fonts.ready);
  shot++;
  const file = `${PREFIX}-${String(shot).padStart(2, "0")}-${screen}${width === 1440 ? "" : `-${width}`}.png`;
  await page.screenshot({ path: join(OUT, file), animations: "disabled" });
  console.log(`shot ${file}`);
};

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


const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function refresh(page) { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(500); }
async function click(page, name) { await page.getByRole('button',{name,exact:true}).click(); await (page.page?.() ?? page).waitForTimeout(250); }
const attention = locator => locator.evaluate(x=>getComputedStyle(x).backgroundColor==='rgb(233, 255, 59)');
async function layout(page, root, name) {
  check(`content fits ${name}`, await root.evaluate(x=>x.scrollWidth<=x.clientWidth));
  const heights=await root.locator('[data-hosted-app], [data-made-app]').evaluateAll(xs=>xs.map(x=>x.getBoundingClientRect().height));
  if(heights.length) check(`every home row has the same height ${name}`, heights.length===5 && Math.max(...heights)-Math.min(...heights)<1);
  const tags=await root.locator('[data-version-tag]').evaluateAll(xs=>xs.filter(x=>x.checkVisibility()).map(x=>x.getBoundingClientRect().x));
  if(tags.length) check(`version tag columns align ${name}`, Math.max(...tags)-Math.min(...tags)<1);
}
async function owner(browser,width) {
  const page=await newPage(browser,width,'owner');
  await ownerRoutes(page);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:urls.owner});
  await page.context().route(F.FC.preview, r=>r.fulfill({contentType:'text/html',body:'<h1>Sample preview</h1>'}));
  await page.goto(urls.owner,{waitUntil:'networkidle'});
  await page.locator('[data-footer-key="apps"] button').click({timeout:60000});
  const home=page.locator('[data-hosted-apps]');
  await home.locator('[data-hosted-app="fourcorners"]').waitFor();
  await snap(page,'owner-home',width);
  if(!LOOK) {
    check(`home leads to review before publishing ${width}`, await home.getByRole('button',{name:'Review changes',exact:true}).count()===1 && !/Publish changes|Local|On the web/.test(await home.innerText()));
    check(`home highlights the pending review ${width}`,await attention(home.getByRole('button',{name:'Review changes',exact:true})));
    check(`home has five rows including tools ${width}`, await home.locator('[data-made-app]').count()===2);
    await layout(page,home,`home ${width}`);
  }
  await home.locator('[data-hosted-app="fourcorners"] button').first().click();
  const tab=page.locator('[data-hosted-tab="fourcorners"]');
  await tab.locator('[data-review-content]').waitFor();
  await tab.getByText(F.COMMITS.fourcorners[0].message,{exact:true}).first().waitFor();
  await snap(page,'owner-app',width);
  if(!LOOK) {
    check(`pending preview has an accurate highlighted count ${width}`,await tab.locator('[data-review-state]').innerText()==='1 unpublished change' && await attention(tab.locator('[data-review-state]')));
    const review=tab.getByRole('link',{name:'Review preview',exact:true});
    check(`Review preview is the highlighted next action ${width}`,await attention(review));
    if(width===1180) {
      const r=await review.boundingBox(), publish=await tab.locator('[data-review-publish]').boundingBox();
      check(`narrow Publish stays left aligned on its second line ${width}`,Math.abs(r.x-publish.x)<1 && publish.y>r.y);
    }
    check(`default view hides Local and version history ${width}`, await tab.getByRole('tab',{name:'Preview',exact:true}).getAttribute('aria-selected')==='true' && await tab.locator('[data-app-env]').count()===0 && await tab.locator('[data-version]').count()===0);
    await click(tab,'Ask Boppy');
    check(`Ask Boppy keeps the app beside an unsent draft ${width}`,await tab.isVisible() && (await page.locator('#composer').evaluate(x=>x.value ?? x.textContent)).includes('fourcorners'));
    await page.locator('#composer').fill('');

    await click(tab,'Show password');
    check(`password reveals the current value ${width}`, await tab.locator('[data-password-popover] [data-preview-password]').innerText()===F.FC.password);
    await click(tab,'Copy password');
    check(`copy contains exactly the preview password ${width}`, await page.evaluate(()=>navigator.clipboard.readText())===F.FC.password);
    await snap(page,'owner-password',width);
    await page.keyboard.press('Escape');
    check(`Escape closes password and restores focus ${width}`, await tab.locator('[data-password-popover]').count()===0 && await tab.getByRole('button',{name:'Show password',exact:true}).evaluate(x=>x===document.activeElement));
    const popup=page.waitForEvent('popup');
    await tab.getByRole('link',{name:'Review preview',exact:true}).click();
    const preview=await popup; await preview.waitForLoadState();
    check(`Review preview opens the reviewed address ${width}`, preview.url()===F.FC.preview+'/' && await preview.getByRole('heading',{name:'Sample preview'}).count()===1); await preview.close();
    await tab.getByRole('tab',{name:'Live',exact:true}).click();
    check(`Live links to the website and labels GitHub delivery honestly ${width}`, await tab.getByRole('link',{name:'Open website',exact:true}).getAttribute('href')===`https://${F.FC.domain}` && await tab.getByText('Sent to GitHub',{exact:true}).count()===1);
    await tab.getByRole('tab',{name:'Preview',exact:true}).click();
    await tab.getByRole('button',{name:'About preview and live',exact:true}).click();
    check(`explanation works on click ${width}`, await tab.locator('[data-view-help]').isVisible());
    await tab.getByRole('button',{name:'About preview and live',exact:true}).click();
    const n=model.acts.length;
    await click(tab,'Publish changes');
    const confirm=tab.locator('[data-publish-confirmation]');
    check(`confirmation names version and destination before any request ${width}`, (await confirm.innerText()).includes(F.COMMITS.fourcorners[0].message) && (await confirm.innerText()).includes('OrgoAI/orgo-brandlord') && (await confirm.innerText()).includes('may update automatically') && model.acts.length===n);
    check(`confirmation quiets the previous review action ${width}`,!await attention(tab.getByRole('link',{name:'Review preview',exact:true})));
    await snap(page,'owner-publish-confirmation',width);
    await click(confirm,'Keep reviewing');
    check(`cancel preserves unpublished changes ${width}`,model.acts.length===n && await tab.locator('[data-review-publish]').isEnabled());
    check(`cancel restores the review emphasis ${width}`,await attention(tab.getByRole('link',{name:'Review preview',exact:true})));
    await click(tab,'Publish changes');
    appOf('fourcorners').preview.serving=F.id('c3'); await refresh(page);
    check(`a moved preview cannot publish an unseen version ${width}`,await tab.locator('[data-publish-confirmation]').getByRole('button',{name:'Publish changes',exact:true}).isDisabled() && model.acts.length===n);
    await click(tab.locator('[data-publish-confirmation]'),'Keep reviewing');
    appOf('fourcorners').preview.serving=F.FC.head; await refresh(page);

    await click(tab,'Version history'); await tab.locator('[data-version]').first().waitFor();
    await layout(page,tab,`versions ${width}`); await snap(page,'owner-versions',width);
    await tab.locator('[data-version]').nth(2).getByRole('button',{name:/Restore/}).click();
    check(`restore sends the original preview request ${width}`,same(model.acts.at(-1),{ws:'ws_main',action:'deploy',env:'preview',at:F.id('c3')}));
    await page.waitForTimeout(1900); await refresh(page);
    check(`an older preview remains publishable ${width}`,await tab.locator('[data-review-publish]').innerText()==='Publish changes' && await tab.locator('[data-review-publish]').isEnabled());
    await tab.locator('[data-version]').first().getByRole('button',{name:/Restore/}).click();
    await page.waitForTimeout(1900); await refresh(page);
    await click(tab,'Publish changes'); await click(tab.locator('[data-publish-confirmation]'),'Publish changes');
    check(`publish keeps the exact preview-pinned request ${width}`,same(model.acts.at(-1),{ws:'ws_main',action:'promote',site:'fourcorners',at:F.FC.head}));
    await refresh(page);
    check(`published preview no longer offers new changes ${width}`,await tab.locator('[data-review-state]').innerText()==='Up to date' && await tab.locator('[data-review-publish]').isDisabled());
    check(`up-to-date preview is quiet again ${width}`,!await attention(tab.locator('[data-review-state]')) && !await attention(tab.getByRole('link',{name:'Open preview',exact:true})));
    await click(tab,'Technical details');
    check(`technical details retain Local and GitHub menu ${width}`,await tab.locator('[data-app-env="local"]').count()===1 && await tab.locator('[data-prod-menu]').isVisible());
    await tab.locator('[data-prod-menu]').click(); await tab.locator('[data-gh-pull]').click();
    check(`GitHub pull retains its request ${width}`,same(model.acts.at(-1),{ws:'ws_main',action:'githubPull'}));
    await tab.locator('[data-app-env="local"] [data-act="local-start"]').click();
    check(`local start retains its request ${width}`,same(model.acts.at(-1),{ws:'ws_main',action:'start'}));
    await snap(page,'owner-technical-details',width);
  }
  await click(tab,'Settings');
  await snap(page,'owner-settings',width);
  await click(tab,'Technical settings');
  const settings=tab.locator('[data-settings]'); await settings.waitFor();
  await snap(page,'owner-technical-settings',width);
  if(!LOOK) {
    await settings.getByRole('textbox',{name:'Build command',exact:true}).fill('npm run build:site');
    await settings.getByRole('button',{name:'Save',exact:true}).click();
    check(`preview settings retain the selected environment ${width}`,same(model.acts.at(-1),{ws:'ws_main',env:'preview',build:'npm run build:site'}));
  }
  await click(tab,'Back to Your Apps');
  await home.locator('[data-hosted-app="cclc"] button').first().click();
  const cclc=page.locator('[data-hosted-tab="cclc"]');
  await cclc.locator('[data-review-content]').waitFor();
  await snap(page,'owner-unpublished',width);
  await click(cclc,'Add a domain');
  check(`Add a domain opens the existing form ${width}`,await cclc.locator('[data-add-domain-panel]').count()===1 || await cclc.getByText('Add a domain',{exact:true}).count()>0);
  await snap(page,'owner-domain-settings',width);
  await page.context().close();
}

async function sam(browser,width) {
  const page=await newPage(browser,width,'sam'); await samRoutes(page);
  await page.goto(urls.sam,{waitUntil:'networkidle'});
  await page.locator('[data-footer-key]').first().waitFor({timeout:60000});
  const status=await page.evaluate(id=>fetch('/api/workspaces/shared',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({open:id})}).then(r=>r.status),F.PROJECT.id);
  if(status!==200) throw new Error(`sam shared workspace: ${status}`);
  await page.locator('[data-footer-key="apps"] button').click();
  const fc=page.locator('[data-shared-app="fourcorners"]'); await fc.waitFor(); await snap(page,'admin-home',width);
  if(!LOOK) check(`Admin home opens review without publishing ${width}`,await fc.getByRole('button',{name:'Review changes',exact:true}).count()===1 && await fc.locator('[data-review-content]').count()===0);
  if(!LOOK) check(`Admin home highlights pending review ${width}`,await attention(fc.getByRole('button',{name:'Review changes',exact:true})));
  await fc.getByRole('button',{name:'Open fourcorners',exact:true}).click();
  await fc.locator('[data-review-content]').waitFor(); await snap(page,'admin-open',width);
  if(!LOOK) {
    check(`Admin shares the highlighted preview decision ${width}`,await attention(fc.locator('[data-review-state]')) && await attention(fc.getByRole('link',{name:'Review preview',exact:true})));
    check(`Admin sees Preview and Live without Local ${width}`,await fc.getByRole('tab').count()===2 && !/Local/.test(await fc.innerText()));
    await click(fc,'Show password'); check(`Admin can find preview password ${width}`,await fc.locator('[data-password-popover] [data-preview-password]').innerText()===F.FC.password); await page.keyboard.press('Escape');
    await click(fc,'Version history'); await layout(page,fc,`Admin versions ${width}`); await snap(page,'admin-versions',width);
    await fc.locator('[data-version]').nth(2).getByRole('button',{name:/Restore/}).click();
    check(`Admin restore keeps its request ${width}`,same(model.acts.at(-1),{act:'deploy',app:'fourcorners',at:F.id('c3')}));
    check(`Admin keeps Update preview beside Publish ${width}`,await fc.locator('[data-review-update]').isEnabled() && await fc.locator('[data-review-publish]').innerText()==='Publish changes');
    const n=model.acts.length; await click(fc,'Publish changes');
    check(`Admin publishing asks before sending ${width}`,model.acts.length===n && await fc.locator('[data-publish-confirmation]').count()===1);
    const said=await fc.locator('[data-publish-confirmation]').innerText();
    check(`Admin confirmation says where Publish goes ${width}`,said.includes('Publish sends it to GitHub (OrgoAI/orgo-brandlord, main), where its own deploy puts it live.') && said.includes('OrgoAI/orgo-brandlord · main'));
    check(`Admin confirmation quiets review ${width}`,!await attention(fc.getByRole('link',{name:'Review preview',exact:true})));
    await click(fc.locator('[data-publish-confirmation]'),'Publish changes');
    check(`Admin Publish keeps its original pinned request ${width}`,same(model.acts.at(-1),{act:'deploy',app:'fourcorners',env:'prod',at:F.FC.head}));
    await click(fc,'Technical details'); await click(fc,'Settings'); await snap(page,'admin-settings',width);
    const port=fc.getByRole('textbox',{name:'Port',exact:true}); await port.fill('3001'); await click(fc,'Save');
    check(`Admin settings keep the original site body ${width}`,same(model.acts.at(-1),{act:'settings',app:'fourcorners',port:3001}));
    check(`Admin never receives Local controls ${width}`,await fc.locator('[data-app-env="local"]').count()===0);
  }
  await page.context().close();
}

const browser=await chromium.launch({channel:'chrome',headless:!HOLD,args:HOLD?[`--window-size=${WIDTHS[0]},960`]:[]});
try {
  if(HOLD) await hold(browser);
  else for(const width of WIDTHS) {
    model.apps=F.hostedApps().apps; model.acts=[];
    await owner(browser,width); await sam(browser,width);
  }
} finally {
  await browser.close();
  if(started) spawnSync(process.execPath,[join(root,'scripts','dev-two-person.mjs'),'stop'],{stdio:'inherit'});
}
for(const error of errors) console.log(`FAIL ${error}`);
console.log(fails||errors.length?`${fails} FAIL, ${errors.length} page errors`:'all PASS');
process.exit(fails||errors.length?1:0);
