import "server-only";
import { randomBytes } from "node:crypto";
import { BOPS_DEVICE_HEADER, BOPS_PROTOCOL_HEADER, BOPS_USER_HEADER, CHAT_NOT_IN_CLOUD, STATE_PROTOCOL, type ChatSendAnswer, type ChatSendBody } from "@/cloud/protocol";
import { workspaceOf } from "@/lib/types";
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
 * Everything goes through the cloud there (cloud/turns.ts allCloud): a group, a bot set to work on the Mac and a bot
 * with no computer go too, with `all` (ChatSendBody.all), and Bops Cloud answers each on a computer or says in the chat
 * why not. A Bops Cloud that says the chat isn't its (CHAT_NOT_IN_CLOUD: the owner's last Mac is older, or the switch was
 * turned off meanwhile) has this Mac answer it, as before. Nothing is answered twice, and in a workspace in the cloud
 * never on this Mac by itself: a request that never went out (no route to Bops Cloud, it refused the connection, its
 * name didn't resolve) is "failed", and so is one sent and not answered (a timeout, Bops Cloud failing) after it's sent
 * again with the same key, which Bops Cloud takes once; the window says it didn't go. Pictures, files, an app open
 * beside the chat and Select's picks stay this Mac's for now.
 */

/** The errors of a request that never reached Bops Cloud: Bops Cloud never had it, so it's sent again (and never answered here). */
const NEVER_WENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"]);
const TRIES = 3;

const g = globalThis as unknown as { __bopsCloudChat?: { fetch?: typeof fetch } };

/** Whether this message goes through Bops Cloud (see above): any chat of a workspace in the cloud, a group or a bot with no computer too. */
export function sendsThroughCloud(chatId: string, extra: { images?: number; files?: number; lookingAt?: string; appNote?: boolean; picks?: boolean }): boolean {
  if (onRunner() || !cloudOn() || extra.images || extra.files || extra.lookingAt || extra.appNote || extra.picks) return false;
  const c = chat(chatId);
  if (!c || !c.botIds.length) return false;
  const st = getState();
  const b = st.bots.find((x) => x.id === c.botIds[0]);
  if (!b) return false;
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
 * answers it itself: Bops Cloud says this chat isn't its), or "failed" (it never went out, or no answer after TRIES: the
 * window says it didn't go, and this Mac never answers it by itself).
 */
export async function sendThroughCloud(chatId: string, text: string, replyTo?: string): Promise<"sent" | "here" | "failed"> {
  const key = randomBytes(12).toString("hex");
  const user = stateUser();
  const auth = cloudKey();
  if (!user || !auth) return "here";
  const f = g.__bopsCloudChat?.fetch ?? fetch;
  let neverWent = 0;
  for (let i = 0; i < TRIES; i++) {
    let res: Response;
    try {
      res = await f(`${cloudUrl()}/v1/chats/${encodeURIComponent(chatId)}/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth}`, [BOPS_USER_HEADER]: user, [BOPS_PROTOCOL_HEADER]: String(STATE_PROTOCOL), [BOPS_DEVICE_HEADER]: stateDevice() ?? "", "content-type": "application/json", ...appHeaders() },
        body: JSON.stringify({ key, text, ...(replyTo ? { replyTo } : {}), all: true } satisfies ChatSendBody),
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch (e) {
      // It never went out: in a workspace in the cloud that's never this Mac's to answer, so it's sent again, then failed.
      if (NEVER_WENT.has(causeOf(e))) neverWent++;
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
  if (neverWent === TRIES) console.warn(`[cloud-chat] ${chatId}: Bops Cloud couldn't be reached, so the message didn't go`);
  return "failed";
}

/**
 * The owner's switch for a workspace's chat (Settings, General: components/app/chat-switch.tsx), to Bops Cloud (POST
 * /v1/chat-routing, cloud/turns.ts setRouting): "cloud" runs everything there, and "mac" chooses this Mac, and Bops
 * Cloud never moves that workspace by itself after either; "auto" (an older window's) gives the choice back, so Bops
 * Cloud moves it once its bots' computers answer there. Where Bops Cloud doesn't move workspaces for this account, it
 * refuses "auto" (409 chat_auto_off) and says so on the workspace first (Workspace.chatAutoOff). The state is read
 * again now: it carries the switch as Bops Cloud wrote it (Workspace.chatOn, chatAuto, chatAutoOff, chatTrouble).
 * Refused: Bops Cloud's words (an older Bops on another Mac: 409).
 */
export async function setChatRouting(wsId: string, mode: "auto" | "mac" | "cloud"): Promise<{ ok: true } | { error: string; status: number }> {
  const user = stateUser();
  const auth = cloudKey();
  if (onRunner() || !cloudOn() || !user || !auth) return { error: "Sign in with Orgo to use Bops Cloud.", status: 409 };
  const f = g.__bopsCloudChat?.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${cloudUrl()}/v1/chat-routing`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}`, [BOPS_USER_HEADER]: user, [BOPS_PROTOCOL_HEADER]: String(STATE_PROTOCOL), [BOPS_DEVICE_HEADER]: stateDevice() ?? "", "content-type": "application/json", ...appHeaders() },
      body: JSON.stringify({ wsId, mode }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    return { error: "Couldn't reach Bops Cloud. Check your internet connection.", status: 502 };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: unknown } | null;
  if (res.ok && body?.ok) {
    await pullState().catch(() => {});
    return { ok: true };
  }
  return { error: typeof body?.error === "string" && body.error ? body.error : "Bops Cloud couldn't change that. Try again.", status: res.status === 409 || res.status === 404 ? res.status : 502 };
}

/** For tests: this way to reach Bops Cloud (unset: fetch). */
export const cloudChatForTests = (opts: { fetch?: typeof fetch }) => void (g.__bopsCloudChat = opts);
