import { trackCloudEvent } from "./analytics.ts";
import type { CloudUser } from "./auth.ts";
import { ensureUserRow, query, tx } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import type { MailHandleBody, MailHandleCheck, MailHandleClaim, MailHandleResult } from "./protocol.ts";
import { loadState } from "./state.ts";

/**
 * Mail handles: each workspace's part of its bots' addresses (boppy@tiger.bops.bot), claimed once
 * across every Bops user in bops.mail_handles (db/migrations/0008_plans.sql). Before these, every
 * user's first workspace was "Main" and every first bot Boppy, so everyone wanted boppy@main.bops.bot.
 *
 * - The user's default workspace (ws_main) takes the user's own handle: their Orgo name, else their
 *   email's part before the @. Any other workspace takes its own name. Both slugified: 3 to 30
 *   lowercase letters, digits and dashes, starting and ending with a letter or digit.
 * - Taken (or kept for Bops: www, mail, api, main…), a number goes on the end: tiger, tiger2, tiger3.
 * - Claimed by one INSERT … ON CONFLICT DO NOTHING on the handle's primary key, so of two users
 *   wanting the same one at once, only one gets it. One current row per (user, workspace).
 * - Changed (at most 3 times), the old handle stays the user's (retired): mail to the old addresses
 *   still arrives, so nobody else may take it, and the user may go back to it.
 * - Within one handle, bot names are unique: they're the user's own bots in one workspace.
 *
 * The app asks GET /v1/mail/handle as the user types, and POST /v1/mail/handle when they pick one
 * (or choose later: the suggestion is claimed for them). A plan set up while the Mac is closed claims
 * the suggestion itself (provision.ts), and the app offers to change it after.
 */

/** The workspace every user has from the start (lib/types.ts MAIN_WORKSPACE): it takes the user's own handle. */
export const MAIN_WORKSPACE = "ws_main";
/** How many times a workspace's handle may be changed. */
export const MAX_CHANGES = 3;

/**
 * Kept for Bops: addresses people would trust as Bops' own, the mail system's own names, and the
 * subdomains everyone shared before handles (main, main-2 … main-25).
 */
const RESERVED = new Set([
  "www", "mail", "email", "api", "app", "admin", "administrator", "support", "help", "main", "bops", "bopsbot", "orgo",
  "team", "teams", "billing", "security", "abuse", "postmaster", "hostmaster", "webmaster", "noreply", "no-reply",
  "root", "info", "status", "smtp", "imap", "pop", "mx", "ns", "ns1", "ns2", "ftp", "staging", "dev", "test",
  "official", "account", "accounts", "login", "verify", "agentmail",
]);
const RULE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/** Letters and digits of anything, lowercase, the rest one dash, at most 30 characters ("Night Owl" → "night-owl"). */
export function slugOf(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

const reserved = (h: string) => RESERVED.has(h) || /^main-\d+$/.test(h);

/** Why a handle can't be used, in words to show, or null when it can (if nobody has it). */
export function handleProblem(h: string): string | null {
  if (h.length < 3 || h.length > 30) return "Use 3 to 30 letters, numbers and dashes.";
  if (!/^[a-z0-9-]+$/.test(h)) return "Use letters, numbers and dashes only.";
  if (!RULE.test(h)) return "Start and end with a letter or a number.";
  if (h.includes("--")) return "Use one dash at a time.";
  if (reserved(h)) return "That one is kept for Bops.";
  return null;
}

/** `base` with a number on the end, cut to fit 30 characters (tiger, tiger2…). */
const numbered = (base: string, n: number) => (n === 1 ? base : `${base.slice(0, 30 - String(n).length).replace(/-+$/, "")}${n}`);

/** The handles in `hs` that someone other than this workspace holds (current or retired). */
async function takenOf(hs: string[], userId: string, workspaceId: string): Promise<Set<string>> {
  if (!hs.length) return new Set();
  const r = await query<{ handle: string }>("SELECT handle FROM bops.mail_handles WHERE handle = ANY($1::text[]) AND NOT (user_id = $2 AND workspace_id = $3)", [hs, userId, workspaceId]);
  return new Set(r.rows.map((x) => x.handle));
}

/** The first of base, base2, base3… that is valid and free; a short base starts at 2 (al → al2). */
async function firstFree(base: string, userId: string, workspaceId: string): Promise<string> {
  const root = base.length >= 2 ? base : `${base}bot`.replace(/^-+/, "") || "bot";
  for (let start = 1; start < 200; start += 25) {
    const candidates = Array.from({ length: 25 }, (_, i) => numbered(root, start + i)).filter((h) => !handleProblem(h));
    const taken = await takenOf(candidates, userId, workspaceId);
    const free = candidates.find((h) => !taken.has(h));
    if (free) return free;
  }
  // 200 people with one name: a few random digits instead.
  return numbered(root, 200 + Math.floor(Math.random() * 99_800));
}

/** Who the user is, for their own handle: their Orgo name and email as the session saw them, else as their Mac last said. */
async function whoIs(user: Pick<CloudUser, "id" | "name" | "email">): Promise<{ name?: string; email?: string }> {
  if (user.name || user.email) return { name: user.name, email: user.email };
  const state = (await loadState(user.id).catch(() => null))?.state as { account?: { user?: { name?: string; email?: string } } } | undefined;
  const account = (await query<{ email: string | null }>("SELECT email FROM bops.cloud_accounts WHERE user_id = $1", [user.id])).rows[0];
  return { name: state?.account?.user?.name, email: state?.account?.user?.email ?? account?.email ?? undefined };
}

/**
 * A free handle for this workspace: the default workspace's from the user's Orgo name, else their
 * email's part before the @; any other workspace's from its name; or, when `from` is given (what
 * the user tried), from that.
 */
export async function suggestHandle(user: Pick<CloudUser, "id" | "name" | "email">, workspaceId: string, opts: { workspaceName?: string; from?: string } = {}): Promise<string> {
  const who = workspaceId === MAIN_WORKSPACE && !opts.from ? await whoIs(user) : {};
  const bases = (opts.from !== undefined ? [opts.from] : workspaceId === MAIN_WORKSPACE ? [who.name, who.email?.split("@")[0]] : [opts.workspaceName]).map(slugOf);
  const base = bases.find((b) => b.length >= 3) ?? bases.find(Boolean) ?? "my-bots";
  return firstFree(base, user.id, workspaceId);
}

type HandleRow = { handle: string; workspace_id: string; auto: boolean; changes: number; retired_at: Date | null };
const claimOf = (r: HandleRow): MailHandleClaim => ({ handle: r.handle, auto: r.auto, changesLeft: Math.max(0, MAX_CHANGES - r.changes) });

/** The workspace's handle now, or null before it has one. */
export async function currentHandle(userId: string, workspaceId: string): Promise<MailHandleClaim | null> {
  const r = await query<HandleRow>("SELECT handle, workspace_id, auto, changes, retired_at FROM bops.mail_handles WHERE user_id = $1 AND workspace_id = $2 AND retired_at IS NULL", [userId, workspaceId]);
  return r.rows[0] ? claimOf(r.rows[0]) : null;
}

/** Every workspace's handle now, by workspace id. */
export async function handlesOf(userId: string): Promise<Record<string, MailHandleClaim>> {
  const r = await query<HandleRow>("SELECT handle, workspace_id, auto, changes, retired_at FROM bops.mail_handles WHERE user_id = $1 AND retired_at IS NULL ORDER BY workspace_id", [userId]);
  return Object.fromEntries(r.rows.map((x) => [x.workspace_id, claimOf(x)]));
}

/** Whether a handle can be this workspace's (GET /v1/mail/handle). */
export async function checkHandle(user: CloudUser, workspaceId: string, tried: string, workspaceName?: string): Promise<MailHandleCheck> {
  const handle = tried.trim().toLowerCase();
  const current = await currentHandle(user.id, workspaceId);
  if (!handle) return { handle, status: "invalid", problem: "Pick a name for your address.", suggestion: current?.handle ?? (await suggestHandle(user, workspaceId, { workspaceName })), current };
  const problem = handleProblem(handle);
  const fromTried = slugOf(handle);
  if (problem) return { handle, status: "invalid", problem, suggestion: await suggestHandle(user, workspaceId, fromTried.length >= 2 ? { from: fromTried } : { workspaceName }), current };
  const holder = (await query<{ user_id: string; workspace_id: string }>("SELECT user_id, workspace_id FROM bops.mail_handles WHERE handle = $1", [handle])).rows[0];
  if (!holder) return { handle, status: "available", suggestion: handle, current };
  if (holder.user_id === user.id && holder.workspace_id === workspaceId) return { handle, status: "yours", suggestion: handle, current };
  return {
    handle,
    status: "taken",
    problem: holder.user_id === user.id ? "Another of your workspaces has it." : "Someone already has that one.",
    suggestion: await suggestHandle(user, workspaceId, { from: handle }),
    current,
  };
}

/** A handle that can't be had: 409 (taken, with a free one to suggest), 400 (invalid) or 429 (changed 3 times already). */
const taken = (suggestion: string, why = "Someone already has that one.") => new HttpError(409, why, { code: "handle_taken", suggestion });
const invalid = (problem: string, suggestion: string) => new HttpError(400, problem, { code: "handle_invalid", suggestion });

/**
 * Claim a handle for one of the user's workspaces, or change it. No `handle`: the suggestion is
 * claimed (`auto`), unless the workspace has one already, which is kept. The same handle again is
 * no change. A change keeps the old one as the user's (retired) and counts against the 3.
 */
export async function claimHandle(user: Pick<CloudUser, "id" | "name" | "email">, workspaceId: string, opts: { handle?: string; workspaceName?: string } = {}): Promise<MailHandleResult> {
  await ensureUserRow(user.id);
  const wanted = opts.handle?.trim().toLowerCase();
  const current = await currentHandle(user.id, workspaceId);
  if (current && (!wanted || wanted === current.handle)) return { workspaceId, ...current };
  if (wanted) {
    const problem = handleProblem(wanted);
    if (problem) throw invalid(problem, await suggestHandle(user, workspaceId, { from: slugOf(wanted).length >= 2 ? slugOf(wanted) : undefined, workspaceName: opts.workspaceName }));
  }
  if (current) return changeHandle(user, workspaceId, wanted!);
  // A first claim. Of two at once (the app and a plan's setup, say), one row wins and the other reads it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = wanted ?? (await suggestHandle(user, workspaceId, { workspaceName: opts.workspaceName }));
    const r = await query<HandleRow>(
      `INSERT INTO bops.mail_handles (handle, user_id, workspace_id, auto) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING handle, workspace_id, auto, changes, retired_at`,
      [handle, user.id, workspaceId, !wanted],
    );
    if (r.rows[0]) {
      trackCloudEvent(user.id, "bops_email_address_claimed", { auto: !wanted }, { once: workspaceId });
      return { workspaceId, ...claimOf(r.rows[0]) };
    }
    const now = await currentHandle(user.id, workspaceId);
    if (now) {
      if (!wanted || wanted === now.handle) return { workspaceId, ...now };
      return changeHandle(user, workspaceId, wanted);
    }
    // Someone else has it (or got it a moment ago); a suggestion that went meanwhile is tried again.
    if (wanted) throw taken(await suggestHandle(user, workspaceId, { from: wanted }));
  }
  throw new HttpError(503, "Couldn't save your address right now. Try again in a minute.");
}

/** Move a workspace to another handle (one of its own old ones, or a free one). The old stays the user's. */
async function changeHandle(user: Pick<CloudUser, "id" | "name" | "email">, workspaceId: string, wanted: string): Promise<MailHandleResult> {
  try {
    return await tx(async (c) => {
      const cur = (await c.query<HandleRow>("SELECT handle, workspace_id, auto, changes, retired_at FROM bops.mail_handles WHERE user_id = $1 AND workspace_id = $2 AND retired_at IS NULL FOR UPDATE", [user.id, workspaceId])).rows[0];
      if (!cur) throw new HttpError(409, "That workspace has no address yet. Try again.");
      if (cur.handle === wanted) return { workspaceId, ...claimOf(cur) };
      if (cur.changes >= MAX_CHANGES) throw new HttpError(429, `You've changed this address ${MAX_CHANGES} times, the most it can be changed.`, { code: "handle_changes_used" });
      const holder = (await c.query<{ user_id: string; workspace_id: string }>("SELECT user_id, workspace_id FROM bops.mail_handles WHERE handle = $1 FOR UPDATE", [wanted])).rows[0];
      if (holder && !(holder.user_id === user.id && holder.workspace_id === workspaceId)) throw taken("", holder.user_id === user.id ? "Another of your workspaces has it." : undefined);
      await c.query("UPDATE bops.mail_handles SET retired_at = now() WHERE handle = $1", [cur.handle]);
      const r = holder
        ? await c.query<HandleRow>("UPDATE bops.mail_handles SET retired_at = NULL, auto = false, changes = $2 WHERE handle = $1 RETURNING handle, workspace_id, auto, changes, retired_at", [wanted, cur.changes + 1])
        : await c.query<HandleRow>(
            "INSERT INTO bops.mail_handles (handle, user_id, workspace_id, auto, changes) VALUES ($1, $2, $3, false, $4) RETURNING handle, workspace_id, auto, changes, retired_at",
            [wanted, user.id, workspaceId, cur.changes + 1],
          );
      return { workspaceId, ...claimOf(r.rows[0]), previous: cur.handle };
    });
  } catch (e) {
    // Someone took it between the check and the insert (its primary key), or the error above: either way it's taken.
    if ((e as { code?: string }).code === "23505" || (e instanceof HttpError && e.status === 409 && (e.extra?.code === "handle_taken"))) {
      const why = e instanceof HttpError ? e.message : undefined;
      throw taken(await suggestHandle(user, workspaceId, { from: wanted }), why);
    }
    throw e;
  }
}

/* ---------------- Routes ---------------- */

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const workspaceOf = (x: unknown) => {
  const id = typeof x === "string" ? x.trim() : "";
  if (!WORKSPACE_ID.test(id)) throw new HttpError(400, "Which workspace? (workspace)");
  return id;
};
const nameOf = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 80) : undefined);

export const routes: Route[] = [
  {
    method: "GET",
    path: "/v1/mail/handle",
    auth: "user",
    handle: async (_req, res, { user, url }) => {
      const workspaceId = workspaceOf(url.searchParams.get("workspace") ?? url.searchParams.get("workspaceId"));
      sendJson(res, 200, await checkHandle(user!, workspaceId, (url.searchParams.get("try") ?? "").slice(0, 64), nameOf(url.searchParams.get("name"))));
    },
  },
  {
    method: "GET",
    path: "/v1/mail/handles",
    auth: "user",
    handle: async (_req, res, { user }) => sendJson(res, 200, { handles: await handlesOf(user!.id) }),
  },
  {
    method: "POST",
    path: "/v1/mail/handle",
    auth: "user",
    handle: async (req, res, { user }) => {
      const body = await readJson<Partial<MailHandleBody>>(req);
      const workspaceId = workspaceOf(body.workspaceId);
      const handle = typeof body.handle === "string" && body.handle.trim() ? body.handle.slice(0, 64) : undefined;
      sendJson(res, 200, await claimHandle(user!, workspaceId, { handle, workspaceName: nameOf(body.workspaceName) }));
    },
  },
];
