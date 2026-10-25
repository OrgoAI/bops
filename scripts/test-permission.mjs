// Tests for what a bot does without asking (lib/permission.ts), as Claude Code's "don't ask again" decides it: a rule is
// for one bot and one action, whatever the recipients or details of each call; the last rule for an action wins, and none
// asks. "Just do it" allows what no rule says, except what it still asks about (what could move money) and what it never
// covers (a key's write, a paid lookup). Always allow saves one rule for the action, with "*" as its resource for a Bops
// from before, never twice. A rule saved before for an action and one resource reads as a rule for that action. No
// wildcards: an action is as it's written.
// Pure: no state, no network.
// Usage: node scripts/test-permission.mjs
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
const P = await import(`${root}/lib/permission.ts`);

/* ---------------- A rule is for its action, whoever it's for ---------------- */

const ava = [{ action: "Send an email", resource: "*", effect: "allow" }];
assert.equal(P.allows({ permissions: ava }, "Send an email"), true, "the action Always allow saved");
assert.equal(P.allows({ permissions: ava }, "Send Email in Gmail (work)"), false, "another action asks");
assert.equal(P.allows({}, "Send an email"), false, "no rule: it asks");
// Saved before, for one recipient or for no one: a rule for that action now.
assert.equal(P.allows({ permissions: [{ action: "Send an email", resource: "dana@acme.example", effect: "allow" }] }, "Send an email"), true, "one saved for Dana");
assert.equal(P.allows({ permissions: [{ action: "Create Event in Google Calendar (work)", resource: "(no one)", effect: "allow" }] }, "Create Event in Google Calendar (work)"), true, "one saved for no one");
assert.equal(P.allows({ permissions: [{ action: "Send *", resource: "*", effect: "allow" }] }, "Send an email"), false, "no wildcards: an action is as it's written");
assert.equal(P.allows({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }, "Send an email"), false, "nor * for every action");
// The last for an action wins.
const flip = [...ava, { action: "Send an email", effect: "ask" }];
assert.equal(P.ruleFor({ permissions: flip }, "Send an email"), "ask");
assert.equal(P.allows({ permissions: flip, autoApprove: true }, "Send an email"), false, "a rule that asks, over Just do it");

/* ---------------- Just do it ---------------- */

assert.equal(P.allows({ autoApprove: true }, "Create Issue in Linear"), true, "what no rule says");
assert.equal(P.allows({ autoApprove: true }, "Pay Invoice in Stripe", { guarded: true }), false, "what could move money still asks");
assert.equal(P.allows({ autoApprove: true }, "Use a paid lookup", { justDoIt: false }), false, "never where it doesn't apply (a key's write, a paid lookup)");
assert.equal(P.allows({ autoApprove: true, permissions: [{ action: "Pay Invoice in Stripe", resource: "*", effect: "allow" }] }, "Pay Invoice in Stripe", { guarded: true }), true, "an Always allow the user saved still counts");
assert.equal(P.allows({ permissions: [{ action: "Use a paid lookup", resource: "*", effect: "allow" }] }, "Use a paid lookup", { justDoIt: false }), true, "and where Just do it doesn't");

/* ---------------- Always allow ---------------- */

assert.deepEqual(P.alwaysRule("Send an email"), { action: "Send an email", resource: "*", effect: "allow" }, "one rule for the action, \"*\" for a Bops from before");
assert.equal(P.alwaysRule("Send an email", ava), null, "never twice");
assert.equal(P.alwaysRule("Send an email", [{ action: "Send an email", resource: "dana@acme.example", effect: "allow" }]), null, "one saved before covers it already");
assert.deepEqual(P.alwaysRule("Send an email", flip), { action: "Send an email", resource: "*", effect: "allow" }, "over a rule that asks");

/* ---------------- The card says what Always allow covers ---------------- */

assert.equal(P.alwaysScope("Max", { action: "Send an email", kind: "email" }), "Always allow Max to send an email, whoever it's to and whatever it says.");
assert.equal(P.alwaysScope("Max", { action: "Send Email in Gmail (work)", kind: "app" }), "Always allow Max to send Email in Gmail (work), whoever it's for and whatever it says.");
assert.equal(P.alwaysScope("Sam", { action: "Call Stripe", kind: "api" }), "Always allow Sam to call Stripe, whatever it sends.");
assert.equal(P.alwaysScope("Sam", { action: "Use Bash", kind: "brain" }), "Always allow Sam to use Bash, whatever it runs.");

console.log("permission: all tests passed");
