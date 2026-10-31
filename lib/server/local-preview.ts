import "server-only";
import net from "node:net";

/*
 * An app's Local seen from the owner's Mac (Your Apps, Open preview): its dev server runs on its bot's
 * computer, and this Mac forwards http://localhost:<its port> to that same port there, over the tailnet or else
 * through the computer's SSH (a carrier: computer-ssh.ts), so the page's origin is the same as on the computer's
 * screens, where the user's Google sign in is set up, and hot reload's websocket goes through as any request does. One forward per Mac port: another app's preview on the same port
 * takes it over (so two apps never share cookies on one origin). Loopback only (127.0.0.1 and ::1, so localhost
 * always lands on it, with no firewall prompt), and only for a request that names localhost (or 127.0.0.1, or
 * [::1]) on that port as its Host: a page elsewhere that points its own name at 127.0.0.1 gets a 403. Its target
 * is fixed when it opens, from the bot's tailnet address (or its carrier) and Local's own port: nothing a request
 * says changes it. It closes on Local's stop, when its tab closes, after 20 minutes with no connection, and with
 * the server, its carrier with it.
 */

/** How long a forward stays with no connection before it closes itself. */
export const IDLE_MS = 20 * 60_000;
/** The most of a request's head read before its Host is checked, and how long it may take to come. */
const HEAD_MAX = 16 * 1024;
const HEAD_MS = 5000;

/**
 * What carries a forward's connections to its computer when that isn't a plain connect to its address over the
 * tailnet: an SSH tunnel's (computer-ssh.ts), each connection one through it. It's the forward's once given to
 * openForward, and closes with it.
 */
export type Carrier = { via: "ssh"; connect: () => net.Socket; close: () => void };

type Forward = {
  key: string;
  app: string;
  macPort: number;
  host: string;
  port: number;
  carrier?: Carrier;
  servers: net.Server[];
  sockets: Set<net.Socket>;
  last: number;
};

const g = globalThis as unknown as { bopsPreviewForwards?: Map<number, Forward>; bopsPreviewSweep?: ReturnType<typeof setInterval>; bopsPreviewExit?: boolean };
const forwards = (g.bopsPreviewForwards ??= new Map<number, Forward>());

/** Why a forward couldn't open: something else answers on that port of this Mac. */
export class ForwardError extends Error {
  code: "MAC_PORT_BUSY";
  constructor(port: number) {
    super(`Port ${port} on this Mac is in use, so it opens on its screen.`);
    this.code = "MAC_PORT_BUSY";
  }
}

/** Whether anything answers on `host`:`port` of this Mac (a connect that's taken). */
const answers = (host: string, port: number) =>
  new Promise<boolean>((done) => {
    const s = net.connect({ host, port });
    const end = (v: boolean) => {
      s.destroy();
      done(v);
    };
    s.setTimeout(800, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });

const reply = (sock: net.Socket, status: string, words: string) => {
  const body = `${words}\n`;
  sock.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
};

/** The Host header of a request's head, lowercase (undefined: none yet). */
const hostOf = (head: string) => /^host:[ \t]*([^\r\n]*)$/im.exec(head)?.[1]?.trim().toLowerCase();

/** One connection to a forward: its head read and its Host checked, then piped both ways to its target. */
function take(f: Forward, sock: net.Socket) {
  f.sockets.add(sock);
  f.last = Date.now();
  sock.once("close", () => {
    f.sockets.delete(sock);
    f.last = Date.now();
  });
  sock.on("error", () => sock.destroy());
  let head = Buffer.alloc(0);
  const t = setTimeout(() => sock.destroy(), HEAD_MS);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0 && head.length < HEAD_MAX) return;
    clearTimeout(t);
    sock.off("data", onData);
    sock.pause();
    const host = hostOf(head.subarray(0, end < 0 ? head.length : end).toString("latin1"));
    const ok = new Set([`localhost:${f.macPort}`, `127.0.0.1:${f.macPort}`, `[::1]:${f.macPort}`]);
    if (!host || !ok.has(host)) return reply(sock, "403 Forbidden", `Open it at localhost:${f.macPort}.`);
    const up = f.carrier ? f.carrier.connect() : net.connect({ host: f.host, port: f.port });
    let open = false;
    up.setTimeout(10_000, () => {
      if (!open) up.destroy(new Error("timeout"));
    });
    up.once("connect", () => {
      open = true;
      up.setTimeout(0);
      up.write(head);
      sock.pipe(up);
      up.pipe(sock);
      sock.resume();
    });
    up.on("error", () => {
      if (!open) reply(sock, "502 Bad Gateway", `Bops can't reach ${f.app} on its computer right now.`);
      else sock.destroy();
    });
    sock.once("close", () => up.destroy());
    up.once("close", () => sock.destroy());
  };
  sock.on("data", onData);
}

/** Listen on one loopback address; an IPv6 loopback the Mac doesn't have is no matter. */
const listenOn = (server: net.Server, host: string, port: number) =>
  new Promise<boolean>((done, fail) => {
    server.once("error", (e: NodeJS.ErrnoException) => (host === "::1" && (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT") ? done(false) : fail(e)));
    server.listen({ host, port, exclusive: true }, () => done(true));
  });

/**
 * A forward opened (or its target moved, when this app's is open there already) on `macPort` of this Mac to
 * `host`:`port`, or through `carrier` (closed with the forward, or at once when it can't open, and the one it had
 * closed when it moves to another or to none). Another app's on the same port is closed first (`replaced`: its
 * key, so the window closes its tab). Refused (ForwardError) when something that isn't a forward of Bops' answers
 * on that port.
 */
export async function openForward(o: { key: string; app?: string; macPort: number; host: string; port: number; carrier?: Carrier }): Promise<{ replaced?: string }> {
  const was = forwards.get(o.macPort);
  if (was && was.key === o.key) {
    if (was.carrier !== o.carrier) was.carrier?.close();
    was.host = o.host;
    was.port = o.port;
    was.carrier = o.carrier;
    was.last = Date.now();
    return {};
  }
  if (was) closeOne(was);
  if (await macPortBusy(o.macPort)) {
    o.carrier?.close();
    throw new ForwardError(o.macPort);
  }
  const f: Forward = { key: o.key, app: o.app ?? o.key.split("/").at(-2) ?? "it", macPort: o.macPort, host: o.host, port: o.port, carrier: o.carrier, servers: [], sockets: new Set(), last: Date.now() };
  for (const host of ["127.0.0.1", "::1"]) {
    const server = net.createServer((sock) => take(f, sock));
    try {
      if (await listenOn(server, host, o.macPort)) f.servers.push(server);
    } catch (e) {
      server.close();
      for (const s of f.servers) s.close();
      o.carrier?.close();
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw new ForwardError(o.macPort);
      throw e;
    }
  }
  forwards.set(o.macPort, f);
  sweeping();
  return was ? { replaced: was.key } : {};
}

function closeOne(f: Forward) {
  if (forwards.get(f.macPort) === f) forwards.delete(f.macPort);
  for (const s of f.servers) s.close();
  for (const s of f.sockets) s.destroy();
  f.sockets.clear();
  f.carrier?.close();
}

/** Whether something that isn't a forward of Bops' answers on `macPort` of this Mac (openForward would refuse it). */
export const macPortBusy = async (macPort: number) => !forwards.has(macPort) && ((await answers("127.0.0.1", macPort)) || (await answers("::1", macPort)));

/** The forward of `key` ("<ws>/<app>/<site>", or every one of an app's with "<ws>/<app>/") closed; none is no matter. */
export function closeForward(key: string) {
  for (const f of [...forwards.values()]) if (f.key === key || (key.endsWith("/") && f.key.startsWith(key))) closeOne(f);
}

/** The forward open on `macPort` of this Mac, if any: whose it is and where it goes (`via`: what carries it, when something does). */
export const forwardOn = (macPort: number) => {
  const f = forwards.get(macPort);
  return f && { key: f.key, host: f.host, port: f.port, ...(f.carrier ? { via: f.carrier.via } : {}) };
};

/** The forward open for `key`, if any. */
export const forwardOf = (key: string) => {
  const f = [...forwards.values()].find((x) => x.key === key);
  return f && { macPort: f.macPort, host: f.host, port: f.port, ...(f.carrier ? { via: f.carrier.via } : {}) };
};

/** Forwards with no connection for IDLE_MS closed (`at`: now, given in tests). */
export function sweepForwards(at = Date.now()) {
  for (const f of [...forwards.values()]) if (!f.sockets.size && at - f.last >= IDLE_MS) closeOne(f);
}

/** The sweep each minute while any forward is open, and every forward closed with the server. */
function sweeping() {
  if (!g.bopsPreviewSweep) {
    g.bopsPreviewSweep = setInterval(() => {
      sweepForwards();
      if (!forwards.size && g.bopsPreviewSweep) {
        clearInterval(g.bopsPreviewSweep);
        g.bopsPreviewSweep = undefined;
      }
    }, 60_000);
    g.bopsPreviewSweep.unref?.();
  }
  if (!g.bopsPreviewExit) {
    g.bopsPreviewExit = true;
    process.once("exit", () => {
      for (const f of [...forwards.values()]) closeOne(f);
    });
  }
}
