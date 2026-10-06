import "server-only";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadOrgoKey, orgoOrigin } from "./orgo-auth";
import { recordUsage } from "./usage";

/** Thin Orgo REST client (the published SDKs predate screens and clone). */

const base = () => `${orgoOrigin()}/api`;

/**
 * The key Orgo calls run on: the signed-in user's (Sign in with Orgo, kept in the Keychain), else
 * ORGO_API_KEY (self-hosting), else the Orgo CLI's login in ~/.orgo/credentials.json.
 */
async function apiKey(): Promise<string> {
  const signedIn = await loadOrgoKey();
  if (signedIn) return signedIn;
  if (process.env.ORGO_API_KEY) return process.env.ORGO_API_KEY;
  try {
    const creds = JSON.parse(readFileSync(`${homedir()}/.orgo/credentials.json`, "utf8"));
    const key = creds.profiles[creds.current ?? "default"].apiKey;
    if (key) return key;
  } catch {
    /* no CLI login either */
  }
  throw new Error("Not signed in to Orgo");
}

/** Orgo turned a call down: its HTTP status, its code when it sent one (VM_SLOT_ADDON, NOT_FORKABLE…), and its own words. */
export class OrgoError extends Error {
  status: number;
  code?: string;
  said?: string;
  constructor(message: string, status: number, code?: string, said?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.said = said;
  }
}

async function call<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await apiKey()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  // Orgo has the odd momentary 5xx; reads are safe to try again.
  if (res.status >= 500 && method === "GET" && attempt < 2) {
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    return call<T>(method, path, body, attempt + 1);
  }
  let json: { error?: string; code?: unknown } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new Error(`Orgo ${method} ${path} sent back something that isn't JSON`);
  }
  if (!res.ok)
    throw new OrgoError(
      `Orgo ${method} ${path} → ${res.status}: ${json.error ?? text.slice(0, 200)}`,
      res.status,
      typeof json.code === "string" ? json.code : undefined,
      typeof json.error === "string" ? json.error : undefined,
    );
  return json as T;
}

const lanes = new Map<string, Promise<unknown>>();
/** Run calls for one computer one at a time. */
function inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  lanes.set(key, next);
  return next;
}

export type OrgoScreen = { id: string; display: string; width: number; height: number; default: boolean };

export type OrgoComputer = { id: string; name: string; status: string; cpu: number; ram: number; os: string };

/**
 * Bops computers live in their own Orgo workspace; nothing outside it is ever created or deleted
 * here. It's the signed-in user's own workspace named "bops" (any case, so an older "Bops" is kept),
 * made the first time. BOPS_ORGO_WORKSPACE pins one instead, but only without a signed-in user: a
 * pinned id belongs to the self-hoster's key, not to whoever signs in.
 *
 * The id is cached per server process; signIn() and signOut() clear the cache (orgo-auth.ts), so
 * the next user never lands in the last one's workspace.
 */
const WORKSPACE = "bops";
type OrgoWorkspace = { id: string; name: string; role?: string };
const g = globalThis as unknown as { bopsOrgoWorkspace?: Promise<string>; bopsComputerChanges?: number };

/**
 * How many computers Bops has made or deleted since the server started. What's known about the plan's
 * computers in use (lib/server/plan.ts) is read again after a change.
 */
export const computerChanges = () => g.bopsComputerChanges ?? 0;
const changed = () => void (g.bopsComputerChanges = computerChanges() + 1);

/** The workspaces the user owns. GET /api/workspaces lists shared ones too (role "member" and up). */
const ownedWorkspaces = async () => ((await call<{ workspaces?: OrgoWorkspace[] }>("GET", "/workspaces")).workspaces ?? []).filter((w) => (w.role ?? "owner") === "owner");
const isBops = (w: OrgoWorkspace) => w.name.trim().toLowerCase() === WORKSPACE;

export async function bopsWorkspace(): Promise<string> {
  if (process.env.BOPS_ORGO_WORKSPACE && !(await loadOrgoKey())) return process.env.BOPS_ORGO_WORKSPACE;
  return (g.bopsOrgoWorkspace ??= (async () => {
    // Only one the user owns will do.
    const find = async () => (await ownedWorkspaces()).find(isBops)?.id;
    const found = await find();
    if (found) return found;
    try {
      return (await call<{ id: string }>("POST", "/workspaces", { name: WORKSPACE })).id;
    } catch (e) {
      // Orgo refuses a second workspace with the same name (any case): someone else just made it.
      const made = await find();
      if (made) return made;
      throw e;
    }
  })().catch((e: Error) => {
    g.bopsOrgoWorkspace = undefined;
    throw e;
  }));
}

/**
 * A workspace the user owns, to read their plan's numbers by (Orgo counts computers against the owner,
 * across every workspace they own): the "bops" one when there is one, else any. Unlike bopsWorkspace it
 * never makes one, so reading the plan leaves nothing behind in an account that never used the cloud.
 * Null when they own none.
 */
export async function ownedWorkspace(): Promise<string | null> {
  const bops = await g.bopsOrgoWorkspace?.catch(() => undefined);
  if (bops) return bops;
  const owned = await ownedWorkspaces();
  return (owned.find(isBops) ?? owned[0])?.id ?? null;
}

/**
 * Sam's computer launches from this template (built from orgo/bops-base.mjs; keep the versions in
 * step): Orgo's own copy, which every account can use and which is the only one a free Bops computer
 * is made from (orgo-web lib/curated-templates.ts). BOPS_ORGO_TEMPLATE points at your own build
 * when the default isn't in your Orgo account.
 */
export const BOPS_TEMPLATE = process.env.BOPS_ORGO_TEMPLATE || "system/bops-base@0.1.8";
/**
 * Every Bops computer's disk, in GB (Orgo's plan default is 20). Copies inherit their source's disk,
 * and older computers grow to this the next time Bops gets them ready (see growDisk).
 */
export const BOPS_DISK_GB = Number(process.env.BOPS_DISK_GB) || 120;
/** Every screen on a Bops computer: 4:3, like the template's boot screen (orgo/bops-base.mjs). */
export const BOPS_SCREEN = { width: 1280, height: 960 };

const grown = new Set<string>();

export const orgo = {
  /**
   * A new computer in the Bops workspace, from the Bops template, with `ram` GB of memory: the plan's
   * memory per computer (computerRam in lib/orgo-plans.ts), so the plan runs out of computers before
   * memory, as every copy of this one is as big. Its vCPUs are the template's 4, as many as one computer
   * on the user's plan can have (Hacker 1, Startup 2, Scale 4). Without `ram` Orgo gives it the
   * template's 16 GB, as far as the plan allows. A computer the template's size resumes from its golden
   * snapshot; a smaller one boots fresh, which takes longer.
   *
   * `free`: the user's one free Bops computer (bops_free), off their Orgo plan, at the template's size
   * whatever the plan (Orgo sets it; no `ram` is sent). Orgo makes it only when the user has none yet,
   * in their own "bops" workspace, from Orgo's Bops template; otherwise this is an ordinary create.
   */
  create: async (name: string, opts: { ram?: number; free?: boolean } = {}) => {
    const c = await call<{ id: string; name: string; status: string }>("POST", "/computers", {
      workspace_id: await bopsWorkspace(),
      name,
      template_ref: BOPS_TEMPLATE,
      ...(opts.free ? { bops_free: true } : opts.ram ? { ram: opts.ram } : {}),
    });
    changed();
    recordUsage("computer.create");
    return c;
  },

  /**
   * Grow a computer's disk to BOPS_DISK_GB (or the plan's most, if that's less). Disks only grow,
   * and on Linux it happens live: no restart, and the filesystem fills the new space by itself.
   */
  growDisk: async (computerId: string) => {
    if (grown.has(computerId)) return;
    const d = await call<{ current_disk_gb: number; max_disk_gb: number }>("GET", `/computers/${computerId}/resize`);
    const want = Math.min(BOPS_DISK_GB, d.max_disk_gb);
    if (d.current_disk_gb < want) await call("PATCH", `/computers/${computerId}/resize`, { disk_size_gb: want });
    grown.add(computerId);
  },

  /**
   * The computer's VNC password, for the live desktop view. Server-side only: hand it out only to
   * the user's own app on this Mac (see /api/vnc), never to anything remote.
   */
  vncPassword: async (computerId: string) => (await call<{ vnc_password: string }>("GET", `/computers/${computerId}`)).vnc_password,

  /** Every computer in the Bops workspace (and only that workspace). */
  bopsComputers: async () =>
    ((await call<{ desktops?: { id: string; name: string }[] }>("GET", `/workspaces/${await bopsWorkspace()}`)).desktops ?? []).map((d) => ({ id: d.id, name: d.name })),

  /**
   * Delete a computer, but only one in the Bops workspace (or the one BOPS_ORGO_WORKSPACE pinned:
   * computers made there before sign-in are Bops' too, when the account that signed in can reach them).
   */
  remove: async (computerId: string) => {
    const c = await call<{ project_id?: string; workspace_id?: string }>("GET", `/computers/${computerId}`);
    const where = c.workspace_id ?? c.project_id;
    if (where !== (await bopsWorkspace()) && (!where || where !== process.env.BOPS_ORGO_WORKSPACE))
      throw new Error(`refusing to delete ${computerId}: not a Bops computer`);
    await call("DELETE", `/computers/${computerId}`);
    changed();
    recordUsage("computer.remove");
  },

  /** Public facts about a computer. Never pass the raw response on: it carries the VNC password. */
  computer: async (computerId: string): Promise<OrgoComputer> => {
    const c = await call<OrgoComputer>("GET", `/computers/${computerId}`);
    return { id: c.id, name: c.name, status: c.status, cpu: c.cpu, ram: c.ram, os: c.os };
  },

  /**
   * Fork a running computer: a copy of its live memory as well as its disk, so open apps,
   * browser tabs and screens carry over. Orgo's fork takes the computer's instance id (its UUID
   * answers 404) and returns the new computer's UUID. Firecracker VMs can't be forked (QEMU ones
   * can), so callers fall back to clone. A fork or clone lands on the source's server, so it needs
   * that much free memory there.
   */
  fork: async (computerId: string) => {
    const c = await call<{ instance_details?: { id?: string } }>("GET", `/computers/${computerId}`);
    if (!c.instance_details?.id) throw new Error("this computer can't be forked (no instance id)");
    const forked = await call<{ id: string; name: string; status: string }>("POST", `/computers/${c.instance_details.id}/fork`);
    changed();
    recordUsage("computer.create");
    return forked;
  },

  clone: async (computerId: string, name: string) => {
    const cloned = await call<{ id: string; name: string; status: string }>("POST", `/computers/${computerId}/clone`, { name });
    changed();
    recordUsage("computer.create");
    return cloned;
  },

  screens: async (computerId: string) =>
    (await call<{ screens: OrgoScreen[] }>("GET", `/computers/${computerId}/screens`)).screens,

  /**
   * Start another screen. Bops computers are 4:3 (see BOPS_SCREEN); we pass the size because Orgo
   * still records a template computer's boot screen as 1280x720 and would size new screens to that.
   */
  createScreen: (computerId: string) => call<OrgoScreen>("POST", `/computers/${computerId}/screens`, BOPS_SCREEN),

  destroyScreen: (computerId: string, screenId: string) => call("DELETE", `/computers/${computerId}/screens/${screenId}`),

  bash: async (computerId: string, command: string, timeout = 60) =>
    (await call<{ output: string; exit_code: number }>("POST", `/computers/${computerId}/bash`, { command, timeout })),

  /** Input on one screen, for when the user takes over. Queued with screenshots so they don't collide. */
  click: (computerId: string, screen: string, x: number, y: number, double = false) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/click?screen=${screen}`, { x: Math.round(x), y: Math.round(y), double })),
  type: (computerId: string, screen: string, text: string) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/type?screen=${screen}`, { text })),
  key: (computerId: string, screen: string, key: string) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/key?screen=${screen}`, { key })),

  /**
   * Raw screenshot bytes for one screen. Orgo fails overlapping screenshots of one computer,
   * and the app watches several screens at once, so they queue per computer and retry once.
   */
  screenshot: (computerId: string, screen: string, scale = 0.75) =>
    inLane(computerId, async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(
          `${base()}/computers/${computerId}/screenshot?screen=${screen}&response_format=binary&format=jpeg&scale=${scale}`,
          { headers: { Authorization: `Bearer ${await apiKey()}` }, cache: "no-store" },
        );
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        if (attempt === 1 || res.status < 500) throw new Error(`screenshot ${res.status}`);
      }
    }),
};

/** A device paired to route computers' browsing through it (Orgo's personal-device egress). */
export type OrgoEgressDevice = { id: string; name: string; online: boolean | null; computers?: unknown };

/**
 * Personal-device egress: a Mac paired with Orgo carries a computer's browsing out through its own
 * internet. Orgo answers 403 where it isn't available yet (see OrgoUnavailable).
 */
export const egress = {
  /** This user's paired devices, whether each is connected right now (null: Orgo couldn't tell), and where agents dial. */
  devices: () => call<{ devices?: OrgoEgressDevice[]; rendezvous?: string | null }>("GET", "/egress-devices"),
  /** Pair a new device. The pairing code comes back only here: keep it server side. */
  pair: (name: string) => call<{ id: string; name: string; pairing_code: string; rendezvous?: string | null }>("POST", "/egress-devices", { name }),
  /** Which way a computer's browsing goes out now. */
  upstream: (computerId: string) =>
    call<{ mode: "residential" | "device" | "custom"; device_id?: string | null; proxy_on: boolean }>("GET", `/computers/${computerId}/egress/upstream`),
  /**
   * Route a computer's browsing. Orgo applies it right away: when the proxy was off, turning a route
   * on restarts the computer's Chrome; when it was on, only the route underneath changes.
   */
  setUpstream: (computerId: string, mode: "residential" | "device", deviceId?: string) =>
    call<{ proxy_on?: boolean }>("POST", `/computers/${computerId}/egress/upstream`, { mode, ...(deviceId ? { device_id: deviceId } : {}) }),
  /** Turn a computer's proxy off: browsing goes out directly again (this restarts its Chrome too). */
  proxyOff: (computerId: string) => call("POST", `/computers/${computerId}/residential-proxy`, { enabled: false }),
};

/** Orgo said a feature isn't available for this account (403). */
export const orgoUnavailable = (e: unknown) => / → 403:/.test((e as Error)?.message ?? "");

/** Screen id for an X display number: 99 is the boot screen, 100-102 are created screens. */
export const screenId = (display: number) => (display === 99 ? "default" : `screen-${display}`);
