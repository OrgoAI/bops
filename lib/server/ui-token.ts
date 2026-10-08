import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Whether a request comes from the Bops window on this Mac. desktop/main.cjs keeps a token, gives it to
 * this server (BOPS_UI_TOKEN) and sets it in the window's session as an httpOnly cookie, so every
 * request the window makes carries it and no page script can read it; main.cjs's own calls send it as
 * x-bops-window. A page that reached this server some other way can't have it: a bot's Chrome on this
 * Mac browsing to it, above all. proxy.ts asks for it on every request but a read; the routes for what
 * only the user may turn on (Full access, a bot's settings) ask again. Without a token set (a hosted
 * server, or a dev server run outside the app), any request counts.
 */
export function fromBopsWindow(request: Request): boolean {
  const want = process.env.BOPS_UI_TOKEN;
  if (!want) return true;
  const cookie = /(?:^|;\s*)bops_window=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const got = cookie ?? request.headers.get("x-bops-window") ?? "";
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
