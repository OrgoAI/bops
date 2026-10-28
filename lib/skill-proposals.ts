import type { SkillProposal } from "./types";

/*
 * Changes a bot proposed to its workspace's skills (Message.skillProposals, lib/server/skill-proposals.ts): how one
 * applies to a file's text, and how a change reads as a diff. Pure, for the Mac server and the window alike (the
 * card under the bot's message: components/app/skill-proposals.tsx).
 */

/** The most edits one proposal makes, and the longest text each side of one, or a whole new file, may be. */
export const PROPOSAL_LIMITS = { edits: 20, edit: 20_000, content: 64 * 1024, summary: 400, perTurn: 6 } as const;

/** How many times `part` is in `text`. */
const times = (text: string, part: string) => {
  let n = 0;
  for (let i = text.indexOf(part); i !== -1 && n < 2; i = text.indexOf(part, i + part.length)) n++;
  return n;
};

/**
 * A file's text with the edits made, in order, each `old` exactly once in the text as it is by then (never zero
 * times, never twice: what it changes is never a guess), or why one can't be.
 */
export function applyEdits(text: string, edits: { old: string; new: string }[]): { text: string } | { error: string } {
  let out = text;
  for (const [i, e] of edits.entries()) {
    const which = edits.length > 1 ? `Edit ${i + 1}` : "The edit";
    if (!e.old) return { error: `${which} has no old text to change.` };
    const n = times(out, e.old);
    if (n === 0) return { error: `${which}: its old text isn't in the file.` };
    if (n > 1) return { error: `${which}: its old text is in the file more than once. Give more of the text around it.` };
    const at = out.indexOf(e.old);
    out = out.slice(0, at) + e.new + out.slice(at + e.old.length);
  }
  return { text: out };
}

/** The text a proposal makes of a file's text now (null: a file it doesn't have yet), or why it can't. */
export function proposedText(p: Pick<SkillProposal, "edits" | "content">, now: string | null): { text: string } | { error: string } {
  if (typeof p.content === "string") return { text: p.content };
  if (now === null) return { error: "The file isn't there, so its old text can't be changed." };
  return applyEdits(now, p.edits ?? []);
}

/** One line of a diff: kept (" "), taken out ("-") or put in ("+"). */
export type DiffLine = { t: " " | "-" | "+"; s: string };
/** Beyond this many lines a side, a diff is every old line out and every new one in. */
const DIFF_MAX = 1500;

/**
 * The lines that changed from `a` to `b` (a longest common run of lines kept), with `context` kept lines around
 * each change and "…" between, so a long file shows only what changed.
 */
export function lineDiff(a: string, b: string, context = 2): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  let all: DiffLine[];
  if (x.length > DIFF_MAX || y.length > DIFF_MAX) all = [...x.map((s) => ({ t: "-" as const, s })), ...y.map((s) => ({ t: "+" as const, s }))];
  else {
    // The longest common subsequence's lengths, from the end.
    const n = x.length;
    const m = y.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    all = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        all.push({ t: " ", s: x[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) all.push({ t: "-", s: x[i++] });
      else all.push({ t: "+", s: y[j++] });
    }
  }
  const near = all.map((l, k) => l.t !== " " || all.slice(Math.max(0, k - context), k + context + 1).some((z) => z.t !== " "));
  const out: DiffLine[] = [];
  for (const [k, l] of all.entries()) {
    if (near[k]) out.push(l);
    else if (out[out.length - 1]?.s !== "…") out.push({ t: " ", s: "…" });
  }
  return out;
}

/** A proposal's change as diff lines with no file to compare to: each edit's old lines out and new lines in, a whole new file all in. */
export function proposalLines(p: Pick<SkillProposal, "edits" | "content">): DiffLine[] {
  if (typeof p.content === "string") return p.content.split("\n").map((s) => ({ t: "+" as const, s }));
  return (p.edits ?? []).flatMap((e, i) => [...(i ? [{ t: " " as const, s: "…" }] : []), ...e.old.split("\n").map((s) => ({ t: "-" as const, s })), ...e.new.split("\n").map((s) => ({ t: "+" as const, s }))]);
}

/** How one stands, for the card and a member's read only view. */
export const proposalStatus = (p: Pick<SkillProposal, "status">) => p.status ?? "open";

/** What the bot says when a turn offered changes and said nothing else. */
export const proposedWords = (n: number) => (n === 1 ? "I proposed a change to a skill. It changes once you accept it." : `I proposed ${n} changes to skills. Each changes once you accept it.`);
