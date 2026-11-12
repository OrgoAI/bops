"use client";

import type { GithubSetting } from "@/cloud/protocol";

/*
 * Where an app's production is on GitHub, as a form: the owner's own (components/app/app-envs.tsx, Publish's menu) and an
 * Admin's or a Member's with App secrets in a shared workspace's Your Apps (components/app/shared-apps.tsx GithubPart).
 * The same fields and the same cleaning for both: lib/hosted-apps.ts cleanGithubMirror (cloud/github-config.ts) checks
 * what it sends again, on the owner's Mac and in Bops Cloud. Imports nothing of either page, so both take it.
 */

/** The GitHub production form as typed: its lists as one line each ("a, b", "client=cclc"). */
export type GhForm = { repo: string; branch: string; path: string; keep: string; workflow: string; inputs: string };

/** An empty form, for an app with none yet. */
export const NO_GH_FORM: GhForm = { repo: "", branch: "main", path: "", keep: "", workflow: "", inputs: "" };

/** The form as the route takes it (lib/hosted-apps.ts cleanGithubMirror checks it again). */
export function ghMirrorOf(f: GhForm): GithubSetting {
  const keep = f.keep.split(",").map((x) => x.trim()).filter(Boolean);
  const inputs = Object.fromEntries(
    f.inputs
      .split(",")
      .map((x) => x.split("=").map((y) => y.trim()))
      .filter((kv) => kv.length === 2 && kv[0])
      .map((kv) => [kv[0], kv[1]] as const),
  );
  return {
    repo: f.repo.trim(),
    branch: f.branch.trim() || "main",
    path: f.path.trim(),
    ...(keep.length ? { keep } : {}),
    ...(f.workflow.trim() ? { dispatch: { workflow: f.workflow.trim(), ...(Object.keys(inputs).length ? { inputs } : {}) } } : {}),
  };
}

/** A setting as the form shows it, to change it (ghMirrorOf's other way). */
export const ghFormOf = (g: Partial<GithubSetting> | null | undefined): GhForm =>
  g
    ? {
        repo: g.repo ?? "",
        branch: g.branch ?? "main",
        path: g.path ?? "",
        keep: (g.keep ?? []).join(", "),
        workflow: g.dispatch?.workflow ?? "",
        inputs: Object.entries(g.dispatch?.inputs ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(", "),
      }
    : { ...NO_GH_FORM };

/** What the form says: its title, the line under it, and its button (the owner's own, unless a page says otherwise). */
export type GhFormWords = { title: string; blurb: string; save: string; saving: string };
export const OWNER_GH_WORDS: GhFormWords = {
  title: "Publish to GitHub",
  blurb: "Ingot stays where it's worked on and previewed. Publish pushes what the Preview serves into this folder, with your GitHub key in Keys, and that repo's own workflow deploys it.",
  save: "Save",
  saving: "Saving…",
};

const DARK = "whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[12px] font-semibold leading-4 text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]";

/**
 * Where an app's production is on GitHub: the repo, its branch and the app's folder in it, the files that stay in
 * Ingot alone, and a workflow to run after a push (for one that doesn't start on a push).
 */
export function GithubForm({
  form,
  onChange,
  busy,
  onSave,
  onCancel,
  compact,
  words = OWNER_GH_WORDS,
}: {
  form: GhForm;
  onChange: (f: GhForm) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  compact?: boolean;
  words?: GhFormWords;
}) {
  const field = (key: keyof GhForm, label: string, placeholder: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">{label}</span>
      <input
        data-gh-field={key}
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => onChange({ ...form, [key]: e.target.value })}
        className="h-8 rounded-[8px] bg-white px-2.5 text-[12.5px] leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] outline-none placeholder:text-[#B0B0AE] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
      />
    </label>
  );
  const why = form.repo.trim() ? undefined : "Which repo?";
  return (
    <div data-gh-form className={`${compact ? "pl-[26px] pr-2" : ""} pt-2`} onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-col gap-2.5 rounded-[12px] bg-[#F7F7F6] p-3">
        <span className="text-[12.5px] font-semibold leading-4 text-ink">{words.title}</span>
        <span className="text-[12px] leading-[17px] text-[#6B6B6B]">{words.blurb}</span>
        <div className="grid grid-cols-1 gap-2 @[420px]:grid-cols-3">
          {field("repo", "Repo", "OrgoAI/orgo-brandlord")}
          {field("branch", "Branch", "main")}
          {field("path", "Folder in it", "formula (empty: the whole repo)")}
        </div>
        {field("keep", "Left alone both ways (files, or folders ending in /)", "proxy.ts, clients/other/")}
        <div className="grid grid-cols-1 gap-2 @[420px]:grid-cols-2">
          {field("workflow", "Workflow to run after a push (optional)", "deploy.yml")}
          {field("inputs", "Its inputs", "client=cclc")}
        </div>
        <div className="flex items-center gap-2">
          {/* (Greyed with why in its tooltip, on what holds it: a disabled button gets no pointer events in some browsers.) */}
          <span data-tip={why} onClick={(e) => e.stopPropagation()} className="flex shrink-0">
            <button data-act="gh-save" disabled={!!why || busy} onClick={onSave} className={DARK}>
              {busy ? words.saving : words.save}
            </button>
          </span>
          <button onClick={onCancel} className="text-[12.5px] leading-4 text-[#6B6B6B] hover:text-ink">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
