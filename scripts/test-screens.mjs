// Tests for screens as people and bots see them (lib/screens.ts, lib/server/briefing.ts): screen numbers
// (1 to 4, from the X displays); the map of a computer's screens (who's on each, what for, its state, a
// held one, who left a free one and on what), the same from any bot that shares it and whoever's view
// you took over from; the main bot's team row (other computers, needs-you first, what was left lately);
// and the bots' briefing (a held screen, "left by", each teammate's screen). Offline, in a throwaway folder.
// Usage: node --conditions=react-server scripts/test-screens.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-routing";
process.env.TYPESAFE_API_KEY = "ts-test-routing";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-routing-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

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


/* ---------------- Offline ---------------- */

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (the test is offline: ${new URL(String(input instanceof Request ? input.url : input)).host})`);
};
console.warn = () => {};

const L = await import(`${root}/lib/screens.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const B = await import(`${root}/lib/server/briefing.ts`);

/* ---------------- Numbers ---------------- */

assert.deepEqual([100, 101, 102, 99].map(L.screenNo), [1, 2, 3, 4], "the made screens first, Orgo's boot screen last");
assert.deepEqual([1, 2, 3, 4].map(L.displayOf), [100, 101, 102, 99]);
assert.equal(L.screenLabel(102), "screen 3");
assert.equal(L.screenNo(55), 0, "not a screen");

/* ---------------- The map ---------------- */

const now = Date.now();
S.update((st) => {
  st.host = "orgo";
  st.owner = { name: "Alex" };
  const main = st.bots.find((b) => b.isMain);
  Object.assign(main, { computerId: "comp_main", computerStatus: "ready" });
  st.bots.push({ id: "cclc", name: "CCLC", role: "Brochures", color: "#E9FF3B", isMain: false, computer: "shared", computerStatus: "none" });
  st.bots.push({ id: "jayce", name: "Jayce", role: "Outbound", color: "#E9FF3B", isMain: false, computer: "own", computerId: "comp_jayce", computerStatus: "ready" });
});
const main = S.getState().bots.find((b) => b.isMain);
const ses = (o) => ({ chatId: `bot:${o.botId}`, sentVia: "you", goal: o.title, host: "orgo", steps: [], replies: [], createdAt: now, ...o });
S.update((st) => {
  st.sessions.push(ses({ id: "ses_a", botId: main.id, title: "YC replies", status: "running", display: 100, activity: "reading Gmail" }));
  st.sessions.push(ses({ id: "ses_b", botId: "cclc", title: "Brochure", status: "running", display: 101, blocker: "signin" }));
  st.sessions.push(ses({ id: "ses_c", botId: main.id, title: "Ask about dates", status: "done", waitingOnYou: true, endedAt: now - 60_000, lastDisplay: 102 }));
  st.sessions.push(ses({ id: "ses_old", botId: main.id, title: "Old question", status: "done", waitingOnYou: true, endedAt: now - 20 * 60_000, lastDisplay: 99 }));
  st.screenLog = { [`${main.id}:99`]: { sessionId: "ses_x", botId: "cclc", title: "Logo", page: { url: "https://figma.com/x", title: "Logo" }, at: now - 5 * 60_000 } };
  st.sessions.push(ses({ id: "ses_j", botId: "jayce", title: "Evening YC check", status: "running", display: 100, blocker: "captcha" }));
  st.sessions.push(ses({ id: "ses_j2", botId: "jayce", title: "Leads", status: "running", display: 102, activity: "searching" }));
  st.screenLog[`jayce:101`] = { sessionId: "ses_jl", botId: "jayce", title: "Hotels", at: now - 10 * 60_000 };
  st.screenLog[`jayce:99`] = { sessionId: "ses_jo", botId: "jayce", title: "Too old", at: now - 45 * 60_000 };
});
const st = S.getState();
// The same four screens whichever bot sharing the computer you ask for; each says the bot that's on it.
const m = L.screenMap(st, main.id, now);
assert.deepEqual(L.screenMap(st, "cclc", now), m, "a bot that shares sees the same map");
assert.deepEqual(m.map((x) => [x.no, x.kind, x.botId, x.title]), [
  [1, "working", main.id, "YC replies"],
  [2, "needsYou", "cclc", "Brochure"],
  [3, "held", main.id, "Ask about dates"],
  [4, "free", undefined, undefined],
]);
assert.equal(m[0].doing, "reading Gmail");
assert.deepEqual([m[3].left?.title, m[3].left?.botId], ["Logo", "cclc"], "a free screen says who left it, for half an hour");
assert.equal(L.holdsScreen(st.sessions.find((x) => x.id === "ses_old"), now), false, "a hold lasts 15 minutes");
// You driving a screen comes first on it; Jayce's own computer is its own map.
S.update((s) => (s.takeover = { botId: "cclc", display: 101, since: now }));
assert.equal(L.screenMap(S.getState(), main.id, now)[1].kind, "driving", "whichever bot's view you took over from");
S.update((s) => (s.takeover = undefined));
assert.deepEqual(L.screenMap(S.getState(), "jayce", now).map((x) => x.kind), ["needsYou", "free", "working", "free"]);
assert.equal(L.onSameComputer(S.getState(), main.id, "cclc"), true);
assert.equal(L.onSameComputer(S.getState(), main.id, "jayce"), false);
S.update((s) => (s.host = "mac"));
assert.equal(L.onSameComputer(S.getState(), main.id, "cclc"), false, "on this Mac every bot has its own browsers");
S.update((s) => (s.host = "orgo"));

// The team row, from the main bot: other computers only, needs-you first, then work, then what was left lately.
const team = L.teamScreens(S.getState(), main.id, now);
assert.deepEqual(team.map((x) => [x.computerBotId, x.no, x.kind, x.title ?? x.left?.title]), [
  ["jayce", 1, "needsYou", "Evening YC check"],
  ["jayce", 3, "working", "Leads"],
  ["jayce", 2, "free", "Hotels"],
]);
assert.equal(L.ago(now - 5 * 60_000, now), "5 min ago");

/* ---------------- What the bots are told ---------------- */

const told = await B.computerBriefing(main.id, { thread: "ses_a" });
assert.match(told, /^Your computer, as of now:/);
assert.match(told, /Screen 1: this thread \(you\) · now: reading Gmail/);
assert.match(told, /Screen 2: CCLC is working there on "Brochure"; it's not yours, don't touch it\./);
assert.match(told, /Screen 3: kept for your thread "Ask about dates" while it waits on Alex; don't use it for other work/);
assert.match(told, /Screen 4: free · your home screen is open, left by CCLC's thread "Logo" 5 min ago\./);
const toldCclc = await B.computerBriefing("cclc");
assert.match(toldCclc, /^The computer you share with /);
assert.match(toldCclc, /Screen 4: free · your home screen is open, left by your thread "Logo" 5 min ago\./);
const teamTold = B.teamBriefing(main.id);
assert.match(teamTold, /- Jayce \(Outbound\): working on "Evening YC check" \(working, on its computer's screen 1, stuck: needs Alex/);
assert.match(teamTold, /- CCLC \(Brochures\): working on "Brochure" \(working, on your computer's screen 2/);

rmSync(scratch, { recursive: true, force: true });
console.log("screens: all tests passed");
process.exit(0);
