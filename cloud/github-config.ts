/*
 * Where an app's production lives on GitHub (lib/hosted-apps.ts AppHosting.github), as both sides check it: the owner's
 * Bops when the owner sets it from the Bops window (lib/server/hosted-apps.ts setGithubMirror), and Bops Cloud when an
 * Admin, or a Member with App secrets, sets it from a shared workspace's Your Apps (cloud/members.ts githubHere). One
 * rule for both: the same words for a repo, branch or folder that won't do, and the same point kept or dropped
 * (keepsPoint). Imported by Bops Cloud, the window and the Mac server, so it imports nothing.
 */

/**
 * Where an app's production lives on GitHub (AppHosting.github). `path`: the folder of the repo the app's files are
 * ("" the whole repo). `keep`: paths left alone either way (a path, or a folder ending in /): never sent to GitHub,
 * never taken from it (a preview's own password file; another app's client in a shared folder). `dispatch`: a workflow
 * to run after a push, for one that doesn't start on a push. `last`: where the two were last the same (Link, Publish,
 * or Bring in): `sha`, the GitHub commit; `ingot`, the Ingot changeset that matches it, which a preview must be at
 * or after to publish (lib/server/github-mirror.ts).
 */
export type GithubMirror = {
  repo: string;
  branch: string;
  path: string;
  keep?: string[];
  dispatch?: { workflow: string; inputs?: Record<string, string> };
  /** (`keep`: the paths left alone when it was made: one taken off the list since needs a new Link.) */
  last?: { sha: string; ingot: string; keep?: string[]; when: number };
};

export const GH_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const GH_BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
export const GH_PATH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/@ -]{0,300}$/;

/** A GitHub mirror as the window sends it, cleaned, or why it won't do. `last` is the server's own (never taken from here). */
export function cleanGithubMirror(v: unknown): { ok: Omit<GithubMirror, "last"> } | { why: string } {
  const m = v as Partial<GithubMirror> | null;
  const repo = typeof m?.repo === "string" ? m.repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") : "";
  if (!GH_REPO.test(repo)) return { why: "Which GitHub repo? Like OrgoAI/orgo-brandlord." };
  const branch = typeof m?.branch === "string" && m.branch.trim() ? m.branch.trim() : "main";
  if (!GH_BRANCH.test(branch)) return { why: "That isn't a branch name." };
  const path = (typeof m?.path === "string" ? m.path.trim() : "").replace(/^\/+|\/+$/g, "");
  if (!GH_PATH.test(path)) return { why: "That isn't a folder in the repo." };
  const typed = Array.isArray(m?.keep) ? m.keep.filter((k): k is string => typeof k === "string").map((k) => k.trim().replace(/^\/+/, "")).filter(Boolean) : [];
  const bad = typed.find((k) => !GH_PATH.test(k));
  if (bad) return { why: `"${bad.slice(0, 80)}" can't be a path left alone (letters, digits, . _ - @ / and spaces; a folder ends in /).` };
  const keep = [...new Set(typed)].slice(0, 50);
  const w = m?.dispatch;
  const workflow = typeof w?.workflow === "string" ? w.workflow.trim() : "";
  if (workflow && !/^[A-Za-z0-9_.-]{1,100}\.ya?ml$/.test(workflow)) return { why: "That isn't a workflow file, like deploy.yml." };
  const inputs =
    w?.inputs && typeof w.inputs === "object"
      ? Object.fromEntries(Object.entries(w.inputs).filter(([k, x]) => /^[A-Za-z0-9_-]{1,50}$/.test(k) && typeof x === "string" && x.length <= 200).slice(0, 10) as [string, string][])
      : undefined;
  return { ok: { repo, branch, path, ...(keep.length ? { keep } : {}), ...(workflow ? { dispatch: { workflow, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) } } : {}) } };
}

type Where = Pick<GithubMirror, "repo" | "branch" | "path" | "keep">;

/**
 * Whether a new setting keeps the point (GithubMirror.last) of the one before: the same repo, branch and folder, with
 * every path the old one left alone still left alone (more is fine). Else it needs linking again.
 */
export const keepsPoint = (was: Where | null | undefined, next: Where): boolean =>
  !!was && was.repo === next.repo && was.branch === next.branch && was.path === next.path && (was.keep ?? []).every((k) => (next.keep ?? []).includes(k));

/**
 * Whether a new setting writes to the same place as the one before: the same repo, branch, folder and workflow (with its
 * inputs). What's left alone (`keep`) isn't part of it: it only ever sends less. Someone other than the owner changes
 * where the GitHub key writes only with a GitHub key of the workspace's own (cloud/members.ts githubKeyFor).
 */
export const sameDestination = (was: Omit<GithubMirror, "last"> | null | undefined, next: Omit<GithubMirror, "last">): boolean =>
  !!was && was.repo === next.repo && was.branch === next.branch && was.path === next.path && sameDispatch(was.dispatch, next.dispatch);

const sameDispatch = (a: GithubMirror["dispatch"], b: GithubMirror["dispatch"]) => {
  if (!a || !b) return !a && !b;
  const ka = Object.entries(a.inputs ?? {}).sort(([x], [y]) => x.localeCompare(y));
  const kb = Object.entries(b.inputs ?? {}).sort(([x], [y]) => x.localeCompare(y));
  return a.workflow === b.workflow && JSON.stringify(ka) === JSON.stringify(kb);
};

/** The GitHub key's vault name (lib/server/github-mirror.ts GITHUB_KEY): what a bot is given in Keys to publish to GitHub. */
export const GITHUB_KEY_NAME = "GITHUB_TOKEN";
