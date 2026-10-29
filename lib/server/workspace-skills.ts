import "server-only";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MAIN_WORKSPACE, procedureKey, workBot, workspaceOf, type Procedure, type ScriptApproval, type SkillKind, type SkillRef, type SkillRisk, type Workspace } from "@/lib/types";
import { appsOpen } from "@/lib/apps-access";
import { builtinLabels, builtinSkills, type BuiltinSkill } from "@/lib/builtin-skills";
import { APPS_LABEL, botHasSkill, cleanLabel, isUnsorted, keptLabel, LABEL_ABOUT_MAX, labelInfoOf, nextBotLabels, sameLabel, UNSORTED, type SkillGroup, type SkillLabelInfo } from "@/lib/skill-labels";
import {
  BUNDLE_LIMITS,
  RISKS,
  bundleSha,
  byteLength,
  checkFolder,
  fileBytes,
  fitFrontmatter,
  freeSlug,
  frontmatterWarnings,
  isScript,
  isVersion,
  junkReason,
  labelOf,
  legacyBundleSha,
  nameProblem,
  nextVersion,
  normalizePath,
  pathFoldKey,
  parseSkillMd,
  renderSkillMd,
  scanFile,
  scanSecrets,
  sha256Hex,
  slugify,
  specOf,
  textOf,
  toSpecForm,
  undeclaredSecrets,
  unscannableBinary,
  validateFrontmatter,
  withLabel,
  withVersion,
  type BundleFile,
  type FolderFile,
  type Problem,
} from "./skill-bundle";
import { onRunner } from "./persist";
import { bot, getState, ownerName, update, userDir } from "./store";
import { outbox } from "./sync-outbox";

/**
 * Skills and apps: a workspace's ways of doing a kind of job (skills) and the tools Bops built that bots
 * run (apps), each a folder in the Agent Skill shape (SKILL.md and its files). On the Mac the folders are
 * the source: <userDir>/workspaces/<id>/skills/<slug>/ and apps/<slug>/, where <id> is the workspace's
 * Orgo project once it has one (else its Bops id). The state keeps what each is (Workspace.skills,
 * Workspace.apps: SkillRef) so the window and the bots' prompts never read a folder to list them.
 *
 * Versions: the folder is what's being worked on (a draft); Publish copies it into
 * .versions/<skills|apps>/<slug>/<version>/ and the bots read that version; Roll back points them at an
 * older one. Scripts run only once someone approved their content (by sha256, so an unchanged script in
 * a new version stays approved). A bot sees only a skill's name and description until it reads one
 * (read_skill), and only the published skills of its own workspace whose bots include it (none named:
 * every bot). When orgo-web has the skills routes and the workspace has its Orgo project, they're kept
 * in step with Orgo (syncSkills); otherwise they stay on this Mac. Every change here queues a sync (a new
 * draft too, and a bot taken off by its delete), and a sync Orgo didn't take is tried again after a
 * backoff. A delete goes to Orgo through an outbox kept with the user's folder (sync-outbox.ts), tried
 * again until Orgo took it, and a sync never brings back one still waiting there. A sync reads only what
 * changed in Orgo since the last one (?since=, kept per Mac in the workspace's folder) with Orgo's record
 * of what was deleted since: one deleted there (on another Mac, on orgo.ai) goes here too, unless it
 * changed here since the two last agreed (then it goes to Orgo again), so several Macs agree on what was
 * deleted. Without a record (the first sync, one too old, an orgo-web without it) the whole list is read,
 * and a skill this Mac had from Orgo's project (SkillRef.remotePid) that Orgo no longer lists is taken as
 * deleted there the same way. Script approvals made here go to Orgo too (POST and DELETE
 * …/skills/approvals with the person's Bops sign-in key, through an outbox kept on disk, after the skill's
 * own sync so Orgo knows the script; one Orgo can't place yet is sent again only once a sync sent a file
 * with that content), and a sync takes the approvals the person signed in here made on orgo.ai or in Bops
 * on another Mac (never another member's: theirs doesn't run a script on this Mac), and revokes made
 * there. The Mac keeps them in step: a computer's runner never syncs or sends a delete.
 *
 * Labels (lib/skill-labels.ts): every skill is listed under one (SkillRef.label), so a bot with many looks
 * at a few labels first, opens the one that fits the job (read_skill with label), and only then reads a
 * skill. Bops' own skills (lib/builtin-skills.ts) are every bot's, under labels of their own. A label
 * chosen for a skill (given when it's made or moved, or in the SKILL.md it came with) is kept in its
 * SKILL.md as metadata.label, so it syncs with Orgo. One without is Unsorted (UNSORTED: no label kept,
 * here, in its SKILL.md or in Orgo's column), and Bops suggests one (SkillRef.labelBy "auto"): from its
 * words (guessLabel), else, or when the workspace has labels of its own, by one small model call for the
 * skills made or imported within a couple of seconds (suggestLabels). A suggestion stays in the state,
 * with Confirm and Change in Skills, until it's confirmed, changed or the skill is published. A version
 * and a computer's folder carry the label as it's listed; Orgo gets a suggestion only once it's confirmed.
 * A label renamed is renamed here at once and in Orgo's database in one step (orgo-web's
 * …/skill-labels/rename), through an outbox kept on disk until Orgo took it.
 *
 * The SKILL.md form is the Agent Skills spec's (skill-bundle.ts toSpecForm): name (the folder's own, which a
 * folder imported must say when it says one), description, and Bops' own fields as strings in metadata
 * (label, version, risk, runs-on, requires-secrets). Every write here is in that form; the form from before
 * (top level version, risk, runs_on, requires_secrets, label) is read too, so nothing kept or synced before
 * stops working, and a skill takes the new form on its next write.
 *
 * Which bot has which (lib/skill-labels.ts botHasSkill, the one rule for every list, read, copy to a computer
 * and count): a skill's own bot list when it names any; else the bot's labels (Bot.skillLabels: unset is
 * every label). So a new skill in a label goes to every bot that has the label, and naming bots on one skill
 * stays the exception. Bops' own skills are every bot's. Orgo keeps the same (orgo-web's skills.label column,
 * which a sync sends with a PATCH once orgo-web's skill JSON says "label", and bops_bots.skill_labels through
 * bops-sync.ts). What the owner wrote about a label (Workspace.skillLabelInfo, orgo-web's skill_labels) is
 * optional: its about line is what a prompt shows for the label, else its skills' names.
 *
 * A bot never changes a skill on its own say: it proposes (skill-proposals.ts), any turn, and only the owner's
 * Accept makes the change the next version, through the same checks and publish as any other.
 */

/** Skills (and apps) per workspace, as orgo-web allows. */
export const MAX_SKILLS = 500;
/** At most this many labels are listed in a prompt (the rest by reading one: read_skill with label). */
const NOTE_MAX = 15;
const NOTE_LINE_MAX = 220;
/** A workspace's own skills up to this many are listed under their labels in a prompt, each with its description (as many as were listed before labels); more, and each label is one line. */
const NOTE_SMALL = 15;
/** The most of a file read_skill gives a bot. */
const FILE_CAP = 20_000;

const g = globalThis as unknown as {
  bopsSkillsRoutes?: Map<string, boolean>;
  bopsSkillsSync?: Map<string, ReturnType<typeof setTimeout>>;
  bopsSkillsTries?: Map<string, number>;
  bopsSkillsDeleteTimer?: ReturnType<typeof setTimeout>;
  bopsSkillsCopied?: Map<string, string>;
  bopsSkillsInFlight?: Map<string, { done: Promise<SyncResult>; again: boolean }>;
  bopsSkillsLabelColumn?: Map<string, boolean>;
  bopsSkillsLabelProbed?: Set<string>;
  bopsSkillLabelsRoute?: Map<string, boolean>;
  bopsSkillLabelRename?: Map<string, boolean>;
  bopsLabelSuggest?: Map<string, { keys: Set<string>; timer: ReturnType<typeof setTimeout> }>;
};

export class SkillError extends Error {
  status: number;
  problems?: Problem[];
  constructor(message: string, status = 400, problems?: Problem[]) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const listKey = (kind: SkillKind) => (kind === "app" ? "apps" : "skills") as "apps" | "skills";

/* ---------------- Where things are ---------------- */

/** The workspace by id, or undefined. */
export const workspaceById = (wsId: string): Workspace | undefined => getState().workspaces?.find((w) => w.id === wsId);

/** Its folder's name: the Orgo project's id once it has one, else its Bops id. Safe as a path either way. */
export const folderKey = (w: Pick<Workspace, "id" | "orgoProjectId">) => (w.orgoProjectId ?? w.id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";

/** <userDir>/workspaces, or null signed out on the Mac app. */
const workspacesRoot = () => {
  const root = userDir();
  return root === null ? null : join(/*turbopackIgnore: true*/ root, "workspaces");
};

/** A workspace's own folder, or null when there's nowhere to keep it. */
export function workspaceDir(wsId: string): string | null {
  const root = workspacesRoot();
  const w = workspaceById(wsId) ?? (wsId === MAIN_WORKSPACE ? { id: MAIN_WORKSPACE } : undefined);
  return root && w ? join(/*turbopackIgnore: true*/ root, folderKey(w)) : null;
}

/** The working folder of a skill or app. */
export function skillDir(wsId: string, kind: SkillKind, slug: string): string | null {
  const ws = workspaceDir(wsId);
  return ws ? join(/*turbopackIgnore: true*/ ws, listKey(kind), slug) : null;
}

/** A version's folder; null for a string that isn't a version (never a path out of .versions). */
const versionDir = (wsId: string, kind: SkillKind, slug: string, version: string) => {
  const ws = workspaceDir(wsId);
  return ws && isVersion(version) ? join(/*turbopackIgnore: true*/ ws, ".versions", listKey(kind), slug, version) : null;
};

/* ---------------- What's in the state ---------------- */

/** A workspace's skills and apps (both, or one kind), oldest first. */
export function refsOf(wsId: string, kind?: SkillKind): SkillRef[] {
  adoptProcedures();
  labelRefs(wsId);
  const w = workspaceById(wsId);
  if (!w) return [];
  return kind ? [...(w[listKey(kind)] ?? [])] : [...(w.skills ?? []), ...(w.apps ?? [])];
}

export const findRef = (wsId: string, kind: SkillKind, slug: string) => refsOf(wsId, kind).find((r) => r.slug === slug);

/** Change one ref in place (by workspace, kind and slug). */
function patchRef(wsId: string, kind: SkillKind, slug: string, fn: (r: SkillRef) => void) {
  update((s) => {
    const r = s.workspaces?.find((w) => w.id === wsId)?.[listKey(kind)]?.find((x) => x.slug === slug);
    if (r) fn(r);
  });
}

/** Whether a bot has a skill of its workspace (lib/skill-labels.ts botHasSkill): named for it, or under one of its labels. */
const forBot = (r: SkillRef, botId: string) => {
  const b = bot(botId);
  return !!b && botHasSkill(r, b);
};

/** The skills and apps a bot can use now: its workspace's published ones that are for it. */
export function skillsFor(botId: string, kind?: SkillKind): SkillRef[] {
  const b = bot(botId);
  if (!b) return [];
  return refsOf(workspaceOf(b), kind).filter((r) => r.status === "published" && forBot(r, botId));
}

/** One of a bot's skills or apps: by slug, then the id it had as a procedure, then its name (case, spacing and dashes aside). */
export function findSkill(botId: string, nameOrSlug: string, { drafts = false } = {}): SkillRef | undefined {
  const b = bot(botId);
  if (!b) return undefined;
  const list = drafts ? refsOf(workspaceOf(b)).filter((r) => forBot(r, botId)) : skillsFor(botId);
  const want = nameOrSlug.trim().replace(/^["“']|["”']$/g, "");
  return list.find((r) => r.slug === want) ?? list.find((r) => r.legacyId === want) ?? list.find((r) => r.name === want) ?? list.find((r) => procedureKey(r.name) === procedureKey(want));
}

/** How a routine or a thread names the skill it follows: its old procedure id when it had one (so what named it before still does), else its slug. */
export const skillRefId = (r: SkillRef) => r.legacyId ?? r.slug;

/* ---------------- Labels ---------------- */

/**
 * The words that place a skill nobody gave a label, read in its name and description (whole words, any
 * case). Plain rules, free: the most hits wins (one in the name counts twice), the first here on a tie, and
 * none is UNSORTED. These are Bops' preset labels, which a model's suggestion may pick too (suggestLabels).
 */
const LABEL_WORDS: { label: string; words: RegExp }[] = [
  { label: "Email", words: /\b(e-?mails?|inbox(es)?|gmail|outlook|mailbox(es)?|newsletters?)\b/g },
  { label: "Calendar", words: /\b(calendars?|meetings?|appointments?|invites?|agendas?|availability|bookings?|reschedul\w*)\b/g },
  { label: "Sales", words: /\b(sales|selling|leads?|prospect\w*|deals?|crm|pipelines?|outreach|quotes?|upsell\w*)\b/g },
  { label: "Recruiting", words: /\b(recruit\w*|hiring|hires?|candidates?|interview\w*|resumes?|applicants?|job posts?|job postings?|offer letters?)\b/g },
  { label: "Finance", words: /\b(financ\w*|invoic\w*|payments?|billing|bills?|expenses?|receipts?|budgets?|payroll|tax(es)?|accounting|bookkeeping|refunds?|revenue|bank\w*|stripe|quickbooks)\b/g },
  { label: "Support", words: /\b(support|tickets?|help ?desk|complaints?|zendesk|intercom|faqs?|customer issues?|bug reports?)\b/g },
  { label: "Research", words: /\b(research\w*|investigat\w*|competitors?|markets?|analy[sz]\w*|look(s|ing)? up|lookups?|sources|papers?)\b/g },
  { label: "Writing", words: /\b(writ(e|es|ing|ten)|drafts?|drafting|blogs?|articles?|copywriting|proofread\w*|memos?|essays?|reports?|docs|documentation)\b/g },
  { label: "Social", words: /\b(social|twitter|tweets?|linkedin|instagram|facebook|tiktok|youtube|reddit|followers?|posts?)\b/g },
  // Only words that mean source control or deploying: "site", "app", "code" or "branch" alone are as often a
  // garage's booking site, the Uber app, a discount code or a bank's branch.
  { label: APPS_LABEL, words: /\b(deploy\w*|git|github|gitlab|repos?|repository|repositories|ingot|commits?|pull requests?|merge conflicts?|frontend|backend)\b/g },
];

/**
 * The label a skill's own words place it under (LABEL_WORDS), or UNSORTED. Bops' own label for apps only for
 * someone apps are open to (lib/apps-access.ts): anyone else's deploy or git skill goes by its other words.
 */
export function guessLabel(name: string, description: string, apps = appsOpen(getState())): string {
  const hits = (text: string, re: RegExp) => text.toLowerCase().match(re)?.length ?? 0;
  let best = UNSORTED;
  let most = 0;
  for (const { label, words } of LABEL_WORDS) {
    if (!apps && label === APPS_LABEL) continue;
    const n = 2 * hits(name, words) + hits(description, words);
    if (n > most) [best, most] = [label, n];
  }
  return best;
}

/** Never looked at (from before labels), or kept as "Other" or "Unsorted" before Unsorted was no label. */
const unlooked = (r: SkillRef) => (!r.label && !r.labelBy) || (r.label !== undefined && isUnsorted(r.label));

/**
 * Skills from before labels get a suggestion, once, from their own words (guessLabel: labelBy "auto"); one
 * kept as "Other" or "Unsorted" before is Unsorted, no label, from now on.
 */
function labelRefs(wsId: string) {
  const w = workspaceById(wsId);
  if (!w || ![...(w.skills ?? []), ...(w.apps ?? [])].some(unlooked)) return;
  update((s) => {
    const ws = s.workspaces?.find((x) => x.id === wsId);
    for (const r of [...(ws?.skills ?? []), ...(ws?.apps ?? [])]) {
      if (!unlooked(r)) continue;
      const was = r.label;
      delete r.label;
      if (was !== undefined) {
        r.labelBy ??= "user";
        continue;
      }
      // An app gets none: its label is changed nowhere in Skills, so a suggestion could never be confirmed.
      if (r.kind === "app") {
        r.labelBy = "skill";
        continue;
      }
      const guess = keptLabel(guessLabel(r.name, r.description));
      if (guess) r.label = guess;
      r.labelBy = "auto";
    }
  });
}

/** A ref's label as it's listed (one never looked at: from its words, as labelRefs gives it). */
const labelOfRef = (r: SkillRef) => (r.label ? cleanLabel(r.label) : r.labelBy ? UNSORTED : guessLabel(r.name, r.description));
/** Bops' suggestion, not confirmed yet: listed under it here, kept out of its SKILL.md and Orgo. */
const suggested = (r: SkillRef) => r.labelBy === "auto" && !!r.label;
/** Its label as its SKILL.md and Orgo have it: a suggestion is none there (Unsorted) until it's confirmed. */
const sentLabelOf = (r: SkillRef) => (suggested(r) ? UNSORTED : labelOfRef(r));

/** Bops' preset labels (LABEL_WORDS), the apps one only where apps are open. */
const presetLabels = (apps = appsOpen(getState())) => LABEL_WORDS.filter((w) => apps || w.label !== APPS_LABEL).map((w) => w.label);

/**
 * A label for a skill of this workspace, spelled as one already in use when it's the same one (sameLabel:
 * "email" is the workspace's "Email"): Bops' own labels, then the workspace's, then those guessLabel gives
 * and UNSORTED; else a new one, as given.
 */
export function knownLabel(wsId: string, label: unknown): string {
  const want = cleanLabel(label);
  const apps = appsOpen(getState());
  const known = [...builtinLabels(apps).map((b) => b.label), ...refsOf(wsId).map(labelOfRef), ...presetLabels(apps), UNSORTED].find((l) => sameLabel(l, want));
  return known ? cleanLabel(known) : want;
}

/* ---------------- Labels a model suggests ---------------- */

/** Skills made or imported within this long of each other are labeled in one call. */
const SUGGEST_WAIT_MS = 2000;
/** At most this many skills in one call (the rest keep the label from their words, or none). */
const SUGGEST_MAX = 40;
/** A dash used as punctuation: any of the long ones, or a hyphen with a space on each side ("Follow-up" is a word). */
const DASHED = /[\u2012-\u2015]|\s-\s/;

/** The workspace's own labels: those its skills are under or the owner wrote about, not Bops' preset ones nor Unsorted. */
function ownLabels(wsId: string): string[] {
  const presets = presetLabels();
  return workspaceLabels(wsId).filter((l) => !isUnsorted(l) && !presets.some((p) => sameLabel(p, l)));
}

/** Whether the model may be asked for this workspace: Suggest labels with AI on (Workspace.skillLabelsAIOff unset), never on a computer's runner, signed in on this Mac. */
const suggestOn = (wsId: string) => !onRunner() && userDir() !== null && !!workspaceById(wsId) && !workspaceById(wsId)!.skillLabelsAIOff;

/** One call: each skill's place in the batch to the label picked for it (one of `labels`, Unsorted, or a new one), or null when it couldn't be asked. */
export type AskLabels = (skills: { i: number; name: string; description: string }[], labels: string[]) => Promise<Map<number, string> | null>;
/** Tests: a stand in for the model, and a batch run now instead of after its wait. */
export const labelSuggestForTests: { ask?: AskLabels; run: (wsId: string) => Promise<void> } = { run: (wsId) => suggestLabels(wsId) };

/** The small model through Bops Cloud (skill-label-model.ts), only when the cloud carries it: self hosted, signed out or offline, none. */
const askModel: AskLabels = async (skills, labels) => {
  const { cloudProxy } = await import("./cloud");
  if (!cloudProxy("openai")) return null;
  const { pickLabels } = await import("./skill-label-model");
  return pickLabels(skills, labels);
};

/** A new skill for the next call, a couple of seconds from now (the one after it in that time joins it). */
function queueSuggest(wsId: string, kind: SkillKind, slug: string) {
  if (!suggestOn(wsId)) return;
  const batches = (g.bopsLabelSuggest ??= new Map());
  const had = batches.get(wsId);
  if (had) clearTimeout(had.timer);
  const keys = had?.keys ?? new Set<string>();
  keys.add(`${kind}:${slug}`);
  const timer = setTimeout(() => void suggestLabels(wsId).catch((e: Error) => console.warn(`[skills] labels: ${e.message}`)), SUGGEST_WAIT_MS);
  timer.unref?.();
  batches.set(wsId, { keys, timer });
}

/**
 * The skills waiting for a label (queueSuggest), in one call of a small model (labelBy "auto" for each it
 * places): it picks among the workspace's own labels (Bops' preset ones while it has none), and may add one new short label at
 * most. Off, out of credit, offline or an answer that isn't usable: each keeps the label from its words, or
 * none. One whose label was chosen meanwhile keeps that.
 */
async function suggestLabels(wsId: string) {
  const batches = (g.bopsLabelSuggest ??= new Map());
  const b = batches.get(wsId);
  batches.delete(wsId);
  if (b) clearTimeout(b.timer);
  if (!b?.keys.size || !suggestOn(wsId)) return;
  const open = (r: SkillRef | undefined): r is SkillRef => !!r && r.labelBy === "auto";
  const refs = [...b.keys].map((k) => findRef(wsId, k.startsWith("app:") ? "app" : "skill", k.slice(k.indexOf(":") + 1))).filter(open).slice(0, SUGGEST_MAX);
  if (!refs.length) return;
  // The workspace's own labels once it has some, else Bops' preset ones: never both, so the two don't mix.
  const own = ownLabels(wsId);
  const choices = [...new Map((own.length ? own : presetLabels()).map((l) => [l.toLowerCase(), cleanLabel(l)])).values()];
  const picked = await (labelSuggestForTests.ask ?? askModel)(refs.map((r, i) => ({ i, name: r.name, description: cut(r.description, 300) })), choices).catch(() => null);
  if (!picked) return;
  let fresh: string | undefined;
  for (const [i, said] of picked) {
    const r = refs[i];
    const now = r && findRef(wsId, r.kind, r.slug);
    if (!open(now) || isUnsorted(said) || scanSecrets("label", said).length) continue;
    let label = choices.find((c) => sameLabel(c, said));
    if (!label) {
      // A new one with a dash as punctuation (a long dash between "Sales" and "calls") isn't taken, however the prompt asked: it would be
      // listed in Skills, Who has what and every bot's prompt, and once confirmed in its SKILL.md and on Orgo.
      if (DASHED.test(said)) continue;
      // One new label a call: a second one keeps the label from its words.
      fresh ??= cleanLabel(said);
      if (!sameLabel(fresh, said)) continue;
      label = fresh;
    }
    const to = label;
    if (sameLabel(labelOfRef(now), to)) continue;
    patchRef(wsId, now.kind, now.slug, (x) => {
      x.label = to;
      x.labelBy = "auto";
    });
  }
}

/** Suggest labels with AI, in Skills: on (the default) or off for the workspace. */
export function setLabelSuggest(wsId: string, on: boolean): boolean {
  if (!workspaceById(wsId)) throw new SkillError("That workspace is gone.", 404);
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (!w) return;
    if (on) delete w.skillLabelsAIOff;
    else w.skillLabelsAIOff = true;
  });
  return on;
}

/* ---------------- Who has what ---------------- */

/**
 * Every label of a workspace's own skills and apps, the ones the owner wrote about first in their order, Unsorted
 * last: the rows of Who has what, and what a bot with every label has. Bops' own skills aren't counted: they're
 * every bot's.
 */
export function workspaceLabels(wsId: string): string[] {
  const out: string[] = [];
  const add = (l: string) => {
    const c = cleanLabel(l);
    if (!out.some((x) => sameLabel(x, c))) out.push(c);
  };
  for (const x of [...(workspaceById(wsId)?.skillLabelInfo ?? [])].sort((a, b) => a.position - b.position)) add(x.name);
  for (const r of refsOf(wsId)) add(labelOfRef(r));
  return [...out.filter((l) => !isUnsorted(l)), ...out.filter((l) => isUnsorted(l))];
}

/** A bot of the workspace, or why not. */
function teamBot(wsId: string, botId: string) {
  const b = bot(botId);
  if (!b || workspaceOf(b) !== wsId) throw new SkillError("That bot isn't in this workspace.", 404);
  return b;
}

/** A bot's labels as they are now (undefined: every label), kept. */
function keepBotLabels(botId: string, labels: string[] | undefined) {
  update((s) => {
    const x = s.bots.find((y) => y.id === botId);
    if (!x) return;
    if (labels === undefined) delete x.skillLabels;
    else x.skillLabels = labels;
  });
}

/**
 * Tick or untick a label for a bot (Who has what, in Skills, or the bot's own Skills): lib/skill-labels.ts
 * nextBotLabels, so the first untick of a bot with every label leaves it every label but that one, and every
 * label ticked again is every label (new ones too). A skill naming its own bots goes by them whatever this says.
 */
export function setBotLabel(wsId: string, botId: string, label: string, on: boolean): string[] | undefined {
  const b = teamBot(wsId, botId);
  const next = nextBotLabels(b.skillLabels, workspaceLabels(wsId), knownLabel(wsId, label), on);
  keepBotLabels(botId, next);
  return next;
}

/** A bot's labels set at once: null is every label (new ones too), a list only those (none: no skill of the workspace's but those naming it). */
export function setBotLabels(wsId: string, botId: string, labels: string[] | null): string[] | undefined {
  teamBot(wsId, botId);
  const next = labels === null ? undefined : [...new Map(labels.filter((l) => typeof l === "string").map((l) => knownLabel(wsId, l)).map((l) => [l.toLowerCase(), l])).values()];
  keepBotLabels(botId, next);
  return next;
}

/**
 * Only where it's listed: its SKILL.md says the label (the rest of its folder as it is; none for Unsorted).
 * A suggestion moved to another label stays one, out of its SKILL.md. `bump`: a change for the next sync
 * to send (a rename Orgo's database doesn't take in one step).
 */
function relabel(wsId: string, r: SkillRef, label: string, bump: boolean) {
  const auto = suggested(r) && !isUnsorted(label);
  const dir = skillDir(wsId, r.kind, r.slug);
  const now = readBundle(dir);
  if (!auto && now && dir) writeFileSync(join(/*turbopackIgnore: true*/ dir, "SKILL.md"), renderSkillMd(withLabel(now.frontmatter, label), now.body));
  patchRef(wsId, r.kind, r.slug, (x) => {
    const kept = keptLabel(label);
    if (kept) x.label = kept;
    else delete x.label;
    x.labelBy = auto ? "auto" : "user";
    if (bump) x.updatedAt = Math.max(Date.now(), (x.syncedAt ?? 0) + 1);
  });
}

/**
 * Rename a label: every skill in it moves (its SKILL.md says so), what the owner wrote about it goes with it,
 * and each bot that had it has the new one. To a label already there, the two are one (its spelling kept); to
 * Unsorted, its skills have none. Done here at once; Orgo hears in one step (flushRenames). Answers how many
 * skills moved.
 */
export function renameLabel(wsId: string, from: string, to: string): number {
  if (!workspaceById(wsId)) throw new SkillError("That workspace is gone.", 404);
  const want = cleanLabel(to);
  noSecretsIn(want, "x");
  // A new spelling of the same label ("email" to "Email") is that; another label already there is merged into.
  const target = sameLabel(from, want) ? want : knownLabel(wsId, want);
  // As it's listed ("ops" is the workspace's "Ops"), before its skills move.
  const was = knownLabel(wsId, from);
  const moving = refsOf(wsId).filter((r) => sameLabel(labelOfRef(r), from));
  // Orgo's rename moves every skill it has under `from`. Unsorted there holds Bops' suggestions too (never sent),
  // which stay where they're listed here: then each skill moved goes on its own, as an older orgo-web takes it.
  const pid = workspaceById(wsId)?.orgoProjectId;
  const each = !!pid && (renameRoutes.get(pid) === false || (isUnsorted(from) && refsOf(wsId).some((r) => suggested(r) && !!r.remoteId)));
  for (const r of moving) relabel(wsId, r, target, each);
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (w?.skillLabelInfo?.some((x) => sameLabel(x.name, from))) {
      const old = w.skillLabelInfo.find((x) => sameLabel(x.name, from))!;
      const there = sameLabel(from, target) ? undefined : w.skillLabelInfo.find((x) => sameLabel(x.name, target));
      w.skillLabelInfo = w.skillLabelInfo.filter((x) => x !== old && x !== there);
      // Unsorted keeps no row.
      if (!isUnsorted(target)) w.skillLabelInfo.push({ name: target, about: there?.about || old.about, position: there?.position ?? old.position });
      w.skillLabelInfoUnsent = true;
    }
    for (const b of s.bots)
      if (workspaceOf(b) === wsId && b.skillLabels?.some((l) => sameLabel(l, from)))
        b.skillLabels = [...new Map(b.skillLabels.map((l) => (sameLabel(l, from) ? target : l)).map((l) => [l.toLowerCase(), l])).values()];
  });
  if (pid && !each && routes.get(pid) !== false && !onRunner()) {
    renamesOut.add(wsId, { pid, from: was, to: target });
    void flushRenames(wsId).catch((e: Error) => console.warn(`[skills] label rename: ${e.message}`));
  }
  queueSync(wsId);
  return moving.length;
}

/**
 * What the owner wrote about a label, on one line (empty takes it away): what a bot's prompt says the label is
 * for (else its skills' names). Kept with the workspace and sent to Orgo with the next sync (skill_labels).
 * Unsorted has none: it's no label, and orgo-web keeps no skill_labels row for it (its PUT leaves one out and
 * deletes what it wasn't given), so a line kept here would be gone after the next sync.
 */
export function setLabelAbout(wsId: string, label: string, about: string): SkillLabelInfo[] {
  if (!workspaceById(wsId)) throw new SkillError("That workspace is gone.", 404);
  if (isUnsorted(label)) throw new SkillError(`${UNSORTED} has no line of its own: it lists the skills with no label.`);
  const name = knownLabel(wsId, label);
  const line = cut(oneLine(about ?? ""), LABEL_ABOUT_MAX);
  noSecretsIn(name, line || "x");
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    if (!w) return;
    const rows = w.skillLabelInfo ?? [];
    const had = rows.find((x) => sameLabel(x.name, name));
    if (!line) w.skillLabelInfo = rows.filter((x) => x !== had);
    else if (had) had.about = line;
    else w.skillLabelInfo = [...rows, { name, about: line, position: rows.reduce((n, x) => Math.max(n, x.position + 1), 0) }];
    w.skillLabelInfoUnsent = true;
  });
  queueSync(wsId);
  return workspaceById(wsId)?.skillLabelInfo ?? [];
}

/** Bops' own skills this account has (lib/builtin-skills.ts): the apps ones only where apps are open (lib/apps-access.ts). */
const ownSkills = () => builtinSkills(appsOpen(getState()));

/** One of Bops' own skills (lib/builtin-skills.ts): by slug, then its name (case, spacing and dashes aside). */
function findBuiltin(nameOrSlug: string): BuiltinSkill | undefined {
  const want = nameOrSlug.trim().replace(/^["“']|["”']$/g, "");
  const own = ownSkills();
  return own.find((s) => s.slug === want) ?? own.find((s) => s.name === want) ?? own.find((s) => procedureKey(s.name) === procedureKey(want));
}

/** One skill or app as a label lists it: the workspace's own, or Bops' (`builtin`). */
type Listed = { label: string; name: string; description: string; kind: SkillKind; slug: string; builtin: boolean };

const builtinListed = (s: BuiltinSkill): Listed => ({ label: cleanLabel(s.label), name: s.name, description: oneLine(s.description), kind: "skill", slug: s.slug, builtin: true });

/** What a bot has, as its labels list it: Bops' own in their order, then its workspace's in the order they were made. */
function listedFor(botId: string): Listed[] {
  if (!bot(botId)) return [];
  const mine = [...skillsFor(botId)].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  return [...ownSkills().map(builtinListed), ...mine.map((r) => ({ label: labelOfRef(r), name: r.name, description: r.description, kind: r.kind, slug: r.slug, builtin: false }))];
}

/** `told`: its about line is what the owner wrote about it (Workspace.skillLabelInfo), so it's said wherever a built-in label's is. */
type Grouped = SkillGroup & { items: Listed[]; told?: boolean };

/** At most this much of a label's line says what's in it. */
const ABOUT_MAX = 160;
const titleOf = (x: Listed) => (x.kind === "app" ? `${x.name} (app)` : x.name);

/**
 * Skills under their labels: Bops' own labels first, in their order (only those with a skill), then the
 * workspace's by how many skills each has, Unsorted last. A workspace label's `about` is what the owner wrote
 * about it (`info`), else its skills' names.
 */
function grouped(list: Listed[], info?: SkillLabelInfo[]): Grouped[] {
  const make = (label: string, about: string, builtin: boolean): Grouped => ({ label: cleanLabel(label), about, builtin, count: 0, slugs: [], items: [] });
  const ours = builtinLabels(appsOpen(getState())).map((b) => make(b.label, oneLine(b.about), true));
  const theirs: Grouped[] = [];
  for (const x of list) {
    let g = ours.find((y) => sameLabel(y.label, x.label)) ?? theirs.find((y) => sameLabel(y.label, x.label));
    // A built-in skill under a label BUILTIN_LABELS doesn't name is still Bops' own, listed with them.
    // A workspace label's line: what the owner wrote about it (Workspace.skillLabelInfo), else its skills' names.
    if (!g) {
      const told = x.builtin ? "" : cut(oneLine(labelInfoOf(info, x.label)?.about ?? ""), ABOUT_MAX);
      (x.builtin ? ours : theirs).push((g = { ...make(x.label, told, x.builtin), ...(told ? { told: true } : {}) }));
    }
    g.items.push(x);
    g.slugs.push(x.slug);
    g.count++;
  }
  for (const g of [...ours, ...theirs]) if (!g.about) g.about = cut(g.items.map(titleOf).join(", "), ABOUT_MAX);
  const other = (g: Grouped) => (isUnsorted(g.label) ? 1 : 0);
  theirs.sort((a, b) => other(a) - other(b) || b.count - a.count || a.label.localeCompare(b.label));
  return [...ours.filter((g) => g.count), ...theirs];
}

/** What the owner wrote about the labels of a bot's workspace. */
const infoFor = (botId: string) => {
  const b = bot(botId);
  return b ? workspaceById(workspaceOf(b))?.skillLabelInfo : undefined;
};

/** A bot's labels: Bops' own, then its workspace's skills and apps by label, each with how many and which. */
export function skillGroups(botId: string): SkillGroup[] {
  return grouped(listedFor(botId), infoFor(botId)).map((g) => ({ label: g.label, about: g.about, builtin: g.builtin, count: g.count, slugs: g.slugs }));
}

/* ---------------- Files ---------------- */

type ReadTree = { files: FolderFile[]; tooMany: boolean };

/** Every file under `dir`, with paths relative to it. A link is followed only while it stays inside `dir`. */
function readTree(dir: string, max = BUNDLE_LIMITS.files * 4): ReadTree {
  const files: FolderFile[] = [];
  let tooMany = false;
  const top = realpathSync(/*turbopackIgnore: true*/ dir);
  const inside = (p: string) => p === top || p.startsWith(top + sep);
  const walk = (abs: string, depth: number) => {
    if (depth > BUNDLE_LIMITS.pathDepth) return;
    for (const name of readdirSync(/*turbopackIgnore: true*/ abs).sort()) {
      if (files.length >= max) {
        tooMany = true;
        return;
      }
      const full = join(/*turbopackIgnore: true*/ abs, name);
      const rel = relative(top, full).split(sep).join("/");
      let st = lstatSync(/*turbopackIgnore: true*/ full);
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(/*turbopackIgnore: true*/ full);
        } catch {
          files.push({ path: rel, content: null, executable: false, size: 0, link: "outside" });
          continue;
        }
        if (!inside(real)) {
          files.push({ path: rel, content: null, executable: false, size: 0, link: "outside" });
          continue;
        }
        st = statSync(/*turbopackIgnore: true*/ real);
      }
      if (st.isDirectory()) {
        // Junk folders aren't walked into: a node_modules or .git can hold thousands of files.
        if (junkReason(`${rel}/x`)) {
          files.push({ path: rel, content: "", executable: false, size: 0 });
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const executable = (st.mode & 0o111) !== 0;
      if (st.size > BUNDLE_LIMITS.file) {
        files.push({ path: rel, content: "", executable, size: st.size });
        continue;
      }
      const buf = readFileSync(/*turbopackIgnore: true*/ full);
      const text = textOf(rel, buf);
      files.push(text !== null ? { path: rel, content: text, executable, size: st.size } : { path: rel, content: null, data: buf, executable, size: st.size });
    }
  };
  walk(top, 0);
  return { files, tooMany };
}

/** Write a bundle into `dir` (made fresh): SKILL.md and its files (text, or a binary file's bytes), scripts executable. */
function writeTree(dir: string, skillMd: string, files: { path: string; content: string | null; data?: Buffer; executable: boolean }[]) {
  rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  writeFileSync(join(/*turbopackIgnore: true*/ dir, "SKILL.md"), skillMd);
  for (const f of files) {
    const to = join(/*turbopackIgnore: true*/ dir, f.path);
    if (!resolve(to).startsWith(resolve(dir) + sep)) continue;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, fileBytes(f), { mode: f.executable ? 0o755 : 0o644 });
    if (f.executable) chmodSync(to, 0o755);
  }
}

export type Bundle = { frontmatter: Record<string, unknown>; body: string; skillMd: string; files: BundleFile[] };

/** A folder read as a bundle (SKILL.md split, the rest as files), or null when it isn't there. Junk is left out. */
function readBundle(dir: string | null): Bundle | null {
  if (!dir || !existsSync(/*turbopackIgnore: true*/ join(dir, "SKILL.md"))) return null;
  const { files } = readTree(dir);
  const md = files.find((f) => f.path === "SKILL.md")?.content ?? "";
  const parsed = parseSkillMd(md);
  const rest: BundleFile[] = files
    .filter((f) => f.path !== "SKILL.md" && (f.content !== null || f.data) && !f.link && !junkReason(f.path))
    .map((f) => (f.content !== null ? { path: f.path, content: f.content, sha256: sha256Hex(f.content), size: byteLength(f.content), executable: f.executable } : { path: f.path, content: null, data: f.data, sha256: sha256Hex(f.data!), size: f.data!.length, executable: f.executable }));
  return { frontmatter: parsed.ok ? (parsed.frontmatter ?? {}) : {}, body: parsed.ok ? parsed.body : md, skillMd: md, files: rest };
}

/**
 * What a bot reads: the published version's folder (the working folder when that version isn't on this
 * Mac). A skill moved from a procedure on another Mac (the state came from Bops Cloud, its folder didn't)
 * is written again here from the procedure kept in the state.
 */
function publishedBundle(wsId: string, r: SkillRef): Bundle | null {
  if (r.version) {
    const v = readBundle(versionDir(wsId, r.kind, r.slug, r.version));
    if (v) return v;
    // Never the working folder for a published version: that's a draft. Only a procedure kept in the state.
    return fromBackup(wsId, r);
  }
  return readBundle(skillDir(wsId, r.kind, r.slug)) ?? fromBackup(wsId, r);
}

/** A skill that was a procedure, its folder made again from the procedure kept in the state (proceduresBackup). */
function fromBackup(wsId: string, r: SkillRef): Bundle | null {
  const p = r.legacyId ? getState().proceduresBackup?.find((x) => x.id === r.legacyId) : undefined;
  const dir = skillDir(wsId, r.kind, r.slug);
  if (!p || !dir || (r.version && !isVersion(r.version))) return null;
  const body = procedureBody(p);
  try {
    const md = renderSkillMd(frontmatterOf(r.slug, r.description), body);
    writeTree(dir, md, []);
    if (r.version) writeTree(versionDir(wsId, r.kind, r.slug, r.version)!, renderSkillMd(withVersion(frontmatterOf(r.slug, r.description), r.version), body), []);
  } catch (e) {
    console.warn(`[skills] writing ${r.slug} again from its procedure: ${(e as Error).message}`);
    return null;
  }
  return readBundle(r.version ? versionDir(wsId, r.kind, r.slug, r.version) : dir);
}

/* ---------------- Checks ---------------- */

/** A file as a save sends it: its text, or a binary file's bytes (`data`, content null). */
type FileIn = { path: string; content?: string | null; data?: Buffer; executable?: boolean };

const mb = (n: number) => `${n / 1024 / 1024} MB`;

/**
 * Files as a save sends them, checked strictly, as orgo-web checks a save: a bad path, junk, a cap, any
 * secret (a binary file's read the way orgo-web reads one) or an archive refuses the whole skill. Bytes
 * that are text (a text kind of path, UTF-8 without NUL) are kept as text.
 */
function checkFiles(body: string, files: FileIn[]): { files: BundleFile[]; warnings: Problem[] } {
  const errors: Problem[] = [];
  const out: BundleFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const n = normalizePath(f.path);
    if ("reason" in n) {
      errors.push({ path: String(f.path).slice(0, 200), reason: n.reason });
      continue;
    }
    if (n.path === "SKILL.md") {
      errors.push({ path: n.path, reason: "SKILL.md is the skill itself, not one of its files" });
      continue;
    }
    const junk = junkReason(n.path);
    if (junk) {
      errors.push({ path: n.path, reason: junk });
      continue;
    }
    // As a case insensitive disk (and orgo-web) sees paths: two that differ only by case are one file.
    const key = pathFoldKey(n.path);
    if (seen.has(key)) {
      errors.push({ path: n.path, reason: files.some((g) => g !== f && g.path === n.path) ? "path appears twice" : "path differs from another only by case" });
      continue;
    }
    if (key === "skill.md") {
      errors.push({ path: n.path, reason: "name SKILL.md in capitals (it is the skill itself)" });
      continue;
    }
    seen.add(key);
    const bytes = Buffer.isBuffer(f.data) ? f.data : null;
    const text = bytes ? textOf(n.path, bytes) : typeof f.content === "string" ? f.content : null;
    if (!bytes && text === null) {
      errors.push({ path: n.path, reason: "content must be text or bytes" });
      continue;
    }
    if (text !== null && text.includes("\u0000")) {
      errors.push({ path: n.path, reason: "binary file sent as text" });
      continue;
    }
    const size = text !== null ? byteLength(text) : bytes!.length;
    if (size > BUNDLE_LIMITS.file) {
      errors.push({ path: n.path, reason: `file is over ${mb(BUNDLE_LIMITS.file)}` });
      continue;
    }
    const file: BundleFile = text !== null ? { path: n.path, content: text, sha256: sha256Hex(text), size, executable: !!f.executable } : { path: n.path, content: null, data: bytes!, sha256: sha256Hex(bytes!), size, executable: !!f.executable };
    const opaque = file.data ? unscannableBinary(file.data) : null;
    if (opaque) {
      errors.push({ path: n.path, reason: opaque });
      continue;
    }
    errors.push(...scanFile(n.path, file));
    out.push(file);
  }
  // A file "a" and a file "a/b" can't both be written to a disk.
  for (const f of out) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i += 1)
      if (seen.has(pathFoldKey(parts.slice(0, i).join("/")))) {
        errors.push({ path: f.path, reason: "path is inside a name that is also a file" });
        break;
      }
  }
  errors.push(...scanSecrets("SKILL.md", body));
  if (byteLength(body) > BUNDLE_LIMITS.body) errors.push({ path: "SKILL.md", reason: `body is over ${BUNDLE_LIMITS.body / 1024} KB` });
  if (out.length + 1 > BUNDLE_LIMITS.files) errors.push({ path: "", reason: `a skill holds ${BUNDLE_LIMITS.files} files at most` });
  if (out.reduce((n, f) => n + f.size, byteLength(body)) > BUNDLE_LIMITS.total) errors.push({ path: "", reason: `a skill is ${mb(BUNDLE_LIMITS.total)} at most` });
  if (errors.length) {
    const secret = errors.some((e) => e.reason.startsWith("secret:"));
    throw new SkillError(secret ? "That has a secret in it. Use the key's vault name instead ($NAME, listed in requires_secrets)." : "Some files can't be kept.", secret ? 422 : 400, errors);
  }
  return { files: out, warnings: [] };
}

/**
 * The frontmatter a skill is written with, in the spec's form (skill-bundle.ts toSpecForm): name (its slug)
 * and description, then what it says of itself, its version left out (a version's folder adds its own).
 */
function frontmatterOf(slug: string, description: string, extra: Record<string, unknown> = {}) {
  return toSpecForm({ ...extra, name: slug, description }, { version: null });
}

const riskOf = (fm: Record<string, unknown>): SkillRisk | undefined => {
  const risk = specOf(fm).risk;
  return (RISKS as readonly unknown[]).includes(risk) ? (risk as SkillRisk) : undefined;
};
const runsOnOf = (fm: Record<string, unknown>) => specOf(fm).runsOn;

/* ---------------- Making and changing them ---------------- */

export type NewSkill = {
  kind?: SkillKind;
  name: string;
  description: string;
  body: string;
  /** The label it goes under (one already in use when it's the same, knownLabel; Unsorted for none). None given: the frontmatter's, else Bops' suggestion. */
  label?: string | null;
  frontmatter?: Record<string, unknown>;
  files?: FileIn[];
  botIds?: string[];
  source?: SkillRef["source"];
  status?: "draft" | "published";
  from?: SkillRef["from"];
  legacyId?: string;
  /** For one from before (a procedure): when it was made and used. */
  times?: { createdAt: number; updatedAt: number; uses?: number; usedAt?: number };
};

/** The bots in a workspace, by id. */
const teamIds = (wsId: string) => new Set(getState().bots.filter((b) => workspaceOf(b) === wsId).map((b) => b.id));

/**
 * A new skill or app in a workspace: written to its folder, and listed. Checked strictly (no secrets,
 * no junk, the caps). A draft unless `status` says published (then its first version is published too).
 * Its label, in layers: the one given (a bot's create_skill, Orgo's column), else its frontmatter's (kept in
 * its SKILL.md either way), else Bops' suggestion (labelBy "auto", kept in the state until it's confirmed,
 * changed or published): from its words (guessLabel), and, when they place it nowhere or the workspace has
 * labels of its own, a small model's pick a moment later (queueSuggest), for one made here. A skill's only:
 * an app naming none is Unsorted, since its label is changed nowhere in Skills.
 */
export function createSkill(wsId: string, input: NewSkill): { ref: SkillRef; warnings: Problem[] } {
  const w = workspaceById(wsId);
  if (!w) throw new SkillError("That workspace is gone.", 404);
  const kind = input.kind ?? "skill";
  const name = cut(oneLine(input.name ?? ""), 120);
  const description = oneLine(input.description ?? "");
  if (!/[\p{L}\p{N}]/u.test(name)) throw new SkillError(`A ${kind} needs a name.`);
  if (!description) throw new SkillError("Say what it does and when to use it.");
  if (description.length > BUNDLE_LIMITS.description) throw new SkillError(`The description is ${BUNDLE_LIMITS.description} characters at most.`);
  if (refsOf(wsId).length >= MAX_SKILLS) throw new SkillError(`A workspace holds ${MAX_SKILLS} skills and apps at most. Delete one to add another.`, 409);
  const body = (input.body ?? "").replace(/\r\n?/g, "\n");
  if (!body.trim()) throw new SkillError(`A ${kind} needs its SKILL.md text.`);
  // One brought from Orgo is never refused for its frontmatter's form (a version an earlier build stored may say
  // version: "1.0" or risk: high): made fit the way orgo-web carries a stored version (fitFrontmatter). The rest
  // is checked as orgo-web checks a new save.
  const given = input.source === "orgo" && input.frontmatter ? fitFrontmatter(input.frontmatter) : input.frontmatter;
  const said = input.label?.trim() ? input.label : labelOf(given);
  const extra = said !== undefined ? withLabel(given ?? {}, knownLabel(wsId, said)) : (given ?? {});
  noSecretsIn(name, description, extra);
  const problems = validateFrontmatter(extra);
  if (problems.length) throw new SkillError("The frontmatter has a problem.", 400, problems);
  const { files } = checkFiles(body, input.files ?? []);
  const dir0 = workspaceDir(wsId);
  if (!dir0) throw new SkillError("Sign in to keep skills.", 401);
  const fmSlug = typeof extra.name === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(extra.name) ? extra.name : slugify(name);
  const slug = freeSlug(fmSlug, refsOf(wsId, kind).map((r) => r.slug));
  const fm = frontmatterOf(slug, description, extra);
  // Suggestions are a skill's only: an app's label is changed nowhere in Skills, so one would never be confirmed.
  const suggest = said === undefined && kind === "skill";
  // Bops' keyword guess only where the workspace has no labels of its own yet: one that has some keeps to
  // them (the model picks among them, or one new label), so a preset never lands beside the owner's own
  // ("Support" beside "Support playbook"). No answer from the model then leaves it Unsorted.
  const guess = suggest && !ownLabels(wsId).length ? keptLabel(guessLabel(name, description)) : undefined;
  const label = labelOf(fm) ?? guess;
  const skillMd = renderSkillMd(fm, body);
  writeTree(skillDir(wsId, kind, slug)!, skillMd, files);
  const team = teamIds(wsId);
  const now = Date.now();
  const ref: SkillRef = {
    slug,
    kind,
    name,
    description,
    ...(label ? { label } : {}),
    labelBy: suggest ? "auto" : "skill",
    status: "draft",
    botIds: [...new Set(input.botIds ?? [])].filter((id) => team.has(id)),
    source: input.source ?? "bops",
    createdAt: input.times?.createdAt ?? now,
    updatedAt: input.times?.updatedAt ?? now,
    ...(riskOf(fm) ? { risk: riskOf(fm) } : {}),
    ...(runsOnOf(fm) ? { runsOn: runsOnOf(fm) } : {}),
    ...(input.legacyId ? { legacyId: input.legacyId } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.times?.uses ? { uses: input.times.uses } : {}),
    ...(input.times?.usedAt ? { usedAt: input.times.usedAt } : {}),
  };
  update((s) => {
    const ws = s.workspaces?.find((x) => x.id === wsId);
    if (ws) (ws[listKey(kind)] ??= []).push(ref);
  });
  // Nothing it came with names a label, and its words place it nowhere or the workspace has labels of its own: a model's pick.
  if (suggest && input.source !== "orgo" && (!guess || ownLabels(wsId).length)) queueSuggest(wsId, kind, slug);
  if (input.status === "published") publishSkill(wsId, kind, slug, { version: specOf(extra).version });
  // A draft goes to Orgo too (create_skill, Save as skill, an import); one brought from Orgo is there already.
  if (ref.source !== "orgo") queueSync(wsId);
  const warnings = [...frontmatterWarnings(extra), ...undeclaredSecrets([{ path: "SKILL.md", content: body }, ...files], specOf(fm).requiresSecrets ?? [])];
  return { ref: findRef(wsId, kind, slug)!, warnings };
}

/** A key in the name, the description or the frontmatter would reach every prompt and Orgo: refused like one in the body. */
function noSecretsIn(name: string, description: string, extra: Record<string, unknown> = {}) {
  const found = [...scanSecrets("name", name), ...scanSecrets("description", description), ...scanSecrets("frontmatter", JSON.stringify(extra))];
  if (found.length) throw new SkillError("That looks like a secret. Keep keys in Logins, not in a skill.", 400, found);
}

/**
 * `label`: move it to that label (Unsorted: none; null or empty: it stays where it is), the label confirmed
 * as the owner's when it's the suggestion it had. `frontmatter`: what its SKILL.md says of itself from now
 * on (a folder it's updated from), its name and label kept as they are.
 */
export type SkillEdit = { name?: string; description?: string; body?: string; files?: FileIn[]; botIds?: string[]; label?: string | null; frontmatter?: Record<string, unknown> };

/**
 * Change a skill: its name, description or SKILL.md text in its folder (a draft of the next version;
 * the bots keep reading the published one until it's published), or which bots have it. `draft` (a bot's
 * edit): on a published skill the name and description the bots see stay as published; the description
 * waits in the folder's SKILL.md and goes live with publishSkill. A move to another label is only where
 * it's listed, so it's at once, draft or not, and kept in its folder's SKILL.md too.
 */
export function updateSkill(wsId: string, kind: SkillKind, slug: string, edit: SkillEdit, opts: { draft?: boolean } = {}): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const dir = skillDir(wsId, kind, slug);
  const now = readBundle(dir);
  const name = edit.name !== undefined ? cut(oneLine(edit.name), 120) : r.name;
  const description = edit.description !== undefined ? oneLine(edit.description) : r.description;
  const label = edit.label?.trim() ? knownLabel(wsId, edit.label) : undefined;
  if (!/[\p{L}\p{N}]/u.test(name)) throw new SkillError(`A ${kind} needs a name.`);
  if (!description) throw new SkillError("Say what it does and when to use it.");
  if (description.length > BUNDLE_LIMITS.description) throw new SkillError(`The description is ${BUNDLE_LIMITS.description} characters at most.`);
  noSecretsIn(name, description, label ? { label } : {});
  const changesFolder = edit.body !== undefined || edit.files !== undefined || edit.description !== undefined || edit.frontmatter !== undefined;
  if (edit.frontmatter) {
    const problems = validateFrontmatter(edit.frontmatter);
    if (problems.length) throw new SkillError("The frontmatter has a problem.", 400, problems);
    noSecretsIn(name, description, edit.frontmatter);
  }
  if (changesFolder) {
    const body = (edit.body ?? now?.body ?? "").replace(/\r\n?/g, "\n");
    if (!body.trim()) throw new SkillError(`A ${kind} needs its SKILL.md text.`);
    const files = edit.files ?? now?.files ?? [];
    const checked = checkFiles(body, files);
    // A folder's own frontmatter keeps the skill's label (its label is where it's listed, not the folder's say; a suggestion isn't in it).
    const fm = withLabel(frontmatterOf(slug, description, edit.frontmatter ?? now?.frontmatter ?? {}), label ?? (edit.frontmatter ? sentLabelOf(r) : undefined));
    writeTree(dir!, renderSkillMd(fm, body), checked.files);
  } else if (label && now && dir) {
    // Only moved: its SKILL.md says so, the rest of the folder as it is.
    writeFileSync(join(/*turbopackIgnore: true*/ dir, "SKILL.md"), renderSkillMd(withLabel(now.frontmatter, label), now.body));
  }
  const team = teamIds(wsId);
  const keep = opts.draft && r.status === "published";
  patchRef(wsId, kind, slug, (x) => {
    if (!keep) {
      x.name = name;
      x.description = description;
    }
    if (label) {
      const kept = keptLabel(label);
      if (kept) x.label = kept;
      else delete x.label;
      x.labelBy = "user";
    }
    if (edit.botIds) x.botIds = [...new Set(edit.botIds)].filter((id) => team.has(id));
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/**
 * Give a bot a skill, or take it away: the skill names its own bots from then on, the exception to its label
 * (lib/skill-labels.ts botHasSkill). Taking the last named bot away would leave it to its label's bots again, so
 * that's refused.
 */
export function setSkillBot(wsId: string, kind: SkillKind, slug: string, botId: string, on: boolean): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const team = teamIds(wsId);
  if (!team.has(botId)) throw new SkillError("That bot isn't in this workspace.", 404);
  // Its label's bots have it (none named): taking one away, or giving it to one more, names them.
  const byLabel = [...team].filter((id) => botHasSkill({ label: labelOfRef(r) }, bot(id)!));
  const now = r.botIds.length ? r.botIds : byLabel;
  const next = on ? [...new Set([...now, botId])] : now.filter((x) => x !== botId);
  if (!next.length) throw new SkillError("At least one bot keeps it. Delete it instead.");
  patchRef(wsId, kind, slug, (x) => {
    // Its label's bots named, no more and no less, is the same as none: kept as none, so a bot given the label gets it too.
    x.botIds = byLabel.length === next.length && byLabel.every((id) => next.includes(id)) ? [] : next;
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/** Publish what's in the folder as a new version (the next patch unless `version` says): its bots read it from now on. */
export function publishSkill(wsId: string, kind: SkillKind, slug: string, opts: { version?: string } = {}): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const b = readBundle(skillDir(wsId, kind, slug));
  if (!b) throw new SkillError(`Its folder is gone from this Mac. Delete it, or import the folder again.`, 404);
  // Checked again: the folder may have been changed in Finder since.
  checkFiles(b.body, b.files);
  const versions = r.versions ?? [];
  const version = opts.version ?? nextVersion(versions.map((v) => v.version));
  if (!isVersion(version)) throw new SkillError("A version looks like 1.2.0.");
  if (versions.some((v) => v.version === version)) throw new SkillError(`Version ${version} is already published.`, 409);
  // The description as the folder has it (a bot's edit waits there until now).
  const said = typeof b.frontmatter.description === "string" ? oneLine(b.frontmatter.description) : "";
  const description = said && said.length <= BUNDLE_LIMITS.description && !scanSecrets("SKILL.md", said).length ? said : r.description;
  // Its label as it's listed now (Bops' suggestion goes into its SKILL.md from this version on, as the owner's).
  const fm = withLabel(frontmatterOf(slug, description, b.frontmatter), labelOfRef(r));
  const skillMd = renderSkillMd(withVersion(fm, version), b.body);
  const sha = bundleSha(skillMd, b.files);
  const last = versions.find((v) => v.version === r.version);
  const lastMd = last && renderSkillMd(withVersion(fm, last.version), b.body);
  // The same as the version in use: by its hash, or (one kept in the form from before) by what's in it.
  const same = last && lastMd && (last.sha256 === bundleSha(lastMd, b.files) || last.sha256 === legacyBundleSha(lastMd, b.files) || sameContent(readBundle(versionDir(wsId, kind, slug, last.version)), { ...b, frontmatter: fm }));
  if (last && same) throw new SkillError(`Nothing changed since ${last.version}.`, 409);
  writeTree(versionDir(wsId, kind, slug, version)!, skillMd, b.files);
  patchRef(wsId, kind, slug, (x) => {
    x.versions = [...versions, { version, at: Date.now(), sha256: sha }];
    x.version = version;
    x.description = description;
    x.status = "published";
    // Bops' suggestion, published, is kept like a chosen one (in every version's SKILL.md from now on).
    if (x.labelBy === "auto") x.labelBy = "user";
    x.risk = riskOf(b.frontmatter) ?? x.risk;
    x.runsOn = runsOnOf(b.frontmatter) ?? x.runsOn;
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/** Two bundles with the same text, files and frontmatter (in the spec's form, the version aside): one kept in either form is the other. */
function sameContent(a: Bundle | null, b: Bundle): boolean {
  if (!a) return false;
  const canon = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  const fm = (x: Record<string, unknown>) => JSON.stringify(canon(toSpecForm(x, { version: null })));
  const files = (x: Bundle) => x.files.map((f) => `${f.path}:${f.sha256}:${f.executable ? "x" : "-"}`).join("\n");
  // The blank line after the frontmatter is how it was written, not what it says.
  const body = (x: Bundle) => x.body.replace(/^\n+/, "");
  return body(a) === body(b) && files(a) === files(b) && fm(a.frontmatter) === fm(b.frontmatter);
}

/** Point its bots back at an older version (nothing's deleted: rolling forward is another roll back). */
export function rollbackSkill(wsId: string, kind: SkillKind, slug: string, version: string): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  if (!r.versions?.some((v) => v.version === version)) throw new SkillError(`It has no version ${version}.`, 404);
  const dir = versionDir(wsId, kind, slug, version);
  if (!dir || !existsSync(/*turbopackIgnore: true*/ dir)) throw new SkillError(`Version ${version} isn't on this Mac.`, 404);
  // The folder goes back to that version too, so what's worked on next starts from it.
  cpSync(/*turbopackIgnore: true*/ dir, skillDir(wsId, kind, slug)!, { recursive: true, force: true });
  patchRef(wsId, kind, slug, (x) => {
    x.version = version;
    x.status = "published";
    x.updatedAt = Date.now();
  });
  queueSync(wsId);
  return findRef(wsId, kind, slug)!;
}

/**
 * Delete a skill or app: its folder and versions on this Mac, and Orgo's copy (by its Orgo id, else by its
 * slug: one sent whose id this Mac never heard). The delete waits in an outbox on disk until Orgo took it,
 * tried now and again after a backoff, so Orgo not answering never brings the skill back.
 */
export async function deleteSkill(wsId: string, kind: SkillKind, slug: string): Promise<boolean> {
  const r = findRef(wsId, kind, slug);
  if (!r) return false;
  dropLocal(wsId, kind, slug);
  const pid = workspaceById(wsId)?.orgoProjectId;
  // Its Orgo copy is in the project it was sent to (one from before that was kept: this one's).
  const at = r.remoteId ? (r.remotePid ?? pid) : pid;
  if (at && routes.get(at) !== false && !onRunner()) {
    deletes.add(wsId, { pid: at, kind, slug, ...(r.remoteId ? { remoteId: r.remoteId } : {}) });
    await flushDeletes(wsId).catch((e: Error) => console.warn(`[skills] deleting Orgo's copy: ${e.message}`));
  }
  return true;
}

/** A skill's ref, folder and versions off this Mac (nothing sent). */
function dropLocal(wsId: string, kind: SkillKind, slug: string) {
  update((s) => {
    const ws = s.workspaces?.find((w) => w.id === wsId);
    if (ws) ws[listKey(kind)] = (ws[listKey(kind)] ?? []).filter((x) => x.slug !== slug);
  });
  for (const d of [skillDir(wsId, kind, slug), workspaceDir(wsId) && join(/*turbopackIgnore: true*/ workspaceDir(wsId)!, ".versions", listKey(kind), slug)])
    if (d) rmSync(/*turbopackIgnore: true*/ d, { recursive: true, force: true });
}

/**
 * A bot is gone: off every skill that named it; one only it had is kept, for every bot of the workspace
 * (never deleted with it). A change like any other: Orgo's copy loses the bot too.
 */
export function dropBotFromSkills(botId: string, wsId: string) {
  let changed = false;
  for (const r of refsOf(wsId)) {
    if (!r.botIds.includes(botId)) continue;
    patchRef(wsId, r.kind, r.slug, (x) => {
      x.botIds = x.botIds.filter((id) => id !== botId);
      // Later than the last sync, even in its millisecond: a change to send.
      x.updatedAt = Math.max(Date.now(), (x.syncedAt ?? 0) + 1);
    });
    changed = true;
  }
  if (changed) queueSync(wsId);
}

/* ---------------- Reading them ---------------- */

export type SkillFileInfo = { path: string; size: number; sha256: string; executable: boolean; script: boolean; approved: boolean; binary: boolean };

const approvedIn = (wsId: string) => new Set((workspaceById(wsId)?.approvals ?? []).map((a) => a.sha256));

/** A skill as the window shows it: its SKILL.md (a version, else what's being worked on), its files, and where its folder is. */
export function skillDetail(wsId: string, kind: SkillKind, slug: string, version?: string) {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const dir = skillDir(wsId, kind, slug);
  const b = version ? readBundle(versionDir(wsId, kind, slug, version)) : readBundle(dir);
  const approved = approvedIn(wsId);
  const files: SkillFileInfo[] = (b?.files ?? []).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, executable: f.executable, script: isScript(f), approved: approved.has(f.sha256), binary: f.content === null }));
  // What changed in the folder since the version the bots read.
  const pub = r.version ? readBundle(versionDir(wsId, kind, slug, r.version)) : null;
  const changed = !!b && !!pub && !version && (pub.body !== b.body || pub.files.map((f) => `${f.path}:${f.sha256}`).join() !== b.files.map((f) => `${f.path}:${f.sha256}`).join());
  return { ref: r, body: b?.body ?? "", frontmatter: b?.frontmatter ?? {}, files, dir, missing: !b, changed };
}

/** One file's text, for the window (Approve shows the script it approves); a binary file has none (content null), only its size. */
export function skillFile(wsId: string, kind: SkillKind, slug: string, path: string, version?: string): { path: string; content: string | null; sha256: string; binary?: true; size?: number } {
  const n = normalizePath(path);
  if ("reason" in n) throw new SkillError(n.reason);
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const b = version ? readBundle(versionDir(wsId, kind, slug, version)) : readBundle(skillDir(wsId, kind, slug));
  const f = b?.files.find((x) => x.path === n.path);
  if (!f) throw new SkillError("That file isn't in it.", 404);
  if (f.content === null) return { path: f.path, content: null, sha256: f.sha256, binary: true, size: f.size };
  return { path: f.path, content: f.content, sha256: f.sha256 };
}

/** Every file of a workspace's skills here: what's being worked on and each one's published version. */
const filesHere = (wsId: string) =>
  refsOf(wsId)
    .flatMap((r) => [readBundle(skillDir(wsId, r.kind, r.slug)), r.version ? readBundle(versionDir(wsId, r.kind, r.slug, r.version)) : null])
    .flatMap((b) => b?.files ?? []);

/** Approve a script's content to run in this workspace (by its sha256). Only content that's in one of its skills can be. */
export function approveScript(wsId: string, sha256: string, on = true): ScriptApproval[] {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SkillError("That isn't a script's sha256.");
  const where = filesHere(wsId).find((f) => f.sha256 === sha256);
  if (on && !where) throw new SkillError("No script in this workspace has that content.", 404);
  update((s) => {
    const ws = s.workspaces?.find((w) => w.id === wsId);
    if (!ws) return;
    const rest = (ws.approvals ?? []).filter((a) => a.sha256 !== sha256);
    ws.approvals = on ? [...rest, { sha256, path: where!.path, at: Date.now(), inBops: true }] : rest;
  });
  approvalChanged(wsId, sha256, on, where?.path);
  return workspaceById(wsId)?.approvals ?? [];
}

/** A size as a person reads it. */
const sizeText = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Where a bot finds its skills on its computer (sessions.ts copies them there). */
export const COMPUTER_SKILLS = "/workspace/capabilities/skills";
export const COMPUTER_APPS = "/workspace/capabilities/apps";

/**
 * A label's line in a prompt: its name, how many skills, and what they're for. A built-in label's words are
 * Bops' own, so the workspace's skills under it are named first, or they'd be out of sight.
 */
const labelLine = (g: Grouped) => {
  const own = g.builtin ? g.items.filter((x) => !x.builtin).map(titleOf) : [];
  return `- ${cut(`${g.label} (${g.count}): ${own.length ? `${cut(own.join(", "), ABOUT_MAX)}, and Bops' own: ` : ""}${g.about}`, NOTE_LINE_MAX)}`;
};
/** A skill's line under a label: its name and description. */
const skillLine = (x: Listed) => cut(`${titleOf(x)}: ${x.description}`, NOTE_LINE_MAX);
/** A bot's labels in a few words, for an answer that didn't find what was asked. */
const labelsSaid = (groups: Grouped[]) => (groups.length ? groups.map((g) => `${g.label} (${g.count})`).join(", ") : "none yet");

/** read_skill with a label: its skills, one line each, Bops' own first. */
function labelText(g: Grouped): string {
  return [`${g.label} (${g.count})${g.builtin || g.told ? `: ${g.about}` : ""}`, "Read the one that fits with read_skill and name, then follow it.", ...g.items.map((x) => `- ${skillLine(x)}`)].join("\n");
}

/** read_skill of one of Bops' own skills: its body and files (text, never a script), or one file. Not counted as a use. */
function readBuiltin(s: BuiltinSkill, file?: string | null): string {
  const files = s.files ?? [];
  if (file?.trim()) {
    const n = normalizePath(file.trim());
    const f = "reason" in n ? undefined : files.find((x) => x.path === n.path);
    if (!f) return `"${s.name}" has no file ${cut(oneLine(file), 120)}. Its files: ${files.map((x) => x.path).join(", ") || "none"}.`;
    return `${s.name}, ${f.path}:\n${f.content.length > FILE_CAP ? `${f.content.slice(0, FILE_CAP)}\n(cut short)` : f.content}`;
  }
  return [
    `Skill: ${s.name} (Bops' own)`,
    s.body.trim(),
    files.length ? `Its files (read one with read_skill and file; on your computer they're in ${COMPUTER_SKILLS}/${s.slug}/):\n${files.map((f) => `- ${f.path}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * read_skill: a skill or app in full for a bot about to do a job (its SKILL.md body and the list of its
 * files, a read counted as a use), or one file of it with `file`; one of Bops' own the same way. With
 * `label` (and no skill named), that label's skills, one line each. A label given as the name opens it
 * too. When there's nothing by that name, it says so and lists the bot's labels.
 */
export function readSkill(botId: string, nameOrSlug: string, file?: string | null, label?: string | null): string {
  const b = bot(botId);
  if (!b) return "Unknown bot.";
  const asked = cut(oneLine(nameOrSlug), 80);
  const r = asked ? findSkill(botId, nameOrSlug) : undefined;
  if (!r) {
    const own = asked ? findBuiltin(nameOrSlug) : undefined;
    if (own) return readBuiltin(own, file);
    const groups = grouped(listedFor(botId), infoFor(botId));
    const want = label?.trim() ? label : asked;
    const g = want ? groups.find((x) => sameLabel(x.label, want)) : undefined;
    if (g) return labelText(g);
    const open = "Open one with read_skill and label to see its skills.";
    if (!asked && !label?.trim()) return `Give a skill's name, or a label to see its skills. Your labels: ${labelsSaid(groups)}. ${open}`;
    if (!asked) return `No label called "${cut(oneLine(label!), 80)}". Your labels: ${labelsSaid(groups)}. ${open}`;
    return `No skill called "${asked}". Your labels: ${labelsSaid(groups)}. ${open}`;
  }
  const wsId = workspaceOf(b);
  const bundle = publishedBundle(wsId, r);
  if (!bundle) return `"${r.name}" isn't on this Mac right now.`;
  if (file?.trim()) {
    const n = normalizePath(file.trim());
    const f = "reason" in n ? undefined : bundle.files.find((x) => x.path === n.path);
    if (!f) return `"${r.name}" has no file ${cut(oneLine(file), 120)}. Its files: ${bundle.files.map((x) => x.path).join(", ") || "none"}.`;
    if (isScript(f) && !approvedIn(wsId).has(f.sha256)) return `${r.name}, ${f.path}: a script not approved yet. Ask to have it approved in Skills, in Knowledge; its content comes once it is.`;
    if (f.content === null) return `${r.name}, ${f.path}: a binary file (${sizeText(f.size)}), not text, so it isn't shown. On your computer it's ${r.kind === "app" ? COMPUTER_APPS : COMPUTER_SKILLS}/${r.slug}/${f.path}.`;
    return `${r.name}, ${f.path}:\n${f.content.length > FILE_CAP ? `${f.content.slice(0, FILE_CAP)}\n(cut short)` : f.content}`;
  }
  const at = Date.now();
  patchRef(wsId, r.kind, r.slug, (x) => {
    x.uses = (x.uses ?? 0) + 1;
    x.usedAt = at;
  });
  const approved = approvedIn(wsId);
  const base = r.kind === "app" ? COMPUTER_APPS : COMPUTER_SKILLS;
  const files = bundle.files.map((f) => `- ${f.path}${f.content === null ? ` (binary, ${sizeText(f.size)})` : ""}${isScript(f) ? (approved.has(f.sha256) ? " (script, approved)" : " (script, not approved yet: ask to have it approved in Skills, in Knowledge, before running it)") : ""}`);
  return [
    `${r.kind === "app" ? "App" : "Skill"}: ${r.name}${r.version ? ` (version ${r.version})` : ""}`,
    bundle.body.trim(),
    files.length ? `Its files (read one with read_skill and file; on your computer they're in ${base}/${r.slug}/):\n${files.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * One file of a skill as a proposal reads it (skill-proposals.ts): what its bots read (`published`, the version
 * in use), or the working folder the next version is published from. SKILL.md is its text without the
 * frontmatter, as read_skill gives it. `changed`: the folder has changes not published yet. Null when it isn't
 * on this Mac (a computer's runner has only what was made there).
 */
export function skillFileText(wsId: string, r: SkillRef, file: string, from: "published" | "folder"): { text: string | null; exists: boolean; binary: boolean; changed: boolean } | null {
  const pub = publishedBundle(wsId, r);
  const b = from === "published" ? pub : readBundle(skillDir(wsId, r.kind, r.slug));
  if (!b) return null;
  // As skillDetail says it: its text or files differ from the version in use (a label or a description waiting there doesn't count).
  const changed = from === "folder" && !!r.version && !!pub && (pub.body.replace(/^\n+/, "") !== b.body.replace(/^\n+/, "") || pub.files.map((f) => `${f.path}:${f.sha256}`).join() !== b.files.map((f) => `${f.path}:${f.sha256}`).join());
  if (file === "SKILL.md") return { text: b.body, exists: true, binary: false, changed };
  const f = b.files.find((x) => x.path === file);
  return { text: f ? f.content : null, exists: !!f, binary: !!f && f.content === null, changed };
}

/**
 * A proposal the owner accepted, made the skill's next version (skill-proposals.ts acceptProposal): one file of
 * the working folder (SKILL.md's text, or a file in it) becomes `text`, through the same checks as any save
 * (no secret, the caps), and it's published. Answers the skill as it is then.
 */
export function applySkillFile(wsId: string, kind: SkillKind, slug: string, file: string, text: string): SkillRef {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  if (file === "SKILL.md") updateSkill(wsId, kind, slug, { body: text });
  else {
    const now = readBundle(skillDir(wsId, kind, slug));
    if (!now) throw new SkillError("Its folder is gone from this Mac.", 404);
    const files: FileIn[] = now.files.filter((f) => f.path !== file).map((f) => ({ path: f.path, content: f.content, data: f.data, executable: f.executable }));
    const had = now.files.find((f) => f.path === file);
    files.push({ path: file, content: text, executable: !!had?.executable });
    updateSkill(wsId, kind, slug, { files });
  }
  return publishSkill(wsId, kind, slug);
}

/** A skill's SKILL.md body as its bot follows it (a routine's, a thread's), without counting a use. Empty when it isn't on this Mac. */
export function skillText(botId: string, r: SkillRef): string {
  const b = bot(botId);
  const bundle = b ? publishedBundle(workspaceOf(b), r) : null;
  return bundle ? `${r.kind === "app" ? "App" : "Skill"}: ${r.name}\n\n${bundle.body.trim()}` : "";
}

/** Count a use of a skill (a thread or a routine's run that follows it, once per run). */
export function countUse(botId: string, r: SkillRef) {
  const b = bot(botId);
  if (!b) return;
  patchRef(workspaceOf(b), r.kind, r.slug, (x) => {
    x.uses = (x.uses ?? 0) + 1;
    x.usedAt = Date.now();
  });
}

/**
 * The list for a bot's prompts, in layers: one line per label (how many skills, what they're for), and
 * the rule: open the label that fits the job (read_skill with label), then read the skill. A workspace
 * with few skills of its own (NOTE_SMALL) has them listed under their labels at once, each label a
 * heading (Bops' own skills stay inside theirs). At most NOTE_MAX
 * labels. In a fixed order (labels by size, skills in the order they were made), so a read doesn't
 * reorder it and the prompt's lead stays cached. Empty when the bot has none, Bops' own included. `propose`: a
 * chat turn, which has propose_skill_change (skill-proposals.ts): a step found wrong, missing or out of date is
 * proposed as a change there rather than only said.
 */
export function skillsNote(botId: string, opts: { propose?: boolean } = {}): string {
  const groups = grouped(listedFor(botId), infoFor(botId));
  if (!groups.length) return "";
  const mine = groups.reduce((n, g) => n + g.items.filter((x) => !x.builtin).length, 0);
  const small = mine <= NOTE_SMALL;
  const shown = groups.slice(0, NOTE_MAX);
  const more = groups.length - shown.length;
  return [
    `Your skills: how your workspace does jobs it was shown before, and Bops' own, under labels. When a job fits a label, open it with read_skill and label to see its skills, then read the one that fits with read_skill and name, and follow it.${small && mine ? " One listed here you can read at once." : ""} ${opts.propose ? `When a step of one was wrong, missing or out of date, propose the change with propose_skill_change: nothing changes until ${ownerName()} accepts it.` : "Tell the user if a step no longer works."}`,
    ...shown.flatMap((g) => {
      if (!small) return [labelLine(g)];
      // Few: each label a heading with the workspace's own skills under it (a workspace label's names say nothing more).
      const own = g.items.filter((x) => !x.builtin);
      return [cut(`${g.label} (${g.count}):${g.builtin || g.told || !own.length ? ` ${g.about}` : ""}`, NOTE_LINE_MAX), ...own.map((x) => `- ${skillLine(x)}`)];
    }),
    ...(more > 0 ? [`(${more} more labels: read_skill with a label not listed here names them all.)`] : []),
  ].join("\n");
}

/**
 * The same for a thread on its bot's brain (Claude Code, Codex: sessions.ts), which reads its skills as
 * folders on its computer (copySkillsToComputer): INDEX.md first, then the label that fits, then the skill.
 * One line per label. Empty when it has none.
 */
export function skillsIndexNote(botId: string, owner = "the user"): string {
  const groups = grouped(listedFor(botId), infoFor(botId));
  if (!groups.length) return "";
  const shown = groups.slice(0, NOTE_MAX);
  const more = groups.length - shown.length;
  return [
    `Your skills: how your workspace does jobs it was shown before, and Bops' own, as folders on your computer under labels. Before a job, read ${COMPUTER_SKILLS}/INDEX.md first, open the label that fits the job there, then read that skill's SKILL.md in its folder and follow it. Tell ${owner} if a step no longer works.`,
    ...shown.map(labelLine),
    ...(more > 0 ? [`(${more} more labels in INDEX.md.)`] : []),
  ].join("\n");
}

/** What a script nobody approved yet holds where it would run: never its content, so approval is a real gate. */
const WAITING = "#!/bin/sh\n# This script is waiting for approval in Bops, in Skills, in Knowledge. Its content arrives once it's approved.\necho 'Not approved yet: ask to have it approved in Skills, in Knowledge.' >&2\nexit 1\n";
/** A bundle's files as they go to a task folder or a computer: scripts approved run; others are WAITING, not executable. */
function shipped(files: BundleFile[], approved: Set<string>) {
  return files.map((f) => (isScript(f) && !approved.has(f.sha256) ? { ...f, content: WAITING, data: undefined, executable: false } : { ...f, executable: f.executable && approved.has(f.sha256) }));
}

/** The tool a bot reads its skills with. */
export const READ_SKILL_TOOL = {
  type: "function" as const,
  name: "read_skill",
  description: "Open one of your labels (listed under Your skills) to see its skills, or read one skill or app in full before a job it fits, then follow it. With file, read one of its files.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "file", "label"],
    properties: {
      name: { type: ["string", "null"], description: "The skill's name, as listed, or null to open a label." },
      file: { type: ["string", "null"], description: "One of its files (scripts/check.sh), or null for the skill itself." },
      label: { type: ["string", "null"], description: "A label to see its skills, one line each, or null to read the skill named." },
    },
  },
};

/* ---------------- Importing a folder ---------------- */

export type ImportResult = { ref: SkillRef; skipped: Problem[]; warnings: Problem[]; drafted: boolean };

/** A folder on this Mac read and checked as an import takes one (checkFolder), its frontmatter's name the spec's and its folder's own. */
function readFolder(folder: string): Extract<ReturnType<typeof checkFolder>, { ok: true }> & { folderName: string } {
  let st;
  try {
    st = statSync(/*turbopackIgnore: true*/ folder);
  } catch {
    throw new SkillError("That folder isn't there.", 404);
  }
  if (!st.isDirectory()) throw new SkillError("Pick a folder.");
  const tree = readTree(folder);
  if (tree.tooMany) throw new SkillError(`That folder has more than ${BUNDLE_LIMITS.files * 4} files. Pick the skill's own folder.`);
  const folderName = folder.split(sep).filter(Boolean).pop() ?? "skill";
  const checked = checkFolder(tree.files, { folderName });
  if (!checked.ok) throw new SkillError("That folder can't be imported.", checked.errors.some((e) => e.reason.startsWith("secret:")) ? 422 : 400, [...checked.errors, ...checked.skipped]);
  // The spec's rule: a name it says is the folder's own, in its words (a skill kept before with another keeps working).
  const said = checked.frontmatter.name;
  const why = said === undefined ? null : nameProblem(said, folderName);
  if (why) throw new SkillError("Its SKILL.md name isn't one the Agent Skills spec takes.", 400, [{ path: "SKILL.md", reason: `frontmatter name: ${why}` }, ...checked.skipped]);
  return { ...checked, folderName };
}

/**
 * A folder on this Mac (picked in Finder) taken in as a new draft: checked the way orgo-web's importer
 * checks one (junk and links out of the folder skipped, a file holding a secret left out and listed by
 * path, line and kind, never its text; no SKILL.md, and README.md or SPEC.md is drafted from), its
 * frontmatter's name, when it says one, the spec's and the folder's own name.
 */
export function importFolder(wsId: string, folder: string, kind: SkillKind = "skill"): ImportResult {
  if (!workspaceById(wsId)) throw new SkillError("That workspace is gone.", 404);
  const checked = readFolder(folder);
  const extra = { ...checked.frontmatter, name: checked.slugBase };
  const { ref } = createSkill(wsId, {
    kind,
    name: checked.name,
    description: checked.description,
    body: checked.body,
    frontmatter: extra,
    files: checked.files.map((f) => ({ path: f.path, content: f.content, data: f.data, executable: f.executable })),
    source: "import",
    status: "draft",
  });
  return { ref, skipped: checked.skipped, warnings: checked.warnings, drafted: checked.drafted };
}

/**
 * Update from folder: a folder on this Mac taken in as an existing skill's next version, checked as an import
 * is (importFolder), its name, when it says one, this skill's. Its label, its bots and its versions stay; its
 * name stays too (the folder's description and text come in). A draft of the next version, published at once
 * with `publish`.
 */
export function updateFromFolder(wsId: string, folder: string, kind: SkillKind, slug: string, opts: { publish?: boolean } = {}): ImportResult & { published: boolean } {
  const r = findRef(wsId, kind, slug);
  if (!r) throw new SkillError(`That ${kind} was deleted.`, 404);
  const checked = readFolder(folder);
  const said = checked.frontmatter.name;
  if (said !== undefined && said !== slug) throw new SkillError(`That folder is another ${kind}: its SKILL.md says ${JSON.stringify(said)}, and this one is ${JSON.stringify(slug)}.`, 400, [{ path: "SKILL.md", reason: `frontmatter name: must be ${JSON.stringify(slug)}` }]);
  const description = typeof checked.frontmatter.description === "string" && checked.frontmatter.description.trim() ? checked.description : r.description;
  const files = checked.files.map((f) => ({ path: f.path, content: f.content, data: f.data, executable: f.executable }));
  updateSkill(wsId, kind, slug, { description, body: checked.body, files, frontmatter: { ...checked.frontmatter, name: slug } });
  let published = false;
  if (opts.publish) {
    publishSkill(wsId, kind, slug);
    published = true;
  }
  return { ref: findRef(wsId, kind, slug)!, skipped: checked.skipped, warnings: checked.warnings, drafted: checked.drafted, published };
}

/* ---------------- Procedures from before ---------------- */

/** A procedure as SKILL.md text: when to use it, its steps, its pitfalls. */
export function procedureBody(p: Pick<Procedure, "name" | "whenToUse" | "steps" | "pitfalls">): string {
  return [`# ${p.name}`, "", "## When to use", "", p.whenToUse, "", "## Steps", "", p.steps, ...(p.pitfalls?.trim() ? ["", "## Pitfalls", "", p.pitfalls] : []), ""].join("\n");
}

let adopting = false;

/**
 * Procedures from before skills (state.procedures) become skills of their bot's workspace, for that bot
 * only and published, keeping their uses; routines and threads that named one still find it (legacyId).
 * What was there is kept: in the state (proceduresBackup) and as procedures-backup.json beside the
 * workspaces' folders. Safe to run again: one already moved isn't moved twice. Nothing happens while
 * there's nowhere to keep the folders (signed out on the Mac).
 */
export function adoptProcedures(): number {
  const list = getState().procedures;
  if (!list?.length || adopting) return 0;
  const root = workspacesRoot();
  if (root === null) return 0;
  adopting = true;
  let moved = 0;
  try {
    mkdirSync(/*turbopackIgnore: true*/ root, { recursive: true });
    const backupFile = join(/*turbopackIgnore: true*/ root, "procedures-backup.json");
    let kept: Procedure[] = [];
    try {
      kept = JSON.parse(readFileSync(/*turbopackIgnore: true*/ backupFile, "utf8"));
    } catch {}
    // What was kept first stays: a procedure by an id already moved (a stale copy from another Mac) doesn't replace it.
    const backup = [...kept, ...list.filter((p) => !kept.some((k) => k.id === p.id))];
    writeFileSync(/*turbopackIgnore: true*/ backupFile, JSON.stringify(backup, null, 1));
    for (const p of list) {
      const b = bot(p.botId);
      if (!b) continue;
      const wsId = workspaceOf(b);
      if (!workspaceById(wsId)) update((s) => void (s.workspaces ??= []).push({ id: wsId, name: wsId === MAIN_WORKSPACE ? "Main" : "Workspace", createdAt: 0 }));
      if ((workspaceById(wsId)?.skills ?? []).some((r) => r.legacyId === p.id)) continue;
      try {
        createSkill(wsId, {
          name: p.name,
          description: p.whenToUse || p.name,
          body: procedureBody(p),
          botIds: [p.botId],
          source: "procedure",
          status: "published",
          legacyId: p.id,
          ...(p.from ? { from: p.from } : {}),
          times: { createdAt: p.createdAt, updatedAt: p.updatedAt, uses: p.uses, usedAt: p.usedAt },
        });
        moved++;
      } catch (e) {
        console.warn(`[skills] procedure ${p.id.slice(0, 12)} kept in the backup only: ${(e as Error).message}`);
      }
    }
    update((s) => {
      const had = s.proceduresBackup ?? [];
      s.proceduresBackup = [...had, ...list.filter((p) => !had.some((k) => k.id === p.id))];
      s.procedures = (s.procedures ?? []).filter((p) => !list.some((x) => x.id === p.id));
    });
  } finally {
    adopting = false;
  }
  return moved;
}

/* ---------------- On a computer ---------------- */

/** One of Bops' own skills as a folder: its SKILL.md (with its label) and its text files. */
function builtinBundle(s: BuiltinSkill): Bundle {
  const frontmatter = withLabel({ name: s.slug, description: oneLine(s.description) }, cleanLabel(s.label));
  const files: BundleFile[] = (s.files ?? []).map((f) => ({ path: f.path, content: f.content, sha256: sha256Hex(f.content), size: byteLength(f.content), executable: false }));
  return { frontmatter, body: s.body, skillMd: renderSkillMd(frontmatter, s.body), files };
}

/** A folder for a task or a computer, and how its label lists it. `builtin`: one of Bops' own, whose files need no approval. */
type Shipping = Listed & { bundle: Bundle; wsId: string };

/**
 * What goes in a task's skills folder: the bot's published skills (and apps), each as its folder. On a
 * computer several workspaces' bots share (the free one), the skills of every bot that works there.
 * `builtins`: Bops' own too, after them (a slug of theirs already taken gets a number).
 */
function bundlesFor(botIds: string[], opts: { builtins?: boolean } = {}): Shipping[] {
  const out: Shipping[] = [];
  const taken = new Set<string>();
  for (const id of botIds) {
    const b = bot(id);
    if (!b) continue;
    const wsId = workspaceOf(b);
    for (const r of skillsFor(id)) {
      const key = `${r.kind}:${wsId}:${r.slug}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const bundle = publishedBundle(wsId, r);
      if (!bundle) continue;
      // Two workspaces with the same slug on one computer: the later one's folder gets a number.
      const slug = freeSlug(r.slug, out.filter((x) => x.kind === r.kind).map((x) => x.slug));
      out.push({ kind: r.kind, slug, bundle, wsId, label: labelOfRef(r), name: r.name, description: r.description, builtin: false });
    }
  }
  if (opts.builtins && botIds.length)
    for (const s of ownSkills()) {
      const slug = freeSlug(s.slug, out.filter((x) => x.kind === "skill").map((x) => x.slug));
      out.push({ ...builtinListed(s), slug, bundle: builtinBundle(s), wsId: "" });
    }
  return out;
}

/** Where a folder is on a computer. */
const computerFolder = (x: { kind: SkillKind; slug: string }) => `${x.kind === "app" ? COMPUTER_APPS : COMPUTER_SKILLS}/${x.slug}`;

/**
 * INDEX.md beside the skills on a computer: every folder there under its label (Bops' own labels first,
 * as a bot's prompt lists them), each skill's name, what it's for, and its folder. A brain reads it first.
 */
function skillsIndex(list: Shipping[]): string {
  const ws = list.find((x) => !x.builtin)?.wsId;
  const groups = grouped([...list.filter((x) => x.builtin), ...list.filter((x) => !x.builtin)], ws ? workspaceById(ws)?.skillLabelInfo : undefined);
  return [
    "# Skills, by label",
    "",
    "How your workspace does jobs it was shown before, and Bops' own. Open the label that fits the job, then read that skill's SKILL.md in its folder and follow it. A script nobody approved yet says so when it runs: ask to have it approved in Skills, in Knowledge.",
    ...groups.flatMap((g) => [
      "",
      `## ${g.label} (${g.count})`,
      ...(g.builtin || g.told ? ["", g.about] : []),
      "",
      ...g.items.flatMap((x) => [`- ${titleOf(x)}: ${x.description}`, `  Folder: ${computerFolder(x)}/`]),
    ]),
    "",
  ].join("\n");
}

/**
 * The bots of this bot's workspace whose work lands on its computer: everyone of it sharing it (workBot), in
 * the same order whoever asks (so the computer's folders are the same set, named the same, for each of them).
 * Another workspace's bots on the same computer (the free one) are left out: each workspace's task gets only
 * its own workspace's skills there, the others' cleared first.
 */
function sharers(botId: string): string[] {
  const bots = getState().bots;
  const me = bot(botId);
  if (!me) return [];
  const host = workBot(me, bots);
  const ws = workspaceOf(me);
  return bots.filter((x) => workBot(x, bots).id === host.id && workspaceOf(x) === ws).map((x) => x.id);
}

/**
 * The bot's skills as folders in `dir` for a task on this Mac (made when missing; the task's folder is
 * fresh each run), and its apps beside it (`../apps`). Scripts not approved yet aren't executable.
 */
export function writeSkillFiles(botId: string, dir: string): void {
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  const b = bot(botId);
  if (!b) return;
  const approved = approvedIn(workspaceOf(b));
  for (const x of bundlesFor([botId])) {
    const to = x.kind === "app" ? join(/*turbopackIgnore: true*/ dirname(dir), "apps", x.slug) : join(/*turbopackIgnore: true*/ dir, x.slug);
    writeTree(to, x.bundle.skillMd, shipped(x.bundle.files, approved));
  }
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * Bytes per piece of a file copied to a computer. Linux takes no single argument over 128 KB
 * (MAX_ARG_STRLEN), and each call's commands reach the computer's bash as one: a piece (48 KB, 64 KB
 * as base64) and a call (CALL_MAX) stay well under it.
 */
const PIECE = 48 * 1024;
const CALL_MAX = 100_000;

/**
 * The bot's skills and apps copied to its Orgo computer, fresh: /workspace/capabilities/skills/<slug>/
 * and capabilities/apps/<slug>/ (on a shared computer, every sharer's), Bops' own skills beside them, and
 * INDEX.md listing them all by label (skillsIndex). Scripts nobody approved yet arrive without their
 * executable bit. Sent in pieces small enough for one bash call each. Answers how many of the workspace's own
 * folders went there (Bops' own always do). A computer's runner has the skills' files only as far as they
 * were made there (they're synced to the Mac alone): missing any of them, it leaves the folder as the Mac
 * copied it rather than clear it.
 */
export async function copySkillsToComputer(botId: string, computerId: string, bash: (computerId: string, command: string, timeout?: number) => Promise<{ output: string; exit_code: number }>) {
  const team = sharers(botId);
  if (onRunner() && team.some((id) => skillsFor(id).some((r) => !publishedBundle(workspaceOf(bot(id)!), r)))) return 0;
  const bundles = bundlesFor(team, { builtins: true });
  // Nothing to copy and nothing copied there before (by this server, or as far as it knows): nothing to clear either.
  const me = bot(botId);
  const approved = me ? approvedIn(workspaceOf(me)) : new Set<string>();
  // Bops' own files are never scripts, and are Bops' to vouch for: as they are.
  const filesOf = (x: Shipping) => (x.builtin ? x.bundle.files : shipped(x.bundle.files, approved));
  const index = bundles.length ? skillsIndex(bundles) : "";
  const copied = (g.bopsSkillsCopied ??= new Map());
  const sig = sha256Hex(JSON.stringify([index, ...bundles.map((x) => [x.kind, x.slug, x.bundle.skillMd, filesOf(x).map((f) => [f.path, sha256Hex(fileBytes(f)), f.executable])])]));
  const own = bundles.filter((x) => !x.builtin).length;
  if ((!bundles.length && !copied.has(computerId)) || copied.get(computerId) === sig) return own;
  const lines: string[] = [`rm -rf ${COMPUTER_SKILLS} ${COMPUTER_APPS}`, `mkdir -p ${COMPUTER_SKILLS} ${COMPUTER_APPS}`];
  const each: { base: string; files: { path: string; content: string | null; data?: Buffer; executable: boolean }[] }[] = [
    ...(index ? [{ base: COMPUTER_SKILLS, files: [{ path: "INDEX.md", content: index, executable: false }] }] : []),
    ...bundles.map((x) => ({ base: computerFolder(x), files: [{ path: "SKILL.md", content: x.bundle.skillMd, executable: false }, ...filesOf(x)] })),
  ];
  for (const { base, files } of each) {
    for (const f of files) {
      const to = `${base}/${f.path}`;
      const bytes = fileBytes(f);
      // A large file (a program) goes in pieces, each its own base64, appended: no one call carries all of it.
      const pieces: string[] = [];
      for (let i = 0; i < bytes.length; i += PIECE) pieces.push(`printf %s ${shQuote(bytes.subarray(i, i + PIECE).toString("base64"))} | base64 -d >> ${shQuote(to)}`);
      const head = `mkdir -p ${shQuote(dirname(to))} && : > ${shQuote(to)}`;
      const file = pieces.length <= 1 ? [[head, ...pieces].join(" && ")] : [head, ...pieces];
      if (f.executable) file[file.length - 1] += ` && chmod 755 ${shQuote(to)}`;
      lines.push(...file);
    }
  }
  const chunks: string[][] = [[]];
  let size = 0;
  for (const l of lines) {
    if (size + l.length > CALL_MAX && chunks[chunks.length - 1].length) {
      chunks.push([]);
      size = 0;
    }
    chunks[chunks.length - 1].push(l);
    size += l.length;
  }
  copied.delete(computerId);
  for (const c of chunks) {
    const r = await bash(computerId, ["set -e", ...c].join("\n"), 60);
    if (r.exit_code !== 0) throw new Error(`copying skills: ${r.output.slice(0, 200)}`);
  }
  copied.set(computerId, sig);
  return own;
}

/* ---------------- Moving a workspace's folder ---------------- */

/**
 * A workspace got its Orgo project: its folder moves from <wsId> to <projectId> (folderKey). When the
 * new one is already there (another Mac synced into it), the two merge by slug: what's already there stays.
 */
export function moveWorkspaceFolder(fromKey: string, toKey: string) {
  const root = workspacesRoot();
  if (!root || fromKey === toKey) return;
  const from = join(/*turbopackIgnore: true*/ root, fromKey);
  const to = join(/*turbopackIgnore: true*/ root, toKey);
  if (!existsSync(/*turbopackIgnore: true*/ from)) return;
  if (!existsSync(/*turbopackIgnore: true*/ to)) {
    mkdirSync(/*turbopackIgnore: true*/ root, { recursive: true });
    renameSync(/*turbopackIgnore: true*/ from, to);
    return;
  }
  for (const sub of ["skills", "apps", join(".versions", "skills"), join(".versions", "apps")]) {
    const a = join(/*turbopackIgnore: true*/ from, sub);
    if (!existsSync(/*turbopackIgnore: true*/ a)) continue;
    for (const slug of readdirSync(/*turbopackIgnore: true*/ a)) {
      const dest = join(/*turbopackIgnore: true*/ to, sub, slug);
      if (existsSync(/*turbopackIgnore: true*/ dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(/*turbopackIgnore: true*/ join(a, slug), dest);
    }
  }
  rmSync(/*turbopackIgnore: true*/ from, { recursive: true, force: true });
}

/* ---------------- In step with Orgo ---------------- */

/** `label`: orgo-web's skills.label column, which only an orgo-web that keeps it says (labelColumn). */
type RemoteSkill = { id: string; slug: string; name: string; description: string | null; type: string; status: string; bot_ids?: string[]; label?: string | null; updated_at: string; current_version?: { version?: string } | null };
/** One of Orgo's record of deletions (GET …/skills?since=): a skill deleted after `since`, never one live now. */
type RemoteDeletion = { id: string; slug: string; type: string; deleted_at: string };

const remoteType = (kind: SkillKind) => (kind === "app" ? "app" : "skill");
// "software" is what an older orgo-web called an app.
const localKind = (type: string): SkillKind => (type === "software" || type === "app" ? "app" : "skill");

/** One call to orgo-web's skills routes for a workspace, with the signed-in key. Null when Orgo didn't answer. */
async function skillsCall<T>(projectId: string, path: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {}) {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  return callOrgo<T>(key, `/api/workspaces/${encodeURIComponent(projectId)}/skills${path}`, { ...init, timeoutMs: 20_000 });
}

/** Whether this Orgo has the skills routes, per project (an Orgo without them answers 404 or 405, not JSON with skills). */

const routes = (g.bopsSkillsRoutes ??= new Map());

/**
 * Whether this Orgo keeps a skill's label in its own column (orgo-web's skills.label, authoritative for listing
 * and grouping there), per project: its skill JSON says "label" (a list's, a POST's or a PATCH's answer). Then a
 * move here goes to Orgo with a PATCH, at once, and Orgo's label comes here unless it's the one Orgo had when
 * the two last agreed (SkillRef.remoteLabel: a move made here and not taken yet is kept, and sent). Without it
 * (an older orgo-web), a move reaches Orgo only in the next version's SKILL.md, and a pull keeps it meanwhile
 * the same way. Known only in memory: after a restart a list of only what changed may say nothing, so a PATCH's
 * answer says it too, and a move still waiting asks the whole list once (labelProbed).
 */
const labelColumn = (g.bopsSkillsLabelColumn ??= new Map());
const hasColumn = (x: unknown): x is { label?: string | null } => !!x && typeof x === "object" && Object.prototype.hasOwnProperty.call(x, "label");
const noteLabelColumn = (pid: string, list: unknown[] | undefined) => {
  if (list?.some(hasColumn)) labelColumn.set(pid, true);
};
/** Projects whose whole list this run read once to learn whether Orgo keeps the column, for a move waiting. */
const labelProbed = (g.bopsSkillsLabelProbed ??= new Set());
/** A label as orgo-web's column takes it: null for Unsorted, and for Bops' suggestion not confirmed yet. */
const columnLabel = (r: SkillRef) => keptLabel(sentLabelOf(r)) ?? null;
/** Orgo's column as a label here: null, empty, "Other" or "Unsorted" is Unsorted. */
const labelOfColumn = (x: { label?: string | null }) => cleanLabel(x.label);
/** Moved here and not taken by Orgo yet: not the label Orgo had when the two last agreed. */
const movedHere = (r: SkillRef) => r.remoteLabel !== undefined && !sameLabel(sentLabelOf(r), r.remoteLabel);

/**
 * A move made here, to Orgo's column alone (orgo-web's PATCH takes {label} without a new version): what Orgo
 * has after it, as last seen. Not ok, with Orgo's status (null: no answer), when it didn't go.
 */
async function sendLabel(wsId: string, pid: string, remoteId: string, r: SkillRef): Promise<{ ok: boolean; status: number | null }> {
  const p = await skillsCall<{ skill?: RemoteSkill }>(pid, `/${encodeURIComponent(remoteId)}`, { method: "PATCH", body: { label: columnLabel(r) } });
  if (p?.status !== 200) return { ok: false, status: p?.status ?? null };
  noteLabelColumn(pid, [p.json.skill]);
  const after = p.json.skill;
  patchRef(wsId, r.kind, r.slug, (x) => {
    x.remoteLabel = hasColumn(after) ? labelOfColumn(after) : sentLabelOf(r);
    if (after?.updated_at) x.remoteAt = after.updated_at;
  });
  return { ok: true, status: 200 };
}
/** Whether orgo-web has the skill-labels route, per project (undefined: not asked yet). */
const labelRoutes = (g.bopsSkillLabelsRoute ??= new Map());

/** A delete still to send: the project it's in, and its Orgo id (none: found by slug and kind when it's sent). */
type SkillDelete = { pid: string; kind: SkillKind; slug: string; remoteId?: string };
/** Deletes Orgo hasn't taken yet, kept on disk until it does. */
const deletes = outbox<SkillDelete>("skill-deletes", 2 * MAX_SKILLS);

/** Orgo didn't answer, or answered for now (signed out, not allowed for now, a timeout, too many, 5xx): sent again later. */
const forNow = (status: number | null) => status === null || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;
const DELETE_RETRY_MS = 60_000;
const DELETE_RETRY_MAX_MS = 30 * 60_000;

/**
 * Send a workspace's waiting deletes (every workspace's without one): DELETE .../skills/{id}, the id found
 * by slug and kind in Orgo's list for one without. Done when Orgo deleted it, or hasn't it (404, or not
 * in its list); kept, and tried again after a backoff, when Orgo didn't answer or answered for now. One
 * Orgo will never take (a 400) is given up on, said in the log. True when none is left waiting.
 */
async function flushDeletes(wsId?: string): Promise<boolean> {
  const lists = new Map<string, RemoteSkill[] | null>();
  const listOf = async (pid: string) => {
    if (!lists.has(pid)) {
      const got = await skillsCall<{ skills?: RemoteSkill[] }>(pid, "");
      lists.set(pid, got && got.status < 300 && Array.isArray(got.json.skills) ? got.json.skills : got && !forNow(got.status) ? [] : null);
    }
    return lists.get(pid)!;
  };
  let left = false;
  for (const e of deletes.waiting(wsId)) {
    const d = e.item;
    if (routes.get(d.pid) === false) {
      deletes.done([e.id]);
      continue;
    }
    let remoteId = d.remoteId;
    if (!remoteId) {
      const list = await listOf(d.pid);
      if (list === null) {
        left = true;
        continue;
      }
      remoteId = list.find((x) => x.slug === d.slug && localKind(x.type) === d.kind)?.id;
      if (!remoteId) {
        deletes.done([e.id]);
        continue;
      }
    }
    const r = await skillsCall(d.pid, `/${encodeURIComponent(remoteId)}`, { method: "DELETE" });
    const status = r?.status ?? null;
    if (forNow(status)) {
      left = true;
      continue;
    }
    if (status !== null && status >= 300 && status !== 404) console.warn(`[skills] Orgo answered ${status} to deleting ${d.slug}; not asked again`);
    deletes.done([e.id]);
  }
  if (left) deletesLater();
  else if (!wsId) g.bopsSkillsTries?.delete("deletes");
  return !left;
}

/** Deletes still waiting go again after a backoff (1 minute, doubling to 30). */
function deletesLater() {
  if (g.bopsSkillsDeleteTimer) return;
  const tries = (g.bopsSkillsTries ??= new Map());
  const n = (tries.get("deletes") ?? 0) + 1;
  tries.set("deletes", n);
  g.bopsSkillsDeleteTimer = setTimeout(
    () => {
      g.bopsSkillsDeleteTimer = undefined;
      void flushDeletes().catch((e: Error) => console.warn(`[skills] deletes: ${e.message}`));
    },
    Math.min(DELETE_RETRY_MS * 2 ** (n - 1), DELETE_RETRY_MAX_MS),
  );
  g.bopsSkillsDeleteTimer.unref?.();
}

/** Deletes and label renames left in the outboxes by an earlier run of Bops go now (once a start: the skills route's first sync, or a sign-in). */
export function skillDeletesOnStart() {
  if (onRunner()) return;
  if (renamesOut.restore().length) void flushRenames().catch((e: Error) => console.warn(`[skills] label rename: ${e.message}`));
  if (!deletes.restore().length) return;
  void flushDeletes().catch((e: Error) => console.warn(`[skills] deletes: ${e.message}`));
}

/* ---------------- A label renamed, in Orgo's database ---------------- */

/** A rename still to send: the project, and the label before and after (Unsorted for none). */
type LabelRename = { pid: string; from: string; to: string };
/** Renames Orgo hasn't taken yet, kept on disk until it does, sent in the order they were made. */
const renamesOut = outbox<LabelRename>("skill-label-renames", 200);
/** Whether orgo-web has the rename route, per project (false: an older one; each skill's label goes on its own). */
const renameRoutes = (g.bopsSkillLabelRename ??= new Map());
const g3 = globalThis as unknown as { bopsRenamesChain?: Promise<unknown>; bopsRenamesTimer?: ReturnType<typeof setTimeout>; bopsRenamesTries?: number };

/** A skill whose move a rename still waiting carries: not sent on its own meanwhile. */
const carried = (wsId: string, pid: string, r: SkillRef) => renamesOut.waiting(wsId).some((e) => e.item.pid === pid && sameLabel(e.item.to, sentLabelOf(r)));
/** Moved here and not taken by Orgo yet, nor waiting to go with a rename. */
const movedNow = (wsId: string, pid: string, r: SkillRef) => movedHere(r) && !carried(wsId, pid, r);

/**
 * Send a workspace's waiting renames (every workspace's without one), oldest first, one after another (a call
 * meanwhile waits for the one going): POST /api/projects/{id}/skill-labels/rename {from, to}, which moves every
 * skill of the project under `from` and its skill_labels row in one transaction, with no new version. Taken:
 * Orgo has `to` where it had `from` (SkillRef.remoteLabel), so nothing goes again; a skill changed here
 * meanwhile stays the later change. Orgo didn't answer, or for now: kept, and later ones of that project wait
 * behind it, tried again after a backoff and at the next start. An older orgo-web without the route (404, 405),
 * or one that turned it down: each skill moved goes on its own with the next sync, as before (moveEach). True
 * when none is left waiting.
 */
function flushRenames(wsId?: string): Promise<boolean> {
  const run = (g3.bopsRenamesChain ?? Promise.resolve()).catch(() => {}).then(() => sendRenames(wsId));
  g3.bopsRenamesChain = run;
  return run;
}

async function sendRenames(wsId?: string): Promise<boolean> {
  const stuck = new Set<string>();
  for (const e of renamesOut.waiting(wsId)) {
    const { pid, from, to } = e.item;
    if (stuck.has(pid)) continue;
    if (routes.get(pid) === false) {
      renamesOut.done([e.id]);
      continue;
    }
    const r = renameRoutes.get(pid) === false ? null : await labelsCall(pid, { method: "POST", path: "/rename", body: { from, to } });
    const status = renameRoutes.get(pid) === false ? 404 : (r?.status ?? null);
    if (forNow(status)) {
      stuck.add(pid);
      continue;
    }
    renamesOut.done([e.id]);
    if (status === 200) {
      renameRoutes.set(pid, true);
      await renamedThere(e.wsId, pid, from, to);
      continue;
    }
    if (status === 404 || status === 405) renameRoutes.set(pid, false);
    else console.warn(`[skills] Orgo answered ${status} to renaming a label; each skill goes on its own`);
    moveEach(e.wsId, pid, from, to);
  }
  if (stuck.size) renamesLater();
  else if (!wsId) g3.bopsRenamesTries = 0;
  return !stuck.size;
}

/**
 * Orgo took a rename: what it has now, as last seen. The rename gave every skill it moved a new updated_at (and
 * no new version), and its answer ({moved, label}) carries no times, so Orgo's list says them, read once: a
 * skill it moved, listed with the version last seen and `to` in its column, takes that updated_at as last seen
 * (as sendLabel does after a PATCH). Else the next sync would see it changed on Orgo and take Orgo's copy over
 * its folder, a draft there or an edit not sent yet with it. One listed otherwise (another version: changed
 * there too), or a list that can't be read: the sync compares it as before, and one changed here meanwhile is
 * the later change.
 */
async function renamedThere(wsId: string, pid: string, from: string, to: string) {
  const moved = new Set<string>();
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    for (const x of [...(w?.skills ?? []), ...(w?.apps ?? [])]) {
      if (!x.remoteId || (x.remotePid ?? pid) !== pid || x.remoteLabel === undefined || !sameLabel(x.remoteLabel, from)) continue;
      x.remoteLabel = cleanLabel(to);
      moved.add(x.remoteId);
    }
  });
  if (!moved.size) return;
  const got = await skillsCall<{ skills?: RemoteSkill[] }>(pid, "");
  const listed = got?.status === 200 && Array.isArray(got.json.skills) ? got.json.skills : null;
  if (listed) noteLabelColumn(pid, listed);
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    for (const x of [...(w?.skills ?? []), ...(w?.apps ?? [])]) {
      if (!x.remoteId || !moved.has(x.remoteId) || (x.remotePid ?? pid) !== pid) continue;
      const there = listed?.find((y) => y.id === x.remoteId);
      if (there?.updated_at && hasColumn(there) && sameLabel(labelOfColumn(there), to) && (there.current_version?.version ?? "") === (x.remoteVersion ?? "")) x.remoteAt = there.updated_at;
      else if (x.syncedAt && x.updatedAt > x.syncedAt) x.updatedAt = Date.now();
    }
  });
}

/** Without the route: every skill the rename moved here that Orgo still has under `from` goes with the next sync, on its own. */
function moveEach(wsId: string, pid: string, from: string, to: string) {
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === wsId);
    for (const x of [...(w?.skills ?? []), ...(w?.apps ?? [])]) {
      if (!x.remoteId || (x.remotePid ?? pid) !== pid || !sameLabel(sentLabelOf(x), to)) continue;
      if (x.remoteLabel !== undefined && !sameLabel(x.remoteLabel, from)) continue;
      x.updatedAt = Math.max(Date.now(), (x.syncedAt ?? 0) + 1);
    }
  });
  queueSync(wsId);
}

/** Renames still waiting go again after a backoff (1 minute, doubling to 30). */
function renamesLater() {
  if (g3.bopsRenamesTimer) return;
  const n = (g3.bopsRenamesTries = (g3.bopsRenamesTries ?? 0) + 1);
  g3.bopsRenamesTimer = setTimeout(
    () => {
      g3.bopsRenamesTimer = undefined;
      void flushRenames().catch((e: Error) => console.warn(`[skills] label rename: ${e.message}`));
    },
    Math.min(DELETE_RETRY_MS * 2 ** (n - 1), DELETE_RETRY_MAX_MS),
  );
  g3.bopsRenamesTimer.unref?.();
}

/* ---------------- Script approvals, in step with Orgo ---------------- */

/** An approval or a revoke still to send: the project, the script's sha256, and where it is. */
type ApprovalChange = { pid: string; sha256: string; on: boolean; path?: string };
/** Approvals and revokes Orgo hasn't taken yet, kept on disk until it does. */
const approvalsOut = outbox<ApprovalChange>("skill-approvals", 2000);
/** `approved_by`: the Orgo user who approved it. */
type RemoteApproval = { sha256: string; path_hint?: string | null; approved_by?: string | null; approved_at?: string };
const g2 = globalThis as unknown as { bopsApprovalsTimer?: ReturnType<typeof setTimeout>; bopsApprovalsTries?: number; bopsApprovalsSaid?: boolean; bopsApprovalsParked?: Set<string> };
/** Outbox entries Orgo couldn't place (unknown_sha), by id: sent again only after a sync sent a file with that content (or once a run of Bops). */
const parked = (g2.bopsApprovalsParked ??= new Set<string>());

/** An approval made or taken back here: sent to Orgo now (or once the script's skill is there). */
function approvalChanged(wsId: string, sha256: string, on: boolean, path?: string) {
  const pid = workspaceById(wsId)?.orgoProjectId;
  if (!pid || routes.get(pid) === false || onRunner()) return;
  approvalsOut.done(approvalsOut.waiting(wsId).filter((e) => e.item.sha256 === sha256).map((e) => e.id));
  approvalsOut.add(wsId, { pid, sha256, on, ...(path ? { path: path.slice(0, 512) } : {}) });
  void flushApprovals(wsId).catch((e: Error) => console.warn(`[skills] approvals: ${e.message}`));
}

/**
 * Send a workspace's waiting approvals and revokes (every workspace's without one). An approval Orgo can't
 * place yet (404 unknown_sha: no file of the workspace's skills on Orgo has that content, as a draft of a
 * published skill until it's published) stays on this Mac without a retry on a timer, and goes again only
 * after a sync sent a file with that content (`pushed`) or at the next start; one whose script is in none
 * of the workspace's skills any more (changed again, or deleted) goes from the outbox. One Orgo didn't
 * take for now is tried again after a backoff. The key must be the person's Bops sign-in key (orgo-web's
 * session_required otherwise): one that isn't gives up, said in the log once. True when none is left
 * waiting for a retry.
 */
async function flushApprovals(wsId?: string, pushed?: Set<string>): Promise<boolean> {
  let left = false;
  const shas = new Map<string, Set<string>>();
  const inSkills = (ws: string, sha: string) => {
    let here = shas.get(ws);
    if (!here) shas.set(ws, (here = new Set(filesHere(ws).map((f) => f.sha256))));
    return here.has(sha);
  };
  const drop = (id: string) => {
    approvalsOut.done([id]);
    parked.delete(id);
  };
  for (const e of approvalsOut.waiting(wsId)) {
    const a = e.item;
    if (routes.get(a.pid) === false || workspaceById(e.wsId)?.orgoProjectId !== a.pid) {
      drop(e.id);
      continue;
    }
    if (a.on && !inSkills(e.wsId, a.sha256)) {
      drop(e.id);
      continue;
    }
    if (a.on && parked.has(e.id) && !pushed?.has(a.sha256)) continue;
    parked.delete(e.id);
    const r = a.on
      ? await skillsCall<{ approval?: RemoteApproval; code?: string }>(a.pid, "/approvals", { method: "POST", body: { sha256: a.sha256, ...(a.path ? { path_hint: a.path } : {}) } })
      : await skillsCall<{ code?: string }>(a.pid, `/approvals?sha256=${a.sha256}`, { method: "DELETE" });
    const status = r?.status ?? null;
    const code = typeof (r?.json as { code?: unknown } | undefined)?.code === "string" ? (r!.json as { code: string }).code : undefined;
    if (status !== null && (status < 300 || (!a.on && status === 404))) {
      approvalsOut.done([e.id]);
      if (a.on) markApproval(e.wsId, a.sha256, true);
      continue;
    }
    if (code === "session_required") {
      if (!g2.bopsApprovalsSaid) console.warn("[skills] Orgo takes script approvals only from a person signed in to Bops; this key isn't, so they stay on this Mac");
      g2.bopsApprovalsSaid = true;
      approvalsOut.done([e.id]);
      continue;
    }
    // No file on Orgo has that content yet: kept here, and sent again once a sync sent one.
    if (code === "unknown_sha") {
      parked.add(e.id);
      continue;
    }
    if (forNow(status)) {
      left = true;
      continue;
    }
    console.warn(`[skills] Orgo answered ${status} to ${a.on ? "an approval" : "a revoke"}; not asked again`);
    approvalsOut.done([e.id]);
  }
  if (left) approvalsLater();
  else g2.bopsApprovalsTries = 0;
  return !left;
}

function approvalsLater() {
  if (g2.bopsApprovalsTimer) return;
  const n = (g2.bopsApprovalsTries = (g2.bopsApprovalsTries ?? 0) + 1);
  g2.bopsApprovalsTimer = setTimeout(
    () => {
      g2.bopsApprovalsTimer = undefined;
      void flushApprovals().catch((e: Error) => console.warn(`[skills] approvals: ${e.message}`));
    },
    Math.min(DELETE_RETRY_MS * 2 ** (n - 1), DELETE_RETRY_MAX_MS),
  );
  g2.bopsApprovalsTimer.unref?.();
}

/** Orgo has this approval (`on`), or not. */
function markApproval(wsId: string, sha256: string, on: boolean) {
  update((s) => {
    const x = s.workspaces?.find((w) => w.id === wsId)?.approvals?.find((y) => y.sha256 === sha256);
    if (x) x.synced = on || undefined;
  });
}

/**
 * Orgo's approvals here (GET …/skills/approvals): one the person signed in here made (on orgo.ai, or in
 * Bops on another Mac: approved_by) is taken, another member's never (it doesn't run a script on this
 * Mac); one Orgo had and no longer lists was revoked there and goes here too; one made here that Orgo
 * never had is sent, while its script is in one of the workspace's skills. What waits to be sent from here
 * stands.
 */
async function pullApprovals(wsId: string, pid: string) {
  const got = await skillsCall<{ approvals?: RemoteApproval[] }>(pid, "/approvals");
  if (!got || got.status !== 200 || !Array.isArray(got.json.approvals)) return;
  const owner = getState().account?.user.id;
  const there = new Map(got.json.approvals.filter((a) => typeof a?.sha256 === "string").map((a) => [a.sha256, a]));
  const byOwner = (a: RemoteApproval | undefined) => !!owner && !!a && a.approved_by === owner;
  const waiting = new Set(approvalsOut.waiting(wsId).map((e) => e.item.sha256));
  const mine = workspaceById(wsId)?.approvals ?? [];
  const send: ScriptApproval[] = [];
  const kept: ScriptApproval[] = [];
  let shas: Set<string> | undefined;
  for (const a of mine) {
    if (waiting.has(a.sha256)) kept.push(a);
    else if (there.has(a.sha256)) {
      // Made here, or taken from Orgo while Orgo says this person made it (one taken before from another member's goes).
      if (a.inBops || byOwner(there.get(a.sha256)) || !owner) kept.push(a.synced ? a : { ...a, synced: true });
    }
    // Orgo had it and doesn't now: revoked there. Never had it: sent, while its script is in a skill here.
    else if (!a.synced) {
      kept.push(a);
      if ((shas ??= new Set(filesHere(wsId).map((f) => f.sha256))).has(a.sha256)) send.push(a);
    }
  }
  for (const [sha, a] of there)
    if (byOwner(a) && !waiting.has(sha) && !kept.some((x) => x.sha256 === sha)) kept.push({ sha256: sha, path: (a.path_hint ?? "").slice(0, 512), at: Date.parse(a.approved_at ?? "") || Date.now(), synced: true });
  if (kept.length !== mine.length || kept.some((x, i) => x !== mine[i]))
    update((s) => {
      const ws = s.workspaces?.find((w) => w.id === wsId);
      if (ws) ws.approvals = kept;
    });
  // Not with a key Orgo takes no approvals from (said once): they stay here.
  if (!g2.bopsApprovalsSaid) for (const a of send) approvalChanged(wsId, a.sha256, true, a.path);
}

/* ---------------- What a sync reads ---------------- */

/** The time of this Mac's last whole sync of a workspace with Orgo (orgo-web's `at`), kept in its folder for ?since=. */
const sinceFile = (wsId: string) => {
  const dir = workspaceDir(wsId);
  return dir ? join(/*turbopackIgnore: true*/ dir, ".orgo-since.json") : null;
};
function sinceOf(wsId: string, pid: string): string | undefined {
  const file = sinceFile(wsId);
  try {
    const s = file && existsSync(/*turbopackIgnore: true*/ file) ? (JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as { pid?: string; at?: string }) : null;
    return s?.pid === pid && typeof s.at === "string" ? s.at : undefined;
  } catch {
    return undefined;
  }
}
function keepSince(wsId: string, pid: string, at: string) {
  const file = sinceFile(wsId);
  if (!file) return;
  try {
    mkdirSync(/*turbopackIgnore: true*/ dirname(file), { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ `${file}.tmp`, JSON.stringify({ pid, at }), { mode: 0o600 });
    renameSync(/*turbopackIgnore: true*/ `${file}.tmp`, file);
  } catch (e) {
    console.warn(`[skills] keeping when the last sync was: ${(e as Error).message}`);
  }
}

/** A skill as Orgo had it when the two last agreed: what an answer of only what changed leaves out of it. */
const asLastSeen = (r: SkillRef): RemoteSkill => ({
  id: r.remoteId!,
  slug: r.slug,
  name: r.name,
  description: r.description,
  type: remoteType(r.kind),
  status: r.status,
  bot_ids: r.botIds,
  updated_at: r.remoteAt!,
  current_version: r.remoteVersion ? { version: r.remoteVersion } : null,
});

/** What a skill's folder sends Orgo: its SKILL.md text (with its label as it's listed here, a suggestion not confirmed yet as none) and files, a binary file (a program) as content_base64. */
function payloadOf(wsId: string, r: SkillRef) {
  const b = r.version ? (readBundle(versionDir(wsId, r.kind, r.slug, r.version)) ?? readBundle(skillDir(wsId, r.kind, r.slug))) : readBundle(skillDir(wsId, r.kind, r.slug));
  if (!b) return null;
  return {
    shas: b.files.map((f) => f.sha256),
    body: renderSkillMd(withLabel(frontmatterOf(r.slug, r.description, b.frontmatter), sentLabelOf(r)), b.body),
    files: b.files.map((f) => (f.content !== null ? { path: f.path, content: f.content, executable: f.executable } : { path: f.path, content_base64: f.data!.toString("base64"), executable: f.executable })),
  };
}

/** `removed`: deleted on Orgo, so deleted here. `retry`: Orgo didn't take all of it for now (tried again after a backoff). */
export type SyncResult = { mode: "local" | "orgo"; pushed: number; pulled: number; failed: number; removed?: number; retry?: boolean };

/**
 * Keep a workspace's skills in step with Orgo's (GET/POST/PATCH /api/workspaces/{project}/skills), keyed
 * by slug, the later change winning (Orgo's updated_at against this Mac's updatedAt): a skill only here
 * goes to Orgo, one only on Orgo comes here, one changed on both sides takes the later. A workspace with
 * no Orgo project, or an Orgo without the routes, stays local and nothing is sent.
 *
 * One sync per workspace at a time: a call while one runs gets that run's promise, and the run goes
 * once more after it ends (two runs side by side would both see a skill as "only here" and both POST it,
 * leaving Orgo two copies). The answer is the last run's, so a caller that awaits sees the final state.
 */
export function syncSkills(wsId: string): Promise<SyncResult> {
  const inFlight = (g.bopsSkillsInFlight ??= new Map());
  const going = inFlight.get(wsId);
  if (going) {
    going.again = true;
    return going.done;
  }
  const entry = { done: Promise.resolve() as unknown as Promise<SyncResult>, again: false };
  const loop = async (): Promise<SyncResult> => {
    for (;;) {
      entry.again = false;
      const r = await syncOnce(wsId);
      if (!entry.again) return r;
    }
  };
  entry.done = loop()
    .then((r) => {
      // Not all of it went: again after a backoff. All of it did: the backoff starts over.
      const tries = (g.bopsSkillsTries ??= new Map());
      if (r.retry) queueSync(wsId, (tries.get(wsId) ?? 0) + 1);
      else tries.delete(wsId);
      return r;
    })
    .finally(() => inFlight.delete(wsId));
  inFlight.set(wsId, entry);
  return entry.done;
}

async function syncOnce(wsId: string): Promise<SyncResult> {
  const res: SyncResult = { mode: "local", pushed: 0, pulled: 0, failed: 0 };
  const pid = workspaceById(wsId)?.orgoProjectId;
  if (!pid || routes.get(pid) === false || !workspaceDir(wsId)) return res;
  // Deletes waiting go first: a sync never brings back one Orgo hasn't taken yet.
  skillDeletesOnStart();
  if (!(await flushDeletes(wsId))) res.retry = true;
  // Renames waiting go next: Orgo's labels are this Mac's before the two are compared.
  if (!(await flushRenames(wsId))) res.retry = true;
  // Only what changed since the last whole sync, with Orgo's record of what was deleted since.
  const since = sinceOf(wsId, pid);
  const got = await skillsCall<{ skills?: RemoteSkill[]; deleted?: RemoteDeletion[]; full?: boolean; at?: string }>(pid, since ? `?since=${encodeURIComponent(since)}` : "");
  if (!got || forNow(got.status)) return { ...res, retry: true };
  if (got.status === 404 || got.status === 405 || !Array.isArray(got.json.skills)) {
    if (got.status === 404 || got.status === 405) routes.set(pid, false);
    return res;
  }
  routes.set(pid, true);
  res.mode = "orgo";
  const changed = got.json.skills;
  noteLabelColumn(pid, changed);
  // Deleted on Orgo (another Mac, orgo.ai), as its record says: here too, unless it changed here since the
  // two last agreed: then it goes to Orgo again, as a new one.
  for (const d of Array.isArray(got.json.deleted) ? got.json.deleted : []) {
    if (!d || typeof d.id !== "string" || changed.some((x) => x.id === d.id)) continue;
    const r = refsOf(wsId).find((x) => x.remoteId === d.id && (x.remotePid ?? pid) === pid);
    if (!r) continue;
    if (r.syncedAt && r.updatedAt <= r.syncedAt) {
      dropLocal(wsId, r.kind, r.slug);
      res.removed = (res.removed ?? 0) + 1;
    } else patchRef(wsId, r.kind, r.slug, (x) => ((x.remoteId = undefined), (x.remotePid = undefined), (x.remoteAt = undefined), (x.remoteVersion = undefined), (x.remoteLabel = undefined), (x.syncedAt = undefined)));
  }
  // An answer of only what changed holds every skill here that changed there; the rest are as Orgo had them
  // when the two last agreed. One this Mac can't place that way (never sent, or from before remoteVersion)
  // needs the whole list.
  let listed = changed;
  if (got.json.full === false) {
    const ids = new Set(changed.map((x) => x.id));
    const lastSeen = (r: SkillRef) => !!r.remoteId && (r.remotePid ?? pid) === pid && !!r.syncedAt && !!r.remoteAt && r.remoteVersion !== undefined;
    const here = refsOf(wsId);
    if (here.every((r) => (r.remoteId && ids.has(r.remoteId)) || lastSeen(r))) listed = [...changed, ...here.filter((r) => !(r.remoteId && ids.has(r.remoteId))).map(asLastSeen)];
    else {
      const all = await skillsCall<{ skills?: RemoteSkill[] }>(pid, "");
      if (!all || forNow(all.status)) return { ...res, retry: true };
      if (!Array.isArray(all.json.skills)) return res;
      listed = all.json.skills;
      noteLabelColumn(pid, listed);
    }
  }
  // A move made here and not taken yet, and nothing this run read said whether Orgo keeps the column (a restart,
  // then a list of only what changed with nothing in it; or an orgo-web that keeps one since, its column taken
  // from the version): the whole list says, once a run, so the move goes now.
  if (labelColumn.get(pid) === undefined && !labelProbed.has(pid) && refsOf(wsId).some((r) => !!r.remoteId && (r.remotePid ?? pid) === pid && movedNow(wsId, pid, r))) {
    const all = await skillsCall<{ skills?: RemoteSkill[] }>(pid, "");
    if (all && !forNow(all.status)) {
      labelProbed.add(pid);
      if (Array.isArray(all.json.skills)) noteLabelColumn(pid, all.json.skills);
    }
  }
  // Deleted here and not taken by Orgo yet: as if Orgo hadn't them (never matched, never brought here).
  const waiting = deletes.waiting(wsId).filter((e) => e.item.pid === pid);
  const goneHere = (x: RemoteSkill) => waiting.some((e) => (e.item.remoteId ? e.item.remoteId === x.id : e.item.slug === x.slug && e.item.kind === localKind(x.type)));
  const remote = listed.filter((x) => !goneHere(x));
  const local = refsOf(wsId);
  // The contents of every file this sync sent: an approval Orgo couldn't place before may be placed now.
  const pushed = new Set<string>();
  for (const r of local) {
    // Its Orgo id is this project's (one kept from before remotePid was: taken to be).
    const mine = !!r.remoteId && (r.remotePid ?? pid) === pid;
    const there = remote.find((x) => (mine ? x.id === r.remoteId : x.slug === r.slug && localKind(x.type) === r.kind));
    try {
      if (!there && mine && r.remotePid === pid && r.syncedAt && r.updatedAt <= r.syncedAt) {
        // Orgo had it and doesn't now, and it hasn't changed here since: deleted there (on orgo.ai, or on another Mac).
        dropLocal(wsId, r.kind, r.slug);
        res.removed = (res.removed ?? 0) + 1;
        continue;
      }
      if (!there) {
        // Only here: made on Orgo with its current text.
        const p = payloadOf(wsId, r);
        if (!p) continue;
        const made = await skillsCall<{ skill?: RemoteSkill }>(pid, "", {
          method: "POST",
          body: { name: r.name, description: r.description, type: remoteType(r.kind), body: p.body, files: p.files, bot_ids: r.botIds, status: r.status, source: "bops", ...(r.version ? { version: r.version } : {}) },
        });
        if (made?.status === 201 && made.json.skill?.id) {
          noteLabelColumn(pid, [made.json.skill]);
          const id = made.json.skill.id;
          const at = made.json.skill.updated_at;
          const version = made.json.skill.current_version?.version ?? r.version ?? "";
          const sentAs = hasColumn(made.json.skill) ? labelOfColumn(made.json.skill) : sentLabelOf(r);
          patchRef(wsId, r.kind, r.slug, (x) => ((x.remoteId = id), (x.remotePid = pid), (x.remoteAt = at), (x.remoteVersion = version), (x.remoteLabel = sentAs), (x.syncedAt = Date.now())));
          for (const sha of p.shas) pushed.add(sha);
          res.pushed++;
        } else {
          res.failed++;
          if (forNow(made?.status ?? null)) res.retry = true;
        }
        continue;
      }
      // Changed on Orgo: its updated_at isn't the one last seen. Changed here: since the two last agreed.
      const remoteAt = Date.parse(there.updated_at) || 0;
      const changedThere = there.updated_at !== r.remoteAt;
      // A move Orgo hasn't taken (movedHere) is a change here too, once Orgo keeps the column: it goes once.
      const changedHere = !r.syncedAt || r.updatedAt > r.syncedAt || (labelColumn.get(pid) === true && movedNow(wsId, pid, r));
      if (r.remoteId !== there.id || r.remotePid !== pid) patchRef(wsId, r.kind, r.slug, (x) => ((x.remoteId = there.id), (x.remotePid = pid)));
      // In step: Orgo's version as it is, for a sync that reads only what changed (one from before it kept this).
      if (!changedThere && !changedHere && r.remoteVersion !== (there.current_version?.version ?? "")) patchRef(wsId, r.kind, r.slug, (x) => void (x.remoteVersion = there.current_version?.version ?? ""));
      if (changedThere && (!changedHere || remoteAt >= r.updatedAt)) {
        if (await pull(wsId, pid, there, r)) {
          res.pulled++;
          // A move made here that the pull kept (Orgo hadn't moved it): to Orgo's column now.
          const now = findRef(wsId, r.kind, r.slug);
          if (now && labelColumn.get(pid) === true && movedNow(wsId, pid, now)) {
            const sent = await sendLabel(wsId, pid, there.id, now);
            if (!sent.ok) {
              res.failed++;
              if (forNow(sent.status)) res.retry = true;
            }
          }
        } else res.failed++;
      } else if (changedHere) {
        // Its label too, where Orgo keeps it in a column (labelColumn): a move goes at once, without a version.
        const withLabelColumn = labelColumn.get(pid) === true;
        let p = await skillsCall<{ skill?: RemoteSkill }>(pid, `/${encodeURIComponent(there.id)}`, { method: "PATCH", body: { name: r.name, description: r.description, bot_ids: r.botIds, status: r.status, ...(withLabelColumn ? { label: columnLabel(r) } : {}) } });
        const v = r.version && there.current_version?.version !== r.version ? payloadOf(wsId, r) : null;
        // The label Orgo's SKILL.md has from now on: the one a version sent carries.
        let sentLabel: string | undefined = withLabelColumn && p?.status === 200 ? sentLabelOf(r) : undefined;
        if (!withLabelColumn && p?.status === 200 && hasColumn(p.json.skill)) {
          // Its answer says Orgo keeps the column, which nothing this run read said yet (a restart, and a list of
          // only what changed with nothing in it): the label goes too, now, else Orgo's column would take it back.
          noteLabelColumn(pid, [p.json.skill]);
          if (sameLabel(labelOfColumn(p.json.skill), sentLabelOf(r))) sentLabel = sentLabelOf(r);
          else {
            const q = await skillsCall<{ skill?: RemoteSkill }>(pid, `/${encodeURIComponent(there.id)}`, { method: "PATCH", body: { label: columnLabel(r) } });
            if (q?.status === 200) {
              p = q;
              sentLabel = sentLabelOf(r);
            } else {
              res.failed++;
              if (forNow(q?.status ?? null)) res.retry = true;
            }
          }
        }
        if (v) {
          const sentV = await skillsCall(pid, `/${encodeURIComponent(there.id)}/versions`, { method: "POST", body: { body: v.body, files: v.files, version: r.version } });
          if (sentV && sentV.status < 300) {
            for (const sha of v.shas) pushed.add(sha);
            sentLabel = sentLabelOf(r);
          }
        }
        if (p?.status === 200) {
          // What Orgo says now (after the version too), as last seen.
          const now = v ? await skillsCall<{ skills?: RemoteSkill[] }>(pid, "") : null;
          const after = now?.json.skills?.find((x) => x.id === there.id);
          const at = after?.updated_at ?? p.json.skill?.updated_at ?? new Date().toISOString();
          const version = after?.current_version?.version ?? (v ? r.version : (p.json.skill?.current_version?.version ?? there.current_version?.version)) ?? "";
          patchRef(wsId, r.kind, r.slug, (x) => ((x.remoteAt = at), (x.remoteVersion = version), (x.remoteLabel = sentLabel ?? x.remoteLabel), (x.syncedAt = Date.now())));
          res.pushed++;
        } else if (p?.status === 404) {
          // Gone from Orgo with no record of it (an orgo-web from before the record): changed here since,
          // so it goes back to Orgo as a new one at the next try.
          patchRef(wsId, r.kind, r.slug, (x) => ((x.remoteId = undefined), (x.remotePid = undefined), (x.remoteAt = undefined), (x.remoteVersion = undefined), (x.remoteLabel = undefined), (x.syncedAt = undefined)));
          res.retry = true;
        } else {
          res.failed++;
          if (forNow(p?.status ?? null)) res.retry = true;
        }
      }
    } catch (e) {
      res.failed++;
      console.warn(`[skills] sync ${r.slug}: ${(e as Error).message}`);
    }
  }
  // Only on Orgo: brought here.
  for (const x of remote) {
    if (refsOf(wsId).some((r) => r.remoteId === x.id || (r.slug === x.slug && r.kind === localKind(x.type)))) continue;
    // Gone from this Mac since the list was read (deleted meanwhile): not brought back.
    if (deletes.waiting(wsId).some((e) => e.item.pid === pid && (e.item.remoteId === x.id || (e.item.slug === x.slug && e.item.kind === localKind(x.type))))) continue;
    if (await pull(wsId, pid, x)) res.pulled++;
    else res.failed++;
  }
  // Every skill went both ways: the next sync reads only what changed after this one's read.
  if (!res.retry && !res.failed && typeof got.json.at === "string") keepSince(wsId, pid, got.json.at);
  // Script approvals: this Mac's go once their skills are there (one Orgo can't place yet goes again once
  // a sync sent a file with that content), and the person's own made elsewhere come here.
  if (!(await flushApprovals(wsId, pushed))) res.retry = true;
  await pullApprovals(wsId, pid).catch((e: Error) => console.warn(`[skills] approvals from Orgo: ${e.message}`));
  if (!(await syncLabelInfo(wsId, pid).catch(() => false))) res.retry = true;
  return res;
}

/** One call to orgo-web's skill-labels routes for a project (same key and scopes as the skills routes; `path` "/rename" for a rename). Null when Orgo didn't answer. */
async function labelsCall(projectId: string, init: { method?: "GET" | "PUT" | "POST"; body?: unknown; path?: string } = {}) {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  const { path = "", ...rest } = init;
  return callOrgo<{ labels?: unknown; moved?: number; label?: string | null }>(key, `/api/projects/${encodeURIComponent(projectId)}/skill-labels${path}`, { ...rest, timeoutMs: 20_000 });
}

/** orgo-web's rows as kept here: a name and an about line each, in order, labels cleaned, one each. */
function cleanInfo(v: unknown): SkillLabelInfo[] | null {
  if (!Array.isArray(v)) return null;
  const out: SkillLabelInfo[] = [];
  for (const x of v as { name?: unknown; about?: unknown; position?: unknown }[]) {
    if (!x || typeof x.name !== "string" || !x.name.trim()) continue;
    const name = cleanLabel(x.name);
    if (out.some((y) => sameLabel(y.name, name))) continue;
    out.push({ name, about: cut(oneLine(typeof x.about === "string" ? x.about : ""), LABEL_ABOUT_MAX), position: typeof x.position === "number" && Number.isFinite(x.position) ? x.position : out.length });
  }
  return out;
}

/**
 * What the owner wrote about the workspace's labels, in step with orgo-web's skill_labels: changed here and not
 * sent (Workspace.skillLabelInfoUnsent), the whole set goes (PUT replaces Orgo's); else Orgo's comes here (GET).
 * An Orgo without the route keeps it on this Mac. False when Orgo didn't take it for now (tried again later).
 */
async function syncLabelInfo(wsId: string, pid: string): Promise<boolean> {
  if (labelRoutes.get(pid) === false) return true;
  const w = workspaceById(wsId);
  if (!w) return true;
  const missing = (status: number | null) => status === 404 || status === 405;
  if (w.skillLabelInfoUnsent) {
    const sent = w.skillLabelInfo ?? [];
    const r = await labelsCall(pid, { method: "PUT", body: { labels: sent.map((x) => ({ name: x.name, about: x.about, position: x.position })) } });
    const status = r?.status ?? null;
    if (missing(status)) {
      labelRoutes.set(pid, false);
      return true;
    }
    if (status === null || status >= 300) return !forNow(status);
    labelRoutes.set(pid, true);
    update((s) => {
      const x = s.workspaces?.find((y) => y.id === wsId);
      // Changed again meanwhile: that goes with the next sync.
      if (x && JSON.stringify(x.skillLabelInfo ?? []) === JSON.stringify(sent)) delete x.skillLabelInfoUnsent;
    });
    return true;
  }
  const r = await labelsCall(pid);
  const status = r?.status ?? null;
  if (missing(status)) {
    labelRoutes.set(pid, false);
    return true;
  }
  if (status !== 200) return !forNow(status);
  labelRoutes.set(pid, true);
  const rows = cleanInfo(r!.json.labels);
  if (rows && JSON.stringify(rows) !== JSON.stringify(w.skillLabelInfo ?? []))
    update((s) => {
      const x = s.workspaces?.find((y) => y.id === wsId);
      if (x && !x.skillLabelInfoUnsent) x.skillLabelInfo = rows;
    });
  return true;
}

type ExportFile = { content?: string; url?: string; sha256?: string; executable?: boolean };

/**
 * A file of Orgo's export as it was stored: its text inline, or its bytes from `url` (a short presigned GET,
 * no key sent: orgo-web gives one for every binary file and for large text). Checked against its sha256;
 * null when it can't be fetched or doesn't match, so nothing half there is ever written.
 */
async function exportedFile(path: string, f: ExportFile): Promise<{ path: string; content: string | null; data?: Buffer; executable: boolean } | null> {
  let bytes: Buffer;
  if (typeof f.content === "string") bytes = Buffer.from(f.content, "utf8");
  else if (typeof f.url === "string" && /^https?:\/\//.test(f.url)) {
    const res = await fetch(f.url, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
    if (!res?.ok) return null;
    bytes = Buffer.from(await res.arrayBuffer());
  } else return null;
  if (f.sha256 && sha256Hex(bytes) !== f.sha256) return null;
  const text = typeof f.content === "string" ? f.content : textOf(path, bytes);
  return text !== null ? { path, content: text, executable: !!f.executable } : { path, content: null, data: bytes, executable: !!f.executable };
}

/** Orgo's copy of a skill (its export: SKILL.md and every file) written here, as `into` or as a new one. */
async function pull(wsId: string, pid: string, x: RemoteSkill, into?: SkillRef): Promise<boolean> {
  const ex = await skillsCall<{ files?: Record<string, ExportFile>; version?: string }>(pid, `/${encodeURIComponent(x.id)}/export`);
  if (!ex || ex.status !== 200 || !ex.json.files) return false;
  const md = ex.json.files["SKILL.md"]?.content ?? "";
  const parsed = parseSkillMd(md);
  if (!parsed.ok) return false;
  const got = await Promise.all(
    Object.entries(ex.json.files)
      .filter(([p]) => p !== "SKILL.md")
      .map(([path, f]) => exportedFile(path, f)),
  );
  if (got.some((f) => f === null)) {
    console.warn(`[skills] bringing ${x.slug} from Orgo: a file couldn't be fetched or didn't match its sha256`);
    return false;
  }
  const files = got as NonNullable<(typeof got)[number]>[];
  const kind = localKind(x.type);
  const said = ex.json.version ?? x.current_version?.version;
  // Only a version-shaped one names a folder here.
  const version = isVersion(said) ? said : undefined;
  // Its label as Orgo's SKILL.md has it (none there: it keeps the one it has here), or, from an Orgo that keeps
  // the label in its own column (labelColumn), that one, whatever its SKILL.md says. The same one Orgo had when
  // the two last agreed: Orgo didn't move it, so a move made here since (which Orgo hasn't taken yet: a PATCH
  // or a version still to go) is kept, in its folder's SKILL.md too, and goes to Orgo after.
  const column = hasColumn(x);
  const pulledLabel = column ? labelOfColumn(x) : labelOf(parsed.frontmatter);
  try {
    if (into) {
      // A suggestion here is none in Orgo's copy, nor in its folder's SKILL.md.
      const pulledAs = pulledLabel ?? UNSORTED;
      const unmoved = into.remoteLabel !== undefined && sameLabel(pulledAs, into.remoteLabel);
      const mine = suggested(into) ? undefined : into.label;
      const keep = unmoved && !!mine && !sameLabel(pulledAs, mine) ? mine : column && !sameLabel(pulledAs, labelOf(parsed.frontmatter) ?? UNSORTED) ? pulledAs : undefined;
      writeTree(skillDir(wsId, kind, into.slug)!, keep ? renderSkillMd(withLabel(parsed.frontmatter ?? {}, keep), parsed.body) : md, files);
      if (version) writeTree(versionDir(wsId, kind, into.slug, version)!, md, files);
      // Moved on Orgo (another Mac, orgo.ai): that label, the skill's own from now on (Unsorted: none).
      const label = (column || pulledLabel) && !unmoved ? knownLabel(wsId, pulledAs) : undefined;
      patchRef(wsId, kind, into.slug, (r) => {
        r.name = x.name;
        r.description = x.description ?? r.description;
        if (label) {
          const kept = keptLabel(label);
          if (kept) r.label = kept;
          else delete r.label;
          r.labelBy = "skill";
        }
        r.botIds = x.bot_ids ?? r.botIds;
        r.status = x.status === "published" ? "published" : "draft";
        if (version) {
          r.version = version;
          if (!r.versions?.some((v) => v.version === version)) r.versions = [...(r.versions ?? []), { version, at: Date.now(), sha256: bundleSha(md, files.map((f) => ({ path: f.path, sha256: sha256Hex(fileBytes(f)), executable: f.executable }))) }];
        }
        r.remoteId = x.id;
        r.remotePid = pid;
        r.remoteAt = x.updated_at;
        r.remoteVersion = said ?? "";
        r.remoteLabel = column ? pulledAs : pulledLabel;
        r.updatedAt = Date.parse(x.updated_at) || Date.now();
        r.syncedAt = Math.max(Date.now(), r.updatedAt);
      });
      return true;
    }
    const { ref } = createSkill(wsId, {
      kind,
      name: x.name,
      description: x.description ?? x.name,
      body: parsed.body,
      ...(column ? { label: pulledLabel } : {}),
      frontmatter: { ...(parsed.frontmatter ?? {}), name: x.slug },
      files,
      botIds: x.bot_ids ?? [],
      source: "orgo",
      status: x.status === "published" ? "published" : "draft",
    });
    patchRef(wsId, kind, ref.slug, (r) => {
      r.remoteId = x.id;
      r.remotePid = pid;
      r.remoteAt = x.updated_at;
      r.remoteVersion = said ?? "";
      r.remoteLabel = pulledLabel;
      r.updatedAt = Date.parse(x.updated_at) || r.updatedAt;
      r.syncedAt = Math.max(Date.now(), r.updatedAt);
    });
    return true;
  } catch (e) {
    console.warn(`[skills] bringing ${x.slug} from Orgo: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Sync a workspace a moment after a change here (several changes in a row are one sync), or after a
 * backoff once `tries` syncs in a row didn't all go (1 minute, doubling to 30): a change meanwhile goes
 * at once.
 */
export function queueSync(wsId: string, tries = 0) {
  const pid = workspaceById(wsId)?.orgoProjectId;
  if (!pid || routes.get(pid) === false || onRunner()) return;
  const timers = (g.bopsSkillsSync ??= new Map());
  const counts = (g.bopsSkillsTries ??= new Map());
  if (tries) counts.set(wsId, tries);
  else if (timers.has(wsId) && (counts.get(wsId) ?? 0) > 0) counts.delete(wsId);
  clearTimeout(timers.get(wsId));
  const t = setTimeout(
    () => {
      timers.delete(wsId);
      void syncSkills(wsId).catch((e: Error) => console.warn(`[skills] sync: ${e.message}`));
    },
    tries ? Math.min(DELETE_RETRY_MS * 2 ** (tries - 1), DELETE_RETRY_MAX_MS) : 1500,
  );
  t.unref?.();
  timers.set(wsId, t);
}

/** Whether Orgo has the skills routes for this project, as last seen (undefined: not asked yet). */
export const skillsRoutesSeen = (projectId: string) => routes.get(projectId);

/**
 * A deleted workspace's skills and apps go from this Mac (remove.ts deleteWorkspace, while it's still
 * listed, so its folder is found): its folder (workspaces/<project or workspace id>, with every skill's
 * files, versions and the sync's marks), its deletes, label renames and approvals still to send (Orgo's copies went with
 * its project), and a sync waiting for it.
 */
export function dropWorkspaceSkills(wsId: string) {
  const timers = g.bopsSkillsSync;
  clearTimeout(timers?.get(wsId));
  timers?.delete(wsId);
  g.bopsSkillsTries?.delete(wsId);
  deletes.done(deletes.waiting(wsId).map((e) => e.id));
  renamesOut.done(renamesOut.waiting(wsId).map((e) => e.id));
  const approvals = approvalsOut.waiting(wsId).map((e) => e.id);
  approvalsOut.done(approvals);
  for (const id of approvals) parked.delete(id);
  if (wsId === MAIN_WORKSPACE) return;
  const dir = workspaceDir(wsId);
  if (dir) rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
}
