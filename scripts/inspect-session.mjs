// Print every saved item in an Agents API session, compactly.
// Usage: node scripts/inspect-session.mjs <sessionId>
import OpenAI from "openai";
const client = new OpenAI();
const id = process.argv[2];
const session = await client.beta.agents.sessions.retrieve(id);
console.log("status:", session.status);
for await (const item of client.beta.agents.sessions.items.list(id)) {
  const brief = JSON.stringify(item, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v));
  console.log("-", item.type, brief.slice(0, 600));
}
