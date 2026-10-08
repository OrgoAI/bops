import "server-only";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";

/**
 * The macOS sandbox (Seatbelt) a Mac task's executor runs in.
 *
 * `codex exec-server` runs whatever the agent asks for on this Mac: the browser tools, but also a shell
 * (exec_command), file reads and writes, with the user's own permissions. Neither the Agents API nor
 * the executor has a setting that leaves the shell out, and the executor only sandboxes a command when
 * the caller asks it to. So Bops starts the executor itself inside a sandbox of its own, which holds
 * for everything it does and everything it starts:
 * - it can start only Codex itself and the runtime of the browser tools (exact paths): no shell, no
 *   osascript, open, curl or any other program;
 * - it reads the system, but nothing in the user's home (or other homes, other disks, temp folders)
 *   beyond the task's own folder and the folders those programs live in;
 * - it writes only in the task's own folder and its browser tools' sockets folder (both deleted when
 *   the task ends), and can't run code from there;
 * - its network reaches OpenAI (the port of its remote) and the task's own Chrome on this Mac, nothing else
 *   (Bops answers its app calls on a socket in its sockets folder: composio.ts serveApps);
 * - it can't send Apple Events, so it can't script other apps.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type ExecutorSandbox = {
  /** The task's own folder: the only place it can write. */
  taskDir: string;
  /** The folder its browser tools keep their sockets in (local.ts taskSockets): the task's own too, under a path short enough for one. */
  sockets: string;
  /** The programs it may start, by exact path. */
  programs: string[];
  /** Folders it may read in places that are otherwise closed (the user's home): where those programs live. */
  readable: string[];
  /** The port its link to OpenAI uses. */
  remotePort: number;
  /** The DevTools port of the task's Chrome on this Mac. */
  cdpPort: number;
};

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Closed to the executor: the user's home and every other, other disks, and temp folders other apps share. */
const closed = () => [...new Set([homedir(), "/Users", "/Volumes", "/Network", "/private/tmp", "/private/var/folders"].map(realOr))];
/** A folder that holds a closed one (the home, /Users, /) is never opened, whatever program lives there. */
const opensClosed = (dir: string, shut: string[]) => shut.some((c) => c === dir || c.startsWith(dir.endsWith(sep) ? dir : dir + sep));

/** System services a program needs to start, log, look up names and check TLS certificates. Not the pasteboard, Launch Services, preferences or anything that reaches other apps. */
const SERVICES = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.system.DirectoryService.libinfo_v1",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.logd",
  "com.apple.logd.events",
  "com.apple.diagnosticd",
  "com.apple.bsd.dirhelper",
  "com.apple.SystemConfiguration.DNSConfiguration",
  "com.apple.SystemConfiguration.configd",
  "com.apple.networkd",
  "com.apple.trustd",
  "com.apple.trustd.agent",
  "com.apple.ocspd",
  "com.apple.SecurityServer",
];

const list = (name: string, values: string[], filter: string) => values.map((_, i) => `(${filter} (param "${name}_${i}"))`).join(" ");
const params = (name: string, values: string[]) => values.flatMap((v, i) => ["-D", `${name}_${i}=${v}`]);

/** The arguments for /usr/bin/sandbox-exec that run `command` in the executor's sandbox. */
export function sandboxArgs(box: ExecutorSandbox, command: string[]): string[] {
  const programs = [...new Set(box.programs.flatMap((p) => [p, realOr(p)]))];
  const shut = closed();
  const readable = [...new Set(box.readable.map(realOr))].filter((d) => !opensClosed(d, shut));
  const taskDir = realOr(box.taskDir);
  const sockets = realOr(box.sockets);
  // Seatbelt takes the last rule that matches, so each narrower allow comes after the broader deny.
  const profile = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec ${list("PROGRAM", programs, "literal")})
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow file-read*)
(deny file-read* ${list("CLOSED", shut, "subpath")})
(allow file-read* (subpath (param "TASK_DIR")) (subpath (param "SOCKETS")) ${list("READABLE", readable, "subpath")} ${list("PROGRAM", programs, "literal")})
(allow file-read-metadata (path-ancestors (param "TASK_DIR")) (path-ancestors (param "SOCKETS")) ${list("READABLE", readable, "path-ancestors")} ${list("PROGRAM", programs, "path-ancestors")})
(allow file-write* (subpath (param "TASK_DIR")) (subpath (param "SOCKETS")))
(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (subpath "/dev/fd"))
(allow file-map-executable)
(deny file-map-executable (subpath (param "TASK_DIR")) (subpath (param "SOCKETS")))
(allow network-outbound (remote tcp (param "REMOTE")) (remote ip (param "CDP")) (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog"))
(allow network-bind network-inbound (local unix-socket (subpath (param "TASK_DIR"))) (local unix-socket (subpath (param "SOCKETS"))))
(allow network-outbound (remote unix-socket (subpath (param "TASK_DIR"))) (remote unix-socket (subpath (param "SOCKETS"))))
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow mach-lookup ${SERVICES.map((s) => `(global-name "${s}")`).join(" ")})
(deny appleevent-send)
`;
  return [
    "-p",
    profile,
    "-D",
    `TASK_DIR=${taskDir}`,
    "-D",
    `SOCKETS=${sockets}`,
    ...params("PROGRAM", programs),
    ...params("READABLE", readable),
    ...params("CLOSED", shut),
    "-D",
    `REMOTE=*:${box.remotePort}`,
    "-D",
    `CDP=localhost:${box.cdpPort}`,
    ...command,
  ];
}

/** The port a remote URL connects to. */
export function remotePort(url: string) {
  const u = new URL(url);
  return Number(u.port) || (u.protocol === "ws:" || u.protocol === "http:" ? 80 : 443);
}

/** The start of a file: enough for a script's #! line. */
const head = (path: string) => {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(256);
    return buf.subarray(0, readSync(fd, buf, 0, 256, 0)).toString();
  } finally {
    closeSync(fd);
  }
};

/**
 * How to run Codex in the sandbox: its own binary, and the programs and folders that takes. npm's
 * `codex` is a Node script that starts the binary for this Mac's chip, so Bops runs that binary
 * directly; any other script runs through its interpreter.
 */
export function codexInSandbox(found: string, path: string): { command: string; programs: string[]; readable: string[] } {
  const real = realOr(found);
  const top = head(real);
  if (!top.startsWith("#!")) return { command: real, programs: [real], readable: [dirname(real)] };
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  const pkg = dirname(dirname(real));
  const platform = `codex-darwin-${arch}`;
  for (const vendor of [join(pkg, "node_modules", "@openai", platform, "vendor"), join(dirname(pkg), platform, "vendor"), join(pkg, "vendor")]) {
    const bin = join(vendor, triple, "bin", "codex");
    if (existsSync(bin)) return { command: realOr(bin), programs: [realOr(bin)], readable: [join(realOr(vendor), triple)] };
  }
  const shebang = top.split("\n")[0].slice(2).trim().split(/\s+/);
  const viaEnv = shebang[0] === "/usr/bin/env";
  const interpreter = viaEnv ? which(shebang[1], path) : shebang[0];
  const programs = [real, ...(viaEnv ? ["/usr/bin/env"] : []), ...(interpreter ? [interpreter] : [])];
  return { command: real, programs, readable: [dirname(real), ...(interpreter ? [installDir(interpreter)] : [])] };
}

const which = (name: string | undefined, path: string) => {
  if (!name) return undefined;
  for (const dir of path.split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
};

/** The folder a program is installed in, with what it loads: two levels up from bin/node, or an app bundle. */
export function installDir(program: string) {
  const real = realOr(program);
  const app = real.indexOf(`.app${sep}`);
  return app > 0 ? real.slice(0, app + 4) : dirname(dirname(real));
}
