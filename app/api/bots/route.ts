import { createBot, renameBot, setComputer } from "@/lib/server/bots";
import { deleteBot } from "@/lib/server/remove";
import { requestInbox } from "@/lib/server/mail";
import { MAX_PERSONA_CHARS, type AppAccess, type Effort } from "@/lib/types";
import { bot, update } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";
import { routineChanged } from "@/lib/server/routine-sync";
import { fromBopsWindow } from "@/lib/server/ui-token";

/**
 * A bot's settings (what it may do in the user's apps, "Just do it", where it works) and the bot
 * itself change only from the Bops window (ui-token.ts): a page a bot's Chrome reached this server
 * with mustn't be able to give a bot more say.
 */
const notFromWindow = (request: Request) =>
  fromBopsWindow(request) ? null : Response.json({ error: "A bot's settings can only be changed in the Bops app." }, { status: 403 });

/**
 * Create a bot. It works on the main bot's computer, or (`ownComputer`) on a copy of it made on its first
 * task, when the Orgo plan has room for one; `note` says why when it hasn't.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { name, role, workspaceId, ownComputer } = (await request.json()) as { name?: string; role?: string; workspaceId?: string; ownComputer?: boolean };
  const made = await createBot(name ?? "", role, workspaceId, ownComputer === true);
  if ("error" in made) return Response.json(made, { status: name?.trim() ? 409 : 400 });
  return Response.json(made);
}

/**
 * Set the bot's access to an account (read, act or none; null puts it back to the default), rename it, set how hard it thinks,
 * where it works, whether it asks first, whether it has business data and how it should work (persona),
 * or get it an email.
 */
export async function PATCH(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const body = (await request.json()) as {
    botId?: string;
    /** Access to one of the user's app accounts: read, act, none, or null for the default (levelOf). */
    access?: { account: string; level: AppAccess | null };
    effort?: Effort;
    runsOn?: "auto" | "cloud" | "mac";
    /** "Just do it": act in apps and email without asking first (see Bot.autoApprove). */
    autoApprove?: boolean;
    /** Business data off for this bot (see Bot.dataOff). */
    dataOff?: boolean;
    /** A new name: its email address, phone agents and desktop follow. */
    name?: string;
    /** Work on the main bot's computer, or its own (see setComputer). */
    computer?: "shared" | "own";
    /** Get this bot an email (Max: up to 5; see requestInbox). */
    email?: true;
    /** "How I work" (Bot.persona): trimmed, cut to MAX_PERSONA_CHARS; empty clears it. */
    persona?: string;
  };
  const b = body.botId ? bot(body.botId) : undefined;
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  if (body.email === true) {
    const r = await requestInbox(b.id).catch((e: Error) => ({ error: e.message, upgrade: null }));
    return Response.json(r, { status: "error" in r ? ("upgrade" in r && r.upgrade ? 402 : 409) : 200 });
  }
  if (body.computer === "shared" || body.computer === "own") {
    const r = await setComputer(b.id, body.computer);
    if ("error" in r) return Response.json(r, { status: 409 });
  }
  if (body.name !== undefined) {
    const r = renameBot(b.id, body.name);
    if ("error" in r) return Response.json(r, { status: 400 });
  }
  const runsOnBefore = b.runsOn;
  update(() => {
    if (body.access && typeof body.access.account === "string") {
      const level = body.access.level;
      if (level === "read" || level === "act" || level === "none") (b.access ??= {})[body.access.account] = level;
      else if (b.access) delete b.access[body.access.account];
    }
    if (body.effort && ["auto", "low", "medium", "high"].includes(body.effort)) b.effort = body.effort;
    if (body.runsOn && ["auto", "cloud", "mac"].includes(body.runsOn)) b.runsOn = body.runsOn;
    if (typeof body.autoApprove === "boolean") b.autoApprove = body.autoApprove || undefined;
    if (typeof body.dataOff === "boolean") b.dataOff = body.dataOff || undefined;
    if (typeof body.persona === "string") b.persona = body.persona.trim().slice(0, MAX_PERSONA_CHARS).trim() || undefined;
  });
  // Its routines that need the Mac follow where it works (runner.ts pinnedToMac): Orgo hears.
  if (body.runsOn && runsOnBefore !== b.runsOn) routineChanged(b.id);
  return Response.json({ ok: true });
}

/** Delete a bot, its computer (Bops workspace only), chat, threads and routines. */
export async function DELETE(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const { botId } = (await request.json().catch(() => ({}))) as { botId?: string };
  if (!botId || !bot(botId)) return Response.json({ error: "no such bot" }, { status: 404 });
  try {
    await deleteBot(botId);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
