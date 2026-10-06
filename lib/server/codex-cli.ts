import "server-only";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/**
 * The Codex CLI that Bops drives on the user's Mac (lib/server/codex.ts). Bops uses the user's own
 * when they have one (on PATH, or where Codex's installers put it). Without one it installs it by
 * itself, in the background, the way routing through this Mac just turns on: OpenAI's latest release
 * from GitHub (openai/codex), built for this Mac's chip, checked against the SHA-256 digest GitHub
 * lists for the file, into Bops' own folder (~/Library/Application Support/Bops/bin). Signing in and
 * Codex's Computer Use stay the user's to do (the setup card, components/app/setup.tsx).
 */

const RELEASE = "https://api.github.com/repos/openai/codex/releases/latest";

/** Bops' own folder for the CLI it installs. */
export const binDir = () => join(homedir(), "Library", "Application Support", "Bops", "bin");

/** The PATH Codex runs with: the server's, where Codex's installers put it, and Bops' own copy last. */
export const codexPath = () =>
  [...new Set([...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local/bin"), "/usr/local/bin", "/opt/homebrew/bin", binDir()].filter(Boolean))].join(delimiter);

const runnable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The `codex` Bops runs: the first one on that PATH, if there is one. */
export function findCodex() {
  for (const dir of codexPath().split(delimiter)) if (runnable(join(dir, "codex"))) return join(dir, "codex");
}

export type CodexInstall = { state: "installing" | "installed" | "failed"; error?: string; version?: string };

const g = globalThis as typeof globalThis & { __bopsCodexInstall?: { status?: CodexInstall; running?: Promise<void> } };
const install = (g.__bopsCodexInstall ??= {});

/** Where Bops' own install stands: nothing until it first tries (once per start of the server, then only when asked again). */
export const installStatus = () => install.status;

/** Install the CLI into binDir(), unless an install is already running; `then` runs once this one ends, however it ended. */
export function installCodex(then?: () => void) {
  if (install.running) return;
  install.status = { state: "installing" };
  install.running = download(binDir())
    .then((version) => void (install.status = { state: "installed", version }))
    .catch((e: Error) => void (install.status = { state: "failed", error: e.message }))
    .finally(() => {
      install.running = undefined;
      then?.();
    });
}

const run = (file: string, args: string[]) =>
  new Promise<string>((res, rej) => execFile(file, args, { timeout: 60_000 }, (e, stdout) => (e ? rej(e) : res(String(stdout)))));

/**
 * Fetch the latest release's codex for this Mac into `dir`/codex and return its version. The file must
 * match the digest GitHub's API lists for it, and the binary must run, before it takes the place of
 * one that's there. The work happens in a folder next to it, removed at the end.
 */
export async function download(dir: string) {
  const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  const name = `codex-${target}.tar.gz`;
  const res = await fetch(RELEASE, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Bops" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest Codex release.`);
  const release = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; digest?: string | null }[] };
  const asset = release.assets?.find((a) => a.name === name);
  if (!asset) throw new Error(`The latest Codex release (${release.tag_name ?? "unknown"}) has no download for this Mac.`);
  const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
  if (!want) throw new Error("GitHub listed no checksum for the Codex download.");
  await mkdir(dir, { recursive: true });
  const work = await mkdtemp(join(dir, ".install-"));
  try {
    const file = join(work, name);
    const got = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Bops" }, signal: AbortSignal.timeout(20 * 60_000) });
    if (!got.ok || !got.body) throw new Error(`The Codex download failed (${got.status}).`);
    const hash = createHash("sha256");
    const tap = new Transform({ transform: (chunk: Buffer, _, done) => (hash.update(chunk), done(null, chunk)) });
    await pipeline(Readable.fromWeb(got.body as unknown as NodeReadableStream), tap, createWriteStream(file));
    if (hash.digest("hex") !== want) throw new Error("The Codex download didn't match its checksum.");
    await run("/usr/bin/tar", ["-xzf", file, "-C", work]);
    const bin = join(work, `codex-${target}`);
    if (!runnable(bin)) await chmod(bin, 0o755);
    const version = (await run(bin, ["--version"]).catch(() => "")).trim();
    if (!/codex/i.test(version)) throw new Error("The downloaded Codex didn't run on this Mac.");
    await rename(bin, join(dir, "codex"));
    return version;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
