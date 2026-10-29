import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, lineDiff, PROPOSAL_LIMITS, proposedText, type DiffLine } from "@/lib/skill-proposals";
import { workspaceOf, type Bot, type SkillProposal } from "@/lib/types";
import { builtinSkills } from "@/lib/builtin-skills";
import { normalizePath, scanSecrets, sha256Hex, type Problem } from "./skill-bundle";
import { onRunner } from "./persist";
import { getState, id, ownerName, update, userDir } from "./store";
import { applySkillFile, findRef, findSkill, SkillError, skillFileText, skillsFor } from "./workspace-skills";

/**
 * Changes a bot proposes to its workspace's skills (Message.skillProposals), from any turn: the owner's own, a
 * routine's run (in the background), one someone else started, one that read a page, an email or an app. That's
 * safe because a proposal changes nothing. It's a card under the bot's message (components/app/skill-proposals.tsx)
 * with the change as a diff, who proposed it, from which chat or routine, and, when the turn read something from
 * outside Bops, whose words those were (the turn's reads), so the owner sees where the idea may have come from.
 * create_skill and update_skill keep their own rules (only on the owner's say, never after an outside read).
 *
 * Only the owner's Accept, in the Bops window (app/api/skills action "proposal"; never a member, never a shared
 * viewer, never a computer's runner), makes it the skill's next version: the working folder's file changed through
 * the same checks as any save (no secret, the caps) and published (workspace-skills.ts applySkillFile). When the
 * skill changed since the proposal was made (another version, the file's text, changes not published yet), Accept
 * says so and shows the change on what the skill is now, and applies only once the owner saw that and accepts it.
 * Reject drops it. A proposal holding what looks like a secret is never kept: the bot is told to use the vault
 * name. On a computer's runner, where a skill's files may not be, one is kept unchecked and checked when accepted.
 *
 * Accept takes a proposal only as its message's own (its bot's, for a skill that bot has in its workspace), and one
 * this Mac's own turn made only with this Mac's mark on it (sealProposals): a computer's runner may write any message
 * of its bots, its cards too, so one without the mark is shown on what the skill is now first, whatever it says of
 * its base, as one made where the skill's files weren't.
 */

/** The tool, offered in every turn (chat.ts): it changes nothing, so a routine's run and an outside turn have it too. */
export const PROPOSE_TOOL = {
  type: "function" as const,
  name: "propose_skill_change",
  description:
    "Propose a change to one of your skills when a step was wrong, missing or out of date: one file of it, as edits (each old text exactly as it is in the file, once) or a whole new file. It shows as a card under your answer for the owner to accept; nothing changes until they do. Read the skill (read_skill) first, so the old text is exact.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["skill", "file", "edits", "content", "summary"],
    properties: {
      skill: { type: "string", description: "The skill's name, as listed under Your skills." },
      file: { type: "string", description: "\"SKILL.md\" for its text as read_skill shows it, or one of its files (references/faults.md), or a new file's path." },
      edits: {
        type: ["array", "null"],
        description: "The changes, in order: each old text exactly as it is in the file (once), and what it becomes. Null when content gives the whole file.",
        items: { type: "object", additionalProperties: false, required: ["old", "new"], properties: { old: { type: "string" }, new: { type: "string" } } },
      },
      content: { type: ["string", "null"], description: "The file's whole new text (a new file, or a short one rewritten). Null when edits say the change." },
      summary: { type: "string", description: "What was wrong and what the change does, in one or two plain sentences." },
    },
  },
};

export type ProposeArgs = { skill?: unknown; file?: unknown; edits?: unknown; content?: unknown; summary?: unknown };

/** Where a proposal comes from: its chat, the routine whose run it is, and whose words the turn read from outside Bops (so far). */
export type ProposeFrom = { chatId: string; routineId?: string; read: () => string[] };

const said = (problems: Problem[]) => problems.map((p) => `${p.path}${p.line ? ` line ${p.line}` : ""}: ${p.reason.replace(/^secret: /, "")}`).join("; ");

/**
 * propose_skill_change: a proposal checked and kept for the card under the answer (`had` are this turn's so far; one
 * for the same file replaces its earlier one), or why not, in words for the model. Never changes a skill.
 */
export function offerProposal(b: Bot, a: ProposeArgs, from: ProposeFrom, had: SkillProposal[]): { proposal?: SkillProposal; said: string } {
  const no = (why: string) => ({ said: `Not proposed: ${why}` });
  const name = typeof a.skill === "string" ? a.skill.trim() : "";
  if (!name) return no("say which skill.");
  const r = findSkill(b.id, name);
  if (!r) {
    const own = builtinSkills(true).some((s) => s.slug === name || s.name.toLowerCase() === name.toLowerCase());
    return no(own ? "that's one of Bops' own skills, which come with Bops and can't be changed." : `you have no skill called "${name.slice(0, 80)}".`);
  }
  const rawFile = typeof a.file === "string" ? a.file.trim() : "";
  const n = rawFile === "SKILL.md" ? { path: "SKILL.md" } : normalizePath(rawFile);
  if ("reason" in n) return no(`that file can't be: ${n.reason}.`);
  const file = n.path;
  const summary = typeof a.summary === "string" ? a.summary.replace(/\s+/g, " ").trim().slice(0, PROPOSAL_LIMITS.summary) : "";
  if (!summary) return no("say what was wrong and what the change does (summary).");
  const content = typeof a.content === "string" ? a.content.replace(/\r\n?/g, "\n") : undefined;
  const edits = Array.isArray(a.edits)
    ? (a.edits as { old?: unknown; new?: unknown }[]).filter((e) => e && typeof e.old === "string" && typeof e.new === "string").map((e) => ({ old: (e.old as string).replace(/\r\n?/g, "\n"), new: (e.new as string).replace(/\r\n?/g, "\n") }))
    : undefined;
  if (content !== undefined && edits?.length) return no("give edits or content, not both.");
  if (content === undefined && !edits?.length) return no("give the edits (each old text and what it becomes), or the file's whole new content.");
  if (edits && edits.length > PROPOSAL_LIMITS.edits) return no(`${PROPOSAL_LIMITS.edits} edits at most; give the whole file as content instead.`);
  if (edits?.some((e) => e.old.length > PROPOSAL_LIMITS.edit || e.new.length > PROPOSAL_LIMITS.edit)) return no(`each side of an edit is ${PROPOSAL_LIMITS.edit} characters at most.`);
  if (content !== undefined && content.length > PROPOSAL_LIMITS.content) return no(`a file is ${PROPOSAL_LIMITS.content / 1024} KB at most.`);
  if (file === "SKILL.md" && content !== undefined && !content.trim()) return no("its text can't be empty.");
  // A key in a proposal would sit in the chat and reach the skill: never kept.
  const secrets = [scanSecrets("summary", summary), ...(edits ?? []).flatMap((e, i) => [...scanSecrets(`edit ${i + 1}`, e.old), ...scanSecrets(`edit ${i + 1}`, e.new)]), content !== undefined ? scanSecrets(file, content) : []].flat();
  if (secrets.length) return no(`it holds what looks like a secret (${said(secrets)}). Keep keys in Logins and name one by its vault name ($NAME) instead.`);
  const ws = workspaceOf(b);
  // What its bots read now: the edits are checked against it here, or on the Mac when it's accepted (a runner may not have the files).
  const base = skillFileText(ws, r, file, "published");
  let baseSha: string | undefined;
  let replaces = false;
  if (base) {
    if (base.binary) return no(`${file} is a binary file, which can't be changed as text.`);
    if (edits) {
      const out = base.text === null ? { error: `${file} isn't in "${r.name}". Give its whole content to add it.` } : applyEdits(base.text, edits);
      if ("error" in out) return no(`${out.error} Read it with read_skill and give its exact text.`);
      const leak = scanSecrets(file, out.text);
      if (leak.length) return no(`the file would hold what looks like a secret (${said(leak)}).`);
    }
    if (base.text !== null) baseSha = sha256Hex(base.text);
    replaces = base.exists && content !== undefined;
  }
  if (had.filter((x) => !(x.slug === r.slug && x.kind === r.kind && x.file === file)).length >= PROPOSAL_LIMITS.perTurn) return no(`${PROPOSAL_LIMITS.perTurn} proposals in one answer at most.`);
  const read = from.read();
  const proposal: SkillProposal = {
    id: id("prop"),
    ws,
    kind: r.kind,
    slug: r.slug,
    name: r.name,
    file,
    ...(content !== undefined ? { content } : { edits }),
    ...(replaces ? { replaces: true as const } : {}),
    summary,
    base: r.version ?? "",
    ...(baseSha ? { baseSha } : {}),
    ...(!base ? { unchecked: true as const } : {}),
    botId: b.id,
    chatId: from.chatId,
    ...(from.routineId ? { routineId: from.routineId } : {}),
    ...(read.length ? { read } : {}),
    at: Date.now(),
  };
  return { proposal, said: `Proposed. It shows under your answer for ${ownerName()} to accept; nothing in "${r.name}" changes until they do. Say in a few words what you proposed.` };
}

/* ---------------- This Mac's mark ---------------- */

/** This Mac's key for its mark, per user folder: made once, kept only there (never in the state, which a runner reads). */
let markKey: { dir: string; key: Buffer } | undefined;
function keyHere(): Buffer | null {
  if (onRunner()) return null;
  const dir = userDir();
  if (!dir) return null;
  if (markKey?.dir === dir) return markKey.key;
  const file = join(/*turbopackIgnore: true*/ dir, "skill-proposals.key");
  try {
    let key = existsSync(/*turbopackIgnore: true*/ file) ? Buffer.from(readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim(), "base64url") : null;
    if (!key || key.length < 32) {
      key = randomBytes(32);
      mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
      writeFileSync(/*turbopackIgnore: true*/ `${file}.tmp`, key.toString("base64url"), { mode: 0o600 });
      renameSync(/*turbopackIgnore: true*/ `${file}.tmp`, file);
    }
    markKey = { dir, key };
    return key;
  } catch (e) {
    console.warn(`[skills] proposals' key: ${(e as Error).message}`);
    return null;
  }
}

/** The mark: an HMAC over all Accept trusts of it (which skill and file, its base, the change, whose bot, whose words the turn read). */
const markOf = (key: Buffer, p: SkillProposal) =>
  createHmac("sha256", key)
    .update(JSON.stringify([p.id, p.ws, p.kind, p.slug, p.file, p.edits ?? null, p.content ?? null, !!p.replaces, p.base, p.baseSha ?? null, !!p.unchecked, p.botId, p.chatId, p.routineId ?? null, p.read ?? []]))
    .digest("base64url");

/**
 * This Mac's mark on the proposals its own turn made, as they go on the message (chat.ts: whose words the whole
 * turn read included). None on a computer's runner, whose key it never has.
 */
export function sealProposals(ps: SkillProposal[]): SkillProposal[] {
  const key = keyHere();
  return key ? ps.map((p) => ({ ...p, seal: markOf(key, p) })) : ps;
}

/** Whether this Mac's own turn made it as it is now. */
function ownHere(p: SkillProposal): boolean {
  const key = keyHere();
  if (!key || typeof p.seal !== "string") return false;
  const want = Buffer.from(markOf(key, p));
  const got = Buffer.from(p.seal);
  return got.length === want.length && timingSafeEqual(got, want);
}

/* ---------------- Accept and Reject ---------------- */

type Found = { messageId: string; p: SkillProposal; botId?: string };
const find = (messageId: string, proposalId: string): Found | undefined => {
  const m = getState().messages.find((x) => x.id === messageId);
  const p = m?.skillProposals?.find((x) => x.id === proposalId);
  return p ? { messageId, p, botId: m?.botId } : undefined;
};

/**
 * Why a proposal isn't its message's own, or null: its bot is the message's, the skill is in that bot's workspace,
 * and the bot has it (one a runner put on its bot's message for another workspace's skill, or one the bot doesn't have, isn't).
 */
function notItsOwn(f: Found): string | null {
  const { p } = f;
  const b = getState().bots.find((x) => x.id === p.botId);
  if (p.botId !== f.botId || !b || p.ws !== workspaceOf(b)) return "That proposal isn't for this bot's skills.";
  if (!skillsFor(p.botId).some((x) => x.kind === p.kind && x.slug === p.slug)) return "Its bot doesn't have that skill anymore.";
  return null;
}
const patch = (messageId: string, proposalId: string, fn: (p: SkillProposal) => void) =>
  update((s) => {
    const p = s.messages.find((x) => x.id === messageId)?.skillProposals?.find((x) => x.id === proposalId);
    if (p) fn(p);
  });

/** What changed since a proposal was made, in words, or null when nothing did. `own`: this Mac's own turn made it as it is (ownHere); else it's always shown on what the skill is now. */
function staleWhy(p: SkillProposal, version: string, now: { text: string | null; changed: boolean }, own: boolean): string | null {
  if (!own && !p.unchecked) return "It wasn't made on this Mac, so here's the change on what it is now.";
  if (version !== p.base) return version ? `It's at version ${version} now${p.base ? `, and this was proposed for ${p.base}` : ""}.` : "It was proposed for a version it no longer has.";
  if (now.changed) return "It has changes not published yet, which accepting this publishes too.";
  if (p.baseSha && sha256Hex(now.text ?? "") !== p.baseSha) return `${p.file} changed since this was proposed.`;
  if (!p.baseSha && !p.unchecked && now.text !== null && !p.replaces) return `${p.file} was added since this was proposed.`;
  if (p.unchecked) return "It was proposed where the skill's files weren't, so here's the change on what it is now.";
  return null;
}

export type ProposalAnswer =
  | { ok: true; version?: string }
  | { ok: false; status: number; error: string; problems?: Problem[]; stale?: { why: string; lines: DiffLine[]; seen: string } | { why: string; lines?: undefined; seen?: undefined } };

const going = new Set<string>();

/**
 * The owner's Accept (the window only: app/api/skills): the proposal made the skill's next version. When the skill
 * changed since it was made, it isn't applied blindly: the answer says what changed and shows the change on what the
 * skill is now (`stale`), and Accept again with that view's `seen` applies it there. Refused once accepted or
 * rejected, on a computer's runner, and while another Accept of it goes.
 */
export function acceptProposal(messageId: string, proposalId: string, seen?: string): ProposalAnswer {
  if (onRunner()) return { ok: false, status: 409, error: "Accept it in Bops on your Mac." };
  const f = find(messageId, proposalId);
  if (!f) return { ok: false, status: 404, error: "That proposal isn't here anymore." };
  const { p } = f;
  if (p.status) return { ok: false, status: 409, error: p.status === "accepted" ? "It was accepted already." : "It was rejected." };
  const notOwn = notItsOwn(f);
  if (notOwn) return { ok: false, status: 403, error: notOwn };
  const r = findRef(p.ws, p.kind, p.slug);
  if (!r) return { ok: false, status: 404, error: "That skill was deleted." };
  if (going.has(p.id)) return { ok: false, status: 409, error: "It's being applied." };
  const now = skillFileText(p.ws, r, p.file, "folder");
  if (!now) return { ok: false, status: 404, error: "Its folder is gone from this Mac." };
  if (now.binary) return { ok: false, status: 400, error: `${p.file} is a binary file now, so this can't change it.` };
  const next = proposedText(p, now.text);
  const why = staleWhy(p, r.version ?? "", now, ownHere(p));
  if ("error" in next) return { ok: false, status: 409, error: "This no longer fits the skill.", stale: { why: `${why ?? ""} ${next.error}`.trim() } };
  const token = sha256Hex(`${now.text ?? ""}\u0000${next.text}`);
  if (why && seen !== token) return { ok: false, status: 409, error: "The skill changed since this was proposed.", stale: { why, lines: lineDiff(now.text ?? "", next.text), seen: token } };
  if (next.text === (now.text ?? null)) return { ok: false, status: 409, error: "The skill says that already." };
  going.add(p.id);
  try {
    const ref = applySkillFile(p.ws, p.kind, p.slug, p.file, next.text);
    patch(messageId, proposalId, (x) => {
      x.status = "accepted";
      x.doneAt = Date.now();
      if (ref.version) x.version = ref.version;
    });
    return { ok: true, ...(ref.version ? { version: ref.version } : {}) };
  } catch (e) {
    if (e instanceof SkillError) return { ok: false, status: e.status, error: e.message, ...(e.problems ? { problems: e.problems } : {}) };
    return { ok: false, status: 500, error: (e as Error).message };
  } finally {
    going.delete(p.id);
  }
}

/** The owner's Reject: dropped, nothing changed. */
export function rejectProposal(messageId: string, proposalId: string): ProposalAnswer {
  if (onRunner()) return { ok: false, status: 409, error: "Reject it in Bops on your Mac." };
  const f = find(messageId, proposalId);
  if (!f) return { ok: false, status: 404, error: "That proposal isn't here anymore." };
  if (f.p.status) return { ok: false, status: 409, error: f.p.status === "accepted" ? "It was accepted already." : "It was rejected already." };
  patch(messageId, proposalId, (x) => {
    x.status = "rejected";
    x.doneAt = Date.now();
  });
  return { ok: true };
}

/** A proposal's change on what the skill is now, for the card's View on what it is now. */
export function proposalDiff(messageId: string, proposalId: string): { ok: true; lines: DiffLine[]; why: string | null } | { ok: false; status: number; error: string } {
  const f = find(messageId, proposalId);
  if (!f) return { ok: false, status: 404, error: "That proposal isn't here anymore." };
  const notOwn = notItsOwn(f);
  if (notOwn) return { ok: false, status: 403, error: notOwn };
  const r = findRef(f.p.ws, f.p.kind, f.p.slug);
  if (!r) return { ok: false, status: 404, error: "That skill was deleted." };
  const now = skillFileText(f.p.ws, r, f.p.file, "folder");
  if (!now) return { ok: false, status: 404, error: "Its folder is gone from this Mac." };
  const next = proposedText(f.p, now.text);
  if ("error" in next) return { ok: false, status: 409, error: next.error };
  return { ok: true, lines: lineDiff(now.text ?? "", next.text), why: staleWhy(f.p, r.version ?? "", now, ownHere(f.p)) };
}
