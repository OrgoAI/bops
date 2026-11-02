// Tests for the size of the free Bops computer, billed by use: Medium or Large. Reading the sizes from orgo-web's
// GET /api/bops/plan (lib/bops-billing.ts, flat or nested, only sizes this app knows), the words and prices
// (lib/computer-size.ts, every number Orgo's), the size a new computer is made at (lib/server/plan.ts makeFree:
// bops_size only when Orgo lists it, none on Bops' plans or from an orgo-web before sizes, which makes it Large
// as before), the size kept from Orgo's read, whether Pick your computer is asked (fail open), and switching
// (lib/server/computer-size.ts): asleep it's woken first, memory too full it's restarted once (never under a
// bot that's working), want of credit in the app's words, the Orgo plan's own resize, and a refusal of every
// other kind left as it was. Orgo is a fake fetch on a made-up origin and the state a throwaway file store in a
// temporary folder: nothing reaches Orgo. The ids are made up.
// Usage: node --conditions=react-server scripts/test-computer-size.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.BOPS_SELF_HOSTED = "1";
for (const k of ["ORGO_API_KEY", "BOPS_ORGO_WORKSPACE", "BOPS_ORGO_TEMPLATE", "BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "BOPS_MAIL_DOMAIN", "OPENAI_API_KEY", "TAILSCALE_AUTH_KEY", "BOPS_WEBRTC"])
  delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
process.env.BOPS_WAKE_WAIT_MS = "2000";
// A path, not a URL's: a checkout under a folder with a space in its name works too.
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const scratch = mkdtempSync(join(tmpdir(), "bops-test-size-"));
process.chdir(scratch);
globalThis.bopsOrgoKey = "sk_test_size";

/* ---------------- A fake orgo-web, with sizes ---------------- */

const SIZES = [
  { size: "medium", name: "Medium", cpu: 2, ram_gb: 8, disk_gb: 80, running_cents_per_hour: 5.5 },
  { size: "large", name: "Large", cpu: 4, ram_gb: 16, disk_gb: 80, running_cents_per_hour: 11 },
];
/**
 * `o.sizes`: orgo-web lists sizes (false: an orgo-web from before, which makes every one Large and has no
 * switch); `o.computer`: the free Bops computer (null: none yet), its size, status and how it's switched;
 * `o.sizeAnswers`: what the switch answers next, in turn, before the rules.
 */
let o;
const fresh = (over = {}) => {
  o = { billing: "usage", sizes: true, computer: null, credit: 400, made: 0, ramInUse: false, sizeAnswers: [], webrtcRefuse: false, ...over };
  return o;
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls = [];
const planAnswer = () => {
  const c = o.computer;
  const size = c?.size ?? "large";
  const offer = SIZES.find((s) => s.size === size);
  const computer = { size: offer.name, key: size, change: c ? ("change" in c ? c.change : "bops") : null, hourlyCents: offer.running_cents_per_hour, asleepFree: true, creditCents: o.credit };
  if (!o.sizes) return { billing: o.billing, balanceCents: o.credit, computer: { size: "Large", hourlyCents: 11, asleepFree: true, creditCents: o.credit }, usage: { computer: { id: c?.id ?? null, size: "large", running_cents_per_hour: 11 } } };
  return {
    billing: o.billing,
    balanceCents: o.credit,
    computer,
    computerSizes: SIZES.map((s) => ({ key: s.size, name: s.name, cpu: s.cpu, ramGb: s.ram_gb, diskGb: s.disk_gb, hourlyCents: s.running_cents_per_hour })),
    defaultSize: "medium",
    usage: { computer: { id: c?.id ?? null, size, change: computer.change, running_cents_per_hour: offer.running_cents_per_hour }, computer_sizes: SIZES, default_size: "medium" },
  };
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://orgo.test") throw new Error(`not the fake Orgo: ${url}`);
  const call = { method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  const c = o.computer;
  const key = `${call.method} ${call.path}`;
  if (key === "GET /api/bops/plan") return json(200, planAnswer());
  if (key === "GET /api/workspaces") return json(200, { workspaces: [{ id: "ws_bops", name: "Bops", role: "owner" }] });
  if (key === "GET /api/user/subscription") return json(200, { tier: "free", planLimits: null });
  if (key === "GET /api/billing/compute-limits") return json(200, { max_computers: 0, computers_used: 0, account_ram_budget_gb: 4, account_ram_used_gb: 0, max_ram_gb: 4, bops_free_computer_id: c?.id ?? null });
  if (key === "POST /api/computers") {
    const b = call.body;
    if (b.bops_size !== undefined && o.refuseSize) return json(400, { error: 'bops_size must be "medium" or "large".', code: "INVALID_BOPS_SIZE" });
    o.computer = { id: `c-free-${++o.made}`, size: o.sizes && b.bops_size ? b.bops_size : "large", status: "running" };
    return json(201, { id: o.computer.id, name: b.name, status: "creating" });
  }
  if (key === "POST /api/bops/computer/size") {
    const next = o.sizeAnswers.shift();
    if (next) return next(call);
    if (!c) return json(404, { error: "You don't have a Bops computer yet.", code: "bops_no_computer" });
    if (c.status !== "running") return json(409, { error: "Wake your computer, then switch.", code: "COMPUTER_NOT_RUNNING", next: { method: "POST", path: `/api/computers/${c.id}/resume` } });
    if (call.body.size === "medium" && o.ramInUse) return json(409, { error: "Too much memory in use.", code: "RAM_IN_USE", in_use_gb: 11, min_ram_gb: 16 });
    if (call.body.size === "large" && o.credit < 11) return json(402, { error: "Add Orgo credit to switch to Large. It costs $0.11 an hour while it runs.", code: "bops_out_of_credit", credit_usd_needed: 0.11 });
    c.size = call.body.size;
    return json(200, { size: c.size, changed: true, restarted: false });
  }
  const [, id, what] = call.path.match(/^\/api\/computers\/([^/]+)(?:\/(\w+))?$/) ?? [];
  if (!c || id !== c.id) return json(404, { error: "Not found" });
  if (call.method === "GET" && !what) return json(200, { id, name: "boppy", status: c.status, cpu: c.size === "medium" ? 2 : 4, ram: c.size === "medium" ? 8 : 16, os: "linux" });
  if (call.method === "POST" && what === "resume") {
    if (o.credit < 6) return json(402, { error: "Add credit to start this computer.", code: "bops_out_of_credit" });
    c.status = "running";
    return json(200, { ok: true });
  }
  if (call.method === "POST" && what === "restart") {
    o.ramInUse = false;
    return json(200, { ok: true });
  }
  if (call.method === "PATCH" && what === "resize") {
    if (o.planRefuse) return json(403, { error: "Your plan has no memory left for that size.", code: "RAM_ADDON" });
    c.size = call.body.size;
    return json(200, { ok: true, restarted: false });
  }
  if (call.method === "POST" && what === "webrtc") return o.webrtcRefuse ? json(409, { error: "Needs 4 vCPUs.", code: "webrtc_ineligible" }) : json(200, { webrtc: true });
  return json(404, { error: "Not found" });
};
const asked = (method, path) => calls.filter((c) => c.method === method && c.path === path);

const B = await import(`${root}/lib/bops-billing.ts`);
const W = await import(`${root}/lib/computer-size.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const L = await import(`${root}/lib/server/plan.ts`);
const O = await import(`${root}/lib/server/orgo.ts`);
const Z = await import(`${root}/lib/server/computer-size.ts`);
const R = await import(`${root}/app/api/computer/size/route.ts`);
Z.sizeWait.pollMs = 5;
// The Mac app's ways from here (cloud.ts cloudOn), with the state still in the test's file store.
delete process.env.BOPS_SELF_HOSTED;
const cloudBox = globalThis.bopsCloud;
const billedBy = (billing) => (cloudBox.session = { key: "sk_test_size", value: { userId: "u_size", plan: { tier: "free_bops", billing, limits: true } } });
const main = () => S.bot("boppy");
const noComputer = () => {
  L.forgetPlan();
  S.update((s) => {
    Object.assign(s.bots.find((b) => b.id === "boppy"), { computerId: undefined, computerStatus: "none", freeComputer: undefined, computerRam: undefined });
    s.computerSize = undefined;
    s.computerSizeChosenAt = undefined;
    s.sessions = [];
  });
};
const noDashes = (text) => assert.doesNotMatch(text, /[–—]|Orbit/, `no dashes, never Orbit: ${text}`);

let passed = 0;
let n;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

/* ---------------- Reading the sizes (lib/bops-billing.ts) ---------------- */

await test("the sizes, the computer's own and how it's switched, read flat or nested; sizes this app doesn't know are left out", async () => {
  fresh({ computer: { id: "c-1", size: "medium", status: "running" } });
  const flat = B.usageTermsIn(planAnswer(), "https://orgo.test");
  assert.deepEqual(flat.sizes, [
    { key: "medium", name: "Medium", cpu: 2, ramGb: 8, diskGb: 80, hourlyCents: 5.5 },
    { key: "large", name: "Large", cpu: 4, ramGb: 16, diskGb: 80, hourlyCents: 11 },
  ]);
  assert.equal(flat.defaultSize, "medium");
  assert.deepEqual([flat.computer.key, flat.computer.id, flat.computer.change, flat.computer.hourlyCents, flat.computer.size], ["medium", "c-1", "bops", 5.5, "Medium"]);
  // Only orgo-web's nested names: the same terms.
  const { usage } = planAnswer();
  const nested = B.usageTermsIn({ billing: "usage", usage: { ...usage, computer_sizes: [{ size: "small", name: "Small", running_cents_per_hour: 2.3 }, ...usage.computer_sizes, { size: "large", running_cents_per_hour: 99 }] } }, "https://orgo.test");
  assert.deepEqual(nested.sizes, flat.sizes, "a size this app doesn't know yet (small) is left out, and each size once");
  assert.deepEqual([nested.computer.key, nested.computer.id, nested.computer.change], ["medium", "c-1", "bops"]);
  // An orgo-web from before sizes: none, so nothing is offered, and its computer is the Large it always was.
  const old = B.usageTermsIn({ billing: "usage", computer: { size: "Large", hourlyCents: 11, asleepFree: true } }, "https://orgo.test");
  assert.equal(old.sizes, undefined);
  assert.equal(old.defaultSize, undefined);
  assert.deepEqual(old.computer, { size: "Large", hourlyCents: 11, asleepFree: true }, "read as before, nothing added");
  assert.equal(old.computer.change, undefined);
  // No computer yet; switched by Orgo's resize (a yes from an orgo-web that switches every size that way).
  assert.equal(B.usageTermsIn({ billing: "usage", usage: { computer: { id: null } } }, "x").computer.id, null);
  assert.equal(B.usageTermsIn({ billing: "usage", computer: { change: "plan" } }, "x").computer.change, "plan");
  assert.equal(B.usageTermsIn({ billing: "usage", computer: { change: true } }, "x").computer.change, "plan");
  assert.equal(B.usageTermsIn({ billing: "usage", computer: { change: null } }, "x").computer.change, null);
});

await test("prices to the tenth of a cent, and about how long $5 runs each size, rounded down", async () => {
  assert.deepEqual([5.5, 11, 12, 10, 5.8, 100, 150].map(B.rateText), ["$0.055", "$0.11", "$0.12", "$0.10", "$0.058", "$1", "$1.50"]);
  assert.equal(B.centsText(5.5), "$0.06", "why rateText: cents to the cent would say $0.06");
  assert.deepEqual([B.hoursFor(5.5), B.hoursFor(11), B.hoursFor(11, 7), B.hoursFor(60), B.hoursFor(0)], [90, 45, 0, 8, 0]);
});

await test("the words: each size with Orgo's price and hours, Settings' line, the question before a switch; never a price on the Orgo plan", async () => {
  fresh();
  const [m, l] = B.usageTermsIn(planAnswer(), "x").sizes;
  assert.deepEqual(W.offerWords(m), { name: "Medium", specs: "2 cores, 8 GB", price: "$0.055 an hour", lasts: "$5 runs it for about 90 hours.", blurb: "Good for most tasks." });
  assert.deepEqual(W.offerWords(l), { name: "Large", specs: "4 cores, 16 GB", price: "$0.11 an hour", lasts: "$5 runs it for about 45 hours.", blurb: "Faster, with smoother screen video." });
  assert.equal(W.settingsHint(m, "bops"), "Medium: 2 cores, 8 GB, 80 GB. $0.055 an hour while it works.");
  assert.equal(W.settingsHint(l, "plan"), "Large: 4 cores, 16 GB, 80 GB. Part of your Orgo plan.");
  assert.deepEqual(W.confirmWords(l, "bops"), { title: "Switch to Large?", line: "Large costs $0.11 an hour while it works. Your computer may restart, and anything open on it may close.", action: "Switch" });
  assert.deepEqual(W.confirmWords(m, "plan"), { title: "Switch to Medium?", line: "Your computer may restart, and anything open on it may close.", action: "Switch" });
  assert.equal(W.doneWords(m), "Your computer is Medium now.");
  // On the Orgo plan the card names no price and no hours: what it costs is the plan's.
  assert.deepEqual(W.offerWords(l, "plan"), { name: "Large", specs: "4 cores, 16 GB", price: "", lasts: "Part of your Orgo plan.", blurb: "Faster, with smoother screen video." });
  assert.deepEqual(W.offerWords(m, "bops"), W.offerWords(m));
  assert.doesNotMatch(W.PICK_WORDS.planLine, /pay/);
  assert.equal(W.RESTART_WORDS, "Your computer may restart, and anything open on it may close.");
  // Orgo's own prices, whatever they are: nothing here names one.
  assert.equal(W.offerWords({ ...m, hourlyCents: 6 }).lasts, "$5 runs it for about 80 hours.");
  for (const t of [...Object.values(W.PICK_WORDS), ...Object.values(W.offerWords(l, "plan")), W.RESTART_WORDS, ...Object.values(W.PHASE_WORDS), ...Object.values(W.SIZE_REFUSED).map((x) => (typeof x === "function" ? x(l) : x)), ...Object.values(W.offerWords(m)), W.settingsHint(m, "bops"), W.confirmWords(l, "bops").line])
    noDashes(t);
});

await test("a computer that changed size is said with its id, so only its live views stream afresh", async () => {
  globalThis.window = new EventTarget();
  try {
    const heard = [];
    const stop = W.onComputerResized((id) => heard.push(id));
    W.computerResized("c-1");
    W.computerResized();
    stop();
    W.computerResized("c-2");
    assert.deepEqual(heard, ["c-1", undefined], "the id when said, none otherwise; nothing after stop");
  } finally {
    delete globalThis.window;
  }
});

/* ---------------- The size a new computer is made at (plan.ts makeFree) ---------------- */

const lastCreate = () => asked("POST", "/api/computers").at(-1)?.body;

await test("billed by use, someone new: made at Orgo's default (Medium); one they picked first, at that; Bops' plans and an orgo-web before sizes: no size sent, so Large", async () => {
  billedBy("usage");
  fresh();
  noComputer();
  assert.deepEqual({ ...(await L.makeMainComputer(main(), "boppy-a")) }, { id: "c-free-1", free: true });
  assert.equal(lastCreate().bops_free, true);
  assert.equal(lastCreate().bops_size, "medium", "Orgo's default for someone new");
  assert.equal(o.computer.size, "medium");

  fresh();
  noComputer();
  S.update((s) => {
    s.computerSize = "large";
    s.computerSizeChosenAt = Date.now();
  });
  await L.makeMainComputer(main(), "boppy-b");
  assert.equal(lastCreate().bops_size, "large", "the one they picked");

  // An orgo-web before sizes: nothing sent, and nothing breaks.
  fresh({ sizes: false });
  noComputer();
  await L.makeMainComputer(main(), "boppy-c");
  assert.equal("bops_size" in lastCreate(), false);
  assert.equal(o.computer.size, "large");

  // Bops' plans (until a user moves): today's create, word for word.
  billedBy("plan");
  fresh({ billing: "plan" });
  noComputer();
  await L.makeMainComputer(main(), "boppy-d");
  assert.deepEqual(lastCreate(), { workspace_id: "ws_bops", name: "boppy-d", template_ref: "system/bops-base@0.1.11", bops_free: true });
  billedBy("usage");

  // Orgo turns the size down (taken out since): made again without one, as Large.
  fresh({ refuseSize: true });
  noComputer();
  assert.equal((await L.makeMainComputer(main(), "boppy-e")).free, true);
  const two = asked("POST", "/api/computers").slice(-2).map((c) => c.body.bops_size);
  assert.deepEqual(two, ["medium", undefined]);
});

await test("the computer's size is kept from Orgo's read (so one made again comes back the same), and with none yet the wake check is the size it'll be", async () => {
  fresh({ computer: { id: "c-old", size: "large", status: "running" } });
  noComputer();
  await L.readBopsPlan("sk_test_size");
  assert.equal(S.getState().computerSize, "large", "an existing user's Large is kept");
  assert.equal(S.getState().computerSizeChosenAt, undefined, "but not answered for them");
  // None yet, with $0.06 left: Large's hour doesn't fit, Medium's does.
  fresh({ credit: 6 });
  noComputer();
  let plan = await L.readBopsPlan("sk_test_size");
  assert.equal(plan.usage.computer.hourlyCents, 5.5, "Medium, Orgo's default, is what it would be made at");
  assert.equal(B.canWake(plan.usage), true);
  S.update((s) => (s.computerSize = "large"));
  plan = await L.readBopsPlan("sk_test_size");
  assert.equal(plan.usage.computer.hourlyCents, 11);
  assert.equal(B.canWake(plan.usage), false);
});

/* ---------------- Pick your computer: asked or not (fail open) ---------------- */

const view = async (q = "") => (await R.GET(new Request(`http://localhost:3210/api/computer/size${q}`))).json();

await test("Pick your computer is asked of a user billed by use until they answer it: Medium first for someone new, an existing user's own Large first; never otherwise", async () => {
  billedBy("usage");
  fresh();
  noComputer();
  let v = await view();
  assert.deepEqual([v.needed, v.current, v.preselect, v.sizes.map((s) => s.key)], [true, null, "medium", ["medium", "large"]]);
  fresh({ computer: { id: "c-old", size: "large", status: "running" } });
  v = await view();
  assert.deepEqual([v.needed, v.current, v.preselect, v.change], [true, "large", "large", "bops"]);
  // Answered on this account (any Mac of theirs): never again.
  S.update((s) => (s.computerSizeChosenAt = Date.now()));
  assert.equal((await view()).needed, false);
  S.update((s) => (s.computerSizeChosenAt = undefined));
  // An orgo-web before sizes, Bops' plans, or a plan read that didn't come: nothing to pick, nothing in the way.
  fresh({ sizes: false, computer: { id: "c-old", size: "large", status: "running" } });
  assert.equal((await view()).needed, false);
  billedBy("plan");
  fresh({ billing: "plan" });
  n = calls.length;
  assert.equal((await view()).needed, false);
  assert.equal(calls.length, n, "Bops' plans: Orgo isn't even asked");
  billedBy("usage");
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  assert.equal((await view()).needed, false);
  globalThis.fetch = real;
  // How far a switch has got, without asking Orgo.
  n = calls.length;
  assert.equal((await view("?phase=1")).needed, false);
  assert.equal(calls.length, n);
});

/* ---------------- Switching (lib/server/computer-size.ts) ---------------- */

const post = async (size, more = {}) => {
  const res = await R.POST(new Request("http://localhost:3210/api/computer/size", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size, ...more }) }));
  return { status: res.status, ...(await res.json()) };
};

await test("Continue on the computer's own size (keep) is answered without asking Orgo, so a plan read that fails never holds the card up", async () => {
  billedBy("usage");
  fresh({ computer: { id: "c-keep", size: "large", status: "running" } });
  noComputer();
  n = calls.length;
  const r = await post("large", { keep: true });
  assert.deepEqual([r.status, r.ok, r.changed, r.size, r.computerId], [200, true, false, "large", undefined]);
  assert.equal(calls.length, n, "nothing asked of Orgo");
  assert.equal(S.getState().computerSize, "large");
  assert.ok(S.getState().computerSizeChosenAt);
  assert.equal((await view()).needed, false, "answered on this account");
  assert.equal((await post("tiny", { keep: true })).status, 400, "only a size this app knows");
});

await test("no computer yet: the size is kept as the one it's made at, and the account has answered", async () => {
  billedBy("usage");
  fresh();
  noComputer();
  const r = await post("large");
  assert.deepEqual([r.status, r.ok, r.changed], [200, true, false]);
  assert.equal(asked("POST", "/api/bops/computer/size").length, 0, "none asked yet");
  assert.equal(S.getState().computerSize, "large");
  assert.ok(S.getState().computerSizeChosenAt);
  assert.equal((await post("tiny")).status, 400, "only a size this app knows");
});

await test("Continue on the computer's own size changes nothing; the other size switches it through Orgo's Bops switch, and the stream is asked afresh", async () => {
  fresh({ computer: { id: "c-big", size: "large", status: "running" }, webrtcRefuse: true });
  noComputer();
  n = asked("POST", "/api/bops/computer/size").length;
  let r = await post("large");
  assert.deepEqual([r.ok, r.changed], [true, false]);
  assert.equal(asked("POST", "/api/bops/computer/size").length, n);
  // WebRTC turned down once (a Medium can't), so it isn't asked again for 10 minutes...
  await O.orgo.webrtc("c-big", { webrtc: null, running: true }).catch(() => {});
  n = asked("POST", "/api/computers/c-big/webrtc").length;
  assert.equal(await O.orgo.webrtc("c-big", { webrtc: null, running: true }), false);
  assert.equal(asked("POST", "/api/computers/c-big/webrtc").length, n);
  r = await post("medium");
  assert.deepEqual([r.status, r.ok, r.changed, r.size, r.computerId], [200, true, true, "medium", "c-big"], "the computer's id, so only its live views stream afresh");
  assert.deepEqual(asked("POST", "/api/bops/computer/size").at(-1).body, { size: "medium" });
  assert.equal(o.computer.size, "medium");
  assert.equal(S.getState().computerSize, "medium");
  // ...but after a switch it is.
  o.webrtcRefuse = false;
  assert.equal(await O.orgo.webrtc("c-big", { webrtc: null, running: true }), true);
});

await test("asleep: woken, then switched; too little credit to wake it says so", async () => {
  fresh({ computer: { id: "c-z", size: "large", status: "suspended" } });
  noComputer();
  n = asked("POST", "/api/bops/computer/size").length;
  const r = await post("medium");
  assert.deepEqual([r.ok, r.changed], [true, true]);
  assert.equal(asked("POST", "/api/computers/c-z/resume").length, 1);
  assert.equal(asked("POST", "/api/bops/computer/size").length - n, 2, "asked, woken, asked again");
  fresh({ computer: { id: "c-z", size: "large", status: "suspended" }, credit: 3 });
  const no = await post("medium");
  assert.deepEqual([no.status, no.error], [402, "Add Orgo credit to wake your computer, then switch."]);
  assert.equal(o.computer.size, "large");
});

await test("memory too full for Medium: restarted once, then switched; never while a bot is working on it", async () => {
  fresh({ computer: { id: "c-r", size: "large", status: "running" }, ramInUse: true });
  noComputer();
  S.update((s) => {
    Object.assign(s.bots.find((b) => b.id === "boppy"), { computerId: "c-r", computerStatus: "ready", freeComputer: true });
    s.sessions = [{ id: "ses_w", botId: "boppy", chatId: "bot:boppy", title: "Work", goal: "Work", status: "running", runsOn: "cloud", steps: [], replies: [], createdAt: Date.now() }];
  });
  const busy = await post("medium");
  assert.deepEqual([busy.status, busy.error], [409, "Your bots are working on it. Switch when they finish."]);
  assert.equal(asked("POST", "/api/computers/c-r/restart").length, 0);
  S.update((s) => (s.sessions = []));
  const r = await post("medium");
  assert.deepEqual([r.ok, r.changed], [true, true]);
  assert.equal(asked("POST", "/api/computers/c-r/restart").length, 1);
  assert.equal(o.computer.size, "medium");
});

await test("want of credit for Large, in the app's words with Orgo's top up; refusals of every other kind leave it as it was", async () => {
  fresh({ computer: { id: "c-m", size: "medium", status: "running" }, credit: 5 });
  noComputer();
  const r = await post("large");
  assert.deepEqual([r.status, r.error, r.topUpUrl], [402, "Add Orgo credit to switch to Large. You need enough for an hour.", "https://orgo.test/settings/billing"]);
  assert.equal(S.getState().computerSizeChosenAt, undefined, "not answered: nothing changed");
  o.credit = 400;
  o.sizeAnswers.push(() => json(409, { error: "Your computer is still being set up.", code: "bops_size_pending" }));
  assert.equal((await post("large")).error, "Your computer is still being set up. You can switch in a minute.");
  o.sizeAnswers.push(() => json(409, { error: "Your plan's computer keeps its size.", code: "bops_size_unavailable" }));
  assert.equal((await post("large")).error, "Your plan's computer keeps its size.");
  o.sizeAnswers.push(() => json(502, { error: "host", code: "bops_size_failed" }));
  assert.deepEqual(await post("large").then((x) => [x.status, x.error]), [502, "Couldn't change your computer's size. Try again in a minute."]);
  // An orgo-web that lists sizes but has no switch yet (404, no code): the same plain words.
  o.sizeAnswers.push(() => json(404, { error: "Not found" }));
  assert.equal((await post("large")).error, "Couldn't change your computer's size. Try again in a minute.");
  assert.equal(o.computer.size, "medium");
  // Still being set up, by the plan read: nothing asked.
  o.computer.change = null;
  n = asked("POST", "/api/bops/computer/size").length;
  assert.equal((await post("large")).error, "Your computer is still being set up. You can switch in a minute.");
  assert.equal(asked("POST", "/api/bops/computer/size").length, n);
});

await test("part of the Orgo plan: Orgo's own resize, with the plan's own words when it says no; a Bops switch that finds it on the plan goes there too", async () => {
  fresh({ computer: { id: "c-p", size: "large", status: "running", change: "plan" } });
  noComputer();
  n = asked("POST", "/api/bops/computer/size").length;
  let r = await post("medium");
  assert.deepEqual([r.ok, r.changed], [true, true]);
  assert.deepEqual(asked("PATCH", "/api/computers/c-p/resize").at(-1).body, { size: "medium" });
  assert.equal(asked("POST", "/api/bops/computer/size").length, n);
  o.planRefuse = true;
  r = await post("large");
  assert.deepEqual([r.status, r.error], [409, "Your plan has no memory left for that size."]);
  o.planRefuse = false;
  fresh({ computer: { id: "c-p2", size: "large", status: "running" } });
  o.sizeAnswers.push(() => json(409, { error: "Your computer is part of your Orgo plan.", code: "bops_size_on_plan", next: { method: "PATCH", path: "/api/computers/c-p2/resize", body: { size: "medium" } } }));
  r = await post("medium");
  assert.deepEqual([r.ok, r.changed], [true, true]);
  assert.equal(asked("PATCH", "/api/computers/c-p2/resize").length, 1);
});

await test("Bops' plans never switch; one switch at a time", async () => {
  billedBy("plan");
  fresh({ billing: "plan", computer: { id: "c-x", size: "large", status: "running" } });
  const r = await post("medium");
  assert.deepEqual([r.status, r.error], [409, "Your plan's computer keeps its size."]);
  billedBy("usage");
  fresh({ computer: { id: "c-y", size: "large", status: "running" } });
  let release;
  o.sizeAnswers.push(() => new Promise((res) => (release = () => res(json(200, { size: "medium", changed: true })))));
  const first = post("medium");
  for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await view("?phase=1")).switching, "switching");
  const second = await post("large");
  assert.deepEqual([second.status, second.error], [409, "Your computer is already switching. Try again in a minute."]);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await view("?phase=1")).switching, undefined);
});

console.log(`computer size: ${passed} passed (${calls.length} fake Orgo calls, none to the network)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
