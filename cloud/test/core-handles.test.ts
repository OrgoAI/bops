import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { claimHandle, handleProblem, slugOf, suggestHandle } from "../handles.ts";
import { call, dropUsers, keyOf, listen, newUserId, prepareDb, startCloud, type Listening } from "./core-fakes.ts";

/**
 * Mail handles (handles.ts): each workspace's part of its bots' addresses, claimed once across every
 * user. Suggested from the Orgo name (or email) and the workspace's name, numbered when taken, never
 * a reserved word, claimed atomically, changed at most 3 times with the old ones kept for the user.
 */

const users: string[] = [];
/** A name nobody else in the test database has, so runs and files at once don't collide. */
const word = () => `t${randomBytes(4).toString("hex")}`;
const names = new Map<string, { name?: string; email: string }>();
let orgo: Listening, cloud: Listening;

before(async () => {
  await prepareDb();
  // Orgo's profile, with the name each test gave its user.
  orgo = await listen(
    createServer((req, res) => {
      const userId = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const who = userId ? names.get(userId) : undefined;
      if (req.url !== "/api/user/profile" || !userId) return void res.writeHead(401).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: userId, email: who?.email ?? `${userId}@example.com`, ...(who?.name ? { name: who.name } : {}) }));
    }),
  );
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  cloud = await startCloud();
});

after(async () => {
  await dropUsers(users);
  await Promise.all([cloud?.close(), orgo?.close()]);
  await closeDb();
});

const user = (who: { name?: string; email?: string } = {}) => {
  const id = newUserId("handle");
  users.push(id);
  names.set(id, { name: who.name, email: who.email ?? `${id}@example.com` });
  return id;
};
const check = (id: string, workspace: string, tried: string, name?: string) =>
  call(cloud.url, "GET", `/v1/mail/handle?workspace=${workspace}&try=${encodeURIComponent(tried)}${name ? `&name=${encodeURIComponent(name)}` : ""}`, { key: keyOf(id) });
const claim = (id: string, body: Record<string, unknown>) => call(cloud.url, "POST", "/v1/mail/handle", { key: keyOf(id), json: body });

test("handles: 3 to 30 letters, digits and dashes, no reserved words", () => {
  assert.equal(slugOf("Night Owl"), "night-owl");
  assert.equal(slugOf("  Café_Ölé!! "), "cafe-ole");
  assert.equal(slugOf("x".repeat(40)), "x".repeat(30));
  assert.equal(slugOf("a-".repeat(20)), "a-a-a-a-a-a-a-a-a-a-a-a-a-a-a", "a cut never ends on a dash");
  assert.equal(handleProblem("tiger"), null);
  assert.equal(handleProblem("t2"), "Use 3 to 30 letters, numbers and dashes.");
  assert.equal(handleProblem("x".repeat(31)), "Use 3 to 30 letters, numbers and dashes.");
  assert.equal(handleProblem("ti_ger"), "Use letters, numbers and dashes only.");
  assert.equal(handleProblem("-tiger"), "Start and end with a letter or a number.");
  assert.equal(handleProblem("ti--ger"), "Use one dash at a time.");
  for (const r of ["www", "mail", "api", "admin", "support", "main", "bops", "orgo", "team", "help", "main-7"]) assert.equal(handleProblem(r), "That one is kept for Bops.", r);
});

test("the default workspace is suggested from the Orgo name, else the email; a taken one gets a number", async () => {
  const w = word();
  const first = user({ name: `${w} Lane` });
  const viaEmail = user({ email: `${w}.mail@example.com` });
  assert.equal(await suggestHandle({ id: first, name: `${w} Lane` }, "ws_main"), `${w}-lane`);
  assert.equal(await suggestHandle({ id: viaEmail, email: `${w}.mail@example.com` }, "ws_main"), `${w}-mail`);
  await claimHandle({ id: first, name: `${w} Lane` }, "ws_main");
  const second = user({ name: `${w} Lane` });
  assert.equal(await suggestHandle({ id: second, name: `${w} Lane` }, "ws_main"), `${w}-lane2`);
  // Another workspace is suggested from its own name; a short one starts numbered; a reserved one gets a number.
  assert.equal(await suggestHandle({ id: second }, "ws_acme", { workspaceName: `Acme ${w}` }), `acme-${w}`);
  assert.equal(await suggestHandle({ id: second }, "ws_x", { workspaceName: "Al" }).then((h) => /^al\d+$/.test(h)), true);
  assert.equal(await suggestHandle({ id: second }, "ws_y", { workspaceName: "Team" }).then((h) => /^team\d+$/.test(h)), true);
});

test("GET /v1/mail/handle answers available, taken, invalid or yours, always with a free suggestion", async () => {
  const w = word();
  const tiger = user({ name: w });
  const other = user({ name: `${w} other` });
  let r = await check(tiger, "ws_main", "");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "invalid");
  assert.equal(r.json.suggestion, w, "from the Orgo name");
  r = await check(tiger, "ws_main", w.toUpperCase());
  assert.deepEqual([r.json.status, r.json.handle, r.json.suggestion], ["available", w, w], "typed in capitals is the same handle");
  assert.equal((await claim(tiger, { workspaceId: "ws_main", handle: w })).status, 200);
  r = await check(tiger, "ws_main", w);
  assert.equal(r.json.status, "yours");
  assert.deepEqual(r.json.current, { handle: w, auto: false, changesLeft: 3 });
  r = await check(other, "ws_main", w);
  assert.deepEqual([r.json.status, r.json.problem, r.json.suggestion], ["taken", "Someone already has that one.", `${w}2`]);
  r = await check(other, "ws_main", "mail");
  assert.deepEqual([r.json.status, r.json.problem], ["invalid", "That one is kept for Bops."]);
  assert.match(r.json.suggestion, /^mail\d+$/);
  // The user's other workspace can't have the same handle either.
  r = await check(tiger, "ws_two", w);
  assert.deepEqual([r.json.status, r.json.problem], ["taken", "Another of your workspaces has it."]);
  assert.equal((await call(cloud.url, "GET", "/v1/mail/handle?workspace=../x&try=a", { key: keyOf(tiger) })).status, 400);
  assert.equal((await call(cloud.url, "GET", "/v1/mail/handle?workspace=ws_main&try=a")).status, 401);
});

test("of two users claiming one handle at once, exactly one gets it; the other is told what's free", async () => {
  const w = word();
  const ids = [user(), user(), user(), user()];
  const all = await Promise.all(ids.map((id) => claim(id, { workspaceId: "ws_main", handle: w })));
  const won = all.filter((r) => r.status === 200);
  assert.equal(won.length, 1, all.map((r) => r.text).join(" | "));
  for (const lost of all.filter((r) => r.status !== 200)) {
    assert.equal(lost.status, 409);
    assert.equal(lost.json.code, "handle_taken");
    assert.match(lost.json.suggestion, new RegExp(`^${w}\\d+$`));
  }
  assert.equal((await query("SELECT count(*)::int AS n FROM bops.mail_handles WHERE handle = $1", [w])).rows[0].n, 1);
});

test("choosing later claims the suggestion (auto); claiming again keeps it; one current handle per workspace", async () => {
  const w = word();
  const id = user({ name: w });
  const all = await Promise.all([claim(id, { workspaceId: "ws_main" }), claim(id, { workspaceId: "ws_main" }), claim(id, { workspaceId: "ws_main" })]);
  for (const r of all) assert.equal(r.status, 200, r.text);
  assert.deepEqual(new Set(all.map((r) => r.json.handle)), new Set([w]));
  assert.deepEqual(all[0].json, { workspaceId: "ws_main", handle: w, auto: true, changesLeft: 3 });
  const rows = (await query("SELECT handle FROM bops.mail_handles WHERE user_id = $1 AND retired_at IS NULL", [id])).rows;
  assert.equal(rows.length, 1);
  // A second workspace is its own, from its name.
  const acme = await claim(id, { workspaceId: "ws_acme", workspaceName: `Acme ${w}` });
  assert.equal(acme.json.handle, `acme-${w}`);
  const session = await call(cloud.url, "GET", "/v1/mail/handles", { key: keyOf(id) });
  assert.deepEqual(session.json.handles, { ws_main: { handle: w, auto: true, changesLeft: 3 }, ws_acme: { handle: `acme-${w}`, auto: true, changesLeft: 3 } });
});

test("a handle changes at most 3 times; the old ones stay the user's, and they can go back", async () => {
  const w = word();
  const id = user();
  const someone = user();
  assert.equal((await claim(id, { workspaceId: "ws_main", handle: `${w}-a` })).status, 200);
  let r = await claim(id, { workspaceId: "ws_main", handle: `${w}-b` });
  assert.deepEqual(r.json, { workspaceId: "ws_main", handle: `${w}-b`, auto: false, changesLeft: 2, previous: `${w}-a` });
  // Mail to the old addresses still arrives: nobody else may take the old handle.
  r = await claim(someone, { workspaceId: "ws_main", handle: `${w}-a` });
  assert.equal(r.status, 409);
  assert.equal((await check(id, "ws_main", `${w}-a`)).json.status, "yours");
  r = await claim(id, { workspaceId: "ws_main", handle: `${w}-a` });
  assert.deepEqual([r.status, r.json.handle, r.json.changesLeft, r.json.previous], [200, `${w}-a`, 1, `${w}-b`], "back to an old one");
  r = await claim(id, { workspaceId: "ws_main", handle: `${w}-c` });
  assert.deepEqual([r.status, r.json.changesLeft], [200, 0]);
  r = await claim(id, { workspaceId: "ws_main", handle: `${w}-d` });
  assert.equal(r.status, 429);
  assert.equal(r.json.code, "handle_changes_used");
  r = await claim(id, { workspaceId: "ws_main", handle: `${w}-c` });
  assert.equal(r.status, 200, "the same one again isn't a change");
  const current = (await query("SELECT handle FROM bops.mail_handles WHERE user_id = $1 AND workspace_id = 'ws_main' AND retired_at IS NULL", [id])).rows;
  assert.deepEqual(current, [{ handle: `${w}-c` }]);
  r = await claim(id, { workspaceId: "ws_main", handle: "Not Valid" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "handle_invalid");
  assert.match(r.json.suggestion, /^not-valid\d*$/);
});

test("the session hands the app its handles", async () => {
  const w = word();
  const id = user({ name: w });
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}'::jsonb, 0) ON CONFLICT DO NOTHING", [id]);
  await claimHandle({ id, name: w }, "ws_main");
  const saved = { ...process.env };
  try {
    for (const k of ["AGENTMAIL_API_KEY", "AGENTPHONE_API_KEY"]) delete process.env[k];
    const r = await call(cloud.url, "POST", "/v1/session", { key: keyOf(id) });
    assert.equal(r.status, 200, r.text);
    // No AgentMail on this cloud: no handles to hand out either.
    assert.equal(r.json.agentmail, null);
    assert.deepEqual(r.json.plan, { tier: "free_bops", limits: false });
  } finally {
    Object.assign(process.env, saved);
  }
});
