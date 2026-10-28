import { APPS_LABEL, sameLabel } from "./skill-labels";

/*
 * Bops' own skills, which every bot has and nobody edits (lib/skill-labels.ts): each one a short, exact
 * procedure a bot follows step by step, whether its brain is Bops agent, Claude Code or Codex. They're
 * listed under labels of their own (BUILTIN_LABELS) and read like any other skill (read_skill, or as files
 * on the computer at /workspace/capabilities/skills/<slug>/). Each body is a SKILL.md body: its first line
 * is "# <name>". Every command and tool a body names is a real one: the `ingot` command and Ingot's MCP
 * tools as ingot/docs/hosted-api.md says, the chat tools work_on_app and deploy_app (lib/hosted-apps.ts,
 * lib/server/hosted-apps.ts), and what orgo-web's deploy runner does (orgo-web docs/deploys.md);
 * scripts/test-builtin-skills.mjs holds them to that. Slugs start with bops-. Imported by the window and
 * the Mac server.
 */

/** A label Bops ships, with one line on what its skills are for. */
export type BuiltinLabel = { label: string; about: string };

/**
 * One of Bops' own skills. `description`: what it's for and when to read it, all a bot sees until it reads
 * it. `about`: more on when it fits, when the description alone doesn't say. `files`: text files beside its
 * SKILL.md (read_skill with file), never scripts.
 */
export type BuiltinSkill = {
  slug: string;
  name: string;
  description: string;
  label: string;
  about?: string;
  body: string;
  files?: { path: string; content: string }[];
};

export const BUILTIN_LABELS: BuiltinLabel[] = [
  {
    label: APPS_LABEL,
    about: "Building, versioning and deploying your workspace's apps with Ingot, Orgo's source control: read one before you change an app's code or put it live.",
  },
];

const WORK_ON_AN_APP = [
  "# Work on an app with Ingot",
  "",
  "Each app your workspace builds is an Ingot repo: Ingot is Orgo's own source control, not git. Its changes are changesets on main, and its working folder on your computer is /workspace/apps/<name>.",
  "",
  "A repo's full name is <workspace>/<name>, and your task gives it: name it in full wherever a command takes a repo, as your computer may work for more than one workspace. The `ingot` command on your computer is already signed in (an agent token for each workspace, in its config): never paste or print a token, and never ask for one.",
  "",
  "## In chat",
  "You don't edit an app from chat. Call work_on_app with app (its name as listed, or null for a new one), name (a new app's name, else null), change (what to build or change, complete on its own) and deploy (true when the user asked in the same message for it to go live too: Bops deploys it once the task has committed). A task on your computer does the work and follows this skill there.",
  "",
  "## Start",
  "1. `cd /workspace/apps/<name>`. The task cloned it there, or pulled the newest main into it, as it started.",
  "2. No folder? `ingot clone <workspace>/<name> /workspace/apps/<name>`. Never run git init there, and never copy the files somewhere else to work on them.",
  "3. `ingot status` lists what changed since the folder's base. Changes you didn't make: ask before you touch them.",
  "4. `ingot log -n 10` shows what changed lately, and who changed it.",
  "",
  "## Make the change",
  "1. Change only what the job asks for.",
  "2. Run it before you commit. A server listens on $PORT on 0.0.0.0: start it with PORT=3000, check it with `curl -i http://127.0.0.1:3000/`, then stop it. A plain site: `python3 -m http.server 3000` in the folder.",
  "3. `ingot diff` (or `ingot diff <path>`), and read every line you're about to commit.",
  "",
  "## Commit",
  '1. `ingot commit -m "<what changed, in one clear line>"` commits every change in the folder that isn\'t ignored. There is no add step: whatever `ingot status` lists goes in.',
  '2. One idea per commit, with a message that says it: "Add the signup form", never "updates". A second -m adds a paragraph on why.',
  "3. `ingot show <id>` shows what a commit holds. `ingot log` prints the ids; the short ones work.",
  '4. Refused because main moved on? Someone committed first: follow the skill "When several people push at once".',
  "",
  "## Never commit",
  "1. Secrets: keys, passwords, tokens, .env files. They're the app's environment variables, which the user sets in Orgo as the app's Variables, and the code reads them from the environment.",
  "2. What an install or a build makes. Ignored by default: .ingot/, .git/, node_modules/, .DS_Store, __pycache__/, *.pyc, .next/, dist/, build/ and .env*.",
  "3. Anything else that shouldn't go in: add it to .ingotignore (gitignore's syntax) at the top of the folder. A line starting with ! there brings back one of the defaults (never .ingot/ or .git/).",
  "",
  "## Claude Code and Codex",
  "On an app's task you also have Ingot's tools. In the working folder (dir): repo_status (dir), repo_diff (dir, path), repo_commit (dir, message) and repo_pull (dir). By the app's name: repo_log, repo_show, repo_file and repo_tree. They do what the commands do.",
  'Plain git works too, with the same history, in a clone of its own beside the working folder, never inside it: `git clone "$(ingot git-url <workspace>/<name>)" /workspace/apps/<name>-git`, then the skill "When several people push at once" for pull and push. In the working folder, use Ingot\'s commands.',
  "",
  "## Done",
  'Say in the chat what you changed and the commit\'s short id. Putting it live is separate: the skill "Deploy an app".',
];

const SEVERAL_PEOPLE = [
  "# When several people push at once",
  "",
  "People and bots can work on one app at the same time. Every commit and push names the changeset it started from, and Ingot refuses one that didn't start from the newest main. Nothing was written and nothing is lost: it's normal, and the answer is to pull, merge and commit again.",
  "",
  "## What you'll see",
  '`ingot commit` (and repo_commit): "main has moved on since this folder\'s base ... Nothing was committed. Run ingot pull to bring in the new changes, then ingot commit again."',
  'A git push: "remote: ingot: main has new changesets since you fetched. Run git pull --no-rebase, then git push again."',
  "",
  "## What to do",
  "1. `ingot pull` (or repo_pull) in the working folder. It brings in the newest main, merges your uncommitted changes into it file by file, and lists each file: updated, merged, conflict, kept or restored.",
  "2. See what came in: `ingot log -n 5`, then `ingot show <id>` on each new one, so you know what the other person meant.",
  "3. A file listed as conflict holds both sides where you both changed the same lines:",
  "```",
  "<<<<<<< yours",
  "(your lines)",
  "=======",
  "(their lines, from main)",
  ">>>>>>> theirs",
  "```",
  "4. Edit it so it does what both changes meant to do, and delete the three marker lines. When they truly clash, keep theirs working, fit yours around it, and say so.",
  "5. A binary file you both changed (an image): yours stays, and main's is beside it as <path>.theirs. Keep one and delete the other.",
  "6. Kept: main deleted a file you changed. Restored: you deleted a file main changed. Decide whether each should stay.",
  "7. Run the app again and check that both changes work.",
  '8. `ingot status`, then `ingot commit -m "<your change>, merged with <what came in>"`. Commit refuses while any marker or .theirs file is left.',
  "9. Refused again? Someone committed meanwhile: go back to step 1.",
  "10. Say in the chat what came in, whose it was, and how you merged it.",
  "",
  "Pull refuses when an ignored file of yours (such as .env) is where main now has one: move yours aside, pull, and put its values in the app's Variables, not the repo.",
  "",
  "## Plain git",
  "`ingot setup-git` already set up git's credential helper on your computer, so git signs in on its own. Never put a token in a URL or a command. git asks for a password anyway: don't type one, stop and say so in the chat.",
  'Clone it beside the working folder, never inside it (Ingot would commit the copy): `git clone "$(ingot git-url <workspace>/<name>)" /workspace/apps/<name>-git`. When a push is refused: `git pull --no-rebase`, resolve the conflicts the same way (git\'s markers say HEAD for yours), `git commit`, then `git push origin HEAD:main`.',
  "",
  "## Never",
  "1. Never force: no forced push, and never clone again to copy your files over theirs.",
  "2. Never drop someone else's change to make yours fit, and never delete a conflicted file to make the conflict go away.",
  "3. Never commit with a marker left in a file.",
];

const DEPLOY_AN_APP = [
  "# Deploy an app",
  "",
  "Deploying puts one changeset of an app on the web, at its public address (https://<name>.orgo.dev). That changeset comes from the app's Ingot repo, and it's built and run on the app's computer.",
  "",
  "## Only when asked",
  'Deploy only when the user asked for it in their own words ("put it live", "deploy it", "roll it back"). A finished change is no reason to deploy: say it\'s ready and ask.',
  "In a task on your computer you don't deploy: say what's committed. When your task says Bops puts it live once you've committed, it does, so don't tell the user to deploy it; otherwise they deploy it from the Apps page or ask for it in chat.",
  "",
  "## How",
  "1. Commit first. A deploy builds a changeset on main, never what's in a working folder.",
  "2. deploy_app with app (its name as listed) and at null deploys the newest commit on main.",
  "3. To roll back, or put an older one live again: deploy_app with at set to that changeset's id (the short id from ingot log works). Say that main still has the newer commits, and the next plain deploy puts them back.",
  "4. It answers with what it queued and the address. A first deploy gets its address once it's live; the Apps page shows it then.",
  "",
  "## What a deploy does",
  "1. Exports that changeset into a new folder (`ingot export`), checking every file.",
  '2. Detects how to build it (the skill "Make a web app that deploys cleanly"), installs and builds. A build stops after 30 minutes.',
  "3. Starts it with PORT set and HOST=0.0.0.0. Within 60 seconds, its / must answer on that port with any status below 500.",
  "4. It answered: the new release is live. It didn't: the release that was live before (if there was one) is live again, and the deploy failed.",
  "One build at a time per computer, and a newer deploy of an app replaces one still queued. A computer that's asleep builds once it runs.",
  "",
  "## How it went",
  'The app\'s tab on the Apps page shows its state (Deploying, Live, or why it failed) and its Deploy log: each step ("==> Installing dependencies", "==> Building"), each command it ran ("$ npm ci") and the end ("Answered 200 on port 3000. Live."). Values of variables are masked there. When you can\'t see it, ask the user for the log\'s last lines.',
  "",
  "## When it fails",
  "1. Say in plain words which step failed and why, from the log.",
  '2. It couldn\'t tell how to run it: add a start script, a Procfile web: line or an orgo.json (the skill "Make a web app that deploys cleanly").',
  "3. Install or build failed: in a task on its computer, export the same changeset into a new folder (`ingot export --repo <workspace>/<name> --at <id> /tmp/<name>-check`), run the same commands there, fix it in the working folder, commit.",
  "4. It didn't answer within 60 seconds: it isn't listening on $PORT on 0.0.0.0, it crashed as it started (a missing variable, often), or its / is slow. Its own output is in /var/log/orgo/svc-<name>.log on its computer. The release before is still live, so nothing is down.",
  "5. Fix it with work_on_app, then deploy again only when the user says so. Never deploy again and again hoping it passes.",
];

const WEB_APP_THAT_DEPLOYS = [
  "# Make a web app that deploys cleanly",
  "",
  "Orgo builds an app from its Ingot repo, on the app's computer, and runs it at https://<name>.orgo.dev. Make it so the first deploy works.",
  "",
  "## How Orgo knows what it is",
  "The first of these at the top of the repo decides:",
  "1. compose.yaml, compose.yml, docker-compose.yml or docker-compose.yaml: Docker Compose.",
  "2. Dockerfile: docker build, then docker run, with PORT set to the port it EXPOSEs (else the app's port).",
  "3. package.json: Node.js (from .nvmrc, .node-version or engines.node; 18 to 24, 22 by default). The lockfile picks npm, pnpm, yarn or bun. Its build script runs when it has one; a start script (or orgo.json's start) is required.",
  "4. requirements.txt, pyproject.toml (with uv.lock, uv sync) or Pipfile: Python in a uv virtual environment, started by a Procfile web: line (or orgo.json's start).",
  "5. index.html: a plain site, served with python3 -m http.server.",
  "Pick the simplest that fits. A plain site needs only an index.html.",
  "",
  "## Run where Orgo looks",
  "1. Listen on the port in $PORT, on 0.0.0.0 (HOST says 0.0.0.0 too). Never a fixed port, never 127.0.0.1 or localhost alone.",
  "2. Its / must answer with any status below 500 within 60 seconds of starting. Start listening first; slow work (migrations, warming a cache) comes after, or in the build.",
  "3. The start command stays in the foreground: it never goes to the background or exits.",
  "",
  "## orgo.json",
  'When detection would guess wrong, put an orgo.json at the top of the repo: { "framework": "node", "install": "npm ci", "build": "npm run build", "start": "node server.js" }. framework is one of node, python, dockerfile, compose and static; leave out whatever detection gets right.',
  "",
  "## Secrets and settings",
  "1. API keys, passwords and DATABASE_URL are the app's environment variables, never files in the repo (.env files are never committed). The user sets them in Orgo, as the app's Variables: ask for the name you need, never the value.",
  "2. Read them from the environment (process.env.DATABASE_URL, os.environ[\"DATABASE_URL\"]), and stop with a clear message when one is missing.",
  "3. They reach the build too, so NEXT_PUBLIC_ ones work.",
  "",
  "## Build",
  "1. A build stops after 30 minutes: no huge downloads or model weights in it.",
  "2. dist/, build/, .next/ and node_modules/ are never committed, so the build makes them from the source.",
  "3. Commit the lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock, uv.lock) so the deploy installs what you tested.",
  "",
  "## Check before you commit",
  "Run it as Orgo will: install, build, then start it with PORT=3000 HOST=0.0.0.0, and check that `curl -i http://127.0.0.1:3000/` answers below 500 within seconds. Then stop it.",
  "",
  "## A start to copy",
  "examples/node-app/ in this skill (read_skill with file examples/node-app/server.js, and examples/node-app/package.json) is a small Node.js app that does all of this.",
];

const APP_HISTORY = [
  "# Read an app's history",
  "",
  "Every change to an app is a changeset on main: who made it, when, its message and its files. Nothing is rewritten, so the history is the record.",
  "",
  "## The commands",
  "In the working folder /workspace/apps/<name>, or anywhere with --repo <workspace>/<name>:",
  '1. `ingot log` lists main\'s changesets, newest first: short id, time (UTC), author, the message\'s first line and the files it added, modified and deleted (+1 ~2 -0). "merge" marks a merge, and "(this folder)" the one your folder is on.',
  "2. `ingot log -n 100` shows more (200 at most). For older ones, `ingot log --before <id>` with the id it prints at the end.",
  "3. `ingot log <path>` lists only the changesets that touched that file or folder.",
  "4. `ingot show <id>` shows one in full: author, time, message, files and the patch against the one before it. Short ids work.",
  "Claude Code and Codex can use Ingot's tools instead: repo_log (name, path, limit, before), repo_show (name, id), repo_file (name, path, at) for a file as it was, and repo_tree (name, at) for the files.",
  "",
  "## When something changed, and who changed it",
  "1. `ingot log <the file>` narrows it to the changesets that touched it.",
  "2. `ingot show <id>` on each, newest first, until one changes the lines in question.",
  '3. Answer with its author, when, its message and its short id, in plain words: "Sam raised the Pro price to $20 on Oct 3 (a1b2c3d)."',
  '4. Who last changed a given line: in a plain git clone (the skill "When several people push at once"), `git blame <file>`. Its authors are the changesets\' authors.',
  "",
  "## Comparing two changesets",
  "`ingot show` compares one with the one before it. For two far apart, export both into new folders and compare them:",
  "```",
  "ingot export --repo <workspace>/<name> --at <older id> /tmp/<name>-a",
  "ingot export --repo <workspace>/<name> --at <newer id> /tmp/<name>-b",
  "diff -ru /tmp/<name>-a /tmp/<name>-b",
  "```",
  "Delete both folders when you're done.",
  "",
  "## Looking at an older version",
  "`ingot checkout <id>` moves a clean folder to that changeset, to read or run it; `ingot checkout main` brings it back. Never commit from an older one: commit refuses it anyway, since it didn't start from the newest main.",
  "",
  "## Putting an older one live",
  "That's a deploy, not a commit. The user picks it in the app's History on the Apps page and presses Deploy this one, or asks in chat, and you call deploy_app with at set to its id. Main keeps the newer changesets, so the next plain deploy brings them back.",
  "To undo a change on main itself, make a new commit that reverses it, and say so.",
];

/** A Node.js app that deploys cleanly: listens on $PORT on 0.0.0.0, answers / at once, stays in the foreground. */
const NODE_SERVER = [
  "// A small web app that deploys cleanly on Orgo: it listens on $PORT on 0.0.0.0 and answers / at once.",
  'const http = require("node:http");',
  "",
  "const port = Number(process.env.PORT) || 3000;",
  'const host = process.env.HOST || "0.0.0.0";',
  "",
  "http",
  "  .createServer((req, res) => {",
  '    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });',
  '    res.end("<!doctype html><title>Hello</title><h1>Hello</h1>\\n");',
  "  })",
  "  .listen(port, host, () => console.log(`Listening on http://${host}:${port}`));",
  "",
];

/** Its package.json: a start script, and nothing to install. */
const NODE_PACKAGE = ["{", '  "name": "my-app",', '  "private": true,', '  "scripts": { "start": "node server.js" }', "}", ""];

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    slug: "bops-work-on-an-app",
    name: "Work on an app with Ingot",
    description: "Read before you build or change an app: its working folder, ingot status, diff and commit, what never goes in a commit, and Ingot's tools for Claude Code and Codex.",
    label: APPS_LABEL,
    body: WORK_ON_AN_APP.join("\n"),
  },
  {
    slug: "bops-several-people-pushing",
    name: "When several people push at once",
    description: "Read when ingot commit or a git push is refused because main moved on: pull, resolve the yours and theirs markers keeping both changes, run it, commit again. Never force.",
    label: APPS_LABEL,
    body: SEVERAL_PEOPLE.join("\n"),
  },
  {
    slug: "bops-deploy-an-app",
    name: "Deploy an app",
    description: "Read before you put an app live with deploy_app: when to, what a deploy does, how it went, and what to do when it fails or an older changeset should be live again.",
    label: APPS_LABEL,
    body: DEPLOY_AN_APP.join("\n"),
  },
  {
    slug: "bops-web-app-that-deploys",
    name: "Make a web app that deploys cleanly",
    description: "Read when you make a new web app or one won't deploy: how Orgo detects and builds it, listening on $PORT and 0.0.0.0, answering / quickly, orgo.json, and secrets as variables.",
    label: APPS_LABEL,
    body: WEB_APP_THAT_DEPLOYS.join("\n"),
    files: [
      { path: "examples/node-app/server.js", content: NODE_SERVER.join("\n") },
      { path: "examples/node-app/package.json", content: NODE_PACKAGE.join("\n") },
    ],
  },
  {
    slug: "bops-app-history",
    name: "Read an app's history",
    description: "Read when someone asks what changed in an app, when, or who changed it: ingot log and show, comparing two changesets, an older version, and putting an older one live.",
    label: APPS_LABEL,
    body: APP_HISTORY.join("\n"),
  },
];

/**
 * Bops' own skills an account has, and their labels: those under APPS_LABEL only where apps are open
 * (`apps`: lib/apps-access.ts appsOpen), so anyone else's bots never list, read or get them on a computer,
 * and the Skills page doesn't show them.
 */
export const builtinSkills = (apps: boolean): BuiltinSkill[] => (apps ? BUILTIN_SKILLS : BUILTIN_SKILLS.filter((s) => !sameLabel(s.label, APPS_LABEL)));
export const builtinLabels = (apps: boolean): BuiltinLabel[] => (apps ? BUILTIN_LABELS : BUILTIN_LABELS.filter((l) => !sameLabel(l.label, APPS_LABEL)));
