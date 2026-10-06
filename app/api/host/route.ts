import { update } from "@/lib/server/store";
import type { Host } from "@/lib/types";

/** Switch where new sessions run: Chrome windows on this Mac, or Orgo cloud computers. */
export async function POST(request: Request) {
  const { host } = (await request.json()) as { host?: Host };
  if (host !== "mac" && host !== "orgo") return Response.json({ error: "host must be mac or orgo" }, { status: 400 });
  update((s) => (s.host = host));
  return Response.json({ host });
}
