// A take against what its page showed. At each marked moment, the video's frame is decoded and compared with a CDP
// Page.captureScreenshot of the page taken then (scripts/test-browser-tab-e2e.mjs --takes writes both, and runs this).
// A moment passes when:
// - the video is the screenshot's size (never scaled);
// - the sidebar's background is within 3 levels of the screenshot's on each channel: the commonest colour in the
//   sidebar's box of the screenshot, at a pixel whose 5x5 square is all that colour (the light grey a low-bitrate
//   recording loses first: Playwright's VP8 takes lost it, with the address bar box and the card outlines);
// - under 2 % of all pixels differ by more than 16 levels on some channel;
// - with a `cursor` box (the bot's cursor, its arrow and name, on screen then): the cursor is in the video's frame, not
//   only on the page: its ink (pixels at most 60 on every channel: the arrow is #0A0A0A) fills the box in the video at
//   least half as much as in the screenshot, and at least 20 pixels' worth. (A cursor is too small for the 2 % to see.)
// Usage: node scripts/check-takes.mjs <video> <stills.json>
//   stills.json: [{ "name", "png", "t": seconds into the video, "sidebar": { "x", "y", "width", "height" }, "cursor"?: { "x", "y", "width", "height" } }, ...]
//   Prints a line per moment, then VERDICT: PASS or FAIL (exit 1).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${String(r.stderr).trim()}`);
  return r.stdout;
};
const sizeOf = (file) => {
  const [width, height] = String(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])).trim().split(",").map(Number);
  return { width, height };
};
/** One frame as RGB bytes: the image, or the video's frame at `t` seconds. */
const rgb = (file, t) => run("ffmpeg", ["-v", "error", ...(t === undefined ? [] : ["-ss", String(t)]), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);

/** The sidebar's background in a screenshot: its commonest colour, at the pixel nearest the box's centre inside a 5x5 square of only that colour. */
function sidebarPixel(px, width, box) {
  const at = (x, y) => (y * width + x) * 3;
  const key = (i) => (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
  const x0 = Math.max(2, Math.round(box.x)), y0 = Math.max(2, Math.round(box.y));
  const x1 = Math.round(box.x + box.width) - 3, y1 = Math.round(box.y + box.height) - 3;
  const count = new Map();
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) count.set(key(at(x, y)), (count.get(key(at(x, y))) ?? 0) + 1);
  const colour = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let best = null;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (best && d >= best.d) continue;
      let flat = true;
      for (let dy = -2; dy <= 2 && flat; dy++) for (let dx = -2; dx <= 2 && flat; dx++) flat = key(at(x + dx, y + dy)) === colour;
      if (flat) best = { x, y, d };
    }
  return best && { x: best.x, y: best.y };
}

/** How many of a box's pixels are ink (at most 60 on every channel), in an RGB frame of `size`. */
function inkIn(px, size, box) {
  let n = 0;
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(size.height, Math.ceil(box.y + box.height)); y++)
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(size.width, Math.ceil(box.x + box.width)); x++) {
      const i = (y * size.width + x) * 3;
      if (px[i] <= 60 && px[i + 1] <= 60 && px[i + 2] <= 60) n++;
    }
  return n;
}

/** Each moment of `stills` checked against `video`: what was measured, and whether it passed (and why not). */
export function checkTake(video, stills) {
  const v = sizeOf(video);
  return stills.map((s) => {
    const shot = sizeOf(s.png);
    if (shot.width !== v.width || shot.height !== v.height) return { name: s.name, t: s.t, ok: false, why: `the video is ${v.width}x${v.height}, the screenshot ${shot.width}x${shot.height}` };
    const a = rgb(s.png);
    const b = rgb(video, s.t);
    if (a.length !== b.length) return { name: s.name, t: s.t, ok: false, why: `no frame at ${s.t} s` };
    let over = 0;
    for (let i = 0; i < a.length; i += 3) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 16) over++;
    const overPct = (100 * over) / (a.length / 3);
    const p = sidebarPixel(a, v.width, s.sidebar);
    if (!p) return { name: s.name, t: s.t, ok: false, overPct, why: "no flat sidebar background in the screenshot's sidebar box" };
    const i = (p.y * v.width + p.x) * 3;
    const want = [a[i], a[i + 1], a[i + 2]];
    const got = [b[i], b[i + 1], b[i + 2]];
    const delta = Math.max(...want.map((c, k) => Math.abs(c - got[k])));
    const cursor = s.cursor ? { inShot: inkIn(a, v, s.cursor), inVideo: inkIn(b, v, s.cursor) } : undefined;
    const why = [
      delta > 3 && `sidebar background off by ${delta} levels`,
      overPct >= 2 && `${overPct.toFixed(2)} % of pixels off by more than 16`,
      cursor && (cursor.inShot < 20 || cursor.inVideo < Math.max(20, cursor.inShot / 2)) && `the cursor's box has ${cursor.inVideo} ink pixels in the video, ${cursor.inShot} in the screenshot`,
    ]
      .filter(Boolean)
      .join("; ");
    return { name: s.name, t: s.t, ok: !why, overPct, sidebar: { at: p, want, got, delta }, ...(cursor ? { cursor } : {}), ...(why ? { why } : {}) };
  });
}

export const describe = (r) =>
  `${r.ok ? "ok" : "not ok"} - ${r.name} at ${r.t.toFixed(2)} s: ` +
  (r.sidebar ? `sidebar background at (${r.sidebar.at.x}, ${r.sidebar.at.y}) rgb(${r.sidebar.want}) in the screenshot, rgb(${r.sidebar.got}) in the video (${r.sidebar.delta} levels); ` : "") +
  (r.overPct !== undefined ? `${r.overPct.toFixed(2)} % of pixels off by more than 16` : "") +
  (r.cursor ? `; the bot's cursor: ${r.cursor.inVideo} ink pixels in its box in the video, ${r.cursor.inShot} in the screenshot` : "") +
  (r.why ? ` (${r.why})` : "");

if (import.meta.url === `file://${process.argv[1]}`) {
  const [video, stillsFile] = process.argv.slice(2);
  if (!video || !stillsFile) {
    console.error("Usage: node scripts/check-takes.mjs <video> <stills.json>");
    process.exit(2);
  }
  const base = dirname(resolve(stillsFile));
  const stills = JSON.parse(readFileSync(stillsFile, "utf8")).map((s) => ({ ...s, png: resolve(base, s.png) }));
  const results = checkTake(video, stills);
  for (const r of results) console.log(describe(r));
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(`VERDICT: ${ok ? "PASS" : "FAIL"} (${video})`);
  process.exit(ok ? 0 : 1);
}
