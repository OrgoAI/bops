// End to end, the bot's browser beside the chat (components/app/bot-browser.tsx), on the local two-person stack
// (scripts/dev-two-person.mjs: started here when it isn't up, and stopped again after). Two people in headless Chrome:
// the owner and sam (a member with Write on the bot and Use its computer).
//
// 1. The owner opens the bot's browser from a new tab; the bot goes to a page with a fresh word; within 2 s the owner's
//    tab shows its address, and its frame matches a direct CDP screenshot of the bot's page (and not the page before).
// 2. Sam sees the same in place of the owner's computer.
// 4. Sam takes over (the owner sees "Sam has control"), clicks the page's button (sam's own press rings at once where
//    sam pressed, within 400 ms) and types in its field, and the page reacts; a bot step on that screen waits
//    meanwhile and runs once sam hands back. A CDP method outside the allowlist is refused.
// 7. Without control the address bar is read-only; in control, sam types an address and the page goes there.
// 5. Sam signs in to the test site's sign-in page with the fixture's made-up account, hands back, and a bot step reads
//    the signed-in page: it prints the name it read.
// 6. Both close the tab: no frame is sent after, and the bot's computer stops capturing within 5 s (and a bit).
//
// B2, Boppy's cursor (components/app/browser-cursor.tsx, lib/cursor-path.ts):
// B2.2 The bot moves about 620 px across its page and presses: sam's overlay, sampled every animation frame, takes at
//      least 15 distinct places on the way, never steps more than 25 px a frame (at 60 fps), and is within 1 px of the
//      target when the ring shows.
// B2.3 Both see "Boppy" riding the bot's cursor; when sam takes over, the owner sees "Sam" on a cursor that follows
//      sam's moves within 1 s, and sam sees no arrow for Sam (the bot's fades).
// B2.4 With prefers-reduced-motion: the cursor jumps (at most 2 places a move), no dip, no light along the edge; the ring
//      still shows.
// B2.5 Each state of the tab shot (shots/state-*.png, and in grayscale): browsing, you, other, needs-you, idle,
//      unreachable. Only needs-you's status line is highlighter.
// B2.6 Sam presses the page while Boppy browses: sam has control within 500 ms, the press goes nowhere (the page's
//      button still says "Press me"), a step asked meanwhile runs only after Hand back, and the chat says who handed back.
// B2.7 A step waiting while sam has control: the owner sees "Boppy is waiting for Sam to hand back", highlighted,
//      within 1 s, and "Take over from Sam" gives the owner control.
// B2.8 The owner's panel shows "Boppy's browser" beside "Boppy's computer" without the New tab page.
// B2.9 With the owner's browser out of sight, the bot starts browsing: "Boppy is browsing · Watch" shows within 1 s and
//      opens the browser; it goes when the browser shows, and when the browsing stops.
// B2.10 Links in a bot's message: sam's localhost link opens in Boppy's browser in sam's control while the bot is idle;
//      while a step browses sam is asked first ("Take over and open" goes there, "Not now" changes nothing); Cmd-click and
//      a file link take their old paths; the owner's localhost link still opens Local; the owner's link to another
//      site (acme.test, this Mac by name) opens in Boppy's browser in the owner's control.
// B2.11 The stand-in's step reaches the sign-in page and asks; sam presses "Sign in in Boppy's browser", signs in with
//      the fixture's account, hands back; the step reads the signed-in name. The password is in neither app's
//      /api/state nor the stack's log (Bops Cloud's and the relay's lines).
//
// Shots go to <out>/shots. With --takes, each person is filmed for a film at 1920x1080: the page's own frames (CDP
// Page.startScreencast, JPEG at quality 95, CSS pixels, each with its time) become <out>/takes/<who>.mp4 (H.264, a
// constant 30 fps timed by those times, crf 12), and at three still moments each a Page.captureScreenshot is held
// against the mp4's frame then (scripts/check-takes.mjs: the run fails if the video lost the sidebar's grey or drifts).
// <out> is $B2_OUT, else .scratch/B2.
// Everything stays on 127.0.0.1: both browsers refuse any other address.
// Usage: node scripts/test-browser-tab-e2e.mjs [--takes]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTake, describe } from "./check-takes.mjs";
import { removeTemp } from "./fixtures/cleanup.mjs";
import { ACCOUNT, BOT, SAM, PROJECT } from "./fixtures/two-person.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = process.env.B2_OUT || join(root, ".scratch", "B2");
const TAKES = process.argv.includes("--takes");
for (const d of ["shots", ...(TAKES ? ["takes/stills"] : [])]) mkdirSync(join(OUT, d), { recursive: true });
const { chromium } = await import("playwright");
const { default: WebSocket } = await import("ws");

/* ---------------- The stack ---------------- */

const stateFile = join(root, ".scratch", "two-person", "stack.json");
const running = () => {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    process.kill(s.pid, 0);
    return s.ready ? s : null;
  } catch {
    return null;
  }
};
let started = false;
if (!running()) {
  console.log("starting the two-person stack…");
  const r = spawnSync(process.execPath, [join(root, "scripts", "dev-two-person.mjs"), "start"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
  started = true;
}
const stack = running();
const { urls, ports } = stack;
const site = urls.site;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const control = async (path, body) => (await fetch(`${urls.control}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const botStep = (body) => control("/bot/step", body);
/** Sam's role on this stack (TWO_PERSON_MEMBER_ROLE): a Member has the browser in place of the computer, an Admin beside it. */
const SAM_ADMIN = (await control("/info")).sam === "admin";
console.log(`sam is ${SAM_ADMIN ? "an Admin" : "a Member"} of the shared workspace`);

/** The test's own look at the bot's page (not the bot's: it never waits): CDP on the tab in front of the stand-in's Chrome. */
async function cdp(method, params = {}) {
  const tabs = (await (await fetch(`http://127.0.0.1:${ports.chrome}/json/list`)).json()).filter((t) => t.type === "page" && !t.url.startsWith("devtools:"));
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => (ws.once("open", ok), ws.once("error", no)));
  try {
    return await new Promise((ok, no) => {
      ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        if (m.id !== 1) return;
        if (m.error) no(new Error(m.error.message));
        else ok(m.result);
      });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}
const onPage = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true })).result.value;
const directShot = async () => `data:image/png;base64,${(await cdp("Page.captureScreenshot", { format: "png" })).data}`;

let passed = 0;
const log = [];
const mark = (what) => log.push({ at: Date.now(), what });
/** Takes only: a pause a viewer can follow (the checks don't need it). */
const beat = (ms = 1500) => (TAKES ? sleep(ms) : Promise.resolve());
/** Takes only: typing at a person's pace. */
const typing = () => (TAKES ? { delay: 90 } : {});
const test = async (name, f) => {
  mark(name);
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

/* ---------------- Two people ---------------- */

// One browser per person: headless Chrome here crashes making a second context in one browser.
const browsers = [];
/** The film's size: a take is never scaled up to it (screencast frames come at CSS pixels). */
const FILM = { width: 1920, height: 1080 };
const person = async (who) => {
  // A *.test name is this Mac too (a tab of its own, as a Cmd-click opens, isn't held to the route below): nothing is looked up.
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--host-resolver-rules=MAP *.test 127.0.0.1"] });
  browsers.push(browser);
  const context = await browser.newContext({ viewport: TAKES ? FILM : { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // Nothing leaves this Mac.
  await context.route(/^(?!(https?|wss?):\/\/127\.0\.0\.1[:/])(?!data:)(?!blob:)/, (r) => r.abort());
  const page = await context.newPage();
  return { who, context, page, take: TAKES ? await film(page, who) : null };
};

/** Takes only: every frame the page paints (CDP Page.startScreencast), each with its time, to a temp folder. */
async function film(page, who) {
  const take = { who, dir: mkdtempSync(join(tmpdir(), `bops-takes-${who}-`)), cdp: await page.context().newCDPSession(page), frames: [], stills: [], late: [], odd: [], on: true };
  take.cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    void take.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!take.on) return;
    const jpeg = Buffer.from(data, "base64");
    const size = jpegSize(jpeg);
    const got = Date.now() / 1000;
    if (size.width !== FILM.width || size.height !== FILM.height) {
      // The blank page's first paint can come before the viewport does (1920x993 here): the take starts at film size.
      if (take.frames.length === 0) return;
      take.odd.push({ i: take.frames.length, t: got, ...size, url: page.url() });
    }
    const file = join(take.dir, `f${String(take.frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, jpeg);
    take.frames.push({ file, t: metadata.timestamp ?? got });
    take.late.push(got - (metadata.timestamp ?? got));
  });
  await take.cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: FILM.width, maxHeight: FILM.height, everyNthFrame: 1 });
  return take;
}

/** A JPEG's size in pixels, from its start-of-frame marker. */
function jpegSize(b) {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return { width: 0, height: 0 };
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}

/**
 * Takes only: a CDP screenshot of a person's page at a still moment, for the takes check to hold the mp4's frame then
 * against. `cursor`: with the bot's cursor's box then (its arrow and name), which the check finds in the video's frame.
 */
async function still(p, name, { cursor = false } = {}) {
  if (!p.take) return;
  await sleep(300);
  const t0 = Date.now();
  const { data } = await p.take.cdp.send("Page.captureScreenshot", { format: "png" });
  const at = (t0 + Date.now()) / 2000;
  const sidebar = await p.page.evaluate(() => {
    const b = document.querySelector("aside")?.getBoundingClientRect();
    return b && { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  const png = join(p.take.dir, `still-${p.take.stills.length + 1}.png`);
  writeFileSync(png, Buffer.from(data, "base64"));
  const box = cursor
    ? await p.page.evaluate(() => {
        const el = document.querySelector('[data-browser-cursors] [data-agent-cursor="bot"]');
        const rects = el ? [...el.children].map((c) => c.getBoundingClientRect()) : [];
        if (!rects.length) return null;
        const x = Math.min(...rects.map((r) => r.left));
        const y = Math.min(...rects.map((r) => r.top));
        return { x, y, width: Math.max(...rects.map((r) => r.right)) - x, height: Math.max(...rects.map((r) => r.bottom)) - y };
      })
    : null;
  if (cursor) assert.ok(box, `${name}: the bot's cursor on the page`);
  p.take.stills.push({ name, png, at, sidebar, ...(box ? { cursor: box } : {}) });
}

/** Takes only: the frames as <out>/takes/<who>.mp4, a constant 30 fps where each frame is the last one painted at or before its time; then the takes check. */
function toMp4(take) {
  const { frames } = take;
  assert.ok(frames.length > 0, `${take.who}: no frames`);
  assert.equal(take.odd.length, 0, `${take.who}: ${take.odd.length} of ${frames.length} frames not at ${FILM.width}x${FILM.height}: ${JSON.stringify(take.odd.map((o) => ({ ...o, t: Number((o.t - frames[0].t).toFixed(2)) })))}`);
  const seq = join(take.dir, "seq");
  mkdirSync(seq);
  const t0 = frames[0].t;
  const end = frames.at(-1).t + 1; // the last frame held a second
  let i = 0;
  let n = 0;
  for (; t0 + n / 30 < end; n++) {
    while (i + 1 < frames.length && frames[i + 1].t <= t0 + n / 30) i++;
    linkSync(frames[i].file, join(seq, `${String(n).padStart(6, "0")}.jpg`));
  }
  const mp4 = join(OUT, "takes", `${take.who}.mp4`);
  // BT.709, and tagged so on the frames themselves (ffmpeg's -color_primaries and -color_trc alone came out "unknown"),
  // so a player or an editor shows the greys and colours Chrome painted.
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-framerate", "30", "-i", join(seq, "%06d.jpg"), "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv", "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-movflags", "+faststart", mp4], { encoding: "utf8" });
  assert.equal(r.status, 0, `ffmpeg: ${r.stderr}`);
  const probed = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,avg_frame_rate,pix_fmt,color_space,color_primaries,color_transfer,color_range,nb_frames:format=duration", "-of", "json", mp4], { encoding: "utf8" }).stdout);
  const v = probed.streams[0];
  assert.deepEqual(
    [v.codec_name, v.width, v.height, v.r_frame_rate, v.avg_frame_rate, v.pix_fmt, v.color_space, v.color_primaries, v.color_transfer, v.color_range],
    ["h264", FILM.width, FILM.height, "30/1", "30/1", "yuv420p", "bt709", "bt709", "bt709", "tv"],
    `${take.who}.mp4 isn't H.264 ${FILM.width}x${FILM.height} at a constant 30 fps, tagged BT.709`,
  );
  const late = [...take.late].sort((a, b) => a - b)[take.late.length >> 1];
  // The most frames painted in any one second (the screencast sends a frame only when the page changes).
  let peak = 0;
  for (let a = 0, b = 0; b < frames.length; b++) {
    while (frames[b].t - frames[a].t >= 1) a++;
    peak = Math.max(peak, b - a + 1);
  }
  const stills = take.stills.map((s, k) => {
    const png = join(OUT, "takes", "stills", `${take.who}-${k + 1}.png`);
    copyFileSync(s.png, png);
    return { name: s.name, png: `${take.who}-${k + 1}.png`, t: Number((s.at - t0).toFixed(3)), sidebar: s.sidebar, ...(s.cursor ? { cursor: s.cursor } : {}) };
  });
  writeFileSync(join(OUT, "takes", "stills", `${take.who}.json`), JSON.stringify(stills, null, 2));
  const checked = checkTake(mp4, stills.map((s) => ({ ...s, png: join(OUT, "takes", "stills", s.png) })));
  for (const c of checked) console.log(`  takes check, ${take.who}.mp4: ${describe(c)}`);
  console.log(`  ${take.who}.mp4: ${frames.length} frames painted over ${(frames.at(-1).t - t0).toFixed(1)} s (at most ${peak} in a second), ${n} at 30 fps; a frame's time to its arrival here: median ${(late * 1000).toFixed(0)} ms`);
  removeTemp(take.dir);
  return { mp4, t0, frames: frames.length, peak, probed, checked };
}

const owner = await person("owner");
const sam = await person("sam");
const shot = (p, name) => p.screenshot({ path: join(OUT, "shots", `${name}.png`) });

/** What a person's Browser tab shows: the address bar, the state (its look, line and the line's background), the frame (once drawn: true, or with `withFrame` its canvas as a JPEG). */
const view = (p, withFrame = false) =>
  p.evaluate((withFrame) => {
    const box = document.querySelector('[data-bot-browser]');
    if (!box) return null;
    const line = box.querySelector("[data-browser-line]");
    return {
      address: box.querySelector('input[aria-label="Address"]')?.value ?? null,
      readOnly: box.querySelector('input[aria-label="Address"]')?.readOnly ?? null,
      look: box.getAttribute("data-browser-look"),
      line: line?.textContent ?? null,
      lineBg: line ? getComputedStyle(line).backgroundColor : null,
      // Encoded only when asked: a JPEG of the canvas on every poll would load the page being timed.
      frame: withFrame ? (() => {
        const c = box.querySelector("canvas[data-browser-frame]");
        return c && c.dataset.drawn !== undefined ? c.toDataURL("image/jpeg", 0.95) : null;
      })() : box.querySelector("canvas[data-browser-frame][data-drawn]") ? true : null,
    };
  }, withFrame);
const HIGHLIGHTER = "rgb(233, 255, 59)";
/**
 * B2.5: a state of the tab, shot as it is and with every colour taken out (the delete-the-colour test). A CDP shot of
 * the window, cropped to the tab (and desaturated) by ffmpeg: Playwright's element shot changed the screencast's frame
 * size for a moment, and a grayscale filter on the page would show in a take.
 */
async function stateShot(p, name) {
  const box = await p.page.locator("[data-bot-browser]").boundingBox();
  await sleep(250);
  const cdp = p.take?.cdp ?? (p.cdp ??= await p.context.newCDPSession(p.page));
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const full = join(OUT, "shots", `.state-${name}-window.png`);
  writeFileSync(full, Buffer.from(data, "base64"));
  const crop = `crop=${Math.round(box.width)}:${Math.round(box.height)}:${Math.round(box.x)}:${Math.round(box.y)}`;
  for (const [out, vf] of [[`state-${name}.png`, crop], [`state-${name}-gray.png`, `${crop},hue=s=0`]]) {
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", full, "-vf", vf, join(OUT, "shots", out)], { encoding: "utf8" });
    assert.equal(r.status, 0, `ffmpeg: ${r.stderr}`);
  }
  removeTemp(full);
  const v = await view(p.page);
  (results.states ??= {})[name] = { look: v.look, line: v.line, lineBg: v.lineBg };
  return v;
}
/** Who has control of the stand-in's screen now, as its relay says (null: nobody). */
const relayHeld = async () => (await control("/relay")).screens?.[0]?.heldBy ?? null;
/** The panel's tabs, by title, in order (the title bar's row). */
const tabTitles = (p) => p.evaluate(() => [...document.querySelectorAll("div.group\\/tab")].map((t) => t.getAttribute("title")));
const panelTab = (p, title) => p.locator(`div.group\\/tab[title="${title}"]`);
/** Whether the chat shows a line (the hand-back note): in a person's middle pane. */
const chatSays = (p, text) => p.evaluate((t) => document.body.innerText.includes(t), text);

/** A frame shows a page when under this percent of its pixels differ from a direct shot of the page (diff below). */
const MATCH = 0.5;

/** How unlike two images are: the percent of their pixels, at 160x100, whose grey levels differ by more than 48 (0: the same picture). */
const diff = (p, a, b) =>
  p.evaluate(
    async ([a, b]) => {
      const grey = async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = 160;
        c.height = 100;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, 160, 100);
        const d = g.getImageData(0, 0, 160, 100).data;
        const out = [];
        for (let i = 0; i < d.length; i += 4) out.push((d[i] + d[i + 1] + d[i + 2]) / 3);
        return out;
      };
      const [x, y] = await Promise.all([grey(a), grey(b)]);
      return (100 * x.filter((v, i) => Math.abs(v - y[i]) > 48).length) / x.length;
    },
    [a, b],
  );

/** A point on the bot's page (CSS pixels), as a point on a person's frame of it. */
async function onFrame(p, x, y) {
  const size = await onPage("[innerWidth, innerHeight]");
  const r = await p.evaluate(() => {
    const b = document.querySelector('[data-bot-browser] canvas[data-browser-frame]').getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  });
  return { x: r.left + (x / size[0]) * r.width, y: r.top + (y / size[1]) * r.height };
}
const centre = async (selector) => onPage(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
async function clickOnFrame(p, selector) {
  const [x, y] = await centre(selector);
  const at = await onFrame(p, x, y);
  await p.mouse.click(at.x, at.y);
}

/** Every animation frame from now: where the bot's cursor is on the overlay (its px), whether it's dipped, whether a ring shows. */
const startSampling = (p, key = "bot") =>
  p.evaluate((key) => {
    window.__cursor = { samples: [], on: true };
    const loop = (t) => {
      const layer = document.querySelector("[data-browser-cursors]");
      const el = layer?.querySelector(`[data-agent-cursor="${key}"]`);
      if (layer && el) {
        const a = el.getBoundingClientRect();
        const b = layer.getBoundingClientRect();
        window.__cursor.samples.push({ t, x: a.left - b.left, y: a.top - b.top, w: b.width, pressed: el.hasAttribute("data-pressed"), ring: !!layer.querySelector("[data-cursor-ring]") });
      }
      if (window.__cursor.on) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, key);
const stopSampling = (p) =>
  p.evaluate(() => {
    window.__cursor.on = false;
    return window.__cursor.samples;
  });
/** The tag riding a cursor, on a person's overlay: its text, and whether it's showing (not faded at rest). */
const cursorTag = (p, key) =>
  p.evaluate((key) => {
    const el = document.querySelector(`[data-browser-cursors] [data-agent-cursor="${key}"]`);
    return el ? { text: el.querySelector("[data-cursor-name]")?.textContent ?? "", showing: !el.hasAttribute("data-rest") && getComputedStyle(el).opacity !== "0" } : null;
  }, key);

/** The bot goes to a page with a fresh word; resolves with when it was told to and the word. */
async function botGoesToWord() {
  const word = `WORD${randomBytes(3).toString("hex").toUpperCase()}`;
  const before = await directShot();
  const asked = Date.now();
  const step = botStep({ do: "goto", url: `${site}/word/${word}` });
  return { word, before, asked, url: `${site}/word/${word}`, step };
}

/** Within 2 s of the bot's navigation, a person's tab shows its address and a frame of it (like a direct shot of it, unlike the page before). */
async function seesNavigation(p, who) {
  const nav = await botGoesToWord();
  const seen = await until(async () => {
    const v = await view(p);
    return v?.address === nav.url && v.frame && v;
  }, `${who}'s address bar to show ${nav.url}`, 5000);
  await nav.step;
  const direct = await directShot();
  // The frame that matches it: the first one at or after the address, within the 2 s.
  const matched = await until(async () => {
    const v = await view(p, true);
    const d = v?.frame ? await diff(p, v.frame, direct) : 255;
    return d < MATCH && { v, d, at: Date.now() };
  }, `${who}'s frame to show ${nav.word}`, 5000);
  const ms = matched.at - nav.asked;
  const unlike = await diff(p, matched.v.frame, nav.before);
  console.log(`  ${who}: ${nav.word} shown ${ms} ms after the bot was told to go (pixels unlike a direct shot of it: ${matched.d.toFixed(2)}%; unlike the page before: ${unlike.toFixed(2)}%)`);
  assert.ok(ms < 2000, `${who} saw it in ${ms} ms`);
  // The check can tell them apart: the page before would not have counted as a match (how much two pages differ
  // depends on the window's size, so the bar is the match threshold itself, not a fixed percent).
  assert.ok(unlike > MATCH && unlike > 5 * matched.d, `the frame is the new page, not the one before (unlike it: ${unlike.toFixed(2)}%)`);
  assert.ok(seen.address === nav.url);
  return { word: nav.word, url: nav.url, ms };
}

const results = {};
try {
  await test("criterion 1: the owner opens the bot's browser and sees its page within 2 s of a navigation", async () => {
    await owner.page.goto(urls.owner, { waitUntil: "load" });
    // B2 criterion 8: the bot's browser is the tab beside its computer's, without the New tab page.
    const titles = await until(async () => {
      const t = await tabTitles(owner.page);
      return t.includes(`${BOT.name}'s browser`) && t;
    }, "the owner's browser tab", 15_000);
    assert.deepEqual(titles.slice(0, 2), [`${BOT.name}'s computer`, `${BOT.name}'s browser`]);
    console.log(`  B2 criterion 8: the owner's tabs: ${titles.join(", ")}`);
    await shot(owner.page, "owner-browser-tab-by-default");
    await panelTab(owner.page, `${BOT.name}'s browser`).click();
    await until(async () => (await view(owner.page))?.frame, "the owner's frame", 15_000);
    results.owner = await seesNavigation(owner.page, "owner");
    const v = await view(owner.page);
    // (The bot's step just ended: browsing still, or idle once it's been quiet a moment.)
    assert.ok([`${BOT.name} is browsing`, `${BOT.name}'s browser`].includes(v.line), v.line);
    assert.equal(v.readOnly, true, "no control: the address is read-only");
    await shot(owner.page, "after-owner-browser-tab");
    await still(owner, "the owner watches the bot");
    await beat(2000);
  });

  await test(`criterion 2: sam sees the same, ${SAM_ADMIN ? "beside the computer's live view (an Admin)" : "in place of the owner's computer (a Member)"}`, async () => {
    await sam.page.goto(urls.sam, { waitUntil: "load" });
    const opened = await sam.page.evaluate((id) => fetch("/api/workspaces/shared", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: id }) }).then((r) => r.status), PROJECT.id);
    assert.equal(opened, 200);
    await sam.page.reload({ waitUntil: "load" });
    const titles = await until(async () => {
      const t = await tabTitles(sam.page);
      return t.includes(`${BOT.name}'s browser`) && t;
    }, "sam's tab for the bot's browser", 15_000);
    if (SAM_ADMIN) {
      // An Admin keeps the shared computer view (SharedScreen) on the first tab, and has the browser beside it, as the owner does.
      assert.deepEqual(titles.slice(0, 2), ["Owner's computer", `${BOT.name}'s browser`]);
      await until(async () => (await sam.page.locator("[data-shared-screen]").count()) > 0, "the Admin's live computer view (SharedScreen) on the first tab", 15_000);
      await shot(sam.page, "sam-admin-computer-tab");
      await panelTab(sam.page, `${BOT.name}'s browser`).click();
    } else assert.deepEqual(titles, [`${BOT.name}'s browser`], "a Member's first tab is the browser, with nothing beside it");
    console.log(`  sam's tabs: ${titles.join(", ")}`);
    assert.equal(await sam.page.getByText("Its screens show only in the owner's Bops").count(), 0, "not v0.0.37's line");
    await until(async () => (await view(sam.page))?.frame, "sam's frame", 15_000);
    results.sam = await seesNavigation(sam.page, "sam");
    await shot(sam.page, "after-sam-browser-tab");
    await still(sam, "sam watches the bot");
    // Takes: the bot browsing while sam watches.
    if (TAKES) {
      mark("the bot browses while sam watches");
      for (const to of [`${site}/other`, `${site}/`]) {
        await beat(1800);
        await botStep({ do: "goto", url: to });
      }
      await beat(1800);
    }
  });

  // Where the bot's cursor goes, on the start page's empty right side and lower half (nothing there to press).
  const A = { x: 1180, y: 160 };
  const B = { x: 640, y: 470 };
  await test("B2 criterion 2: the bot's cursor travels like a hand to where it presses, and is there before the ring", async () => {
    await botStep({ do: "goto", url: `${site}/` });
    await until(async () => (await view(sam.page))?.address === `${site}/`, "the start page");
    await botStep({ do: "click", ...A });
    await sleep(700);
    await beat(1200);
    mark("Boppy's cursor travels to where it presses");
    await startSampling(sam.page);
    const step = await botStep({ do: "click", ...B });
    await sleep(500);
    const all = await stopSampling(sam.page);
    const width = await onPage("innerWidth");
    const scale = all.at(-1).w / width;
    const target = { x: B.x * scale, y: B.y * scale };
    const ring = all.findIndex((x) => x.ring);
    assert.ok(ring > 0, "a ring showed where it pressed");
    // The way there: from the last frame still at A to the frame the ring shows on.
    const from = all.findLastIndex((x, i) => i < ring && Math.hypot(x.x - A.x * scale, x.y - A.y * scale) < 1);
    const way = all.slice(Math.max(0, from), ring + 1);
    const places = new Set(way.map((x) => `${x.x.toFixed(1)},${x.y.toFixed(1)}`)).size;
    let most = 0;
    for (let i = 1; i < way.length; i++) most = Math.max(most, Math.hypot(way[i].x - way[i - 1].x, way[i].y - way[i - 1].y) / Math.max(1, (way[i].t - way[i - 1].t) / (1000 / 60)));
    const off = Math.hypot(all[ring].x - target.x, all[ring].y - target.y);
    const dist = Math.hypot(B.x - A.x, B.y - A.y);
    console.log(`  a ${dist.toFixed(0)} px move (${(dist * scale).toFixed(0)} px on sam's frame, at ${scale.toFixed(3)}): ${way.length} frames, ${places} places, at most ${most.toFixed(1)} px a frame at 60 fps; ${off.toFixed(2)} px off the target when the ring showed; the bot pressed ${step.clickedAt - step.movedAt} ms after it moved`);
    results.cursor = { dist, scale, frames: way.length, places, most, off };
    assert.ok(dist >= 600);
    assert.ok(places >= 15, `${places} distinct places`);
    // At 1440x900 (the checks' size) the frame is about half the page; a take's 1920x1080 frame is bigger, so the same
    // move covers more of the screen in the same 650 ms: there the step is reported, not held to 25 px.
    if (!TAKES) assert.ok(most <= 25, `${most.toFixed(1)} px in a frame`);
    assert.ok(off <= 1, `${off.toFixed(2)} px off when the ring showed`);
    await shot(sam.page, "sam-sees-bot-cursor");
    await still(sam, "sam sees Boppy's cursor where it pressed", { cursor: true });
    if (TAKES) {
      // More of the bot's hand for the film: to the note field, then away to rest.
      await beat(1500);
      await botStep({ do: "click", selector: "#note" });
      await beat(1500);
      await botStep({ do: "click", ...A });
      await beat(1500);
    }
  });

  await test("B2 criterion 3 (the bot's): both see Boppy's name riding its cursor", async () => {
    for (const p of [owner.page, sam.page]) {
      const tag = await until(() => cursorTag(p, "bot"), "the bot's cursor", 3000);
      assert.equal(tag.text, BOT.name);
    }
  });

  await test("B2 criterion 4: with reduced motion the cursor jumps and doesn't dip; the ring still shows", async () => {
    await sam.page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await startSampling(sam.page);
      await botStep({ do: "click", ...A });
      await sleep(500);
      const all = await stopSampling(sam.page);
      const places = new Set(all.map((x) => `${x.x.toFixed(1)},${x.y.toFixed(1)}`)).size;
      console.log(`  reduced motion: ${places} places over ${all.length} frames; dipped ${all.some((x) => x.pressed)}; ring ${all.some((x) => x.ring)}`);
      assert.ok(places <= 2, `${places} places`);
      assert.equal(all.some((x) => x.pressed), false, "no dip");
      assert.equal(all.some((x) => x.ring), true, "the ring shows");
    } finally {
      await sam.page.emulateMedia({ reducedMotion: null });
    }
  });

  await test("B2 criterion 5 (idle, browsing): the bot's face and the frame's edge say it", async () => {
    const idle = await until(async () => (await view(owner.page))?.look === "idle" && view(owner.page), "the owner's tab idle", 6000);
    assert.equal(idle.line, `${BOT.name}'s browser`);
    await until(async () => (await cursorTag(owner.page, "bot"))?.showing === false, "idle: the bot's cursor faded", 2000);
    await stateShot(owner, "idle");
    const browse = botStep({ do: "browse", urls: [`${site}/other`, `${site}/`], pause: 1800 });
    const v = await until(async () => (await view(owner.page))?.look === "browsing" && view(owner.page), "the owner's tab browsing", 3000);
    assert.equal(v.line, `${BOT.name} is browsing`);
    const motion = await owner.page.evaluate(() => ({
      sweep: getComputedStyle(document.querySelector("[data-browser-sweep]"), "::before").animationName,
      breathing: getComputedStyle(document.querySelector("[data-breathing]")).animationName,
    }));
    assert.deepEqual(motion, { sweep: "browser-sweep", breathing: "breathe" });
    await stateShot(owner, "browsing");
    // Reduced motion: the light goes, the ring holds still (B2.4).
    await owner.page.emulateMedia({ reducedMotion: "reduce" });
    const still = await owner.page.evaluate(() => ({
      sweep: getComputedStyle(document.querySelector("[data-browser-sweep]"), "::before").animationName,
      breathing: getComputedStyle(document.querySelector("[data-breathing]")).animationName,
    }));
    await owner.page.emulateMedia({ reducedMotion: null });
    assert.deepEqual(still, { sweep: "none", breathing: "none" }, "reduced motion: no sweep, no breathing");
    await browse;
  });

  await test("B2 criterion 6: sam presses the page while Boppy browses: control at once, the press goes nowhere, a waiting step runs after Hand back, the chat says so", async () => {
    await until(async () => (await view(sam.page))?.address === `${site}/`, "the start page");
    const browse = botStep({ do: "browse", urls: [`${site}/`], pause: 4000 });
    await until(async () => (await view(sam.page))?.look === "browsing", "sam to see the bot browsing", 3000);
    await beat(1200);
    const [x, y] = await centre("#press");
    const at = await onFrame(sam.page, x, y);
    mark("sam presses the page to take over");
    const pressed = Date.now();
    await sam.page.mouse.click(at.x, at.y);
    await until(async () => ["you", "needs"].includes((await view(sam.page))?.look), "sam to have control", 2000);
    const ms = Date.now() - pressed;
    console.log(`  sam had control ${ms} ms after pressing the page`);
    assert.ok(ms < 500, `${ms} ms`);
    await sleep(800);
    assert.equal(await onPage("document.getElementById('press').textContent"), "Press me", "the press that took over never reached the page");
    let done = null;
    const step = botStep({ do: "read" }).then((r) => (done = { ...r, at: Date.now() }));
    await until(async () => (await view(sam.page))?.line === `${BOT.name} is waiting for you to hand back`, "sam to see the bot waiting on sam", 3000);
    await sleep(1200);
    assert.equal(done, null, "the step waits while sam has control");
    await beat(1200);
    mark("sam hands back; the bot carries on");
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await step;
    assert.ok(done.waited >= 1200, `waited ${done.waited} ms`);
    const said = `${SAM.name} handed back. ${BOT.name} carries on.`;
    for (const p of [sam.page, owner.page]) await until(() => chatSays(p, said), `"${said}" in the chat`, 8000);
    await browse;
    // And it does, its cursor going on from where sam left the page.
    mark("Boppy carries on, its cursor pressing again");
    await botStep({ do: "click", selector: "#note" });
    await beat(1500);
  });

  await test("B2 criterion 7: a step waits while sam has control: the owner sees it, highlighted, within 1 s, and Take over from Sam works", async () => {
    await sam.page.getByRole("button", { name: "Take over", exact: true }).click();
    await until(async () => (await view(sam.page))?.look === "you", "sam to have control");
    const other = await until(async () => (await view(owner.page))?.look === "other" && view(owner.page), "the owner to see sam has control");
    assert.equal(other.line, `${SAM.name} has control`);
    await stateShot(owner, "other");
    await stateShot(sam, "you");
    let done = null;
    const asked = Date.now();
    const step = botStep({ do: "read" }).then((r) => (done = r));
    const needs = await until(async () => (await view(owner.page))?.look === "needs" && view(owner.page), "the owner to see the bot waiting", 3000);
    const ms = Date.now() - asked;
    console.log(`  the owner saw "${needs.line}" ${ms} ms after the step asked (its background ${needs.lineBg})`);
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal(needs.line, `${BOT.name} is waiting for ${SAM.name} to hand back`);
    assert.equal(needs.lineBg, HIGHLIGHTER, "highlighted");
    await stateShot(owner, "needs-you");
    await beat(1500);
    mark("the owner takes over from sam");
    await owner.page.getByRole("button", { name: `Take over from ${SAM.name}`, exact: true }).click();
    await until(async () => (await view(owner.page))?.line === `${BOT.name} is waiting for you to hand back`, "the owner to have control");
    await until(async () => (await view(sam.page))?.line === `${BOT.name} is waiting for Tess to hand back`, "sam to see the owner has it");
    assert.equal(done, null, "still waiting");
    await beat(1500);
    await owner.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await step;
    for (const p of [sam.page, owner.page]) await until(() => chatSays(p, `Tess handed back. ${BOT.name} carries on.`), "the owner's hand back in the chat", 8000);
  });

  await test("B2 criterion 5 (unreachable): the computer cut off says what happened, what's kept, and Try again", async () => {
    await control("/relay/cut", {});
    const v = await until(async () => (await view(owner.page))?.look === "unreachable" && view(owner.page), "the owner's tab out of reach", 5000);
    assert.equal(v.line, `${BOT.name}'s browser can't be reached`);
    assert.equal(await owner.page.locator("[data-browser-away]").innerText().then((t) => t.includes("Its work still shows in the chat.")), true);
    await stateShot(owner, "unreachable");
    // Try again while it's still cut off: asked afresh, and still honest about it.
    await owner.page.getByRole("button", { name: "Try again" }).click();
    await sleep(1500);
    assert.equal((await view(owner.page))?.look, "unreachable");
    // The computer back: the tab comes back by itself.
    await control("/relay/back", {});
    await until(async () => ["idle", "browsing"].includes((await view(owner.page))?.look), "the owner's tab back", 10_000);
    await until(async () => (await view(sam.page))?.frame && ["idle", "browsing"].includes((await view(sam.page))?.look), "sam's tab back", 10_000);
    // Only needs-you's line is highlighter.
    for (const [name, st] of Object.entries(results.states)) assert.equal(st.lineBg === HIGHLIGHTER, name === "needs-you", `${name}: ${st.lineBg}`);
  });

  await test("B2 criterion 9: with the browser out of sight, the Watch chip shows while the bot browses, opens it, and goes", async () => {
    const chip = owner.page.locator("[data-watch-chip]");
    await panelTab(owner.page, `${BOT.name}'s computer`).click();
    await until(async () => !(await view(owner.page)), "the owner's browser out of sight");
    const browse = botStep({ do: "browse", urls: [`${site}/other`, `${site}/`], pause: 1800 });
    const asked = Date.now();
    await chip.waitFor({ timeout: 3000 });
    const ms = Date.now() - asked;
    console.log(`  the Watch chip showed ${ms} ms after the bot started browsing: "${await chip.innerText()}"`);
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal((await chip.innerText()).replace(/\s+/g, " ").trim(), `${BOT.name} is browsing · Watch`);
    await sleep(300);
    await shot(owner.page, "owner-watch-chip");
    await beat(1200);
    mark("the owner presses Watch");
    await chip.click();
    await until(async () => (await view(owner.page))?.look === "browsing", "the browser in sight, browsing");
    assert.equal(await chip.count(), 0, "it goes when the browser shows");
    await browse;
    // Out of sight again, a stretch of browsing: the chip comes, and goes once the browsing stops.
    await panelTab(owner.page, `${BOT.name}'s computer`).click();
    await until(async () => (await chip.count()) === 0 && !(await view(owner.page)), "out of sight, no chip");
    const again = botStep({ do: "browse", urls: [`${site}/`], pause: 1000 });
    await chip.waitFor({ timeout: 3000 });
    await again;
    await chip.waitFor({ state: "detached", timeout: 5000 });
    await panelTab(owner.page, `${BOT.name}'s browser`).click();
    await until(async () => (await view(owner.page))?.frame, "the owner's browser back");
  });

  await test("B2 criterion 10: links in a bot's message open in Boppy's browser for whoever may use it", async () => {
    await until(async () => ["idle", "browsing"].includes((await view(sam.page))?.look), "sam's tab free");
    await botStep({ do: "goto", url: `${site}/` });
    const local = `${site}/other`;
    const named = `http://acme.test:${ports.site}/`;
    assert.ok((await control("/bot/say", { text: `Here's [the other page](${local}), [Acme's site](${named}) and [the notes](/workspace/notes.md).` })).ok);
    for (const p of [sam.page, owner.page]) await p.getByRole("link", { name: "the other page" }).last().waitFor({ timeout: 10_000 });
    await until(async () => (await view(sam.page))?.look === "idle", "the bot idle", 6000);
    await beat(1200);
    // Idle: it opens at once, in sam's control.
    mark("sam opens a link from the chat in Boppy's browser");
    await sam.page.getByRole("link", { name: "the other page" }).last().click();
    await until(async () => (await view(sam.page))?.look === "you", "sam in control", 3000);
    await until(async () => (await onPage("location.href")) === local, "the page there", 5000);
    await until(async () => (await view(sam.page))?.address === local, "sam's bar there");
    await shot(sam.page, "sam-link-in-boppys-browser");
    await beat(1500);
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await until(async () => ["idle", "browsing"].includes((await view(sam.page))?.look), "handed back");
    // A step browsing: asked first; Not now changes nothing; Take over and open goes there.
    await botStep({ do: "goto", url: `${site}/` });
    const browse = botStep({ do: "browse", urls: [`${site}/`], pause: 6000 });
    await until(async () => (await view(sam.page))?.look === "browsing", "the bot browsing", 3000);
    const ask = sam.page.locator("[data-browser-ask]");
    await sam.page.getByRole("link", { name: "the other page" }).last().click();
    await ask.waitFor({ timeout: 3000 });
    assert.match(await ask.innerText(), new RegExp(`${BOT.name} is using its browser. Open the link now\\? ${BOT.name} waits until you hand back.`));
    await sleep(300);
    await shot(sam.page, "sam-link-asks-while-browsing");
    await ask.getByRole("button", { name: "Not now" }).click();
    await ask.waitFor({ state: "detached", timeout: 2000 });
    await sleep(600);
    assert.equal((await view(sam.page))?.look, "browsing", "Not now: nothing changed");
    assert.equal(await onPage("location.pathname"), "/");
    await sam.page.getByRole("link", { name: "the other page" }).last().click();
    await ask.waitFor({ timeout: 3000 });
    await beat(1000);
    await ask.getByRole("button", { name: "Take over and open" }).click();
    await until(async () => (await onPage("location.href")) === local, "the page there", 5000);
    assert.ok(["you", "needs"].includes((await view(sam.page))?.look), "in sam's control");
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await browse;
    await until(async () => ["idle", "browsing"].includes((await view(sam.page))?.look), "handed back");
    // Cmd-click: sam's own browser (a tab of its own here, asking for the address; nothing leaves this Mac: the route
    // refuses it), not Boppy's. (A localhost link's Cmd-click goes to Local as before: never this Mac's own localhost.)
    const before = await onPage("location.href");
    const tab = sam.context.waitForEvent("page", { timeout: 5000 });
    await sam.page.getByRole("link", { name: "Acme's site" }).last().click({ modifiers: ["Meta"] });
    const opened = await tab;
    await opened.waitForLoadState("load").catch(() => {});
    console.log(`  Cmd-click opened a tab of sam's own browser: ${opened.url()}`);
    assert.ok(opened.url() === named || opened.url().startsWith("chrome-error:"), opened.url());
    for (const p of sam.context.pages()) if (p !== sam.page) await p.close();
    await sleep(500);
    assert.equal(await onPage("location.href"), before, "Boppy's browser didn't go there");
    assert.notEqual((await view(sam.page))?.look, "you");
    // A file link: its old path, never Boppy's browser. Sam's is refused in place (a shared workspace's window writes
    // nothing through the app's routes); the owner's goes to /api/files, below.
    await sam.page.getByRole("link", { name: "the notes" }).last().click();
    await sam.page.getByRole("alert").last().waitFor({ timeout: 3000 });
    assert.equal(await onPage("location.href"), before);
    let fileAsked = false;
    await owner.page.route("**/api/files", (r) => {
      fileAsked = true;
      return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "No such file in the test." }) });
    });
    await owner.page.getByRole("link", { name: "the notes" }).last().click();
    await until(() => fileAsked, "the owner's file link's own path (/api/files)");
    await owner.page.unroute("**/api/files");
    assert.equal(await onPage("location.href"), before);
    // The owner's localhost link: still Local (here, with no app on it, the bot's computer).
    await owner.page.getByRole("link", { name: "the other page" }).last().click();
    await until(async () => !(await view(owner.page)) && (await owner.page.locator(`div.group\\/tab[title="${BOT.name}'s computer"].bg-white`).count()) === 1, "the owner's Local path (the computer's tab)", 5000);
    assert.equal(await onPage("location.href"), before, "not in Boppy's browser");
    // The owner's link to another site: Boppy's browser, in the owner's control.
    await owner.page.getByRole("link", { name: "Acme's site" }).last().click();
    await until(async () => (await view(owner.page))?.look === "you", "the owner in control", 5000);
    await until(async () => (await onPage("location.href")) === named, "the named site there", 5000);
    await owner.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await until(async () => ["idle", "browsing"].includes((await view(owner.page))?.look), "the owner handed back");
    // The browser shown again later never opens that link again (the ask was taken once).
    await panelTab(owner.page, `${BOT.name}'s computer`).click();
    await until(async () => !(await view(owner.page)), "the owner's browser out of sight");
    await panelTab(owner.page, `${BOT.name}'s browser`).click();
    await until(async () => (await view(owner.page))?.frame, "the owner's browser back");
    await sleep(1500);
    assert.ok(["idle", "browsing"].includes((await view(owner.page))?.look), "no take over on showing it again");
    assert.equal(await relayHeld(), null, "nobody has control");
  });

  await test("tabs: a link opens in a new tab of Boppy's browser, the bot's page kept; the strip switches tabs; hand back puts the bot's tab in front again", async () => {
    const chromeTabs = async () => (await (await fetch(`http://127.0.0.1:${ports.chrome}/json/list`)).json()).filter((t) => t.type === "page" && !t.url.startsWith("devtools:"));
    const strip = (p) => p.evaluate(() => [...document.querySelectorAll("[data-bot-browser] [data-browser-tab]")].map((b) => ({ name: b.textContent, front: b.getAttribute("aria-selected") === "true" })));
    // From one tab: the bot's own, on the site.
    for (const t of (await chromeTabs()).slice(1)) await fetch(`http://127.0.0.1:${ports.chrome}/json/close/${t.id}`);
    await until(async () => (await chromeTabs()).length === 1, "one tab");
    await until(async () => ["idle", "browsing"].includes((await view(sam.page))?.look), "sam's tab free");
    await botStep({ do: "goto", url: `${site}/` });
    const botTab = (await chromeTabs())[0].id;
    await until(async () => (await view(sam.page))?.look === "idle", "the bot idle", 6000);
    assert.deepEqual(await strip(sam.page), [], "one tab: no strip");
    // Sam opens a link from the chat: a new tab, in front, in sam's control; the bot's page is still open.
    mark("sam opens a link from the chat in a new tab of Boppy's browser");
    const local = `${site}/other`;
    await sam.page.getByRole("link", { name: "the other page" }).last().click();
    await until(async () => (await view(sam.page))?.look === "you", "sam in control", 3000);
    const two = await until(async () => {
      const t = await chromeTabs();
      return t.length === 2 && t;
    }, "a second tab in the bot's Chrome", 5000);
    assert.deepEqual(two.map((t) => t.url).sort(), [`${site}/`, local].sort(), "the bot's page kept, the link beside it");
    assert.equal(await onPage("location.href"), local, "the new tab in front");
    const shown = await until(async () => {
      const s = await strip(sam.page);
      return s.length === 2 && s.find((x) => x.front)?.name === "Another test page" && s;
    }, "sam's strip: two tabs, the new one in front", 5000);
    assert.equal(shown[0].name, "Acme test page", "oldest first");
    await until(async () => (await strip(owner.page)).length === 2, "the owner sees the same tabs", 5000);
    await shot(sam.page, "tabs-link-in-new-tab");
    // The strip switches: the bot's tab in front, its page there.
    await sam.page.locator(`[data-bot-browser] [data-browser-tab="${botTab}"]`).click();
    await until(async () => (await onPage("location.href")) === `${site}/`, "the bot's tab in front", 5000);
    await until(async () => (await strip(sam.page)).find((x) => x.front)?.name === "Acme test page", "the strip says so", 5000);
    assert.deepEqual((await strip(sam.page)).map((x) => x.name), ["Acme test page", "Another test page"], "nothing moved");
    // Back to sam's tab, then hand back: the bot's tab is in front again, sam's still open.
    await sam.page.locator("[data-bot-browser] [data-browser-tab]").nth(1).click();
    await until(async () => (await onPage("location.href")) === local, "sam's tab in front", 5000);
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await until(async () => (await onPage("location.href")) === `${site}/`, "the bot's tab in front after hand back", 5000);
    assert.equal((await chromeTabs()).length, 2);
    await until(async () => ["idle", "browsing"].includes((await view(sam.page))?.look), "handed back");
    // Nobody in control: pressing a tab takes over and switches (as pressing the page does); in control, a tab closes.
    await sam.page.locator("[data-bot-browser] [data-browser-tab]").nth(1).click();
    await until(async () => (await view(sam.page))?.look === "you" && (await onPage("location.href")) === local, "taken over and switched", 5000);
    await sam.page.getByRole("button", { name: "Close Another test page" }).click();
    await until(async () => (await chromeTabs()).length === 1 && (await strip(sam.page)).length === 0, "one tab again, no strip", 5000);
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await until(async () => ["idle", "browsing"].includes((await view(sam.page))?.look), "handed back");
    assert.equal(await onPage("location.href"), `${site}/`);
  });

  await test("B2 criterion 11: the bot asks for a sign-in; sam signs in in its browser and hands back; the bot reads the signed-in page", async () => {
    mark("the bot asks sam to sign in");
    const step = botStep({ do: "signin" });
    const ask = sam.page.getByRole("button", { name: `Sign in in ${BOT.name}'s browser` }).last();
    await ask.waitFor({ timeout: 10_000 });
    const needs = await until(async () => (await view(sam.page))?.line === `${BOT.name} needs you to sign in` && view(sam.page), "sam's tab to say the bot needs sam", 5000);
    assert.equal(needs.lineBg, HIGHLIGHTER);
    await stateShot(sam, "needs-you-sign-in");
    await beat(1500);
    await ask.click();
    await until(async () => (await view(sam.page))?.look === "needs" && (await view(sam.page))?.readOnly === false, "sam in control, the bot still needing sam", 3000);
    await until(async () => (await view(sam.page))?.address === `${site}/login`, "the sign-in page");
    await beat(800);
    await clickOnFrame(sam.page, "#user");
    await sam.page.keyboard.type(ACCOUNT.user, typing());
    await clickOnFrame(sam.page, "#password");
    await sam.page.keyboard.type(ACCOUNT.password, typing());
    await sam.page.keyboard.press("Enter");
    await until(async () => (await onPage("location.pathname")) === "/account", "signed in", 8000);
    await beat(1200);
    mark("sam hands back; the bot reads the signed-in page");
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    const r = await step;
    console.log(`  the sign-in step read: ${r.signedInAs} (it waited ${r.waited} ms)`);
    assert.equal(r.signedInAs, ACCOUNT.name);
    for (const p of [owner.page, sam.page]) assert.ok(!(await p.evaluate(() => fetch("/api/state").then((x) => x.text()))).includes(ACCOUNT.password), "not in /api/state");
    assert.ok(!readFileSync(join(root, ".scratch", "two-person", "stack.log"), "utf8").includes(ACCOUNT.password), "not in Bops Cloud's or the relay's log");
    await beat(1500);
  });

  await test("criterion 7 (read-only): without control the address bar can't be typed in", async () => {
    const box = sam.page.locator('[data-bot-browser] input[aria-label="Address"]');
    const was = await box.inputValue();
    await box.click();
    await sam.page.keyboard.type(`${site}/other`);
    await sam.page.keyboard.press("Enter");
    await sleep(800);
    assert.equal(await box.inputValue(), was);
    assert.ok(!(await onPage("location.href")).endsWith("/other"), "the page didn't go anywhere");
  });

  await test("criterion 4: sam takes over, clicks and types, a bot step waits, and runs once sam hands back", async () => {
    await botStep({ do: "goto", url: `${site}/` });
    await beat();
    mark("sam takes over");
    await sam.page.getByRole("button", { name: "Take over", exact: true }).click();
    await until(async () => (await view(sam.page))?.line === `You have control. ${BOT.name} waits.`, "sam to have control");
    await until(async () => (await view(owner.page))?.line === `${SAM.name} has control`, "the owner to see sam has it");
    // One person at a time: the owner's is "Take over from Sam" now (B2: the owner can override a member).
    assert.equal(await owner.page.getByRole("button", { name: `Take over from ${SAM.name}`, exact: true }).isEnabled(), true, "the owner can take it from sam");
    // B2 criterion 3: sam's hand on the page is "Sam" to the owner, following it; sam sees only sam's own pointer.
    const [px, py] = [900, 300];
    const there = await onFrame(sam.page, px, py);
    mark("the owner sees Sam's named cursor");
    await sam.page.mouse.move(there.x - 120, there.y + 60);
    await sam.page.mouse.move(there.x, there.y, { steps: TAKES ? 40 : 6 });
    const handMoved = Date.now();
    const followed = await until(async () => {
      const r = await owner.page.evaluate((key) => {
        const layer = document.querySelector("[data-browser-cursors]");
        const el = layer?.querySelector(`[data-agent-cursor="${key}"]`);
        if (!el) return null;
        const a = el.getBoundingClientRect();
        const b = layer.getBoundingClientRect();
        return { x: a.left - b.left, y: a.top - b.top, w: b.width, text: el.querySelector("[data-cursor-name]")?.textContent };
      }, SAM.id);
      if (!r) return null;
      const s = r.w / (await onPage("innerWidth"));
      return Math.hypot(r.x - px * s, r.y - py * s) < 2 && r;
    }, "the owner to see sam's cursor where sam moved it", 3000);
    console.log(`  the owner saw "${followed.text}" follow sam's moves ${Date.now() - handMoved} ms after the last`);
    assert.ok(Date.now() - handMoved < 1000);
    assert.equal(followed.text, SAM.name);
    assert.equal(await cursorTag(sam.page, SAM.id), null, "sam sees no arrow for Sam");
    assert.equal((await cursorTag(sam.page, "bot"))?.showing ?? false, false, "and the bot's has faded");
    await shot(owner.page, "owner-sees-sam-cursor");
    if (TAKES) {
      // Sam's hand wanders a little, for the owner's film.
      await sam.page.mouse.move(there.x - 200, there.y + 120, { steps: 40 });
      await sleep(400);
      await sam.page.mouse.move(there.x, there.y, { steps: 40 });
      await beat(1200);
    }
    await shot(owner.page, "owner-sees-sam-in-control");
    await still(owner, "the owner sees sam in control");
    // A bot step on that screen, asked now: it waits.
    let stepDone = null;
    const asked = Date.now();
    const step = botStep({ do: "read" }).then((r) => (stepDone = { ...r, at: Date.now() }));
    await sleep(1500);
    assert.equal(stepDone, null, "the bot's step waits while sam has control");
    await beat(1000);
    // Sam's own press rings at once where sam pressed, on sam's frame, without waiting for the page's answer (the
    // page's own pointer event for it is sam's, so it never draws one).
    const pressAt = await onFrame(sam.page, ...(await centre("#press")));
    await sam.page.mouse.move(pressAt.x, pressAt.y);
    const pressed = Date.now();
    await sam.page.mouse.down();
    const ring = await until(
      () => sam.page.evaluate(() => {
        const r = document.querySelector("[data-bot-browser] [data-browser-cursors] [data-cursor-ring]")?.getBoundingClientRect();
        return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }),
      "sam's own press to ring",
      400,
    );
    console.log(`  sam's own press rang ${Date.now() - pressed} ms after it, ${Math.hypot(ring.x - pressAt.x, ring.y - pressAt.y).toFixed(1)} px from it`);
    await sam.page.mouse.up();
    assert.ok(Math.hypot(ring.x - pressAt.x, ring.y - pressAt.y) < 3, "the ring is where sam pressed");
    await until(async () => (await onPage("document.getElementById('press').textContent")) === "Pressed by a person", "the page's button to react");
    await beat(1000);
    await clickOnFrame(sam.page, "#note");
    await sam.page.keyboard.type("hello from Sam", typing());
    await until(async () => (await onPage("document.getElementById('echo').textContent")) === "hello from Sam", "the field to take sam's typing");
    await until(async () => (await diff(sam.page, (await view(sam.page, true)).frame, await directShot())) < MATCH, "sam's frame to show it");
    await shot(sam.page, "sam-in-control-typed");
    await still(sam, "sam in control, typed");
    // A method outside the allowlist: refused before it reaches the bot's computer.
    const post = (body) => sam.page.evaluate((b) => fetch("/api/browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) })), body);
    const refused = await post({ bot: "boppy", project: PROJECT.id, act: "input", method: "Runtime.evaluate", params: { expression: "document.title='owned'" } });
    assert.equal(refused.status, 400);
    // A window still showing another workspace (its own, here) never acts in this one by a bot of the same id.
    const moved = await post({ bot: "boppy", act: "input", method: "Input.insertText", params: { text: "not here" } });
    assert.deepEqual([moved.status, moved.code], [409, "workspace_changed"]);
    const movedWatch = await sam.page.evaluate(() => fetch("/api/browser?bot=boppy").then((r) => r.text()));
    assert.match(movedWatch, /"code":"workspace_changed"/);
    await sleep(500);
    assert.equal(await onPage("document.title"), "Acme test page");
    assert.equal(stepDone, null, "still waiting");
    await beat();
    mark("sam hands back; the bot's step runs");
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await step;
    console.log(`  the bot's step waited ${stepDone.waited} ms, and ran once sam handed back`);
    assert.ok(stepDone.waited >= 1500 && stepDone.at - asked >= 1500);
    assert.match(stepDone.text, /hello from Sam/, "it read the page as sam left it");
    await until(async () => (await view(owner.page))?.line === `${BOT.name} is browsing`, "the owner to see the bot browsing again");
    await still(owner, "the owner sees the bot browsing again");
    await beat();
  });

  await test("criteria 7 and 5: in control, sam goes to the sign-in page by its address and signs in; the bot reads the signed-in page", async () => {
    mark("sam takes over to sign in");
    await sam.page.getByRole("button", { name: "Take over", exact: true }).click();
    await until(async () => (await view(sam.page))?.line === `You have control. ${BOT.name} waits.`, "sam to have control");
    const box = sam.page.locator('[data-bot-browser] input[aria-label="Address"]');
    assert.equal(await box.evaluate((e) => e.readOnly), false);
    await beat(1000);
    await box.click();
    await box.fill(`${site}/other`);
    await box.press("Enter");
    await until(async () => (await onPage("location.href")) === `${site}/other`, "the page to go to the typed address");
    await until(async () => (await view(sam.page))?.address === `${site}/other`, "sam's bar to say so");
    await beat(1000);
    await box.click();
    if (TAKES) {
      await box.fill("");
      await box.pressSequentially(`${site}/login`, typing());
    } else await box.fill(`${site}/login`);
    await box.press("Enter");
    await until(async () => (await onPage("location.pathname")) === "/login", "the sign-in page");
    await until(async () => (await view(sam.page))?.address === `${site}/login`, "sam's bar on the sign-in page");
    await sleep(400);
    await beat(1000);
    await clickOnFrame(sam.page, "#user");
    await sam.page.keyboard.type(ACCOUNT.user, typing());
    await clickOnFrame(sam.page, "#password");
    await sam.page.keyboard.type(ACCOUNT.password, typing());
    await beat(600);
    await sam.page.keyboard.press("Enter");
    await until(async () => (await onPage("location.pathname")) === "/account", "the account page", 8000);
    await until(async () => (await view(sam.page))?.address === `${site}/account`, "sam's bar on the account page");
    await sleep(600);
    await shot(sam.page, "sam-signed-in");
    await still(sam, "sam signed in");
    await beat(2000);
    mark("sam hands back; the bot reads the signed-in page and carries on");
    await sam.page.getByRole("button", { name: "Hand back", exact: true }).click();
    await until(async () => ["browsing", "idle"].includes((await view(sam.page))?.look), "handed back");
    const read = await botStep({ do: "read" });
    const name = /Signed in as (.+)/.exec(read.text)?.[1]?.trim();
    console.log(`  the bot step read the signed-in name: ${name}`);
    results.signedInName = name;
    assert.equal(name, ACCOUNT.name);
    // The password went nowhere but the page: not in either app's state, nor in the bot's chat.
    for (const p of [owner.page, sam.page]) assert.ok(!(await p.evaluate(() => fetch("/api/state").then((r) => r.text()))).includes(ACCOUNT.password));
    // The bot carries on from there.
    await beat();
    await botStep({ do: "goto", url: `${site}/other` });
    await until(async () => (await view(sam.page))?.address === `${site}/other`, "sam to see the bot carry on");
    await beat(2000);
  });

  await test("criterion 6: both close the tab; no frame is sent after, and capture stops within 5 s", async () => {
    // The owner goes to the computer's tab (the browser's doesn't close); sam leaves the shared workspace's page.
    await panelTab(owner.page, `${BOT.name}'s computer`).click();
    await sam.page.goto("about:blank");
    const left = Date.now();
    await sleep(500);
    const sent = (await control("/relay")).screens[0].framesSent;
    const stopped = await until(async () => (await control("/relay")).screens[0].capturing === false && Date.now(), "the capture to stop", 8000);
    await sleep(2000);
    const after = (await control("/relay")).screens[0].framesSent;
    console.log(`  capture stopped ${stopped - left} ms after the last viewer left; frames sent after they left: ${after - sent}`);
    assert.ok(stopped - left >= 4500 && stopped - left < 6500, "about 5 s");
    assert.equal(after, sent);
  });
} catch (e) {
  console.error(`not ok - ${e.stack ?? e}`);
  await shot(sam.page, "failed-sam").catch(() => {});
  await shot(owner.page, "failed-owner").catch(() => {});
  process.exitCode = 1;
} finally {
  for (const p of [owner, sam])
    if (p.take) {
      p.take.on = false;
      await p.take.cdp.send("Page.stopScreencast").catch(() => {});
    }
  await owner.context.close().catch(() => {});
  await sam.context.close().catch(() => {});
  for (const b of browsers) await b.close().catch(() => {});
  const takes = {};
  if (TAKES)
    for (const p of [owner, sam])
      try {
        takes[p.who] = toMp4(p.take);
        if (!takes[p.who].checked.every((c) => c.ok)) throw new Error(`the takes check failed on ${p.who}.mp4`);
        console.log(`ok - ${p.who}.mp4 holds what the page showed at ${takes[p.who].checked.length} still moments`);
      } catch (e) {
        console.error(`not ok - ${e.message}`);
        process.exitCode = 1;
        removeTemp(p.take.dir);
      }
  mkdirSync(join(OUT, "logs"), { recursive: true });
  writeFileSync(join(OUT, "logs", "e2e-marks.json"), JSON.stringify({ marks: log, takeStart: Object.fromEntries(Object.entries(takes).map(([w, t]) => [w, t.t0])), results }, null, 2));
  if (TAKES && takes.owner && takes.sam) {
    const at = (who, t) => `${Math.max(0, t / 1000 - takes[who].t0).toFixed(1)} s`;
    const rows = log.map((m) => `| ${at("owner", m.at)} | ${at("sam", m.at)} | ${m.what} |`);
    const probe = (who) => {
      const { probed, frames, peak, mp4 } = takes[who];
      const v = probed.streams[0];
      return `| \`${who}.mp4\` | ${(statSync(mp4).size / 1e6).toFixed(1)} MB | ${v.width}x${v.height} | ${v.r_frame_rate} constant (${v.nb_frames} frames, ${Number(probed.format.duration).toFixed(1)} s) | ${v.codec_name} ${v.profile}, ${v.pix_fmt}, BT.709 (primaries, transfer, matrix), crf 12 | ${frames} frames painted, at most ${peak} in a second |`;
    };
    const checks = Object.entries(takes).flatMap(([who, t]) => t.checked.map((c) => `- \`${who}.mp4\` ${describe(c)}`));
    writeFileSync(
      join(OUT, "takes", "TAKES.md"),
      [
        `# Takes: Boppy's browser, its cursor, who has control, and links that open there (local two-person stack, headless Chrome, ${FILM.width}x${FILM.height})`,
        "",
        "Recorded by `node scripts/test-browser-tab-e2e.mjs --takes`, which wrote this: each person's page filmed with CDP `Page.startScreencast` (JPEG at quality 95, CSS pixels, never scaled), each frame at its own time, assembled at a constant 30 fps (each frame the last one painted at or before its time).",
        "",
        "| File | Size | Resolution | fps | Video | Captured |",
        "|---|---|---|---|---|---|",
        probe("owner"),
        probe("sam"),
        "",
        "| File | What it shows |",
        "|---|---|",
        "| `owner.mp4` | The owner's Bops: Boppy's browser in the tab beside its computer's; Boppy's named cursor travelling and pressing; the states (browsing, idle, Sam has control, \"Boppy is waiting for Sam to hand back\" in highlighter, Take over from Sam, can't be reached); the Watch chip while the browser is out of sight, and pressing Watch; links from the chat (Local for a localhost link, Boppy's browser for another site); Sam's named cursor following Sam's hand while Sam drives; the bot browsing again. |",
        "| `sam.mp4` | Sam's Bops (a teammate with Write and Use its computer): Boppy's browser in place of the owner's computer; Boppy's cursor travelling to where it presses, with its name; pressing the page to take over (the press goes nowhere), Hand back, the chat's \"Sam handed back. Boppy carries on.\" and Boppy's cursor carrying on; opening a link from the chat in Boppy's browser, and being asked first while Boppy browses; Boppy asking for a sign-in, \"Sign in in Boppy's browser\", signing in, Hand back, Boppy reading the signed-in page; B1's take over, typing and sign-in by the address bar. |",
        "",
        "Where each moment is in each video:",
        "",
        "| owner.mp4 | sam.mp4 | Moment |",
        "|---|---|---|",
        ...rows,
        "",
        "Known blemishes, to cut: `sam.mp4` opens on sam's own workspace (\"Main\", \"Boppy doesn't have a computer yet\") for about a second before the shared one loads. Whenever `owner.mp4` shows the owner's computer tab (the Watch chip, the localhost link, the end), the stand-in computer has no screens, so it says \"Screen unavailable\" beside the app's idle clock. The test's own checks run between moments (a cut-off computer, Try again, reduced motion for a moment), and the chat keeps the test's messages.",
        "",
        "The takes check (scripts/check-takes.mjs; rerun: `node scripts/check-takes.mjs takes/sam.mp4 takes/stills/sam.json`): at each still moment, the mp4's frame against a CDP `Page.captureScreenshot` taken then (`stills/`). Passes when the sidebar's background is within 3 levels and under 2 % of pixels differ by more than 16, and, at a moment with the bot's cursor, its ink is in the video's frame where the page had it.",
        "",
        ...checks,
        "",
        "All made up and local: the test site, the account, the keys (scripts/fixtures/two-person.mjs). No real password, no real site.",
      ].join("\n"),
    );
  }
  if (started) spawnSync(process.execPath, [join(root, "scripts", "dev-two-person.mjs"), "stop"], { stdio: "inherit" });
}
console.log(`browser tab end to end: ${passed} passed`);
