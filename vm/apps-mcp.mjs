#!/usr/bin/env node
// The user's apps and business data for a Bops thread on their Mac: a tiny MCP server (stdio) that the
// task's executor starts. It passes find_app_actions and use_app (--apps), and business_search, find_data
// and get_data (--data, lib/server/treg.ts) to Bops, which holds the accounts and keys and asks the user
// before anything that sends, changes or costs more than a little. It reaches Bops through a socket in
// the task's own sockets folder (composio.ts serveApps), the only way out of the executor's sandbox to
// this Mac: that socket answers only this thread, so no secret is needed.
// Usage: node apps-mcp.mjs --socket <path> [--apps] [--data]
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const socket = process.argv[process.argv.indexOf("--socket") + 1];
const str = (description) => ({ type: "string", description });
const appTools = [
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
const dataTools = [
  {
    name: "business_search",
    description:
      'Look up business data from 100+ data providers. job is one of: companies (query, or industry, technology, name or domain; country, limit), similar_companies (domain), people (title and the company\'s domain, or query, full_name; keywords, location, country, limit), company (domain, or name, linkedin_url, email), person (email or linkedin_url, or full_name and domain), work_email (full_name and domain, or linkedin_url; checked before you get it), phone (linkedin_url, or email, or full_name and domain), check_email (email), news (domain), hiring (domain: open jobs), funding (domain), places (query: "dentists in Austin, TX"; country). Fill only what the job uses; a domain or LinkedIn URL beats a name. Most lookups cost under a cent and a miss is free.',
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", enum: ["companies", "similar_companies", "people", "company", "person", "work_email", "phone", "check_email", "news", "hiring", "funding", "places"] },
        query: str("Plain words: \"Series A fintech in New York\", \"dentists in Austin, TX\"."),
        name: str("A company's name."),
        domain: str("A company's website domain, e.g. stripe.com."),
        industry: str("An industry."),
        technology: str("A technology the company uses, e.g. HubSpot."),
        title: str("A job title or role."),
        keywords: { type: "array", items: { type: "string" }, description: "Skills or topics a person must match." },
        full_name: str("A person's full name."),
        email: str("An email address."),
        linkedin_url: str("A LinkedIn profile or company URL."),
        country: str("A two-letter country code."),
        location: str("A place, e.g. London, United Kingdom."),
        limit: { type: "integer", description: "How many results, 1 to 25 (default 10)." },
      },
      required: ["job"],
    },
  },
  {
    name: "find_data",
    description:
      "Search the rest of the business data catalog (social profiles and posts, SEO and search results, ads libraries, reviews, app stores, web scraping) for a job business_search doesn't do. It answers with each endpoint's id, price per call, how often it works and its inputs. Then call get_data.",
    inputSchema: { type: "object", properties: { query: str("The job in plain words.") }, required: ["query"] },
  },
  {
    name: "get_data",
    description: "Call one endpoint from find_data by its exact id, with its inputs (query, path and body inputs all in input, by name). Cheap ones run at once; a dearer one waits for the user's OK in Bops.",
    inputSchema: { type: "object", properties: { endpoint_id: { type: "string" }, input: { type: "object" } }, required: ["endpoint_id", "input"] },
  },
];
// A Bops from before --data passes neither flag: apps only.
const tools = [...(process.argv.includes("--apps") || !process.argv.includes("--data") ? appTools : []), ...(process.argv.includes("--data") ? dataTools : [])];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

/** One call: the request goes in, the connection's half closed, and Bops answers ({ text, ok }) and closes it. */
const call = (tool, args) =>
  new Promise((resolve, reject) => {
    const c = createConnection(socket);
    let body = "";
    c.setEncoding("utf8");
    c.on("data", (d) => (body += d));
    c.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error(body.slice(0, 200) || "no answer"));
      }
    });
    c.on("error", reject);
    c.end(JSON.stringify({ tool, args }));
  });

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notifications
  if (m.method === "initialize")
    return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bops_apps", version: "0.2" } } });
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
