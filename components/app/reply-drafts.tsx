"use client";

import { useState } from "react";
import { DRAFT_APP_NAME, draftError, draftStatus, draftWhere } from "@/lib/reply-drafts";
import type { AppAccount, AppState, Message, ReplyDraft } from "@/lib/types";
import { Spinner } from "./mascot";
import { DraftSource } from "./source-view";
import { clockTime, post } from "./ui";

/*
 * Replies a bot wrote for the user to send (Message.drafts, lib/server/reply-drafts.ts), as cards under its
 * message: in the chat (chat-view.tsx) and in a routine's reports (routine-reports.tsx). Each says who it goes to
 * and where, exactly (the address, the channel), with the words in a box the user can change, Send and Copy.
 * Sending, it says so and waits; sent, it folds to one line ("Sent to Kevin · 9:14 AM") that opens to what
 * went; failed, it says why, with Send again. In a workspace shared with the user they're the owner's: read
 * and copied, never sent (the server refuses it too: app/api/drafts/send).
 */

/** What the user typed in a draft and hasn't sent, by its id: kept while the window is open, so the chat and the reports show the same words. */
const edits = new Map<string, string>();

const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";

/** The account a reply goes from, as the Vault names it. */
const titleOf = (a?: AppAccount) => (a ? [a.label, a.name].filter(Boolean).join(" · ") || a.appName : undefined);

export function ReplyDrafts({ message: m, state, className = "" }: { message: Message; state: AppState; className?: string }) {
  if (!m.drafts?.length) return null;
  return (
    <div data-drafts className={`flex w-[420px] min-w-0 max-w-full flex-col gap-2 ${className}`}>
      {m.drafts.map((d) => (
        <DraftCard key={d.id} messageId={m.id} draft={d} readOnly={!!state.shared} from={state.shared ? undefined : state.accounts?.find((a) => a.id === d.accountId)} />
      ))}
    </div>
  );
}

function DraftCard({ messageId, draft: d, readOnly, from }: { messageId: string; draft: ReplyDraft; readOnly: boolean; from?: AppAccount }) {
  const [text, setText] = useState(() => edits.get(d.id) ?? d.sent?.text ?? d.text);
  const [busy, setBusy] = useState(false);
  // What the server answered that the state doesn't say (the reply gone, Bops not reached).
  const [answered, setAnswered] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  // The email or thread it answers, read from the account it goes from (source-view.tsx); never in a shared workspace.
  const [showing, setShowing] = useState(false);
  const canShow = !readOnly && !!d.accountId && (d.app === "gmail" ? !!d.threadId : d.app === "slack" ? !!d.channel && !!d.threadTs : !!d.channel);
  const status = busy && !d.sent ? "sending" : draftStatus(d);
  const error = status === "failed" ? (draftError(d) ?? answered) : status === "draft" ? answered : undefined;
  const app = DRAFT_APP_NAME[d.app];

  const edit = (v: string) => {
    setText(v);
    edits.set(d.id, v);
  };
  const copy = () => {
    void navigator.clipboard?.writeText(d.sent?.text ?? text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const send = async () => {
    if (busy || readOnly) return;
    setBusy(true);
    setAnswered(undefined);
    try {
      const res = await post("/api/drafts/send", { messageId, draftId: d.id, text });
      if (res.ok) edits.delete(d.id);
      // Being sent, or sent already (a second click, another window): the card shows that from the state.
      else if (res.status !== 409) setAnswered(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "It didn't send.");
    } catch {
      setAnswered("Bops couldn't be reached. Try again.");
    }
    setBusy(false);
  };

  const logo = (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/logos/${d.app}.svg`} alt="" width={14} height={14} className="shrink-0 rounded-[3px]" />
  );

  // Sent: one line, opening to what went.
  if (d.sent)
    return (
      <div data-draft={d.id} data-draft-status="sent" className="flex flex-col gap-1.5">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 text-left shadow-[0_0_0_1px_#E2E2DF] outline-none hover:bg-[#FCFCFB] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
        >
          {logo}
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-[#2BB673]">
            <path d="M3 8.5l3 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-4 text-[#3A3A38]">
            Sent to {d.toName} · {clockTime(d.sent.at)}
          </span>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`shrink-0 text-[#B0B0AD] transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div data-draft-sent className="whitespace-pre-wrap rounded-xl bg-[#F7F7F6] px-3 py-2 text-[12.5px] leading-[18px] text-[#3A3A38] [overflow-wrap:anywhere]">
            {d.sent.text}
          </div>
        )}
      </div>
    );

  const sending = status === "sending";
  return (
    <div data-draft={d.id} data-draft-status={status} className="flex flex-col gap-2.5 rounded-2xl bg-white p-3.5 shadow-[0_0_0_1px_#0000000F,0_10px_30px_-16px_#00000059]">
      <div className="flex items-start gap-2.5">
        <span className="pt-0.5">{logo}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[13.5px] font-semibold leading-[18px]">Reply to {d.toName}</span>
          {/* Exactly where it goes: the address for an email; the channel (and as which Discord bot) for Slack and Discord. */}
          <span data-draft-where className="flex flex-wrap items-center gap-1 text-[12px] leading-4 text-[#6B6B6B]">
            {d.to ? (
              <>
                To
                <code className="rounded-md bg-[#F7F7F6] px-1.5 py-0.5 text-[11.5px] leading-4 text-[#3A3A38] [overflow-wrap:anywhere]">{d.to}</code>
                {d.subject && <span className="min-w-0 [overflow-wrap:anywhere]">· {d.subject}</span>}
              </>
            ) : (
              <span className="[overflow-wrap:anywhere]">
                {app} · {draftWhere(d)}
                {d.app === "discord" ? ` · as ${titleOf(from) ?? "your Discord bot"}` : ""}
              </span>
            )}
          </span>
        </div>
      </div>
      {readOnly ? (
        <div className="whitespace-pre-wrap rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13px] leading-[19px] text-[#3A3A38] [overflow-wrap:anywhere]">{text}</div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => edit(e.target.value)}
          disabled={sending}
          aria-label={`Reply to ${d.toName}`}
          rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
          className="w-full resize-y rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13px] leading-[19px] text-ink outline-none placeholder:text-[#9A9A98] focus:shadow-[0_0_0_1.5px_#0A0A0A] disabled:text-[#6B6B6B]"
        />
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318] [overflow-wrap:anywhere]">
          {error}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {!readOnly && (
          <button onClick={() => void send()} disabled={sending || !text.trim()} className={`${btn} flex items-center gap-1.5 bg-ink text-white`}>
            {sending ? (
              <>
                <Spinner size={11} color="#FFFFFF" />
                Sending
              </>
            ) : status === "failed" ? (
              "Send again"
            ) : (
              "Send"
            )}
          </button>
        )}
        <button onClick={copy} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
          {copied ? "Copied" : "Copy"}
        </button>
        {canShow && (
          <button onClick={() => setShowing(!showing)} aria-expanded={showing} data-draft-show className={`${btn} text-[#3A3A38] hover:bg-[#F2F2F0]`}>
            {showing ? `Hide the ${d.app === "gmail" ? "email" : "thread"}` : `Show the ${d.app === "gmail" ? "email" : "thread"}`}
          </button>
        )}
      </div>
      {showing && canShow && <DraftSource messageId={messageId} draftId={d.id} app={d.app} />}
    </div>
  );
}
