/*
 * Skills grouped by label, so a bot with many skills looks at a few labels first, opens the one that fits
 * the job, and only then reads a skill. Every skill has one label (SkillRef.label; one it never got is
 * UNSORTED). Bops ships some skills of its own, in labels of their own (lib/builtin-skills.ts BUILTIN_SKILLS),
 * which every bot has and nobody edits: the first is APPS_LABEL, for building, versioning and deploying an
 * app with Ingot. Imported by the window and the Mac server.
 */

/** A label's name: short, plain words ("Email", "Sales calls", "Apps and source control"). */
export const SKILL_LABEL_MAX = 40;
/**
 * Where a skill without a label is listed. Never kept as a label: a skill there has none (no SKILL.md
 * metadata.label, orgo-web's skills.label NULL). "Other", its name before, is read as it, any case.
 */
export const UNSORTED = "Unsorted";
/** The built-in label for apps: Ingot source control, several people pushing, deploying. */
export const APPS_LABEL = "Apps and source control";

const trimmed = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, SKILL_LABEL_MAX).trim() : "");

/** No label: none, empty, or "Unsorted" or "Other" in any case. */
export const isUnsorted = (v: unknown) => /^(|unsorted|other)$/i.test(trimmed(v));

/** A label cleaned for listing: trimmed, spaces collapsed, at most SKILL_LABEL_MAX characters; none is UNSORTED. */
export function cleanLabel(v: unknown): string {
  return isUnsorted(v) ? UNSORTED : trimmed(v);
}

/** A label as it's kept (a SkillRef, a SKILL.md, Orgo's column): cleaned, and undefined for UNSORTED. */
export const keptLabel = (v: unknown): string | undefined => (isUnsorted(v) ? undefined : trimmed(v));

/** The same label whatever its case or spacing ("email" is "Email"). */
export const sameLabel = (a: string, b: string) => cleanLabel(a).toLowerCase() === cleanLabel(b).toLowerCase();

/**
 * One label as a bot or the Skills page sees it. `about`: one line on what its skills are for (the
 * built-in labels' own; a workspace label's is its skills' names). `builtin`: Bops' own.
 */
export type SkillGroup = { label: string; about: string; builtin: boolean; count: number; slugs: string[] };

/**
 * What the owner wrote about a label of their workspace (orgo-web's skill_labels: GET and PUT
 * /api/projects/{id}/skill-labels), kept with the workspace (Workspace.skillLabelInfo). Optional: a label
 * with no row works the same, and a skill never points at it, only names its label. `about` is the line a
 * bot's prompt shows for the label (none: its skills' names, as before); `position`, where the owner put it.
 */
export type SkillLabelInfo = { name: string; about: string; position: number };
/** The longest about line kept. */
export const LABEL_ABOUT_MAX = 200;

/** A label's row, whatever its case or spacing. */
export const labelInfoOf = (info: SkillLabelInfo[] | undefined, label: string) => info?.find((x) => sameLabel(x.name, label));

/**
 * Whether a bot has one of its workspace's skills, the one rule every list, read, copy to a computer and
 * count keeps (Bops' own skills are every bot's, always, and never come here): the skill's own bot list
 * when it names any (SkillRef.botIds, orgo-web's skills.bot_ids); else the bot's labels (Bot.skillLabels,
 * orgo-web's bops_bots.skill_labels), unset being every label, or the skill's label among them.
 */
export function botHasSkill(r: { botIds?: string[]; label?: string }, b: { id: string; skillLabels?: string[] }): boolean {
  if (r.botIds?.length) return r.botIds.includes(b.id);
  return !b.skillLabels || b.skillLabels.some((l) => sameLabel(l, cleanLabel(r.label)));
}

/** Whether a bot has a label: every label (Bot.skillLabels unset), or that one among them. */
export const botHasLabel = (b: { skillLabels?: string[] }, label: string) => !b.skillLabels || b.skillLabels.some((l) => sameLabel(l, label));

/**
 * A bot's labels after the owner ticked (`on`) or unticked a label for it, from every label the workspace
 * has (`all`). The first untick of a bot with every label makes it every label but that one. Every label
 * ticked again is every label (undefined), so one made later is its too, as a skill with every bot named is
 * every bot's (workspace-skills.ts setSkillBot).
 */
export function nextBotLabels(now: string[] | undefined, all: string[], label: string, on: boolean): string[] | undefined {
  const had = now ?? all;
  const rest = had.filter((l) => !sameLabel(l, label));
  const next = on ? [...rest, cleanLabel(label)] : rest;
  const kept = [...new Map(next.map((l) => [cleanLabel(l).toLowerCase(), cleanLabel(l)])).values()];
  return all.length && all.every((l) => kept.some((k) => sameLabel(k, l))) ? undefined : kept;
}
