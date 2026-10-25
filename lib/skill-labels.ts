/*
 * Skills grouped by label, so a bot with many skills looks at a few labels first, opens the one that fits
 * the job, and only then reads a skill. Every skill has one label (SkillRef.label; one it never got is
 * OTHER). Bops ships some skills of its own, in labels of their own (lib/builtin-skills.ts BUILTIN_SKILLS),
 * which every bot has and nobody edits: the first is APPS_LABEL, for building, versioning and deploying an
 * app with Ingot. Imported by the window and the Mac server.
 */

/** A label's name: short, plain words ("Email", "Sales calls", "Apps and source control"). */
export const SKILL_LABEL_MAX = 40;
/** Where a skill without a label is listed. */
export const OTHER = "Other";
/** The built-in label for apps: Ingot source control, several people pushing, deploying. */
export const APPS_LABEL = "Apps and source control";

/** A label cleaned for keeping: trimmed, spaces collapsed, at most SKILL_LABEL_MAX characters; empty is OTHER. */
export function cleanLabel(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, SKILL_LABEL_MAX).trim() : "";
  return s || OTHER;
}

/** The same label whatever its case or spacing ("email" is "Email"). */
export const sameLabel = (a: string, b: string) => cleanLabel(a).toLowerCase() === cleanLabel(b).toLowerCase();

/**
 * One label as a bot or the Skills page sees it. `about`: one line on what its skills are for (the
 * built-in labels' own; a workspace label's is its skills' names). `builtin`: Bops' own.
 */
export type SkillGroup = { label: string; about: string; builtin: boolean; count: number; slugs: string[] };
