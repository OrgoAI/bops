import "server-only";
import { execFile, spawn } from "node:child_process";
import { stateUser } from "./store";

/**
 * Secrets in the Mac's Keychain, under "Bops Vault". Values go to `security` on stdin, hex-encoded,
 * so they never show up in the process list; reading one back only names the item.
 */
const SERVICE = "Bops Vault";
const q = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

export function setSecret(account: string, value: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain refused it: ${err.trim() || code}`))));
    p.stdin.end(`add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} -X ${Buffer.from(value, "utf8").toString("hex")}\n`);
  });
}

export function getSecret(account: string) {
  return new Promise<string | null>((resolve) =>
    execFile("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], (e, out) => resolve(e ? null : out.replace(/\n$/, ""))),
  );
}

export function deleteSecret(account: string) {
  return new Promise<void>((resolve) => execFile("security", ["delete-generic-password", "-s", SERVICE, "-a", account], () => resolve()));
}

/*
 * A user's own secrets (a vault login's password and 2FA key, a channel's token): named for the
 * signed-in Orgo user, so another account signed in on this Mac never reaches them. Their state
 * lists them (the vault, the channels), and each user's state is their own. A secret saved before
 * names had a user is still read for the user whose state names it, and moved to their name.
 */
const forUser = (name: string) => {
  const user = stateUser();
  return user ? `${user}:${name}` : name;
};

export async function getUserSecret(name: string) {
  const named = forUser(name);
  const value = await getSecret(named);
  if (value !== null || named === name) return value;
  const old = await getSecret(name);
  if (old !== null)
    await setSecret(named, old)
      .then(() => deleteSecret(name))
      .catch(() => {});
  return old;
}

export const setUserSecret = (name: string, value: string) => setSecret(forUser(name), value);

export async function deleteUserSecret(name: string) {
  const named = forUser(name);
  await deleteSecret(named);
  if (named !== name) await deleteSecret(name);
}
