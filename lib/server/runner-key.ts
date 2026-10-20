import "server-only";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A computer's own Orgo key, which its Bops runner signs in with (orgo-auth.ts loadOrgoKey on a runner).
 * Orgo makes it for that computer alone and writes it there as ORGO_API_KEY: when the computer is made
 * from a template that asks for it (bops-base 0.1.9 on: metal writes `export ORGO_API_KEY='…'` into
 * /root/.env), or when the Mac sets a runner up on a computer without it (PUT orgo-web
 * /api/computers/{id}/orgo-key, which writes /root/.orgo-secrets.env, 0600, sourced by /root/.env, and
 * takes the line made with the computer out of /root/.env). Orgo may write it again later (a restore in
 * place, a copy's own key), so it's read from the files, never kept in a setting of the runner's: the
 * first file that has it wins, as orgo-web lib/computer-orgo-key.ts says a program should read them.
 * Never logged.
 */
export const ORGO_KEY_FILES = ["/root/.orgo-secrets.env", "/root/.env"] as const;
export const ORGO_KEY_NAME = "ORGO_API_KEY";

/**
 * A line in those files that sets a non-empty ORGO_API_KEY, as extended grep reads it (the Mac's probe,
 * runner-install.ts, asks only whether one is there and never prints it).
 */
export const ORGO_KEY_LINE = `^[[:space:]]*(export[[:space:]]+)?${ORGO_KEY_NAME}=['"]?[^'"[:space:]]`;

/**
 * One shell word, as the files have it: single quotes (taken as they are), double quotes, a backslash,
 * and plain characters, joined until a space or `;`. Orgo writes shlex.quote's form (`'a'"'"'b'`) and
 * metal its own (`'a'\''b'`); both read back as the value. Null for what a shell would expand ($, `)
 * or a quote left open: not a value Orgo wrote.
 */
function shellWord(s: string): string | null {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === " " || c === "\t" || c === ";") break;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length && '$`"\\'.includes(s[j + 1])) out += s[++j];
        else if (s[j] === "$" || s[j] === "`") return null;
        else out += s[j];
      }
      if (j >= s.length) return null;
      i = j + 1;
    } else if (c === "\\") {
      out += s[i + 1] ?? "";
      i += 2;
    } else if (c === "$" || c === "`") return null;
    else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The ORGO_API_KEY a file's lines set (`export ` or not, quoted as a shell would read it), the last one as in a shell; null when none, or it's empty. */
export function orgoKeyIn(text: string): string | null {
  const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${ORGO_KEY_NAME}=(.*)$`);
  let found: string | null = null;
  for (const l of text.split(/\r?\n/)) {
    const m = line.exec(l);
    if (m) found = shellWord(m[1]);
  }
  return found || null;
}

/**
 * Whether no one but this runner's own user (root, on its computer) can read `file`: a plain file of that
 * user's (never a link), with no read for its group or others, or in a folder of that user's nobody else
 * may enter (/root is 0700).
 */
async function onlyOurs(file: string): Promise<boolean> {
  const uid = process.getuid?.();
  const st = await lstat(file);
  if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return false;
  if ((st.mode & 0o044) === 0) return true;
  const dir = await lstat(dirname(file));
  return dir.isDirectory() && (uid === undefined || dir.uid === uid) && (dir.mode & 0o077) === 0;
}

const g = globalThis as unknown as { __bopsOrgoKeyFiles?: readonly string[] };

/**
 * The computer's Orgo key, from the first of ORGO_KEY_FILES that sets it, when that file is ours alone
 * (onlyOurs); else none. A file others could read isn't used, and nothing of the key is ever logged.
 */
export async function readRunnerKey(): Promise<string | null> {
  return (await readRunnerKeyFile())?.key ?? null;
}

/** The same, with the file it's in (for the runner's log: orgo-auth.ts says which file has a key that isn't the computer's own). */
export async function readRunnerKeyFile(): Promise<{ key: string; file: string } | null> {
  for (const file of g.__bopsOrgoKeyFiles ?? ORGO_KEY_FILES) {
    let key: string | null;
    try {
      key = orgoKeyIn(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!key) continue;
    if (await onlyOurs(file).catch(() => false)) return { key, file };
    console.warn(`[runner] ${file} can be read by others: its ${ORGO_KEY_NAME} isn't used`);
    return null;
  }
  return null;
}

/**
 * What the runner signs in with now (identity, key or none), one word, written by it at each change
 * (orgo-auth.ts takeUp), root's alone: the Mac's look reads it (runner-install.ts AUTH_LINE), as its log's
 * `[runner] auth:` line may have rotated away.
 */
export const RUNNER_AUTH_FILE = "/opt/bops/runner/auth";

/** Tests: read these files instead (undefined: the computer's own). */
export const runnerKeyForTests = { files: (files?: readonly string[]) => void (g.__bopsOrgoKeyFiles = files) };
