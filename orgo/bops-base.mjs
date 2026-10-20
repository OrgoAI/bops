// Build, validate and publish the `bops-base` Orgo template from files in this repo.
//
// Every Bops computer (Sam's main one and every bot clone) launches from this template:
// Codex for the Agents API executor, Claude Code for brains the user brings, the screen MCP,
// and helpers for per-screen Chrome.
//
// Usage:
//   node orgo/bops-base.mjs validate
//   node orgo/bops-base.mjs publish          # publish + build the golden snapshot
//   node orgo/bops-base.mjs status

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// lib/server/orgo.ts BOPS_TEMPLATE moves to this version once it's built (and orgo-web's curated ref,
// lib/curated-templates.ts). 0.1.9 asks Orgo for the computer's own key (secrets: orgo_api_key).
const VERSION = "0.1.9";
const CODEX_VERSION = "0.160.0";
// The same as lib/server/brains.ts CLAUDE_CODE_VERSION, which installs it on older computers.
const CLAUDE_CODE_VERSION = "2.1.292";
const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(`${root}${p}`, "utf8");

const template = {
  api_version: "orgo.ai/v1",
  template: {
    name: "bops-base",
    version: VERSION,
    description: "Bops computer: Codex executor, Claude Code, screen MCP, per-screen Chrome, and Tailscale for the mirrored view.",
    publisher: "orgo",
  },
  // The computer's own Orgo key, which its Bops runner signs in with (lib/server/runner-key.ts): Orgo makes
  // it for each computer made from this template, writes it there as ORGO_API_KEY (/root/.env), and revokes
  // it with the computer. Never from anyone's vault, and none where someone else can use the workspace.
  // Optional: a computer made without it gets it when the Mac sets its runner up (PUT /api/computers/{id}/orgo-key).
  secrets: [
    {
      name: "orgo_api_key",
      description: "This computer's own Orgo key, made by Orgo for it and revoked with it. The Bops runner on it signs in with it.",
      optional: true,
    },
  ],
  // 4:3, boxier than 16:9, like a laptop screen; every screen on the computer matches it.
  hardware: { cpu: 4, ram_gb: 16, resolution: "1280x960x24", auto_stop_minutes: 0 },
  build: {
    apt: [
      "python3.12-venv", "jq", "rsync", "xdotool", "scrot", "hsetroot", "plank", "libglib2.0-bin",
      // Real apps on the bot's computer, so it's a computer and not just a browser.
      "gimp", "inkscape", "libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "evince", "ristretto", "galculator",
    ],
    run: [
      // Node 24 + npm, matching system/coding.
      "curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/node-setup.sh && bash /tmp/node-setup.sh && apt-get install -y nodejs",
      // Codex, pinned. `codex exec-server` is the Agents API executor.
      `curl -fsSL -o /tmp/codex.tgz https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz && tar -xzf /tmp/codex.tgz -C /tmp && install -m 755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/bin/codex && codex --version`,
      // Claude Code, pinned and unmodified (npm's package, its own install script and all), for brains the
      // user signs in with their own Claude plan or key (lib/server/brains.ts, vm/bin/bops-brain).
      `mkdir -p /opt/bops/claude && npm install -g --prefix /opt/bops/claude --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && DISABLE_AUTOUPDATER=1 /opt/bops/claude/bin/claude --version`,
      // Python env for the screen MCP.
      "python3 -m venv /opt/bops/venv && /opt/bops/venv/bin/pip install -q 'mcp==1.26.0'",
      "mkdir -p /workspace/capabilities/skills /root/profiles /root/.bops /var/log/bops /opt/bops/desktop && chmod 700 /root/.bops",
      // Tailscale (userspace networking; joined at runtime by bops-tailnet with a one-use key from Bops).
      "mkdir -p /opt/bops/tailscale && curl -fsSL https://pkgs.tailscale.com/stable/tailscale_latest_amd64.tgz | tar -xz -C /opt/bops/tailscale --strip-components=1 && /opt/bops/tailscale/tailscale version",
    ],
  },
  files: [
    { to: "/opt/bops/screen_mcp.py", inline: read("vm/screen_mcp.py"), mode: "0644" },
    { to: "/usr/local/bin/bops-chrome", inline: read("vm/bin/bops-chrome"), mode: "0755" },
    { to: "/usr/local/bin/bops-seed-profiles", inline: read("vm/bin/bops-seed-profiles"), mode: "0755" },
    { to: "/usr/local/bin/bops-exec", inline: read("vm/bin/bops-exec"), mode: "0755" },
    { to: "/usr/local/bin/bops-tailnet", inline: read("vm/bin/bops-tailnet"), mode: "0755" },
    { to: "/usr/local/bin/bops-screens", inline: read("vm/bin/bops-screens"), mode: "0755" },
    // Brains: Claude Code's own sign-in on a screen, its status and sign-out, and runs with a clean environment;
    // a thread's Claude Code process, which Bops talks to through files (lib/server/cli-agents.ts).
    { to: "/usr/local/bin/bops-brain", inline: read("vm/bin/bops-brain"), mode: "0755" },
    { to: "/usr/local/bin/bops-brain-browser", inline: read("vm/bin/bops-brain-browser"), mode: "0755" },
    { to: "/usr/local/bin/bops-agent", inline: read("vm/bin/bops-agent"), mode: "0755" },
    // The bot's own desktop (wallpaper, Chrome theme, home screen, dock); Bops supplies the bot's pages.
    { to: "/usr/local/bin/bops-desktop", inline: read("vm/bin/bops-desktop"), mode: "0755" },
    { to: "/opt/bops/bops-home.py", inline: read("vm/bops-home.py"), mode: "0755" },
  ],
  hooks: {
    on_pre_snapshot: "apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/codex* /tmp/node-setup.sh",
    on_resume: "mkdir -p /root/.bops /var/log/bops && chmod 700 /root/.bops",
  },
};

const key =
  process.env.ORGO_API_KEY ??
  JSON.parse(readFileSync(`${homedir()}/.orgo/credentials.json`, "utf8")).profiles.default.apiKey;
const api = async (method, path, body) => {
  const res = await fetch(`https://www.orgo.ai/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
};

const ref = `default/bops-base/${VERSION}`;
const cmd = process.argv[2] ?? "validate";

if (cmd === "validate" || cmd === "publish") {
  const v = await api("POST", "/templates/validate", template);
  if (!v.json.ok) {
    console.error("invalid:", JSON.stringify(v.json.errors ?? v.json, null, 2));
    process.exit(1);
  }
  console.log("valid");
}
if (cmd === "publish") {
  const p = await api("POST", "/templates?auto_build=true&force=true", template);
  console.log(p.status, JSON.stringify(p.json));
}
if (cmd === "status") {
  const s = await api("GET", `/templates/${ref}/build`);
  console.log(s.status, JSON.stringify(s.json));
}
