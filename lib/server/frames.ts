import "server-only";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./store";

/**
 * Each thread's last frame: its screen as it let go of it (sessions.ts leaveScreen), so a finished
 * thread can show where it left off even after another task has the screen. Kept on this Mac in the
 * user's ~/.bops (not the state's folder, which a cloud user doesn't have here), one JPEG per thread,
 * replaced each time; served by /api/frames.
 */
const framesDir = () => {
  const home = userHome();
  return home ? join(home, "frames") : null;
};

/** A thread's frame file, if the id is a thread's (letters, digits and _ only). */
export function framePath(sessionId: string): string | null {
  const dir = framesDir();
  if (!dir || !/^ses_[a-z0-9]+$/i.test(sessionId)) return null;
  return join(/*turbopackIgnore: true*/ dir, `${sessionId}.jpg`);
}

/** Keep a thread's last frame. Whether it was kept. */
export function saveFrame(sessionId: string, jpeg: Buffer): boolean {
  const p = framePath(sessionId);
  if (!p || !jpeg.length || jpeg.length > 8 * 1024 * 1024) return false;
  mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(/*turbopackIgnore: true*/ p, jpeg, { mode: 0o600 });
  return true;
}

export const hasFrame = (sessionId: string) => {
  const p = framePath(sessionId);
  return !!p && existsSync(/*turbopackIgnore: true*/ p);
};
