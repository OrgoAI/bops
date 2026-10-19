import { askRunsOn, heardRunsOn, runsOnMissing, setRunsOn } from "@/lib/server/runner";
import { orgo } from "@/lib/server/orgo";
import { runnersSoon } from "@/lib/server/runner-install";
import { notReady } from "@/lib/server/ready";
import { getState, stateReady } from "@/lib/server/store";
import { computerAsleep } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Where routines run (Settings, lib/server/runner.ts): Cloud or This Mac, as Orgo keeps it (asked again
 * now; null when Orgo hasn't answered, so Settings picks neither and says so), whether Orgo can keep it
 * yet (`missing`: not, so they run on this Mac), and which computers with a runner up are asleep now
 * (Orgo's status read never wakes one). Each computer's runner is in the state (runners).
 */
export async function GET() {
  if (!stateReady()) return Response.json({ runsOn: null, missing: false, asleep: [] });
  await askRunsOn();
  const up = Object.entries(getState().runners ?? {})
    .filter(([, x]) => x.status === "running")
    .map(([id]) => id);
  const asleep = await Promise.all(up.map((id) => orgo.computer(id).then((c) => (computerAsleep(c.status) ? id : null), () => null)));
  return Response.json({ runsOn: heardRunsOn() ?? null, missing: runsOnMissing(), asleep: asleep.filter((id) => id !== null) });
}

/** Set where routines run from now on, for every Mac and computer of the user's (PUT orgo-web /api/bops/settings): the runners are set up or stopped in a moment. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as { runsOn?: unknown };
  if (body.runsOn !== "cloud" && body.runsOn !== "mac") return Response.json({ error: "runsOn: cloud or mac" }, { status: 400 });
  const res = await setRunsOn(body.runsOn);
  if (res.error) return Response.json({ error: res.error, missing: !!res.missing, runsOn: heardRunsOn() ?? null }, { status: res.missing ? 409 : 502 });
  runnersSoon();
  return Response.json({ runsOn: heardRunsOn() ?? body.runsOn, missing: false });
}
