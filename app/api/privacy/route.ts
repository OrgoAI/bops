import { isDeletedDays, isKeepDays, type ClearChoice } from "@/lib/privacy";
import type { DeletedDays, KeepDays } from "@/lib/types";
import { purgeDeleted, restoreDeleted } from "@/lib/server/deleted";
import { onPostgres, onRunner } from "@/lib/server/persist";
import { choicesFresh, clearNow, forgetHere, privacyInfo, privacyPreview, setPrivacy } from "@/lib/server/privacy";
import { bot } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Settings → Your data (lib/server/privacy.ts, deleted.ts): only for the Bops window on the user's Mac (a page a
 * bot's Chrome reached this server with never reads what's in Recently deleted, nor changes how long chats are
 * kept), never on a computer's runner, and never while a workspace shared with the user is open: it's the
 * owner's own data, and a viewer is shown and changes none of it. Nor on a hosted server (Postgres): no sweep
 * runs there, and nothing deleted there is kept to restore, so it offers no choice it can't keep, and the
 * window, told no, shows nothing of it (your-data.tsx). Errors come back as { error }.
 */
function refused(request: Request): Response | null {
  const no = (error: string) => Response.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } });
  if (onRunner() || onPostgres() || !fromBopsWindow(request)) return no("Your data can only be seen in the Bops app.");
  if (sharedOpen()) return no("In a shared workspace, only its owner sees this.");
  return notReady();
}

/** Delete now's choice as asked for ({ olderThan: null | 365 | 90 | 30, bot? }): a bot only one that's here. Null when it isn't one. */
function clearChoiceOf(olderThan: unknown, botId: unknown): ClearChoice | null {
  if (!isKeepDays(olderThan)) return null;
  if (botId === undefined || botId === null || botId === "") return { olderThan };
  return typeof botId === "string" && bot(botId) ? { olderThan, bot: botId } : null;
}

/**
 * `?keepDays=30|90|365|null` or `?deletedDays=0|7|30`: also what choosing it would delete now (PrivacyInfo.goes,
 * goesDeleted); `?clear=null|365|90|30` (and `&bot=`): what Delete now takes (goesNow); for the window to ask first.
 */
function proposedIn(request: Request): { keepDays?: KeepDays; deletedDays?: DeletedDays; clear?: ClearChoice } | null {
  const q = new URL(request.url).searchParams;
  const out: { keepDays?: KeepDays; deletedDays?: DeletedDays; clear?: ClearChoice } = {};
  const c = q.get("clear");
  if (c !== null) {
    const choice = clearChoiceOf(c === "null" || c === "" ? null : Number(c), q.get("bot"));
    if (choice) out.clear = choice;
  }
  const k = q.get("keepDays");
  if (k !== null) {
    const n = k === "null" || k === "" ? null : Number(k);
    if (isKeepDays(n)) out.keepDays = n;
  }
  const d = q.get("deletedDays");
  if (d !== null && isDeletedDays(Number(d))) out.deletedDays = Number(d) as DeletedDays;
  return "keepDays" in out || "deletedDays" in out || "clear" in out ? out : null;
}

/** How long a save of a shorter keep waits on the sweep it starts before it answers: after that, the window reads again while it goes (PrivacyInfo.sweeping). */
const SWEEP_WAIT_MS = 5_000;

/** The user's choices, where things are kept with this Mac's numbers, Recently deleted (lib/privacy.ts PrivacyInfo). */
export async function GET(request: Request) {
  const no = refused(request);
  if (no) return no;
  const proposed = proposedIn(request);
  return Response.json(proposed ? await privacyPreview(proposed) : privacyInfo(), { headers: { "Cache-Control": "no-store" } });
}

/**
 * One change: { keepDays: 30 | 90 | 365 | null } or { deletedDays: 0 | 7 | 30 } (the window asked the user first
 * when fewer days delete something), { restore: <id> } or { deleteNow: <id> } for one in Recently deleted, or
 * { clear: { olderThan: null | 365 | 90 | 30, bot? } }, Delete now (asked first too, with what it takes). Answers
 * what GET does, after it: a shorter keep once the sweep it starts is done, or a few seconds in; a restore with
 * `left`, how many of Delete now's couldn't go back; Delete now with `cleared`, what it deleted, and the copy
 * to restore it from.
 */
export async function POST(request: Request) {
  const no = refused(request);
  if (no) return no;
  const body = (await request.json().catch(() => ({}))) as { keepDays?: unknown; deletedDays?: unknown; restore?: unknown; deleteNow?: unknown; clear?: { olderThan?: unknown; bot?: unknown } };
  const bad = (error: string, status = 400) => Response.json({ error }, { status });
  if ("keepDays" in body) {
    if (!isKeepDays(body.keepDays)) return bad("Keep them 30, 90 or 365 days, or until you delete them.");
    const swept = setPrivacy({ keepDays: body.keepDays });
    if (swept) await Promise.race([swept.catch(() => null), new Promise((r) => setTimeout(r, SWEEP_WAIT_MS).unref?.())]);
  } else if ("deletedDays" in body) {
    if (!isDeletedDays(body.deletedDays)) return bad("Keep what you delete 0, 7 or 30 days.");
    setPrivacy({ deletedDays: body.deletedDays });
  } else if (typeof body.restore === "string") {
    // One whose time is up by this Mac's choices goes first only when they're known current (choicesFresh).
    const r = restoreDeleted(body.restore, { current: choicesFresh() });
    if (!r.ok) return bad(r.error, r.status);
    forgetHere();
    if (r.left) return Response.json({ ...privacyInfo(), left: r.left });
  } else if (typeof body.deleteNow === "string") {
    if (!purgeDeleted(body.deleteNow)) return bad("That isn't in Recently deleted anymore.", 404);
    forgetHere();
  } else if (body.clear && typeof body.clear === "object") {
    const choice = clearChoiceOf(body.clear.olderThan, body.clear.bot);
    if (!choice) return bad("Delete everything, or what's older than a year, 90 or 30 days, for every bot or one that's here.");
    const cleared = await clearNow(choice);
    return Response.json({ ...privacyInfo(), cleared });
  } else return bad("What should change?");
  return Response.json(privacyInfo());
}
