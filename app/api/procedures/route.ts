import { chatThreads, deleteProcedure, draftProcedure, proceduresOf, saveProcedure } from "@/lib/server/procedures";
import { bot, chat, getState } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";
import type { Procedure } from "@/lib/types";

/**
 * A bot's procedures (lib/server/procedures.ts): drafted from a chat, saved, edited and deleted. They
 * change how a bot works, so like a bot's other settings they change only from the Bops window
 * (ui-token.ts): a page a bot's Chrome reached this server with mustn't be able to teach a bot steps.
 */
const notFromWindow = (request: Request) =>
  fromBopsWindow(request) ? null : Response.json({ error: "A bot's procedures can only be changed in the Bops app." }, { status: 403 });

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** What a procedure is made of, as the window sends it: only strings are taken. */
type Fields = { name?: unknown; whenToUse?: unknown; steps?: unknown; pitfalls?: unknown };
const fieldsOf = (d: Fields) => ({ name: str(d.name) ?? "", whenToUse: str(d.whenToUse) ?? "", steps: str(d.steps) ?? "", pitfalls: str(d.pitfalls) ?? "" });

/** Where a procedure was learned, as the window sends it back: a chat, and the threads read with it. */
function fromOf(v: unknown): Procedure["from"] {
  const f = v as { chatId?: unknown; sessionIds?: unknown } | null | undefined;
  const chatId = str(f?.chatId);
  if (!chatId || !chat(chatId)) return undefined;
  const sessionIds = Array.isArray(f?.sessionIds) ? f.sessionIds.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  return { chatId, ...(sessionIds.length ? { sessionIds } : {}) };
}

/**
 * `{action: "draft", botId, chatId, sessionId?}`: a draft from the chat (and the threads it started,
 * or just that one), with the name of the procedure it would replace (`updating`) and where it was
 * learned (`from`, to send back on save). `{action: "save", botId, draft, from?}`: saved, replacing
 * `draft.updates` when that one is still there (else the one with the same name).
 */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; botId?: unknown; chatId?: unknown; sessionId?: unknown; draft?: unknown; from?: unknown };
  const botId = str(body.botId);
  if (!botId || !bot(botId)) return Response.json({ error: "That bot is gone." }, { status: 404 });
  if (body.action === "draft") {
    const chatId = str(body.chatId);
    if (!chatId || !chat(chatId)) return Response.json({ error: "That chat is gone." }, { status: 404 });
    const sessionId = str(body.sessionId) || undefined;
    const r = await draftProcedure(botId, chatId, { sessionId });
    if (!r.draft) return Response.json({ error: r.error ?? "Couldn't write a draft." }, { status: 400 });
    const old = r.draft.updates ? proceduresOf(botId).find((p) => p.id === r.draft!.updates) : undefined;
    const sessionIds = chatThreads(botId, chatId, sessionId).map((s) => s.id).slice(-20);
    // What the one it updates says now, so the user sees what the draft would replace before saving it.
    return Response.json({
      draft: r.draft,
      ...(old ? { updating: old.name, was: { steps: old.steps, pitfalls: old.pitfalls ?? "" } } : {}),
      from: { chatId, ...(sessionIds.length ? { sessionIds } : {}) },
    });
  }
  if (body.action === "save") {
    const d = (body.draft ?? {}) as Fields & { updates?: unknown; id?: unknown };
    const want = str(d.id) ?? str(d.updates);
    // The one it was drafted to replace may have been deleted meanwhile: then it's saved as a new one.
    const id = want && proceduresOf(botId).some((p) => p.id === want) ? want : undefined;
    const r = saveProcedure(botId, { id, ...fieldsOf(d) }, fromOf(body.from));
    if (!r.procedure) return Response.json({ error: r.error ?? "Couldn't save it." }, { status: 400 });
    return Response.json({ procedure: r.procedure });
  }
  return Response.json({ error: "Say draft or save." }, { status: 400 });
}

/** `{id, edit}`: change a procedure's name, when to use it, steps or pitfalls (what isn't sent stays). */
export async function PATCH(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const { id, edit } = (await request.json().catch(() => ({}))) as { id?: unknown; edit?: Fields };
  const p = (getState().procedures ?? []).find((x) => x.id === id);
  if (!p) return Response.json({ error: "That procedure was deleted." }, { status: 404 });
  const e = edit ?? {};
  const r = saveProcedure(p.botId, {
    id: p.id,
    name: str(e.name) ?? p.name,
    whenToUse: str(e.whenToUse) ?? p.whenToUse,
    steps: str(e.steps) ?? p.steps,
    pitfalls: str(e.pitfalls) ?? p.pitfalls ?? "",
  });
  if (!r.procedure) return Response.json({ error: r.error ?? "Couldn't save it." }, { status: 400 });
  return Response.json({ procedure: r.procedure });
}

/** `{id}`: delete a procedure. */
export async function DELETE(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  const sid = str(id);
  if (!sid || !deleteProcedure(sid)) return Response.json({ error: "That procedure was deleted." }, { status: 404 });
  return Response.json({ ok: true });
}
