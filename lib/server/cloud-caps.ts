import "server-only";
import type { CloudCap, CloudHealth } from "@/cloud/protocol";
import { cloudUrl } from "./cloud-url";

/**
 * Whether this Mac's Bops Cloud does `cap` (cloud/protocol.ts CLOUD_CAPS), as its GET /health says. Once it says so
 * it's kept (a Bops Cloud is never rolled back past a cap an app went by without a release saying so); a no, or no
 * answer, is asked again after a minute. Never throws: no answer is a no.
 */
const NO_MS = 60_000;
const known = new Set<CloudCap>();
const asked = new Map<CloudCap, { at: number; going?: Promise<boolean> }>();
type Health = () => Promise<CloudHealth | null>;
const realHealth: Health = async () => {
  const res = await fetch(`${cloudUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  // A 503 (its database down) still says what it does.
  return (await res.json().catch(() => null)) as CloudHealth | null;
};
let health: Health = realHealth;

export async function cloudDoes(cap: CloudCap): Promise<boolean> {
  if (known.has(cap)) return true;
  const was = asked.get(cap);
  if (was?.going) return was.going;
  if (was && Date.now() - was.at < NO_MS) return false;
  const going = health()
    .then((h) => !!h && Array.isArray(h.caps) && h.caps.includes(cap))
    .catch(() => false)
    .then((yes) => {
      if (yes) known.add(cap);
      asked.set(cap, { at: Date.now() });
      return yes;
    });
  asked.set(cap, { at: Date.now(), going });
  return going;
}

/** For tests: this way to read Bops Cloud's /health (unset: the real one), and nothing kept. */
export function resetCloudCaps(o: { health?: Health } = {}) {
  health = o.health ?? realHealth;
  known.clear();
  asked.clear();
}
