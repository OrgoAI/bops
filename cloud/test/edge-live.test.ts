import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb } from "../db.ts";
import { closeAll } from "../live.ts";
import { dropUsers, fakeOrgo, keyOf, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * Live and the state (cloud/live.ts, state.ts): a device watching a workspace hears "state" when a
 * write changed that workspace's part, and not for a write that changed only another workspace's or the
 * account's own (the usage ledger); messages written into a workspace's chat wake it with their seq.
 */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  cloud = await startCloud();
});

after(async () => {
  closeAll();
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await closeDb();
});

const headers = (userId: string, device = "mac-a") => ({ Authorization: `Bearer ${keyOf(userId)}`, "x-bops-user": userId, "x-bops-protocol": "2", "x-bops-device": device, "content-type": "application/json" });
const putState = (userId: string, base: number, state: Record<string, unknown>, device?: string) =>
  fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: headers(userId, device), body: JSON.stringify({ base, state }) });

/** A live stream's "state" events, as they come. */
async function watch(userId: string, ws: string) {
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}/v1/live?ws=${ws}`, { headers: { Authorization: `Bearer ${keyOf(userId)}` }, signal: ctl.signal });
  assert.equal(res.status, 200);
  const got: { type: string; data: Record<string, unknown> }[] = [];
  void (async () => {
    let text = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body!) {
        text += dec.decode(chunk as Uint8Array, { stream: true });
        for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
          const block = text.slice(0, i);
          text = text.slice(i + 2);
          const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
          if (field("event")) got.push({ type: field("event")!, data: JSON.parse(field("data") ?? "{}") });
        }
      }
    } catch {}
  })();
  await until(() => got.some((g) => g.type === "reset"), "the stream to start");
  return { states: () => got.filter((g) => g.type === "state"), close: () => ctl.abort() };
}

const blob = (acmeStatus: string, usage: number[]) => ({
  workspaces: [
    { id: "ws_main", name: "Main" },
    { id: "ws_acme", name: "Acme" },
  ],
  bots: [{ id: "boppy", isMain: true }, { id: "max", isMain: true, workspaceId: "ws_acme" }],
  chats: [{ id: "bot:boppy", botIds: ["boppy"] }, { id: "bot:max", botIds: ["max"], workspaceId: "ws_acme" }],
  sessions: [{ id: "s1", botId: "max", status: acmeStatus }],
  routines: [],
  usage: { events: usage },
});

test("a write wakes the watched workspace whose part changed, and only it", async () => {
  const id = newUserId("live");
  users.push(id);
  const main = await watch(id, "ws_main");
  const acme = await watch(id, "ws_acme");
  assert.equal((await putState(id, 0, blob("running", [1]))).status, 200);
  await until(() => main.states().length === 1 && acme.states().length === 1, "the first write to reach both");
  assert.equal(main.states()[0].data.by, "mac-a");

  // Only the usage ledger changed: nobody hears of it.
  assert.equal((await putState(id, 1, blob("running", [1, 2]), "mac-b")).status, 200);
  // Acme's thread finished: Acme hears of it.
  assert.equal((await putState(id, 2, blob("done", [1, 2, 3]), "mac-b")).status, 200);
  await until(() => acme.states().length === 2, "Acme to hear of its thread");
  assert.equal(acme.states()[1].data.by, "mac-b");
  assert.equal(main.states().length, 1, "Main's part didn't change");

  // A message in Acme's main bot's chat: Acme hears it with the seq.
  const res = await fetch(`${cloud.url}/v1/messages`, {
    method: "POST",
    headers: headers(id, "mac-b"),
    body: JSON.stringify({ upsert: [{ id: "msg_1", chatId: "bot:max", role: "user", text: "hi", at: 1 }], remove: [] }),
  });
  assert.equal(res.status, 200);
  const { seq } = (await res.json()) as { seq: number };
  await until(() => acme.states().length === 3, "Acme to hear of the message");
  assert.equal(acme.states()[2].data.seq, seq);
  assert.equal(main.states().length, 1);
  main.close();
  acme.close();
});
