/*
 * The changes someone other than the owner may make in a shared workspace from their own window, as the owner's own
 * window makes them: which of the owner's routes, which power each needs (member-access.ts Power), and how it's kept to this
 * workspace. A "change" act (protocol.ts MemberAct) names one; Bops Cloud checks it (cloud/members.ts), and the owner's
 * Mac checks it again and calls that very route as its own window would (lib/server/change-acts.ts), so every rule a
 * route has holds. Anything not listed here is never done for anyone but the owner, and nothing here deletes the
 * workspace or hands it over. Imported by Bops Cloud and the app, so it imports only a type from member-access.ts.
 */
import type { Power } from "./member-access.ts";

/** The owner's Bops that takes a "change" act (older ones would drop it): SharedWsSlice.changes says so to the viewer. */
export const CHANGES_MIN_VERSION = "0.0.44";
/** The most a change's body may be, as JSON (an org chart of many bots fits). */
export const CHANGE_BODY_MAX = 48_000;
/** This workspace, in a change's body or query: the owner's Mac puts its own id there (the viewer's Bops calls it something else). */
export const THIS_WS = "@ws";

export type ChangeMethod = "POST" | "PATCH" | "PUT" | "DELETE";
export const CHANGE_METHODS: readonly ChangeMethod[] = ["POST", "PATCH", "PUT", "DELETE"];
export type ChangeCall = { method: ChangeMethod; path: string; query?: Record<string, string>; body: Record<string, unknown> };

type Body = Record<string, unknown>;
/** What a route checks a change against: the workspace's bots and apps, as whoever checks has them. */
export type ChangeScope = { bots: ReadonlySet<string>; apps: ReadonlySet<string> };

export type ChangeRoute = {
  method: ChangeMethod;
  /** The route's path; `:app` is one of the workspace's apps. */
  path: string;
  /**
   * The fields a change sends, each with the power it needs (all of them, for every field sent). Only these, and `keys`,
   * go: anything else in the body is refused, so a field a route gets later stays the owner's. A call with none of these
   * isn't a change (the viewer's Bops does it as its own, as before: its favorites, which workspace is open).
   */
  fields: Readonly<Record<string, Power | readonly Power[]>>;
  /** Fields that say what's changed (the workspace, the bot), never changes themselves. */
  keys?: readonly string[];
  /** Powers a field's value needs beyond its own (a bot set to work on the owner's Mac). */
  more?: (b: Body) => Power[];
  /** Fields of the body that name this workspace: always THIS_WS, put back as the owner's id by the owner's Mac. */
  ws?: readonly string[];
  /** Query parameters that name this workspace, the same way. */
  wsQuery?: readonly string[];
  /**
   * A call to this route that isn't a change of the shared workspace (the user's own favorites, which workspace is open)
   * is the user's own, done by their Bops as before. Unset: refused while a shared workspace is open, so it never acts
   * on the user's own bot of that id.
   */
  ownCalls?: true;
  /** The body's field naming a bot, which must be one of the workspace's (required when set). */
  bot?: string;
  /** How the owner's chat says it, after the person's name ("changed the org chart"). None: not said. */
  said?: (b: Body, names: { bot?: string; app?: string }) => string;
};

const has = (b: Body, k: string) => Object.hasOwn(b, k) && b[k] !== undefined;

/** Whether a call to `route` is a change at all: it sends one of the route's change fields. */
export const isChange = (route: ChangeRoute, b: Body) => Object.keys(route.fields).some((k) => has(b, k));

/** The powers a change to `route` needs (every field's, and `more`), or why it isn't done: a field the route doesn't list. */
export function powersFor(route: ChangeRoute, b: Body): Power[] | string {
  const allowed = new Set([...(route.keys ?? []), ...(route.ws ?? []), ...(route.bot ? [route.bot] : []), ...Object.keys(route.fields)]);
  const more = Object.keys(b).filter((k) => b[k] !== undefined && !allowed.has(k));
  if (more.length) return `Only the owner can change ${more.join(", ")} here.`;
  const out = new Set<Power>();
  for (const [k, p] of Object.entries(route.fields)) if (has(b, k)) for (const x of typeof p === "string" ? [p] : p) out.add(x);
  for (const x of route.more?.(b) ?? []) out.add(x);
  return out.size ? [...out] : "Nothing to change.";
}

/**
 * A bot's settings (app/api/bots PATCH), each field's power. Its own computer and an inbox cost the plan more (Spending
 * too); working on the owner's Mac (`runsOn` "mac") and its access to the owner's own app accounts (`access`) are the
 * owner's Mac's. "How I work" isn't here: it's the "persona" act, which keeps whose words they are.
 */
const BOT_FIELDS: Readonly<Record<string, Power | readonly Power[]>> = {
  name: "bots",
  effort: "bots",
  runsOn: "bots",
  autoApprove: "bots",
  dataOff: "bots",
  site: "bots",
  callVoice: "bots",
  answersCalls: "bots",
  sequence: "bots",
  othersMail: "bots",
  computer: ["bots", "spend"],
  email: ["bots", "spend"],
  access: ["bots", "mac"],
};

export const CHANGE_ROUTES: readonly ChangeRoute[] = [
  // The workspace: its org chart, its name, where its chat is answered, its groups' names. Never which is open, or its favorites (the viewer's own).
  {
    method: "PATCH",
    path: "/api/workspaces",
    ws: ["id"],
    ownCalls: true,
    fields: { chain: "chart", name: "workspace", chat: "workspace", computerName: "workspace" },
    said: (b) => (has(b, "chain") ? "changed the org chart" : has(b, "name") ? "renamed the workspace" : has(b, "chat") ? "changed where the chat is answered" : "renamed a group of bots"),
  },
  // A bot's settings.
  {
    method: "PATCH",
    path: "/api/bots",
    bot: "botId",
    fields: BOT_FIELDS,
    more: (b) => (b.runsOn === "mac" ? ["mac"] : []),
    said: (_b, n) => `changed ${n.bot ?? "a bot"}'s settings`,
  },
];

/** A path's parts against a route's: `:app` takes an app's name. The app named, or null when it isn't this route. */
function matchPath(pattern: string, path: string): { app?: string } | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const out: { app?: string } = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === ":app") {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b[i]) || b[i].length > 64) return null;
      out.app = b[i];
    } else if (a[i] !== b[i]) return null;
  }
  return out;
}

/** The route a change is for, and the app its path names, or null when no change goes there. */
export function changeRouteOf(method: unknown, path: unknown): { route: ChangeRoute; app?: string } | null {
  if (typeof method !== "string" || typeof path !== "string" || path.length > 200) return null;
  for (const route of CHANGE_ROUTES) {
    if (route.method !== method) continue;
    const m = matchPath(route.path, path);
    if (m) return { route, ...m };
  }
  return null;
}

/**
 * A change checked against a workspace (`scope`): the route, the powers it needs, and the bot and app it names; or why
 * it isn't done. Its workspace fields must say THIS_WS (the viewer's Bops puts it there), a bot it names must be one of
 * the workspace's, and an app its path names one of its apps. Bops Cloud and the owner's Mac both check with this.
 */
export function checkChange(call: ChangeCall, scope: ChangeScope): { route: ChangeRoute; powers: Power[]; bot?: string; app?: string } | { why: string } {
  const r = changeRouteOf(call.method, call.path);
  if (!r) return { why: "Only the owner can change this." };
  const { route, app } = r;
  const b = call.body;
  for (const k of route.ws ?? []) if (b[k] !== THIS_WS) return { why: "That's another workspace." };
  for (const k of Object.keys(call.query ?? {})) if (!(route.wsQuery ?? []).includes(k)) return { why: "Only the owner can change this." };
  for (const k of route.wsQuery ?? []) if (call.query?.[k] !== undefined && call.query[k] !== THIS_WS) return { why: "That's another workspace." };
  let bot: string | undefined;
  if (route.bot) {
    const id = b[route.bot];
    if (typeof id !== "string" || !scope.bots.has(id)) return { why: "That bot isn't in this workspace." };
    bot = id;
  }
  if (app !== undefined && !scope.apps.has(app)) return { why: "That app isn't in this workspace." };
  const powers = powersFor(route, b);
  if (typeof powers === "string") return { why: powers };
  return { route, powers, ...(bot ? { bot } : {}), ...(app ? { app } : {}) };
}

/** A change as it came, made safe to queue: a known method, a short path, string query values, an object body under CHANGE_BODY_MAX. */
export function cleanChange(v: unknown): ChangeCall | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  if (!CHANGE_METHODS.includes(x.method as ChangeMethod) || typeof x.path !== "string" || !x.path.startsWith("/api/") || x.path.length > 200) return null;
  if (!x.body || typeof x.body !== "object" || Array.isArray(x.body)) return null;
  let size = 0;
  try {
    size = JSON.stringify(x.body).length;
  } catch {
    return null;
  }
  if (size > CHANGE_BODY_MAX) return null;
  let query: Record<string, string> | undefined;
  if (x.query !== undefined) {
    if (!x.query || typeof x.query !== "object" || Array.isArray(x.query)) return null;
    const entries = Object.entries(x.query as Record<string, unknown>);
    if (entries.length > 8 || !entries.every(([k, s]) => k.length <= 40 && typeof s === "string" && s.length <= 200)) return null;
    query = Object.fromEntries(entries) as Record<string, string>;
  }
  return { method: x.method as ChangeMethod, path: x.path, ...(query ? { query } : {}), body: x.body as Record<string, unknown> };
}
