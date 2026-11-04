import "server-only";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";
import type { MemberFileTarget } from "@/cloud/protocol";
import { cleanFileName, FILE_MAX, type AddedFile } from "../added-files";
import type { Bot } from "../types";
import { computerOutOfCredit, freeHoursUsed } from "./free-hours";
import { apiKey, callOrgo, orgo, type OrgoError } from "./orgo";
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
 * there can't open them. In a workspace shared with the user, the computer is the owner's, as Bops Cloud names it for
 * someone who may use it (lib/server/shared.ts sharedFileTarget: sharedTarget), never the user's own bot's of that id,
 * and the same steps go with the user's own Orgo key, which Orgo checks too: what it refuses is said plainly (orgoNo).
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

/** Where a file goes: the computer, the bot it's for, and the bot whose computer that is (its own, or the main bot's). */
export type FileTarget = MemberFileTarget;

/** Bops Cloud's words when it doesn't name a computer for a shared workspace's bot (sharedTarget), by what it said. */
const CLOUD_OLD = "Teammates can't add files here until Bops Cloud updates.";

/**
 * The computer a file for a bot of the workspace shared with the user goes on, from what Bops Cloud answered
 * (POST /v1/ws/<project>/files: lib/server/shared.ts sharedFileTarget), or an AddFileError with its words: not theirs
 * to add (no Write, no Use its computer, a drop on a screen they aren't shown), the owner's Bops too old, no computer,
 * or one that won't wake. A Bops Cloud from before has no such route ("Not found"), which says so.
 */
export function sharedTarget(got: { status: number; json: Record<string, unknown> } | null): FileTarget {
  if (!got) throw new AddFileError("Couldn't reach Bops Cloud. Try again.", 502);
  const j = got.json;
  const said = typeof j.error === "string" && j.error.trim() ? j.error.trim() : "";
  if (got.status === 200) {
    const ok = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v);
    if (ok(j.computerId) && ok(j.botId) && ok(j.hostId) && typeof j.hostName === "string" && j.hostName.trim())
      return { computerId: j.computerId, botId: j.botId, hostId: j.hostId, hostName: j.hostName.trim().slice(0, 120) };
    throw new AddFileError("The file couldn't be added. Try again.", 502);
  }
  if (got.status === 404 && said === "Not found") throw new AddFileError(CLOUD_OLD, 409);
  if (got.status === 404) throw new AddFileError("That bot isn't in this workspace anymore.", 404);
  throw new AddFileError(said || "The file couldn't be added. Try again.", got.status >= 400 && got.status < 500 ? got.status : 502);
}

/**
 * Orgo turning a file down (its uploads, or the command on the computer first), said plainly, or null for Orgo's own
 * words: the owner keeping the user off this computer (bops_owner_only), a key for another workspace, a locked
 * computer, and in a shared workspace Orgo letting only its owner and Admins add files (its own "Access denied").
 */
function orgoNo(status: number, code: string | undefined, hostName: string, shared: boolean): AddFileError | null {
  if (code === "bops_owner_only") return new AddFileError("The owner hasn't let you use this computer, so files can't go on it.", 403);
  if (code === "workspace_scope_mismatch") return new AddFileError("Your Orgo key only works in another workspace. Sign in to Orgo again in Bops.", 403);
  if (status === 402) return new AddFileError(`${hostName}'s computer is locked on Orgo right now, so files can't go on it.${shared ? " The owner can unlock it on Orgo." : " Check your plan on Orgo."}`, 402);
  if (status === 403 && shared) return new AddFileError("Orgo lets only the owner and Admins of this workspace add files to its computers.", 403);
  return null;
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

/** The code an Orgo answer says, when it says one. */
const codeOf = (json: unknown) => (json && typeof (json as { code?: unknown }).code === "string" ? (json as { code: string }).code : undefined);

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

/** An error Orgo answered with (lib/server/orgo.ts OrgoError), by its shape: its status, and its code when it said one. */
const fromOrgo = (e: unknown): Pick<OrgoError, "status" | "code"> | null =>
  e instanceof Error && typeof (e as Partial<OrgoError>).status === "number" ? { status: (e as OrgoError).status, code: (e as OrgoError).code } : null;

/**
 * Why the computer didn't wake or take the command, as the user should hear it: no hours or credit left (the user's
 * own computer: a shared one's owner's credit is never the user's, so their own Bops isn't told it ran out), Orgo
 * refusing it (orgoNo), else that it didn't wake.
 */
const notAwake = (e: unknown, hostName: string, shared: boolean) => {
  const why = shared ? undefined : (freeHoursUsed(e) ?? computerOutOfCredit(e));
  if (why) return new AddFileError(why, 402);
  const o = fromOrgo(e);
  return (o && orgoNo(o.status, o.code, hostName, shared)) ?? new AddFileError(`${hostName}'s computer didn't wake up. Try again.`, 503);
};

/** An upload longer than this touches the computer again before it's put in place (it may have gone to sleep). */
const TOUCH_AFTER_MS = 60_000;

/**
 * Add a file for bot `b` of the user's own workspace: `size` bytes from `body`, named `rawName`. `screen`: dropped on
 * its computer's screen, which puts it on that computer even for a bot set to work on the Mac. Answers what was added
 * (the message names it by its id), or throws an AddFileError saying why not.
 */
export function addFile(b: Bot, rawName: string, size: number, body: ReadableStream<Uint8Array>, { screen = false } = {}): Promise<AddedFile> {
  return addFileTo(rawName, size, body, async () => {
    const to = filesGoTo(b, { screen });
    if ("why" in to) throw new AddFileError(to.why, 409);
    return { computerId: to.computerId, botId: b.id, hostId: to.host.id, hostName: to.host.name };
  });
}

/**
 * Add a file at the computer `where` names (asked once the file's name and size are fine; it throws an AddFileError to
 * refuse): `size` bytes from `body`, named `rawName`. `shared`: that computer is the owner's, in a workspace shared with
 * the user (sharedTarget), so Orgo's refusals are said as theirs and nothing of the user's own billing is touched.
 * Answers what was added, or throws an AddFileError saying why not.
 */
export async function addFileTo(rawName: string, size: number, body: ReadableStream<Uint8Array>, where: () => Promise<FileTarget>, { shared = false } = {}): Promise<AddedFile> {
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const refuse = (e: AddFileError) => {
    stream.destroy();
    return e;
  };
  const clean = cleanFileName(rawName);
  if (!clean) throw refuse(new AddFileError("That file needs a name."));
  if (!Number.isSafeInteger(size) || size <= 0) throw refuse(new AddFileError("That file is empty."));
  if (size > FILE_MAX) throw refuse(new AddFileError("That file is too big. 2 GB at most.", 413));
  let to: FileTarget;
  try {
    to = await where();
  } catch (e) {
    throw refuse(e instanceof AddFileError ? e : new AddFileError("The file couldn't be added. Try again.", 502));
  }
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
    if (!m || out.exit_code !== 0) throw new AddFileError(`There's no room for it on ${to.hostName}'s Desktop.`, 502);
    claimed = m[1];
  } catch (e) {
    throw refuse(e instanceof AddFileError ? e : notAwake(e, to.hostName, shared));
  }
  const fail = async (e: AddFileError) => {
    stream.destroy();
    await unclaim(to.computerId, claimed);
    return e;
  };
  const start = await callOrgo<{ upload_url?: unknown; upload_token?: unknown; error?: unknown; code?: unknown }>(key, "/api/files/uploads", {
    method: "POST",
    body: { desktopId: to.computerId, filename: claimed, size_bytes: size },
    timeoutMs: 30_000,
  });
  const url = typeof start?.json.upload_url === "string" ? start.json.upload_url : "";
  const token = typeof start?.json.upload_token === "string" ? start.json.upload_token : "";
  if (start?.status !== 200 || !url.startsWith("https://") || !token) {
    const plain = start && start.status !== 200 ? orgoNo(start.status, codeOf(start.json), to.hostName, shared) : null;
    const said = typeof start?.json.error === "string" ? ` Orgo said: ${start.json.error}` : "";
    throw await fail(plain ?? new AddFileError(`Orgo didn't take the file.${said}`, 502));
  }
  const began = Date.now();
  if (!(await (g.__bopsFilePut ?? putTo)(url, stream, size))) throw await fail(new AddFileError("The file didn't upload. Try again.", 502));
  if (Date.now() - began > TOUCH_AFTER_MS)
    try {
      await orgo.bash(to.computerId, "true", 60);
    } catch (e) {
      throw await fail(notAwake(e, to.hostName, shared));
    }
  const done = await callOrgo<{ error?: unknown; code?: unknown }>(key, "/api/files/uploads/complete", { method: "POST", body: { desktopId: to.computerId, upload_token: token }, timeoutMs: 320_000 });
  if (done?.status !== 200) {
    const plain = done ? orgoNo(done.status, codeOf(done.json), to.hostName, shared) : null;
    const said = typeof done?.json.error === "string" ? ` Orgo said: ${done.json.error}` : "";
    throw await fail(plain ?? new AddFileError(`The file didn't reach ${to.hostName}'s computer.${said}`, 502));
  }
  const file: AddedFile = { id: id("file"), name: claimed, size, path: `~/Desktop/${claimed}`, botId: to.botId, hostId: to.hostId, hostName: to.hostName };
  const now = Date.now();
  for (const [k, v] of added) if (now - v.at > KEEP_MS) added.delete(k);
  added.set(file.id, { ...file, at: now });
  return file;
}
