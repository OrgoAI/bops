# Bops Cloud

The server Orgo runs for hosted Bops. The Bops app on each user's Mac still does the work (bots,
screens, Mac apps, routing through the Mac); the cloud does the four things a Mac can't:

1. **Holds the keys.** Orgo's OpenAI, AgentPhone, AgentMail, Honcho, Composio, Typesafe and Twilio
   keys live here, never on a user's Mac. The Mac calls those services through the cloud with the
   user's Orgo key, and the cloud keeps each user inside their own things (their numbers, their
   inboxes, their memory, their OpenAI objects).
2. **Serves every user at once**, with each user's data in Postgres (the `bops` schema in orgo-web's
   database; see db/README.md).
3. **Takes the webhooks** (texts, calls, Bops' Slack app's events) for everyone at one public
   address and passes each one to the right user's Mac over that Mac's tunnel, and serves the few
   public pages connecting an app needs. This replaces the Fly relay (edge/) and the tailnet hop.
4. **Decides who owns each phone line, and answers calls when the Mac is away** (asleep, off,
   offline): the owner's bot takes a note, anyone else gets a bot that only takes a message, and the
   Mac hears about it when it's back. Who the owner is comes from `bops.phone_lines` (the first phone
   to call or text a new number in its 15 minutes), never from the app's state.

Self-hosters don't need any of this: with `BOPS_SELF_HOSTED=1` and their own keys in `.env.local`,
the app calls every service directly, as before.

## Running it

```bash
node cloud/server.ts        # Node 24+, which runs TypeScript directly
```

Plain TypeScript that Node runs as is: erasable syntax only (no enums, namespaces or parameter
properties), relative imports with `.ts` extensions, no `@/` aliases, nothing from Next.js and no
`server-only`. Dependencies: `pg` and `ws` (from the repo root `package.json`) and Node's own
modules. Type-check with `npx tsc -p cloud/tsconfig.json`. Tests: `node --test cloud/test/`.

It listens on 127.0.0.1 (`BOPS_CLOUD_PORT`, default 8790) behind a TLS proxy (Caddy) at
`BOPS_CLOUD_PUBLIC_URL` (at Orgo: `https://bops.orgo.ai/api`; Caddy strips the `/api`, so the routes
here are `/v1/…`, `/proxy/…`, `/hooks/…`). Every public address the cloud hands out (webhook URLs,
pages) is made from `BOPS_CLOUD_PUBLIC_URL`. At start it applies `db/migrations/*.sql` that haven't run.

Settings (`cloud/config.ts`): `BOPS_DATABASE_URL`, `BOPS_CLOUD_SECRET` (32+ random bytes, base64;
seals the secrets the cloud keeps), `BOPS_CLOUD_PUBLIC_URL`, `BOPS_ORGO_ORIGIN`, the provider keys
(`OPENAI_API_KEY`, `OPENAI_EXECUTOR_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `OPENAI_SIP_URI`,
`AGENTPHONE_API_KEY`, `AGENTMAIL_API_KEY`, `HONCHO_API_KEY`, `COMPOSIO_API_KEY`, `TYPESAFE_API_KEY`,
`TWILIO_*`), and `BOPS_UPSTREAM_*` to point a provider at a fake server in tests. Calls:
`BOPS_PHONE_MODEL` (the model for a call's turns, default `gpt-6.1-sol`), and `BOPS_SIP_TRUNKS=1`
to make each user's SIP trunk to `OPENAI_SIP_URI` again (off: the GPT-Live path is dormant). For Bops' own Slack
app: `BOPS_SLACK_APP_ID` (public; at Orgo `A0C6UNXT54J`, the "Bops" app) and
`BOPS_SLACK_SIGNING_SECRET` (secret: checks its events). `BOPS_COMPOSIO_AUTH_CONFIGS` (optional,
comma-separated auth config ids): Orgo's own sign-in setups Macs may use besides Composio's own,
such as the Slack app's (see "Slack"). `BOPS_AI_CREDITS=1` (Orgo's cloud only): each use is paid from
the user's AI credit, and calls that spend are refused once it's used up (see "AI credit").

## Who's calling

Every request from a Mac carries `Authorization: Bearer <the user's Orgo API key>`, the key the app
got from "Sign in with Orgo". The cloud asks Orgo whose it is (`GET /api/user/profile`) and keeps
the answer for 5 minutes by the key's SHA-256 (`cloud/auth.ts`). It never stores the key.

Webhooks are public and proven by the provider's signature instead.

## Endpoints

| | Path | Who | What |
|---|---|---|---|
| | `GET /health` | anyone | database reachable, how many Macs are connected |
| 1 | `POST /v1/session` | Mac | set the user up on first contact, answer a `CloudSession` (`protocol.ts`) |
| 1 | `GET/PUT /v1/state` | Mac | the app's state as a backup, and for the cloud to answer calls |
| 2 | `/proxy/openai/*` | Mac | OpenAI, HTTP + streaming + WebSocket (the call sideband) |
| 2 | `/proxy/agentphone/*` | Mac | AgentPhone, always in the user's own sub-account |
| 2 | `/proxy/honcho/*` | Mac | Honcho, only the user's own workspaces |
| 2 | `/proxy/composio/*` | Mac | Composio, only as the user's own Composio user |
| 2 | `/proxy/typesafe/*` | Mac | Typesafe |
| 2 | `POST /v1/verify/start`, `/check` | Mac | texted and emailed codes (Twilio Verify) |
| 4 | `GET/PUT /v1/phone/lines`, `POST /v1/phone/lines/unlink`, `POST /v1/phone/owners/remove` | Mac | the user's lines and whose phone each is linked to |
| 3 | `PUT /v1/slack/links` | Mac | where the user's bots are in Slack, for routing the Slack app's events |
| 3 | `GET /v1/connect` (WebSocket) | Mac | the tunnel |
| 3,4 | `POST /hooks/agentphone` | AgentPhone | texts and call turns for any user's number |
| 3,4 | `POST /hooks/openai` | OpenAI | incoming GPT-Live calls over a SIP trunk (dormant) |
| 3 | `POST /hooks/slack` | Slack | events from Bops' Slack app, for any user's bots |
| 3 | `GET /connected` | anyone | the page people land on after connecting an app |
| 3 | `GET /oauth/callback` | anyone | Orgo's own OAuth apps send people back here; 302 on to Composio |
| 3 | `GET /mascot/*.png\|jpg`, `/brand/*.png` | anyone | the bots' pictures (Slack's `icon_url`) and the Bops logo |

### POST /v1/session

Idempotent, safe to call at every app start; two at once for one user must not make two of anything
(take a row lock on the account first). On first contact for a user:

- **AgentMail:** a pod with `client_id` `bops-<userId>` (find it if it exists), then a key scoped to
  that pod (`POST /v0/pods/{pod_id}/api-keys`), made once: AgentMail shows a key only when it's made,
  so it's sealed (`crypto.ts`) in `bops.cloud_accounts` and the same one is handed back every time.
  The Mac uses AgentMail directly with it (REST and the WebSocket mail comes in on). AgentMail itself
  keeps that key inside the pod, and it has mail permissions only (inboxes, messages, drafts,
  labels): no keys, pods, domains, webhooks, apps or account changes.
- **AgentPhone:** a sub-account named `bops-<userId>` (found by name first, else
  `POST /v1/sub-accounts`). The Mac points each number's calls at its agent
  (`PATCH /v1/numbers/{id}/voice-routing {method: "agent"}` through the proxy, agent in voice mode
  "webhook"). Only with `BOPS_SIP_TRUNKS=1` and `OPENAI_SIP_URI` set: a SIP trunk in it that sends
  calls to OpenAI (made, then its destination set with `PATCH`, as AgentPhone ignores it on create),
  best effort (AgentPhone answers 403 for a sub-account without SIP).
- **Honcho:** `workspacePrefix` = `u-<userId>`, with anything in the user id other than letters and
  digits written as `_` and its UTF-8 bytes in hex (`a.b` → `u-a_2eb`; Honcho ids allow letters,
  digits, `-` and `_`). No two users' prefixes are the same and none has a `-` in it, so
  `<prefix>-…` can only be that user's. The Mac names its workspaces `<prefix>-bops` and
  `<prefix>-bops-<workspace>`.
- **Composio:** the user's Composio user id is `bops-<userId>`.
- **OpenAI:** `executorKey` is `OPENAI_EXECUTOR_API_KEY`: a restricted, spend-capped key, because
  Bops copies it onto bot computers, where the user has root. Never the main key.
- **Slack:** `{appId}` when the cloud takes Bops' Slack app's events (`BOPS_SLACK_APP_ID`,
  `BOPS_SLACK_SIGNING_SECRET` and Composio all set), else null. The app then gets its Slack messages
  from the tunnel, never from Composio's triggers.

A service whose key the cloud doesn't have comes back `null`, and the app shows that feature as off.
A provider that fails during setup makes the call answer 502; what was made is kept, and the next
call finishes the rest.

### The proxies

The Mac points each SDK at `<cloud>/proxy/<provider>` with the Orgo key as its API key. The cloud
drops the caller's `authorization` (and any provider auth header), adds its own, and passes the rest
through: method, path, query, body, streaming responses unbuffered (SSE as it comes, one event at a
time), and WebSocket upgrades. Only a short list of the Mac's headers goes on (content type,
idempotency, SDK telemetry, `OpenAI-Beta`); hop-by-hop headers, cookies and anything that picks an
account or project are dropped. Bodies up to 25 MB.

Deny by default: each provider has the list of routes the app uses (`proxy.ts`), and anything else
is 403. Paths are taken as written (no percent-encoding, no `.`, `..` or empty segments), and the
query and a JSON body are re-encoded after they're checked, so the provider reads what was checked
(keys are matched in any spelling: `user_id`, `userId`, `USER-ID`). An answer or event that makes an
object is held only until its owner is recorded. Two SDK details: the Honcho SDK drops any path in
its baseURL, so the cloud also answers Honcho at `/v3/*`; and the Composio SDK sends its key as
`x-api-key`, so the Mac adds `Authorization: Bearer <Orgo key>` to it (`defaultHeaders`).

What keeps users apart, per service:

- **AgentPhone:** every request gets `X-Sub-Account-Id: <the user's sub-account>`, whatever the Mac
  sent. A sub-account only sees its own numbers, agents and messages, so that is the whole wall.
  Two things are caught on the way:
  - Webhook registration (`POST /v1/agents/{id}/webhook`, and any other route that sets a webhook
    URL): the URL is replaced with `<publicUrl>/hooks/agentphone`; the `secret` in AgentPhone's
    answer is sealed into `bops.cloud_agents` for that agent and user, and the Mac gets
    `"secret": "kept-by-cloud"` instead. Only agent webhooks: the sub-account's own webhook
    (`/v1/webhooks`) is refused, as it would have nowhere to keep its secret.
  - Numbers: any answer that lists or makes numbers (`phoneNumber` + `id`) is recorded in
    `bops.cloud_numbers` (last 10 digits → user), so a call to that number finds its user. US and
    Canadian (+1) numbers only: another country's number with the same last 10 digits could
    otherwise take over someone's. A number bought (`POST /v1/numbers`) or attached to an agent is
    also one of the user's lines (`bops.phone_lines`, below); a bought one opens its 15 minutes.

  Only the routes `lib/server/phone.ts` uses: no sub-accounts, registration, account webhooks, trunk
  changes or calls out. A trunk comes back as its id and name only (its credentials place calls on
  Orgo's account; its destination is Orgo's OpenAI project).
- **Honcho:** the path's workspace id (`/v3/workspaces/{id}/…`) must be the user's prefix or start
  with it and a `-`; `POST /v3/workspaces` (get-or-create) must name one in its body; any
  `workspace_id` in a body or query must be one too; `POST /v3/workspaces/list` is answered with only
  the user's own (filtered after the call). Anything else: 403.
- **Composio:** every user id the request names (`user_id`, `userId`, `entity_id`, in the query or
  a JSON body) must be the user's own, and one is added where the SDK leaves it out. Objects reached
  by id (connected accounts, sessions) must be ones the cloud saw made for this user
  (`bops.cloud_objects`). List the SDK calls `lib/server/composio.ts` and `channels.ts` make and
  allow exactly those routes (the catalog, sign-in setup, connected accounts with several per app,
  sessions, direct actions and Composio's proxy to an app, tool and trigger info, Slack triggers).
  Calls that act in an account must name one of the user's. Shared accounts, saved session configs,
  custom credentials and a trigger's events sent elsewhere are refused; tool arguments, a proxied
  call's body and a trigger's settings aren't read (a Slack tool's `user_id` is Slack's).
  - **Sign-in setups** (auth configs) serve the whole project: one made with someone's own OAuth
    app, credentials or proxy could catch or break other users' sign-ins. So a Mac may make only
    Composio's own (`use_composio_managed_auth`, a toolkit and a name), or, for an app Composio has
    no sign-in of its own for (the cloud asks Composio), `use_custom_auth` with `credentials: {}`
    and a non-OAuth scheme (`API_KEY`, `BEARER_TOKEN`, `BASIC`…), where each person types their own
    key at sign-in: it holds nobody's secret, and it can't take the place of Composio's own sign-in
    for anyone. Those are recorded in `bops.cloud_objects` (kind `auth_config`), and any
    user may use them. `GET auth_configs` lists only the usable ones: Composio's own
    (`is_composio_managed`), the ones made through the cloud, and the ones pinned in
    `BOPS_COMPOSIO_AUTH_CONFIGS` (Orgo's own OAuth apps, such as the Slack app's); anything else in
    the project (made in Composio's dashboard for something else) isn't offered. Each comes back
    without its credentials, proxy or shared credentials. Connecting an account
    (`connected_accounts/link`, `connected_accounts`) must name one of those, and so must a
    session's `auth_configs` (Composio's own is checked with Composio, once per setup).
  - **Connected accounts** come back with their secrets masked where they are (OAuth access,
    refresh and ID tokens, secrets, passwords, and anything named a key or a key's id: API, access,
    secret, consumer and service account keys, in any spelling), in lists, reads and new
    connections: Composio uses them, the Mac never needs them. The account's own name stays (an
    email, a workspace); where only an ID token said who it is, the app asks the app itself through
    Composio's proxy instead (`whoIs`).
  - The SDK's live trigger delivery (`triggers.subscribe`, `api/v3/internal/sdk/realtime/*`: a
    Pusher channel carrying the whole project's events) is never passed through. Bops' own Slack
    app's events come through `/hooks/slack` instead (below). To deliver other triggers, the cloud
    would take Composio's project webhook (at a `/hooks/composio`, signature checked) and send each
    event to the Mac of the user whose connected account it's for (`metadata.user_id`, checked in
    `bops.cloud_objects`); triggers stay off for hosted users until then.
- **OpenAI:** one project for everyone, so the cloud tracks ownership itself: every object id the
  user makes (`resp_…`, Agents API sessions with their turns and helpers, live sessions) is recorded
  in `bops.cloud_objects` as the answer passes (JSON body, or the SSE event that carries it). A request
  whose path names an object id is allowed only if that id is the user's; an id the cloud never saw
  is refused (404). Live call sessions are recorded by `/hooks/openai` when it hands a call to the
  Mac (and the in-app call's by `POST /v1/live/sessions`). List the endpoints Bops uses
  (`lib/server/{chat,sessions,call,phone,memory,watches}.ts`) and allow exactly those; everything
  else is 403. Ids in a body count too: `previous_response_id` and conversations must be the user's,
  and references to stored files, vector stores, containers, items, reasoning, prompts, agents or
  vaults aren't passed at all. Token use (`usage` in an answer, in `response.completed`, or an
  Agents API turn's) goes to `bops.cloud_usage`, and so do a sideband call's seconds.
- **Typesafe:** only `POST /v1/systemone`; counted.

### AI credit

What a user's bots do with AI (model answers and tasks, calls, numbers, texts, Typesafe, texted
codes) is paid from their AI credit, at what it costs Orgo: $1 of credit is $1 of what OpenAI,
AgentPhone, Twilio or Typesafe charge (`pricing.ts`, in micro-dollars; 1 cent = 10,000). The plans
(`BOPS_TIERS` in `protocol.ts`): Free gets $5 once, at the first use of Bops; Pro ($20 a month) gets
$20 and Max ($200 a month) $200 each month it's paid for, with nothing carried over. Every plan has
its one free Bops computer; AI credit is the only difference.

- **Where it lives:** orgo-web's database, `public.bops_ai_credit` (the balance) and
  `public.bops_ai_credit_grants` (each grant), made by orgo-web's `20261022_bops_plans.sql` with
  three functions that do the math, and the one grant `bops_app` has outside its schema
  (db/README.md). orgo-web adds the plan's credit when Stripe says an invoice is paid; the cloud
  reads the balance and takes each use (`credit.ts`).
- **Taking it:** every row `usage.ts` writes has its cost (`cloud_usage.cost_micros`), and the same
  transaction takes that much (`bops_ai_credit_spend`): this month's plan credit first, then the
  rest, which may go below 0 when a turn already under way overruns (the next grant covers it). A
  row seen more than once (an agent turn, a call's seconds) is priced again each time and only the
  difference is taken. An agent turn is priced at its session's model (kept in
  `cloud_objects.model` when the session is made); a model with no price, or none known, at the
  dearest one's, and logged. Texts are counted by segment as they go out (`POST v1/messages`) and as
  they come in (`/hooks/agentphone`, once per delivery). Counting never holds up or fails a call.
- **The gate:** a proxy route that spends (OpenAI's `POST v1/responses`, `v1/live/sessions` and its
  `accept`, `v1/agents/sessions` and its `events`; AgentPhone's `POST v1/numbers` and
  `v1/messages`; Typesafe) is answered 402 `{error, code: "ai_credit_empty", upgrade: true}`
  (`AI_CREDIT_EMPTY`) when the user has nothing left, before anything is sent on; a number needs
  its month's price left (an iMessage line's is $150 or $250). The balance is read every time, so an
  upgrade counts at once. Reads, hanging up and turning a call away are never refused, nor are
  texted codes (setting up the account; they're still paid for) or webhooks. A call the cloud would
  answer is turned away (`reject` 402) instead. Nothing is cut off mid-turn or mid-call.
- **The $5:** the first `POST /v1/session` (or the gate, whichever is first) asks for the balance,
  which gives it, once per user ever.
- **Off** unless `BOPS_AI_CREDITS=1`: a self-hosted or local cloud still prices each row, but takes
  nothing and refuses nothing. On, the cloud checks at start that it can use the two tables and
  functions, and won't start without them.
- Not taken yet (still stopped at $0, since the turn that starts them is): in-app voice calls (the
  audio goes from the browser to OpenAI), numbers' monthly renewals after the first, AgentPhone's
  voice-agent minutes, web searches, Honcho, Composio and AgentMail.

### Codes (Twilio Verify)

`POST /v1/verify/start {to, channel}` and `POST /v1/verify/check {to, code}` (an `@` in `to` makes
it an email), with the limits the app had (5 an hour per user and recipient, 8 per recipient from
anyone, 12 per user, 30 an hour for the whole cloud, 15 checks an hour, 30 s between texts and 60 s
between emails), counted in `bops.cloud_limits` so every cloud process shares them. While a user has
a code out for a recipient (10 minutes), nobody else can start or check one for it. SMS to US and
Canada numbers only; email only with `BOPS_VERIFY_EMAIL=1`. Answers `VerifyResult`, or
`VerifyErrorBody` with Twilio's error code and `retryAfter` (the app's `lib/server/verify.ts` maps
those to what it shows). When a code checks out for a phone, the cloud records it in
`bops.owner_phones` (one verified owner per number across all users; a number another user already
verified is refused, before a text is sent and again at the check), and an address in
`bops.owner_emails`.

### The tunnel

`GET /v1/connect` upgrades to a WebSocket (Orgo key as Bearer). One per user: a newer one replaces
the older (which gets `{"t":"replaced"}` and close code 4000). Frames are JSON (`CloudToMac`,
`MacToCloud` in `protocol.ts`).

- `req` → the Mac replays it against its own server (`http://127.0.0.1:<port><path>`), adding
  `x-bops-cloud: <token>` (`CLOUD_TUNNEL_HEADER`; the token never leaves that Mac process) after
  dropping any copy in the frame, and answers `res` with the same id. The cloud waits up to the
  caller's timeout.
- `event` → something that waited (`bops.cloud_pending`, oldest first). The Mac handles it and
  answers `ack`; only then is it marked delivered. Unacked events are sent again on the next connect.
  At most hourly, as new events come in, the cloud clears out what no Mac will take: events past
  their `expires_at` that nobody took (even for a Mac that never comes back), and delivered ones
  after a week. Texts and calls have no `expires_at`: they wait however long it takes.
- `ping` every 25 s; a Mac that doesn't `pong` for 60 s is dropped.

### Webhooks

- `POST /hooks/agentphone`: signature = HMAC-SHA256 of `"{timestamp}.{raw body}"` in
  `X-Webhook-Signature` as `sha256=<hex>`, timestamp in `X-Webhook-Timestamp`, at most 5 minutes
  old. The secret is the one sealed for the event's agent (`bops.cloud_agents`), which also says
  whose it is. Then:
  - Who sent a text, tapback or call turn is decided first (`lines.ts`, below; a call or a
    one-to-one text may claim a line in its 15 minutes) and goes with the delivery:
    `x-bops-caller: {"owner":true|false,"claimed"?:"call"|"text"}` on a replay, `bopsCaller` in a
    kept one. The Mac follows it.
  - A text or tapback, Mac connected: replay as `POST /api/phone/agentphone` with the raw body and
    the webhook headers, wait up to 25 s, and answer AgentPhone with the Mac's answer. Mac away: it's
    kept for the Mac (`agentphone`, deduped by `X-Webhook-Id`) and AgentPhone gets 200 `{}`.
  - A call's turn (`agent.message` on channel `voice`): replayed the same way; a 2xx from the Mac
    within 15 s is what gets spoken, otherwise the cloud answers it (below). An answer ready within
    1.5 s goes back as JSON (`{"text", "hangup"?}`); a slower one as NDJSON
    (`application/x-ndjson`): `{"text":"Mm-hm, one sec.","interim":true}` at once, then the answer.
  - `agent.call_ended` ends a call the cloud was answering (and is replayed to the Mac, which ends its own).
- `POST /hooks/openai`: Standard Webhooks signature (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`, secret `OPENAI_WEBHOOK_SECRET`). For `live.transport.incoming`, find the user
  from the numbers in the SIP headers (`To` first) via `bops.cloud_numbers`, record the live session
  as theirs (`bops.cloud_objects`), then:
  - Mac connected: replay as `POST /api/phone/openai` (raw body, headers, and `x-bops-caller` as
    above) and wait up to 4 s for a 2xx. The Mac accepts the call through `/proxy/openai` and runs it
    over the sideband as before.
  - Mac away, or no 2xx in time: the cloud answers the owner's call (below) and turns anyone
    else's away before it connects (`reject` with 403), as the app does: no bot, no message.
  Always answer OpenAI 200 quickly; other event types are logged and answered 200.
- `POST /hooks/slack`: Bops' Slack app's events (see "Slack" below).

### Phone lines and who owns them

`bops.phone_lines` (`db/migrations/0006_phone_lines.sql`, `lines.ts`): one row per number (its last
10 digits), with the user, AgentPhone's number id, the bot or workspace it's for, and its owner
(`owner_number`, `claimed_at`, `claimed_via` `call`|`text`|`sms_code`) or, while it has none, until
when it can be claimed (`claim_until`).

- **First caller claims it:** a bought number gets 15 minutes. The first phone to call it, or text
  it one-to-one (not a group, not STOP/START/HELP), becomes its owner by one conditional
  `UPDATE … WHERE owner_number IS NULL AND now() < claim_until`, so only one can win. The number goes
  into `bops.owner_phones` for that user in the same transaction: one claimed by another Bops
  account (its unique index), or another Bops number, never wins.
- **Every delivery:** the caller is the owner when it's the line's `owner_number` or one of the
  user's numbers in `bops.owner_phones` (verified by code, or claimed on another of their lines).
  Never from the app's state.
- **The app:** `PUT /v1/phone/lines {numberId, botId?, workspaceId?, open?}` after it gets or
  assigns a number (it must be in the user's `bops.cloud_numbers`; `open` gives a line with no owner
  a fresh 15 minutes, one already running keeps its own), and once at each start for every line.
  `GET /v1/phone/lines` lists them (`PhoneLine` in `protocol.ts`). `POST /v1/phone/lines/unlink
  {numberId}` clears the owner and opens a fresh 15 minutes (the number leaves `owner_phones` unless
  another line has it). `POST /v1/phone/owners/remove {number}` drops one of the user's numbers
  everywhere (Settings, Remove).
- A number verified by texted code becomes the owner of the user's lines that have none. The
  migration backfills lines from `bops.cloud_numbers`, with no window open, and links the user's
  newest code-verified number.

### Answering a call's turns in the cloud

`voice.ts`, when the Mac doesn't answer a turn. From the user's last state upload: the bot whose
number it is (by the agent), its name, and (for the owner) the owner's name, the apps the bot may use
and where it's in Slack, Telegram and Discord. Each turn is one Responses call (`BOPS_PHONE_MODEL`,
low reasoning) with two tools, each carrying the words to say: `take_message({name, text,
callback, say})` and `end_call({say})`. Its tokens are counted (`openai.tokens`, source `phone`).

- The owner hears that the computer is offline and gets their note taken; a first call that claimed
  the line is told so.
- Anyone else gets a bot told nothing about the person it works for, that chats and takes a message.
- The call (grouped by AgentPhone's `callId`) ends on `end_call`, on `agent.call_ended`, after
  2 minutes without a turn, or at 10 minutes. Then a `call` event is kept for the Mac
  (`CloudCallPayload`: `owner`, `claimed`, `message`, the transcript) and `call.minutes` is counted.

### Answering a GPT-Live call in the cloud (dormant)

For a number routed to a SIP trunk (only with `BOPS_SIP_TRUNKS=1`). Bots take these calls only from
their owner (`incomingCall` in `lib/server/phone.ts`). From the user's last state upload: the bot
whose number was called (the same lookup as `calledBot`; no bot has it: `reject` 404); whether the
caller (From, else P-Asserted-Identity) is the owner comes from `lines.ts`. Anyone else is turned
away before the call connects (`reject` 403): nothing is said, nothing is kept and nobody is texted.

The owner's call is accepted, in the voice the app picked and kept for the bot (`bot.voice`), with
short instructions: you are <bot>, on a call with <owner>; the computer you work on is offline, so
you can't do tasks until it's back; what you can do then (the owner's apps the bot may use, each
account with read only or read & act, written as the app writes them, and where it's in Slack,
Telegram and Discord); that it's answering from Bops Cloud, where texts wait for the computer (and
Slack messages for a day), that Telegram keeps its messages a day and that Discord messages sent
meanwhile are missed (the Mac's Discord connection starts afresh), so anything to send it is a note
on this call or a text; be brief, take a note of anything they want done, then say goodbye.
Tools: `take_message({name, text, callback})` and `end_call()`. Over the sideband: answer the tool
calls, keep the transcript, hang up after `end_call` or 10 minutes. Then keep a `call` event for the
Mac (`CloudCallPayload`, `owner: true`), which turns it into a message in that bot's chat ("While
your Mac was away, you called: …").

### Slack

Bops' own Slack app (`slack/manifest.json`; at Orgo the "Bops" app, `A0C6UNXT54J`, which several
users in one workspace share for now) sends every workspace's events to one address,
`<public>/hooks/slack` (`slack/setup.mjs events` with `BOPS_PUBLIC_URL` set to the cloud's public
address). People connect it as a Composio Slack account (the `slackbot` toolkit) through Orgo's own
auth config for the app, with its redirect at `<public>/oauth/callback`, pinned in
`BOPS_COMPOSIO_AUTH_CONFIGS`.

Workspaces are kept apart (Slack itself names each account's workspace), but users who share one
workspace are not kept apart there, which is accepted for now: the cloud takes each Mac's word for
its channels, direct message and paired people, and anyone connected to the shared app can call
Slack's API with its bot token through Composio's proxy. Keeping them apart would take a check with
Slack before honoring a claim, and in the end a separate install (bot token) per user.

- `POST /hooks/slack`: Slack's v0 signature (HMAC-SHA256 of `"v0:{timestamp}:{raw body}"` with
  `BOPS_SLACK_SIGNING_SECRET`, as `v0=<hex>` in `X-Slack-Signature`, at most 5 minutes off, compared
  in constant time). `url_verification` is answered here. Everything else gets 200 at once and is
  handled after: Slack wants an answer within 3 seconds and turns an app's events off when most of
  an hour's deliveries fail, so a Mac being away is never a failure (never a 503; 404 only when the
  secret isn't set). An event is taken once per `event_id` (Slack sends it again when it didn't hear
  back). Only what the app acts on goes on: people's messages and mentions, not bots' own posts,
  edits, deletions or joins.
- **Who an event is for** comes from `bops.slack_links`, never from the workspace alone, and only
  within the event's own workspace (its `team_id`, or the installation's in `authorizations`, which
  differ only for a channel shared between workspaces): a channel message goes to the users with a
  bot in that channel; a direct message to the user it's with (`dm`), or from someone their bots
  are paired with (`owners`: they may have paired in a channel, so the Mac doesn't know that direct
  message yet); a direct message nobody has yet to the users whose bots wait for their pairing code
  (`pairing`), whose Macs check the code.
- Each of them: Mac connected, replay as `POST /api/channels/slack/events` (the raw body, Slack's
  headers) and wait up to 5 s for a 2xx; otherwise keep it (`slack`, deduped by `event_id`) for a
  day. Past that it's dropped (on the next connect, or when the cloud clears out old events), not
  answered late.
- `PUT /v1/slack/links` (Mac): `SlackLinksBody` in `protocol.ts`, every Slack account each time (one
  left out is forgotten). Each account must be the user's own (`bops.cloud_objects`). Its workspace
  and the app's bot user there come only from Slack: the cloud runs `auth.test` through that account
  itself (Composio's proxy, its own key) the first time it sees it, and keeps the answer (an account
  never changes workspace). Only the channels, the direct message, the paired people and pairing
  come from the Mac, and they count only within that workspace. Answers `SlackLinksResult`.

### Public pages

What Bops' front door (`edge/server.mjs`) served, now here, with nothing of any user's in them:

- `GET /connected?app=<name>&status=…`: where people land after connecting an app (the app's
  `callbackUrl` is `<public>/connected`). Every value from the address is escaped; the page's
  pictures are relative (`brand/bops-512.png`), so they stay under the public path's `/api`; a
  content security policy lets only its own style and script run.
- `GET /oauth/callback`: a 302 to `https://backend.composio.dev/api/v3/toolkits/auth/callback` with
  the query as it came. The query carries the sign-in's code: it's never logged.
- `GET /mascot/<name>.png|jpg` and `/brand/<name>.png`: fixed files in `cloud/public` (copied from
  `edge/public`), names of letters, digits and `-` only, `image/png` or `image/jpeg`. Slack shows
  them as each bot's `icon_url`.

## Data

`db/migrations/0004_cloud.sql`: `cloud_accounts`, `cloud_agents`, `cloud_numbers`, `cloud_objects`,
`cloud_pending`, `cloud_usage`, `cloud_limits`, next to `app_state` (the state backups) and
`owner_phones`/`owner_emails` from before. `0005_slack_links.sql`: `slack_links` (who gets each
Slack event) and `cloud_pending.expires_at` (what may wait only so long). `0006_phone_lines.sql`:
`phone_lines` (who owns each number). `0007_ai_credit.sql`: `cloud_usage.cost_micros` (what each use
cost Orgo) and `cloud_objects.model` (an agent session's model). The AI credit itself is orgo-web's
(see "AI credit").

## Code layout

| File | What |
|---|---|
| `server.ts` | puts the routes together, HTTP + upgrades, start and stop |
| `config.ts`, `http.ts`, `auth.ts`, `crypto.ts`, `db.ts` | shared pieces |
| `protocol.ts` | what the cloud and the app say to each other (both import it) |
| `session.ts`, `proxy.ts`, `verify.ts`, `usage.ts` | 1 and 2: setup, the proxies, codes, metering |
| `pricing.ts`, `credit.ts` | what each use costs, and the AI credit it's paid from (the gate) |
| `tunnel.ts`, `hooks.ts`, `slack.ts`, `state.ts` | 3: the tunnel, webhooks, Slack, state |
| `lines.ts`, `voice.ts`, `calls.ts` | 4: who owns each line, a call's turns answered here, GPT-Live calls (dormant) |
| `pages.ts`, `public/` | the public pages and pictures (`/connected`, `/oauth/callback`, `/mascot`, `/brand`) |
| `test/` | `node --test`, fake upstreams on localhost, a throwaway Postgres schema |

## The app's side

`lib/server/cloud.ts` and friends (see the comments there): when the app is signed in with Orgo and
not self-hosted, every service call goes through the cloud, the tunnel stays open while the app
runs, and the state is uploaded (debounced) after it changes. For Slack in cloud mode the app
takes `CloudSession.slack` as its own Slack app being set up, accepts the replayed
`/api/channels/slack/events` from its tunnel (and handles a waiting `slack` event the same way),
and never subscribes to Composio's triggers. It sends its Slack links to `PUT /v1/slack/links`
whenever its channels, pairing or paired people change: `owners` are the Slack user ids its bots
are paired with, and it records a direct message's channel as `dm` only when the message is from
one of them or carries the right pairing code, never a stranger's. It matches a Slack event to its
links by the envelope's `team_id` or any `authorizations[].team_id`, as the cloud does (`teamsOf`
in `slack.ts`), so a message in a channel shared with another workspace isn't dropped. Telegram and
Discord stay on the Mac (their tokens are in its Keychain).

For calls, the app answers each turn the cloud replays (`lib/server/phone-voice.ts`, as JSON: the
cloud speaks the filler) and follows `x-bops-caller` for who's calling or texting, never its own
list. It routes each number's calls to its agent when it makes or assigns one, puts back any that
isn't at each start, tells the cloud each line's bot (`PUT /v1/phone/lines`), and shows whose phone
a line is linked to (`lib/server/phone-lines.ts`, `components/app/line-link.tsx`).
