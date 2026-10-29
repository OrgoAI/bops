import "server-only";
import { isAppName } from "@/lib/hosted-apps";
import { constants, createHash, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { appsOpen } from "@/lib/apps-access";
import type { IngotToken } from "@/lib/hosted-apps";
import { workspaceOf } from "@/lib/types";
import { apiKey, orgo } from "./orgo";
import { onRunner } from "./persist";
import { bot, getState, sameState, update, watchChanges } from "./store";

/**
 * Ingot (ingot/docs/hosted-api.md): Orgo's own source control, where a workspace's apps on the web live
 * (hosted-apps.ts), one Ingot repo each. One central Ingot server keeps every workspace's repos
 * (BOPS_INGOT_URL, https://bops.bot/api/ingot by default), each under its workspace's Orgo project
 * (Workspace.orgoProjectId), and signs each caller in with their Orgo key: the workspace's owner and
 * admins write, its members read. This Mac calls its API straight, with the user's key (`ingot` below),
 * so an app's history never needs a computer awake. A Bops computer gets only the ingot command, root's
 * config for it and an agent token for each workspace it works on apps for (ensureIngotCli), which its
 * working folders (readyFolder), its brains' MCP tools (INGOT_MCP), plain git (`ingot setup-git`) and
 * orgo-web's deploy runner (`ingot export`) all use. There it signs in with those tokens (design.md 19),
 * never the user's key: this Mac mints each with the user's key for that computer and workspace alone, so
 * a workspace others use works the same, and revokes it once no app of the workspace is on the computer
 * or the computer is gone. A token is for one workspace, and a computer may work for several (the user's
 * free Bops computer, which other workspaces' main bots share), so each has its own file there (TOKENS),
 * and the ingot command signs in to a repo with its workspace's. A token goes there sealed to a key the
 * computer makes for it (sealScript): orgo-web logs every command, and the computer runs each as an
 * argument of `bash -c`, so no command carries it, not even in base64.
 */

export const INGOT_BIN = "/opt/bops/bin/ingot";
/** The central Ingot server. */
export const ingotUrl = () => (process.env.BOPS_INGOT_URL || "https://bops.bot/api/ingot").replace(/\/+$/, "");
/** Where an app's working folder is on its computer: /workspace/apps/<name>, made with `ingot clone`. */
export const APPS_DIR = "/workspace/apps";
/**
 * Root's client config on a computer, the one the ingot command, its MCP server, git's credential helper
 * and orgo-web's deploy runner read there: the central server alone. No default workspace, as the computer
 * may work for more than one: every repo is named in full, "<project>/<name>".
 */
const CONFIG = "~root/.config/ingot/config.json";
/** Root's agent tokens there, beside the config (Ingot's tokens folder): one file per workspace, named after its Orgo project. */
const TOKENS = "~root/.config/ingot/tokens";
const tokenFile = (workspace: string) => `${TOKENS}/${workspace}`;

/**
 * Ingot's MCP tools (repo_status, repo_diff, repo_commit, repo_pull, repo_log, repo_show, repo_file,
 * repo_tree) for a brain's thread on an app (sessions.ts brainTools), with root's config on its computer.
 */
export const INGOT_MCP = { type: "stdio", command: INGOT_BIN, args: ["mcp", "--hosted"] } as const;

/** An Ingot repo's name: lowercase letters and digits in words joined by single dashes, at most 64 characters. */
export const isRepoName = isAppName;

/** A repo name for an app called `words` ("Recipe Box" is recipe-box): "app" when nothing in it can be one. */
export function repoNameFor(words: string): string {
  const all = words
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return all.slice(0, 64).replace(/-+$/, "") || "app";
}

/** An app's working folder on its computer. */
export const appFolder = (name: string) => `${APPS_DIR}/${name}`;

/**
 * Ingot couldn't do it, in plain words. `offline`: Ingot can't be reached. `refused`: the computer's ingot
 * command was turned away, as Ingot no longer takes its token.
 */
export class IngotError extends Error {
  offline: boolean;
  refused: boolean;
  constructor(message: string, offline = false, refused = false) {
    super(message);
    this.offline = offline;
    this.refused = refused;
  }
}

/** Why a workspace can't have apps yet: Ingot keeps a workspace's repos under its Orgo project, and it has none. */
export const NO_PROJECT = "This workspace isn't on Orgo yet, so it can't have apps on the web.";

/**
 * Work on apps that waits on Orgo or Ingot (a computer's set-up, a deploy, a DNS change) is the account's that
 * began it (`ours`: store.ts sameState). Once another account's state came in meanwhile (a sign-in on this
 * Mac), it stops before its next call or write: none of it is made with that account's key or kept in its
 * state, whoever they are.
 */
export const SWAPPED = "Another account signed in meanwhile, so that stopped.";
export function stillOurs(ours: () => boolean) {
  if (!ours()) throw new IngotError(SWAPPED);
}

/** An Orgo project's id as it goes in Ingot's paths (a lowercase uuid; Ingot's own rule, at most 64 characters). */
const PROJECT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The workspace a Bops workspace's repos are under in Ingot: its Orgo project (IngotError when it has none yet). */
export function ingotWorkspace(wsId: string): string {
  const p = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId?.toLowerCase();
  if (!p || p.length > 64 || !PROJECT.test(p)) throw new IngotError(NO_PROJECT);
  return p;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const g = globalThis as unknown as {
  /**
   * Each computer and workspace ("<computerId>\n<project>") the ingot command, root's config and the
   * workspace's token file (its sha256) were last found right on, and when.
   */
  bopsIngotReady?: Map<string, { at: number; sum: string }>;
  /** A computer's set-up already under way, by computer, whichever workspace it's for: a second ensureIngotCli waits for it. */
  bopsIngotSetup?: Map<string, Promise<IngotToken>>;
  /** The vendored binaries' sha256, by path, for the file as it was ("<size>:<mtime>"). */
  bopsIngotBins?: Map<string, { stamp: string; sha256: string }>;
  /** Each computer `ingot setup-git` last ran right on, for which server and binary. */
  bopsIngotGit?: Map<string, string>;
  /** Computers whose token is being revoked now (dropToken), by "<wsId>\n<computerId>". */
  bopsIngotDropping?: Set<string>;
  bopsIngotSweep?: ReturnType<typeof setTimeout>;
};

/** How long a computer found ready is taken for ready without asking it again. */
const READY_MS = 60_000;

/**
 * "<botId>; <bot name>": the bot a write from this Mac is from (X-Ingot-Author: a new repo). Ingot signs in
 * the key's user, and keeps the author as "<bot> via <user>". A computer's writes aren't: Ingot names
 * those after its token ("<token name> via <user>", tokenName), whatever author they give.
 */
export function authorOf(botId: string | undefined): string {
  const b = botId ? bot(botId) : undefined;
  const name = (b?.name ?? "Bops").replace(/[\u0000-\u001f\u007f;]+/g, " ").trim() || "Bops";
  return `${b?.id ?? "bops"}; ${name}`;
}

/* ---------------- The ingot binary, from this Bops ---------------- */

type Arch = "amd64" | "arm64";

/** Where this Bops keeps the ingot binaries for Linux: vendor/ingot (BOPS_INGOT_DIR in the packaged app). */
const vendorDir = () => process.env.BOPS_INGOT_DIR || join(/*turbopackIgnore: true*/ process.cwd(), "vendor/ingot");
const binaryPath = (arch: Arch) => join(/*turbopackIgnore: true*/ vendorDir(), `ingot-linux-${arch}`);

/** The vendored binary for `arch` and its sha256, or null when this Bops has none. */
function vendored(arch: Arch): { path: string; sha256: string } | null {
  const path = binaryPath(arch);
  let stamp: string;
  try {
    const st = statSync(/*turbopackIgnore: true*/ path);
    if (!st.isFile()) return null;
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  const kept = (g.bopsIngotBins ??= new Map()).get(path);
  if (kept?.stamp === stamp) return { path, sha256: kept.sha256 };
  const got = sha256(readFileSync(/*turbopackIgnore: true*/ path));
  g.bopsIngotBins.set(path, { stamp, sha256: got });
  return { path, sha256: got };
}

/**
 * Bytes of the gzipped binary per command. The computer runs a command as one argument of `bash -c`, and
 * Linux takes 128 KiB at most in one argument (MAX_ARG_STRLEN): 64 KiB is about 87,400 base64 characters.
 */
const PIECE = 64 * 1024;

/**
 * The vendored binary onto the computer at INGOT_BIN: gzipped, in base64 pieces appended to a part file
 * (as copySkillsToComputer sends files), then checked by sha256 before and after unpacking and moved
 * into place in one step, so a binary half copied never runs.
 */
async function sendBinary(computerId: string, bin: { path: string; sha256: string }, ours: () => boolean, signal?: AbortSignal) {
  const gz = gzipSync(readFileSync(/*turbopackIgnore: true*/ bin.path), { level: 9 });
  const part = "/opt/bops/bin/.ingot.gz.part";
  const n = Math.max(1, Math.ceil(gz.length / PIECE));
  for (let i = 0; i < n; i++) {
    const b64 = gz.subarray(i * PIECE, (i + 1) * PIECE).toString("base64");
    const lines = [`# bops-ingot binary ${i + 1}/${n}`, "set -e", ...(i === 0 ? [`install -d -m 755 /opt/bops/bin`, `: > ${part}`] : []), `printf %s ${q(b64)} | base64 -d >> ${part}`];
    const r = await orgo.bash(computerId, lines.join("\n"), 60, { signal });
    if (r.exit_code !== 0) throw new IngotError(`Couldn't copy Ingot to the computer: ${tail(r.output)}`);
    stillOurs(ours);
  }
  const done = await orgo.bash(
    computerId,
    [
      "# bops-ingot binary done",
      "set -e",
      "cd /opt/bops/bin",
      `[ "$(sha256sum ${part} | cut -c1-64)" = ${q(sha256(gz))} ] || { echo "INGOT_FAIL=the copy came out wrong"; exit 1; }`,
      `gzip -dc ${part} > .ingot.new`,
      `[ "$(sha256sum .ingot.new | cut -c1-64)" = ${q(bin.sha256)} ] || { echo "INGOT_FAIL=it unpacked wrong"; exit 1; }`,
      `chmod 755 .ingot.new && mv -f .ingot.new ${INGOT_BIN} && rm -f ${part}`,
      // On the PATH a brain's shell has (bops-brain runs it with /usr/local/bin, not /opt/bops/bin).
      `ln -sf ${INGOT_BIN} /usr/local/bin/ingot`,
      "echo INGOT_BIN=ok",
    ].join("\n"),
    60,
    { signal },
  );
  if (done.exit_code !== 0 || !/INGOT_BIN=ok/.test(done.output)) throw new IngotError(`Couldn't put Ingot on the computer: ${tail(done.output)}`);
}

/* ---------------- The ingot command on a computer ---------------- */

/** The `KEY=value` lines a set-up command printed. */
function marks(output: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of output.split("\n")) {
    const x = /^(INGOT_[A-Z_]+)=(.*)$/.exec(l.trim());
    if (x) m.set(x[1], x[2]);
  }
  return m;
}

/** The end of what a command printed, for an error: its failure's own words when it said them. */
function tail(output: string): string {
  const said = marks(output).get("INGOT_FAIL");
  const rest = output
    .split("\n")
    .filter((l) => !/^INGOT_[A-Z_]+=/.test(l.trim()))
    .join("\n")
    .trim()
    .slice(-400);
  return [said, rest].filter(Boolean).join(". ") || "no answer";
}

/** What the computer has of Ingot now: its binary, root's config and the workspace's token file, each by sha256 (one quick command). */
function probeScript(workspace: string): string {
  return [
    "# bops-ingot probe",
    "a=$(uname -m)",
    'case "$a" in x86_64|amd64) a=amd64 ;; aarch64|arm64) a=arm64 ;; esac',
    'echo "INGOT_ARCH=$a"',
    `if [ -x ${INGOT_BIN} ]; then ln -sf ${INGOT_BIN} /usr/local/bin/ingot; echo "INGOT_BIN=$(sha256sum ${INGOT_BIN} | cut -c1-64)"; else echo INGOT_BIN=none; fi`,
    `if [ -f ${CONFIG} ]; then echo "INGOT_CONFIG=$(sha256sum ${CONFIG} | cut -c1-64)"; else echo INGOT_CONFIG=none; fi`,
    `if [ -f ${tokenFile(workspace)} ]; then echo "INGOT_TOKEN_FILE=$(sha256sum ${tokenFile(workspace)} | cut -c1-64)"; else echo INGOT_TOKEN_FILE=none; fi`,
    "exit 0",
  ].join("\n");
}

/** The key a token is sealed to while it's sent: one per send, made on the computer, gone after it. */
const sealKey = (n: string) => `~root/.config/ingot/.seal-${n}.pem`;

/**
 * A key on the computer for one token to be sealed to (RSA, 2048 bits, 0600 in a folder of root's alone),
 * its public half printed: its private half never leaves the computer. Keys an earlier send left behind go.
 */
function sealScript(n: string): string {
  return [
    "# bops-ingot seal",
    "set -e",
    "umask 077",
    `command -v openssl >/dev/null || { echo "INGOT_FAIL=this computer has no openssl"; exit 1; }`,
    `mkdir -p ${TOKENS}`,
    `chmod 700 ~root/.config/ingot ${TOKENS}`,
    "find ~root/.config/ingot -maxdepth 1 -name '.seal-*.pem' -mmin +10 -delete",
    `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ${sealKey(n)} 2>/dev/null || { echo "INGOT_FAIL=openssl couldn't make a key"; exit 1; }`,
    `openssl pkey -in ${sealKey(n)} -pubout`,
    "echo INGOT_SEAL=ok",
  ].join("\n");
}

/** How much of the token one sealed piece holds: RSA OAEP with SHA-256 takes 190 bytes at most with a 2048 bit key. */
const SEAL_PIECE = 190;

/** The computer's key as sealScript printed it: RSA, 2048 bits or more (IngotError otherwise). */
function sealKeyOf(output: string): KeyObject {
  const pem = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(output)?.[0];
  let key: KeyObject | undefined;
  try {
    key = pem ? createPublicKey(pem) : undefined;
  } catch {
    key = undefined;
  }
  if (!key || key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new IngotError(`The computer didn't make a key for Ingot's token: ${tail(output)}`);
  return key;
}

/** `text` sealed to the computer's key, in base64 pieces openssl opens there. */
function sealTo(key: KeyObject, text: string): string[] {
  const b = Buffer.from(text, "utf8");
  const out: string[] = [];
  for (let i = 0; i < b.length; i += SEAL_PIECE) out.push(publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, b.subarray(i, i + SEAL_PIECE)).toString("base64"));
  return out;
}

/** Root's client config, as it is in the file: the central server. It holds no secret. */
const configText = () => `${JSON.stringify({ url: ingotUrl() })}\n`;

/** Root's client config written (0600, in a folder of root's alone) in one step, checked by sha256 before it's moved into place. */
function configScript(text: string): string {
  const next = `${CONFIG}.new`;
  return [
    "# bops-ingot config",
    "set -e",
    "umask 077",
    "mkdir -p ~root/.config/ingot",
    "chmod 700 ~root/.config/ingot",
    `trap 'rm -f ${next}' EXIT`,
    `printf %s ${q(Buffer.from(text).toString("base64"))} | base64 -d > ${next}`,
    `chmod 600 ${next}`,
    `[ "$(sha256sum ${next} | cut -c1-64)" = ${q(sha256(text))} ] || { echo "INGOT_FAIL=it came out wrong"; exit 1; }`,
    `mv -f ${next} ${CONFIG}`,
    "echo INGOT_CONFIG=ok",
  ].join("\n");
}

/** A workspace's token file as it is there: the token on one line. */
const tokenText = (token: string) => `${token}\n`;

/**
 * A workspace's token file written (0600, in a folder of root's alone) in one step, the token opened on
 * the computer with its key (`n`) straight into the file: it's never in a command, a variable or what's
 * printed. Checked by sha256 (`sum`, of tokenText) before it's moved into place. The key goes after,
 * whatever happened.
 */
function tokenScript(n: string, workspace: string, pieces: string[], sum: string): string {
  const k = sealKey(n);
  // Named so the ingot command never takes it for a workspace's.
  const next = `${TOKENS}/.${workspace}.new`;
  return [
    "# bops-ingot token",
    "set -e",
    "set -o pipefail",
    "umask 077",
    `trap 'rm -f ${k} ${next}' EXIT`,
    `[ -f ${k} ] || { echo "INGOT_FAIL=the key it was sealed to is gone"; exit 1; }`,
    "{",
    ...pieces.map((p) => `  printf %s ${q(p)} | base64 -d | openssl pkeyutl -decrypt -inkey ${k} -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256`),
    "  echo",
    `} > ${next}`,
    `chmod 600 ${next}`,
    `[ "$(sha256sum ${next} | cut -c1-64)" = ${q(sum)} ] || { echo "INGOT_FAIL=it came out wrong"; exit 1; }`,
    `mv -f ${next} ${tokenFile(workspace)}`,
    "echo INGOT_TOKEN_FILE=ok",
  ].join("\n");
}

/** `ingot setup-git` as root: git's credential helper for the central server is `ingot credential`, so plain git needs no password. */
const gitScript = () => ["# bops-ingot git", "export HOME=~root", `${INGOT_BIN} setup-git 2>&1 || { echo "INGOT_FAIL=setup-git"; exit 1; }`, "echo INGOT_GIT=ok"].join("\n");

/* ---------------- The computer's token ---------------- */

/** A computer's token as the workspace keeps it (Workspace.ingotTokens): its id and its file's sha256, never the token. */
const tokenOf = (wsId: string, computerId: string): IngotToken | undefined => getState().workspaces?.find((w) => w.id === wsId)?.ingotTokens?.[computerId];

/** Whether the workspace has a token on the computer (one it minted there and hasn't revoked). */
export const hasToken = (wsId: string, computerId: string) => !!tokenOf(wsId, computerId);

function keepToken(wsId: string, computerId: string, t: IngotToken | undefined) {
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (!w) return;
    if (t) w.ingotTokens = { ...(w.ingotTokens ?? {}), [computerId]: t };
    else if (w.ingotTokens?.[computerId]) {
      const { [computerId]: _gone, ...rest } = w.ingotTokens;
      void _gone;
      w.ingotTokens = Object.keys(rest).length ? rest : undefined;
    }
  });
}

/**
 * A token's name at Ingot: "<bot> on <computer>", the workspace's bot whose computer it is (else the task's)
 * and the computer's name on Orgo, in the one line of at most 64 characters Ingot takes. Ingot names the
 * computer's commits for the workspace after it.
 */
async function tokenName(computerId: string, wsId: string, botId?: string): Promise<string> {
  const bots = getState().bots;
  const b = bots.find((x) => x.computerId === computerId && workspaceOf(x) === wsId) ?? (botId ? bot(botId) : undefined) ?? bots.find((x) => x.computerId === computerId);
  const c = await orgo.computer(computerId).catch(() => null);
  const plain = (s: string | undefined, most: number) =>
    Array.from((s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim())
      .slice(0, most)
      .join("")
      .trim();
  const who = plain(b?.name, 30) || "Bops";
  return `${who} on ${plain(c?.name, 60 - Array.from(who).length) || plain(computerId, 60 - Array.from(who).length)}`;
}

/**
 * A new token for the computer in the workspace's token file there, in place of `old` (revoked once the
 * new one is in, best effort): its key made there first (sealScript), the token minted here with the
 * user's key, sealed to it and written (tokenScript). A token that couldn't be written is revoked at once.
 */
async function newToken(computerId: string, wsId: string, workspace: string, old: IngotToken | undefined, o: { botId?: string; signal?: AbortSignal; ours: () => boolean }): Promise<IngotToken> {
  const n = randomBytes(8).toString("hex");
  const seal = await orgo.bash(computerId, sealScript(n), 60, { signal: o.signal });
  if (seal.exit_code !== 0 || !/INGOT_SEAL=ok/.test(seal.output)) throw new IngotError(`Couldn't send Ingot's token to the computer: ${tail(seal.output)}`);
  stillOurs(o.ours);
  const key = sealKeyOf(seal.output);
  const name = await tokenName(computerId, wsId, o.botId);
  stillOurs(o.ours);
  const made = await ingot.mintToken(wsId, name, o.signal);
  let t: IngotToken;
  try {
    stillOurs(o.ours);
    const sum = sha256(tokenText(made.token));
    const r = await orgo.bash(computerId, tokenScript(n, workspace, sealTo(key, made.token), sum), 30, { signal: o.signal });
    if (r.exit_code !== 0 || !/INGOT_TOKEN_FILE=ok/.test(r.output)) throw new IngotError(`Couldn't put Ingot's token on the computer: ${tail(r.output)}`);
    stillOurs(o.ours);
    t = { id: made.id, sum, at: Date.now() };
  } catch (e) {
    // Revoked only by the account that made it: never with another's key, in that account's workspace.
    if (o.ours()) await ingot.revokeToken(wsId, made.id).catch((x: Error) => console.warn(`[ingot] ${computerId}: the token ${made.id} it never got wasn't revoked: ${x.message}`));
    throw e;
  }
  keepToken(wsId, computerId, t);
  if (old && old.id !== t.id) await ingot.revokeToken(wsId, old.id).catch((x: Error) => console.warn(`[ingot] ${computerId}: its old token ${old.id} wasn't revoked: ${x.message}`));
  return t;
}

/**
 * The computer's token revoked at Ingot and forgotten here (best effort: forgotten all the same when Ingot
 * can't be told): no app of the workspace is on the computer anymore, or it's gone (hosted-apps.ts, sweep).
 */
export async function dropToken(wsId: string, computerId: string): Promise<void> {
  const t = tokenOf(wsId, computerId);
  const job = `${wsId}\n${computerId}`;
  const busy = (g.bopsIngotDropping ??= new Set());
  if (!t || busy.has(job)) return;
  busy.add(job);
  try {
    for (const k of g.bopsIngotReady?.keys() ?? []) if (k.startsWith(`${computerId}\n`)) g.bopsIngotReady?.delete(k);
    await ingot.revokeToken(wsId, t.id).catch((e: Error) => console.warn(`[ingot] ${computerId}: its token ${t.id} wasn't revoked: ${e.message}`));
    // Unless a new one took its place meanwhile.
    if (tokenOf(wsId, computerId)?.id === t.id) keepToken(wsId, computerId, undefined);
  } finally {
    busy.delete(job);
  }
}

/** The tokens of computers no bot has anymore (deleted, or reset to a new one): revoked. */
export function sweepTokens() {
  const s = getState();
  const have = new Set(s.bots.map((b) => b.computerId).filter(Boolean));
  for (const w of s.workspaces ?? []) for (const computerId of Object.keys(w.ingotTokens ?? {})) if (!have.has(computerId)) void dropToken(w.id, computerId);
}

// Any change might be a computer gone: looked at a moment later, once for a burst of changes. Never on a
// computer's runner, which mints none, nor for an account apps aren't open to (lib/apps-access.ts).
if (!onRunner())
  watchChanges("ingot-tokens", () => {
    if (g.bopsIngotSweep || !appsOpen(getState())) return;
    g.bopsIngotSweep = setTimeout(() => {
      g.bopsIngotSweep = undefined;
      try {
        sweepTokens();
      } catch (e) {
        console.warn(`[ingot] ${(e as Error).message}`);
      }
    }, 500);
    g.bopsIngotSweep.unref?.();
  });

/* ---------------- Setting a computer up ---------------- */

/**
 * The ingot command ready on a computer for workspace `wsId`: the binary from this Bops
 * (vendor/ingot/ingot-linux-<amd64|arm64>, by uname -m) at INGOT_BIN, root's config for the central
 * server, the computer's own agent token for the workspace in its file there, and git's credential helper
 * (`ingot setup-git`). Nothing else runs there, and neither the user's key nor the token is in any command.
 * Idempotent: a computer that has it all takes one quick command (none for a minute after), and only what's
 * missing or changed goes: a new binary here, the config, or a new token when its file is missing or
 * changed, or Ingot no longer lists it, or `renew` (Ingot turned it away), the old one revoked. Another
 * workspace's token there stays as it is, so a computer two workspaces share works for both. A workspace
 * others use too is set up the same. IngotError when the workspace isn't on Orgo yet or no one is signed
 * in. `botId`: the task's bot, for the token's name when the computer is no bot's of the workspace.
 */
export async function ensureIngotCli(computerId: string, wsId: string, opts: { signal?: AbortSignal; botId?: string; renew?: boolean } = {}): Promise<void> {
  const ours = sameState();
  const workspace = ingotWorkspace(wsId);
  const key = await apiKey().catch(() => null);
  stillOurs(ours);
  if (!key) throw new IngotError("Sign in with Orgo to work on apps on the web.");
  // The token turned away, as it was when it was: one another set-up replaced meanwhile is new.
  const refused = opts.renew ? (tokenOf(wsId, computerId)?.id ?? "") : undefined;
  const ready = (g.bopsIngotReady ??= new Map());
  const setup = (g.bopsIngotSetup ??= new Map());
  const job = `${computerId}\n${workspace}`;
  for (;;) {
    const kept = tokenOf(wsId, computerId);
    const was = ready.get(job);
    if (kept && kept.id !== refused && was && was.sum === kept.sum && Date.now() - was.at < READY_MS) return;
    const running = setup.get(computerId);
    if (!running) break;
    await running.catch(() => undefined);
    stillOurs(ours);
  }
  const work = setUp(computerId, wsId, workspace, { ...opts, refused, ours });
  setup.set(computerId, work);
  try {
    const t = await work;
    ready.set(job, { at: Date.now(), sum: t.sum });
  } catch (e) {
    ready.delete(job);
    throw e;
  } finally {
    if (setup.get(computerId) === work) setup.delete(computerId);
  }
}

async function setUp(computerId: string, wsId: string, workspace: string, o: { signal?: AbortSignal; botId?: string; refused?: string; ours: () => boolean }): Promise<IngotToken> {
  const kept = tokenOf(wsId, computerId);
  const mine = kept && kept.id !== o.refused ? kept : undefined;
  // Whether Ingot still lists the token, asked of it from here while the computer is probed (null: it didn't say).
  const [probe, listed] = await Promise.all([orgo.bash(computerId, probeScript(workspace), 30, { signal: o.signal }), mine ? ingot.tokenIds(wsId, o.signal).catch(() => null) : null]);
  stillOurs(o.ours);
  const m = marks(probe.output);
  const arch = m.get("INGOT_ARCH");
  if (arch !== "amd64" && arch !== "arm64") throw new IngotError(`Ingot runs on Linux on amd64 or arm64, and this computer is ${arch || "something else"}.`);
  const has = m.get("INGOT_BIN") ?? "none";
  const bin = vendored(arch);
  if (!bin && has === "none") throw new IngotError(`This Bops has no Ingot for the computer to run (${binaryPath(arch)} is missing), so its apps can't be set up there.`);
  if (bin && has !== bin.sha256) {
    await sendBinary(computerId, bin, o.ours, o.signal);
    stillOurs(o.ours);
  }
  const config = configText();
  const newConfig = m.get("INGOT_CONFIG") !== sha256(config);
  if (newConfig) {
    const r = await orgo.bash(computerId, configScript(config), 30, { signal: o.signal });
    if (r.exit_code !== 0 || !/INGOT_CONFIG=ok/.test(r.output)) throw new IngotError(`Couldn't write Ingot's config on the computer: ${tail(r.output)}`);
    stillOurs(o.ours);
  }
  const good = mine && m.get("INGOT_TOKEN_FILE") === mine.sum && listed?.has(mine.id) !== false ? mine : undefined;
  const t = good ?? (await newToken(computerId, wsId, workspace, kept, o));
  stillOurs(o.ours);
  await gitReady(computerId, bin?.sha256 ?? has, newConfig, o.signal);
  return t;
}

/**
 * `ingot setup-git` on the computer, when it hasn't run there for this server and binary since this Mac
 * started, or `again` (a new config). Not fatal: the ingot command and its tools work without it, and it's
 * tried again on the next set-up.
 */
async function gitReady(computerId: string, binary: string, again: boolean, signal?: AbortSignal) {
  const want = `${ingotUrl()}\n${binary}`;
  const done = (g.bopsIngotGit ??= new Map());
  if (!again && done.get(computerId) === want) return;
  done.delete(computerId);
  let r: { output: string; exit_code: number };
  try {
    r = await orgo.bash(computerId, gitScript(), 30, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    r = { output: (e as Error).message, exit_code: 1 };
  }
  if (r.exit_code === 0 && /INGOT_GIT=ok/.test(r.output)) done.set(computerId, want);
  else console.warn(`[ingot] ${computerId}: plain git isn't set up there yet: ${tail(r.output)}`);
}

/* ---------------- Its API, from this Mac ---------------- */

type Answer<T> = { status: number; json: T & { error?: string; message?: string } };

/** How long the central server gets for one call. */
const CALL_MS = 15_000;
/** What a proxy in front of Ingot answers while Ingot is down. */
const DOWN = new Set([502, 503, 504]);
/** A header's value as UTF-8 on the wire (fetch takes Latin-1 only, and a bot's name may be anything). */
const utf8 = (s: string) => Buffer.from(s, "utf8").toString("latin1");

/**
 * One call to the central Ingot's API, `path` under the workspace's repos (/api/v1/w/<project>), with the
 * user's Orgo key, and `author` as X-Ingot-Author for a write. Throws IngotError (offline) when Ingot
 * can't be reached; any other HTTP answer comes back as it is, but a key Ingot didn't take.
 */
async function api<T>(wsId: string, method: "GET" | "POST" | "DELETE", path: string, opts: { body?: unknown; author?: string; signal?: AbortSignal } = {}): Promise<Answer<T>> {
  const ours = sameState();
  const project = ingotWorkspace(wsId);
  const key = await apiKey().catch(() => null);
  // The key of the account whose workspace this is, never one signed in since.
  stillOurs(ours);
  if (!key) throw new IngotError("Sign in with Orgo to use apps on the web.");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (opts.author) headers["X-Ingot-Author"] = utf8(opts.author);
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const timeout = AbortSignal.timeout(CALL_MS);
  let res: Response;
  try {
    res = await fetch(`${ingotUrl()}/api/v1/w/${encodeURIComponent(project)}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      cache: "no-store",
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new IngotError("Ingot isn't answering.", true);
  }
  if (DOWN.has(res.status)) throw new IngotError("Ingot isn't answering.", true);
  const json = (await res.json().catch(() => ({}))) as Answer<T>["json"];
  if (res.status === 401) throw new IngotError("Ingot didn't take your Orgo key. Sign in with Orgo again.");
  return { status: res.status, json };
}

/** Ingot's own words for an answer it turned down. */
const refusal = (what: string, r: Answer<unknown>) => new IngotError(`${what}: ${r.json.message || r.json.error || `Ingot answered ${r.status}`}`);

/** A repo as Ingot lists it: its newest changeset on main (null: nothing committed yet). */
export type IngotRepo = { name: string; head: string | null; updated_at: string | number | null };

/** A changeset in a repo's log, newest first: its file changes against its first parent (paths, or how many). */
export type IngotChangeset = {
  id: string;
  parents: string[];
  author: { id?: string; name?: string } | null;
  message: string;
  at: string | number;
  changes?: { added?: unknown; modified?: unknown; deleted?: unknown };
};

/** A time as Ingot gives it (an ISO date, or seconds or milliseconds since 1970) in milliseconds, or null. */
export function msOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v) {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Typed calls to the central Ingot (hosted-api.md), for a Bops workspace's repos. None needs a computer. */
export const ingot = {
  /** Every repo of the workspace, with its newest changeset on main. */
  repos: async (wsId: string, signal?: AbortSignal): Promise<IngotRepo[]> => {
    const r = await api<{ repos?: IngotRepo[] }>(wsId, "GET", "/repos", { signal });
    if (r.status !== 200) throw refusal("Couldn't list the apps", r);
    return (r.json.repos ?? []).filter((x) => isRepoName(x?.name));
  },
  /** A new repo, by `author`. Says whether it was made now (false: it was there already). */
  createRepo: async (wsId: string, name: string, author: string, signal?: AbortSignal): Promise<boolean> => {
    if (!isRepoName(name)) throw new IngotError(`"${name}" can't be an app's name.`);
    const r = await api(wsId, "POST", "/repos", { body: { name }, author, signal });
    if (r.status === 201) return true;
    if (r.status === 409) return false;
    throw refusal(`Couldn't make the app ${name}`, r);
  },
  /**
   * A repo deleted, with all its history (the workspace's owner or an admin only: never an agent token).
   * Says whether it was there to delete (false: there was no such repo).
   */
  deleteRepo: async (wsId: string, name: string, signal?: AbortSignal): Promise<boolean> => {
    if (!isRepoName(name)) throw new IngotError(`"${name}" can't be an app's name.`);
    const r = await api(wsId, "DELETE", `/repos/${name}`, { signal });
    if (r.status === 200 || r.status === 204) return true;
    if (r.status === 404) return false;
    throw refusal(`Couldn't delete ${name}'s code`, r);
  },
  /** A repo's changesets on main, newest first (`before`: older than that one), and `next` for the page after; null when there's no such repo. */
  log: async (wsId: string, name: string, opts: { before?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{ changesets: IngotChangeset[]; next: string | null } | null> => {
    const query = new URLSearchParams({ limit: String(Math.min(200, Math.max(1, opts.limit ?? 50))), ...(opts.before ? { before: opts.before } : {}) });
    const r = await api<{ changesets?: IngotChangeset[]; next?: string | null }>(wsId, "GET", `/repos/${name}/log?${query}`, { signal: opts.signal });
    if (r.status === 404) return null;
    if (r.status !== 200) throw refusal(`Couldn't read ${name}'s history`, r);
    return { changesets: (r.json.changesets ?? []).filter((c) => typeof c?.id === "string"), next: typeof r.json.next === "string" && r.json.next ? r.json.next : null };
  },
  /** A repo's newest changeset on main (null: nothing committed yet), or undefined when there's no such repo. */
  head: async (wsId: string, name: string, signal?: AbortSignal): Promise<string | null | undefined> => {
    const r = await api<{ refs?: { name: string; target: string }[] }>(wsId, "GET", `/repos/${name}`, { signal });
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw refusal(`Couldn't read ${name}`, r);
    return r.json.refs?.find((x) => x.name === "main")?.target ?? null;
  },
  /**
   * A new agent token that writes the workspace's repos, for one computer, named `name` (one line, at most
   * 64 characters): its id, and its secret, which Ingot gives this once ({ token, secret }). Kept in memory
   * only as long as it takes to send it.
   */
  mintToken: async (wsId: string, name: string, signal?: AbortSignal): Promise<{ id: string; token: string }> => {
    const r = await api<{ token?: { id?: unknown }; secret?: unknown }>(wsId, "POST", "/tokens", { body: { name, scope: "write" }, signal });
    if (r.status !== 200 && r.status !== 201) throw refusal("Couldn't make the computer a token for Ingot", r);
    const id = idOf(r.json.token?.id);
    const secret = r.json.secret;
    if (!id || typeof secret !== "string" || !secret) throw new IngotError("Ingot made the computer a token but didn't say what it is.");
    return { id, token: secret };
  },
  /** The ids of the workspace's agent tokens Ingot still takes (one revoked or past its time isn't), or null when it didn't say. */
  tokenIds: async (wsId: string, signal?: AbortSignal): Promise<Set<string> | null> => {
    const r = await api<{ tokens?: { id?: unknown; revoked_at?: unknown; expires_at?: unknown }[] }>(wsId, "GET", "/tokens", { signal });
    if (r.status !== 200 || !Array.isArray(r.json.tokens)) return null;
    const now = Date.now();
    const live = r.json.tokens.filter((t) => idOf(t?.id) && !t.revoked_at && !((msOf(t.expires_at) ?? Infinity) <= now));
    return new Set(live.map((t) => idOf(t.id)!));
  },
  /** An agent token revoked (one Ingot no longer has is revoked already). */
  revokeToken: async (wsId: string, id: string, signal?: AbortSignal): Promise<void> => {
    const r = await api(wsId, "DELETE", `/tokens/${encodeURIComponent(id)}`, { signal });
    if (r.status !== 200 && r.status !== 204 && r.status !== 404) throw refusal("Couldn't revoke the computer's token", r);
  },
};

/** An agent token's id as Ingot gives it (a number), as Bops keeps it. */
const idOf = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined);

/**
 * How the ingot command says Ingot turned its token away (a 401: one Ingot doesn't know, revoked or past its
 * time, or none sent, in Ingot's own words, or the command's own when Ingot said none), on the line it
 * fails with ("ingot: ..."), never in what a pull lists (a file's path may say anything).
 */
const TURNED_AWAY = /^ingot: .*(?:does not know this agent token|this agent token (?:was revoked|has expired)|the Ingot server refused the key|send an Orgo API key as Authorization)/im;

/**
 * An app's working folder on the computer (appFolder): cloned from its repo ("<project>/<name>") when it
 * isn't there, else brought to the newest main with `ingot pull` (which merges the folder's own changes; a
 * conflict leaves markers for the task to fix). A folder there that isn't an Ingot working folder (or is
 * one of the computer's old local Ingot, of no workspace) is moved aside first, never deleted. One of
 * another workspace's repo (the computer works for both, and each has an app by that name) is left as it
 * is, and refused: that workspace's tasks work in it. Says what was done, in words for the task's steps.
 * IngotError `refused` when Ingot turned the computer's token away.
 */
export async function readyFolder(computerId: string, wsId: string, name: string, signal?: AbortSignal): Promise<string> {
  if (!isRepoName(name)) throw new IngotError(`"${name}" can't be an app's name.`);
  const repo = `${ingotWorkspace(wsId)}/${name}`;
  const dir = appFolder(name);
  const state = `${dir}/.ingot/state.json`;
  // A field of the folder's state, which Ingot writes one a line (a repo's name and a workspace are plain).
  const field = (k: string) => `$(sed -n 's/^ *"${k}": "\\([a-z0-9-]*\\)".*/\\1/p' ${state} | head -n 1)`;
  const r = await orgo.bash(
    computerId,
    [
      `# bops-ingot folder ${name}`,
      "export HOME=~root",
      `mkdir -p ${APPS_DIR}`,
      `there=""; [ ! -f ${state} ] || there="${field("workspace")}/${field("repo")}"`,
      `if [ "$there" = ${q(repo)} ]; then`,
      `  cd ${dir}`,
      "  echo INGOT_FOLDER=pull",
      `  ${INGOT_BIN} pull 2>&1 || echo "INGOT_PULL_EXIT=$?"`,
      'elif [ -n "${there%%/*}" ] && [ "${there%%/*}" != local ]; then',
      '  echo "INGOT_OTHER=$there"',
      "  exit 1",
      "else",
      `  if [ -e ${dir} ]; then old=${APPS_DIR}/.${name}.before-ingot-$(date +%s); mv ${dir} "$old"; echo "INGOT_MOVED=$old"; fi`,
      `  ${INGOT_BIN} clone ${q(repo)} ${dir} 2>&1 || { echo INGOT_FAIL=clone; exit 1; }`,
      "  echo INGOT_FOLDER=clone",
      "fi",
    ].join("\n"),
    120,
    { signal },
  );
  const m = marks(r.output);
  const other = m.get("INGOT_OTHER");
  if (other) throw new IngotError(`${dir} on this computer is the working folder of another workspace's Ingot repo (${other}), so ${name} can't be worked on there.`);
  const failed = r.exit_code !== 0 || !m.has("INGOT_FOLDER");
  if ((failed || m.has("INGOT_PULL_EXIT")) && TURNED_AWAY.test(r.output)) throw new IngotError(`Ingot didn't take this computer's token: ${tail(r.output)}`, false, true);
  if (failed) throw new IngotError(`Couldn't make ${dir} from the Ingot repo ${name}: ${tail(r.output)}`);
  const moved = m.get("INGOT_MOVED");
  if (m.get("INGOT_FOLDER") === "clone") return `Cloned the Ingot repo ${name} into ${dir}${moved ? ` (what was there before is in ${moved})` : ""}`;
  return m.has("INGOT_PULL_EXIT") ? `Pulled the newest ${name} into ${dir}: ${tail(r.output)}` : `Pulled the newest ${name} into ${dir}`;
}
