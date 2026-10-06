# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub: [**Report a vulnerability**](https://github.com/nickvasilescu/bops/security/advisories/new) (the Security tab of this repo). Tell us what you found, how to reproduce it, and what it lets someone do. We'll reply within 3 business days and keep you posted until it's fixed. Please give us a reasonable time to fix it before you share it.

## What's in scope

- The Bops server (`app/`, `lib/server/`): anything that lets someone outside your Mac read your state, act as you, or reach your bots' computers.
- The webhook relay (`edge/`) and the webhook routes (`app/api/phone/*`).
- What runs on the bots' computers (`vm/`, `orgo/`).
- The desktop app (`desktop/`).

## How Bops is meant to be run

- The server listens on your Mac (port 3210) and trusts requests from it. Don't expose that port to the internet. Only `/hooks/agentphone` and `/hooks/openai` should be public (through `edge/`), and both check signatures.
- Provider keys live in `.env.local`; saved logins live in the Mac's Keychain. Neither is sent to the browser or to models.
- Anyone on your Tailscale tailnet can reach the server: keep the tailnet to your own devices.
