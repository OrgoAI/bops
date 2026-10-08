import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import WebSocket from "ws";
import { forgetNotedVersions, olderThan, refreshAppPolicy, UPDATE_BOPS } from "../app-version.ts";
import { closeDb, query } from "../db.ts";
import { call, dropUsers, fakeOrgo, fakeProvider, keyOf, newUserId, prepareDb, seedUser, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * Which Bops app each user is on, and old apps kept out (cloud/app-version.ts): every signed-in call
 * says its version, kept with the user's account; with bops.app_policy's block_below set, an older app,
 * or one that doesn't say, is told to update (426) everywhere but its state's calls, its sockets too,
 * and nothing it asked for reaches a provider. Against a fake OpenAI. (Only this process reads the
 * policy again, so other test files never see it set.)
 */

const alice = newUserId("version");
let orgo: Listening, cloud: Listening, openai: Awaited<ReturnType<typeof fakeProvider>>;

const seen = async (userId: string) =>
  (await query<{ app_version: string | null; app_seen_at: Date | null }>("SELECT app_version, app_seen_at FROM bops.cloud_accounts WHERE user_id = $1", [userId])).rows[0];
const as = (version: string | undefined, method: string, path: string, json?: unknown) =>
  call(cloud.url, method, path, { key: keyOf(alice), json, headers: version ? { "x-bops-version": version } : {} });
/** The status a socket to the cloud is answered with: 101 when it opens. */
const socketStatus = (version: string | undefined) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(`${cloud.url.replace(/^http/, "ws")}/v1/connect`, { headers: { authorization: `Bearer ${keyOf(alice)}`, ...(version ? { "x-bops-version": version } : {}) } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", () => {});
  });

before(async () => {
  await prepareDb();
  await seedUser(alice);
  orgo = await fakeOrgo();
  openai = await fakeProvider((g) => (g.method === "POST" && g.path === "/v1/responses" ? { json: { id: `resp_${alice}_${Date.now()}`, object: "response", output: [], usage: null } } : { status: 418, json: {} }));
  Object.assign(process.env, { OPENAI_API_KEY: "sk-test-main", BOPS_UPSTREAM_OPENAI: openai.url });
  cloud = await startCloud();
});

/** Set the oldest app served, as scripts/internal/notices.sh does, and read it now. */
const block = async (version: string | null) => {
  await query("UPDATE bops.app_policy SET block_below = $1, updated_at = now() WHERE id", [version]);
  await refreshAppPolicy();
};

beforeEach(async () => {
  await block(null);
  forgetNotedVersions();
});

after(async () => {
  await block(null);
  await dropUsers([alice]);
  await Promise.all([cloud?.close(), orgo?.close(), openai?.close()]);
  await closeDb();
});

test("versions compare place by place, as numbers", () => {
  assert.equal(olderThan("0.0.17", "0.0.18"), true);
  assert.equal(olderThan("0.0.18", "0.0.18"), false);
  assert.equal(olderThan("0.0.100", "0.0.18"), false, "not as text");
  assert.equal(olderThan("0.1.0", "0.0.99"), false);
  assert.equal(olderThan("1.0.0", "0.9.9"), false);
  assert.equal(olderThan("0.9.9", "1.0.0"), true);
});

test("the version a user's app says is kept with their account, and an app that says none is kept as that", async () => {
  const r = await as("0.0.18", "GET", "/v1/state/head");
  assert.notEqual(r.status, 426);
  const row = await until(async () => (await seen(alice))?.app_version === "0.0.18" && (await seen(alice)));
  assert.ok(row.app_seen_at, "with when");
  // The same Mac on an older app (or another Mac): the latest call is what's kept, at once.
  await as(undefined, "GET", "/v1/state/head");
  await until(async () => (await seen(alice))?.app_version === null, "the app that didn't say");
  // Not a version: kept as none.
  await as("latest; drop table", "GET", "/v1/state/head");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await seen(alice))?.app_version, null);
});

test("with no oldest version set, every app is served", async () => {
  const asked = openai.got.length;
  const r = await as(undefined, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" });
  assert.equal(r.status, 200, r.text);
  assert.equal(openai.got.length, asked + 1);
  assert.equal(openai.got.at(-1)!.headers["x-bops-version"], undefined, "the version never reaches OpenAI");
  assert.equal(await socketStatus(undefined), 101);
});

test("blocked below 0.0.18: an older app, or one that doesn't say, is told to update; its state still goes through", async () => {
  await block("0.0.18");
  const asked = openai.got.length;
  // Through /proxy/openai, as OpenAI's SDK reads an error ({ error: { message } }), so the app shows the words.
  for (const version of [undefined, "0.0.17", "0.0.9", "nonsense"]) {
    const r = await as(version, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" });
    assert.equal(r.status, 426, `${version}: ${r.text}`);
    assert.deepEqual(r.json, { error: { message: UPDATE_BOPS, code: "app_update_required" }, code: "app_update_required" });
  }
  assert.equal(openai.got.length, asked, "nothing reached OpenAI");
  // The cloud's own calls, as the app reads them ({ error: "…" }).
  const session = await as("0.0.17", "POST", "/v1/session", {});
  assert.equal(session.status, 426);
  assert.deepEqual(session.json, { error: UPDATE_BOPS, code: "app_update_required" });
  assert.ok(!/—/.test(UPDATE_BOPS), "no dashes");
  // Its state's calls go through, so what it holds isn't lost and the updated app finds it.
  for (const [method, path] of [["GET", "/v1/state/head"], ["GET", "/v1/state"], ["GET", "/v1/messages?after=0"]] as const) {
    const r = await as(undefined, method, path);
    assert.notEqual(r.status, 426, `${method} ${path}`);
  }
  // Its sockets (the tunnel) too.
  assert.equal(await socketStatus("0.0.17"), 426);
  assert.equal(await socketStatus(undefined), 426);
  // The oldest it serves, and anything newer, are served (0.0.100 is newer than 0.0.18).
  for (const version of ["0.0.18", "0.0.100", "0.1.0", "1.0.0"]) {
    const r = await as(version, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" });
    assert.equal(r.status, 200, `${version}: ${r.text}`);
  }
  assert.equal(openai.got.length, asked + 4);
  assert.equal(await socketStatus("0.0.18"), 101);
  // And who's on an old one is there to see.
  await as("0.0.17", "GET", "/v1/state/head");
  await until(async () => (await seen(alice))?.app_version === "0.0.17", "the old app kept");
});

test("a block that isn't a version turns nobody away, and lifting it serves every app again", async () => {
  await block("soon");
  assert.equal((await as(undefined, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" })).status, 200);
  await block("0.0.18");
  assert.equal((await as(undefined, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" })).status, 426);
  await block(null);
  const r = await as(undefined, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" });
  assert.equal(r.status, 200, r.text);
});
