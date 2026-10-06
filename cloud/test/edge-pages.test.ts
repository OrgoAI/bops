import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { closeDb } from "../db.ts";
import { startCloud, type Listening } from "./edge-fakes.ts";

/** The public pages (cloud/pages.ts): /connected, /oauth/callback, and the pictures in cloud/public. None needs a user or a database. */

let cloud: Listening;
const get = (path: string) => fetch(`${cloud.url}${path}`, { redirect: "manual" });
/** A GET with the path exactly as written (fetch would tidy away "..", "//" and backslashes first). */
const rawGet = (path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(cloud.url);
    const req = request({ hostname, port, method: "GET", path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

before(async () => {
  cloud = await startCloud();
});

after(async () => {
  await cloud.close();
  await closeDb();
});

test("/connected: Bops' own page after an app's sign-in, with every value from the address escaped", async () => {
  const res = await get("/connected?app=Gmail&status=success");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.match(html, /<title>Gmail is connected · Bops<\/title>/);
  assert.match(html, /Your bots can use it now\. You can close this tab and go back to Bops\./);
  // Behind the proxy the page is at <public>/api/connected: its pictures are relative, so they stay under /api.
  assert.match(html, /<img src="brand\/bops-512\.png" alt="Bops">/);
  assert.match(html, /<link rel="icon" href="brand\/bops-512\.png">/);
  assert.ok(!html.includes('"/brand'), "never an address from the root");
  assert.ok(!html.includes(String.fromCharCode(0x2014)), "no em dashes");

  const failed = await (await get("/connected?app=Notion&status=failed")).text();
  assert.match(failed, /Notion didn't connect/);
  assert.match(failed, /Nothing was saved\. Go back to Bops and try again\./);
  assert.match(failed, /<script><\/script>/, "a failed one stays open");
  assert.match(await (await get("/connected")).text(), /<title>Connected · Bops<\/title>/);

  const evil = await get(`/connected?app=${encodeURIComponent(`<script>alert("x")</script><img src=x onerror='y'>&`)}`);
  const page = await evil.text();
  assert.ok(!page.includes("<script>alert"), "no markup from the address");
  assert.ok(!page.includes("<img src=x"), "no markup from the address");
  assert.match(page, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&lt;img src=x onerror=&#39;y&#39;&gt;&amp;/);
  // Only the page's own style and script run.
  const csp = evil.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  const script = /<script>(.*?)<\/script>/.exec(page)![1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(page)![1];
  assert.ok(csp.includes(`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`));
  assert.ok(csp.includes(`style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'`));
  assert.ok(!csp.includes("unsafe-inline"));
  assert.equal(evil.headers.get("x-content-type-options"), "nosniff");
});

test("/oauth/callback: straight on to Composio with the query as it came, and the code never logged", async () => {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const query = "?code=4%2F0AX4XfWh-secret-code&state=st_abc123&scope=chat%3Awrite";
    const res = await get(`/oauth/callback${query}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://backend.composio.dev/api/v3/toolkits/auth/callback${query}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const bare = await get("/oauth/callback");
    assert.equal(bare.headers.get("location"), "https://backend.composio.dev/api/v3/toolkits/auth/callback");
  } finally {
    Object.assign(console, saved);
  }
  assert.ok(!lines.some((l) => l.includes("secret-code")), "the code isn't in any log");
  assert.equal((await fetch(`${cloud.url}/oauth/callback?code=x`, { method: "POST" })).status, 404);
});

test("/mascot and /brand: the fixed pictures, with their own types, and nothing else", async () => {
  const png = await get("/mascot/main-0A0A0A.png");
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(png.headers.get("cache-control"), "public, max-age=86400");
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.deepEqual(bytes, readFileSync(new URL("../public/mascot/main-0A0A0A.png", import.meta.url)));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  const jpg = await get("/mascot/blob-2EC4B6.jpg");
  assert.equal(jpg.status, 200);
  assert.equal(jpg.headers.get("content-type"), "image/jpeg");
  const logo = await get("/brand/bops-512.png");
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  // Twice: the same bytes from what was kept.
  assert.deepEqual(Buffer.from(await (await get("/brand/bops-512.png")).arrayBuffer()), readFileSync(new URL("../public/brand/bops-512.png", import.meta.url)));

  for (const path of [
    "/mascot/nobody-000000.png",
    "/mascot/main-0A0A0A.gif",
    "/brand/bops-512.jpg",
    "/mascot",
    "/mascot/",
    "/mascot/sub/main-0A0A0A.png",
    "/mascot/main-0A0A0A.png.png",
    "/mascot/%2e%2e%2fserver.ts",
    "/mascot/..%2f..%2fserver.ts",
    "/brand/..%2F..%2Fpackage.json",
  ])
    assert.equal((await get(path)).status, 404, path);
  for (const path of ["/mascot/../server.ts", "/mascot/..\\..\\server.ts", "/brand/./bops-512.png/..", "/mascot//etc/passwd"]) {
    const status = await rawGet(path);
    assert.ok(status === 404 || status === 400, `${path}: ${status}`);
  }
});
