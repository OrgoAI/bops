import "server-only";
import { execFile, spawn } from "node:child_process";

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
