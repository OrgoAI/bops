"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, Bot, Session } from "@/lib/types";
import { MemorySheet } from "./memory-sheet";
import { ago, post, StatusIcon } from "./ui";

type Fact = { id: string; text: string; private: boolean; at?: number; source?: string };
type Data = { workspace: string; ws: string; card: Fact[]; facts: Fact[]; error?: string };
/** Each bot's Memory tab as last loaded, so opening it again is instant (then it refreshes). */
const seen = new Map<string, Data>();

type Answer = { answer: string; based: { id: string; text: string; source: string }[] };

/**
 * A bot's Memory tab, as one quiet page: a box to search or ask, then what it knows about the user
 * (their card, as a contact card), what it learned lately, and its recent work. Click anything to fix,
 * pin or delete it. Memory belongs to the workspace, so the whole team shares it (Manage, at the end).
 */
export function BotMemory({ state, bot: b, onOpenThread }: { state: AppState; bot: Bot; onOpenThread: (s: Session) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // What the tab showed last time for this bot shows at once; the fresh copy replaces it when it lands.
  const [data, setData] = useState<Data | null>(() => seen.get(b.id) ?? null);
  // Another bot's profile: its own last copy (or nothing), never the previous bot's.
  const [dataFor, setDataFor] = useState(b.id);
  if (dataFor !== b.id) {
    setDataFor(b.id);
    setData(seen.get(b.id) ?? null);
  }
  const [results, setResults] = useState<Fact[] | null>(null);
  const [mine, setMine] = useState(false);
  const [tick, setTick] = useState(0);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<(Answer & { question: string }) | null>(null);
  const [manage, setManage] = useState(false);
  const [allLearned, setAllLearned] = useState(false);
  const [allWork, setAllWork] = useState(false);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  // The page: the card and the newest facts (or just what this bot learned).
  useEffect(() => {
    let gone = false;
    void fetch(`/api/memory?${new URLSearchParams({ bot: b.id, ...(mine ? { mine: "1" } : {}) })}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Data) => {
        if (!mine && !j.error) seen.set(b.id, j);
        if (!gone) setData(j);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [b.id, mine, tick]);
  // A search: facts that match.
  useEffect(() => {
    if (!query) return;
    let gone = false;
    void fetch(`/api/memory?${new URLSearchParams({ bot: b.id, q: query })}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Data) => !gone && setResults(j.facts ?? []))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [b.id, query, tick]);

  const ask = async () => {
    const question = q.trim();
    if (!question || asking) return;
    setAsking(true);
    setAnswer(null);
    const r = (await (await post("/api/memory", { action: "ask", bot: b.id, question })).json()) as Answer;
    setAsking(false);
    setAnswer({ ...r, question });
  };

  const searching = !!q.trim();
  const done = state.sessions.filter((s) => s.botId === b.id && (s.answer || s.status === "done")).reverse();
  const learned = data?.facts ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-7 pb-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
        className="flex items-center gap-2 rounded-full bg-[#F7F7F6] py-1 pl-3.5 pr-1 focus-within:bg-white focus-within:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0 text-[#9A9A98]" aria-hidden>
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (!e.target.value.trim()) {
              setAnswer(null);
              setResults(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setQ("");
            setAnswer(null);
            setResults(null);
          }}
          placeholder={`Ask ${b.name} what it knows about you`}
          className="h-8 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[#9A9A98]"
        />
        {searching && (
          <button disabled={asking} className="h-7 shrink-0 rounded-full bg-[#0A0A0A] px-3 text-[12.5px] font-medium text-white disabled:opacity-50">
            {asking ? "Thinking…" : "Ask"}
          </button>
        )}
      </form>

      {searching ? (
        <div className="-mt-3 flex flex-col gap-6">
          {(asking || answer) && (
            <div className="flex flex-col gap-3 rounded-[18px] bg-[#F7F7F6] px-5 py-4">
              {asking ? (
                <div className="text-[13.5px] text-[#9A9A98]">Thinking back…</div>
              ) : (
                answer && (
                  <>
                    <div className="whitespace-pre-wrap text-[14.5px] leading-[22px]">
                      <Bold text={answer.answer} />
                    </div>
                    {answer.based.length > 0 && (
                      <div className="flex flex-col gap-1.5 border-t border-black/[0.06] pt-3">
                        {answer.based.map((f) => (
                          <div key={f.id} className="flex items-baseline gap-3 text-[12.5px] leading-[18px] text-[#6B6B6B]">
                            <span className="min-w-0 flex-1">{sentence(f.text)}</span>
                            <span className="shrink-0 text-[#9A9A98]">{f.source}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )
              )}
            </div>
          )}
          <Section title="Matches">
            {!results ? (
              <Quiet>Looking…</Quiet>
            ) : results.length ? (
              <FactList ws={data?.ws ?? ""} facts={results} onChange={reload} />
            ) : (
              <Quiet>Nothing learned matches. Press Ask to have {b.name} think it through.</Quiet>
            )}
          </Section>
        </div>
      ) : !data ? (
        <Quiet>Loading…</Quiet>
      ) : data.error ? (
        <Quiet>{data.error}</Quiet>
      ) : (
        <>
          <Section title="About you">{data.card.length ? <ContactCard ws={data.ws} lines={data.card} onChange={reload} /> : <Quiet>Nothing yet. Tell {b.name} about yourself, or pin what it learns.</Quiet>}</Section>

          <Section
            title="Recently learned"
            right={
              <div className="flex gap-0.5 rounded-full bg-[#F2F2F0] p-0.5 text-[12px] leading-4">
                {[false, true].map((m) => (
                  <button key={String(m)} onClick={() => setMine(m)} className={`rounded-full px-2.5 py-1 ${mine === m ? "bg-white font-medium text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}>
                    {m ? `From ${b.name}` : "All"}
                  </button>
                ))}
              </div>
            }
          >
            {learned.length ? (
              <>
                <FactList ws={data.ws} facts={allLearned ? learned : learned.slice(0, 5)} onChange={reload} pinnable />
                {learned.length > 5 && <More open={allLearned} onClick={() => setAllLearned((x) => !x)} count={learned.length} />}
              </>
            ) : (
              <Quiet>{mine ? `${b.name} hasn't learned anything about you yet.` : "Nothing yet. It fills in as you talk."}</Quiet>
            )}
          </Section>

          <Section title="Recent work">
            {done.length ? (
              <>
                <div className="flex flex-col">
                  {(allWork ? done : done.slice(0, 3)).map((s) => (
                    <button key={s.id} onClick={() => onOpenThread(s)} className="-mx-2.5 flex items-start gap-2.5 rounded-[12px] px-2.5 py-2 text-left hover:bg-[#F7F7F6]">
                      <span className="mt-0.5">
                        <StatusIcon session={s} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5">{s.title}</span>
                          <span className="shrink-0 text-[12px] text-[#9A9A98]">{ago(s.endedAt ?? s.createdAt)}</span>
                        </span>
                        {s.answer && <span className="line-clamp-1 text-[13px] leading-[18px] text-[#6B6B6B]">{s.answer.replace(/\*\*|\[|\]\([^)]*\)/g, "")}</span>}
                      </span>
                    </button>
                  ))}
                </div>
                {done.length > 3 && <More open={allWork} onClick={() => setAllWork((x) => !x)} count={done.length} />}
              </>
            ) : (
              <Quiet>What {b.name} finds and makes will collect here.</Quiet>
            )}
          </Section>

          <div className="text-center text-[12px] leading-4 text-[#9A9A98]">
            Everyone on the {data.workspace} team shares this memory.{" "}
            <button onClick={() => setManage(true)} className="font-medium text-[#6B6B6B] underline decoration-[#D9D9D6] underline-offset-2 hover:text-ink">
              Manage
            </button>
          </div>
        </>
      )}

      {manage && <MemorySheet state={state} onClose={() => setManage(false)} />}
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex h-6 items-center justify-between">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: React.ReactNode }) => <div className="py-2 text-[13.5px] leading-5 text-[#9A9A98]">{children}</div>;

function More({ open, onClick, count }: { open: boolean; onClick: () => void; count: number }) {
  return (
    <button onClick={onClick} className="self-start text-[13px] font-medium text-[#6B6B6B] hover:text-ink">
      {open ? "Show less" : `Show all ${count}`}
    </button>
  );
}

/** **Bold** in an answer, shown bold. */
function Bold({ text }: { text: string }) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i} className="font-semibold">{part}</b> : part));
}

/** Facts come lowercase ("alex is…"): start them with a capital. */
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/* ---------------- About you: the card, as a contact card ---------------- */

/** A card line: "ATTRIBUTE: Project: Atlas (Mobile App)" is kind ATTRIBUTE, label Project, value "Atlas", note "Mobile App". */
type Line = Fact & { kind: string; label: string; value: string; note?: string; head: string };

function parse(f: Fact): Line {
  const m = f.text.match(/^(?:([A-Z][A-Z_ ]+):\s*)?([A-Z][\w ()/'-]{1,30}):\s+(.+)$/);
  if (!m) return { ...f, kind: "", label: "", value: f.text, head: "" };
  const [, kind = "", label, rest] = m;
  const p = rest.match(/^(.+?)\s+\(([^)]+)\)$/);
  return { ...f, kind, label, value: p ? p[1] : rest, note: p?.[2], head: f.text.slice(0, f.text.length - rest.length) };
}

const LABEL: Record<string, string> = {
  Alias: "Also known as",
  Location: "Lives in",
  Project: "Projects",
  Tool: "Tools",
  "Primary Agent": "Agents",
  "Agent fleet": "Agents",
  "Co-founder": "Cofounders",
  "YC Batch": "YC",
  Education: "Studied",
};
const WORK = /role|project|focus|tool|agent|website|batch|company|team|customer|co-?founder/i;
const groupOf = (l: Line) => (!l.label ? "Notes" : /co-?founder|agent fleet/i.test(l.label) ? "Work" : l.kind === "RELATIONSHIP" ? "People" : WORK.test(l.label) ? "Work" : "You");

/** Short values sit on one line ("alex · @alex"); long lists go one per line. */
const stacked = (items: Line[]) => items.length > 3 || items.some((x) => x.value.length > 26) || items.filter((x) => x.note).length > 1;

function ContactCard({ ws, lines, onChange }: { ws: string; lines: Fact[]; onChange: () => void }) {
  const parsed = lines.map(parse);
  const open = parsed.filter((l) => !l.private);
  const hidden = parsed.filter((l) => l.private);
  const [showPrivate, setShowPrivate] = useState(false);
  const groups = (["You", "Work", "People", "Notes"] as const)
    .map((g) => {
      const rows = new Map<string, Line[]>();
      for (const l of open.filter((x) => groupOf(x) === g)) {
        const k = g === "Notes" ? l.id : (LABEL[l.label] ?? l.label);
        rows.set(k, [...(rows.get(k) ?? []), l]);
      }
      return { g, rows: [...rows.entries()] };
    })
    .filter((x) => x.rows.length);
  return (
    <div className="flex flex-col rounded-[18px] px-5 py-1 shadow-[0_0_0_1px_#ECECEA]">
      {groups.map(({ g, rows }) => (
        <div key={g} className="flex flex-col gap-2 border-b border-[#F0F0EE] py-4 last:border-b-0">
          <div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-[#B0B0AD]">{g}</div>
          {rows.map(([label, items]) => (
            <div key={label} className="flex gap-4 text-[13.5px] leading-[21px]">
              {g !== "Notes" && <span className="w-[116px] shrink-0 truncate text-[#9A9A98]" title={label}>{label}</span>}
              <span className="min-w-0 flex-1">
                {items.map((l, i) => (
                  <span key={l.id}>
                    {i > 0 && (stacked(items) ? <br /> : <span className="text-[#C9C9C6]"> · </span>)}
                    <Editable ws={ws} item={l} onChange={onChange}>
                      {l.value}
                      {l.note && <span className="text-[#9A9A98]"> {l.note}</span>}
                    </Editable>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
      {hidden.length > 0 && (
        <div className="border-t border-[#F0F0EE] py-3.5 first:border-t-0">
          <button onClick={() => setShowPrivate((x) => !x)} className="flex w-full items-center gap-2.5 text-left">
            <LockIcon />
            <span className="flex-1 text-[13.5px] leading-5">
              {hidden.length} private details <span className="text-[#9A9A98]">· hidden from bots while they work</span>
            </span>
            <svg width="10" height="10" viewBox="0 0 12 12" className={`shrink-0 transition-transform ${showPrivate ? "rotate-90" : ""}`}>
              <path d="M4.5 3l3 3-3 3" fill="none" stroke="#9A9A98" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showPrivate && (
            <div className="mt-2.5 flex flex-col gap-1.5 pl-[22px]">
              {hidden.map((l) => (
                <div key={l.id} className="flex gap-4 text-[13.5px] leading-[21px]">
                  <span className="w-[116px] shrink-0 truncate text-[#9A9A98]" title={l.label}>{/ Address$/.test(l.label) ? "Address" : l.label || "Note"}</span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <Editable ws={ws} item={l} onChange={onChange}>
                      {l.value}
                      {l.note && <span className="text-[#9A9A98]"> {l.note}</span>}
                      {/ Address$/.test(l.label) && <span className="text-[#9A9A98]"> · {l.label.replace(/ Address$/, "")}</span>}
                    </Editable>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Learned facts ---------------- */

function FactList({ ws, facts, onChange, pinnable }: { ws: string; facts: Fact[]; onChange: () => void; pinnable?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {facts.map((f) => (
        <div key={f.id} className="flex flex-col py-1.5">
          <span className="text-[14px] leading-[21px] [overflow-wrap:anywhere]">
            <Editable ws={ws} item={{ ...f, value: f.text, head: "" }} onChange={onChange} pinnable={pinnable}>
              {f.private && <LockIcon inline />}
              {sentence(f.text)}
            </Editable>
          </span>
          {f.source && (
            <span className="text-[12px] leading-4 text-[#9A9A98]">
              {f.source}
              {f.at ? ` · ${ago(f.at)}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Fix, pin, delete ---------------- */

/**
 * Something memory knows. Click it for Fix · Pin · Delete. Fixing a card line edits just its value;
 * a learned fact is rewritten whole.
 */
function Editable({ ws, item, onChange, pinnable, children }: { ws: string; item: Fact & { value: string; head: string }; onChange: () => void; pinnable?: boolean; children: React.ReactNode }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);
  const act = async (body: Record<string, unknown>) => {
    setMenu(false);
    const r = (await (await post("/api/memory", { ws, ...body })).json()) as { error?: string };
    if (r.error) setError(r.error);
    onChange();
  };
  if (gone) return null;
  if (editing !== null)
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(null);
          if (editing.trim() && editing.trim() !== item.value) void act({ action: "fix", id: item.id, text: item.head + editing.trim() });
        }}
        className="inline-flex w-full items-center gap-1.5 align-middle"
      >
        <input
          autoFocus
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
          onBlur={() => setEditing(null)}
          className="h-7 min-w-0 flex-1 rounded-[8px] px-2 text-[13.5px] shadow-[inset_0_0_0_1.5px_#0A0A0A] outline-none"
        />
      </form>
    );
  const pill = "rounded-full px-2.5 py-1 text-[12.5px] font-medium leading-4 hover:bg-[#F2F2F0]";
  return (
    <span ref={box} className="relative">
      <span
        role="button"
        tabIndex={0}
        onClick={() => setMenu((m) => !m)}
        onKeyDown={(e) => e.key === "Enter" && setMenu((m) => !m)}
        className={`-mx-1 cursor-pointer rounded-[6px] px-1 transition-colors ${menu ? "bg-[#F2F2F0]" : "hover:bg-[#F7F7F6]"}`}
      >
        {children}
      </span>
      {error && <span className="ml-2 text-[12px] text-[#B42318]">{error}</span>}
      {menu && (
        <span className="absolute left-0 top-[calc(100%+4px)] z-20 flex items-center gap-0.5 rounded-full bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_10px_24px_-10px_#00000059]">
          <button
            onClick={() => {
              setMenu(false);
              setEditing(item.value);
            }}
            className={pill}
          >
            Fix
          </button>
          {pinnable && (
            <button onClick={() => void act({ action: "pin", text: item.text })} className={pill} title="Add to About you, which every bot sees">
              Pin
            </button>
          )}
          <button
            onClick={() => {
              setGone(true);
              void act({ action: "forget", id: item.id });
            }}
            className={`${pill} text-[#B42318] hover:bg-[#FBEAEA]`}
          >
            Delete
          </button>
        </span>
      )}
    </span>
  );
}

function LockIcon({ inline }: { inline?: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-label="Private" className={inline ? "mr-1.5 inline-block align-[-1px]" : "shrink-0"}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="#9A9A98" strokeWidth="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="#9A9A98" strokeWidth="1.4" />
    </svg>
  );
}
