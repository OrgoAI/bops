"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyOps,
  cleanCell,
  cleanColumnName,
  cleanFileName,
  CRM_LIMITS,
  CRM_SAY,
  defaultView,
  formatNumber,
  groupRows,
  inferColumns,
  OTHER_KEY,
  parseDate,
  parseNumber,
  SAMPLE_NAME,
  toCsv,
  type ColumnInfo,
  type CrmFileData,
  type CrmFileMeta,
  type CrmOp,
  type CrmView as ChartView,
} from "@/lib/crm-csv";
import type { AppState, Message } from "@/lib/types";
import { CrmChart } from "./crm-chart";
import { DeleteX, NameInput } from "./sidebar";
import { CloseButton, currentWorkspace, post } from "./ui";

/*
 * The CRM: the workspace's CSV files, listed on the left (CrmSection) and each opened as a tab on the
 * right (CrmView): a chart you can point at and click, over a table you can edit. Bots read and add to
 * the same files (lib/server/crm.ts), and each save they make leaves a note in the chat (CrmNote) with
 * Open and Undo. The files are on this Mac (lib/server/crm.ts says where), not in the app's state, so
 * the lists fetch their own and fetch again when the window comes back, when a bot saves (crmMarkOf)
 * and when anything here saves (the "bops-crm" event).
 */

/** Open a CRM file as a tab on the right (bops-app.tsx); null outside the app. */
export const OpenCrm = createContext<((ws: string, file: string) => void) | null>(null);

/** What the lists fetch again on: the newest bot save's note, and whether it was undone. */
export function crmMarkOf(state: AppState) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const c = state.messages[i].crm;
    if (c) return `${state.messages[i].id}:${c.after}:${c.undone ? 1 : 0}`;
  }
  return "";
}

/** Tell every CRM list and tab on the page that a file changed. */
const announce = () => window.dispatchEvent(new Event("bops-crm"));

const q = encodeURIComponent;

/** A call to the CRM's routes: ok, status, and the JSON it answered. */
async function send(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string } };
}

const rowsWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

/* ---------------- Icons ---------------- */

/** A table: a CRM file. */
export function CrmFileIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <rect x="2.5" y="3" width="11" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 6.5h11M6.5 6.5V13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Three bars: the CRM's chart. */
export function CrmBarsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <path d="M3.5 13V9M8 13V4.5M12.5 13V7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <path d="M8 2.5v7.5M5 7l3 3 3-3M3 12.5v1h10v-1" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------------- Data ---------------- */

/** The workspace's files for the sidebar (null until they're in), and `off` where there's no CRM. */
export function useCrmFiles(ws: string, mark: string) {
  const [got, setGot] = useState<{ ws: string; files: CrmFileMeta[] } | null>(null);
  const [off, setOff] = useState(false);
  useEffect(() => {
    let stop = false;
    let seq = 0;
    let offTries = 0;
    let again: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const mine = ++seq;
      clearTimeout(again);
      void fetch(`/api/crm?ws=${q(ws)}`, { cache: "no-store" })
        .then(async (r) => {
          const j = (await r.json().catch(() => ({}))) as { off?: boolean; files?: CrmFileMeta[] };
          if (stop || mine !== seq) return;
          // Still loading the account: once more in a moment.
          if (r.status === 409) again = setTimeout(load, 2000);
          else if (j.off) {
            setOff(true);
            if (++offTries <= 3) again = setTimeout(load, 5000);
          } else if (r.ok && j.files) {
            setOff(false);
            setGot({ ws, files: j.files });
          }
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    window.addEventListener("bops-crm", load);
    return () => {
      stop = true;
      clearTimeout(again);
      window.removeEventListener("focus", load);
      window.removeEventListener("bops-crm", load);
    };
  }, [ws, mark]);
  return { files: got?.ws === ws ? got.files : null, off };
}

type FileStatus = "loading" | "ok" | "gone" | "failed";

/**
 * One file for its tab. A fetch again keeps what's shown until it lands (no flash), and doesn't land
 * at all while saves are on their way (`hold` counts them): the save's answer is newer.
 */
export function useCrmFile(ws: string, file: string, mark: string, hold?: { current: number }) {
  const key = `${ws}\u0000${file.toLowerCase()}`;
  const [got, setGot] = useState<{ key: string; data: CrmFileData | null; status: FileStatus }>({ key, data: null, status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    let seq = 0;
    let again: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const mine = ++seq;
      clearTimeout(again);
      void fetch(`/api/crm/file?ws=${q(ws)}&name=${q(file)}`, { cache: "no-store" })
        .then(async (r) => {
          const j = (await r.json().catch(() => ({}))) as CrmFileData;
          if (stop || mine !== seq || (hold?.current ?? 0) > 0) return;
          if (r.ok) setGot({ key, data: j, status: "ok" });
          else if (r.status === 404) setGot({ key, data: null, status: "gone" });
          else if (r.status === 409) again = setTimeout(load, 2000);
          else setGot((g) => (g.key === key && g.data ? g : { key, data: null, status: "failed" }));
        })
        .catch(() => !stop && mine === seq && setGot((g) => (g.key === key && g.data ? g : { key, data: null, status: "failed" })));
    };
    load();
    window.addEventListener("focus", load);
    window.addEventListener("bops-crm", load);
    return () => {
      stop = true;
      clearTimeout(again);
      window.removeEventListener("focus", load);
      window.removeEventListener("bops-crm", load);
    };
  }, [ws, file, key, mark, tick, hold]);
  const now = got.key === key ? got : { key, data: null, status: "loading" as const };
  const setData = useCallback((data: CrmFileData) => setGot({ key, data, status: "ok" }), [key]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: now.data, status: now.status, setData, reload };
}

/* ---------------- The sidebar's section ---------------- */

/** A file's name from a file the user picked: what can be a name, without its extension ("Q3 leads (final)"). */
function nameFromFile(fileName: string) {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N} _()&'-]+/gu, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .slice(0, CRM_LIMITS.fileName);
  return cleanFileName(base) ?? "Imported";
}

/** `base`, or "base 2", "base 3"… whichever isn't taken (case ignored), 60 characters at most. */
function freeName(base: string, taken: Set<string>) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, CRM_LIMITS.fileName - String(n).length - 1).trimEnd()} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Text from a file the user picked: UTF-8, or Windows' own encoding (older Excel exports) when it isn't. */
async function textOf(f: File) {
  const buf = await f.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

const isCsv = (f: File) => /\.(csv|tsv|txt)$/i.test(f.name) || f.type === "text/csv";

/** Whether a drag carries files (a CSV from Finder), not text or a link. */
const dragsFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");

/** A new file (a template, or an imported CSV's text): its name once it's made, or what went wrong. */
async function makeFile(ws: string, body: { name: string; template?: "pipeline" | "sample"; text?: string }): Promise<{ name: string; note?: string } | { error: string }> {
  const r = await send("/api/crm", "POST", { ws, template: null, text: null, ...body }).catch(() => null);
  if (!r?.ok) return { error: r?.body.error ?? "Couldn't add that file. Try again." };
  announce();
  return { name: (r.body.file as CrmFileMeta).name, ...(typeof r.body.note === "string" ? { note: r.body.note } : {}) };
}

/** The workspace's file names as they are now (lowercased), when the caller has no list of its own. */
async function namesIn(ws: string) {
  const r = await send(`/api/crm?ws=${q(ws)}`, "GET").catch(() => null);
  return new Set(((r?.body.files ?? []) as CrmFileMeta[]).map((f) => f.name.toLowerCase()));
}

/**
 * CSV files the user picked or dropped (10 at most), each made a new file under a name that's free.
 * The last one made opens. `say` gets each refusal (bad) and note (cells cut).
 */
async function importCsvs(ws: string, picked: File[], taken: Set<string> | null, open: ((ws: string, file: string) => void) | null, say: (text: string, bad: boolean) => void) {
  const names = taken ?? (await namesIn(ws));
  let last: string | null = null;
  for (const f of picked.slice(0, 10)) {
    if (!isCsv(f)) {
      say(CRM_SAY.notCsv, true);
      continue;
    }
    if (f.size > CRM_LIMITS.bytes) {
      say(CRM_SAY.bytes, true);
      continue;
    }
    const made = await makeFile(ws, { name: freeName(nameFromFile(f.name), names), text: await textOf(f) });
    if ("error" in made) {
      say(made.error, true);
      continue;
    }
    names.add(made.name.toLowerCase());
    last = made.name;
    if (made.note) say(made.note, false);
  }
  if (last) open?.(ws, last);
}

/**
 * The CRM in the sidebar: the workspace's files with their row counts, newest work a click away.
 * + starts a pipeline, imports a CSV or puts the sample back; a CSV dropped here is imported. Rename
 * and delete on hover (delete asks once more). With the sidebar's search open, files filter by name.
 */
export function CrmSection({
  state,
  query,
  active,
  onOpen,
  onChange,
}: {
  state: AppState;
  /** The sidebar's search, lowercased (empty: none). */
  query?: string;
  /** The file open on the right, to mark its row. */
  active?: { ws: string; file: string };
  onOpen: (ws: string, file: string) => void;
  /** A file was renamed (`to`) or deleted (null): tabs showing it follow. */
  onChange: (change: { ws: string; from: string; to: string | null }) => void;
}) {
  const ws = currentWorkspace(state);
  const { files, off } = useCrmFiles(ws, crmMarkOf(state));
  const [menu, setMenu] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const [naming, setNaming] = useState<{ from?: string; name: string } | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 4000);
    return () => clearTimeout(t);
  }, [said]);
  useEffect(() => {
    if (!menu) return;
    const outside = (t: EventTarget | null) => !pop.current?.contains(t as Node) && !plus.current?.contains(t as Node);
    const away = (e: MouseEvent) => outside(e.target) && setMenu(null);
    // Focus going anywhere else (Tab, a click into a field) closes it too.
    const left = (e: FocusEvent) => outside(e.target) && setMenu(null);
    // Esc closes the menu, and only the menu (preventDefault keeps the tab on the right open), back to +.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenu(null);
      plus.current?.focus();
    };
    const gone = () => setMenu(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("focusin", left);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", gone);
    document.addEventListener("scroll", gone, true);
    // The menu sits at the end of the page: focus goes into it, so the keyboard can reach its items.
    pop.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("focusin", left);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", gone);
      document.removeEventListener("scroll", gone, true);
    };
  }, [menu]);

  if (off) return null;
  const list = files ?? [];
  const shown = query ? list.filter((f) => f.name.toLowerCase().includes(query)) : list;
  if (query && !shown.length) return null;
  const isActive = (f: CrmFileMeta) => !!active && active.ws === ws && active.file.toLowerCase() === f.name.toLowerCase();
  const rows = all || query ? shown : [...shown.slice(0, 4), ...shown.slice(4).filter(isActive)];
  const taken = () => new Set(list.map((f) => f.name.toLowerCase()));

  const openMenu = () => {
    const r = plus.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + 150 > window.innerHeight;
    setMenu({ x: Math.max(8, r.right - 220), y: up ? r.top - 6 : r.bottom + 6, up });
  };
  const create = async (body: { name: string; template?: "pipeline" | "sample" }) => {
    const made = await makeFile(ws, body);
    if ("error" in made) {
      setSaid({ text: made.error, bad: true });
      return null;
    }
    onOpen(ws, made.name);
    return made.name;
  };
  const importFiles = (picked: File[]) => importCsvs(ws, picked, files ? taken() : null, onOpen, (text, bad) => setSaid({ text, bad }));
  /** Up and Down (Home, End) move through the menu; Tab leaves it, back on +. */
  const menuKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      items[to]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      setMenu(null);
      plus.current?.focus();
    }
  };
  const save = async () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!naming.from) {
      if (await create({ name, template: "pipeline" })) setNaming(null);
      return;
    }
    if (name === naming.from) return setNaming(null);
    const r = await send("/api/crm", "PATCH", { ws, name: naming.from, to: name });
    if (!r.ok) return setSaid({ text: r.body.error ?? "Couldn't rename it. Try again.", bad: true });
    const to = (r.body.file as CrmFileMeta).name;
    setNaming(null);
    moveView(ws, naming.from, to);
    onChange({ ws, from: naming.from, to });
    announce();
  };
  /** Delete a file. `keys`: asked from the keyboard, so focus goes back to + rather than nowhere once its row is gone. */
  const remove = async (name: string, keys: boolean) => {
    setSure(null);
    const r = await send(`/api/crm?ws=${q(ws)}&name=${q(name)}`, "DELETE");
    if (!r.ok && r.status !== 404) return setSaid({ text: r.body.error ?? "Couldn't delete it. Try again.", bad: true });
    onChange({ ws, from: name, to: null });
    announce();
    if (keys) plus.current?.focus();
  };
  const item = "flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[14px] font-medium hover:bg-black/[0.04]";

  return (
    <div
      className={`flex flex-col rounded-[12px] pt-4 ${dropping ? "shadow-[inset_0_0_0_1.5px_#0A0A0A]" : ""}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="flex items-center pb-1.5 pl-2.5 pr-1.5">
        <span className="flex-1 text-[13px] font-medium leading-4 text-[#9A9A98]">CRM</span>
        <button
          ref={plus}
          aria-label="New CRM file"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={() => (menu ? setMenu(null) : openMenu())}
          className={`flex size-5 items-center justify-center rounded-md hover:bg-black/[0.06] hover:text-ink ${menu ? "bg-black/[0.06] text-ink" : "text-[#9A9A98]"}`}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {menu &&
        createPortal(
          <div
            ref={pop}
            role="menu"
            aria-label="New CRM file"
            onKeyDown={menuKeys}
            className="fixed z-50 flex w-[220px] flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_rgba(0,0,0,0.12)]"
            style={{ left: menu.x, top: menu.y, transform: menu.up ? "translateY(-100%)" : undefined }}
          >
            <button
              role="menuitem"
              className={item}
              onClick={() => {
                setMenu(null);
                setNaming({ name: freeName("Pipeline", taken()) });
              }}
            >
              <CrmFileIcon size={15} />
              New pipeline
            </button>
            <button
              role="menuitem"
              className={item}
              onClick={() => {
                setMenu(null);
                plus.current?.focus();
                picker.current?.click();
              }}
            >
              <ImportIcon />
              Import a CSV
            </button>
            {files && !list.some((f) => f.sample) && (
              <button
                role="menuitem"
                className={item}
                onClick={() => {
                  setMenu(null);
                  plus.current?.focus();
                  void create({ name: freeName(SAMPLE_NAME, taken()), template: "sample" });
                }}
              >
                <CrmBarsIcon size={15} />
                Add the sample
              </button>
            )}
          </div>,
          document.body,
        )}
      {dropping && <div className="px-2.5 pb-1 text-[13px] leading-[18px] text-[#3A3A38]">Drop a CSV to add it</div>}
      {naming && !naming.from && (
        <NameInput value={naming.name} placeholder="Name the file" onChange={(name) => setNaming({ name })} onSave={() => void save()} onCancel={() => setNaming(null)} />
      )}
      {rows.map((f) =>
        naming?.from === f.name ? (
          <NameInput key={f.name} value={naming.name} onChange={(name) => setNaming({ from: f.name, name })} onSave={() => void save()} onCancel={() => setNaming(null)} />
        ) : (
          <div
            key={f.name}
            onMouseLeave={() => sure === f.name && setSure(null)}
            className={`group/crm flex h-[34px] items-center gap-2 rounded-[10px] px-2.5 has-[>button:first-child:focus-visible]:shadow-[inset_0_0_0_1.5px_#0A0A0A] ${isActive(f) ? "bg-[#EEEEEC]" : "hover:bg-black/[0.03]"}`}
          >
            {/* Its focus shows as a ring on the whole row (above). */}
            <button onClick={() => onOpen(ws, f.name)} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none">
              <span className="text-[#6B6B6B]">
                <CrmFileIcon />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px]">{f.name}</span>
            </button>
            {sure === f.name ? (
              <button
                autoFocus
                onClick={(e) => void remove(f.name, e.detail === 0)}
                onBlur={() => setSure(null)}
                title={`Delete ${f.name}`}
                className="h-7 shrink-0 rounded-md bg-[#B42318] px-2 text-[12px] font-medium text-white"
              >
                Delete
              </button>
            ) : (
              <>
                <span className="shrink-0 text-[12px] tabular-nums text-[#9A9A98] group-hover/crm:hidden group-has-[:focus-visible]/crm:hidden">{f.rows.toLocaleString("en-US")}</span>
                <span className="hidden shrink-0 items-center group-hover/crm:flex group-has-[:focus-visible]/crm:flex">
                  <button
                    onClick={() => setNaming({ from: f.name, name: f.name })}
                    aria-label={`Rename ${f.name}`}
                    className="flex size-5 items-center justify-center rounded-md text-[#9A9A98] hover:bg-black/[0.06] hover:text-ink"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
                      <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12 3 13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <DeleteX label={`Delete ${f.name}`} onDelete={() => setSure(f.name)} className="group-hover/crm:opacity-100 group-has-[:focus-visible]/crm:opacity-100" />
                </span>
              </>
            )}
          </div>
        ),
      )}
      {files && !list.length && !naming && (
        <button onClick={openMenu} aria-haspopup="menu" className="px-2.5 py-1 text-left text-[13px] leading-[18px] text-[#9A9A98] hover:text-[#6B6B6B]">
          No files yet. Start a pipeline or import a CSV.
        </button>
      )}
      {!query && (all ? shown.length > 4 : shown.length > rows.length) && (
        <button onClick={() => setAll(!all)} className="self-start rounded-[8px] px-2.5 py-1 text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
          {all ? "Show less" : `Show all (${shown.length})`}
        </button>
      )}
      {said && <span className={`px-2.5 pt-1 text-[12px] leading-4 ${said.bad ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>{said.text}</span>}
      <input
        ref={picker}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        multiple
        hidden
        onChange={(e) => {
          void importFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/* ---------------- The tab ---------------- */

const viewKey = (ws: string, file: string) => `bops.crm.view.${ws}.${file.toLowerCase()}`;

/** How the user last set a file's chart (this Mac only). */
function readView(ws: string, file: string): ChartView | null {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(ws, file)) ?? "null") as ChartView | null;
    return v && (typeof v.groupBy === "string" || v.groupBy === null) && typeof v.measure === "string" && (v.kind === "bar" || v.kind === "line") ? v : null;
  } catch {
    return null;
  }
}

function writeView(ws: string, file: string, v: ChartView) {
  try {
    localStorage.setItem(viewKey(ws, file), JSON.stringify(v));
  } catch {
    /* kept for this visit only */
  }
}

/**
 * What the table shows for a file (the picked bar, the search, the sort, how many rows), while the app
 * is open: the side panel and full width are two views of the same file, so going from one to the other
 * keeps it.
 */
type TableView = { picked: string | null; search: string; sort: { col: number; dir: 1 | -1 } | null; shown: number };
const tableViews = new Map<string, TableView>();
const tableKey = (ws: string, file: string) => `${ws}\u0000${file.toLowerCase()}`;

/** A file renamed keeps its chart as the user set it (and its table as it was). */
function moveView(ws: string, from: string, to: string) {
  const table = tableViews.get(tableKey(ws, from));
  if (table) {
    tableViews.delete(tableKey(ws, from));
    tableViews.set(tableKey(ws, to), table);
  }
  try {
    const v = localStorage.getItem(viewKey(ws, from));
    if (v === null || viewKey(ws, from) === viewKey(ws, to)) return;
    localStorage.setItem(viewKey(ws, to), v);
    localStorage.removeItem(viewKey(ws, from));
  } catch {
    /* it opens with the default chart */
  }
}

/** A remembered chart, checked against the file's columns now (a column renamed or gone falls back to the default). */
function fitView(v: ChartView | null, columns: string[], types: ColumnInfo[]): ChartView {
  const fallback = defaultView(columns, types);
  if (!v || v.groupBy === null || !columns.includes(v.groupBy)) return fallback;
  const by = types[columns.indexOf(v.groupBy)];
  const measure = v.measure === "count" || types.some((t) => t.name === v.measure && t.type === "number") ? v.measure : "count";
  return { groupBy: v.groupBy, measure, kind: v.kind === "line" && by?.type === "date" ? "line" : "bar" };
}

/** A sortable value: a number, a date as YYYYMMDD, else the text; null for an empty cell (always last). */
function sortValue(v: string, type: ColumnInfo["type"] | undefined): number | string | null {
  if (!v.trim()) return null;
  if (type === "number") return parseNumber(v) ?? v.toLowerCase();
  if (type === "date") {
    const d = parseDate(v);
    return d ? d.y * 10_000 + d.m * 100 + d.d : v.toLowerCase();
  }
  return v;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function RingButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** A native select dressed like the app's pills. */
function Pick({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[12px] leading-4 text-[#9A9A98]">{label}</span>
      <span className="relative flex">
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 max-w-[220px] cursor-pointer appearance-none truncate rounded-full bg-white pl-3 pr-7 text-[13px] text-ink shadow-[0_0_0_1px_#E6E6E3] outline-none hover:bg-[#FCFCFB] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
        >
          {children}
        </select>
        <svg width="10" height="10" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden>
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="#6B6B6B" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </label>
  );
}

/** The pinned Delete column's edge while columns are hidden behind it: a hairline and a soft shadow. */
const PINNED_SHADOW = "shadow-[inset_1px_0_0_#ECECEA,-10px_0_12px_-10px_rgba(0,0,0,0.16)]";

const EMPTY_COLUMNS: string[] = [];
const EMPTY_ROWS: string[][] = [];

/**
 * A CRM file as a tab: a chart (Group by, Show, Bar or Line) over its rows, which sort, search, filter
 * to the picked bar, and edit in place. Each change shows at once and saves in order behind it; if the
 * file changed meanwhile (a bot saved), the latest is shown with a line saying so. `mode` "focus" is
 * full width (Esc, or the button, goes back to the side panel).
 */
export function CrmView({
  state,
  ws,
  file,
  mode,
  onClose,
  onFocus,
  onBack,
}: {
  state: AppState;
  ws: string;
  file: string;
  mode: "panel" | "focus";
  onClose: () => void;
  onFocus?: () => void;
  onBack?: () => void;
}) {
  const pending = useRef(0);
  const { data, status, setData, reload } = useCrmFile(ws, file, crmMarkOf(state), pending);
  const columns = data?.columns ?? EMPTY_COLUMNS;
  const rows = data?.rows ?? EMPTY_ROWS;
  const [stored, setStored] = useState<ChartView | null>(() => readView(ws, file));
  // What the columns hold, the chart as set (checked against them), and its groups: again only when the file or the setting changes.
  const chart = useMemo(() => {
    const types = inferColumns(columns, rows);
    const view = fitView(stored, columns, types);
    const by = view.groupBy === null ? -1 : columns.indexOf(view.groupBy);
    const sum = view.measure === "count" ? -1 : columns.indexOf(view.measure);
    return { types, view, by, sum, grouped: by >= 0 ? groupRows(rows, by, types[by].type, sum >= 0 ? sum : null) : null };
  }, [columns, rows, stored]);
  const { types, view, by, sum, grouped } = chart;
  const groups = grouped?.groups ?? [];
  const [picked, setPicked] = useState<string | null>(() => tableViews.get(tableKey(ws, file))?.picked ?? null);
  const pickedGroup = picked === null ? undefined : groups.find((g) => g.key === picked);
  const [search, setSearch] = useState(() => tableViews.get(tableKey(ws, file))?.search ?? "");
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(() => tableViews.get(tableKey(ws, file))?.sort ?? null);
  const sortBefore = useRef<{ col: number; dir: 1 | -1 } | null>(null);
  const [shown, setShown] = useState<number>(() => tableViews.get(tableKey(ws, file))?.shown ?? CRM_LIMITS.tableRows);
  useEffect(() => {
    tableViews.set(tableKey(ws, file), { picked, search, sort, shown });
  }, [ws, file, picked, search, sort, shown]);
  // The cell the keyboard is on: the table is one stop for Tab, and the arrow keys move inside it.
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);
  const grid = useRef<HTMLTableElement>(null);
  // Columns hidden past the right edge: the row's Delete, pinned there, casts a shadow over them, and
  // a chevron over it scrolls to them (and back to the first columns once at the end).
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [across, setAcross] = useState(false);
  const ready = !!data;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => {
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
      setAcross(el.scrollLeft > 1);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const seen = new ResizeObserver(check);
    seen.observe(el);
    if (el.firstElementChild) seen.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", check);
      seen.disconnect();
    };
  }, [ready]);
  // A CSV dropped on the tab is added as a new file, as in the sidebar.
  const openFile = useContext(OpenCrm);
  const [dropping, setDropping] = useState(false);
  const [told, setTold] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ row: number; col: number; draft: string } | null>(null);
  // The cell last closed, so a blur that comes after Tab or Esc moved on doesn't save it twice.
  const closed = useRef<string | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ col: number; name: string } | null>(null);
  // A column name typed in the header was handled (Enter), so the blur as its input goes doesn't do it again.
  const named = useRef(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  // The file as the server last had it (a failed save goes back to it), and the saves in flight, in order.
  const confirmed = useRef<CrmFileData | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const epoch = useRef(0);
  // Brings a row's Delete into sight when it shows (the table may be scrolled across): once, as it appears.
  const reveal = useCallback((el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }), []);

  useEffect(() => {
    if (data && !pending.current) confirmed.current = data;
  }, [data]);
  useEffect(() => {
    if (saving !== "saved") return;
    const t = setTimeout(() => setSaving("idle"), 1200);
    return () => clearTimeout(t);
  }, [saving]);
  useEffect(() => {
    if (!problem) return;
    const t = setTimeout(() => setProblem(null), 6000);
    return () => clearTimeout(t);
  }, [problem]);
  useEffect(() => {
    if (!told) return;
    const t = setTimeout(() => setTold(null), 6000);
    return () => clearTimeout(t);
  }, [told]);

  const order = useMemo(() => {
    const inGroup = picked === null ? undefined : chart.grouped?.groups.find((g) => g.key === picked);
    const inPick = inGroup ? new Set(inGroup.rows) : null;
    const words = search.trim().toLowerCase();
    let at = rows.map((_, i) => i);
    if (inPick) at = at.filter((i) => inPick.has(i));
    if (words) at = at.filter((i) => rows[i].some((v) => v.toLowerCase().includes(words)));
    if (sort) {
      const type = chart.types[sort.col]?.type;
      const keyOf = new Map(at.map((i) => [i, sortValue(rows[i][sort.col] ?? "", type)]));
      at.sort((a, b) => {
        const x = keyOf.get(a) ?? null;
        const y = keyOf.get(b) ?? null;
        if (x === null || y === null) return x === y ? a - b : x === null ? 1 : -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : typeof x === "number" ? -1 : typeof y === "number" ? 1 : collator.compare(x, y);
        return c * sort.dir || a - b;
      });
    }
    return at;
  }, [rows, chart, picked, search, sort]);

  /** Show a change at once, then save it behind the ones before it. False when it can't be made. */
  const change = (ops: CrmOp[]) => {
    if (!data) return false;
    const next = applyOps(data.columns, data.rows, ops);
    if ("conflict" in next) {
      setProblem(CRM_SAY.changed);
      reload();
      return false;
    }
    if ("error" in next) {
      setProblem(next.error);
      return false;
    }
    setProblem(null);
    setData({ ...data, ...next });
    pending.current++;
    setSaving("saving");
    const mine = epoch.current;
    queue.current = queue.current.then(async () => {
      if (mine !== epoch.current) {
        pending.current--;
        return;
      }
      const r = await send("/api/crm/file", "PATCH", { ws, name: file, ops }).catch(() => null);
      pending.current--;
      if (r?.ok) {
        confirmed.current = r.body as unknown as CrmFileData;
        if (!pending.current) {
          setData(confirmed.current);
          setSaving("saved");
        }
        announce();
        return;
      }
      // Refused: the changes after this one go too, and the file shows as the server has it.
      epoch.current++;
      const latest = r?.status === 409 && r.body.file ? (r.body.file as CrmFileData) : confirmed.current;
      if (latest) {
        confirmed.current = latest;
        setData(latest);
      }
      setSaving("idle");
      setProblem(r?.body.error ?? "Couldn't save that. Check your connection and try again.");
      if (r?.status === 404) reload();
    });
    return true;
  };

  const drop: Drop = {
    dropping,
    onDragOver: (e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      if (!dropping) setDropping(true);
    },
    onDragLeave: (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false),
    onDrop: (e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      void importCsvs(ws, [...e.dataTransfer.files], null, openFile, (text, bad) => (bad ? setProblem(text) : setTold(text)));
    },
  };

  if (status === "gone" || (!data && status === "failed"))
    return (
      <Frame mode={mode} drop={drop}>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="text-[13.5px] leading-5 text-[#6B6B6B]">{status === "gone" ? "This file isn't there anymore." : "Couldn't load this file."}</span>
          <button onClick={status === "gone" ? onClose : reload} className="rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium leading-4 text-white">
            {status === "gone" ? "Close" : "Try again"}
          </button>
        </div>
      </Frame>
    );
  if (!data) return <Frame mode={mode} drop={drop}>{null}</Frame>;

  const typeOf = (c: number) => types[c]?.type;
  const money = sum >= 0 ? types[sum]?.money ?? null : null;
  const counted = groups.reduce((n, g) => n + g.count, 0);
  const total = groups.reduce((n, g) => n + g.value, 0);
  const lineWanted = view.kind === "line";
  const kind = lineWanted && groups.length >= 2 ? "line" : "bar";
  const byName = view.groupBy ?? "";
  const title = sum >= 0 ? `${columns[sum]} by ${byName}` : `Rows by ${byName}`;
  // Words and dates to group by (every column when there are none), and always the one it's grouped by now.
  const byChoices = columns.some((_, c) => typeOf(c) !== "number") ? columns.filter((name, c) => typeOf(c) !== "number" || name === view.groupBy) : columns;
  const numberColumns = columns.filter((_, c) => typeOf(c) === "number");
  const visible = order.slice(0, shown);
  if (edit && !visible.includes(edit.row) && order.includes(edit.row)) visible.push(edit.row);
  const filtered = !!pickedGroup || !!search.trim();

  const setView = (v: ChartView) => {
    setStored(v);
    writeView(ws, file, v);
  };
  const startEdit = (row: number, col: number, draft?: string) => {
    closed.current = null;
    setDeleting(null);
    setEdit({ row, col, draft: draft ?? rows[row]?.[col] ?? "" });
  };
  const nextCell = (row: number, col: number, back: boolean) => {
    let r = visible.indexOf(row);
    let c = col + (back ? -1 : 1);
    if (c >= columns.length) [r, c] = [r + 1, 0];
    else if (c < 0) [r, c] = [r - 1, columns.length - 1];
    return r >= 0 && r < visible.length ? { row: visible[r], col: c } : null;
  };
  /** Focus a cell (past the last column: its row's Delete) once it's drawn. */
  const focusCell = (row: number, col: number) => requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)?.focus());
  // The one cell Tab stops at: the one the keyboard was last on, while it's shown, else the first.
  const home = cursor && visible.includes(cursor.row) && cursor.col <= columns.length ? cursor : visible.length ? { row: visible[0], col: 0 } : null;
  const stop = (row: number, col: number) => (home?.row === row && home.col === col ? 0 : -1);
  const onCell = (row: number, col: number) => setCursor((k) => (k?.row === row && k.col === col ? k : { row, col }));
  /** Arrow keys (Home, End; with Command or Control, the table's first and last cell) move from cell to cell. True when one did. */
  const gridKeys = (e: React.KeyboardEvent, row: number, col: number) => {
    const r = visible.indexOf(row);
    const far = e.metaKey || e.ctrlKey;
    let to: { row: number; col: number } | null;
    if (e.key === "ArrowRight") to = { row, col: Math.min(columns.length, col + 1) };
    else if (e.key === "ArrowLeft") to = { row, col: Math.max(0, col - 1) };
    else if (e.key === "ArrowDown") to = r + 1 < visible.length ? { row: visible[r + 1], col } : null;
    else if (e.key === "ArrowUp") to = r > 0 ? { row: visible[r - 1], col } : null;
    else if (e.key === "Home") to = { row: far ? visible[0] : row, col: 0 };
    else if (e.key === "End") to = { row: far ? visible[visible.length - 1] : row, col: columns.length - 1 };
    else return false;
    e.preventDefault();
    if (to) focusCell(to.row, to.col);
    return true;
  };
  /** Close the cell being edited, saving what's typed when it changed, and go on to `then` (Tab). */
  const finish = (row: number, col: number, draft: string, then: { row: number; col: number } | null) => {
    const k = `${row}:${col}`;
    if (closed.current === k) return;
    closed.current = k;
    const before = rows[row];
    if (before && cleanCell(draft) !== before[col]) change([{ op: "set", row, was: before, col, value: draft }]);
    setEdit(then ? { ...then, draft: rows[then.row]?.[then.col] ?? "" } : null);
  };
  const addRow = () => {
    const values = columns.map(() => "");
    // A row added while a group is picked starts in it.
    if (pickedGroup && pickedGroup.key && pickedGroup.key !== OTHER_KEY && by >= 0 && typeOf(by) !== "date") values[by] = pickedGroup.label;
    else setPicked(null);
    setSearch("");
    if (change([{ op: "add", values }])) startEdit(rows.length, 0, values[0]);
  };
  const addColumn = () => {
    if (adding === null || named.current) return;
    named.current = true;
    const name = adding.trim();
    if (!name) return setAdding(null);
    if (change([{ op: "addColumn", name }])) setAdding(null);
    else named.current = false;
  };
  const renameColumn = () => {
    if (!renaming || named.current) return;
    named.current = true;
    const was = columns[renaming.col];
    const name = cleanColumnName(renaming.name);
    if (!name || name === was) return setRenaming(null);
    if (!change([{ op: "renameColumn", col: renaming.col, was, name }])) {
      named.current = false;
      return;
    }
    setRenaming(null);
    // The chart stays on the column under its new name.
    if (view.groupBy === was || view.measure === was) setView({ ...view, groupBy: view.groupBy === was ? name : view.groupBy, measure: view.measure === was ? name : view.measure });
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(columns, rows, { guard: true, bom: true })], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.name}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const notes = [
    grouped?.noValue && sum >= 0 ? `${grouped.noValue === 1 ? "1 row has" : `${grouped.noValue.toLocaleString("en-US")} rows have`} no number in ${columns[sum]}.` : "",
    grouped?.noDate && by >= 0 ? `${grouped.noDate === 1 ? "1 row has" : `${grouped.noDate.toLocaleString("en-US")} rows have`} no date in ${columns[by]}.` : "",
    lineWanted && kind === "bar" && rows.length ? "Line needs dates in at least two months." : "",
  ].filter(Boolean);
  const headCell = "sticky top-0 border-b border-[#ECECEA] bg-white px-3 py-2 text-left align-bottom text-[12.5px] font-medium leading-4 text-[#6B6B6B]";
  const widthOf = (c: number) => (/^notes?$/i.test(columns[c]) ? "min-w-[120px] max-w-[360px]" : "min-w-[120px] max-w-[280px]");

  return (
    <Frame mode={mode} drop={drop}>
      <div className="flex items-start gap-3.5">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
          <CrmBarsIcon size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[20px] font-semibold leading-6 tracking-[-0.01em]">{data.name}</span>
          <span className="text-[13px] leading-[19px] text-[#6B6B6B]">
            {rowsWord(rows.length)}, {columns.length} {columns.length === 1 ? "column" : "columns"}
            {saving === "saving" ? " · Saving…" : saving === "saved" ? " · Saved" : ""}
          </span>
          {problem && <span className="text-[13px] leading-[19px] text-[#B42318]">{problem}</span>}
          {told && !problem && <span className="text-[13px] leading-[19px] text-[#6B6B6B]">{told}</span>}
        </div>
        <div className="mt-1.5 flex shrink-0 gap-1.5">
          {mode === "focus" ? (
            <RingButton label="Back to the side panel" onClick={() => onBack?.()}>
              <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5L14 2M6.5 9.5L2 14" {...STROKE} />
            </RingButton>
          ) : (
            onFocus && (
              <RingButton label="Full width" onClick={onFocus}>
                <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" {...STROKE} />
              </RingButton>
            )
          )}
          <RingButton label="Download CSV" onClick={download}>
            <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" {...STROKE} />
          </RingButton>
          <CloseButton onClick={onClose} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Pick
          label="Group by"
          value={view.groupBy ?? ""}
          onChange={(v) => {
            setPicked(null);
            const type = typeOf(columns.indexOf(v));
            setView({ ...view, groupBy: v, kind: type === "date" ? "line" : "bar" });
          }}
        >
          {byChoices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Pick>
        <Pick label="Show" value={view.measure} onChange={(v) => setView({ ...view, measure: v })}>
          <option value="count">Count of rows</option>
          {numberColumns.map((c) => (
            <option key={c} value={c}>
              Sum of {c}
            </option>
          ))}
        </Pick>
        <div className="flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]">
          {(["bar", "line"] as const).map((k) => {
            const on = (k === "line") === lineWanted;
            const blocked = k === "line" && typeOf(by) !== "date";
            return (
              <button
                key={k}
                aria-pressed={on}
                aria-disabled={blocked || undefined}
                data-tip={blocked ? "Line needs a date column, like Close date." : undefined}
                onClick={() => !blocked && setView({ ...view, kind: k })}
                className={`rounded-full px-2.5 py-1 text-[12px] leading-4 ${on ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : blocked ? "cursor-default text-[#C9C9C6]" : "text-[#6B6B6B] hover:text-ink"}`}
              >
                {k === "bar" ? "Bar" : "Line"}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl px-4 pb-3 pt-3.5 shadow-[0_0_0_1px_#ECECEA]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[14px] font-semibold leading-5">{title}</span>
          {!!rows.length && (
            <span className="shrink-0 text-[12.5px] leading-4 text-[#9A9A98] tabular-nums">{sum >= 0 ? `Total ${formatNumber(total, { money })}` : rowsWord(counted)}</span>
          )}
        </div>
        {rows.length ? (
          <CrmChart groups={groups} kind={kind} title={title} money={money} count={sum < 0} wide={mode === "focus"} selected={pickedGroup ? pickedGroup.key : null} onSelect={setPicked} />
        ) : (
          <div className="py-8 text-center text-[13px] leading-5 text-[#6B6B6B]">No rows yet. Add one below, or ask a bot to add some.</div>
        )}
        {!!notes.length && (
          <div className="flex flex-col gap-0.5">
            {notes.map((n) => (
              <span key={n} className="text-[12px] leading-4 text-[#9A9A98]">
                {n}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.stopPropagation();
                setSearch("");
              }
            }}
            placeholder="Search rows"
            aria-label="Search rows"
            className="h-8 w-[220px] max-w-full rounded-full bg-white px-3.5 text-[13px] shadow-[0_0_0_1px_#E6E6E3] outline-none placeholder:text-[#9A9A98] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
          />
          {pickedGroup && (
            <span className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-[#F2F2F0] pl-2.5 pr-1 text-[12.5px] leading-4 text-[#3A3A38]">
              <span className="max-w-[180px] truncate">
                {byName}: {pickedGroup.label}
              </span>
              <button aria-label="Clear filter" onClick={() => setPicked(null)} className="flex size-5 shrink-0 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-black/[0.06] hover:text-ink">
                <svg width="8" height="8" viewBox="0 0 12 12" aria-hidden>
                  <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          )}
          {filtered && (
            <>
              <span className="shrink-0 text-[12.5px] leading-4 text-[#9A9A98] tabular-nums">{rowsWord(order.length)}</span>
              <button
                onClick={() => {
                  setPicked(null);
                  setSearch("");
                }}
                className="shrink-0 text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:text-ink"
              >
                Clear
              </button>
            </>
          )}
          <button onClick={addRow} className="ml-auto shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
            + Add row
          </button>
        </div>

        <div ref={scroller} className="max-h-[70vh] overflow-auto rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
          <table ref={grid} role="grid" aria-label={`${data.name} rows`} className="w-max min-w-full border-separate border-spacing-0 text-[13px] leading-[18px] text-[#3A3A38]">
            <thead>
              <tr>
                {columns.map((name, c) => {
                  const right = typeOf(c) === "number";
                  return (
                    <th key={`${c}:${name}`} aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={`${headCell} z-[2]`}>
                      {renaming?.col === c ? (
                        <input
                          autoFocus
                          value={renaming.name}
                          onChange={(e) => setRenaming({ col: c, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") renameColumn();
                            else if (e.key === "Escape") {
                              e.stopPropagation();
                              setRenaming(null);
                            }
                          }}
                          onBlur={renameColumn}
                          aria-label="Column name"
                          className={`h-6 w-full min-w-[110px] rounded-[6px] bg-[#F4F4F2] px-1.5 text-[12.5px] font-medium text-ink outline-none focus:shadow-[0_0_0_1.5px_#0A0A0A] ${widthOf(c)}`}
                        />
                      ) : (
                        <button
                          onClick={(e) => {
                            if (e.detail > 1) return;
                            sortBefore.current = sort;
                            setSort(!sort || sort.col !== c ? { col: c, dir: 1 } : sort.dir === 1 ? { col: c, dir: -1 } : null);
                          }}
                          onDoubleClick={() => {
                            setSort(sortBefore.current);
                            named.current = false;
                            setAdding(null);
                            setRenaming({ col: c, name });
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "F2") return;
                            e.preventDefault();
                            named.current = false;
                            setAdding(null);
                            setRenaming({ col: c, name });
                          }}
                          title="Click to sort. Double-click or press F2 to rename."
                          className={`flex w-full items-center gap-1 ${right ? "justify-end" : ""} ${widthOf(c)} hover:text-ink`}
                        >
                          <span className="truncate">{name}</span>
                          {sort?.col === c && (
                            <svg width="9" height="9" viewBox="0 0 12 12" className="shrink-0" aria-hidden>
                              <path d={sort.dir === 1 ? "M3 7.5l3-3 3 3" : "M3 4.5l3 3 3-3"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </button>
                      )}
                    </th>
                  );
                })}
                <th className={`${headCell} z-[2] w-0 whitespace-nowrap`}>
                  {adding === null ? (
                    <button
                      onClick={() => {
                        named.current = false;
                        setRenaming(null);
                        setAdding("");
                      }}
                      className="font-medium text-[#6B6B6B] hover:text-ink"
                    >
                      + Add column
                    </button>
                  ) : (
                    <input
                      autoFocus
                      value={adding}
                      onChange={(e) => setAdding(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addColumn();
                        else if (e.key === "Escape") {
                          e.stopPropagation();
                          setAdding(null);
                        }
                      }}
                      onBlur={addColumn}
                      placeholder="Column name"
                      aria-label="Column name"
                      className="h-6 w-[130px] rounded-[6px] bg-[#F4F4F2] px-1.5 text-[12.5px] font-medium text-ink outline-none placeholder:font-normal placeholder:text-[#9A9A98] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
                    />
                  )}
                </th>
                {/* Over each row's Delete, pinned to the right edge. */}
                <th className={`sticky right-0 top-0 z-[3] w-0 border-b border-[#ECECEA] bg-white px-2 py-1 align-middle ${more ? PINNED_SHADOW : ""}`}>
                  {(more || across) && (
                    <button
                      aria-label={more ? "More columns" : "Back to the first columns"}
                      onClick={() => {
                        const el = scroller.current;
                        if (!el) return;
                        if (more) el.scrollBy({ left: Math.max(160, el.clientWidth - 240), behavior: "smooth" });
                        else el.scrollTo({ left: 0, behavior: "smooth" });
                      }}
                      className="ml-auto flex size-6 items-center justify-center rounded-md text-[#6B6B6B] hover:bg-black/[0.06] hover:text-ink"
                    >
                      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
                        <path d={more ? "M4.5 2.5L8 6l-3.5 3.5" : "M7.5 2.5L4 6l3.5 3.5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i} className="group/row">
                  {columns.map((_, c) => {
                    const v = rows[i]?.[c] ?? "";
                    const right = typeOf(c) === "number";
                    const editing = edit?.row === i && edit.col === c;
                    return (
                      <td
                        key={c}
                        data-cell={`${i}:${c}`}
                        tabIndex={editing ? -1 : stop(i, c)}
                        onFocus={(e) => e.target === e.currentTarget && onCell(i, c)}
                        onClick={() => !editing && startEdit(i, c)}
                        onKeyDown={(e) => {
                          if (editing || e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === "F2") {
                            e.preventDefault();
                            startEdit(i, c);
                          } else gridKeys(e, i, c);
                        }}
                        className={`border-b border-[#F0F0EE] px-3 align-top outline-none group-hover/row:bg-black/[0.02] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A] ${editing ? "py-1" : "cursor-text py-2"}`}
                      >
                        {editing ? (
                          <textarea
                            autoFocus
                            rows={1}
                            value={edit.draft}
                            ref={(el) => {
                              if (el) {
                                el.style.height = "auto";
                                el.style.height = `${el.scrollHeight}px`;
                              }
                            }}
                            onChange={(e) => setEdit({ row: i, col: c, draft: e.target.value })}
                            onKeyDown={(e) => {
                              // Back on the cell after Enter, Esc, or Tab past the last one, so the keyboard keeps its place.
                              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                finish(i, c, edit.draft, null);
                                focusCell(i, c);
                              } else if (e.key === "Tab") {
                                e.preventDefault();
                                const then = nextCell(i, c, e.shiftKey);
                                finish(i, c, edit.draft, then);
                                if (!then) focusCell(i, c);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                e.stopPropagation();
                                closed.current = `${i}:${c}`;
                                setEdit(null);
                                focusCell(i, c);
                              }
                            }}
                            onBlur={() => finish(i, c, edit.draft, null)}
                            aria-label={`${columns[c]}, row ${i + 1}`}
                            className={`block w-full resize-none overflow-hidden rounded-[6px] bg-[#F4F4F2] px-1.5 py-1 text-[13px] leading-[18px] text-ink outline-none focus:shadow-[0_0_0_1.5px_#0A0A0A] ${widthOf(c)} ${right ? "text-right tabular-nums" : ""}`}
                          />
                        ) : (
                          <div className={`line-clamp-2 whitespace-pre-wrap break-words ${widthOf(c)} ${right ? "text-right tabular-nums" : ""}`}>{v}</div>
                        )}
                      </td>
                    );
                  })}
                  {/* Under "+ Add column". */}
                  <td className="border-b border-[#F0F0EE] group-hover/row:bg-black/[0.02]" />
                  <td className={`sticky right-0 z-[1] border-b border-[#F0F0EE] bg-white px-2 py-1 text-right align-middle group-hover/row:bg-[#FAFAFA] ${more ? PINNED_SHADOW : ""}`}>
                    {deleting === i ? (
                      <span
                        ref={reveal}
                        className="flex items-center justify-end gap-1"
                        onKeyDown={(e) => {
                          if (e.key !== "Escape") return;
                          e.stopPropagation();
                          setDeleting(null);
                          focusCell(i, columns.length);
                        }}
                      >
                        <button
                          autoFocus
                          onClick={(e) => {
                            // From the keyboard: on to the next row's Delete (rows after this one move up by one).
                            const r = visible.indexOf(i);
                            const next = visible[r + 1] ?? visible[r - 1];
                            setDeleting(null);
                            if (change([{ op: "delete", row: i, was: rows[i] }]) && e.detail === 0 && next !== undefined) focusCell(next > i ? next - 1 : next, columns.length);
                          }}
                          className="rounded-full bg-[#B42318] px-2.5 py-1 text-[12px] font-semibold leading-4 text-white"
                        >
                          Delete
                        </button>
                        <button
                          onClick={(e) => {
                            setDeleting(null);
                            if (e.detail === 0) focusCell(i, columns.length);
                          }}
                          className="rounded-full px-2 py-1 text-[12px] leading-4 text-[#6B6B6B]"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        aria-label="Delete row"
                        data-cell={`${i}:${columns.length}`}
                        tabIndex={stop(i, columns.length)}
                        onFocus={() => onCell(i, columns.length)}
                        onKeyDown={(e) => gridKeys(e, i, columns.length)}
                        onClick={() => setDeleting(i)}
                        className="ml-auto flex size-6 items-center justify-center rounded-md text-[#9A9A98] opacity-0 hover:bg-black/[0.06] hover:text-[#B42318] focus-visible:opacity-100 group-hover/row:opacity-100"
                      >
                        <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
                          <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-1">
          <button onClick={addRow} className="text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:text-ink">
            + Add row
          </button>
          <span className="flex-1" />
          {!!rows.length && !order.length && <span className="text-[12.5px] leading-4 text-[#9A9A98]">No rows match.</span>}
          {order.length > shown && (
            <>
              <span className="text-[12.5px] leading-4 text-[#9A9A98] tabular-nums">
                Showing {shown.toLocaleString("en-US")} of {rowsWord(order.length)}.
              </span>
              <button onClick={() => setShown(shown + CRM_LIMITS.tableRows)} className="text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:text-ink">
                Show 200 more
              </button>
            </>
          )}
        </div>
      </div>
    </Frame>
  );
}

type Drop = {
  dropping: boolean;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
};

/** The tab's page: it scrolls, fills the side panel, and in full width is capped and centered. A CSV dropped on it is added. */
function Frame({ mode, drop, children }: { mode: "panel" | "focus"; drop: Drop; children: React.ReactNode }) {
  const { dropping, ...on } = drop;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...on}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-8 pt-7">
        <div className={`flex w-full flex-col gap-5 ${mode === "focus" ? "mx-auto max-w-[1200px]" : ""}`}>{children}</div>
      </div>
      {dropping && (
        <div className="pointer-events-none absolute inset-2 flex items-start justify-center rounded-2xl pt-4 shadow-[inset_0_0_0_1.5px_#0A0A0A]">
          <span className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white">Drop a CSV to add it</span>
        </div>
      )}
    </div>
  );
}

/* ---------------- The note in the chat ---------------- */

/** "Boppy added 3 rows to Leads", with Open and Undo (lib/server/crm.ts undoNote). */
export function CrmNote({ m }: { m: Message }) {
  const c = m.crm!;
  const open = useContext(OpenCrm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);
  const undo = async () => {
    setBusy(true);
    const r = await post("/api/crm/undo", { messageId: m.id });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't undo it. Try again.");
    announce();
    setBusy(false);
  };
  const button = "shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium leading-4 text-ink hover:bg-black/[0.05] disabled:opacity-40";
  return (
    <div className="flex w-full max-w-[400px] flex-col self-center rounded-[14px] bg-[#F7F7F6] py-2 pl-3 pr-1.5 text-[12px] leading-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[#9A9A98]">
          <CrmFileIcon size={13} />
        </span>
        <span className={`min-w-0 flex-1 ${c.undone ? "text-[#9A9A98] line-through" : "text-[#3A3A3A]"}`}>{m.text}</span>
        {open && !(c.undone && c.created) && (
          <button onClick={() => open(c.ws, c.file)} className={button}>
            Open
          </button>
        )}
        {c.undone ? (
          <span className="shrink-0 px-2 py-0.5 font-medium text-[#9A9A98]">Undone</span>
        ) : (
          <button disabled={busy} onClick={() => void undo()} className={button}>
            Undo
          </button>
        )}
      </div>
      {error && <span className="pl-[21px] pt-1 text-[#B42318]">{error}</span>}
    </div>
  );
}
