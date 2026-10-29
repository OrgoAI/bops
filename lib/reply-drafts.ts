import type { ReplyDraft } from "./types";

/*
 * Replies a bot wrote for the user to send (Message.drafts): how one stands, and how it reads where its
 * card can't go (a text, an email, a channel, the run's record). Imported by the window and the server
 * alike: no server imports here. Sending is lib/server/reply-drafts.ts.
 */

/** How long a Send may go unanswered before Bops takes it for lost (the app quit as it went): its card says so, and it can go again. */
export const SEND_STALE_MS = 2 * 60_000;

/** What a Send that was never answered says: it may have gone. */
export const LOST_SEND = "Bops didn't hear back. Check whether it went before you send it again.";

export type DraftStatus = "draft" | "sending" | "sent" | "failed";

/** Where a draft stands: written, going now, sent, or its last Send failed (or was never answered). */
export function draftStatus(d: Pick<ReplyDraft, "sent" | "sending" | "error">, now = Date.now()): DraftStatus {
  if (d.sent) return "sent";
  if (d.sending !== undefined && now - d.sending < SEND_STALE_MS) return "sending";
  if (d.error || d.sending !== undefined) return "failed";
  return "draft";
}

/** Why its last Send didn't go, as its card says it (undefined: it didn't fail). */
export function draftError(d: Pick<ReplyDraft, "sent" | "sending" | "error">, now = Date.now()): string | undefined {
  if (d.sent) return undefined;
  if (d.sending !== undefined && now - d.sending >= SEND_STALE_MS) return LOST_SEND;
  return d.sending !== undefined ? undefined : d.error;
}

export const DRAFT_APP_NAME: Record<ReplyDraft["app"], string> = { gmail: "Gmail", slack: "Slack", discord: "Discord" };

/** Who it goes to: the name and address for an email ("Kevin Example <kevin@example.com>"), else the name. */
export const draftTo = (d: Pick<ReplyDraft, "toName" | "to">) => (d.to ? (d.toName && d.toName.toLowerCase() !== d.to.toLowerCase() ? `${d.toName} <${d.to}>` : d.to) : d.toName);

/** Where it goes, in a few words: the subject for an email, the channel for Slack or Discord ("#support, in its thread"). */
export function draftWhere(d: Pick<ReplyDraft, "app" | "subject" | "where" | "channel" | "threadTs" | "messageId">): string {
  if (d.app === "gmail") return d.subject ? d.subject : "its thread";
  const place = d.where ?? (d.app === "slack" && d.channel?.startsWith("D") ? "a direct message" : d.channel ? `channel ${d.channel}` : DRAFT_APP_NAME[d.app]);
  return d.threadTs ? `${place}, in its thread` : d.messageId ? `${place}, as a reply` : place;
}

/** One draft as plain words: who and where, then its text (what was sent, once it went). */
export const draftText = (d: ReplyDraft) => `Reply to ${draftTo(d)} (${DRAFT_APP_NAME[d.app]}, ${draftWhere(d)})${d.sent ? ", sent" : ""}:\n${d.sent?.text ?? d.text}`;

/** Drafts as plain words, for where their cards can't go: each one, and where to send them. */
export const draftsText = (drafts: readonly ReplyDraft[]) =>
  drafts.length ? `${drafts.map(draftText).join("\n\n")}\n\n${drafts.length === 1 ? "Send it" : "Send them"} from Bops.` : "";

/** What a bot's message says when it only offered drafts. */
export const readyWords = (n: number) => (n === 1 ? "Here's a reply for you to send." : `Here are ${n} replies for you to send.`);
