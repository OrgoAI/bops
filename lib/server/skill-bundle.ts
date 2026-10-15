import "server-only";
import { createHash } from "node:crypto";

/**
 * A skill (or an app) is a folder in the Anthropic Agent Skill shape: SKILL.md (YAML frontmatter, then
 * a markdown body) and the files it needs. This file is pure: it reads SKILL.md, writes it back, and
 * checks a folder's files the way orgo-web's importer does (lib/skills/bundle.ts in orgo-web, decided
 * in .ops-kit/bops-skills/FORMAT-REVIEW.md): the same paths, junk, caps and secret rules, so a folder
 * Bops takes in is one Orgo takes too. A finding names the path, the line and the kind of problem,
 * never the text that matched.
 */

export const BUNDLE_LIMITS = {
  /** SKILL.md body, bytes. */
  body: 64 * 1024,
  /** One file, bytes. */
  file: 256 * 1024,
  /** Files in a bundle, SKILL.md included. */
  files: 200,
  /** The whole bundle, bytes. */
  total: 2 * 1024 * 1024,
  frontmatter: 16 * 1024,
  description: 1024,
  slug: 64,
  path: 512,
  pathDepth: 16,
} as const;

export const RISKS = ["read", "write", "destructive"] as const;
export const RUNS_ON = ["local", "remote-host", "container"] as const;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const VAULT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export type Problem = { path: string; reason: string; line?: number };
export type BundleFile = { path: string; content: string; sha256: string; size: number; executable: boolean };

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/* ---------------- Paths and junk ---------------- */

/** The normalized path, or why it's refused. Never resolves "..". */
export function normalizePath(raw: string): { path: string } | { reason: string } {
  if (typeof raw !== "string" || !raw) return { reason: "path is empty" };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { reason: "path has a control character" };
  if (raw.includes("\\")) return { reason: "path uses a backslash" };
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return { reason: "path is absolute" };
  let path = raw.normalize("NFC");
  while (path.startsWith("./")) path = path.slice(2);
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "..") return { reason: "path leaves the folder (..)" };
    if (s === "" || s === ".") return { reason: "path has an empty or . segment" };
  }
  if (path.length > BUNDLE_LIMITS.path) return { reason: `path is over ${BUNDLE_LIMITS.path} characters` };
  if (segments.length > BUNDLE_LIMITS.pathDepth) return { reason: `path is over ${BUNDLE_LIMITS.pathDepth} folders deep` };
  return { path };
}

/** Why a path is junk (never kept), or null. */
export function junkReason(path: string): string | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (segments.includes("__pycache__")) return "junk: __pycache__";
  if (segments.includes(".git")) return "junk: .git";
  if (segments.includes("node_modules")) return "junk: node_modules";
  if (name === ".DS_Store") return "junk: .DS_Store";
  if (/\.bak([-._~\d]|$)/i.test(name) || /~$/.test(name)) return "junk: backup file";
  if (/\.pyc$/i.test(name)) return "junk: .pyc";
  if (/\.log(\.\d+)?$/i.test(name)) return "junk: log file";
  return null;
}

/* ---------------- Secrets ---------------- */

type SecretRule = { reason: string; re: RegExp; keep?: (m: RegExpExecArray) => boolean };

const PLACEHOLDER_RE = /^(\$.*|<.*>|\*+|x+|\.\.\.|…|%s|%\(.*|\{.*\}|password|passwd|pass|pw|secret|changeme|redacted|example|your[-_].*|null|none)$/i;

const SECRET_RULES: SecretRule[] = [
  { reason: "private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { reason: "AWS access key id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { reason: "Stripe secret key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { reason: "Stripe webhook secret", re: /\bwhsec_[0-9A-Za-z]{24,}\b/g },
  { reason: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { reason: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { reason: "OpenAI style API key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { reason: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { reason: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { reason: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    reason: "connection string with a password",
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"`]+:([^\s@/'"`]+)@/gi,
    keep: (m) => !PLACEHOLDER_RE.test(m[1]) && !m[1].includes("$"),
  },
  {
    reason: "high entropy secret assignment",
    re: /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|CREDENTIAL)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_.-]{20,})/gi,
    keep: (m) => !PLACEHOLDER_RE.test(m[2]) && shannonEntropy(m[2]) >= 3.5,
  },
];

export function shannonEntropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const lineAt = (text: string, index: number) => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** Secrets in a text: one finding per kind per line, with the line and the kind. The text that matched is never returned. */
export function scanSecrets(path: string, text: string): Problem[] {
  const found: Problem[] = [];
  const seen = new Set<string>();
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (rule.keep && !rule.keep(m)) continue;
      const line = lineAt(text, m.index);
      const key = `${rule.reason}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path, line, reason: `secret: ${rule.reason}` });
      if (found.length >= 20) return found;
    }
  }
  return found.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Vault names a text uses ($STRIPE_SECRET_KEY, ${GITHUB_TOKEN}) that the frontmatter doesn't declare in
 * requires_secrets: flagged, never refused (a script's own variables look the same).
 */
export function undeclaredSecrets(files: { path: string; content: string }[], declared: string[]): Problem[] {
  const known = new Set(declared);
  const out: Problem[] = [];
  const looksSecret = /(?:SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|DATABASE_URL|DSN)/;
  for (const f of files) {
    const seen = new Set<string>();
    for (const m of f.content.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)) {
      const name = m[1];
      if (known.has(name) || seen.has(name) || !looksSecret.test(name)) continue;
      seen.add(name);
      out.push({ path: f.path, line: lineAt(f.content, m.index ?? 0), reason: `uses ${name}, which requires_secrets doesn't declare` });
    }
  }
  return out;
}

/* ---------------- SKILL.md ---------------- */

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** A YAML scalar as text: quotes taken off, true/false and null read, the rest kept as written. */
function scalar(raw: string): unknown {
  const v = raw.trim();
  if (!v) return "";
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^\d+\.\d+\.\d+/.test(v)) return Number(v);
  return v.replace(/\s+#.*$/, "");
}

/** A flow list or map ([a, b], {k: v}) one level deep. */
function flow(v: string): unknown {
  const inner = v.slice(1, -1).trim();
  if (!inner) return v.startsWith("[") ? [] : {};
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  if (v.startsWith("[")) return parts.map((p) => value(p.trim()));
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i > 0) out[p.slice(0, i).trim()] = value(p.slice(i + 1).trim());
  }
  return out;
}

const value = (v: string): unknown => ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}")) ? flow(v) : scalar(v));

/**
 * The YAML a SKILL.md's frontmatter holds, as skills write it: `key: value`, flow lists and maps,
 * block lists (`- item`), one level of nested mapping, and block text (`|`, `>`). Anything else is
 * refused rather than guessed at.
 */
export function parseYaml(text: string): Record<string, unknown> | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const blank = (l: string) => !l.trim() || l.trimStart().startsWith("#");
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    if (indentOf(line) !== 0) return null;
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    if (!m) return null;
    const key = m[1];
    const rest = m[2].trim();
    i++;
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const block: string[] = [];
      while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > 0)) block.push(lines[i++]);
      const pad = Math.min(...block.filter((l) => l.trim()).map(indentOf), 1e9);
      const body = block.map((l) => l.slice(Math.min(pad, l.length)));
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out[key] = rest.startsWith("|") ? body.join("\n") : body.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }
    if (rest) {
      out[key] = value(rest);
      continue;
    }
    // A block list or a nested mapping (one level), or nothing.
    const kids: string[] = [];
    while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]) > 0)) {
      if (!blank(lines[i])) kids.push(lines[i]);
      i++;
    }
    if (!kids.length) out[key] = null;
    else if (kids.every((l) => l.trimStart().startsWith("- "))) out[key] = kids.map((l) => value(l.trimStart().slice(2).trim()));
    else {
      const map: Record<string, unknown> = {};
      for (const l of kids) {
        const k = /^\s+([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(l);
        if (!k) return null;
        map[k[1]] = value(k[2].trim());
      }
      out[key] = map;
    }
  }
  return out;
}

export type ParsedSkillMd = { ok: true; frontmatter: Record<string, unknown> | null; body: string } | { ok: false; reason: string };

/** SKILL.md as frontmatter (null when it has none) and body. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { ok: true, frontmatter: null, body: text.replace(/^﻿/, "") };
  const yaml = m[1] ?? "";
  if (byteLength(yaml) > BUNDLE_LIMITS.frontmatter) return { ok: false, reason: `frontmatter is over ${BUNDLE_LIMITS.frontmatter / 1024} KB` };
  const fm = yaml.trim() ? parseYaml(yaml) : {};
  if (!fm) return { ok: false, reason: "frontmatter is not YAML Bops can read" };
  return { ok: true, frontmatter: fm, body: text.slice(m[0].length) };
}

const FIRST_KEYS = ["name", "description", "version"];

/** A value as YAML on one line: plain when that's safe, else a JSON string (which YAML reads as a double quoted one). */
function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(yamlValue).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${yamlValue(x)}`).join(", ")}}`;
  const s = String(v);
  return /^[A-Za-z0-9][A-Za-z0-9 ._/@+()-]*$/.test(s) && !/^(true|false|null|~|\d[\d.]*)$/.test(s) && !/:\s|\s#/.test(s) ? s : JSON.stringify(s);
}

/** SKILL.md from frontmatter (name, description and version first, then a to z) and a body. */
export function renderSkillMd(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter)
    .filter((k) => frontmatter[k] !== undefined)
    .sort((a, b) => {
      const ia = FIRST_KEYS.indexOf(a);
      const ib = FIRST_KEYS.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return `---\n${keys.map((k) => `${k}: ${yamlValue(frontmatter[k])}\n`).join("")}---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/** Checks the keys Orgo knows when they're there. */
export function validateFrontmatter(fm: Record<string, unknown>): Problem[] {
  const errors: Problem[] = [];
  const bad = (key: string, reason: string) => errors.push({ path: "SKILL.md", reason: `frontmatter ${key}: ${reason}` });
  if (fm.version !== undefined && (typeof fm.version !== "string" || !SEMVER_RE.test(fm.version))) bad("version", "a version such as 1.2.0");
  if (fm.risk !== undefined && !(RISKS as readonly unknown[]).includes(fm.risk)) bad("risk", `one of ${RISKS.join(", ")}`);
  if (fm.runs_on !== undefined && !(RUNS_ON as readonly unknown[]).includes(fm.runs_on)) bad("runs_on", `one of ${RUNS_ON.join(", ")}`);
  if (fm.requires_secrets !== undefined && (!Array.isArray(fm.requires_secrets) || !fm.requires_secrets.every((s) => typeof s === "string" && VAULT_NAME_RE.test(s))))
    bad("requires_secrets", "a list of vault key names (never the values)");
  return errors;
}

/** The slug a name starts from: lowercase ASCII words joined by "-". */
export function slugify(name: string, max = 60): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return base || "skill";
}

/** base when free, else base-2, base-3, and so on. */
export function freeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const c = `${base.slice(0, BUNDLE_LIMITS.slug - String(n).length - 1)}-${n}`;
    if (!used.has(c)) return c;
  }
}

/** The first H1 and the first paragraph of a markdown doc. */
export function summarizeDoc(text: string): { title: string | null; summary: string | null } {
  let title: string | null = null;
  const para: string[] = [];
  let fence = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      if (para.length) break;
      continue;
    }
    if (fence) continue;
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && !title) {
      title = h1[1];
      continue;
    }
    if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\s*[|>]/.test(line)) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }
  const summary = para.join(" ").replace(/\s+/g, " ").trim();
  return { title, summary: summary ? (summary.length > BUNDLE_LIMITS.description ? `${summary.slice(0, BUNDLE_LIMITS.description - 1)}…` : summary) : null };
}

/* ---------------- A folder ---------------- */

export type FolderFile = { path: string; content: string | null; executable: boolean; size: number; link?: "outside" };

export type Checked = {
  ok: true;
  name: string;
  slugBase: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
  files: BundleFile[];
  /** Left out on purpose: junk, links that leave the folder, a file with a secret in it. Path and reason only. */
  skipped: Problem[];
  warnings: Problem[];
  /** The frontmatter was drafted from a README or SPEC (or nothing): it stays a draft. */
  drafted: boolean;
};

/**
 * A folder's files checked as orgo-web's importer does: junk and links out of the folder are skipped, a
 * file holding a secret is left out and listed (path, line, kind), a missing SKILL.md is drafted from
 * README.md or SPEC.md. A secret in SKILL.md itself, a bad path or a cap refuses the whole folder.
 * `strict` (a save, not an import): any secret, anywhere, refuses it.
 */
export function checkFolder(input: FolderFile[], opts: { folderName?: string; strict?: boolean } = {}): Checked | { ok: false; errors: Problem[]; skipped: Problem[] } {
  const errors: Problem[] = [];
  const skipped: Problem[] = [];
  const warnings: Problem[] = [];
  const kept = new Map<string, { content: string; executable: boolean }>();
  for (const f of input) {
    const norm = normalizePath(f.path);
    if ("reason" in norm) {
      errors.push({ path: f.path.slice(0, BUNDLE_LIMITS.path), reason: norm.reason });
      continue;
    }
    const junk = junkReason(norm.path);
    if (junk) {
      skipped.push({ path: norm.path, reason: junk });
      continue;
    }
    if (f.link === "outside") {
      skipped.push({ path: norm.path, reason: "link to outside the folder" });
      continue;
    }
    if (f.size > BUNDLE_LIMITS.file) {
      errors.push({ path: norm.path, reason: `file is over ${BUNDLE_LIMITS.file / 1024} KB` });
      continue;
    }
    if (f.content === null || f.content.includes("\u0000")) {
      skipped.push({ path: norm.path, reason: "binary file (only text files are kept)" });
      continue;
    }
    kept.set(norm.path, { content: f.content, executable: f.executable });
  }
  for (const [path, f] of [...kept]) {
    const found = scanSecrets(path, f.content);
    if (!found.length) continue;
    if (opts.strict || path === "SKILL.md") errors.push(...found);
    else {
      skipped.push(...found);
      kept.delete(path);
    }
  }
  let doc: string | null = null;
  let source = "none";
  for (const n of ["SKILL.md", "README.md", "SPEC.md"])
    if (kept.has(n)) {
      doc = kept.get(n)!.content;
      kept.delete(n);
      source = n;
      break;
    }
  let frontmatter: Record<string, unknown> = {};
  let body = "";
  let drafted = source !== "SKILL.md";
  if (doc !== null) {
    const parsed = parseSkillMd(doc);
    if (!parsed.ok) errors.push({ path: "SKILL.md", reason: parsed.reason });
    else {
      frontmatter = parsed.frontmatter ?? {};
      body = parsed.body;
      if (parsed.frontmatter === null) drafted = true;
    }
  }
  const files: BundleFile[] = [...kept]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, f]) => ({ path, content: f.content, sha256: sha256Hex(f.content), size: byteLength(f.content), executable: f.executable }));
  const sum = summarizeDoc(body);
  const fmName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const name = (sum.title?.trim() || fmName || opts.folderName || "").slice(0, 120);
  if (!name) errors.push({ path: "SKILL.md", reason: "a skill needs a name" });
  const description = (typeof frontmatter.description === "string" ? frontmatter.description.trim() : "") || sum.summary || (name ? `${name}.` : "");
  if (description.length > BUNDLE_LIMITS.description) errors.push({ path: "SKILL.md", reason: `description is ${BUNDLE_LIMITS.description} characters at most` });
  if (doc === null) body = `# ${name || "Skill"}\n\nDrafted on import: this folder had no SKILL.md, README.md or SPEC.md.\n\n## Files\n\n${files.map((f) => `- \`${f.path}\`${f.executable ? " (executable)" : ""}`).join("\n")}\n`;
  if (byteLength(body) > BUNDLE_LIMITS.body) errors.push({ path: "SKILL.md", reason: `body is over ${BUNDLE_LIMITS.body / 1024} KB` });
  errors.push(...validateFrontmatter(frontmatter));
  const total = files.reduce((n, f) => n + f.size, 0) + byteLength(body);
  if (files.length + 1 > BUNDLE_LIMITS.files) errors.push({ path: "", reason: `a skill holds ${BUNDLE_LIMITS.files} files at most` });
  if (total > BUNDLE_LIMITS.total) errors.push({ path: "", reason: `a skill is ${BUNDLE_LIMITS.total / 1024 / 1024} MB at most` });
  if (errors.length) return { ok: false, errors, skipped };
  if (body.split("\n").length > 500) warnings.push({ path: "SKILL.md", reason: "body is over 500 lines; move long tables to references/" });
  for (const f of files) if (/StrictHostKeyChecking\s*=?\s*no/.test(f.content)) warnings.push({ path: f.path, reason: "turns off SSH host key checking" });
  const declared = Array.isArray(frontmatter.requires_secrets) ? (frontmatter.requires_secrets as string[]) : [];
  warnings.push(...undeclaredSecrets([{ path: "SKILL.md", content: body }, ...files], declared));
  const slugBase = fmName && SLUG_RE.test(fmName) && fmName.length <= BUNDLE_LIMITS.slug ? fmName : slugify(fmName || name);
  return { ok: true, name, slugBase, description, frontmatter, body, files, skipped, warnings, drafted };
}

/** A bundle's hash: sha256 over "path NUL sha256 LF" for every file sorted by path, SKILL.md included (as orgo-web hashes it). */
export function bundleSha(skillMd: string, files: { path: string; sha256: string }[]): string {
  const entries = [{ path: "SKILL.md", sha256: sha256Hex(skillMd) }, ...files.map((f) => ({ path: f.path, sha256: f.sha256 }))].sort((a, b) => (a.path < b.path ? -1 : 1));
  return sha256Hex(entries.map((e) => `${e.path}\u0000${e.sha256}\n`).join(""));
}

/** Whether a file is a script someone has to approve before it runs: executable, under scripts/, or one with a #! line. */
export const isScript = (f: { path: string; content: string; executable: boolean }) => f.executable || f.path.startsWith("scripts/") || f.content.startsWith("#!");

/** The next patch after the highest version (0.1.0 when there's none). */
export function nextVersion(versions: string[]): string {
  const parse = (v: string) => SEMVER_RE.exec(v)?.slice(1, 4).map(Number) as [number, number, number] | undefined;
  const all = versions.map(parse).filter((x): x is [number, number, number] => !!x);
  if (!all.length) return "0.1.0";
  all.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [a, b, c] = all[all.length - 1];
  return `${a}.${b}.${c + 1}`;
}
