import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, type Route } from "./http.ts";

/**
 * The few public pages connecting apps and Slack need, the ones Bops' own front door (edge/server.mjs)
 * served, so hosted Bops needs no Mac and no relay for them. None of them has anything of any user's.
 *
 * - GET /connected: where people land after connecting an app (Composio's callbackUrl), in Bops' look.
 * - GET /oauth/callback: Orgo's own OAuth apps (Bops' Slack app) send people back here, and they go
 *   straight on to Composio with everything the provider sent, so the address bar shows Bops'.
 * - GET /mascot/<name>.png|jpg, /brand/<name>.png: the bots' pictures (Slack shows them as each bot's
 *   icon_url) and the Bops logo, fixed files in cloud/public.
 *
 * Behind the proxy the public path has a prefix (https://bops.orgo.ai/api/connected), so the pages
 * point at their pictures with relative addresses: "/brand/…" would leave the prefix out.
 */

/** Composio's own end of an app's sign-in. */
const COMPOSIO_CALLBACK = "https://backend.composio.dev/api/v3/toolkits/auth/callback";
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const sha256 = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/** After connecting an app: Bops' own page (a port of edge/server.mjs connectedPage). Every value from the address is escaped. */
export function connectedPage(url: URL) {
  const ok = url.searchParams.get("status") !== "failed";
  const app = esc((url.searchParams.get("app") ?? "").slice(0, 60));
  const title = ok ? (app ? `${app} is connected` : "Connected") : app ? `${app} didn't connect` : "That didn't connect";
  const line = ok ? "Your bots can use it now. You can close this tab and go back to Bops." : "Nothing was saved. Go back to Bops and try again.";
  const style = `
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FDFFF6;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;color:#0A0A0A}
main{display:flex;flex-direction:column;align-items:center;gap:14px;padding:40px;text-align:center;max-width:420px}
img{width:88px;height:88px;border-radius:24px;box-shadow:0 0 0 1px #0000000F,0 18px 40px -18px #28320066}
h1{margin:6px 0 0;font-size:24px;line-height:30px;letter-spacing:-.01em}
p{margin:0;color:#6B6B6B;font-size:15px}
.mark{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${ok ? "#12B76A" : "#F04438"};color:#fff;font-size:13px;font-weight:700;vertical-align:-3px;margin-right:8px}
`;
  const script = ok ? "setTimeout(()=>window.close(),2500)" : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Bops</title><link rel="icon" href="brand/bops-512.png"><style>${style}</style></head><body><main><img src="brand/bops-512.png" alt="Bops"><h1><span class="mark">${ok ? "&#10003;" : "!"}</span>${title}</h1><p>${line}</p></main><script>${script}</script></body></html>`;
  // Only this page's own style and script run, and nothing on it reaches anywhere but its own pictures.
  const csp = `default-src 'none'; img-src 'self'; style-src ${sha256(style)}; script-src ${sha256(script)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
}

const connected: Route = {
  method: "GET",
  path: "/connected",
  auth: "public",
  handle: async (_req, res, { url }) => {
    const { html, csp } = connectedPage(url);
    const data = Buffer.from(html);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(data.length),
      "cache-control": "no-store",
      "content-security-policy": csp,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  },
};

/** Straight on to Composio with everything the provider sent (the browser follows the 302). The query carries the sign-in's code: it's never logged. */
const oauthCallback: Route = {
  method: "GET",
  path: "/oauth/callback",
  auth: "public",
  handle: async (_req, res, { url }) => {
    res.writeHead(302, { location: `${COMPOSIO_CALLBACK}${url.search}`, "cache-control": "no-store", "referrer-policy": "no-referrer", "content-length": "0" });
    res.end();
  },
};

/** The pictures: a name of letters, digits and "-" only (no way out of the folder), mascots as PNG or JPEG, the logo as PNG. */
const ASSET = { mascot: /^\/mascot\/([A-Za-z0-9-]{1,64})\.(png|jpg)$/, brand: /^\/brand\/([A-Za-z0-9-]{1,64})\.(png)$/ };
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg" };
/** Files read once and kept (a few hundred KB in all); a name with no file is never kept. */
const files = new Map<string, Buffer>();

const asset = (folder: keyof typeof ASSET): Route => ({
  method: "GET",
  path: `/${folder}/*`,
  auth: "public",
  handle: async (_req, res, { url }) => {
    const m = ASSET[folder].exec(url.pathname);
    if (!m) throw new HttpError(404, "Not found");
    const name = `${folder}/${m[1]}.${m[2]}`;
    let data = files.get(name);
    if (!data) {
      data = await readFile(join(PUBLIC, folder, `${m[1]}.${m[2]}`)).catch(() => undefined);
      if (!data) throw new HttpError(404, "Not found");
      files.set(name, data);
    }
    res.writeHead(200, { "content-type": TYPES[m[2]], "content-length": String(data.length), "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
    res.end(data);
  },
});

export const routes: Route[] = [connected, oauthCallback, asset("mascot"), asset("brand")];
