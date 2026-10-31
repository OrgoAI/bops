import type { HostedSite, LocalSite } from "./hosted-apps";

/*
 * An app's page beside its bot's chat (components/app/preview-tab.tsx), as Lovable shows the app being built, in
 * what can be said without a window: which of its three places it can show (Local, Preview, Published) and why not
 * when it can't, the widths a page is seen at, when Fix it is offered and what it sends, and Select's script and what
 * Bops keeps of what it answers. Plain functions, so scripts/test-preview-tools.mjs runs them in node.
 */

/* ---------------- Its places: Local, Preview and Published ---------------- */

/** Where the page beside the chat is from: the site's Local, its Preview link, or Published (its own domain). */
export type Place = "local" | "preview" | "prod";
export const PLACES: readonly Place[] = ["local", "preview", "prod"];
export const PLACE_NAMES: Record<Place, string> = { local: "Local", preview: "Preview", prod: "Published" };

/** One place: its address, or why the site doesn't have it yet (said on its greyed switch). */
export type PlaceAt = { url: string; why?: undefined } | { url: null; why: string };

/**
 * The site's three places: Local at `local` (http://localhost:<its port>/, always there: a stopped one says so over
 * the page), its Preview link once something is deployed there, and Published on its first domain once something is
 * published (never an orgo.dev name). `x`: the site as the apps list says it (the app itself for its own site); none
 * while that list is read.
 */
export function placesOf(local: string, x: Pick<HostedSite, "preview" | "domain" | "serving" | "live"> | undefined): Record<Place, PlaceAt> {
  const reading = { url: null, why: "Reading its links…" } as const;
  if (!x) return { local: { url: local }, preview: reading, prod: reading };
  const p = x.preview;
  const preview: PlaceAt = !p
    ? { url: null, why: "Orgo couldn't say its preview link just now." }
    : p.off
      ? { url: null, why: "Orgo turned its preview link off." }
      : !p.url
        ? { url: null, why: "It has no preview link yet. Deploy a preview first." }
        : !p.serving && p.live?.state !== "succeeded"
          ? { url: null, why: "Nothing is on its preview yet. Deploy a preview first." }
          : { url: p.url };
  const live = !!x.serving || x.live?.state === "succeeded";
  const prod: PlaceAt = !x.domain
    ? { url: null, why: live ? "It has no domain yet. Published sites live only on their own domain." : "It isn't published yet." }
    : !live
      ? { url: null, why: "It isn't published yet." }
      : { url: x.domain };
  return { local: { url: local }, preview, prod };
}

/* ---------------- The widths a page is seen at ---------------- */

export type Width = "full" | "tablet" | "phone";
export const WIDTHS: readonly { id: Width; px: number | null; name: string }[] = [
  { id: "full", px: null, name: "Full width" },
  { id: "tablet", px: 768, name: "Tablet, 768 wide" },
  { id: "phone", px: 390, name: "Phone, 390 wide" },
];
export const isWidth = (v: unknown): v is Width => WIDTHS.some((w) => w.id === v);

/** Where an app's width is kept on this Mac (per Bops user, workspace and app). */
const widthKey = (user: string | undefined, ws: string, name: string) => `bops.preview.width.${user || "me"}.${ws}.${name}`;

/** The width an app's page was left at on this Mac (Full until one is picked; guarded: no storage, Full). */
export function readWidth(user: string | undefined, ws: string, name: string): Width {
  try {
    const v = localStorage.getItem(widthKey(user, ws, name));
    return isWidth(v) ? v : "full";
  } catch {
    return "full";
  }
}

export function writeWidth(user: string | undefined, ws: string, name: string, w: Width) {
  try {
    if (w === "full") localStorage.removeItem(widthKey(user, ws, name));
    else localStorage.setItem(widthKey(user, ws, name), w);
  } catch {
    /* kept until the tab closes */
  }
}

/* ---------------- Fix it, and going back ---------------- */

/**
 * What the site's Local says of its good runs and Fix it presses (vm/bin/bops-local's BOPS_LOCAL_MORE line, read
 * into LocalSite by the server): `lastGood`, the changeset it last ran well on (its page answered below 500 with the
 * folder clean) and when; `fixes`, how many times Fix it was pressed since. Both optional: an older computer's
 * bops-local doesn't say them.
 */
export type LocalFacts = { lastGood?: { at: string; when: number }; fixes?: number };

/** The page's main frame answered with this status (the webview's did-navigate), on this path. */
export type PageAnswer = { status: number; path: string };

/** What the Fix it panel is about: what stopped in words, and the last lines of its log (none when there are none). */
export type FixAsk = { title: string; lines: string[]; said: string };

/** How many of its log's last lines the panel shows and Fix it sends. */
export const FIX_LINES = 6;

/**
 * The Fix it panel, for the site's Local only (its Preview and Published have their deploys' own logs): when its
 * dev server stopped by itself (`failed`), its page's main frame answered 5xx, or it opened on a port of its own
 * (`mismatch`: one that ignores $PORT, so nothing answers on the site's own port and it never stops starting).
 * Null otherwise. `site`: the site's name as people read it. The lines are its log's last ones, as its status says
 * them (its `error`).
 */
export function fixAsk(site: string, place: Place, x: LocalSite | undefined, page: PageAnswer | null): FixAsk | null {
  if (place !== "local") return null;
  const lines = (x?.error ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, "").slice(0, 300))
    .filter((l) => l.trim())
    .slice(-FIX_LINES);
  if (x?.state === "failed") return { title: `${site}'s Local stopped.`, lines, said: `${site}'s Local stopped.` };
  if (x?.state === "running" && page && page.status >= 500 && page.status <= 599) {
    const on = `${site}'s Local had an error on ${page.path} (${page.status}).`;
    return { title: on, lines: [], said: on };
  }
  if (x?.state === "starting" && x.mismatch && x.port) {
    const on = `${site}'s dev server opened on port ${x.mismatch} instead of its own port, ${x.port}`;
    return { title: `${on}. Its bot can make its dev command use $PORT.`, lines: [], said: `${on}: its dev command has to use $PORT.` };
  }
  return null;
}

/**
 * The message Fix it sends in the bot's chat, as the owner would type it: what stopped, "Fix it.", and the lines in
 * a fenced block (fenced longer than any run of backticks in them, so a line can't end it).
 */
export function fixMessage(ask: FixAsk): string {
  const head = `${ask.said} Fix it.`;
  if (!ask.lines.length) return head;
  const longest = Math.max(0, ...ask.lines.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((m) => m[0].length))));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${head}\n\n${fence}\n${ask.lines.join("\n")}\n${fence}`;
}

/**
 * The loop breaker: after two Fix it presses with no good run between, the version it last ran well on, which
 * the panel then offers first ("Go back to the version that worked"). Null before that, or when there's none.
 */
export function goBackTo(x: (LocalSite & LocalFacts) | undefined): { at: string; when: number } | null {
  const g = x?.lastGood;
  if (!g || typeof g.at !== "string" || !g.at || typeof g.when !== "number" || (x?.fixes ?? 0) < 2) return null;
  return { at: g.at, when: g.when };
}

/** One later change going back undoes, as GET /api/hosted-apps/[name]?restore= says it (each field read with care). */
export type LaterChange = { id: string; title: string; author: string; at: number };

/** GET …?restore=<to>'s answer, read: the later changes it undoes, and why it can't now (`blocked`). Null: not an answer. */
export function restorePlanOf(raw: unknown): { later: LaterChange[]; blocked?: string } | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { later?: unknown }).later)) return null;
  const r = raw as { later: unknown[]; blocked?: unknown };
  const later = r.later
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({ id: str(c.id, 64), title: str(c.title, 120), author: str(c.author, 60), at: typeof c.at === "number" && Number.isFinite(c.at) ? c.at : 0 }))
    .filter((c) => c.id);
  const blocked = str(r.blocked, 300);
  return blocked ? { later, blocked } : { later };
}

/* ---------------- Select: pointing at something on the page ---------------- */

/**
 * Select's script, run in the page (webview.executeJavaScript): it outlines what's under the pointer and answers,
 * once, what was clicked (`{ pick, add }`, add: with Cmd), or `{ esc: true }` for Esc, or null when it was turned off
 * (OFF_SCRIPT, or this script run again). The click never reaches the page. The page's own scripts run in the same
 * world and can change anything it reads or answers, so Bops takes the answer as data only (pickAnswerOf), never
 * runs it, and caps every part of it.
 */
export const SELECT_SCRIPT = `(() => {
  const w = window, K = "__bopsSelect";
  if (w[K]) w[K]();
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;box-sizing:border-box;border:2px solid #0A0A0A;border-radius:3px;background:rgba(233,255,59,.22);box-shadow:0 0 0 1px #fff";
    (document.body || document.documentElement).appendChild(box);
    let on = null;
    const show = (el) => {
      const r = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
    };
    const clip = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n);
    const heading = (el) => {
      let found = "";
      for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
        if (h === el || !(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
        found = h.textContent;
      }
      return clip(found, 200);
    };
    const about = (el) => {
      const r = el.getBoundingClientRect();
      const text = el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || el.getAttribute("title") || "";
      return {
        route: location.pathname,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        text: clip(text, 200),
        id: el.id || "",
        classes: Array.from(el.classList).slice(0, 12),
        testId: el.getAttribute("data-testid") || "",
        heading: heading(el),
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
      };
    };
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const move = (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el === box) return;
      on = el;
      show(el);
    };
    const click = (e) => {
      stop(e);
      const el = e.target instanceof Element && e.target !== box ? e.target : on;
      if (el) end({ pick: about(el), add: !!(e.metaKey || e.ctrlKey) });
    };
    const key = (e) => {
      if (e.key !== "Escape") return;
      stop(e);
      end({ esc: true });
    };
    const kinds = { mousemove: move, click, keydown: key, mousedown: stop, mouseup: stop, pointerdown: stop, pointerup: stop, dblclick: stop, auxclick: stop, contextmenu: stop };
    const end = (answer) => {
      for (const k in kinds) removeEventListener(k, kinds[k], true);
      box.remove();
      if (w[K] === off) delete w[K];
      resolve(answer);
    };
    const off = () => end(null);
    w[K] = off;
    for (const k in kinds) addEventListener(k, kinds[k], true);
  });
})()`;

/** Turns Select off in the page (its outline gone; the pending answer is null). */
export const OFF_SCRIPT = `(() => { const f = window.__bopsSelect; if (typeof f === "function") f(); })()`;

/** One thing picked on the page, as Bops keeps it: every part capped here, whatever the page answered. */
export type Picked = {
  /** Its page's path ("/pricing"). */
  route: string;
  tag: string;
  role: string;
  /** Its words, on one line, at most 80 characters. */
  text: string;
  id: string;
  /** Up to 3 of its classes (only plain ones: a utility class like hover:bg-[#fff] says nothing of it). */
  classes: string[];
  testId: string;
  /** The nearest heading before it (or holding it). */
  heading: string;
  /** Where it is in the page's window, in its pixels. */
  box: { x: number; y: number; w: number; h: number };
};

/** At most this many things a Select (Cmd click adds more). */
export const MAX_PICKS = 5;

// Control characters, and the ones that turn text around or hide it.
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
/** A string from the page, on one line, at most `n` characters (whole ones: never half of an emoji). Anything else: "". */
function str(v: unknown, n: number) {
  if (typeof v !== "string") return "";
  const one = v.slice(0, 4 * n).replace(UNSEEN, " ").replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length > n ? `${chars.slice(0, n - 1).join("").trimEnd()}…` : one;
}
/** A string from the page that must look like `shape` (else ""). */
const word = (v: unknown, n: number, shape: RegExp) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length <= n && shape.test(s) ? s : "";
};
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

/** One pick from what the page answered, every part checked and capped; null when it isn't one. */
export function pickedOf(raw: unknown): Picked | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const tag = word(r.tag, 32, /^[a-z][a-z0-9-]*$/);
  if (!tag) return null;
  const route = str(r.route, 200).replace(/\s/g, "");
  const b = r.box && typeof r.box === "object" ? (r.box as Record<string, unknown>) : {};
  return {
    route: route.startsWith("/") ? route : "/",
    tag,
    role: word(r.role, 32, /^[a-z][a-z-]*$/),
    text: str(r.text, 80).replace(/"/g, "'"),
    id: word(r.id, 60, /^[A-Za-z][\w-]*$/),
    classes: (Array.isArray(r.classes) ? r.classes.slice(0, 50) : [])
      .map((c) => word(c, 40, /^-?[A-Za-z_][\w-]*$/))
      .filter(Boolean)
      .slice(0, 3),
    testId: word(r.testId, 60, /^[\w.:-]+$/),
    heading: str(r.heading, 80).replace(/"/g, "'"),
    box: { x: num(b.x, -1e5, 1e5), y: num(b.y, -1e5, 1e5), w: num(b.w, 0, 1e5), h: num(b.h, 0, 1e5) },
  };
}

/** What Select's script answered: a pick (and whether Cmd was held, to add more), Esc, or nothing (it was turned off). */
export type PickAnswer = { pick: Picked; add: boolean } | { esc: true } | null;

export function pickAnswerOf(raw: unknown): PickAnswer {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.esc === true) return { esc: true };
  const pick = pickedOf(r.pick);
  return pick ? { pick, add: r.add === true } : null;
}

/** What a thing on a page is called in a line, by its role, else its tag; "part of the page" when neither says. */
const NOUNS: Record<string, string> = {
  button: "button",
  a: "link",
  link: "link",
  img: "image",
  image: "image",
  svg: "icon",
  input: "field",
  textbox: "field",
  textarea: "text box",
  select: "menu",
  combobox: "menu",
  checkbox: "checkbox",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  heading: "heading",
  nav: "navigation",
  navigation: "navigation",
  header: "header",
  footer: "footer",
  form: "form",
  li: "list item",
  listitem: "list item",
  p: "paragraph",
  label: "label",
  table: "table",
  video: "video",
  tab: "tab",
  menuitem: "menu item",
  dialog: "dialog",
  section: "section",
  article: "section",
  aside: "sidebar",
  div: "box",
  span: "text",
  strong: "text",
  em: "text",
  small: "text",
};

/**
 * The line a pick puts at the top of the message, in words a person would say: where it is and what it is (On
 * /pricing, the button "Sign up" under "Pro"). The bot passes it on to its task verbatim (chat.ts work_on_app), with
 * where it is in the page's code (pickCode), which goes with the message out of the owner's sight (Message.picks).
 */
export function pickLine(p: Picked): string {
  const noun = NOUNS[p.role] ?? NOUNS[p.tag] ?? "part of the page";
  const under = p.heading && p.heading !== p.text ? ` under "${p.heading}"` : "";
  return `On ${p.route}, the ${noun}${p.text ? ` "${p.text}"` : ""}${under}`;
}

/** Where a pick is in the page's code, for the bot only: its tag and what names it best (button.cta, a#docs). */
export function pickCode(p: Picked): string {
  const how = p.testId ? `[data-testid="${p.testId}"]` : p.id ? `#${p.id}` : p.classes.length ? `.${p.classes.join(".")}` : "";
  return `${p.tag}${how}`;
}

/** One pick a message carries (Message.picks): its line in the owner's words, and where that is in the page's code. */
export type PickNote = { line: string; code: string };

/** pickCode's shape, and nothing else. */
const CODE = /^[a-z][a-z0-9-]{0,31}(?:#[A-Za-z][\w-]{0,59}|(?:\.-?[A-Za-z_][\w-]{0,39}){1,3}|\[data-testid="[\w.:-]{1,60}"\])?$/;
/** At most this many picks go with a message. */
const MAX_NOTES = 10;

/**
 * The picks a message from the Bops window says it has (POST /api/chats/[chatId]/messages `picks`), as the server
 * keeps them: only lines still in its words (`text`), each with a code in pickCode's shape, none twice. Anything else
 * is dropped.
 */
export function picksOf(raw: unknown, text: string): PickNote[] {
  if (!Array.isArray(raw)) return [];
  const out: PickNote[] = [];
  for (const x of raw.slice(0, 50)) {
    const { line, code } = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    if (typeof line !== "string" || typeof code !== "string" || !line.trim() || line.length > 500 || !text.includes(line) || !CODE.test(code)) continue;
    if (!out.some((p) => p.line === line && p.code === code)) out.push({ line, code });
  }
  return out.slice(0, MAX_NOTES);
}

/**
 * The part of the page a pick's picture shows: its box with `pad` around it, inside the page's window (`view`, as
 * Bops measures it, never as the page says), in whole pixels. Null when nothing of it is in view (the whole window
 * then).
 */
export function captureRect(box: Picked["box"], view: { w: number; h: number }, pad = 16): { x: number; y: number; width: number; height: number } | null {
  const x0 = Math.max(0, Math.floor(box.x - pad));
  const y0 = Math.max(0, Math.floor(box.y - pad));
  const x1 = Math.min(Math.floor(view.w), Math.ceil(box.x + box.w + pad));
  const y1 = Math.min(Math.floor(view.h), Math.ceil(box.y + box.h + pad));
  return x1 - x0 >= 4 && y1 - y0 >= 4 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
