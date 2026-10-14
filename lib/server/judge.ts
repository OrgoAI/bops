import "server-only";
import { openaiClient } from "./openai-client";
import { SOL } from "./routing";
import { recordTokens, usageTags } from "./usage";

/**
 * A grader for the comparison runs (scripts/bench-tasks.mjs --grid): does a bot's answer to a task
 * meet the task's rubric? A strong, careful model reads it (6.1 Sol at high effort), and says pass or
 * fail and why in a sentence. It judges what the answer says, not facts it can't check: a rubric
 * names what a right answer contains.
 */
export async function judgeAnswer(task: string, rubric: string, answer: string): Promise<{ pass: boolean; why: string }> {
  if (!answer.trim()) return { pass: false, why: "No answer." };
  const client = openaiClient();
  const res = await client.responses.create(
    {
      model: SOL(),
      reasoning: { effort: "high" },
      store: false,
      instructions:
        "You grade an AI assistant's answer to a task against a rubric. Pass it only when it meets every point of the rubric; partial or vague answers fail. Judge only what the answer says: don't fail it for facts you can't check yourself, and don't pass it for effort. Say why in one plain sentence.",
      input: JSON.stringify({ task, rubric, answer: answer.slice(0, 8000) }),
      text: {
        format: {
          type: "json_schema",
          name: "grade",
          strict: true,
          schema: { type: "object", additionalProperties: false, required: ["pass", "why"], properties: { pass: { type: "boolean" }, why: { type: "string" } } },
        },
      },
    },
    usageTags("decide"),
  );
  recordTokens("decide", res.model, res.usage);
  const out = JSON.parse(res.output_text || "{}") as { pass?: boolean; why?: string };
  return { pass: out.pass === true, why: out.why ?? "" };
}
