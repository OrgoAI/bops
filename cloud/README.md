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
`server-only`. Dependencies: `pg`, `ws` and `posthog-node` (from the repo root `package.json`) and Node's own
modules. Type-check with `npx tsc -p cloud/tsconfig.json`. Tests: `node --test cloud/test/`.

It listens on 127.0.0.1 (`BOPS_CLOUD_PORT`, default 8790) behind a TLS proxy (Caddy) at
`BOPS_CLOUD_PUBLIC_URL` (at Orgo: `https://bops.orgo.ai/api`; Caddy strips the `/api`, so the routes
here are `/v1/…`, `/proxy/…`, `/hooks/…`). Every public address the cloud hands out (webhook URLs,
pages) is made from `BOPS_CLOUD_PUBLIC_URL`. At start it applies `db/migrations/*.sql` that haven't run.

Settings (`cloud/config.ts`): `BOPS_DATABASE_URL`, `BOPS_CLOUD_SECRET` (32+ random bytes, base64;
seals the secrets the cloud keeps), `BOPS_CLOUD_PUBLIC_URL`, `BOPS_ORGO_ORIGIN`, the provider keys
(`OPENAI_API_KEY`, `OPENAI_EXECUTOR_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `OPENAI_SIP_URI`,
`AGENTPHONE_API_KEY`, `AGENTMAIL_API_KEY`, `HONCHO_API_KEY`, `COMPOSIO_API_KEY`, `TYPESAFE_API_KEY`,
`TREG_TOKEN` (an org-scoped token of Orgo's treg team), `TWILIO_*`), and `BOPS_UPSTREAM_*` to point a
provider at a fake server in tests. Calls:
`BOPS_PHONE_MODEL` (the model for a call's turns, default `gpt-6.1-sol`), and `BOPS_SIP_TRUNKS=1`
to make each user's SIP trunk to `OPENAI_SIP_URI` again (off: the GPT-Live path is dormant). For Bops' own Slack
app: `BOPS_SLACK_APP_ID` (public; at Orgo `A0C6UNXT54J`, the "Bops" app) and
`BOPS_SLACK_SIGNING_SECRET` (secret: checks its events). `BOPS_COMPOSIO_AUTH_CONFIGS` (optional,
comma-separated auth config ids): Orgo's own sign-in setups Macs may use besides Composio's own,
such as the Slack app's (see "Slack"). `BOPS_AI_CREDITS=1` (Orgo's cloud only): each use is paid from
the user's AI credit, and calls that spend are refused once it's used up (see "AI credit").
Plans (see "Plans"): `BOPS_CLOUD_PLAN_SECRET` (secret, 32+ random bytes, the same one as orgo-web's:
checks orgo-web's plan notices; unset, they're refused and plans are read at each session start only),
`BOPS_PLAN_LIMITS=1` (off by default: phone numbers and emails as each plan includes, Free none, Pro 1, Max 5)
and `BOPS_PHONE_AREA` (the area code a plan's number is bought in, 415 unless set).
`BOPS_TELEMETRY=1` (Orgo's cloud only): usage events to Orgo's PostHog (see "Usage events").

## Who's calling

Every request from a Mac carries `Authorization: Bearer <the user's Orgo API key>`, the key the app
got from "Sign in with Orgo". The cloud asks Orgo whose it is (`GET /api/user/profile`) and keeps
the answer for 5 minutes by the key's SHA-256 (`cloud/auth.ts`). It never stores the key.

### Which app

Every request from the app (0.0.18 on) also says its version, `x-bops-version: 0.0.18`
(`lib/server/app-version.ts`; apps before it say nothing). The cloud keeps the latest with the user's
account, `bops.cloud_accounts.app_version` (NULL: an app that didn't say) and `app_seen_at`
(`cloud/app-version.ts`). With `bops.app_policy.block_below` set (`scripts/internal/notices.sh block
0.0.18`; read every minute, no deploy), an app older than that, or one that doesn't say, is answered
426 (`app_update_required`, with a line telling the user to update) on every call and socket but its
state's (`/v1/state`, `/v1/messages`), which still go through so nothing it holds is lost.

### Notices

What Orgo tells users (`cloud/notices.ts`): rows in `bops.notices` (a title, a few lines, a link if
any, from when until when, and optionally only for apps older than a version). The app (0.0.19 on)
asks `GET /v1/notices` at launch and every 15 minutes and shows each one once as a pop-up, until the
user puts it away (`POST /v1/notices/dismiss { id }`, kept in `bops.notice_dismissals`, so it stays away
on all their Macs). Posted, listed and ended with `scripts/internal/notices.sh`.

Webhooks are public and proven by the provider's signature instead.

## Endpoints

| | Path | Who | What |
|---|---|---|---|
| | `GET /health` | anyone | database reachable, how many Macs are connected |
| 1 | `POST /v1/session` | Mac | set the user up on first contact, answer a `CloudSession` (`protocol.ts`) |
| 1 | `GET/PUT /v1/state`, `GET /v1/state/head`, `GET/POST /v1/messages`, `POST /v1/state/backups` | Mac | the app's state, kept here per user (see "The app's state") and read to answer calls |
| 2 | `/proxy/openai/*` | Mac | OpenAI, HTTP + streaming + WebSocket (the call sideband) |
| 2 | `/proxy/agentphone/*` | Mac | AgentPhone, always in the user's own sub-account |
| 2 | `/proxy/honcho/*` | Mac | Honcho, only the user's own workspaces |
| 2 | `/proxy/composio/*` | Mac | Composio, only as the user's own Composio user |
| 2 | `/proxy/typesafe/*` | Mac | Typesafe |
| 2 | `/proxy/treg/call/<endpoint-id>` | Mac | treg: one catalog endpoint per call, tagged with the user and bot |
| 2 | `POST /v1/verify/start`, `/check` | Mac | texted and emailed codes (Twilio Verify) |
| 4 | `GET/PUT /v1/phone/lines`, `POST /v1/phone/lines/unlink`, `POST /v1/phone/owners/remove` | Mac | the user's lines and whose phone each is linked to |
| 1 | `GET /v1/mail/handle`, `GET /v1/mail/handles`, `POST /v1/mail/handle` | Mac | each workspace's part of its bots' addresses (see "Mail handles") |
| 1 | `POST /v1/internal/plan-changed` | orgo-web | a user's Bops plan changed (signed; see "Plans") |
| 1 | `GET /v1/internal/ops/handles` | orgo-web | each user's bot number and email, for the staff page /ops/bops (signed; see "Plans") |
| 1 | `GET /v1/usage?from=&to=&tz=` | Mac | the user's metered use in a range, by kind, day and bot (`CloudUsage`; see "What's counted") |
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
  vaults aren't passed at all. What it used goes to `bops.cloud_usage` (see "What's counted").
- **Typesafe:** only `POST /v1/systemone`; each answer's tokens counted.
- **treg:** only `GET`/`POST call/<endpoint-id>`, for an endpoint the cloud finds in treg's open catalog
  (`/catalog/endpoints/<id>`, kept an hour) as data, routed or a free helper, on treg's own keys and not
  a long-running job, with its own method. Never a team's own tools (`call/<tool>/<path>`, a URL), a hub
  tool, an endpoint that needs an account connected to treg (those would be Orgo's team's), or anything
  about Orgo's treg team (balance, keys, members, budgets). The cloud sets `X-Treg-Meta:
  customer=<user>, bot=<bot>` itself (the Mac's is dropped) and `X-Treg-Route-Max-Cost`: what the Mac
  asked (`x-treg-route-max-cost`, $0.10 when it doesn't say), at most $5 and what's left of the user's
  credit. `x-treg-route-exclude` (providers a routed endpoint skips) goes on when it's a plain list.
  treg's own refusals (`X-Treg-Error: 1`) about Orgo's balance or limits never reach the Mac (they name
  Orgo's balance and a top-up link): the Mac gets 503 `treg_unavailable`, and the cloud logs it. One
  about the call's own cap (`route_max_cost`) or its input goes on. The Mac reads the open catalog
  (search, an endpoint's details) from treg directly.

### What's counted

Every paid use passes through the cloud, so the cloud counts it, once, at its real price
(`pricing.ts`, each price one named constant with its source), for its user, bot and kind of work
(`usage.ts`). A use seen more than once (an agent turn, a web search, a call's seconds) is one row
per `ref`, keeping the largest count, so sightings never count twice however far apart they are.
The Mac says which bot and kind of work each call is for (`x-bops-bot`, `x-bops-source`: read here,
never sent on; a kind of work only from the Mac's own list, `chat`, `session`, `memory`, `call`,
`decide`, so it can never name the cloud's `agent` and dodge long-context rates); an agent session
keeps the bot it was made for (`cloud_objects.bot_id`).

| Kind | What | Price |
|---|---|---|
| `openai.tokens` | each response (by its id: an answer and its stream event are one), each agent turn (by its id, at the turn's own count: a helper's turn is its own), each turn of a call the cloud answers | the model's input, cached, cache-write and output rates; long-context rates for one response past 272K input, never for an agent turn (many requests summed) |
| `openai.web_search` | each web search call an agent made (by its item id), from the session's stream or its items; units 1 for a search, 0 for opening a page or finding in one | $10 per 1K searches; opening a page or finding in one, nothing |
| `openai.live_seconds` | a GPT-Live call's audio seconds: in the app (the cloud listens on the session's sideband with its own key, as audio never passes through it), or over SIP (the bridge, or a call the cloud answers) | $0.05 a minute, plus the SIP leg over SIP |
| `agentphone.voice_seconds` | every call through a number's voice agent (by its callId), whoever answers its turns, a paused number's too | 13 cents a minute, by the second (the bot's words are its own tokens) |
| `agentphone.numbers`, `agentphone.sms` | a number bought; a text in or out, by segment | AgentPhone's |
| `typesafe.tokens` | each Jev answer: its input tokens (estimated from the question's size when Typesafe doesn't say), read to the end even when the Mac stopped waiting | $0.042 per 1M input tokens |
| `composio.calls` | each tool run (an action, a session's tool, an app's own API, and the cloud's own Slack `auth.test`), by tool, app and bot | `COMPOSIO_CALL`, $0 while it's negotiated |
| `treg.calls` | each treg call (by its `X-Treg-Call-Id`, whatever its status), by endpoint, the provider that served it, and bot | what treg charged (`X-Treg-Cost-Micro`): the provider's own rate; misses on per-success endpoints, failed calls and replays are $0 |
| `honcho.calls` | each memory question, search and messages saved (not a list of them) | `HONCHO_CALL`, $0 until it's set |
| `verify.sms`, `verify.email` | a code sent | Twilio's |

A model answer the Mac stops waiting for, whole or streamed, is still read to the end and counted
(OpenAI bills it). Rows from before this count stay as they were: `typesafe.calls` (a Jev call) and
`call.minutes` (a call the cloud answered); the account page shows them as quick checks and calls.
Agent turns are also read back by the cloud itself (`reconcile.ts`): every session that got work,
a few minutes after its last input, again while a turn still runs (up to 6 hours), and once more a
day later, with the cloud's key (its turns' tokens, its and its helpers' web searches). So a turn
the Mac never saw finish (the app quit, the Mac slept, a helper ran on) is still counted, and a
count OpenAI revises later is counted up.

Tasks on the user's Mac are agent turns like any other: the Agents API runs them through the cloud
and `codex exec-server` (with the executor key) runs their tools in a Chrome of the bot's own on the
Mac, so they're counted here and paid from AI credit. Bops never signs anyone in to Codex or runs
any work on their own ChatGPT account.

`GET /v1/usage` sums the user's rows in a range by kind (and, for tokens, by kind of work), by day
in their time zone and by bot: the account page shows it, so what it says is what AI credit paid
for, and each way of cutting it adds up to the same total.

### AI credit

What a user's bots do with AI (model answers and tasks, calls, numbers, texts, Typesafe, texted
codes) is paid from their AI credit, at what it costs Orgo: $1 of credit is $1 of what OpenAI,
AgentPhone, Twilio or Typesafe charge (`pricing.ts`, in micro-dollars; 1 cent = 10,000). The plans
(`BOPS_TIERS` in `protocol.ts`): Free gets $5 once, at the first use of Bops; Pro ($20 a month) gets
$20 and Max ($200 a month) $200 each month it's paid for, with nothing carried over. Every plan has
its one free Bops computer; Pro and Max also bring the main bot a number and an inbox (see "Plans").

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
  `v1/messages`; Typesafe; treg's calls, which are also capped at what's left) is answered 402 `{error, code: "ai_credit_empty", upgrade: true}`
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
- Counted but at $0 for now: Composio and Honcho (one named price each in `pricing.ts`). Not
  counted yet: numbers' monthly renewals after the first, and AgentMail.

### Plans

What a Bops plan brings, kept in step here (`plans.ts`, `provision.ts`). orgo-web owns the plan
(`profiles.bops_tier`, written by its Stripe webhook), which `bops_app` can't read, so it's told and asked:

- **Told:** orgo-web's webhook sends `POST /v1/internal/plan-changed {userId, tier, at}` each time it
  writes a user's tier, signed with `BOPS_CLOUD_PLAN_SECRET`: HMAC-SHA256 of `"{timestamp}.{raw body}"`
  as `sha256=<hex>` in `x-bops-signature`, the Unix timestamp in `x-bops-timestamp`, at most 5 minutes
  off (else 401; 404 with no secret set). Best effort on its side, and sent again on the plan's next
  Stripe event, so the route is idempotent: kept in `bops.plans` only when `at` is newer than what's
  kept (an older notice never undoes a newer one), and answered at once (`{ok, applied}`); the work
  runs after.
- **Shown to staff:** orgo-web's `/ops/bops` asks `GET /v1/internal/ops/handles` (`ops.ts`), signed the
  same way with `"{timestamp}.GET /v1/internal/ops/handles"` in place of the body (404 with no secret
  set). It answers each user's number (`phone_lines`) and email (`mail_inboxes`, plus the inboxes the
  Mac made itself, read from the app's state), one each, with how many they have, and the counts:
  users, with a number, with an email, both, neither. Released ones count for nothing; paused and
  broken ones count, and are counted again on their own. Read only.
- **Asked:** at each `POST /v1/session`, after answering, the cloud asks orgo-web's
  `GET /api/bops/plan` with the user's own Orgo key (the time kept is when it asked), so a notice
  that never came is made up for the next time the app opens. With plan limits on, the number gate
  asks too (with the caller's key) when the cloud thinks the user is on Free.

Then the user's things are made to match (one run per user at a time, with a lock in Postgres, and
at most 3 users' runs at once, since each lock holds a pool connection; on a repeat with nothing new,
at most once a minute):

- **Pro or Max:** the main bot of the default workspace (`ws_main`, from the last state upload; none
  yet: it waits for the next upload) gets, unless it has one of its own already:
  - **A number**, bought in the user's sub-account the way the app's `ensurePhone` does it (tag
    `bops-<install>-<bot>`, found again before anything is bought, so a setup cut short never buys a
    second): an agent in voice mode `webhook` whose webhook is the cloud (secret sealed in
    `cloud_agents`), the number on it, its calls routed to the agent, its line in `phone_lines`
    (`plan`). Its 15 minutes for the first caller open only when the app shows the user the number
    (the `plan` event, then `PUT /v1/phone/lines` with `open`), never while the Mac may be closed and
    nobody is watching: a stranger texting a new number then would become its owner. Included: counted
    (`agentphone.plan_numbers`), not taken from the AI credit. While the plan has a number for the
    main bot (or is getting one), the app's own purchase with the main bot's tag is refused (409
    `plan_number`), so the bot never ends up with two.
  - **An inbox**, `<bot>@<handle>.bops.bot` on the default workspace's handle (claimed from the
    suggestion when it has none, `auto`), with the client id the app would use, so the two never make
    two; in `mail_inboxes`.
  - Each is `setting_up`, then `ready` only once read back (AgentPhone: the number on the agent, its
    calls to the agent, the webhook the cloud's; AgentMail: the inbox there), else `broken` with the
    `problem` (the next run tries again: a session start, a notice, or the hourly sweep). The Mac is told (a `plan` event, `CloudPlanPayload`) and takes
    them into its state as if it had made them (`lib/server/cloud-plan.ts`).
- **Free:** the plan's number and inbox are `paused`: `/hooks/agentphone` answers nothing on the
  number (a call hears that it's paused and ends; texts aren't kept or counted), a text out from it
  through the proxy is refused (402 `plan_required`), and the Mac stops reading and sending from the
  inbox (the Mac holds the pod's key, so that one is the app's to keep). Upgrading again picks them up
  as they were. Still paused after 30 days (an hourly sweep, each under the user's lock so an upgrade
  at that moment keeps it): given back (`DELETE` at AgentPhone and AgentMail), `released`, and the Mac
  is told. One that can't be given back (the provider fails, or isn't set up here) stays paused.
- **Limits** (`BOPS_PLAN_LIMITS=1`, off by default so nothing changes until plans are switched on):
  each plan's phone numbers and emails are `BOPS_TIERS` (`protocol.ts`): Free none, Pro 1 (the main
  bot's, from the plan), Max up to 5 (the main bot's from the plan, then only when the user asks).
  `POST /proxy/agentphone/v1/numbers` while the user already holds as many numbers as the plan
  includes (their lines in `bops.phone_lines` not given back) is answered 402 before anything is
  bought: on Free `{code: "plan_required", upgrade: true, upgradeTo: "pro_bops"}` ("Free doesn't
  include a phone number. Pro includes 1, and Max up to 5."), on Pro the same with `upgradeTo:
  "max_bops"` ("Pro includes 1 phone number. Max includes up to 5."), on Max `{code: "plan_limit"}`
  ("Max includes up to 5 phone numbers, and you have 5."). When the cloud's plan leaves no room,
  orgo-web is asked first, so a plan just bought counts. `CloudSession.plan` tells the app the tier,
  and the app holds each plan to its emails (`lib/server/mail.ts`: the Mac makes inboxes in its own
  AgentMail pod) and shows why instead of "Get a number" or "Get an email".

### Mail handles

Each workspace's part of its bots' addresses (`tiger` in `boppy@tiger.bops.bot`), claimed once across
every user in `bops.mail_handles` (`handles.ts`); before, every user's first workspace was "Main" and
every first bot Boppy, so all wanted `boppy@main.bops.bot`.

- The default workspace takes the user's own handle: their Orgo name, else their email's part before
  the @. Any other workspace takes its own name. Slugified: 3 to 30 lowercase letters, digits and
  dashes, starting and ending with a letter or digit, one dash at a time. Reserved: `www`, `mail`,
  `api`, `admin`, `support`, `main` (and `main-2`…), `bops`, `orgo`, `team`, `help` and a few more.
  Taken or reserved: a number goes on the end (`tiger`, `tiger2`, `tiger3`).
- Claimed by one `INSERT … ON CONFLICT DO NOTHING` on the handle's primary key: of two users at once,
  one gets it. One current row per (user, workspace) (a partial unique index).
- `GET /v1/mail/handle?workspace=<id>&try=<handle>[&name=<workspace name>]` answers
  `MailHandleCheck`: `available`, `taken`, `invalid` (with the `problem` in words) or `yours`, always
  with a free `suggestion`, and the workspace's handle now. `POST /v1/mail/handle {workspaceId,
  handle?, workspaceName?}` claims it (no `handle`: the suggestion, `auto`, which the app calls
  "Choose later"), or changes it: at most 3 times (429 `handle_changes_used`); the old handle stays the
  user's (`retired_at`), since mail to the old addresses still arrives, and they can go back to it.
  409 `handle_taken` and 400 `handle_invalid` carry a `suggestion`. `GET /v1/mail/handles` lists them.
- The session hands them over (`CloudSession.agentmail.handle`, the default workspace's, and
  `handles`). The app asks the user the first time a workspace gets email ("Pick your Bops address",
  `components/app/mail-address.tsx`), keeps a workspace's slug from before handles when it can, and
  never moves an inbox made before handles. Self-hosting keeps the old way.

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
  (`CloudCallPayload`: `owner`, `claimed`, `message`, the transcript). Its seconds are counted by
  `/hooks/agentphone` for every call (`agentphone.voice_seconds`), whoever answered it.

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

## The app's state

The Mac app keeps no state of its own: signed in, its state is the user's here, and signing in on
another account shows only that account's (`state.ts`, `lib/server/persist-cloud.ts`). It's two
parts: every chat message is a row of `chat_messages` (`json` null: removed, kept 30 days so the
user's other Macs hear of it, then swept hourly), and the rest is one blob in `app_state.state`.

- `GET /v1/state`: `{ version, seq, protocol, writer, state }`, the blob without messages; 404 (with
  `version` and `seq`) when there's none yet. `GET /v1/state/head`: `{ version, seq, writer }`.
- `PUT /v1/state` `{ base, state }`: written only over `base` (0 makes the first); the new
  `{ version }`, or 409 `state_conflict` with what's there now, for the Mac to merge
  (`lib/server/state-merge.ts`) and write again. `version` is the cloud's count.
- `GET /v1/messages?after=<seq>&limit=<n>`: what changed after a seq, oldest first (`after=0`: the
  live ones), `{ messages: [{ id, seq, json }], seq, more }`. `POST /v1/messages`
  `{ upsert, remove }` in one transaction, `{ seq }`. 256 KB a message, 20 MB a batch.
- `POST /v1/state/backups`: a copy of the whole state, messages in, before "Start over".

Every call names its user (`X-Bops-User`, which must be the key's: else 409 `wrong_user`), the
protocol (`X-Bops-Protocol: 2`) and the Mac (`X-Bops-Device`). After a write the user's connected Mac
gets a `state` frame and reads what changed; the others look at the head every 30 seconds. Builds
from before still `PUT /v1/state { version, state }` their whole state as a backup (its messages
become rows) and `GET` it back with the messages in, until a newer build writes for the user
(`protocol` 2): then the old upload is refused (426).

## Usage events

With `BOPS_TELEMETRY=1` (`analytics.ts`), the cloud sends Orgo's PostHog project (the one orgo.ai
uses, at `https://us.i.posthog.com`) what only it knows: a new Bops user (`bops_signup_completed`), a
plan change (`bops_plan_changed`), AI credit running out (`bops_ai_credit_ran_out`), a phone number
or a mail address set up (`bops_phone_number_added`, `bops_email_address_claimed`), an owner contact
verified (`bops_owner_contact_verified`), and unexpected 500s on a signed-in user's call
(`$exception`: the error's type and where in Bops' code, never its message; a public route's stay in
the log). Each event is the Orgo user id (the person orgo.ai identifies) plus enums and counts, and
every one, with its properties, is listed in `cloud/analytics-rules.ts`, which drops anything else
before it leaves. Never message, mail or call content, names, numbers or addresses.

Nothing is sent for a user whose state has `analyticsOff` (Settings → You → Share usage data; read
from `app_state` and kept 10 minutes, forgotten at each state upload), or for anything a call marked
`x-bops-telemetry: off` does (an app whose Mac sends none: `BOPS_TELEMETRY=0`, `DO_NOT_TRACK=1`, a
development build). Events the cloud sees on its own, outside any call from the app (AI credit
running out from a text, a call or reconcile; a plan notice from orgo-web; a number the plan set up),
carry no such header: only `analyticsOff` stops them. A send PostHog can't take is dropped with one
log line every 10 minutes at most. `BOPS_UPSTREAM_POSTHOG` points it at a fake server in tests. Events are flushed on
SIGTERM, before the server closes.

## Data

`db/migrations/0004_cloud.sql`: `cloud_accounts`, `cloud_agents`, `cloud_numbers`, `cloud_objects`,
`cloud_pending`, `cloud_usage`, `cloud_limits`, next to `app_state` (each user's state) and
`owner_phones`/`owner_emails` from before. `0005_slack_links.sql`: `slack_links` (who gets each
Slack event) and `cloud_pending.expires_at` (what may wait only so long). `0006_phone_lines.sql`:
`phone_lines` (who owns each number). `0007_ai_credit.sql`: `cloud_usage.cost_micros` (what each use
cost Orgo) and `cloud_objects.model` (an agent session's model). The AI credit itself is orgo-web's
(see "AI credit"). `0008_plans.sql`: `plans` (each user's tier as orgo-web last said), the status of
each line (`phone_lines.status`, `checked_at`, `problem`, `plan`, `agent_id`, `paused_at`),
`mail_inboxes` (a plan's inboxes, the same statuses) and `mail_handles` (see "Mail handles").
`0009_usage.sql`: `cloud_objects.bot_id`, `used_at`, `checked_at`, `settled_at` (an agent session's
bot, and when its turns were last read back) and an index to find a use by its `ref` (see "What's counted").
`0010_chat_messages.sql`: `chat_messages` (each chat message its own row, moved out of the state
blobs), `app_state.protocol` and `app_state.writer` (see "The app's state").

## Code layout

| File | What |
|---|---|
| `server.ts` | puts the routes together, HTTP + upgrades, start and stop |
| `config.ts`, `http.ts`, `auth.ts`, `crypto.ts`, `db.ts` | shared pieces |
| `protocol.ts` | what the cloud and the app say to each other (both import it) |
| `session.ts`, `proxy.ts`, `verify.ts`, `usage.ts`, `reconcile.ts` | 1 and 2: setup, the proxies, codes, metering, agent turns read back |
| `pricing.ts`, `credit.ts` | what each use costs, and the AI credit it's paid from (the gate) |
| `plans.ts`, `provision.ts`, `handles.ts` | each user's plan and what it brings the main bot (a number, an inbox), and each workspace's mail handle |
| `ops.ts` | each user's bot number and email for Orgo's staff page (signed, read only) |
| `tunnel.ts`, `hooks.ts`, `slack.ts`, `state.ts` | 3: the tunnel, webhooks, Slack, state |
| `lines.ts`, `voice.ts`, `calls.ts` | 4: who owns each line, a call's turns answered here, GPT-Live calls (dormant) |
| `pages.ts`, `public/` | the public pages and pictures (`/connected`, `/oauth/callback`, `/mascot`, `/brand`) |
| `test/` | `node --test`, fake upstreams on localhost, a throwaway Postgres schema |

## The app's side

`lib/server/cloud.ts` and friends (see the comments there): when the app is signed in with Orgo and
not self-hosted, every service call goes through the cloud, the tunnel stays open while the app
runs, and the app's state lives here (`lib/server/persist-cloud.ts`, see "The app's state"). For Slack in cloud mode the app
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

For plans, the app takes a `plan` event into its state as if it had made the number and inbox itself
(`lib/server/cloud-plan.ts`; paused ones are shown as paused, and a paused inbox isn't read), makes
new inboxes on the workspace's claimed handle (`lib/server/mail.ts`), and asks for the handle the
first time a workspace gets email, or offers to change one Bops picked (`components/app/mail-address.tsx`).
