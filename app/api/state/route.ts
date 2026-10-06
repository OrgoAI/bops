import "@/lib/server/routines";
import "@/lib/server/watches";
import "@/lib/server/codex";
import { getState, getVersion } from "@/lib/server/store";
import type { AppState } from "@/lib/types";
import { ensureCloud } from "@/lib/server/cloud-tunnel";
import { startMail } from "@/lib/server/mail";
import { startPhone } from "@/lib/server/phone";
import { startChannels } from "@/lib/server/channels";

export const dynamic = "force-dynamic";

/**
 * Full app state plus a version counter; the UI polls this. With ?v= (the version the page has),
 * an unchanged state answers with just the version, not the whole state. Importing routines and
 * watches starts their loops; the first poll starts mail (bots' inboxes, and listening for email),
 * and Bops Cloud's tunnel if the server's start didn't (the Keychain gave the key only later).
 */
export async function GET(request: Request) {
  ensureCloud();
  startMail();
  startPhone();
  startChannels();
  const have = new URL(request.url).searchParams.get("v");
  const version = getVersion();
  if (have !== null && Number(have) === version) return Response.json({ version });
  return Response.json({ version, state: forApp(getState()) });
}

/**
 * The state as the app gets it: each bot's key for app actions stays on the server (its computer has
 * it), and so does the usage ledger, which grows to thousands of events and which the account page
 * totals on the server (/api/account).
 */
function forApp(state: AppState): AppState {
  return { ...state, usage: undefined, bots: state.bots.map((b) => ({ ...b, appsKey: undefined })) };
}
