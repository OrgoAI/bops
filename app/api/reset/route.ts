import { rmSync } from "node:fs";
import { checkMac } from "@/lib/server/mac";
import { orgo } from "@/lib/server/orgo";
import { onPostgres } from "@/lib/server/persist";
import { ownerPhoneTable } from "@/lib/server/persist-pg";
import { stopAllSessions } from "@/lib/server/sessions";
import { pagesDir } from "@/lib/server/pages";
import { filesDir } from "@/lib/server/files";
import { getState, resetState, update } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

/**
 * Start Bops over from the beginning: stop all work, delete the bots' computers, and reset to Sam
 * alone. The old state is backed up first.
 *
 * Only computers Bops knows it made go (a bot's, and in the "bops" workspace). The workspace is the
 * user's own on Orgo and may hold computers they put there themselves; those stay, listed in `kept`.
 */
export async function POST() {
  const unready = notReady();
  if (unready) return unready;
  stopAllSessions("Stopped: Bops was reset");
  update((state) => (state.takeover = undefined));
  const ours = new Set(getState().bots.flatMap((b) => (b.computerId ? [b.computerId] : [])));
  const computers = await orgo.bopsComputers();
  const deleted: string[] = [];
  const failed: string[] = [];
  const kept = computers.filter((c) => !ours.has(c.id)).map((c) => c.name);
  // A bot's computer outside the "bops" workspace (made in the one BOPS_ORGO_WORKSPACE pinned, before sign-in) goes too.
  const listed = new Set(computers.map((c) => c.id));
  const others = getState().bots.flatMap((b) => (b.computerId && !listed.has(b.computerId) ? [{ id: b.computerId, name: `${b.name}'s computer` }] : []));
  for (const c of [...computers.filter((x) => ours.has(x.id)), ...others]) {
    try {
      await orgo.remove(c.id);
      deleted.push(c.name);
    } catch (e) {
      failed.push(`${c.name}: ${(e as Error).message}`);
    }
  }
  await resetState();
  // Starting over forgets the user's verified mobiles, so on a hosted server their claim on them goes too.
  const user = getState().account?.user.id;
  if (onPostgres() && user) await ownerPhoneTable()?.releaseAll(user).catch((e: Error) => console.warn(`[reset] owner_phones: ${e.message}`));
  // Pages bots made go too, and the files of theirs the user opened; the user's Mac is checked again right away, so it's ready for the first task.
  for (const dir of [pagesDir(), filesDir()]) if (dir) rmSync(dir, { recursive: true, force: true });
  await checkMac().catch(() => {});
  return Response.json({ deleted, failed, kept, bots: getState().bots.map((b) => b.name) });
}
