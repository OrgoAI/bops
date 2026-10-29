import "server-only";
import { SKILL_LABEL_MAX, UNSORTED } from "@/lib/skill-labels";
import { noteOutOfCredit, creditsOut } from "./cloud";
import { openaiClient } from "./openai-client";
import { LIGHT } from "./routing";
import { setting } from "./models";
import { recordTokens, usageTags } from "./usage";

/**
 * A label for each of a few skills, by one call of a small model (routing.ts LIGHT, through Bops Cloud, as
 * memory-categories.ts sorts facts): it reads each skill's name and description and picks one of the
 * workspace's labels or Bops' preset ones, Unsorted when none fits, or one new short label for skills none
 * fits that belong together (workspace-skills.ts suggestLabels takes one new label a call at most). Not
 * stored by the provider, a fixed shape, low effort. Null when it couldn't be asked or didn't answer usably
 * (out of credit, down, slow): the caller keeps what it had.
 */

const MODEL = () => setting(LIGHT(), "BOPS_SKILL_LABEL_MODEL");
const openai = openaiClient();

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skills"],
  properties: {
    skills: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["i", "label"], properties: { i: { type: "integer" }, label: { type: "string" } } },
    },
  },
} as const;

export async function pickLabels(skills: { i: number; name: string; description: string }[], labels: string[]): Promise<Map<number, string> | null> {
  if (!skills.length || (await creditsOut())) return null;
  const instructions = [
    "You put each skill of a workspace (how its AI assistants do one kind of job) under one label, so related skills are listed together.",
    "Rules:",
    "- Pick the label from the list that fits the skill's job best, spelled exactly as listed.",
    `- None fits: a new label, a word or two in plain words ("Sales calls", "Hiring"), at most ${SKILL_LABEL_MAX} characters. At most one new label in all: give it to every skill it fits.`,
    `- Still nothing fits: ${UNSORTED}.`,
    "- One answer for each skill, by its i. No dashes.",
  ].join("\n");
  try {
    const res = await openai.responses.create(
      { model: MODEL(), reasoning: { effort: "low" }, store: false, instructions, input: JSON.stringify({ labels, skills }), text: { format: { type: "json_schema", name: "skill_labels", strict: true, schema: SCHEMA } } },
      { ...usageTags("decide"), timeout: 30_000, maxRetries: 1 },
    );
    recordTokens("decide", res.model, res.usage);
    const out = JSON.parse(res.output_text) as { skills: { i: number; label: string }[] };
    const map = new Map<number, string>();
    for (const x of out.skills) if (Number.isInteger(x.i) && x.i >= 0 && x.i < skills.length && typeof x.label === "string") map.set(x.i, x.label);
    return map;
  } catch (e) {
    if (!noteOutOfCredit(e)) console.warn(`[skills] labels from a model: ${(e as Error).message}`);
    return null;
  }
}
