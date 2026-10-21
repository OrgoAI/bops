import "server-only";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { guardAddresses } from "./safe-fetch";

/**
 * The gate every request of a page rendered in a browser goes through (lib/server/web-render.ts). The
 * browser (a hidden window in the Bops app, desktop/render.cjs) is told to use this as its proxy for
 * everything, this Mac's own addresses included, so it never looks a name up or connects anywhere by
 * itself: this does, with the same checks as safeFetch (lib/server/safe-fetch.ts guardAddresses). The
 * page itself, its scripts, styles, images, frames, fetches and redirects, and its websockets (which a
 * browser always opens through a proxy as a tunnel) are each checked, and each connection goes to the
 * very addresses that were checked, so a name that answers with a private address a moment later (DNS
 * rebinding) can't slip one in.
 *
 * - https and websockets come as CONNECT host:port: refused unless the port is 80 or 443 (or a test
 *   fixture's) and every address the name has is public; then a plain tunnel to a checked address;
 * - plain http comes as a request for a full address: the same checks, then the request is passed on to
 *   a checked address and the answer passed back, nothing followed (the browser follows a redirect by
 *   asking again, and that's checked too);
 * - anything else (a request for a path alone, an upgrade not tunnelled) is refused.
 *
 * It listens on 127.0.0.1 only, on a port the system picks, while one page is rendered. It reaches only
 * what a page fetch may reach, so another program on this Mac using it meanwhile gains nothing.
 */

/** How long one connection may take to open (the page's own clock, 20 seconds, bounds the rest). */
const CONNECT_MS = 10_000;
/** The most connections open at once (a page with hundreds of images still loads, a few at a time). */
const MAX_SOCKETS = 64;
/** Headers that are about one hop, never passed on. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);

export type Guard = {
  /** The port it listens on, at 127.0.0.1. */
  port: number;
  /** Each address it refused, as asked ("10.0.0.1:80", "http://localhost:3210/x"), at most 50. */
  refused: string[];
  /** Stops listening and closes every connection still open. */
  close(): void;
};

/** A TCP connection to the first of `addresses` that answers. */
function connectTo(addresses: LookupAddress[], port: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = (last?: Error) => {
      if (signal.aborted) return reject(signal.reason);
      const a = addresses[i++];
      if (!a) return reject(last ?? new Error("no address"));
      const s = net.connect({ host: a.address, port, family: a.family });
      const timer = setTimeout(() => s.destroy(new Error("timed out")), CONNECT_MS);
      s.once("connect", () => {
        clearTimeout(timer);
        s.off("error", failed);
        resolve(s);
      });
      const failed = (e: Error) => {
        clearTimeout(timer);
        next(e);
      };
      s.once("error", failed);
    };
    next();
  });
}

/** "host:port" from a CONNECT line ("example.com:443", "[2606:4700::1]:443"), or null. */
function hostPort(target: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-f:.%]+\]|[^:[\]\s/]+):(\d{1,5})$/i.exec(target.trim());
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

/**
 * Starts the gate for one rendered page, at `top` (its address: a page asked for by its bare address may
 * load more from that same address). Resolves once it listens.
 */
export async function openGuard(top: URL): Promise<Guard> {
  const reached = new Set<string>();
  if (net.isIP(top.hostname.replace(/^\[(.*)\]$/, "$1"))) reached.add(top.hostname.replace(/^\[(.*)\]$/, "$1"));
  const stop = new AbortController();
  const sockets = new Set<Duplex>();
  const refused: string[] = [];
  const track = (s: Duplex) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
  };
  const deny = (what: string) => {
    if (refused.length < 50) refused.push(what);
  };

  const server = http.createServer(async (req, res) => {
    const raw = req.url ?? "";
    // Refused as a connection that closed, so the page sees a network error, never an answer it could read.
    const refuse = () => {
      deny(raw);
      res.socket?.destroy();
    };
    if (!/^http:\/\//i.test(raw)) {
      deny(raw);
      res.writeHead(400, { Connection: "close" }).end();
      return;
    }
    let upstream: http.ClientRequest | undefined;
    try {
      const { url, addresses } = await guardAddresses(raw, reached, stop.signal);
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
      headers.connection = "close";
      upstream = http.request({
        host: addresses[0].address,
        family: addresses[0].family,
        port: url.port ? Number(url.port) : 80,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        agent: false,
        signal: stop.signal,
        timeout: CONNECT_MS,
      });
      upstream.on("timeout", () => upstream?.destroy(new Error("timed out")));
      upstream.on("response", (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
        up.on("error", () => res.destroy());
      });
      upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502, { Connection: "close" }).end()));
      req.pipe(upstream);
    } catch {
      refuse();
    }
  });
  server.maxConnections = MAX_SOCKETS;
  server.on("connection", track);

  // https and websockets: a tunnel to a checked address, or 403.
  server.on("connect", async (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    const target = hostPort(req.url ?? "");
    const refuse = () => {
      deny(req.url ?? "");
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    if (!target) return refuse();
    let remote: net.Socket;
    try {
      const { addresses } = await guardAddresses(`${target.port === 80 ? "http" : "https"}://${target.host}:${target.port}/`, reached, stop.signal);
      remote = await connectTo(addresses, target.port, stop.signal);
    } catch {
      return refuse();
    }
    if (client.destroyed) return void remote.destroy();
    track(remote);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) remote.write(head);
    remote.pipe(client);
    client.pipe(remote);
    remote.once("close", () => client.destroy());
    client.once("close", () => remote.destroy());
  });

  // An upgrade that isn't a tunnel (a websocket asked for as plain http): never passed on.
  server.on("upgrade", (req: http.IncomingMessage, client: Duplex) => {
    deny(req.url ?? "");
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    refused,
    close() {
      stop.abort(new Error("closed"));
      server.close();
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
  };
}
