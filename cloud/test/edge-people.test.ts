import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import type { PeopleSync } from "../protocol.ts";
import { connectMac, dropUsers, fakeOrgo, keyOf, newUserId, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/** People messaging each other (cloud/people.ts): finding someone, direct messages, groups, invites, reading, leaving, and who's told. */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};
const emailOf = (userId: string) => `${userId}@example.com`;

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  cloud = await startCloud();
});

after(async () => {
  await query("DELETE FROM bops.convos WHERE created_by = ANY($1::text[])", [users]);
  await query("DELETE FROM bops.people WHERE user_id = ANY($1::text[])", [users]);
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await closeDb();
});

async function call<T = Record<string, unknown>>(userId: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${cloud.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${keyOf(userId)}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as T };
}
const sync = async (userId: string, after = 0) => (await call<PeopleSync>(userId, `/v1/people/sync?after=${after}`)).body;

test("someone is found by their exact email once they've used Bops, and nobody else", async () => {
  const ann = user("find-ann");
  const bob = user("find-bob");
  assert.equal((await call(ann, "/v1/people/find", { email: emailOf(bob) })).body.person, null, "not on Bops yet");
  await call(bob, "/v1/people/hello", {});
  const found = await call<{ person: { userId: string; email: string } }>(ann, "/v1/people/find", { email: emailOf(bob).toUpperCase() });
  assert.equal(found.body.person.userId, bob);
  assert.equal((await call(ann, "/v1/people/find", { email: "bob" })).status, 400);
  assert.equal((await fetch(`${cloud.url}/v1/people/find`, { method: "POST", body: "{}" })).status, 401, "only a signed-in user");
});

test("a direct message: one per pair, both see it, messages go once, and each Mac is told", async () => {
  const ann = user("dm-ann");
  const bob = user("dm-bob");
  await call(bob, "/v1/people/hello", {});
  const bobMac = await connectMac(cloud.url, bob);
  try {
    const first = await call<{ convoId: string }>(ann, "/v1/people/convos", { emails: [emailOf(bob)] });
    assert.match(first.body.convoId, /^dm_/);
    const again = await call<{ convoId: string }>(ann, "/v1/people/convos", { userIds: [bob] });
    assert.equal(again.body.convoId, first.body.convoId, "the same direct message");
    const fromBob = await call<{ convoId: string }>(bob, "/v1/people/convos", { userIds: [ann] });
    assert.equal(fromBob.body.convoId, first.body.convoId, "whoever starts it");
    const convoId = first.body.convoId;

    const sent = await call<{ seq: number }>(ann, "/v1/people/send", { convoId, id: "msg_hello_1", text: "hey bob" });
    assert.ok(sent.body.seq > 0);
    const twice = await call<{ seq: number }>(ann, "/v1/people/send", { convoId, id: "msg_hello_1", text: "hey bob" });
    assert.equal(twice.body.seq, 0, "sent again: nothing new");
    await until(() => bobMac.frames.some((f) => f.t === "people" && f.seq === sent.body.seq), "Bob's Mac told");

    const seen = await sync(bob);
    const convo = seen.convos.find((c) => c.id === convoId)!;
    assert.equal(convo.kind, "dm");
    assert.deepEqual(convo.members.map((m) => m.userId).sort(), [ann, bob].sort());
    assert.deepEqual(seen.messages.filter((m) => m.convoId === convoId).map((m) => [m.author, m.text]), [[ann, "hey bob"]]);
    // Asked again from where it left off: nothing.
    const later = await sync(bob, seen.seq);
    assert.equal(later.messages.length, 0);
    assert.equal(later.convos.length, 0);

    // Bob read it: Ann sees how far.
    await call(bob, "/v1/people/read", { convoId, seq: sent.body.seq });
    const annSees = await sync(ann, seen.seq);
    assert.equal(annSees.convos.find((c) => c.id === convoId)!.members.find((m) => m.userId === bob)!.readSeq, sent.body.seq);

    // Typing is told to Bob's Mac, never kept.
    await call(ann, "/v1/people/typing", { convoId });
    await until(() => bobMac.frames.some((f) => f.t === "people" && f.typing?.userId === ann), "typing");
  } finally {
    bobMac.ws.close();
  }
});

test("only members read or write a conversation", async () => {
  const ann = user("priv-ann");
  const bob = user("priv-bob");
  const eve = user("priv-eve");
  await call(bob, "/v1/people/hello", {});
  const { convoId } = (await call<{ convoId: string }>(ann, "/v1/people/convos", { userIds: [bob] })).body;
  await call(ann, "/v1/people/send", { convoId, id: "msg_secret_1", text: "just us" });
  assert.equal((await call(eve, "/v1/people/send", { convoId, id: "msg_eve_1", text: "hi" })).status, 404);
  assert.equal((await call(eve, "/v1/people/members", { convoId, add: [eve] })).status, 404);
  const eves = await sync(eve);
  assert.equal(eves.convos.length, 0);
  assert.equal(eves.messages.length, 0);
});

test("a group: named, people added by email, someone not on Bops joins when they sign in, and leaving stops what's new", async () => {
  const ann = user("grp-ann");
  const bob = user("grp-bob");
  const cat = user("grp-cat");
  const dan = user("grp-dan");
  await call(bob, "/v1/people/hello", {});
  await call(cat, "/v1/people/hello", {});
  const made = await call<{ convoId: string; invited: string[] }>(ann, "/v1/people/convos", { emails: [emailOf(bob), emailOf(dan)], title: "Launch crew" });
  assert.match(made.body.convoId, /^grp_/);
  assert.deepEqual(made.body.invited, [emailOf(dan)], "Dan isn't on Bops yet");
  const convoId = made.body.convoId;
  let seen = (await sync(bob)).convos.find((c) => c.id === convoId)!;
  assert.equal(seen.title, "Launch crew");
  assert.deepEqual(seen.invited, [emailOf(dan)]);

  await call(bob, "/v1/people/members", { convoId, add: [emailOf(cat)] });
  await call(ann, "/v1/people/send", { convoId, id: "msg_grp_1", text: "welcome" });
  assert.deepEqual((await sync(cat)).messages.map((m) => m.text), ["welcome"], "a new member sees what was said before");

  // Dan signs in with the email he was asked by: he's in.
  await call(dan, "/v1/people/hello", {});
  seen = (await sync(dan)).convos.find((c) => c.id === convoId)!;
  assert.ok(seen.members.some((m) => m.userId === dan));
  assert.deepEqual(seen.invited, []);

  // Only whoever made it takes others out; anyone can leave.
  assert.equal((await call(bob, "/v1/people/members", { convoId, remove: cat })).status, 403);
  const before = (await sync(cat)).seq;
  await call(cat, "/v1/people/members", { convoId, leave: true });
  await call(ann, "/v1/people/send", { convoId, id: "msg_grp_2", text: "after cat left" });
  const cats = await sync(cat, before);
  assert.equal(cats.convos.find((c) => c.id === convoId)?.left, true, "Cat hears she's out");
  assert.equal(cats.messages.length, 0, "and gets nothing new");
  assert.equal((await call(cat, "/v1/people/send", { convoId, id: "msg_cat_1", text: "hi" })).status, 404);

  // A direct message can't take more people.
  const dm = (await call<{ convoId: string }>(ann, "/v1/people/convos", { userIds: [bob] })).body.convoId;
  assert.equal((await call(ann, "/v1/people/members", { convoId: dm, add: [cat] })).status, 400);
});

test("what a message may carry", async () => {
  const ann = user("msg-ann");
  const bob = user("msg-bob");
  await call(bob, "/v1/people/hello", {});
  const { convoId } = (await call<{ convoId: string }>(ann, "/v1/people/convos", { userIds: [bob] })).body;
  assert.equal((await call(ann, "/v1/people/send", { convoId, id: "x", text: "too short an id" })).status, 400);
  assert.equal((await call(ann, "/v1/people/send", { convoId, id: "msg_empty_1", text: "   " })).status, 400);
  assert.equal((await call(ann, "/v1/people/send", { convoId, id: "msg_json_1", text: "a reply", json: { replyTo: "msg_x" } })).status, 200);
  const m = (await sync(bob)).messages.find((x) => x.id === "msg_json_1")!;
  assert.deepEqual(m.json, { replyTo: "msg_x" });
});
