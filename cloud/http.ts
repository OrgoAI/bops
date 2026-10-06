import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { CloudUser } from "./auth.ts";

/**
 * The few HTTP pieces every cloud module shares: a route table entry, an upgrade handler, and
 * helpers to read a body and answer with JSON.
 */

/** A route: method + path pattern. `auth: "user"` routes get the signed-in user (Bearer Orgo key); "public" ones don't. */
export type Route = {
  method: string;
  /** Exact path ("/v1/session") or a prefix ending in "/*" ("/proxy/openai/*"). */
  path: string;
  auth: "user" | "public";
  handle: (req: IncomingMessage, res: ServerResponse, ctx: { user: CloudUser | null; url: URL }) => Promise<void>;
};

/** A WebSocket upgrade handler for a path prefix ("/v1/connect", "/proxy/openai/*"). Always for a signed-in user. */
export type Upgrade = {
  path: string;
  handle: (req: IncomingMessage, socket: Duplex, head: Buffer, ctx: { user: CloudUser; url: URL }) => void;
};

export const matches = (pattern: string, path: string) =>
  pattern.endsWith("/*") ? path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1)) : path === pattern;

/** Read the whole request body (up to `max` bytes; past it, the request is refused with 413). */
export async function readBody(req: IncomingMessage, max = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(req: IncomingMessage, max = 1024 * 1024): Promise<T> {
  const body = await readBody(req, max);
  try {
    return JSON.parse(body.toString("utf8") || "{}") as T;
  } catch {
    throw new HttpError(400, "Body isn't JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(data.length), "cache-control": "no-store" });
  res.end(data);
}

/** An error that becomes an HTTP answer: status plus a message safe to show the caller. */
export class HttpError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Refuse a WebSocket upgrade with an HTTP status. */
export function refuseUpgrade(socket: Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
