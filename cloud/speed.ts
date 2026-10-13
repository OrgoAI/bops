/**
 * How fast the cloud's own model calls run when someone's waiting on them (the iPhone chat, a call
 * the cloud answers), as the Mac's do (lib/server/routing.ts): Ultrafast on the models that have it
 * (GPT-6.1 Sol, GPT-6 Astra), else Fast; a tier down when OpenAI turns one down (its rate limit, or a
 * 400 naming the tier). BOPS_SPEED caps it: auto (the default), fast, or standard. Each answer is
 * priced at the tier it ran on (pricing.ts tierMultiplier).
 */

const ULTRAFAST = /^gpt-6(\.1-sol|-astra)(-\d{4}-\d{2}-\d{2})?$/;

/** The tiers to try for someone waiting on `model`, fastest first. */
export function tiersFor(model: string): ("ultrafast" | "fast" | "default")[] {
  const cap = process.env.BOPS_SPEED?.trim() || "auto";
  if (cap === "standard") return ["default"];
  if (cap === "fast") return ["fast", "default"];
  return ULTRAFAST.test(model) ? ["ultrafast", "fast", "default"] : ["fast", "default"];
}

/**
 * Send a request to OpenAI at the fastest tier that takes it: `send` gets the body fields for a tier
 * (nothing for standard). The last tier's answer is returned whatever it is.
 */
export async function atSpeed(model: string, send: (tier: { service_tier?: string }) => Promise<Response>): Promise<Response> {
  const tiers = tiersFor(model);
  for (let i = 0; ; i++) {
    const res = await send(tiers[i] === "default" ? {} : { service_tier: tiers[i] });
    if (i === tiers.length - 1 || !(await refused(res))) return res;
    await res.body?.cancel().catch(() => {});
    console.warn(`[speed] ${tiers[i]} turned down (${res.status}): trying ${tiers[i + 1]}`);
  }
}

/** OpenAI turned the tier down: 429, or a 400 that names it. */
async function refused(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 400) return false;
  const text = await res.clone().text().catch(() => "");
  return /service[_ ]tier|ultrafast|\bfast\b/i.test(text);
}
