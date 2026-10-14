import { notReady } from "@/lib/server/ready";
import { judgeAnswer } from "@/lib/server/judge";

/** Whether a bot's answer to a task meets its rubric (lib/server/judge.ts): for the comparison runs (scripts/bench-tasks.mjs --grid). */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { task, rubric, answer } = (await request.json().catch(() => ({}))) as { task?: string; rubric?: string; answer?: string };
  if (!task?.trim() || !rubric?.trim()) return Response.json({ error: "task and rubric required" }, { status: 400 });
  return Response.json(await judgeAnswer(task, rubric, answer ?? ""));
}
