"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { appsShown } from "@/lib/apps-access";
import { builtinLabels, builtinSkills, type BuiltinSkill } from "@/lib/builtin-skills";
import { cleanLabel, OTHER, sameLabel, SKILL_LABEL_MAX, type SkillGroup } from "@/lib/skill-labels";
import { workspaceOf, type AppState, type Bot, type SkillKind, type SkillRef } from "@/lib/types";
import { Fold } from "./fold";
import { Mascot, Spinner } from "./mascot";
import { Chevron, readSectionOpen, writeSectionOpen } from "./side-group";
import { CloseButton, currentWorkspace, post, teamOf } from "./ui";
import { BRAND } from "@/lib/brand";

/*
 * Skills: a workspace's ways of doing a kind of job (skills) and the tools Bops built that bots run (apps),
 * each a folder in the Agent Skill shape on this Mac (lib/server/workspace-skills.ts). A kind in Knowledge
 * (memory-categories.tsx): its chip opens a page (SkillsPage) in the Knowledge tab with the skills under
 * their labels (lib/skill-labels.ts), Bops' own labels first, each a heading that folds; one opens in place:
 * its SKILL.md and files, its label (a chip to move it), which bots have it, its versions (Publish, Roll
 * back), its scripts to approve, Open in Finder and Delete. Bops' own skills open read only. Import folder
 * takes a folder picked in Finder through the Mac app. The lists are the app's state (Workspace.skills,
 * Workspace.apps), so they're as current as everything else.
 */

type Problem = { path: string; reason: string; line?: number };
type FileInfo = { path: string; size: number; sha256: string; executable: boolean; script: boolean; approved: boolean; binary?: boolean };
type Detail = { ref: SkillRef; body: string; frontmatter: Record<string, unknown>; files: FileInfo[]; dir: string | null; missing: boolean; changed: boolean };

/** The Mac app's bridge for skills (desktop/preload.cjs): a folder picked in Finder, and a folder shown there. */
type Bridge = { pickFolder?: () => Promise<string | null>; revealFolder?: (dir: string) => Promise<boolean> };
const bridge = () => (typeof window === "undefined" ? undefined : (window as unknown as { bopsMac?: Bridge }).bopsMac);

/** The current workspace's skills and apps, newest first. */
export function skillsIn(state: AppState, wsId = currentWorkspace(state)) {
  const w = state.workspaces?.find((x) => x.id === wsId);
  const newest = (a: SkillRef, b: SkillRef) => b.updatedAt - a.updatedAt;
  return { skills: [...(w?.skills ?? [])].sort(newest), apps: [...(w?.apps ?? [])].sort(newest) };
}

/** The skills and apps a bot has: its workspace's, every bot's or named for it. Drafts too (they say so). */
export function botSkills(state: AppState, b: Bot) {
  // Apps hidden in the prod build for now.
  const { skills /* , apps */ } = skillsIn(state, workspaceOf(b));
  return [...skills /* , ...apps */].filter((r) => !r.botIds.length || r.botIds.includes(b.id));
}

/** The Skills mark: a folder with a spark. */
export function SkillsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 4.6c0-.6.5-1.1 1.1-1.1h3l1.4 1.5h5.4c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" />
      <path d="M8 7.2v3M6.5 8.7h3" />
    </svg>
  );
}

const PILL = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
const CHIP = "rounded-full bg-[#F2F2F0] px-2 py-px text-[11px] leading-4 text-[#6B6B6B]";
const DRAFT = "shrink-0 rounded-full bg-highlighter px-2 py-px text-[11px] font-medium leading-4 text-ink";
const RISK: Record<string, string> = { read: "Reads only", write: "Changes things", destructive: "Can delete" };

/* ---------------- Labels ---------------- */

/** One label on the page: its skills of the workspace's, and Bops' own in it (lib/builtin-skills.ts: every bot has them, nobody edits them). */
export type LabelGroup = SkillGroup & { refs: SkillRef[]; builtins: BuiltinSkill[] };

/**
 * Skills under their labels, as the page lists them and in the order a bot sees them (skillGroups in
 * lib/server/workspace-skills.ts): Bops' own labels first, in their order (with any of the workspace's
 * skills given one of their names), then the workspace's, the most skills first, then by name, Other
 * last. Each list keeps the order it came in (newest first). `withBuiltins` false: only the workspace's
 * labels (apps have no built-in ones). `apps`: whether apps are open to the account (lib/apps-access.ts),
 * without which Bops' own Apps and source control skills aren't listed.
 */
export function labelGroups(refs: SkillRef[], withBuiltins = true, apps = true): LabelGroup[] {
  const make = (label: string, about: string, builtin: boolean): LabelGroup => ({ label: cleanLabel(label), about, builtin, count: 0, slugs: [], refs: [], builtins: [] });
  const ours = withBuiltins ? builtinLabels(apps).map((b) => make(b.label, b.about, true)) : [];
  for (const s of withBuiltins ? builtinSkills(apps) : []) {
    let g = ours.find((x) => sameLabel(x.label, s.label));
    // One under a label BUILTIN_LABELS doesn't name is still Bops' own, listed with them.
    if (!g) ours.push((g = make(s.label, "", true)));
    g.builtins.push(s);
  }
  const theirs: LabelGroup[] = [];
  for (const r of refs) {
    const label = cleanLabel(r.label);
    let g = ours.find((x) => sameLabel(x.label, label)) ?? theirs.find((x) => sameLabel(x.label, label));
    if (!g) theirs.push((g = make(label, "", false)));
    g.refs.push(r);
  }
  const other = (g: LabelGroup) => (sameLabel(g.label, OTHER) ? 1 : 0);
  theirs.sort((a, b) => other(a) - other(b) || b.refs.length - a.refs.length || a.label.localeCompare(b.label));
  // A label of Bops' with nothing in it isn't listed.
  return [...ours.filter((g) => g.builtins.length || g.refs.length), ...theirs].map((g) => {
    const all = [...g.builtins, ...g.refs];
    return { ...g, count: all.length, slugs: all.map((x) => x.slug), about: g.about || all.map((x) => x.name).join(", ") };
  });
}

/** The labels a skill can be moved to: every one on the page, and Other. */
export function labelChoices(refs: SkillRef[], apps = true) {
  const all = labelGroups(refs, true, apps).map((g) => g.label);
  return all.some((l) => sameLabel(l, OTHER)) ? all : [...all, OTHER];
}

/** What the update route takes to move a skill to `label` (app/api/skills, action "update"). */
export const labelEdit = (label: string) => ({ action: "update", edit: { label: cleanLabel(label) } });

/** Labels open on the page before the user folds or opens one: the first two. */
export const OPEN_LABELS = 2;
/** This Mac's memory of what's folded (side-group.tsx keeps it), for this page. */
const FOLDS = "skills";

/**
 * Whether a label is open, as the user left it on this Mac (`fallback` until they fold or open it), read
 * again for another workspace or label, and how to change it (remembered, when it can be).
 */
function useLabelOpen(user: string, ws: string, label: string, fallback: boolean) {
  const key = label.toLowerCase();
  const id = `${user}:${ws}:${key}:${fallback}`;
  const [v, setV] = useState(() => ({ id, open: readSectionOpen(FOLDS, user, ws, key, fallback) }));
  if (v.id !== id) setV({ id, open: readSectionOpen(FOLDS, user, ws, key, fallback) });
  const open = v.id === id ? v.open : readSectionOpen(FOLDS, user, ws, key, fallback);
  const set = (next: boolean) => {
    setV({ id, open: next });
    writeSectionOpen(FOLDS, user, ws, key, next);
  };
  return [open, set] as const;
}

/** What the server said back, in words, with the files it turned down (path and why, never what's in them). */
async function call<T>(body: Record<string, unknown>): Promise<{ ok: true; json: T } | { ok: false; error: string; problems?: Problem[] }> {
  try {
    const res = await post("/api/skills", body);
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; problems?: Problem[] };
    return res.ok ? { ok: true, json } : { ok: false, error: json.error ?? "That didn't work. Try again.", problems: json.problems };
  } catch {
    return { ok: false, error: `Couldn't reach ${BRAND.name}. Try again.` };
  }
}

/**
 * Skills or Apps, in the Knowledge tab (one per workspace; `only` picks which, its own chip): one line each
 * under its label, Import folder, and one opened in place (`focus`: "skill:<slug>", "app:<slug>", or
 * "builtin:<slug>" for one of Bops' own; `focusAt` is when it was asked for). `nav` is Knowledge's row of
 * chips, under the title as on Issues.
 */
export function SkillsPage({ state, only, focus, focusAt, nav, onClose }: { state: AppState; only?: SkillKind; focus?: string; focusAt?: number; nav?: ReactNode; onClose: () => void }) {
  const ws = currentWorkspace(state);
  const team = teamOf(state);
  const { skills, apps } = skillsIn(state, ws);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [asked, setAsked] = useState({ focus, focusAt });
  if (asked.focus !== focus || asked.focusAt !== focusAt) {
    setAsked({ focus, focusAt });
    if (focus) setOpen(focus);
  }
  const [importing, setImporting] = useState<SkillKind | null>(null);
  const [imported, setImported] = useState<{ name?: string; skipped: Problem[]; warnings: Problem[]; error?: string } | null>(null);
  const [orgo, setOrgo] = useState(false);
  // Opened: kept in step with Orgo, where the workspace has its own and Orgo has the routes.
  useEffect(() => {
    let gone = false;
    void fetch(`/api/skills?sync=1&ws=${encodeURIComponent(ws)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { orgo?: boolean }) => !gone && setOrgo(!!j.orgo))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [ws]);
  const picker = bridge()?.pickFolder;

  const importFolder = async (kind: SkillKind) => {
    const path = await picker?.().catch(() => null);
    if (!path) return;
    setImporting(kind);
    setImported(null);
    const r = await call<{ ref: SkillRef; skipped: Problem[]; warnings: Problem[] }>({ action: "import", ws, kind, path });
    setImporting(null);
    if (r.ok) {
      setImported({ name: r.json.ref.name, skipped: r.json.skipped, warnings: r.json.warnings });
      setOpen(`${kind}:${r.json.ref.slug}`);
    } else setImported({ error: r.error, skipped: r.problems ?? [], warnings: [] });
  };

  const ref = open ? [...skills, ...apps].find((r) => `${r.kind}:${r.slug}` === open) : undefined;
  // Bops' own Apps and source control skills only where apps are shown (lib/apps-access.ts): never in a shared workspace.
  const appsHere = appsShown(state);
  const ours = open?.startsWith("builtin:") ? builtinSkills(appsHere).find((s) => `builtin:${s.slug}` === open) : undefined;
  const kinds: SkillKind[] = only ? [only] : ["skill", "app"];
  const groups = [
    { kind: "skill" as const, label: "Skills", list: skills },
    { kind: "app" as const, label: "Apps", list: apps },
  ].filter((g) => kinds.includes(g.kind));
  // Each kind's labels (Bops' own for skills), and where its first one is on the page, so only the page's first two start open.
  const sections = groups.map((g) => ({ ...g, labels: labelGroups(g.list, g.kind === "skill", appsHere) }));
  const starts = sections.map((_, i) => sections.slice(0, i).reduce((n, s) => n + s.labels.length, 0));
  const user = state.account?.user.id ?? "";
  const about =
    only === "app"
      ? "Programs and tools this workspace\u2019s bots run, kept with their files exactly as they are."
      : only === "skill"
        ? "How this workspace\u2019s bots do a kind of job."
        : "How this workspace\u2019s bots do a kind of job, and the apps they run.";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[600px] flex-col gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <SkillsIcon size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{only === "app" ? "Apps" : "Skills"}</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">
              {about} {orgo ? "Kept in step with Orgo." : "Kept on this Mac."}
            </span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>
        {!ref && nav}

        {imported && <ImportNote result={imported} onDismiss={() => setImported(null)} />}

        {ref ? (
          <SkillView key={open} state={state} ws={ws} skill={ref} team={team} labels={labelChoices(skills, appsHere)} onBack={() => setOpen(null)} />
        ) : ours ? (
          <BuiltinView key={open} skill={ours} onBack={() => setOpen(null)} />
        ) : (
          <>
            {picker && (
              <div className="flex flex-wrap gap-2">
                {kinds.map((k) => (
                  <button key={k} disabled={!!importing} onClick={() => void importFolder(k)} className={`${PILL} flex items-center gap-1.5 bg-[#F2F2F0] text-ink hover:bg-[#EAEAE7]`}>
                    {importing === k && <Spinner size={11} color="#6B6B6B" />}
                    {k === "skill" ? "Import a skill folder" : "Import an app folder"}
                  </button>
                ))}
              </div>
            )}
            {sections.map((s, i) => (
              <section key={s.kind} className="flex flex-col gap-3">
                {/* Both kinds on one page: each under its own name. */}
                {sections.length > 1 && s.labels.length > 0 && <span className="text-[13px] font-semibold leading-4">{s.label}</span>}
                {s.labels.map((g, n) => (
                  <LabelSection key={g.label} user={user} ws={ws} group={g} first={starts[i] + n < OPEN_LABELS}>
                    {g.builtins.map((b) => (
                      <SkillRow key={`builtin:${b.slug}`} name={b.name} description={b.description} onOpen={() => setOpen(`builtin:${b.slug}`)} />
                    ))}
                    {g.refs.map((r) => (
                      <SkillRow key={`${r.kind}:${r.slug}`} name={r.name} description={r.description} draft={r.status === "draft"} onOpen={() => setOpen(`${r.kind}:${r.slug}`)} />
                    ))}
                  </LabelSection>
                ))}
                {!s.list.length && (
                  <span className="text-[13px] leading-[19px] text-[#6B6B6B]">
                    {s.kind === "app"
                      ? `No apps yet.${picker ? " Import a folder with the program and its files." : ""}`
                      : `No skills of your own yet. Save one from a chat\u2019s menu${picker ? ", or import a folder" : ""}.`}
                  </span>
                )}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A label: a heading with how many skills it has (Built in for Bops' own, what they're for in its tooltip)
 * that folds its rows. Open as the user left it on this Mac; until then, open when it's one of the first two.
 */
function LabelSection({ user, ws, group: g, first, children }: { user: string; ws: string; group: LabelGroup; first: boolean; children: ReactNode }) {
  const [open, setOpen] = useLabelOpen(user, ws, g.label, first);
  return (
    <div className="flex flex-col gap-1.5" data-label={g.label}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${g.label}, ${g.count} skill${g.count === 1 ? "" : "s"}${g.builtin ? ", built in" : ""}`}
        data-tip={g.builtin ? g.about : undefined}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 self-start rounded-md py-0.5 pr-1 text-[13px] font-semibold leading-4 text-ink"
      >
        <span className="text-[#9A9A98]">
          <Chevron open={open} />
        </span>
        {g.label}
        <span className="font-normal tabular-nums text-[#9A9A98]">{g.count}</span>
        {g.builtin && <span className={`${CHIP} font-normal`}>Built in</span>}
      </button>
      <Fold open={open} lazy>
        <div className="flex flex-col overflow-hidden rounded-2xl border border-[#ECECEA] bg-white">{children}</div>
      </Fold>
    </div>
  );
}

/** A skill on one line: its name, what it does (all of it in the tooltip), and Draft until it's published. */
function SkillRow({ name, description, draft, onOpen }: { name: string; description: string; draft?: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${name}\n${description}`}
      className="flex min-w-0 items-center gap-2.5 border-b border-black/[0.05] px-3.5 py-2 text-left last:border-b-0 hover:bg-[#FCFCFB]"
    >
      <span className="max-w-[45%] shrink-0 truncate text-[13px] font-medium leading-[18px]">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-[18px] text-[#6B6B6B]">{description}</span>
      {draft && <span className={DRAFT}>Draft</span>}
    </button>
  );
}

/** One of Bops' own skills opened: what it is, its files and its SKILL.md, to read. Every bot has it and it can't be changed. */
function BuiltinView({ skill: s, onBack }: { skill: BuiltinSkill; onBack: () => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const files = s.files ?? [];
  return (
    <div className="motion-fade-in flex flex-col gap-4">
      <button onClick={onBack} className="self-start text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
        ‹ Back
      </button>
      <div className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[17px] font-semibold leading-[22px]">{s.name}</span>
          <span className={CHIP}>Built in</span>
          <span className={CHIP}>{cleanLabel(s.label)}</span>
        </span>
        <span className="text-[13px] leading-[19px] text-[#3A3A38]">{s.description}</span>
        <span className="text-[12px] leading-4 text-[#9A9A98]">Every bot has it. It comes with {BRAND.name}, so it can&apos;t be changed here.</span>
      </div>
      {files.length > 0 && (
        <Group title="Files">
          {files.map((f, i) => (
            <div key={f.path} className={`flex flex-col gap-1.5 px-4 py-2 ${i === files.length - 1 ? "pb-3" : "border-b border-black/[0.05]"}`}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-4">{f.path}</span>
                <button onClick={() => setShown(shown === f.path ? null : f.path)} className="shrink-0 text-[12px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
                  {shown === f.path ? "Hide" : "View"}
                </button>
              </div>
              {shown === f.path && (
                <pre className="motion-fade-in max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-[#F7F7F6] px-3 py-2 font-mono text-[11.5px] leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#ECECEA]">{f.content}</pre>
              )}
            </div>
          ))}
        </Group>
      )}
      <Group title="SKILL.md">
        <div className="px-4 pb-4 pt-1">
          <SkillMarkdown text={s.body} />
        </div>
      </Group>
    </div>
  );
}

const MENU_ITEM = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-4 text-ink outline-none hover:bg-[#F2F2F0] focus-visible:bg-[#F2F2F0]";

/** A skill's label as a chip, which opens the labels there are to move it to one, or to a new one. */
function LabelChip({ label, labels, busy, onPick }: { label: string; labels: string[]; busy: boolean; onPick: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative flex">
      <button
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Label: ${label}. Change it`}
        data-label-chip={label}
        onClick={() => setOpen(!open)}
        className={`${CHIP} flex items-center gap-1 hover:bg-[#EAEAE7] disabled:opacity-50`}
      >
        {label}
        <svg width="8" height="8" viewBox="0 0 12 12" className="shrink-0" aria-hidden>
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <LabelMenu
          current={label}
          labels={labels}
          onClose={() => setOpen(false)}
          onPick={(l) => {
            setOpen(false);
            if (!sameLabel(l, label)) onPick(l);
          }}
        />
      )}
    </span>
  );
}

/**
 * The labels a skill can go under, its own checked, and New label, which asks for a name in place (one
 * that's already there, in any case, is that one). Esc or a click outside closes it.
 */
export function LabelMenu({ current, labels, onPick, onClose }: { current: string; labels: string[]; onPick: (label: string) => void; onClose: () => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  // Focus on the skill's own label as it opens (the first, when it has none there), on the name once New label asks for one.
  useEffect(() => {
    const menu = ref.current;
    (menu?.querySelector<HTMLElement>(naming ? "input" : "[aria-checked=true]") ?? menu?.querySelector<HTMLElement>("[role^=menuitem]"))?.focus();
  }, [naming]);
  const move = (by: number) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + by + all.length) % all.length]?.focus();
  };
  const save = () => {
    if (!name.trim()) return;
    const fresh = cleanLabel(name);
    onPick(labels.find((l) => sameLabel(l, fresh)) ?? fresh);
  };
  return (
    <>
      <div className="fixed inset-0 z-30" onMouseDown={onClose} />
      <div
        ref={ref}
        role="menu"
        aria-label="Labels"
        onKeyDown={(e) => {
          const go = { Escape: onClose, ArrowDown: () => move(1), ArrowUp: () => move(-1) }[e.key];
          if (!go || (naming && e.key !== "Escape")) return;
          // Esc closes the menu and only the menu (the page under it stays open).
          e.preventDefault();
          e.stopPropagation();
          go();
        }}
        className="motion-menu-in absolute left-0 top-[calc(100%+6px)] z-40 flex w-[220px] origin-top-left flex-col rounded-xl bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040]"
      >
        <div className="flex max-h-[240px] flex-col overflow-y-auto">
          {labels.map((l) => {
            const on = sameLabel(l, current);
            return (
              <button key={l} type="button" role="menuitemradio" aria-checked={on} onClick={() => onPick(l)} className={MENU_ITEM}>
                <span className="min-w-0 flex-1 truncate">{l}</span>
                {on && (
                  <svg width="11" height="11" viewBox="0 0 12 12" className="shrink-0" aria-hidden>
                    <path d="M2.5 6.5l2.5 2.5 4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
        <span className="mx-1.5 my-1 h-px bg-black/[0.06]" />
        {naming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="flex items-center gap-1.5 p-1"
          >
            <input
              value={name}
              maxLength={SKILL_LABEL_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label name"
              aria-label="New label"
              className="min-w-0 flex-1 rounded-lg bg-[#F7F7F6] px-2 py-1.5 text-[13px] leading-4 text-ink outline-none placeholder:text-[#9A9A98] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
            />
            <button type="submit" disabled={!name.trim()} className="rounded-full bg-ink px-2.5 py-1 text-[12px] font-medium leading-4 text-white disabled:opacity-40">
              Save
            </button>
          </form>
        ) : (
          <button type="button" role="menuitem" onClick={() => setNaming(true)} className={MENU_ITEM}>
            New label
          </button>
        )}
      </div>
    </>
  );
}

/** What an import did: what it's called now, and what it left out and why (paths only). */
function ImportNote({ result: r, onDismiss }: { result: { name?: string; skipped: Problem[]; warnings: Problem[]; error?: string }; onDismiss: () => void }) {
  const lines = [...r.skipped, ...r.warnings];
  return (
    <div role="status" className={`flex flex-col gap-1.5 rounded-2xl px-3.5 py-3 text-[12.5px] leading-[18px] ${r.error ? "bg-[#FEF3F2] text-[#3A3A38]" : "bg-[#F7F7F6] text-[#3A3A38]"}`}>
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 font-medium">{r.error ?? `Imported ${r.name} as a draft.${r.skipped.length ? ` Left out ${r.skipped.length} file${r.skipped.length === 1 ? "" : "s"}:` : ""}`}</span>
        <button onClick={onDismiss} className="text-[12px] font-medium text-[#6B6B6B] hover:text-ink">
          Dismiss
        </button>
      </span>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {lines.slice(0, 30).map((p, i) => (
            <li key={`${p.path}:${p.line ?? 0}:${i}`} className="flex gap-2">
              <span className="truncate font-mono text-[11.5px]">{p.path || "the folder"}{p.line ? `:${p.line}` : ""}</span>
              <span className="text-[#6B6B6B]">{p.reason}</span>
            </li>
          ))}
          {lines.length > 30 && <li className="text-[#9A9A98]">and {lines.length - 30} more</li>}
        </ul>
      )}
    </div>
  );
}

/** One skill or app opened: what it is, who has it, its versions, its SKILL.md and files. */
function SkillView({ state, ws, skill: r, team, labels, onBack }: { state: AppState; ws: string; skill: SkillRef; team: Bot[]; labels: string[]; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  // Read again after a change here, and whenever the state says it changed (a publish, a roll back, a sync from Orgo, an approval).
  const [tick, setTick] = useState(0);
  const read = useCallback(async () => setTick((n) => n + 1), []);
  const approvals = state.workspaces?.find((w) => w.id === ws)?.approvals?.length ?? 0;
  // The error a failed read put up (not one an action did), so a later read that works takes it down.
  const readError = useRef<string | null>(null);
  useEffect(() => {
    let gone = false;
    void call<Detail>({ action: "detail", ws, kind: r.kind, slug: r.slug, ...(version ? { version } : {}) }).then((d) => {
      if (gone) return;
      if (d.ok) {
        setDetail(d.json);
        // A read that worked since one that didn't: its error no longer holds.
        setError((e) => (e === readError.current ? null : e));
        readError.current = null;
      } else {
        readError.current = d.error;
        setError(d.error);
      }
    });
    return () => {
      gone = true;
    };
  }, [ws, r.kind, r.slug, version, r.updatedAt, approvals, tick]);
  const act = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    setError(null);
    setProblems([]);
    const res = await call<unknown>({ ws, kind: r.kind, slug: r.slug, ...body });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      setProblems(res.problems ?? []);
      return false;
    }
    await read();
    return true;
  };
  const reveal = bridge()?.revealFolder;
  const latest = r.versions?.at(-1)?.version;
  const canPublish = !version && (r.status === "draft" || !!detail?.changed);
  const word = r.kind === "app" ? "app" : "skill";

  return (
    <div className="motion-fade-in flex flex-col gap-4">
      <button onClick={onBack} className="self-start text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
        ‹ Back
      </button>
      <div className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[17px] font-semibold leading-[22px]">{r.name}</span>
          {r.status === "draft" ? <span className={DRAFT}>Draft</span> : <span className={CHIP}>v{r.version}</span>}
          {r.kind === "skill" && <LabelChip label={labels.find((l) => sameLabel(l, cleanLabel(r.label))) ?? cleanLabel(r.label)} labels={labels} busy={!!busy} onPick={(l) => void act("label", labelEdit(l))} />}
          {r.risk && <span className={CHIP}>{RISK[r.risk] ?? r.risk}</span>}
          {r.runsOn && <span className={CHIP}>Runs {r.runsOn === "local" ? "on its computer" : `on ${r.runsOn}`}</span>}
        </span>
        <span className="text-[13px] leading-[19px] text-[#3A3A38]">{r.description}</span>
        {r.status === "draft" && <span className="text-[12px] leading-4 text-[#9A9A98]">Its bots don&apos;t use it until it&apos;s published.</span>}
        {detail?.changed && r.status === "published" && !version && <span className="text-[12px] leading-4 text-[#9A9A98]">Its folder changed since v{r.version}. Publish to have its bots use the change.</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canPublish && (
          <button disabled={!!busy} onClick={() => void act("publish", { action: "publish" })} className={`${PILL} bg-ink text-white`}>
            {busy === "publish" ? "Publishing…" : r.status === "draft" && !latest ? "Publish" : "Publish a new version"}
          </button>
        )}
        {reveal && detail?.dir && !detail.missing && (
          <button onClick={() => void reveal(detail.dir!)} className={`${PILL} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
            Open in Finder
          </button>
        )}
        <button disabled={!!busy} onClick={() => setSure(true)} className={`${PILL} text-[#B42318] hover:bg-[#FEF3F2]`}>
          Delete
        </button>
      </div>
      {sure && (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#FEF3F2] px-3 py-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-[#3A3A38]">Delete this {word}, its folder and every version? Its bots stop using it.</span>
          <button disabled={!!busy} onClick={() => void act("delete", { action: "delete" }).then((ok) => ok && onBack())} className={`${PILL} bg-[#B42318] text-white`}>
            {busy === "delete" ? "Deleting…" : "Delete"}
          </button>
          <button onClick={() => setSure(false)} className={`${PILL} bg-white hover:bg-[#F7F7F6]`}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="flex flex-col gap-0.5 text-[12.5px] leading-[18px] text-[#B42318]">
          <span>{error}</span>
          {problems.map((p, i) => (
            <span key={i} className="text-[12px] text-[#6B6B6B]">
              <span className="font-mono">{p.path || "the folder"}{p.line ? `:${p.line}` : ""}</span> {p.reason}
            </span>
          ))}
        </div>
      )}

      {team.length > 0 && (
        <Group title="Bots">
          <div className="flex flex-wrap gap-1.5 px-4 pb-3 pt-1">
            {team.map((b) => {
              const on = !r.botIds.length || r.botIds.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={on}
                  disabled={!!busy}
                  data-tip={on ? `${b.name} has it. Tap to take it away` : `Give it to ${b.name}`}
                  onClick={() => void act(`bot:${b.id}`, { action: "bot", botId: b.id, on: !on })}
                  className={`flex h-[26px] items-center gap-1.5 rounded-full pl-1 pr-2.5 text-[12px] font-medium leading-4 disabled:opacity-50 ${on ? "bg-[#FBFFE0] text-ink shadow-[0_0_0_1.5px_#0A0A0A]" : "text-[#6B6B6B] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"}`}
                >
                  <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
                  {b.name}
                </button>
              );
            })}
          </div>
        </Group>
      )}

      {!!r.versions?.length && (
        <Group title="Versions">
          {[...r.versions].reverse().map((v, i, all) => {
            const current = v.version === r.version;
            const viewing = version === v.version;
            return (
              <div key={v.version} className={`flex items-center gap-2 px-4 py-2 ${i === all.length - 1 ? "pb-3" : "border-b border-black/[0.05]"}`}>
                <span className="text-[13px] font-medium leading-4">v{v.version}</span>
                <span className="text-[12px] leading-4 text-[#9A9A98]">{new Date(v.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                {current && <span className={CHIP}>In use</span>}
                <span className="flex-1" />
                <button onClick={() => setVersion(viewing ? undefined : v.version)} className="text-[12px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
                  {viewing ? "Back to the folder" : "View"}
                </button>
                {!current && (
                  <button disabled={!!busy} onClick={() => void act(`rollback:${v.version}`, { action: "rollback", version: v.version })} className="text-[12px] font-medium leading-4 text-ink disabled:opacity-50">
                    {busy === `rollback:${v.version}` ? "Rolling back…" : "Roll back to this"}
                  </button>
                )}
              </div>
            );
          })}
        </Group>
      )}

      {!detail ? (
        !error && (
          <span role="status" className="flex items-center gap-2 text-[13px] text-[#6B6B6B]">
            <Spinner size={12} color="#6B6B6B" />
            Reading it
          </span>
        )
      ) : detail.missing ? (
        <span className="text-[13px] leading-[19px] text-[#6B6B6B]">Its folder isn&apos;t on this Mac.</span>
      ) : (
        <>
          {detail.files.length > 0 && (
            <Group title="Files">
              {detail.files.map((f, i) => (
                <FileRow key={f.path} ws={ws} skill={r} file={f} version={version} last={i === detail.files.length - 1} onApproved={read} />
              ))}
            </Group>
          )}
          <Group title={version ? `SKILL.md, v${version}` : "SKILL.md"}>
            <div className="px-4 pb-4 pt-1">
              <SkillMarkdown text={detail.body} />
            </div>
          </Group>
        </>
      )}
    </div>
  );
}

/** A file: its path and size; a script says whether it's approved, and Review shows it with Approve. A binary file (a program, an image) is never shown as text. */
function FileRow({ ws, skill: r, file: f, version, last, onApproved }: { ws: string; skill: SkillRef; file: FileInfo; version?: string; last: boolean; onApproved: () => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = async () => {
    if (text !== null) return setText(null);
    if (f.binary) return setText("");
    const res = await call<{ content: string }>({ action: "file", ws, kind: r.kind, slug: r.slug, path: f.path, ...(version ? { version } : {}) });
    if (res.ok) setText(res.json.content);
    else setError(res.error);
  };
  const approve = async (on: boolean) => {
    setBusy(true);
    const res = await call<unknown>({ action: "approve", ws, sha256: f.sha256, on });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setText(null);
    await onApproved();
  };
  const size = f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${Math.round(f.size / 1024)} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`;
  return (
    <div className={`flex flex-col gap-1.5 px-4 py-2 ${last ? "pb-3" : "border-b border-black/[0.05]"}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-4">{f.path}</span>
        <span className="shrink-0 text-[11.5px] leading-4 text-[#9A9A98]">{f.binary ? `Binary, ${size}` : size}</span>
        {f.script && (f.approved ? <span className={CHIP}>Approved</span> : <span className="rounded-full bg-[#FFF4E5] px-2 py-px text-[11px] leading-4 text-[#9A5B00]">Needs approval</span>)}
        {(!f.binary || f.script) && (
          <button onClick={() => void review()} className="shrink-0 text-[12px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
            {text !== null ? "Hide" : f.script && !f.approved ? "Review" : "View"}
          </button>
        )}
      </div>
      {text !== null && (
        <div className="motion-fade-in flex flex-col gap-2">
          {f.binary ? (
            <p className="rounded-[10px] bg-[#F7F7F6] px-3 py-2 text-[12px] leading-[17px] text-[#3A3A38] shadow-[0_0_0_1px_#ECECEA]">A program, so it can&apos;t be shown as text. Approve it only if you trust where it came from.</p>
          ) : (
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-[#F7F7F6] px-3 py-2 font-mono text-[11.5px] leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#ECECEA]">{text}</pre>
          )}
          {f.script && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-[#9A9A98]">sha256 {f.sha256.slice(0, 16)}</span>
              <span className="flex-1" />
              {f.approved ? (
                <button disabled={busy} onClick={() => void approve(false)} className={`${PILL} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
                  Take approval back
                </button>
              ) : (
                <button disabled={busy} onClick={() => void approve(true)} className={`${PILL} bg-ink text-white`}>
                  {busy ? "Approving…" : "Approve this script"}
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl bg-white shadow-[0_0_0_1px_#ECECEA]">
      <span className="px-4 pb-1 pt-[11px] text-[13px] font-semibold leading-4">{title}</span>
      {children}
    </div>
  );
}

/** `code`, **bold**, and the rest as text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
      <code key={i} className="rounded bg-[#F2F2F0] px-1 font-mono text-[11.5px]">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("**") && part.endsWith("**") && part.length > 3 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** SKILL.md's body as a page: headings, lists, code blocks, tables as text, paragraphs. Nothing in it runs. */
export function SkillMarkdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      const fence = line.trim().slice(0, 3);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++} className="overflow-x-auto rounded-[10px] bg-[#F7F7F6] px-3 py-2 font-mono text-[11.5px] leading-4 text-[#3A3A38]">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const size = h[1].length === 1 ? "text-[16px]" : h[1].length === 2 ? "text-[14px]" : "text-[13px]";
      out.push(
        <span key={key++} className={`${size} block pt-2 font-semibold leading-5`}>
          {inline(h[2])}
        </span>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++} className={`${ordered ? "list-decimal" : "list-disc"} flex flex-col gap-0.5 pl-5`}>
          {items.map((x, n) => (
            <li key={n}>{inline(x)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,4}\s|[-*]\s|\d+\.\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(
      <p key={key++} className={para.some((l) => l.trimStart().startsWith("|")) ? "whitespace-pre-wrap font-mono text-[11.5px]" : ""}>
        {inline(para.join(para.some((l) => l.trimStart().startsWith("|")) ? "\n" : " "))}
      </p>,
    );
  }
  return <div className="flex flex-col gap-2 text-[13px] leading-[19px] text-[#3A3A38]">{out}</div>;
}
