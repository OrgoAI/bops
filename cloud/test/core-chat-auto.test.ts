import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "../db.ts";
import type { CloudDoes } from "../protocol.ts";
import { AUTO_HOLD_MS, autoMoves, chatAutoFor, cloudDoesFor, keepChatOn, mirrorOf, resetTurns, troubleGoes, wholeOnComputers, type AutoSeen, type RoutingRow } from "../turns.ts";

/**
 * Chat through Bops Cloud by itself (turns.ts autoMoves, keepChatOn, chatAutoFor), with no database: a workspace nobody
 * chose for moves to Bops Cloud once every computer its bots work on has a runner the Mac saw running at a Bops new
 * enough, which connected since Bops Cloud started and since its computer last couldn't answer; back to the Mac when
 * one can't answer, has no runner, or its runner failed; never one the owner or staff chose, either way.
 */

after(closeDb);

const D1 = "d1d1d1d1-0000-4000-8000-0000000000aa";
const D2 = "d2d2d2d2-0000-4000-8000-0000000000bb";
const NOW = 1_800_000_000_000;

const running = (version = "0.0.37", more: Record<string, unknown> = {}) => ({ status: "running", version, buildId: "b", by: "mac", at: 1, ...more });
/** An owner's state: Acme's main bot Max on D1 (with Dana on it too), Zed on the Mac, Rex in Beta on D2. */
const blob = (runners: Record<string, unknown> = { [D1.toUpperCase()]: running(), [D2]: running() }, more: Record<string, unknown>[] = []) => ({
  workspaces: [{ id: "ws_main" }, { id: "ws_acme" }, { id: "ws_beta" }],
  bots: [
    { id: "boppy", isMain: true },
    { id: "max", isMain: true, workspaceId: "ws_acme", computerId: D1.toUpperCase() },
    { id: "dana", workspaceId: "ws_acme" },
    { id: "zed", workspaceId: "ws_acme", runsOn: "mac" },
    { id: "rex", isMain: true, workspaceId: "ws_beta", computerId: D2 },
    ...more,
  ],
  runners,
});
const seen = (o: Partial<AutoSeen> & { live?: string[]; at?: number; version?: string } = {}): AutoSeen => ({
  on: true,
  appOk: true,
  proved: (c) => (o.live ?? [D1, D2]).includes(c) ? { version: o.version ?? "0.0.37", at: o.at ?? NOW - 1000 } : undefined,
  broken: () => undefined,
  now: NOW,
  ...o,
});
const row = (mode: "mac" | "cloud", setBy: string | null, setAt = NOW - 1000): RoutingRow => ({ mode, setBy, setAt });
const rows = (r: Record<string, RoutingRow> = {}) => new Map(Object.entries(r));
const moves = (b: Record<string, unknown>, r: Map<string, RoutingRow>, s: AutoSeen) => autoMoves(b, r, s).map((m) => `${m.wsId}:${m.mode}${m.hold ? ":held" : ""}`);

test("a workspace nobody chose for moves to Bops Cloud once every computer of its bots has a runner that answers", () => {
  assert.deepEqual(moves(blob(), rows(), seen()), ["ws_acme:cloud", "ws_beta:cloud"]);
  // Its row says nobody chose (moved by itself before, or the owner gave the choice back): the same.
  assert.deepEqual(moves(blob(), rows({ ws_acme: row("mac", "auto"), ws_beta: row("mac", null) }), seen()), ["ws_acme:cloud", "ws_beta:cloud"]);
  // The Mac's entry with capitals, the computer's id in lower case: the same computer.
  assert.deepEqual(moves(blob({ [D1]: running() }), rows(), seen({ live: [D1] })), ["ws_acme:cloud"]);
});

test("not until every computer is ready: a runner missing, not running, found down, too old, never connected, or connected at an older Bops", () => {
  const acme = (runner: unknown, s = seen()) => moves(blob({ [D1]: runner }), rows(), s).filter((m) => m.startsWith("ws_acme"));
  assert.deepEqual(moves(blob({}), rows(), seen()), [], "no runner set up");
  for (const status of ["installing", "failed", "stopping"]) assert.deepEqual(acme(running("0.0.37", { status })), [], status);
  assert.deepEqual(acme(running("0.0.37", { down: { status: "stopped", at: 1 } })), [], "found down");
  assert.deepEqual(acme(running("0.0.35")), [], "a runner before chat through Bops Cloud");
  assert.deepEqual(acme(running("dev")), [], "not a version");
  assert.deepEqual(acme(running(), seen({ live: [] })), [], "never connected since Bops Cloud started");
  assert.deepEqual(acme(running("0.0.38"), seen({ version: "0.0.37" })), [], "connected before the Mac set up its newer one");
  assert.deepEqual(acme(running(), seen({ version: "0.0.35" })), [], "connected as a runner too old");
  // Asleep now is fine: a turn wakes it.
  assert.deepEqual(acme(running()), ["ws_acme:cloud"]);
  // A second computer for the same workspace: both must be ready.
  const two = blob({ [D1]: running(), [D2]: running() }, [{ id: "ivy", isMain: true, freeComputer: true, workspaceId: "ws_acme", computerId: D2 }]);
  assert.ok(moves(two, rows(), seen()).includes("ws_acme:cloud"));
  assert.ok(!moves(two, rows(), seen({ live: [D1] })).includes("ws_acme:cloud"));
});

test("not when moves are off for the owner, their Mac is too old, the workspace has no computer, or it waits after a wake refused", () => {
  assert.deepEqual(moves(blob(), rows(), seen({ on: false })), []);
  assert.deepEqual(moves(blob(), rows(), seen({ appOk: false })), []);
  assert.deepEqual(moves({ ...blob(), bots: [{ id: "boppy", isMain: true }, { id: "zed", workspaceId: "ws_acme", runsOn: "mac" }] }, rows(), seen()), [], "no bot with a computer");
  // Moved back as its computer couldn't be woken: it waits AUTO_HOLD_MS, then may go again.
  assert.deepEqual(moves(blob(), rows({ ws_acme: row("mac", "auto-held", NOW - 1000) }), seen()), ["ws_beta:cloud"]);
  assert.deepEqual(moves(blob(), rows({ ws_acme: row("mac", "auto-held", NOW - AUTO_HOLD_MS - 1) }), seen()), ["ws_acme:cloud", "ws_beta:cloud"]);
  // Couldn't answer since its runner last connected: not until it connects again.
  const broke = (at: number) => seen({ broken: (c) => (c === D1 ? { at, hold: false } : undefined) });
  assert.deepEqual(moves(blob(), rows(), broke(NOW - 500)), ["ws_beta:cloud"]);
  assert.deepEqual(moves(blob(), rows(), broke(NOW - 5000)), ["ws_acme:cloud", "ws_beta:cloud"]);
});

test("a choice the owner or staff made is never moved, either way", () => {
  for (const by of ["owner", "staff"]) {
    assert.deepEqual(moves(blob(), rows({ ws_acme: row("mac", by), ws_beta: row("mac", by) }), seen()), [], `${by}'s mac`);
    assert.deepEqual(moves(blob({}), rows({ ws_acme: row("cloud", by), ws_beta: row("cloud", by) }), seen()), [], `${by}'s cloud`);
  }
});

test("a cloud workspace whose computer can't answer stays in the cloud where the owner's Mac keeps to everything through the cloud, and says why (chatTrouble)", () => {
  const moved = rows({ ws_acme: row("cloud", "auto"), ws_beta: row("cloud", null) });
  const all = (s: AutoSeen) => ({ ...s, cloudAll: true });
  const stays = (runners: Record<string, unknown>, s = seen()) => autoMoves(blob(runners), moved, all(s));
  assert.deepEqual(stays({ [D2]: running() }), [], "no runner");
  assert.deepEqual(stays({ [D1]: running("0.0.37", { status: "failed" }) }), [], "runner failed");
  assert.deepEqual(stays({ [D1]: running("0.0.37", { status: "stopping" }) }), [], "runner stopping");
  assert.deepEqual(stays({ [D1]: running("0.0.37", { down: { status: "asleep", at: 1 } }) }), [], "computer down");
  assert.deepEqual(stays({ [D1]: running() }, seen({ broken: (c) => (c === D1 ? { at: NOW - 10, hold: true } : undefined) })), [], "a wake refused");
  const none = { ...blob(), bots: [{ id: "max", isMain: true, workspaceId: "ws_acme", runsOn: "mac", computerId: D1 }] };
  assert.deepEqual(autoMoves(none, moved, all(seen())), [], "its bots on the Mac");
  // Why is said on the workspace instead (turns.ts noteTrouble): the mirror carries it, while the workspace is in the cloud.
  const troubled = rows({ ws_acme: { ...row("cloud", "auto"), trouble: { note: "stopped", botId: "max", desktop: D1, at: NOW } } });
  const kept = keepChatOn({ workspaces: [{ id: "ws_acme", chatOn: "cloud" }] }, troubled, true);
  assert.deepEqual(kept.workspaces, [{ id: "ws_acme", chatOn: "cloud", chatAuto: true, chatTrouble: { note: "stopped", botId: "max", at: NOW } }]);
  // Moving to the cloud there, a bot set to work on the Mac counts: its computer must be ready too.
  const zedOwn = blob({ [D1]: running() }, [{ id: "zed2", workspaceId: "ws_acme", runsOn: "mac", computer: "own", computerId: D2 }]);
  assert.ok(moves(zedOwn, rows(), seen({ live: [D1] })).includes("ws_acme:cloud"), "an older owner's: Zed2 isn't counted");
  assert.ok(!moves(zedOwn, rows(), all(seen({ live: [D1] }))).includes("ws_acme:cloud"), "Zed2's computer has no runner yet");
  assert.ok(moves(blob({ [D1]: running(), [D2]: running() }, [{ id: "zed2", workspaceId: "ws_acme", runsOn: "mac", computer: "own", computerId: D2 }]), rows(), all(seen())).includes("ws_acme:cloud"));
});

test("where the owner's Mac keeps to everything through the cloud, never moved there by itself while a bot of it has no computer or a group of it spans computers; an older owner's moves as before", () => {
  const all = (s: AutoSeen) => ({ ...s, cloudAll: true });
  const acme = (b: Record<string, unknown>, s: AutoSeen) => moves(b, rows(), s).includes("ws_acme:cloud");
  // Ivy, with no computer: her messages would get only notes in the cloud, where the Mac answered them.
  const ivy = blob(undefined, [{ id: "ivy", workspaceId: "ws_acme", computer: "own" }]);
  assert.equal(wholeOnComputers(ivy, "ws_acme"), false);
  assert.ok(!acme(ivy, all(seen())), "a bot with no computer");
  assert.ok(acme(ivy, seen()), "an older owner's: as before (the Mac answers Ivy)");
  // A group across computers (Max on D1, Rex's computer D2), then one whose bots share one.
  const split = { ...blob(), chats: [{ id: "g1", kind: "group", botIds: ["max", "rex"], workspaceId: "ws_acme" }] };
  assert.equal(wholeOnComputers(split, "ws_acme"), false);
  assert.ok(!acme(split, all(seen())), "a group across computers");
  assert.ok(acme(split, seen()), "an older owner's: as before");
  const shared = { ...blob(), chats: [{ id: "g2", kind: "group", botIds: ["max", "dana", "zed"], workspaceId: "ws_acme" }, { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" }] };
  assert.equal(wholeOnComputers(shared, "ws_acme"), true);
  assert.ok(acme(shared, all(seen())), "every bot on a computer, the group on one: it moves");
  // Another workspace's group or bot changes nothing here.
  const elsewhere = { ...blob(undefined, [{ id: "pip", workspaceId: "ws_beta", computer: "own" }]), chats: [{ id: "g3", kind: "group", botIds: ["rex", "max"], workspaceId: "ws_beta" }] };
  assert.ok(acme(elsewhere, all(seen())));
});

test("trouble said on a workspace goes once it's about no computer of its bots (moved, given a new one), or the computer it names (or its bot's now) answers; an older Bops's stays until a new enough one answers", () => {
  const b = blob();
  const t = (note: string, botId: string | null, desktop: string | null) => ({ note, botId, desktop });
  // Max (and Dana, Zed) on D1; D1 named: it stays until D1 answers.
  assert.equal(troubleGoes(b, "ws_acme", t("deleted", "max", D1), null), false);
  assert.equal(troubleGoes(b, "ws_acme", t("deleted", "max", D1), { desktop: D2, version: "0.0.54" }), false, "another computer answered");
  assert.equal(troubleGoes(b, "ws_acme", t("deleted", "max", D1), { desktop: D1.toUpperCase(), version: "0.0.54" }), true);
  // Max given a new computer (D2): D1 is no bot's of Acme's any more.
  const moved = { ...b, bots: b.bots.map((x) => (x.id === "max" ? { ...x, computerId: D2 } : x)) };
  assert.equal(troubleGoes(moved, "ws_acme", t("deleted", "max", D1), null), true);
  // Dana moved to D2 while Max stays on D1: said of Dana, it goes when D2 answers; said of Max, it stays.
  const dana = { ...b, bots: [...b.bots.filter((x) => x.id !== "dana"), { id: "dana", workspaceId: "ws_acme", computer: "own", computerId: D2 }] };
  assert.equal(troubleGoes(dana, "ws_acme", t("stopped", "dana", D1), null), false);
  assert.equal(troubleGoes(dana, "ws_acme", t("stopped", "dana", D1), { desktop: D2, version: "0.0.54" }), true);
  assert.equal(troubleGoes(dana, "ws_acme", t("stopped", "max", D1), { desktop: D2, version: "0.0.54" }), false);
  // An older Bops: only a new enough one clears it.
  assert.equal(troubleGoes(b, "ws_acme", t("old", "max", D1), { desktop: D1, version: "0.0.53" }), false);
  assert.equal(troubleGoes(b, "ws_acme", t("old", "max", D1), { desktop: D1, version: null }), false);
  assert.equal(troubleGoes(b, "ws_acme", t("old", "max", D1), { desktop: D1, version: "0.0.54" }), true);
});

test("the mirror carries chatTrouble only while the workspace is in the cloud, puts it back on a save that drops it, and takes it off once it's gone", () => {
  const t = { note: "noRunner", botId: "max", desktop: D1, at: NOW };
  assert.deepEqual(mirrorOf({ ...row("cloud", "owner"), trouble: t }, true), { chatOn: "cloud", chatTrouble: { note: "noRunner", botId: "max", at: NOW } });
  assert.deepEqual(mirrorOf({ ...row("cloud", "owner"), trouble: { ...t, botId: null } }, true), { chatOn: "cloud", chatTrouble: { note: "noRunner", at: NOW } });
  assert.deepEqual(mirrorOf({ ...row("mac", "owner"), trouble: t }, true), { chatOn: "mac" }, "on the Mac: nothing to say");
  const r = rows({ ws_acme: { ...row("cloud", "owner"), trouble: t } });
  const dropped = keepChatOn({ workspaces: [{ id: "ws_acme", chatOn: "cloud" }] }, r, true);
  assert.deepEqual(dropped.workspaces, [{ id: "ws_acme", chatOn: "cloud", chatTrouble: { note: "noRunner", botId: "max", at: NOW } }]);
  // Keys in another order (the table's JSON): the same.
  const reordered = { workspaces: [{ id: "ws_acme", chatOn: "cloud", chatTrouble: { at: NOW, botId: "max", note: "noRunner" } }] };
  assert.equal(keepChatOn(reordered, r, true), reordered);
  const cleared = keepChatOn(dropped, rows({ ws_acme: row("cloud", "owner") }), true);
  assert.deepEqual(cleared.workspaces, [{ id: "ws_acme", chatOn: "cloud" }]);
});

test("an older owner's Mac keeps the old move back: one Bops Cloud moved goes back to the Mac when a computer can't answer, and never because a runner went quiet", () => {
  const moved = rows({ ws_acme: row("cloud", "auto"), ws_beta: row("cloud", null) });
  const back = (runners: Record<string, unknown>, s = seen()) => autoMoves(blob(runners), moved, s).filter((m) => m.wsId === "ws_acme");
  // Asleep, its runner not listening, moves off for everyone: it stays.
  assert.deepEqual(back({ [D1]: running(), [D2]: running() }, seen({ live: [], on: false, appOk: false })), []);
  assert.deepEqual(back({ [D2]: running() }).map((m) => m.why), ["no runner"]);
  assert.deepEqual(back({ [D1]: running("0.0.37", { status: "failed" }) }).map((m) => m.why), ["runner failed"]);
  assert.deepEqual(back({ [D1]: running("0.0.37", { status: "stopping" }) }).map((m) => m.why), ["runner stopping"]);
  assert.deepEqual(back({ [D1]: running("0.0.37", { down: { status: "asleep", at: 1 } }) }).map((m) => m.why), ["computer down"]);
  // A wake refused (held on the Mac a while) or no runner coming (not held), since its runner last connected.
  const refused = (hold: boolean) => seen({ broken: (c) => (c === D1 ? { at: NOW - 10, hold } : undefined) });
  assert.deepEqual(back({ [D1]: running() }, refused(true)).map((m) => [m.mode, m.why, m.hold]), [["mac", "couldn't answer", true]]);
  assert.deepEqual(back({ [D1]: running() }, refused(false)).map((m) => [m.mode, m.hold]), [["mac", undefined]]);
  // Its bots have no computer any more (all on the Mac now).
  const none = { ...blob(), bots: [{ id: "max", isMain: true, workspaceId: "ws_acme", runsOn: "mac", computerId: D1 }] };
  assert.deepEqual(autoMoves(none, moved, seen()).filter((m) => m.wsId === "ws_acme").map((m) => m.why), ["no computer"]);
});

test("the mirror on the owner's state: chatOn cloud or a chosen mac, chatAuto while Bops Cloud may move it", () => {
  assert.deepEqual(mirrorOf(undefined, false), {});
  assert.deepEqual(mirrorOf(undefined, true), { chatAuto: true });
  assert.deepEqual(mirrorOf(row("cloud", "auto"), true), { chatOn: "cloud", chatAuto: true });
  assert.deepEqual(mirrorOf(row("cloud", "staff"), true), { chatOn: "cloud" });
  assert.deepEqual(mirrorOf(row("mac", "owner"), true), { chatOn: "mac" });
  assert.deepEqual(mirrorOf(row("mac", "auto"), false), {});
  const st = { workspaces: [{ id: "ws_main", chatAuto: true }, { id: "ws_acme" }, { id: "ws_beta", chatOn: "cloud" }] };
  const kept = keepChatOn(st, rows({ ws_acme: row("mac", "owner"), ws_beta: row("cloud", "staff") }), false);
  assert.deepEqual(kept.workspaces, [{ id: "ws_main" }, { id: "ws_acme", chatOn: "mac", chatAutoOff: true }, { id: "ws_beta", chatOn: "cloud", chatAutoOff: true }]);
  // Already as the table has it: the same blob back.
  assert.equal(keepChatOn(kept, rows({ ws_acme: row("mac", "owner"), ws_beta: row("cloud", "staff") }), false), kept);
});

test("the mirror says where Bops Cloud won't take the switch back on (chatAutoOff): a workspace with the switch, outside BOPS_CHAT_AUTO", () => {
  // Outside it, "auto" is refused (setRouting, 409 chat_auto_off): turned off, the switch can't come back on there.
  assert.deepEqual(mirrorOf(row("mac", "owner"), false), { chatOn: "mac", chatAutoOff: true });
  assert.deepEqual(mirrorOf(row("mac", "admin"), false), { chatOn: "mac", chatAutoOff: true });
  assert.deepEqual(mirrorOf(row("cloud", "staff"), false), { chatOn: "cloud", chatAutoOff: true });
  assert.deepEqual(mirrorOf(row("cloud", "auto"), false), { chatOn: "cloud", chatAutoOff: true });
  // No switch there (nobody chose, and nothing moves for the account): nothing to say.
  assert.deepEqual(mirrorOf(undefined, false), {});
  assert.deepEqual(mirrorOf(row("mac", "auto"), false), {});
  // Inside it, "auto" is taken: never the flag.
  assert.deepEqual(mirrorOf(row("mac", "owner"), true), { chatOn: "mac" });
  assert.deepEqual(mirrorOf(row("cloud", "staff"), true), { chatOn: "cloud" });
  // An older Bops's save, without the flag: put back. Moves turned on for the account since: taken off.
  const r = rows({ ws_acme: row("mac", "owner") });
  assert.deepEqual(keepChatOn({ workspaces: [{ id: "ws_acme", name: "Acme", chatOn: "mac" }] }, r, false).workspaces, [{ id: "ws_acme", name: "Acme", chatOn: "mac", chatAutoOff: true }]);
  assert.deepEqual(keepChatOn({ workspaces: [{ id: "ws_acme", chatOn: "mac", chatAutoOff: true }] }, r, true).workspaces, [{ id: "ws_acme", chatOn: "mac" }]);
  const same = { workspaces: [{ id: "ws_acme", chatOn: "mac", chatAutoOff: true }] };
  assert.equal(keepChatOn(same, r, false), same, "as the table has it: the same blob back");
});

test("what Bops Cloud does for each workspace (cloudDoes) is a mirror: written where it does a part, its parts in order, kept over a save from an older Bops, taken off when it does none, and the same blob back when it's as it should be", () => {
  const does = (o: Record<string, CloudDoes>) => new Map(Object.entries(o));
  const r = rows({ ws_acme: row("cloud", "owner") });
  // Written: in the order Bops Cloud writes the parts, whatever order it was given in.
  const st = { workspaces: [{ id: "ws_main", name: "Main" }, { id: "ws_acme", name: "Acme", chatOn: "cloud" }] };
  const written = keepChatOn(st, r, true, does({ ws_acme: { watches: true, texts: true } }));
  assert.deepEqual(written.workspaces, [{ id: "ws_main", name: "Main", chatAuto: true }, { id: "ws_acme", name: "Acme", chatOn: "cloud", cloudDoes: { texts: true, watches: true } }]);
  assert.deepEqual(Object.keys((written.workspaces as { cloudDoes?: object }[])[1].cloudDoes!), ["texts", "watches"]);
  // Equality covers it: the same parts in another order, the same blob back; another part, a new blob.
  const reordered = { workspaces: [{ id: "ws_main", name: "Main", chatAuto: true }, { id: "ws_acme", name: "Acme", chatOn: "cloud", cloudDoes: { watches: true, texts: true } }] };
  assert.equal(keepChatOn(reordered, r, true, does({ ws_acme: { texts: true, watches: true } })), reordered);
  assert.equal(keepChatOn(written, r, true, does({ ws_acme: { texts: true, watches: true } })), written);
  const more = keepChatOn(written, r, true, does({ ws_acme: { texts: true, watches: true, digest: true } }));
  assert.notEqual(more, written);
  assert.deepEqual((more.workspaces as { cloudDoes?: object }[])[1].cloudDoes, { texts: true, digest: true, watches: true });
  // A save from an older Bops drops it (and the switch): both put back, the rest of what it saved kept.
  const older = { workspaces: [{ id: "ws_main", name: "Main" }, { id: "ws_acme", name: "Acme Inc" }] };
  assert.deepEqual(keepChatOn(older, r, true, does({ ws_acme: { texts: true, watches: true } })).workspaces, [
    { id: "ws_main", name: "Main", chatAuto: true },
    { id: "ws_acme", name: "Acme Inc", chatOn: "cloud", cloudDoes: { texts: true, watches: true } },
  ]);
  // Bops Cloud does none for it now (a kill switch, the switch turned off): taken off, never left empty.
  assert.deepEqual(keepChatOn(written, r, true, does({})).workspaces, [{ id: "ws_main", name: "Main", chatAuto: true }, { id: "ws_acme", name: "Acme", chatOn: "cloud" }]);
  assert.deepEqual(keepChatOn(written, r, true, does({ ws_acme: {} })).workspaces, [{ id: "ws_main", name: "Main", chatAuto: true }, { id: "ws_acme", name: "Acme", chatOn: "cloud" }]);
  assert.deepEqual(keepChatOn(written, r, true).workspaces, [{ id: "ws_main", name: "Main", chatAuto: true }, { id: "ws_acme", name: "Acme", chatOn: "cloud" }], "none given: none");
  // One a Mac wrote itself (no part is a Mac's to write): taken off too; a part that isn't one never written.
  const forged = { workspaces: [{ id: "ws_acme", chatOn: "cloud", cloudDoes: { texts: true } }] };
  assert.deepEqual(keepChatOn(forged, r, true).workspaces, [{ id: "ws_acme", chatOn: "cloud" }]);
  assert.deepEqual(keepChatOn(forged, r, true, does({ ws_acme: { texts: true, routines: false as unknown as true, made: true } as CloudDoes })).workspaces, [{ id: "ws_acme", chatOn: "cloud", cloudDoes: { texts: true } }]);
  // A workspace with none and no mirror: the same blob back.
  const none = { workspaces: [{ id: "ws_acme", chatOn: "cloud" }] };
  assert.equal(keepChatOn(none, r, true), none);
});

test("cloudDoesFor: no part is Bops Cloud's in this release, for any workspace", async () => {
  resetTurns();
  const st = { workspaces: [{ id: "ws_main" }, { id: "ws_acme", chatOn: "cloud", cloudDoes: { texts: true } }] };
  assert.equal((await cloudDoesFor(null, "u_no_such_owner", st)).size, 0);
});

test("BOPS_CHAT_AUTO: unset and off move nothing, on moves everyone's, a list only theirs, revert nothing", () => {
  const was = process.env.BOPS_CHAT_AUTO;
  try {
    const as = (v: string | undefined) => {
      if (v === undefined) delete process.env.BOPS_CHAT_AUTO;
      else process.env.BOPS_CHAT_AUTO = v;
      return [chatAutoFor("u1"), chatAutoFor("u2")];
    };
    assert.deepEqual(as(undefined), [false, false]);
    assert.deepEqual(as("off"), [false, false]);
    assert.deepEqual(as("revert"), [false, false]);
    assert.deepEqual(as("on"), [true, true]);
    assert.deepEqual(as("u2, u3"), [false, true]);
  } finally {
    if (was === undefined) delete process.env.BOPS_CHAT_AUTO;
    else process.env.BOPS_CHAT_AUTO = was;
  }
});
