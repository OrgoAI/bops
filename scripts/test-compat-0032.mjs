// What a Bops from before this one (v0.0.32, the release out now, on the user's other Macs and on the bots' computers'
// runners) does to the fields this build adds, run with v0.0.32's own code: its merge3 (lib/server/state-merge.ts) and
// its cleanAccess (cloud/member-access.ts), taken from the v0.0.32 tag with git. Each case is one the user meets: an
// older Bops that saves something else, that changes the same bot before it has the newer state (an email noted, its
// call voice kept), that rewrites a person's access on its People sheet.
//
// - A bot's settings page settings (Workspace.botSettings, lib/types.ts BotSettings) live on its workspace, which
//   v0.0.32 merges field by field and never writes: they're kept in every case, the same bot changed on both sides too
//   (a bot's own fields would go there: v0.0.32 keeps its whole copy of a bot changed on both sides).
// - What each phone line speaks in (Workspace.lineVoices): a workspace field too, kept in every case; v0.0.32 sets no
//   voice on AgentPhone, so the one this build set holds whichever Mac answers a call.
// - A person's Your Apps level (MemberAccess.apps): v0.0.32 keeps it whenever it saves something else; its People
//   sheet drops it (cleanAccess knows only others and bots), and this build's next merge puts it back (keepAppsLevels).
//   An entry is kept only with a bot, by this build as by v0.0.32 (showsAny), so v0.0.32's saves never delete one.
//
// - Used in (Workspace.loginsOn, lib/types.ts levelOf and usedIn, lib/server/logins.ts): a login switched on in more
//   workspaces lives on the workspace that uses it. v0.0.32 keeps it in every save (a workspace goes field by field), its
//   syncApps never touches it (it drops and adds accounts only), and its own levelOf, grantsOn and keysOf, run on a state
//   that has it, give exactly what this build gives without it: losing it is back to today, less access and never more.
//   A saved site login keeps nothing new (its bots list says where it's used), and v0.0.32's loginsFor agrees with it.
//
// - An app's Local and Staging (Your Apps' three environments, all on the app's bot computer): nothing of either is
//   kept in Bops' state. Staging is a second deploy project of each site on the computer, found there by its name
//   every time; Local is written on the computer. The app's record (Workspace.hostedApps, one field v0.0.32 merges
//   field by field) has exactly v0.0.32's fields, so a v0.0.32 Mac saving it, merging it or rebuilding it (its
//   movedTo) can't lose anything of Staging: at worst a Staging project it left behind on another computer isn't
//   listed there, and this build makes a new one where the app is. v0.0.32's own deploy (its makeProject) finds
//   Prod's project by name, never Staging's, while Prod's is there, and this build makes Prod's before Staging's.
//
// Pure functions, and v0.0.32's own modules loaded from the tag (lib/types.ts, lib/server/composio.ts's syncApps,
// lib/server/keys.ts, lib/server/vault.ts, cloud/computer-scope.ts) with the services they reach faked: nothing reaches
// Bops Cloud, Composio or Orgo. Without the v0.0.32 tag here (a shallow clone), it says so and stops.
// Usage: node scripts/test-compat-0032.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fill } from "./fake-exports.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TAG = "v0.0.32";
const old = (path) => {
  try {
    return execFileSync("git", ["-C", root, "show", `${TAG}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const merge32 = old("lib/server/state-merge.ts");
const access32 = old("cloud/member-access.ts");
if (!merge32 || !access32) {
  console.log(`compat ${TAG}: skipped, no ${TAG} tag in this clone (git fetch --tags)`);
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), "bops-test-compat-"));
writeFileSync(join(dir, "state-merge.ts"), merge32);
writeFileSync(join(dir, "member-access.ts"), access32);
const V32 = await import(join(dir, "state-merge.ts"));
const A32 = await import(join(dir, "member-access.ts"));
const NOW = await import(`${root}/lib/server/state-merge.ts`);

/*
 * v0.0.32's own modules, as they are at the tag: a file one of them imports is written from the tag into `tree` (the
 * repo's layout) as it's first asked for, so each runs with v0.0.32's lib/types.ts and the rest of its own code. What
 * a server module reaches (its store, Bops Cloud, Composio, Orgo) is faked: OLD_FAKES by module, the rest of each one's
 * exports stand ins that throw (fake-exports.mjs). This build's lib/server/logins.ts runs with a fake store the same way.
 */
const tree = join(dir, "tree");
mkdirSync(tree, { recursive: true });
const treeUrls = [...new Set([pathToFileURL(tree).href, pathToFileURL(realpathSync(tree)).href])].map((u) => `${u}/`);
const inTree = (url) => !!url && treeUrls.some((u) => url.startsWith(u));
const relIn = (url) => decodeURIComponent(url.slice(treeUrls.find((u) => url.startsWith(u)).length));
/** v0.0.32's file at repo path `rel` (with .ts, .tsx or /index.ts when it has no extension), written into the tree: its URL, or null. */
const fromTag = (rel) => {
  for (const p of /\.[a-z]+$/.test(rel) ? [rel] : [`${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`]) {
    const src = old(p);
    if (src === null) continue;
    const file = join(tree, p);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, src);
    return pathToFileURL(file).href;
  }
  return null;
};
const forward = (mod, names) => names.map((n) => `export const ${n} = (...a) => globalThis.__f32[${JSON.stringify(mod)}].${n}(...a);`).join("\n");
/** v0.0.32's server modules under test reach these (globalThis.__f32, set per check). */
const OLD_FAKES = {
  store: forward("store", ["getState", "update", "bot", "addMessage", "installId", "ownerName", "session", "id", "patchSession", "stateUser", "sameState", "flushState"]),
  cloud: forward("cloud", ["cloudOn", "cloudProxy", "cloudSession", "cloudSessionNow", "cloudUrl"]),
  persist: "export const onRunner = () => false; export const selfHosted = () => false;",
  "orgo-auth": "export const loadOrgoKey = async () => 'sk_test';",
  ingot: [
    "export const isRepoName = (s) => typeof s === 'string' && s.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);",
    "export const ingotWorkspace = () => globalThis.__f32.ingot.workspace;",
    "export const hasToken = () => true;",
    "export const msOf = (v) => { const t = typeof v === 'number' ? v : Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };",
    "export const ingot = { repos: async () => [] };",
    "export class IngotError extends Error {}",
    "export const SWAPPED = 'Another account signed in meanwhile, so that stopped.';",
    "export const NO_PROJECT = 'Not on Orgo yet.';",
    "export const dropToken = async () => {};",
  ].join("\n"),
  analytics: "export const trackServerEvent = () => {};",
  "app-version": "export const appHeaders = () => ({}); export const orgoHeaders = () => ({});",
  "access-sync": "export const logUse = () => {}; export const accessChanged = () => {}; export const targetNameOf = (a) => a.appName; export const viaOf = () => ({ via: 'chat' });",
  orgo: [
    "export const apiKey = async () => 'sk_test';",
    "const o = (k) => new Proxy({}, { get: (_, m) => (...a) => globalThis.__f32.orgo[k][m](...a) });",
    "export const deploys = o('deploys');",
    "export const domains = o('domains');",
    "export class OrgoError extends Error { constructor(m, status, code, said) { super(m); this.status = status; this.code = code; this.said = said; } }",
    "export class OrgoTimeout extends Error {}",
    "export const deployedAt = (d) => d?.at ?? d?.source_version ?? d?.commit_sha ?? null;",
  ].join("\n"),
};
/** This build's lib/server/logins.ts and keys.ts reach these; the rest of each one's exports throw. */
const NOW_FAKES = {
  store: forward("store", ["getState", "update"]),
  "access-sync": "export const accessChanged = () => {};",
};
const NOW_FAKED = /^\.\/(store|access-sync|permission|app-version|orgo|orgo-auth)$/;
const COMPOSIO = "export class Composio { constructor() { return globalThis.__f32.composio; } }";
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? "";
    if (specifier === "server-only") return { url: "fake32:empty", shortCircuit: true };
    if (inTree(parent)) {
      if (specifier === "@composio/core") return { url: "fake32:composio", shortCircuit: true };
      const rel = specifier.startsWith("@/") ? specifier.slice(2) : /^\.{1,2}\//.test(specifier) ? new URL(specifier, `file:///${relIn(parent)}`).pathname.slice(1) : null;
      if (rel === null) return next(specifier, { ...context, parentURL: pathToFileURL(`${root}/package.json`).href });
      const url = fromTag(rel);
      if (!url) throw new Error(`${TAG} has no ${rel}`);
      const name = /^lib\/server\/([a-z-]+)\.ts$/.exec(relIn(url))?.[1];
      if (name && !["composio", "keys", "vault"].includes(name)) return { url: `fake32:${name}?${url}`, shortCircuit: true };
      return { url, shortCircuit: true };
    }
    if (/\/lib\/server\/(logins|keys)\.ts$/.test(parent) && NOW_FAKED.test(specifier)) return { url: `fakenow:${specifier.slice(2)}?${new URL(`${specifier}.ts`, parent).href}`, shortCircuit: true };
    // This build's own files: "@/" is the repo, and an import without its extension is its .ts or .tsx.
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
    if (url === "fake32:empty") return { format: "module", source: "export {};", shortCircuit: true };
    if (url === "fake32:composio") return { format: "module", source: COMPOSIO, shortCircuit: true };
    if (url.startsWith("fake32:")) {
      const [name, real] = [url.slice(7, url.indexOf("?")), url.slice(url.indexOf("?") + 1)];
      return { format: "module", source: fill(name, real, OLD_FAKES[name] ?? ""), shortCircuit: true };
    }
    if (url.startsWith("fakenow:")) {
      const [name, real] = [url.slice(8, url.indexOf("?")), url.slice(url.indexOf("?") + 1)];
      return { format: "module", source: fill(name, real, NOW_FAKES[name] ?? ""), shortCircuit: true };
    }
    return next(url, context);
  },
});
const T32 = await import(fromTag("lib/types.ts"));
const CS32 = await import(fromTag("cloud/computer-scope.ts"));
const C32 = await import(fromTag("lib/server/composio.ts"));
const K32 = await import(fromTag("lib/server/keys.ts"));
const VT32 = await import(fromTag("lib/server/vault.ts"));
const T = await import(`${root}/lib/types.ts`);
const CS = await import(`${root}/cloud/computer-scope.ts`);
const L = await import(`${root}/lib/server/logins.ts`);
const K = await import(`${root}/lib/server/keys.ts`);

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const checkAsync = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};
const clone = (x) => JSON.parse(JSON.stringify(x));
/** An older Bops's kept copy (persist-cloud.ts buildKept), as v0.0.32's merge3 takes it. */
const KEPT = { device: "dev_old_mac", older: true };

/* ---------------- A bot's settings page settings ---------------- */

const SET = { callVoice: "sage", answersCalls: false, sequencesOff: { othersMail: true, othersCalls: true }, mailNever: true };
const ASK = { action: "Send an email", resource: "*", effect: "ask" };
const base0 = {
  owner: { name: "Ava" },
  workspace: "ws_main",
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  bots: [
    { id: "sam", isMain: true, name: "Sam", voice: "cedar" },
    { id: "juno", name: "Juno", voice: "marin", mail: { inboxId: "in_1", podId: "p", seenAt: 1 } },
  ],
  chats: [],
};
/** The newer Bops's state: Juno's settings set, and the ask rule Never keeps for older Bops. */
const withSet = (s) => {
  const x = clone(s);
  x.workspaces[0].botSettings = { juno: SET };
  x.bots[1].permissions = [ASK];
  return x;
};
/** Juno's settings where lib/types.ts settingsOf reads them: its workspace's botSettings, by its id. */
const junoSet = (st) => st.workspaces.find((w) => w.id === "ws_main")?.botSettings?.juno ?? {};

check("v0.0.32 saving something else keeps a bot's settings", () => {
  const base = withSet(base0);
  const mine = clone(base);
  mine.owner.name = "Ava B";
  assert.deepEqual(junoSet(V32.merge3(clone(base), mine, clone(base))), SET);
});
check("v0.0.32 saving while the newer Bops set them keeps them", () => {
  const mine = clone(base0);
  mine.owner.name = "Ava B";
  assert.deepEqual(junoSet(V32.merge3(clone(base0), mine, withSet(base0))), SET);
});
check("v0.0.32 noting an email for the same bot before it pulled keeps them", () => {
  // The case a bot's own fields lose: v0.0.32 keeps its whole copy of a bot changed on both sides.
  const mine = clone(base0);
  mine.bots[1].mail.seenAt = 2;
  const r = V32.merge3(clone(base0), mine, withSet(base0));
  assert.deepEqual(junoSet(r), SET);
  assert.equal(r.bots[1].mail.seenAt, 2, "and its own change stands");
});
check("v0.0.32 keeping the same bot's voice (its voiceFor) keeps them, and never touches the picked one", () => {
  const mine = clone(base0);
  mine.bots[1].voice = "coral";
  const r = V32.merge3(clone(base0), mine, withSet(base0));
  assert.deepEqual(junoSet(r), SET);
  assert.equal(r.bots[1].voice, "coral", "Bot.voice is v0.0.32's, as before");
});
check("v0.0.32 renaming the same workspace keeps them (a workspace goes field by field)", () => {
  const mine = clone(base0);
  mine.workspaces[0].name = "Acme";
  const r = V32.merge3(clone(base0), mine, withSet(base0));
  assert.deepEqual(junoSet(r), SET);
  assert.equal(r.workspaces[0].name, "Acme");
});
check("a copy v0.0.32 kept, merged in later, keeps them", () => {
  const mine = clone(base0);
  mine.bots[1].mail.seenAt = 2;
  assert.deepEqual(junoSet(V32.merge3(clone(base0), mine, withSet(base0), KEPT)), SET);
});
check("loaded and written back by v0.0.32, they ride along", () => {
  assert.deepEqual(junoSet(V32.toShared(V32.fromShared(withSet(base0), "dev_old_mac"), "dev_old_mac")), SET);
});
check("v0.0.32 rewriting the same bot's rules: Never stays Never; it reads the ask rule as ask", () => {
  const mine = clone(base0);
  mine.bots[1].permissions = [{ action: "Call Stripe", resource: "*", effect: "allow" }];
  const r = V32.merge3(clone(base0), mine, withSet(base0));
  assert.equal(junoSet(r).mailNever, true);
});
check("this build's merge: two Macs setting different bots' settings keep both", () => {
  const base = clone(base0);
  const mine = clone(base0);
  mine.workspaces[0].botSettings = { sam: { callVoice: "ash" } };
  const theirs = withSet(base0);
  const r = NOW.merge3(base, mine, theirs);
  assert.deepEqual(r.workspaces[0].botSettings, { sam: { callVoice: "ash" }, juno: SET });
});

/* ---------------- A phone line's voice ---------------- */

// What each line's agent speaks in (Workspace.lineVoices, lib/server/phone.ts voiceToAgent): a workspace field, which
// v0.0.32 merges field by field and never writes. Its own Bops sets no voice on AgentPhone (its lineUpkeep routes calls,
// its renameAgents sets a name), so the voice set stays on AgentPhone whichever Mac answers; a number v0.0.32 makes
// speaks in the line's own voice until this build's next start sets it (and the page says the line's own meanwhile).
const LV = { agt_ws: { for: "sage", id: "11labs-Laura", name: "Laura" } };
const withLv = (s) => {
  const x = clone(s);
  x.workspaces[0].lineVoices = LV;
  return x;
};
check("v0.0.32 saving something else, or the same bot, keeps what each line speaks in", () => {
  const mine = clone(base0);
  mine.owner.name = "Ava B";
  mine.bots[1].mail.seenAt = 2;
  mine.bots[0].voice = "ash";
  assert.deepEqual(V32.merge3(clone(base0), mine, withLv(base0)).workspaces[0].lineVoices, LV);
  const base = withLv(base0);
  const later = clone(base);
  later.owner.name = "Ava C";
  assert.deepEqual(V32.merge3(clone(base), later, clone(base)).workspaces[0].lineVoices, LV);
});
check("v0.0.32 renaming the same workspace keeps them, and so does loading and writing back", () => {
  const mine = clone(base0);
  mine.workspaces[0].name = "Acme";
  const r = V32.merge3(clone(base0), mine, withLv(base0));
  assert.deepEqual(r.workspaces[0].lineVoices, LV);
  assert.equal(r.workspaces[0].name, "Acme");
  assert.deepEqual(V32.toShared(V32.fromShared(withLv(base0), "dev_old_mac"), "dev_old_mac").workspaces[0].lineVoices, LV);
});

/* ---------------- A person's Your Apps level ---------------- */

const AVA = "ava@acme.example";
const access = (apps, bots = { sam: "read" }) => ({ others: "none", bots, at: 100, ...(apps ? { apps } : {}) });
const blob = (map) => ({ ...clone(base0), workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, memberAccess: map }] });
const appsOf = (b) => b.workspaces[0].memberAccess?.[AVA]?.apps;
/** v0.0.32's People sheet saving Ava's entry: its cleanAccess, then when and how it was set. */
const sheet32 = (state, bots) => {
  const s = clone(state);
  const clean = A32.cleanAccess({ ...s.workspaces[0].memberAccess[AVA], bots });
  s.workspaces[0].memberAccess = { ...s.workspaces[0].memberAccess, [AVA]: { ...clean, at: 200 } };
  return s;
};

check("v0.0.32 saving something else keeps Your Apps", () => {
  const base = blob({ [AVA]: access("write") });
  const mine = clone(base);
  mine.owner.name = "Ava B";
  assert.equal(appsOf(V32.merge3(clone(base), mine, clone(base))), "write");
});
check("v0.0.32 saving while the newer Bops set Your Apps keeps it", () => {
  const base = blob({ [AVA]: access(undefined) });
  const mine = clone(base);
  mine.owner.name = "Ava B";
  assert.equal(appsOf(V32.merge3(clone(base), mine, blob({ [AVA]: access("write") }))), "write");
});
check("v0.0.32's cleanAccess drops Your Apps; this build's next merge puts it back", () => {
  const base = blob({ [AVA]: access("write") });
  assert.equal(A32.cleanAccess(access("write")).apps, undefined, "v0.0.32 knows only others and bots");
  // The older Mac gives Ava a second bot on its People sheet: its save loses the level.
  const older = sheet32(base, { sam: "read", juno: "read" });
  assert.equal(appsOf(older), undefined);
  // This build pulls: its own copy (mine) still has the level, the cloud's (theirs) doesn't.
  const r = NOW.merge3(clone(base), clone(base), older);
  assert.equal(appsOf(r), "write", "put back");
  assert.deepEqual(r.workspaces[0].memberAccess[AVA].bots, { sam: "read", juno: "read" }, "with the older Mac's change");
});
check("v0.0.32's save keeps every entry this build keeps: each has a bot (its showsAny), Your Apps only with one", () => {
  // v0.0.32's own rule for keeping an entry (lib/server/workspaces.ts showsAny), from its source.
  const src = old("lib/server/workspaces.ts");
  const rule = /const showsAny = \(a: MemberAccess\) => (.+);/.exec(src ?? "")?.[1];
  assert.ok(rule, "v0.0.32's showsAny");
  const showsAny32 = new Function("a", `return ${rule};`);
  const NOW_SRC = readFileSync(`${root}/lib/server/workspaces.ts`, "utf8");
  const rule0 = /const showsAny = \(a: MemberAccess\) => (.+);/.exec(NOW_SRC)?.[1];
  const showsAnyNow = new Function("a", `return ${rule0};`);
  for (const e of [access("write"), access("read", { sam: "none", juno: "write" }), { others: "read", bots: {}, apps: "write" }, { others: "none", bots: {}, apps: "write" }])
    if (showsAnyNow(e)) assert.ok(showsAny32(A32.cleanAccess(e)), `kept by v0.0.32 too: ${JSON.stringify(e)}`);
  assert.equal(showsAnyNow({ others: "none", bots: {}, apps: "write" }), false, "Your Apps alone isn't an entry");
});

/* ---------------- Used in: a login switched on in more workspaces ---------------- */

const ON = { at: 5 };
/** Two workspaces: Main's Gmail switched on in Fernway, where Juno works; Notion only given to Iris; a channel app. */
const base1 = {
  owner: { name: "Ava" },
  workspace: "ws_main",
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 1, orgoProjectId: "proj-main" },
    { id: "ws_fern", name: "Fernway", createdAt: 2, orgoProjectId: "proj-fern" },
  ],
  bots: [
    { id: "sam", isMain: true, name: "Sam" },
    { id: "iris", name: "Iris", access: { ca_notion: "read" } },
    { id: "juno", name: "Juno", workspaceId: "ws_fern", access: {} },
    { id: "rex", name: "Rex", workspaceId: "ws_fern", access: { ca_gmail: "none" } },
  ],
  accounts: [
    { id: "ca_gmail", app: "gmail", appName: "Gmail", name: "ava@acme.example", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_notion", app: "notion", appName: "Notion", status: "active", at: 1, workspaceId: "ws_main", onlyGiven: true },
    { id: "ca_slack", app: "slackbot", appName: "Slack", status: "active", at: 1, workspaceId: "ws_main" },
  ],
  vault: [{ id: "vl_x", site: "x.com", username: "ava", hasPassword: true, hasTotp: false, bots: "all", auto: true, addedAt: 1 }],
  chats: [],
};
const withOn = (st, map) => {
  const x = clone(st);
  x.workspaces[1].loginsOn = map;
  return x;
};
const larkOn = (st) => st.workspaces.find((w) => w.id === "ws_fern")?.loginsOn;
const GMAIL_ON = { "app:ca_gmail": ON };
/** Every bot's level in every account, by this build (levelIn) and by v0.0.32's own levelOf. */
const levels = (st, f) => Object.fromEntries(st.bots.flatMap((b) => st.accounts.map((a) => [`${b.id}/${a.id}`, f(b, a)])));
const now = (st) => levels(st, (b, a) => T.levelIn(st, b, a));
const was = (st) => levels(st, (b, a) => T32.levelOf(b, a));
const without = (st) => {
  const x = clone(st);
  for (const w of x.workspaces) delete w.loginsOn;
  return x;
};
/** `less` never gives more than `more`, bot by bot and account by account (act is more than read). */
const notMore = (less, more, what) => {
  const rank = { act: 2, read: 1 };
  for (const [k, v] of Object.entries(less)) assert.ok((rank[v] ?? 0) <= (rank[more[k]] ?? 0), `${what}: ${k} is ${v} there, ${more[k]} here`);
};

check("v0.0.32 saving something else keeps a login switched on", () => {
  const base = withOn(base1, GMAIL_ON);
  const mine = clone(base);
  mine.owner.name = "Ava B";
  assert.deepEqual(larkOn(V32.merge3(clone(base), mine, clone(base))), GMAIL_ON);
});
check("v0.0.32 saving while the newer Bops switched one on keeps it", () => {
  const mine = clone(base1);
  mine.owner.name = "Ava B";
  assert.deepEqual(larkOn(V32.merge3(clone(base1), mine, withOn(base1, GMAIL_ON))), GMAIL_ON);
});
check("v0.0.32 renaming the same workspace, or changing one of its bots, keeps it", () => {
  const mine = clone(base1);
  mine.workspaces[1].name = "Fernway Co";
  mine.bots[2].name = "Juno B";
  const r = V32.merge3(clone(base1), mine, withOn(base1, GMAIL_ON));
  assert.deepEqual(larkOn(r), GMAIL_ON);
  assert.equal(r.workspaces[1].name, "Fernway Co");
  assert.deepEqual(larkOn(V32.merge3(clone(base1), mine, withOn(base1, GMAIL_ON), KEPT)), GMAIL_ON, "and a copy it kept, merged in later");
});
check("loaded and written back by v0.0.32, it rides along", () => {
  assert.deepEqual(larkOn(V32.toShared(V32.fromShared(withOn(base1, GMAIL_ON), "dev_old_mac"), "dev_old_mac")), GMAIL_ON);
});
check("this build's merge: two Macs switching different logins on keep both; one switched off stays off", () => {
  const base = withOn(base1, GMAIL_ON);
  const mine = withOn(base1, { ...GMAIL_ON, "app:ca_notion": ON });
  const theirs = withOn(base1, { ...GMAIL_ON, "key:proj-main:STRIPE_SECRET_KEY": ON });
  assert.deepEqual(larkOn(NOW.merge3(clone(base), mine, theirs)), { ...GMAIL_ON, "app:ca_notion": ON, "key:proj-main:STRIPE_SECRET_KEY": ON });
  const off = clone(base1);
  off.workspaces[1].loginsOn = undefined;
  const other = clone(base);
  other.workspaces[1].name = "Fernway Co";
  const r = NOW.merge3(clone(base), JSON.parse(JSON.stringify(off)), other);
  assert.equal(larkOn(r), undefined, "switched off on one Mac, renamed on the other");
  assert.equal(r.workspaces[1].name, "Fernway Co");
});
check("v0.0.32's own levelOf never gives more than this build, and this build without Used in is v0.0.32 exactly", () => {
  for (const map of [GMAIL_ON, { "app:ca_notion": ON, "app:ca_slack": ON }, { "app:ca_gmail": ON, "app:ca_gone": ON }, {}]) {
    const st = withOn(base1, map);
    notMore(was(st), now(st), JSON.stringify(map));
    assert.deepEqual(now(without(st)), was(st), "lost, it's today's");
  }
  const st = withOn(base1, GMAIL_ON);
  assert.equal(T.levelIn(st, st.bots[2], st.accounts[0]), "act", "Juno has Gmail in Fernway by default");
  assert.equal(T32.levelOf(st.bots[2], st.accounts[0]), null, "v0.0.32 doesn't: less, never more");
  assert.equal(T.levelIn(st, st.bots[3], st.accounts[0]), null, "Rex was given No access there: the picker narrows it");
  assert.equal(T.levelIn(withOn(base1, { "app:ca_notion": ON }), st.bots[2], st.accounts[1]), null, "an account only the bots given it have stays that way");
  assert.equal(T.levelIn(withOn(base1, { "app:ca_slack": ON }), st.bots[2], st.accounts[2]), null, "a channel app has no default anywhere");
});
check("anything else under loginsOn gives nothing", () => {
  for (const junk of [null, true, "on", 1, [], { "app:ca_gmail": null }, { "app:ca_gmail": true }, { "app:ca_gmail": "on" }]) {
    const st = clone(base1);
    st.workspaces[1].loginsOn = junk;
    assert.deepEqual(now(st), was(st), JSON.stringify(junk));
  }
});
check("v0.0.32's grantsOn (Bops Cloud's hold on a computer's runner) never gives more than this build's, and the same without Used in", () => {
  const st = withOn(base1, GMAIL_ON);
  st.bots[2].computerId = "desk-lark";
  st.bots[3].computerId = "desk-lark";
  const grants = (f, x) => Object.fromEntries([...f(x, "desk-lark")].map(([id, g]) => [id, g.level]));
  notMore(grants(CS32.grantsOn, st), grants(CS.grantsOn, st), "grantsOn");
  assert.deepEqual(grants(CS.grantsOn, st), { ca_gmail: "act" });
  assert.deepEqual(grants(CS32.grantsOn, st), {});
  assert.deepEqual(grants(CS.grantsOn, without(st)), grants(CS32.grantsOn, st));
});
await checkAsync("v0.0.32's syncApps leaves Used in alone, and what it drops or finds anew never widens anyone's access", async () => {
  // In Composio: Gmail working, Notion signed out, and a new account; Main's Calendar is gone from it. Calendar is
  // switched on in Fernway, and so is the new one (an entry left from before): v0.0.32 drops the one, adds the other.
  const st = withOn(base1, { ...GMAIL_ON, "app:ca_cal": ON, "app:ca_new": ON });
  st.accounts.push({ id: "ca_cal", app: "googlecalendar", appName: "Google Calendar", status: "active", at: 1, workspaceId: "ws_main" });
  st.bots[1].access = {};
  const before = now(st);
  const items = [
    { id: "ca_gmail", status: "ACTIVE", toolkit: { slug: "gmail" } },
    { id: "ca_notion", status: "EXPIRED", toolkit: { slug: "notion" } },
    { id: "ca_slack", status: "ACTIVE", toolkit: { slug: "slackbot" } },
    { id: "ca_new", status: "ACTIVE", toolkit: { slug: "hubspot" } },
  ];
  process.env.COMPOSIO_API_KEY = "test-composio";
  globalThis.__f32 = {
    store: { getState: () => st, update: (fn) => fn(st), bot: (id) => st.bots.find((b) => b.id === id), installId: () => "test", ownerName: () => "Ava" },
    cloud: { cloudOn: () => false, cloudProxy: () => null, cloudSession: async () => null, cloudSessionNow: () => null, cloudUrl: () => "" },
    composio: {
      connectedAccounts: { list: async () => ({ items, nextCursor: null }), get: async (id) => ({ data: { email: `${id}@acme.example` } }) },
      toolkits: { get: async () => ({}), getToolkits: async () => [] },
    },
  };
  await C32.syncApps();
  assert.deepEqual(larkOn(st), { ...GMAIL_ON, "app:ca_cal": ON, "app:ca_new": ON }, "v0.0.32 never touches a workspace");
  assert.deepEqual(st.accounts.map((a) => a.id), ["ca_gmail", "ca_slack", "ca_new"], "Calendar gone from Composio, Notion signed out and unused: off the list");
  assert.equal(st.accounts.find((a) => a.id === "ca_new").onlyGiven, true, "found anew: only the bots given it");
  const after = now(st);
  for (const [k, v] of Object.entries(after)) if (k in before) assert.ok(v === before[k] || v === null, `${k}: ${before[k]} before, ${v} after`);
  assert.equal(after["juno/ca_new"], null, "the entry left from before gives the new one to nobody");
  assert.equal(after["juno/ca_gmail"], "act", "Gmail stays switched on in Fernway");
});
check("v0.0.32's keysOf never sees another workspace's key; this build's sees it where it's switched on, and without that is v0.0.32's", () => {
  const all = [
    { name: "STRIPE_SECRET_KEY", updatedAt: null, workspaceId: "proj-main" },
    { name: "GITHUB_TOKEN", updatedAt: null, workspaceId: null },
    { name: "LINEAR_API_KEY", updatedAt: null, workspaceId: "proj-fern" },
  ];
  const st = withOn(base1, { "key:proj-main:STRIPE_SECRET_KEY": ON });
  globalThis.__f32 = { store: { getState: () => st } };
  const names = (f, ws) => f(all, ws).map((k) => k.name).sort();
  assert.deepEqual(names(K32.keysOf, "ws_fern"), ["GITHUB_TOKEN", "LINEAR_API_KEY"], "v0.0.32: the account's and its own");
  assert.deepEqual(names(K.keysOf, "ws_fern"), ["GITHUB_TOKEN", "LINEAR_API_KEY", "STRIPE_SECRET_KEY"], "this build: Main's Stripe key too");
  assert.equal(K.keyProjectFor(all, "ws_fern", "STRIPE_SECRET_KEY"), "proj-main", "called through Main's project, where it is");
  assert.equal(K.keyProjectFor(all, "ws_fern", "LINEAR_API_KEY"), "proj-fern");
  assert.deepEqual(names(K.keysOf, "ws_main"), names(K32.keysOf, "ws_main"), "Main as before");
  const lost = without(st);
  globalThis.__f32.store.getState = () => lost;
  assert.deepEqual(names(K.keysOf, "ws_fern"), names(K32.keysOf, "ws_fern"), "lost, it's v0.0.32's");
});
check("a site login keeps nothing new: switched off or on in a workspace, only its bots change, and v0.0.32's loginsFor agrees", () => {
  const st = clone(base1);
  globalThis.__f32 = { store: { getState: () => st, update: (fn) => fn(st) } };
  const x = (id) => VT32.loginsFor(id, "https://x.com/home").map((l) => l.id);
  assert.deepEqual([x("sam"), x("juno")], [["vl_x"], ["vl_x"]], "every bot, as today");
  const keys = (o) => Object.keys(o).sort();
  const shape = keys(st.vault[0]);
  assert.deepEqual(L.setSiteIn("vl_x", "ws_fern", false), { ok: true });
  assert.deepEqual(st.vault[0].bots, ["sam", "iris"], "every bot but Fernway's, by name");
  assert.deepEqual(keys(st.vault[0]), shape, "no field v0.0.32 doesn't know");
  assert.equal(larkOn(st), undefined, "nothing on the workspace");
  assert.deepEqual([x("sam"), x("juno"), x("rex")], [["vl_x"], [], []], "v0.0.32 reads it the same way");
  L.setSiteIn("vl_x", "ws_fern", true);
  assert.deepEqual([x("juno"), x("rex")], [["vl_x"], ["vl_x"]]);
  assert.deepEqual(st.vault[0].bots, ["sam", "iris", "juno", "rex"], "on again: each bot there by name, never every bot of every workspace");
});
check("switched off, a login's explicit grants there go too, so v0.0.32 agrees; one v0.0.32 puts back is no more than before", () => {
  const st = withOn(base1, GMAIL_ON);
  st.bots[2].access = { ca_gmail: "read", ca_notion: "act" };
  globalThis.__f32 = { store: { getState: () => st, update: (fn) => fn(st) } };
  const before = was(st);
  assert.deepEqual(L.setAppIn("ca_gmail", "ws_fern", false), { ok: true });
  assert.equal(larkOn(st), undefined);
  assert.deepEqual(st.bots[2].access, { ca_notion: "act" }, "Juno's Gmail grant goes; its Notion one is another login's");
  assert.equal(st.bots[3].access.ca_gmail, "none", "a No access stays, for when it's switched on again");
  assert.equal(T.levelIn(st, st.bots[2], st.accounts[0]), null);
  assert.equal(T32.levelOf(st.bots[2], st.accounts[0]), null, "v0.0.32 sees it off too");
  // An older Mac that changed Juno before it pulled puts its whole copy back (as with any bot change today): Juno has
  // what it had before the switch off, no more.
  const r = V32.merge3(withOn(base1, GMAIL_ON), (() => { const m = withOn(base1, GMAIL_ON); m.bots[2].access = { ca_gmail: "read", ca_notion: "act" }; m.bots[2].name = "Juno B"; return m; })(), clone(st));
  notMore(was(r), before, "an older Mac's copy");
  assert.deepEqual(L.setAppIn("ca_gmail", "ws_main", false).status, 409, "its own workspace is always on: the picker keeps bots from it");
});

/* ---------------- An app's Local and Staging ---------------- */

/** A type's fields as its source declares them (`export type <name> = { ... };`, one field a line or more). */
const fieldsOf = (src, name) => {
  const body = new RegExp(`export type ${name} = \\{([^\\n]*)\\};`).exec(src)?.[1] ?? new RegExp(`export type ${name} = \\{\\n([\\s\\S]*?)\\n\\};`).exec(src)?.[1];
  assert.ok(body !== undefined, `${name} in the source`);
  return [...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:^|[{;\n])\s*([a-zA-Z]+)\??:/g)].map((m) => m[1]).sort();
};
const HA32 = old("lib/hosted-apps.ts");
const HA = readFileSync(`${root}/lib/hosted-apps.ts`, "utf8");

check("The app's record (Workspace.hostedApps) has exactly v0.0.32's fields: nothing of Local or Staging is kept in Bops' state", () => {
  for (const t of ["AppHosting", "AppSiteHosting", "AppProjectBehind"]) assert.deepEqual(fieldsOf(HA, t), fieldsOf(HA32, t), t);
  assert.ok(fieldsOf(HA, "AppHosting").includes("behind"), "where Staging projects left on another computer go: v0.0.32 knows it");
});

const W1 = {
  owner: { name: "Ava" },
  workspace: "ws_main",
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, orgoProjectId: "proj-main", hostedApps: { "field-notes": { botId: "sam", computerId: "c_new", projectId: "p_prod2" } } }],
  bots: [{ id: "sam", isMain: true, name: "Sam", computerId: "c_new" }],
  chats: [],
};
const notesOf = (st) => st.workspaces[0].hostedApps["field-notes"];
check("v0.0.32 changing the app (a deploy it queued) while this build kept its Staging left on another computer (behind): both kept, field by field", () => {
  const theirs = clone(W1);
  notesOf(theirs).behind = [
    { site: "field-notes", computerId: "c_old", projectId: "p_prod" },
    { site: "field-notes", computerId: "c_old", projectId: "p_staging" },
  ];
  const mine = clone(W1);
  notesOf(mine).queuedAt = 7;
  const r = V32.merge3(clone(W1), mine, theirs);
  assert.deepEqual(notesOf(r), { ...notesOf(theirs), queuedAt: 7 });
  assert.deepEqual(notesOf(V32.merge3(clone(W1), mine, theirs, KEPT)), { ...notesOf(theirs), queuedAt: 7 }, "a copy it kept, merged in later, too");
});
check("v0.0.32 rebuilding the app's record while this build listed Staging behind (both changed it): v0.0.32's stands, so that Staging project is only no longer listed (never deleted), and Prod's record is v0.0.32's", () => {
  const theirs = clone(W1);
  notesOf(theirs).behind = [{ site: "field-notes", computerId: "c_old", projectId: "p_staging" }];
  const mine = clone(W1);
  notesOf(mine).behind = [{ site: "field-notes", computerId: "c_other", projectId: "p_prod2" }];
  notesOf(mine).computerId = "c_third";
  const r = V32.merge3(clone(W1), mine, theirs);
  assert.deepEqual(notesOf(r), notesOf(mine));
});

/** A computer's deploy projects as orgo-web lists them, for v0.0.32's own hosted-apps code: Prod's and Staging's of one app. */
const PROJ = "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a9c4f13";
const projectOf = (id, name, port) => ({ id, name, source: "ingot", ingot_repo: `${PROJ}/field-notes`, url: `https://${name}.orgo.dev`, port, deployments: [], current: null });
await checkAsync("v0.0.32's own Deploy on an app with a Staging project beside Prod's deploys Prod's: with its record, and with its record forgetting Prod's project (found by name, never Staging's); with Prod's deleted outside Bops, its one site fallback would take Staging's, which this build's Prod first keeps from happening otherwise", async () => {
  const H32 = await import(fromTag("lib/server/hosted-apps.ts"));
  const st = clone(W1);
  st.workspaces[0].orgoProjectId = PROJ;
  let projects = [projectOf("p_prod", "field-notes", 3000), projectOf("p_staging", "field-notes-staging", 3001)];
  const queued = [];
  globalThis.__f32 = {
    store: { getState: () => st, update: (fn) => fn(st), bot: (id) => st.bots.find((b) => b.id === id), ownerName: () => "Ava", sameState: () => () => true, flushState: async () => true },
    ingot: { workspace: PROJ },
    orgo: {
      deploys: {
        projects: async () => ({ enabled: true, value: { projects } }),
        project: async (_c, id) => ({ enabled: true, value: projects.find((p) => p.id === id) }),
        deploy: async (_c, id, at) => (queued.push(id), { enabled: true, value: { id: `d_${queued.length}`, state: "queued", created_at: new Date().toISOString(), at: at ?? null } }),
        create: async () => assert.fail("nothing made: Prod's is there"),
      },
    },
  };
  notesOf(st).computerId = "c_new";
  notesOf(st).projectId = "p_prod";
  await H32.deployApp("ws_main", "field-notes", { ours: () => true });
  assert.deepEqual(queued, ["p_prod"], "with its record: Prod's");
  delete notesOf(st).projectId;
  await H32.deployApp("ws_main", "field-notes", { ours: () => true });
  assert.deepEqual(queued, ["p_prod", "p_prod"], "its record forgetting it: Prod's again, by name");
  assert.equal(notesOf(st).projectId, "p_prod");
  // Prod's deleted on Orgo, outside Bops: v0.0.32 doesn't know Staging, so its fallback takes the repo's one project.
  projects = projects.filter((p) => p.id !== "p_prod");
  delete notesOf(st).projectId;
  await H32.deployApp("ws_main", "field-notes", { ours: () => true });
  assert.deepEqual(queued.at(-1), "p_staging", "the one case left, and only after someone deletes Prod's project on Orgo");
});

rmSync(dir, { recursive: true, force: true });
console.log(`compat ${TAG}: ${passed} passed`);
