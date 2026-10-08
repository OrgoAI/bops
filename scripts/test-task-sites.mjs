// Tests for lib/task-sites.ts: which tasks name the site a screen has open, so a new task goes to the
// screen already on its site (pump in lib/server/sessions.ts) instead of opening it on a second one.
// Usage: node --experimental-strip-types scripts/test-task-sites.mjs
import assert from "node:assert/strict";
import { namesSite, onASite } from "../lib/task-sites.ts";

const cases = [
  // By name, however it's written.
  ["Check my OpenRouter credits", "https://openrouter.ai/settings/credits", true],
  ["check open router usage", "https://openrouter.ai/activity", true],
  ["Update the Linear issue ORG-12", "https://linear.app/orgo/issue/ORG-12", true],
  ["check stripe payouts", "https://dashboard.stripe.com/payouts", true],
  // By address.
  ["go to openrouter.ai/keys and make a key", "https://platform.openrouter.ai/x", true],
  ["summarize bbc.co.uk headlines", "https://www.bbc.co.uk/news", true],
  // By what it's also called.
  ["triage my gmail", "https://mail.google.com/mail/u/0", true],
  ["reply to my tweets", "https://x.com/home", true],
  // Not the site.
  ["Find flights to NYC", "https://openrouter.ai/", false],
  ["google the weather", "https://mail.google.com/mail", false],
  ["post on x", "https://x.com/home", false],
  ["read the bbc news", "https://www.bbc.co.uk/news", false],
  // No one's site: search engines, home screens, local pages.
  ["search google for X", "https://www.google.com/search?q=x", false],
  ["anything", "chrome://newtab", false],
  ["anything", "http://127.0.0.1:7600/", false],
];
for (const [task, url, want] of cases) assert.equal(namesSite(task, url), want, `${task} · ${url}`);

assert.equal(onASite("https://openrouter.ai/"), true);
assert.equal(onASite("https://www.google.com/search?q=x"), false);
assert.equal(onASite("about:blank"), false);
console.log(`ok · ${cases.length + 3} checks`);
