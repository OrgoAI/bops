// The made-up people, keys and test account of the local two-person stack (scripts/dev-two-person.mjs) and its
// end-to-end test (scripts/test-browser-tab-e2e.mjs). None of it is real: the keys are plain strings only the stack's
// fake orgo-web knows, the computer is a headless Chrome on this Mac, the account signs in to a test page the stack
// serves. Nothing here ever reaches Orgo, Bops Cloud or any real site.

/**
 * Sam's role in the shared workspace, as the fake orgo-web says it: "member" (the default: Write on the bot and Use its
 * computer, kept in the owner's state) or "admin" (TWO_PERSON_MEMBER_ROLE=admin: Orgo's Admin, with no entry of their own;
 * Bops Cloud gives an Admin every bot and its computer, cloud/ws-slice.ts viewerAccess).
 */
export const SAM_ROLE = process.env.TWO_PERSON_MEMBER_ROLE === "admin" ? "admin" : "member";

/** The owner of the shared workspace, and their teammate with Write on its bot and Use its computer. */
export const OWNER = { id: "u-two-person-owner", email: "owner@two-person.test", name: "Tess Owner", key: "two-person-test-key-owner" };
export const SAM = { id: "u-two-person-sam", email: "sam@two-person.test", name: "Sam", key: "two-person-test-key-sam" };

/** The Orgo workspace (orgo-web project) the owner shares, and its Bops workspace. */
export const PROJECT = { id: "proj-two-person-acme", name: "Acme", wsId: "ws_main" };

/** The bot's computer: the stand-in Chrome. Its id is a made-up UUID; its key signs the relay in as that computer. */
export const COMPUTER = { id: "6f1c2e8a-0b1d-4c2e-9a00-00000000b1b1", key: "two-person-test-key-computer", display: 100 };

/** The bot the owner gave Sam Write on. */
export const BOT = { id: "boppy", name: "Boppy" };

/** The test site's one account (scripts/dev-two-person.mjs serves its sign-in page). */
export const ACCOUNT = { user: "sam.test", password: "not-a-real-password-7311", name: "Sam Test at Acme" };

/** The owner's state as the stack seeds it in Bops Cloud before either app starts: the bot on its computer, Sam's access. */
export function ownerState(now = Date.now()) {
  return {
    account: { user: { id: OWNER.id, email: OWNER.email, name: OWNER.name } },
    owner: { name: OWNER.name },
    host: "orgo",
    bots: [{ id: BOT.id, name: BOT.name, role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerId: COMPUTER.id, computerStatus: "ready", workspaceId: PROJECT.wsId }],
    workspace: PROJECT.wsId,
    workspaces: [
      {
        id: PROJECT.wsId,
        name: PROJECT.name,
        createdAt: now,
        orgoProjectId: PROJECT.id,
        memberAccess: SAM_ROLE === "admin" ? {} : { [SAM.email]: { others: "none", bots: { [BOT.id]: "write" }, apps: "none", computer: "use", at: now } },
      },
    ],
  };
}

/** What the fake orgo-web says each key is (GET /api/user/profile). The computer's key is that computer's alone. */
export function profileFor(key) {
  if (key === OWNER.key) return { id: OWNER.id, email: OWNER.email, full_name: OWNER.name };
  if (key === SAM.key) return { id: SAM.id, email: SAM.email, full_name: SAM.name };
  if (key === COMPUTER.key) return { id: OWNER.id, email: OWNER.email, api_key: { scope: "computer", computer_id: COMPUTER.id } };
  return null;
}

/** Who each user is in the shared workspace (GET /api/projects/<id>/bops-role), or null: no access. */
export function roleFor(key, projectId) {
  if (projectId !== PROJECT.id) return null;
  if (key === OWNER.key) return { role: "owner", ownerUserId: OWNER.id, bopsWsId: PROJECT.wsId, name: PROJECT.name };
  if (key === SAM.key) return SAM_ROLE === "admin" ? { role: "admin", ownerUserId: OWNER.id, bopsWsId: PROJECT.wsId, name: PROJECT.name } : { role: "member", ownerUserId: OWNER.id, bopsWsId: PROJECT.wsId, name: PROJECT.name, computerUse: true };
  return null;
}

/** The Orgo workspaces each user's switcher lists (GET /api/workspaces). */
export function workspacesFor(key) {
  if (key === OWNER.key) return [{ id: PROJECT.id, name: PROJECT.name, role: "owner", product: "bops", bops_ws_id: PROJECT.wsId }];
  if (key === SAM.key) return [{ id: PROJECT.id, name: PROJECT.name, role: SAM_ROLE, product: "bops", bops_ws_id: PROJECT.wsId, owner_email: OWNER.email }];
  return null;
}
