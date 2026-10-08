"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppState, MemoryGroup } from "@/lib/types";
import { currentWorkspace, post } from "./ui";

type Info = {
  on: boolean;
  bank: string;
  own: boolean;
  sharedWith: { id: string; name: string }[];
  card: { text: string; private: boolean }[];
  review: ReviewSummary | null;
};
type ReviewSummary = {
  at: number;
  running: boolean;
  error?: string;
  total?: number;
  checked: number;
  flagged: number;
  deleting?: { group: MemoryGroup; done: number; total: number };
  groups: { key: MemoryGroup; count: number; items: { id: string; text: string }[] }[];
};
type Preview = { personal: number; work: number; skipped: number; examples: { personal: string[]; work: string[] } };

/**
 * A workspace's memory: where it comes from (its own, or shared with another workspace), copying
 * what another workspace knows about the user (personal, work, or both), what's on their card, and a
 * check for facts that were learned wrong.
 */
export function MemorySheet({ state, onClose }: { state: AppState; onClose: () => void }) {
  const ws = currentWorkspace(state);
  const here = state.workspaces?.find((w) => w.id === ws);
  const others = (state.workspaces ?? []).filter((w) => w.id !== ws);
  const [info, setInfo] = useState<Info | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let gone = false;
    void fetch(`/api/memory?ws=${encodeURIComponent(ws)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Info) => !gone && setInfo(j))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [ws, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Esc closes the sheet, and only the sheet: the profile behind it stays (it sees the dialog, and preventDefault).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center bg-black/10 p-6 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Memory"
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000066]"
      >
        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0]">
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <div className="px-6 pb-3 pt-5">
          <div className="text-[18px] font-semibold leading-6 tracking-[-0.01em]">Memory</div>
          <div className="pt-0.5 text-[13px] leading-5 text-[#6B6B6B]">What {here?.name ?? "this workspace"}&rsquo;s bots know about you. They add to it as you talk.</div>
        </div>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pb-6">
          {!info ? (
            <div className="py-6 text-center text-[13px] text-[#9A9A98]">Loading…</div>
          ) : !info.on ? (
            <div className="py-6 text-center text-[13px] text-[#9A9A98]">Memory isn&rsquo;t on yet.</div>
          ) : (
            <>
              <Source ws={ws} info={info} others={others} onChange={reload} />
              {others.length > 0 && <Copy ws={ws} info={info} others={others} />}
              <Review ws={ws} review={info.review} onChange={reload} />
              <Card info={info} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const SECTION = "text-[12px] font-medium uppercase tracking-[0.04em] text-[#9A9A98]";
const BUTTON = "h-8 shrink-0 rounded-full bg-[#0A0A0A] px-3.5 text-[13px] font-medium text-white hover:bg-[#2A2A2A] disabled:opacity-40";
const QUIET = "h-8 shrink-0 rounded-full bg-white px-3.5 text-[13px] font-medium shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6] disabled:opacity-40";

/** Its own memory, or another workspace's (both read and add to the same one). */
function Source({ ws, info, others, onChange }: { ws: string; info: Info; others: { id: string; name: string }[]; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = (from: string | null) => {
    setBusy(true);
    void post("/api/memory", from ? { action: "share", ws, from } : { action: "own", ws }).finally(() => {
      setBusy(false);
      onChange();
    });
  };
  const sharing = info.own ? null : others.find((o) => info.sharedWith.some((s) => s.id === o.id));
  return (
    <section className="flex flex-col gap-2">
      <div className={SECTION}>Where it lives</div>
      <div className="flex flex-col gap-1 rounded-[14px] bg-[#F7F7F6] p-1">
        <Choice on={info.own} disabled={busy} onClick={() => !info.own && set(null)} title="Its own memory" detail={info.own && info.sharedWith.length ? `Also used by ${info.sharedWith.map((s) => s.name).join(", ")}` : info.bank.startsWith("bops-") ? "Starts empty, learns as you go" : `Your ${info.bank} memory, shared with your other agents`} />
        {others.map((o) => (
          <Choice key={o.id} on={sharing?.id === o.id} disabled={busy} onClick={() => sharing?.id !== o.id && set(o.id)} title={`Share with ${o.name}`} detail="Both workspaces read and add to one memory" />
        ))}
      </div>
    </section>
  );
}

function Choice({ on, disabled, onClick, title, detail }: { on: boolean; disabled?: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button disabled={disabled} onClick={onClick} className={`flex items-center gap-2.5 rounded-[11px] px-3 py-2 text-left ${on ? "bg-white shadow-[0_0_0_1px_#E6E6E3]" : "hover:bg-black/[0.03]"}`}>
      <span className={`flex size-4 shrink-0 items-center justify-center rounded-full ${on ? "bg-[#0A0A0A]" : "shadow-[inset_0_0_0_1.5px_#C9C9C6]"}`}>{on && <span className="size-1.5 rounded-full bg-white" />}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium leading-5">{title}</span>
        <span className="block text-[12px] leading-4 text-[#9A9A98]">{detail}</span>
      </span>
    </button>
  );
}

/** Copy, once, what another workspace knows about you: personal, work, or both (Jev sorts them). */
function Copy({ ws, info, others }: { ws: string; info: Info; others: { id: string; name: string }[] }) {
  const from = others.filter((o) => !info.sharedWith.some((s) => s.id === o.id));
  const [pick, setPick] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [kinds, setKinds] = useState<{ personal: boolean; work: boolean }>({ personal: true, work: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!from.length) return null;
  const look = async (id: string) => {
    setPick(id);
    setPreview(null);
    setDone(null);
    setError(null);
    setBusy("Sorting what it knows into personal and work…");
    const r = (await (await post("/api/memory", { action: "preview-copy", ws, from: id })).json()) as Preview & { error?: string };
    setBusy(null);
    if (r.error) setError(r.error);
    else setPreview(r);
  };
  const copy = async () => {
    setBusy("Copying…");
    const want = (["personal", "work"] as const).filter((k) => kinds[k]);
    const r = (await (await post("/api/memory", { action: "copy", ws, from: pick, kinds: want })).json()) as { card?: number; facts?: number; error?: string };
    setBusy(null);
    if (r.error) setError(r.error);
    else {
      setDone(`Copied ${(r.card ?? 0) + (r.facts ?? 0)} things it knew about you.`);
      setPreview(null);
    }
  };
  return (
    <section className="flex flex-col gap-2">
      <div className={SECTION}>Start with what another workspace knows</div>
      <div className="flex flex-wrap gap-1.5">
        {from.map((o) => (
          <button key={o.id} disabled={!!busy} onClick={() => void look(o.id)} className={`${QUIET} ${pick === o.id ? "shadow-[0_0_0_1.5px_#0A0A0A]" : ""}`}>
            From {o.name}
          </button>
        ))}
      </div>
      {busy && <div className="text-[13px] text-[#9A9A98]">{busy}</div>}
      {error && <div className="text-[13px] text-[#B42318]">{error}</div>}
      {done && <div className="text-[13px] text-[#1F7A3A]">{done}</div>}
      {preview && (
        <div className="flex flex-col gap-2 rounded-[14px] bg-[#F7F7F6] p-3">
          {(["personal", "work"] as const).map((k) => (
            <label key={k} className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" checked={kinds[k]} onChange={(e) => setKinds((x) => ({ ...x, [k]: e.target.checked }))} className="mt-0.5 size-4 accent-[#0A0A0A]" />
              <span className="min-w-0">
                <span className="block text-[14px] font-medium leading-5">
                  {k === "personal" ? "Personal" : "Work"} · {preview[k]}
                </span>
                <span className="block text-[12px] leading-4 text-[#9A9A98]">{preview.examples[k].slice(0, 3).join(" · ") || "Nothing"}</span>
              </span>
            </label>
          ))}
          {preview.skipped > 0 && <div className="text-[12px] text-[#9A9A98]">Leaves out {preview.skipped} that look learned wrong.</div>}
          <div className="flex justify-end pt-1">
            <button disabled={!!busy || (!kinds.personal && !kinds.work)} onClick={() => void copy()} className={BUTTON}>
              Copy {(kinds.personal ? preview.personal : 0) + (kinds.work ? preview.work : 0)}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const GROUPS: Record<MemoryGroup, { title: string; detail: string }> = {
  passing: { title: "Passing moments", detail: "What you asked once, steps in a task. Not worth keeping." },
  agent_rule: { title: "An agent's rules, not yours", detail: "How an agent was told to reply, taken for something about you." },
  someone_else: { title: "About someone else", detail: "Details of a sender or a customer, filed under you." },
  unsure: { title: "Less sure", detail: "Look at these one by one." },
};

/** Facts memory may have learned wrong, grouped. Groups Jev is sure of can go all at once (two taps). */
function Review({ ws, review, onChange }: { ws: string; review: ReviewSummary | null; onChange: () => void }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<MemoryGroup | null>(null);
  const [confirm, setConfirm] = useState<MemoryGroup | null>(null);
  const busy = !!review?.running || !!review?.deleting;
  // Fresh numbers while it reads or deletes.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(onChange, 1500);
    return () => clearInterval(t);
  }, [busy, onChange]);
  const settle = (id: string, action: "delete" | "keep") => {
    setGone((g) => new Set(g).add(id));
    void post("/api/memory", { action, ws, id });
  };
  const start = () => void post("/api/memory", { action: "review", ws }).then(onChange);
  const removeAll = (group: MemoryGroup) => {
    setConfirm(null);
    void post("/api/memory", { action: "delete-group", ws, group }).then(onChange);
  };
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className={SECTION}>Check for wrong facts</div>
        <button disabled={busy} onClick={start} className={QUIET}>
          {review?.running ? "Checking…" : review?.at ? "Check again" : "Check now"}
        </button>
      </div>
      {review?.running ? (
        <div className="text-[13px] text-[#9A9A98]">
          Read {review.checked.toLocaleString()}
          {review.total ? ` of ${review.total.toLocaleString()}` : ""} facts…
        </div>
      ) : review?.error ? (
        <div className="text-[13px] text-[#B42318]">{review.error}</div>
      ) : !review ? (
        <div className="text-[13px] text-[#9A9A98]">Finds facts that look learned wrong, so you can delete them.</div>
      ) : !review.groups.length ? (
        <div className="text-[13px] text-[#9A9A98]">Checked {review.checked.toLocaleString()} facts. Nothing left to look at.</div>
      ) : (
        <>
          <div className="text-[13px] text-[#6B6B6B]">
            {review.flagged.toLocaleString()} of {review.checked.toLocaleString()} facts look wrong.
            {review.deleting && ` Deleting ${GROUPS[review.deleting.group].title.toLowerCase()}: ${review.deleting.done.toLocaleString()} of ${review.deleting.total.toLocaleString()}…`}
          </div>
          <div className="flex flex-col divide-y divide-[#ECECEA] rounded-[14px] shadow-[0_0_0_1px_#ECECEA]">
            {review.groups.map((g) => {
              const items = g.items.filter((f) => !gone.has(f.id));
              const expanded = open === g.key;
              return (
                <div key={g.key} className="flex flex-col">
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <button onClick={() => setOpen(expanded ? null : g.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <svg width="10" height="10" viewBox="0 0 12 12" className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}>
                        <path d="M4.5 3l3 3-3 3" fill="none" stroke="#9A9A98" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium leading-5">
                          {GROUPS[g.key].title} <span className="font-normal text-[#9A9A98]">· {g.count.toLocaleString()}</span>
                        </span>
                        <span className="block text-[12px] leading-4 text-[#9A9A98]">{GROUPS[g.key].detail}</span>
                      </span>
                    </button>
                    {g.key !== "unsure" &&
                      (confirm === g.key ? (
                        <button onClick={() => removeAll(g.key)} className="h-7 shrink-0 rounded-full bg-[#B42318] px-2.5 text-[12px] font-medium text-white">
                          Delete {g.count.toLocaleString()}?
                        </button>
                      ) : (
                        <button disabled={busy} onClick={() => setConfirm(g.key)} className="h-7 shrink-0 rounded-full bg-[#F7F7F6] px-2.5 text-[12px] font-medium text-[#B42318] hover:bg-[#FBEAEA] disabled:opacity-40">
                          Delete all
                        </button>
                      ))}
                  </div>
                  {expanded && (
                    <div className="flex flex-col pb-1">
                      {items.map((f) => (
                        <div key={f.id} className="flex items-center gap-2 py-1.5 pl-[30px] pr-3">
                          <div className="min-w-0 flex-1 text-[13px] leading-[18px] [overflow-wrap:anywhere]">{f.text}</div>
                          <button onClick={() => settle(f.id, "keep")} className="h-7 shrink-0 rounded-full px-2.5 text-[12px] font-medium text-[#6B6B6B] hover:bg-[#F2F2F0]">
                            Keep
                          </button>
                          <button onClick={() => settle(f.id, "delete")} className="h-7 shrink-0 rounded-full px-2.5 text-[12px] font-medium text-[#B42318] hover:bg-[#FBEAEA]">
                            Delete
                          </button>
                        </div>
                      ))}
                      {g.count > g.items.length && <div className="py-1.5 pl-[30px] text-[12px] text-[#9A9A98]">And {(g.count - g.items.length).toLocaleString()} more like these.</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** The card: who you are, at a glance. Private lines are kept out of what bots see while they work. */
function Card({ info }: { info: Info }) {
  if (!info.card.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className={SECTION}>About you</div>
      <div className="flex flex-col gap-0.5">
        {info.card.map((l) => (
          <div key={l.text} className="flex items-start gap-2 text-[13px] leading-[19px]">
            <span className="flex h-[19px] w-3.5 shrink-0 items-center justify-center" title={l.private ? "Private: kept out of what bots see while they work" : undefined}>
              {l.private ? (
                <svg width="11" height="11" viewBox="0 0 16 16" aria-label="Private">
                  <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="#9A9A98" strokeWidth="1.4" />
                  <path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="#9A9A98" strokeWidth="1.4" />
                </svg>
              ) : (
                <span className="size-1 rounded-full bg-[#C9C9C6]" />
              )}
            </span>
            <span className={`min-w-0 [overflow-wrap:anywhere] ${l.private ? "text-[#9A9A98]" : ""}`}>{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
