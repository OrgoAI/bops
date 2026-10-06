import "server-only";
import { isBotAddress, isBotInbox, mailOn, onBotsMailDomain, ownerAddresses, ownerEmailSources } from "./mail";
import { onPostgres } from "./persist";
import { getState, installId, ofThisUser, update } from "./store";
import { checkVerification, emailCodesOn, forgetVerification, pendingVerifications, startVerification } from "./verify";

/**
 * The user's own email addresses (Settings, How your bots reach you): the second way their bots
 * know it's them, after their mobile. An email from one of these, when the email proves it (DMARC,
 * isFromOwner in lib/server/mail.ts), is the user talking, and bots may email them without asking.
 *
 * - The Gmail they connected counts as it is. The email they signed in to Orgo with is listed, and
 *   counts once they say so ("Count it"): the DMARC verdict is read from headers as AgentMail hands
 *   them over, so an address isn't trusted that way without the user's OK.
 * - Any other address is added with a 6-digit code emailed to it (lib/server/verify.ts, the "email"
 *   channel), and saved only once the code comes back. A code proves only the address it went to.
 * - Codes are only offered while the Verify service can email them (emailCodesOn): Settings never
 *   offers a code that can't arrive.
 * - A bot's own address (its inboxes, agentmail.to, bops.bot, a workspace's part of this server's
 *   bot domain) is never added as the user's.
 * - What the user proves is kept with their Orgo user id: another account signed in on this Mac
 *   doesn't inherit it (ofThisUser in lib/server/store.ts).
 * - Like adding a number, this is for the app on the user's Mac only (app/api/owner-email). A
 *   hosted server would also claim each address in bops.owner_emails (ownerEmailTable in
 *   lib/server/persist-pg.ts) once its requests prove which user sent them.
 */

/** Who's asking, for the limits and pending codes: on a hosted server the signed-in user, else this install (as in lib/server/phone.ts). */
const verifier = () => (onPostgres() ? `u:${getState().account?.user.id ?? "nobody"}` : `i:${installId()}`);

/** The app on this Mac, not anyone else who reaches the server: loopback, and not a hosted server (which can't tell its users apart yet). */
export const fromThisMac = (request: Request) => !onPostgres() && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(request.url).hostname);

/** " Me@Example.com " → "me@example.com", or "" when it isn't an email address. */
export function normalizeEmail(input: string): string {
  const a = input.trim().toLowerCase();
  if (!a || a.length > 254 || /\s/.test(a)) return "";
  const [local, domain, ...more] = a.split("@");
  if (more.length || !local || !domain) return "";
  // A dot in the domain, no empty part in it, and nothing from a display name or a list ("Me <me@x.com>", "a@x.com,b@y.com").
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return "";
  return a;
}

/**
 * Why an address can't be added as the user's, when it's the bots': one of their inboxes, or on a
 * domain where only bots get addresses. Null when it's fine.
 */
export function botAddressError(address: string): string | null {
  if (isBotInbox(address)) return "That's one of your bots' own addresses. Use your own email.";
  if (isBotAddress(address) || onBotsMailDomain(address)) return `Addresses on ${address.slice(address.lastIndexOf("@") + 1)} are for bots. Use your own email.`;
  return null;
}

const UNAVAILABLE = "Adding another email by code isn't available yet.";

/** The signed-in Orgo user's email, as Settings lists it (lowercased), or "". */
const signInEmail = () => (getState().account?.user.email ?? "").trim().toLowerCase();

/**
 * Step one: email a code to an address the user wants to count as them. Refused before anything is
 * sent when it isn't an address, is a bot's, already counts, is the sign-in email (one tap counts
 * that), or codes can't be emailed from here.
 */
export async function startOwnerEmail(input: string) {
  const address = normalizeEmail(input);
  if (!address) return { ok: false as const, error: "That doesn't look like an email address." };
  const bots = botAddressError(address);
  if (bots) return { ok: false as const, error: bots };
  if (ownerAddresses().includes(address)) return { ok: false as const, error: "That address already counts as you." };
  if (address === signInEmail()) return { ok: false as const, error: "That's your sign-in email. Tap Count it instead." };
  if (!mailOn() || !(await emailCodesOn())) return { ok: false as const, error: UNAVAILABLE };
  return startVerification("email", address, verifier(), Date.now());
}

/** Step two: the code the user typed. Right, and the address is saved as theirs, verified now. Nothing is saved otherwise. */
export async function checkOwnerEmail(input: string, code: string) {
  const address = normalizeEmail(input);
  if (!address) return { ok: false as const, error: "That doesn't look like an email address." };
  const r = await checkVerification("email", address, verifier(), code);
  if (!r.ok) return r;
  // Checked again on the way in: an address that became a bot's while the code was out never counts as the user.
  const bots = botAddressError(address);
  if (bots) return { ok: false as const, error: bots, restart: true };
  const verifiedAt = Date.now();
  const userId = getState().account?.user.id;
  update((s) => {
    s.ownerEmails = [...(s.ownerEmails ?? []).filter((e) => e.address !== address), { address, verifiedAt, ref: r.ref, ...(userId ? { userId } : {}) }];
  });
  return { ok: true as const };
}

/** An address the user added with a code no longer counts as them (and a code out for it is dropped). Only the signed-in user's. */
export function removeOwnerEmail(input: string) {
  const address = normalizeEmail(input) || input.trim().toLowerCase();
  update((s) => {
    s.ownerEmails = (s.ownerEmails ?? []).filter((e) => e.address !== address || !ofThisUser(e));
    if (!s.ownerEmails.length) delete s.ownerEmails;
  });
  forgetVerification("email", address, verifier());
}

/** Whether the email the user signed in to Orgo with counts as them ("Count it", "Don't count it"): kept for that address only. */
export function setSignInEmailCounted(on: boolean) {
  const address = signInEmail();
  update((s) => {
    if (on && address && !isBotAddress(address)) s.signInEmailCounted = address;
    else delete s.signInEmailCounted;
  });
}

/**
 * For Settings: whether mail is on, whether codes can be emailed from here, whether addresses can be
 * added here at all (`local`: the request came from the app on this Mac; a hosted server can't tell
 * its users apart yet), the user's addresses with where each comes from, and the addresses with a
 * code out (never the code). The sign-in email is read here, on the server: the app never sends it.
 *
 * Anyone else gets whether mail is on and nothing more: no addresses, no codes out, and no call to
 * the Verify service.
 */
export async function ownerEmailStatus(local = true) {
  if (!local || onPostgres()) return { on: mailOn(), codes: false, add: "hosted" as const, emails: [], pending: [] };
  return {
    on: mailOn(),
    codes: mailOn() && (await emailCodesOn()),
    add: "on" as const,
    emails: ownerEmailSources(),
    pending: pendingVerifications("email", verifier()),
  };
}
