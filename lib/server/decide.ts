import "server-only";
import { cloudProxy, cloudSession } from "./cloud";

/**
 * Small, fast judgment calls ("is this a sign-in page?", "is the bot waiting on the user?") go to
 * TypeSafe's Jev: typed answers with calibrated probabilities in ~200 ms, for a fraction of a
 * cent per thousand. Text only, read literally, so questions spell out exactly what each answer
 * means. Swap the backend here (e.g. OpenAI's Decisions API) without touching callers. Signed in
 * with Orgo it goes through Bops Cloud (lib/server/cloud.ts), when the cloud runs it; self-hosting,
 * on TYPESAFE_API_KEY.
 */

type Text = string | Record<string, unknown> | unknown[];
export type Question =
  | { type: "choice"; instructions: Text; criteria: Record<string, Text | null> }
  | { type: "noul"; instructions: Text; criteria?: { true?: Text; false?: Text } }
  | { type: "score"; instructions: Text; criteria: Text[] };

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

/** Ask several questions about one state in a single call. Null when Jev isn't set up or fails. */
export async function decide<K extends string>(state: Text, questions: Partial<Record<K, Question>>): Promise<Partial<Record<K, Answer>> | null> {
  const via = cloudProxy("typesafe");
  const key = via ? via.key : process.env.TYPESAFE_API_KEY;
  if (!key || (via && !(await cloudSession().catch(() => null))?.typesafe)) return null;
  try {
    const res = await fetch(`${via ? via.url : "https://api.typesafe.ai"}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { answers: Partial<Record<K, Answer>> }).answers;
  } catch (e) {
    console.warn("[decide]", (e as Error).message);
    return null;
  }
}

export const chose = (a: Answer | undefined) => (a?.type === "choice" ? a : undefined);
export const yes = (a: Answer | undefined) => (a?.type === "noul" ? a.noul : undefined);
