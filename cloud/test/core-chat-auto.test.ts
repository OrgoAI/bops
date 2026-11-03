import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "../db.ts";
import { AUTO_HOLD_MS, autoMoves, chatAutoFor, keepChatOn, mirrorOf, type AutoSeen, type RoutingRow } from "../turns.ts";

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

test("one Bops Cloud moved goes back to the Mac when a computer can't answer, and never because a runner went quiet", () => {
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
