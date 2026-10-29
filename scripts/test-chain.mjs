// Tests for the team chart's rules (cloud/chain.ts, through lib/chain.ts in the app): with no chain everyone may ask
// everyone, only the chief hands off and the chief is above every bot; up and down a line is open whatever sideways
// says; sideways closed on either side stops a sideways ask; an exception beats sideways, both ways, and is one way;
// handing off follows who is under whom, takesWork and handsDown; cleanChain drops loops, self leads, other
// workspaces' ids, leads deeper than 4, exceptions with the chief or in one line, `for` not in the workspace's
// access, readsTeam without own memory, any entry on the chief and what's past the sizes; and a deleted bot's bots
// answer to its lead.
//
// Pure: nothing here reads a file or the network.
// Usage: node scripts/test-chain.mjs
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const C = await import(`${root}/cloud/chain.ts`);

let passed = 0;
let failed = 0;
const test = (name, f) => {
  try {
    f();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 4).join("\n  ")}`);
  }
};

// Acme: Sam runs it; Max and Nova (Nova leads Pip), Juno and Rex. Another workspace has Zed.
const BOTS = [
  { id: "sam", isMain: true, workspaceId: "ws_acme" },
  { id: "max", workspaceId: "ws_acme" },
  { id: "nova", workspaceId: "ws_acme" },
  { id: "pip", workspaceId: "ws_acme" },
  { id: "juno", workspaceId: "ws_acme" },
  { id: "rex", workspaceId: "ws_acme" },
  { id: "boppy", isMain: true },
  { id: "zed", workspaceId: "ws_main" },
];
const ACME = BOTS.filter((b) => b.workspaceId === "ws_acme");
const state = (chain, memberAccess) => ({ bots: BOTS, workspaces: [{ id: "ws_main" }, { id: "ws_acme", ...(chain ? { chain } : {}), ...(memberAccess ? { memberAccess } : {}) }] });
const others = (s, id) => ACME.map((b) => b.id).filter((x) => x !== id);

test("no chain: everyone may ask everyone, only the chief hands off (to everyone), and the chief is above every bot", () => {
  for (const s of [state(), state({}), state({ at: 5 })]) {
    for (const a of ACME) for (const b of ACME) assert.equal(C.mayAsk(s, a.id, b.id), a.id !== b.id, `${a.id} asks ${b.id}`);
    assert.deepEqual(C.belowOf(s, "sam"), others(s, "sam"));
    for (const b of others(s, "sam")) {
      assert.equal(C.leadOf(s, b), "sam");
      assert.deepEqual(C.lineOf(s, b), ["sam"]);
      assert.deepEqual(C.belowOf(s, b), []);
      assert.equal(C.mayHandOff(s, "sam", b), true);
      for (const c of ACME) assert.equal(C.mayHandOff(s, b, c.id), false, `${b} hands to ${c.id}`);
      assert.equal(C.sidewaysOf(s, b), "open");
      assert.equal(C.ownMemory(s, b), false);
      assert.equal(C.readsTeam(s, b), true);
    }
    assert.equal(C.leadOf(s, "sam"), undefined);
    assert.equal(C.chainSet(s.workspaces[1].chain), false);
  }
});

test("never across workspaces, never itself", () => {
  const s = state();
  assert.equal(C.mayAsk(s, "max", "zed"), false);
  assert.equal(C.mayAsk(s, "zed", "max"), false);
  assert.equal(C.mayAsk(s, "boppy", "max"), false);
  assert.equal(C.mayAsk(s, "max", "max"), false);
  assert.equal(C.mayHandOff(s, "sam", "zed"), false);
  assert.equal(C.mayAsk(s, "max", "ghost"), false);
});

test("up and down a line is open whatever sideways says; sideways closed on either side stops a sideways ask", () => {
  const s = state({ sideways: "closed", bots: { pip: { lead: "nova" } } });
  assert.equal(C.mayAsk(s, "pip", "nova"), true);
  assert.equal(C.mayAsk(s, "nova", "pip"), true);
  assert.equal(C.mayAsk(s, "pip", "sam"), true, "the chief, always");
  assert.equal(C.mayAsk(s, "max", "nova"), false);
  assert.equal(C.mayAsk(s, "pip", "max"), false);
  assert.deepEqual(C.lineOf(s, "pip"), ["nova", "sam"]);
  assert.equal(C.inLine(s, "pip", "sam"), true);
  assert.equal(C.inLine(s, "pip", "max"), false);
  // Only one side closed is enough to stop it.
  const one = state({ bots: { juno: { sideways: "closed" } } });
  assert.equal(C.mayAsk(one, "juno", "max"), false);
  assert.equal(C.mayAsk(one, "max", "juno"), false);
  assert.equal(C.mayAsk(one, "max", "rex"), true);
  // A bot's own open beats the chain's closed, but both must be open.
  const open = state({ sideways: "closed", bots: { max: { sideways: "open" }, rex: { sideways: "open" } } });
  assert.equal(C.mayAsk(open, "max", "rex"), true);
  assert.equal(C.mayAsk(open, "max", "juno"), false);
});

test("an exception beats sideways, both ways, and is one way", () => {
  const s = state({ sideways: "closed", pairs: { "max>juno": true } });
  assert.equal(C.mayAsk(s, "max", "juno"), true);
  assert.equal(C.mayAsk(s, "juno", "max"), false, "one way");
  const t = state({ pairs: { "max>juno": false } });
  assert.equal(C.mayAsk(t, "max", "juno"), false);
  assert.equal(C.mayAsk(t, "juno", "max"), true);
  // Never about the chief or one line: those stay open.
  const u = state({ bots: { pip: { lead: "nova" } }, pairs: { "pip>nova": false, "max>sam": false } });
  assert.equal(C.mayAsk(u, "pip", "nova"), true);
  assert.equal(C.mayAsk(u, "max", "sam"), true);
});

test("handing off follows who is under whom, takesWork and handsDown", () => {
  const s = state({ bots: { pip: { lead: "nova" }, rex: { lead: "pip" } } });
  assert.deepEqual(C.belowOf(s, "nova"), ["pip", "rex"]);
  assert.equal(C.mayHandOff(s, "nova", "pip"), true);
  assert.equal(C.mayHandOff(s, "nova", "rex"), true, "at any depth");
  assert.equal(C.mayHandOff(s, "pip", "nova"), false, "never up");
  assert.equal(C.mayHandOff(s, "max", "pip"), false, "never sideways");
  assert.equal(C.mayHandOff(s, "sam", "rex"), true);
  const no = state({ bots: { pip: { lead: "nova", takesWork: false }, nova: { handsDown: false }, rex: { lead: "nova" } } });
  assert.equal(C.mayHandOff(no, "sam", "pip"), false, "takes no work, not even from the chief");
  assert.equal(C.mayHandOff(no, "nova", "rex"), false, "doesn't hand down");
  assert.equal(C.mayHandOff(no, "sam", "rex"), true);
  // handsDown never stops the chief.
  assert.equal(C.mayHandOff(state({ bots: { sam: { handsDown: false } } }), "sam", "max"), true);
});

test("memory and the person a bot works for", () => {
  const access = { "ava@example.com": { others: "none", bots: { juno: "write" } }, "ben@example.com": { others: "none", bots: { juno: "read" } } };
  const s = state({ bots: { juno: { memory: "own", for: "ava@example.com", forName: "Ava" }, rex: { memory: "own", readsTeam: false, for: "ben@example.com" } } }, access);
  assert.equal(C.ownMemory(s, "juno"), true);
  assert.equal(C.readsTeam(s, "juno"), true);
  assert.equal(C.readsTeam(s, "rex"), false);
  assert.deepEqual(C.worksFor(s, "juno"), { key: "ava@example.com", name: "Ava" });
  assert.deepEqual(C.worksForNow(s, "juno"), { key: "ava@example.com", name: "Ava" });
  assert.deepEqual(C.worksFor(s, "rex"), { key: "ben@example.com", name: "Ben" });
  assert.equal(C.worksForNow(s, "rex"), undefined, "Ben has no Write on Rex: no line");
  // Never the chief's.
  assert.equal(C.ownMemory(state({ bots: { sam: { memory: "own" } } }), "sam"), false);
});

test("cleanChain drops loops, self leads, other workspaces' ids, too deep, the chief's entry, odd values", () => {
  const access = { "ava@example.com": { others: "none", bots: {} } };
  const got = C.cleanChain(
    {
      sideways: "closed",
      bots: {
        sam: { lead: "max", memory: "own" },
        max: { lead: "max" },
        nova: { lead: "pip" },
        pip: { lead: "nova", takesWork: false },
        juno: { lead: "zed", readsTeam: false, for: "ava@example.com", forName: " Ava\n(Lee) " },
        rex: { lead: "ghost", memory: "own", readsTeam: false, for: "ben@example.com" },
        zed: { lead: "sam" },
        __proto__: { lead: "max" },
      },
      pairs: { "max>juno": true, "max>sam": true, "pip>nova": false, "juno>zed": true, "max>juno>rex": true, "rex>juno": "yes" },
      at: 12,
      extra: 1,
    },
    ACME,
    access,
  );
  assert.deepEqual(got, {
    sideways: "closed",
    // nova and pip were a loop: nova (first) answers to the chief, pip stays under nova.
    bots: { pip: { lead: "nova", takesWork: false }, juno: { for: "ava@example.com", forName: "Ava Lee" }, rex: { memory: "own", readsTeam: false } },
    pairs: { "max>juno": true },
    at: 12,
  });
  // A bank kept apart is said only for a bot that no longer keeps its memory to itself.
  assert.deepEqual(C.cleanChain({ bots: { juno: { kept: true }, rex: { memory: "own", kept: true } } }, ACME).bots, { juno: { kept: true }, rex: { memory: "own" } });
  assert.deepEqual(C.cleanChain("everyone", ACME), {});
  assert.deepEqual(C.cleanChain(null, ACME), {});
  assert.deepEqual(C.cleanChain({ sideways: "maybe", bots: [], pairs: [] }, ACME), {});
});

test("cleanChain: four bots deep at most; a deeper one answers to the deepest lead allowed above it", () => {
  const deep = [{ id: "sam", isMain: true }, ...["a", "b", "c", "d", "e", "f"].map((id) => ({ id }))];
  const got = C.cleanChain({ bots: { b: { lead: "a" }, c: { lead: "b" }, d: { lead: "c" }, e: { lead: "d" }, f: { lead: "e" } } }, deep);
  assert.deepEqual(got.bots, { b: { lead: "a" }, c: { lead: "b" }, d: { lead: "c" }, e: { lead: "c" }, f: { lead: "c" } });
  const s = { bots: deep, workspaces: [{ id: "ws_main", chain: { bots: { b: { lead: "a" }, c: { lead: "b" }, d: { lead: "c" }, e: { lead: "d" } } } }] };
  // Read straight from a chain that wasn't cleaned (synced from an older copy): the same answer.
  assert.equal(C.leadOf(s, "e"), "c");
  assert.equal(C.teamIn(s, "ws_main").depth.get("d"), 4);
});

test("cleanChain: exceptions with the chief or two bots in one line go; sizes are kept to the most", () => {
  const got = C.cleanChain({ bots: { pip: { lead: "nova" } }, pairs: { "pip>nova": true, "nova>pip": false, "sam>max": false, "max>pip": true } }, ACME);
  assert.deepEqual(got.pairs, { "max>pip": true });
  const many = [{ id: "sam", isMain: true }, ...Array.from({ length: 450 }, (_, i) => ({ id: `b${i}` }))];
  const big = C.cleanChain(
    {
      bots: Object.fromEntries(many.slice(1).map((b) => [b.id, { sideways: "closed" }])),
      pairs: Object.fromEntries(many.slice(1, 440).map((b, i) => [`${b.id}>b${i + 1}`, true])),
    },
    many,
  );
  assert.equal(Object.keys(big.bots).length, C.MAX_CHAIN_BOTS);
  assert.equal(Object.keys(big.pairs).length, C.MAX_CHAIN_PAIRS);
});

test("a deleted bot: its bots answer to its lead, its exceptions go", () => {
  const chain = { bots: { pip: { lead: "nova" }, nova: { lead: "max", memory: "own" }, rex: { lead: "nova", sideways: "closed" } }, pairs: { "max>nova": true, "juno>rex": true } };
  assert.deepEqual(C.chainWithout(chain, "nova", "max"), { bots: { pip: { lead: "max" }, rex: { lead: "max", sideways: "closed" } }, pairs: { "juno>rex": true } });
  assert.deepEqual(C.chainWithout({ bots: { pip: { lead: "nova" } } }, "nova", undefined), {}, "under the chief: the lead goes, and an empty entry with it");
  assert.equal(C.chainWithout(undefined, "nova", "max"), undefined);
});

console.log(`\nchain: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
