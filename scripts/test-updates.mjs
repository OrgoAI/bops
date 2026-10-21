// Tests for new versions got in the app (desktop/updates.cjs, "New versions" in desktop/main.cjs): the
// "Download updates automatically" switch is on unless updates.json says off (a broken file too); with it
// on a newer release starts exactly one download, however often it's found again; with it off it waits
// for the user's Download; a finished download is ready, labelled with the version Squirrel staged, and a
// newer release found then waits for the Restart; a download that fails because the app can't be replaced
// sends the user to bops.bot, any other quietly waits for a later check (switch on, backing off, and never
// again for a bad signature) or offers Try again (switch off); a copy that can't replace itself never
// downloads; BOPS_UPDATE_FEED is taken only on this Mac; turning the switch on starts the download; and a
// latest.json naming any zip but this version's on bops.bot isn't downloaded.
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
function make({ inApps = true, execPath = "/Applications/Bops.app/Contents/MacOS/Bops", env = {}, writable = true, unsigned = false, file, clock = { t: 0 } } = {}) {
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
  const u = createUpdates({ autoUpdater: fake, app, fs: testFs, path, note: (t) => notes.push(t), send: (s) => sent.push(s), execPath, env, now: () => clock.t });
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
  // Never "is out" first: the notice doesn't flash it.
  assert.ok(!sent.some((s) => s.phase === "available"));
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

test("downloaded is ready; a newer release then waits for the Restart", () => {
  const { u, fake } = make();
  u.found(v91);
  fake.emit("update-downloaded", {}, "", "Bops 0.0.91");
  assert.equal(u.ready(), true);
  assert.equal(u.state().version, "0.0.91");
  u.found(v91);
  u.found(v92);
  u.found(v92);
  assert.equal(fake.checks, 1);
  assert.equal(u.state().phase, "ready");
  assert.equal(u.state().version, "0.0.91");
});

test("ready says the version Squirrel staged, a newer one than asked too", () => {
  const { u, fake } = make();
  u.found(v91);
  // A release came out between main.cjs' check and Squirrel's own read of latest.json.
  fake.emit("update-downloaded", {}, "", "0.0.92");
  assert.equal(u.state().version, "0.0.92");
  assert.deepEqual(u.state().notes, []);
  u.found(v92);
  assert.equal(fake.checks, 1);
  assert.equal(u.state().phase, "ready");
});

test("a newer release found mid-download isn't fetched while the first is staged", () => {
  const { u, fake } = make();
  u.found(v91);
  u.found(v92);
  assert.equal(fake.checks, 1);
  fake.emit("update-downloaded");
  assert.equal(fake.checks, 1);
  assert.equal(u.state().version, "0.0.91");
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

  const clock = { t: 0 };
  m = make({ clock });
  m.u.found(v91);
  m.fake.emit("error", new Error("The request timed out."));
  assert.deepEqual(m.u.state(), { phase: "available", version: "0.0.91", notes: v91.notes, asked: false, failed: false });
  // A check over an hour later tries again.
  clock.t = 60 * 60_000 + 1;
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

  // Try again from the user skips the wait (below) too.
  m = make();
  m.u.found(v91);
  m.fake.emit("error", new Error("Code signature at URL did not pass validation"));
  m.u.download("0.0.91", { asked: true });
  assert.equal(m.fake.checks, 2);

  // An error with nothing on its way is only logged.
  m = make({ file: '{"auto":false}' });
  m.u.found(v91);
  m.fake.emit("error", new Error("late"));
  assert.equal(m.u.state().failed, false);
});

test("switch on: a download that keeps failing backs off, and a bad signature isn't tried again", () => {
  const clock = { t: 0 };
  const hour = 60 * 60_000;
  let m = make({ clock });
  m.u.found(v91);
  m.fake.emit("error", new Error("The request timed out."));
  // Within the hour: left alone. After it: tried again.
  clock.t = hour - 1;
  m.u.found(v91);
  assert.equal(m.fake.checks, 1);
  assert.equal(m.u.state().phase, "available");
  clock.t = hour + 1;
  m.u.found(v91);
  assert.equal(m.fake.checks, 2);
  m.fake.emit("error", new Error("The request timed out."));
  // Then 4 hours.
  clock.t += 3 * hour;
  m.u.found(v91);
  assert.equal(m.fake.checks, 2);
  clock.t += hour + 1;
  m.u.found(v91);
  assert.equal(m.fake.checks, 3);
  m.fake.emit("error", new Error("The request timed out."));
  // After the third: not again for this version.
  clock.t += 100 * hour;
  m.u.found(v91);
  assert.equal(m.fake.checks, 3);
  // A newer version is tried at once.
  m.u.found(v92);
  assert.equal(m.fake.checks, 4);

  clock.t = 0;
  m = make({ clock });
  m.u.found(v91);
  m.fake.emit("error", new Error("Code signature at URL did not pass validation: code failed to satisfy specified code requirement(s)"));
  clock.t = 1000 * hour;
  m.u.found(v91);
  assert.equal(m.fake.checks, 1);
});

test("latest.json must name this version's zip on bops.bot", () => {
  const file = (v, url, current = v) => ({ version: v, currentRelease: current, releases: [{ version: v, updateTo: { version: v, url } }] });
  const { u } = make();
  assert.equal(u.offers(file("0.0.91", "https://bops.bot/download/Bops-0.0.91-arm64-mac.zip"), "0.0.91"), "");
  for (const bad of [
    file("0.0.91", "http://bops.bot/download/Bops-0.0.91-arm64-mac.zip"),
    file("0.0.91", "https://evil.example/download/Bops-0.0.91-arm64-mac.zip"),
    file("0.0.91", "https://bops.bot/download/Bops-0.0.80-arm64-mac.zip"),
    file("0.0.91", "https://bops.bot/download/Bops-0.0.91-arm64-mac.zip", "0.0.80"),
    { version: "0.0.91" },
  ])
    assert.notEqual(u.offers(bad, "0.0.91"), "", JSON.stringify(bad));
  // A test feed on this Mac may name a zip on the same host, over http.
  const t = make({ env: { BOPS_UPDATE_FEED: "http://127.0.0.1:8765/latest.json" } }).u;
  assert.equal(t.offers(file("0.0.91", "http://127.0.0.1:8765/Bops-0.0.91-arm64-mac.zip"), "0.0.91"), "");
  assert.notEqual(t.offers(file("0.0.91", "http://127.0.0.1:9999/Bops-0.0.91-arm64-mac.zip"), "0.0.91"), "");
  // One that's wrong is bops.bot, and nothing's fetched.
  const m = make();
  m.u.manual(v91, "its zip isn't bops.bot's");
  assert.equal(m.u.state().phase, "manual");
  assert.equal(m.fake.checks, 0);
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
    ["downloading", "ready"],
  );
});

rmSync(scratch, { recursive: true, force: true });
console.log(`${passed} passed`);
