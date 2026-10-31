/** Shared shapes for the Bops app state, used by both the server and the UI. */

import type { AppHosting, AppsForMembers, IngotToken } from "./hosted-apps";
import type { Chain } from "./chain";
import type { MemberAccessMap, MemberWho } from "./member-access";
import type { Ping } from "./pings";
import type { SharedOpen } from "./shared";
import { botHasSkill, type SkillLabelInfo } from "./skill-labels";

export type BotId = string;

export type Bot = {
  id: BotId;
  name: string;
  role: string;
  color: string;
  isMain: boolean;
  /** Its own Orgo computer's UUID. A bot with its own computer gets a fork of the main bot's on first use; one that shares has none. */
  computerId?: string;
  /**
   * That computer's memory in GB, as Orgo last said (a copy of it is as big, which the plan must have
   * room for). Unknown until Bops has seen it up; only meaningful while computerId is set.
   */
  computerRam?: number;
  /**
   * Which computer it works on: the main bot's ("shared", the default for new bots: no computer of
   * its own to pay for or set up) or its own. Unset on bots from before the choice: they keep the
   * computer they have, and share if they have none. See sharesComputer. A main bot has its own,
   * except one that shares the user's free Bops computer with another workspace's main bot, for want
   * of room on the user's Orgo plan ("shared").
   */
  computer?: "shared" | "own";
  /**
   * Its computer is the user's one free Bops computer (orgo-web's bops_free): made by Bops from the
   * Bops template for a main bot, off the user's Orgo plan. One per Orgo account; only a main bot has it.
   */
  freeComputer?: boolean;
  computerStatus: "none" | "cloning" | "ready" | "error";
  /**
   * Its computer's id while Bops has made it and never had it ready: nothing has run on it, so a setup
   * that fails may delete it (ensureComputer). Cleared once it's ready. A computer Bops didn't make (the
   * user's free one taken up again, one from another Mac) or once had working never has it: a failed
   * setup never deletes that one, whatever Orgo says about it.
   */
  computerNeverReady?: string;
  /** Its computer, asleep, couldn't be woken when the user last took control, and why (cleared when a takeover wakes it). */
  wakeFailed?: { why: string; at: number };
  /** How to reach the bot, shown on its Details card. Empty until its phone and inbox exist. */
  phone?: string;
  email?: string;
  /**
   * Its AgentPhone line (lib/server/phone.ts): the number, and the AgentPhone agent it's attached to.
   * `plan`: it came with the user's Pro or Max plan (Bops Cloud set it up, lib/server/cloud-plan.ts);
   * `paused`: that plan ended, so calls and texts to it go unanswered until the user upgrades again.
   */
  phoneLine?: { numberId: string; agentId: string; plan?: boolean; paused?: boolean };
  /** The voice it speaks in on calls (voiceFor in lib/server/call.ts), kept so Bops Cloud answers its calls in the same one while the Mac is away. */
  voice?: string;
  /**
   * Its AgentMail inbox (lib/server/mail.ts): the current one, and older ones (mail to them still
   * arrives). `plan` and `paused` as for phoneLine: a paused inbox's mail isn't read or answered.
   */
  mail?: { inboxId: string; podId: string; past?: string[]; seenAt?: number; plan?: boolean; paused?: boolean };
  /**
   * The user asked for this bot's email (Get an email, on Max): with Bops Cloud's plan limits on, a bot
   * besides the plan's main bot gets an inbox only then, while the plan has room (lib/server/mail.ts).
   */
  mailWanted?: boolean;
  /**
   * What the user set for this bot in your app accounts (by AppAccount id): read, act, or "none". An
   * account with no entry gets the default (levelOf): every bot may read and act there, except in one
   * from before that default (AppAccount.onlyGiven), where it has none.
   */
  access?: Record<string, AppAccess>;
  /** This bot's Composio session (its allowed apps and actions), and the access it was made for. */
  composio?: { sessionId: string; access: string };
  /** The secret this bot's threads use to reach its apps through Bops (/api/apps/call). */
  appsKey?: string;
  /** Its Orgo computer's address on the user's tailnet, once it has joined. Bops reaches the screens' Chrome there. */
  tailnet?: { ip: string; name: string };
  /** How hard it thinks on its threads. "auto" (the default) lets Jev judge each task: high for hard ones, medium otherwise. */
  effort?: Effort;
  /** Where this bot's tasks run: decided per task (auto), always its cloud computer, or always the user's Mac. */
  runsOn?: "auto" | "cloud" | "mac";
  /**
   * "Just do it": it sends, posts, changes and deletes in the user's apps and email without waiting for
   * their OK (said in its chat after), and its tasks don't stop to confirm. Paying on a website still asks. Off by default.
   * For what asks the user, it allows what no rule of the bot's says (lib/permission.ts allows).
   */
  autoApprove?: boolean;
  /**
   * What this bot may do without asking the user, as rules (lib/permission.ts): Always allow on a request for
   * their OK saves one for that action, so that action never asks again, whoever it's for. Only the user's own
   * Bops writes them (a computer never may: cloud/computer-scope.ts).
   */
  permissions?: PermissionRule[];
  /**
   * Business data (lib/server/treg.ts: companies, people, work emails, signals, places) is off for this
   * bot. On for every bot unless the user turns it off, whenever treg is set up.
   */
  dataOff?: boolean;
  /** The workspace (team) it belongs to. Unset means the first one. */
  workspaceId?: string;
  /**
   * "How I work": what the user wrote about how this bot should work (tone, habits, what to check first),
   * up to MAX_PERSONA_CHARS. Given to it in its chat, tasks and calls as the user's preferences; it never
   * overrides Bops' own rules (approvals, text on pages being information).
   */
  persona?: string;
  /**
   * Keys (lib/server/keys.ts): the names of the user's API keys in their Orgo vault this bot may call
   * with call_api ("STRIPE_SECRET_KEY"). Only the names: the keys themselves never leave Orgo.
   */
  keys?: string[];
  /**
   * Its brain (Brain.id, lib/server/brains.ts): the agent its tasks run on, when it isn't Bops' own. Unset is
   * Bops agent, on AI credit. One that names a brain this bot isn't on any more, or one that's gone, is Bops
   * agent too (brainOf).
   */
  brain?: string;
  /**
   * Its AI profile (lib/agents.ts): the agents its threads may run on, each with how it pays and the account
   * it uses, and its Default. Unset is Bops agent only, on AI credit, exactly as before: a profile equal to
   * that is never stored. Only the owner's own Bops changes it (a computer never may: cloud/computer-scope.ts).
   * `brain` above is kept in step with it for older Bops (the Default's account, when that's Claude Code or Codex).
   */
  ai?: BotAi;
  /**
   * The labels of its workspace's skills it has (lib/skill-labels.ts botHasSkill): unset is every label
   * (as every bot had before), an empty list none. A skill whose own bot list names bots goes by that list
   * instead. Bops' own skills are every bot's whatever this says. Set in Who has what, in Skills, and in
   * the bot's own Skills; sent to orgo-web as bops_bots.skill_labels where it takes it (bops-sync.ts).
   */
  skillLabels?: string[];
};

/**
 * What a bot's settings page set (components/app/bot-settings.tsx), kept on its workspace by bot id
 * (Workspace.botSettings) rather than on the bot: a Bops from before that changes the bot (an email noted, its voice
 * kept) before it has the newer state puts back its whole copy of the bot (state-merge.ts merge3), which would take
 * these with it; a workspace merges field by field, and a Bops from before never writes this one. Unset: as before.
 */
export type BotSettings = {
  /**
   * The voice it speaks in on calls, picked from CALL_VOICES. Unset: voiceFor's pick for its name, kept in Bot.voice.
   * Never written into Bot.voice: a Bops from before rewrites that on every call, and Bops Cloud reads it.
   */
  callVoice?: CallVoice;
  /** false: calls to its number hear a short no and are hung up (phone-voice.ts). Unset: it answers, as before. */
  answersCalls?: false;
  /**
   * Built in sequences turned off (lib/sequences.ts): `othersMail`, mail from anyone but the user shows as a card and
   * the bot stays quiet; `othersCalls`, a stranger's call hears a short no. Unset: all on, as before.
   */
  sequencesOff?: { othersMail?: true; othersCalls?: true };
  /**
   * Replies to others is Never (lib/permission.ts mailRule): it emails nobody but the user, and doesn't ask. Its
   * "Send an email" rule says ask meanwhile, which is what a Bops from before does with it.
   */
  mailNever?: true;
};

/** Bot `b`'s settings page settings (Workspace.botSettings), none set: {}. */
export function settingsOf(state: { workspaces?: { id: string; botSettings?: Record<string, BotSettings> }[] }, b: Pick<Bot, "id" | "workspaceId">): BotSettings {
  const all = state.workspaces?.find((w) => w.id === workspaceOf(b))?.botSettings;
  return (all && Object.hasOwn(all, b.id) ? all[b.id] : undefined) ?? {};
}

/**
 * The site of one of its workspace's apps a bot works on (Workspace.botSites, set on its settings page's Works on row):
 * the app's name (Workspace.hostedApps) and the site's (the app's own is named as the app). Kept on the workspace by bot
 * id, as BotSettings is and for the same reason: a bot changed on two Macs at once keeps one Mac's whole copy (by
 * v0.0.32 and by this build alike: state-merge.ts merge3), which would drop a field on the bot; a workspace merges
 * field by field, and this map bot by bot.
 */
export type BotSite = { app: string; site: string };

/** Bot `b`'s site (Workspace.botSites), or undefined when it works on none. Read it here: never off the bot. */
export function siteOf(state: { workspaces?: { id: string; botSites?: Record<string, BotSite> }[] }, b: Pick<Bot, "id" | "workspaceId">): BotSite | undefined {
  const all = state.workspaces?.find((w) => w.id === workspaceOf(b))?.botSites;
  const x = all && Object.hasOwn(all, b.id) ? all[b.id] : undefined;
  return x && typeof x.app === "string" && typeof x.site === "string" ? x : undefined;
}

/**
 * The bot of workspace `ws` whose site (siteOf) is site `site` of app `app` (the app's own named as the app), if any.
 * A site no bot has is its app's own bot's (its hosting record's), which the server's siteBot and the Preview tab
 * (bops-app.tsx: Fix it, Select and Draw ask there) fall back to.
 */
export function siteBotOf<B extends Pick<Bot, "id" | "workspaceId">>(state: { bots: B[]; workspaces?: { id: string; botSites?: Record<string, BotSite> }[] }, ws: string, app: string, site: string): B | undefined {
  return state.bots.find((b) => {
    const y = workspaceOf(b) === ws ? siteOf(state, b) : undefined;
    return y?.app === app && y.site === site;
  });
}

/** The nine voices calls speak in (OpenAI realtime), the same lib/server/call.ts picks from by name. */
export const CALL_VOICES = ["cedar", "ash", "echo", "ballad", "verse", "marin", "coral", "shimmer", "sage"] as const;
export type CallVoice = (typeof CALL_VOICES)[number];
export const isCallVoice = (v: unknown): v is CallVoice => typeof v === "string" && (CALL_VOICES as readonly string[]).includes(v);
/** What a phone line's agent speaks in (Workspace.lineVoices): call voice `for`, as AgentPhone's voice `id` named `name`. */
export type LineVoice = { for: CallVoice; id: string; name: string; exact?: true };

export const MAX_PERSONA_CHARS = 1500;

/** A workspace: one team with its own main bot, bots, chats and work. The user switches between them. */
export type Workspace = {
  id: string;
  name: string;
  createdAt: number;
  /** Where its memory lives (lib/server/memory.ts): unset is its own bank; set when it shares another workspace's. */
  memory?: { bank: string; peer: string };
  /**
   * Its part of every bot's email address (sam@<slug>.bops.bot), unique across every Bops install.
   * On Bops Cloud it's the handle the workspace claimed there (`mailClaimed`; cloud/handles.ts):
   * one from before handles is kept for the bots that have it, and new bots get the claimed one.
   */
  mailSlug?: string;
  /** `mailSlug` is this workspace's handle in Bops Cloud (bops.mail_handles), claimed once across every user. */
  mailClaimed?: boolean;
  /**
   * The "Pick your Bops address" step (components/app/mail-address.tsx): waiting for the user to pick
   * the workspace's handle before its first inbox (`offer` unset), or offering to change one Bops
   * picked for them (`offer`: they chose later, or a plan set it up while the Mac was closed).
   * Unset once they've picked, kept it, or chosen later.
   */
  mailPick?: { at: number; offer?: boolean };
  /** The handle just changed: the workspace's bots move to it (their old addresses still get mail). */
  mailMove?: boolean;
  /**
   * The workspace's phone number (lib/server/phone.ts): people text its main bot there, and the main
   * bot hands work to the others. `previous` is the AgentPhone agent the number came from, for rollback.
   */
  line?: WorkspaceLine;
  /**
   * The Orgo workspace (an orgo-web project marked product "bops") this workspace is, once Orgo has
   * one for it (lib/server/workspaces.ts). Unset on an Orgo without per workspace projects: every
   * workspace's computers then live in the one "bops" project, as before.
   */
  orgoProjectId?: string;
  /**
   * The secret Orbit's hashes of what was forgotten are keyed with (HMAC-SHA256: lib/server/memory-categories.ts),
   * made once by the first Mac that needs it and synced to the others with the state, so each Mac knows what
   * the others forgot. Never sent to Orgo, and never to the window.
   */
  orbitKey?: string;
  /**
   * Its Orgo project's name as Orgo has it, last seen or set here; `orgoUpdatedAt` its updated_at then. A
   * list that names the project otherwise was renamed on orgo.ai, and the name comes here too
   * (syncWorkspaceNames). It may differ from `name`: "orgo (Bops)" for a workspace named "orgo" here, or
   * "bops" for a default the user renamed while an older Bops app is still on the account.
   */
  orgoName?: string;
  orgoUpdatedAt?: string;
  /** Its skills and apps (lib/server/workspace-skills.ts): what each is, by slug. The files are on this Mac. */
  skills?: SkillRef[];
  apps?: SkillRef[];
  /** Scripts someone approved to run in this workspace, by the content's sha256. */
  approvals?: ScriptApproval[];
  /**
   * What the owner wrote about its skills' labels (lib/skill-labels.ts SkillLabelInfo): orgo-web's
   * skill_labels as last read, or as changed here. `skillLabelInfoUnsent`: changed here and not taken by
   * Orgo yet (the next skills sync sends it). Optional: a label with no row works the same.
   */
  skillLabelInfo?: SkillLabelInfo[];
  skillLabelInfoUnsent?: boolean;
  /** Skills → Suggest labels with AI turned off: a new skill's label comes only from its words (unset: on). */
  skillLabelsAIOff?: boolean;
  /**
   * Tags this workspace sorts mail and messages with besides the defaults (lib/routine-catalog.ts
   * DEFAULT_TAGS: Customer, Outage, Bug, Office, FYI). Proposed by a bot from a sample of recent mail
   * or messages when a Gmail, Slack or Discord starter routine is turned on
   * (lib/server/routine-suggestions.ts learnTags), or added by the user.
   */
  tags?: WorkspaceTag[];
  /** The Connected Apps whose recent items tags were already learned from (one sample per app). */
  tagsLearnedFrom?: string[];
  /**
   * The workspace's apps on the web, by Ingot repo name (lib/hosted-apps.ts): which bot's computer holds
   * each one's working folder and runs its site, and its deploy project and URL once deployed.
   */
  hostedApps?: Record<string, AppHosting>;
  /**
   * The agent token each of its computers signs in to Ingot with, by computer id (lib/hosted-apps.ts): its
   * id, never the token. Revoked once no app of the workspace is on that computer, or it's gone.
   */
  ingotTokens?: Record<string, IngotToken>;
  /**
   * Knowledge's kinds pinned to the sidebar's Favorites, in the user's order (lib/favorites.ts): unset
   * until the user first pins or unpins one (the defaults show until then), then their list as it is,
   * an empty one included. Synced with the state, so it follows them to their other Macs.
   */
  favorites?: string[];
  /**
   * What each person the owner added may do with this workspace's bots, by email (lib/member-access.ts):
   * none, read or write per bot, and for the bots not named (new ones too). Someone not here sees no
   * bot. Bops Cloud reads it from the owner's state to build a member's view; it never goes to them.
   */
  memberAccess?: MemberAccessMap;
  /**
   * The team chart (lib/chain.ts): who each bot answers to, who may ask whom, who takes work handed down,
   * which bots keep their memory to themselves and whom each works for. Unset: every bot answers to the main
   * bot and may ask every other, as before. Only the owner's own Bops writes it (workspaces.ts setChain); like
   * memberAccess it never goes to a member (cloud/ws-slice.ts).
   */
  chain?: Chain;
  /**
   * When this Mac gave everyone already here Your Apps at Read (workspaces.ts giveAppsRead): once, so an entry an older
   * Bops rewrote later is never given Read again by that.
   */
  appsScopeAt?: number;
  /**
   * What people with Your Apps at Read or more are shown of its apps on the web (lib/server/apps-for-members.ts), as this
   * Mac last read Ingot and Orgo. Only there while someone has Read or more. Bops Cloud sends parts of it to them
   * (cloud/ws-slice.ts appsFor); never variables, tokens, keys, logs or error text.
   */
  appsForMembers?: AppsForMembers;
  /** Its bots' settings page settings, by bot id (BotSettings): none for a bot with nothing set. Never sent to members. */
  botSettings?: Record<string, BotSettings>;
  /**
   * The voice each of its phone lines speaks in on calls to its number, by AgentPhone agent id (lib/server/phone.ts
   * voiceToAgent): the call voice it was set for and AgentPhone's voice closest to it (`exact`: the same voice by name).
   * Written only once AgentPhone took it, so the settings page says what calls to the number sound like. Unset: the
   * line's own voice. A Bops from before never writes it, and merges it as a workspace field.
   */
  lineVoices?: Record<string, LineVoice>;
  /**
   * Logins of the owner's switched on here besides where they were connected (Used in, on the Logins page), by
   * loginKey: a Connected App by its account ("app:<id>"), a key of another workspace by its Orgo project and name
   * ("key:<project>:<NAME>"). Here a Connected App has the same default as where it was connected (Read & act for
   * every bot, unless only the bots given it have it), and a key may be given to the bots here (Bot.keys). Kept on the
   * workspace that uses it, never on the login: a Bops from before (v0.0.32) merges a workspace field by field and
   * never writes this one, and its syncApps rebuilds or drops accounts. Lost, a login is back to its own workspace and
   * the bots given it: less access, never more. Site logins have none: their bots (VaultLogin.bots) say where.
   */
  loginsOn?: Record<string, LoginOn>;
  /**
   * The names the owner gave its computers, by computer id (lib/bot-groups.ts): the sidebar shows the bots that work on
   * one computer together under it. Unset for one: a name from the apps on it, else its bot's ("Sam's computer"). Only
   * the owner's own Bops writes it; a Bops from before never writes it and merges it as a workspace field, name by name.
   */
  computerNames?: Record<string, string>;
  /** The site each of its bots works on, by bot id (BotSite, read with siteOf). None for a bot that works on none. */
  botSites?: Record<string, BotSite>;
};

/** A login switched on in a workspace (Workspace.loginsOn): when. */
export type LoginOn = { at: number };

/** A tag routines sort by: a short name and what it's for. */
export type WorkspaceTag = { name: string; description: string };

/**
 * Where a routine or watch came from, when it was a starter (lib/routine-catalog.ts): the Connected App's
 * slug or the vault key's name it's for, and the catalog template's id. One per template per bot. A
 * Connected App's check (CHECK_TEMPLATE, the How often picked when it was connected) keeps the account it
 * checks too: one per account per bot.
 */
export type RoutineSource = { app: string; template: string; account?: string };

/** A skill (how a bot does a kind of job) or an app (a tool Bops builds and bots run). */
export type SkillKind = "skill" | "app";
export type SkillRisk = "read" | "write" | "destructive";

/**
 * One skill or app of a workspace: a folder in the Agent Skill shape (SKILL.md and its files) at
 * <userDir>/workspaces/<id>/skills/<slug>/ (apps/<slug>/ for an app). This is what the app and the
 * bots list without reading the folder; the folder holds the rest.
 */
export type SkillRef = {
  slug: string;
  kind: SkillKind;
  name: string;
  /** What it does and when to use it: all a bot sees until it reads it (read_skill). */
  description: string;
  /** The label it's listed under (lib/skill-labels.ts); unset is Unsorted. Kept in its SKILL.md, so it syncs with Orgo. */
  label?: string;
  /**
   * Who chose its label: the owner here ("user"), the skill itself (its SKILL.md, a bot's create_skill, Orgo),
   * or Bops ("auto": from its words or a small model, lib/server/workspace-skills.ts suggestLabels), a
   * suggestion shown with Confirm and Change that stays out of its SKILL.md and Orgo until it's confirmed,
   * changed or published. Unset with a label: one kept from before this, as chosen.
   */
  labelBy?: "user" | "skill" | "auto";
  /** draft: its bots don't see it yet; published: they do, at `version`. */
  status: "draft" | "published";
  /** The version its bots read (published), and every version kept, newest last. */
  version?: string;
  versions?: { version: string; at: number; sha256: string }[];
  risk?: SkillRisk;
  runsOn?: string;
  /** The bots that have it. Empty: every bot in the workspace. */
  botIds: string[];
  /** Where it came from: written in Bops, imported from a folder, made in Orgo, or a procedure from before. */
  source: "bops" | "import" | "orgo" | "procedure";
  createdAt: number;
  updatedAt: number;
  /** The id it had as a procedure (Procedure.id), so routines and threads that named it still find it. */
  legacyId?: string;
  /** Orgo's id for it and when Orgo last changed it (lib/server/workspace-skills.ts sync). */
  remoteId?: string;
  /** The Orgo project that id is in: once set, a sync that no longer finds it there takes it as deleted there. */
  remotePid?: string;
  remoteAt?: string;
  /** The version Orgo had when they last agreed ("" for none), so a sync that reads only what changed since (?since=) knows Orgo's copy of one that didn't. */
  remoteVersion?: string;
  /**
   * The label in Orgo's SKILL.md when they last agreed (sent or brought here: Unsorted for none, and for a suggestion not sent). A move here reaches Orgo only
   * with the next version (orgo-web's PATCH doesn't take a label), so a pull that brings this same one back
   * keeps the label here; one Orgo changed comes here.
   */
  remoteLabel?: string;
  /** When this Mac and Orgo last agreed on it: a change here after this goes to Orgo. */
  syncedAt?: number;
  /** How many times a bot read it for a job, and when it last did. */
  uses?: number;
  usedAt?: number;
  /** The chat it was drafted from. */
  from?: { chatId: string; sessionIds?: string[] };
};

/** A script someone approved to run, by its content (an unchanged script carried into a new version stays approved). */
export type ScriptApproval = {
  sha256: string;
  path: string;
  at: number;
  /** Orgo has it (sent from here, or made on orgo.ai): one it no longer lists was revoked there (lib/server/workspace-skills.ts). */
  synced?: boolean;
  /**
   * Made in a Bops window by the person signed in (approveScript), not taken from Orgo. One taken from
   * Orgo counts only while Orgo says that person made it: another member's approval never runs a script here.
   */
  inBops?: boolean;
};

export type WorkspaceLine = {
  phone: string;
  numberId: string;
  agentId: string;
  type: "imessage" | "sms";
  /** Which AgentPhone account holds it: the parent account, or the Bops sub-account. */
  scope: "parent" | "sub";
  previous?: { agentId: string | null; webhookUrl?: string | null };
  at: number;
};

/** Why a fact looks learned wrong (memory.ts reviewMemory). "unsure" ones are checked one by one; the rest can go all at once. */
export type MemoryGroup = "passing" | "agent_rule" | "someone_else" | "unsure";

/**
 * Where two bots' conversation with each other is kept (Max asks Sam, Sam answers), whichever asked:
 * its messages have this chatId; there's no Chat for it, so it isn't in the sidebar.
 */
export const pairChatId = (a: string, b: string) => `pair:${[a, b].sort().join(":")}`;

/** The workspace every older bot and chat belongs to. */
export const MAIN_WORKSPACE = "ws_main";

/**
 * The first Bops release that finds its default workspace by bops_ws_id rather than by the name "bops"
 * (lib/server/workspaces.ts). An app before it looks for a project named "bops", so the default's project
 * keeps that name until every app on the account is at least this one (lib/server/orgo.ts bopsAppsGate),
 * and the switcher says so (sidebar.tsx heldNameNote).
 */
export const WORKSPACE_APPS_SINCE = "0.0.29";
export const workspaceOf = (b: { workspaceId?: string } | undefined) => b?.workspaceId ?? MAIN_WORKSPACE;

/**
 * Whether a bot works on another bot's computer rather than its own: a bot on its workspace's main
 * bot's, or a main bot on the free Bops computer another workspace's main bot has (when the user's
 * Orgo plan has no room for one of its own; lib/server/plan.ts makeMainComputer).
 */
export const sharesComputer = (b: Pick<Bot, "isMain" | "computer" | "computerId">) =>
  b.isMain ? b.computer === "shared" && !b.computerId : (b.computer ?? (b.computerId ? "own" : "shared")) === "shared";

/** The main bot that has the user's free Bops computer, if one of them does (other than `except`). */
export const freeComputerBot = (bots: Bot[], except?: string) => bots.find((x) => x.isMain && x.freeComputer && x.computerId && x.id !== except);

/**
 * The free Bops computer when the workspace `wsId` is deleted: null when no bot of it holds it. It sits in
 * the default's "bops" project, so Orgo's preview of the workspace never lists it, and main bots of other
 * workspaces may work on it (computer "shared", lib/server/plan.ts shareFree) or have it on record too. Then
 * it stays (`kept`): `heir` is the main bot of another workspace that takes it up, none when another bot
 * has it already. Otherwise it is deleted with the workspace, and the confirm says so.
 */
export function freeComputerOnDelete(bots: Bot[], wsId: string): { id: string; holder: Bot; kept: boolean; heir?: Bot } | null {
  const holder = bots.find((x) => x.isMain && x.freeComputer && x.computerId && workspaceOf(x) === wsId);
  if (!holder) return null;
  const id = holder.computerId!;
  const others = bots.filter((x) => workspaceOf(x) !== wsId);
  if (others.some((x) => x.computerId === id)) return { id, holder, kept: true };
  const heir = others.find((x) => x.isMain && sharesComputer(x));
  return heir ? { id, holder, kept: true, heir } : { id, holder, kept: false };
}

/**
 * The bot whose Orgo computer `b` works on: itself, or its main bot when it shares (and that main
 * bot's own host, when it shares the free Bops computer). Anything about the machine (its id, status,
 * tailnet address, screens) comes from this bot; the work stays `b`'s.
 */
export function workBot(b: Bot, bots: Bot[]): Bot {
  if (!sharesComputer(b)) return b;
  if (b.isMain) return freeComputerBot(bots, b.id) ?? b;
  const main = bots.find((x) => x.isMain && workspaceOf(x) === workspaceOf(b));
  return main ? workBot(main, bots) : b;
}

/**
 * The coding agents a user can bring for their bots' tasks instead of Bops agent (lib/server/brains.ts):
 * Claude Code, the unmodified one Bops installs on the bot's computer, and Codex. They run on the user's
 * own account, never on Bops' AI credit.
 */
export type BrainKind = "claude" | "codex";
/** The agents a thread can run on (lib/agents.ts AGENTS). "bops" is Bops' own agent, on OpenAI. */
export type AgentKind = "bops" | "claude" | "codex" | "opencode" | "agy";
/** The CLI agents this build drives on a bot's computer (lib/server/cli-agents.ts DRIVERS). */
export type CliKind = "claude" | "codex" | "opencode";
/** Who pays for a thread's AI: Bops AI credit, the user's own plan signed in on the computer, or their own key from the Vault. */
export type AgentPays = "credit" | "plan" | "key";
/**
 * One agent in a bot's AI profile: what runs, how it pays, the account it runs on, and the model new threads on
 * it start with. Never secret: a key stays in the Vault, a plan's login stays in its folder on the computer.
 */
export type BotAgent = {
  /** "bops" for Bops agent; else "ag_" and 10 letters or digits. A thread names its agent by this. */
  id: string;
  kind: AgentKind;
  pays: AgentPays;
  /** The AI account (Brain.id) for Claude Code and Codex. Never for Bops agent or OpenCode. */
  account?: string;
  /** For new threads (lib/agents.ts MODELS). Unset: the kind's default (Bops agent: Auto). */
  model?: string;
};
/** A bot's AI profile. Unset: Bops agent only, as its Default, exactly as before. */
export type BotAi = { agents: BotAgent[]; default: string };
/**
 * Whether this build has brains: NEXT_PUBLIC_BOPS_BRAINS=1 where it's built (or where `next dev` starts,
 * .env.local too). Next writes the value into the server and the window alike as it builds them, and a
 * release builds with it 0 (scripts/release.sh). Without brains nothing about them shows (Settings, a bot's
 * profile, a thread's badge and Open in terminal), every bot is on Bops agent (brainOf) and every task runs
 * there, a thread a brain ran included (sessions.ts brainRecord), and the brain routes answer 404. The brains
 * saved in the state stay as they are, for a build that has them.
 */
export const BRAINS_ON = process.env.NEXT_PUBLIC_BOPS_BRAINS === "1";
export const BRAIN_NAMES: Record<BrainKind, string> = { claude: "Claude Code", codex: "Codex" };
/** The CLI agents' names (lib/agents.ts AGENTS has them all). */
export const CLI_NAMES: Record<CliKind, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
/** The Vault key a key brain runs on (lib/server/keys.ts KEY_PROVIDERS): the user's own Anthropic or OpenAI key. */
export const BRAIN_KEYS: Record<BrainKind, string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" };
/**
 * How a brain signs in: with the user's own Claude plan (Pro, Max, Team), through Claude Code's own sign-in
 * on each computer it works on, or with an API key of theirs from the Vault. Codex takes a key only.
 */
export type BrainAuth = "plan" | "key";

/**
 * Claude Code signed in with a plan on one computer, as its own `claude auth status --json` said when Bops
 * last asked: how it signed in ("claude.ai") and whose account it is (the email, the organization, the
 * plan: "max", "pro", "team"). Never the login itself: that stays in the brain's folder on that computer,
 * which Bops never reads, copies or sends anywhere.
 */
export type BrainSignIn = { computerId: string; at: number; method?: string; account?: { email?: string; orgName?: string; plan?: string } };

/**
 * A brain the user added (Settings, Brain): Claude Code or Codex, how it signs in, and which bots may use it.
 * A bot uses it once it's that bot's (Bot.brain). Nothing secret is here: a key brain names its Vault key
 * (`keyName`, scoped as the Vault's keys are: lib/server/keys.ts KeyScope) and the key stays in the user's
 * Orgo vault; a plan brain's logins stay on the computers, one folder per brain on each
 * (/root/.bops/brains/<id>), and only what `signIns` says comes back.
 */
export type Brain = {
  id: string;
  kind: BrainKind;
  /** "Claude Code", "Claude Code (work)": the user can rename it. */
  name: string;
  auth: BrainAuth;
  keyName?: string;
  keyScope?: "workspace" | "all";
  /** The bots that may use it: each one's profile offers it. Empty: none yet. */
  bots: BotId[];
  workspaceId: string;
  createdAt: number;
  /** A plan brain: the computers it's signed in on. A bot on another computer needs its own sign-in there. */
  signIns?: BrainSignIn[];
  /**
   * A plan brain signing in now: Claude Code's own sign-in is open in a terminal on `display` of that
   * computer, the user drives that screen, and Bops asks Claude Code until it says it's signed in.
   * `failed`: it didn't finish, and why (kept until the next try).
   */
  signingIn?: { botId: BotId; computerId: string; display: number; at: number; failed?: string };
};

/** "Max plan", "Pro plan": a Claude plan as Claude Code names it (BrainSignIn's plan); "Claude plan" when it didn't say. */
export const planName = (plan?: string) => (plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan` : "Claude plan");

/** A bot's brain, or undefined for Bops agent: one it picked that still lets it in, and is still there, in a build with brains (BRAINS_ON). */
export function brainOf(b: Pick<Bot, "id" | "brain">, state: Pick<AppState, "brains">): Brain | undefined {
  if (!BRAINS_ON || !b.brain) return undefined;
  const x = state.brains?.find((y) => y.id === b.brain);
  return x && x.bots.includes(b.id) ? x : undefined;
}

/** Where a plan brain is signed in on a computer, if it is. */
export const signInOn = (x: Pick<Brain, "signIns">, computerId: string | undefined) => (computerId ? x.signIns?.find((s) => s.computerId === computerId) : undefined);

/**
 * Whether a brain can run `b`'s tasks now: a key brain with its key named, or a plan brain signed in on the
 * computer `b` works on (workBot). Bots on this Mac's browsers (host "mac") have no computer of their own to sign in on.
 */
export function brainReady(x: Brain, b: Bot, state: Pick<AppState, "bots" | "host">): boolean {
  if (x.auth === "key") return !!x.keyName;
  return state.host !== "mac" && !!signInOn(x, workBot(b, state.bots).computerId);
}

/**
 * Who runs a thread now (sessions.ts brainFor): its brain's CLI once that began it (Session.brainRun), until
 * Bops agent runs any of it (its agent session or response chain, or the user had it finish there), from when
 * on it stays Bops agent's ("agent"), which knows what it did; nobody yet while nothing has run it.
 */
export function threadRunner(s: Pick<Session, "brainRun" | "onBopsAgent" | "agentSessionId" | "responseId">): CliKind | "agent" | undefined {
  if (s.onBopsAgent || s.agentSessionId || s.responseId) return "agent";
  return s.brainRun?.started ? s.brainRun.kind : undefined;
}

/**
 * Whether a thread's brain can be asked to compact what it has so far (Compact: lib/server/sessions.ts compactThread),
 * once it ran: Claude Code (its own /compact), and Bops agent on the Responses API's computer tool (a compaction of its
 * response chain). Not Codex or OpenCode as Bops runs them (a `codex exec` or `opencode run` for each message, and
 * neither compacts), nor an Agents API session (OpenAI compacts it itself, and takes no request to). Each compacts by
 * itself too, as it always did.
 */
export function threadCompacts(s: Pick<Session, "brainRun" | "onBopsAgent" | "agentSessionId" | "responseId" | "runsOn">): boolean {
  const r = threadRunner(s);
  if (r === "claude") return BRAINS_ON && s.runsOn !== "mac";
  return r === "agent" && !!s.responseId && !s.agentSessionId && s.runsOn !== "mac";
}

/** What Compact on a thread waits for, or null when it can go now: not while it runs, and not again with nothing said since the last one. */
export function threadCompactBlocked(s: Session): string | null {
  if (live(s) || s.compact) return "Wait for it to finish.";
  const last = s.steps.findLast((x) => x.tool === COMPACTED);
  if (last && !s.replies.some((r) => r.at > last.at)) return "Nothing new to compact.";
  return null;
}

/** The step a thread's Compact leaves once its brain compacted (sessions.ts run): a quiet line in the thread. */
export const COMPACTED = "compacted";

/**
 * Which of a bot's tasks its brain runs (sessions.ts run: a task on the user's Mac always runs on Bops agent):
 * all of them, those in the cloud when it picks per task and this Mac can take some ("some"), or none, when
 * its tasks all run on this Mac (bots in this Mac's browsers, or a bot set to work on the user's Mac).
 */
export function brainRuns(b: Pick<Bot, "runsOn">, state: Pick<AppState, "host" | "mac">): "all" | "some" | "none" {
  if (state.host === "mac" || b.runsOn === "mac") return "none";
  return b.runsOn === "cloud" || !state.mac?.ready ? "all" : "some";
}

export type Effort = "auto" | "low" | "medium" | "high";
/** How hard a task's model thinks: OpenAI's reasoning efforts. */
export type TaskEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
/** How much thinking a job needs (lib/server/routing.ts): each is a model and an effort. */
export type RouteTier = "quick" | "standard" | "deep" | "max";
/**
 * What a task runs on and who chose it (lib/server/routing.ts routeTask): the bot's own setting, the
 * old rule (a hard task on Astra) or the router; what the router picked when it was asked (in
 * shadow, not what ran); and tiers up since (a retry after a failure, or the user saying it's wrong).
 */
export type TaskRoute = {
  model: string;
  effort: TaskEffort;
  by: "setting" | "rule" | "router" | "forced";
  /** Forced (a benchmark run, POST /api/sessions): its speed too, whoever's waiting. */
  speed?: "default" | "fast" | "ultrafast";
  tier?: RouteTier;
  router?: { model: string; effort: TaskEffort; tier: RouteTier; why: string };
  bumps?: number;
  long?: boolean;
  /** The bot's AI profile picked Bops agent's model (lib/agents.ts): every turn runs on it, a bump included. */
  pinned?: true;
};

/** Where bots' screens live: Chrome windows on the user's Mac, or Orgo cloud computers. */
export type Host = "mac" | "orgo";

/** A conversation: one per bot, plus group chats with several bots. */
export type Chat = {
  id: string;
  kind: "bot" | "group";
  botIds: BotId[];
  /** Group chats get a name; bot chats use the bot's name. */
  title?: string;
  createdAt: number;
  /** When the user last opened it, for unread dots. */
  readAt?: number;
  /** Bots currently writing a reply here. */
  typing: BotId[];
  /** While a bot waits on a teammate's answer before replying: who it's asking (asker → teammate). */
  asking?: Record<BotId, BotId>;
  /** The workspace it belongs to (a bot's own chat follows its bot). Unset means the first one. */
  workspaceId?: string;
  /** What its bots no longer read whole, summed up (lib/server/chat-summary.ts). Unset: nothing yet. */
  summary?: ChatSummary;
};

/**
 * A chat's summary of the messages its bots no longer read whole (lib/server/chat-summary.ts): the conversation so
 * far, which a bot reads before the chat's latest messages. Its messages fall out of what the bot reads a few at a time
 * (chat.ts history) and are folded in as they do; Compact folds in every one up to then, and the bot reads the chat
 * afresh from after them (`fresh`). A delete of one it holds writes it again from what's left (`rebuild`).
 */
export type ChatSummary = {
  /** The conversation so far, in plain sentences. "" while it's written again (`rebuild`). */
  text: string;
  /** When the newest message in it was said (Message.at): it holds the chat's messages up to then. */
  through: number;
  /**
   * When the oldest message it was written from was said, where it left older ones out (written from a long chat's last
   * messages): a delete of one before then (Keep chats' sweep), or one put back, doesn't touch it. None: from the chat's start.
   */
  since?: number;
  /** Set by Compact: when the newest message it folded in was said. The bot reads the chat from after it. */
  fresh?: number;
  /** A message it held was deleted: its text is gone, and it's written again from what's left up to `through`. */
  rebuild?: true;
  /** When it was last written. */
  at: number;
};

export type Message = {
  id: string;
  chatId: string;
  role: "user" | "bot" | "system";
  /**
   * The agent the owner picked in the message box (BotAgent.id) for the threads this message starts. Checked
   * against the bot's profile as they start; ignored on a member's message.
   */
  agent?: string;
  /** Who wrote it, for bot messages. */
  botId?: BotId;
  /**
   * Set on the note a bot leaves when it hands work to another ("Sam handed this to Max"): the bot it came
   * from, so a shared workspace never shows it to someone that bot is hidden from (cloud/ws-slice.ts).
   */
  from?: BotId;
  text: string;
  at: number;
  /** Threads this message started or reports on; shown as session chips under it. */
  sessionIds?: string[];
  /** Set on a thread's result: a newer result from the same thread replaces it in the chat (the thread keeps the history). */
  resultOf?: string;
  /**
   * Set on the line Compact leaves in a chat (lib/server/chat-summary.ts compactChat): its bots read it afresh from
   * here, after the chat's summary (Chat.summary), which pressing the line shows. `member` says who pressed it, when it wasn't the owner.
   */
  compacted?: true;
  /** Set on the note a voice call leaves in the chat: how long it lasted, and the number it came from if it was a phone call. */
  call?: { seconds: number; phone?: string };
  /** The user sent this by text message to the bot's phone number, or in Slack, Telegram or Discord (the reply goes back the same way). */
  via?: "sms" | ChannelKind;
  /** Where in Slack, Telegram or Discord it was said, so the answer (and later results) go back there. */
  channel?: ChannelPlace;
  /** The same message on the phone side (AgentPhone), so tapbacks and threaded replies can cross over. */
  phone?: { apId?: string; conversationId?: string; from?: string };
  /** A text someone else sent the bot's number (in), or the bot sent (out). */
  sms?: { dir: "in" | "out"; from: string; to: string; id?: string };
  /**
   * Set on the note an app action leaves when the user answered its approval: what the app answered, so
   * the bot sees whether it worked. `unasked`: a call that went out without asking them (a GET that
   * failed: keys.ts callApi), which is never read as their approval.
   */
  appResult?: { action: string; ok: boolean; output: string; unasked?: true };
  /** Set on a bot's reply: the API calls it made with the user's keys for it (call_api), "Called Stripe GET /v1/customers". */
  called?: string[];
  /** Set on a heads-up from a watched screen: which watch, so the message can offer to show it or reply. */
  watch?: { id: string };
  /**
   * Posted by a routine's run in the chat (Routine.run "chat"), or a reminder: which routine. `manual`:
   * a run someone asked for (Run now), so a turn in Slack or by text that asked for it sends it back there.
   * `at`: when that run began (its RoutineRun.at), so its report goes with that run (lib/routine-reports.ts);
   * unset on what was posted before Bops kept it.
   */
  routine?: { id: string; manual?: true; at?: number };
  /**
   * The user asked to keep this from someone ("between us"): never read into the shared memory or a
   * procedure's draft. Someone the owner gave its bot still sees it in a shared workspace (cloud/ws-slice.ts).
   */
  secret?: true;
  /** An inline reply (like iMessage's): the message it starts from. Replies to a reply join the same one. */
  replyTo?: string;
  /**
   * Said by someone the owner gave Write on this chat's bots, from their own Bops (cloud/members.ts act), not by
   * the owner: `ref` is their key for it, so a retry isn't added twice and their window swaps its own copy for this one.
   */
  member?: MemberSaid;
  /**
   * In the window only, never synced: one the viewer of a shared workspace sent that the owner's Bops hasn't
   * written yet (lib/server/shared-core.ts viewState makes it), and how it stands: on its way, waiting for the
   * owner's Bops to open, or not sent (`error`). `key` sends it again as the same act.
   */
  memberSend?: MemberSend;
  /** Tapbacks on this message, the user's and the bots'. One each. */
  reactions?: Reaction[];
  /** Replies the bot offered, shown as buttons the user can tap to answer. */
  options?: string[];
  /** Worth interrupting the user for (a finished task they're waiting on): a chime, and a notification if Bops is behind. */
  ping?: boolean;
  /** A thread's result that asked the user something (lib/asks.ts): kept in the chat when the thread moves on, with how it was answered. */
  needed?: boolean;
  /** An email the bot got (in) or sent (out); `text` is its new text, without the quoted history. */
  email?: EmailInfo;
  /** A bot reply that also went to the user by email (they emailed the bot): the address it went to. */
  emailed?: string;
  /** On the user's message: the app (lib/server/made-apps.ts) open next to the chat as they sent it, which a change they ask for is about. */
  lookingAt?: string;
  /** Images attached to it (shown from /api/uploads/<id>; bots see them too). */
  images?: { id: string; type: string; w?: number; h?: number }[];
  /** A picture the bot made (make_image): what it was asked to show, so it knows what it sent. */
  picture?: { prompt: string };
  /**
   * Teammates the bot asked before replying (Max asked Sam): "Asked ● Sam" over the reply opens
   * their conversation (`pairChatId`) at that exchange (`questionId`).
   */
  asked?: { botId: string; question: string; answer: string; questionId?: string }[];
  /** Set on a "Remembered: …" line: the fact (so it can be undone) and an older one it may replace. */
  memory?: { ws: string; /** Saved to this bot's own bank (it keeps its memory to itself: lib/chain.ts). */ bot?: string; id: string; fact: string; undone?: boolean; old?: { id: string; text: string; forgotten?: boolean } };
  /**
   * Set on the note a bot's save to the CRM leaves (lib/server/crm.ts): the workspace and file, how many
   * rows it added and changed (or that it made the file), the copy from before it (`snapshot`) and the
   * file's version after it, so the note can open the file and undo the save while nothing changed since.
   */
  crm?: { ws: string; file: string; added: number; changed: number; created?: true; snapshot?: string; after: string; undone?: true };
  /**
   * Set on the line a bot's app build leaves (lib/server/made-apps.ts): the app, and the version the
   * build made (or is making), so the line can open the app, show it building, and undo the change.
   */
  madeApp?: { appId: string; version: number };
  /**
   * Set on Bops' note about an app a bot couldn't make, change or work on (chat.ts: "Couldn't work on the
   * app: …"), so a shared workspace never shows it to anyone but its owner (cloud/ws-slice.ts sharedMessage).
   */
  appNote?: true;
  /**
   * Set on the owner's message with what the Preview tab's Select put in it (lib/app-preview.ts picksOf): each line,
   * in their words, and where that is in the page's code (button.cta), which the bot reads after the message
   * (chat.ts history) and the window never shows.
   */
  picks?: { line: string; code: string }[];
  /**
   * Set on Bops' card about what a task on an app on the web changed (lib/server/hosted-apps.ts changeCardAfterTask),
   * posted as the bot with appNote: the workspace and the app, the changeset it was at before (`from`; null when it had
   * none yet) and the bot's newest (`to`), that one's first line, how many changesets that is in all and whose they
   * are, and `restored` once the app was put back as it was at `from` (Restore to before this change). The owner's
   * alone: a shared workspace never gets it (cloud/ws-slice.ts keeps only the fields it names; shared-core.ts
   * viewState drops it too), and an older Bops shows the text, which says the same.
   */
  appChange?: { ws: string; app: string; from: string | null; to: string; title: string; count: number; authors: string[]; restored?: true };
  /**
   * Bops' own words in the bot's voice (a line it fills in: why a thread stopped, where to run one, a plan's
   * limit), never the model's: a shared workspace reads it in the owner's voice (lib/server/shared-core.ts viewState).
   */
  bops?: true;
  /**
   * Set on the "While you were busy" message (lib/server/attention.ts flush), which the workspace's main bot
   * posts for every bot's watches: each line it tells and the bot whose watch it came from, so a shared
   * workspace shows someone only the lines of bots they were given (cloud/ws-slice.ts).
   */
  held?: { botId: BotId; text: string }[];
  /**
   * Set on a bot's message: replies it wrote for the user to send (chat.ts draft_reply), each a card under the
   * message with who and where it goes, the words the user can change, and Send (lib/server/reply-drafts.ts).
   * Nothing goes out until the user presses Send.
   */
  drafts?: ReplyDraft[];
  /**
   * Set on a bot's message: changes it proposed to its workspace's skills (chat.ts propose_skill_change), each a
   * card under the message with the change as a diff, who proposed it, where, and whose words the turn read.
   * Nothing changes until the owner presses Accept in the window (lib/server/skill-proposals.ts).
   */
  skillProposals?: SkillProposal[];
};

/**
 * A reply a bot wrote for the user, to an email, a Slack message or a Discord message it read with the user's
 * own account (use_app) in the same turn: it goes back in that thread or channel, from that account, when the
 * user presses Send. Its thread, channel and recipient are ones that turn read (lib/server/reply-drafts.ts), never
 * the bot's own words, which an email it read could have put there.
 */
export type ReplyDraft = {
  id: string;
  /** Where it goes: a Gmail thread, a Slack channel or thread, or a Discord channel (through a Discord bot account). */
  app: "gmail" | "slack" | "discord";
  /** The user's connected account it was read with, and goes out from (AppAccount.id). */
  accountId: string;
  /** Gmail: the thread it answers. */
  threadId?: string;
  /** Gmail: the address it goes to. */
  to?: string;
  /** Gmail: the thread's subject. */
  subject?: string;
  /** Slack and Discord: the channel (or direct message) it goes to, by its id there. */
  channel?: string;
  /** Slack: the thread it goes in (its first message's ts). */
  threadTs?: string;
  /** Discord: the message it answers. */
  messageId?: string;
  /** Who it's for, in a few words ("Kevin Example"). */
  toName: string;
  /** Slack and Discord: the channel's name ("#support"), when what was read named it. */
  where?: string;
  /** The words the bot wrote. */
  text: string;
  /** Being sent since then: another Send waits for it (lib/reply-drafts.ts SEND_STALE_MS). */
  sending?: number;
  /** Sent: when, and the words that went (the user's, as they left them). */
  sent?: { at: number; text: string };
  /** Why the last Send didn't go. */
  error?: string;
};

/**
 * A change a bot proposed to one of its workspace's skills (chat.ts propose_skill_change, lib/server/skill-proposals.ts):
 * one file of it, as edits (each `old` once in it) or a whole new text, and why. Made in any turn, a routine's run
 * and one that read a page, an email or an app included, because it changes nothing: only the owner's Accept, in
 * the window, makes it the skill's next version, through the same checks as any save (secrets, caps) and a publish.
 */
export type SkillProposal = {
  id: string;
  /** The workspace whose skill it is. */
  ws: string;
  kind: SkillKind;
  slug: string;
  /** The skill's name when it was proposed. */
  name: string;
  /** "SKILL.md" (its text as read_skill shows it, without the frontmatter), or a path inside it ("references/x.md"). */
  file: string;
  edits?: { old: string; new: string }[];
  /** The file's whole new text (a new file, or one replaced). */
  content?: string;
  /** content for a file the skill already had: the whole of it replaced. */
  replaces?: true;
  /** Why, in the bot's words. */
  summary: string;
  /** The version it was made against ("" for a skill never published), and that file's sha256 then (unset: a new file, or not known where it was made). */
  base: string;
  baseSha?: string;
  /** Made on a computer's runner, where the skill's files weren't: the edits are checked when it's accepted. */
  unchecked?: true;
  /** Who proposed it, and where: its chat, and the routine whose run it was. */
  botId: BotId;
  chatId: string;
  routineId?: string;
  /** Whose words the turn read from outside Bops (an email's sender, a page's site, an app account), and who started it when that wasn't the owner. */
  read?: string[];
  at: number;
  /**
   * This Mac's mark (lib/server/skill-proposals.ts sealProposals): an HMAC over the rest with a key only that Mac has,
   * set where its own turn made it. A runner's has none; one without it is shown on what the skill is now before Accept.
   */
  seal?: string;
  /** Accepted (and the version it made) or rejected, by the owner. */
  status?: "accepted" | "rejected";
  doneAt?: number;
  version?: string;
};

/**
 * An app a bot made for the user (lib/server/made-apps.ts): a small React app that runs in a tab of
 * Bops' right panel, locked down, and keeps its own data. Each change is a new version; going back
 * to one is a change too.
 */
export type MadeApp = {
  id: string;
  title: string;
  /** The bot that made it, and the chat it was asked for in (its builds report there). */
  botId: BotId;
  chatId: string;
  ws: string;
  /** The version that runs now (0 while the first one is being built). */
  version: number;
  versions: { n: number; note: string; at: number }[];
  /** Being built: the change asked for, when it started, and how much code is written so far. */
  building?: { change: string; since: number; chars: number };
  /** The last build failed: why, in a line (the version before it keeps running). */
  error?: string;
  /** What the user let it do, and when: ask its bot, which looks things up in their connected apps (`bops.bot`). */
  allowed?: { bot?: number };
  createdAt: number;
  updatedAt: number;
  /** The Mac that built it (its device id), as Orgo's record says (lib/server/made-apps-sync.ts). */
  deviceId?: string;
  /** This Mac's updatedAt Orgo has, and Orgo's updatedAt as last seen: a change here after the first goes to Orgo, one there after the second comes here. */
  syncedAt?: number;
  remoteAt?: string;
  /** The sha256 of the data this Mac and Orgo last agreed on, and of what Orgo holds as last heard (fetched when the app reads it). */
  dataSha?: string;
  orgoData?: { sha256: string; at: number };
  /** Versions Orgo refused for what looked like a secret, by number: the sha256 of the code it refused (not sent again while the code is the same). */
  refused?: Record<string, string>;
};

/**
 * What a bot's delete says of the apps it made: they stay, under its workspace's main bot (their builds
 * report in its chat; lib/server/made-apps-sync.ts appsToMainBot). Null when it made none.
 */
export function appsStayLine(state: Pick<AppState, "bots" | "madeApps">, b: Pick<Bot, "id" | "workspaceId">): string | null {
  const n = (state.madeApps ?? []).filter((a) => a.botId === b.id).length;
  const main = state.bots.find((x) => x.isMain && x.id !== b.id && workspaceOf(x) === workspaceOf(b));
  if (!n || !main) return null;
  return n === 1 ? `The app it made stays, under ${main.name}.` : `The ${n} apps it made stay, under ${main.name}.`;
}

export type EmailInfo = {
  dir: "in" | "out";
  inboxId: string;
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** Files that aren't images (images are in `images`). */
  files?: { name: string; size: number }[];
  /** Newsletters, notifications, auto-replies: shown, but the bot doesn't speak up about them. */
  bulk?: boolean;
  /** From one of the user's own addresses, and authenticated (DMARC): it's the user talking, and the bot answers by email. */
  fromOwner?: boolean;
  /** Came past the 12 an hour cap (lib/server/mail.ts receive): shown, and the bot stayed quiet. */
  held?: true;
};

/** iMessage's six tapbacks; any other emoji works too. */
export const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
export type Tapback = (typeof TAPBACKS)[number];
export const TAPBACK_EMOJI: Record<Tapback, string> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };
export type Reaction = { by: "owner" | BotId; type?: Tapback; emoji?: string; at: number };

export type SessionStatus = "queued" | "starting" | "running" | "done" | "failed";

/** One thing a thread did. `who` names the helper that did it (e.g. "Darwin"); `screen` is the screen it acted on, if not its own. */
export type SessionStep = { at: number; tool: string; detail: string; who?: string; screen?: number };

/** A message inside a thread: the user's replies and the bot's updates between turns. */
export type ThreadReply = {
  id: string;
  role: "user" | "bot";
  text: string;
  at: number;
  delivered?: boolean;
  /** Set on messages the app sends the bot for the user (like handing a screen back): shown as this quiet line, not as their words. */
  note?: string;
  /**
   * Passed on by the bot from outside Bops, on a turn someone else started ("an email from
   * desk@hotel.example"): the task gets it as information from them, not as the user's words, and the
   * thread shows who it came from.
   */
  from?: string;
  /** A member's words to the task, from their own Bops (someone the owner gave Write on its bot): instructions, not information like `from`. */
  member?: MemberSaid;
  /** In the window only, never synced: a reply the viewer sent that the owner's Bops hasn't written yet (Message.memberSend). */
  memberSend?: MemberSend;
};

/** Who a member is on what they said (MemberWho), and their key for it (cloud/protocol.ts MemberActBody). */
export type MemberSaid = MemberWho & { ref?: string };
/** How one of the viewer's own acts in a shared workspace stands, until the owner's Bops has written it (Message.memberSend). */
export type MemberSend = { state: "sending" | "waiting" | "failed"; error?: string; key: string };

/** A session is a long-running task on one screen of a bot's computer, shown as a thread. */
export type Session = {
  /** Started from a text the user sent a workspace's number: its result is texted back to them from that number. */
  textBack?: { botId: string; to: string };
  /** Started from a message in Slack, Telegram or Discord: its result is posted back there. */
  channelBack?: ChannelPlace;
  /** Started from an email the user sent the bot: its result is emailed back to them as a reply to that email. */
  emailBack?: { inboxId: string; messageId: string };
  /** The exact window on the user's Mac this task last worked in (from its tools: window id, process id). */
  macWindow?: { windowId: number; pid?: number; at: number };
  /**
   * Started on a turn someone else began (an email, a text or a call from outside Bops: StartOptions.outside).
   * Such a task gets none of the user's CRM (no crm_* tools, no CRM note), as a chat turn like that doesn't:
   * a stranger's words, or a page it opens, can't have it read the user's customers out.
   */
  fromOutside?: true;
  /** Started on a member's turn (someone the owner gave Write on its bot, from their own Bops): shown as Asked by them. */
  member?: MemberWho;
  /**
   * Started for a message the user kept "between us" (Message.secret): kept between us too, and so is
   * what's said about it in a chat, its result and notes (store.ts addMessage), so none of that goes into
   * a procedure's draft. Someone the owner gave its bot still sees it in a shared workspace (cloud/ws-slice.ts).
   */
  secret?: true;
  /** The user dismissed it: it stopped, and it doesn't ask for them again. */
  dismissed?: boolean;
  /** A newer thread took over this job (moved to the Mac, or asked for again); this one stays quiet. */
  replacedBy?: string;
  /** On the Mac: the cloud thread it carries on from (sessions.ts moveToMac). It starts once that one's run has ended, with its record. */
  movedFrom?: string;
  /**
   * A cloud thread that could carry on on the user's Mac, by the bot's say or someone's words, though the
   * user didn't ask: the app offers "Move to your Mac?" while it runs, and nothing moves until they tap it.
   * Cleared when its run ends (a tap then would do the whole task again on the Mac).
   */
  offerMac?: boolean;
  id: string;
  botId: BotId;
  /** The chat it was started from; its chip lives there. */
  chatId: string;
  /** Who kicked it off: the user directly, another bot handing it over, or a routine. Read it with ownerSent, routineSent and sentByBot. */
  sentVia: BotId | "you" | "routine";
  /**
   * `sentVia` names a bot though it's "you" or "routine": a bot from before ids couldn't be those (lib/server/bots.ts
   * freeBotId) handed it on, made it for a new bot or split it off. Never the user's words or a routine's run
   * (ownerSent, routineSent). Set only then.
   */
  sentViaBot?: true;
  /** Short label for chips and lists. */
  title: string;
  /** The kickoff message the bot works from, pinned at the top of the thread. */
  goal: string;
  /** The routine whose run this is (sentVia "routine"), so its result can be quiet, delivered and recorded on it. */
  routineId?: string;
  /** The procedure (Procedure.id) it follows, given to it in full. */
  procedure?: string;
  /**
   * The app on the web it works on (work_on_app, lib/server/hosted-apps.ts), by workspace and Ingot repo
   * name: as it starts, its bot's working folder of the app is made ready on its computer (/workspace/apps/<name>, or
   * a copy of the bot's own when it isn't the app's own bot: /workspace/apps/<name>.<copy>), and a brain's thread gets
   * Ingot's MCP tools.
   * `deployAfter`: the user asked for it to go live too (work_on_app's deploy), so once the task ends done
   * with a new commit, Bops deploys the app itself and says how it went in the chat (hosted-apps.ts
   * deployAfterTask). It's taken off as that deploy goes, so one ask deploys it once at most. `from`: the
   * app's newest commit as the task first started with that ask (null: nothing committed yet), or the one
   * Bops then deployed, which a new commit is told from; unset when Ingot couldn't say.
   * `site`: the site of it the task works on (its bot's Works on when that's this app's, else the app's own,
   * named as the app): the Local it runs and checks. `startHead`: the app's newest commit as the task first ran
   * (null: nothing committed yet), what its changes are told from (hosted-apps.ts changeCardAfterTask); unset when Ingot couldn't say. Both unset on
   * a task from Bops 0.0.34 or before.
   */
  app?: { wsId: string; name: string; deployAfter?: true; from?: string | null; site?: string; startHead?: string | null };
  host: Host;
  status: SessionStatus;
  /** X display number of the screen this session holds (99-102), while it holds one. */
  display?: number;
  /** The screen it last held, so a finished session can still show where it left off. */
  lastDisplay?: number;
  /** The page it was on when it last let go of its screen (lib/screens.ts): where it left off, for it and for the user. */
  lastPage?: { url: string; title?: string };
  /** When its last frame was kept (the screen as it let go: /api/frames?session=<id>), so a finished thread can show where it stopped. */
  lastFrameAt?: number;
  /** Picked up again on another screen than it left (its own was busy): the next turn tells it, with the page it was on. Then cleared. */
  screenMoved?: { from: number; to: number };
  agentSessionId?: string;
  /** "computer": it runs on the Responses API's computer tool (lib/server/computer-task.ts), not an Agents API session. */
  runner?: "computer";
  /** On the computer runner: the last response, which the next turn follows on from. */
  responseId?: string;
  /**
   * On the computer runner: calls in that response not answered yet (a turn stopped mid-step, a step OpenAI
   * flagged, or a run paused at a call that needs the user's OK: AppApproval.resume), answered when it picks up:
   * a tool call with what it answered when it ran, a flagged step's call with its safety checks, the paused call
   * with what the user's reply made of it.
   */
  owed?: { id: string; type: "computer" | "function"; output?: string; checks?: { id: string; code?: string | null; message?: string | null }[] }[];
  /**
   * The Agents API environment its executor connects to, and the workspace (and Full access on this Mac, MacState.fullAccess, its browser tools' sockets folder, and whether it had the user's apps there; on a computer, the screen its browser tools drive) it was made with, kept so a finished thread can pick up again.
   * `ui`: it had the Mac tools (Cua Driver), through Bops' own MCP server ("bops"; true was Cua's own, which a thread doesn't pick up again).
   * `fn`: its apps and business data are function tools Bops answers (sessions.ts agentTool), so a call that needs the user's OK
   * pauses it; one from before had them as MCP tools, and starts a fresh agent session.
   */
  env?: { id: string; remoteUrl: string; workspace?: string; fullAccess?: boolean; sockets?: string; apps?: boolean; data?: boolean; ui?: boolean | "bops"; display?: number; fn?: true };
  /**
   * Run by a CLI agent of its bot's (lib/server/cli-agents.ts) rather than Bops agent: which account (Brain.id;
   * "-" for OpenCode, which has none) and agent, on which computer, and the CLI's own session there (`cli`:
   * Claude Code's session id, Codex's thread, OpenCode's "ses_" session), which a later turn, or a
   * restart of the CLI, picks back up. `started`: the CLI has that session (it said so as it began).
   * `waits`: it can't go on until the user does something: sign the brain in on that computer ("sign_in"),
   * or say what's next after the CLI stopped at its plan's usage limit or its sign-in or key was turned
   * down ("limit": Finish on Bops agent, or Wait), its model isn't allowed ("model") or its provider is down
   * ("down"), or the Vault has given all the keys it allows this hour ("vault"). `said` is what Bops told them then (not the bot's own
   * answer). The replies that turn took are marked not delivered again, so they go in when it carries on.
   */
  brainRun?: { brainId: string; agentId?: string; kind: CliKind; computerId: string; cli: string; started?: true; waits?: "sign_in" | "limit" | "model" | "down" | "vault"; said?: string };
  /**
   * Compact was pressed on it (lib/server/sessions.ts compactThread): it's queued to run once more, its brain asked
   * first thing to compact what it has so far (threadCompacts), then the replies sent meanwhile, if any. `by`: a member
   * with Write who pressed it. `was`: how it stood before, which a run that only compacted puts back.
   */
  compact?: { at: number; by?: MemberSaid; was: { status: Session["status"]; error?: string; endedAt?: number } };
  /**
   * The agent the thread runs on (BotAgent.id in its bot's profile), its kind and model, given as it began
   * (lib/agents.ts pickAgent) and fixed from then: follow ups stay on it. Each start checks it against the bot's
   * profile as it is then (threadAgent), so a thread can't move onto an agent or account its bot doesn't have.
   * Unset on a thread from before: its brainRun's account, else its bot's Default.
   */
  agent?: { id: string; kind: AgentKind; model?: string };
  /** The user had Bops agent finish it after its brain stopped (brainRun.waits "limit"): it runs on Bops agent from then on. */
  onBopsAgent?: true;
  steps: SessionStep[];
  replies: ThreadReply[];
  answer?: string;
  /** The reasoning effort this thread runs at. */
  effort?: TaskEffort;
  /** What it runs on and who chose it (lib/server/routing.ts). Threads from before it have only `effort`. */
  route?: TaskRoute;
  /** When it's waiting on the user: the replies it offered, shown as buttons. */
  options?: string[];
  /** Helpers (subagents) this thread started, by name, in the order it started them. */
  helperNames?: string[];
  /** Screens (displays) the thread's helpers are using right now, besides its own. */
  helperScreens?: number[];
  /** What each helper was given to do, in a few words, by the screen (display) it works on. */
  helperTasks?: Record<number, string>;
  /** Helpers' screens (displays) in the order they were claimed, which is the order helpers start in. */
  helperOrder?: number[];
  /** Set on a thread started from a watched screen: it runs on that screen, on that site. */
  onWatch?: string;
  /** Where it runs: the bot's cloud computer (also when unset, as older threads are), or a Chrome of its own on the user's Mac. */
  runsOn?: "cloud" | "mac";
  /**
   * The Bops that runs it, as the user's state knows it (persist-cloud.ts deviceIdFor): the Mac it was
   * started on, or a computer's runner (lib/server/runner.ts). Only that one starts it, picks it up again,
   * stops it, or marks it failed when it restarts. Unset on threads from before: the Mac's, never a runner's.
   */
  by?: string;
  /** Stop asked for on another Bops than the one that runs it (sessions.ts stopSession), and why: that one stops it when it hears. */
  stopAsked?: string;
  /** Bops is still deciding where it runs. */
  routing?: boolean;
  /** Bops couldn't tell where it should run, so it's asking the user. */
  askWhere?: boolean;
  /** A last step to do on the user's Mac once the cloud part is done, given its result ("…then text Maria the summary"). */
  thenOnMac?: string;
  /** On the Mac: the apps it has used, most recent last (for the live window previews). */
  macApps?: string[];
  /** On the Mac: which of its bot's Chromes there it uses, or last used (0 to 2; lib/server/local.ts macTaskPort). */
  macScreen?: number;
  /** What the bot is doing right now, in a word or two ("searching", "filling a form"), for its cursor caption. */
  activity?: string;
  /** Jev's read of the last answer: is the bot waiting on the user to answer, decide or act? */
  waitingOnYou?: boolean;
  /**
   * One of several tasks started together for one request, each on a screen of its own (parallel work):
   * the group they show under in the chat. `partOf`: the thread that split it off (split_task), if one did.
   */
  group?: { id: string; title: string };
  partOf?: string;
  /** Jev's read too: what it waits on is the user approving something on another device (a sign-in prompt on their phone). */
  approveElsewhere?: boolean;
  /** The answer Bops texted the user about, after it waited unanswered (sessions.ts textIfUnanswered): once per question. */
  askTexted?: string;
  /** Something on its screen only the user can get past (a sign-in, a code, a captcha). */
  blocker?: Blocker;
  error?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
};

/**
 * When a routine runs. Times ("HH:MM", 24h) are wall clock times in the routine's zone (Routine.timeZone),
 * else the user's (Owner.timeZone), else the Mac's. The math lives in cloud/schedule.ts (ScheduleLike is
 * the same shape), so Bops Cloud can run the same schedules later. Every older shape is still one.
 */
export type Schedule =
  /** `times`: several a day ("HH:MM", sorted, each once, at most 6); `time` is times[0]. */
  | { kind: "daily"; time: string; times?: string[] }
  | { kind: "weekdays"; time: string; times?: string[] }
  /** `days`: several days (0 Sunday to 6, sorted); `day` is days[0]. */
  | { kind: "weekly"; day: number; days?: number[]; time: string; times?: string[] }
  /** `dayOfMonth` 1 to 31, or -1 for the last day; a day the month doesn't have runs on its last day. */
  | { kind: "monthly"; dayOfMonth: number; time: string; times?: string[] }
  | { kind: "once"; at: number }
  /**
   * Every `minutes` (MIN_EVERY_MINUTES at least, a day at most). `hours`: only between these local times
   * ("08:00" to "22:00"; a run that falls outside waits for the next start); `days` (0 Sunday to 6): only
   * on these. A check-in is a quiet routine on this kind.
   */
  | { kind: "every"; minutes: number; hours?: { from: string; to: string }; days?: number[] }
  /**
   * `minutes` (5 to 240) before each meeting in the user's Google Calendar (meetings inside `hours` and
   * `days` when set): a check every 15 minutes, each run told the meetings that start in its window
   * (cloud/schedule.ts eventWindow), which starts where the runs before it got to (Routine.eventsThrough),
   * so every meeting is handled once.
   */
  | { kind: "before_event"; minutes: number; source: "googlecalendar"; hours?: { from: string; to: string }; days?: number[] };

/** The shortest gap an "every" routine may have, in minutes. */
export const MIN_EVERY_MINUTES = 15;

/**
 * Where a routine's result goes besides the bot's chat in Bops (which always gets it): a text to the
 * user from the bot's number, an email to the user from the bot's inbox, or a Slack, Telegram or Discord
 * place the bot was added to (a ChannelLink; `chat` is the channel or DM there, unset is the DM with the
 * person paired).
 */
export type Delivery = { kind: "text" } | { kind: "email" } | { kind: "channel"; linkId: string; chat?: string };

/** How a routine's last run went. Running and delivering are told apart: a run can go well and its text not arrive. */
export type RoutineRun = {
  at: number;
  /**
   * running: still going (a task); ok: it ran and said something; quiet: it ran and had nothing for the
   * user (a quiet routine), so nothing was posted; failed: the run itself failed; skipped: it didn't run
   * (the last run was still going, or the bot or its computer wasn't there).
   */
  status: "running" | "ok" | "quiet" | "failed" | "skipped";
  error?: string;
  /** The task it started, when it ran on a computer. */
  sessionId?: string;
  /**
   * On a running record: how the run before this one failed, if it did. A thread that fails the same
   * way again is recorded but not said or sent again (routines.ts onRoutineTaskEnd), like a chat run.
   */
  prevError?: string;
  /**
   * On a skipped record whose thread is still going (it stays the routine's run): when that thread's run
   * began, so its end records the window it handled (a meeting routine's), not the time of the skip.
   */
  threadAt?: number;
  /** Whether the result reached `deliverTo`; unset when there was nothing to send or nowhere besides the chat. */
  delivery?: { status: "sent" | "failed"; to: string; error?: string; at: number };
  /**
   * The computer's runner that ran it (its device, as Session.by), on a run a runner recorded: that run
   * stays the runner's to end if its bot moves off that computer meanwhile, and what the run says in the
   * chat stays the runner's to write until another run is recorded (cloud/computer-scope.ts runsOf, runsBy).
   */
  by?: string;
};

/** A routine or one-off scheduled ask. When it fires it becomes a reminder, a turn in the bot's chat, or a thread. */
export type Routine = {
  id: string;
  botId: BotId;
  title: string;
  goal: string;
  schedule: Schedule;
  /** The IANA zone its times are in ("Europe/London"); unset: the user's (Owner.timeZone). */
  timeZone?: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  /** Its last run was a late one that took the place of the time after it (routines.ts tick), so the next missed one isn't put off either. */
  lateRun?: boolean;
  /**
   * Its times the user skipped (routines.ts skipRoutine): each one of its own coming times, sorted. It
   * doesn't run then; nextRunAt is the first time it isn't skipping. Pausing it, or changing when it runs,
   * clears them; each goes once its time has passed.
   */
  skips?: number[];
  /** Where its task runs (as the user asked); auto lets Bops decide each time. */
  where?: "auto" | "cloud" | "mac";
  /**
   * For a task left to Bops (where auto), where the Mac would send its runs, worked out on the Mac ahead
   * of them for its goal then (routines.ts pickWhere, as where.ts chooseWhere decides a run: the user's
   * app rules, then Jev). "mac" keeps it the Mac's in Cloud while its goal is still `goal` (runner.ts
   * pinnedToMac): a computer's runner can't tell, having no Mac.
   */
  macPick?: { goal: string; where: "mac" | "cloud" };
  /** A plain reminder: this message is sent to the user at the time, and no computer is used. */
  reminder?: string;
  /** Set up by text from the user's phone: the reminder, or the task's result, is texted to them too. */
  textTo?: { botId: string; to: string };
  /**
   * How a run that isn't a reminder works: "chat" is a turn in the bot's chat with its tools (web search,
   * reading pages, email, apps, memory) and no computer, cheap and quick; "task" (also when unset, as
   * routines from before are) starts a thread on a computer.
   */
  run?: "chat" | "task";
  /** Quiet: a run that finds nothing that needs the user posts nothing and sends nothing (the bot answers NOTHING). */
  quiet?: boolean;
  /** Where each run's result goes besides the chat. */
  deliverTo?: Delivery;
  /** A procedure (Procedure.id) each run follows. */
  procedure?: string;
  /** How the last run went. */
  last?: RoutineRun;
  /**
   * A meeting routine (before_event): the meetings starting before this moment (epoch ms) were handled
   * by a run that finished. The next run starts its window here (cloud/schedule.ts eventWindow).
   */
  eventsThrough?: number;
  /**
   * Set up on a turn someone else started (an email, a text or a call from outside Bops): who it came
   * from ("an email from desk@hotel.example"). Such a routine runs as a task in the cloud, marked as from
   * outside (Session.fromOutside), never as a chat run with the user's data; its reminder is a note, not
   * the bot's own words; and the user sees who set it up.
   */
  fromOutside?: string;
  /** The starter it was made from (lib/routine-catalog.ts), when it was one. */
  source?: RoutineSource;
  /** Tags it sorts what it reads with (the defaults and Workspace.tags), as its bot is told. */
  tags?: string[];
};

/**
 * A one-off whose time has passed: done. It's turned off as it fires (lib/server/routines.ts tick), on the one
 * Bops that runs it start to finish, so nothing runs it twice; a run of it that fails shows failed, with Run
 * now to run it again. Run now before its time doesn't finish it (it can still be paused and resumed).
 */
export const onceDone = (r: Routine, now = Date.now()) => !r.enabled && r.schedule.kind === "once" && r.schedule.at <= now;

/**
 * A routine's run going right now, as far as the app can tell: its thread is still running, or a chat
 * run began less than 15 minutes ago (one takes a minute or two). A record a restart or a quit left
 * "running" is never changed (it may be another Mac's, still running there), and it stops counting as
 * running by itself: a thread's run once its thread isn't running anymore, a chat run after 15 minutes.
 * So it never locks Run now for long, and the routine's next run replaces it.
 */
export const runningNow = (r: Routine, sessions: Session[], now = Date.now()) =>
  r.last?.status === "running" && (r.last.sessionId ? sessions.some((s) => s.id === r.last!.sessionId && live(s)) : now - r.last.at < 15 * 60_000);

/**
 * A procedure, from before skills: how a bot did one kind of job, private to it. Each is moved into its
 * workspace's skills (lib/server/workspace-skills.ts adoptProcedures) and kept in proceduresBackup.
 */
export type Procedure = {
  id: string;
  botId: BotId;
  /** A short name for the kind of job: "Weekly invoice summary". */
  name: string;
  /** When it applies, in one line: "When the user sends an invoice CSV and asks for a summary". */
  whenToUse: string;
  /** What to do, in order, as plain numbered lines. */
  steps: string;
  /** What went wrong before or is easy to get wrong, as plain lines. Empty when nothing yet. */
  pitfalls?: string;
  createdAt: number;
  updatedAt: number;
  /** The chat (and threads) it was learned from. */
  from?: { chatId: string; sessionIds?: string[] };
  /** How many times a bot read it for a job, and when it last did. */
  uses?: number;
  usedAt?: number;
};

/** A skill's name as compared (and a procedure's before it): case, spacing and dashes (a bot writes them as commas) don't count. */
export const procedureKey = (s: string) =>
  s
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();


/**
 * You've taken control of a bot's screen (`display`), or of the Chrome a task of the bot's has of its
 * own on your Mac (`macScreen`, Session.macScreen); the bot is paused there until you hand it back.
 * `terminal`: you opened the thread's Claude Code in a terminal on that screen (sessions.ts openInTerminal),
 * and `paused` it as it worked; the screen is yours until you reply in the thread or hand it back.
 * `found`: "left", thread `sessionId` ended there waiting on you at the screen (a sign in, a code), not paused
 * for the takeover: handing back carries it on only while it's still so (sessions.ts returnControl). A run that
 * waits for your OK (AppApproval) holds no screen while it waits, so a takeover never finds it.
 */
export type Takeover = { botId: BotId; sessionId?: string; found?: "left"; since: number; terminal?: { paused?: true; shell?: true } } & ({ display: number; macScreen?: undefined } | { macScreen: number; display?: undefined });

/**
 * A screen of a bot's computer the user drives from this Mac (its Takeover, which isn't synced), said to their other
 * Bops and to the computer's runner, so none of them puts a run on it: this Mac's own (AppState.driving, under
 * macs[deviceId] in Bops Cloud). Said again every few minutes while the takeover lasts (`at`), so one left by a Mac
 * that quit or crashed meanwhile counts no longer than a few minutes more (sessions.ts drivenElsewhere).
 */
export type Driving = { botId: BotId; display: number; at: number };

/**
 * What a thread waits on at its screen that only the user can give: a sign-in, a code, a captcha, a payment,
 * an error page (screen-watch.ts). Waiting for the user's OK isn't one: that's a request (AppApproval), and the
 * thread's status says so while one of its own is unanswered (waitsForOk).
 */
export type Blocker = "sign_in" | "two_factor" | "captcha" | "payment" | "error";
export const BLOCKER_LABEL: Record<Blocker, string> = {
  sign_in: "a sign-in",
  two_factor: "a verification code",
  captcha: "a captcha",
  payment: "a payment to confirm",
  error: "an error page",
};
/** What a thread's status says while a request for the user's OK of its is unanswered (waitsForOk). */
export const WAITING_FOR_OK = "Waiting for your OK";

export type PageKind = "email_compose" | "article" | "checkout" | "results" | "other";

/** A field on the bot's page that the user can fill from a Bops card. Only its label leaves the page, never a value. */
export type FormField = { id: string; label: string; secret: boolean };

/** How a thread chip says what it's waiting on: "needs you to sign in". */
export const BLOCKER_ASK: Record<Blocker, string> = {
  sign_in: "you to sign in",
  two_factor: "a code from you",
  captcha: "you to pass a captcha",
  payment: "your OK to pay",
  error: "you: the page errored",
};

/** What's on a bot's screen, as read from the mirror: where it is, what stands in the way, and whether it's private. */
/** A thread letting go of a screen: who, on what, and the page it left there. */
export type ScreenLeft = { sessionId: string; botId: string; title: string; page?: { url: string; title?: string }; at: number };

export type ScreenRead = {
  url: string;
  title: string;
  blocker?: Blocker;
  sensitive: boolean;
  at: number;
  /** What kind of page it is, for the cards and the reader view. */
  kind?: PageKind;
  /** The sign-in or verification fields on the page, matched by Jev, for the "Sign in for <bot>" card. */
  form?: { identifier?: FormField; password?: FormField; code?: FormField };
  /** A checkout waiting on the user: the total, and the button that pays. For the approve/decline card. */
  payment?: { amount?: string; merchant: string; confirm?: { id: string; text: string } };
  /** An email being written: its fields and send button. The card reads the draft's text from the page itself. */
  email?: { to?: FormField; subject?: FormField; body?: FormField; send?: { id: string; text: string } };
  /** The thread that hit this screen, so getting past it can pick that thread back up. */
  sessionId?: string;
  /** The tab it was read from (lib/server/local.ts pageText): a sign-in fills that tab, never whichever is on screen by then. */
  targetId?: string;
};

/** The person this install of Bops works for: what the bots call them, and what they should know about them (Settings → You). */
export type Owner = {
  name: string;
  about?: string;
  /** Their IANA time zone ("America/New_York"), kept by the Mac app, so routines run at their local times wherever they run. */
  timeZone?: string;
};

/** How long chats and calls are kept (AppState.privacy): a year, 90 or 30 days, or (null) until the user deletes them. */
export type KeepDays = 30 | 90 | 365 | null;
/** How long a copy of what the user deleted stays on the Mac it was deleted on (AppState.privacy): 0 is gone at once. */
export type DeletedDays = 0 | 7 | 30;

export type AppState = {
  /** Who the bots work for. Empty until set in Settings. */
  owner?: Owner;
  bots: Bot[];
  chats: Chat[];
  messages: Message[];
  sessions: Session[];
  routines: Routine[];
  /**
   * How each bot did the kinds of jobs it was shown, from before skills (Procedure). Each is moved into
   * its workspace's skills (lib/server/workspace-skills.ts adoptProcedures) and the list is emptied; what was
   * moved is kept in `proceduresBackup`.
   */
  procedures?: Procedure[];
  proceduresBackup?: Procedure[];
  /**
   * Moving each workspace onto an Orgo workspace of its own (lib/server/workspaces.ts
   * migrateWorkspacesToOrgo): the step it got to, the Orgo workspaces it made (for a rollback), the
   * default's name still waiting for every app to be new, and when it was done. Saved after every step,
   * so a stop resumes.
   */
  orgoMigration?: OrgoMigration;
  /**
   * When the move onto Orgo workspaces was undone (revertWorkspaceMigration): from then on this app keeps
   * every workspace's computers in the one "bops" project and never runs the move again by itself.
   */
  orgoMigrationRevertedAt?: string;
  host: Host;
  takeover?: Takeover;
  /** Latest read of each watched screen, keyed `${botId}:${display}`. */
  screens?: Record<string, ScreenRead>;
  /**
   * Who last let go of each screen, keyed `${computer bot id}:${display}`: the thread, its bot, and the
   * page it left there (lib/screens.ts screenMap shows it as "left by …" for half an hour).
   */
  screenLog?: Record<string, ScreenLeft>;
  /** Screens a bot keeps open on a site and keeps an eye on for the user (an X inbox, LinkedIn messages). */
  watches?: Watch[];
  /** Logins bots can sign in with. Only what's safe to show is here; secrets live in the Keychain. */
  vault?: VaultLogin[];
  /** The brains the user added for their bots (Brain, lib/server/brains.ts). Bops agent is every bot without one. */
  brains?: Brain[];
  /** The user's own Mac, where bots can work in a Chrome of their own. */
  mac?: MacState;
  /** The user's real app accounts, connected through Composio (lib/server/composio.ts). Several per app is fine. */
  accounts?: AppAccount[];
  /** Accounts mid-sign-in: the sign-in page is open in the user's browser. */
  connecting?: AppConnecting[];
  /** Where the user added bots like a teammate: a Slack channel, a Telegram bot, a Discord bot (lib/server/channels.ts). */
  channels?: ChannelLink[];
  /** Actions a bot wants to take that change something (send, create, pay): waiting for the user, or answered a moment ago. Shared by every Bops of the user's (AppApproval). */
  appApprovals?: AppApproval[];
  /** Teams the user keeps apart, and the one they're looking at. */
  workspaces?: Workspace[];
  workspace?: string;
  /** Apps the bots made for the user (lib/server/made-apps.ts): recorded in Orgo, with a copy on this Mac (made-apps-sync.ts); never in Bops Cloud's shared state. */
  madeApps?: MadeApp[];
  /**
   * The user's own mobile numbers (Settings, How your bots reach you): when they agreed to get texts
   * from their bots, and when they proved the number is theirs with a texted code
   * (lib/server/verify.ts). Only a verified number counts as the user, for a text or call from it and
   * for texts to it. One saved before verification existed has no verifiedAt, and Settings asks to
   * verify it. `userId` is the Orgo user who verified it: another account signed in on this Mac
   * doesn't inherit it (ofThisUser in lib/server/store.ts). `claimedVia`: it became theirs by being
   * the first to call or text one of their bots' new numbers (Bops Cloud's bops.phone_lines), not
   * by a code; verifiedAt is then when it did.
   */
  ownerPhones?: { number: string; consentAt: number; verifiedAt?: number; userId?: string; claimedVia?: "call" | "text" }[];
  /**
   * The user's own email addresses that they proved with an emailed code (Settings, How your bots
   * reach you; lib/server/owner-email.ts), lowercased, with Twilio's id for the check and the Orgo
   * user who proved it. Only verified ones are ever saved. With a connected Gmail, BOPS_OWNER_EMAILS
   * and the Orgo sign-in email once counted, they are the user's addresses (ownerAddresses in
   * lib/server/mail.ts): an email from one, with DMARC passing, is the user talking, and bots may
   * email them without asking.
   */
  ownerEmails?: { address: string; verifiedAt: number; ref?: string; userId?: string }[];
  /**
   * The Orgo sign-in email the user said counts as them (Settings, "Count it"), lowercased. Only
   * that address: another account signing in here starts with its own not counted.
   */
  signInEmailCounted?: string;
  /** Numbers that texted STOP to a bot's number: no bot texts them until they text START. */
  smsOptOut?: string[];
  /** This install of Bops, so the services shared by every install (AgentMail…) keep each one's things apart. */
  installId?: string;
  /** News held while the user was busy, told together when they're free (lib/server/attention.ts). */
  digest?: { botId: string; text: string; watchId?: string; at: number }[];
  /** The Orgo account signed in to this Bops (a Bops user is an Orgo user). The key is in the Keychain. */
  account?: { user: { id: string; email?: string; name?: string }; signedInAt: number };
  /**
   * Settings → You → Share usage data turned off: no usage events from this account, from any Mac or
   * from Bops Cloud (which reads it here). Unset: on (README, Privacy).
   */
  analyticsOff?: boolean;
  /**
   * Settings → Your data (lib/privacy.ts, lib/server/privacy.ts): how long chats and calls are kept, and what
   * a delete leaves behind. Shared by every Mac of the user's, like any setting (each field merges on its
   * own: state-merge.ts). `keepDays`: chat messages older than this many days are deleted, from Bops Cloud
   * and every Mac, by an hourly sweep on the Mac, with this Mac's call notes, router notes, last screens and
   * the images and pages no kept message refers to; unset or null, they're kept until the user deletes them.
   * `deletedDays`: a message, thread or group chat the user deletes still goes from the chat and from Bops
   * Cloud at once, but a copy stays on the Mac it was deleted on (and only there) this many days, under
   * Recently deleted, to restore; unset or 0, it's gone at once, its images on this Mac too.
   */
  privacy?: { keepDays?: KeepDays; deletedDays?: DeletedDays };
  /**
   * The user's AI credit ran out: Bops Cloud refused a call that would spend it (402 ai_credit_empty).
   * The bots stop asking the cloud for AI work and the chat shows it with Upgrade, until a read of
   * the plan (GET /api/plan, /api/account) shows credit again. Unset otherwise.
   */
  credits?: { out: boolean; at: number };
  /**
   * A Connected App (or a vault key) just finished connecting for a bot, and the window offers that bot's
   * starter routines for it (GET /api/routines/suggestions). One at a time; cleared once answered or
   * dismissed (POST /api/routines/suggestions, /api/routines/suggestions/dismiss).
   */
  suggest?: { app: string; botId: BotId; at: number };
  /** What running Bops cost, as it happened (lib/server/usage.ts); the account page totals it. */
  usage?: UsageEvent[];
  /** The Orgo user whose account the bots' computers are in (lib/server/orgo-sign-in.ts adoptComputers). */
  computersOf?: string;
  /**
   * When the user finished (or skipped parts of) the setup screen; skipped holds its items ("screen", "relay"…).
   */
  setup?: { doneAt?: number; skipped?: string[] };
  /**
   * Routing the bots' computers through this Mac (lib/server/relay.ts). The pairing code is in the
   * Keychain. It's on by default once Orgo offers it; `turnedOff` is the user's own "off", which
   * stays until they turn it on again.
   */
  relay?: { deviceId?: string; deviceName?: string; on: boolean; turnedOff?: boolean };
  /** Per computer routed through this Mac: how its route was before, to put back when routing stops. */
  relayRoutes?: Record<string, RelayRoute>;
  /**
   * What's each of the user's other Macs' own (routing through it, whether bots can work on it, its setup), by device
   * id, as Bops Cloud keeps the state (lib/server/state-merge.ts). This Mac's own is at the top level
   * (relay, relayRoutes, mac, setup, driving) and goes up under its id.
   */
  macs?: Record<string, { relay?: AppState["relay"]; relayRoutes?: AppState["relayRoutes"]; mac?: MacState; setup?: AppState["setup"]; driving?: Driving }>;
  /** The screen of a bot's computer the user drives from this Mac, for their other Bops and its runner (Driving). */
  driving?: Driving;
  /**
   * The Bops runner on each of the bots' computers, by Orgo computer id (lib/server/runner.ts): a Bops of
   * its own there that runs the routines of the bots working on that computer while the user's Mac is
   * closed (where their bots work: Cloud). Shared by every Mac and runner of the user's, so each knows
   * whose routines are whose.
   */
  runners?: Record<string, RunnerState>;
  /**
   * Whether the computers' other screens stream live through Orgo too, not only over the tailnet
   * (BOPS_SCREEN_STREAM=1, screenStreamWanted in lib/server/orgo.ts). Filled in by /api/state for the
   * app; never stored.
   */
  screenStream?: boolean;
  /** Whether business data (treg) is there for the bots: lib/server/treg.ts tregOn. Filled in by /api/state for the app; never stored. */
  businessData?: boolean;
  /**
   * What the user's bots are doing on their other devices right now (thinking, working…; and the chat,
   * when typing), by bot id, from Bops Cloud's live stream (lib/server/live.ts). Filled in by /api/state
   * for the app; never stored or synced.
   */
  liveMoods?: Record<BotId, { mood: "thinking" | "writing" | "speaking" | "working"; chatId?: string }>;
  /**
   * The workspace shared with the user that's open now (lib/shared.ts, lib/server/shared.ts): watched, and
   * acted in for the bots the owner gave them Write on. Its bots, chats, threads, routines and watches are
   * the owner's, in place of the user's own. Filled
   * in by /api/state for the app; never stored or synced.
   */
  shared?: SharedOpen;
  /**
   * While a shared workspace is open (shared): what of the user's own is worth a chime (lib/pings.ts
   * duePings), as the window would find it in their own state, which it isn't shown then. Filled in by
   * /api/state for the app; never stored or synced.
   */
  ownPings?: Ping[];
};

/**
 * A computer's Bops runner (AppState.runners). `status`: being set up, up (its health check passed: it
 * runs that computer's routines, and the Mac leaves them to it), couldn't start (`error` says why: those
 * routines stay on the Mac), or being stopped (where the bots work switched to This Mac, the computer was
 * deleted, its bots moved off). `version` and `buildId`: the Bops it runs, set up by the Mac `by` (its
 * device id). The runner signs in with its computer's own Orgo key (ORGO_API_KEY, which Orgo writes on
 * it). `keyMade`: Bops gave the computer that key (PUT orgo-web /api/computers/{id}/orgo-key, from the
 * Mac that set the runner up on a computer without one), so Bops takes it back when it stops the runner
 * (DELETE, from any Mac of the user's); `keyId` is its id, to show. A computer that came with its key (a
 * template that asks for one: bops-base 0.1.9 on) keeps it: it's the computer's, and Orgo revokes it with
 * the computer. An entry from before keyMade that has a keyId (made by the old bops-runner-key route)
 * counts as keyMade (runnerKeyMade), and its old `keyBy` is ignored. `at`: when the status was set.
 * `upgrading`: one that's up being set up again with a newer Bops by the Mac `by` since `at`: it stays up
 * and keeps its routines meanwhile (runner-install.ts). `auth`: what it said it signs in with at its last
 * health check or look (its log's `[runner] auth:` line): its computer's Orgo identity, its key, or
 * nothing yet. `down`: a Mac's look found its computer down and not coming back by itself (stopped,
 * frozen, in error), or asleep with one of its routines well past its time (Orgo's waker didn't wake it:
 * Free hours used up, paused, unfunded), as Orgo said (`status`) at `at`: its routines wait for it, saying
 * why, and run on it once it's up again; the Mac never takes them over (runner-install.ts lookDown). A look
 * that finds it up clears it. Only a Mac writes it.
 */
export type RunnerState = {
  status: "installing" | "running" | "failed" | "stopping";
  version: string;
  buildId: string;
  keyMade?: boolean;
  keyId?: string;
  auth?: "identity" | "key" | "none";
  by: string;
  error?: string;
  at: number;
  upgrading?: { version: string; buildId: string; by: string; at: number };
  down?: { status: string; at: number };
};

/** A new task's words that put it on the user's Mac (lib/server/where.ts chooseWhere), and a routine's (routineOnMac). */
export const MAC_WORDS = /\b(on|from|using|use|with) my (mac|macbook|laptop|computer)\b|\blocally\b|\bon this mac\b/i;

/**
 * A routine that needs no computer: a reminder, or a chat run (a turn with the bot's tools; someone else's
 * routine is never one: lib/server/routines.ts run). It's always the Mac's (routineOnMac), as before runners:
 * a runner never runs one, whether a Mac is up or not, and Orgo never wakes a computer for one nor keeps one up
 * for it (the routines mirror's onMac). Bops Cloud can't run a turn with the bot's tools yet (cloud/agent.ts
 * answers the phone with none), so one due while no Mac is up runs once a Mac is up again, late.
 */
export const needsNoComputer = (r: Pick<Routine, "reminder" | "run" | "fromOutside">) => !!r.reminder || (r.run === "chat" && !r.fromOutside);

/**
 * The bot has skills or apps of its workspace published for it (lib/server/workspace-skills.ts skillsFor, read
 * from the state alone so every Bops agrees): their files are synced to the Mac alone. Bops' own built-in
 * skills come with every Bops, a runner too.
 */
function skillsOnMac(s: Pick<AppState, "bots" | "workspaces">, botId: string): boolean {
  const b = s.bots?.find((x) => x.id === botId);
  if (!b) return false;
  const w = s.workspaces?.find((x) => x.id === workspaceOf(b));
  return [...(w?.skills ?? []), ...(w?.apps ?? [])].some((x) => x.status === "published" && botHasSkill(x, b));
}

/**
 * Whether a routine's runs need the user's Mac (lib/server/runner.ts pinnedToMac), decided before a run starts
 * from what every Bops of theirs sees alike in the state (never a Mac's own rules, state.mac, but what a Mac
 * picked and kept with the routine), and never changed by how a run went:
 * - a reminder or a chat run (needsNoComputer), always for now: chat is the backend's, and a bot's computer
 *   is only for work that needs one (a chat run that needs a computer starts a task, which runs on its bot's);
 * - any whose result goes to Slack, Telegram or Discord (a runner can't post there: their tokens are in
 *   the Mac's Keychain, and Bops Cloud gives a computer no raw Composio calls), or that follows a skill
 *   (skills' files are synced to the Mac alone);
 * - a task whose bot has skills or apps of its workspace published for it: on a runner its instructions
 *   would lack their steps, and read_skill finds none;
 * - a task set to run there, or one left to Bops whose bot works on the Mac, whose job says so ("on my
 *   Mac", "locally"), or that the Mac would send there (Routine.macPick for its goal now: the user's app
 *   rules, an app only on their Mac; only while its bot is left to Bops too, as a bot's own setting comes
 *   first: where.ts chooseWhere).
 * A task that reaches something only the user can give on its computer (their OK, a sign in) waits for it
 * there, its status saying so: it's never the Mac's for that.
 */
export function routineOnMac(
  state: Pick<AppState, "bots" | "workspaces">,
  r: Pick<Routine, "botId" | "where" | "goal" | "reminder" | "run" | "fromOutside" | "deliverTo" | "procedure" | "macPick">,
  b: Pick<Bot, "runsOn"> | undefined,
): boolean {
  if (needsNoComputer(r)) return true;
  if (r.deliverTo?.kind === "channel" || r.procedure) return true;
  if (skillsOnMac(state, r.botId)) return true;
  if (r.where === "mac") return true;
  if (r.where === "cloud") return false;
  const leftToBops = b?.runsOn !== "mac" && b?.runsOn !== "cloud";
  return b?.runsOn === "mac" || MAC_WORDS.test(r.goal) || (leftToBops && r.macPick?.where === "mac" && r.macPick.goal === r.goal);
}

/**
 * Why a routine's runs wait for its bot's computer, in a few words ("Max's computer is stopped"), when a
 * Mac's look found that computer down or asleep with its routines overdue (RunnerState.down) while its
 * runner runs them: they run there once it's up, never moved to the Mac. Undefined when nothing holds them
 * up, and for one the Mac runs (routineOnMac).
 */
export function computerWait(state: Pick<AppState, "bots" | "runners" | "workspaces">, r: Pick<Routine, "botId" | "enabled" | "where" | "goal" | "reminder" | "run" | "fromOutside" | "deliverTo" | "procedure" | "macPick">): string | undefined {
  const b = state.bots.find((x) => x.id === r.botId);
  const w = b && workBot(b, state.bots);
  const id = w?.computerId?.toLowerCase();
  const x = id ? Object.entries(state.runners ?? {}).find(([k]) => k.toLowerCase() === id)?.[1] : undefined;
  if (!r.enabled || !w || x?.status !== "running" || !x.down || routineOnMac(state, r, b)) return undefined;
  const st = x.down.status;
  return `${w.name}'s computer is ${st === "error" ? "broken" : st === "suspended" ? "asleep" : st}`;
}

/** Whether Bops gave the computer its Orgo key, and takes it back when it stops the runner: keyMade, or an entry from before keyMade with a keyId. */
export const runnerKeyMade = (x: Pick<RunnerState, "keyMade" | "keyId"> | undefined): boolean => !!x && (x.keyMade ?? !!x.keyId);

/** Why a runner couldn't start, when it was its key: it came up but couldn't sign in, or Orgo didn't give its computer one (runner-install.ts). */
export const RUNNER_NO_SIGN_IN = "it couldn't sign in on its computer";
export const RUNNER_NO_KEY = "Orgo didn't give its computer its key";

/**
 * Whether computer's runner counts on its computer's own Orgo key now: one that's up signs in with it
 * (not one up on its computer's Orgo identity), and one that couldn't start for want of it.
 */
export const runnerNeedsKey = (x: RunnerState | undefined): boolean =>
  !!x && ((x.status === "running" && x.auth !== "identity") || (x.status === "failed" && (x.error === RUNNER_NO_SIGN_IN || x.error === RUNNER_NO_KEY)));

/**
 * A computer's own Orgo key as Settings shows it (orgo-web GET /api/computers/{id}/orgo-key, read by
 * app/api/runs-on/keys): what names it, never the key. `prefix`: its first characters as Orgo shows them
 * ("sk_live_ab12"), empty when Orgo gave none that short. Times in ms; `lastUsed` and `expiresAt` null
 * when it was never used, or never expires.
 */
export type ComputerOrgoKey = { keyId: string; prefix: string; name: string; createdAt: number | null; lastUsed: number | null; expiresAt: number | null };

/**
 * One computer's switch to this Mac's route. `before` is how Orgo had it (proxy on or off, and through
 * what); `applied` is whether it's on this Mac's route now (a computer at work switches when it's free).
 */
export type RelayRoute = {
  before: { proxyOn: boolean; mode: "residential" | "device"; deviceId?: string };
  applied: boolean;
  /** The last thing that went wrong switching it, to show and try again. */
  error?: string;
  /** Tries in a row that went wrong, and when to try again (it waits longer after each). */
  failures?: number;
  retryAt?: number;
  /** Orgo turned it down for good (or it kept failing): left alone until routing is turned off and on again. */
  stuck?: boolean;
  /** Its route changed but its screens' browsers didn't come back: start them again before anything else. */
  screensDown?: boolean;
};

export type UsageKind = "computer.create" | "computer.remove" | "phone.number" | "mail.inbox" | "call.minutes" | "model.tokens";

/** One thing that cost something. `qty` is minutes for calls and tokens for models, else 1. */
export type UsageEvent = {
  kind: UsageKind;
  at: number;
  botId?: string;
  qty?: number;
  /**
   * For model.tokens: which model, and what it was for: chat, a task (on a bot's computer or the
   * user's Mac), memory, a call, or a quick check (Jev).
   */
  model?: string;
  source?: "chat" | "session" | "memory" | "call" | "decide";
  /** For model.tokens: input and output split, when known. */
  inputTokens?: number;
  outputTokens?: number;
};

/** The user's Mac as a place bots can work: whether it's ready, and the words that send a task there. */
export type MacState = {
  /** Bots can work here: the Codex CLI that runs their tools is installed, and Chrome is. */
  ready: boolean;
  /** Why not, in plain words, when it isn't. */
  reason?: string;
  /**
   * The one thing it waits on when it isn't ready (lib/server/mac.ts checkMac): the Codex CLI (Bops
   * installs it by itself; `installing` while it does), or Chrome. "elsewhere": this server isn't on
   * the user's Mac, so there's nothing to do here.
   */
  next?: "codex" | "chrome" | "elsewhere";
  installing?: boolean;
  checkedAt?: number;
  /** Words that mean a task belongs on the Mac (apps like Messages or Notes, "my desktop"…). */
  rules: string[];
  /**
   * Full access: bots' tasks here run outside Bops' sandbox (lib/server/executor-sandbox.ts), as the
   * user, with a shell, their files and their apps, and every browser tool. Off by default.
   */
  fullAccess?: boolean;
};

/**
 * One of the user's accounts in an app (Composio calls it a connected account), e.g. their work Gmail.
 * No token is ever stored in Bops: Composio keeps them. `app` is Composio's toolkit slug ("gmail", "notion").
 * Apps that need no sign-in (Hacker News…) get one account with id `open:<app>`.
 */
export type AppAccount = {
  id: string;
  app: string;
  /** The app's own name for it, as shown in the app ("Gmail"). */
  appName: string;
  /** The account's own name, as Composio reports it: an email, a workspace. */
  name?: string;
  /** The user's own label for it ("Work", "Personal"), when they gave one. */
  label?: string;
  /** "expired": the app signed Bops out (a password change, revoked access); it works again after signing in again. */
  status: "active" | "expired";
  at: number;
  /** When a bot last used it (lib/server/composio.ts runAppAction), for the Vault's "not used lately". */
  usedAt?: number;
  /**
   * The workspace it was connected in: its bots have it by default (levelOf). Unset: written by a build
   * from before that default (v0.0.28 and older, or a Mac still on one), so only the bots given it have it.
   */
  workspaceId?: string;
  /**
   * Connected before every bot had every app by default (lib/server/store.ts set its workspace when it
   * loaded it), or found in Composio connected where Bops didn't see who was picked for it (syncApps): only
   * the bots the user gave it may use it, as there.
   */
  onlyGiven?: boolean;
};

/** An account being connected: its sign-in page is open, and Bops waits for it to finish. */
export type AppConnecting = {
  id: string;
  app: string;
  appName: string;
  label?: string;
  status: "waiting" | "failed";
  error?: string;
  at: number;
  replaces?: string;
  /**
   * Who may use it once it's connected (picked when connecting), and how much: the bots picked get
   * `level`, and the other bots of `workspaceId` (the workspace it was picked in) get none. `check`: How
   * often one of them looks at it (lib/server/routine-suggestions.ts makeCheck), a routine made once it's
   * connected; unset is only when asked.
   */
  grant?: { bots: BotId[]; level: AppLevel; workspaceId?: string; check?: Schedule };
};

/** What a bot may do in an account: read, or read and act (anything that sends, changes or pays still asks the user first). */
export type AppLevel = "read" | "act";
export const APP_LEVELS: { id: AppLevel; name: string; hint: string }[] = [
  { id: "read", name: "Read only", hint: "Can look things up. Can't change anything." },
  { id: "act", name: "Read & act", hint: "Can also draft and make changes. Asks you before it sends, posts, deletes or pays." },
];

/** What the user can set for one bot in one account (Bot.access): a level, or "none" for no access. */
export type AppAccess = AppLevel | "none";

/**
 * Connections that put bots somewhere rather than apps they use: Bops' Slack app ("slackbot"), how bots
 * get into Slack (lib/server/channels.ts). No bot gets one by default, only when the user gives it.
 */
export const CHANNEL_APPS = new Set(["slackbot"]);

/**
 * Whether the bots of an account's workspace have it by default: not one from before that default (no
 * workspace, or AppAccount.onlyGiven), which is only the bots' the user gave it.
 */
export const openToTeam = (a: Pick<AppAccount, "workspaceId" | "onlyGiven">) => !!a.workspaceId && !a.onlyGiven;

/**
 * What a bot may do in one account: what the user set for it (Bot.access), else the default, Read & act,
 * for every bot of the account's workspace (bots made later too), and of each workspace it's switched on in
 * (`usedIn`: Workspace.loginsOn, see usedIn). A bot of any other workspace, a channel app (CHANNEL_APPS), or
 * an account from before that default (openToTeam) has no default. Null: no access. Without `usedIn`, only
 * the account's own workspace: less, never more.
 */
export function levelOf(
  b: Pick<Bot, "access" | "workspaceId">,
  a: Pick<AppAccount, "id" | "app" | "workspaceId" | "onlyGiven">,
  usedIn?: readonly string[],
): AppLevel | null {
  const set = b.access && Object.hasOwn(b.access, a.id) ? b.access[a.id] : undefined;
  if (set === "read" || set === "act") return set;
  if (set === "none" || CHANNEL_APPS.has(a.app) || !openToTeam(a)) return null;
  const ws = workspaceOf(b);
  return workspaceOf(a) === ws || !!usedIn?.includes(ws) ? "act" : null;
}

/* ---------------- Used in: a login switched on in more workspaces ---------------- */

/** A login's key in Workspace.loginsOn: a Connected App by its account id, a key by its Orgo project and name. */
export const appLoginKey = (accountId: string) => `app:${accountId}`;
export const keyLoginKey = (project: string, name: string) => `key:${project}:${name}`;

type WithLogins = { workspaces?: Pick<Workspace, "id" | "loginsOn">[] };

/** Whether workspace `w` has login `key` switched on (Workspace.loginsOn): an entry of its own that's a record. */
export const switchedOn = (w: Pick<Workspace, "loginsOn"> | undefined, key: string) => {
  const on = w?.loginsOn && typeof w.loginsOn === "object" && Object.hasOwn(w.loginsOn, key) ? w.loginsOn[key] : undefined;
  return !!on && typeof on === "object";
};

/** The workspaces login `key` is switched on in besides its own (Workspace.loginsOn). */
export const usedIn = (state: WithLogins, key: string): string[] => (state.workspaces ?? []).filter((w) => switchedOn(w, key)).map((w) => w.id);

/** levelOf, with the workspaces the account is switched on in. */
export const levelIn = (state: WithLogins, b: Pick<Bot, "access" | "workspaceId">, a: Pick<AppAccount, "id" | "app" | "workspaceId" | "onlyGiven">) =>
  levelOf(b, a, usedIn(state, appLoginKey(a.id)));

/**
 * The workspaces account `a` is in, as Used in shows them: its own, each it's switched on in, and each where a bot was
 * given it by name (Bot.access read or act, honoured wherever the bot is, as before Used in). Switching one off takes
 * all of that away there (lib/server/logins.ts).
 */
export function accountIn(state: WithLogins & { bots: Pick<Bot, "access" | "workspaceId">[] }, a: Pick<AppAccount, "id" | "workspaceId">): string[] {
  const out = new Set([workspaceOf(a), ...usedIn(state, appLoginKey(a.id))]);
  for (const b of state.bots) {
    const set = b.access && Object.hasOwn(b.access, a.id) ? b.access[a.id] : undefined;
    if (set === "read" || set === "act") out.add(workspaceOf(b));
  }
  return [...out];
}

/** Whether a bot may use a saved site login (VaultLogin.bots): every bot, or it's one of them. */
export const mayUseLogin = (l: Pick<VaultLogin, "bots">, botId: string) => l.bots === "all" || (Array.isArray(l.bots) && l.bots.includes(botId));

/**
 * The workspaces a saved site login is used in: each with a bot that may use it (every one, for "all"). A site login
 * has no workspace of its own: its bots say where it's used, as before Used in, so nothing new is kept for it.
 */
export function siteLoginIn(state: { bots: Pick<Bot, "id" | "workspaceId">[]; workspaces?: Pick<Workspace, "id">[] }, l: Pick<VaultLogin, "bots">): string[] {
  if (l.bots === "all") return [...new Set([...(state.workspaces ?? []).map((w) => w.id), ...state.bots.map((b) => workspaceOf(b))])];
  return [...new Set(state.bots.filter((b) => mayUseLogin(l, b.id)).map((b) => workspaceOf(b)))];
}

/** Whether a bot's access to an account is the default (the user didn't set it for this bot). */
export const accessIsDefault = (b: Pick<Bot, "access">, a: Pick<AppAccount, "id">) => b.access?.[a.id] === undefined;

/**
 * One use of an app account or an API key by a bot, or a thread of its (lib/server/access-sync.ts): which
 * one, the action (GMAIL_SEND_EMAIL, "GET /v1/balance"), where it ran, and how it ended. `approvedBy`: who
 * said yes to it (the user, or Bops itself for a low risk one or "Just do it"); unset when it needed no yes.
 */
export type AccessUse = {
  bot: BotId;
  kind: "app" | "key";
  target: string;
  targetName: string;
  action: string;
  via: "chat" | "thread" | "routine" | "call";
  viaId?: string;
  outcome: "ok" | "failed" | "refused" | "waiting";
  approvedBy?: "user" | "auto";
  /** Asked for by a member with Write (a turn or a thread of theirs): their name, so the owner sees who it was for. */
  for?: string;
  at: number;
};

/** The last time each account or key was used (GET /api/apps/log), by its target: which bot, when, and for which member (AccessUse.for). */
export type LastUses = Record<string, { bot: BotId; at: number; for?: string }>;

/** Where a bot can be added like a teammate. Slack goes through Composio; Telegram and Discord are the bot's own accounts there. */
export type ChannelKind = "slack" | "telegram" | "discord";

/**
 * A bot added to a channel. Telegram and Discord: a bot account the user made for it (its token is
 * in the Keychain, never here). Slack: the Slack app connected through Composio (an AppAccount), and
 * the Slack channels it's in. Bots only take requests from the user there: `owner` is the user's own
 * id in that service, set when they send the pairing code.
 */
export type ChannelLink = {
  id: string;
  kind: ChannelKind;
  botId: BotId;
  /** How it shows there: "@boppy_bot" in Telegram, "Boppy#1234" in Discord, the Slack workspace. */
  handle: string;
  /** The user's own id in that service, once paired. Until then the bot answers only the pairing code. */
  owner?: string;
  ownerName?: string;
  /**
   * Send this to the bot there (Telegram: tap the link) to pair: it proves who the user is. Only the
   * code itself pairs, only while nobody is paired, and only while it's fresh (pairCodeLive).
   */
  pairCode: string;
  /** When the code was made (links from before: `at`). It pairs for PAIR_CODE_MS. */
  pairCodeAt?: number;
  /** Wrong codes sent since; at PAIR_CODE_TRIES the code stops working and the user gets a new one in Bops. */
  pairTries?: number;
  status: "live" | "error";
  error?: string;
  at: number;
  telegram?: { userId: number; username: string };
  discord?: { userId: string; appId: string; username: string };
  /**
   * The Slack app's account (an AppAccount id), its workspace and bot user there (from Slack's
   * auth.test), the channels this bot is in, and the direct message with the person paired (known once
   * they've written there: from them, or with the right code).
   */
  slack?: { accountId: string; teamId?: string; botUserId?: string; channels: { id: string; name: string }[]; dm?: string };
};

/** How long a pairing code pairs, and how many wrong codes it takes before it stops (a new one is a tap away in Bops). */
export const PAIR_CODE_MS = 60 * 60_000;
export const PAIR_CODE_TRIES = 5;

/** Whether a link's pairing code still pairs: nobody paired yet, made within PAIR_CODE_MS, fewer than PAIR_CODE_TRIES wrong codes. */
export const pairCodeLive = (l: Pick<ChannelLink, "owner" | "pairCode" | "pairCodeAt" | "pairTries" | "at">, now = Date.now()) =>
  !l.owner && !!l.pairCode && (l.pairTries ?? 0) < PAIR_CODE_TRIES && now - (l.pairCodeAt ?? l.at) < PAIR_CODE_MS;

/** A conversation in a channel: which link, which chat or channel there, and the message (or thread) to answer under. */
export type ChannelPlace = { linkId: string; chat: string; messageId?: string; thread?: string; from?: string };

/**
 * A request for the user's OK (OpenCode's permission request, Codex's approval): a bot's run reached a tool call
 * that changes something (an app action, an email to someone else, a key's call that changes something, a dear
 * lookup, a tool its brain may not use by itself) and its rules don't allow it (lib/permission.ts). A plain record
 * in the state every Bops of the user's shares, so every Bops of theirs shows the card, wherever the run runs:
 * - `threadId`: the run's thread (a chat turn has `chatId` only); `routineId`, the routine whose run it is;
 *   `askedBy`, the device running the run (its Bops, as Session.by), the only one that resumes it and that
 *   takes the record out, once it has read the reply;
 * - `action`: what kind of thing ("Send an email", "Send Message in Slack (work)"), what Always allow saves a rule
 *   for (lib/permission.ts); `resources`: to whom or what, as best Bops can tell from its inputs (recipients, a
 *   channel, a URL), for the user to read; `preview`: exactly what will happen, as the card shows it; `kind` and
 *   `api`, how the card shows it;
 * - `resume`: what carries the run on from where it paused (lib/server/permission.ts), held by OpenAI, not by
 *   a Bops process: nothing in memory matters while it waits, and a restart of the device that asked loses nothing;
 * - `reply`: the user's answer, from one of their own Bops (`by` its device): once, always (a rule saved too) or
 *   reject (`message`, what to do instead, the bot is told); Stop on its thread writes reject with reason
 *   "stopped". Set once, never taken back (state-merge.ts mergeApproval). Nothing else resolves it.
 */
export type AppApproval = {
  id: string;
  threadId?: string;
  chatId?: string;
  botId: string;
  routineId?: string;
  askedBy?: string;
  action: string;
  resources: string[];
  preview: string;
  kind?: "app" | "email" | "api" | "data" | "brain";
  /** A call to an API with one of the user's keys: the key, its service, the method and the whole path. */
  api?: { key: string; label: string; method: string; path: string };
  at: number;
  resume?: AskResume;
  reply?: AskAnswer;
  /** In the window only, never synced: the viewer's own answer to it in a shared workspace, on its way or not gone (Message.memberSend). */
  memberSend?: MemberSend;
  /**
   * Asked on a member's turn or thread (memberThread): who asked, by name, for the card. Only the owner answers one of
   * their logins (lib/member-access.ts ownerOnlyAsk), so the card says whose ask it was.
   */
  askedFor?: string;
};

/** How the user answers a request (OpenCode's reply, Codex's ReviewDecision approved / approved_for_session / denied). */
export type AskReply = "once" | "always" | "reject";
/** `member`: answered by a member with Write, from their own Bops (the Mac that took it is `by`). */
export type AskAnswer = { reply: AskReply; message?: string; reason?: "stopped"; by?: string; at: number; member?: MemberWho };
/** The tool call a run paused at, as the model made it: its name and its arguments (JSON). */
export type AskCall = { name: string; arguments: string };

/**
 * What carries a paused run on (lib/server/permission.ts), by the engine that ran it:
 * - "responses": a thread on the Responses API's computer tool (computer-task.ts): the response it paused in,
 *   and the call whose output it owes (function_call_output with previous_response_id);
 * - "agents": a thread on an Agents API session (sessions.ts runTurn): the session, waiting in requires_action
 *   for agent.session.input.tool_result to the call in that turn;
 * - "chat": a chat turn (chat.ts): the response, the call, the other calls' outputs of that round, the calls
 *   the turn handles after its answer (start_task and the like), and the turn as it was (chat.ts ChatPause);
 * - "held": a run that holds the call itself (a brain's tool, through the screen tools: cli-agents.ts), which
 *   can't pause, and waits in memory for the reply.
 */
export type AskResume =
  | { engine: "responses"; responseId: string; callId: string; call: AskCall }
  | { engine: "agents"; sessionId: string; turnId: string; callId: string; call: AskCall }
  | { engine: "chat"; responseId: string; callId: string; call: AskCall; outputs: { callId: string; output: string }[]; later?: unknown[]; turn?: unknown }
  | { engine: "held" };

/**
 * A rule for what a bot does without asking (lib/permission.ts): one action, whatever the recipients or details. The
 * last for an action wins. `resource`: "*" in one Always allow saves (a Bops from before reads rules by action and
 * resource); a rule saved before with one resource reads as a rule for its action all the same.
 */
export type PermissionRule = { action: string; resource?: string; effect: "allow" | "ask" };

/**
 * Whether request `a` is of the run thread `s` is now: asked by the Bops that runs it (Session.by). One another Bops
 * asked before the thread became this one's (a runner whose run was ended for it, its computer deleted) waits on
 * nothing. Where either isn't said (a thread from before Session.by, a self-hosted Bops, a member's copy, which has
 * neither), it is.
 */
export const askedByRunner = (a: Pick<AppApproval, "askedBy">, s: Pick<Session, "by">) => !a.askedBy || !s.by || a.askedBy === s.by;

/**
 * The requests still waiting on the user, of one thread when `threadId` is given: unanswered, and of a thread
 * that's still going (one that ended some other way, its computer deleted, waits on nothing), asked by the Bops
 * that runs it now (askedByRunner).
 */
export const waitingAsks = (state: Pick<AppState, "appApprovals"> & Partial<Pick<AppState, "sessions">>, threadId?: string) =>
  (state.appApprovals ?? []).filter(
    (a) => !a.reply && (threadId === undefined || a.threadId === threadId) && (!a.threadId || !state.sessions || state.sessions.some((s) => s.id === a.threadId && live(s) && askedByRunner(a, s))),
  );

/**
 * Whether thread `s` is Waiting for your OK: a request of its, asked by the Bops that runs it now (askedByRunner), is
 * unanswered. Derived from the request alone, wherever the run runs.
 */
export const waitsForOk = (s: Pick<Session, "id" | "status" | "by">, state: Pick<AppState, "appApprovals">) =>
  live(s as Session) && (state.appApprovals ?? []).some((a) => a.threadId === s.id && !a.reply && askedByRunner(a, s));

/**
 * Whether thread `s`'s run is paused at a request its own Bops made (AppApproval.askedBy, Session.by), answered
 * or not, until that Bops reads the reply: nothing of it is held anywhere but in the request and at OpenAI, so
 * nothing sweeps it up (store.ts leftBehind, routines.ts strayRun, runner-install.ts, a restart): only the
 * user's reply carries it on, and Stop ends it. A brain's held call (resume "held") is a run going, not a pause.
 */
export const pausedForOk = (s: Pick<Session, "id" | "by">, state: Pick<AppState, "appApprovals">) =>
  (state.appApprovals ?? []).some((a) => a.threadId === s.id && (a.askedBy ?? undefined) === (s.by ?? undefined) && a.resume?.engine !== "held");

/**
 * A saved login. The password and 2FA setup key are in the Mac's Keychain (lib/server/keychain.ts);
 * Bops fills them straight into the sign-in page, so no model ever sees them.
 */
export type VaultLogin = {
  id: string;
  /** The site it's for, as a domain: "x.com", "linkedin.com". Subdomains match too. */
  site: string;
  username: string;
  hasPassword: boolean;
  /** Bops makes the 6-digit codes itself from the site's 2FA setup key. */
  hasTotp: boolean;
  /** Which bots may use it. */
  bots: "all" | BotId[];
  /** Sign in without asking; otherwise the sign-in card offers it in one tap. */
  auto: boolean;
  addedAt: number;
  usedAt?: number;
};

/**
 * A screen kept on one site and watched by Jev. Agents leave it alone (threads and helpers use the
 * other screens), except a thread the user starts from it, like drafting a reply there.
 */
export type Watch = {
  id: string;
  botId: BotId;
  display: number;
  /** The site, as the user would say it: "X", "LinkedIn", "Gmail". */
  site: string;
  /** What's worth interrupting the user for, in plain words: "new DMs or replies to me". */
  lookFor: string;
  since: number;
  /**
   * Something waiting for the user, until they look at it or it's no longer on the page. `level`: how
   * much of their attention it got (lib/server/attention.ts): now interrupts, quiet just shows, later
   * was held for a "While you were busy" message.
   */
  alert?: { text: string; at: number; level?: "now" | "quiet" | "later" };
  /**
   * What Bops told the user about (newest last, the last 30). A screen or a Mac window never tells the
   * same words twice (the same DM never pings twice); a web page only skips the words its alert still
   * shows, so a status that comes back is told again.
   */
  told?: string[];
  /** When Jev last read the page (it only reads when the page changed). */
  readAt?: number;
  /**
   * A window on the user's Mac instead of a bot's screen (then `display` is 0): the app, the window's
   * title (a conversation, a mailbox) to find it again, and its id while it stays open.
   */
  mac?: { app: string; title: string; windowId?: number };
  /** What the screen showed when the user set the watch up: the thing being watched, not the screen it's on. */
  target?: string;
  /** The screen shows something else right now (another conversation, page or view): no alerts until it's back. */
  away?: boolean;
  /** The starter it was made from (lib/routine-catalog.ts), when it was one. */
  source?: RoutineSource;
  /**
   * A web page watched with no screen (then `display` is 0): Bops fetches `url` every `everyMin` minutes,
   * keeps a fingerprint of every line with what's certainly noise taken out (a "5m ago", an "Updated 3:45
   * PM": `digests`, in order, and the page's `hash`; cloud/page-diff.ts) and the text of some lines
   * (`lines`, capped: the ones that changed lately first, so a model can see what a new line replaced),
   * and asks a model only when lines were added (a line that went and came back is added too). `error`
   * and `failures`: the last fetches failed, or a web page came back with no text (it backs off). `seen`
   * (lines that went lately) and `odd` (reads that looked nothing like the page): from older builds;
   * never set now, only cleared.
   */
  page?: {
    url: string;
    everyMin: number;
    checkedAt?: number;
    changedAt?: number;
    hash?: string;
    digests?: string[];
    seen?: string[];
    lines?: string[];
    error?: string;
    failures?: number;
    odd?: number;
    /** Read in a browser at the last look, since the page draws itself or checks for a human (lib/server/web-render.ts). */
    via?: "browser";
  };
  /** Paused by the user: not looked at until resumed. */
  paused?: boolean;
};

/**
 * Whether a bot message posted while a turn that came by text or from Slack, Telegram or Discord ran is
 * that turn's own, to send back there: its words, or the result of a thread it started (`started`). A
 * routine's run that happened meanwhile isn't (it goes where the routine sends it, never into that
 * conversation or twice), unless that turn asked for it (Run now); nor is an older thread's result.
 */
export const turnsOwn = (m: Message, started: { id: string }[]) => (!m.routine || !!m.routine.manual) && (!m.resultOf || started.some((s) => s.id === m.resultOf));

/**
 * A routine's thread that finished with NOTHING: a quiet run that found nothing for the user, so it posted
 * nothing (lib/server/routines.ts isNothing). Lists of threads leave it out, in the app and on the server.
 */
export const quietNothing = (s: Session) => !!s.routineId && s.status === "done" && /^\s*NOTHING\.?\s*$/i.test(s.answer ?? "");

/** A watch on a bot's screen (not a window on the user's Mac, not a web page with no screen). */
export const isScreenWatch = (w: Watch) => !w.mac && !w.page;

/** How often a web page watch is fetched, in minutes: the default, and the least. */
export const PAGE_WATCH_DEFAULT_MIN = 30;
export const PAGE_WATCH_MIN_MIN = 5;

export const MAX_SCREENS = 4;
/** Created screens first; the boot screen (with Orgo's own desktop) last. */
export const DISPLAYS = [100, 101, 102, 99];

/**
 * The screen Orgo streams by default: its WebRTC video reaches the boot screen only, and so does its
 * VNC proxy unless asked for another screen by ?screen= (app/api/vnc), which Bops does only with
 * BOPS_SCREEN_STREAM=1 for now. Otherwise the other screens stream live only over the tailnet
 * (TAILSCALE_AUTH_KEY, a developer's setup), and the app shows them as screenshots.
 */
export const ORGO_STREAM_DISPLAY = 99;

/**
 * Whether a screen of an Orgo computer can be shown live: Orgo's own screen, any over the tailnet, and
 * any through Orgo when it streams the other screens too (`screenStream`, see AppState).
 */
export const streamsLive = (c: { tailnet?: unknown }, display: number, screenStream = false) => display === ORGO_STREAM_DISPLAY || !!c.tailnet || screenStream;

/**
 * Whether an Orgo computer's screens are read (their list, a screenshot): only while it's running, or
 * before Orgo has said otherwise. A read of a suspended computer's screens can wake it (orgo-web woke it
 * for every one), so a view that kept looking kept Free's computer from ever sleeping.
 */
export const computerUp = (status: string | undefined) => status === undefined || status === "running";

/**
 * An Orgo computer that's asleep (orgo-web's status "suspended"): Free's computer after 15 minutes nobody
 * used it (orgo-web lib/bops-free-hours.ts), or once its 10 hours this month are used. The app shows it
 * asleep and leaves it be; a task wakes it, and so does the user taking over.
 */
export const computerAsleep = (status: string | undefined) => status === "suspended";

/** Orgo statuses a computer doesn't come back from by itself (computerStaysDown). */
const STAYS_DOWN: ReadonlySet<string> = new Set(["error", "stopped", "frozen", "deleted"]);
/**
 * An Orgo computer that's down and doesn't come back by itself: in error, stopped or frozen (a Stop on
 * orgo.ai, or a Bops Max computer parked when the plan ended), or deleted (one that's been deleted isn't
 * usually listed at all). Unlike one asleep, nothing wakes it for a task: a setup there ends saying so
 * (sessions.ts), and its runner runs nothing, so its routines wait for it, saying why (runner-install.ts).
 */
export const computerStaysDown = (status: string | undefined) => status !== undefined && STAYS_DOWN.has(status);

/**
 * Something is using a computer in the cloud right now: a task working there (starting or running, not
 * one on the user's Mac), or the user driving one of its screens. `onIt`: whether a bot works on it.
 */
export const computerInUse = (state: Pick<AppState, "sessions" | "takeover">, onIt: (botId: BotId) => boolean) =>
  state.sessions.some((s) => onIt(s.botId) && s.runsOn !== "mac" && (s.status === "starting" || s.status === "running")) ||
  (state.takeover?.display !== undefined && onIt(state.takeover.botId));

/**
 * How long the app waits to read a computer's status again (its computer view), or null for not while
 * the window is hidden: every 8 seconds, as before, unless it's asleep; then every 2 while a task or the
 * user is waking it, and every minute with nothing using it (a read of its status never wakes it, and
 * it can wake without the app: a reset, a Resume on orgo.ai). The view reads it once more when the
 * window shows again, and as soon as something starts using it.
 */
export function computerCheckMs(status: string | undefined, { visible, inUse }: { visible: boolean; inUse: boolean }): number | null {
  if (!visible) return null;
  if (!computerAsleep(status)) return 8000;
  return inUse ? 2000 : 60_000;
}

export type OrgoMigration = {
  /** 1: the first build, which moved computers (`moves`, `pending` may still be in a state from it, and are ignored). 2: nothing moves. */
  v: number;
  step: string;
  /** Orgo workspaces made by the move, for a rollback (deleted when empty). */
  created: string[];
  /** A workspace renamed because the user's Orgo already had that name: shown until the user dismisses it. */
  renamed?: { wsId: string; from: string; to: string }[];
  /**
   * The default workspace is `to` here, and its Orgo project keeps the name "bops" until every Bops app on
   * the account is new enough (orgo.ts bopsAppsGate); `reason` is the gate's last answer, `checkedAt` when
   * it was asked, `at` when the user gave the name (a wish kept before `at` was goes by `checkedAt`). The
   * default's name here is `to` for as long as it waits (workspaces.ts holdDefaultName puts it back when
   * another Mac's copy or an older one brings "bops" back). Tried again at each start, sign-in and names
   * sync (workspaces.ts retryDefaultRename); gone once the project has the name, or once the project was
   * renamed on orgo.ai after `at` (that name wins).
   */
  defaultRename?: { to: string; reason: string; checkedAt: string; at?: string };
  doneAt?: string;
};

/** The chat id for talking to one bot directly. */
export const botChatId = (botId: BotId) => `bot:${botId}`;

type SentBy = Pick<Session, "sentVia" | "sentViaBot">;
/** Whether the user gave a thread themselves (Session.sentVia "you"), never a bot from before whose id is "you" (Session.sentViaBot). */
export const ownerSent = (s: SentBy) => s.sentVia === "you" && !s.sentViaBot;
/** Whether a thread is a routine's run (Session.sentVia "routine"), never one a bot from before whose id is "routine" started. */
export const routineSent = (s: SentBy) => s.sentVia === "routine" && !s.sentViaBot;
/** The bot that started a thread (handed it on), when neither the user nor a routine did. */
export const sentByBot = (s: SentBy): BotId | undefined => (ownerSent(s) || routineSent(s) ? undefined : s.sentVia);

export const live = (s: Session) => s.status === "queued" || s.status === "starting" || s.status === "running";

/**
 * Whether a thread is someone else's work as far as what's the owner's own goes: one someone outside Bops started
 * (Session.fromOutside: an email, a text or a call to a bot), one a member with Write started (Session.member), one a
 * member has told something (ThreadReply.member: their words are instructions there too), or a part of one of those
 * (split_task: Session.partOf), whether or not the part was marked so. It gets nothing that's the owner's alone,
 * whatever its bot may use: none of their saved logins (sign_in_from_vault, the screen's own sign in), Connected apps,
 * API keys, CRM or memory of facts. `find` looks a thread up by id (the store's session).
 */
export function othersThread(s: Session | undefined, find: (id: string) => Session | undefined): boolean {
  return outsideThread(s, find) || memberThread(s, find);
}

/**
 * Whether a thread is a stranger's: one someone outside Bops started (Session.fromOutside: an email, a text or a call
 * to a bot), or a part of one. It gets none of the owner's logins, whatever its bot may use: no Connected apps, API keys
 * or saved site logins, as on their turns in the chat.
 */
export function outsideThread(s: Session | undefined, find: (id: string) => Session | undefined): boolean {
  return !!s?.fromOutside || (!!s?.partOf && !!find(s.partOf)?.fromOutside);
}

/**
 * Whether a thread is a member's: one a member with Write started (Session.member) or has told something
 * (ThreadReply.member), or a part of one. It may use the logins its bot has (a person reaches a login only through the
 * bots they can tell), but every send, change, delete or payment asks the owner first, with no rule, Just do it or low
 * risk guess going for them, and a saved site login signs in only when it's set to sign in by itself.
 */
export function memberThread(s: Session | undefined, find: (id: string) => Session | undefined): boolean {
  const theirs = (x: Session | undefined) => !!x && (!!x.member || (x.replies ?? []).some((r) => r.role === "user" && !!r.member));
  return theirs(s) || (!!s?.partOf && theirs(find(s.partOf)));
}

/** The member a thread is for (memberThread): who started it, else the last of them to tell it something. */
export function memberOf(s: Session | undefined, find: (id: string) => Session | undefined): MemberWho | undefined {
  const of = (x: Session | undefined) => x?.member ?? [...(x?.replies ?? [])].reverse().find((r) => r.role === "user" && !!r.member)?.member;
  return of(s) ?? (s?.partOf ? of(find(s.partOf)) : undefined);
}

/**
 * When the Bops that runs thread `s` (Session.by: a Mac, a computer's runner) last showed a sign of work (a
 * thread begun, a step, a frame, a reply) on `s` or on any of its live threads in `sessions`. One queued there
 * waits behind its others (all its bot's screens busy), so that Bops at work on them says it's still there,
 * never the queued one's own quiet: how a thread another Bops runs is told from one it left behind
 * (store.ts leftBehind, routines.ts strayRun).
 */
export function lastWorkOf(s: Session, sessions: Session[]): number {
  const signs = (x: Session) => [x.startedAt, x.createdAt, x.lastFrameAt, ...(x.steps ?? []).map((y) => y.at), ...(x.replies ?? []).map((y) => y.at)].filter((y): y is number => typeof y === "number");
  return Math.max(0, ...sessions.filter((x) => x.by === s.by && live(x)).flatMap(signs), ...signs(s));
}

/**
 * A brand's real logo, in public/logos (official files: Wikimedia Commons, Simple Icons, or the
 * company's own site). `tile` marks logos that are already an app tile (Stripe, Discord, iMessage).
 * Every other app's logo is Composio's (served and cached by /api/apps/logo/<app>).
 */
export type Logo = { src: string; tile?: boolean };

/** Our own copies of the logos we had before the catalog, by Composio app slug; the rest come from Composio. */
export const LOCAL_LOGOS: Record<string, Logo> = {
  gmail: { src: "/logos/gmail.svg" },
  googlecalendar: { src: "/logos/google-calendar.svg" },
  attio: { src: "/logos/attio.svg" },
  clay: { src: "/logos/clay.png" },
  linear: { src: "/logos/linear.svg" },
  stripe: { src: "/logos/stripe.svg", tile: true },
  slack: { src: "/logos/slack.svg" },
  slackbot: { src: "/logos/slack.svg" },
};
export const appLogo = (app: string): Logo => LOCAL_LOGOS[app] ?? { src: `/api/apps/logo/${encodeURIComponent(app)}` };

/** The apps offered first when adding one: what a business runs on. Everything else is a search away. */
export const FEATURED_APPS = [
  "gmail", "googlecalendar", "slack", "notion", "googledrive", "googlesheets", "hubspot", "salesforce",
  "linear", "attio", "stripe", "quickbooks", "airtable", "asana", "jira", "github",
  "outlook", "zoom", "calendly", "docusign", "shopify", "intercom", "xero", "googledocs",
];

/** Where you can add a bot like a teammate. `live` ones work now; the rest are shown ahead of time. */
export const CHANNELS: { id: string; name: string; color: string; glyph: string; logo?: Logo; hint: string; live?: boolean }[] = [
  { id: "slack", name: "Slack", color: "#4A154B", glyph: "#", logo: { src: "/logos/slack.svg" }, hint: "Add to channels", live: true },
  { id: "telegram", name: "Telegram", color: "#229ED9", glyph: "T", logo: { src: "/logos/telegram.svg", tile: true }, hint: "Its own Telegram bot", live: true },
  { id: "discord", name: "Discord", color: "#5865F2", glyph: "D", logo: { src: "/logos/discord.svg", tile: true }, hint: "Add to a server", live: true },
  { id: "imessage", name: "iMessage + SMS", color: "#0A84FF", glyph: "✉", logo: { src: "/logos/imessage.svg", tile: true }, hint: "Uses the bot's phone" },
  // The bot's own inbox isn't a brand, so it keeps a plain mark.
  { id: "email", name: "Email", color: "#3A3A38", glyph: "@", hint: "Its own inbox" },
  { id: "whatsapp", name: "WhatsApp", color: "#25D366", glyph: "W", logo: { src: "/logos/whatsapp.svg" }, hint: "Uses the bot's number" },
];
