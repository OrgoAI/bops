/**
 * The CRM's files: plain CSV that the user's bots and the user share. A file is a header row of column
 * names and rows of text cells, nothing else: whether a column holds numbers, dates or words is worked
 * out each time it's read, and the chart groups and adds up rows the same way for the app and for the
 * bots (crm_read). The server keeps the files (lib/server/crm.ts); this module only reads and writes
 * their text. Shared by the server and the app (no server imports).
 */

/** How big things may get. Each refusal says it in CRM_SAY. */
export const CRM_LIMITS = {
  /** Files in one workspace. */
  files: 50,
  bytes: 2 * 1024 * 1024,
  rows: 5_000,
  columns: 40,
  columnName: 64,
  cell: 2_000,
  fileName: 60,
  /** Rows a bot saves in one call. */
  botRows: 50,
  /** Rows a bot reads in one call: unless it says, and at most. */
  readRows: 50,
  readRowsMax: 200,
  /** What a bot reads is cut at this many characters, and each cell in it at readCell. */
  readChars: 14_000,
  readCell: 300,
  /** Changes the app sends in one save. */
  ops: 200,
  /** Rows the table draws at a time. */
  tableRows: 200,
  /** Bars before the rest fold into "Other". */
  groups: 12,
  /** Copies kept for undoing bots' saves, per workspace, and for how many days. */
  snapshots: 100,
  snapshotDays: 30,
  /** Deleted files kept per workspace. */
  trash: 20,
} as const;

/** What Bops says when something can't be done, in plain words (the app and the bots read the same). */
export const CRM_SAY = {
  files: "This workspace has 50 CRM files, the most it can have. Delete one to add another.",
  bytes: "That file is over 2 MB. Split it or remove columns, then try again.",
  rows: "That file has more than 5,000 rows. Split it, then try again.",
  columns: "That file has more than 40 columns. Remove some, then try again.",
  addColumn: "A file can have 40 columns at most.",
  addRow: "A file can have 5,000 rows at most.",
  fileName: "Use letters, numbers, spaces and _ ( ) & ' - in a file name, 60 at most.",
  nameFile: "Name the file.",
  nameColumn: "Name the column.",
  cut: "Some cells were over 2,000 characters and were cut.",
  empty: "That file is empty.",
  notCsv: "Bops opens CSV files. In Numbers, Excel or Google Sheets, export a CSV first.",
  cantOpen: "That file can't be opened here.",
  gone: "That file isn't there anymore.",
  changed: "That row changed while you were editing. Showing the latest.",
  badChange: "That change didn't make sense. Showing the latest.",
  signIn: "Sign in to Bops first.",
  noWorkspace: "No such workspace.",
} as const;

export const fileTaken = (name: string) => `There's already a file called ${name}.`;
export const columnTaken = (name: string) => `There's already a column called ${name}.`;

/** A new pipeline's columns, and the stages a deal goes through (the chart keeps them in this order). */
export const PIPELINE_COLUMNS = ["Name", "Company", "Email", "Stage", "Value", "Owner", "Close date", "Notes"] as const;
export const PIPELINE_STAGES = ["Lead", "Qualified", "Proposal", "Won", "Lost"] as const;

/** The example file every workspace starts with (once: deleting it is for good). Made-up people at example.com. */
export const SAMPLE_NAME = "Sample pipeline";
export const SAMPLE_PIPELINE = `Name,Company,Email,Stage,Value,Owner,Close date,Notes
Jordan Lee,Northwind Dental,jordan@example.com,Proposal,"$12,000",Alex,2026-10-24,Wants a demo for 3 locations
Priya Shah,Bluebird Bakery,priya@example.com,Won,"$4,800",Morgan,2026-10-02,Signed. Starts Monday
Marcus Hill,Harbor Fitness,marcus@example.com,Qualified,"$9,500",Alex,2026-11-14,Budget approved for Q4
Elena Ruiz,Cedar Law,elena@example.com,Lead,"$6,000",Riley,2026-12-05,Met at the chamber event
Chris Wong,Summit Roofing,chris@example.com,Proposal,"$18,500",Morgan,2026-11-03,"Sent pricing, follow up Friday"
Taylor Brooks,Lumen Studio,taylor@example.com,Lost,"$7,200",Riley,2026-09-30,Went with a cheaper option
Dana Kim,Orchard Cafe,dana@example.com,Lead,"$3,000",Alex,2027-01-15,Asked for a call next month
Avery Johnson,Atlas Logistics,avery@example.com,Qualified,"$24,000",Morgan,2026-12-12,Needs sign off from finance
Noah Patel,Pine Street Books,noah@example.com,Won,"$2,500",Alex,2026-09-18,Paid the first invoice
Mia Torres,Riverbend Vet,mia@example.com,Proposal,"$8,800",Riley,2026-10-29,Comparing two plans
Leo Martin,Copperline HVAC,leo@example.com,Lead,"$15,000",Morgan,2027-01-08,Referral from Priya
Grace Okafor,Willow Yoga,grace@example.com,Qualified,"$5,400",Alex,2026-11-20,Wants monthly billing
`;

/** A file in the sidebar's list. */
export type CrmFileMeta = { name: string; rows: number; columns: string[]; bytes: number; updatedAt: number; sample: boolean };
/** A file as the tab shows it. `version` changes with every save (the first 12 hex digits of its bytes' SHA-1). */
export type CrmFileData = { name: string; columns: string[]; rows: string[][]; version: string; updatedAt: number };

export type CsvTable = { columns: string[]; rows: string[][] };

/* ---------------- Cells and names ---------------- */

// Control characters, except the newline a cell may hold (tabs and carriage returns are turned into a space and a newline first).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** At most `n` UTF-16 units, without leaving half of a character at the end. */
function cutTo(s: string, n: number) {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** A cell as it's kept: text only, no control characters, one kind of line break, no tabs, trimmed, 2,000 characters at most. */
export function cleanCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : "";
  const out = s.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL, "").trim();
  return out.length > CRM_LIMITS.cell ? cutTo(out, CRM_LIMITS.cell).trimEnd() : out;
}

/** Whether a cell is longer than cleanCell keeps. */
const tooLong = (v: string) => v.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim().length > CRM_LIMITS.cell;

/**
 * A cell as it goes into a CSV someone opens in a spreadsheet: one that starts like a formula
 * (= + - @, a tab or a carriage return) gets a ' in front, so Numbers or Excel shows it rather than
 * running it. A plain number ("-5", "+1,200.50") stays as it is. Only for files leaving Bops
 * (Download CSV); the files themselves keep what was typed.
 */
export function guardCell(v: string) {
  return /^[=+\-@\t\r]/.test(v) && !/^[+-]?\d[\d,]*(\.\d+)?$/.test(v) ? `'${v}` : v;
}

/** A file name as typed, made tidy (NFC, single spaces); null when it can't be a file's name. A trailing ".csv" is dropped. */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFC").replace(/\s+/g, " ").trim().replace(/\.csv$/i, "").trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} _()&'-]{0,59}$/u.test(s) ? s : null;
}

/** A column name, tidy and 64 characters at most; null when there's nothing left. */
export function cleanColumnName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = cutTo(cleanCell(raw).normalize("NFC").replace(/\s+/g, " ").trim(), CRM_LIMITS.columnName).trim();
  return s || null;
}

/** Names for a file's columns: empty ones become "Column 3", and a repeat (case ignored) "Email 2". */
function columnNames(raw: string[]) {
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const base = cleanColumnName(r) ?? `Column ${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${cutTo(base, CRM_LIMITS.columnName - String(n).length - 1).trimEnd()} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

/* ---------------- Reading and writing CSV ---------------- */

/** The delimiter a file uses: whichever of comma, semicolon or tab its first line has most of, outside quotes. A tie goes to the comma. */
export function sniffDelimiter(text: string) {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let i = 0;
  // Blank lines before the header don't count.
  while (i < text.length && (text[i] === "\n" || text[i] === "\r")) i++;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

/** The records in CSV text (RFC 4180, forgiving): each line's cells, and whether the line had nothing on it at all. */
function records(text: string, d: string) {
  const out: { cells: string[]; empty: boolean }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let fieldStart = true;
  let any = false;
  const end = () => {
    cells.push(cell);
    out.push({ cells, empty: !any });
    cells = [];
    cell = "";
    fieldStart = true;
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      any = true;
    } else if (ch === d) {
      cells.push(cell);
      cell = "";
      fieldStart = true;
      any = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      end();
    } else {
      cell += ch;
      fieldStart = false;
      any = true;
    }
  }
  if (any || cells.length) end();
  return out;
}

/**
 * CSV text as columns and rows. The first row that isn't blank names the columns. Rows come out as
 * wide as the widest one: short ones are filled with "", and cells past the header add columns
 * ("Column 9"). A byte order mark is dropped; the delimiter is sniffed unless given. Rows that are
 * entirely blank are dropped, unless `keepBlankRows` (a file Bops wrote, where an empty row is one the
 * user added). `cut` counts cells over 2,000 characters, which are cut.
 */
export function parseCsv(text: string, opts: { delimiter?: string; keepBlankRows?: boolean } = {}): CsvTable & { cut: number } {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const recs = records(t, opts.delimiter ?? sniffDelimiter(t)).filter((r) => !r.empty);
  const blank = (cells: string[]) => cells.every((c) => !c.trim());
  const at = recs.findIndex((r) => !blank(r.cells));
  if (at < 0) return { columns: [], rows: [], cut: 0 };
  const head = recs[at].cells;
  const body = recs.slice(at + 1).map((r) => r.cells).filter((cells) => opts.keepBlankRows || !blank(cells));
  let width = head.length;
  for (const r of body) width = Math.max(width, r.length);
  const columns = columnNames(Array.from({ length: width }, (_, i) => head[i] ?? ""));
  let cut = 0;
  const rows = body.map((r) =>
    Array.from({ length: width }, (_, i) => {
      const raw = r[i] ?? "";
      if (raw.length > CRM_LIMITS.cell && tooLong(raw)) cut++;
      return cleanCell(raw);
    }),
  );
  return { columns, rows, cut };
}

/** Rows padded (or cut) to `width` cells. */
const fit = (row: string[], width: number) => Array.from({ length: width }, (_, i) => row[i] ?? "");

/**
 * Columns and rows as CSV: commas, CRLF line ends, a cell in quotes when it has a comma, a quote, a
 * line break, or a space at either end. `guard` and `bom` are for Download CSV: formula-looking
 * cells guarded (guardCell), and a byte order mark so Excel reads it as UTF-8.
 */
export function toCsv(columns: string[], rows: string[][], opts: { guard?: boolean; bom?: boolean } = {}) {
  const field = (v: string) => {
    const s = opts.guard ? guardCell(v) : v;
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // A row of one empty cell is written "" so it isn't read back as a blank line.
  const line = (cells: string[]) => (cells.length === 1 && cells[0] === "" ? '""' : cells.map(field).join(","));
  const lines = [columns, ...rows.map((r) => fit(r, columns.length))].map(line);
  return `${opts.bom ? "\uFEFF" : ""}${lines.join("\r\n")}\r\n`;
}

/* ---------------- Numbers and dates ---------------- */

/**
 * A cell as a number, or null: "$12,000", "€9.50", "12%" (12), "(1,200)" (-1200), "1 200". Commas and
 * spaces only as thousands separators, so "+1 555 0100" and "02134" stay text. What a European
 * spreadsheet writes reads too when it can only mean one thing: "4.200,50", "1.234.567", "12,5",
 * "4.200,00 €" ("4.200" alone is 4.2).
 */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1].trim();
  }
  let sign = "";
  if (/^[+-]/.test(s)) {
    sign = s[0];
    s = s.slice(1).trim();
  }
  if (/^[$€£]/.test(s)) s = s.slice(1).trim();
  else s = s.replace(/\s?[$€£]$/, "");
  if (!sign && /^[+-]/.test(s)) {
    sign = s[0];
    s = s.slice(1).trim();
  }
  s = s.replace(/%$/, "").trim();
  // European: dots between thousands and a decimal comma, more than one dot group, or a comma and one or two decimals.
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s) || /^\d{1,3}(\.\d{3}){2,}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  if (/[, ]/.test(s)) {
    if (!/^\d{1,3}([, ]\d{3})+(\.\d+)?$/.test(s) || (s.includes(",") && s.includes(" "))) return null;
    s = s.replace(/[, ]/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(s) || /^0\d/.test(s)) return null;
  const n = Number(s) * (sign === "-" ? -1 : 1) * (negative ? -1 : 1);
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT_MONTHS = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1, 3));
const monthOf = (word: string) => {
  const w = word.toLowerCase();
  if (w === "sept") return 9;
  return w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) + 1 : 0;
};
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * A cell as a calendar date, or null: 2026-10-24 (a time after it is fine), 2026-10, 10/24/2026,
 * 10/24/26, Oct 24, 2026, 24 Oct 2026, and 24.10.2026 as European spreadsheets write it. Never through
 * `new Date(text)`, which moves dates by the time zone.
 */
export function parseDate(v: unknown): { y: number; m: number; d: number } | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let y = 0;
  let m = 0;
  let d = 1;
  let x: RegExpExecArray | null;
  if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = /^(\d{4})-(\d{1,2})$/.exec(s))) [y, m] = [+x[1], +x[2]];
  else if ((x = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(s))) [m, d, y] = [+x[1], +x[2], x[3].length === 2 ? 2000 + +x[3] : +x[3]];
  else if ((x = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) [d, m, y] = [+x[1], +x[2], +x[3]];
  else if ((x = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) [m, d, y] = [monthOf(x[1]), +x[2], +x[3]];
  else if ((x = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) [d, m, y] = [+x[1], monthOf(x[2]), +x[3]];
  else return null;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return { y, m, d };
}

/** "Oct 2026". */
export const monthLabel = (y: number, m: number) => `${SHORT_MONTHS[m - 1]} ${y}`;

/* ---------------- Columns, grouping, totals ---------------- */

export type ColumnType = "number" | "date" | "text";
export type ColumnInfo = { name: string; type: ColumnType; distinct: number; money: string | null };

/**
 * What each column holds, from its cells: numbers when 80% of the filled ones are (and money, "$",
 * when half of them start with the symbol), dates when 80% are, words otherwise. `distinct` counts
 * different filled values, case ignored.
 */
export function inferColumns(columns: string[], rows: string[][]): ColumnInfo[] {
  return columns.map((name, c) => {
    let filled = 0;
    let numbers = 0;
    let dates = 0;
    const symbols: Record<string, number> = { $: 0, "€": 0, "£": 0 };
    const distinct = new Set<string>();
    for (const r of rows) {
      const v = (r[c] ?? "").trim();
      if (!v) continue;
      filled++;
      distinct.add(v.toLowerCase());
      if (parseNumber(v) !== null) numbers++;
      else if (parseDate(v)) dates++;
      // The currency symbol in front ($12,000) or, as European spreadsheets write it, after (4.200,00 €).
      const first = v.replace(/^[(+-]\s*/, "")[0];
      const last = v.replace(/\)$/, "").trimEnd().at(-1) ?? "";
      if (first in symbols) symbols[first]++;
      else if (last in symbols) symbols[last]++;
    }
    const type: ColumnType = filled && numbers / filled >= 0.8 ? "number" : filled && dates / filled >= 0.8 ? "date" : "text";
    const [symbol, uses] = Object.entries(symbols).sort((a, b) => b[1] - a[1])[0];
    return { name, type, distinct: distinct.size, money: type === "number" && uses && uses / filled >= 0.5 ? symbol : null };
  });
}

/** How a file's chart is set: the column it groups by, what it adds up ("count" or a number column's name), and bars or a line. */
export type CrmView = { groupBy: string | null; measure: "count" | string; kind: "bar" | "line" };

const GROUP_NAMES = ["stage", "status", "owner", "source", "type", "company"];
const VALUE_NAMES = ["value", "amount", "revenue", "price", "deal value", "deal size", "mrr", "arr"];

/**
 * The chart a file opens with: grouped by the first of Stage, Status, Owner, Source, Type or Company
 * that's words with 20 values or fewer (else any such column with 2 to 20, else a date column, else
 * the first), adding up the first of Value, Amount, Revenue, Price, Deal value, Deal size, MRR or ARR
 * (else counting rows); a line over time for a date column, bars otherwise.
 */
export function defaultView(columns: string[], types: ColumnInfo[]): CrmView {
  const text = types.filter((t) => t.type === "text");
  const named = GROUP_NAMES.map((n) => text.find((t) => t.name.toLowerCase() === n && t.distinct <= 20)).find(Boolean);
  const group = named ?? text.find((t) => t.distinct >= 2 && t.distinct <= 20) ?? types.find((t) => t.type === "date") ?? types[0];
  const numbers = types.filter((t) => t.type === "number");
  const value = VALUE_NAMES.map((n) => numbers.find((t) => t.name.toLowerCase() === n)).find(Boolean);
  return { groupBy: group?.name ?? (columns[0] || null), measure: value?.name ?? "count", kind: group?.type === "date" ? "line" : "bar" };
}

/** One bar (or point): the rows in it by their place in the file, how many, and their total (the sum, or the count). */
export type Group = { key: string; label: string; count: number; value: number; rows: number[] };
/** The bar that holds the groups past the first 12. */
export const OTHER_KEY = "\u0000other";

const STAGE_ORDER = PIPELINE_STAGES.map((s) => s.toLowerCase());

/**
 * Rows grouped by column `by` (of type `type`), each group's total the sum of column `sum`, or the
 * count when `sum` is null. Words group with case ignored (shown as their most common spelling,
 * empty as "Blank"), largest first, or in pipeline order when every value is a stage; past 12 groups
 * the rest fold into "Other (N)". Dates group by month, in order, with the months between filled in
 * (by year past 36 months). `noValue` counts rows whose `sum` cell isn't a number, `noDate` rows
 * without a date.
 */
export function groupRows(rows: string[][], by: number, type: ColumnType, sum: number | null): { groups: Group[]; noValue: number; noDate: number } {
  let noValue = 0;
  let noDate = 0;
  const add = (g: Group, i: number) => {
    g.count++;
    g.rows.push(i);
    if (sum === null) g.value++;
    else {
      const n = parseNumber(rows[i][sum] ?? "");
      if (n === null) noValue++;
      else g.value += n;
    }
  };

  if (type === "date") {
    const dated: { i: number; at: number }[] = [];
    rows.forEach((r, i) => {
      const d = parseDate(r[by] ?? "");
      if (d) dated.push({ i, at: d.y * 12 + d.m - 1 });
      else noDate++;
    });
    if (!dated.length) return { groups: [], noValue, noDate };
    let first = Infinity;
    let last = -Infinity;
    for (const x of dated) {
      first = Math.min(first, x.at);
      last = Math.max(last, x.at);
    }
    const byYear = last - first + 1 > 36;
    const groups: Group[] = [];
    const at = new Map<number, Group>();
    for (let k = byYear ? Math.floor(first / 12) : first; k <= (byYear ? Math.floor(last / 12) : last); k++) {
      const y = byYear ? k : Math.floor(k / 12);
      const m = k % 12 + 1;
      const g: Group = byYear ? { key: String(y), label: String(y), count: 0, value: 0, rows: [] } : { key: `${y}-${String(m).padStart(2, "0")}`, label: monthLabel(y, m), count: 0, value: 0, rows: [] };
      groups.push(g);
      at.set(k, g);
    }
    for (const x of dated) add(at.get(byYear ? Math.floor(x.at / 12) : x.at)!, x.i);
    return { groups, noValue, noDate };
  }

  const byKey = new Map<string, Group & { spellings: Map<string, number> }>();
  rows.forEach((r, i) => {
    const raw = (r[by] ?? "").trim();
    const key = raw.toLowerCase();
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { key, label: raw || "Blank", count: 0, value: 0, rows: [], spellings: new Map() }));
    g.spellings.set(raw, (g.spellings.get(raw) ?? 0) + 1);
    add(g, i);
  });
  let groups: Group[] = [...byKey.values()].map(({ spellings, ...g }) => ({ ...g, label: g.key ? [...spellings].sort((a, b) => b[1] - a[1])[0][0] : "Blank" }));
  const named = groups.filter((g) => g.key);
  if (named.length && named.every((g) => STAGE_ORDER.includes(g.key))) {
    const place = (g: Group) => (g.key ? STAGE_ORDER.indexOf(g.key) : STAGE_ORDER.length);
    groups.sort((a, b) => place(a) - place(b));
  } else groups.sort((a, b) => b.value - a.value);
  if (groups.length > CRM_LIMITS.groups) {
    const rest = groups.slice(CRM_LIMITS.groups);
    const other: Group = {
      key: OTHER_KEY,
      label: `Other (${rest.length})`,
      count: rest.reduce((n, g) => n + g.count, 0),
      value: rest.reduce((n, g) => n + g.value, 0),
      rows: rest.flatMap((g) => g.rows).sort((a, b) => a - b),
    };
    groups = [...groups.slice(0, CRM_LIMITS.groups), other];
  }
  return { groups, noValue, noDate };
}

/** About `count` round numbers from at or below `min` to at or above `max`, for an axis (whole numbers only with `whole`, for counts). */
export function niceTicks(min: number, max: number, count = 4, whole = false): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) return [0, 1];
    if (min > 0) min = 0;
    else max = 0;
  }
  const rough = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(rough));
  const nice = [1, 2, 2.5, 5, 10].map((f) => f * power).find((s) => s >= rough) ?? 10 * power;
  const step = whole ? Math.max(1, Math.round(nice)) : nice;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** A number as people read it (en-US): "$116,700", or short with `compact` ("$39.3K", "1.2M"). */
export function formatNumber(n: number, opts: { money?: string | null; compact?: boolean } = {}) {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  let body: string;
  if (opts.compact && a >= 1000) {
    const units = [
      [1e12, "T"],
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "K"],
    ] as const;
    let i = units.findIndex(([u]) => a >= u);
    let v = Math.round((a / units[i][0]) * 10) / 10;
    if (v >= 1000 && i > 0) {
      i--;
      v = Math.round((a / units[i][0]) * 10) / 10;
    }
    body = `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${units[i][1]}`;
  } else body = a.toLocaleString("en-US", { maximumFractionDigits: opts.compact ? 1 : 2 });
  return `${sign}${opts.money ?? ""}${body}`;
}

/* ---------------- Changes from the app ---------------- */

/**
 * One change the user made in the table. A row is found by its place in the file and what it held
 * (`was`): if it isn't there as it was, the change is refused (someone else changed the file).
 */
export type CrmOp =
  | { op: "set"; row: number; was: string[]; col: number; value: string }
  | { op: "add"; values: string[] }
  | { op: "delete"; row: number; was: string[] }
  | { op: "addColumn"; name: string }
  | { op: "renameColumn"; col: number; was: string; name: string };

/**
 * Changes applied in order, to copies: the app shows the result at once, and the server saves it.
 * `conflict` when a row or column isn't as the change expected; `error` (in plain words) when it
 * can't be done at all.
 */
export function applyOps(columns: string[], rows: string[][], ops: CrmOp[]): CsvTable | { conflict: true } | { error: string } {
  const cols = [...columns];
  let out = rows.map((r) => fit(r, cols.length));
  const asWas = (row: string[] | undefined, was: unknown) => !!row && Array.isArray(was) && cols.every((_, i) => row[i] === cleanCell(was[i]));
  for (const o of ops as unknown[]) {
    const x = (o ?? {}) as Record<string, unknown>;
    const row = typeof x.row === "number" && Number.isInteger(x.row) ? out[x.row] : undefined;
    const col = typeof x.col === "number" && Number.isInteger(x.col) && x.col >= 0 && x.col < cols.length ? x.col : -1;
    switch (x.op) {
      case "set":
        if (col < 0 || !asWas(row, x.was)) return { conflict: true };
        row![col] = cleanCell(x.value);
        break;
      case "add":
        if (out.length >= CRM_LIMITS.rows) return { error: CRM_SAY.addRow };
        out.push(cols.map((_, i) => cleanCell(Array.isArray(x.values) ? x.values[i] : "")));
        break;
      case "delete":
        if (!asWas(row, x.was)) return { conflict: true };
        out.splice(x.row as number, 1);
        break;
      case "addColumn": {
        const name = cleanColumnName(x.name);
        if (!name) return { error: CRM_SAY.nameColumn };
        if (cols.some((c) => c.toLowerCase() === name.toLowerCase())) return { error: columnTaken(name) };
        if (cols.length >= CRM_LIMITS.columns) return { error: CRM_SAY.addColumn };
        cols.push(name);
        out = out.map((r) => [...r, ""]);
        break;
      }
      case "renameColumn": {
        if (col < 0 || cols[col] !== x.was) return { conflict: true };
        const name = cleanColumnName(x.name);
        if (!name) return { error: CRM_SAY.nameColumn };
        if (cols.some((c, i) => i !== col && c.toLowerCase() === name.toLowerCase())) return { error: columnTaken(name) };
        cols[col] = name;
        break;
      }
      default:
        return { error: CRM_SAY.badChange };
    }
  }
  return { columns: cols, rows: out };
}
