# Cloud mode: routines on the bots' own computers

Settings has **Where routines run**: **Cloud** (the default) or **This Mac**. Orgo keeps the choice for
the whole account (`GET`/`PUT /api/bops/settings` on orgo-web; `profiles.bops_runs_on`), so every Mac
of the user's and every runner go by the same one.

- **This Mac**: everything runs in the Bops app on the Mac, as before. Closed, nothing runs.
- **Cloud**: each computer a bot works on gets a **Bops runner**, and that runner runs the tasks of the
  bots that work there, start to finish, so they keep running while the Mac is closed. Orgo wakes the
  computer when one of its tasks comes due, and lets it sleep again when nothing is due. Nothing of a run is
  ever handed to the Mac in the middle of it: what only the user can give (their OK, a sign in) is a wait
  the run pauses in, shown on every Bops of theirs (below). Chat belongs to the backend, and a bot's computer is
  only for work that needs one: reminders and chat runs are the Mac's for now, as before runners (below).

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
| 200 | uses the token, and asks again 25 minutes before it ends (at half its life for a short one), and after a nap (a wake may be another VM). A token for another computer than its own (`desktop_id` isn't `BOPS_RUNNER_COMPUTER`): this is a copy (a live fork), which never takes it up and leaves (below) |
| 403 (the computer doesn't qualify: someone else can use its workspace, say) | uses nothing at all, never its key file, and stops |
| 404 (none here) | uses its key file, and asks again in 5 minutes |
| connection refused or no connection in a second | as 404, unless a 200 or 403 came in the last 10 minutes (the VMM restarting): then as below |
| 429, 5xx, a read timeout | keeps the token in use while it hasn't ended, else its key file meanwhile; asks again after `Retry-After`, or 2 seconds doubling to 60 |

A 401 from Orgo or Bops Cloud for a token drops it for good and the call is made once more on the next
credential, at once (the runner picks it as the 401 comes, not at its next call): a fresh token
(`?fresh=1`, at most every 5 seconds), or the key file with `vm_identity_off` (for 5 minutes).
`bops_cloud_not_ready` (orgo-web won't answer a profile for a token until Bops Cloud tells a computer
from its user, `VM_IDENTITY_BOPS_CLOUD_READY`) drops nothing: orgo-web still takes the token, so the
runner keeps it for orgo-web's calls, and only Bops Cloud and Orgo's profile get the key file for 10
minutes (`cloudKey`), then the token again; no fresh token is asked for meanwhile. A token for another account than the state's
stops the runner ("this computer now belongs to another Orgo account"). A new token for the same user
only swaps the key Bops Cloud's calls carry. `BOPS_RUNNER_IDENTITY=0` in the runner's environment skips
identity (debugging one runner; the wrapper never sets it).

What it signs in with goes in its log as `[runner] auth: identity`, `auth: key` or `auth: none`, at
start and on every change, and in `/opt/bops/runner/auth` (the word alone, 0600), which the Mac's look
reads first: the log rotates at 5 MB and the word is said only when it changes. It says `key` while Bops
Cloud takes its key file (`bops_cloud_not_ready`), as it needs that key then. **With no credential at all** (no identity here and no key file) it stays
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
the same one, up to 5 minutes) and goes on with the new one, in Bops Cloud too. The first time it uses a
key it asks Orgo's profile, in the background, whose it is: one Orgo says isn't this computer's own
(an account's or a workspace's key someone put in `/root/.env`, another computer's, a computer key Orgo
never bound to one) is never used again, its file named in the log, and the runner waits with `auth:
none`, which has the Mac's way back give it its own (below). An Orgo from before keys were bound to
their computers can't say, and the key is used as before.

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
Discord and Slack, the look at the bots' computers, routing through home internet, the Mac's time zone
(a runner starts in the user's zone and follows it as the Mac keeps it, right before it runs anything),
Codex on the Mac, the cloud tunnel, memory sorting and Orbit, the map and the access set sent to Orgo,
and setting runners up. `scripts/test-runner-mode.mjs` fails when a new loop isn't on one side.

**Who runs which routine** (`lib/server/runner.ts` `runsHere`):

- A runner runs a routine whose bot works on its computer and that doesn't need the Mac, as decided
  before a run starts (`pinnedToMac`, `lib/types.ts` routineOnMac, which the app shows by too: set to run
  on the Mac, or its bot works on the Mac, or its words say so, or the Mac would send it there
  (`Routine.macPick`: for a task left to Bops, the Mac works out ahead of its runs where it would send them,
  by the user's app rules and Jev, as for a run of its own); its result goes to Slack, Telegram or Discord,
  which a runner can't post to; or it follows a skill, or its bot has skills or apps of its workspace
  published for it, whose files only the Mac has), while Orgo said Cloud under a minute ago and the state
  marks that runner Running. Nothing a run meets on the way changes that: a request for the user's OK, or a
  sign in (a saved login's too, whose password only the Mac's Keychain has), waits on the runner, saying
  so (below).
- **Reminders and chat runs are the Mac's** (`needsNoComputer`, `pinnedToMac`): chat belongs to the
  backend, and a bot's computer is only for work that needs one. Until Bops Cloud can run a turn with the
  bot's tools (`cloud/agent.ts` answers the phone with none yet), the Mac runs them, as v0.0.29 did: a
  runner never runs one, whether a Mac is up or not, and Orgo never wakes a computer for one nor keeps one
  up for it (the mirror sends them `onMac`). One due while no Mac is up runs once a Mac is up again,
  late, or as a missed run, as before runners. A chat run that needs a computer starts a task
  (`start_task`), which runs on its bot's computer as any task the Mac starts does.
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
  (`stopAsked`), and it does when it hears. One paused for the user's OK there ends at once where Stop was
  pressed (below): nothing of it runs anywhere to stop. Stop never makes a thread another Bops's, so Try
  again or a reply, from whichever of the user's Macs, sends it back to that computer's runner, never to the
  Mac (`sessions.ts` replyToSession, `runner.ts` runnerUpFor).

**Waking**: the Mac sends each routine's next time to Orgo, with how it runs and whether it needs the
Mac (`run`, `onMac`), and the map of the workspace's bots and the computer each works on (`PUT
/api/projects/{id}/bops`). orgo-web's `bops-routine-wake` job wakes the computer of the bot whose
routine comes due, and its idle suspend leaves a computer up while one is due within a few minutes.

**A computer that's down waits; its routines never move.** When nothing wakes it (the job is off, or turns
it down: Free hours used up, paused, unfunded), or the computer is down and doesn't come back by itself
(stopped, frozen or in error: a Stop on orgo.ai, a Bops Max computer parked when the plan ended), the
runner's routines wait for it, on the runner: the Mac never takes them over. At its next look at the
runners (when one of that computer's routines is more than 10 minutes overdue, one of its runner's threads
runs, or it was found down before: one call asking Orgo how it is, which never wakes it or counts as
using it), the Mac keeps what it found in the state (`RunnerState.down`: its status and when; `runner.ts`
noteDown, `runner-install.ts` lookDown), so every Bops shows why they wait: the routine's line says
"Waiting: Max's computer is stopped" (asleep, frozen, broken) in place of its next time (`lib/types.ts`
computerWait). A look that finds the computer up clears it, and its runner runs what's due, late (or, as a
missed run, at its next time when that's close, as any routine its Bops slept through). A thread the
runner was running on a computer that's down that way ends ("Stopped: its computer was stopped."), its
routine's run failed with it (Run now runs it again), so it never holds the next run; on a computer asleep
it's left to carry on when the computer wakes. The run its runner left going on a computer asleep of a
routine it no longer runs (set to run on the Mac, its result sent to a channel, its bot moved: "Stopped: its
computer was asleep, and its routine doesn't run there anymore."; the Mac looks within a minute of that
change), and every thread of a runner the Mac marks failed, end too, so none holds its routine's next run.
A run paused for the user's OK there is none of these (`lib/types.ts` pausedForOk; `sessions.ts`
endSessionsOf, `runner-install.ts` strays): nothing of it is held on the computer, so a computer asleep or
stopped is a wait for it too, the change is for the routine's runs to come, its request stays as it was, and
the routine's next run waits for it. Only a computer deleted ends it.

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
   with (`auth=identity`, `key` or `none`, the word in its auth file, else its log's last `[runner]
   auth:` line, and nothing else, as orgo-web logs a command's output), kept as
   `runners[computer].auth`. Then it's Running, and the Mac leaves that computer's routines to it.

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
an hour, every 15 minutes for one on its identity). So it does when a run there waits on an answer the user
gave, and again for each answer given since it last asked, as nothing else would notice that answer
never being read: gone, a Running runner couldn't start (so Stop ends that run, and the runner is set up
again later), and a Stopping one kept for that run is taken off with it (below). The same command says whether the computer has its
key, what its identity answers and what the runner last said it signs in with (none of it secret).
With no key, and an identity that answers anything but 200 or 403 (or a runner that says `auth: none`),
or with a key in its files and a runner that says `auth: none` (a key that isn't the computer's own, or
one Orgo turned down), and never with identity refused (403), the Mac gives the computer its key (`PUT`,
`keyMade`; Orgo writes it to `/root/.orgo-secrets.env`, read first) and starts the runner if supervisord
doesn't show it running; a runner that waits picks the key up within 30 seconds. So a runner left with no credential
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
restore, a move) gets a new token at once. And whenever its VMM hands it a token for another computer,
it's a copy, which takes its runner off and leaves without ever using that token. Orgo stamps the source
of every copy, so a token in a copy's memory stops working within seconds.

The routines Orgo keeps say the Mac runs them (`onMac`) unless a computer's runner that's Running runs
them (never a reminder or a chat run, above), and each runner going up or down sends them again, so Orgo
wakes a computer only for a runner that will run what's due, and only for a task. A run waiting on the
user's OK or a sign in changes none of it: Orgo keeps waking that computer for its routine. A runner that's up
isn't set up again while a run of its goes (nor while one is paused for the user's OK: that would wake the
computer for nothing): it's set up once the run is over (`runner-install.ts` keepUp). A one-off that
fired is off, with no next time (below), so nothing wakes a computer for it again. When a routine of a
Running runner is 10 minutes past its time and its computer is up, the Mac asks whether the runner's
program is still there (at most once an hour); gone, it's Couldn't start, and its routines are the Mac's
before their next run.

**One-offs** (a schedule of kind `once`) are turned off as they fire (`routines.ts` tick), as in v0.0.29:
one Bops runs a run start to finish, so nothing runs it twice. Run now before its time doesn't finish it.
A run of one that dies (its computer stopped, Bops restarted mid-run) shows failed, and why, and Run now
(Run again, once a run failed) runs it again. A run whose thread Bops ended as it started (it restarted
mid-run, or another Mac left the thread behind) is recorded failed on the routine at the next tick and sent
where its results go (`routines.ts` endedAtStart), so it never shows Done or "still running" for good.

**Asking the user's OK is a pause, held by OpenAI** (`lib/server/permission.ts`), the way OpenCode
(`packages/core/src/permission.ts`) and Codex (approval policy, ReviewDecision) do it. Before asking, the bot's
rules decide (`lib/permission.ts`: an action and a resource, either with `*` wildcards, the last rule that
matches wins, none asks; "Just do it" is a rule that allows everything, ahead of an ask for what could move
money or reaches someone found through business data, and the bot's own rules come last, `Bot.permissions`).
A run that reaches an action its rules don't allow (a Composio app action that changes something, an email to
someone else in `mail.ts` withOk, a key's call that changes something in `keys.ts` callApi, a dear business
data lookup in `treg.ts`) pauses there, on a runner or on a Mac: the tool throws `NeedsOk`, and the engine
running it opens a request in the state every Bops of the user's shares (`appApprovals`: `lib/types.ts`
AppApproval; its thread, bot, routine, the device that asked, `action` (what kind of thing), `resources` (to
whom or what), `preview` (exactly what will happen), and `resume`: what carries the run on). The engine sends
no output for that call and ends its turn: the Responses API engine (`computer-task.ts` pauseAt, a cloud
thread) keeps the response it paused in and the call; the Agents API engine (`sessions.ts` runTurn, a Mac
task, whose apps and data are function tools Bops answers, never an MCP server in its sandbox) leaves the
session waiting in requires_action, with the turn and the call; a chat turn (`chat.ts`) keeps the response,
the call, the other calls' outputs of that round and the turn as it was. The thread waits queued, holding no
screen and nothing in memory, so nothing keeps its computer up (no in-use beat: `free-hours.ts` inUse; no
identity look: `runner-start.ts`). Its status Waiting for your OK is the unanswered request alone
(`lib/types.ts` waitsForOk), on the thread, its row, Needs your attention and the chat.

**Only two things resolve a request**: the user's reply from one of their own Bops (the card's Allow once,
Always allow, or Deny with what to do instead: `app/api/apps/approvals`, `permission.ts` replyToAsk), or Stop
on its thread. Always allow is Claude Code's "don't ask again": it saves a rule for that bot and that action
(`lib/permission.ts`: "Send an email", "Send Email in Gmail (work)", "Call Stripe"), whoever it's for and
whatever it says, and answers that bot's other requests for it. The card says that scope under its buttons
("Always allow Max to send an email, whoever it's to and whatever it says."), and still shows who and what
each request names, as best Bops can tell from its inputs, for the user to read. A rule saved before for an
action and one resource reads as a rule for that action. A reply to a request a computer's runner made gets that computer woken until its
runner reads it (`permission.ts` wakeForAnswers, derived from the state: an answered request a runner asked
whose thread is still that runner's), from every Mac of the user's: on the answer, whenever the state loads
or changes come in, and at the look at the runners, and again later while it isn't up (asleep, it's resumed;
suspending or resuming, or Orgo not answering, it's looked at again; up, looked at again a while later). The
chat says when it can't be woken (Free's hours used up). The run goes on there. The device that asked reads the reply (a Mac from the Live stream, a
runner within seconds while it's up: `listenForAnswers`), takes the request out as it reads it, and carries
the same run on from where it paused (`sessions.ts` pickUpAnswered, run; `chat.ts` resumeChat): on a yes it
does the action and sends its result as that call's output (`function_call_output` with
`previous_response_id`, or `agent.session.input.tool_result`); on a no it sends "Declined: <what the user
said>". A restart of that device meanwhile loses nothing (`store.ts` migrate keeps a paused run queued with
its request). Stop, from any Bops, writes reject with reason "stopped", ends the run where it paused (an
Agents API session also gets `agent.session.input.cancel` from there), wakes nothing, and resumes nothing; the
Bops that asked takes the request out when it next hears. A run ended for good on another Bops's behalf (its
computer deleted, the workspace shared, its runner failed and nobody wants the computer: `sessions.ts`
endSessionOf) has its requests resolved the same way, and a resolved request of a runner that's gone, failed
or being stopped, whose thread isn't its any more, is taken out by any Bops of the user's (`permission.ts`
settleAsks), one the user had answered too, so none is left that nobody can clear. Stop on a run whose runner
failed after the user answered ends it there and then, as nothing on the computer will hear it. A Stop the Bops
that asked hears only with a state it loads (it was quit, signed out or restarting when the user answered and
then pressed Stop elsewhere) ends the run before it goes on from the answer: that Bops honors every stop asked
of it before it starts or carries on any run (`sessions.ts` pump, stopAskedHere). A thread waits only on the requests of the Bops
that runs it now (`lib/types.ts` askedByRunner). Nothing else touches a waiting run or its request:
not taking over a screen or handing it back (a waiting run holds none), not a routine edited, moved or pinned,
not a look at a runner or a stray sweep, not a merge, not a restart. A brain's tool (Claude Code holds the
call: `cli-agents.ts` approveTool, `composio.ts` held) can't pause, and waits for the reply in memory, 19
minutes at most (`resume` "held").

Only the owner's own Bops replies (a person's action). A runner may add its own bots' requests and take them
out, never write a reply: `replyToAsk` refuses on a runner, Bops Cloud refuses its write
(`cloud/computer-scope.ts`: `appApprovals.<id>`), the runner never sends it (keepAllowed), and the Mac puts it
back as it was if a Bops Cloud from before these rules let it through; nor may it write a bot's rules.
Someone the owner shared a workspace with sees the requests of the bots they were given (`cloud/ws-slice.ts`
approvals: never the reply, which device asked, or what resumes it). One with Write on the bot may answer them
from their own Bops, but never through it: their answer goes to Bops Cloud (`POST /v1/ws/<id>/act`), which checks
it and queues it for the owner's Mac, and the owner's own Bops writes the reply (`lib/server/member-acts.ts`,
`replyToAsk` with the member named). Their own Bops has none of the owner's requests. Two
copies of a request changed at once keep the reply (`state-merge.ts` mergeApproval: never back to
unanswered; two replies, the first; at once, a reject). Bops v0.0.29 never synced requests, and ignores them.

**A sign in waits too.** A task on a runner that needs a sign in waits Needs you to sign in (the screen
watch's `sign_in` blocker, and the card's way to its computer's screen, where the user signs in or takes
over); the bot's `sign_in_from_vault` there says the saved logins sign in only from Bops on the Mac, and
to wait for the user (`vault.ts` vaultSignIn). Taking control of that screen with nothing running there
is for the thread that waits there for a sign in, a code, a check or a payment (`sessions.ts` takeOver,
waitingAt): the one whose card the user came from (its Sign in, however long it's waited), or else the last
one there while it holds the screen (15 minutes), never one that only asked a question. Handing the screen
back after signing in carries that same run on, on its computer; so does the card's I signed in. A saved
login no longer keeps a task routine on the Mac. Whatever picks the thread up again on the Mac (the sign in done
there, handing the screen back, a reply, Try again) leaves it with that computer's runner while it's up
and the bot still works there (`sessions.ts` replyToSession, `runner.ts` runnerUpFor): the computer is
woken for it, and its runner runs it as soon as it hears (pickUpQueued). It never moves to the Mac in the
middle of the run.

**Move to your Mac** on a runner's thread (`sessions.ts` moveToMac) moves that run: the routine's record
follows the Mac's new thread and is the Mac's from then on (no `by`), the computer forgets it (its thread
is asked to stop, and its end is no end of the routine's run: `routines.ts` onRoutineTaskEnd,
`state-merge.ts` mergeRoutine), and that time of the routine is done when the Mac's thread ends, never due
again for the move.

**In Bops Cloud** (`cloud/auth.ts`, `cloud/server.ts`, `cloud/computer-scope.ts`; `cloud/README.md`, "A
computer's runner") a runner signed in as its computer, by its identity token or its own key, calls only
what it needs, and only for the bots that work on its computer (as the user's state says, which a
computer can't change). The Mac mirrors the bots' keys, app access and computers to orgo-web on the
user's own key, and orgo-web pins the runner's routines, Orbit, access log and Logins to exactly those
rows, so Bops Cloud keeps the runner from rewriting them:

- Its state (`GET`/`PUT /v1/state`, `GET /v1/state/head`): a write may change only its own threads
  (`Session.by` its device), its bots' routines' runs (`nextRunAt`, `lastRunAt`, `last`, `lateRun`,
  `eventsThrough`, a passed skip going, a pause), how its bots are doing on it (`computerStatus`,
  `computerRam`, `computerNeverReady`, `wakeFailed`, `tailnet`, their Composio session), when an account
  was last used, a brain's sign-in on this computer, news held about its bots, its screens' last threads,
  the usage ledger and the out-of-credit mark, and its own requests for the user's OK (added unanswered,
  taken out; never a reply, above). Anything else (a bot's keys or app access, a bot moved or
  added, a routine's job, where it delivers or a routine added or taken out, another device's threads,
  workspaces, logins, runners, numbers) is 403 `computer_not_allowed` with the paths. It never starts a
  state, never uploads a whole one, and never reads one with every message in it. The runner keeps to
  the same rules before it sends (`keepAllowed`), so it's never refused: what it may not send stays on the
  runner, said once in its log. And the Mac takes of a version a runner wrote (read right after its own)
  only what that computer may change, and writes the rest back as it was: a second guard behind Bops
  Cloud's, for a Bops Cloud from before these rules.
- Its messages (`GET`/`POST /v1/messages`): written, changed and taken out only in its bots' chats (and
  group chats one of them is in), and only those read. Only its bots' own words and Bops' notes: never
  the user's, nor another bot's (`computersMessage`).
- Its session (`POST /v1/session`): no AgentMail key (it reaches every inbox of the user's and outlives
  the computer). Its mail (a routine's email, `check_email`, `read_email`, `send_email`, `reply_email`)
  goes through `/proxy/agentmail/*`, sent on with the user's pod key, in its bots' own inboxes only.
- The models (`/proxy/openai/*` and its WebSocket), Typesafe and treg, as the Mac.
- Honcho in its bots' workspaces' memory banks only.
- Composio: the catalog, its bots' sessions (each bot's apps and accounts only, a read-only app's actions
  read-only, connecting accounts and a sandbox off), and actions in the accounts the user gave the bot
  (reading ones only where it may only read). Never connecting, deleting or linking an account, sign-in
  setups, raw API calls (`tools/execute/proxy`) or triggers.
- AgentPhone: only a text (`POST /v1/messages`) from a line its bots text the user from (a bot's own, or
  its workspace's main bot's) to one of the user's verified numbers. So a routine that texts its result
  (`deliverTo` text, `textTo`) and a bot's `text_me` work on the runner; the check of whether a text went
  through (reading the line's messages) doesn't, and is skipped.
- The user's OK is the runner's to ask, as Claude Code's harness asks it on the computer it runs on: the
  computer is trusted for its bots (it reads and writes their things and uses their accounts, and the bot's
  agent has a root shell there), so Bops Cloud doesn't check its calls against the user's answers. It holds
  only to who answers: a computer never writes a reply, its own requests' included (above), and someone the
  user shared a workspace with never answers.
- Mail handles, Slack links, numbers and lines, codes, backups, notices, usage, the iPhone's agent and
  the tunnel answer it 403.

Its device is Bops Cloud's to set from its computer id, and a write saying another device is 403. A
computer's answer is kept 30 seconds at most, never past its token's end, and its open sockets and long
answers are looked at again every 30 seconds: Orgo turning its credential down, or naming another
computer for it, closes them, a socket closes at its token's end (the runner opens another on its next
token), and an answer still coming (an agent's events) outlives its token only while that computer
keeps signing in afresh.

**Stopping one**: switching to This Mac (or the bots to browsers on the Mac), the computer deleted, or no
bot working on it any more. Its program and wrapper are taken off its computer (one asleep isn't woken
for it, and runs nothing meanwhile: the state says it's Stopping), its threads end with a plain reason
(as the Mac's, so a last save from the runner can't bring them back), and Bops takes back only what it
gave: when `keyMade`, whichever Mac stops it sends `DELETE /api/computers/{id}/orgo-key` (200 or 404 is
done), which revokes it and takes it off a computer that's up. A key the computer came with stays: it's
the computer's, and Orgo revokes it with the computer. A state from before `keyMade` with a `keyId` (the
old `bops-runner-key` route) counts as `keyMade`. It's taken out of the state once it's off its computer
and that key is revoked; until then it stays Stopping, and the next look tries again. A run there paused
for the user's OK doesn't end with it (unless the computer is deleted, someone else can use its workspace,
or its runner had failed or its program is gone from the computer, so nothing is left there to read the answer;
also once it's Stopping with such a run kept, and for a runner that failed with no key of Bops' to take back:
it ends then, its request resolved as Stop resolves it). Whether its program is still there is asked whenever
the computer is up at a look (never waking it: at most once an hour, and again for each answer the user gives
it meanwhile, the answer that wakes the computer), so one that died before the stop, or while it was kept, ends
that run once the user's answer has the computer up. Otherwise it waits on, its request untouched, as for a routine changed meanwhile, and the switch is for
the runs to come. The runner stays on its computer with its key, running nothing else, until that run is
over (the user's answer wakes the computer and carries it on to its end there, or Stop ends it); the look
within a minute of that takes it off. Switched back meanwhile, it's up again as it was.

## Not in this version

- Chat on the runner: the Mac still runs chat turns while it's open, and the iPhone's chats don't go
  through a runner.
- Events waking a computer: texts, email and Slack still wait for the Mac.
- Brains on a runner that run on the Mac (Hermes, Claude Code on the Mac).
- Bops Cloud limiting what a computer reads: its token or key still reads the user's whole Bops state
  (every bot, routine, thread and workspace, though not the other bots' chat messages nor the Preview
  passwords kept for members: cloud/computer-scope.ts forComputer), and spends their
  AI credit (the identity spec's Q4). Its writes are limited (above). OpenAI objects (another bot's agent
  sessions) are the user's, not the computer's.
- Versioned mirror PUTs (`bops_state_version`): Orgo's mirrors are last writer wins.
- A runner making new computers while the Mac is closed: the map and the runners catch up when the Mac
  opens.
- Saved logins and Telegram or Discord on a runner: their secrets are in the Mac's Keychain, so a
  routine that posts to a channel stays on the Mac, and a runner signs nothing in by itself: a sign in
  there waits for the user on the computer's screen (above).
- Reading pages in a browser on a runner: the browser that reads pages drawn by JavaScript or behind a
  "checking your browser" wall is the Mac app's hidden window, which a runner hasn't got (and its
  fetches come from a datacenter). A chat run, which reads pages, is the Mac's (above); any turn on a
  runner whose `web_fetch` meets such a page isn't read plain or guessed at (the bot is told it couldn't be
  read there), and `web_fetch`'s own description there says there's no browser.
- Chat routines and reminders on the backend: Bops Cloud can't run a turn with the bot's tools yet, so
  they're the Mac's (above), and one due while no Mac is up runs once a Mac is up, late.
- Skills on a runner: their files are synced to the Mac alone, so a routine that follows one, or whose
  bot has any published for it, stays on the Mac, and a runner leaves a computer's skills folder as the Mac copied it.
- Checking a runner's health while nothing is due: the Mac checks it when it sets it up, supervisord
  starts it again when it stops, and the Mac only asks again when one of its routines is overdue (above).

## Older apps still open

The state level is 4 (`cloud/protocol.ts`), so Bops Cloud refuses an older app the user's state once
this one wrote it. An app from before this one that's still open (another Mac of the user's, which
updates only when it quits) would keep running every routine from the copy it has in memory, the ones a
runner or this app now runs included: only apps from this version on stop their routines on that
refusal. So Bops Cloud refuses such an app the proxies too (`cloud/state.ts` behindState, 426
`state_too_new`): its runs fail instead of running a second time, and its notices say to update. It
knows such an app by the state level a call says, or, as 0.0.29's OpenAI and treg calls say none, by a
version below 0.0.30; this app says its level on every call, those included. Only users with a Mac on
this version are touched (their state is at level 4); raising `bops.app_policy.block_below` (Orgo's
`scripts/notices.sh` in OrgoAI/bops-secrets) stays for when every older app should stop. Telegram and
Discord replies an older Mac sends with its own Keychain's tokens don't go through Bops Cloud.

Such an app also still mirrors its routines to orgo-web, straight and on its Orgo key, after each run it
makes and at its start, with neither `run` nor `onMac` (it predates them). orgo-web fills those in as a
task the Mac doesn't run (`lib/routines/body.ts` defaults), so its waker would wake a bot's computer for
reminders, chat routines and routines pinned to the Mac, and keep it up, using a Free user's hours.
This app puts them back at its 10 minute look (`routine-sync.ts` mendRoutineCopies), but only while a Mac
on this version is up; orgo-web has to keep a routine's stored `run` and `on_mac` when a body doesn't
send them (release steps).

## Release steps

Before this Bops ships (identity: the identity spec's rollout, `vm-identity-spec.md` 5):

- Bops Cloud from this release and the app go out together. A build made before this release that
  already writes level 4 says an older version and no level on its OpenAI calls, so behindState takes it
  for 0.0.29 and refuses them until it updates.
- orgo-web keeps a routine's stored `run` and `on_mac` when the routines `PUT` (or POST) doesn't send
  them, as an app before 0.0.30 doesn't: `routineSchema` without defaults for those two, `toWriteRow`
  sending null, the upsert taking `COALESCE(EXCLUDED.run, r.run)` and `COALESCE(EXCLUDED.on_mac, r.on_mac)`,
  and a new row `run` 'task' and `on_mac` true (above, "Older apps still open").
- orgo-web's `bops-routine-wake` job on in each environment (`/ops/crons`, with `CRONS_EXEC=1`): it's
  off until enabled there. Without it a routine whose computer is asleep waits for it, saying so (above),
  until something else wakes the computer (the user, a task they start), Mac open or closed.

- In each environment, in this order: Bops Cloud with the computer routes and their limits deployed
  (the identity spec 4.4); then orgo-web's `VM_IDENTITY_BOPS_CLOUD_READY=1`, right after that deploy;
  then `VM_IDENTITY=admins`, and later `on`. Until the flag, orgo-web answers a profile for an identity
  token 403 `bops_cloud_not_ready`: the runner keeps the token for orgo-web and gives Bops Cloud its key
  file meanwhile, trying the token with Bops Cloud again every 10 minutes (and one with no key file can't
  reach Bops Cloud at all), so the flag must not wait for identity to be on.
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

**The runner's key sits on the computer.** orgo-web binds the computer's key to its own computer and
its bots (`api_keys.desktop_id`; held to them once its pin is enforced, `ORGO_COMPUTER_KEY_PIN=enforce`,
as the identity token always is), but it stays in `/root` until it's taken off: the bots' agents run as
root on the same computer and can be steered by the web pages they read, so a page could get a bot to
read it. Phase 1 keeps it on every Bops computer (from bops-base 0.1.9 on, whether or not a runner runs
there) as the fallback for identity. Identity is the narrow, device-bound, revocable credential this
blocker asked for, written nowhere and good for an hour; phase 2 takes the key off the computers that
run on it. Until phase 2, a key read off a computer reaches that computer, its bots' routines, Orbit and
Logins, reads the user's whole Bops state in Bops Cloud but for the Preview passwords kept for members (Q4), and
writes only what the computer may
(above).
