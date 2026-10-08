// Tests for how the app streams a computer's screens (app/api/vnc, lib/server/orgo.ts, lib/rtc.ts): the
// boot screen over Orgo's VNC proxy and Orgo's WebRTC alongside, on by default, with the VNC password as
// the token, the screen's real size, and no Orgo key in the plan; WebRTC turned on for a computer where
// nobody chose (and Orgo's refusal not asked again for a while), left off where someone turned it off,
// never turned on for a stopped computer (it has no record on Orgo then, and saving the choice would make
// one), not used at all with BOPS_WEBRTC=0, and after it shrank a screen, that screen put back and
// streamed over VNC for a day; the other screens over the tailnet, or through Orgo's VNC proxy by ?screen= (never
// WebRTC) with BOPS_SCREEN_STREAM=1, by Orgo's own id for the screen once the app has read the list; and
// the client's pieces: which failures wait how long before WebRTC is tried again, a stream smaller than
// the screen, what a VNC stream does by how Orgo closed it, Orgo's frames, and where a click on the
// picture lands on the remote screen.
// Orgo is a fake fetch on a made-up origin and the state a throwaway file store in a temporary folder:
// nothing reaches Orgo, and no key is read from the Keychain.
// Usage: node --conditions=react-server scripts/test-stream.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of ["ORGO_API_KEY", "BOPS_ORGO_WORKSPACE", "BOPS_ORGO_TEMPLATE", "BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "OPENAI_API_KEY", "TAILSCALE_AUTH_KEY", "BOPS_WEBRTC", "BOPS_SCREEN_STREAM"]) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded (the Mac check, the relay's agent) or that Node can't load are
// stand-ins: each of their exports does nothing.
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
const scratch = mkdtempSync(join(tmpdir(), "bops-test-stream-"));
process.chdir(scratch);
globalThis.bopsOrgoKey = "sk_test_one";

/* ---------------- A fake Orgo: one computer, its VNC password and its WebRTC choice ---------------- */

const calls = [];
// `status`: "running", or "frozen" (stopped: Orgo has no record of it then, instance_details is null).
// `screens`: what GET /computers/c1/screens lists.
const orgo = { webrtc: null, refuse: null, password: "pw/1+ä", status: "running", screens: [] };
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://orgo.test") throw new Error(`not the fake Orgo: ${url}`);
  const call = { method: init.method ?? "GET", path: url.pathname, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  if (call.method === "GET" && call.path === "/api/computers/c1")
    return json(200, {
      id: "c1",
      status: orgo.status,
      vnc_password: orgo.password,
      instance_details: orgo.status !== "running" ? null : orgo.webrtc === null ? { id: "inst-1" } : { id: "inst-1", webrtc: orgo.webrtc },
    });
  if (call.method === "GET" && call.path === "/api/computers/c1/screens") return json(200, { screens: orgo.screens });
  if (call.method === "PATCH" && call.path === "/api/computers/c1/screens/default") return json(200, { id: "default", display: ":99", ...call.body, default: true });
  if (call.method === "POST" && call.path === "/api/computers/c1/webrtc") {
    if (orgo.refuse) return json(409, { error: orgo.refuse, code: "webrtc_ineligible" });
    // Orgo saves it whatever the computer's state: on a stopped one that makes a record where there was none.
    if (orgo.status !== "running") orgo.madeRecord = true;
    orgo.webrtc = call.body.enabled;
    return json(200, { ok: true, webrtc: orgo.webrtc, effective: true });
  }
  return json(404, { error: "Not found" });
};
const asked = (method, path) => calls.filter((c) => c.method === method && c.path === path).length;

const S = await import(`${root}/lib/server/store.ts`);
const V = await import(`${root}/app/api/vnc/route.ts`);
const R = await import(`${root}/lib/rtc.ts`);
const T = await import(`${root}/lib/types.ts`);

S.update((s) => {
  s.host = "orgo";
  Object.assign(s.bots.find((b) => b.isMain), { computerId: "c1", computerStatus: "ready", tailnet: undefined });
});
const main = () => S.getState().bots.find((b) => b.isMain);
const plan = async (display, host = "localhost:3210") => {
  const res = await V.GET(new Request(`http://${host}/api/vnc?bot=${main().id}&display=${display}`));
  return { status: res.status, ...(await res.json()) };
};
const token = `token=${encodeURIComponent(orgo.password)}`;

/* ---------------- The boot screen: Orgo's WebRTC first, its VNC proxy second ---------------- */

// On unless BOPS_WEBRTC=0. Nobody chose for this computer (Orgo forgets on a stop): Bops turns WebRTC on,
// then streams over it, with the screen's real size so the app can tell a stream Orgo shrank it for.
let p = await plan(99);
assert.equal(p.status, 200);
assert.equal(p.rtc, `wss://orgo.test/desktops/c1/ws/rtc?${token}`);
assert.deepEqual(p.size, { w: 1280, h: 960 });
assert.equal(p.vnc, `wss://orgo.test/desktops/c1/ws/websockify?${token}`);
assert.equal(p.password, orgo.password);
assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body]), [["/api/computers/c1/webrtc", { enabled: true }]]);
assert.ok(calls.every((c) => c.auth === "Bearer sk_test_one"), "Orgo asked with the user's key");
assert.ok(!JSON.stringify(p).includes("sk_test_one"), "the Orgo key never goes to the page: the VNC password is the token");
// Stopped: nothing is turned on (saving it would give Orgo a record for a computer that isn't running,
// which Orgo takes for a running one); turned on once it runs again.
orgo.webrtc = null;
orgo.status = "frozen";
p = await plan(99);
assert.deepEqual([p.rtc, !!p.vnc], [undefined, true]);
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 1);
assert.equal(orgo.madeRecord, undefined, "a stopped computer's record left alone");
const O = await import(`${root}/lib/server/orgo.ts`);
assert.equal(await O.orgo.webrtc("c1"), false, "setting a computer up doesn't turn it on while it's stopped either");
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 1);
orgo.status = "running";
p = await plan(99);
assert.equal(p.rtc, `wss://orgo.test/desktops/c1/ws/rtc?${token}`);
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 2);
// Turned off on Orgo: setting a computer up again leaves it off.
orgo.webrtc = false;
assert.equal(await O.orgo.webrtc("c1"), false);
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 2);
orgo.webrtc = true;
// On already: streamed, nothing to turn on.
p = await plan(99);
assert.ok(p.rtc);
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 2);
// Someone turned it off on Orgo: Bops leaves it off, and the screen streams over VNC.
orgo.webrtc = false;
p = await plan(99);
assert.deepEqual([p.rtc, p.vnc], [undefined, `wss://orgo.test/desktops/c1/ws/websockify?${token}`]);
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 2);
// Orgo turns it down (fewer than 4 vCPUs): VNC, and Orgo isn't asked again on every view.
orgo.webrtc = null;
orgo.refuse = "Needs 4 vCPUs or a GPU. This one has 2.";
p = await plan(99);
assert.deepEqual([p.rtc, !!p.vnc], [undefined, true]);
await plan(99);
await plan(99);
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 3, "refused once, then not asked for a while");
// Turned off in Bops (BOPS_WEBRTC=0): VNC as before, and nothing asked of Orgo.
process.env.BOPS_WEBRTC = "0";
orgo.refuse = null;
p = await plan(99);
assert.deepEqual([p.rtc, p.size, !!p.vnc], [undefined, undefined, true]);
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 3);
assert.equal(O.webrtcWanted(), false);
delete process.env.BOPS_WEBRTC;
assert.equal(O.webrtcWanted(), true, "unset is on");
process.env.BOPS_WEBRTC = "1";
assert.equal(O.webrtcWanted(), true);
delete process.env.BOPS_WEBRTC;
// Orgo's WebRTC shrank the screen (its gateway's limit is under 1280x960): the app says so, Bops puts the
// screen back to its real size, and the computer streams over VNC for a day, without Orgo asked about WebRTC.
orgo.webrtc = true;
assert.ok((await plan(99)).rtc);
const shrunk = (host = "localhost:3210") => V.POST(new Request(`http://${host}/api/vnc?bot=${main().id}&display=99`, { method: "POST" }));
assert.equal((await shrunk("bops.example")).status, 403, "only this Mac's app");
assert.equal(asked("PATCH", "/api/computers/c1/screens/default"), 0);
assert.equal((await shrunk()).status, 200);
assert.deepEqual(
  calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body]),
  [["/api/computers/c1/screens/default", { width: 1280, height: 960 }]],
  "the boot screen back to 1280x960, in place",
);
assert.ok(O.rtcShrunk("c1"));
const before = asked("GET", "/api/computers/c1");
p = await plan(99);
assert.deepEqual([p.status, p.rtc, p.size, p.vnc], [200, undefined, undefined, `wss://orgo.test/desktops/c1/ws/websockify?${token}`], "VNC only now");
assert.equal(asked("GET", "/api/computers/c1"), before + 1, "just the password");
assert.equal(asked("POST", "/api/computers/c1/webrtc"), 3, "nothing asked of Orgo about WebRTC");
// Orgo couldn't put it back: the app hears so, and the computer still streams over VNC.
const okFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => (init?.method === "PATCH" ? json(502, { error: "screen busy" }) : okFetch(input, init));
assert.equal((await shrunk()).status, 502);
globalThis.fetch = okFetch;
assert.equal((await plan(99)).rtc, undefined);
console.log("boot screen: on by default, VNC with WebRTC alongside (turned on where nobody chose), the VNC password as the token; a screen WebRTC shrank put back, then VNC");

/* ---------------- The other screens: over the tailnet, and with BOPS_SCREEN_STREAM=0 never through Orgo ---------------- */

// On by default: Orgo streams any screen by ?screen= (orgo-web's per-screen streams). BOPS_SCREEN_STREAM=0
// is for an Orgo without them, which would stream the boot screen in a bot's tile: screenshots then.
assert.equal(O.screenStreamWanted(), true, "on unless turned off");
process.env.BOPS_SCREEN_STREAM = "0";
assert.equal(O.screenStreamWanted(), false);
for (const d of [100, 101, 102]) assert.equal((await plan(d)).status, 409, `screen ${d}: BOPS_SCREEN_STREAM=0, screenshots, as before`);
S.update(() => (main().tailnet = { ip: "100.64.0.7", name: "bops-c1" }));
p = await plan(101);
assert.deepEqual([p.status, p.rtc, p.vnc, p.password], [200, undefined, "ws://100.64.0.7:6082/websockify", orgo.password]);
assert.ok((await plan(99)).vnc.startsWith("wss://orgo.test/"), "the boot screen still goes through Orgo");
assert.deepEqual([100, 101, 102, 99].map((d) => T.streamsLive(main(), d)), [true, true, true, true]);
S.update(() => (main().tailnet = undefined));
assert.deepEqual([100, 101, 102, 99].map((d) => T.streamsLive(main(), d)), [false, false, false, true]);
// Only for the app on this Mac (the reply has the password), and only for Orgo computers.
assert.equal((await plan(99, "bops.example")).status, 403);
S.update((s) => (s.host = "mac"));
assert.equal((await plan(99)).status, 409);
S.update((s) => (s.host = "orgo"));
console.log("other screens: on by default; with BOPS_SCREEN_STREAM=0 live over the tailnet only; the plan only for this Mac's app");

/* ---------------- The other screens through Orgo's VNC proxy (BOPS_SCREEN_STREAM=1) ---------------- */

process.env.BOPS_SCREEN_STREAM = "1";
assert.equal(O.screenStreamWanted(), true);
const rtcAsked = asked("POST", "/api/computers/c1/webrtc");
for (const d of [100, 101, 102]) {
  p = await plan(d);
  assert.deepEqual(
    [p.status, p.rtc, p.vnc, p.password, p.screen],
    [200, undefined, `wss://orgo.test/desktops/c1/ws/websockify?${token}&screen=screen-${d}`, orgo.password, `screen-${d}`],
    `screen ${d}: Orgo's VNC proxy by ?screen=, never WebRTC (Orgo's WebRTC streams the boot screen only)`,
  );
}
assert.equal(asked("POST", "/api/computers/c1/webrtc"), rtcAsked, "nothing turned on for another screen");
assert.equal(asked("GET", "/api/computers/c1/screens"), 1, "the screen's id: Orgo's list, read once and kept a minute (screensOf)");
p = await plan(99);
assert.deepEqual([p.vnc, p.screen], [`wss://orgo.test/desktops/c1/ws/websockify?${token}`, undefined], "the boot screen's stream is as it was");
for (const d of [98, 5, NaN]) assert.equal((await plan(d)).status, 409, `display ${d}: not one of Bops' screens`);
assert.ok(!JSON.stringify(await plan(101)).includes("sk_test_one"), "still no Orgo key in the plan");
// Orgo's own id for the screen from its list (read before a stream and kept a minute, and read by a click
// without the tailnet too; the computer view never reads it); screen-<display> for one the list doesn't have.
orgo.screens = [
  { id: "default", display: ":99", width: 1280, height: 960, default: true },
  { id: "screen-100", display: ":100", width: 1280, height: 960, default: false },
  { id: "s-101", display: ":101", width: 1280, height: 960, default: false },
];
const C = await import(`${root}/app/api/computer/route.ts`);
const viewed = await (await C.GET(new Request(`http://localhost:3210/api/computer?bot=${main().id}`))).json();
assert.equal(viewed.screens, undefined, "the computer view doesn't read the list");
assert.equal(asked("GET", "/api/computers/c1/screens"), 1);
// A minute on (or a click read it fresh): the new list.
const SC = await import(`${root}/lib/server/screens.ts`);
await SC.screensOf("c1", true);
p = await plan(101);
assert.deepEqual([p.screen, p.vnc], ["s-101", `wss://orgo.test/desktops/c1/ws/websockify?${token}&screen=s-101`], "Orgo's id from the list the app has");
assert.equal((await plan(102)).screen, "screen-102", "not in the list: the id the computer names it by");
assert.equal(asked("GET", "/api/computers/c1/screens"), 2, "kept: no read for those streams");
// A list Orgo fails to give leaves the last one in use, and the stream is still planned.
const failingFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => (String(input).endsWith("/screens") ? json(404, { error: "No screens yet" }) : failingFetch(input, init));
await SC.screensOf("c1", true).catch(() => null);
p = await plan(101);
globalThis.fetch = failingFetch;
assert.deepEqual([p.status, p.screen], [200, "s-101"], "the last list Orgo gave");
assert.equal(main().computerId, "c1", "a list it couldn't give isn't a computer gone");
// The tailnet still comes first: direct and private.
S.update(() => (main().tailnet = { ip: "100.64.0.7", name: "bops-c1" }));
p = await plan(101);
assert.deepEqual([p.vnc, p.screen], ["ws://100.64.0.7:6082/websockify", undefined], "over the tailnet when the computer is on it");
S.update(() => (main().tailnet = undefined));
// The app is told, and shows every screen live (each tile and thumbnail too).
assert.deepEqual([100, 101, 102, 99].map((d) => T.streamsLive(main(), d, true)), [true, true, true, true]);
assert.deepEqual([100, 101, 102, 99].map((d) => T.streamsLive(main(), d, false)), [false, false, false, true]);
process.env.BOPS_SCREEN_STREAM = "0";
assert.equal((await plan(101)).status, 409, "turned off: screenshots");
delete process.env.BOPS_SCREEN_STREAM;
assert.equal((await plan(101)).status, 200, "unset is on");
console.log("other screens through Orgo (BOPS_SCREEN_STREAM=1): noVNC by ?screen= with Orgo's id for it, never WebRTC, the tailnet first");

/* ---------------- The client's pieces ---------------- */

// How long until WebRTC is tried again: never held back for a computer that's down (VNC fails the same
// way), long when UDP never got through or WebRTC is off, short for anything else.
for (const r of ["ws_close_4001", "ws_close_4003", "ws_close_4004", "ws_close_4503"]) assert.equal(R.rtcRetryAfter(r), 0, r);
for (const r of ["ice_failed", "not_connected", "ice_unrecovered", "ws_close_4010"]) assert.equal(R.rtcRetryAfter(r), 600_000, r);
for (const r of ["no_first_frame", "no_ready", "error_session_limit", "ws_close_4520", "media_stall", "input_unresponsive"]) assert.equal(R.rtcRetryAfter(r), 45_000, r);
// A stream that shrank the screen: a day, since the gateway would shrink it again on every try.
assert.equal(R.rtcRetryAfter("shrunk"), 24 * 60 * 60_000);
assert.equal(R.RTC_SHRUNK_MS, 24 * 60 * 60_000);
// Smaller than the screen either way is shrunk (a 1280x960 screen under the default 1280x720 limit comes
// out 960x720); the real size, or no size known, isn't.
const real = { w: 1280, h: 960 };
assert.equal(R.rtcShrank({ w: 960, h: 720 }, real), true);
assert.equal(R.rtcShrank({ w: 1280, h: 720 }, real), true);
assert.equal(R.rtcShrank({ w: 1014, h: 960 }, real), true);
assert.equal(R.rtcShrank({ w: 1280, h: 960 }, real), false);
assert.equal(R.rtcShrank(undefined, real), false, "a gateway that doesn't say: the picture shows its size");
assert.equal(R.rtcShrank({ w: 960, h: 720 }, undefined), false, "no size in the plan: as before");
// What a VNC stream does when it ends. Any stream: back by itself if it had been live, else the caller
// shows the screen another way; Orgo's codes count only for a screen it streams by ?screen=.
const ended = (code, at = {}) => R.afterVncClose(code, { screen: true, ever: false, tries: 0, refused: false, ...at });
for (const code of [undefined, 1000, 1006, 4003, 4004, 4008]) {
  assert.equal(ended(code), "fail", `${code} before it was live`);
  assert.equal(ended(code, { ever: true, tries: 7 }), "retry", `${code} after it was live`);
}
for (const code of [4012, 4001, 4502, 4503]) {
  assert.equal(ended(code, { screen: false }), "fail", `${code} on the boot screen or the tailnet: as before`);
  assert.equal(ended(code, { screen: false, ever: true }), "retry", `${code} on the boot screen or the tailnet, live before: as before`);
}
// 4012, no such screen (or one Orgo can't stream): screenshots for good, even after it was live; never retried.
assert.equal(ended(4012), "no_stream");
assert.equal(ended(4012, { ever: true }), "no_stream");
// 4502, 4503: Orgo couldn't reach or look up the computer just then: tried again with growing waits, a
// few times when it never connected, for as long as it takes when it had been live.
assert.deepEqual([0, 1, 2, 3, 4].map((tries) => ended(4502, { tries })), ["retry", "retry", "retry", "retry", "fail"]);
assert.deepEqual([0, 3, 4].map((tries) => ended(4503, { tries })), ["retry", "retry", "fail"]);
assert.equal(ended(4503, { ever: true, tries: 9 }), "retry");
assert.deepEqual(R.STREAM_RETRY_MS, [2000, 5000, 10_000, 30_000]);
// 4001, the token turned away: once more with a fresh plan (a fresh password), then screenshots.
assert.equal(ended(4001), "reauth");
assert.equal(ended(4001, { ever: true }), "reauth");
assert.equal(ended(4001, { refused: true }), "fail");
assert.equal(ended(4001, { refused: true, ever: true }), "fail");
// Orgo's frames.
assert.deepEqual(R.parseServerMsg(JSON.stringify({ type: "ready", sessionId: "s1", iceServers: [], video: { w: 960, h: 720, fps: 30 } }))?.video, { w: 960, h: 720, fps: 30 });
assert.equal(R.parseServerMsg(JSON.stringify({ type: "answer", sdp: "v=0" }))?.type, "answer");
assert.equal(R.parseServerMsg(JSON.stringify({ type: "error", code: "session_limit" }))?.code, "session_limit");
assert.equal(R.parseServerMsg(JSON.stringify({ type: "hello" })), null);
assert.equal(R.parseServerMsg("not json"), null);
assert.deepEqual(R.parseChannelMsg(JSON.stringify({ t: "sz", w: 1280, h: 960 })), { t: "sz", w: 1280, h: 960 });
assert.equal(R.parseChannelMsg(JSON.stringify({ t: "po", ts: 5 }))?.t, "po");
assert.equal(R.parseChannelMsg(JSON.stringify({ t: "zz" })), null);
// A 4:3 screen in a wide box is drawn with bars at the sides: a click is mapped onto the picture, not the box.
const box = { left: 0, top: 0, width: 1600, height: 900 };
const pic = R.containedRect(box, { w: 1280, h: 960 });
assert.deepEqual(pic, { left: 200, top: 0, width: 1200, height: 900 });
assert.deepEqual(R.toScreenPoint(800, 450, pic, { w: 1280, h: 960 }), { x: 640, y: 480 }, "the middle");
assert.deepEqual(R.toScreenPoint(200, 0, pic, { w: 1280, h: 960 }), { x: 0, y: 0 }, "the picture's corner, not the box's");
assert.deepEqual(R.toScreenPoint(50, 950, pic, { w: 1280, h: 960 }), { x: 0, y: 959 }, "a press in a bar lands on the edge");
// Right and middle swap between the DOM and RFB; wheel scrolling adds up to whole clicks.
assert.deepEqual([1, 2, 4, 3].map(R.rfbButtons), [1, 4, 2, 5]);
let w = R.wheelClicks(0, 60, 0);
assert.deepEqual(w, { clicks: 0, rest: 60 });
w = R.wheelClicks(w.rest, 60, 0);
assert.deepEqual(w, { clicks: 1, rest: 20 });
assert.deepEqual(R.wheelClicks(0, -3, 1), { clicks: -3, rest: 0 }, "lines are clicks");
assert.equal(R.wheelClicks(0, 5000, 0).clicks, 10, "at most 10 clicks an event");
console.log("client: retry waits, a stream smaller than the screen, what a VNC stream does by its close code, Orgo's frames, clicks onto the picture, buttons and the wheel");

console.log(`all stream tests passed (${calls.length} fake Orgo calls, none to the network)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
