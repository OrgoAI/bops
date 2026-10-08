# How Bops builds on Orgo

Sources, read 2026-10-02:
- Orgo: https://docs.orgo.ai/llms-full.txt, https://docs.orgo.ai/api-reference/openapi.json (v2.0.0, 56 operations)
- OpenAI self-hosted sandboxes: https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted
- OpenAI sandbox lifecycle: https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle

Orgo's own positioning is "provides the computer, not the agent". Bops is the agent layer on top.

## 1. Mapping our model onto Orgo

| Bops concept | Orgo primitive | Notes |
|---|---|---|
| Sam's main computer | `POST /computers` with `template_ref` (our `bops-base` template) | Template = Chrome, xdotool, Codex CLI, our runner daemon, egress policy. Golden snapshot boots in seconds. With `bops_free: true` and Orgo's own `system/bops-base@…`, in the user's "bops" workspace, it's the user's one free Bops computer: off their Orgo plan, at the template's size, and `GET /billing/compute-limits` names it (`bops_free_computer_id`). |
| You log into apps once | Take over Sam's computer (noVNC embed) and sign in | Logins live on Sam's disk. |
| Bot computer cloned from Sam | `POST /computers/{samId}/clone {name}` | Full disk copy, including browser sessions. Source must be running (otherwise `400 NOT_CLONABLE`). Clone comes up `running`, auto-stop forced to always-on (re-set via `PATCH /computers/{id}/resize`). Each clone uses a computer slot. |
| 4 screens per bot | Screens API: `POST /computers/{id}/screens` | Max 4 including the boot screen: `default` (`:99`) plus `screen-100`…`screen-102`. Each is its own X server with its own cursor and window manager. Fresh screens are bare: no panel, no wallpaper. |
| Session acts on its screen | `screenshot`, `click`, `drag`, `type`, `key`, `scroll` with `?screen=<id>` | Only these 6 honor `?screen`. `bash`, `exec` and `wait` always use `DISPLAY=:99`. |
| Open apps on a screen | `POST /bash` with `DISPLAY=:100 nohup google-chrome --user-data-dir=/root/profiles/s100 … &` | Each screen needs its own Chrome profile (profile lock), seeded from Sam's logged-in profile. |
| Screens survive restarts? | No. Screens are held in memory. | Run `ensureScreens()` after every start, restart and clone. |
| Live view | `wss://www.orgo.ai/desktops/{instance_id}/ws/websockify?token={vnc_password}` (noVNC) | Default screen. Screens 2–4 (`ws_port` 6081+): add `&screen=screen-100` (orgo-web's per-screen streams, on staging only so far; closes `4012` for a screen it can't stream, `4502`/`4503` when it can't reach the computer just then). WebRTC (`/ws/rtc`) streams the default screen only and closes `4010` on `?screen=`. Bops tries it by default alongside noVNC (`BOPS_WEBRTC=0` turns it off) and keeps it only at the screen's real size: the gateway shrinks a screen bigger than its host's `ORGO_RTC_WIDTH`x`ORGO_RTC_HEIGHT` (1280x720 unless set) before `ready`, so 1280x960 needs `ORGO_RTC_HEIGHT=960` on the host. A smaller stream ends, Bops puts the screen back (`PATCH /computers/{id}/screens/default`), and that computer stays on noVNC for a day. Bops uses `?screen=` with `BOPS_SCREEN_STREAM=1`; otherwise it polls `GET /screenshot?screen=…&response_format=binary` for those screens. |
| Take over | Same noVNC embed with `viewOnly=false` | `vnc_password` = root on the computer (also opens the terminal and bash proxy). Fetch it server-side per session; never send it to the client bundle. It rotates on restart. `4008` close = 30-minute idle, so reconnect on user action. |
| Activity / idle | Events WebSocket `wss://…/ws/events` | Subscribe to `window_focus`, `window_open`, `process_start`/`process_stop`, `file_change`, `clipboard`, `idle`/`active`. Server-side clients can use `Authorization: Bearer`. |
| Free computer asleep | `status: "suspended"` (`GET /computers/{id}`), `POST /computers/{id}/resume` | Free's computer sleeps after 15 minutes without `POST /api/bops/computer/active`. Bops then reads only its status: a read of its screens can wake it, and a screenshot can come back `409 computer_asleep` (asleep, never gone). A task says it's in use as it starts; taking over resumes it. |
| Runtime secrets | Secrets vault → `/root/.env` (`POST /computers/{id}/secrets/sync`) | Use for API keys. Template `secrets` declare names only, never values. Use the `on_resume` hook to re-read after a restore. |
| VM-local automations | Template `triggers` (cron, file, http, process, metric, log, desktop) → actions (webhook, command, service, notify) | Good for watchdogs and "file landed" events that call back to Bops. Bot routines stay in our own scheduler because they change at runtime and templates are immutable. |
| Size | `ram`/`cpu` on create; cap is 4 vCPU / 64 GB / 300 GB | For 4 screens, each running Chrome, use **16–32 GB / 4 vCPU**. |
| Fleet growth | Capacity API: `GET` / `POST /account/capacity` with `Idempotency-Key` and `dry_run` | Self-serve up to +100 computers (was 30), then `403 capacity_cap`: ask support. (Checked 2026-10-04.) |
| Keys | `sk_live_` account-wide or workspace-scoped | Workspace scope alone is not a tenancy boundary. **Use the Clients API (`POST /v1/accounts`)** for each customer: a workspace plus a key that reaches only it, with `external_id`, `max_computers` and `monthly_ai_cap_usd` (set it to 0). Keep keys server-side regardless. See docs/internal/LAUNCH_RESEARCH.md. |
| Reaching services inside a VM | Authenticated proxy `https://www.orgo.ai/api/desktops/{instance_id}/proxy/<path>` | VMs have no public inbound hostname, so daemons should **dial out**. |

Not used in Bops core:
- **Orgo `POST /v1/chat/completions`.** Claude models only, no `screen` targeting, a fixed 250-step loop, no history replay, and the thread is overwritten on each call.
- **Orgo Memory guide.** It's Mem0; Bops owns memory.
- **Orgo SDKs.** Stale: no screens or clone support. Call REST directly.

## 2. Yes, OpenAI lets you bring your own environment: two ways

### A. Responses API `computer` tool: always bring-your-own
OpenAI returns `computer_call.actions[]`; we execute them against the Orgo screen and send back a screenshot (`detail: "original"`, unresized, so coordinates match). This is the **GUI path** and works today. Orgo's own guide covers it (it still names `gpt-5.6`; use `gpt-6.1-sol`).

Built: `lib/server/computer-task.ts`, the default for new cloud tasks (`BOPS_COMPUTER_TOOL=0` turns it off) (with web search, a shell through Orgo's bash, and the user's apps; no browser tools or helpers). Actions run with xdotool on the screen's display, as the screen MCP's do. Benchmarked against Option B's screen MCP on the same model and tasks (2026-10-06): same success rate on 7 everyday tasks (21/21 each), about 30% faster and 45% cheaper per task.

Action mapping:

| OpenAI action | Orgo |
|---|---|
| `click` / `double_click` | `/click` (with `double`) |
| `type` | `/type` |
| `keypress` | `/key "ctrl+c"` |
| `scroll` | `/scroll` |
| `drag` | `/drag`, first and last point of the path |
| `move` | No endpoint. Use `xdotool` via bash with `DISPLAY` set. |
| `screenshot` / `wait` | `/screenshot?screen=`, sleep |

### B. Agents API `environment: { type: "self_hosted" }`: OpenAI's managed harness, Orgo compute
- OpenAI runs the agent loop: managed Codex harness, compaction, subagents, steering, webhooks, vaults, tracing.
- We run **`codex exec-server` inside the Orgo VM**. It connects **outbound** over WSS (`api.openai.com`, `codex-cloud-environments.chatgpt.com`) using a restricted environment key (`CODEX_API_KEY`). That suits Orgo exactly, since its VMs have no inbound hostname.
- It gives the agent **shell, files and local MCP servers** in the VM.
- **Each session has its own environment ID and needs its own executor**, which maps cleanly onto one executor process per screen with `DISPLAY=:10x`.

What B can't do directly: the Agents API `computer_use` tool only runs in an **OpenAI-hosted** browser. GUI on Orgo through B requires a **local MCP server we write** ("screen MCP": screenshot, click and type on its own `DISPLAY`) running inside the executor's environment. Whether the model drives a GUI as well through MCP as through the native `computer` tool is unproven, so this is a **P0 spike**.

Other B constraints:
- US data residency only
- No ZDR
- Tools, instructions and `multi_agent` are fixed for the life of a session
- Subagents can't use function tools (they do inherit MCP)
- The API waits up to 5 minutes for an input-time connection
- Deleting a session doesn't stop compute; stop it yourself

**Provisioning modes (OpenAI lifecycle guide):**
1. **Application-managed.** Bops creates the session, ensures the Orgo screen exists, and starts `codex exec-server --remote <session.environment.remote_url> --environment-id <session.environment.id>` on it.
2. **Webhook-managed.** On `agent.session.action_required` with `required_action.type: "environment_connection"`, our handler resumes or replaces the Orgo computer/screen and starts the executor.

**Orgo is not on OpenAI's 10 listed sandbox providers** (Modal, Cloudflare, Vercel, Daytona, Blaxel, E2B, Runloop, DigitalOcean, AWS Lambda MicroVMs, OCI). The E2B entry is just a page plus two cookbook examples (application-managed and webhook-managed). Orgo could ship the same, and it would be **the only provider offering a full desktop with screens**. That's a direct BD play, and Bops is the reference implementation.

## 3. Recommended session architecture

```
Bops backend (Next.js API + workers, Supabase)
 ├─ Sam + bot brains: Agents SDK (TS), Responses API
 ├─ Decision layer: Decisions API / Luna
 ├─ Scheduler + approvals + memory
 └─ Session runners, one per screen:
     ├─ GUI session  → Responses `computer` loop (gpt-6.1-sol) → Orgo actions ?screen=
     └─ Code/shell   → Option B executor (codex exec-server on that screen, outbound)
                       or local `codex app-server` reached by the bops-runner
Orgo
 ├─ Sam computer (template bops-base) ── clone ──► bot computers
 └─ each bot computer: screens default, 100, 101, 102 + Chrome profile per screen
     + bops-runner daemon (dials out: heartbeats, Events WS relay, ensureScreens helper)
```

**Why both A and B:**
- **A** is the proven GUI path.
- **B** gives us OpenAI's managed harness for code and shell sessions without running `codex app-server` ourselves, and it makes Orgo an OpenAI sandbox provider.
- If the screen-MCP spike shows good GUI quality under B, collapse to **B only**: one harness for every screen session, with OpenAI-managed compaction, steering and approvals.

## 4. Orgo-side work (we own it)

1. **Per-screen websockify route.** Needed for live view and Take over on screens 2–4. Built (`?screen=`), on staging; once orgo.ai has it, Bops' `BOPS_SCREEN_STREAM` goes on by default.
2. **`?screen` on `bash` and `exec`.** Or set `DISPLAY` from it.
3. **Mouse move / hover endpoint.** Plus a `drag` that accepts coordinate 0.
4. **Screens surviving restart, or a template field to declare screens.** Removes `ensureScreens()`.
5. **Webhooks.** For computer lifecycle and events, not just template triggers.
6. **Template from a running computer (snapshot API).** Lets Sam's logged-in state become a template.
7. **SDK refresh.** TS and Python need screens, clone, start/stop and capacity.
8. **`orgo-vnc` 0.3.x on npm.** Only 0.2.20 is published; docs say 0.3.0+.
9. **OpenAI sandbox provider listing.** Docs page plus cookbook examples for application-managed and webhook-managed flows.
10. **Per-hour metering.** Today plans are slot-based; Bops logs per-screen minutes itself.

## 5. Gotchas

- `stop` freezes the computer (status reads `frozen`). A frozen computer can't be cloned or have screens.
- Restart and stop/start give the computer a new IP. Cloned sessions on new IPs can trigger site logouts.
- Screenshot URLs (`response_format=url`) are unauthenticated links. Use `binary` or `base64`.
- `POST /screens` with only one of width/height silently falls back to the boot size.
- Events WebSocket doesn't validate event names: a typo subscribes to nothing, silently.
- `bash` is synchronous (max 300 s). Background long jobs with `nohup … &` and poll.
- Errors carry `request_id`; include it in support reports.
