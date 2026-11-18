// Tests for the news held for later (lib/server/attention.ts flush): one "While you were busy" message per workspace,
// from its main bot, once the user is free; and never for a workspace whose digest Bops Cloud tells
// (Workspace.cloudDoes.digest): its news stays held for Bops Cloud, while the other workspaces' is told and cleared as
// before. With no cloudDoes anywhere, everything is as before.
//
// The state is a throwaway file store in a temporary folder (BOPS_SELF_HOSTED); modules that would start processes are
// stand-ins, and fetch answers nothing: nothing reaches a real service. The bots are made up.
// Usage: node --conditions=react-server scripts/test-attention.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-attention-"));
process.chdir(scratch);
process.env.HOME = scratch;
globalThis.bopsOrgoKey = null;
globalThis.bopsOrgoKeyMissAt = Infinity;
globalThis.fetch = async () => new Response(JSON.stringify({ error: "Not here" }), { status: 404, headers: { "content-type": "application/json" } });

const S = await import(`${root}/lib/server/store.ts`);
const At = await import(`${root}/lib/server/attention.ts`);
// The timer is the test's to run (one flush: what the minute's tick does), never on its own.
clearInterval(globalThis.bopsDigestTimer);

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

const ACME = "ws_acme";
/** Two workspaces: Main with its main bot Boppy, Acme with its main bot Nova and Max. */
S.update((s) => {
  s.workspaces = [{ id: "ws_main", name: "Main", createdAt: 0 }, { id: ACME, name: "Acme", createdAt: 1 }];
  s.bots = [
    { id: "boppy", name: "Boppy", role: "Chief", color: "#000", isMain: true, computerStatus: "none" },
    { id: "nova", name: "Nova", role: "Chief", color: "#000", isMain: true, workspaceId: ACME, computerStatus: "none" },
    { id: "max", name: "Max", role: "Ops", color: "#000", isMain: false, workspaceId: ACME, computerStatus: "none" },
  ];
  s.messages = [];
});
const acme = () => S.getState().workspaces.find((w) => w.id === ACME);
/** Held news, 21 minutes old: the user is free to hear it. */
const hold = () => {
  At.holdForLater({ botId: "boppy", text: "Inbox: “Dana wrote back”" });
  At.holdForLater({ botId: "max", text: "Orders: “Three new orders”" });
  At.holdForLater({ botId: "nova", text: "Bank: “A refund came in”" });
  S.update((s) => {
    for (const h of s.digest) h.at -= 21 * 60_000;
  });
};
const told = () => S.getState().messages.filter((m) => m.held).map((m) => [m.botId, m.text]);
const clear = () =>
  S.update((s) => {
    s.messages = [];
    s.digest = [];
  });

await test("no cloudDoes: one message per workspace, from its main bot, and the digest cleared, as before", () => {
  hold();
  At.flush();
  assert.deepEqual(told(), [
    ["boppy", "While you were busy:\n• Inbox: “Dana wrote back”"],
    ["nova", "While you were busy:\n• Orders: “Three new orders”\n• Bank: “A refund came in”"],
  ]);
  assert.deepEqual(S.getState().digest, []);
  clear();
});

await test("a workspace whose digest Bops Cloud tells is left to it: its news stays held, the rest is told and cleared", () => {
  S.update(() => (acme().cloudDoes = { digest: true }));
  hold();
  At.flush();
  assert.deepEqual(told(), [["boppy", "While you were busy:\n• Inbox: “Dana wrote back”"]]);
  assert.deepEqual(
    S.getState().digest.map((h) => h.botId),
    ["max", "nova"],
    "Acme's, for Bops Cloud",
  );
  // Nothing of Main's left: the next flush tells nothing, and keeps Acme's.
  At.flush();
  assert.equal(told().length, 1);
  assert.equal(S.getState().digest.length, 2);
  clear();
});

await test("only Bops Cloud's held news: nothing told, nothing cleared, and the Mac's own wait never counts it", () => {
  S.update(() => (acme().cloudDoes = { digest: true }));
  At.holdForLater({ botId: "max", text: "Orders: “Three new orders”" });
  S.update((s) => {
    for (const h of s.digest) h.at -= 21 * 60_000;
  });
  At.flush();
  assert.deepEqual(told(), []);
  assert.equal(S.getState().digest.length, 1);
  // Main's own, held just now: it waits its 20 minutes, whatever Acme's says.
  At.holdForLater({ botId: "boppy", text: "Inbox: “Dana wrote back”" });
  At.flush();
  assert.deepEqual(told(), [], "Main's waits: the user hasn't been free for it yet");
  clear();
});

await test("other parts of cloudDoes are no part of it; once it goes (a kill switch), the Mac tells it again", () => {
  S.update(() => (acme().cloudDoes = { texts: true, watches: true }));
  hold();
  At.flush();
  assert.equal(told().length, 2);
  clear();
  S.update(() => (acme().cloudDoes = { digest: true }));
  hold();
  At.flush();
  assert.equal(told().length, 1);
  S.update(() => delete acme().cloudDoes);
  At.flush();
  assert.deepEqual(told()[1], ["nova", "While you were busy:\n• Orders: “Three new orders”\n• Bank: “A refund came in”"]);
  assert.deepEqual(S.getState().digest, []);
  clear();
});

console.log(`\nattention: ${passed} passed`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
