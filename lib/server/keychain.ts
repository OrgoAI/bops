import "server-only";
import { stateUser } from "./store";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SERVICE = "Bops Vault";
const q = (s: string) => `"${s.replace(/["\\]/g, "")}"`;
const windows = process.platform === "win32";
const vaultFile = () => join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Bops", "vault.json");

function readVault(): Record<string, string> {
  try { return JSON.parse(readFileSync(vaultFile(), "utf8")) as Record<string, string>; } catch { return {}; }
}
function writeVault(v: Record<string, string>) {
  mkdirSync(dirname(vaultFile()), { recursive: true });
  writeFileSync(vaultFile(), JSON.stringify(v), { mode: 0o600 });
}
function ps(script: string, input = "") {
  return new Promise<string>((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `PowerShell exited ${code}`)));
    p.stdin.end(input);
  });
}
async function protect(value: string) {
  // ConvertFrom-SecureString without an explicit key uses Windows DPAPI for the current user.
  return ps(
    "$v=[Console]::In.ReadToEnd();$s=ConvertTo-SecureString $v -AsPlainText -Force;ConvertFrom-SecureString $s",
    value,
  );
}
async function unprotect(value: string) {
  return ps(
    "$v=[Console]::In.ReadToEnd();$s=ConvertTo-SecureString $v;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}",
    value,
  );
}

export async function setSecret(account: string, value: string) {
  if (windows) {
    const all = readVault();
    all[account] = await protect(value);
    writeVault(all);
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const p = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain refused it: ${err.trim() || code}`))));
    p.stdin.end(`add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} -X ${Buffer.from(value, "utf8").toString("hex")}\n`);
  });
}

export async function getSecret(account: string) {
  if (windows) {
    const value = readVault()[account];
    if (!value) return null;
    return unprotect(value).catch(() => null);
  }
  return new Promise<string | null>((resolve) =>
    execFile("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], (e, out) => resolve(e ? null : out.replace(/\n$/, ""))),
  );
}

export async function deleteSecret(account: string) {
  if (windows) {
    const all = readVault();
    delete all[account];
    if (Object.keys(all).length) writeVault(all);
    else if (existsSync(vaultFile())) writeFileSync(vaultFile(), "{}", { mode: 0o600 });
    return;
  }
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
