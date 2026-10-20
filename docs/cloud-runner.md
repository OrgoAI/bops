# Cloud mode: routines on the bots' own computers

Settings has **Where routines run**: **Cloud** (the default) or **This Mac**. Orgo keeps the choice for
the whole account (`GET`/`PUT /api/bops/settings` on orgo-web; `profiles.bops_runs_on`), so every Mac
of the user's and every runner go by the same one.

- **This Mac**: everything runs in the Bops app on the Mac, as before. Closed, nothing runs.
- **Cloud**: each computer a bot works on gets a **Bops runner**, and that runner runs the routines of
  the bots that work there, so they keep running while the Mac is closed. Orgo wakes the computer when
  one of its routines comes due, and lets it sleep again when nothing is due.

## How it runs

**The runner** is this same server, on the bot's computer (`BOPS_RUNNER=1`). It keeps the user's state
where the Mac does, in Bops Cloud, as a device of its own (`BOPS_DEVICE_SEED` is the computer's id). It
signs in with its computer's own Orgo key (below), answers on 127.0.0.1:3210 only, and has a window token
nobody has. It won't start otherwise (`lib/server/runner-start.ts`: "no ORGO_API_KEY on this computer").

**Its key** is the computer's, not Bops': an account-wide Orgo key named "Computer key for <computer>",
which Orgo makes for that one computer, writes there as `ORGO_API_KEY`, and revokes when the computer is
deleted (orgo-web keeps which key is whose, `instance_details.orgo_key_id`). It gets there one of two ways:

- When the computer is made, from a template that asks for it (`secrets: orgo_api_key`; bops-base 0.1.9
  on). Metal writes `export ORGO_API_KEY='…'` into `/root/.env`.
- When the Mac sets a runner up on a computer that has none (made before that template, or its key taken
  off): `PUT /api/computers/{id}/orgo-key`, no body. Orgo writes it into `/root/.orgo-secrets.env` (0600,
  sourced by `/root/.env`) and takes the line made with the computer out of `/root/.env`; the Mac only
  hears its id.

The runner reads it from those files itself (`lib/server/runner-key.ts`): `/root/.orgo-secrets.env`
first, then `/root/.env`, the first that sets it wins, shell quoting as Orgo writes it, and only from a
file nobody but root can read (no read for group or others, or in `/root`, which is 0700). It's never in
the runner's settings, its wrapper or its supervisord program, and never logged. Orgo may write a new one
later (a restore in place, or a copy made from the computer, which gives both a new one), so when Orgo
answers 401 the runner reads the files again (at most every 5 seconds, twice as long each time they have
the same one, up to 5 minutes) and goes on with the new one, in Bops Cloud too.

Settings shows under each computer's runner whether the computer holds its own key: "Own Orgo key
sk_live_ab12… · used 5m ago" with Manage in Orgo (Settings, API keys on Orgo), or "No Orgo key" when it
has none and its runner counts on one (Running, or couldn't start for want of it). The Mac asks
`GET /api/computers/{id}/orgo-key` (`lib/server/computer-keys.ts`, through `/api/runs-on/keys`, never
from the window) with the signed-in key, for the computers some bot works on, only while Settings is
open, keeping each answer a minute. Orgo answers from its own records (`{ keyId, prefix, name,
createdAt, lastUsed, expiresAt }`, or 404 `key_not_found`), so it never wakes the computer, and nothing
else is asked about it. A 405 (an orgo-web before that GET), 403, any other answer, or none within 5
seconds shows nothing.

**What it runs** is an allow-list (`lib/server/persist.ts` `RUNNER_LOOPS`): the routines timer, the
mirror of its own routines to Orgo, the threads it started, and telling Orgo its computer is in use
while one of its tasks runs (`via: 'runner'`, so Orgo suspends it 5 minutes after, not 15). Everything
else that runs by itself stays on the Mac: watches, the digest, email, texts and calls, Telegram,
Discord and Slack, the look at the bots' computers, routing through home internet, the Mac's time zone,
Codex on the Mac, the cloud tunnel, memory sorting and Orbit, the map and the access set sent to Orgo,
and setting runners up. `scripts/test-runner-mode.mjs` fails when a new loop isn't on one side.

**Who runs which routine** (`lib/server/runner.ts` `runsHere`):

- A runner runs a routine whose bot works on its computer and that doesn't need the Mac
  (`pinnedToMac`: set to run on the Mac, or its bot works on the Mac, or its words say so), while Orgo
  said Cloud under a minute ago and the state marks that runner Running.
- The Mac runs the rest: routines that need the Mac, bots with no computer yet, and computers whose
  runner isn't Running (none, Setting up, Couldn't start, or being stopped for over 90 seconds).
- A routine that moves from one Bops to another (a runner set up again or failing, its bot moved to
  another computer, the routine set to run on the Mac) waits 90 seconds on the one it goes to, unless
  the runner it left is confirmed stopped, so the one it left has read the state by then.
- A runner runs nothing it isn't sure of: where the bots work as Orgo said under a minute ago, the
  state as read under 40 seconds ago, that it's on its own computer (below, looked at right before
  each run), none of it from before a nap (its computer suspended in between).
- Threads say which Bops runs them (`Session.by`), so a restart fails only its own. A thread changed on
  two Bops at once is the copy of the one that runs it, with the replies and steps of both, so a reply
  on the Mac reaches a runner's thread. Stop on another Bops's thread asks that one to stop it
  (`stopAsked`), and it does when it hears.

**Waking**: the Mac sends each routine's next time to Orgo, with how it runs and whether it needs the
Mac (`run`, `onMac`), and the map of the workspace's bots and the computer each works on (`PUT
/api/projects/{id}/bops`). orgo-web's `bops-routine-wake` job wakes the computer of the bot whose
routine comes due, and its idle suspend leaves a computer up while one is due within a few minutes.

**Setting a runner up** (from the Mac only, `lib/server/runner-install.ts`):

1. Only in Cloud, for a computer some bot works on as both Orgo's map and the Mac have it, and never
   where someone else can use the workspace (they're root there, or could become it; the key is the
   whole account's): "Couldn't start: someone else can use this workspace", and its routines stay on the
   Mac. The Mac looks first at what Orgo's members list shows (any other member, View only too, or an
   invite still open); Orgo, which counts a live share link too, has the last word (409
   `full_access_member`). Neither is waited on: each look asks again.
2. The server bundle the app ships (`scripts/server-bundle.sh`, run by `scripts/release.sh`: the
   release build, stripped and checked for leaked secrets, in `Resources/runner`; on a dev Mac the
   newest in `dist-runner/`) goes up through Orgo's file uploads to `/opt/bops/runner/incoming`. One
   command then checks its sha256, unpacks it to `/opt/bops/runner/<version>-<BUILD_ID>` and points
   `current` at it, under a lock.
3. Its key: the Mac asks the computer whether a file has `ORGO_API_KEY` (grep, never printed). It has one
   (made with it, or given it before): left as it is. None: `PUT /api/computers/{id}/orgo-key`, and the
   state says Bops gave it (`runners[computer].keyMade`, with `keyId` to show), so Bops takes it back when
   it stops the runner. Orgo keeps one key per computer and revokes an earlier one itself. Refused: "someone
   else can use this workspace" (409), "only the workspace's owner can set a runner up there" (403
   `owner_only`), "Orgo can't set up a runner on it yet" (404 or 405, an Orgo from before the route),
   "a runner needs a Linux computer" (422).
4. A supervisord program (Orgo computers have no systemd), `/etc/supervisor/conf.d/bops-runner.conf`,
   starts `/opt/bops/runner/run.sh`, which sets the runner's settings (none secret) and makes a fresh
   window token each start. No command sent carries a key or a token.
5. The health check: it answers on 127.0.0.1:3210 and listens there only. Then it's Running, and the
   Mac leaves that computer's routines to it.

A build already unpacked on the computer (a copy of a computer with a runner, a try again) is used as it
is, without an upload. A newer runner is never replaced by an older one; the same version again
replaces it only when the Mac that set it up last built it again (a dev Mac). A runner that's up and set
up again (a new release) stays Running, with its routines, until the new one starts in its place
(`runners[computer].upgrading`); a try that doesn't get that far leaves it as it was and is tried again
later.

A bot's computer copied from its main bot's is a clone when the main computer has a runner (a fork
carries on from the running computer's memory, runner and all), and has the runner taken off as its
first command (its supervisord program and its wrapper, never its key). Orgo gives a copy (a fork, a
clone, one restored as new) a key of its own, or none where it may not hold one, and revokes the
source's from the copy, so no key is live on two computers. A runner checks it's on its own computer as it starts (before it reads the state, so a
copy never takes the original's threads for its own), right before each run, and every 5 minutes while
a task of its own runs (a word it writes, read back through Orgo from the computer it was set up on): a
copy takes its runner off and stops. A read that didn't finish (a slow computer's command timing out)
proves nothing either way. An idle runner sends no command to its computer at all: Orgo counts a
command as using it, and it would never sleep.

The routines Orgo keeps say the Mac runs them (`onMac`) unless a computer's runner that's Running runs
them, and each runner going up or down sends them again, so Orgo wakes a computer only for a runner
that will run what's due. When a routine of a Running runner is 10 minutes past its time and its
computer is up, the Mac asks whether the runner's program is still there (at most once an hour); gone,
it's Couldn't start, and its routines go back to the Mac.

**Stopping one**: switching to This Mac (or the bots to browsers on the Mac), the computer deleted, or no
bot working on it any more. Its program and wrapper are taken off its computer (one asleep isn't woken
for it, and runs nothing meanwhile: the state says it's Stopping), its threads end with a plain reason
(as the Mac's, so a last save from the runner can't bring them back), and Bops takes back only what it
gave: when `keyMade`, whichever Mac stops it sends `DELETE /api/computers/{id}/orgo-key` (200 or 404 is
done), which revokes it and takes it off a computer that's up. A key the computer came with stays: it's
the computer's, and Orgo revokes it with the computer. A state from before `keyMade` with a `keyId` (the
old `bops-runner-key` route) counts as `keyMade`. It's taken out of the state once it's off its computer
and that key is revoked; until then it stays Stopping, and the next look tries again.

## Not in this version

- Chat on the runner: the Mac still runs chat turns while it's open, and the iPhone's chats don't go
  through a runner.
- Events waking a computer: texts, email and Slack still wait for the Mac.
- Brains on a runner that run on the Mac (Hermes, Claude Code on the Mac).
- A narrow runner credential (see the release blocker below).
- Versioned mirror PUTs (`bops_state_version`): Orgo's mirrors are last writer wins.
- A runner making new computers while the Mac is closed: the map and the runners catch up when the Mac
  opens.
- Saved logins and Telegram or Discord on a runner: their secrets are in the Mac's Keychain.
- Checking a runner's health while nothing is due: the Mac checks it when it sets it up, supervisord
  starts it again when it stops, and the Mac only asks again when one of its routines is overdue (above).

## Release steps

Before this Bops ships:

1. orgo-web: migrations `20261077` and `20261078` applied, and `feat/orgo-key-at-create` (the
   computer's own key: made at create for a template that asks for it, `PUT`/`DELETE
   /api/computers/{id}/orgo-key`, a copy's own key, the revoke with the computer) merged and deployed.
   The old `/api/computers/{id}/bops-runner-key` route is gone.
2. Publish bops-base 0.1.9 with `orgo_api_key` (`node orgo/bops-base.mjs publish`), then bump
   `BOPS_TEMPLATE` in `lib/server/orgo.ts` and orgo-web's curated ref (`lib/curated-templates.ts`) to
   `system/bops-base@0.1.9`. Until then the Mac's `PUT` gives each computer its key when it sets a runner
   up.

## Release blockers

**Older apps run the runners' routines too.** The state level is 4 (`cloud/protocol.ts`), so Bops
Cloud refuses an older app the user's state once this one wrote it, but an app from before this one
that's still open keeps running every routine from the copy it has in memory, the ones a runner now
runs included: only apps from this version on stop their routines on that refusal. Before Cloud mode
ships as the default, raise Bops Cloud's `bops.app_policy.block_below` to this release (Orgo's
`scripts/notices.sh` in OrgoAI/bops-secrets), so an older app is answered `APP_UPDATE_REQUIRED` on every
call but its state's and its runs fail instead of running a second time.

**The runner's key is the whole account's.** Orgo can't yet make a key that does only what a runner
needs, so each computer has an account-wide key of its own ("Computer key for <computer>", never handed
to Orgo's own agents, and it can't make or delete keys), and from bops-base 0.1.9 on every Bops computer
has one whether or not a runner runs there. The bots' agents run as root on the same computer and can be
steered by the web pages they read, so a page could get a bot to read that key, and with it the whole
Orgo account (computers, workspaces, members, AI credit). Cloud mode must not ship as the default until
the runner has a narrow, device-bound, revocable credential, or the bots no longer run as root beside it.
