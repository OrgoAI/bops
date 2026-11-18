import { cleanChain } from "./chain.ts";
import { checkChange, type ChangeCall } from "./change-routes.ts";
import { workBotOf } from "./computer-scope.ts";
import { groupKeyOf } from "./group-key.ts";
import { HttpError } from "./http.ts";
import { withMailRule, type MailRule, type PermissionRule } from "./permission-rules.ts";
import { CLOUD_NOT_YET } from "./protocol.ts";

/**
 * A "change" act (cloud/change-routes.ts) done by Bops Cloud itself in a workspace where everything goes through the cloud
 * (turns.ts allCloud; members.ts cloudAct), as the owner's Mac does it through the owner's own route (lib/server/change-acts.ts
 * doChange: app/api/workspaces and app/api/bots PATCH): pure, the owner's state in and out. members.ts checks it first
 * (changeTouched: the powers it needs, a bot they have at Write) and again under the owner's lock, and does what needs
 * another service itself, before or after (the workspace's name on orgo-web, where its chat is answered: turns.ts
 * setRouting). Kept on the workspace by its key (Workspace.changesDone: the same act again changes nothing) and said in
 * the owner's chat as theirs, as the Mac says it.
 *
 * What it doesn't do yet, said plainly (409 CLOUD_NOT_YET): a bot's own computer and its email (they cost the owner's plan
 * and delete computers), and which site a bot works on (Workspace.botSites, with the Locals of the app it leaves stopped on
 * its computer). A bot set to work on the owner's Mac is refused: every bot here works on its own computer.
 *
 * What the owner's route also does outside the state for a bot's new name (its email, phone agents, Telegram and Discord
 * names, desktop), call voice (its phone agents' voice) or place to work (Orgo's copy of its routines) is the owner's
 * Mac's, with its keys and logins: it follows each as the change comes in, or as its Bops next opens
 * (lib/server/bot-follow.ts, from CLOUD_ALL_MIN_VERSION, which a workspace needs to go through the cloud at all). The
 * change itself never waits for that Mac; with it closed, the line in the chat says what follows once it opens
 * (followWords).
 */

type Blob = Record<string, unknown>;
const isObject = (v: unknown): v is Blob => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): Blob[] => (Array.isArray(v) ? v.filter(isObject) : []);
/** As lib/types.ts MAIN_WORKSPACE, and workspaceOf. */
const MAIN_WORKSPACE = "ws_main";
const wsOfBot = (b: Blob | undefined) => (typeof b?.workspaceId === "string" ? b.workspaceId : MAIN_WORKSPACE);
/** As lib/server/change-acts.ts CHANGES_KEPT. */
export const CHANGES_KEPT = 20;
/** As lib/types.ts CALL_VOICES. */
export const CALL_VOICES = ["cedar", "ash", "echo", "ballad", "verse", "marin", "coral", "shimmer", "sage"] as const;
/** As lib/bot-groups.ts MAX_COMPUTER_NAME and cleanComputerName. */
export const MAX_COMPUTER_NAME = 40;
export const cleanComputerName = (s: unknown): string =>
  typeof s === "string"
    ? [...s]
        .map((ch) => (ch < " " || ch === "\u007f" ? " " : ch))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_COMPUTER_NAME)
        .trim()
    : "";
/** As lib/server/bots.ts renameBot: a bot's name, trimmed, at most this long. */
const BOT_NAME_MAX = 40;
/** As lib/server/workspaces.ts NAME_MAX: a workspace's name. */
export const WS_NAME_MAX = 40;

/** Who made the change (MemberWho). */
export type ChangeWho = { userId: string; name: string };

/** 409: what can't be done from the cloud yet (§4). */
export const NOT_FROM_CLOUD = "A bot's own computer and email can't be set up from the cloud yet.";
export const MAIN_NOT_FROM_CLOUD = "The main workspace can't be renamed from the cloud yet.";
/** The hint under a disabled "Your Mac" in a bot's settings: refused for a change act too. */
export const NO_MAC_HERE = "This workspace runs in the cloud, so its bots work on their own computers.";
export const SITE_NOT_FROM_CLOUD = "Which site a bot works on can't be changed from the cloud yet.";

/** Whether a body sends field `k` (as change-routes.ts reads it). */
const has = (b: Blob, k: string) => Object.hasOwn(b, k) && b[k] !== undefined;

/**
 * The bots API's own checks (app/api/bots/route.ts PATCH) and what Bops Cloud won't do here: throws why not, before any
 * of it is done. Nothing else of the body is checked here (changeTouched did).
 */
function botRefusal(b: Blob): void {
  if (has(b, "computer") || has(b, "email")) throw new HttpError(409, NOT_FROM_CLOUD, { code: CLOUD_NOT_YET });
  if (has(b, "site")) throw new HttpError(409, SITE_NOT_FROM_CLOUD, { code: CLOUD_NOT_YET });
  if (b.runsOn === "mac") throw new HttpError(409, NO_MAC_HERE, { code: CLOUD_NOT_YET });
  if (b.callVoice !== undefined && b.callVoice !== null && !(CALL_VOICES as readonly unknown[]).includes(b.callVoice)) throw new HttpError(400, "Pick one of the nine voices.");
  const seq = b.sequence;
  if (seq !== undefined && (!isObject(seq) || !["othersMail", "othersCalls"].includes(String(seq.id ?? "")) || typeof seq.on !== "boolean")) throw new HttpError(400, "No such sequence.");
  if (b.othersMail !== undefined && !["never", "ask", "allow"].includes(String(b.othersMail))) throw new HttpError(400, "Pick Never, With your OK or On its own.");
}

/** A bot's settings on its workspace (lib/server/bot-settings.ts editBotSettings), as a copy of the blob. */
function withBotSettings(blob: Blob, b: Blob, edit: (x: Blob) => void): Blob {
  const id = wsOfBot(b);
  let workspaces = list(blob.workspaces);
  let w = workspaces.find((x) => x.id === id);
  const all = isObject(w?.botSettings) ? w.botSettings : {};
  const x: Blob = { ...(isObject(all[String(b.id)]) ? (all[String(b.id)] as Blob) : {}) };
  if (isObject(x.sequencesOff)) x.sequencesOff = { ...x.sequencesOff };
  edit(x);
  if (isObject(x.sequencesOff) && !Object.keys(x.sequencesOff).length) delete x.sequencesOff;
  const set = Object.keys(x).length > 0;
  if (!w) {
    // The default workspace before it had a record of its own.
    if (!set || id !== MAIN_WORKSPACE) return blob;
    w = { id: MAIN_WORKSPACE, name: "Main", createdAt: 0 };
    workspaces = [w, ...workspaces];
  }
  const next = { ...all };
  if (set) next[String(b.id)] = x;
  else delete next[String(b.id)];
  const changed: Blob = { ...w };
  if (Object.keys(next).length) changed.botSettings = next;
  else delete changed.botSettings;
  return { ...blob, workspaces: workspaces.map((y) => (y === w ? changed : y)) };
}

/** A bot's settings (app/api/bots/route.ts PATCH), on a copy of the blob: the fields Bops Cloud does here (botRefusal said no to the rest). */
function changeBot(blob: Blob, botId: string, body: Blob): Blob {
  const bots = list(blob.bots);
  const b = bots.find((x) => x.id === botId);
  if (!b) throw new HttpError(404, "No such bot");
  botRefusal(body);
  const next: Blob = { ...b };
  if (body.name !== undefined) {
    // As lib/server/bots.ts renameBot.
    const clean = typeof body.name === "string" ? body.name.trim().slice(0, BOT_NAME_MAX) : "";
    if (!clean) throw new HttpError(400, "name required");
    if (clean !== b.name && bots.some((x) => x.id !== botId && wsOfBot(x) === wsOfBot(b) && String(x.name ?? "").toLowerCase() === clean.toLowerCase())) throw new HttpError(400, "a bot with that name exists");
    next.name = clean;
  }
  const access = body.access;
  if (isObject(access) && typeof access.account === "string") {
    const kept: Blob = { ...(isObject(b.access) ? b.access : {}) };
    if (access.level === "read" || access.level === "act" || access.level === "none") kept[access.account] = access.level;
    else delete kept[access.account];
    if (Object.keys(kept).length || isObject(b.access)) next.access = kept;
  }
  if (typeof body.effort === "string" && ["auto", "low", "medium", "high"].includes(body.effort)) next.effort = body.effort;
  if (body.runsOn === "auto" || body.runsOn === "cloud") next.runsOn = body.runsOn;
  if (typeof body.autoApprove === "boolean") {
    if (body.autoApprove) next.autoApprove = true;
    else delete next.autoApprove;
  }
  if (typeof body.dataOff === "boolean") {
    if (body.dataOff) next.dataOff = true;
    else delete next.dataOff;
  }
  if (body.othersMail) next.permissions = withMailRule(Array.isArray(b.permissions) ? (b.permissions as PermissionRule[]) : undefined, body.othersMail as MailRule);
  let out: Blob = { ...blob, bots: bots.map((x) => (x === b ? next : x)) };
  if (body.callVoice !== undefined || typeof body.answersCalls === "boolean" || body.sequence || body.othersMail)
    out = withBotSettings(out, next, (x) => {
      if (body.callVoice === null) delete x.callVoice;
      else if (typeof body.callVoice === "string") x.callVoice = body.callVoice;
      if (body.answersCalls === false) x.answersCalls = false;
      else if (body.answersCalls === true) delete x.answersCalls;
      if (isObject(body.sequence)) {
        const id = String(body.sequence.id);
        const off: Blob = isObject(x.sequencesOff) ? x.sequencesOff : {};
        if (body.sequence.on) delete off[id];
        else off[id] = true;
        x.sequencesOff = off;
      }
      if (body.othersMail === "never") x.mailNever = true;
      else if (body.othersMail) delete x.mailNever;
    });
  return out;
}

/** A bot's call voice as its workspace keeps it (lib/types.ts settingsOf), or null. */
const voiceOf = (blob: Blob, b: Blob): unknown => {
  const all = list(blob.workspaces).find((w) => w.id === wsOfBot(b))?.botSettings;
  const x = isObject(all) && Object.hasOwn(all, String(b.id)) ? all[String(b.id)] : undefined;
  return isObject(x) ? (x.callVoice ?? null) : null;
};

/**
 * What the chat's line adds for a bot's change while the owner's Mac is closed, when it's of use (a sentence after it): a new
 * name its phone and channels (Telegram, Discord) take, and a new call voice its calls take, once the owner's Bops opens
 * (lib/server/bot-follow.ts). Nothing for a bot with no phone or channels.
 */
export function followWords(before: Blob, after: Blob, botId: string): string {
  const was = list(before.bots).find((x) => x.id === botId);
  const now = list(after.bots).find((x) => x.id === botId);
  if (!was || !now) return "";
  const owner = isObject(after.owner) && typeof after.owner.name === "string" && after.owner.name.trim() ? after.owner.name.trim() : "the owner";
  const line = list(after.workspaces).find((w) => w.id === wsOfBot(now))?.line;
  const phone = (isObject(now.phoneLine) && typeof now.phoneLine.agentId === "string") || (now.isMain === true && isObject(line) && typeof line.agentId === "string");
  const channels = list(after.channels).some((c) => c.botId === botId && (c.kind === "telegram" || c.kind === "discord"));
  if (was.name !== now.name && (phone || channels)) return `. ${phone && channels ? "Its phone and channel names follow" : phone ? "Its name on calls follows" : "Its channel names follow"} when ${owner}'s Bops next opens.`;
  if (voiceOf(before, was) !== voiceOf(after, now) && phone) return `. Its calls take the new voice when ${owner}'s Bops next opens.`;
  return "";
}

/** As lib/types.ts siteOf: the site a bot works on (Workspace.botSites). */
const siteOf = (blob: Blob, b: Blob): Blob | undefined => {
  const all = list(blob.workspaces).find((w) => w.id === wsOfBot(b))?.botSites;
  const x = isObject(all) && Object.hasOwn(all, String(b.id)) ? all[String(b.id)] : undefined;
  return isObject(x) && typeof x.app === "string" && typeof x.site === "string" ? x : undefined;
};

/**
 * A group's name key (lib/bot-groups.ts groupNameKey) from the key a member's window sent it by (SharedGroup.key:
 * groupKeyOf), among the workspace's computers and the apps their bots work on (as change-acts.ts groupNameKeyOf), or the
 * key as it came when it isn't one of those.
 */
export function groupNameKeyOf(blob: Blob, wsId: string, key: string): string {
  if (!/^c[0-9a-f]{16}$/.test(key)) return key;
  const bots = list(blob.bots);
  const keys = new Set<string>();
  for (const b of bots.filter((x) => wsOfBot(x) === wsId)) {
    const computer = workBotOf(b, bots).computerId;
    if (typeof computer !== "string" || !computer) continue;
    keys.add(computer);
    const app = siteOf(blob, b)?.app;
    if (typeof app === "string") keys.add(`${computer}/${app}`);
  }
  return [...keys].find((k) => groupKeyOf(wsId, k) === key) ?? key;
}

/** A computer's name (lib/server/bot-groups.ts setComputerName), on a copy of the blob. */
function nameComputer(blob: Blob, wsId: string, sent: unknown): Blob {
  const c = isObject(sent) ? sent : {};
  const computerId = typeof c.computer === "string" ? groupNameKeyOf(blob, wsId, c.computer) : undefined;
  const bots = list(blob.bots);
  const mine = bots.filter((b) => wsOfBot(b) === wsId);
  const computers = new Set(mine.flatMap((b) => (typeof workBotOf(b, bots).computerId === "string" ? [String(workBotOf(b, bots).computerId)] : [])));
  const [computer, app, ...more] = computerId ? computerId.split("/") : [];
  const appOn = (comp: string, a: string) => mine.some((b) => workBotOf(b, bots).computerId === comp && siteOf(blob, b)?.app === a);
  if (!computer || more.length || app === "" || !computers.has(computer) || (app !== undefined && !appOn(computer, app))) throw new HttpError(404, "None of this workspace's bots work on that computer.");
  if (c.name !== undefined && c.name !== null && typeof c.name !== "string") throw new HttpError(400, "Say its name.");
  const kept = cleanComputerName(c.name);
  return {
    ...blob,
    workspaces: list(blob.workspaces).map((w) => {
      if (w.id !== wsId) return w;
      const all: Blob = { ...(isObject(w.computerNames) ? w.computerNames : {}) };
      if (kept) all[computerId!] = kept;
      else delete all[computerId!];
      const x: Blob = { ...w };
      if (Object.keys(all).length) x.computerNames = all;
      else delete x.computerNames;
      return x;
    }),
  };
}

/** Workspace `wsId` of a copy of the blob, changed by `f`. */
const withWorkspace = (blob: Blob, wsId: string, f: (w: Blob) => Blob): Blob => ({ ...blob, workspaces: list(blob.workspaces).map((w) => (w.id === wsId ? f(w) : w)) });

/**
 * What orgo-web said of a workspace's rename (members.ts asks it, with the member's own key, before the lock): its name
 * now there and when, kept as the owner's Mac keeps one (lib/server/workspaces.ts noteOrgoName) so its next look at
 * Orgo's names takes it for no change.
 */
export type Renamed = { name: string; orgoName: string; updatedAt?: string | null };

/** Whether a workspace's rename can't be done from the cloud: the main one while its Orgo project is still "bops" (the gate for older apps). */
export function renameRefused(blob: Blob, wsId: string, name: string): string | null {
  const w = list(blob.workspaces).find((x) => x.id === wsId);
  const isBops = (n: unknown) => typeof n === "string" && n.trim().toLowerCase() === "bops";
  if (wsId === MAIN_WORKSPACE && isBops(w?.orgoName ?? "bops") && !isBops(name)) return MAIN_NOT_FROM_CLOUD;
  return null;
}

/**
 * Apply a change on the owner's state (`blob`) for workspace `wsId`, as the owner's route does it: the route's own checks
 * (checkChange, against the workspace's bots and apps), then its fields. `renamed`: what orgo-web said of the workspace's
 * new name (asked before). `chat`: where its chat is answered, set by the caller (setRouting) already. Kept by its key in
 * Workspace.changesDone (the same key again: nothing changes) and said as theirs; with the owner's Mac off (`macOn`
 * false), the line says what follows once it opens (followWords). Returns the state and the note, or null when it was
 * done already; throws why not (HttpError).
 */
export function applyChange(blob: Blob, wsId: string, call: ChangeCall, who: ChangeWho, key: string, at: number, o: { renamed?: Renamed; chatDone?: boolean; macOn?: boolean } = {}): { blob: Blob; said: Blob | null } | null {
  const ws = list(blob.workspaces).find((w) => w.id === wsId);
  if (!ws) throw new HttpError(404, "No such workspace");
  if (list(ws.changesDone).some((d) => d.key === key)) return null;
  const ids = new Set(list(blob.bots).flatMap((b) => (wsOfBot(b) === wsId && typeof b.id === "string" ? [b.id] : [])));
  const r = checkChange(call, { bots: ids, apps: new Set(isObject(ws.hostedApps) ? Object.keys(ws.hostedApps) : []) });
  if ("why" in r) throw new HttpError(403, r.why);
  const body = call.body;
  let out = blob;
  if (call.path === "/api/workspaces") {
    // As the route takes them: where its chat is answered, else a computer's name, else the org chart, else its name.
    if (body.chat !== undefined) {
      // (Set by the caller already: turns.ts setRouting, which takes the owner's lock itself.)
      if (!o.chatDone || (body.chat !== "mac" && body.chat !== "auto")) throw new HttpError(400, 'Say which workspace, and "mac" or "auto".');
    } else if (body.computerName !== undefined) out = nameComputer(out, wsId, body.computerName);
    else if (body.chain !== undefined) {
      const bots = list(out.bots).filter((b) => wsOfBot(b) === wsId) as { id: string; isMain?: boolean; workspaceId?: string }[];
      const chain = { ...cleanChain(body.chain, bots, isObject(ws.memberAccess) ? ws.memberAccess : undefined), at };
      out = withWorkspace(out, wsId, (w) => ({ ...w, chain }));
    } else if (typeof body.name === "string") {
      const clean = body.name.trim().slice(0, WS_NAME_MAX);
      if (clean) {
        const refused = renameRefused(out, wsId, clean);
        if (refused) throw new HttpError(409, refused, { code: CLOUD_NOT_YET });
        if (!o.renamed) throw new HttpError(409, MAIN_NOT_FROM_CLOUD, { code: CLOUD_NOT_YET });
        const rn = o.renamed;
        out = withWorkspace(out, wsId, (w) => ({ ...w, name: rn.name, orgoName: rn.orgoName, ...(rn.updatedAt ? { orgoUpdatedAt: rn.updatedAt } : {}) }));
      }
    }
  } else if (call.path === "/api/bots" && r.bot) out = changeBot(out, r.bot, body);
  else throw new HttpError(403, "Only the owner can change this.");
  out = withWorkspace(out, wsId, (w) => ({ ...w, changesDone: [...list(w.changesDone).filter((d) => d.key !== key), { key, by: who.userId, ok: true, at }].slice(-CHANGES_KEPT) }));
  // Said as theirs: in the bot's chat when it's a bot's (by its name now), else the main bot's (change-acts.ts doChange).
  const bots = list(out.bots);
  const b = r.bot ? bots.find((x) => x.id === r.bot) : undefined;
  const chief = bots.find((x) => x.isMain === true && wsOfBot(x) === wsId);
  const to = b ?? chief;
  const said =
    r.route.said && to
      ? {
          id: `msg_change_${who.userId}_${key}`,
          chatId: `bot:${String(to.id)}`,
          role: "system",
          botId: to.id,
          text: `${who.name} ${r.route.said(body, { bot: typeof b?.name === "string" ? b.name : undefined, ...(r.app ? { app: r.app } : {}) })}${o.macOn === false && r.bot ? followWords(blob, out, r.bot) : ""}`,
          at,
        }
      : null;
  return { blob: out, said };
}
