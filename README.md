<p align="center">
  <img src="docs/images/logo.png" width="96" height="96" alt="Bops">
</p>

<h1 align="center">Bops</h1>

<p align="center">
  <b>A team of AI bots that runs your business ops.</b><br>
  Each bot has its own computer, email and phone number, and remembers everything.
</p>

<p align="center">
  <a href="https://bops.bot/download/Bops.dmg"><b>Download for Mac</b></a> ·
  <a href="https://bops.bot">bops.bot</a> ·
  <a href="#self-host-it">Self-host</a> ·
  <a href="LICENSE">FSL-1.1-ALv2</a>
</p>

<p align="center">
  <img src="docs/images/app.png" alt="Bops: Boppy's chat on the left, and its computer on the right building a lead list on four screens at once" width="100%">
</p>

## Bop it. Text it. Call it.

Bops is a Mac app. You chat with your bots like teammates, and they do the work on their own cloud computers: inbox, pipeline, invoices, reports. Text them from your phone, call them and talk live, email them a task, or add them to Slack, Telegram and Discord. Wherever you reach them, they know who you are and what they did yesterday.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/screen.png" alt="One of Boppy's screens up close, with Watch and Take control">
      <p><b>Its own computer, four screens.</b> A bot works on up to four things at once. Watch any screen live, take control, then hand it back.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/approve.png" alt="Penny asking before paying an invoice">
      <p><b>Asks before it acts.</b> Reading runs at once. Sending, paying and deleting wait for your OK.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/vault.png" alt="The Vault: connected apps, several accounts each, and which bots use them">
      <p><b>Your apps, your rules.</b> About 1,000 apps through Composio, several accounts each. Every bot gets only the access you give it.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/slack.png" alt="Otto answering a request sent from Slack">
      <p><b>Wherever you work.</b> Ask in Slack, by text, by email or on a call. The answer comes back the same way.</p>
    </td>
  </tr>
</table>

## What it does

- **A team per workspace.** A main bot (Boppy by default) runs the team and hands work to specialists you add. Bots talk to each other, keep threads, and report back in the chat.
- **Each bot has its own computer.** An [Orgo](https://orgo.ai) cloud computer with four screens. You can watch any screen live and take over.
- **Your Mac, when you say so.** Bots can work in your Mac's apps through Codex computer use, with your rules for which apps they may use.
- **Long-term memory** (Honcho): what you tell your bots, they remember, per workspace.
- **Your apps** (Composio): Gmail, Calendar, Slack, Notion, HubSpot and about 1,000 more, several accounts each. Reading runs at once; sending, creating or paying asks you first.
- **Email:** every bot has its own inbox (AgentMail). Mail you send a bot starts a task, and the answer comes back by email.
- **Texts and calls:** each workspace's main bot has a phone number (AgentPhone). Text it like a person (tapbacks, threads, reminders by text), or call it and talk to it live (GPT-Live over SIP).
- **Slack, Telegram and Discord:** add a bot like a teammate, and it answers where you asked.
- **Calls in the app:** talk to any bot by voice, and it can start tasks while you talk.
- **Routines and watches:** scheduled tasks and reminders, and screens a bot keeps an eye on for you.

Coming soon: WhatsApp, and a real phone per bot.

## Get Bops

- **Hosted (easiest):** [download the Mac app](https://bops.bot/download/Bops.dmg) and sign in with Orgo. Every service is run for you; no keys on your Mac. Free to start, with Pro and Max plans for more AI credit.
- **Self-hosted:** free under the license. Bring your own keys and run everything yourself: see below.

Requires macOS on Apple silicon.

## How it works

```
Bops.app (Electron) ── loads ──► Bops server (Next.js, port 3210, on your Mac)
                                   ├─ chat, threads, routines, watches (state in .data/)
                                   ├─ OpenAI: chat, agent runs, GPT-Live calls
                                   ├─ Orgo: bots' computers (CDP and screens over Tailscale, or Orgo's API)
                                   ├─ Codex + cua-driver: work on your Mac
                                   ├─ Honcho (memory), Composio (apps), AgentMail (email), AgentPhone (texts, calls)
                                   └─ public webhooks ◄── edge/ (a small relay, e.g. on Fly) ◄── AgentPhone, OpenAI
```

Everything runs on your Mac except the bots' computers and the providers. `edge/` is optional: it gives the webhooks for texts and calls a public HTTPS address and forwards them to your Mac over Tailscale.

## Requirements

- macOS on Apple Silicon, Node 22 or newer.
- **Required:** an OpenAI API key and an Orgo account.
- **Recommended:** Typesafe (small judgment calls), Honcho (memory), Composio (apps), AgentMail (email), Tailscale (direct live view of the bots' screens).
- **Optional:** AgentPhone plus a public URL for texts and calls (see `edge/`).
- **For "Your Mac":** the Codex CLI signed in with ChatGPT (with computer use), and `cua-driver` (default `~/.local/bin/cua-driver`). macOS asks for Screen Recording and Accessibility.

## Self-host it

```bash
npm install
cp .env.example .env.local   # fill in at least OPENAI_API_KEY (and ORGO_API_KEY to skip signing in)
npm run app                  # opens Bops.app, which starts the server on port 3210
```

Or run the server alone with `npx next dev --port 3210` and open http://localhost:3210.

The app opens on **Sign in with Orgo**: approve the code on orgo.ai, and Bops runs on your Orgo account. Self-hosters with `BOPS_SELF_HOSTED=1` and `ORGO_API_KEY` skip this.

Then open **Settings → You** and add your name and a line about yourself: every bot uses it.

The app is designed for hosted Bops, where every service is run for the user, so Settings shows only what's theirs to set. Signed in with Orgo, the app reaches every service through Bops Cloud (`cloud/README.md`) on the user's Orgo key, so no provider keys sit on the Mac. `BOPS_SELF_HOSTED=1` (on in `.env.example`) calls each service directly with the keys in `.env.local` instead, and adds a Self-hosting section: network, email domain, phone service and computer ids.

### The bots' computers

Bot computers launch from an Orgo template built from this repo: `node orgo/bops-base.mjs publish`. Set `BOPS_ORGO_TEMPLATE` to your build's ref if the default isn't in your account. Bops keeps its computers in one Orgo workspace (the signed-in user's workspace named "bops", or `BOPS_ORGO_WORKSPACE` when self-hosting on `ORGO_API_KEY`) and never creates or deletes computers outside it.

### Texts and calls (optional)

1. Deploy `edge/` (see `edge/fly.toml`): it needs a Tailscale login and `BOPS_UPSTREAM` (your Mac's tailnet address, port 3210).
2. Point AgentPhone's webhook and your OpenAI project's webhook (`live.transport.incoming`) at it: `/hooks/agentphone` and `/hooks/openai`.
3. Set the `AGENTPHONE_*`, `BOPS_AGENTPHONE_HOOK_URL` and `OPENAI_WEBHOOK_SECRET` settings, then add your mobile in **Settings → How your bots reach you**.

US texting needs an A2P 10DLC registration for your brand.

## Releasing the Mac app

```bash
scripts/release.sh          # or: npm run app:release
```

It fetches the `orgo-relay` agent (`scripts/fetch-relay.sh`, into `vendor/orgo-relay/`), builds the server (`next build`, `output: "standalone"`), and makes `dist-desktop/Bops-<version>-arm64.dmg` and `.zip` (Apple silicon). The app carries the server in `Contents/Resources/server` and runs it with its own Node (no Node or source folder needed on the user's Mac); its state lives in `~/Library/Application Support/Bops/server/.data` and its log in `~/Library/Logs/Bops/server.log`. The relay agent ships as `Contents/Resources/bin/orgo-relay`. No `.env` file goes into the app; settings for one Mac can go in `~/Library/Application Support/Bops/.env.local`. Before finishing, the script starts the bundled server once as a fresh install would, with no keys and an empty home folder (port 3299), and checks that the page and the app's state answer. The bundled server listens on 127.0.0.1 only: bot computers' app calls and phone webhooks, which come over the tailnet, don't reach it unless that `.env.local` says `BOPS_LISTEN_ALL=1` (then `proxy.ts` lets other addresses reach only those paths). While it's loopback only, Orgo threads get no app tools.

What a release needs:

- **A Developer ID Application certificate** of the Apple Developer team, in the keychain, or as `CSC_LINK` (path or base64 of the .p12) plus `CSC_KEY_PASSWORD`; `CSC_NAME` picks one when there are several. An "Apple Development" certificate is not enough: only Developer ID apps run on other Macs outside the App Store.
- **Notarization**, so Gatekeeper opens the app without a warning. electron-builder notarizes after signing when it finds, preferably, an App Store Connect API key: `APPLE_API_KEY` (path to the .p8), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; or an Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Without a Developer ID certificate the script says so and builds unsigned, for testing on this Mac only (macOS also forgets Screen Recording and Microphone grants between unsigned builds).

The app is signed with the hardened runtime and only two entitlements (`build/entitlements.mac.plist`): JIT, which Electron needs, and the microphone, for calls. Screen Recording and Accessibility have no entitlement: the user allows them in System Settings. Every binary inside, the relay included, is signed with the app.

Why not the Mac App Store: its sandbox would stop Bops from running its own server and the relay, starting Codex and Chrome for the bots, and driving other apps for computer use.

`npm run app:build` (and `app:install`) still make a development app that runs `next dev` from this folder, unsigned (`-c.mac.identity=null`, so electron-builder doesn't pick whatever Apple Development certificate is in the keychain). The release script pins signing to the Developer ID certificate and fails if anything else signed the app.

## Project layout

| Path | What's there |
|---|---|
| `app/` | Next.js routes: the UI and `app/api/*` |
| `components/app/` | The app's UI; `components/message-ui/` is the iMessage-style chat kit |
| `lib/server/` | Everything server-side: chat engine, sessions, providers, state (`store.ts`) |
| `lib/types.ts` | The app state's shape |
| `desktop/` | The Electron shell |
| `vm/` | What runs on the bots' computers (screen MCP, browser helpers) |
| `orgo/` | The Orgo template builder |
| `edge/` | The public webhook relay |
| `docs/` | Notes on the Orgo API |

## Security

- The Bops server trusts requests from your Mac. Don't expose port 3210 to the internet; only the two webhook paths go public, through `edge/`, and they're signature-checked.
- Keys live in `.env.local` and the Mac's Keychain, never in the repo or in the app's state sent to the browser.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[FSL-1.1-ALv2](LICENSE) (Functional Source License, "fair source"): use, modify and self-host Bops freely, except to offer a competing commercial service. Each version becomes Apache-2.0 two years after release.

"Bops" and the Bops logo are trademarks of Organic Intelligence, Inc.; see [TRADEMARK.md](TRADEMARK.md).
