"use client";

import { useRef, useState } from "react";
import { fixMessage, restorePlanOf, type FixAsk, type LaterChange } from "@/lib/app-preview";
import type { LocalAnswer } from "@/lib/hosted-apps";
import { ago } from "@/lib/screens";
import { short } from "./hosted-apps";
import { undash } from "./side-group";
import { AskInPlace, post } from "./ui";

/*
 * Fix it, on the Preview tab (preview-tab.tsx), when the site's Local stopped by itself or its page answered 5xx: a
 * panel over the page, never a dialog: what stopped, the last lines of its log, and Fix it, which asks the bot in
 * its chat in the owner's own words (so they see exactly what was asked), tagged appNote, then counts the press on
 * its computer (POST …/local { action: "fix" }). One press, one ask: it says Asking… and can't be pressed again
 * until that ask is in (a double click asks once). After two presses with no good run between (lib/app-preview.ts
 * goBackTo), it leads with going back to the version that last ran well, which first says what that undoes (GET
 * /api/hosted-apps/[name]?restore=), then puts it back as a new change on top (POST { action: "restore", to }).
 * Fix it and going back are the owner's only. A Bops without those routes yet says so in plain words.
 */

const DARK = "whitespace-nowrap rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]";
const LIGHT = "whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6] disabled:text-[#9A9A98]";
const QUIET = "whitespace-nowrap rounded-full px-2.5 py-1.5 text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:bg-[#F2F2F0] disabled:opacity-40";

/** What a Bops without a route says (it isn't in this version yet). */
const NOT_HERE = "Going back isn't in this version of Bops yet.";
const missing = (status?: number) => status === 404 || status === 405;
/** When, from a time a computer said (its seconds, or milliseconds). */
const msOf = (when: number) => (when < 1e12 ? when * 1000 : when);

export function FixPanel({
  ws,
  name,
  site,
  copy,
  ask,
  back,
  own,
  bot,
  onLocal,
  onStart,
  starting,
  onHide,
}: {
  ws: string;
  name: string;
  /** The site it's about (none: the app's own). */
  site?: string;
  /** The bot whose copy of the app its Local is (none: the app's own folder's): the press is counted there. */
  copy?: string;
  ask: FixAsk;
  /** The version it last ran well on, offered first after two Fix it presses (goBackTo); null before that. */
  back: { at: string; when: number } | null;
  /** The owner's own workspace: Fix it and going back are theirs only. */
  own: boolean;
  /** Its bot, whose chat Fix it asks in (none: it has none to ask). */
  bot?: { name: string; chatId: string };
  /** Its Local as an act answered it (the press counted). */
  onLocal: (a: LocalAnswer) => void;
  /** Start again, for a Local that stopped. */
  onStart?: () => void;
  starting?: boolean;
  /** Hide it (a page that answered 5xx: the page itself is still worth reading). */
  onHide?: () => void;
}) {
  const [busy, setBusy] = useState<"fix" | "read" | "back" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Going back, asked in place: what it undoes (read first), or why it can't now.
  const [plan, setPlan] = useState<{ later: LaterChange[]; blocked?: string } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const at = `/api/hosted-apps/${encodeURIComponent(name)}`;
  // Asking now: a second press before the window shows it (a double click) is the same press.
  const asking = useRef(false);

  const fix = async () => {
    if (!bot || asking.current) return;
    asking.current = true;
    setBusy("fix");
    setError(null);
    setSaid(null);
    const r = await post(`/api/chats/${encodeURIComponent(bot.chatId)}/messages`, { text: fixMessage(ask), appNote: true }).catch(() => null);
    if (!r?.ok) {
      asking.current = false;
      setBusy(null);
      return setError(`Couldn't ask ${bot.name}. Try again.`);
    }
    // Counted on its computer, for the loop breaker. (A Bops that doesn't count them yet answers 400 or 404: asked all the same.)
    const c = await post(`${at}/local`, { ws, action: "fix", ...(site ? { site } : {}), ...(copy ? { bot: copy } : {}) }).catch(() => null);
    const j = c?.ok ? ((await c.json().catch(() => null)) as LocalAnswer | null) : null;
    if (j?.sites) onLocal(j);
    asking.current = false;
    setBusy(null);
    setSaid(`Asked ${bot.name} to fix it.`);
  };

  const readBack = async () => {
    if (!back) return;
    setBusy("read");
    setError(null);
    setPlanError(null);
    const r = await fetch(`${at}?ws=${encodeURIComponent(ws)}&restore=${encodeURIComponent(back.at)}`, { cache: "no-store" }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { error?: string } | null;
    setBusy(null);
    if (!r || missing(r.status)) return setError(r ? NOT_HERE : "Couldn't reach Bops. Try again.");
    const p = r.ok ? restorePlanOf(j) : null;
    if (!p) return setError(undash(j?.error || "Couldn't read what going back undoes. Try again."));
    setPlan(p);
  };

  const goBack = async () => {
    if (!back) return;
    setBusy("back");
    setPlanError(null);
    const r = await post(at, { ws, action: "restore", to: back.at }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { error?: string } | null;
    setBusy(null);
    if (!r?.ok) return setPlanError(r && missing(r.status) ? NOT_HERE : undash(j?.error || "Couldn't go back. Try again."));
    setPlan(null);
    setSaid(`Went back to ${short(back.at)}. Its Local picks it up.`);
    // A Local that had stopped starts again on it.
    onStart?.();
  };

  const n = plan?.later.length ?? 0;
  return (
    <div data-preview-fix={ask.lines.length ? "lines" : "plain"} className="flex w-full max-w-[520px] flex-col gap-2.5 rounded-2xl bg-white px-4 py-3.5 text-left shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_-16px_#0000004D]">
      <span data-preview-fix-title className="text-[13.5px] font-semibold leading-5 text-ink">
        {ask.title}
      </span>
      {ask.lines.length > 0 && (
        <pre data-preview-fix-lines className="max-h-[132px] overflow-auto whitespace-pre rounded-lg bg-[#F7F7F6] px-3 py-2 font-mono text-[11.5px] leading-[17px] text-[#3A3A38]">
          {ask.lines.join("\n")}
        </pre>
      )}
      {plan && back ? (
        plan.blocked ? (
          <div className="flex flex-wrap items-center gap-2">
            <span role="alert" className="min-w-0 flex-1 text-[12.5px] leading-[17px] text-[#3A3A38]">
              {undash(plan.blocked)}
            </span>
            <button onClick={() => setPlan(null)} className={QUIET}>
              OK
            </button>
          </div>
        ) : (
          <AskInPlace
            compact
            title={`Go back to ${short(back.at)}?`}
            line={n ? `This also undoes ${n} later change${n === 1 ? "" : "s"}:` : "Its files go back as they were then, as a new change on top. Nothing is lost."}
            action="Go back"
            busy={busy === "back"}
            error={planError}
            onConfirm={() => void goBack()}
            onCancel={() => setPlan(null)}
          >
            {n > 0 && (
              <ul data-preview-undoes className="flex flex-col gap-0.5">
                {/* As a change card lists what restoring undoes (app-change.tsx): its short id, its line, who. */}
                {plan.later.slice(0, 5).map((c) => (
                  <li key={c.id} className="flex min-w-0 gap-1.5 text-[12px] leading-4 text-[#3A3A38]">
                    <span className="shrink-0 font-mono text-[11px] text-[#9A9A98]">{short(c.id)}</span>
                    <span className="min-w-0 truncate">
                      {undash(c.title) || "A change"}
                      {c.author ? <span className="text-[#9A9A98]"> · {c.author}</span> : null}
                    </span>
                  </li>
                ))}
                {n > 5 && <li className="text-[12px] leading-4 text-[#9A9A98]">and {n - 5} more</li>}
              </ul>
            )}
          </AskInPlace>
        )
      ) : (
        <>
          {/* The loop breaker: when it last worked, in its own line, so the button stays short enough for a narrow panel. */}
          {own && back && (
            <span data-preview-worked className="text-[12.5px] leading-[17px] text-[#3A3A38]">
              {`It last worked ${ago(msOf(back.when))}, at ${short(back.at)}.`}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {own && back && (
              <button data-preview-back disabled={!!busy} onClick={() => void readBack()} className={DARK}>
                {busy === "read" ? "Checking…" : "Go back to the version that worked"}
              </button>
            )}
            {own && (
              <span data-tip={bot ? undefined : "Its bot has no chat to ask in."} className="flex">
                <button data-preview-fixit disabled={!bot || !!busy} onClick={() => void fix()} className={back ? LIGHT : DARK}>
                  {busy === "fix" ? "Asking…" : back ? "Try fixing again" : "Fix it"}
                </button>
              </span>
            )}
            {onStart && (
              <button data-preview-start disabled={starting || !!busy} onClick={onStart} className={own ? QUIET : DARK}>
                {starting ? "Starting…" : "Start again"}
              </button>
            )}
            {onHide && (
              <button onClick={onHide} className={QUIET}>
                Hide
              </button>
            )}
          </div>
        </>
      )}
      {said && (
        <span role="status" className="text-[12px] leading-4 text-[#6B6B6B]">
          {said}
        </span>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}
