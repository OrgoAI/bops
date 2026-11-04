// End to end, files an Admin adds in a workspace shared with them (lib/server/shared.ts sharedFilesTo, cloud/members.ts
// cleanAct, lib/server/member-acts.ts), on the local two-person stack (scripts/dev-two-person.mjs, sam as Orgo's Admin:
// TWO_PERSON_MEMBER_ROLE=admin; started here when it isn't up, and stopped again after). In headless Chrome, sam opens the
// owner's workspace, adds a PDF and a PNG with the message box's +, and sends them with a few words:
//
// 1. Both are on the bot's computer's Desktop (the stack's stand-in folder), byte for byte: the PNG as a file too, as the
//    owner's bots never see sam's Mac's pictures.
// 2. The owner's Bops has sam's message with both files, each on the bot's own computer (hostId), named as Sam's.
// 3. The bot was told where they are: its answer (the stack's scripted model) names both paths.
// 4. Sam's chat shows the two files under their message, and the bot's answer.
//
// Everything stays on 127.0.0.1. Usage: node scripts/test-shared-files-e2e.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOT, PROJECT, SAM } from "./fixtures/two-person.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(root, ".scratch", "shared-files");
mkdirSync(OUT, { recursive: true });
const { chromium } = await import("playwright");

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
  console.log("starting the two-person stack, sam as an Admin…");
  const r = spawnSync(process.execPath, [join(root, "scripts", "dev-two-person.mjs"), "start"], { stdio: "inherit", env: { ...process.env, TWO_PERSON_MEMBER_ROLE: "admin" } });
  if (r.status !== 0) process.exit(1);
  started = true;
}
const { urls } = running();
const control = async (path) => (await fetch(`${urls.control}${path}`)).json();
assert.equal((await control("/info")).sam, "admin", "this needs sam as an Admin: stop the stack and start it with TWO_PERSON_MEMBER_ROLE=admin");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

// A PDF and a PNG, each with bytes of this run alone.
const tag = randomBytes(4).toString("hex");
const pdf = { name: `Itinerary ${tag}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% two-person ${tag}\n${randomBytes(2048).toString("base64")}\n%%EOF\n`) };
const png = { name: `Hotel ${tag}.png`, mimeType: "image/png", buffer: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(4096)]) };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const words = `Here's the itinerary and the hotel ${tag}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
let passed = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.route(/^(?!(https?|wss?):\/\/127\.0\.0\.1[:/])(?!data:)(?!blob:)/, (r) => r.abort());
  const page = await context.newPage();
  await page.goto(urls.sam, { waitUntil: "load" });
  const opened = await page.evaluate((id) => fetch("/api/workspaces/shared", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: id }) }).then((r) => r.status), PROJECT.id);
  assert.equal(opened, 200);
  await page.reload({ waitUntil: "load" });
  // The bot's chat, from the sidebar.
  await page.getByText(BOT.name, { exact: true }).first().click();
  const plus = page.getByRole("button", { name: "Add images or files" });
  await plus.waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(OUT, "1-box.png") });

  await page.locator('input[type="file"]').first().setInputFiles([pdf, png]);
  await page.locator("#composer").fill(words);
  await page.locator("#composer").press("Enter");

  // 1. On the bot's computer's Desktop, byte for byte.
  const desktop = await until(async () => {
    const { files } = await control("/computer/desktop");
    return files.filter((f) => f.name.includes(tag)).length === 2 && files;
  }, "both files on the bot's Desktop", 30_000);
  for (const f of [pdf, png]) {
    const on = desktop.find((x) => x.name === f.name);
    assert.ok(on, `${f.name} is on the Desktop`);
    assert.deepEqual([on.size, on.sha256], [f.buffer.length, sha(f.buffer)], `${f.name}'s bytes`);
  }
  passed++;
  console.log(`ok - 1. both files are on ${BOT.name}'s computer's Desktop, byte for byte (the PNG as a file)`);

  // 2. The owner's Bops has the message, with both files on the bot's own computer, named as Sam's.
  const mine = await until(async () => {
    const s = await (await fetch(`${urls.owner}/api/state`)).json();
    const st = s.state ?? s;
    return st.messages?.find((m) => m.role === "user" && m.text === words);
  }, "sam's message in the owner's Bops", 30_000);
  assert.equal(mine.member?.name, SAM.name);
  assert.deepEqual(
    mine.files.map((f) => [f.name, f.path, f.size, f.botId, f.hostId, f.hostName]),
    [pdf, png].map((f) => [f.name, `~/Desktop/${f.name}`, f.buffer.length, BOT.id, BOT.id, BOT.name]),
  );
  passed++;
  console.log("ok - 2. the owner's Bops has sam's message with both files, each on the bot's own computer");

  // 3. The bot was told where they are.
  const reply = await until(async () => {
    const s = await (await fetch(`${urls.owner}/api/state`)).json();
    const st = s.state ?? s;
    return st.messages?.find((m) => m.role === "bot" && m.at >= mine.at && /I have them on my Desktop/.test(m.text));
  }, "the bot's answer", 60_000);
  for (const f of [pdf, png]) assert.ok(reply.text.includes(`~/Desktop/${f.name}`), `the answer names ${f.name}: ${reply.text}`);
  passed++;
  console.log(`ok - 3. the bot was told where they are: "${reply.text}"`);

  // 4. Sam's chat shows the files under their message, and the answer.
  await page.getByText("I have them on my Desktop", { exact: false }).last().waitFor({ timeout: 20_000 });
  for (const f of [pdf, png]) assert.ok((await page.getByText(f.name, { exact: true }).count()) > 0, `sam sees ${f.name}`);
  await page.screenshot({ path: join(OUT, "2-sent.png") });
  passed++;
  console.log(`ok - 4. sam's chat shows both files and the answer (${join(OUT, "2-sent.png")})`);
} finally {
  await browser.close();
  if (started) spawnSync(process.execPath, [join(root, "scripts", "dev-two-person.mjs"), "stop"], { stdio: "inherit" });
}
console.log(`\n${passed} passed, 0 failed`);
