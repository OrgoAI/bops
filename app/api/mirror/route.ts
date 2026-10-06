import { mirror } from "@/lib/server/mirror";
import { screenEndpoint } from "@/lib/server/screens";
import { bot } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/** The mirrored screen as a stream of rrweb events (server-sent events), current page first. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const b = bot(url.searchParams.get("bot") ?? "");
  const display = Number(url.searchParams.get("display") ?? 100);
  if (!b) return new Response("no bot", { status: 404 });
  const endpoint = screenEndpoint(b, display);
  if (!endpoint) return new Response("no direct path to this computer yet (join it to the tailnet)", { status: 409 });
  try {
    await fetch(`http://${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return new Response("nothing on this screen yet", { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          unsubscribe();
        }
      };
      unsubscribe = mirror(endpoint).subscribe((json) => write(`data: ${json}\n\n`));
      ping = setInterval(() => write(": ping\n\n"), 15000);
      request.signal.addEventListener("abort", () => {
        clearInterval(ping);
        unsubscribe();
      });
    },
    cancel() {
      clearInterval(ping);
      unsubscribe();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
