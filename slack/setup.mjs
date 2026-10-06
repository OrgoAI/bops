#!/usr/bin/env node
/**
 * Bops' own Slack app, wired to Composio, so Slack shows "Bops" (and each bot under its own name and
 * picture) instead of Composio's shared app. Run from the repo root; it reads and writes .env.local.
 *
 *   SLACK_CONFIG_TOKEN=xoxe.xoxp-… node slack/setup.mjs create
 *     Makes the app from slack/manifest.json (Slack's App Manifest API), then a Composio Slackbot auth
 *     config with the app's credentials (redirect through api.bops.bot), so connecting Slack in Bops
 *     shows "Bops". The config token comes from api.slack.com/apps → "Your App Configuration Tokens" →
 *     Generate Token. Saves the app's id and credentials to .env.local (BOPS_SLACK_*); Bops checks
 *     Slack's events with BOPS_SLACK_SIGNING_SECRET.
 *
 *   SLACK_CONFIG_TOKEN=xoxe.xoxp-… node slack/setup.mjs events
 *     Turns on the app's events, sent to api.bops.bot/hooks/slack (relayed to Bops). Slack checks the
 *     URL on the spot, so Bops must be running and reachable through the relay.
 *
 * Nothing secret is printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Composio } from "@composio/core";

const ENV = ".env.local";
const env = Object.fromEntries(
  readFileSync(ENV, "utf8")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const get = (k) => process.env[k] || env[k];
const save = (vars) => {
  let text = readFileSync(ENV, "utf8");
  for (const [k, v] of Object.entries(vars)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(ENV, text);
};

const PUBLIC = (get("BOPS_PUBLIC_URL") || "https://api.bops.bot").replace(/\/$/, "");
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const EVENTS = ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"];

async function slack(method, token, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}${j.errors ? ` ${JSON.stringify(j.errors)}` : ""}`);
  return j;
}

const cx = new Composio({ apiKey: get("COMPOSIO_API_KEY") });
const step = process.argv[2];

if (step === "create") {
  const config = get("SLACK_CONFIG_TOKEN");
  if (!config) throw new Error("Set SLACK_CONFIG_TOKEN (api.slack.com/apps → Your App Configuration Tokens)");
  let appId = get("BOPS_SLACK_APP_ID");
  if (!appId) {
    const made = await slack("apps.manifest.create", config, { manifest: JSON.stringify(manifest) });
    appId = made.app_id;
    save({
      BOPS_SLACK_APP_ID: made.app_id,
      BOPS_SLACK_CLIENT_ID: made.credentials.client_id,
      BOPS_SLACK_CLIENT_SECRET: made.credentials.client_secret,
      BOPS_SLACK_SIGNING_SECRET: made.credentials.signing_secret,
      BOPS_SLACK_VERIFICATION_TOKEN: made.credentials.verification_token,
    });
    for (const [k, v] of Object.entries({ BOPS_SLACK_CLIENT_ID: made.credentials.client_id, BOPS_SLACK_CLIENT_SECRET: made.credentials.client_secret, BOPS_SLACK_SIGNING_SECRET: made.credentials.signing_secret, BOPS_SLACK_VERIFICATION_TOKEN: made.credentials.verification_token })) env[k] = v;
    console.log(`Slack app made: ${appId} (https://api.slack.com/apps/${appId})`);
  } else console.log(`Slack app already made: ${appId}`);

  const clientId = get("BOPS_SLACK_CLIENT_ID");
  const { items } = await cx.authConfigs.list({ toolkit: "slackbot" });
  let ac = items.find((a) => !a.isComposioManaged && a.status === "ENABLED");
  if (!ac) {
    ac = await cx.authConfigs.create("slackbot", {
      type: "use_custom_auth",
      authScheme: "OAUTH2",
      name: "Bops Slack app",
      credentials: {
        client_id: clientId,
        client_secret: get("BOPS_SLACK_CLIENT_SECRET"),
        oauth_redirect_uri: `${PUBLIC}/oauth/callback`,
        scopes: manifest.oauth_config.scopes.bot.join(","),
        verification_token: get("BOPS_SLACK_VERIFICATION_TOKEN"),
      },
    });
    console.log(`Composio auth config made: ${ac.id}`);
  } else console.log(`Composio auth config already made: ${ac.id}`);

  save({ BOPS_SLACK_AUTH_CONFIG: ac.id });
  console.log(`Next: run the "events" step (Bops running), and upload the app icon at https://api.slack.com/apps/${appId}/general (edge/public/brand/bops-1024.png).`);
} else if (step === "events") {
  const config = get("SLACK_CONFIG_TOKEN");
  if (!config) throw new Error("Set SLACK_CONFIG_TOKEN");
  await slack("apps.manifest.update", config, {
    app_id: get("BOPS_SLACK_APP_ID"),
    manifest: JSON.stringify({ ...manifest, settings: { ...manifest.settings, event_subscriptions: { request_url: `${PUBLIC}/hooks/slack`, bot_events: EVENTS } } }),
  });
  console.log(`Events on, sent to ${PUBLIC}/hooks/slack. Slack checked the URL.`);
} else {
  console.log("Usage: node slack/setup.mjs create | events   (see the top of this file)");
}
