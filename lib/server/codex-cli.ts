import "server-only";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const RELEASE = "https://api.github.com/repos/openai/codex/releases/latest";
const windows = process.platform === "win32";

export const binDir = () =>
  windows
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Bops", "bin")
    : join(homedir(), "Library", "Application Support", "Bops", "bin");

export const codexPath = () => {
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter),
    windows ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm") : join(homedir(), ".local/bin"),
    windows ? binDir() : "/usr/local/bin",
    windows ? "" : "/opt/homebrew/bin",
    binDir(),
  ].filter(Boolean);
  return [...new Set(candidates)].join(delimiter);
};

const runnable = (p: string) => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};

export function findCodex() {
  // Use a native executable on Windows. .cmd wrappers cannot reliably host app-server stdio.
  const names = windows ? ["codex.exe"] : ["codex"];
  for (const dir of codexPath().split(delimiter)) for (const name of names) if (runnable(join(dir, name))) return join(dir, name);
}

export type CodexInstall = { state: "installing" | "installed" | "failed"; error?: string; version?: string };
const g = globalThis as typeof globalThis & { __bopsCodexInstall?: { status?: CodexInstall; running?: Promise<void> } };
const install = (g.__bopsCodexInstall ??= {});
export const installStatus = () => install.status;

export function installCodex(then?: () => void) {
  if (install.running) return;
  install.status = { state: "installing" };
  install.running = download(binDir())
    .then((version) => void (install.status = { state: "installed", version }))
    .catch((e: Error) => void (install.status = { state: "failed", error: e.message }))
    .finally(() => { install.running = undefined; then?.(); });
}

const run = (file: string, args: string[]) =>
  new Promise<string>((res, rej) => execFile(file, args, { timeout: 60_000, windowsHide: true }, (e, stdout) => e ? rej(e) : res(String(stdout))));

export async function download(dir: string) {
  const target = windows
    ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`
    : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  const name = windows ? `codex-${target}.exe` : `codex-${target}.tar.gz`;

  const res = await fetch(RELEASE, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Bops" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest Codex release.`);
  const release = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; digest?: string | null }[] };
  const asset = release.assets?.find((a) => a.name === name);
  if (!asset) throw new Error(`The latest Codex release (${release.tag_name ?? "unknown"}) has no download for ${target}.`);
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

    let bin: string;
    if (windows) {
      bin = join(dir, "codex.exe");
      await rm(bin, { force: true }).catch(() => {});
      await rename(file, bin);
    } else {
      await run("/usr/bin/tar", ["-xzf", file, "-C", work]);
      const extracted = join(work, `codex-${target}`);
      if (!runnable(extracted)) await chmod(extracted, 0o755);
      bin = join(dir, "codex");
      await rm(bin, { force: true }).catch(() => {});
      await rename(extracted, bin);
    }
    const version = (await run(bin, ["--version"]).catch(() => "")).trim();
    if (!/codex/i.test(version)) throw new Error("The downloaded Codex binary didn't run.");
    return version;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
