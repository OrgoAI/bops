import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOUD_BY, RUNNER_EXPOSED, RUNNER_FULL_ACCESS, RUNNER_OWNER_ONLY, type KeeperAsk } from "../protocol.ts";
import { askOf, INSTALLING_STALE_MS, keeperAnswer, type KeeperFacts } from "../runner-keeper.ts";

/**
 * Bops Cloud's answer to a computer's keeper (cloud/runner-keeper.ts keeperAnswer), from the facts the route reads: each
 * reason in the order it's looked at (one that fails two checks is told the first), the halts, the slots per owner and
 * in all, and the soak, and never anything for an owner whose last Mac is older than CLOUD_SELF_MIN_VERSION. And the
 * ask itself (askOf): every field checked, nothing else taken.
 */

const NOW = Date.parse("2026-11-19T12:00:00Z");
const RELEASE = { version: "0.0.56", buildId: "BuildNew_1", stateLevel: 4, releasedAt: NOW - 2 * 3600_000 };

/** A keeper that may update: an older runner there, the release Bops Cloud knows, a Bops computer nobody else uses. */
const ask = (more: Partial<KeeperAsk> = {}): KeeperAsk => ({
  keeper: "1",
  runner: { version: "0.0.55", buildId: "BuildOld_1", up: true },
  latest: { version: RELEASE.version, buildId: RELEASE.buildId },
  busy: false,
  key: false,
  runsOn: "cloud",
  computer: { shared: false, bops: true },
  ...more,
});

/** Facts where everything holds for a staff owner: the answer is update. */
const facts = (more: Partial<KeeperFacts> = {}): KeeperFacts => ({
  now: NOW,
  ask: ask(),
  macVersion: "0.0.55",
  macLevel: 4,
  release: RELEASE,
  record: { status: "running", version: "0.0.55", buildId: "BuildOld_1", by: "mac-1", at: NOW - 86_400_000 },
  hostMac: false,
  workspaces: ["ws_acme"],
  cloudSelf: true,
  team: false,
  staff: true,
  mode: "on",
  claimed: false,
  slots: { owner: 0, all: 0 },
  ownerSlots: 3,
  allSlots: 10,
  halted: false,
  staffUpdated: false,
  soakMin: 60,
  ...more,
});
const why = (f: KeeperFacts) => keeperAnswer(f).why;
const noRunner = (more: Partial<KeeperFacts> = {}) => facts({ ask: ask({ runner: null }), record: null, ...more });

test("everything holds: an older runner is told to update, and a computer with none to install, and when to ask again", () => {
  assert.deepEqual(keeperAnswer(facts()), { do: "update", why: "ok", retryS: 60 });
  assert.deepEqual(keeperAnswer(noRunner()), { do: "install", why: "ok", retryS: 60 });
  assert.deepEqual(Object.keys(keeperAnswer(facts())).sort(), ["do", "retryS", "why"], "never a place, a version or a key");
});

test("an owner whose last Mac is older than CLOUD_SELF_MIN_VERSION (or never said) is told nothing, before anything else", () => {
  for (const macVersion of ["0.0.54", "0.0.9", null]) {
    // Everything else wrong too: still ownerMac, the first look.
    const a = keeperAnswer(facts({ macVersion, ask: ask({ runsOn: "mac", latest: null, key: true }), release: null, hostMac: true, workspaces: [] }));
    assert.equal(a.do, "nothing");
    assert.equal(a.why, "ownerMac", String(macVersion));
  }
  assert.equal(keeperAnswer(facts({ macVersion: "0.1.0" })).do, "update", "a newer Mac is at it");
});

test("each reason in the order it's looked at: a keeper that fails two is told the first", () => {
  // Each step's failure, with every later one failing too: the step's own reason comes back.
  const later: Partial<KeeperFacts> = { hostMac: true, workspaces: [], cloudSelf: false, macLevel: 1, mode: "off", halted: true, claimed: true, slots: { owner: 9, all: 99 } };
  const steps: [string, Partial<KeeperFacts>][] = [
    ["accountMac", { ask: ask({ runsOn: "mac", latest: null }), release: null }],
    ["accountMac", { ask: ask({ runsOn: null }) }],
    ["noRelease", { release: null, record: { status: "stopping" } }],
    ["stale", { ask: ask({ latest: null }), record: { status: "stopping" } }],
    ["stale", { ask: ask({ latest: { version: "0.0.55", buildId: "BuildOld_1" } }), record: { status: "stopping" } }],
    ["stale", { ask: ask({ latest: { version: RELEASE.version, buildId: "BuildOther" } }), record: { status: "stopping" } }],
    ["stopping", { record: { status: "stopping" }, ...later }],
    ["someoneElse", { record: { status: "failed", error: RUNNER_FULL_ACCESS }, ...later }],
    ["someoneElse", { record: { status: "failed", error: RUNNER_OWNER_ONLY }, ...later }],
    ["keptDown", { record: { status: "failed", error: RUNNER_EXPOSED }, ...later }],
    ["keptDown", { record: { status: "failed", error: "a reason nobody named" }, ...later }],
    ["keptDown", { record: { status: "failed" }, ...later }],
    ["macBusy", { record: { status: "installing", by: "mac-1", at: NOW - 60_000 }, ...later }],
    ["macBusy", { record: { status: "running", version: "0.0.55", by: "mac-1", at: NOW - 86_400_000, upgrading: { version: "0.0.56", by: "mac-1", at: NOW - 60_000 } }, ...later }],
    ["botsOnMac", { hostMac: true, workspaces: [], cloudSelf: false, macLevel: 1 }],
    ["noBot", { workspaces: [], ask: ask({ computer: null }) }],
    ["manyWorkspaces", { workspaces: ["ws_acme", "ws_main"], ask: ask({ computer: null }) }],
    ["notCloud", { cloudSelf: false, ask: ask({ computer: null }) }],
    ["notOnMap", { ask: ask({ computer: null, key: true }), macLevel: 1 }],
    ["notOnMap", { ask: ask({ computer: { shared: false, bops: false } }), macLevel: 1 }],
    ["sharedKey", { ask: ask({ key: true, computer: { shared: true, bops: true } }), macLevel: 1, mode: "off" }],
    ["macLevel", { macLevel: 3, mode: "off", halted: true }],
    ["macLevel", { macLevel: null, mode: "off" }],
  ];
  for (const [want, more] of steps) assert.equal(why(facts(more)), want, `${want}: ${JSON.stringify(more).slice(0, 120)}`);
});

test("a Mac setting the runner up long ago, or Bops Cloud's own record, isn't a Mac at it now", () => {
  assert.equal(keeperAnswer(facts({ record: { status: "installing", by: "mac-1", at: NOW - INSTALLING_STALE_MS - 1 } })).do, "update");
  assert.equal(keeperAnswer(facts({ record: { status: "installing", by: CLOUD_BY, at: NOW - 1000 } })).do, "update");
  const upgradedLongAgo = { status: "running", version: "0.0.55", by: "mac-1", at: NOW, upgrading: { version: "0.0.56", by: "mac-1", at: NOW - INSTALLING_STALE_MS - 1 } };
  assert.equal(keeperAnswer(facts({ record: upgradedLongAgo })).do, "update");
  // A failure a runner outlives (its computer didn't answer) is no bar.
  assert.equal(keeperAnswer(facts({ record: { status: "failed", error: "its computer didn't answer", at: NOW - 1000 } })).do, "update");
});

test("a key on a computer someone else can use: Orgo says so, its record says so, or its workspace has members; with no key, any of those is fine", () => {
  for (const more of [{ ask: ask({ key: true, computer: { shared: true, bops: true } }) }, { ask: ask({ key: true }), record: { status: "running", version: "0.0.55", shared: true } }, { ask: ask({ key: true }), team: true }])
    assert.equal(why(facts(more as Partial<KeeperFacts>)), "sharedKey", JSON.stringify(more));
  assert.equal(keeperAnswer(facts({ ask: ask({ key: true }) })).do, "update", "a key on a computer only the owner uses");
  for (const more of [{ ask: ask({ computer: { shared: true, bops: true } }) }, { team: true }, { record: { status: "running", version: "0.0.55", shared: true } }])
    assert.equal(keeperAnswer(facts(more as Partial<KeeperFacts>)).do, "update", `no key: ${JSON.stringify(more)}`);
});

test("never a runner that writes a state newer than the owner's Mac reads", () => {
  assert.equal(why(facts({ macLevel: 3 })), "macLevel");
  assert.equal(why(noRunner({ macLevel: 3 })), "macLevel");
  assert.equal(keeperAnswer(facts({ macLevel: 4 })).do, "update", "the same level");
  assert.equal(keeperAnswer(facts({ macLevel: 9 })).do, "update");
});

test("with no runner: off, then staff only, then the slots, else install; nothing halted, claimed or soaked stops a first one", () => {
  assert.equal(why(noRunner({ mode: "off", slots: { owner: 9, all: 99 } })), "off");
  assert.equal(why(noRunner({ mode: "off", staff: true })), "off");
  assert.equal(why(noRunner({ mode: "staff", staff: false, slots: { owner: 9, all: 99 } })), "staffOnly");
  assert.equal(keeperAnswer(noRunner({ mode: "staff", staff: true })).do, "install");
  assert.equal(why(noRunner({ slots: { owner: 3, all: 0 } })), "slots", "the owner's slots");
  assert.equal(why(noRunner({ slots: { owner: 0, all: 10 } })), "slots", "everyone's");
  assert.equal(keeperAnswer(noRunner({ slots: { owner: 2, all: 9 } })).do, "install", "one left of each");
  assert.deepEqual(keeperAnswer(noRunner({ staff: false, halted: true, claimed: true, release: { ...RELEASE, releasedAt: NOW } })), { do: "install", why: "ok", retryS: 60 });
});

test("with a runner: up to date, then off or staff only, halted, claimed, the slots, the soak, else update", () => {
  // Up to date: the same version (whatever its build) or a newer one, before anything else of these.
  assert.equal(why(facts({ ask: ask({ runner: { version: "0.0.56", buildId: "BuildNew_1", up: true } }), mode: "off", halted: true })), "upToDate");
  assert.equal(why(facts({ ask: ask({ runner: { version: "0.0.56", buildId: "BuildElse", up: false } }) })), "upToDate", "the same version, another build: never");
  assert.equal(why(facts({ ask: ask({ runner: { version: "0.0.57", buildId: "B", up: true } }) })), "upToDate", "never older");
  assert.equal(why(facts({ mode: "off", halted: true, claimed: true })), "off");
  assert.equal(why(facts({ mode: "staff", staff: false, halted: true })), "staffOnly");
  assert.equal(why(facts({ halted: true, claimed: true, slots: { owner: 9, all: 99 } })), "halted");
  assert.equal(why(facts({ claimed: true, slots: { owner: 9, all: 99 } })), "claimed");
  assert.deepEqual(keeperAnswer(facts({ claimed: true })), { do: "nothing", why: "claimed", retryS: 120 }, "asked again soon: the reply ends");
  assert.equal(why(facts({ slots: { owner: 3, all: 0 }, staff: false })), "slots", "per owner");
  assert.equal(why(facts({ slots: { owner: 0, all: 10 } })), "slots", "in all");
  assert.equal(keeperAnswer(facts({ slots: { owner: 2, all: 9 }, ownerSlots: 3, allSlots: 10 })).do, "update");
  assert.equal(why(facts({ slots: { owner: 1, all: 1 }, ownerSlots: 1, allSlots: 10 })), "slots", "BOPS_RUNNER_OWNER_SLOTS");
  assert.equal(why(facts({ slots: { owner: 0, all: 2 }, ownerSlots: 3, allSlots: 2 })), "slots", "BOPS_RUNNER_UPDATE_SLOTS");
});

test("the soak: an owner who isn't staff waits BOPS_RUNNER_SOAK_MIN after the release, then for a staff computer's healthy update to it", () => {
  const fresh = { ...RELEASE, releasedAt: NOW - 10 * 60_000 };
  // 50 minutes left: asked again then.
  assert.deepEqual(keeperAnswer(facts({ staff: false, release: fresh, staffUpdated: true })), { do: "nothing", why: "soak", retryS: 3000 });
  // Clamped: a minute at least, an hour at most.
  assert.equal(keeperAnswer(facts({ staff: false, release: { ...RELEASE, releasedAt: NOW - 60 * 60_000 + 5_000 }, staffUpdated: true })).retryS, 60);
  assert.equal(keeperAnswer(facts({ staff: false, release: { ...RELEASE, releasedAt: NOW }, soakMin: 240, staffUpdated: true })).retryS, 3600);
  // Past it, but no staff computer updated to it yet.
  assert.deepEqual(keeperAnswer(facts({ staff: false })), { do: "nothing", why: "soak", retryS: 900 });
  assert.equal(keeperAnswer(facts({ staff: false, staffUpdated: true })).do, "update");
  // A release whose signing time isn't known: only the staff update.
  assert.equal(keeperAnswer(facts({ staff: false, release: { ...RELEASE, releasedAt: null }, staffUpdated: true })).do, "update");
  // Staff don't soak: they're the first.
  assert.equal(keeperAnswer(facts({ staff: true, release: fresh })).do, "update");
  assert.equal(keeperAnswer(facts({ staff: false, soakMin: 0, staffUpdated: true, release: fresh })).do, "update", "BOPS_RUNNER_SOAK_MIN 0");
});

test("an ask is taken only whole and well formed: every field checked, nothing else in it", () => {
  const good = { ...ask(), off: 1_763_550_000, outcome: { kind: "rolledBack", version: "0.0.56", buildId: "BuildNew_1", why: "it didn't answer on its computer" } };
  assert.deepEqual(askOf(good), good);
  assert.deepEqual(askOf(ask({ runner: null, latest: null, computer: null, runsOn: null })), ask({ runner: null, latest: null, computer: null, runsOn: null }));
  const bad: [string, unknown][] = [
    ["not an object", []],
    ["null", null],
    ["another computer named", { ...ask(), desktopId: "c1c1c1c1-0000-4000-8000-0000000000aa" }],
    ["a place to fetch", { ...ask(), url: "https://example.com/x.tgz" }],
    ["no keeper", { ...ask(), keeper: undefined }],
    ["keeper not a word", { ...ask(), keeper: "1; rm -rf /" }],
    ["busy not a flag", { ...ask(), busy: "no" }],
    ["key not a flag", { ...ask(), key: 1 }],
    ["runsOn", { ...ask(), runsOn: "laptop" }],
    ["runner version", { ...ask(), runner: { version: "0.0.56-rc1", buildId: "B", up: true } }],
    ["runner build", { ...ask(), runner: { version: "0.0.56", buildId: "a/b", up: true } }],
    ["runner up", { ...ask(), runner: { version: "0.0.56", buildId: "B", up: "yes" } }],
    ["runner more", { ...ask(), runner: { version: "0.0.56", buildId: "B", up: true, path: "/tmp" } }],
    ["latest version", { ...ask(), latest: { version: "99", buildId: "B" } }],
    ["latest more", { ...ask(), latest: { version: "0.0.56", buildId: "B", url: "https://example.com" } }],
    ["computer flags", { ...ask(), computer: { shared: "no", bops: true } }],
    ["computer more", { ...ask(), computer: { shared: false, bops: true, id: "x" } }],
    ["off not a time", { ...ask(), off: -1 }],
    ["off text", { ...ask(), off: "1763550000" }],
    ["outcome kind", { ...ask(), outcome: { kind: "deleted", version: "0.0.56", buildId: "B" } }],
    ["outcome version", { ...ask(), outcome: { kind: "updated", version: "latest", buildId: "B" } }],
    ["outcome words", { ...ask(), outcome: { kind: "failed", version: "0.0.56", buildId: "B", why: "<script>x</script>" } }],
    ["outcome long words", { ...ask(), outcome: { kind: "failed", version: "0.0.56", buildId: "B", why: "a".repeat(201) } }],
    ["outcome more", { ...ask(), outcome: { kind: "failed", version: "0.0.56", buildId: "B", body: "x" } }],
  ];
  for (const [what, body] of bad) assert.equal(askOf(body), null, what);
});
