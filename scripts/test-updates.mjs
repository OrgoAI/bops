// Tests for new versions got in the app (desktop/updates.cjs, "New versions" in desktop/main.cjs): the
// "Download updates automatically" switch is on unless updates.json says off (a broken file too); with it
// on a newer release starts exactly one download, however often it's found again; with it off it waits
// for the user's Download; a finished download is ready, and a newer release found then downloads again;
// a download that fails because the app can't be replaced sends the user to bops.bot, any other quietly
// waits for the next check (switch on) or offers Try again (switch off); a copy that can't replace itself
// never downloads; BOPS_UPDATE_FEED is taken only on this Mac; and turning the switch on starts the download.
//
// The autoUpdater is a fake (an EventEmitter that counts checkForUpdates), Electron's app a stub, and
// userData a throwaway folder: nothing is fetched or installed.
// Usage: node scripts/test-updates.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

const require = createRequire(import.meta.url);
const { createUpdates, FEED_URL } = require("../desktop/updates.cjs");

const scratch = mkdtempSync(join(tmpdir(), "bops-test-updates-"));
let passed = 0;
const test = (name, f) => {
  f();
  passed++;
  console.log(`ok - ${name}`);
};

/** A fresh updater over its own userData: { u, fake, sent, notes, dir }. */
function make({ inApps = true, execPath = "/Applications/Bops.app/Contents/MacOS/Bops", env = {}, writable = true, unsigned = false, file } = {}) {
  const dir = mkdtempSync(join(scratch, "user-"));
  if (file !== undefined) writeFileSync(join(dir, "updates.json"), file);
  const fake = new EventEmitter();
  fake.checks = 0;
  fake.feeds = [];
  fake.checkForUpdates = () => fake.checks++;
  fake.setFeedURL = (o) => {
    if (unsigned) throw new Error("Could not get code signature for running application");
    fake.feeds.push(o);
  };
  const app = { getPath: () => dir, isInApplicationsFolder: () => inApps };
  // The bundle's write check, without a real Bops.app.
  const accessSync = (p) => {
    if (!writable) throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" });
  };
  const testFs = { ...fs, accessSync };
  const sent = [];
  const notes = [];
  const u = createUpdates({ autoUpdater: fake, app, fs: testFs, path, note: (t) => notes.push(t), send: (s) => sent.push(s), execPath, env });
  return { u, fake, sent, notes, dir };
}
const v91 = { version: "0.0.91", notes: ["Restart to update."] };
const v92 = { version: "0.0.92", notes: [] };

test("the switch is on by default, and with a broken updates.json", () => {
  assert.equal(make().u.auto(), true);
  assert.equal(make({ file: "{not json" }).u.auto(), true);
  assert.equal(make({ file: '{"auto":false}' }).u.auto(), false);
  const { u, dir } = make();
  u.setAuto(false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "updates.json"), "utf8")), { auto: false });
  assert.equal(u.auto(), false);
});

test("switch on: a newer release starts one download, found again or not", () => {
  const { u, fake, sent } = make();
  u.found(v91);
  assert.equal(fake.checks, 1);
  assert.deepEqual(fake.feeds, [{ url: FEED_URL, serverType: "json" }]);
  assert.equal(u.state().phase, "downloading");
  assert.equal(u.state().asked, false);
  u.found(v91);
  u.found(v91);
  u.download("0.0.91");
  assert.equal(fake.checks, 1);
  assert.equal(sent.at(-1).phase, "downloading");
});

test("switch off: it waits for Download", () => {
  const { u, fake } = make({ file: '{"auto":false}' });
  u.found(v91);
  assert.equal(fake.checks, 0);
  assert.deepEqual(u.state(), { phase: "available", version: "0.0.91", notes: v91.notes, asked: false, failed: false });
  u.found(v91);
  assert.equal(fake.checks, 0);
  u.download("0.0.91", { asked: true });
  assert.equal(fake.checks, 1);
  assert.equal(u.state().phase, "downloading");
  assert.equal(u.state().asked, true);
  // A version that isn't the one found is never fetched.
  u.download("0.0.99", { asked: true });
  assert.equal(fake.checks, 1);
});

test("downloaded is ready; a newer release then downloads again and stays ready", () => {
  const { u, fake } = make();
  u.found(v91);
  fake.emit("update-downloaded", {}, "", "Bops 0.0.91");
  assert.equal(u.ready(), true);
  assert.equal(u.state().version, "0.0.91");
  u.found(v91);
  assert.equal(fake.checks, 1);
  u.found(v92);
  assert.equal(fake.checks, 2);
  assert.equal(u.state().phase, "ready");
  assert.equal(u.state().version, "0.0.91");
  u.found(v92);
  assert.equal(fake.checks, 2);
  fake.emit("update-downloaded");
  assert.equal(u.state().version, "0.0.92");
  assert.equal(u.ready(), true);
});

test("a newer release found mid-download goes next", () => {
  const { u, fake } = make();
  u.found(v91);
  u.found(v92);
  assert.equal(fake.checks, 1);
  fake.emit("update-downloaded");
  assert.equal(fake.checks, 2);
  fake.emit("update-downloaded");
  assert.equal(u.state().version, "0.0.92");
});

test("errors: can't write is bops.bot; others quiet (switch on) or Try again (switch off)", () => {
  let m = make();
  m.u.found(v91);
  m.fake.emit("error", new Error("Cannot update while running on a read-only volume"));
  assert.equal(m.u.state().phase, "manual");
  assert.equal(m.u.canSelfUpdate(), false);
  m.u.found(v92);
  assert.equal(m.fake.checks, 1);
  assert.equal(m.u.state().phase, "manual");

  m = make();
  m.u.found(v91);
  m.fake.emit("error", new Error("The request timed out."));
  assert.deepEqual(m.u.state(), { phase: "available", version: "0.0.91", notes: v91.notes, asked: false, failed: false });
  // The next hourly check tries again.
  m.u.found(v91);
  assert.equal(m.fake.checks, 2);

  m = make({ file: '{"auto":false}' });
  m.u.found(v91);
  m.u.download("0.0.91", { asked: true });
  m.fake.emit("error", new Error("Code signature at URL did not pass validation"));
  assert.equal(m.u.state().phase, "available");
  assert.equal(m.u.state().failed, true);
  // Still Try again after the hourly check; Try again downloads.
  m.u.found(v91);
  assert.equal(m.u.state().failed, true);
  assert.equal(m.fake.checks, 1);
  m.u.download("0.0.91", { asked: true });
  assert.equal(m.fake.checks, 2);
  assert.equal(m.u.state().phase, "downloading");
  assert.equal(m.u.state().failed, false);

  // An error with nothing on its way is only logged.
  m = make({ file: '{"auto":false}' });
  m.u.found(v91);
  m.fake.emit("error", new Error("late"));
  assert.equal(m.u.state().failed, false);
});

test("a copy that can't replace itself is bops.bot and never downloads", () => {
  for (const opts of [
    { inApps: false },
    { execPath: "/private/var/folders/x/AppTranslocation/ABC/d/Bops.app/Contents/MacOS/Bops" },
    { execPath: "/Volumes/Bops/Bops.app/Contents/MacOS/Bops" },
    { writable: false },
    { unsigned: true },
  ]) {
    const { u, fake } = make(opts);
    u.found(v91);
    assert.equal(u.state().phase, "manual", JSON.stringify(opts));
    assert.equal(fake.checks, 0);
    assert.equal(u.canSelfUpdate(), false);
  }
});

test("BOPS_UPDATE_FEED: only this Mac's", () => {
  assert.equal(make({ env: { BOPS_UPDATE_FEED: "http://127.0.0.1:8765/latest.json" } }).u.feedUrl(), "http://127.0.0.1:8765/latest.json");
  assert.equal(make({ env: { BOPS_UPDATE_FEED: "http://localhost:9000/x.json" } }).u.feedUrl(), "http://localhost:9000/x.json");
  for (const bad of ["https://evil.example/latest.json", "file:///tmp/latest.json", "http://127.0.0.1.evil.example/x", "not a url"]) {
    const { u, notes } = make({ env: { BOPS_UPDATE_FEED: bad } });
    assert.equal(u.feedUrl(), FEED_URL, bad);
    u.feedUrl();
    assert.equal(notes.filter((n) => n.includes("BOPS_UPDATE_FEED")).length, 1);
  }
});

test("turning the switch on while it's out starts the download", () => {
  const { u, fake } = make({ file: '{"auto":false}' });
  u.found(v91);
  assert.equal(fake.checks, 0);
  assert.deepEqual(u.setAuto(true), { auto: true, canSelfUpdate: true });
  assert.equal(fake.checks, 1);
  assert.equal(u.state().phase, "downloading");
  assert.equal(u.state().asked, false);
});

test("the page hears each change once", () => {
  const { u, fake, sent } = make();
  u.found(v91);
  u.found(v91);
  fake.emit("update-downloaded");
  assert.deepEqual(
    sent.map((s) => s.phase),
    ["available", "downloading", "ready"],
  );
});

rmSync(scratch, { recursive: true, force: true });
console.log(`${passed} passed`);
