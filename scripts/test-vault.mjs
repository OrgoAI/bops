// Tests for the Vault's services (lib/vault-services.ts): an app's accounts, its MCP server and the
// site's saved login are one row; Google's apps are one "Google"; a login with no app is a row of its
// own, named by its site; when a service was last used (or added, if never); what's signed out.
// Pure: no state, no network.
// Usage: node scripts/test-vault.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
});
const V = await import(`${root}/lib/vault-services.ts`);

let n = 0;
const account = (app, appName, o = {}) => ({ id: `ca_${++n}`, app, appName, status: "active", at: 1000, ...o });
const login = (site, o = {}) => ({ id: `vl_${++n}`, site, username: "me@example.com", hasPassword: true, hasTotp: false, bots: "all", auto: false, addedAt: 2000, ...o });

const accounts = [
  account("github", "GitHub", { name: "octocat" }),
  account("github_mcp", "GitHub MCP"),
  account("notion", "Notion"),
  account("notion_mcp", "Notion MCP"),
  account("gmail", "Gmail", { name: "work@example.com" }),
  account("gmail", "Gmail", { name: "home@example.com" }),
  account("googlecalendar", "Google Calendar", { name: "work@example.com", usedAt: 9000 }),
  account("stripe", "Stripe"),
  account("attio", "Attio", { status: "expired" }),
  account("granola_mcp", "Granola MCP"),
];
const logins = [login("stripe.com"), login("www.google.com", { usedAt: 5000 }), login("attio"), login("openrouter.ai"), login("ycombinator.com")];
const services = V.servicesOf(accounts, logins);
const by = Object.fromEntries(services.map((s) => [s.key, s]));

// One row per service, in name order.
assert.deepEqual(
  services.map((s) => s.name),
  ["Attio", "GitHub", "Google", "Granola", "Notion", "openrouter.ai", "Stripe", "ycombinator.com"],
);
// An app and its MCP server are one; Google's apps are one; an app and its site's login are one.
assert.deepEqual(by.github.accounts.map((a) => a.appName), ["GitHub", "GitHub MCP"]);
assert.deepEqual(by.notion.accounts.map((a) => a.appName), ["Notion", "Notion MCP"]);
assert.deepEqual(by.google.accounts.map((a) => a.app), ["gmail", "gmail", "googlecalendar"]);
assert.equal(by.google.logins.length, 1, "www.google.com goes with Google");
assert.equal(by.stripe.logins[0].site, "stripe.com");
assert.equal(by.attio.logins[0].site, "attio", "a login saved under a bare name still finds its app");
// A login with no app is its own row, named by its site.
assert.deepEqual([by.openrouter.accounts.length, by.openrouter.logins.length], [0, 1]);
// MCP servers are told apart (for the row's kinds).
assert.deepEqual(accounts.filter(V.isMcp).map((a) => a.appName), ["GitHub MCP", "Notion MCP", "Granola MCP"]);
// Last used: the newest use, else when it was added.
assert.equal(V.lastUsed(by.google), 9000);
assert.equal(V.lastUsed(by.stripe), 2000);
assert.equal(V.lastUsed(by.github), 1000);
// What's signed out.
assert.deepEqual(V.signedOut(by.attio).map((a) => a.appName), ["Attio"]);
assert.equal(V.signedOut(by.github).length, 0);
assert.ok(V.FOLD_OVER >= 8 && V.FOLD_AFTER_MS >= 7 * 24 * 60 * 60_000);

console.log("vault: all tests passed");
