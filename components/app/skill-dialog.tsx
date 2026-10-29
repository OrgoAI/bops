"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Spinner } from "./mascot";
import { post } from "./ui";
import { BRAND } from "@/lib/brand";

/*
 * "Save as skill", from a chat's menu (or a thread's): the bot rereads the chat and the threads it started
 * (or just that thread) and drafts a skill in the SKILL.md shape (lib/server/procedures.ts draftSkill): a
 * name, a description with the user's own words, the SKILL.md text, and scripts for commands it ran (dry
 * run unless given --apply). The user edits it and saves it as a draft, publishes it, or cancels. When the
 * workspace already has a skill for the same kind of job, saving updates that one: the dialog says so. Once
 * the user has changed the draft, a click outside doesn't throw it away (Cancel does), and Escape in a field
 * just leaves the field.
 */

type DraftFile = { path: string; content: string; executable: boolean };
type Draft = { name: string; description: string; body: string; files: DraftFile[]; updates?: string };
type Drafted = { draft?: Draft; updating?: string; from?: { chatId: string; sessionIds?: string[] }; error?: string };
type Problem = { path: string; reason: string; line?: number };

/** The longest a name and a description can be (lib/server/workspace-skills.ts). */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 1024;

/**
 * Drafts asked for and not answered yet, by what they're for: a dialog mounted twice (React's dev
 * Strict Mode) waits on the same one, so the model is asked once. Gone once it answers, so opening
 * the dialog again later drafts afresh.
 */
const drafting = new Map<string, Promise<Drafted>>();
function draftOnce(key: string, body: { botId: string; chatId: string; sessionId?: string }): Promise<Drafted> {
  let asked = drafting.get(key);
  if (!asked) {
    asked = post("/api/skills", { action: "draft", ...body })
      .then(async (res) => {
        const json = ((await res.json().catch(() => null)) as Drafted | null) ?? {};
        return res.ok && json.draft ? json : { error: json.error ?? "Couldn't write a draft. Try again." };
      })
      .catch(() => ({ error: `Couldn't reach ${BRAND.name}. Try again.` }));
    drafting.set(key, asked);
    void asked.finally(() => drafting.delete(key));
  }
  return asked;
}

const FIELD = "w-full bg-[color:var(--c-f7f7f6)] text-[13px] outline-none shadow-[0_0_0_1px_var(--c-e6e6e3)] focus:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]";
const INPUT = `${FIELD} h-8 rounded-full px-3`;
const AREA = `${FIELD} resize-none rounded-[12px] px-3 py-1.5 leading-[18px]`;
const LABEL = "flex flex-col gap-1";
const LABEL_TEXT = "text-[12px] font-medium leading-4 text-[color:var(--c-6b6b6b)]";
const PILL = "rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-4 disabled:opacity-50";

/** "Save as skill", over everything: reads the chat, then the draft to edit, Save draft, Publish and Cancel. */
export function SaveSkillDialog({ botId, chatId, sessionId, onClose }: { botId: string; chatId: string; sessionId?: string; onClose: () => void }) {
  // Each try at a draft (Try again asks for a new one).
  const [attempt, setAttempt] = useState(0);
  const [fields, setFields] = useState<Draft | null>(null);
  const [updating, setUpdating] = useState<string | undefined>();
  const [from, setFrom] = useState<Drafted["from"]>();
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState<"draft" | "publish" | null>(null);
  const [saved, setSaved] = useState<"draft" | "publish" | null>(null);
  // The user changed the draft: a stray click outside, or Escape in a field, doesn't throw that away.
  const [edited, setEdited] = useState(false);
  // Whether the press that ends in a click started on the scrim (a text selection that ends past the card doesn't).
  const downOnScrim = useRef(false);

  useEffect(() => {
    let gone = false;
    void draftOnce(`${botId}:${chatId}:${sessionId ?? ""}:${attempt}`, { botId, chatId, sessionId }).then((r) => {
      if (gone) return;
      if (r.draft) {
        setFields({ name: r.draft.name, description: r.draft.description, body: r.draft.body, files: r.draft.files ?? [], updates: r.draft.updates });
        setUpdating(r.updating);
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
  const set = (k: "name" | "description" | "body") => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setFields((f) => (f ? { ...f, [k]: value } : f));
    setEdited(true);
  };
  const ready = !!fields && !!fields.name.trim() && !!fields.description.trim() && !!fields.body.trim();

  const save = async (how: "draft" | "publish") => {
    if (!fields || busy) return;
    setBusy(how);
    setError(null);
    setProblems([]);
    try {
      const res = await post("/api/skills", { action: "save-draft", botId, draft: fields, from, publish: how === "publish" });
      const json = ((await res.json().catch(() => null)) as { error?: string; problems?: Problem[] } | null) ?? {};
      if (!res.ok || json.error) {
        setError(json.error ?? "Couldn't save it. Try again.");
        setProblems(json.problems ?? []);
        setBusy(null);
        return;
      }
      setSaved(how);
    } catch {
      setError(`Couldn't reach ${BRAND.name}. Try again.`);
      setBusy(null);
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
        aria-labelledby="skill-title"
        aria-describedby="skill-line"
        aria-busy={!fields && !error}
        onClick={(e) => e.stopPropagation()}
        className="motion-dialog-in flex max-h-full w-[520px] max-w-full flex-col overflow-hidden rounded-[18px] bg-white shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <div className="flex flex-col px-5 pt-5">
          <span id="skill-title" className="text-[15px] font-semibold leading-5">
            Save as skill
          </span>
          <span id="skill-line" className="pt-1 text-[13px] leading-[18px] text-[color:var(--c-6b6b6b)]">
            How this workspace does this kind of job. Once published, your bot reads it the next time a job like this comes up.
          </span>
        </div>

        {fields ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pt-4">
            {fields.updates && updating && <span className="text-[12.5px] leading-[18px] text-[color:var(--c-3a3a38)]">This updates &ldquo;{updating}&rdquo;.</span>}
            <label className={LABEL}>
              <span className={LABEL_TEXT}>Name</span>
              <input autoFocus value={fields.name} onChange={set("name")} maxLength={NAME_MAX} placeholder="Weekly invoice summary" className={INPUT} />
            </label>
            <label className={LABEL}>
              <span className={LABEL_TEXT}>What it does and when to use it</span>
              <textarea value={fields.description} onChange={set("description")} maxLength={DESCRIPTION_MAX} rows={2} placeholder="Sums up the week's invoices when you ask for &ldquo;the weekly invoice summary&rdquo;" className={AREA} />
            </label>
            <label className={LABEL}>
              <span className={LABEL_TEXT}>SKILL.md</span>
              <textarea value={fields.body} onChange={set("body")} rows={12} className={`${AREA} font-mono text-[12px]`} />
            </label>
            {fields.files.length > 0 && (
              <div className={LABEL}>
                <span className={LABEL_TEXT}>Files</span>
                {fields.files.map((f) => (
                  <details key={f.path} className="rounded-[12px] bg-[color:var(--c-f7f7f6)] px-3 py-2 text-[12px] leading-[17px] text-[color:var(--c-3a3a38)]">
                    <summary className="font-mono">{f.path}</summary>
                    <pre className="whitespace-pre-wrap pt-1.5 font-mono text-[11.5px]">{f.content}</pre>
                  </details>
                ))}
                <span className="text-[12px] leading-4 text-[color:var(--c-9a9a98)]">Scripts only say what they&apos;d do until run with --apply, and run once you approve them in Skills, in Knowledge.</span>
              </div>
            )}
          </div>
        ) : error ? null : (
          <div role="status" className="flex items-center gap-2 px-5 py-8 text-[13px] leading-[18px] text-[color:var(--c-6b6b6b)]">
            <Spinner size={12} color="#6B6B6B" />
            Reading the chat…
          </div>
        )}

        {error && (
          <span role="alert" className="flex flex-col gap-0.5 px-5 pt-3 text-[12.5px] leading-[18px] text-[#B42318]">
            {error}
            {problems.map((p, i) => (
              <span key={i} className="text-[12px] text-[color:var(--c-6b6b6b)]">
                <span className="font-mono">{p.path}{p.line ? `:${p.line}` : ""}</span> {p.reason}
              </span>
            ))}
          </span>
        )}

        <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-5">
          <button disabled={!!busy} onClick={onClose} className={`${PILL} bg-[color:var(--c-f2f2f0)] hover:bg-[color:var(--c-eaeae7)]`}>
            Cancel
          </button>
          {!fields && error ? (
            <button autoFocus onClick={retry} className={`${PILL} bg-ink text-white`}>
              Try again
            </button>
          ) : (
            <>
              <button disabled={!saved && (!ready || !!busy)} onClick={() => void save("draft")} className={`${PILL} bg-[color:var(--c-f2f2f0)] hover:bg-[color:var(--c-eaeae7)]`}>
                {saved === "draft" ? "Saved" : busy === "draft" ? "Saving…" : "Save draft"}
              </button>
              <button disabled={!saved && (!ready || !!busy)} onClick={() => void save("publish")} className={`${PILL} flex min-w-[76px] items-center justify-center bg-ink text-white`}>
                {saved === "publish" ? "Published" : busy === "publish" ? "Publishing…" : "Publish"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
