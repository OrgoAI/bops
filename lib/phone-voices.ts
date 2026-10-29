import { CALL_VOICES, type CallVoice } from "@/lib/types";

/**
 * Calls to a bot's number in its own voice: AgentPhone speaks each answer (voice mode "webhook") in its agent's
 * `voice`, one of its own catalog's (GET /v1/agents/voices: voice_id, voice_name, gender, accent), set with
 * POST or PATCH /v1/agents (lib/server/phone.ts voiceToAgent). The nine call voices are OpenAI's; AgentPhone's
 * catalog comes from its voice provider, so each call voice is matched to the closest one there. Pure: the server
 * and the tests read it alike.
 */

/** One of AgentPhone's voices. */
export type PhoneVoice = { id: string; name: string; gender?: "male" | "female"; accent?: string };

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** The voices in AgentPhone's answer ({ data: [...] }, or a bare list), the well formed ones. */
export function phoneVoicesIn(json: unknown): PhoneVoice[] {
  const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : [];
  const out: PhoneVoice[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const v = x as Record<string, unknown>;
    const id = str(v.voice_id) || str(v.voiceId) || str(v.id);
    if (!id) continue;
    const g = str(v.gender).toLowerCase();
    const accent = str(v.accent);
    // Shown on the settings page as it is: a name like "Adrian", never a dash.
    const name = (str(v.voice_name) || str(v.voiceName) || str(v.name) || id).replace(/[\s_\-\u2010-\u2015]+/g, " ").trim();
    out.push({ id, name, ...(g.startsWith("f") ? { gender: "female" as const } : g.startsWith("m") ? { gender: "male" as const } : {}), ...(accent ? { accent } : {}) });
  }
  return out;
}

/**
 * How each call voice sounds (OpenAI's words for it: cedar warm and steady, ash clear, echo smooth, ballad soft,
 * verse lively; marin warm, coral bright, shimmer gentle, sage calm), as the names voice catalogs give voices like
 * it, the closest first.
 */
const LIKE: Record<CallVoice, { gender: "male" | "female"; names: string[] }> = {
  cedar: { gender: "male", names: ["Adrian", "Brian", "Daniel", "Adam"] },
  ash: { gender: "male", names: ["Andrew", "Chris", "Josh"] },
  echo: { gender: "male", names: ["Paul", "Eric", "Michael"] },
  ballad: { gender: "male", names: ["Anthony", "George", "Callum"] },
  verse: { gender: "male", names: ["Ryan", "Liam", "Max"] },
  marin: { gender: "female", names: ["Grace", "Sarah", "Rachel"] },
  coral: { gender: "female", names: ["Chloe", "Lily", "Jessica"] },
  shimmer: { gender: "female", names: ["Kate", "Matilda", "Charlotte"] },
  sage: { gender: "female", names: ["Dorothy", "Laura", "Nina"] },
};

/** A voice's words, lowercased ("openai-Cedar" → openai, cedar). */
const words = (v: PhoneVoice) => new Set(`${v.id} ${v.name}`.toLowerCase().split(/[^a-z]+/).filter(Boolean));
const american = (v: PhoneVoice) => /americ|\bus\b|united states/i.test(v.accent ?? "");

/**
 * The AgentPhone voice closest to call voice `want`: the same voice when AgentPhone has it by name (OpenAI's own
 * first), else the first voice named like it, else one of the same gender (an American one first), picked by the
 * call voice's place so the nine spread out. Null: nothing to pick from.
 */
export function closestPhoneVoice(want: CallVoice, voices: readonly PhoneVoice[]): { voice: PhoneVoice; exact: boolean } | null {
  if (!voices.length) return null;
  const same = voices.filter((v) => words(v).has(want));
  if (same.length) return { voice: same.find((v) => words(v).has("openai")) ?? same[0], exact: true };
  const like = LIKE[want];
  for (const name of like.names) {
    const v = voices.find((x) => x.gender !== (like.gender === "male" ? "female" : "male") && words(x).has(name.toLowerCase()));
    if (v) return { voice: v, exact: false };
  }
  const pool = voices.filter((v) => v.gender === like.gender);
  const from = pool.length ? [...pool.filter(american), ...pool.filter((v) => !american(v))] : [...voices];
  const place = CALL_VOICES.filter((v) => LIKE[v].gender === like.gender).indexOf(want);
  return { voice: from[Math.max(0, place) % from.length], exact: false };
}
