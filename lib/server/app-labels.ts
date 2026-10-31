import "server-only";
import { createHash, randomInt } from "node:crypto";

/*
 * The hidden names of an app's deploy projects and its Preview's public URL on Orgo (Your Apps: Local,
 * Preview, Published). Each is 12 lowercase letters and digits: 8 random (`head`, at least one a letter, so
 * never all digits, which orgo-web's checkLabel refuses) and a 4 character `seal` made from what it's for
 * (Preview or Prod), the app's Ingot repo, the site and the head. So any Mac recognizes a site's Preview and
 * Prod among its computer's projects and public URLs without Bops' state (isLabelOf), and a Preview's link,
 * once made, is found again and never changes (the user registers it in Google sign in once).
 * About 41 bits of randomness. Not a secret: a certificate for it shows up in public logs once visited.
 */

export type LabelKind = "preview" | "prod";

/** A label's shape: 12 lowercase letters and digits. */
export const LABEL = /^[a-z0-9]{12}$/;

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A label's last 4 characters, made from what it's for, the app's repo (lowercase), the site and its head. */
export function sealOf(kind: LabelKind, repo: string, site: string, head: string): string {
  const h = createHash("sha256").update(`bops:${kind}:${repo.toLowerCase()}:${site}:${head}`).digest();
  return Array.from({ length: 4 }, (_, i) => ALPHA[h[i] % 36]).join("");
}

/** A new label for a site's Preview or Prod: 8 random characters (at least one a letter), then its seal. */
export function newLabel(kind: LabelKind, repo: string, site: string, rand: (n: number) => number = (n) => randomInt(n)): string {
  let head = "";
  for (let tries = 0; tries < 100 && !/[a-z]/.test(head); tries++) head = Array.from({ length: 8 }, () => ALPHA[rand(36)]).join("");
  // (A random source that never gives a letter: one is put first.)
  if (!/[a-z]/.test(head)) head = `a${head.slice(1)}`;
  return head + sealOf(kind, repo, site, head);
}

/** Whether `label` is one of `kind` for this repo and site (made by newLabel, or given as one: labelGiven). */
export function isLabelOf(kind: LabelKind, label: unknown, repo: string, site: string): boolean {
  if (typeof label !== "string" || !LABEL.test(label)) return false;
  const head = label.slice(0, 8);
  return /[a-z]/.test(head) && label.slice(8) === sealOf(kind, repo, site, head);
}

/**
 * A Preview name the owner chose ahead (registered in Google sign in already): 12 lowercase letters and
 * digits, the first a letter. It carries no seal, so Bops keeps it in its state copy and finds it on Orgo by
 * that (AppHosting.preview); null when it isn't one.
 */
export function labelGiven(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9]{11}$/.test(v.trim()) ? v.trim() : null;
}
