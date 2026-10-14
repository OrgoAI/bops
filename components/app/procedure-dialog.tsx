"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_PROCEDURE_CHARS, PROCEDURE_NAME_MAX, PROCEDURE_WHEN_MAX } from "@/lib/types";
import { Spinner } from "./mascot";
import { post } from "./ui";

/*
 * "Save as procedure", from a chat's menu (or a thread's): the bot rereads the chat and the threads
 * it started (or just that thread) and drafts how it does this kind of job (lib/server/procedures.ts
 * draftProcedure). The user edits the draft and saves it, or cancels. When the bot already has a
 * procedure for the same kind of job, saving updates that one: the dialog says so, and shows what it
 * says now. Once the user has changed the draft, a click outside doesn't throw it away (Cancel does),
 * and Escape in a field just leaves the field.
 */

type Draft = { name: string; whenToUse: string; steps: string; pitfalls: string; updates?: string };
type Drafted = { draft?: Draft; updating?: string; was?: { steps: string; pitfalls: string }; from?: { chatId: string; sessionIds?: string[] }; error?: string };

/**
 * Drafts asked for and not answered yet, by what they're for: a dialog mounted twice (React's dev
 * Strict Mode) waits on the same one, so the model is asked once. Gone once it answers, so opening
 * the dialog again later drafts afresh.
 */
const drafting = new Map<string, Promise<Drafted>>();
function draftOnce(key: string, body: { botId: string; chatId: string; sessionId?: string }): Promise<Drafted> {
  let asked = drafting.get(key);
  if (!asked) {
    asked = fetch("/api/procedures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "draft", ...body }) })
      .then(async (res) => {
        const json = ((await res.json().catch(() => null)) as Drafted | null) ?? {};
        return res.ok && json.draft ? json : { error: json.error ?? "Couldn't write a draft. Try again." };
      })
      .catch(() => ({ error: "Couldn't reach Bops. Try again." }));
    drafting.set(key, asked);
    void asked.finally(() => drafting.delete(key));
  }
  return asked;
}

const FIELD = "w-full bg-[#F7F7F6] text-[13px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]";
const INPUT = `${FIELD} h-8 rounded-full px-3`;
const AREA = `${FIELD} resize-none rounded-[12px] px-3 py-1.5 leading-[18px]`;
const LABEL = "flex flex-col gap-1";
const LABEL_TEXT = "text-[12px] font-medium leading-4 text-[#6B6B6B]";
const PILL = "rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-4 disabled:opacity-50";

/** "Save as procedure", over everything: reads the chat, then the draft to edit, Save and Cancel. */
export function SaveProcedureDialog({ botId, chatId, sessionId, onClose }: { botId: string; chatId: string; sessionId?: string; onClose: () => void }) {
  // Each try at a draft (Try again asks for a new one).
  const [attempt, setAttempt] = useState(0);
  const [fields, setFields] = useState<Draft | null>(null);
  const [updating, setUpdating] = useState<string | undefined>();
  const [was, setWas] = useState<Drafted["was"]>();
  const [from, setFrom] = useState<Drafted["from"]>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // The user changed the draft: a stray click outside, or Escape in a field, doesn't throw that away.
  const [edited, setEdited] = useState(false);
  // Whether the press that ends in a click started on the scrim (a text selection that ends past the card doesn't).
  const downOnScrim = useRef(false);

  useEffect(() => {
    let gone = false;
    void draftOnce(`${botId}:${chatId}:${sessionId ?? ""}:${attempt}`, { botId, chatId, sessionId }).then((r) => {
      if (gone) return;
      if (r.draft) {
        setFields({ name: r.draft.name, whenToUse: r.draft.whenToUse, steps: r.draft.steps, pitfalls: r.draft.pitfalls, updates: r.draft.updates });
        setUpdating(r.updating);
        setWas(r.was);
        setFrom(r.from);
      } else setError(r.error ?? "Couldn't write a draft. Try again.");
    });
    return () => {
      gone = true;
    };
  }, [botId, chatId, sessionId, attempt]);

  // Escape closes this alone, not the chat or sheet under it (the app closes its sheets on Escape, on window).
  // With changes made, Escape in a field leaves the field; Cancel (or Escape outside the fields) closes.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ? e.target : null;
      if (edited && field) return field.blur();
      if (!busy) onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, edited, onClose]);

  // "Saved" for a moment, then it closes.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(onClose, 700);
    return () => clearTimeout(t);
  }, [saved, onClose]);

  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };
  const set = (k: keyof Omit<Draft, "updates">) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setFields((f) => (f ? { ...f, [k]: value } : f));
    setEdited(true);
  };
  const size = fields ? fields.name.length + fields.whenToUse.length + fields.steps.length + fields.pitfalls.length : 0;
  const tooLong = size > MAX_PROCEDURE_CHARS;
  const ready = !!fields && !!fields.name.trim() && !!fields.whenToUse.trim() && !!fields.steps.trim() && !tooLong;

  const save = async () => {
    if (!fields || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/procedures", { action: "save", botId, draft: fields, from });
      const json = ((await res.json().catch(() => null)) as { error?: string } | null) ?? {};
      if (!res.ok || json.error) {
        setError(json.error ?? "Couldn't save it. Try again.");
        setBusy(false);
        return;
      }
      setSaved(true);
    } catch {
      setError("Couldn't reach Bops. Try again.");
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="motion-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-black/20 p-6 backdrop-blur-[2px]"
      onMouseDown={(e) => (downOnScrim.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (downOnScrim.current && e.target === e.currentTarget && !busy && !edited) onClose();
        downOnScrim.current = false;
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="procedure-title"
        aria-describedby="procedure-line"
        aria-busy={!fields && !error}
        onClick={(e) => e.stopPropagation()}
        className="motion-dialog-in flex max-h-full w-[520px] max-w-full flex-col overflow-hidden rounded-[18px] bg-white shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <div className="flex flex-col px-5 pt-5">
          <span id="procedure-title" className="text-[15px] font-semibold leading-5">
            Save as procedure
          </span>
          <span id="procedure-line" className="pt-1 text-[13px] leading-[18px] text-[#6B6B6B]">
            How your bot does this kind of job. It reads it the next time a job like this comes up.
          </span>
        </div>

        {fields ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pt-4">
            {fields.updates && updating && <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">This updates &ldquo;{updating}&rdquo;.</span>}
            {fields.updates && updating && was && (
              <details className="rounded-[12px] bg-[#F7F7F6] px-3 py-2 text-[12.5px] leading-[18px] text-[#3A3A38]">
                <summary className="cursor-pointer text-[12px] font-medium text-[#6B6B6B]">What it says now</summary>
                <div className="whitespace-pre-wrap pt-1.5">{was.steps}</div>
                {was.pitfalls.trim() && <div className="whitespace-pre-wrap pt-1.5 text-[#6B6B6B]">Pitfalls: {was.pitfalls}</div>}
              </details>
            )}
            <label className={LABEL}>
              <span className={LABEL_TEXT}>Name</span>
              <input autoFocus value={fields.name} onChange={set("name")} maxLength={PROCEDURE_NAME_MAX} placeholder="Weekly invoice summary" className={INPUT} />
            </label>
            <label className={LABEL}>
              <span className={LABEL_TEXT}>When to use it</span>
              <input value={fields.whenToUse} onChange={set("whenToUse")} maxLength={PROCEDURE_WHEN_MAX} placeholder="When you ask for a summary of the week's invoices" className={INPUT} />
            </label>
            <label className={LABEL}>
              <span className={LABEL_TEXT}>Steps</span>
              <textarea value={fields.steps} onChange={set("steps")} rows={9} placeholder="1. Open the invoices folder" className={AREA} />
            </label>
            <label className={LABEL}>
              <span className={LABEL_TEXT}>Pitfalls</span>
              <textarea value={fields.pitfalls} onChange={set("pitfalls")} rows={4} placeholder="What to watch out for. Optional." className={AREA} />
            </label>
            {size > MAX_PROCEDURE_CHARS * 0.9 && (
              <span className={`text-[12px] leading-4 ${tooLong ? "text-[#B42318]" : "text-[#9A9A98]"}`}>
                {size} of {MAX_PROCEDURE_CHARS} characters{tooLong ? ". Make it shorter to save it." : ""}
              </span>
            )}
          </div>
        ) : error ? null : (
          <div role="status" className="flex items-center gap-2 px-5 py-8 text-[13px] leading-[18px] text-[#6B6B6B]">
            <Spinner size={12} color="#6B6B6B" />
            Reading the chat…
          </div>
        )}

        {error && (
          <span role="alert" className="px-5 pt-3 text-[12.5px] leading-[18px] text-[#B42318]">
            {error}
          </span>
        )}

        <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-5">
          <button disabled={busy} onClick={onClose} className={`${PILL} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
            Cancel
          </button>
          {!fields && error ? (
            <button autoFocus onClick={retry} className={`${PILL} bg-ink text-white`}>
              Try again
            </button>
          ) : (
            <button disabled={!saved && (!ready || busy)} onClick={() => void save()}className={`${PILL} flex min-w-[76px] items-center justify-center bg-ink text-white`}>
              {saved ? "Saved" : busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
