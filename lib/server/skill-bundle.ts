import "server-only";
import { createHash } from "node:crypto";
import { isUnsorted, keptLabel } from "@/lib/skill-labels";

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
  /** One file, bytes (a program as much as a script). */
  file: 50 * 1024 * 1024,
  /** Files in a bundle, SKILL.md included. */
  files: 2000,
  /** The whole bundle, bytes. */
  total: 100 * 1024 * 1024,
  frontmatter: 16 * 1024,
  description: 1024,
  slug: 64,
  path: 512,
  pathDepth: 16,
} as const;

export const RISKS = ["read", "write", "destructive"] as const;
export const RUNS_ON = ["local", "remote-host", "container"] as const;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A version such as 1.2.0 (the only shape a version folder's name may have). */
export const isVersion = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && SEMVER_RE.test(v);
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const VAULT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export type Problem = { path: string; reason: string; line?: number };
/** A file of a bundle: its text (`content`), or for a binary file (a program, an image) null and its bytes in `data`. sha256 and size are over its bytes. */
export type BundleFile = { path: string; content: string | null; data?: Buffer; sha256: string; size: number; executable: boolean };

export const sha256Hex = (text: string | Buffer) => (typeof text === "string" ? createHash("sha256").update(text, "utf8") : createHash("sha256").update(text)).digest("hex");
export const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
/** A file's bytes: its data, else its text as UTF-8. */
export const fileBytes = (f: { content: string | null; data?: Buffer }) => f.data ?? Buffer.from(f.content ?? "", "utf8");
/** Megabytes for a cap, the way a refusal says it. */
const mb = (n: number) => `${n / 1024 / 1024} MB`;

/* ---------------- Text or bytes ---------------- */

/** Media types by extension, as orgo-web reads them (lib/skills/bundle.ts there): text unless it's a known binary kind. */
const MEDIA_TYPES: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript",
  py: "text/x-python", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", ts: "text/x-typescript", json: "application/json",
  yaml: "application/yaml", yml: "application/yaml", toml: "application/toml", html: "text/html", htm: "text/html", css: "text/css", sql: "application/sql",
  tsv: "text/tab-separated-values", psv: "text/plain", csv: "text/csv", xml: "application/xml", svg: "image/svg+xml", ps1: "text/plain", rb: "text/x-ruby", go: "text/x-go",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", icns: "image/icns", pdf: "application/pdf",
  zip: "application/zip", gz: "application/gzip", tgz: "application/gzip", tar: "application/x-tar", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime", sqlite: "application/vnd.sqlite3",
  db: "application/octet-stream", bin: "application/octet-stream", so: "application/octet-stream", dylib: "application/octet-stream", exe: "application/octet-stream",
  jar: "application/java-archive", whl: "application/zip", dmg: "application/octet-stream",
};
const TEXT_APPLICATION = ["application/json", "application/yaml", "application/toml", "application/sql", "application/xml", "image/svg+xml", "application/javascript"];

/** Whether a path names a text kind of file (an unknown extension, or none, is text). */
export function isTextPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const mt = MEDIA_TYPES[dot > 0 ? name.slice(dot + 1).toLowerCase() : ""] ?? "text/plain";
  return mt.startsWith("text/") || TEXT_APPLICATION.includes(mt);
}

/** The text in bytes when they're UTF-8 without NUL, else null. */
export function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A file's text when it's a text file (a text kind of path, UTF-8 without NUL), else null: then it's kept as bytes, as orgo-web keeps it. */
export const textOf = (path: string, bytes: Uint8Array): string | null => (isTextPath(path) ? utf8Text(bytes) : null);

/** Why the secret scan can't read these bytes (archives, databases: orgo-web refuses them), or null. */
export function unscannableBinary(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const reason = (kind: string) => `${kind} (its contents can't be scanned for secrets; send the files themselves)`;
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08)) return reason("zip archive");
  if (starts(0x1f, 0x8b)) return reason("gzip archive");
  if (starts(0x42, 0x5a, 0x68)) return reason("bzip2 archive");
  if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return reason("xz archive");
  if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return reason("7z archive");
  if (starts(0x28, 0xb5, 0x2f, 0xfd)) return reason("zstd archive");
  if (starts(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return reason("rar archive");
  if (Buffer.from(bytes.subarray(0, 16)).toString("latin1") === "SQLite format 3\u0000") return reason("SQLite database");
  return null;
}

/** UTF-16 by its BOM, or by a NUL at (nearly) every other byte of the first 4 KB. */
function utf16Order(bytes: Uint8Array): "le" | "be" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "be";
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 8) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2) odd++;
    else even++;
  }
  const half = n / 2;
  if (odd >= half * 0.9 && even < half * 0.1) return "le";
  if (even >= half * 0.9 && odd < half * 0.1) return "be";
  return null;
}

/** The text the secret scan reads in a binary file, as orgo-web reads it: UTF-16 decoded when it's UTF-16, else Latin-1 (a key block in a program is still a key block). */
export function binaryScanText(bytes: Buffer): string {
  const order = utf16Order(bytes);
  if (!order) return bytes.toString("latin1");
  const even = Buffer.from(bytes.subarray(0, bytes.length & ~1));
  return (order === "be" ? even.swap16() : even).toString("utf16le");
}

/** Secrets in a file of either kind: its text, or what binaryScanText reads in its bytes. */
export const scanFile = (path: string, f: { content: string | null; data?: Buffer }) => scanSecrets(path, f.content ?? binaryScanText(f.data ?? Buffer.alloc(0)));

/* ---------------- Paths and junk ---------------- */

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.[^.]*)?$/i;

/** The key two paths collide on when written to a case insensitive disk (macOS, Windows), as orgo-web folds them. */
export const pathFoldKey = (path: string) => path.normalize("NFC").toLowerCase();

/** The normalized path, or why it's refused (orgo-web's rules, so what's kept here is accepted there). Never resolves "..". */
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
    // Names macOS or Windows can't hold, or that a JSON map turns into its prototype.
    if (/[. ]$/.test(s)) return { reason: "path has a name ending in a dot or a space" };
    if (/[:<>"|?*]/.test(s)) return { reason: 'path has a character Windows does not allow (: < > " | ? *)' };
    if (WINDOWS_RESERVED_RE.test(s)) return { reason: "path has a name Windows reserves (CON, NUL, COM1 …)" };
    if (s === "__proto__" || s === "constructor" || s === "prototype") return { reason: "path has a reserved name" };
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
  // Files that hold credentials the secret scan can't always tell (a short password, .netrc's "password x"): never kept.
  if (/^\.env($|\.)/i.test(name) || /^\.(netrc|pgpass|npmrc|pypirc)$/i.test(name) || /^id_[a-z0-9]+(\.pub)?$/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name)) return "credentials file: never kept";
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
 * metadata.requires-secrets (or requires_secrets, as before): flagged, never refused (a script's own variables look the same).
 */
export function undeclaredSecrets(files: { path: string; content: string | null }[], declared: string[]): Problem[] {
  const known = new Set(declared);
  const out: Problem[] = [];
  const looksSecret = /(?:SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|DATABASE_URL|DSN)/;
  for (const f of files) {
    if (f.content === null) continue;
    const seen = new Set<string>();
    for (const m of f.content.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)) {
      const name = m[1];
      if (known.has(name) || seen.has(name) || !looksSecret.test(name)) continue;
      seen.add(name);
      out.push({ path: f.path, line: lineAt(f.content, m.index ?? 0), reason: `uses ${name}, which metadata.requires-secrets doesn't declare` });
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

/* ---------------- The Agent Skills spec's form ---------------- */

/**
 * The Agent Skills spec (agentskills.io/specification) keeps only name, description, license, compatibility,
 * metadata (a map of string to string) and allowed-tools at the top of SKILL.md's frontmatter. Bops' own
 * fields live in metadata, as strings: metadata.label (the skill's one label), metadata.version (semver),
 * metadata.risk (read, write or destructive), metadata.runs-on (local, remote-host or container) and
 * metadata.requires-secrets (vault key names, space separated: never a value). Bops writes only that form
 * (toSpecForm). It reads the form from before too (top level version, risk, runs_on, a requires_secrets list,
 * label), so every skill kept or synced before keeps working, and a stored version is never refused for it;
 * a skill takes the new form on its next write. The same in orgo-web (lib/skills/bundle.ts there).
 */
export type SkillSpec = { label?: string; version?: string; risk?: string; runsOn?: string; requiresSecrets?: string[] };

/** The spec's name: 1 to 64 of a to z, 0 to 9 and single hyphens, none at either end. */
export const NAME_MAX = 64;
export const COMPATIBILITY_MAX = 500;
/** Bops' keys in metadata, and the top level ones they were before. */
const META = { label: "label", version: "version", risk: "risk", runsOn: "runs-on", requiresSecrets: "requires-secrets" } as const;
const OLD = { label: "label", version: "version", risk: "risk", runsOn: "runs_on", requiresSecrets: "requires_secrets" } as const;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A frontmatter's metadata map (none: empty). */
export const metadataOf = (fm: Record<string, unknown> | null | undefined): Record<string, unknown> => (isMap(fm?.metadata) ? fm.metadata : {});
/** A metadata value as the spec keeps one: a string (a number or true as written; a list as its words). */
const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : Array.isArray(v) ? v.map((x) => String(x)).join(" ") : v === null || v === undefined ? undefined : JSON.stringify(v);
const words = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  return undefined;
};

/**
 * Whether a value of one of Bops' fields is one Bops takes: any label, a version such as 1.2.0, a risk and a
 * runs-on from their lists, vault key names (100 at most). The same as orgo-web's (lib/skills/bundle.ts there).
 */
const FITS: Record<keyof typeof META, (v: unknown) => boolean> = {
  label: () => true,
  version: (v) => isVersion(asString(v)?.trim()),
  risk: (v) => (RISKS as readonly unknown[]).includes(asString(v)?.trim()),
  runsOn: (v) => (RUNS_ON as readonly unknown[]).includes(asString(v)?.trim()),
  requiresSecrets: (v) => {
    const names = words(v);
    return !!names && names.length <= 100 && names.every((s) => VAULT_NAME_RE.test(s));
  },
};

/**
 * Bops' fields in a frontmatter, in either form: metadata first, else the top level key from before. A value
 * Bops wouldn't take (a version such as "1.0", as the spec's own example writes metadata.version, or a risk
 * outside the list) reads as none, and the old form is tried: a stored version is read, never refused, as
 * orgo-web's skillMeta reads one. A version that isn't one is numbered when it's published.
 */
export function specOf(fm: Record<string, unknown> | null | undefined): SkillSpec {
  const meta = metadataOf(fm);
  const pick = (k: keyof typeof META) => (meta[META[k]] !== undefined && FITS[k](meta[META[k]]) ? meta[META[k]] : fm?.[OLD[k]] !== undefined && FITS[k](fm[OLD[k]]) ? fm[OLD[k]] : undefined);
  const label = asString(pick("label"))?.replace(/\s+/g, " ").trim();
  const version = asString(pick("version"))?.trim();
  const risk = asString(pick("risk"))?.trim();
  const runsOn = asString(pick("runsOn"))?.trim();
  const secrets = words(pick("requiresSecrets"));
  return { ...(label ? { label } : {}), ...(version ? { version } : {}), ...(risk ? { risk } : {}), ...(runsOn ? { runsOn } : {}), ...(secrets?.length ? { requiresSecrets: secrets } : {}) };
}

/**
 * A frontmatter in the spec's form, as Bops writes every SKILL.md: its own fields from the top level moved into
 * metadata as strings (requires-secrets space separated), every metadata value a string, `set` applied on top
 * (a label or a version; null takes one out). Keys that aren't Bops' (license, compatibility, allowed-tools, or
 * anyone's own) stay where they are.
 */
export function toSpecForm(fm: Record<string, unknown>, set: { label?: string | null; version?: string | null } = {}): Record<string, unknown> {
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadataOf(fm))) {
    const s = asString(v);
    if (s !== undefined) meta[k] = s;
  }
  const out: Record<string, unknown> = { ...fm };
  for (const k of Object.keys(META) as (keyof typeof META)[]) {
    const old = out[OLD[k]];
    delete out[OLD[k]];
    if (meta[META[k]] !== undefined || old === undefined || old === null) continue;
    const s = k === "requiresSecrets" ? words(old)?.join(" ") : asString(old);
    if (s) meta[META[k]] = k === "label" ? s.replace(/\s+/g, " ").trim() : s;
  }
  if (set.label !== undefined) {
    if (set.label) meta.label = set.label;
    else delete meta.label;
  }
  if (set.version !== undefined) {
    if (set.version) meta.version = set.version;
    else delete meta.version;
  }
  // Unsorted is no label: never kept as one ("Other", as it was called before, neither).
  if (meta.label !== undefined && isUnsorted(meta.label)) delete meta.label;
  delete out.metadata;
  if (Object.keys(meta).length) out.metadata = meta;
  return out;
}

/** A skill's label as its SKILL.md keeps it: metadata.label (a top level label from before is read too). Undefined when it has none, or says Unsorted or Other. */
export const labelOf = (fm: Record<string, unknown> | null | undefined): string | undefined => keptLabel(specOf(fm).label);

/** Frontmatter in the spec's form with its label kept in metadata.label (Unsorted or empty: none there); unchanged when no label is given. */
export function withLabel(fm: Record<string, unknown>, label: string | undefined): Record<string, unknown> {
  return label === undefined ? fm : toSpecForm(fm, { label: keptLabel(label) ?? null });
}

/** Frontmatter in the spec's form with its version in metadata.version. */
export const withVersion = (fm: Record<string, unknown>, version: string) => toSpecForm(fm, { version });

/** Why a name isn't the spec's (1 to 64 of a to z, 0 to 9 and single hyphens; the folder's own name when one is given), or null. */
export function nameProblem(name: unknown, folder?: string): string | null {
  if (typeof name !== "string" || !name) return "a name is needed";
  if (name.length > NAME_MAX) return `${NAME_MAX} characters at most`;
  if (!SLUG_RE.test(name)) return "lowercase letters, digits and single hyphens only, none at the start or the end";
  if (folder !== undefined && name !== folder) return `must be its folder's name, ${JSON.stringify(folder)}`;
  return null;
}

/**
 * Checks the keys Orgo knows when they're there, in either form, as orgo-web checks a new save: metadata a map,
 * a risk and a runs-on from their lists and vault key names, in metadata or at the top level, and a top level
 * version (the old form, checked as before). Only for what's taken in here (an import, a skill made or changed
 * here): one brought from Orgo is made fit instead (fitFrontmatter), never refused. A metadata.version that isn't
 * a version and a compatibility that isn't the spec's only warn (frontmatterWarnings).
 */
export function validateFrontmatter(fm: Record<string, unknown>): Problem[] {
  const errors: Problem[] = [];
  const bad = (key: string, reason: string) => errors.push({ path: "SKILL.md", reason: `frontmatter ${key}: ${reason}` });
  const meta = metadataOf(fm);
  if (fm.metadata !== undefined && fm.metadata !== null && !isMap(fm.metadata)) bad("metadata", "a map of names to text");
  if (fm.version !== undefined && !(typeof fm.version === "string" && FITS.version(fm.version))) bad("version", "a version such as 1.2.0");
  for (const [k, says] of [["risk", `one of ${RISKS.join(", ")}`], ["runsOn", `one of ${RUNS_ON.join(", ")}`]] as const) {
    if (meta[META[k]] !== undefined && !FITS[k](meta[META[k]])) bad(`metadata.${META[k]}`, says);
    if (fm[OLD[k]] !== undefined && !FITS[k](fm[OLD[k]])) bad(OLD[k], says);
  }
  if (meta[META.requiresSecrets] !== undefined && !FITS.requiresSecrets(meta[META.requiresSecrets])) bad("metadata.requires-secrets", "vault key names separated by spaces (never the values)");
  if (fm.requires_secrets !== undefined && !(Array.isArray(fm.requires_secrets) && FITS.requiresSecrets(fm.requires_secrets))) bad("requires_secrets", "a list of vault key names (never the values)");
  return errors;
}

/**
 * What's taken but not as written, said as a warning: a metadata.version that isn't a version such as 1.2.0 (the
 * spec's own example writes "1.0"; it's numbered when published, as orgo-web does), and a compatibility that
 * isn't the spec's (text, 500 characters at most).
 */
export function frontmatterWarnings(fm: Record<string, unknown>): Problem[] {
  const out: Problem[] = [];
  const v = metadataOf(fm)[META.version];
  if (v !== undefined && !FITS.version(v)) out.push({ path: "SKILL.md", reason: "metadata.version is not a version such as 1.2.0, so the version number is set for you" });
  if (fm.compatibility !== undefined && (typeof fm.compatibility !== "string" || fm.compatibility.length > COMPATIBILITY_MAX)) out.push({ path: "SKILL.md", reason: `compatibility is text of ${COMPATIBILITY_MAX} characters at most` });
  return out;
}

/**
 * A frontmatter kept elsewhere (a version on Orgo) made fit to keep here, so it's never refused for its form, as
 * orgo-web's textMetadata carries a stored version: metadata that isn't a map goes, its values become text, and
 * each of Bops' fields a new save would refuse goes, in either form (an earlier build kept metadata as the
 * author's free text, so a stored one may say risk: high). A metadata.version that isn't a version goes too:
 * the version is the one Orgo numbered. The rest as it is.
 */
export function fitFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fm };
  if (out.metadata !== undefined) {
    if (!isMap(out.metadata)) delete out.metadata;
    else {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(out.metadata)) {
        const s = asString(v);
        if (s !== undefined) meta[k] = s;
      }
      for (const k of Object.keys(META) as (keyof typeof META)[]) if (meta[META[k]] !== undefined && !FITS[k](meta[META[k]])) delete meta[META[k]];
      out.metadata = meta;
    }
  }
  for (const k of Object.keys(OLD) as (keyof typeof OLD)[]) {
    const v = out[OLD[k]];
    if (v === undefined) continue;
    const ok = k === "version" ? typeof v === "string" && FITS.version(v) : k === "requiresSecrets" ? Array.isArray(v) && FITS.requiresSecrets(v) : FITS[k](v);
    if (!ok) delete out[OLD[k]];
  }
  return out;
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

/** A file read from a folder: its text, or null and its bytes in `data` (a binary file); neither for a link out of the folder. */
export type FolderFile = { path: string; content: string | null; data?: Buffer; executable: boolean; size: number; link?: "outside" };

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
 * README.md or SPEC.md. A binary file (a program, an image) is kept as bytes and scanned as orgo-web scans
 * one; an archive or a database, which can't be scanned, is left out like a secret. A secret in SKILL.md
 * itself, a bad path or a cap refuses the whole folder. `strict` (a save, not an import): any secret, or an
 * archive, anywhere, refuses it.
 */
export function checkFolder(input: FolderFile[], opts: { folderName?: string; strict?: boolean } = {}): Checked | { ok: false; errors: Problem[]; skipped: Problem[] } {
  const errors: Problem[] = [];
  const skipped: Problem[] = [];
  const warnings: Problem[] = [];
  const kept = new Map<string, { content: string | null; data?: Buffer; executable: boolean }>();
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
      errors.push({ path: norm.path, reason: `file is over ${mb(BUNDLE_LIMITS.file)}` });
      continue;
    }
    if (f.content === null && !f.data) {
      skipped.push({ path: norm.path, reason: "couldn't be read" });
      continue;
    }
    if (f.content !== null && f.content.includes("\u0000")) {
      skipped.push({ path: norm.path, reason: "binary file read as text" });
      continue;
    }
    kept.set(norm.path, f.content !== null ? { content: f.content, executable: f.executable } : { content: null, data: f.data, executable: f.executable });
  }
  for (const [path, f] of [...kept]) {
    const opaque = f.data ? unscannableBinary(f.data) : null;
    if (opaque || (path === "SKILL.md" && f.content === null)) {
      const why = { path, reason: opaque ?? "SKILL.md must be text" };
      if (opts.strict || path === "SKILL.md") errors.push(why);
      else {
        skipped.push(why);
        kept.delete(path);
      }
      continue;
    }
    const found = scanFile(path, f);
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
    if (kept.has(n) && kept.get(n)!.content !== null) {
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
    .map(([path, f]) => (f.content !== null ? { path, content: f.content, sha256: sha256Hex(f.content), size: byteLength(f.content), executable: f.executable } : { path, content: null, data: f.data, sha256: sha256Hex(f.data!), size: f.data!.length, executable: f.executable }));
  const sum = summarizeDoc(body);
  const fmName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const name = (sum.title?.trim() || fmName || opts.folderName || "").slice(0, 120);
  if (!name) errors.push({ path: "SKILL.md", reason: "a skill needs a name" });
  const description = (typeof frontmatter.description === "string" ? frontmatter.description.trim() : "") || sum.summary || (name ? `${name}.` : "");
  if (description.length > BUNDLE_LIMITS.description) errors.push({ path: "SKILL.md", reason: `description is ${BUNDLE_LIMITS.description} characters at most` });
  if (doc === null) body = `# ${name || "Skill"}\n\nDrafted on import: this folder had no SKILL.md, README.md or SPEC.md.\n\n## Files\n\n${files.map((f) => `- \`${f.path}\`${f.executable ? " (executable)" : ""}${f.content === null ? " (binary)" : ""}`).join("\n")}\n`;
  if (byteLength(body) > BUNDLE_LIMITS.body) errors.push({ path: "SKILL.md", reason: `body is over ${BUNDLE_LIMITS.body / 1024} KB` });
  errors.push(...validateFrontmatter(frontmatter));
  warnings.push(...frontmatterWarnings(frontmatter));
  const total = files.reduce((n, f) => n + f.size, 0) + byteLength(body);
  if (files.length + 1 > BUNDLE_LIMITS.files) errors.push({ path: "", reason: `a skill holds ${BUNDLE_LIMITS.files} files at most` });
  if (total > BUNDLE_LIMITS.total) errors.push({ path: "", reason: `a skill is ${mb(BUNDLE_LIMITS.total)} at most` });
  if (errors.length) return { ok: false, errors, skipped };
  if (body.split("\n").length > 500) warnings.push({ path: "SKILL.md", reason: "body is over 500 lines; move long tables to references/" });
  for (const f of files) if (f.content !== null && /StrictHostKeyChecking\s*=?\s*no/.test(f.content)) warnings.push({ path: f.path, reason: "turns off SSH host key checking" });
  const declared = specOf(frontmatter).requiresSecrets ?? [];
  warnings.push(...undeclaredSecrets([{ path: "SKILL.md", content: body }, ...files], declared));
  const slugBase = fmName && SLUG_RE.test(fmName) && fmName.length <= BUNDLE_LIMITS.slug ? fmName : slugify(fmName || name);
  return { ok: true, name, slugBase, description, frontmatter, body, files, skipped, warnings, drafted };
}

/**
 * A bundle's hash, as orgo-web hashes it (bundle_sha256): sha256 over "path NUL sha256 NUL x|- LF" for every
 * file sorted by path (x when executable), SKILL.md included, each file's sha256 over its bytes.
 */
export function bundleSha(skillMd: string, files: { path: string; sha256: string; executable?: boolean }[]): string {
  const entries = [{ path: "SKILL.md", sha256: sha256Hex(skillMd), executable: false }, ...files.map((f) => ({ path: f.path, sha256: f.sha256, executable: !!f.executable }))].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(entries.map((e) => `${e.path}\u0000${e.sha256}\u0000${e.executable ? "x" : "-"}\n`).join(""));
}

/** The hash versions published before bundleSha matched orgo-web's had ("path NUL sha256 LF"): kept so "nothing changed" still knows them. */
export function legacyBundleSha(skillMd: string, files: { path: string; sha256: string }[]): string {
  const entries = [{ path: "SKILL.md", sha256: sha256Hex(skillMd) }, ...files.map((f) => ({ path: f.path, sha256: f.sha256 }))].sort((a, b) => (a.path < b.path ? -1 : 1));
  return sha256Hex(entries.map((e) => `${e.path}\u0000${e.sha256}\n`).join(""));
}

/** Whether a file is a script or a program someone has to approve before it runs: executable, under scripts/, or one with a #! line. */
export const isScript = (f: { path: string; content: string | null; data?: Buffer; executable: boolean }) =>
  f.executable || f.path.startsWith("scripts/") || (f.content !== null ? f.content.startsWith("#!") : f.data?.subarray(0, 2).toString("latin1") === "#!");

/** The next patch after the highest version (0.1.0 when there's none). */
export function nextVersion(versions: string[]): string {
  const parse = (v: string) => SEMVER_RE.exec(v)?.slice(1, 4).map(Number) as [number, number, number] | undefined;
  const all = versions.map(parse).filter((x): x is [number, number, number] => !!x);
  if (!all.length) return "0.1.0";
  all.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [a, b, c] = all[all.length - 1];
  return `${a}.${b}.${c + 1}`;
}
