import "server-only";
import type { PhoneLine, PhoneLineIn, PhoneLinesResult } from "@/cloud/protocol";
import { workspaceOf } from "@/lib/types";
import { cloudJson, cloudOn } from "./cloud";
import { getState, update } from "./store";

/**
 * Who owns each of the bots' numbers, kept by Bops Cloud (bops.phone_lines, cloud/lines.ts), never
 * here: on every call and text the cloud checks the caller against the line's owner and tells this
 * Mac (CallerVerdict), and this Mac follows it. Only through the cloud (signed in with Orgo); a
 * self-hoster's numbers keep counting only the verified numbers in Settings and BOPS_OWNER_PHONES.
 *
 * - When Bops gets a number for a bot or a workspace, the cloud gives the line 15 minutes: the first
 *   phone to call or text it becomes the owner's ("first caller claims it"). The app says so ("Call
 *   or text … from your phone in the next 15 minutes to make it yours"), then "Linked to …".
 * - The user can unlink the owner (a fresh 15 minutes opens), or open a window for a line that has
 *   none (one from before, or after the 15 minutes ran out).
 * - A number that claimed a line is one of the user's own numbers here too (ownerPhones, with
 *   `claimedVia`), so bots text it as they would a verified one.
 */

/** Whether lines and their owners come from Bops Cloud here. */
export const linesOn = () => cloudOn();

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

/** One of the bots' numbers as this app has it: the workspace's (its main bot's), or a bot's own. */
type LocalLine = { numberId: string; phone: string; botId?: string; workspaceId?: string };

/** Every number the bots have here. */
export function localLines(): LocalLine[] {
  const s = getState();
  const out: LocalLine[] = [];
  for (const w of s.workspaces ?? []) {
    if (!w.line) continue;
    const main = s.bots.find((b) => b.isMain && workspaceOf(b) === w.id);
    out.push({ numberId: w.line.numberId, phone: w.line.phone, botId: main?.id, workspaceId: w.id });
  }
  for (const b of s.bots) if (b.phone && b.phoneLine && !out.some((l) => l.numberId === b.phoneLine!.numberId)) out.push({ numberId: b.phoneLine.numberId, phone: b.phone, botId: b.id });
  return out;
}

/**
 * Tell the cloud about a number the app got or assigned (PUT /v1/phone/lines): which bot or workspace
 * it's for, and with `open`, that the user is being told to call it now (a line with no owner gets
 * its 15 minutes).
 */
export async function tellCloudLine(line: PhoneLineIn): Promise<PhoneLine | null> {
  if (!linesOn()) return null;
  return (await cloudJson<{ line: PhoneLine }>("/v1/phone/lines", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(line) })).line;
}

/** The user's lines and their owners, from the cloud; null when lines aren't kept there. Claimed owners join the user's own numbers here. */
export async function cloudLines(): Promise<PhoneLine[] | null> {
  if (!linesOn()) return null;
  const { lines } = await cloudJson<PhoneLinesResult>("/v1/phone/lines");
  keepClaimedOwners(lines);
  return lines;
}

/** A number that claimed a line (by a call or a text) is one of the user's own numbers here, if it isn't already. */
function keepClaimedOwners(lines: PhoneLine[]) {
  const userId = getState().account?.user.id;
  const claimed = lines.filter((l) => l.owner && (l.owner.via === "call" || l.owner.via === "text"));
  const missing = claimed.filter((l) => !(getState().ownerPhones ?? []).some((p) => digits(p.number) === digits(l.owner!.number) && (!p.userId || p.userId === userId)));
  if (!missing.length) return;
  update((s) => {
    for (const l of missing) {
      const at = Date.parse(l.owner!.at ?? "") || Date.now();
      s.ownerPhones = [...(s.ownerPhones ?? []), { number: l.owner!.number, consentAt: at, verifiedAt: at, claimedVia: l.owner!.via as "call" | "text", ...(userId ? { userId } : {}) }];
    }
  });
}

/** A fresh 15 minutes for the first caller to claim the line (it has no owner). */
export async function openLine(numberId: string) {
  const line = localLines().find((l) => l.numberId === numberId);
  if (!line) throw new Error("no such number");
  return tellCloudLine({ numberId, botId: line.botId, workspaceId: line.workspaceId, open: true });
}

/**
 * The line's owner no longer counts as the user (the cloud opens a fresh 15 minutes). Here, that
 * number leaves the user's own numbers too, unless another of their lines still has it as owner.
 */
export async function unlinkLine(numberId: string) {
  if (!linesOn()) throw new Error("numbers are linked through Bops Cloud");
  const before = (await cloudLines())?.find((l) => l.numberId === numberId);
  await cloudJson<{ line: PhoneLine }>("/v1/phone/lines/unlink", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numberId }) });
  const gone = before?.owner?.number;
  const still = gone && (await cloudLines())?.some((l) => l.owner && digits(l.owner.number) === digits(gone));
  if (gone && !still)
    update((s) => {
      s.ownerPhones = (s.ownerPhones ?? []).filter((p) => digits(p.number) !== digits(gone));
    });
}

/** One of the user's own numbers no longer counts as them on any line (Settings, Remove). */
export async function forgetOwnerNumber(number: string) {
  if (!linesOn()) return;
  await cloudJson("/v1/phone/owners/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number }) });
}

/** Each of the bots' numbers, told to the cloud with the bot it's for (once at start: lines from before Bops kept them get their bot). */
export async function syncCloudLines() {
  if (!linesOn()) return;
  for (const l of localLines()) await tellCloudLine({ numberId: l.numberId, botId: l.botId, workspaceId: l.workspaceId }).catch((e: Error) => console.warn(`[phone] line ${l.numberId}: ${e.message}`));
}
