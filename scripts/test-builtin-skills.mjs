// Tests for Bops' own skills (lib/builtin-skills.ts): their shape (slugs as a skill's folder takes them,
// names and descriptions that fit the line a prompt lists, every one under APPS_LABEL, a label of
// BUILTIN_LABELS), each one as a SKILL.md folder that Bops' own checks take as it is (no secret, no
// warning, the same name, slug and description back), and their words: every `ingot` subcommand a body
// names is one the command has, every tool is a real one (the chat tools work_on_app, deploy_app and
// read_skill, and Ingot's MCP tools) with only its own arguments, every other skill a body points to is
// one of them, no local Ingot server (no 127.0.0.1:7979, no /etc/ingot), git only by ingot git-url into a clone
// beside the working folder, every repo a command takes named in full (<workspace>/<name>, as a computer may work for
// more than one workspace), no author a computer's commit can't have (Ingot names those after its token), an app's
// source an Ingot repo (never a git repo), short bodies, and no dashes as punctuation.
//
// Pure: nothing is written, started or called.
// Usage: node --conditions=react-server scripts/test-builtin-skills.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
});

const { BUILTIN_LABELS, BUILTIN_SKILLS } = await import(`${root}/lib/builtin-skills.ts`);
const { APPS_LABEL, SKILL_LABEL_MAX, cleanLabel, isUnsorted } = await import(`${root}/lib/skill-labels.ts`);
const { BUNDLE_LIMITS, SLUG_RE, checkFolder, isScript, renderSkillMd } = await import(`${root}/lib/server/skill-bundle.ts`);

let failures = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

/** The line a bot's prompt lists a skill on is cut at this many characters (workspace-skills.ts NOTE_LINE_MAX). */
const NOTE_LINE_MAX = 220;
/** About 60 lines: short enough to follow without guessing. */
const BODY_LINES_MAX = 60;
/** The `ingot` command's subcommands (ingot/cmd/ingot: repo.go repoCommands, and main.go). */
const INGOT_SUBCOMMANDS = new Set(["clone", "status", "diff", "commit", "pull", "log", "show", "checkout", "export", "mcp", "serve", "credential", "setup-git", "git-url"]);
/** The ones a bot working on an app uses, which the skills between them all teach. */
const TAUGHT = ["clone", "status", "diff", "commit", "pull", "log", "show", "checkout", "export", "git-url"];
/** Each tool a body may name, with its arguments: Bops' chat tools, then Ingot's (ingot/internal/mcp/hosted.go). */
const TOOLS = {
  work_on_app: ["app", "name", "change", "deploy"],
  deploy_app: ["app", "at"],
  read_skill: ["name", "file"],
  repo_status: ["dir"],
  repo_diff: ["dir", "path"],
  repo_commit: ["dir", "message"],
  repo_pull: ["dir"],
  repo_log: ["name", "ref", "at", "path", "limit", "before"],
  repo_show: ["name", "id"],
  repo_file: ["name", "path", "at", "ref"],
  repo_tree: ["name", "at", "ref", "path"],
};
/** Words with an underscore that aren't tools. */
const NOT_TOOLS = new Set(["node_modules", "http_code"]);

/** Everything a bot reads of a skill: its name, description, body and files. */
const textsOf = (s) => [
  ["name", s.name],
  ["description", s.description],
  ...(s.about ? [["about", s.about]] : []),
  ["body", s.body],
  ...(s.files ?? []).map((f) => [f.path, f.content]),
];
const everyText = () => [...BUILTIN_LABELS.flatMap((l) => [[`label ${l.label}`, l.label], [`about ${l.label}`, l.about]]), ...BUILTIN_SKILLS.flatMap((s) => textsOf(s).map(([w, t]) => [`${s.slug} ${w}`, t]))];
/** The line and its number, for a failure that names where. */
const lineOf = (text, index) => {
  const n = text.slice(0, index).split("\n").length;
  return `line ${n}: ${text.split("\n")[n - 1].trim()}`;
};

check("The labels: APPS_LABEL among them, each one clean, short, its own and with a line on what it's for", () => {
  assert.ok(BUILTIN_LABELS.length >= 1);
  assert.ok(BUILTIN_LABELS.some((l) => l.label === APPS_LABEL));
  const seen = new Set();
  for (const l of BUILTIN_LABELS) {
    assert.equal(cleanLabel(l.label), l.label, `${l.label} is kept as it's written`);
    assert.ok(l.label.length <= SKILL_LABEL_MAX, l.label);
    assert.ok(!isUnsorted(l.label), `${l.label} is Unsorted`);
    assert.ok(!seen.has(l.label.toLowerCase()), `${l.label} twice`);
    seen.add(l.label.toLowerCase());
    assert.ok(l.about.trim().length > 20 && l.about.length < NOTE_LINE_MAX, `${l.label}: about is ${l.about.length} characters`);
  }
});

check("The skills: seven, each with a slug a skill's folder takes, its own name, a short description, APPS_LABEL and a body", () => {
  assert.equal(BUILTIN_SKILLS.length, 7);
  const slugs = new Set();
  const names = new Set();
  for (const s of BUILTIN_SKILLS) {
    assert.match(s.slug, SLUG_RE, s.slug);
    assert.ok(s.slug.length <= BUNDLE_LIMITS.slug, s.slug);
    assert.ok(s.slug.startsWith("bops-"), `${s.slug} starts with bops-`);
    assert.ok(!slugs.has(s.slug), `${s.slug} twice`);
    slugs.add(s.slug);
    assert.ok(s.name.trim() && s.name === s.name.trim() && s.name.length <= 120, s.name);
    assert.ok(!names.has(s.name.toLowerCase()), `${s.name} twice`);
    names.add(s.name.toLowerCase());
    assert.ok(s.description.trim().length > 40, `${s.slug}: a description that says when to read it`);
    assert.ok(s.description.length < 220, `${s.slug}: description is ${s.description.length} characters`);
    assert.ok(`${s.name}: ${s.description}`.length <= NOTE_LINE_MAX, `${s.slug}: its line in a prompt is ${`${s.name}: ${s.description}`.length} characters, so it would be cut`);
    assert.equal(s.label, APPS_LABEL, s.slug);
    assert.ok(BUILTIN_LABELS.some((l) => l.label === s.label), `${s.slug}: its label is one of BUILTIN_LABELS`);
    assert.equal(typeof s.body, "string");
    if (s.about !== undefined) assert.ok(typeof s.about === "string" && s.about.trim(), `${s.slug}: about`);
  }
});

check("Each body starts with its name as the heading, and is about 60 lines at most", () => {
  for (const s of BUILTIN_SKILLS) {
    assert.ok(s.body.startsWith(`# ${s.name}\n\n`), `${s.slug} starts with "# ${s.name}"`);
    const lines = s.body.split("\n").length;
    assert.ok(lines <= BODY_LINES_MAX, `${s.slug} is ${lines} lines`);
    assert.ok(!/\n\n\n/.test(s.body) && !/[ \t]$/m.test(s.body), `${s.slug}: no runs of blank lines or trailing spaces`);
    const fences = (s.body.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, `${s.slug}: every code block is closed`);
  }
});

check("Their files: text, each path once, none a script (a script waits for approval, so a bot couldn't read it)", () => {
  for (const s of BUILTIN_SKILLS) {
    const paths = new Set();
    for (const f of s.files ?? []) {
      assert.equal(typeof f.content, "string", `${s.slug} ${f.path}`);
      assert.ok(!paths.has(f.path), `${s.slug} ${f.path} twice`);
      paths.add(f.path);
      assert.ok(!isScript({ path: f.path, content: f.content, executable: false }), `${s.slug} ${f.path} is a script`);
      assert.ok(f.content.endsWith("\n"), `${s.slug} ${f.path} ends with a line break`);
    }
  }
  // The JSON one is JSON.
  for (const s of BUILTIN_SKILLS) for (const f of s.files ?? []) if (f.path.endsWith(".json")) JSON.parse(f.content);
});

check("As a SKILL.md folder, each one passes Bops' own checks as it is: no secret, no warning, the same name, slug, description and body back", () => {
  for (const s of BUILTIN_SKILLS) {
    // The frontmatter a workspace's skill gets (workspace-skills.ts frontmatterOf), with its label.
    const md = renderSkillMd({ name: s.slug, description: s.description, label: s.label }, s.body);
    const folder = [{ path: "SKILL.md", content: md }, ...(s.files ?? [])].map((f) => ({ path: f.path, content: f.content, executable: false, size: Buffer.byteLength(f.content) }));
    const r = checkFolder(folder, { folderName: s.slug, strict: true });
    assert.ok(r.ok, `${s.slug}: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(r.skipped, [], s.slug);
    assert.deepEqual(r.warnings, [], s.slug);
    assert.equal(r.name, s.name);
    assert.equal(r.slugBase, s.slug);
    assert.equal(r.description, s.description);
    assert.equal(r.frontmatter.label, s.label);
    assert.equal(r.body.trim(), s.body.trim());
    assert.deepEqual(
      r.files.map((f) => f.path),
      (s.files ?? []).map((f) => f.path).sort(),
    );
  }
});

check("Every ingot subcommand named is one the command has, and between them they teach every one a bot uses", () => {
  const found = new Set();
  for (const [where, text] of everyText()) {
    for (const m of text.matchAll(/\bingot\s+([a-z][a-z-]*)/g)) {
      assert.ok(INGOT_SUBCOMMANDS.has(m[1]), `${where}: "ingot ${m[1]}" isn't a subcommand (${lineOf(text, m.index)})`);
      found.add(m[1]);
    }
    // `ingot` with a flag right after it is no subcommand either.
    for (const m of text.matchAll(/\bingot\s+-/g)) assert.fail(`${where}: ingot with no subcommand (${lineOf(text, m.index)})`);
  }
  for (const c of TAUGHT) assert.ok(found.has(c), `no skill shows ingot ${c}`);
});

check("Every tool named is a real one (the chat tools work_on_app, deploy_app, read_skill, or Ingot's), with only its own arguments", () => {
  const named = new Set();
  for (const [where, text] of everyText()) {
    for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      if (NOT_TOOLS.has(m[0])) continue;
      assert.ok(m[0] in TOOLS, `${where}: ${m[0]} is no tool (${lineOf(text, m.index)})`);
      named.add(m[0]);
    }
    // "repo_diff (dir, path)": what's in the brackets is that tool's arguments.
    for (const m of text.matchAll(/\b(repo_[a-z]+) \(([^)]*)\)/g))
      for (const arg of m[2].split(/,\s*|\s+and\s+/)) assert.ok(TOOLS[m[1]].includes(arg.trim()), `${where}: ${m[1]} has no argument "${arg.trim()}" (${lineOf(text, m.index)})`);
    // "deploy_app with at set to ...": the word after with is one of its arguments.
    for (const m of text.matchAll(/\b(work_on_app|deploy_app|read_skill) with ([a-z_]+)/g)) assert.ok(TOOLS[m[1]].includes(m[2]), `${where}: ${m[1]} has no argument "${m[2]}" (${lineOf(text, m.index)})`);
  }
  for (const t of ["work_on_app", "deploy_app", "read_skill", "repo_commit", "repo_pull", "repo_log", "repo_show"]) assert.ok(named.has(t), `no skill names ${t}`);
});

check("A skill a body points to is another of them", () => {
  const names = new Set(BUILTIN_SKILLS.map((s) => s.name));
  let pointed = 0;
  for (const s of BUILTIN_SKILLS)
    for (const m of s.body.matchAll(/the skill "([^"]+)"/g)) {
      assert.ok(names.has(m[1]), `${s.slug}: there's no skill "${m[1]}"`);
      assert.notEqual(m[1], s.name, `${s.slug} points to itself`);
      pointed++;
    }
  assert.ok(pointed >= 4);
});

check("No local Ingot server: no 127.0.0.1:7979 or /etc/ingot, git only by ingot git-url, and only the app's own addresses", () => {
  for (const [where, text] of everyText()) {
    for (const m of text.matchAll(/:7979|\/etc\/ingot|\blocal Ingot\b/gi)) assert.fail(`${where}: ${m[0]} (${lineOf(text, m.index)})`);
    // 127.0.0.1 is only the app's own: checked on its port 3000, or in "never 127.0.0.1 or localhost alone".
    for (const m of text.matchAll(/127\.0\.0\.1(\S*)/g)) assert.ok(m[1] === "" || /^:3000\/`?[.,]?$/.test(m[1]), `${where}: 127.0.0.1${m[1]} (${lineOf(text, m.index)})`);
    // A repo's git address comes from ingot git-url, never written out, and git signs in with no token in sight.
    for (const m of text.matchAll(/`git clone[^`]*`/g)) assert.equal(m[0], '`git clone "$(ingot git-url <workspace>/<name>)" /workspace/apps/<name>-git`', `${where} (${lineOf(text, m.index)})`);
    for (const m of text.matchAll(/\/git\/|[a-z>]\.git\b|credential\.|password=/g)) assert.fail(`${where}: ${m[0]} (${lineOf(text, m.index)})`);
  }
  // Where an app's folder is (ingot.ts APPS_DIR), and its address (orgo-web's public URLs).
  const all = BUILTIN_SKILLS.map((s) => s.body).join("\n");
  for (const m of all.matchAll(/\/workspace\/[a-z]+\/\S*/g)) assert.match(m[0], /^\/workspace\/apps\/<name>(-git)?`?[.,:]?$/, m[0]);
  for (const m of all.matchAll(/https?:\/\/\S+/g)) assert.match(m[0], /^(https:\/\/<name>\.orgo\.dev\)?[.,]?|http:\/\/127\.0\.0\.1:3000\/`?[.,]?|http:\/\/localhost:3000(\/api\/auth\/callback\/google)?\/?`?[.,]?)$/, m[0]);
});

check("Every repo a command takes is named in full, and no commit is said to be from an author Ingot doesn't keep", () => {
  let named = 0;
  for (const [where, text] of everyText()) {
    for (const m of text.matchAll(/\bingot (?:clone|git-url) (\S+?)\)?["`\s]|--repo ([^\s:,`]+)/g)) {
      assert.equal(m[1] ?? m[2], "<workspace>/<name>", `${where}: ${m[0].trim()} (${lineOf(text, m.index)})`);
      named++;
    }
    for (const m of text.matchAll(/INGOT_AUTHOR|\bas (?:you|yourself)\b/g)) assert.fail(`${where}: ${m[0]} (${lineOf(text, m.index)})`);
  }
  assert.ok(named >= 4, `${named} named`);
});

check("An app's source is an Ingot repo, never a git repo; the memory is Knowledge, never Orbit", () => {
  for (const [where, text] of everyText()) {
    assert.ok(!/\bgit repo/i.test(text), `${where} says git repo`);
    assert.ok(!/\bOrbit\b/.test(text), `${where} says Orbit`);
  }
});

check("No dashes as punctuation: no en or em dash, no spaced hyphen, no list made of dashes", () => {
  for (const [where, text] of everyText()) {
    for (const m of text.matchAll(/[–—]|\s-{1,2}\s|^\s*[-*] /gm)) assert.fail(`${where}: a dash (${lineOf(text, m.index)})`);
  }
});

check("The commands' own words, as Ingot prints them (ingot/internal/workdir ops.go, gitbridge)", () => {
  const several = BUILTIN_SKILLS.find((s) => s.slug === "bops-several-people-pushing").body;
  for (const words of ["<<<<<<< yours", "=======", ">>>>>>> theirs", "Run ingot pull to bring in the new changes, then ingot commit again.", "main has new changesets since you fetched. Run git pull --no-rebase, then git push again.", "ingot setup-git", 'git clone "$(ingot git-url <workspace>/<name>)" /workspace/apps/<name>-git', "never inside it", "git pull --no-rebase", "git push origin HEAD:main", ".theirs"])
    assert.ok(several.includes(words), words);
  const work = BUILTIN_SKILLS.find((s) => s.slug === "bops-work-on-an-app").body;
  // A repo's name in full (a computer may work for more than one workspace), and a command that's already signed in.
  for (const words of ["<workspace>/<name>", "name it in full", "already signed in", "never paste or print a token", "never inside it"]) assert.ok(work.includes(words), words);
  for (const ignored of [".ingot/", ".git/", "node_modules/", ".DS_Store", "__pycache__/", "*.pyc", ".next/", "dist/", "build/", ".env*"]) assert.ok(work.includes(ignored), `the defaults Ingot ignores: ${ignored}`);
  const web = BUILTIN_SKILLS.find((s) => s.slug === "bops-web-app-that-deploys").body;
  // Detection in its order (orgo-web lib/deploys/guest-runner.ts orgo_detect).
  const order = ["compose.yaml", "Dockerfile", "package.json", "requirements.txt", "index.html"].map((f) => web.indexOf(f));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `detection in order: ${order}`);
  for (const words of ["$PORT", "0.0.0.0", "orgo.json", '"framework"', '"install"', '"build"', '"start"', "30 minutes", "DATABASE_URL", "60 seconds"]) assert.ok(web.includes(words), words);
});

console.log(`builtin skills: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
