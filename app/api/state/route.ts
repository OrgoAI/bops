import "@/lib/server/routines";
import { watchesForApp } from "@/lib/server/watches";
import "@/lib/server/mac";
import { getState, getVersion } from "@/lib/server/store";
import type { AppState } from "@/lib/types";
import { ensureCloud } from "@/lib/server/cloud-tunnel";
import { startMail } from "@/lib/server/mail";
import { startPhone } from "@/lib/server/phone";
import { startChannels } from "@/lib/server/channels";
import { screenStreamWanted } from "@/lib/server/orgo";
import { fullAccessOn } from "@/lib/server/full-access";
import { tregOn } from "@/lib/server/treg";
import { startActivityBeat } from "@/lib/server/free-hours";
import { startComputerChecks } from "@/lib/server/sessions";
import { startRunsOn } from "@/lib/server/runner";

export const dynamic = "force-dynamic";

/**
 * Full app state plus a version counter; the UI polls this. With ?v= (the version the page has),
 * an unchanged state answers with just the version, not the whole state. Importing routines and
 * watches starts their loops; the first poll starts mail (bots' inboxes, and listening for email),
 * Bops Cloud's tunnel if the server's start didn't (the Keychain gave the key only later), the look
 * at the bots' computers on Orgo (one deleted there since is replaced), and asking Orgo where the bots
 * work (runner.ts), which says which routines are this Mac's.
 */
export async function GET(request: Request) {
  ensureCloud();
  startMail();
  startPhone();
  startChannels();
  startComputerChecks();
  startActivityBeat();
  startRunsOn();
  const have = new URL(request.url).searchParams.get("v");
  const version = getVersion();
  if (have !== null && Number(have) === version) return Response.json({ version });
  return Response.json({ version, state: forApp(getState()) });
}

/**
 * The state as the app gets it: each bot's key for app actions stays on the server (its computer has
 * it), and so does the usage ledger, which grows to thousands of events and which the account page
 * totals on the server (/api/account), and what's kept of each watched web page to compare it (only the
 * server compares), with when the page was last read even when that wasn't saved (watches.ts
 * watchesForApp), and each workspace's Orbit secret (memory-categories.ts). It also says whether the other
 * screens stream through Orgo.
 */
function forApp(state: AppState): AppState {
  // Full access is kept on this Mac, not in the state (full-access.ts): shown as part of it.
  const mac = state.mac ? { ...state.mac, fullAccess: fullAccessOn() || undefined } : state.mac;
  const watches = watchesForApp(state.watches);
  const workspaces = state.workspaces?.map((w) => (w.orbitKey ? { ...w, orbitKey: undefined } : w));
  return { ...state, mac, watches, workspaces, usage: undefined, bots: state.bots.map((b) => ({ ...b, appsKey: undefined })), screenStream: screenStreamWanted(), businessData: tregOn() };
}
