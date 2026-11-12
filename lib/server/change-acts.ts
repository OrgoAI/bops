import "server-only";
import { checkChange, THIS_WS, type ChangeCall } from "@/cloud/change-routes";
import { groupKeyOf } from "@/cloud/group-key";
import { appsLevelOf, hasPower, levelOf, permits, POWER_WORDS, type MemberAccess } from "@/lib/member-access";
import { botChatId, siteOf, workBot, workspaceOf, type Workspace } from "@/lib/types";
import { asChange } from "./change-replay";
import { addMessage, getState, update } from "./store";

/**
 * A change someone made in one of this Mac's shared workspaces from their own window (the "change" act: cloud/change-routes.ts),
 * done here as the owner's own window would do it: through that very route, called in this process with the window's
 * token, for this workspace alone, so every rule the route has holds. Bops Cloud checked it (cloud/members.ts changeTouched);
 * this checks it again against this state (changeRefused), which may be newer. How it went is kept on the workspace
 * (Workspace.changesDone) for their window, and a change that went is said in the owner's chat as theirs.
 */

/** How many changes' results a workspace keeps (Workspace.changesDone). */
export const CHANGES_KEPT = 20;

type Handler = (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
/** Each route a change may go to (CHANGE_ROUTES' paths), loaded when one comes. */
const ROUTES: Record<string, () => Promise<Record<string, unknown>>> = {
  "/api/workspaces": () => import("@/app/api/workspaces/route"),
  "/api/bots": () => import("@/app/api/bots/route"),
};

const wsOf = (wsId: string): Workspace | undefined => getState().workspaces?.find((w) => w.id === wsId);
const botIdsOf = (wsId: string) => getState().bots.filter((b) => workspaceOf(b) === wsId).map((b) => b.id);

/**
 * Why this Mac won't do a change for someone (`role` and what they may do here, `access`), or null when it will: the same
 * checks as Bops Cloud's, against this state. A bot it names one they have at Write, an app one of the workspace's with
 * Your Apps at Write, every power it needs theirs, the org chart only when they see every bot.
 */
export function changeRefused(wsId: string, call: ChangeCall, role: "admin" | "member", access: MemberAccess): string | null {
  if (!wsOf(wsId)) return "no such workspace";
  const ids = botIdsOf(wsId);
  const bots = new Set(ids.filter((id) => permits(levelOf(access, id), "write")));
  const apps = new Set(appsLevelOf(access) === "write" ? Object.keys(wsOf(wsId)?.hostedApps ?? {}) : []);
  const r = checkChange(call, { bots, apps });
  if ("why" in r) return r.why;
  const missing = r.powers.find((p) => !hasPower(p, role, access.can));
  if (missing) return `The owner or an Admin can let you change ${POWER_WORDS[missing].name} in Team.`;
  if (r.powers.includes("chart") && !(access.others !== "none" && ids.every((id) => levelOf(access, id) !== "none"))) return "doesn't see every bot";
  return null;
}

/** THIS_WS put back as this workspace's id, in the fields the route names (checkChange made sure they say it). */
function withWs(call: ChangeCall, wsId: string, ws: readonly string[] = [], wsQuery: readonly string[] = []) {
  const body: Record<string, unknown> = { ...call.body };
  for (const k of ws) if (body[k] === THIS_WS) body[k] = wsId;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(call.query ?? {})) query.set(k, wsQuery.includes(k) && v === THIS_WS ? wsId : v);
  return { body, query };
}

/**
 * A group's name key (lib/bot-groups.ts groupNameKey) from the key Bops Cloud sent it by (SharedGroup.key: groupKeyOf),
 * among this workspace's computers and the apps their bots work on; or the key as it came when it isn't one of those.
 */
function groupNameKeyOf(wsId: string, key: string): string {
  if (!/^c[0-9a-f]{16}$/.test(key)) return key;
  const s = getState();
  const bots = s.bots.filter((b) => workspaceOf(b) === wsId);
  const keys = new Set<string>();
  for (const b of bots) {
    const computer = workBot(b, s.bots).computerId;
    if (!computer) continue;
    keys.add(computer);
    const app = siteOf(s, b)?.app;
    if (app) keys.add(`${computer}/${app}`);
  }
  return [...keys].find((k) => groupKeyOf(wsId, k) === key) ?? key;
}

/** One result kept on the workspace, the oldest past CHANGES_KEPT let go. */
function keep(wsId: string, done: NonNullable<Workspace["changesDone"]>[number]) {
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (!w) return;
    w.changesDone = [...(w.changesDone ?? []).filter((d) => d.key !== done.key), done].slice(-CHANGES_KEPT);
  });
}

/** A change this Mac won't do (changeRefused, or too late), kept as why for their window. */
export const refuseChange = (wsId: string, key: string, who: { userId: string }, why: string) => {
  if (wsOf(wsId) && !wsOf(wsId)?.changesDone?.some((d) => d.key === key)) keep(wsId, { key, by: who.userId, ok: false, error: REFUSED[why] ?? why, at: Date.now() });
};
/** What a refusal says in their window, for this Mac's own reasons (changeRefused's other answers are said as they are). */
const REFUSED: Record<string, string> = {
  "too late": "The owner's Mac was away too long. Try again.",
  "access from before they joined": "Your access changed. Try again.",
  "doesn't see every bot": "To change the org chart, you need to see every bot.",
};

/**
 * Do a change (checked: changeRefused) through its route, as the owner's window would, and keep how it went. The same key
 * again (an ack that was lost) isn't done twice. Never throws: a route that says no is kept as why.
 */
export async function doChange(wsId: string, call: ChangeCall, who: { userId: string; name: string }, key: string): Promise<void> {
  if (wsOf(wsId)?.changesDone?.some((d) => d.key === key)) return;
  const ids = new Set(botIdsOf(wsId));
  const r = checkChange(call, { bots: ids, apps: new Set(Object.keys(wsOf(wsId)?.hostedApps ?? {})) });
  if ("why" in r) return keep(wsId, { key, by: who.userId, ok: false, error: r.why, at: Date.now() });
  const { body, query } = withWs(call, wsId, r.route.ws, r.route.wsQuery);
  // A group's name: by the key Bops Cloud sent it by, as this Mac names it.
  if (call.path === "/api/workspaces" && body.computerName && typeof body.computerName === "object") {
    const c = body.computerName as Record<string, unknown>;
    if (typeof c.computer === "string") body.computerName = { ...c, computer: groupNameKeyOf(wsId, c.computer) };
  }
  const load = ROUTES[r.route.path];
  const handler = load ? ((await load())[call.method] as Handler | undefined) : undefined;
  if (!handler) return keep(wsId, { key, by: who.userId, ok: false, error: "This Bops can't do that yet.", at: Date.now() });
  const qs = query.toString();
  const request = new Request(`http://127.0.0.1${call.path}${qs ? `?${qs}` : ""}`, {
    method: call.method,
    headers: { "content-type": "application/json", ...(process.env.BOPS_UI_TOKEN ? { "x-bops-window": process.env.BOPS_UI_TOKEN } : {}) },
    body: JSON.stringify(body),
  });
  let ok = false;
  let error: string | undefined;
  try {
    const res = await asChange({ name: who.name }, () => handler(request, { params: Promise.resolve((r.app ? { name: r.app } : {}) as Record<string, string>) }));
    ok = res.ok;
    if (!ok) {
      const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
      error = typeof j?.error === "string" ? j.error.slice(0, 300) : "That didn't go.";
    }
  } catch (e) {
    error = (e as Error).message.slice(0, 300) || "That didn't go.";
  }
  keep(wsId, { key, by: who.userId, ok, ...(error ? { error } : {}), at: Date.now() });
  if (!ok || !r.route.said) return;
  // Said as theirs: in the bot's chat when it's a bot's, else the main bot's.
  const s = getState();
  const b = r.bot ? s.bots.find((x) => x.id === r.bot) : undefined;
  const chief = s.bots.find((x) => x.isMain && workspaceOf(x) === wsId);
  const at = b ?? chief;
  if (at) addMessage({ chatId: botChatId(at.id), role: "system", botId: at.id, text: `${who.name} ${r.route.said(call.body, { bot: b?.name, app: r.app })}` });
}
