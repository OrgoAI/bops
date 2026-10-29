/**
 * Keys and tokens as they look, for taking out of what Bops reads back from a bot's computer (a CLI agent's
 * words, its errors, a thread's steps): the providers' key shapes (as lib/server/skill-bundle.ts finds them in
 * a skill's files) and a key gate's run token (vm/bin/bops-ai-gate: "bopsrun_" and 64 hex). A run token is
 * worth nothing once its run is over, and only on that computer, but it is never kept or shown either way.
 */
export const SECRET_PATTERNS: RegExp[] = [
  /\bbopsrun_[0-9a-f]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** `text` with every key or token in it replaced by "[hidden]". */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[hidden]");
  return out;
}

/** Every string in a value (an event read back from a computer) with keys and tokens taken out. */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}
