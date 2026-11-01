import "server-only";
import { randomBytes } from "node:crypto";
import { BOPS_DEVICE_HEADER, BOPS_PROTOCOL_HEADER, BOPS_USER_HEADER, CHAT_NOT_IN_CLOUD, STATE_PROTOCOL, type ChatSendAnswer } from "@/cloud/protocol";
import { workBot, workspaceOf } from "@/lib/types";
import { appHeaders } from "./app-version";
import { cloudOn, cloudUrl } from "./cloud";
import { cloudKey } from "./orgo-auth";
import { onRunner } from "./persist";
import { chat, getState, pullState, stateDevice, stateUser } from "./store";

/**
 * The owner's own messages through Bops Cloud (cloud/turns.ts POST /v1/chats/<chatId>/send). In a workspace switched to
 * it (Workspace.chatOn, mirrored from Bops Cloud's switch), a plain message in a one bot chat whose bot works on a
 * computer goes to Bops Cloud first, which writes it and owes its answer to that computer, as it does a member's: this
 * Mac runs nothing for it, and every viewer hears it and the answer at once.
 *
 * Offline still works, and nothing is answered twice: only when the request never went out (no route to Bops Cloud, it
 * refused the connection, its name didn't resolve) does this Mac answer it itself, as before (Bops Cloud never heard of
 * it). Sent and not answered (a timeout, Bops Cloud failing) it's sent again with the same key, which Bops Cloud takes
 * once; then the window says it didn't go. Anything else (pictures, an app open beside the chat, Select's picks, a
 * group, a bot with no computer or set to work on the Mac) stays this Mac's, as before.
 */

/** The errors of a request that never reached Bops Cloud: safe to answer here, as Bops Cloud never had it. */
const NEVER_WENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"]);
const TRIES = 3;

const g = globalThis as unknown as { __bopsCloudChat?: { fetch?: typeof fetch } };

/** Whether this message goes through Bops Cloud (see above). */
export function sendsThroughCloud(chatId: string, extra: { images?: number; lookingAt?: string; appNote?: boolean; picks?: boolean }): boolean {
  if (onRunner() || !cloudOn() || extra.images || extra.lookingAt || extra.appNote || extra.picks) return false;
  const c = chat(chatId);
  if (!c || c.kind === "group" || c.botIds.length !== 1) return false;
  const st = getState();
  const b = st.bots.find((x) => x.id === c.botIds[0]);
  if (!b || b.runsOn === "mac" || !workBot(b, st.bots).computerId) return false;
  const ws = c.workspaceId ?? workspaceOf(b);
  return !!st.workspaces?.some((w) => w.id === ws && w.chatOn === "cloud");
}

/** Why a request failed, by its cause's code. */
const causeOf = (e: unknown) => {
  const c = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | null)?.cause;
  return typeof c?.code === "string" ? c.code : typeof c?.errors?.[0]?.code === "string" ? c.errors[0].code : "";
};

/**
 * Send the owner's message through Bops Cloud: "sent" (it's written there, and this Mac reads it now), "here" (this Mac
 * answers it itself: it never went out, or Bops Cloud says this chat isn't its), or "failed" (sent, and no answer
 * after TRIES: the window says it didn't go).
 */
export async function sendThroughCloud(chatId: string, text: string, replyTo?: string): Promise<"sent" | "here" | "failed"> {
  const key = randomBytes(12).toString("hex");
  const user = stateUser();
  const auth = cloudKey();
  if (!user || !auth) return "here";
  const f = g.__bopsCloudChat?.fetch ?? fetch;
  for (let i = 0; i < TRIES; i++) {
    let res: Response;
    try {
      res = await f(`${cloudUrl()}/v1/chats/${encodeURIComponent(chatId)}/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth}`, [BOPS_USER_HEADER]: user, [BOPS_PROTOCOL_HEADER]: String(STATE_PROTOCOL), [BOPS_DEVICE_HEADER]: stateDevice() ?? "", "content-type": "application/json", ...appHeaders() },
        body: JSON.stringify({ key, text, ...(replyTo ? { replyTo } : {}) }),
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch (e) {
      if (i === 0 && NEVER_WENT.has(causeOf(e))) return "here";
      continue;
    }
    const body = (await res.json().catch(() => null)) as (ChatSendAnswer & { code?: string }) | null;
    if (res.ok && body?.ok) {
      void pullState().catch(() => {});
      return "sent";
    }
    // Not this chat's (switched off meanwhile, its bot moved to the Mac): answered here, as before. Bops Cloud wrote nothing.
    if (res.status === 409 && body?.code === CHAT_NOT_IN_CLOUD) return "here";
    if (res.status < 500 && res.status !== 429) return "failed";
  }
  return "failed";
}

/** For tests: this way to reach Bops Cloud (unset: fetch). */
export const cloudChatForTests = (opts: { fetch?: typeof fetch }) => void (g.__bopsCloudChat = opts);
