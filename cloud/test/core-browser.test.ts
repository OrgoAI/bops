import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mayUseBrowser, resetBrowser } from "../browser.ts";
import { resetMembers } from "../members.ts";
import { BROWSER_SHARED_COMPUTER, type WsAccess } from "../protocol.ts";

/**
 * Who may watch a bot's browser when bots share a computer (browser.ts mayUseBrowser): bots on one computer share its
 * screens (lib/server/browser-runner.ts screenFor), so watching one shows, and taking over drives, whichever screen any
 * of them holds. Someone other than the owner watches only a computer whose every bot is of their workspace and theirs
 * at Write: never one a bot hidden from them works on, nor another workspace's main bot on the free computer. orgo-web
 * is a fake fetch and the owner's state a fake; nothing here needs a database.
 */

const OWNER = "u-owner";
const ACME = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OWN = "1f1e1d1c-1b1a-4918-8716-151413121110";
const at = 1_700_000_000_000;
const state = {
  workspaces: [
    {
      id: "ws_acme",
      name: "Acme",
      memberAccess: {
        // Dana works on Max's computer (a bot with none of its own), and Max is hidden from them.
        "hid@example.com": { others: "none", bots: { dana: "write" }, computer: "use", at },
        // Both bots on that computer, at Write.
        "both@example.com": { others: "none", bots: { max: "write", dana: "write" }, computer: "use", at },
        // Max at Write, Dana (on the same computer) at Read only.
        "half@example.com": { others: "none", bots: { max: "write", dana: "read" }, computer: "use", at },
        // Ella has a computer of her own.
        "ella@example.com": { others: "none", bots: { ella: "write" }, computer: "use", at },
      },
    },
    // Beta's main bot has no computer of its own: it works on the free one Acme's main bot holds.
    { id: "ws_beta", name: "Beta", memberAccess: { "bee@example.com": { others: "none", bots: { bmain: "write" }, computer: "use", at } } },
  ],
  bots: [
    { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computer: "own", computerId: ACME, freeComputer: true },
    { id: "dana", name: "Dana", workspaceId: "ws_acme" },
    { id: "ella", name: "Ella", workspaceId: "ws_acme", computer: "own", computerId: OWN },
    { id: "bmain", name: "Beta main", isMain: true, workspaceId: "ws_beta", computer: "shared" },
  ],
};

const roles: Record<string, WsAccess> = {};
const role = (who: string, project: string, r: WsAccess["role"], ws: string) =>
  (roles[`key-${who} ${project}`] = { role: r, ownerUserId: OWNER, bopsWsId: ws, name: ws, ...(r === "member" ? { computerUse: true } : {}) });
for (const who of ["hid", "both", "half", "ella"]) role(who, "p-acme", "member", "ws_acme");
role("bee", "p-beta", "member", "ws_beta");
role("acme-admin", "p-acme", "admin", "ws_acme");
role("beta-admin", "p-beta", "admin", "ws_beta");
role("owner", "p-acme", "owner", "ws_acme");

const fakeOrgo = (async (input: string | URL | Request, init?: RequestInit) => {
  const key = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1] ?? "";
  const project = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(new URL(String(input)).pathname)?.[1] ?? "";
  const a = roles[`${key} ${project}`];
  return a ? Response.json(a) : new Response("{}", { status: 404 });
}) as typeof fetch;

beforeEach(() => {
  resetMembers({ fetch: fakeOrgo, state: async () => state });
  resetBrowser({ state: async (account) => (account === OWNER ? state : {}) });
});

/** mayUseBrowser for `who` in `project` (null: their own account's bot): the computer it gives, or the refusal's status and code. */
const ask = (who: string, project: string | null, bot: string) =>
  mayUseBrowser({ id: who === "owner" ? OWNER : `u-${who}`, email: `${who}@example.com` }, `key-${who}`, project, bot).then(
    (a) => ({ desktop: a.desktop }),
    (e: { status: number; extra?: { code?: string }; message: string }) => ({ status: e.status, code: e.extra?.code, why: e.message }),
  );

test("a member given a bot that works on a hidden bot's computer can't watch or take over its browser", async () => {
  const r = await ask("hid", "p-acme", "dana");
  assert.equal("status" in r && r.status, 403);
  assert.equal("code" in r && r.code, BROWSER_SHARED_COMPUTER);
  assert.match("why" in r ? r.why : "", /^Dana shares its computer with bots you don't have, so only the owner can watch its browser\.$/);
  assert.deepEqual(await ask("hid", "p-acme", "max"), { status: 404, code: undefined, why: "No such bot" }, "the hidden bot itself stays no bot at all");
  // Read on a bot sharing the computer isn't enough either: taking over drives whichever screen that bot holds.
  assert.equal(((await ask("half", "p-acme", "max")) as { code?: string }).code, BROWSER_SHARED_COMPUTER);
});

test("another workspace's teammate, or its Admin, never reaches the free computer a main bot shares across workspaces", async () => {
  assert.equal(((await ask("bee", "p-beta", "bmain")) as { code?: string }).code, BROWSER_SHARED_COMPUTER);
  assert.equal(((await ask("beta-admin", "p-beta", "bmain")) as { code?: string }).code, BROWSER_SHARED_COMPUTER);
});

test("Write on every bot of the computer, a computer of the bot's own, an Admin of that workspace and the owner still watch", async () => {
  assert.deepEqual(await ask("ella", "p-acme", "ella"), { desktop: OWN });
  assert.deepEqual(await ask("acme-admin", "p-acme", "ella"), { desktop: OWN });
  // Max's computer also has Beta's main bot on it (the free one): nobody but the owner watches there now.
  assert.equal(((await ask("both", "p-acme", "dana")) as { code?: string }).code, BROWSER_SHARED_COMPUTER);
  assert.equal(((await ask("acme-admin", "p-acme", "max")) as { code?: string }).code, BROWSER_SHARED_COMPUTER);
  assert.deepEqual(await ask("owner", "p-acme", "dana"), { desktop: ACME });
  assert.deepEqual(await ask("owner", null, "bmain"), { desktop: ACME });
  // Without Beta's main bot there, both of Max's computer's bots at Write is enough.
  const alone = { ...state, bots: state.bots.filter((b) => b.id !== "bmain") };
  resetMembers({ fetch: fakeOrgo, state: async () => alone });
  resetBrowser({ state: async () => alone });
  assert.deepEqual(await ask("both", "p-acme", "dana"), { desktop: ACME });
  assert.deepEqual(await ask("acme-admin", "p-acme", "max"), { desktop: ACME });
});
