import http from "node:http";
import { existsSync, readFileSync } from "node:fs";

/**
 * Bops' public front door (api.bops.bot, on Fly). Webhooks from AgentPhone, OpenAI and Bops' Slack app arrive here
 * and go, byte for byte, to the Bops server on the user's Mac over the tailnet. Bops checks their
 * signatures itself. If the Mac can't be reached (asleep, offline), the sender gets a 503 and
 * retries later.
 *
 * It also keeps connecting apps in Bops' name (no Mac needed for any of these):
 * - /oauth/callback: our own OAuth apps (Slack, Google…) send people back here, and it passes them
 *   straight on to Composio, so the address bar shows bops.bot, not Composio.
 * - /connected: where people land after connecting an app, instead of Composio's page.
 * - /mascot/*.png|jpg, /brand/*.png: the bots' pictures (Slack, Discord and Telegram avatars) and the Bops logo.
 */

const UPSTREAM = new URL(process.env.BOPS_UPSTREAM ?? "http://127.0.0.1:3210");
const PORT = Number(process.env.PORT ?? 8080);

/** Public path → path on the Bops server (the same two the Mac's Funnel served). */
const ROUTES = {
  "/hooks/agentphone": "/api/phone/agentphone",
  "/hooks/openai": "/api/phone/openai",
  "/hooks/slack": "/api/channels/slack/events",
};

const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

const COMPOSIO_CALLBACK = "https://backend.composio.dev/api/v3/toolkits/auth/callback";
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** After connecting an app: Bops' own page, in the app's look. */
function connectedPage(url) {
  const ok = url.searchParams.get("status") !== "failed";
  const app = esc((url.searchParams.get("app") ?? "").slice(0, 60));
  const title = ok ? (app ? `${app} is connected` : "Connected") : app ? `${app} didn't connect` : "That didn't connect";
  const line = ok ? "Your bots can use it now. You can close this tab and go back to Bops." : "Nothing was saved. Go back to Bops and try again.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Bops</title><link rel="icon" href="/brand/bops-512.png"><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FDFFF6;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;color:#0A0A0A}
main{display:flex;flex-direction:column;align-items:center;gap:14px;padding:40px;text-align:center;max-width:420px}
img{width:88px;height:88px;border-radius:24px;box-shadow:0 0 0 1px #0000000F,0 18px 40px -18px #28320066}
h1{margin:6px 0 0;font-size:24px;line-height:30px;letter-spacing:-.01em}
p{margin:0;color:#6B6B6B;font-size:15px}
.mark{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${ok ? "#12B76A" : "#F04438"};color:#fff;font-size:13px;font-weight:700;vertical-align:-3px;margin-right:8px}
</style></head><body><main><img src="/brand/bops-512.png" alt="Bops"><h1><span class="mark">${ok ? "&#10003;" : "!"}</span>${title}</h1><p>${line}</p></main><script>${ok ? "setTimeout(()=>window.close(),2500)" : ""}</script></body></html>`;
}

/** The bots' pictures (PNG for Slack and Discord, JPEG for Telegram) and the Bops logo: fixed files, cached for a day. */
function asset(pathname, res) {
  const m = /^\/(mascot|brand)\/([A-Za-z0-9-]+\.(png|jpg))$/.exec(pathname);
  const file = m && `${PUBLIC}${m[1]}/${m[2]}`;
  if (!file || !existsSync(file)) return false;
  res.writeHead(200, { "content-type": m[3] === "jpg" ? "image/jpeg" : "image/png", "cache-control": "public, max-age=86400" }).end(readFileSync(file));
  return true;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://edge");
    if (url.pathname === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      // Straight on to Composio with everything the provider sent (a 302: the browser follows it, never this server).
      log({ path: url.pathname, status: 302 });
      return void res.writeHead(302, { location: `${COMPOSIO_CALLBACK}${url.search}`, "cache-control": "no-store" }).end();
    }
    if (req.method === "GET" && url.pathname === "/connected")
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(connectedPage(url));
    if (req.method === "GET" && asset(url.pathname, res)) return;
    const path = ROUTES[url.pathname];
    if (!path || req.method !== "POST") return void res.writeHead(404).end();

    const started = Date.now();
    const headers = { ...req.headers, host: UPSTREAM.host };
    const up = http.request(
      { hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: path + url.search, method: "POST", headers, timeout: 30_000 },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        log({ path: url.pathname, status: r.statusCode, ms: Date.now() - started });
      },
    );
    up.on("timeout", () => up.destroy(new Error("timed out")));
    up.on("error", (err) => {
      log({ path: url.pathname, status: 503, ms: Date.now() - started, error: err.message });
      if (!res.headersSent) res.writeHead(503, { "content-type": "text/plain" }).end("Bops is offline");
      else res.destroy();
    });
    req.pipe(up);
  })
  .listen(PORT, () => log({ listening: PORT, upstream: UPSTREAM.origin }));
