// The hidden names of an app's Preview and Published (lib/server/app-labels.ts): 12 lowercase letters and digits, a
// letter in the 8 random first ones (never all digits), a 4 character seal from what it's for, the app's repo, the site
// and those 8; recognized only for its own kind, repo and site; every one orgo-web's checkLabel takes; a fixed random
// source gives a fixed label; a name the owner chose ahead is taken only as 12 lowercase letters and digits, a letter first.
// Usage: node scripts/test-app-labels.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const L = await import(new URL("../lib/server/app-labels.ts", import.meta.url).href);

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const REPO = "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a9c4f13/recipe-box";

/** orgo-web's checkLabel (lib/public-urls/config.ts), as it is on staging: what a public URL's label may be. */
const RESERVED = new Set(["www", "api", "app", "admin", "edge", "mail", "smtp", "ftp", "ns", "ns1", "ns2", "dns", "orgo", "status", "docs", "help", "support", "staging", "stg", "test", "dev", "cdn", "static", "assets", "auth", "login", "billing", "root", "localhost", "metal", "proxy", "vmm", "fleet", "gw", "gateway", "turn", "stun", "rtc", "vnc", "ssh"]);
const checkLabel = (l) =>
  /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(l) && !/^[0-9]+$/.test(l) && !/^[0-9a-f]{8}$/.test(l) && !l.startsWith("orgo-") && !(l.length >= 4 && l.slice(2, 4) === "--") && !RESERVED.has(l);

check("a label is 12 lowercase letters and digits, with a letter among its first 8, never all digits", () => {
  for (let i = 0; i < 2000; i++) {
    const l = L.newLabel(i % 2 ? "prod" : "preview", REPO, "recipe-box");
    assert.match(l, /^[a-z0-9]{12}$/);
    assert.match(l.slice(0, 8), /[a-z]/);
  }
  // A random source that gives only digits still gets a letter.
  assert.match(L.newLabel("preview", REPO, "recipe-box", () => 30).slice(0, 8), /[a-z]/);
});

check("isLabelOf: true for its own kind, repo and site; false for the other kind, another site or repo, uppercase, or 11 characters", () => {
  const l = L.newLabel("preview", REPO, "recipe-box");
  assert.equal(L.isLabelOf("preview", l, REPO, "recipe-box"), true);
  assert.equal(L.isLabelOf("preview", l, REPO.toUpperCase(), "recipe-box"), true, "the repo as orgo-web may case it");
  assert.equal(L.isLabelOf("prod", l, REPO, "recipe-box"), false);
  assert.equal(L.isLabelOf("preview", l, REPO, "recipe-box-admin"), false);
  assert.equal(L.isLabelOf("preview", l, `${REPO}x`, "recipe-box"), false);
  assert.equal(L.isLabelOf("preview", l.toUpperCase(), REPO, "recipe-box"), false);
  assert.equal(L.isLabelOf("preview", l.slice(0, 11), REPO, "recipe-box"), false);
  assert.equal(L.isLabelOf("preview", null, REPO, "recipe-box"), false);
  assert.equal(L.isLabelOf("preview", "recipe-box", REPO, "recipe-box"), false, "a site's name is no label");
});

check("every label of 10,000 is one orgo-web's checkLabel takes", () => {
  for (let i = 0; i < 10000; i++) {
    const l = L.newLabel(i % 2 ? "prod" : "preview", REPO, `site-${i % 7}`);
    assert.ok(checkLabel(l), l);
  }
});

check("a fixed random source gives a fixed label, and its seal is the sha256 of what it's for", () => {
  let k = 0;
  const rand = () => k++ % 36;
  const a = L.newLabel("preview", REPO, "recipe-box", rand);
  k = 0;
  assert.equal(L.newLabel("preview", REPO, "recipe-box", rand), a);
  assert.equal(a.slice(0, 8), "abcdefgh");
  assert.equal(a.slice(8), L.sealOf("preview", REPO, "recipe-box", "abcdefgh"));
  assert.notEqual(L.sealOf("prod", REPO, "recipe-box", "abcdefgh"), a.slice(8));
});

check("a name chosen ahead: 12 lowercase letters and digits, a letter first", () => {
  for (const ok of ["keaundwsjnt2", "onb8wkukj8kc", "zoe8lk6vtcdy", "jcbcuvszpc26"]) assert.equal(L.labelGiven(ok), ok);
  for (const no of ["1keaundwsjnt", "keaundwsjnt", "keaundwsjnt23", "Keaundwsjnt2", "keaund-sjnt2", 12, null]) assert.equal(L.labelGiven(no), null, String(no));
});

console.log(`app labels: ${passed} passed`);
