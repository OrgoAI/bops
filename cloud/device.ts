import { createHash } from "node:crypto";

/**
 * A device of a user's, as their state knows it (state.macs, Session.by, the writer Bops Cloud keeps):
 * the first 16 hex characters of SHA-256("<user id>\n<platform>"). A Mac's platform is its hardware id;
 * a computer's runner's is its computer id (BOPS_DEVICE_SEED), so Bops Cloud makes the same one for a
 * computer that signs in as itself (auth.ts) and never takes another from it. The app's own is
 * lib/server/persist-cloud.ts deviceIdFor, which calls this.
 */
export const deviceIdOf = (userId: string, platform: string) => createHash("sha256").update(`${userId}\n${platform}`).digest("hex").slice(0, 16);
