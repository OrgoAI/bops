import "server-only";

/**
 * A model setting from the environment: the first of `names` that's set to something, else
 * `fallback`. An empty one counts as not set: .env.example ships these keys blank, and a blank
 * `BOPS_CHAT_MODEL=` would otherwise send model "" to OpenAI.
 */
export function setting(fallback: string, ...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return fallback;
}
