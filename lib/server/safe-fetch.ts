import "server-only";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";
import type { Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import { appVersion } from "./app-version";

/**
 * Fetching a public web page for a bot (web_fetch in chat, page monitors), safely. Bops runs on the
 * user's Mac, next to its own API on 127.0.0.1:3210, the bots' Chrome DevTools, the relay, the
 * user's home network and their tailnet, and an address a model was handed (by a page, an email, a
 * message from someone else) must never reach any of those. So:
 *
 * - only http and https, only ports 80 and 443, never a user name or password in the address;
 * - names like localhost, *.local, *.internal and *.ts.net are refused before any lookup, and so is a
 *   bare name with no dot (it would resolve through the network's search domains);
 * - the name is looked up and every address it has is checked (loopback, private, CGNAT and so
 *   tailnets, link-local and cloud metadata, multicast, reserved; IPv6 loopback, unique-local,
 *   link-local, IPv4-mapped and IPv4 inside NAT64), and so is every network this Mac is on, read fresh
 *   each time (on a home network with IPv6 the router, printers and NAS have public addresses no fixed
 *   range covers). One bad address refuses the whole name;
 * - the connection goes to the addresses that were checked (a custom `lookup`), so a name that
 *   answers differently a moment later (DNS rebinding) can't swap in a private one;
 * - redirects are followed by hand, at most 5, each new address checked the same way, and never to a
 *   bare address the site's name didn't have (a home's own public address, reached from inside);
 * - 10 seconds for everything, at most 2 MB of page read (cut there, not refused), and only text
 *   that reads as a page: HTML, plain text, JSON or XML.
 *
 * The same checks guard a page read in a browser (lib/server/web-render.ts): every request it makes goes
 * through lib/server/render-guard.ts, which asks guardAddresses below.
 *
 * It uses node:http and node:https rather than fetch, because Next patches the global fetch and
 * fetch has no way to pin the address. Errors are plain English, ready to show: FetchRefused for an
 * address Bops won't open at all (or a file that isn't a page), a plain Error when the site couldn't
 * be reached or read.
 *
 * Tests only: BOPS_FETCH_ALLOW is a comma list of host:port (e.g. "127.0.0.1:54321") let through
 * despite all of the above, for a local fixture server. It never lets through port 3210 (Bops itself),
 * 8897 (the relay) or 9200 to 9399 (bots' and computers' DevTools).
 */

/** An address Bops won't open: not http(s), an odd port, a password in it, this Mac or a private network, or not a page. */
export class FetchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefused";
  }
}

export type Fetched = {
  /** Where the page came from in the end, after redirects. */
  url: string;
  status: number;
  /** The media type alone, lowercase ("text/html"), no parameters. */
  contentType: string;
  body: string;
  /** The page was bigger than maxBytes and only its start was read. */
  truncated: boolean;
};

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** IPv4 ranges no page fetch may reach. IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked against these too. */
const V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches this Mac
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, and Tailscale's tailnet addresses
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, and cloud metadata at 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const)
  V4.addSubnet(net, bits, "ipv4");

/** IPv6 ranges no page fetch may reach. Kept apart from V4: an IPv6 rule here would match every IPv4 address. */
const V6 = new BlockList();
for (const [net, bits] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // old site-local
  ["ff00::", 8], // multicast
] as const)
  V6.addSubnet(net, bits, "ipv6");

/** IPv4-mapped IPv6: refused whatever the address inside, since no public name should answer with one. */
const MAPPED = new BlockList();
MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/** Well-known NAT64 (an IPv6-only network reaching IPv4): allowed when the IPv4 address inside is public. */
const NAT64 = new BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");

/** The 8 16-bit words of a valid IPv6 address (one isIP said is 6, zone already removed). */
function words(v6: string): number[] {
  let s = v6;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array<string>(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
}

/**
 * Whether an IP address is one a page fetch must never reach (this Mac, a private or special
 * network). Takes "127.0.0.1", "::1" or "[::1]"; anything that isn't an IP address counts as blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const a = address.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const kind = isIP(a);
  if (kind === 4) return V4.check(a, "ipv4");
  if (kind !== 6) return true;
  if (MAPPED.check(a, "ipv6") || V6.check(a, "ipv6") || V4.check(a, "ipv6")) return true;
  if (NAT64.check(a, "ipv6")) {
    const w = words(a);
    return V4.check(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`, "ipv4");
  }
  return false;
}

/** Subnets shorter than these on this Mac's connections are left to the fixed ranges (an odd setup shouldn't refuse half the internet). */
const LOCAL_MIN_BITS = { ipv4: 16, ipv6: 48 } as const;

/**
 * The networks this Mac is on right now, and its own addresses: read fresh each time (it moves between
 * networks). Loopback is in the fixed ranges already.
 */
function localNetworks(): BlockList {
  const list = new BlockList();
  try {
    for (const nic of Object.values(networkInterfaces()))
      for (const a of nic ?? []) {
        if (a.internal) continue;
        const family = a.family === "IPv6" ? "ipv6" : "ipv4";
        const address = a.address.replace(/%.*$/, "");
        if (!isIP(address)) continue;
        list.addAddress(address, family);
        const bits = Number(a.cidr?.split("/")[1]);
        if (Number.isInteger(bits) && bits >= LOCAL_MIN_BITS[family]) list.addSubnet(address, bits, family);
      }
  } catch {}
  return list;
}

/** Whether an IP address is this Mac's own, or on a network it's on. */
function onThisNetwork(address: string, nets = localNetworks()): boolean {
  const a = address.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const kind = isIP(a);
  return kind ? nets.check(a, kind === 6 ? "ipv6" : "ipv4") : false;
}

/** A host name that only means something on this Mac or a private network. */
function privateName(host: string): boolean {
  if (!host.includes(".")) return true;
  return /(^|\.)(localhost|local|internal|ts\.net|home\.arpa)$/.test(host);
}

/** The host without IPv6 brackets or a trailing dot, lowercase (URL already lowercased it). */
const bare = (hostname: string) => hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
const portOf = (u: URL) => (u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80);

/** Ports BOPS_FETCH_ALLOW can never open: Bops itself, the relay, and DevTools for bots and computers. */
// Bops itself, on 3210 or a partner build's own port (desktop/brand.cjs).
const neverPort = (port: number) => port === 3210 || port === Number(process.env.PORT) || port === 8897 || (port >= 9200 && port <= 9399);

/** A test fixture's host:port named in BOPS_FETCH_ALLOW (see the top of this file). */
function allowedForTests(u: URL): boolean {
  const list = process.env.BOPS_FETCH_ALLOW;
  if (!list) return false;
  const port = portOf(u);
  if (neverPort(port)) return false;
  const key = `${u.hostname}:${port}`.toLowerCase();
  return list.split(",").some((entry) => entry.trim().toLowerCase() === key);
}

const PRIVATE = "That address is on this Mac or a private network, so Bops won't open it.";

/**
 * The checks that need no lookup: a valid http(s) address, no password, port 80 or 443, and not a
 * private name or address. Returns the parsed URL or throws FetchRefused. Cheap enough to run when a
 * user or bot first gives an address (a new page monitor), before anything is fetched.
 */
export function checkUrl(raw: string | URL): URL {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new FetchRefused("That isn't a web address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchRefused("Bops only opens http and https web addresses.");
  if (u.username || u.password) throw new FetchRefused("Bops won't open an address with a user name or password in it.");
  if (allowedForTests(u)) return u;
  const port = portOf(u);
  if (port !== 80 && port !== 443) throw new FetchRefused(`Bops only opens web pages on the usual ports (80 and 443), not ${port}.`);
  const host = bare(u.hostname);
  if (isIP(host) ? isBlockedAddress(host) || onThisNetwork(host) : privateName(host)) throw new FetchRefused(PRIVATE);
  return u;
}

/** Rejects with the signal's reason once it fires; `p` is left to settle on its own. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", stop), resolve(v)),
      (e) => (signal.removeEventListener("abort", stop), reject(e)),
    );
  });
}

/** Every address the URL's host has, each one checked (an IP in the URL is its own answer). */
async function addressesOf(u: URL, signal: AbortSignal): Promise<LookupAddress[]> {
  const host = bare(u.hostname);
  const family = isIP(host);
  if (family) return [{ address: host, family }];
  let found: LookupAddress[];
  try {
    found = await untilAborted(lookup(host, { all: true }), signal);
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error(`Couldn't find a website called ${host}.`);
  }
  if (!found.length) throw new Error(`Couldn't find a website called ${host}.`);
  const nets = localNetworks();
  if (!allowedForTests(u) && found.some((a) => isBlockedAddress(a.address) || onThisNetwork(a.address, nets))) throw new FetchRefused(`${host} points to this Mac or a private network, so Bops won't open it.`);
  return found;
}

/**
 * Where a browser rendering a page may connect, for one address it asks for (lib/server/render-guard.ts,
 * the guard every request of a rendered page goes through): checkUrl's checks, then every address the
 * name has, checked as safeFetch checks them. A bare address only when it's one `reached` already has (one
 * a name on this page had, or the page's own), as safeFetch's redirects; the addresses found are added to
 * it. Throws FetchRefused, or a plain Error when the name isn't found or `signal` fires.
 */
export async function guardAddresses(raw: string | URL, reached: Set<string>, signal: AbortSignal): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const u = checkUrl(raw);
  const host = bare(u.hostname);
  if (isIP(host) && !reached.has(host) && !allowedForTests(u)) throw new FetchRefused("That page asked for a bare network address, so Bops won't open it.");
  const addresses = await addressesOf(u, signal);
  for (const a of addresses) reached.add(a.address);
  return { url: u, addresses };
}

/** A `lookup` that answers with the addresses already checked, never asking DNS again. */
function pinned(addresses: LookupAddress[]): LookupFunction {
  return (_host, options, callback) => {
    const fit = options?.family === 4 || options?.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
    const list = fit.length ? fit : addresses;
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
}

const userAgent = () => `Bops/${appVersion() ?? "dev"} (+https://bops.bot)`;

/** One GET to one checked address; resolves with the response once its headers are in. */
function get(u: URL, addresses: LookupAddress[], signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).request(
      {
        protocol: u.protocol,
        hostname: bare(u.hostname),
        port: portOf(u),
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          "User-Agent": userAgent(),
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,application/xml;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
        },
        // A connection of its own: never a pooled socket another lookup opened.
        agent: false,
        lookup: pinned(addresses),
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

/** Media types that read as a page. */
const PAGE_TYPE = /^(text\/(html|plain|xml)|application\/(json|xml|xhtml\+xml|[\w.-]+\+(json|xml)))$/;

function notAPage(type: string): FetchRefused {
  if (!type) return new FetchRefused("That address didn't say what kind of file it is, so Bops won't read it.");
  if (type === "application/pdf") return new FetchRefused("That address is a PDF, not a page Bops can read.");
  const kind = type.split("/")[0];
  if (kind === "image" || kind === "video" || kind === "audio") return new FetchRefused(`That address is ${kind === "image" ? "an image" : kind === "video" ? "a video" : "audio"}, not a page Bops can read.`);
  return new FetchRefused(`That address is a ${type} file, not a page Bops can read.`);
}

/** The body as bytes, unzipped, stopping at `max` bytes (and closing the connection there). */
async function readBody(res: http.IncomingMessage, max: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const encoding = String(res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  let unzip: Transform | undefined;
  if (encoding === "gzip" || encoding === "x-gzip") unzip = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  else if (encoding === "deflate") unzip = zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  else if (encoding === "br") unzip = zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  else if (encoding !== "identity" && encoding !== "") {
    res.destroy();
    throw new Error("That page came in a compressed format Bops can't read.");
  }
  if (unzip) {
    const u = unzip;
    res.on("error", (e) => u.destroy(e));
    res.pipe(u);
  }
  const stream: Readable = unzip ?? res;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (size + chunk.length > max) {
        chunks.push(chunk.subarray(0, max - size));
        size = max;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    // Leaving early (the cap, an error) closes the connection rather than reading the rest.
    if (!res.complete || truncated) res.destroy();
    unzip?.destroy();
  }
  return { bytes: Buffer.concat(chunks, size), truncated };
}

/** Text from the bytes in the charset the page names (the header, or for HTML a meta tag), else UTF-8. */
function decode(bytes: Buffer, charset: string | undefined, html: boolean): string {
  const label = charset || (html ? /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(bytes.subarray(0, 4096).toString("latin1"))?.[1] : undefined);
  try {
    return new TextDecoder(label || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** A network failure in plain words. */
function plain(e: unknown, u: URL, signal: AbortSignal): Error {
  if (e instanceof FetchRefused) return e;
  if (signal.aborted) return new Error(`${bare(u.hostname)} took too long to answer.`);
  const err = e as NodeJS.ErrnoException;
  const code = err?.code ?? "";
  if (code === "ECONNREFUSED") return new Error(`${bare(u.hostname)} refused the connection.`);
  if (code === "ECONNRESET" || /socket hang up/i.test(err?.message ?? "")) return new Error(`${bare(u.hostname)} closed the connection.`);
  if (code === "ETIMEDOUT") return new Error(`${bare(u.hostname)} took too long to answer.`);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL") return new Error(`Couldn't reach ${bare(u.hostname)}.`);
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY/i.test(code)) return new Error(`${bare(u.hostname)} has a security certificate Bops can't trust.`);
  if (err instanceof Error && /^(Couldn't|That )/.test(err.message)) return err;
  return new Error(`Couldn't open that page${code ? ` (${code})` : ""}.`);
}

/**
 * GET a public web page, with every check above. Returns the final URL, the status (a 404 or 500
 * comes back with its body; callers decide), the media type and the text. A redirect loop, a
 * private address anywhere along the way, a file that isn't a page or a slow site throws.
 */
export async function safeFetch(url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<Fetched> {
  const maxBytes = Math.max(1, opts.maxBytes ?? MAX_BYTES);
  const signal = AbortSignal.timeout(Math.max(1, opts.timeoutMs ?? TIMEOUT_MS));
  let u = checkUrl(url);
  // Every address the pages so far were reached at: a redirect to a bare address must be one of them.
  const reached = new Set<string>();
  for (let hop = 0; ; hop++) {
    try {
      const addresses = await addressesOf(u, signal);
      for (const a of addresses) reached.add(a.address);
      const res = await get(u, addresses, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECTS.has(status) && location) {
        res.destroy();
        if (hop >= MAX_REDIRECTS) throw new Error("That page sent Bops through too many redirects.");
        let next: URL;
        try {
          next = new URL(location, u);
        } catch {
          throw new Error("That page redirected to an address that isn't valid.");
        }
        u = checkUrl(next);
        // A page sent to a bare address (not a name): only one its own name had. Otherwise it could be the
        // home's own public address, which a home router answers from inside as itself.
        if (isIP(bare(u.hostname)) && !reached.has(bare(u.hostname)) && !allowedForTests(u)) throw new FetchRefused("That page redirected to a bare network address, so Bops won't follow it.");
        continue;
      }
      const [type, ...params] = String(res.headers["content-type"] ?? "").split(";");
      const contentType = type.trim().toLowerCase();
      if (!PAGE_TYPE.test(contentType)) {
        res.destroy();
        // An error answer that isn't a page still says what went wrong: its status.
        if (status < 200 || status >= 300) return { url: u.href, status, contentType, body: "", truncated: false };
        throw notAPage(contentType);
      }
      const charset = params
        .map((p) => /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p)?.[1])
        .find(Boolean)
        ?.toLowerCase();
      const { bytes, truncated } = await readBody(res, maxBytes);
      return { url: u.href, status, contentType, body: decode(bytes, charset, contentType.includes("html")), truncated };
    } catch (e) {
      throw plain(e, u, signal);
    }
  }
}
