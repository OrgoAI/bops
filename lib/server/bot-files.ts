import "server-only";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cleanFileName, FILE_MAX, type AddedFile } from "../added-files";
import type { Bot } from "../types";
import { apiKey, callOrgo, orgo } from "./orgo";
import { workComputer } from "./screens";
import { getState, id } from "./store";
import { uploadsDir } from "./uploads";

/**
 * Files the user adds for a bot (lib/added-files.ts). On a computer: Orgo's file uploads, the way the runner's
 * bundle goes (runner-install.ts upload): a link to put it at, the bytes straight there as they arrive (never all
 * of a big file in memory), then Orgo has the computer fetch it onto its Desktop. A bot that works on this Mac gets
 * it in the signed-in user's folder here (.data/users/<id>/uploads/files). Nothing of the link or its token is
 * ever kept or shown.
 */

/** Added ones, by id, for the message they go with (that message names them by id: nothing else is taken). */
const g = globalThis as { __bopsAddedFiles?: Map<string, AddedFile & { at: number }>; /** Tests' stand-in for storage. */ __bopsFilePut?: typeof putTo };
const added = (g.__bopsAddedFiles ??= new Map());
const KEEP_MS = 24 * 3600_000;

export const addedFile = (fileId: string): AddedFile | undefined => {
  const f = added.get(fileId);
  return f && { id: f.id, name: f.name, size: f.size, where: f.where, path: f.path, botId: f.botId };
};

/** Why a file couldn't be added, in words for the user. */
export class AddFileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Where `b` gets its files: its computer (the main bot's, when it shares), or this Mac. */
export function filesGoTo(b: Bot): { where: "computer"; computerId: string; host: Bot } | { where: "mac" } | null {
  const state = getState();
  if (state.host === "mac" || b.runsOn === "mac") return { where: "mac" };
  const host = workComputer(b);
  return host.computerId ? { where: "computer", computerId: host.computerId, host } : null;
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

/**
 * Add a file for bot `b`: `size` bytes from `body`, named `rawName`. Answers what was added (the message names it
 * by its id), or throws an AddFileError saying why not.
 */
export async function addFile(b: Bot, rawName: string, size: number, body: ReadableStream<Uint8Array>): Promise<AddedFile> {
  const name = cleanFileName(rawName);
  if (!name) throw new AddFileError("That file needs a name.");
  if (!Number.isSafeInteger(size) || size <= 0) throw new AddFileError("That file is empty.");
  if (size > FILE_MAX) throw new AddFileError("That file is too big. 2 GB at most.", 413);
  const to = filesGoTo(b);
  if (!to) throw new AddFileError(`${b.name} has no computer yet.`, 409);
  const fileId = id("file");
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  let file: AddedFile;
  if (to.where === "mac") {
    const root = uploadsDir();
    if (!root) throw new AddFileError("Sign in to Bops first.", 409);
    const dir = join(/*turbopackIgnore: true*/ root, "files", fileId);
    mkdirSync(dir, { recursive: true });
    const path = join(/*turbopackIgnore: true*/ dir, name);
    const { t, count } = counter(size);
    try {
      await pipeline(stream, t, createWriteStream(/*turbopackIgnore: true*/ path));
    } catch (e) {
      rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
      throw e instanceof AddFileError ? e : new AddFileError("The file didn't arrive whole. Try again.");
    }
    if (count() !== size) {
      rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
      throw new AddFileError("The file didn't arrive whole. Try again.");
    }
    file = { id: fileId, name, size, where: "mac", path, botId: b.id };
  } else {
    let key: string;
    try {
      key = await apiKey();
    } catch {
      throw new AddFileError("Sign in to Orgo first.", 409);
    }
    // The computer has to be up to take it: woken now (an action waits while it wakes), while the bytes go up.
    const awake = orgo.bash(to.computerId, 'mkdir -p "$HOME/Desktop"', 60).then(
      () => true,
      () => false,
    );
    const start = await callOrgo<{ upload_url?: unknown; upload_token?: unknown; error?: unknown }>(key, "/api/files/uploads", {
      method: "POST",
      body: { desktopId: to.computerId, filename: name, size_bytes: size },
      timeoutMs: 30_000,
    });
    const url = typeof start?.json.upload_url === "string" ? start.json.upload_url : "";
    const token = typeof start?.json.upload_token === "string" ? start.json.upload_token : "";
    if (start?.status !== 200 || !url.startsWith("https://") || !token) {
      stream.destroy();
      const said = typeof start?.json.error === "string" ? ` Orgo said: ${start.json.error}` : "";
      throw new AddFileError(`Orgo didn't take the file.${said}`, 502);
    }
    if (!(await (g.__bopsFilePut ?? putTo)(url, stream, size))) throw new AddFileError("The file didn't upload. Try again.", 502);
    if (!(await awake)) throw new AddFileError(`${to.host.name}'s computer didn't wake up. Try again.`, 503);
    const done = await callOrgo<{ error?: unknown }>(key, "/api/files/uploads/complete", { method: "POST", body: { desktopId: to.computerId, upload_token: token }, timeoutMs: 320_000 });
    if (done?.status !== 200) {
      const said = typeof done?.json.error === "string" ? ` Orgo said: ${done.json.error}` : "";
      throw new AddFileError(`The file didn't reach ${to.host.name}'s computer.${said}`, 502);
    }
    file = { id: fileId, name, size, where: "computer", path: `~/Desktop/${name}`, botId: b.id };
  }
  const now = Date.now();
  for (const [k, v] of added) if (now - v.at > KEEP_MS) added.delete(k);
  added.set(fileId, { ...file, at: now });
  return file;
}
