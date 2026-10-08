import "server-only";
import { appHeaders } from "./app-version";
import { cloudProxy, cloudSession } from "./cloud";
import { stateEpoch } from "./store";
import { recordDecide, usageTags } from "./usage";

/**
 * Small, fast judgment calls ("is this a sign-in page?", "is the bot waiting on the user?") go to
 * TypeSafe's Jev: typed answers with calibrated probabilities in ~200 ms, for a fraction of a
 * cent per thousand. Text only, read literally, so questions spell out exactly what each answer
 * means. Swap the backend here (e.g. OpenAI's Decisions API) without touching callers. Signed in
 * with Orgo it goes through Bops Cloud (lib/server/cloud.ts), when the cloud runs it; self-hosting,
 * on TYPESAFE_API_KEY. Each call is counted as a quick check (usage.ts recordDecide), at the tokens
 * Typesafe says it read, for the bot it's about when the caller says (`opts.botId`); through the
 * cloud, the cloud counts and prices it too (what AI credit pays).
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
export async function decide<K extends string>(state: Text, questions: Partial<Record<K, Question>>, opts: { botId?: string } = {}): Promise<Partial<Record<K, Answer>> | null> {
  const via = cloudProxy("typesafe");
  const key = via ? via.key : process.env.TYPESAFE_API_KEY;
  if (!key || (via && !(await cloudSession().catch(() => null))?.typesafe)) return null;
  const body = JSON.stringify({ model: "jev-latest", state, questions });
  // Counted for the user whose state this was asked for (the ledger is in their state).
  const epoch = stateEpoch();
  try {
    const res = await fetch(`${via ? via.url : "https://api.typesafe.ai"}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(via ? { ...usageTags("decide", opts.botId).headers, ...appHeaders() } : {}) },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const answer = (await res.json()) as { answers: Partial<Record<K, Answer>>; model?: string; usage?: { input_tokens?: number } | null };
    // What Typesafe read (about 4 bytes a token when it doesn't say), as the cloud counts it.
    const said = answer.usage?.input_tokens;
    recordDecide(answer.model ?? "jev-latest", typeof said === "number" && Number.isFinite(said) && said >= 0 ? said : Math.ceil(Buffer.byteLength(body) / 4), opts.botId, epoch);
    return answer.answers;
  } catch (e) {
    console.warn("[decide]", (e as Error).message);
    return null;
  }
}

export const chose = (a: Answer | undefined) => (a?.type === "choice" ? a : undefined);
export const yes = (a: Answer | undefined) => (a?.type === "noul" ? a.noul : undefined);
