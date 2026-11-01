// Tests for new versions got in the app (desktop/updates.cjs, "New versions" in desktop/main.cjs): the
// "Download updates automatically" switch is on unless updates.json says off (a broken file too); with it
// on a newer release starts exactly one download, however often it's found again; with it off it waits
// for the user's Download; a finished download is ready, labelled with the version Squirrel staged, and a
// newer release found then waits for the Restart; a download that fails because the app can't be replaced
// sends the user to bops.bot, any other quietly waits for a later check (switch on, backing off, and never
// again for a bad signature) or offers Try again (switch off); a copy that can't replace itself never
// downloads; BOPS_UPDATE_FEED is taken only on this Mac; turning the switch on starts the download; and a
// latest.json naming any zip but this version's on bops.bot isn't downloaded; a download that ran out of
// disk space says so (asked or not), isn't a bad signature or can't write, and the switch waits for room;
// a download the user waited for always says when it didn't finish; and the try after a failed one gets
// a new updater, so Squirrel's cached zip (304, "update-not-available") doesn't leave the user stuck.
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
const { createUpdates, FEED_URL, SPACE_NEEDED } = require("../desktop/updates.cjs");

const scratch = mkdtempSync(join(tmpdir(), "bops-test-updates-"));
let passed = 0;
const test = (name, f) => {
  f();
  passed++;
  console.log(`ok - ${name}`);
};

/** A fresh updater over its own userData: { u, fake, sent, notes, dir }. */
// disk: { free } bytes on the disk Squirrel unpacks to (undefined: can't tell). squirrel: the fake acts
// as Squirrel.Mac does after a failed download (see the top of desktop/updates.cjs): each updater
// (setFeedURL) keeps the zip it fetched, so its next check answers update-not-available at once.
function make({ inApps = true, execPath = "/Applications/Bops.app/Contents/MacOS/Bops", env = {}, writable = true, unsigned = false, file, clock = { t: 0 }, disk = {}, squirrel = false } = {}) {
  const dir = mkdtempSync(join(scratch, "user-"));
  if (file !== undefined) writeFileSync(join(dir, "updates.json"), file);
  const fake = new EventEmitter();
  fake.checks = 0;
  fake.feeds = [];
  fake.cached = false;
  fake.checkForUpdates = () => {
    fake.checks++;
    if (!squirrel) return;
    if (fake.cached) return fake.emit("update-not-available");
    fake.cached = true;
  };
  fake.setFeedURL = (o) => {
    if (unsigned) throw new Error("Could not get code signature for running application");
    fake.feeds.push(o);
    fake.cached = false;
  };
  const app = { getPath: () => dir, isInApplicationsFolder: () => inApps };
  // The bundle's write check, without a real Bops.app.
  const accessSync = (p) => {
    if (!writable) throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" });
  };
  const statfsSync = () => {
    if (disk.free === undefined) throw new Error("ENOENT");
    return { bavail: disk.free / 4096, bsize: 4096 };
  };
  const testFs = { ...fs, accessSync, statfsSync };
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
  assert.deepEqual(u.state(), { phase: "available", version: "0.0.91", notes: v91.notes, asked: false, failed: false, why: "" });
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
  assert.deepEqual(m.u.state(), { phase: "available", version: "0.0.91", notes: v91.notes, asked: false, failed: false, why: "" });
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

// What Squirrel said on a Mac with 1.4 GB free (ditto unpacking), and when even the zip can't be saved.
const DITTO_FULL =
  "ditto: /Users/x/Library/Caches/ai.orgo.bops.ShipIt/update.OrPCGvx/Bops.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/te.lproj/locale.pak: No space left on device\nditto: Couldn't read pkzip signature.";
const ZIP_FULL = "You can’t save the file “Bops-0.0.91-arm64-mac.zip” because there isn’t enough space.: There isn’t enough space. Remove some files from the volume, and then try again.";

test("out of space: says so, asked or not, and the switch waits for room", () => {
  const GB = 1024 ** 3;
  const clock = { t: 0 };
  const disk = { free: 0.5 * GB };
  // The switch got it unasked: still says so, and it's neither a bad signature nor can't write.
  let m = make({ clock, disk });
  m.u.found(v91);
  m.fake.emit("error", new Error(DITTO_FULL));
  assert.deepEqual(m.u.state(), { phase: "available", version: "0.0.91", notes: v91.notes, asked: false, failed: true, why: "space" });
  assert.equal(m.u.canSelfUpdate(), true);
  // Hourly checks while the disk is full: nothing fetched, however long, and it keeps saying why.
  clock.t = 100 * 60 * 60_000;
  m.u.found(v91);
  assert.equal(m.fake.checks, 1);
  assert.equal(m.u.state().why, "space");
  assert.equal(m.u.state().failed, true);
  // Room again: the next check downloads it (a bad signature never would).
  disk.free = SPACE_NEEDED + 1;
  m.u.found(v91);
  assert.equal(m.fake.checks, 2);
  assert.equal(m.u.state().phase, "downloading");
  assert.equal(m.u.state().why, "");

  // The user's Download, switch off, the zip not even saved.
  m = make({ file: '{"auto":false}', disk: { free: 0 } });
  m.u.found(v91);
  m.u.download("0.0.91", { asked: true });
  m.fake.emit("error", new Error(ZIP_FULL));
  assert.equal(m.u.state().phase, "available");
  assert.equal(m.u.state().failed, true);
  assert.equal(m.u.state().why, "space");
  // Try again always tries (the space estimate isn't the user's last word).
  m.u.download("0.0.91", { asked: true });
  assert.equal(m.fake.checks, 2);
  assert.equal(m.u.state().why, "");

  // Can't tell how much is free: the usual back off, not never.
  clock.t = 0;
  m = make({ clock });
  m.u.found(v91);
  m.fake.emit("error", new Error(DITTO_FULL));
  clock.t = 60 * 60_000 + 1;
  m.u.found(v91);
  assert.equal(m.fake.checks, 2);
});

test("out of space with room to spare: the usual waits and MAX_TRIES still hold; a newer release waits for room too", () => {
  const GB = 1024 ** 3;
  const clock = { t: 0 };
  const disk = { free: 3 * GB };
  // Room by the estimate, yet each download still runs out: an hour, then four, then never on its own.
  const m = make({ clock, disk });
  m.u.found(v91);
  m.fake.emit("error", new Error(DITTO_FULL));
  m.u.found(v91);
  assert.equal(m.fake.checks, 1, "not straight away");
  for (const wait of [60 * 60_000, 4 * 60 * 60_000]) {
    clock.t += wait + 1;
    m.u.found(v91);
    m.fake.emit("error", new Error(DITTO_FULL));
  }
  assert.equal(m.fake.checks, 3);
  for (let h = 0; h < 48; h++) {
    clock.t += 60 * 60_000;
    m.u.found(v91);
  }
  assert.equal(m.fake.checks, 3, "never more than MAX_TRIES on its own");
  assert.equal(m.u.state().why, "space");

  // The disk is full and a newer release comes out: it waits for room as well.
  const n = make({ clock: { t: 0 }, disk: { free: 0.5 * GB } });
  n.u.found(v91);
  n.fake.emit("error", new Error(DITTO_FULL));
  n.u.found({ version: "0.0.92", notes: ["Newer."] });
  assert.equal(n.fake.checks, 1, "nothing fetched onto a full disk");
  assert.equal(n.u.state().version, "0.0.92");
  assert.equal(n.u.state().phase, "available");
});

test("a download the user waited for says it didn't finish, switch on too", () => {
  const m = make();
  m.u.found(v91);
  m.u.download("0.0.91", { asked: true });
  m.fake.emit("error", new Error("The request timed out."));
  assert.equal(m.u.state().phase, "available");
  assert.equal(m.u.state().failed, true);
  assert.equal(m.u.state().why, "");
});

test("after a failed download the next try fetches it, not Squirrel's cached zip", () => {
  // As on the Mac: the download ran out of space, then every Download said "nothing to download".
  const { u, fake, sent } = make({ file: '{"auto":false}', squirrel: true });
  u.found(v91);
  u.download("0.0.91", { asked: true });
  fake.emit("error", new Error(DITTO_FULL));
  assert.equal(u.state().why, "space");
  u.download("0.0.91", { asked: true });
  // A new updater, so it's downloading, not back to "is out" at once.
  assert.equal(fake.feeds.length, 2);
  assert.equal(u.state().phase, "downloading");
  assert.equal(sent.at(-1).phase, "downloading");
  fake.emit("update-downloaded", {}, "", "Bops 0.0.91");
  assert.equal(u.state().phase, "ready");

  // The switch's own retry after a failure too; and no new updater when nothing failed.
  const clock = { t: 0 };
  const m = make({ clock, squirrel: true });
  m.u.found(v91);
  assert.equal(m.fake.feeds.length, 1);
  m.fake.emit("error", new Error("The request timed out."));
  clock.t = 60 * 60_000 + 1;
  m.u.found(v91);
  assert.equal(m.fake.feeds.length, 2);
  assert.equal(m.u.state().phase, "downloading");
  m.fake.emit("update-downloaded", {}, "", "Bops 0.0.91");
  m.u.found(v92);
  assert.equal(m.fake.feeds.length, 2);

  // Squirrel answering nothing to download while the user waits says so.
  const n = make({ squirrel: true });
  n.u.found(v91);
  n.u.download("0.0.91", { asked: true });
  n.fake.emit("update-not-available");
  assert.equal(n.u.state().phase, "available");
  assert.equal(n.u.state().failed, true);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`${passed} passed`);
