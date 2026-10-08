# Windows 11 community integration of OrgoAI/bops v0.0.24

**Work in progress, not an official OrgoAI release.** This branch tracks upstream commit `953d0b33c48319b1358483dcb87e475fb3673c72` while porting Windows support and local BYOK settings. The older tested Windows v0.0.6 release remains on `main` until this branch passes its own tests. Keep the upstream license, authorship and trademarks intact.

**Important limitation:** The upstream v0.0.24 local executor relies on the macOS Seatbelt sandbox and `cua-driver`. This integration refuses to start an unrestricted agent executor on Windows until a secure native sandbox is available. Orgo cloud-computer workflows and direct AI requests are separate features. The Windows binary is not yet validated.

This branch ports the Bops desktop application to Windows 11 while keeping the upstream internal `mac` state/API identifiers for compatibility.

## Supported

- Electron desktop app and local Next.js server
- Orgo cloud computers
- OpenAI / Codex integration
- Composio, Honcho, AgentMail and existing provider integrations
- Local Chrome/Edge bot-browser workers
- Windows protected secret storage using DPAPI
- Windows Codex CLI discovery and automatic verified download
- NSIS installer and portable x64 executable
- Electron desktop screen/window previews

## Windows parity notes

Bops can discover the Windows Codex CLI. Local-PC agent execution is restricted pending a secure Windows sandbox. Local screen/window previews, UI Automation text reading, Chrome/Edge workers, protected secrets, notifications, installer packaging and cloud-computer workflows have Windows implementations.

Orgo personal-device egress still requires a compatible `orgo-relay.exe`. If your Orgo distribution provides it, set `BOPS_RELAY_BIN` to its full path. This private Orgo binary is not part of the public Bops repository.

## Direct AI API and strict privacy

Windows builds can use a locally stored BYOK API from **Settings → AI API**.

- The API key is protected locally with Windows DPAPI and is never returned to the browser after saving.
- Direct AI bypasses the Bops Cloud OpenAI proxy for prompts and model outputs.
- Chat, normal task and hard-task model ids are configurable independently.
- The API base URL can be OpenAI or another OpenAI-compatible endpoint. Full long-running Bops threads require compatible Responses and Agents APIs.
- **Strict privacy: block Bops Cloud** is on by default for new Direct AI setups. It disables Bops Cloud provider proxies, state backup and the webhook tunnel.
- Cloud-computer key sharing is off by default. When enabled, the AI API key is copied to the user's Orgo VM so cloud-computer agent tasks can run.
- With strict privacy on, hosted Bops Cloud-backed integrations such as Composio, Honcho and phone services are unavailable unless equivalent self-hosted provider keys are configured.


> Windows release validation also retries the local Win32 enumeration smoke check, and the runtime avoids executable metadata reads that can stall on protected processes.

## Requirements

- Windows 11 x64
- Node.js 22+
- Git
- PowerShell 5.1+ or PowerShell 7
- Chrome recommended; Edge is accepted as fallback

## Development

```powershell
git clone https://github.com/hasnainkhatri87/bops.git
cd bops
git checkout windows-orgo-v0.0.24
Copy-Item .env.example .env.local
npm install
npm run win:doctor
npm run app
```

Or:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-windows.ps1
```

## Build Windows installer + portable EXE

```powershell
npm run app:build:win
```

or:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-windows.ps1
```

Output is written to `dist-desktop\`.

## Self-hosted configuration

At minimum follow the upstream Bops self-hosting requirements. A typical `.env.local` includes:

```env
BOPS_SELF_HOSTED=1
OPENAI_API_KEY=...
ORGO_API_KEY=...
```

If browser auto-detection fails:

```env
BOPS_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

Do not expose the local Bops server directly to the public Internet.

For an externally supplied Windows Orgo relay:

```env
BOPS_RELAY_BIN=C:\\path\\to\\orgo-relay.exe
```
