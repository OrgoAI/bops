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
//   node orgo/bops-base.mjs yaml             # the template as YAML (orgo-web templates/curated/next/bops-base.yaml)
//
// The keeper's keeper.json says where Orgo, Bops Cloud and the runner releases are: BOPS_KEEPER_ORGO,
// BOPS_KEEPER_CLOUD and BOPS_KEEPER_RELEASES when publishing for staging, else Orgo's own. ORGO_API_URL points
// validate, publish and status at another Orgo's API (staging's), with that Orgo's key in ORGO_API_KEY.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { KEEPER_CONF, KEEPER_CONF_FILE, KEEPER_DIR, q } from "../vm/runner-steps.mjs";

// lib/server/orgo.ts BOPS_TEMPLATE moves to this version once it's built (and orgo-web's curated ref,
// lib/curated-templates.ts). 0.1.9 asks Orgo for the computer's own key (secrets: orgo_api_key). 0.1.11 has
// an 80 GB disk (orgo-web's BOPS_COMPUTER_DISK_GB; 0.1.10 was orgo-web's own build of 0.1.8 with it) and
// screens laid out like a normal computer: Chrome fills each one, and Orgo's own taskbar stays hidden. 0.1.12 has
// the computer's own keeper (vm/bin/bops-runner-keeper.mjs, under supervisord as bops-keeper), which sets the Bops
// runner up and updates it from signed releases when Bops Cloud says it may, so a new computer needs no Mac for it.
const VERSION = "0.1.12";
const CODEX_VERSION = "0.160.0";
// The same as lib/server/brains.ts CLAUDE_CODE_VERSION, which installs it on older computers.
const CLAUDE_CODE_VERSION = "2.1.292";
const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(`${root}${p}`, "utf8");

// Where the keeper finds Orgo, Bops Cloud (its /api, as the runner calls it: lib/server/cloud-url.ts) and the signed
// runner releases (latest.json and the bundles beside it). Never a key: the keeper's are built into runner-steps.mjs.
export const KEEPER_JSON = {
  orgo: process.env.BOPS_KEEPER_ORGO || "https://www.orgo.ai",
  cloud: process.env.BOPS_KEEPER_CLOUD || "https://bops.orgo.ai/api",
  releases: process.env.BOPS_KEEPER_RELEASES || "https://bops.bot/download/runner/",
};

export const template = {
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
  hardware: { cpu: 4, ram_gb: 16, disk_gb: 80, resolution: "1280x960x24", auto_stop_minutes: 0 },
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
      // The keeper's supervisord program (KEEPER_CONF, byte for byte), started with the computer: written here, as a
      // template's files may not go in /etc/supervisor. Its files are in `files` below.
      `mkdir -p /etc/supervisor/conf.d /var/log/bops && printf '%s\\n' ${KEEPER_CONF.split("\n").slice(0, -1).map(q).join(" ")} > ${KEEPER_CONF_FILE} && chmod 0644 ${KEEPER_CONF_FILE}`,
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
    { to: "/usr/local/bin/bops-screen-layout", inline: read("vm/bin/bops-screen-layout"), mode: "0755" },
    { to: "/opt/bops/bops-home.py", inline: read("vm/bops-home.py"), mode: "0755" },
    // The computer's own keeper: it sets the Bops runner up and keeps it on the newest signed release, on the
    // computer's own identity, when Bops Cloud says it may (docs/cloud-runner.md). Its steps beside it, where Orgo,
    // Bops Cloud and the releases are, and its supervisord program (started with the computer).
    { to: `${KEEPER_DIR}/keeper.mjs`, inline: read("vm/bin/bops-runner-keeper.mjs"), mode: "0755" },
    { to: `${KEEPER_DIR}/runner-steps.mjs`, inline: read("vm/runner-steps.mjs"), mode: "0644" },
    { to: `${KEEPER_DIR}/keeper.json`, inline: `${JSON.stringify(KEEPER_JSON, null, 2)}\n`, mode: "0644" },
  ],
  hooks: {
    on_pre_snapshot: "apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/codex* /tmp/node-setup.sh",
    // Every wake lays the screens out again (Chrome filling each, Orgo's taskbar hidden), in the background.
    on_resume: "mkdir -p /root/.bops /var/log/bops && chmod 700 /root/.bops && (setsid nohup bops-screen-layout > /var/log/bops/screen-layout.log 2>&1 < /dev/null &)",
  },
};

/**
 * The template as YAML (block scalars for files of more than one line, quoted strings otherwise), which orgo-web keeps
 * as templates/curated/next/bops-base.yaml and releases with its scripts/release-curated-template.ts.
 */
export function toYaml(v, indent = "") {
  const scalar = (x) => (typeof x === "string" ? JSON.stringify(x) : typeof x === "number" || typeof x === "boolean" ? String(x) : x === null ? "null" : null);
  const block = (s, pad) => {
    // A literal block keeps the text exactly: its indentation said (2 past its key's, as a first line may start with
    // spaces), and how it ends.
    const chomp = s.endsWith("\n\n") ? "+" : s.endsWith("\n") ? "" : "-";
    const body = (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n").map((l) => (l ? `${pad}${l}` : "")).join("\n");
    return `|2${chomp}\n${body}`;
  };
  const value = (x, pad) => (typeof x === "string" && x.includes("\n") && !/[\r\t]/.test(x) ? ` ${block(x, pad)}` : scalar(x) !== null ? ` ${scalar(x)}` : `\n${toYaml(x, pad)}`);
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? `${indent}-${toYaml(x, `${indent}  `).slice(indent.length + 1)}` : `${indent}-${value(x, `${indent}  `)}`)).join("\n");
  return Object.entries(v)
    .map(([k, x]) => `${indent}${k}:${value(x, `${indent}  `)}`)
    .join("\n");
}

const cmd = process.argv[2] ?? "validate";
const main = process.argv[1] && new URL(import.meta.url).pathname === (await import("node:fs")).realpathSync(process.argv[1]);
if (main && cmd === "yaml") process.stdout.write(`${toYaml(template)}\n`);

const apiBase = (process.env.ORGO_API_URL || "https://www.orgo.ai/api").replace(/\/+$/, "");
const keyOf = () =>
  process.env.ORGO_API_KEY ??
  JSON.parse(readFileSync(`${homedir()}/.orgo/credentials.json`, "utf8")).profiles.default.apiKey;
const api = async (method, path, body) => {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${keyOf()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
};

const ref = `default/bops-base/${VERSION}`;

if (main && (cmd === "validate" || cmd === "publish")) {
  const v = await api("POST", "/templates/validate", template);
  if (!v.json.ok) {
    console.error("invalid:", JSON.stringify(v.json.errors ?? v.json, null, 2));
    process.exit(1);
  }
  console.log("valid");
}
if (main && cmd === "publish") {
  const p = await api("POST", "/templates?auto_build=true&force=true", template);
  console.log(p.status, JSON.stringify(p.json));
}
if (main && cmd === "status") {
  const s = await api("GET", `/templates/${ref}/build`);
  console.log(s.status, JSON.stringify(s.json));
}
