import "server-only";
import { createHmac } from "node:crypto";
import { DISPLAYS, live, type ScreenRead, type VaultLogin } from "@/lib/types";
import { deleteUserSecret, getUserSecret, setUserSecret } from "./keychain";
import { onTab, openPages } from "./local";
import { readScreen } from "./screen-watch";
import { screenEndpoint } from "./screens";
import { submitSignIn, type SignInValues } from "./sign-in";
import { addStep } from "./sessions";
import { bot, getState, id, ownerName, session, stateUser, update } from "./store";

/**
 * The vault: logins bots can sign in with. Bops keeps the site, the username and who may use it;
 * the password and the 2FA setup key go to the Mac's Keychain. Signing in fills the page's fields
 * straight from the Keychain (see sign-in.ts), and 2FA codes are made here, so no model, log or
 * state file ever holds a secret.
 */

const PASSWORD = (loginId: string) => `${loginId}:password`;
const TOTP = (loginId: string) => `${loginId}:totp`;

/** "https://mobile.x.com/login" → "x.com": the part of an address a login belongs to. */
export function siteOfUrl(url: string) {
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
    if (/^[\d.]+$|^localhost$/.test(host)) return host;
    const parts = host.split(".");
    // Keep "bbc.co.uk"-style addresses whole.
    return parts.length > 2 && parts.at(-2)!.length <= 3 && parts.at(-1)!.length === 2 ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
  } catch {
    return url.trim().toLowerCase();
  }
}

const logins = () => getState().vault ?? [];
const patchLogin = (loginId: string, patch: Partial<VaultLogin>) =>
  update((state) => {
    const l = state.vault?.find((x) => x.id === loginId);
    if (l) Object.assign(l, patch);
  });

/** The logins a bot may use on a page, best match first. */
export function loginsFor(botId: string, url: string) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return [];
  }
  return logins()
    .filter((l) => (l.bots === "all" || l.bots.includes(botId)) && (host === l.site || host.endsWith(`.${l.site}`)))
    .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0));
}

type LoginInput = { site: string; username: string; password?: string; totp?: string; bots?: VaultLogin["bots"]; auto?: boolean };

export async function saveLogin(input: LoginInput) {
  const site = siteOfUrl(input.site);
  if (!site || !input.username.trim()) throw new Error("a site and a username are needed");
  const totp = input.totp?.replace(/\s+/g, "").toUpperCase();
  if (totp && !/^[A-Z2-7]+=*$/.test(totp)) throw new Error("that 2FA key doesn't look right: it's the code shown under \"can't scan the QR code?\"");
  // Same site and username: update it rather than keeping two.
  const same = logins().find((l) => l.site === site && l.username === input.username.trim());
  const loginId = same?.id ?? id("login");
  if (input.password) await setUserSecret(PASSWORD(loginId), input.password);
  if (totp) await setUserSecret(TOTP(loginId), totp);
  const fields = {
    site,
    username: input.username.trim(),
    hasPassword: !!input.password || !!same?.hasPassword,
    hasTotp: !!totp || !!same?.hasTotp,
    bots: input.bots ?? same?.bots ?? "all",
    auto: input.auto ?? same?.auto ?? false,
  };
  if (same) patchLogin(loginId, fields);
  else update((state) => (state.vault ??= []).push({ id: loginId, addedAt: Date.now(), ...fields }));
  return loginId;
}

export async function editLogin(loginId: string, input: Partial<LoginInput>) {
  const l = logins().find((x) => x.id === loginId);
  if (!l) throw new Error("no such login");
  if (input.password) await setUserSecret(PASSWORD(loginId), input.password);
  const totp = input.totp?.replace(/\s+/g, "").toUpperCase();
  if (totp) {
    if (!/^[A-Z2-7]+=*$/.test(totp)) throw new Error("that 2FA key doesn't look right");
    await setUserSecret(TOTP(loginId), totp);
  }
  patchLogin(loginId, {
    ...(input.site ? { site: siteOfUrl(input.site) } : {}),
    ...(input.username?.trim() ? { username: input.username.trim() } : {}),
    ...(input.password ? { hasPassword: true } : {}),
    ...(totp ? { hasTotp: true } : {}),
    ...(input.bots ? { bots: input.bots } : {}),
    ...(input.auto !== undefined ? { auto: input.auto } : {}),
  });
}

export async function deleteLogin(loginId: string) {
  await deleteUserSecret(PASSWORD(loginId));
  await deleteUserSecret(TOTP(loginId));
  update((state) => (state.vault = state.vault?.filter((l) => l.id !== loginId)));
}

/** The current 6-digit code for a 2FA setup key (RFC 6238: SHA-1, 30 seconds). */
export function totpCode(key: string, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of key.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac("sha1", bytes).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * Sign a bot in with a saved login, on the page it's stuck on. Walks through up to three steps
 * (email, then password, then a code), filling each from the Keychain.
 */
export async function signInWith(botId: string, display: number, loginId: string) {
  const b = bot(botId);
  const l = logins().find((x) => x.id === loginId);
  if (!b || !l) throw new Error("no such login");
  if (l.bots !== "all" && !l.bots.includes(botId)) throw new Error(`${b.name} isn't allowed to use this login`);
  const lock = `${botId}:${display}`;
  if (signingIn.has(lock)) return { signedIn: false, busy: true, read: getState().screens?.[lock] };
  signingIn.add(lock);
  try {
    return await walkSignIn(botId, display, loginId);
  } finally {
    signingIn.delete(lock);
  }
}

async function walkSignIn(botId: string, display: number, loginId: string) {
  const b = bot(botId)!;
  const l = logins().find((x) => x.id === loginId)!;
  let read = getState().screens?.[`${botId}:${display}`];
  for (let step = 0; step < 3 && read?.form && read.blocker; step++) {
    const values: SignInValues = {};
    if (read.form.identifier) values.identifier = l.username;
    if (read.form.password) values.password = (await getUserSecret(PASSWORD(loginId))) ?? undefined;
    if (read.form.code && l.hasTotp) {
      const key = await getUserSecret(TOTP(loginId));
      if (key) values.code = totpCode(key);
    }
    if (!values.identifier && !values.password && !values.code) break;
    const next = await submitSignIn(b, display, values);
    patchLogin(loginId, { usedAt: Date.now() });
    read = next.read ?? undefined;
  }
  const stuck = !!read?.blocker;
  if (read?.sessionId) addStep(read.sessionId, "vault", stuck ? `tried your saved ${l.site} login; still needs you` : `signed in to ${l.site} with your saved login`);
  return { signedIn: !stuck, read };
}

/** Sign-in pages a saved login was recently tried on, so a wrong password never loops. */
const tried = new Map<string, { n: number; at: number }>();

/**
 * A bot hit a sign-in page: if a login it may use is set to sign in automatically, use it. Two
 * tries per page at most; after that the sign-in card asks the user as usual.
 */
export async function autoSignIn(botId: string, display: number, read: ScreenRead) {
  if (!read.form || (read.blocker !== "sign_in" && read.blocker !== "two_factor")) return false;
  const login = loginsFor(botId, read.url).find((l) => l.auto);
  if (!login) return false;
  const key = `${botId}:${display}:${read.url}`;
  if (!takeTry(key)) return false;
  const { signedIn } = await signInWith(botId, display, login.id);
  // Worked: a later sign-out and sign-in on this page gets a fresh go.
  if (signedIn) tried.delete(key);
  return signedIn;
}

/** One more try at a sign-in page, unless it's had two in the last 10 minutes (a wrong password never loops). */
function takeTry(key: string) {
  const last = tried.get(key);
  const n = last && Date.now() - last.at < 10 * 60_000 ? last.n : 0;
  if (n >= 2) return false;
  tried.set(key, { n: n + 1, at: Date.now() });
  return true;
}

/**
 * The bot's sign_in_from_vault (screen_mcp.py, through /api/apps/call): on one of its computer's
 * screens, a tab whose site has a login it may use is read for its sign-in fields and signed in from
 * the Keychain, whichever tab Bops is showing. The bot never sees the secret, only how it went.
 */
export async function vaultSignIn(botId: string, display: number, sessionId: string) {
  const b = bot(botId);
  const owner = ownerName();
  if (!b || !(DISPLAYS as readonly number[]).includes(display)) return "There's no such screen.";
  const s = session(sessionId);
  if (!s || !live(s)) return "This task isn't running anymore.";
  const ep = screenEndpoint(b, display);
  if (!ep) return "Bops can't reach that screen right now.";
  const pages = await openPages(ep).catch(() => []);
  // Only logins set to sign in by themselves ("Sign in automatically"): the rest ask first, with the card,
  // whoever asks for them, the bot included.
  const usable = (url: string) => loginsFor(botId, url).filter((l) => l.auto);
  // The newest tabs first (Chrome lists the last used first): that's where the bot just was.
  const fits = pages.filter((p) => usable(p.url).length);
  if (!fits.length) {
    const asks = pages.filter((p) => loginsFor(botId, p.url).length).map((p) => siteOfUrl(p.url));
    if (asks.length)
      return `${owner}'s saved ${[...new Set(asks)].join(", ")} login is set to ask first. Stop and say in one sentence that you need to sign in: a card lets ${owner} sign you in with one tap.`;
    return `No login in ${owner}'s vault fits a page open on that screen (${[...new Set(pages.map((p) => siteOfUrl(p.url)))].join(", ") || "none"}). Stop and say so in one sentence: ${owner} can add one in the Vault, or sign you in with the card.`;
  }
  const task = s.goal ?? "";
  for (const p of fits) {
    const done = await onTab(ep, p.id, async () => {
      const read = await readScreen(botId, display, ep, task, sessionId, { signIn: true });
      const login = read?.form ? usable(read.url)[0] : undefined;
      if (!read || !login) return null;
      // Two tries a page at most, shared with the screen watch's (autoSignIn): a wrong password never loops, or locks the account.
      if (!takeTry(`${botId}:${display}:${read.url}`)) return { site: login.site, signedIn: false, read, busy: false };
      return { site: login.site, ...(await signInWith(botId, display, login.id)) };
    });
    if (!done) continue;
    if ("busy" in done && done.busy) return "Bops is already signing you in on that screen. Wait a few seconds, then look at it again.";
    return done.signedIn
      ? `Signed in to ${done.site} with ${owner}'s saved login. Look at the screen and carry on.`
      : `Tried ${owner}'s saved ${done.site} login, but the page still needs them (a wrong password, a code Bops can't make, or a check). Stop and say in one sentence what's needed: a card lets ${owner} finish.`;
  }
  return `The pages on that screen with a saved login (${fits.map((p) => siteOfUrl(p.url)).join(", ")}) have no fields Bops can fill. If it's a sign-in, stop and say so: a card lets ${owner} finish.`;
}

/** Screens a sign-in is being typed into right now: one at a time, or two would type over each other. */
const signingIn = new Set<string>();

/** Logins the sign-in card typed: kept for a few minutes so a two-page sign-in (email, then password) saves as one. */
const pending = new Map<string, { site: string; username?: string; at: number }>();

/** Save what the user typed into a sign-in card, if they asked to. The values come from them, not from the page. */
export async function rememberTyped(botId: string, display: number, url: string, values: SignInValues) {
  // Whose sign-in it is too: a username typed for another account on this Mac never joins this one's password.
  const key = `${stateUser() ?? ""}:${botId}:${display}`;
  const site = siteOfUrl(url);
  const before = pending.get(key);
  const username = values.identifier?.trim() || (before && before.site === site && Date.now() - before.at < 5 * 60_000 ? before.username : undefined);
  if (values.password && username) {
    pending.delete(key);
    return saveLogin({ site, username, password: values.password });
  }
  if (values.identifier) pending.set(key, { site, username: values.identifier.trim(), at: Date.now() });
  return null;
}
