#!/usr/bin/env node
// The user's apps for a Bops thread on their Mac: a tiny MCP server (stdio) that Codex starts. It passes
// find_app_actions and use_app to Bops, which holds the accounts and asks the user before anything
// that sends or changes something. Usage: node apps-mcp.mjs --session <bops session id>
// Env: BOPS_URL (http://127.0.0.1:3210), BOPS_KEY (the bot's secret).
import { createInterface } from "node:readline";

const session = process.argv[process.argv.indexOf("--session") + 1];
const url = `${process.env.BOPS_URL ?? "http://127.0.0.1:3210"}/api/apps/call`;
const tools = [
  {
    name: "find_app_actions",
    description: "Find the actions you can take in the user's apps (the ones you have access to) for a job, with their exact names and inputs. Call this before use_app.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "The job in plain words." } }, required: ["query"] },
  },
  {
    name: "use_app",
    description: "Run one action in the user's apps, e.g. GMAIL_FETCH_EMAILS. Reading runs at once. Anything that sends, creates, changes or pays waits for the user to approve it in Bops.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        arguments: { type: "object" },
        account: { type: "string", description: "Which account, when you have more than one in that app: its label or name (e.g. \"Work\")." },
      },
      required: ["action", "arguments"],
    },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

async function call(name, args) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bops-key": process.env.BOPS_KEY ?? "" },
    body: JSON.stringify({ session, tool: name, args }),
  });
  return { text: await res.text(), ok: res.ok };
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notifications
  if (m.method === "initialize")
    return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bops_apps", version: "0.1" } } });
  if (m.method === "tools/list") return send({ id: m.id, result: { tools } });
  if (m.method === "tools/call") {
    try {
      const r = await call(m.params.name, m.params.arguments ?? {});
      return send({ id: m.id, result: { content: [{ type: "text", text: r.text }], isError: !r.ok } });
    } catch (e) {
      return send({ id: m.id, result: { content: [{ type: "text", text: `Couldn't reach Bops: ${e.message}` }], isError: true } });
    }
  }
  if (m.method === "ping") return send({ id: m.id, result: {} });
  send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
});
