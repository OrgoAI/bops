import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.ts";

/**
 * Secrets the cloud keeps in Postgres (a user's AgentMail pod key, AgentPhone webhook secrets) are
 * sealed with AES-256-GCM under BOPS_CLOUD_SECRET, so a copy of the database alone doesn't hold them.
 * Format: "v1:" + base64(iv(12) | tag(16) | ciphertext).
 */

function key(): Buffer {
  const raw = config.secret();
  if (!raw) throw new Error("BOPS_CLOUD_SECRET isn't set");
  const k = Buffer.from(raw, "base64");
  if (k.length < 32) throw new Error("BOPS_CLOUD_SECRET must be at least 32 bytes, base64");
  return k.subarray(0, 32);
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), data]).toString("base64")}`;
}

export function open(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("Unknown sealed format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
