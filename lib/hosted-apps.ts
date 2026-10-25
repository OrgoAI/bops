/*
 * Apps a workspace builds and runs on the web. Each app is an Ingot repo (Orgo's own source control, not
 * git: ingot/docs/hosted-api.md) in the central Ingot, under the workspace's Orgo project, where everyone
 * signs in with their Orgo key. A bot works on it on its Bops computer, in a working folder at
 * /workspace/apps/<name> made with `ingot clone`, through its brain (Claude Code, Codex, or Bops agent),
 * committing with `ingot commit` or the Ingot MCP tools; two people committing at once can't overwrite
 * each other (a commit names its base; a stale one is refused and `ingot pull` merges). Deploying builds
 * one changeset on that computer with orgo-web's deploy runner, at a public URL (<name>.orgo.dev).
 * Imported by the window and the Mac server.
 */

export type DeployState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "superseded";

/**
 * Where an app is worked on and runs, kept on its workspace (Workspace.hostedApps, by repo name): the bot
 * whose computer holds its working folder and runs its site, and once it was first deployed, the deploy
 * project there and its public URL.
 */
export type AppHosting = {
  botId: string;
  computerId: string;
  projectId?: string;
  url?: string;
  /** When this Mac last queued a deploy of it (a bot's, or the window's), so a window showing it reads it again. */
  queuedAt?: number;
};

/**
 * The agent token one of a workspace's computers signs in to Ingot with for it (Workspace.ingotTokens, by
 * computer): minted on the Mac with the user's Orgo key for that computer and workspace alone, and written
 * in the workspace's token file there (lib/server/ingot.ts ensureIngotCli). Kept: its id at Ingot, and the
 * sha256 of that file (to tell it from another), never the token.
 */
export type IngotToken = { id: string; sum: string; at: number };

/** One app as the Apps page shows it (GET /api/hosted-apps). */
export type HostedApp = {
  /** The Ingot repo's name (also the working folder's and the default site name). */
  name: string;
  /** The newest changeset on main (null: nothing committed yet). */
  head: string | null;
  updatedAt: number | null;
  hosting: AppHosting | null;
  /** The changeset its site serves now, as orgo-web says (null: none yet, or it couldn't be read). */
  serving: string | null;
  /** The newest deploy, whatever its state (null: never deployed, or it couldn't be read). */
  live: { id: string; at: string | null; state: DeployState | null; when: number | null; error: string | null; url: string | null } | null;
  /** Ingot can't say now (it isn't answering), so `head` and `updatedAt` aren't known. */
  offline?: true;
};

/** One changeset, newest first (GET /api/hosted-apps/[name]/commits). `serving`: the site serves this one. */
export type AppCommit = {
  id: string;
  message: string;
  author: string;
  at: number;
  changes: { added: number; modified: number; deleted: number };
  serving: boolean;
};

/**
 * GET /api/hosted-apps/[name]/commits?ws=&before= (the app's log in Ingot). `next`: pass as `before` for
 * older ones. `offline`: Ingot can't be reached now.
 */
export type AppCommitsAnswer = { commits: AppCommit[]; head: string | null; next: string | null; offline?: boolean };

/**
 * GET /api/hosted-apps?ws= . `enabled` false with `why` when deploying can't work here (signed out,
 * self-hosted, or Orgo answers that hosting isn't open to this account); the apps are still listed.
 */
export type HostedAppsAnswer = { enabled: boolean; why?: string; apps: HostedApp[] };

/**
 * POST /api/hosted-apps/[name] with { ws, action }:
 * - "deploy" { at?, botId? }: deploys changeset `at` (default the newest on main) on the app's computer,
 *   or on `botId`'s the first time; answers { app }.
 * GET /api/hosted-apps/[name]/logs?ws=&after= answers the newest deploy's { state, log, next, more }.
 */
export type HostedAppAction = { ws: string; action: "deploy"; at?: string; botId?: string };
