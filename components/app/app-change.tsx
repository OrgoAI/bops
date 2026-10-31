"use client";

import { useContext, useState } from "react";
import type { AppRestoreConfirm } from "@/lib/hosted-apps";
import type { AppState, Message } from "@/lib/types";
import { openAtHistory } from "./app-envs";
import { act, OpenHostedApp, short } from "./hosted-apps";
import { undash } from "./side-group";
import { AskInPlace } from "./ui";

/*
 * The card Bops posts in a bot's chat once a task on an app on the web changed it (lib/server/hosted-apps.ts
 * changeCardAfterTask, Message.appChange), in place of the line an older Bops shows: the app, the first line of the
 * bot's newest changeset and its short id, how many changesets that is in all and whose; View changes (the app's tab,
 * at its History); and Restore to before this change, which asks first, in place, with every change after it that
 * restoring also undoes and who made it (GET /api/hosted-apps/[name]?restore=), then puts the whole app back as it
 * was as a new change (POST restore: nothing is lost from its history), and the card says Restored. The owner's
 * alone: the chat shows it only where their own apps are (appsOwnShown), never in a workspace someone shared with
 * them, where Bops Cloud never sends it anyway.
 */

/** What restoring app `app` to changeset `to` undoes, for its question (AppRestoreConfirm), or why it couldn't be read. */
export async function readRestore(ws: string, app: string, to: string): Promise<AppRestoreConfirm | { error: string }> {
  const r = await fetch(`/api/hosted-apps/${encodeURIComponent(app)}?ws=${encodeURIComponent(ws)}&restore=${encodeURIComponent(to)}`, { cache: "no-store" }).catch(() => null);
  const body = (await r?.json().catch(() => null)) as (AppRestoreConfirm & { error?: string }) | null;
  if (!r?.ok || !body || !Array.isArray(body.later)) return { error: undash(body?.error || "Couldn't read what it would undo. Try again.") };
  return body;
}

/** "Boppy", "Boppy and Alex", "Boppy, Ivy and Alex". */
const names = (all: string[]) => (all.length < 2 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`);

/** How many later changes a list shows before "and N more". */
const SHOWN = 5;

export function AppChangeCard({ m, state }: { m: Message; state: AppState }) {
  const c = m.appChange!;
  const open = useContext(OpenHostedApp);
  // Restore's question, as the server read it; what's being done; and what came of it.
  const [asking, setAsking] = useState<AppRestoreConfirm | null>(null);
  const [busy, setBusy] = useState<"reading" | "restoring" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const restored = done || !!c.restored;
  // Restore is the owner's own, in their own workspace (a shared one never has the card: this holds whatever's missed).
  const canRestore = !state.shared && !!c.from && !restored;
  const ask = async () => {
    setBusy("reading");
    setError(null);
    setNote(null);
    const r = await readRestore(c.ws, c.app, c.from!);
    setBusy(null);
    if ("error" in r) setError(r.error);
    else if (r.blocked) setNote(undash(r.blocked));
    else setAsking(r);
  };
  const restore = async () => {
    setBusy("restoring");
    setError(null);
    const r = await act(c.app, { ws: c.ws, action: "restore", to: c.from! });
    setBusy(null);
    if (r.error) return setError(undash(r.error));
    setAsking(null);
    setDone(true);
    if (r.said) setNote(undash(r.said));
  };
  // The changes after this one that restoring also undoes (the server lists every one after `from`, this one's too).
  const later = asking ? asking.later : [];
  const mineAt = later.findIndex((x) => x.id === c.to);
  const others = mineAt >= 0 ? later.slice(0, mineAt) : later.filter((x) => x.id !== c.to);
  const button = "shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium leading-4 text-ink hover:bg-black/[0.05] disabled:opacity-40";
  return (
    <div data-app-change={c.app} className="flex w-[380px] max-w-full flex-col gap-1 self-start rounded-[14px] bg-[#F7F7F6] py-2 pl-3 pr-1.5 text-[12px] leading-4">
      <div className="flex min-w-0 items-center gap-1.5 pr-1.5">
        <span aria-hidden className="shrink-0 font-mono text-[10.5px] font-semibold text-[#9A9A98]">
          {"</>"}
        </span>
        <span className="min-w-0 truncate font-semibold text-ink">{c.app}</span>
        <span className="shrink-0 font-mono text-[11px] text-[#9A9A98]">{short(c.to)}</span>
        {restored && <span className="ml-auto shrink-0 font-medium text-[#9A9A98]">Restored</span>}
      </div>
      <span className={`pr-1.5 text-[13px] leading-[18px] [overflow-wrap:anywhere] ${restored ? "text-[#9A9A98] line-through" : "text-[#3A3A38]"}`}>{undash(c.title)}</span>
      <span className="truncate pr-1.5 text-[#6B6B6B]" title={c.authors.length ? `By ${names(c.authors)}` : undefined}>
        {c.count === 1 ? "1 change" : `${c.count} changes`}
        {c.authors.length ? ` by ${names(c.authors)}` : ""}
      </span>
      {asking ? (
        <div className="pr-1.5 pt-1">
          {/* Not red: it goes back as a new change, so nothing is lost (the Fix it panel's Go back asks the same way). */}
          <AskInPlace
            compact
            title={`Put ${c.app} back as it was before this change?`}
            line={
              others.length
                ? `This also undoes ${others.length === 1 ? "1 later change" : `${others.length} later changes`}:`
                : "It goes back as a new change, so nothing is lost from its history."
            }
            action="Restore"
            busy={busy === "restoring"}
            error={error}
            onConfirm={() => void restore()}
            onCancel={() => {
              setAsking(null);
              setError(null);
            }}
          >
            {!!others.length && (
              <ul data-restore-later className="flex flex-col gap-0.5 text-[12px] leading-4 text-[#3A3A38]">
                {others.slice(0, SHOWN).map((x) => (
                  <li key={x.id} className="flex min-w-0 gap-1.5">
                    <span className="shrink-0 font-mono text-[11px] text-[#9A9A98]">{short(x.id)}</span>
                    <span className="min-w-0 truncate">
                      {undash(x.title) || "A change"}
                      {x.author ? <span className="text-[#9A9A98]"> · {x.author}</span> : null}
                    </span>
                  </li>
                ))}
                {others.length > SHOWN && <li className="text-[#9A9A98]">and {others.length - SHOWN} more</li>}
              </ul>
            )}
          </AskInPlace>
        </div>
      ) : (
        // (Pulled left by its buttons' own padding, so their words line up with the lines above.)
        <div className="-ml-2 flex flex-wrap items-center gap-0.5 pt-0.5">
          {open && (
            <button
              onClick={() => {
                openAtHistory(c.app);
                open(c.ws, c.app);
              }}
              className={button}
            >
              View changes
            </button>
          )}
          {canRestore && (
            <button disabled={busy !== null} onClick={() => void ask()} className={button}>
              {busy === "reading" ? "Checking…" : "Restore to before this change"}
            </button>
          )}
        </div>
      )}
      {!asking && error && (
        <span role="alert" className="pr-1.5 text-[#B42318]">
          {error}
        </span>
      )}
      {note && (
        <span role="status" className="pr-1.5 text-[#6B6B6B]">
          {note}
        </span>
      )}
    </div>
  );
}
