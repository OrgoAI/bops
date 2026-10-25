import { chatThreads, draftSkill, saveSkillDraft } from "@/lib/server/procedures";
import { notReady } from "@/lib/server/ready";
import { bot, chat, getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import {
  approveScript,
  createSkill,
  deleteSkill,
  importFolder,
  publishSkill,
  refsOf,
  rollbackSkill,
  setSkillBot,
  skillDetail,
  skillFile,
  SkillError,
  skillsRoutesSeen,
  syncSkills,
  updateSkill,
  workspaceById,
} from "@/lib/server/workspace-skills";
import { MAIN_WORKSPACE, type SkillKind, type SkillRef } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * A workspace's skills and apps (lib/server/workspace-skills.ts): listed, read, made, changed, published,
 * rolled back, deleted, given to bots, imported from a folder on this Mac, and drafted from a chat ("Save as
 * skill"). They change how the bots work, so like a bot's other settings only from the Bops window
 * (ui-token.ts): a page a bot's Chrome reached this server with mustn't teach a bot steps or approve a script.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Skills can only be changed in the Bops app." }, { status: 403 }));

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const kindOf = (v: unknown): SkillKind => (v === "app" ? "app" : "skill");
const failed = (e: unknown) =>
  e instanceof SkillError ? Response.json({ error: e.message, ...(e.problems ? { problems: e.problems } : {}) }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

/** Where a skill was drafted, as the window sends it back: a chat that's there, and the threads read with it. */
function fromOf(v: unknown): SkillRef["from"] {
  const f = v as { chatId?: unknown; sessionIds?: unknown } | null | undefined;
  const chatId = str(f?.chatId);
  if (!chatId || !chat(chatId)) return undefined;
  const sessionIds = Array.isArray(f?.sessionIds) ? f.sessionIds.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  return { chatId, ...(sessionIds.length ? { sessionIds } : {}) };
}

/** The current workspace's skills and apps (after a sync with Orgo when `?sync=1`), and whether they're kept in step with Orgo. */
export async function GET(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const url = new URL(request.url);
  const wsId = url.searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  if (!workspaceById(wsId)) return Response.json({ error: "That workspace is gone." }, { status: 404 });
  const sync = url.searchParams.has("sync") ? await syncSkills(wsId).catch(() => null) : null;
  const project = workspaceById(wsId)?.orgoProjectId;
  return Response.json({ skills: refsOf(wsId, "skill"), apps: refsOf(wsId, "app"), sync, orgo: !!project && skillsRoutesSeen(project) === true });
}

/** `{action, ...}`: what to do to a skill of the current workspace (`ws` to name another). */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = str(b.ws) ?? getState().workspace ?? MAIN_WORKSPACE;
  const kind = kindOf(b.kind);
  const slug = str(b.slug) ?? "";
  try {
    switch (b.action) {
      case "detail":
        return Response.json(skillDetail(wsId, kind, slug, str(b.version)));
      case "file":
        return Response.json(skillFile(wsId, kind, slug, str(b.path) ?? "", str(b.version)));
      case "create": {
        const botIds = Array.isArray(b.botIds) ? b.botIds.filter((x): x is string => typeof x === "string") : [];
        return Response.json(createSkill(wsId, { kind, name: str(b.name) ?? "", description: str(b.description) ?? "", body: str(b.body) ?? "", botIds, source: "bops" }));
      }
      case "update": {
        const e = (b.edit ?? {}) as Record<string, unknown>;
        return Response.json({ ref: updateSkill(wsId, kind, slug, { name: str(e.name), description: str(e.description), body: str(e.body), label: str(e.label) }) });
      }
      case "publish":
        return Response.json({ ref: publishSkill(wsId, kind, slug, { version: str(b.version) }) });
      case "rollback":
        return Response.json({ ref: rollbackSkill(wsId, kind, slug, str(b.version) ?? "") });
      case "delete":
        return (await deleteSkill(wsId, kind, slug)) ? Response.json({ ok: true }) : Response.json({ error: `That ${kind} was deleted.` }, { status: 404 });
      case "bot": {
        const botId = str(b.botId);
        if (!botId || typeof b.on !== "boolean") return Response.json({ error: "Which bot, and on or off?" }, { status: 400 });
        return Response.json({ ref: setSkillBot(wsId, kind, slug, botId, b.on) });
      }
      case "approve":
        return Response.json({ approvals: approveScript(wsId, str(b.sha256) ?? "", b.on !== false) });
      case "import": {
        const path = str(b.path);
        if (!path || !path.startsWith("/")) return Response.json({ error: "Pick a folder." }, { status: 400 });
        return Response.json(importFolder(wsId, path, kind));
      }
      case "draft": {
        const botId = str(b.botId);
        if (!botId || !bot(botId)) return Response.json({ error: "That bot is gone." }, { status: 404 });
        const chatId = str(b.chatId);
        if (!chatId || !chat(chatId)) return Response.json({ error: "That chat is gone." }, { status: 404 });
        const sessionId = str(b.sessionId) || undefined;
        const r = await draftSkill(botId, chatId, { sessionId });
        if (!r.draft) return Response.json({ error: r.error ?? "Couldn't write a draft." }, { status: 400 });
        const sessionIds = chatThreads(botId, chatId, sessionId).map((s) => s.id).slice(-20);
        const updating = r.draft.updates ? refsOf(wsId, "skill").find((x) => x.slug === r.draft!.updates)?.name : undefined;
        return Response.json({ draft: r.draft, ...(updating ? { updating } : {}), from: { chatId, ...(sessionIds.length ? { sessionIds } : {}) } });
      }
      case "save-draft": {
        const botId = str(b.botId);
        if (!botId || !bot(botId)) return Response.json({ error: "That bot is gone." }, { status: 404 });
        const r = saveSkillDraft(botId, (b.draft ?? {}) as Parameters<typeof saveSkillDraft>[1], { from: fromOf(b.from), publish: b.publish === true });
        if (!r.ref) return Response.json({ error: r.error ?? "Couldn't save it.", ...(r.problems ? { problems: r.problems } : {}) }, { status: 400 });
        return Response.json({ ref: r.ref });
      }
      default:
        return Response.json({ error: "What should happen to it?" }, { status: 400 });
    }
  } catch (e) {
    return failed(e);
  }
}
