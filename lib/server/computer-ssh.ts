import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Carrier } from "./local-preview";
import { computerSsh, orgo, OrgoError } from "./orgo";
import { userDir } from "./store";

/*
 * This Mac's way to a bot's Orgo computer when the computer isn't on the tailnet (tailnet.ts is a developer's
 * setup): the computer's own SSH, which Orgo gives each computer (sshd there takes keys only, on a port of its
 * host's), for a Local's preview here (local-preview.ts carries each of its connections through a tunnel).
 *
 * Bops has a key pair of its own for it, made once in the signed-in user's folder on this Mac (ssh/id_ed25519,
 * 0600, never sent anywhere; its .pub beside it). Before each tunnel its public key is put in the computer's
 * /root/.ssh/authorized_keys through Orgo's bash, once, every other line kept: Orgo writes that file whole with
 * its own keys when SSH is turned on and on each start, so it's looked at every time. Orgo is asked to turn SSH on
 * (with this key) only while it's off, so keys the user set there are never replaced. The computer's host key is
 * read the same way and pinned in a known_hosts of Bops' own, and ssh connects only to that key.
 *
 * A tunnel is /usr/bin/ssh with nothing but one forward: a socket of its own on this Mac (in a folder only this
 * user can open) to that port of the computer's loopback, no command and no other forward, none of the user's
 * ssh config, agent or known hosts.
 */

/** Which ssh and ssh-keygen run (overridable only for scripts/test-hosted-apps.mjs: Bops never sets them). */
const SSH_BIN = () => process.env.BOPS_SSH_BIN || "/usr/bin/ssh";
const KEYGEN_BIN = () => process.env.BOPS_SSH_KEYGEN_BIN || "/usr/bin/ssh-keygen";

/** How long ssh may take to connect and open its forward before it counts as not answering. */
const UP_MS = 20_000;
/** The longest wait between two tries to bring back a tunnel that dropped. */
const BACK_MS = 30_000;
/** How soon after a try a connection may start another at once instead of waiting its turn (a page asks again and again). */
const ASK_MS = 5000;

/**
 * Why a computer can't be reached through its SSH: `no-key` (no key here: signed out, or ssh-keygen failed),
 * `unreachable` (Orgo didn't answer), `refused` (Orgo turned SSH down, or it isn't root's), `no-address` (it has
 * none yet), `no-answer` (its sshd, or its bash, didn't answer, or ssh couldn't connect to it), `asleep` (it
 * sleeps: never woken for this). `said`: ssh's own last words, for the server log.
 */
export class SshError extends Error {
  why: "no-key" | "unreachable" | "refused" | "no-address" | "no-answer" | "asleep";
  constructor(why: SshError["why"], said = "") {
    super(said ? `${why}: ${said}` : why);
    this.why = why;
  }
}

/** Where a computer's sshd is reached from here, and the files ssh uses for it. */
export type SshPlace = { host: string; port: number; user: string; key: string; knownHosts: string };

const g = globalThis as unknown as { bopsSshKeys?: Map<string, Promise<string>>; bopsSshSocks?: string; bopsSshCount?: number };
const making = (g.bopsSshKeys ??= new Map<string, Promise<string>>());

const PUB = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}/;

/** Bops' key pair on this Mac: its folder, its private key's path and its public key's line, made the first time and the same after. */
export async function sshKey(): Promise<{ dir: string; key: string; pub: string }> {
  const root = userDir();
  if (!root) throw new SshError("no-key");
  const dir = join(/*turbopackIgnore: true*/ root, "ssh");
  const key = join(/*turbopackIgnore: true*/ dir, "id_ed25519");
  const pubNow = () => {
    try {
      return PUB.exec(readFileSync(/*turbopackIgnore: true*/ `${key}.pub`, "utf8"))?.[0];
    } catch {
      return undefined;
    }
  };
  let pub = existsSync(/*turbopackIgnore: true*/ key) ? pubNow() : undefined;
  if (!pub) {
    let made = making.get(key);
    if (!made) {
      made = makeKey(dir, key).finally(() => making.delete(key));
      making.set(key, made);
    }
    pub = await made;
  }
  // (ssh refuses a private key others can read.)
  chmodSync(/*turbopackIgnore: true*/ key, 0o600);
  return { dir, key, pub: `${pub} bops` };
}

/** A new key pair (ed25519, no passphrase) in place of whatever half of one was there: its public key's type and body. */
async function makeKey(dir: string, key: string): Promise<string> {
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
  chmodSync(/*turbopackIgnore: true*/ dir, 0o700);
  for (const f of [key, `${key}.pub`]) rmSync(/*turbopackIgnore: true*/ f, { force: true });
  await new Promise<void>((done, fail) =>
    execFile(/*turbopackIgnore: true*/ KEYGEN_BIN(), ["-q", "-t", "ed25519", "-N", "", "-C", "bops", "-f", key], { timeout: 15_000 }, (e) => (e ? fail(new SshError("no-key", e.message)) : done())),
  );
  const pub = PUB.exec(readFileSync(/*turbopackIgnore: true*/ `${key}.pub`, "utf8"))?.[0];
  if (!pub || !existsSync(/*turbopackIgnore: true*/ key)) throw new SshError("no-key", "ssh-keygen made no key");
  return pub;
}

/** A host as ssh takes it: a name or an IPv4 address, never something it would read as an option. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * `computerId`'s sshd made ready for this Mac: Orgo asked where it is (and to turn it on with Bops' key, only when
 * it's off), Bops' key put in its authorized_keys (once: every other line kept), and its host key read there and
 * pinned here. SshError says why not.
 */
export async function sshPlace(computerId: string): Promise<SshPlace> {
  const k = await sshKey();
  const asked = (e: unknown) => Promise.reject(e instanceof SshError ? e : new SshError(e instanceof OrgoError ? "refused" : "unreachable", (e as Error)?.message));
  let s = await computerSsh.get(computerId).catch(asked);
  if (!s.enabled) {
    await computerSsh.on(computerId, k.pub).catch(asked);
    s = await computerSsh.get(computerId).catch(asked);
  }
  const host = typeof s.ipv4_host === "string" && HOST.test(s.ipv4_host) ? s.ipv4_host : null;
  const port = typeof s.ipv4_port === "number" && Number.isInteger(s.ipv4_port) && s.ipv4_port >= 1 && s.ipv4_port <= 65535 ? s.ipv4_port : null;
  if (!s.enabled || !host || !port) throw new SshError("no-address");
  // (Its authorized_keys below is root's: a Bops computer's SSH is.)
  const user = s.ssh_user ?? "root";
  if (user !== "root") throw new SshError("refused", `its SSH is ${user}'s`);
  const body = k.pub.split(" ")[1];
  const r = await orgo
    .bash(
      computerId,
      [
        "# bops-ssh key",
        "umask 077",
        "mkdir -p /root/.ssh && chmod 700 /root/.ssh",
        "f=/root/.ssh/authorized_keys",
        'touch "$f" && chmod 600 "$f"',
        // Once: a line with this key's body in it, whatever its comment, is this key.
        `if ! awk -v b='${body}' '{ for (i = 1; i <= NF; i++) if ($i == b) seen = 1 } END { exit !seen }' "$f"; then`,
        '  [ ! -s "$f" ] || [ -z "$(tail -c 1 "$f")" ] || echo >> "$f"',
        `  echo '${k.pub}' >> "$f"`,
        "fi",
        'echo "BOPS_SSH_HOSTKEY=$(cut -d " " -f 1,2 /etc/ssh/ssh_host_ed25519_key.pub 2> /dev/null)"',
        "echo BOPS_SSH_KEY=ok",
      ].join("\n"),
      30,
    )
    .catch((e: unknown) => Promise.reject(new SshError("no-answer", (e as Error)?.message)));
  const hostKey = /^BOPS_SSH_HOSTKEY=(ssh-ed25519 [A-Za-z0-9+/]+={0,3})$/m.exec(r.output)?.[1];
  if (!/^BOPS_SSH_KEY=ok$/m.test(r.output) || !hostKey) throw new SshError("no-answer", r.output.trim().slice(-200));
  // Pinned: this host and port is that key, in Bops' own known_hosts (one line each, the newest read).
  const knownHosts = join(/*turbopackIgnore: true*/ k.dir, "known_hosts");
  const name = port === 22 ? host : `[${host}]:${port}`;
  const had = existsSync(/*turbopackIgnore: true*/ knownHosts) ? readFileSync(/*turbopackIgnore: true*/ knownHosts, "utf8") : "";
  const kept = had.split("\n").filter((l) => l.trim() && l.split(" ")[0] !== name);
  writeFileSync(/*turbopackIgnore: true*/ knownHosts, `${[...kept, `${name} ${hostKey}`].join("\n")}\n`, { mode: 0o600 });
  return { host, port, user, key: k.key, knownHosts };
}

/**
 * ssh's whole command line for a tunnel from `sock` here to `port` on the computer's loopback: the key and the
 * pinned host key only, nothing asked of anyone, no command, that one forward, and gone once the computer stops
 * answering.
 */
export const sshArgs = (at: SshPlace, sock: string, port: number) => [
  "-F",
  "/dev/null",
  "-i",
  at.key,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "IdentityAgent=none",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile="${at.knownHosts}"`,
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "HostKeyAlgorithms=ssh-ed25519",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "StreamLocalBindUnlink=yes",
  "-N",
  "-L",
  `${sock}:127.0.0.1:${port}`,
  "-p",
  String(at.port),
  "-l",
  at.user,
  "--",
  at.host,
];

/** A folder for this server's tunnel sockets, only this user's (a short path: a socket's is at most 104 bytes). */
function sockDir() {
  if (g.bopsSshSocks && existsSync(/*turbopackIgnore: true*/ g.bopsSshSocks)) return g.bopsSshSocks;
  const base = /^[^\s:]{1,60}$/.test(tmpdir()) ? tmpdir() : "/tmp";
  return (g.bopsSshSocks = mkdtempSync(join(/*turbopackIgnore: true*/ base, "bops-ssh-")));
}

type Tunnel = {
  computerId: string;
  port: number;
  sock: string;
  host: string;
  child?: ChildProcess;
  /** Its ssh's socket is there: connected, its forward open. */
  up: boolean;
  closed: boolean;
  /** A try to bring it back, under way, and when the last one began. */
  trying?: Promise<void>;
  triedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
};

const running = (t: Tunnel) => t.up && !!t.child && t.child.exitCode === null && t.child.signalCode === null;

/**
 * A tunnel through `computerId`'s SSH to `port` on its loopback, up (SshError when it can't be), as the carrier of
 * a forward: each connection one through it. While it's open, one that drops (the computer restarted, the network
 * went) is brought back, waiting longer each time it can't be, never waking a computer that sleeps; a connection
 * meanwhile waits for the try under way. `host`: the computer's SSH address.
 */
export async function sshTunnel(computerId: string, port: number): Promise<{ host: string; carrier: Carrier }> {
  g.bopsSshCount = (g.bopsSshCount ?? 0) + 1;
  const t: Tunnel = { computerId, port, sock: join(/*turbopackIgnore: true*/ sockDir(), `${g.bopsSshCount}.sock`), host: "", up: false, closed: false, failures: 0 };
  try {
    await bringUp(t);
  } catch (e) {
    shut(t);
    throw e;
  }
  return { host: t.host, carrier: { via: "ssh", connect: () => through(t), close: () => shut(t) } };
}

async function bringUp(t: Tunnel) {
  const at = await sshPlace(t.computerId);
  t.host = at.host;
  if (!t.closed) await start(t, at);
}

/** ssh started for the tunnel: done once its socket is there (it's connected, and its forward is open), refused when it stops before. */
function start(t: Tunnel, at: SshPlace): Promise<void> {
  return new Promise((done, fail) => {
    rmSync(/*turbopackIgnore: true*/ t.sock, { force: true });
    // Only what ssh needs: none of this server's own keys go to it.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const child = spawn(/*turbopackIgnore: true*/ SSH_BIN(), sshArgs(at, t.sock, t.port), { stdio: ["ignore", "ignore", "pipe"], env: env as NodeJS.ProcessEnv });
    t.child = child;
    const began = Date.now();
    let said = "";
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (said = (said + d).slice(-1000)));
    let up = 0;
    let over = false;
    const look = setInterval(() => {
      if (existsSync(/*turbopackIgnore: true*/ t.sock)) {
        clearInterval(look);
        up = Date.now();
        t.up = true;
        done();
      } else if (Date.now() - began > UP_MS) child.kill("SIGKILL");
    }, 100);
    const gone = () => {
      if (over) return;
      over = true;
      clearInterval(look);
      if (t.child === child) {
        t.child = undefined;
        t.up = false;
      }
      rmSync(/*turbopackIgnore: true*/ t.sock, { force: true });
      if (!up) return fail(new SshError("no-answer", said.trim().slice(-200)));
      if (!t.closed) console.warn(`[ssh] the tunnel to ${t.computerId} port ${t.port} dropped: ${said.trim().slice(-200) || "ssh stopped"}`);
      lost(t, Date.now() - up);
    };
    // (A binary that can't start at all reports only an error, no exit.)
    child.once("error", gone);
    child.once("exit", gone);
  });
}

/**
 * One connection through the tunnel: at once while ssh runs, else once the try to bring it back is done (none under
 * way and none for a few seconds: one now, ahead of its wait), else refused, its page's 502.
 */
function through(t: Tunnel): net.Socket {
  const s = new net.Socket();
  const go = () => (!t.closed && running(t) ? s.connect({ path: t.sock }) : s.destroy(new Error("Its computer's SSH is down")));
  if (running(t)) return s.connect({ path: t.sock });
  if (Date.now() - (t.triedAt ?? 0) > ASK_MS) again(t);
  if (t.trying) void t.trying.then(go);
  else process.nextTick(go);
  return s;
}

/** Brought back later, after a wait that grows with each try that failed (back to a second after a run that lasted). */
function lost(t: Tunnel, ranMs = 0) {
  if (t.closed || t.timer) return;
  if (ranMs > 2 * BACK_MS) t.failures = 0;
  const wait = Math.min(BACK_MS, 1000 * 2 ** t.failures++);
  t.timer = setTimeout(() => {
    t.timer = undefined;
    again(t);
  }, wait);
  t.timer.unref?.();
}

/** A try to bring it back now, unless one is under way or it runs: never on a computer that sleeps (asked of Orgo, which doesn't wake it). */
function again(t: Tunnel) {
  if (t.closed || t.trying || running(t)) return;
  if (t.timer) clearTimeout(t.timer);
  t.timer = undefined;
  t.triedAt = Date.now();
  t.trying = (async () => {
    const c = await orgo.computer(t.computerId).catch((e: unknown) => e as Error);
    if (c instanceof Error || c.status !== "running") throw new SshError("asleep");
    if (!t.closed) await bringUp(t);
  })()
    .catch(() => lost(t))
    .finally(() => (t.trying = undefined));
}

/** The tunnel closed: ssh stopped (killed if it doesn't), its socket gone, and nothing brought back. */
function shut(t: Tunnel) {
  t.closed = true;
  if (t.timer) clearTimeout(t.timer);
  t.timer = undefined;
  const child = t.child;
  t.child = undefined;
  t.up = false;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 3000).unref();
  }
  rmSync(/*turbopackIgnore: true*/ t.sock, { force: true });
}
