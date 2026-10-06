import { input, navigate, viewport } from "@/lib/server/local";
import { screenEndpoint, workComputer } from "@/lib/server/screens";
import { orgo, screenId } from "@/lib/server/orgo";
import { bot, getState } from "@/lib/server/store";

/**
 * Your input on a bot's screen while you've taken it over. Clicks arrive as fractions of the
 * screen (0-1) so they land right at any size; text and keys go to the focused element.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { botId: string; display: number; kind: "click" | "scroll" | "type" | "key" | "navigate"; fx?: number; fy?: number; dy?: number; text?: string; key?: string; url?: string };
  const state = getState();
  const b = bot(body.botId);
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  if (state.takeover?.botId !== b.id || state.takeover.display !== body.display)
    return Response.json({ error: "take over this screen first" }, { status: 409 });
  try {
    // Straight to the screen's Chrome when we can reach it (the Mac, or Orgo over the tailnet); else through Orgo's API.
    const port = screenEndpoint(b, body.display);
    if (port) {
      if (body.kind === "click" || body.kind === "scroll") {
        const v = await viewport(port);
        const [x, y] = [(body.fx ?? 0) * v.width, (body.fy ?? 0) * v.height];
        await input(port, body.kind === "click" ? { kind: "click", x, y } : { kind: "scroll", x, y, dy: body.dy ?? 0 });
      } else if (body.kind === "type") await input(port, { kind: "type", text: body.text ?? "" });
      else if (body.kind === "navigate") await navigate(port, body.url ?? "");
      else await input(port, { kind: "key", key: body.key ?? "" });
    } else {
      if (body.kind === "navigate") return Response.json({ error: "use the browser's own address bar" }, { status: 400 });
      if (body.kind === "scroll") return Response.json({ ok: true }); // the video view doesn't scroll Orgo screens yet
      const computerId = workComputer(b).computerId;
      if (!computerId) return Response.json({ error: "no computer" }, { status: 409 });
      const screen = screenId(body.display);
      if (body.kind === "click") {
        const s = (await orgo.screens(computerId)).find((x) => x.id === screen);
        await orgo.click(computerId, screen, (body.fx ?? 0) * (s?.width ?? 1280), (body.fy ?? 0) * (s?.height ?? 720));
      } else if (body.kind === "type") await orgo.type(computerId, screen, body.text ?? "");
      else await orgo.key(computerId, screen, body.key ?? "");
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
