"use client";

import type { MemberAct } from "@/cloud/protocol";
import { post } from "./ui";

/**
 * Do something in the shared workspace open now, for a bot the owner gave the user Write on (lib/server/shared.ts
 * actShared, through POST /api/workspaces/shared, the one way it goes while a shared workspace is open: view-only.ts):
 * a fresh key, or the same one to try a failed one again (it's never done twice). What it says when it didn't go
 * (`error`) is also shown where it was done: under their message or reply, which the window's state carries
 * (Message.memberSend) until the owner's Bops has written it.
 */
export async function memberAct(act: MemberAct, key = crypto.randomUUID().replace(/-/g, "")): Promise<{ ok: boolean; error?: string }> {
  const res = await post("/api/workspaces/shared", { act, key }).catch(() => null);
  if (!res) return { ok: false, error: "Couldn't reach Bops. Try again." };
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error || "That didn't go. Try again." };
}
