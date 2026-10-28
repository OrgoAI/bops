"use client";

import { useEffect, useState } from "react";
import {
  DAY_MS,
  DELETED_OPTIONS,
  deletedGoesLine,
  goesLine,
  KEEP_OPTIONS,
  keepGoesAny,
  keepsLess,
  many,
  num,
  sizeOf,
  type DeletedGoes,
  type DeletedItem,
  type HereCount,
  type KeepGoes,
  type PrivacyInfo,
} from "@/lib/privacy";
import type { DeletedDays, KeepDays } from "@/lib/types";
import { post } from "./ui";

/**
 * Settings → Your data (lib/privacy.ts, app/api/privacy): where each kind of the user's things is kept and how
 * it goes, with this Mac's numbers; how long chats and calls are kept (a shorter choice says what it deletes
 * now and asks once); what a delete leaves behind, with Recently deleted to restore from (fewer days says
 * how many copies go, here now and on the other Macs at their next check, and asks once too); and what none
 * of it covers yet. Asking never fails open: when Bops can't say what a choice deletes, it still asks, in
 * general. The user's own: not shown in a shared workspace (bops-app.tsx), whose server refuses it too, nor
 * on a hosted server, which refuses it (nothing would sweep there).
 */

const readInfo = async (proposed?: { keepDays: KeepDays } | { deletedDays: DeletedDays }): Promise<PrivacyInfo | null> => {
  const q = !proposed ? "" : "keepDays" in proposed ? `?keepDays=${proposed.keepDays}` : `?deletedDays=${proposed.deletedDays}`;
  try {
    const r = await fetch(`/api/privacy${q}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as PrivacyInfo) : null;
  } catch {
    return null;
  }
};

const KEEP_NAMES = new Map<KeepDays, string>([
  [null, "Until I delete them"],
  [365, "1 year"],
  [90, "90 days"],
  [30, "30 days"],
]);
const DELETED_NAMES = new Map<DeletedDays, string>([
  [0, "Gone at once"],
  [7, "Keep 7 days"],
  [30, "Keep 30 days"],
]);
const KIND_NAMES: Record<DeletedItem["kind"], string> = { message: "Message", thread: "Thread", chat: "Group chat" };


/** A count of this Mac's files as a chip says it: "12 · 3.4 MB", or the size alone for a log. */
function countLine(c: HereCount, unit?: [string, string]) {
  const size = `${sizeOf(c.bytes)}${c.more ? "+" : ""}`;
  return c.count === undefined || !unit ? size : `${num(c.count)}${c.more && unit[0] !== "profile" ? "+" : ""} ${c.count === 1 ? unit[0] : unit[1]} · ${size}`;
}

/** When, in days: "today", "yesterday", "3 days ago"; and how long until: "today", "in 1 day", "in 6 days". */
function daysAgo(at: number) {
  const d = Math.floor((Date.now() - at) / DAY_MS);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}
function daysLeft(until: number) {
  const d = Math.ceil((until - Date.now()) / DAY_MS);
  return d <= 0 ? "today" : `in ${many(d, "day")}`;
}

const pill = (on: boolean) =>
  `rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-60 ${on ? "bg-ink text-white" : "shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]"}`;
const small = "shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6] disabled:opacity-60";
const card = "flex flex-col gap-2.5 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]";
const danger = "rounded-full bg-[#B42318] px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-white disabled:opacity-60";
const sub = "text-[12px] leading-4 text-[#6B6B6B]";

/** Where each kind of thing is kept and how it goes, one plain line each. */
function WhereKept({ info }: { info: PrivacyInfo }) {
  const h = info.here;
  const here: [string, string][] = [
    ["Images", countLine(h.uploads, ["image", "images"])],
    ["Pages", countLine(h.pages, ["page", "pages"])],
    ["Call notes", countLine(h.calls)],
    ["Last screens", countLine(h.frames, ["screen", "screens"])],
    ["Browser profiles", countLine(h.chrome, ["profile", "profiles"])],
    ["Model choices", countLine(h.routes)],
  ];
  const rows: { kind: string; where: string; how: string; extra?: React.ReactNode }[] = [
    {
      kind: "Logins and tokens",
      where: "Kept in this Mac's Keychain. A bot signing in fills them into that site's page, never into a chat or a model.",
      how: "Remove one in Logins, or disconnect its channel.",
    },
    { kind: "Keys bots use", where: "Orgo's vault, encrypted. Bops keeps only their names.", how: "Delete one in Logins." },
    {
      kind: "Chats, routines and settings",
      where: "Bops Cloud, Orgo's database, so your Macs and iPhone match.",
      how: "Delete a message from its menu, or keep them for less time below.",
      extra: <span className="text-[12px] leading-4 text-[#3A3A38]">{many(info.messages, "message")}</span>,
    },
    { kind: "Memory and Knowledge", where: "Honcho, the memory service Orgo uses, keeps what it learned from your chats and calls.", how: "It stays until you forget it in Knowledge." },
    { kind: "Skill, app and table files", where: "Orgo's file storage.", how: "Delete a skill, app or CRM file where you see it." },
    {
      kind: "Images, pages, call notes, browser profiles, last screens",
      where: "The files stay on this Mac.",
      how: "Images, pages, call notes and last screens go with your chats when you keep them for less time. Browser profiles keep your bots' logins on this Mac.",
      extra: (
        <span className="flex flex-wrap gap-1.5">
          {here.map(([name, line]) => (
            <span key={name} className="rounded-full bg-[#F7F7F6] px-2 py-0.5 text-[11.5px] leading-4 text-[#3A3A38]">
              {name} {line}
            </span>
          ))}
        </span>
      ),
    },
    { kind: "Email and texts", where: "The mail and phone services behind your bots' addresses and numbers.", how: "A bot's inboxes go when you delete the bot." },
    { kind: "Connected apps", where: "Composio keeps the logins.", how: "Disconnect one in Logins." },
    { kind: "Answers to chats and tasks", where: "OpenAI keeps each one 30 days.", how: "Then it's deleted there." },
  ];
  return (
    <div className="flex flex-col rounded-[14px] px-3.5 shadow-[0_0_0_1px_#E6E6E3]">
      {rows.map((r) => (
        <div key={r.kind} className="flex flex-col gap-1 border-b border-[#F0F0EE] py-2.5 last:border-0">
          <span className="text-[13px] font-medium leading-4">{r.kind}</span>
          <span className={sub}>
            {r.where} {r.how}
          </span>
          {r.extra}
        </div>
      ))}
    </div>
  );
}

/** One in Recently deleted: what it was, when it was deleted and goes for good, Restore and Delete now. */
function DeletedRow({ item, busy, act }: { item: DeletedItem; busy: boolean; act: (body: { restore: string } | { deleteNow: string }) => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-[#F0F0EE] py-2 last:border-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium leading-4">{item.what}</span>
        <span className="text-[11.5px] leading-4 text-[#6B6B6B]">
          {KIND_NAMES[item.kind]}
          {item.kind !== "message" && item.messages ? ` · ${many(item.messages, "message")}` : ""} · deleted {daysAgo(item.at)} · goes {daysLeft(item.until)}
        </span>
      </div>
      <button type="button" disabled={busy} onClick={() => act({ restore: item.id })} className={small}>
        Restore
      </button>
      <button type="button" disabled={busy} onClick={() => act({ deleteNow: item.id })} className={`${small} text-[#B42318]`}>
        Delete now
      </button>
    </div>
  );
}

/** Settings → Your data. Nothing until it's loaded, or when the server won't say (a shared workspace, outside the Bops window, a hosted server). */
export function YourData() {
  const [info, setInfo] = useState<PrivacyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** A shorter keep, or fewer days for what's deleted, waiting on the user's yes: with what it deletes (null: Bops couldn't say). */
  const [asking, setAsking] = useState<{ keepDays: KeepDays; goes: KeepGoes | null } | null>(null);
  const [askingDeleted, setAskingDeleted] = useState<{ deletedDays: DeletedDays; goes: DeletedGoes | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void readInfo().then(setInfo);
  }, []);
  // While a sweep is under way the numbers move: read them again until it's done.
  useEffect(() => {
    if (!info?.sweeping) return;
    const t = setTimeout(() => void readInfo().then((x) => x && setInfo(x)), 3_000);
    return () => clearTimeout(t);
  }, [info]);
  if (!info) return null;

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/privacy", body);
      const out = (await res.json().catch(() => null)) as (PrivacyInfo & { error?: string }) | null;
      if (res.ok && out) setInfo(out);
      else setError(out?.error ?? "That didn't work. Try again.");
    } catch {
      setError("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  /** A shorter keep first says what it deletes now, and goes once the user says so (nothing to delete: it just goes; Bops couldn't say: it asks anyway). */
  const pickKeep = async (k: KeepDays) => {
    setAsking(null);
    setAskingDeleted(null);
    if (k === info.keepDays) return;
    if (keepsLess(info.keepDays, k)) {
      setBusy(true);
      const now = await readInfo({ keepDays: k }).finally(() => setBusy(false));
      const goes = now?.goes?.keepDays === k ? now.goes : null;
      if (!goes || keepGoesAny(goes)) return setAsking({ keepDays: k, goes });
    }
    await send({ keepDays: k });
  };
  /** Fewer days for what's deleted always asks first: how many copies go on this Mac now, and that the other Macs' go at their next check. */
  const pickDeleted = async (d: DeletedDays) => {
    setAsking(null);
    setAskingDeleted(null);
    if (d === info.deletedDays) return;
    if (d < info.deletedDays) {
      setBusy(true);
      const now = await readInfo({ deletedDays: d }).finally(() => setBusy(false));
      return setAskingDeleted({ deletedDays: d, goes: now?.goesDeleted?.deletedDays === d ? now.goesDeleted : null });
    }
    await send({ deletedDays: d });
  };

  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-semibold">Your data</span>
        <span className={sub}>Where Bops keeps your things, how long, and what a delete leaves behind.</span>
      </div>

      <WhereKept info={info} />

      <div className={card}>
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium">Keep chats and calls</span>
          <span className={sub}>
            Older messages and finished threads are deleted from Bops Cloud and all your Macs, with each Mac&apos;s call notes, last screens, and the images and pages no kept message shows.
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {KEEP_OPTIONS.map((k) => (
            <button key={String(k)} type="button" disabled={busy} aria-pressed={info.keepDays === k} onClick={() => void pickKeep(k)} className={pill(info.keepDays === k)}>
              {KEEP_NAMES.get(k)}
            </button>
          ))}
        </div>
        {asking && (
          <div className="flex flex-col gap-2 rounded-[10px] bg-[#FFF4F2] p-3">
            <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">{goesLine(asking.keepDays, asking.goes)}</span>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void send({ keepDays: asking.keepDays }).then(() => setAsking(null))} className={danger}>
                Delete and keep {KEEP_NAMES.get(asking.keepDays)}
              </button>
              <button type="button" disabled={busy} onClick={() => setAsking(null)} className={small}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={card}>
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium">When you delete something</span>
          <span className={sub}>
            A message, thread or group chat you delete leaves your chats and Bops Cloud at once.
            {info.deletedDays
              ? " A copy stays on this Mac only, so you can restore it. Bops Cloud never gets the copy, and what you kept between us is never copied."
              : " Its images on this Mac go too."}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {DELETED_OPTIONS.map((d) => (
            <button key={d} type="button" disabled={busy} aria-pressed={info.deletedDays === d} onClick={() => void pickDeleted(d)} className={pill(info.deletedDays === d)}>
              {DELETED_NAMES.get(d)}
            </button>
          ))}
        </div>
        {askingDeleted && (
          <div className="flex flex-col gap-2 rounded-[10px] bg-[#FFF4F2] p-3">
            <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">{deletedGoesLine(askingDeleted.deletedDays, askingDeleted.goes)}</span>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void send({ deletedDays: askingDeleted.deletedDays }).then(() => setAskingDeleted(null))} className={danger}>
                {askingDeleted.deletedDays ? `Delete and keep ${askingDeleted.deletedDays} days` : "Delete and keep none"}
              </button>
              <button type="button" disabled={busy} onClick={() => setAskingDeleted(null)} className={small}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {(info.deletedDays > 0 || info.deleted.length > 0) && (
          <div className="flex flex-col">
            <span className="text-[12.5px] font-medium leading-4">Recently deleted</span>
            {info.deleted.length ? (
              info.deleted.map((x) => <DeletedRow key={x.id} item={x} busy={busy} act={(body) => void send(body)} />)
            ) : (
              <span className={`${sub} pt-1`}>Nothing deleted lately.</span>
            )}
          </div>
        )}
      </div>

      {error && <span className="text-[12px] leading-4 text-[#B42318]">{error}</span>}
      <span className={sub}>
        Not covered yet: Honcho keeps what it learned from chats and calls until you forget it in Knowledge. OpenAI keeps answers to chats and tasks 30 days. Start over keeps a copy of your chats in Bops Cloud.
      </span>
    </div>
  );
}
