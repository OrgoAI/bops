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
signs in as its computer: with the computer's Orgo identity where it has one, else the computer's own
Orgo key (both below). It answers on 127.0.0.1:3210 only, and has a window token nobody has; it won't
start otherwise (`lib/server/runner-start.ts`).

**Its identity** comes first (`lib/server/vm-identity.ts`, `lib/server/orgo-auth.ts` `runnerKey`). On a
Linux computer on Orgo's hosts, Orgo's VMM answers `GET http://169.254.169.254/orgo/v1/identity/token`
(with `Metadata-Flavor: Orgo`) from inside that computer's own network, so the answer can only be that
computer's: an `orgo_vm_` token for it alone, for an hour, which orgo-web takes as a credential for that
one computer and its bots (its routines, Orbit, the access log, Logins), and nothing else of the
account. Nothing of it is written to disk or logged (the log says `identity ok (desktop …, expires in
52m)`). The runner asks over `node:http` with an agent of its own (no proxy, no redirects; 1 second to
connect, 10 in all) and, by what the VMM answers:

| Answer | The runner |
|---|---|
| 200 | uses the token, and asks again 25 minutes before it ends (at half its life for a short one), and after a nap (a wake may be another VM) |
| 403 (the computer doesn't qualify: someone else can use its workspace, say) | uses nothing at all, never its key file, and stops |
| 404 (none here) | uses its key file, and asks again in 5 minutes |
| connection refused or no connection in a second | as 404, unless a 200 or 403 came in the last 10 minutes (the VMM restarting): then as below |
| 429, 5xx, a read timeout | keeps the token in use while it hasn't ended, else its key file meanwhile; asks again after `Retry-After`, or 2 seconds doubling to 60 |

A 401 from Orgo or Bops Cloud for a token drops it for good and the call is made once more on the next
credential, at once: a fresh token (`?fresh=1`, at most every 5 seconds), or the key file with
`vm_identity_off` (for 5 minutes) or `bops_cloud_not_ready` (for 10: orgo-web won't answer a profile for
a token until Bops Cloud tells a computer from its user). A token for another account than the state's
stops the runner ("this computer now belongs to another Orgo account"). A new token for the same user
only swaps the key Bops Cloud's calls carry. `BOPS_RUNNER_IDENTITY=0` in the runner's environment skips
identity (debugging one runner; the wrapper never sets it).

What it signs in with goes in its log as `[runner] auth: identity`, `auth: key` or `auth: none`, at
start and on every change. **With no credential at all** (no identity here and no key file) it stays
up and runs nothing, asking its identity and reading its files every 30 seconds, and starts once
either is there: stopping would only have supervisord start it again forever, which no look from the
Mac could tell from a runner that runs. The Mac's way back (below) gives such a computer its key.

**Its key** is the fallback wherever identity doesn't reach (Mac VMs, bridged Linux computers, a host
without identity, identity paused). It's the computer's, not Bops': an Orgo key named "Computer key for <computer>",
which Orgo makes for that one computer, writes there as `ORGO_API_KEY`, and revokes when the computer is
deleted (orgo-web keeps which key is whose, `api_keys.desktop_id`, and holds it to that computer and its
bots once its pin is enforced, as it always does the identity token). It gets there one of two ways:

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

Settings, Your bots' computers (`components/app/bot-computers.tsx`, in every mode), shows under each bot
that has its own computer "Orgo identity (this computer only)" when its runner is up on its identity
(`runners[computer].auth`, from the health check), and whether that computer holds its own key: "Own
Orgo key sk_live_ab12… · used 5m ago" with Manage in Orgo (Settings, API keys on Orgo), or "No Orgo key"
when it has none and its runner counts on one (Running on its key, or couldn't start for want of it); a
bot that works on another bot's computer shows nothing more. The Mac asks
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
   "a runner needs a Linux computer" (422). In this release (the identity spec's phase 1) this step is
   the same whatever the computer's identity answers: every computer gets its key, so a runner that
   loses identity falls back to it at once. Phase 2 is below.
4. A supervisord program (Orgo computers have no systemd), `/etc/supervisor/conf.d/bops-runner.conf`,
   starts `/opt/bops/runner/run.sh`, which sets the runner's settings (none secret) and makes a fresh
   window token each start. No command sent carries a key or a token.
5. The health check: it answers on 127.0.0.1:3210 and listens there only, and says what it signs in
   with (`auth=identity`, `key` or `none`, the word from its log's last `[runner] auth:` line and
   nothing else, as orgo-web logs a command's output), kept as `runners[computer].auth`. Then it's
   Running, and the Mac leaves that computer's routines to it.

A build already unpacked on the computer (a copy of a computer with a runner, a try again) is used as it
is, without an upload. A newer runner is never replaced by an older one; the same version again
replaces it only when the Mac that set it up last built it again (a dev Mac). A runner that's up and set
up again (a new release) stays Running, with its routines, until the new one starts in its place
(`runners[computer].upgrading`); a try that doesn't get that far leaves it as it was and is tried again
later.

**Phase 2** (the identity spec's rollout step 12, behind `IDENTITY_ONLY` in
`lib/server/runner-install.ts`, off until every prod host has run identity through a full roll and a
staging drill of pausing identity shows the way back gives an identity-only runner a key). The probe
then also asks the computer's identity, the status code only:
`echo "ident=$(curl --noproxy '*' -s -m 3 -o /dev/null -w '%{http_code}' -H 'Metadata-Flavor: Orgo' http://169.254.169.254/orgo/v1/identity/token)"`.

| `ident=` | `key=` | What the Mac does |
|---|---|---|
| `200` | `no` | No PUT. The health check must say `auth=identity`, else it's unhealthy ("it couldn't sign in on its computer"), stopped, and tried again later |
| `200` | `yes` | Leaves the key in the key step. Only after the new build passed the health check with `auth=identity`, and only for a key this Mac's Bops gave (`keyMade`), takes it back (`DELETE`) and clears `keyMade`; a failed upload, install or health check leaves the runner that was up and its key as they were. A key the computer came with is Orgo's and stays |
| `403` | any | No PUT and no runner: "someone else can use this workspace" |
| anything else | `no` | Today's `PUT` (a key given while identity is out is taken back by the row above once it works) |
| anything else | `yes` | As today |

**The way back** (in this release, and what phase 2 counts on). When a Running runner's routine is 10
minutes overdue and its computer is up, the Mac asks whether the runner is still there (at most once
an hour, every 15 minutes for one on its identity); the same command says whether the computer has its
key, what its identity answers and what the runner last said it signs in with (none of it secret).
With no key, and an identity that answers anything but 200 or 403 (or a runner that says `auth: none`),
the Mac gives the computer its key (`PUT`, `keyMade`) and starts the runner if supervisord doesn't show
it running; a runner that waits picks the key up within 30 seconds. So a runner left with no credential
(identity paused or gone with its key taken off) is found within about 25 minutes while a Mac is on, and
waits for one otherwise. Refused, it couldn't start, and why.

A bot's computer copied from its main bot's is a clone when the main computer has a runner (a fork
carries on from the running computer's memory, runner and all), and has the runner taken off as its
first command (its supervisord program and its wrapper, never its key). Orgo gives a copy (a fork, a
clone, one restored as new) a key of its own, or none where it may not hold one, and revokes the
source's from the copy, so no key is live on two computers. A runner checks it's on its own computer as it starts (before it reads the state, so a
copy never takes the original's threads for its own), right before each run, and every 5 minutes while
a task of its own runs (a word it writes, read back through Orgo from the computer it was set up on): a
copy takes its runner off and stops. A read that didn't finish (a slow computer's command timing out)
proves nothing either way. An idle runner sends no command to its computer at all: Orgo counts a
command as using it, and it would never sleep. On its identity it asks its VMM instead
(`GET /orgo/v1/identity`, which only that computer's network reaches): another computer is a copy, and
nothing goes through Orgo, so the look never counts as using the computer (no answer there is the look
through Orgo). It also asks every minute: another computer leaves, and another VM of its own (a wake, a
restore, a move) gets a new token at once. Orgo stamps the source of every copy, so a token in a copy's
memory stops working within seconds.

The routines Orgo keeps say the Mac runs them (`onMac`) unless a computer's runner that's Running runs
them, and each runner going up or down sends them again, so Orgo wakes a computer only for a runner
that will run what's due. When a routine of a Running runner is 10 minutes past its time and its
computer is up, the Mac asks whether the runner's program is still there (at most once an hour); gone,
it's Couldn't start, and its routines go back to the Mac.

**In Bops Cloud** (`cloud/auth.ts`, `cloud/server.ts`; `cloud/README.md`, "A computer's runner") a
runner signed in as its computer, by its identity token or its own key, calls only what it needs: its
state (`GET`/`PUT /v1/state`, `GET /v1/state/head`), its threads (`GET`/`POST /v1/messages`), its
session, and the models and tools its own tasks use (`/proxy/openai/*` and its WebSocket, Honcho,
Composio, Typesafe, treg). Phone, mail handles, Slack links, numbers, codes, backups, notices, usage and
the tunnel answer it 403. Its device is Bops Cloud's to set from its computer id, and a write saying
another device is 403 (a guard against a runner set up wrong, not a bound: Q4 below). A computer's
answer is kept 30 seconds at most, never past its token's end.

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
- Bops Cloud limiting what a computer may touch of its user's state: a computer's token or key reads
  and writes the user's whole Bops state and spends their AI credit, as the key did before (the
  identity spec's Q4). The session it gets still holds the user's AgentMail key, as before.
- Versioned mirror PUTs (`bops_state_version`): Orgo's mirrors are last writer wins.
- A runner making new computers while the Mac is closed: the map and the runners catch up when the Mac
  opens.
- Saved logins and Telegram or Discord on a runner: their secrets are in the Mac's Keychain.
- Checking a runner's health while nothing is due: the Mac checks it when it sets it up, supervisord
  starts it again when it stops, and the Mac only asks again when one of its routines is overdue (above).

## Release steps

Before this Bops ships (identity: the identity spec's rollout, `vm-identity-spec.md` 5):

- Bops Cloud with the computer routes deployed to an environment before orgo-web's
  `VM_IDENTITY_BOPS_CLOUD_READY=1` there, and before `VM_IDENTITY=on` reaches Bops computers. Until
  that flag, orgo-web answers a profile for an identity token 403 `bops_cloud_not_ready`, and the runner
  signs in with its key file meanwhile.
- bops-base stays 0.1.9 with the optional `orgo_api_key` (the phase 1 fallback). Phase 2 publishes a
  version without it, bumps `BOPS_TEMPLATE` and orgo-web's curated ref, and turns `IDENTITY_ONLY` on.

Before that:

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

**The runner's key sits on the computer.** orgo-web binds the computer's key to its own computer and
its bots (`api_keys.desktop_id`; held to them once its pin is enforced, `ORGO_COMPUTER_KEY_PIN=enforce`,
as the identity token always is), but it stays in `/root` until it's taken off: the bots' agents run as
root on the same computer and can be steered by the web pages they read, so a page could get a bot to
read it. Phase 1 keeps it on every Bops computer (from bops-base 0.1.9 on, whether or not a runner runs
there) as the fallback for identity. Identity is the narrow, device-bound, revocable credential this
blocker asked for, written nowhere and good for an hour; phase 2 takes the key off the computers that
run on it. Until phase 2, a key read off a computer reaches that computer, its bots' routines, Orbit,
Logins and the user's whole Bops state in Bops Cloud (Q4).
