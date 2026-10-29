"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { appsShown } from "@/lib/apps-access";
import { GROUP_WORDS as W, linkedBots, MAX_COMPUTER_NAME, siteChoices, siteExists, siteLabel, siteName, type BotGroup } from "@/lib/bot-groups";
import { siteOf, workspaceOf, type AppState, type Bot } from "@/lib/types";
import { Chevron, readGroupOpen, writeGroupOpen } from "./side-group";
import { post } from "./ui";

/*
 * The sidebar's groups of bots that work on one computer (lib/bot-groups.ts says which, and their names): a small
 * header with the computer's name, how many bots, and a fold; the owner renames it in place. And the site a bot works
 * on: the domain the sidebar says under its name (useSiteDomains), and its settings page's Works on row.
 */

/* ---------------- What's folded, in this window ---------------- */

/** A group's fold, kept per window (localStorage, guarded: without it, as the user left it until Bops reloads). */
const FOLD = "computer";
export const groupFolded = (key: string, user: string, ws: string) => !readGroupOpen(`${FOLD}.${key}`, user, ws);
export const keepGroupFolded = (key: string, user: string, ws: string, folded: boolean) => writeGroupOpen(`${FOLD}.${key}`, user, ws, !folded);

/** The groups' folds, as the user left them here: read once a group is first shown, then as they fold and open it. */
export function useGroupFolds(user: string, ws: string) {
  const [set, setSet] = useState<{ scope: string; folded: Record<string, boolean> }>({ scope: `${user}:${ws}`, folded: {} });
  const scope = `${user}:${ws}`;
  const folded = set.scope === scope ? set.folded : {};
  const isFolded = (key: string) => folded[key] ?? groupFolded(key, user, ws);
  const fold = (key: string, next: boolean) => {
    setSet({ scope, folded: { ...folded, [key]: next } });
    keepGroupFolded(key, user, ws, next);
  };
  return { isFolded, fold };
}

/* ---------------- A group's header ---------------- */

/**
 * One computer's bots under its name: the header (its name, how many, and its fold), then `rows`. Folded, only the
 * open chat's row stays (`selected`), and a mark says when one hidden needs the user or has something unread
 * (`waiting`). The owner (`onRename`) clicks the name to rename it in place: Enter saves, Esc puts it back, and so
 * does saving it empty (its default); a click away saves what was typed.
 */
export function BotGroupBlock({
  group,
  folded,
  onFold,
  onRename,
  waiting = false,
  rows,
  selected,
}: {
  group: BotGroup;
  folded: boolean;
  onFold: (folded: boolean) => void;
  /** The owner's own window: save a new name (empty: the default); answers whether it saved. */
  onRename?: (name: string) => Promise<boolean>;
  waiting?: boolean;
  rows: ReactNode;
  /** The open chat's row, when it's one of this group's: still shown folded. */
  selected?: ReactNode;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // The name just saved, shown until the state has it (or says otherwise).
  const [saved, setSaved] = useState<{ name: string; was: string } | null>(null);
  const [failed, setFailed] = useState(false);
  if (saved && saved.was !== group.name) setSaved(null);
  const name = saved?.name || group.name;
  const n = group.bots.length;
  // Each edit ends once: Enter, Esc or a click away, whichever comes first (the field's blur as it goes never saves twice).
  const ended = useRef(false);
  const start = () => {
    ended.current = false;
    setEditing(name);
  };
  const end = (typed: string | null) => {
    if (ended.current) return;
    ended.current = true;
    if (typed === null) setEditing(null);
    else void save(typed);
  };
  const save = async (typed: string) => {
    setEditing(null);
    const next = typed.replace(/\s+/g, " ").trim();
    if (!onRename || next === name) return;
    setFailed(false);
    setSaved({ name: next || group.name, was: group.name });
    const ok = await onRename(next).catch(() => false);
    if (!ok) {
      setSaved(null);
      setFailed(true);
    }
  };
  return (
    <section role="group" aria-label={`${name}, ${W.bots(n)}`} data-bot-group={group.key} className="flex flex-col gap-0.5">
      <div data-group-head title={W.on(name, group.host?.name)} className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] pl-2.5 pr-1 text-[13px] font-medium leading-4 text-[#9A9A98]">
        {editing !== null ? (
          <input
            type="text"
            autoFocus
            data-group-input
            aria-label={W.nameLabel}
            value={editing}
            maxLength={MAX_COMPUTER_NAME}
            placeholder={group.name}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                end(editing);
              } else if (e.key === "Escape") {
                // Only the name goes back: the app's own Esc stays put.
                e.preventDefault();
                e.stopPropagation();
                end(null);
              }
            }}
            onBlur={() => end(editing)}
            className="h-[26px] min-w-0 flex-1 rounded-[7px] bg-white px-2 text-[13px] font-medium text-ink shadow-[0_0_0_1.5px_#0A0A0A] outline-none placeholder:text-[#9A9A98]"
          />
        ) : onRename ? (
          <button
            type="button"
            data-group-name
            onClick={start}
            aria-label={W.rename(name)}
            data-tip={W.rename(name)}
            className="min-w-0 truncate rounded-[6px] px-0.5 text-left outline-none hover:text-[#6B6B6B] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
          >
            {name}
          </button>
        ) : (
          <span data-group-name className="min-w-0 truncate px-0.5">
            {name}
          </span>
        )}
        {editing === null && (
          <span data-group-count aria-hidden className="shrink-0 rounded-full bg-[#EEEEEC] px-1.5 text-[11.5px] leading-4 tabular-nums text-[#6B6B6B]">
            {n}
          </span>
        )}
        {editing === null && folded && waiting && <span data-group-waiting role="img" aria-label={W.needsYou} title={W.needsYou} className="size-[7px] shrink-0 rounded-full bg-[#E59A0B]" />}
        <span className="flex-1" />
        {editing === null && (
          <button
            type="button"
            data-group-fold
            onClick={() => onFold(!folded)}
            aria-expanded={!folded}
            aria-label={folded ? W.unfold(name) : W.fold(name)}
            data-tip={folded ? W.unfold(name) : W.fold(name)}
            className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-black/[0.05] hover:text-[#6B6B6B] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
          >
            <Chevron open={!folded} />
          </button>
        )}
      </div>
      {failed && (
        <span role="alert" className="px-3 pb-1 text-[12px] leading-4 text-[#B42318]">
          {W.saveFailed}
        </span>
      )}
      {folded ? selected : rows}
    </section>
  );
}

/** Save a computer's name from the owner's window (app/api/workspaces computerName). */
export async function renameComputer(ws: string, computerId: string, name: string): Promise<boolean> {
  const res = await post("/api/workspaces", { id: ws, computerName: { computer: computerId, name } }, "PATCH").catch(() => null);
  return !!res?.ok;
}

/* ---------------- The domains the sidebar shows ---------------- */

/** How often the owner's window reads them again: they change only as a domain is added, or its DNS goes live. */
const DOMAINS_MS = 5 * 60_000;

/** Read once a window, whichever of the sidebar and its rail asks: by workspace, with the links they were read for. */
const read = new Map<string, { at: number; links: string; domains: Record<string, string | null> | null; pending?: Promise<void> }>();

/**
 * The domain each of the open workspace's bots that works on a site shows (app/api/bots/sites), by bot id, as this
 * window last read it: {} until then. Only in the owner's own workspace, with apps open to them; in one shared with
 * them, Bops Cloud sends its apps' domains (lib/bot-groups.ts siteLabel).
 */
export function useSiteDomains(state: AppState): Record<string, string | null> {
  const ws = state.workspace ?? state.workspaces?.[0]?.id ?? "";
  const on = !state.shared && appsShown(state);
  const links = on ? JSON.stringify(linkedBots(state)) : "[]";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (links === "[]") return;
    let gone = false;
    const get = () => {
      const was = read.get(ws);
      if (was?.pending || (was && was.links === links && Date.now() - was.at < DOMAINS_MS)) return;
      const entry: { at: number; links: string; domains: Record<string, string | null> | null; pending?: Promise<void> } = { at: Date.now(), links, domains: was?.domains ?? null };
      entry.pending = fetch(`/api/bots/sites?ws=${encodeURIComponent(ws)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { domains?: Record<string, string | null> } | null) => {
          if (j?.domains && typeof j.domains === "object") entry.domains = j.domains;
        })
        .catch(() => {})
        .finally(() => {
          delete entry.pending;
          if (!gone) setTick((t) => t + 1);
        });
      read.set(ws, entry);
    };
    get();
    const t = setInterval(get, DOMAINS_MS);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [ws, links]);
  return (links !== "[]" && read.get(ws)?.domains) || {};
}

/* ---------------- Works on, on a bot's settings page ---------------- */

/**
 * The site of the workspace's apps a bot works on: the sidebar says it under its name (its domain, else its name) in
 * place of its role. The owner picks one of the apps' sites, or None; anyone else (a shared workspace) reads it.
 */
export function WorksOnRow({ state, bot: b, readOnly, className = "" }: { state: AppState; bot: Bot; readOnly: boolean; className?: string }) {
  const ws = state.workspaces?.find((w) => w.id === workspaceOf(b));
  const link = siteOf(state, b);
  const choices = state.shared ? [] : siteChoices(ws);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = link ? (siteLabel(state, b) ?? (state.shared ? undefined : W.siteGone)) : undefined;
  if (readOnly) {
    if (!link || !label) return null;
    return (
      <div data-works-on className={`flex items-center gap-3 rounded-[12px] px-3 py-2 ${className}`}>
        <span className="flex-1 text-[13px] leading-4">{W.worksOn}</span>
        <span data-works-on-value className="min-w-0 truncate text-[13px] font-semibold leading-4">
          {label}
        </span>
      </div>
    );
  }
  // Nothing to pick from, and nothing picked: no row (a workspace without apps never sees it).
  if (!choices.length && !link) return null;
  const value = link && siteExists(ws, link) ? JSON.stringify([link.app, link.site]) : link ? "gone" : "";
  const pick = async (v: string) => {
    if (v === "gone") return;
    const [app, site] = v ? (JSON.parse(v) as [string, string]) : [];
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/bots", { botId: b.id, site: app ? { app, site } : null }, "PATCH");
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "That didn't save. Try again.");
    } catch {
      setError("Couldn't reach Bops. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-works-on className="flex flex-col gap-1.5">
      <label className={`flex items-center gap-3 rounded-[12px] px-3 py-2 ${className}`}>
        <span className="flex-1 text-[13px] leading-4">{W.worksOn}</span>
        <select
          data-works-on-select
          value={value}
          disabled={busy}
          onChange={(e) => void pick(e.target.value)}
          className="max-w-[60%] appearance-none truncate bg-transparent text-right text-[13px] font-semibold leading-4 outline-none disabled:text-[#9A9A98]"
        >
          <option value="">{W.none}</option>
          {value === "gone" && <option value="gone">{W.siteGone}</option>}
          {choices.map((c) => (
            <option key={`${c.app}/${c.site}`} value={JSON.stringify([c.app, c.site])}>
              {siteName(c)}
            </option>
          ))}
        </select>
        <span aria-hidden className="text-[10px] text-[#9A9A98]">
          ▾
        </span>
      </label>
      {error ? (
        <span role="alert" className="px-1 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      ) : (
        link && <span className="px-1 text-[12px] leading-4 text-[#6B6B6B]">{W.worksOnHint}</span>
      )}
    </div>
  );
}
