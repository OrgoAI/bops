import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, posix } from "node:path";
import { fullAccessOn } from "./full-access";
import { taskDir } from "./local";
import { orgo } from "./orgo";
import { onPostgres } from "./persist";
import { workComputer } from "./screens";
import { bot, getState, userDir } from "./store";

/**
 * Files bots link in their answers ([report](/workspace/report.md)): written on the bot's Orgo computer,
 * or on this Mac in the bot's own task folder (or, with Full access, the user's own folders). Neither is a
 * URL the user's browser can open, so when they click one, Bops copies it here (.data/users/<id>/files)
 * under an unguessable id and opens /api/files/<id> in a tab. Copies, not live: clicking again fetches it
 * fresh, and copies go after a day.
 */
export const filesDir = () => {
  const dir = userDir();
  return dir ? join(dir, "files") : null;
};
const MAX_BYTES = 25 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60_000;

/** How each kind of file is served. Anything not here downloads. */
const TYPES: Record<string, string> = {
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".tsv": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Whether this bot linked `href` in the chat or one of its threads: a file on this Mac opens only then. */
function linkedBy(botId: string, href: string) {
  const s = getState();
  const has = (t?: string) => !!t?.includes(`](${href})`);
  return s.messages.some((m) => m.botId === botId && has(m.text)) || s.sessions.some((x) => x.botId === botId && (has(x.answer) || x.replies.some((r) => r.role === "bot" && has(r.text))));
}

/** The file's bytes: off the bot's computer (base64 over Orgo's shell), or off this Mac. Throws a sentence for the user. */
async function fetchFile(botId: string, href: string): Promise<Buffer> {
  const b = bot(botId);
  if (!b) throw new Error("That bot is gone.");
  if (href.startsWith("/workspace/")) {
    const path = posix.normalize(href);
    if (!path.startsWith("/workspace/")) throw new Error("That isn't a file in the bot's workspace.");
    const computerId = getState().host === "mac" ? null : workComputer(b).computerId;
    if (!computerId) throw new Error("That file was in a task's scratch folder on your Mac, which is gone now.");
    const q = `'${path.replace(/'/g, `'\\''`)}'`;
    const r = await orgo.bash(computerId, `test -f ${q} || { echo missing; exit 3; }; s=$(stat -c %s ${q}); [ "$s" -le ${MAX_BYTES} ] || { echo big; exit 4; }; base64 -w0 ${q}`, 60);
    if (r.exit_code === 3) throw new Error(`${basename(path)} isn't on ${b.name}'s computer anymore.`);
    if (r.exit_code === 4) throw new Error(`${basename(path)} is too big to open here (25 MB at most).`);
    if (r.exit_code !== 0) throw new Error(`Couldn't get ${basename(path)} from ${b.name}'s computer.`);
    return Buffer.from(r.output.trim(), "base64");
  }
  // On this Mac: only the app on it reads its files, only ones the bot linked, and only where that bot can
  // write: its own Mac tasks' folders, or the user's home folder when Full access is on (MacState.fullAccess),
  // as its executor can (executor-sandbox.ts). A bot writes its own answers, so its link alone proves nothing.
  if (onPostgres()) throw new Error("That file is on a Mac, so it opens in Bops on that Mac.");
  if (!linkedBy(botId, href)) throw new Error("Bops only opens files a bot linked.");
  const raw = href.startsWith("file://") ? decodeURIComponent(href.slice(7)) : href.startsWith("~/") ? join(homedir(), href.slice(2)) : href;
  // Checked where it really is: a link (a symlink the task made) can't lead out of those folders.
  const real = realOrNull(posix.normalize(raw));
  if (!real || !statSync(/*turbopackIgnore: true*/ real).isFile()) throw new Error(`${basename(raw)} isn't there anymore.`);
  const full = fullAccessOn();
  const roots = [...(full ? [homedir()] : []), ...getState().sessions.filter((s) => s.botId === botId && s.runsOn === "mac").map((s) => taskDir(s.id))]
    .map(realOrNull)
    .filter((r): r is string => !!r);
  if (!roots.some((r) => real.startsWith(`${r}/`)))
    throw new Error(full ? "Bops only opens files in your home folder." : "Bops opens files on your Mac only from the bot's own task folder, unless Full access is on.");
  if (statSync(/*turbopackIgnore: true*/ real).size > MAX_BYTES) throw new Error(`${basename(real)} is too big to open here (25 MB at most).`);
  return readFileSync(/*turbopackIgnore: true*/ real);
}

/** Where a path really is (its links followed), or null when it isn't there. */
function realOrNull(path: string) {
  try {
    return realpathSync(/*turbopackIgnore: true*/ path);
  } catch {
    return null;
  }
}

/** Copy a file a bot linked to where the user can open it. Returns the URL that serves it. */
export async function openFile(botId: string, href: string) {
  const DIR = filesDir();
  if (!DIR) throw new Error("Sign in to Bops first.");
  const bytes = await fetchFile(botId, href);
  mkdirSync(DIR, { recursive: true });
  // Copies made more than a day ago go: they're for opening now, not a second home for the user's files.
  for (const f of readdirSync(DIR))
    if (/^file_[a-f0-9]{32}__/.test(f) && Date.now() - statSync(/*turbopackIgnore: true*/ join(DIR, f)).mtimeMs > KEEP_MS) rmSync(/*turbopackIgnore: true*/ join(DIR, f), { force: true });
  const fileId = `file_${randomBytes(16).toString("hex")}`;
  // The name keeps its extension, which says how it's served.
  const name = basename(href).replace(/[^\w.-]+/g, "-").slice(-120) || "file";
  writeFileSync(join(/*turbopackIgnore: true*/ DIR, `${fileId}__${name}`), bytes);
  return { url: `/api/files/${fileId}` };
}

/** A copied file by id: its bytes, name and how to serve it. */
export function readFile(fileId: string) {
  const DIR = filesDir();
  if (!DIR || !/^file_[a-f0-9]{32}$/.test(fileId) || !existsSync(DIR)) return null;
  const entry = readdirSync(DIR).find((f) => f.startsWith(`${fileId}__`));
  if (!entry) return null;
  const name = entry.slice(fileId.length + 2);
  return { bytes: readFileSync(join(/*turbopackIgnore: true*/ DIR, entry)), name, type: TYPES[extname(name).toLowerCase()] ?? null };
}
