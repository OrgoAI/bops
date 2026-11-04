// Tests for the page-script runner (vm/page-script.cjs), which runs a cloud task's page_script on the
// Chrome of its screen (lib/server/computer-task.ts): here, on a headless Chrome of its own with a
// throwaway profile on a spare port. A script fills and submits a form by its label and button, reads a
// page's text, and returns text or JSON; one that doesn't parse, throws, returns nothing or runs too
// long says so. It works on the tab in front of the screen, a tab it opens comes to the front for the
// next one, and its receipt lists the tabs once there are two or more. A file the page downloads is saved
// to the computer's Downloads under the name the site gave it (never over another), and the receipt says
// where. Chrome is still up after every run. Skipped where there's no Chrome.
// Usage: node scripts/test-page-script.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const chrome = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));
if (!chrome) {
  console.log("page script: skipped (no Chrome here; set CHROME_PATH)");
  process.exit(0);
}

// The runner as it sits on a bot's computer: next to the node_modules that hold playwright-core.
const dir = mkdtempSync(join(tmpdir(), "bops-test-page-"));
copyFileSync(join(root, "vm/page-script.cjs"), join(dir, "page-script.cjs"));
symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
// The computer's home (its Downloads) and its temp folder (where Playwright first puts a download), for the runner only.
const home = join(dir, "home");
const tmp = join(dir, "tmp");
mkdirSync(tmp);
const port = 9300 + Math.floor(Math.random() * 600);
const browser = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "profile")}`, "--no-first-run", "--no-default-browser-check", "data:text/html,<title>First</title>one"], { stdio: "ignore" });
const cleanup = () => {
  browser.kill("SIGKILL");
  // Chrome may still be writing its profile as it dies.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};
process.on("exit", cleanup);
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) break;
  assert.ok(i < 60, "Chrome started");
  await new Promise((r) => setTimeout(r, 250));
}

/** Run one script as a task would, and read the line after the marker. */
const run = (script, seconds = 20) => {
  writeFileSync(join(dir, "s.js"), script);
  const out = execFileSync("node", [join(dir, "page-script.cjs"), String(port), String(seconds), join(dir, "s.js")], { encoding: "utf8", env: { ...process.env, HOME: home, TMPDIR: tmp } });
  const at = out.lastIndexOf("@@bops-page@@");
  assert.ok(at >= 0, `the marker is there: ${out}`);
  return JSON.parse(out.slice(at + "@@bops-page@@".length).trim().split("\n")[0]);
};
const alive = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page").length;

// It works on the tab that's open, and returns text as it is.
let r = run("return await page.title()");
assert.deepEqual([r.ok, r.value], [true, "First"]);
assert.equal(r.changed, false, "a read changes nothing, and its receipt says so");
assert.match(r.url, /^data:text\/html,<title>First/);
assert.equal(r.tabs, undefined, "one tab: no list of tabs");

// A form, filled and sent by its label and its button, as a person would; JSON comes back as JSON.
const form = `data:text/html,<title>Form</title><label>Name <input id=n></label><button onclick="document.body.dataset.saved=document.getElementById('n').value">Save</button>`;
r = run(`await page.goto(${JSON.stringify(form)}); await page.getByLabel("Name").fill("Ada"); await page.getByRole("button", { name: "Save" }).click(); return { saved: await page.evaluate(() => document.body.dataset.saved), title: await page.title() };`);
assert.equal(r.ok, true, r.error);
assert.deepEqual(JSON.parse(r.value), { saved: "Ada", title: "Form" });
assert.equal(r.changed, true);
assert.equal(run("return await page.innerText('body')").value, "Name Save", "the next script is on the same tab");

// A tab the script opens comes to the front, and the next script works on it.
r = run(`const p = await context.newPage(); await p.goto("data:text/html,<title>Second</title>two"); return await p.title();`);
assert.deepEqual([r.ok, r.value], [true, "Second"]);
assert.match(r.url, /<title>Second/, "it ended on the new tab");
assert.deepEqual([r.changed, r.opened], [true, 1]);
// Two tabs: the receipt lists both, by title and address, and says which is in front.
assert.deepEqual(
  r.tabs?.map((t) => [t.title, t.front]).sort(),
  [["Form", false], ["Second", true]],
  `the tabs: ${JSON.stringify(r.tabs)}`,
);
assert.match(r.tabs.find((t) => t.front).url, /^data:text\/html,<title>Second/);
assert.equal(run("return await page.title()").value, "Second");
// And a tab brought to the front the same way.
r = run(`for (const p of context.pages()) if ((await p.title()) === "Form") { await p.bringToFront(); return "ok"; } return "no Form tab";`);
assert.equal(r.value, "ok");
assert.equal(run("return await page.title()").value, "Form");

// What went wrong, said plainly.
r = run("await page.title()");
assert.deepEqual([r.ok, r.value], [true, "(The script returned nothing. End it with return and what you need.)"]);
r = run("return ((");
assert.equal(r.ok, false);
assert.match(r.error, /^The script doesn't parse: /);
r = run(`await page.getByRole("button", { name: "Nope" }).click({ timeout: 500 })`);
assert.equal(r.ok, false);
assert.match(r.error, /Timeout 500ms exceeded/);
const t0 = Date.now();
r = run(`await new Promise((r) => setTimeout(r, 10000)); return "late"`, 1);
assert.deepEqual([r.ok, r.error], [false, "The script ran past 1 seconds and was stopped."]);
assert.ok(Date.now() - t0 < 5000, "stopped on time");

// Its receipt: a dialog the page opened (dismissed, so nothing waits on it), and whether anything changed.
const dialog = `data:text/html,<title>Dialog</title><button onclick="alert('Saved!')">Go</button>`;
r = run(`await page.goto(${JSON.stringify(dialog)}); return "there"`);
r = run(`await page.getByRole("button", { name: "Go" }).click(); return "clicked"`);
assert.deepEqual([r.ok, r.changed, r.dialogs], [true, true, ["alert: Saved!"]]);
r = run(`await page.evaluate(() => 1); return "same"`);
assert.deepEqual([r.changed, r.dialogs, r.downloads, r.opened, r.look], [false, [], [], 0, false]);
// A click on something covered says what's on top, and what to do.
const covered = `data:text/html,<title>Covered</title><button>Buy</button><div id=cover style="position:fixed;inset:0;background:white"></div>`;
run(`await page.goto(${JSON.stringify(covered)}); return 1`);
r = run(`await page.getByRole("button", { name: "Buy" }).click({ timeout: 1500 })`);
assert.equal(r.ok, false);
assert.match(r.error, /Something is on top of it \(<div id="cover"[^)]*\): close or dismiss that first, or click it on the screen\./);
// Asking to see the screen.
r = run(`screenshot(); return await page.title()`);
assert.deepEqual([r.value, r.look], ["Covered", true]);

// A file the page downloads: saved to the computer's Downloads under its own name, whether or not the script waited for
// it, and never over one already there; the receipt gives where.
const saved = join(home, "Downloads", "report.csv");
const getFile = `data:text/html,<title>Files</title><a download="report.csv" href="data:text/csv,a%2Cb%0A1%2C2">Get the report</a>`;
run(`await page.goto(${JSON.stringify(getFile)}); return 1`);
r = run(`await page.getByText("Get the report").click(); return "clicked"`);
assert.deepEqual([r.ok, r.downloads], [true, [saved]], r.error);
assert.equal(readFileSync(saved, "utf8"), "a,b\n1,2");
r = run(`const [d] = await Promise.all([page.waitForEvent("download"), page.getByText("Get the report").click()]); return d.suggestedFilename()`);
assert.deepEqual([r.value, r.downloads], ["report.csv", [join(home, "Downloads", "report (1).csv")]]);
assert.equal(readFileSync(saved, "utf8"), "a,b\n1,2", "the first is still there");
// Playwright's own copies in the temp folder are gone once saved (they'd pile up on the computer).
const leftover = readdirSync(tmp).filter((d) => d.startsWith("playwright-artifacts-")).flatMap((d) => readdirSync(join(tmp, d)));
assert.deepEqual(leftover, [], "no download left in the temp folder");

// Chrome is still up, with both tabs: a script disconnects, it never closes the browser.
assert.equal(await alive(), 2);

// No Chrome on that port: it says it couldn't reach it.
writeFileSync(join(dir, "s.js"), "return 1");
const off = execFileSync("node", [join(dir, "page-script.cjs"), "1", "10", join(dir, "s.js")], { encoding: "utf8" });
assert.match(off, /"ok":false,"error":"Couldn't reach the screen's Chrome: /);

console.log("page script: all tests passed");
process.exit(0);
