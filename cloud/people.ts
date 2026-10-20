import { randomBytes } from "node:crypto";
import type { CloudUser } from "./auth.ts";
import { query, tx } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import type { CloudConvo, CloudConvoMessage, CloudPerson, PeopleSync } from "./protocol.ts";
import { notifyMac } from "./tunnel.ts";

/**
 * People: Bops users messaging each other, one to one and in groups. Each user's chats with their own
 * bots stay theirs (state.ts); a conversation between people lives here once, for everyone in it
 * (db/migrations/0014_people.sql), and each member's Mac mirrors it (lib/server/people.ts).
 *
 * - Someone is found by their email, exactly (POST /v1/people/find): nobody can list who's on Bops. An
 *   email that isn't on Bops yet is asked in, and joins when they sign in with it (Orgo checked it).
 * - Every change a member should see (a message, who's in it, its name, what someone read) takes the
 *   next number of bops.people_seq. A Mac asks for what changed since the last number it saw
 *   (GET /v1/people/sync?after=), and the cloud tells each member's connected Mac to ask (a "people"
 *   frame on the tunnel). A Mac that was away asks when it connects, so nothing has to wait in a queue.
 * - Only members read or write a conversation; one who left keeps what they saw and gets nothing new.
 */

const MAX_TEXT = 20_000;
const MAX_JSON = 64_000;
const MAX_MEMBERS = 50;
const PAGE = 500;
const ID = /^[A-Za-z0-9_-]{6,80}$/;

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
const emailOf = (x: unknown) => (typeof x === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim()) ? x.trim().toLowerCase() : null);

/* ---------------- Who's on Bops ---------------- */

/** When each user's directory row was last written by this process: written again at most every few minutes. */
const greeted = new Map<string, number>();
const GREET_EVERY_MS = 5 * 60_000;

/**
 * Keep the user in the directory (their email and name as Orgo has them now), and put them in the
 * conversations their email was asked into. Done on every people call, at most every few minutes.
 */
export async function greet(user: CloudUser, force = false) {
  if (!force && Date.now() - (greeted.get(user.id) ?? 0) < GREET_EVERY_MS) return;
  greeted.set(user.id, Date.now());
  const email = emailOf(user.email);
  await tx(async (c) => {
    // An email moves with whoever Orgo says has it now.
    if (email) await c.query("UPDATE bops.people SET email = NULL WHERE lower(email) = $1 AND user_id <> $2", [email, user.id]);
    await c.query(
      `INSERT INTO bops.people (user_id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, name = COALESCE(EXCLUDED.name, bops.people.name), updated_at = now()`,
      [user.id, email, user.name?.trim() || null],
    );
  });
  if (!email) return;
  const joined = await query<{ convo_id: string }>(
    `WITH asked AS (DELETE FROM bops.convo_invites WHERE lower(email) = $2 RETURNING convo_id, invited_by)
     INSERT INTO bops.convo_members (convo_id, user_id, added_by) SELECT convo_id, $1, invited_by FROM asked
     ON CONFLICT (convo_id, user_id) DO UPDATE SET left_at = NULL
     RETURNING convo_id`,
    [user.id, email],
  );
  for (const r of joined.rows) await changed(r.convo_id);
}

async function person(userId: string): Promise<CloudPerson> {
  const r = await query<{ email: string | null; name: string | null }>("SELECT email, name FROM bops.people WHERE user_id = $1", [userId]);
  return { userId, email: r.rows[0]?.email ?? null, name: r.rows[0]?.name ?? null };
}

/** Someone on Bops by their exact email, or null. */
export async function findByEmail(email: string): Promise<CloudPerson | null> {
  const r = await query<{ user_id: string; email: string | null; name: string | null }>("SELECT user_id, email, name FROM bops.people WHERE lower(email) = $1", [email.toLowerCase()]);
  const p = r.rows[0];
  return p ? { userId: p.user_id, email: p.email, name: p.name } : null;
}

/* ---------------- Conversations ---------------- */

const isMember = async (convoId: string, userId: string) =>
  !!(await query("SELECT 1 FROM bops.convo_members WHERE convo_id = $1 AND user_id = $2 AND left_at IS NULL", [convoId, userId])).rowCount;

/** Who's in a conversation now, and who just left (they hear that they're out). */
async function membersOf(convoId: string, withLeft = false) {
  const r = await query<{ user_id: string }>(`SELECT user_id FROM bops.convo_members WHERE convo_id = $1 ${withLeft ? "" : "AND left_at IS NULL"}`, [convoId]);
  return r.rows.map((x) => x.user_id);
}

/** Something about a conversation changed: it takes the next number, and its members' Macs come and read it. */
async function changed(convoId: string, opts: { notify?: string[] } = {}) {
  const r = await query<{ seq: string }>("UPDATE bops.convos SET seq = nextval('bops.people_seq') WHERE id = $1 RETURNING seq", [convoId]);
  const seq = Number(r.rows[0]?.seq ?? 0);
  for (const userId of opts.notify ?? (await membersOf(convoId, true))) notifyMac(userId, { t: "people", seq });
  return seq;
}

/**
 * Start a conversation with people (their user ids from an earlier conversation, or emails). One other
 * person and no name makes a direct message, the same one each time; more, or a name, a group.
 * Emails not on Bops are asked in.
 */
export async function startConvo(user: CloudUser, ask: { userIds?: unknown; emails?: unknown; title?: unknown }) {
  await greet(user);
  const ids = new Set<string>(Array.isArray(ask.userIds) ? ask.userIds.filter((x): x is string => typeof x === "string" && x.length < 100) : []);
  const invited: string[] = [];
  for (const raw of Array.isArray(ask.emails) ? ask.emails : []) {
    const email = emailOf(raw);
    if (!email) throw new HttpError(400, `"${String(raw).slice(0, 80)}" isn't an email.`);
    const p = await findByEmail(email);
    if (p) ids.add(p.userId);
    else invited.push(email);
  }
  ids.delete(user.id);
  if (!ids.size && !invited.length) throw new HttpError(400, "Add someone to message.");
  if (ids.size + invited.length + 1 > MAX_MEMBERS) throw new HttpError(400, `A conversation can have ${MAX_MEMBERS} people at most.`);
  const title = typeof ask.title === "string" && ask.title.trim() ? ask.title.trim().slice(0, 80) : null;
  const others = [...ids];
  let convoId: string;
  if (others.length === 1 && !invited.length && !title) {
    // The two of them have one direct message: found again, or made.
    const dmKey = [user.id, others[0]].sort().join(":");
    convoId = await tx(async (c) => {
      const made = await c.query<{ id: string }>(
        "INSERT INTO bops.convos (id, kind, dm_key, created_by) VALUES ($1, 'dm', $2, $3) ON CONFLICT (dm_key) DO NOTHING RETURNING id",
        [newId("dm"), dmKey, user.id],
      );
      const id = made.rows[0]?.id ?? (await c.query<{ id: string }>("SELECT id FROM bops.convos WHERE dm_key = $1", [dmKey])).rows[0].id;
      for (const u of [user.id, others[0]])
        await c.query("INSERT INTO bops.convo_members (convo_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT (convo_id, user_id) DO UPDATE SET left_at = NULL", [id, u, user.id]);
      return id;
    });
  } else {
    convoId = newId("grp");
    await tx(async (c) => {
      await c.query("INSERT INTO bops.convos (id, kind, title, created_by) VALUES ($1, 'group', $2, $3)", [convoId, title, user.id]);
      for (const u of [user.id, ...others]) await c.query("INSERT INTO bops.convo_members (convo_id, user_id, added_by) VALUES ($1, $2, $3)", [convoId, u, user.id]);
      for (const email of invited) await c.query("INSERT INTO bops.convo_invites (convo_id, email, invited_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [convoId, email, user.id]);
    });
  }
  const seq = await changed(convoId);
  return { convoId, seq, invited };
}

/** Add people to a group (by user id or email), take one out (its maker, or themselves), leave, or rename it. */
export async function changeMembers(user: CloudUser, ask: { convoId?: unknown; add?: unknown; remove?: unknown; leave?: unknown; title?: unknown }) {
  const convoId = typeof ask.convoId === "string" ? ask.convoId : "";
  if (!(await isMember(convoId, user.id))) throw new HttpError(404, "No such conversation.");
  const convo = (await query<{ kind: string; created_by: string }>("SELECT kind, created_by FROM bops.convos WHERE id = $1", [convoId])).rows[0];
  const before = await membersOf(convoId);
  if (ask.leave === true) {
    await query("UPDATE bops.convo_members SET left_at = now() WHERE convo_id = $1 AND user_id = $2", [convoId, user.id]);
    return { seq: await changed(convoId, { notify: before }) };
  }
  if (convo.kind !== "group") throw new HttpError(400, "Make a group to add people or name it.");
  const invited: string[] = [];
  for (const raw of Array.isArray(ask.add) ? ask.add : []) {
    const email = emailOf(raw);
    const userId = email ? (await findByEmail(email))?.userId : typeof raw === "string" ? raw : undefined;
    if (userId && before.length + 1 > MAX_MEMBERS) throw new HttpError(400, `A conversation can have ${MAX_MEMBERS} people at most.`);
    if (userId)
      await query("INSERT INTO bops.convo_members (convo_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT (convo_id, user_id) DO UPDATE SET left_at = NULL", [convoId, userId, user.id]);
    else if (email) {
      await query("INSERT INTO bops.convo_invites (convo_id, email, invited_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [convoId, email, user.id]);
      invited.push(email);
    }
  }
  if (typeof ask.remove === "string") {
    if (ask.remove !== user.id && convo.created_by !== user.id) throw new HttpError(403, "Only whoever made the group can take people out.");
    await query("UPDATE bops.convo_members SET left_at = now() WHERE convo_id = $1 AND user_id = $2", [convoId, ask.remove]);
  }
  if (typeof ask.title === "string") await query("UPDATE bops.convos SET title = $2 WHERE id = $1", [convoId, ask.title.trim().slice(0, 80) || null]);
  return { seq: await changed(convoId, { notify: [...new Set([...before, ...(await membersOf(convoId))])] }), invited };
}

/** Post a message (sending it again with the same id changes nothing). */
export async function send(user: CloudUser, ask: { convoId?: unknown; id?: unknown; text?: unknown; json?: unknown; botId?: unknown }) {
  const convoId = typeof ask.convoId === "string" ? ask.convoId : "";
  if (!(await isMember(convoId, user.id))) throw new HttpError(404, "No such conversation.");
  const id = typeof ask.id === "string" && ID.test(ask.id) ? ask.id : null;
  if (!id) throw new HttpError(400, "A message needs an id.");
  const text = typeof ask.text === "string" ? ask.text.slice(0, MAX_TEXT) : "";
  const json = ask.json && typeof ask.json === "object" && !Array.isArray(ask.json) ? ask.json : null;
  if (json && JSON.stringify(json).length > MAX_JSON) throw new HttpError(413, "That message is too big.");
  if (!text.trim() && !json) throw new HttpError(400, "Say something.");
  const botId = typeof ask.botId === "string" && ask.botId.length < 100 ? ask.botId : null;
  const r = await query<{ seq: string }>(
    `INSERT INTO bops.convo_messages (convo_id, id, author, bot_id, text, json, at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (convo_id, id) DO NOTHING RETURNING seq`,
    [convoId, id, user.id, botId, text, json ? JSON.stringify(json) : null, Date.now()],
  );
  const seq = Number(r.rows[0]?.seq ?? 0);
  if (seq) for (const u of await membersOf(convoId)) notifyMac(u, { t: "people", seq });
  return { seq };
}

/** The user has read up to `seq`: what the others see as "Seen". */
export async function markRead(user: CloudUser, ask: { convoId?: unknown; seq?: unknown }) {
  const convoId = typeof ask.convoId === "string" ? ask.convoId : "";
  const seq = typeof ask.seq === "number" && Number.isFinite(ask.seq) ? Math.floor(ask.seq) : 0;
  const r = await query("UPDATE bops.convo_members SET read_seq = $3 WHERE convo_id = $1 AND user_id = $2 AND left_at IS NULL AND read_seq < $3", [convoId, user.id, seq]);
  return { seq: r.rowCount ? await changed(convoId) : 0 };
}

/** Typing: told to the others' connected Macs, never kept. */
export async function typing(user: CloudUser, ask: { convoId?: unknown }) {
  const convoId = typeof ask.convoId === "string" ? ask.convoId : "";
  if (!(await isMember(convoId, user.id))) return;
  for (const u of await membersOf(convoId)) if (u !== user.id) notifyMac(u, { t: "people", seq: 0, typing: { convoId, userId: user.id } });
}

/** What changed in the user's conversations since `after`: conversations (with who's in them) and messages, oldest first. */
export async function sync(user: CloudUser, after: number): Promise<PeopleSync> {
  await greet(user);
  const convoRows = await query<{ id: string; kind: "dm" | "group"; title: string | null; created_by: string; seq: string; left_at: Date | null }>(
    `SELECT c.id, c.kind, c.title, c.created_by, c.seq, m.left_at FROM bops.convos c
     JOIN bops.convo_members m ON m.convo_id = c.id AND m.user_id = $1
     WHERE c.seq > $2 ORDER BY c.seq`,
    [user.id, after],
  );
  const convos: CloudConvo[] = [];
  for (const c of convoRows.rows) {
    const members = await query<{ user_id: string; email: string | null; name: string | null; read_seq: string }>(
      `SELECT m.user_id, p.email, p.name, m.read_seq FROM bops.convo_members m LEFT JOIN bops.people p ON p.user_id = m.user_id
       WHERE m.convo_id = $1 AND m.left_at IS NULL ORDER BY m.joined_at`,
      [c.id],
    );
    const invited = await query<{ email: string }>("SELECT email FROM bops.convo_invites WHERE convo_id = $1 ORDER BY at", [c.id]);
    convos.push({
      id: c.id,
      kind: c.kind,
      title: c.title,
      createdBy: c.created_by,
      members: members.rows.map((m) => ({ userId: m.user_id, email: m.email, name: m.name, readSeq: Number(m.read_seq) })),
      invited: invited.rows.map((i) => i.email),
      ...(c.left_at ? { left: true } : {}),
      seq: Number(c.seq),
    });
  }
  const msgRows = await query<{ convo_id: string; id: string; author: string; bot_id: string | null; text: string; json: Record<string, unknown> | null; at: string; seq: string }>(
    `SELECT x.convo_id, x.id, x.author, x.bot_id, x.text, x.json, x.at, x.seq FROM bops.convo_messages x
     JOIN bops.convo_members m ON m.convo_id = x.convo_id AND m.user_id = $1 AND m.left_at IS NULL
     WHERE x.seq > $2 ORDER BY x.seq LIMIT ${PAGE}`,
    [user.id, after],
  );
  const messages: CloudConvoMessage[] = msgRows.rows.map((x) => ({ convoId: x.convo_id, id: x.id, author: x.author, botId: x.bot_id, text: x.text, json: x.json, at: Number(x.at), seq: Number(x.seq) }));
  const more = messages.length === PAGE;
  // A full page: the next ask starts after its last message (conversations sent again then are the same, so that's fine).
  const seq = more ? messages.at(-1)!.seq : Math.max(after, ...convos.map((c) => c.seq), ...messages.map((m) => m.seq));
  return { me: await person(user.id), convos, messages, seq, more };
}

/* ---------------- Routes ---------------- */

const route = (method: "GET" | "POST", path: string, handle: Route["handle"]): Route => ({ method, path, auth: "user", handle });

export const routes: Route[] = [
  // The directory: the user's own row (and conversations their email was asked into), then someone by email.
  route("POST", "/v1/people/hello", async (_req, res, { user }) => {
    await greet(user!, true);
    sendJson(res, 200, { me: await person(user!.id) });
  }),
  route("POST", "/v1/people/find", async (req, res, { user }) => {
    await greet(user!);
    const { email } = await readJson<{ email?: unknown }>(req);
    const e = emailOf(email);
    if (!e) throw new HttpError(400, "Give an email.");
    sendJson(res, 200, { person: await findByEmail(e) });
  }),
  route("GET", "/v1/people/sync", async (_req, res, { user, url }) => sendJson(res, 200, await sync(user!, Math.max(0, Number(url.searchParams.get("after")) || 0)))),
  route("POST", "/v1/people/convos", async (req, res, { user }) => sendJson(res, 200, await startConvo(user!, await readJson(req)))),
  route("POST", "/v1/people/members", async (req, res, { user }) => sendJson(res, 200, await changeMembers(user!, await readJson(req)))),
  route("POST", "/v1/people/send", async (req, res, { user }) => sendJson(res, 200, await send(user!, await readJson(req, MAX_JSON + MAX_TEXT + 4096)))),
  route("POST", "/v1/people/read", async (req, res, { user }) => sendJson(res, 200, await markRead(user!, await readJson(req)))),
  route("POST", "/v1/people/typing", async (req, res, { user }) => {
    await typing(user!, await readJson(req));
    sendJson(res, 200, { ok: true });
  }),
];
