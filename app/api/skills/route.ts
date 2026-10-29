import { chatThreads, draftSkill, saveSkillDraft } from "@/lib/server/procedures";
import { notReady } from "@/lib/server/ready";
import { bot, chat, getState } from "@/lib/server/store";
import { sharedOpen } from "@/lib/server/shared";
import { acceptProposal, proposalDiff, rejectProposal } from "@/lib/server/skill-proposals";
import { fromBopsWindow } from "@/lib/server/ui-token";
import {
  approveScript,
  createSkill,
  deleteSkill,
  importFolder,
  findRef,
  publishSkill,
  refsOf,
  renameLabel,
  rollbackSkill,
  setBotLabel,
  setBotLabels,
  setLabelAbout,
  setLabelSuggest,
  setSkillBot,
  skillDetail,
  skillFile,
  SkillError,
  skillsRoutesSeen,
  syncSkills,
  updateFromFolder,
  updateSkill,
  workspaceById,
  workspaceLabels,
} from "@/lib/server/workspace-skills";
import { MAIN_WORKSPACE, type SkillKind, type SkillRef } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * A workspace's skills and apps (lib/server/workspace-skills.ts): listed, read, made, changed, published,
 * rolled back, deleted, given to bots, imported from a folder on this Mac, and drafted from a chat ("Save as
 * skill"). They change how the bots work, so like a bot's other settings only from the Bops window
 * (ui-token.ts): a page a bot's Chrome reached this server with mustn't teach a bot steps or approve a script.
 * Which labels each bot has (Who has what), a label's name and about line, Suggest labels with AI, and a bot's proposed change
 * (skill-proposals.ts: accept, reject, or its diff on what the skill is now) are the owner's too: never while a
 * workspace shared with the user is open.
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
  return Response.json({ skills: refsOf(wsId, "skill"), apps: refsOf(wsId, "app"), labels: workspaceLabels(wsId), labelInfo: workspaceById(wsId)?.skillLabelInfo ?? [], sync, orgo: !!project && skillsRoutesSeen(project) === true });
}

/** `{action, ...}`: what to do to a skill of the current workspace (`ws` to name another). */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = str(b.ws) ?? getState().workspace ?? MAIN_WORKSPACE;
  const kind = kindOf(b.kind);
  const slug = str(b.slug) ?? "";
  const ownerOnly = new Set(["bot-label", "bot-labels", "label-rename", "label-about", "label-suggest", "proposal"]);
  if (ownerOnly.has(String(b.action)) && sharedOpen()) return Response.json({ error: "In a shared workspace, only its owner changes this." }, { status: 403 });
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
        // With an existing skill's slug: the folder is its next version (Update from folder), published at once with `publish`.
        if (slug) {
          if (!findRef(wsId, kind, slug)) return Response.json({ error: `That ${kind} was deleted.` }, { status: 404 });
          return Response.json(updateFromFolder(wsId, path, kind, slug, { publish: b.publish === true }));
        }
        return Response.json(importFolder(wsId, path, kind));
      }
      case "bot-label": {
        const botId = str(b.botId);
        const label = str(b.label);
        if (!botId || !label || typeof b.on !== "boolean") return Response.json({ error: "Which bot, which label, and on or off?" }, { status: 400 });
        return Response.json({ skillLabels: setBotLabel(wsId, botId, label, b.on) ?? null });
      }
      case "bot-labels": {
        const botId = str(b.botId);
        if (!botId || !(b.labels === null || Array.isArray(b.labels))) return Response.json({ error: "Which bot, and which labels (or null for every one)?" }, { status: 400 });
        const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === "string").slice(0, 200) : null;
        return Response.json({ skillLabels: setBotLabels(wsId, botId, labels) ?? null });
      }
      case "label-rename": {
        const from = str(b.from);
        const to = str(b.to);
        if (!from || !to?.trim()) return Response.json({ error: "Which label, and its new name?" }, { status: 400 });
        return Response.json({ moved: renameLabel(wsId, from, to), labels: workspaceLabels(wsId) });
      }
      case "label-about": {
        const label = str(b.label);
        if (!label || typeof b.about !== "string") return Response.json({ error: "Which label, and what it's for?" }, { status: 400 });
        return Response.json({ labelInfo: setLabelAbout(wsId, label, b.about) });
      }
      case "label-suggest": {
        if (typeof b.on !== "boolean") return Response.json({ error: "On or off?" }, { status: 400 });
        return Response.json({ on: setLabelSuggest(wsId, b.on) });
      }
      case "proposal": {
        const messageId = str(b.messageId);
        const proposalId = str(b.proposalId);
        if (!messageId || !proposalId) return Response.json({ error: "Which proposal?" }, { status: 400 });
        if (b.do === "diff") {
          const d = proposalDiff(messageId, proposalId);
          return d.ok ? Response.json(d) : Response.json({ error: d.error }, { status: d.status });
        }
        const r = b.do === "accept" ? acceptProposal(messageId, proposalId, str(b.seen)) : b.do === "reject" ? rejectProposal(messageId, proposalId) : null;
        if (!r) return Response.json({ error: "Accept or reject?" }, { status: 400 });
        return r.ok ? Response.json(r) : Response.json({ error: r.error, ...(r.problems ? { problems: r.problems } : {}), ...(r.stale ? { stale: r.stale } : {}) }, { status: r.status });
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
