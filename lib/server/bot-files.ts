import "server-only";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";
import { cleanFileName, FILE_MAX, type AddedFile } from "../added-files";
import type { Bot } from "../types";
import { computerOutOfCredit, freeHoursUsed } from "./free-hours";
import { apiKey, callOrgo, orgo } from "./orgo";
import { workComputer } from "./screens";
import { getState, id } from "./store";

/**
 * Files the user adds for a bot (lib/added-files.ts), put on the Desktop of the computer it works on through Orgo's
 * file uploads, the way the runner's bundle goes (runner-install.ts upload):
 * 1. The computer is woken, and the file's name is claimed on its Desktop: the first one free (report (2).pdf), as
 *    an empty file, so nothing there is ever replaced and two files of one name both arrive.
 * 2. A link to put it at (POST /api/files/uploads, which fixes that name).
 * 3. The bytes straight there as they arrive, never all of a big file in memory. (The Mac app's server lets a
 *    request take as long as it needs for this: desktop/main.cjs.)
 * 4. Orgo has the computer fetch it into place (/complete), the computer touched again first after a long upload.
 * Nothing of the link or its token is ever kept or shown. A bot that works on this Mac gets none: what it runs
 * there can't open them.
 */

/** Added ones, by id, for the message they go with (that message names them by id: nothing else is taken). */
const g = globalThis as { __bopsAddedFiles?: Map<string, AddedFile & { at: number }>; /** Tests' stand-in for storage. */ __bopsFilePut?: typeof putTo };
const added = (g.__bopsAddedFiles ??= new Map());
const KEEP_MS = 24 * 3600_000;

export const addedFile = (fileId: string): AddedFile | undefined => {
  const f = added.get(fileId);
  return f && { id: f.id, name: f.name, size: f.size, path: f.path, botId: f.botId, hostId: f.hostId, hostName: f.hostName };
};

/** Why a file couldn't be added, in words for the user. */
export class AddFileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * The computer `b`'s files go on: its own, or the main bot's when it shares that one. Or why there's none: Bops runs
 * on this Mac, the bot is set to work on the Mac (unless the file was dropped on that computer's own screen), or it
 * has no computer yet.
 */
export function filesGoTo(b: Bot, { screen = false } = {}): { computerId: string; host: Bot } | { why: string } {
  if (getState().host === "mac") return { why: "Your bots work on this Mac here, so there's no computer to put files on. Pictures still work." };
  if (b.runsOn === "mac" && !screen) return { why: `${b.name} works on your Mac, where added files can't be opened yet. Pictures still work.` };
  const host = workComputer(b);
  return host.computerId ? { computerId: host.computerId, host } : { why: `${b.name} has no computer yet.` };
}

/** Counts what goes through, and fails the stream once more than `size` bytes arrive. */
function counter(size: number) {
  let n = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length;
      if (n > size) return done(new AddFileError("The file was bigger than it said."));
      done(null, chunk);
    },
  });
  return { t, count: () => n };
}

/** PUT the stream to a signed storage link with its length (storage takes no chunked upload). Whether it took it. */
function putTo(url: string, body: Readable, size: number): Promise<boolean> {
  return new Promise((resolve) => {
    const { t, count } = counter(size);
    const req = httpsRequest(url, { method: "PUT", headers: { "Content-Length": String(size) }, timeout: 30 * 60_000 }, (res) => {
      res.resume();
      resolve(count() === size && (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => req.destroy());
    body.on("error", () => req.destroy());
    t.on("error", () => req.destroy());
    t.on("end", () => count() !== size && req.destroy());
    body.pipe(t).pipe(req);
  });
}

/** A shell word for `s`, single quoted. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A name's stem and extension, for " (n)" before the extension: report (2).pdf. */
function parts(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 16 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}

/**
 * The script that claims `name` on the Desktop: the first of name, "stem (2).ext", … not there yet, made as an empty
 * file in one step (noclobber), so a second upload of the same name at once takes the next. Prints it between markers.
 */
export function claimScript(name: string): string {
  const { stem, ext } = parts(name);
  return [
    `d="$HOME/Desktop"; mkdir -p "$d" || exit 3`,
    `set -C; n=${sh(name)}; i=2`,
    `until { : > "$d/$n"; } 2>/dev/null; do [ "$i" -gt 500 ] && exit 4; n=${sh(stem)}" ($i)"${sh(ext)}; i=$((i+1)); done`,
    `printf '__BOPS_NAME__%s__BOPS_END__' "$n"`,
  ].join("\n");
}

/** The empty file a claim left, taken away again when the upload didn't come (never a file with anything in it). */
const unclaim = (computerId: string, name: string) =>
  orgo.bash(computerId, `f="$HOME/Desktop/"${sh(name)}; [ -f "$f" ] && [ ! -s "$f" ] && rm -f "$f"; true`, 30).catch(() => {});

/** Why the computer didn't wake, as the user should hear it (no hours or credit left), else that it didn't. */
const notAwake = (e: unknown, host: Bot) => {
  const why = freeHoursUsed(e) ?? computerOutOfCredit(e);
  return why ? new AddFileError(why, 402) : new AddFileError(`${host.name}'s computer didn't wake up. Try again.`, 503);
};

/** An upload longer than this touches the computer again before it's put in place (it may have gone to sleep). */
const TOUCH_AFTER_MS = 60_000;

/**
 * Add a file for bot `b`: `size` bytes from `body`, named `rawName`. `screen`: dropped on its computer's screen,
 * which puts it on that computer even for a bot set to work on the Mac. Answers what was added (the message names
 * it by its id), or throws an AddFileError saying why not.
 */
export async function addFile(b: Bot, rawName: string, size: number, body: ReadableStream<Uint8Array>, { screen = false } = {}): Promise<AddedFile> {
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const refuse = (e: AddFileError) => {
    stream.destroy();
    return e;
  };
  const clean = cleanFileName(rawName);
  if (!clean) throw refuse(new AddFileError("That file needs a name."));
  if (!Number.isSafeInteger(size) || size <= 0) throw refuse(new AddFileError("That file is empty."));
  if (size > FILE_MAX) throw refuse(new AddFileError("That file is too big. 2 GB at most.", 413));
  const to = filesGoTo(b, { screen });
  if ("why" in to) throw refuse(new AddFileError(to.why, 409));
  let key: string;
  try {
    key = await apiKey();
  } catch {
    throw refuse(new AddFileError("Sign in to Orgo first.", 409));
  }
  // Woken (an action waits while it wakes), and its name claimed, before anything goes: a computer out of hours or
  // credit says so at once, not after the whole upload.
  let claimed: string;
  try {
    const out = await orgo.bash(to.computerId, claimScript(clean), 60);
    const m = /__BOPS_NAME__([\s\S]*?)__BOPS_END__/.exec(out.output);
    if (!m || out.exit_code !== 0) throw new AddFileError(`There's no room for it on ${to.host.name}'s Desktop.`, 502);
    claimed = m[1];
  } catch (e) {
    throw refuse(e instanceof AddFileError ? e : notAwake(e, to.host));
  }
  const fail = async (e: AddFileError) => {
    stream.destroy();
    await unclaim(to.computerId, claimed);
    return e;
  };
  const start = await callOrgo<{ upload_url?: unknown; upload_token?: unknown; error?: unknown }>(key, "/api/files/uploads", {
    method: "POST",
    body: { desktopId: to.computerId, filename: claimed, size_bytes: size },
    timeoutMs: 30_000,
  });
  const url = typeof start?.json.upload_url === "string" ? start.json.upload_url : "";
  const token = typeof start?.json.upload_token === "string" ? start.json.upload_token : "";
  if (start?.status !== 200 || !url.startsWith("https://") || !token) {
    const said = typeof start?.json.error === "string" ? ` Orgo said: ${start.json.error}` : "";
    throw await fail(new AddFileError(`Orgo didn't take the file.${said}`, 502));
  }
  const began = Date.now();
  if (!(await (g.__bopsFilePut ?? putTo)(url, stream, size))) throw await fail(new AddFileError("The file didn't upload. Try again.", 502));
  if (Date.now() - began > TOUCH_AFTER_MS)
    try {
      await orgo.bash(to.computerId, "true", 60);
    } catch (e) {
      throw await fail(notAwake(e, to.host));
    }
  const done = await callOrgo<{ error?: unknown }>(key, "/api/files/uploads/complete", { method: "POST", body: { desktopId: to.computerId, upload_token: token }, timeoutMs: 320_000 });
  if (done?.status !== 200) {
    const said = typeof done?.json.error === "string" ? ` Orgo said: ${done.json.error}` : "";
    throw await fail(new AddFileError(`The file didn't reach ${to.host.name}'s computer.${said}`, 502));
  }
  const file: AddedFile = { id: id("file"), name: claimed, size, path: `~/Desktop/${claimed}`, botId: b.id, hostId: to.host.id, hostName: to.host.name };
  const now = Date.now();
  for (const [k, v] of added) if (now - v.at > KEEP_MS) added.delete(k);
  added.set(file.id, { ...file, at: now });
  return file;
}
