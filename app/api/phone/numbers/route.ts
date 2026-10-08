import { searchNumbers } from "@/lib/server/phone";

export const dynamic = "force-dynamic";

const local = (request: Request) => ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);

/**
 * Only from this Mac: numbers for sale near ?areaCode= (the user's own mobile's area code, else 415,
 * when there's none), grouped by area code and city, for picking where a bot's number is from
 * (lib/server/phone.ts searchNumbers). Nothing is bought here: that's POST /api/phone, "provision".
 */
export async function GET(request: Request) {
  if (!local(request)) return Response.json({ error: "local only" }, { status: 403 });
  const areaCode = new URL(request.url).searchParams.get("areaCode") ?? undefined;
  try {
    return Response.json(await searchNumbers(areaCode));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
