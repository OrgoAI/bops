"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { privacyOf } from "@/lib/privacy";
import type { AppState, Message } from "@/lib/types";
import { post } from "./ui";

/**
 * Deleting messages from a chat (chat-view.tsx): one from its hover actions or its menu, the ones ticked in
 * Select messages, or every one (Delete all messages, asked first). Each delete shows a short line for a few
 * seconds, in place for one message, over the message box for more, with Undo:
 * - The user keeps what they delete a few days (Settings → Your data, deletedDays): it's deleted at once, and
 *   Undo puts it back from Recently deleted (POST /api/privacy { restore }), as Restore there does, Bops Cloud
 *   and the other Macs too.
 * - Gone at once (deletedDays 0, the default): nothing is kept to put back, so the delete waits out its Undo
 *   here before it's sent (hidden meanwhile), and Undo just doesn't send it. Leaving the chat's window sends it
 *   at once. Delete all messages, asked first, goes at once either way.
 * What was kept between us never comes back (no copy holds it): the line says how many of those went for good.
 */

export const UNDO_MS = 6000;

export type Gone = {
  key: string;
  chatId: string;
  ids: string[];
  /** When the one deleted on its own was said, and whether it was the user's own (its line goes where it was, on its side). */
  at: number;
  mine: boolean;
  /** One message on its own (its line shows in place), else several or the whole chat (the line shows over the message box). */
  one: boolean;
  all: boolean;
  /** How many went (for the whole chat: as the window counted them, then as the server says). */
  count: number;
  /** Waiting out its Undo before it's sent (Gone at once). */
  waiting: boolean;
  /** The copy in Recently deleted to put it back from (null: none, or not sent yet). */
  restore: string | null;
  /** How many of them no copy holds, as they were kept between us: gone for good. */
  between: number;
  busy?: boolean;
  /** It didn't go (shown again, with why), or didn't come back. */
  failed?: true;
  error?: string;
};

const url = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}/messages`;
const bodyOf = (g: Pick<Gone, "all" | "ids">) => (g.all ? { all: true } : { ids: g.ids });
type Answer = { deleted?: number; restore?: string | null; between?: number; error?: string };

/** The deletes of the chat view, and what they hide until they're sent or undone. */
export function useMessageDeletes(state: AppState) {
  const [gone, setGone] = useState<Gone[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The latest list, for the timers and the window closing.
  const live = useRef(gone);
  useLayoutEffect(() => {
    live.current = gone;
  });
  const keeps = privacyOf(state).deletedDays > 0;

  const patch = (key: string, p: Partial<Gone>) => setGone((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const stopTimer = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
  };
  const drop = (key: string) => {
    stopTimer(key);
    setGone((list) => list.filter((x) => x.key !== key));
  };
  const later = (key: string, fn: () => void) => {
    stopTimer(key);
    timers.current.set(key, setTimeout(fn, UNDO_MS));
  };

  /** Sent: the server's answer, or the line says it didn't go (and the messages show again). */
  const send = async (g: Gone): Promise<Answer | null> => {
    const res = await post(url(g.chatId), bodyOf(g), "DELETE").catch(() => null);
    const out = res ? ((await res.json().catch(() => null)) as Answer | null) : null;
    if (res?.ok && out) return out;
    patch(g.key, { waiting: false, failed: true, error: out?.error ?? "That didn't delete. Try again." });
    later(g.key, () => drop(g.key));
    return null;
  };

  /** Delete these messages of one chat (`all`: every one of it, `count` as the window has them). */
  const remove = (chatId: string, messages: readonly Message[], { all = false, count, mine = false }: { all?: boolean; count?: number; mine?: boolean } = {}) => {
    if (!messages.length && !all) return;
    const key = `gone_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const g: Gone = {
      key,
      chatId,
      ids: messages.map((m) => m.id),
      at: messages[0]?.at ?? Date.now(),
      mine,
      one: messages.length === 1 && !all,
      all,
      count: count ?? messages.length,
      waiting: !keeps && !all,
      restore: null,
      between: 0,
    };
    setGone((list) => [...list, g]);
    if (g.waiting) {
      later(key, () => {
        patch(key, { waiting: false, busy: true });
        void send({ ...g, waiting: false }).then((out) => out && drop(key));
      });
      return;
    }
    void send(g).then((out) => {
      if (!out) return;
      patch(key, { restore: out.restore ?? null, between: out.between ?? 0, count: out.deleted ?? g.count });
      later(key, () => drop(key));
    });
  };

  /** Undo: one still waiting is never sent; one sent comes back from Recently deleted. */
  const undo = async (key: string) => {
    const g = live.current.find((x) => x.key === key);
    if (!g || g.busy) return;
    if (g.waiting) return drop(key);
    if (!g.restore) return;
    stopTimer(key);
    patch(key, { busy: true });
    const res = await post("/api/privacy", { restore: g.restore }).catch(() => null);
    if (res?.ok) return drop(key);
    const out = res ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
    patch(key, { busy: false, restore: null, error: out?.error ?? "That didn't come back. It's in Settings, Your data, Recently deleted." });
    later(key, () => drop(key));
  };

  // Leaving (the window closing, or this view going): what still waits out its Undo is sent now, so a delete is never lost.
  useEffect(() => {
    const flush = (keepalive: boolean) => {
      for (const g of live.current) {
        if (!g.waiting) continue;
        stopTimer(g.key);
        if (keepalive)
          void fetch(url(g.chatId), { method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyOf(g)) }).catch(() => {});
        else void post(url(g.chatId), bodyOf(g), "DELETE").catch(() => {});
      }
    };
    const onHide = () => flush(true);
    const all = timers.current;
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flush(false);
      for (const t of all.values()) clearTimeout(t);
    };
  }, []);

  // What the chat leaves out while it goes: until it's sent (or the state no longer has it), never once it didn't go.
  const hidden = useMemo(() => new Set(gone.filter((g) => !g.failed).flatMap((g) => g.ids)), [gone]);
  return { gone, hidden, remove, undo, keeps };
}

/** What a delete's line says: "Deleted", "Deleted 5 messages", with how many of them were kept between us and went for good, or why it didn't go. */
export function goneWords(g: Gone): string {
  if (g.error) return g.error;
  const what = g.one ? "Deleted" : `Deleted ${g.count.toLocaleString("en-US")} message${g.count === 1 ? "" : "s"}`;
  if (!g.between) return what;
  if (g.between >= g.count) return `${what}. Kept between us, so ${g.count === 1 ? "it" : "they"} can't come back`;
  return `${what}. ${g.between} kept between us can't come back`;
}

/** The line a delete leaves for a few seconds: what went, and Undo while it can come back. */
export function UndoLine({ g, onUndo, className = "" }: { g: Gone; onUndo: () => void; className?: string }) {
  const can = !g.error && !g.busy && (g.waiting || !!g.restore);
  return (
    <div role="status" className={`motion-fade-in flex items-center gap-1.5 px-1 py-1 text-[12.5px] leading-4 ${g.error ? "text-[#B42318]" : "text-[#9A9A98]"} ${className}`}>
      <TrashIcon size={12} />
      <span>{goneWords(g)}</span>
      {can && (
        <>
          <span aria-hidden>·</span>
          <button type="button" onClick={onUndo} className="font-medium text-ink underline-offset-2 hover:underline">
            Undo
          </button>
        </>
      )}
    </div>
  );
}

export function TrashIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Select messages: a ring, filled with a tick once picked. */
export function PickRing({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex size-[18px] shrink-0 items-center justify-center rounded-full transition-colors ${on ? "bg-ink" : "bg-white shadow-[inset_0_0_0_1.5px_#C9C9C6]"}`}>
      {on && (
        <svg width="10" height="10" viewBox="0 0 16 16">
          <path d="M3 8.5l3 3L13 4.5" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

/** "Select messages" in a chat's menu: a list with ticks. */
export function SelectIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" className="shrink-0 text-[#6B6B6B]" aria-hidden>
      <circle cx="3.5" cy="4.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.5" cy="11.5" r="1.9" fill="currentColor" />
      <path d="M7.5 4.5h6M7.5 11.5h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A message in Select messages: its ring beside it, and the whole row one button that ticks it (nothing in the
 * message itself is pressed meanwhile).
 */
export function TickRow({ on, onToggle, children }: { on: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className={`relative flex w-full items-center gap-2.5 rounded-[14px] px-1.5 py-0.5 transition-colors ${on ? "bg-[#F4F4F2]" : ""}`}>
      <PickRing on={on} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <button type="button" aria-pressed={on} aria-label={on ? "Picked" : "Pick"} onClick={onToggle} className="absolute inset-0 z-[3] cursor-pointer rounded-[14px] outline-none focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]" />
    </div>
  );
}

/** Select messages, over the message box in its place: how many are picked, Cancel, and Delete them. */
export function TickBar({ count, onCancel, onDelete }: { count: number; onCancel: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-[22px] bg-white py-2 pl-4 pr-2 shadow-[0_0_0_1px_#E2E2DF]">
      <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-[#6B6B6B]">{count ? `${count.toLocaleString("en-US")} picked` : "Pick the messages to delete"}</span>
      <button type="button" autoFocus onClick={onCancel} className="rounded-full px-3 py-1.5 text-[13px] font-medium leading-4 text-ink hover:bg-[#F2F2F0]">
        Cancel
      </button>
      <button type="button" disabled={!count} onClick={onDelete} className="rounded-full bg-[#B42318] px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-white disabled:opacity-40">
        {count ? `Delete ${count.toLocaleString("en-US")}` : "Delete"}
      </button>
    </div>
  );
}
