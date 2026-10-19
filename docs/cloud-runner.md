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
signs in with a key Orgo made for it and wrote on that computer (`/root/.bops/runner/key`, root only),
answers on 127.0.0.1:3210 only, and has a window token nobody has. It won't start otherwise
(`lib/server/runner-start.ts`).

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
   where someone else has Full access to the workspace (they're root there; the key is the whole
   account's): "Couldn't start: someone else has Full access to this workspace", and its routines stay
   on the Mac.
2. The server bundle the app ships (`scripts/server-bundle.sh`, run by `scripts/release.sh`: the
   release build, stripped and checked for leaked secrets, in `Resources/runner`; on a dev Mac the
   newest in `dist-runner/`) goes up through Orgo's file uploads to `/opt/bops/runner/incoming`. One
   command then checks its sha256, unpacks it to `/opt/bops/runner/<version>-<BUILD_ID>` and points
   `current` at it, under a lock.
3. Its key: `PUT /api/computers/{id}/bops-runner-key`, once per computer. Orgo writes it on the
   computer itself and revokes the computer's earlier runner keys; the Mac only keeps its id
   (`runners[computer].keyId`), which other Macs reuse. Any Mac of the user's revokes it.
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
first command. A runner checks it's on its own computer as it starts (before it reads the state, so a
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
bot working on it any more. Its program and key file are taken off its computer (one asleep isn't woken
for it: it can't run anything once its key is revoked), its key is revoked by whichever Mac stops it,
its threads end with a plain reason (as the Mac's, so a last save from the runner can't bring them
back), and it's taken out of the state once it's off its computer and its key is revoked. Until both
are done it stays Stopping, and the next look tries again.

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

## Release blockers

**Older apps run the runners' routines too.** The state level is 4 (`cloud/protocol.ts`), so Bops
Cloud refuses an older app the user's state once this one wrote it, but an app from before this one
that's still open keeps running every routine from the copy it has in memory, the ones a runner now
runs included: only apps from this version on stop their routines on that refusal. Before Cloud mode
ships as the default, raise Bops Cloud's `bops.app_policy.block_below` to this release (Orgo's
`scripts/notices.sh` in OrgoAI/bops-secrets), so an older app is answered `APP_UPDATE_REQUIRED` on every
call but its state's and its runs fail instead of running a second time.

**The runner's key is the whole account's.** Orgo can't yet make a key that does only what a runner
needs, so each runner has an account-wide key (named "Bops runner on <bot>", reserved, never handed to
Orgo's own agents). The bots' agents run as root on the same computer and can be steered by the web
pages they read, so a page could get a bot to read that key, and with it the whole Orgo account
(computers, workspaces, members, AI credit). Cloud mode must not ship as the default until the runner
has a narrow, device-bound, revocable credential, or the bots no longer run as root beside it.
