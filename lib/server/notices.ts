import "server-only";
import type { CloudNotice } from "@/cloud/protocol";
import { cloudJson, cloudOn } from "./cloud";

/**
 * Notices from Orgo for the signed-in user (cloud/notices.ts), newest first: the app shows each once as
 * a pop-up (components/app/notice-popup.tsx). None when Bops isn't on Bops Cloud (self-hosted).
 */
export async function readNotices(): Promise<CloudNotice[]> {
  if (!cloudOn()) return [];
  const r = await cloudJson<{ notices?: CloudNotice[] }>("/v1/notices");
  return Array.isArray(r.notices) ? r.notices : [];
}

/** The user put a notice away: it doesn't come back, on any of their Macs. */
export async function dismissNotice(id: string): Promise<void> {
  if (!cloudOn()) return;
  await cloudJson("/v1/notices/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
}
