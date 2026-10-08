import "server-only";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { signedInUser } from "./orgo-auth";
import { userBopsHome } from "./user-paths";

/**
 * Full access for bots on this Mac (Settings, This Mac; executorCommand in local.ts): this Mac's and
 * the signed-in user's alone, so it's kept in a file of theirs here (~/.bops/users/<id>, beside their
 * bots' workspace: not their state, which lives in Bops Cloud). It's never part of their state in
 * Bops Cloud (state-merge.ts leaves it out both ways), so nothing there can turn it on, and only the
 * Bops window may (the /api/mac route asks for its token, ui-token.ts).
 */
const file = () => join(/*turbopackIgnore: true*/ userBopsHome(signedInUser()?.id ?? null), "full-access");

export const fullAccessOn = () => existsSync(/*turbopackIgnore: true*/ file());

export function setFullAccess(on: boolean) {
  const f = file();
  if (!on) return rmSync(/*turbopackIgnore: true*/ f, { force: true });
  mkdirSync(/*turbopackIgnore: true*/ dirname(f), { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ f, "on\n", { mode: 0o600 });
}
