import "server-only";
import type { Bot, ScreenRead } from "@/lib/types";
import { live } from "@/lib/types";
import { fillField, input } from "./local";
import { readScreen } from "./screen-watch";
import { screenEndpoint } from "./screens";
import { replyToSession } from "./sessions";
import { getState, patchSession, session } from "./store";

export type SignInValues = { identifier?: string; password?: string; code?: string };

/**
 * Fill the sign-in or code fields Jev matched on a bot's page, submit, and look again. Values go
 * straight into the page over DevTools; they're never stored here, logged, or shown to a model.
 * Once the page is past the sign-in, the thread that hit it picks up. Used by the sign-in card
 * (values the user typed) and the vault (values from the Keychain).
 */
export async function submitSignIn(b: Bot, display: number, values: SignInValues): Promise<{ read: ScreenRead | null; filled: (keyof SignInValues)[] }> {
  const endpoint = screenEndpoint(b, display);
  const read = getState().screens?.[`${b.id}:${display}`];
  if (!endpoint || !read?.form) throw new Error("nothing to fill on this screen");
  const filled = (["identifier", "password", "code"] as const).filter((k) => read.form![k] && values[k]);
  if (!filled.length) throw new Error("nothing to fill in");
  for (const k of filled) await fillField(endpoint, read.form[k]!.id, values[k]!);
  await input(endpoint, { kind: "key", key: "Return" });

  // Give the site a moment, then see where it landed (often the next step: password, then a code).
  const task = read.sessionId ? (session(read.sessionId)?.goal ?? "") : "";
  let next: ScreenRead | null = null;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    next = await readScreen(b.id, display, endpoint, task, read.sessionId);
    if (next && (next.url !== read.url || next.blocker !== read.blocker || JSON.stringify(next.form) !== JSON.stringify(read.form))) break;
  }

  const s = read.sessionId ? session(read.sessionId) : undefined;
  if (next && !next.blocker && s) {
    patchSession(s.id, { blocker: undefined });
    if (!live(s)) replyToSession(s.id, "You've been signed in on the screen. Look at the screen as it is now and carry on with the task.", `${b.name} was signed in`);
  }
  return { read: next, filled };
}
