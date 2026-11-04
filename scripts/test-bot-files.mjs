// Tests for files the user adds for a bot (lib/server/bot-files.ts, lib/added-files.ts): on its computer through
// Orgo's file uploads (the computer woken and the name claimed on its Desktop first, the first one free; a link to
// put it at; the bytes to it as they come; the computer touched again after a long upload; then Orgo has it fetch it
// into place), refused with words for the user (too big, empty, a bot on the Mac, no computer, no hours or credit,
// Orgo turning it down, the computer not waking, fewer or more bytes than it said) with the claimed name let go,
// and named safely (bytes, not characters). Also what the bot is told about them (filesNote) and how sizes read.
// In a workspace shared with the user: the owner's computer Bops Cloud names (sharedTarget), never the user's own
// bot's, with the user's own key; Bops Cloud's refusals in its words; Orgo's said plainly and as theirs in their role
// (only the owner and Admins add files, out of an Admin's reach, a computer the owner keeps them off, a locked one, a key
// for another workspace). And the routes: POST /api/bots/files in a shared workspace asks Bops Cloud, never the user's
// own bot of that id; a message naming a file that isn't here anymore is refused, never sent without it, from the
// user's own chat and from a shared workspace's (the words not kept, `unsent`).
//
// The store, Orgo and storage are fakes (below). The people and ids are made up.
// Usage: node --conditions=react-server scripts/test-bot-files.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = {
  store: ["getState", "id", "bot", "chat", "react"],
  screens: ["workComputer"],
  "free-hours": ["freeHoursUsed", "computerOutOfCredit"],
  // What the routes (below) reach besides: the shared workspace open, the chat, the window's own calls.
  shared: ["sharedOpen", "sharedRole", "sharedFileTarget", "actShared", "closeShared", "listShared", "olderShared", "openShared"],
  ready: ["notReady"],
  "ui-token": ["fromBopsWindow"],
  chat: ["handleMessage"],
  "cloud-chat": ["sendsThroughCloud", "sendThroughCloud"],
  uploads: ["uploadPath"],
  remove: ["clearChat", "deletePicked", "removeMessages"],
};
const ORGO = ["apiKey", "callOrgo"];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
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
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (name === "orgo")
      return {
        format: "module",
        shortCircuit: true,
        source:
          ORGO.map((n) => `export const ${n} = (...a) => globalThis.__fake.orgo.${n}(...a);`).join("\n") +
          `\nexport const orgo = { bash: (...a) => globalThis.__fake.orgo.bash(...a) };` +
          unfaked(name, url, [...ORGO, "orgo"]),
      };
    if (!name || !FAKES[name]) return next(url, context);
    // (Every faked module's name and export is a plain word, as written above.)
    const at = name.replace(/-/g, "_");
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake.${at}.${n}(...a);`).join("\n") + unfaked(name, url, FAKES[name]) };
  },
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 6).join("\n  ") ?? e.message}`);
  }
}

// The computer's home: the claim and clean-up scripts really run, in a shell, with HOME here.
const home = mkdtempSync(join(tmpdir(), "bops-bot-files-"));
const desktop = join(home, "Desktop");
const BOTS = {
  max: { id: "max", name: "Max", computerId: "pc_max", isMain: true },
  rex: { id: "rex", name: "Rex" }, // shares Max's computer
  mia: { id: "mia", name: "Mia", runsOn: "mac" },
  new: { id: "new", name: "Noa" }, // no computer yet
};
let n = 0;
let calls = [];
let puts = [];
const world = {};
const NO_HOURS = new Error("402 bops_free_hours");
let creditAsked = 0;
/** What the routes reached: Bops Cloud asked for a file's computer, acts sent, messages handled. */
const reached = { asked: [], acts: [], handled: [] };
globalThis.__fake = {
  store: {
    getState: () => ({ host: world.host, bots: Object.values(BOTS) }),
    id: (p) => `${p}_${++n}`,
    bot: (id) => BOTS[id],
    chat: (id) => (id === "bot:max" ? { id, kind: "bot", botIds: ["max"] } : undefined),
    react: () => {},
  },
  // `world.shared`: a workspace shared with the user open, with their role there and what Bops Cloud answers for a file.
  shared: {
    sharedOpen: () => !!world.shared,
    sharedRole: () => world.shared?.role ?? null,
    sharedFileTarget: async (botId, o) => (reached.asked.push([botId, !!o?.screen]), world.shared.target),
    actShared: async (act, key) => (reached.acts.push(act), { ok: true, key, macOn: true }),
  },
  ready: { notReady: () => null },
  ui_token: { fromBopsWindow: () => true },
  chat: { handleMessage: async (...a) => void reached.handled.push(a) },
  cloud_chat: { sendsThroughCloud: () => false, sendThroughCloud: async () => "here" },
  uploads: { uploadPath: () => null },
  screens: { workComputer: (b) => (b.id === "rex" ? BOTS.max : b) },
  free_hours: { freeHoursUsed: (e) => (e === NO_HOURS ? "Max's computer used its 10 hours this month." : undefined), computerOutOfCredit: () => void creditAsked++ },
  orgo: {
    apiKey: async () => "sk_test",
    callOrgo: async (key, path, opts) => {
      calls.push({ key, path, ...opts });
      return path === "/api/files/uploads" ? world.start : path === "/api/files/uploads/complete" ? world.complete : null;
    },
    bash: async (id, cmd) => {
      calls.push({ path: "bash", id, cmd });
      if (world.wake !== true) throw world.wake;
      try {
        return { output: execFileSync("sh", ["-c", cmd], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" }), exit_code: 0 };
      } catch (e) {
        return { output: String(e.stdout ?? ""), exit_code: e.status ?? 1 };
      }
    },
  },
};
globalThis.__bopsFilePut = async (url, body, size) => {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  const bytes = Buffer.concat(chunks);
  puts.push({ url, size, bytes });
  if (world.slow) world.now += 120_000;
  return world.put && bytes.length === size;
};
const realNow = Date.now;
Date.now = () => (world.now ?? realNow());

const { addFile, addFileTo, addedFile, AddFileError, filesGoTo, claimScript, sharedTarget } = await import(`${root}/lib/server/bot-files.ts`);
const { cleanFileName, fileSize, filesNote, isPicture } = await import(`${root}/lib/added-files.ts`);

const body = (text) => new Blob([text]).stream();
const reset = () => {
  calls = [];
  puts = [];
  rmSync(desktop, { recursive: true, force: true });
  Object.assign(world, { host: "cloud", put: true, wake: true, slow: false, now: undefined, shared: undefined });
  for (const k of Object.keys(reached)) reached[k] = [];
  world.start = { status: 200, json: { upload_url: "https://storage.example/put?sig=x", upload_token: "tok_1" } };
  world.complete = { status: 200, json: { ok: true, placedIn: "the desktop" } };
};
const onDesktop = () => (existsSync(desktop) ? readdirSync(desktop).sort() : []);
const refusal = async (p, status, words) => {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof AddFileError, `an AddFileError, not ${e}`);
    assert.equal(e.status, status);
    if (words) assert.match(e.message, words);
    return true;
  });
};

await check("a file goes on the bot's computer's Desktop: woken and its name claimed, then Orgo's uploads", async () => {
  reset();
  const f = await addFile(BOTS.max, "Q3 report.pdf", 11, body("hello world"));
  assert.deepEqual({ ...f, id: undefined }, { id: undefined, name: "Q3 report.pdf", size: 11, path: "~/Desktop/Q3 report.pdf", botId: "max", hostId: "max", hostName: "Max" });
  assert.equal(calls[0].path, "bash", "the computer first: woken, the name claimed");
  assert.deepEqual(onDesktop(), ["Q3 report.pdf"], "claimed there");
  const start = calls.find((c) => c.path === "/api/files/uploads");
  assert.deepEqual(start.body, { desktopId: "pc_max", filename: "Q3 report.pdf", size_bytes: 11 }, "no destPath: Orgo puts it on the Desktop");
  assert.equal(start.method, "POST");
  assert.equal(start.key, "sk_test");
  assert.equal(puts[0].url, "https://storage.example/put?sig=x");
  assert.equal(puts[0].bytes.toString(), "hello world", "every byte, as sent");
  assert.deepEqual(calls.find((c) => c.path === "/api/files/uploads/complete").body, { desktopId: "pc_max", upload_token: "tok_1" });
  assert.equal(calls.filter((c) => c.path === "bash").length, 1, "a quick upload isn't touched again");
  assert.deepEqual(addedFile(f.id), f, "kept for the message it goes with");
  assert.equal(addedFile("file_nope"), undefined, "only ones added here");
  assert.ok(!JSON.stringify(f).includes("tok_1") && !JSON.stringify(f).includes("sig="), "nothing of the link or its token");
});

await check("a name that's taken gets the next free one, so nothing there is replaced; odd names stay names", async () => {
  reset();
  const a = await addFile(BOTS.max, "notes.txt", 1, body("a"));
  const b = await addFile(BOTS.max, "notes.txt", 1, body("b"));
  const c = await addFile(BOTS.max, "notes.txt", 1, body("c"));
  assert.deepEqual([a.name, b.name, c.name], ["notes.txt", "notes (2).txt", "notes (3).txt"]);
  assert.equal(c.path, "~/Desktop/notes (3).txt");
  assert.deepEqual(calls.filter((x) => x.path === "/api/files/uploads").map((x) => x.body.filename), ["notes.txt", "notes (2).txt", "notes (3).txt"], "Orgo is given the claimed name");
  const odd = await addFile(BOTS.max, "it's $(touch PWNED) `id`.md", 1, body("x"));
  assert.equal(odd.name, "it's $(touch PWNED) `id`.md");
  assert.ok(!existsSync(join(home, "PWNED")), "nothing in a name runs");
  const plain = await addFile(BOTS.max, "Makefile", 1, body("x"));
  const again = await addFile(BOTS.max, "Makefile", 1, body("x"));
  assert.deepEqual([plain.name, again.name], ["Makefile", "Makefile (2)"]);
});

await check("a bot that shares the main bot's computer gets it there, named as that computer's", async () => {
  reset();
  const f = await addFile(BOTS.rex, "notes.txt", 2, body("hi"));
  assert.equal(calls.find((c) => c.path === "/api/files/uploads").body.desktopId, "pc_max");
  assert.deepEqual([f.botId, f.hostId, f.hostName], ["rex", "max", "Max"]);
});

await check("a bot that works on this Mac gets none (what it runs there can't open them), unless it's dropped on its computer's screen", async () => {
  reset();
  await refusal(addFile(BOTS.mia, "budget.xlsx", 5, body("12345")), 409, /Mia works on your Mac, where added files can't be opened yet\. Pictures still work\./);
  assert.equal(calls.length, 0, "nothing to Orgo");
  BOTS.mia.computerId = "pc_mia";
  const f = await addFile(BOTS.mia, "budget.xlsx", 5, body("12345"), { screen: true });
  assert.equal(f.hostId, "mia");
  delete BOTS.mia.computerId;
  world.host = "mac";
  assert.match(filesGoTo(BOTS.max).why, /work on this Mac here/, "and none at all when Bops runs on the Mac");
});

await check("too big, empty, nameless, or no computer: refused before anything goes", async () => {
  reset();
  await refusal(addFile(BOTS.max, "huge.iso", 3 * 1024 ** 3, body("x")), 413, /2 GB at most/);
  await refusal(addFile(BOTS.max, "empty.txt", 0, body("")), 400, /empty/);
  await refusal(addFile(BOTS.max, "a.txt", Number.NaN, body("x")), 400, /empty/);
  await refusal(addFile(BOTS.max, "../..", 1, body("x")), 400, /needs a name/);
  await refusal(addFile(BOTS.new, "a.txt", 1, body("x")), 409, /Noa has no computer yet/);
  assert.equal(calls.length, 0);
});

await check("a computer out of hours says so at once, before any byte goes; one that doesn't wake says that", async () => {
  reset();
  world.wake = NO_HOURS;
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 402, /used its 10 hours this month/);
  world.wake = new Error("asleep");
  await refusal(addFile(BOTS.rex, "a.txt", 1, body("x")), 503, /Max's computer didn't wake up/);
  assert.equal(puts.length, 0, "never uploaded");
  assert.ok(!calls.some((c) => c.path === "/api/files/uploads"), "never asked for a link");
});

await check("Orgo turning it down says so, with Orgo's words, and the claimed name is let go", async () => {
  reset();
  world.start = { status: 403, json: { error: "This computer is in another workspace." } };
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /Orgo didn't take the file\. Orgo said: This computer is in another workspace\./);
  assert.equal(puts.length, 0);
  assert.deepEqual(onDesktop(), [], "no empty file left");
  reset();
  world.start = { status: 200, json: { upload_url: "http://plain.example/put", upload_token: "t" } };
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /Orgo didn't take/, "only a signed https link");
});

await check("storage not taking it, or Orgo not placing it: each says which, and the claim is let go (never a real file)", async () => {
  reset();
  world.put = false;
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /didn't upload/);
  assert.ok(!calls.some((c) => c.path === "/api/files/uploads/complete"), "never finished");
  assert.deepEqual(onDesktop(), []);
  reset();
  world.complete = { status: 400, json: { error: "Desktop is not running. Start it, then finish the upload." } };
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /didn't reach Max's computer\. Orgo said: Desktop is not running/);
  reset();
  world.complete = null;
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /didn't reach Max's computer\.$/);
  // A file that's really there under that name is never taken away.
  reset();
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(desktop, "kept.txt"), "the bot's own work");
  world.put = false;
  await refusal(addFile(BOTS.max, "kept.txt", 1, body("x")), 502, /didn't upload/);
  assert.deepEqual(onDesktop(), ["kept.txt"]);
  assert.equal(readFileSync(join(desktop, "kept.txt"), "utf8"), "the bot's own work");
});

await check("a long upload touches the computer again before Orgo puts it in place (it may have gone to sleep)", async () => {
  reset();
  world.now = 1_000_000;
  world.slow = true;
  await addFile(BOTS.max, "big.bin", 3, body("abc"));
  const order = calls.map((c) => (c.path === "bash" ? (c.cmd === "true" ? "touch" : "claim") : c.path));
  assert.deepEqual(order, ["claim", "/api/files/uploads", "touch", "/api/files/uploads/complete"]);
  reset();
  world.now = 1_000_000;
  world.slow = true;
  const put = globalThis.__bopsFilePut;
  globalThis.__bopsFilePut = async (...a) => {
    const ok = await put(...a);
    world.wake = NO_HOURS;
    return ok;
  };
  await refusal(addFile(BOTS.max, "big.bin", 3, body("abc")), 402, /10 hours/);
  globalThis.__bopsFilePut = put;
  assert.ok(!calls.some((c) => c.path === "/api/files/uploads/complete"));
});

await check("the claim script: the first free name, made in one step; quotes and $() stay text", () => {
  const script = claimScript("a'b $(x).txt");
  assert.match(script, /set -C/);
  assert.match(script, /n='a'\\''b \$\(x\)\.txt'/);
});

await check("names: the last part only, no hidden files, no control characters, long ones cut by bytes between characters", () => {
  assert.equal(cleanFileName("../../etc/passwd"), "passwd");
  assert.equal(cleanFileName("C:\\Users\\a\\b.docx"), "b.docx");
  assert.equal(cleanFileName(".bashrc"), "bashrc");
  assert.equal(cleanFileName("..."), "");
  assert.equal(cleanFileName("a\u0000b\nc\u007f.txt"), "abc.txt");
  assert.equal(cleanFileName("  spaced name.pdf  "), "spaced name.pdf");
  // Never a space left at either end once the dots go, or once it's cut (Bops Cloud takes no such name on a member's message).
  assert.equal(cleanFileName(". notes.txt"), "notes.txt");
  assert.equal(cleanFileName(". . notes"), "notes");
  assert.equal(cleanFileName(`${"x".repeat(239)} ${"y".repeat(20)}`), "x".repeat(239));
  const long = cleanFileName(`${"x".repeat(300)}.tar.gz`);
  assert.ok(Buffer.byteLength(long) <= 240 && long.endsWith(".gz"), long);
  const jp = cleanFileName(`${"報告書".repeat(40)}.pdf`);
  assert.ok(Buffer.byteLength(jp) <= 240, `${Buffer.byteLength(jp)} bytes`);
  assert.ok(jp.endsWith(".pdf") && jp.startsWith("報告書"));
  const emoji = cleanFileName(`${"😀".repeat(80)}.txt`);
  assert.ok(Buffer.byteLength(emoji) <= 240 && emoji.endsWith(".txt"));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), "never half a character");
  assert.equal(cleanFileName("cafe\u0301.txt"), "café.txt", "composed (NFC)");
});

await check("pictures the model sees; other images are files", () => {
  for (const t of ["image/png", "image/jpeg", "image/webp", "image/gif"]) assert.ok(isPicture(t), t);
  for (const t of ["image/heic", "image/svg+xml", "image/tiff", "application/pdf", "text/csv", ""]) assert.ok(!isPicture(t), t);
});

await check("sizes read plainly", () => {
  assert.equal(fileSize(812), "812 bytes");
  assert.equal(fileSize(14 * 1024), "14 KB");
  assert.equal(fileSize(3.24 * 1024 ** 2), "3.2 MB");
  assert.equal(fileSize(1.1 * 1024 ** 3), "1.1 GB");
  assert.equal(fileSize(2 * 1024 ** 3), "2.0 GB");
});

await check("what the bot is told: on its own computer, to open them there; on another's, whose, and that it isn't its own", () => {
  const pc = [
    { id: "f1", name: "a.pdf", size: 2048, path: "~/Desktop/a.pdf", botId: "max", hostId: "max", hostName: "Max" },
    { id: "f2", name: "b.csv", size: 10, path: "~/Desktop/b.csv", botId: "max", hostId: "max", hostName: "Max" },
  ];
  assert.equal(filesNote(pc, "Alex", "max"), "[Alex added 2 files to your computer's Desktop: ~/Desktop/a.pdf (2 KB), ~/Desktop/b.csv (10 bytes). Open them there.]");
  assert.equal(filesNote(pc.slice(0, 1), "Alex", "max"), "[Alex added a file to your computer's Desktop: ~/Desktop/a.pdf (2 KB). Open it there.]");
  assert.equal(filesNote(pc.slice(0, 1), "Alex", "juno"), "[Alex added a file to Max's computer's Desktop: ~/Desktop/a.pdf (2 KB). It's on that computer, not this one.]", "a bot on another computer");
  assert.equal(filesNote(pc, "Alex", "mac"), "[Alex added 2 files to Max's computer's Desktop: ~/Desktop/a.pdf (2 KB), ~/Desktop/b.csv (10 bytes). They're on that computer, not this one.]", "a task on the Mac");
  assert.match(filesNote(pc, "Alex"), /to Max's computer's Desktop/, "not knowing who reads it: named");
  assert.equal(filesNote([], "Alex"), "");
});

/* ---------------- A workspace shared with the user ---------------- */

// Bops Cloud's answer for an Admin (cloud/members.ts filesIn): the owner's computer.
const OWNERS = { status: 200, json: { computerId: "pc_owner", botId: "boppy", hostId: "boppy", hostName: "Boppy" } };
const shared = (got) => async () => sharedTarget(got);
/** Their role in the shared workspace (bot-files.ts SharedAs): an Admin, whom Bops Cloud names a computer for; a Member, whose upload Orgo refuses. */
const ADMIN = { shared: { role: "admin" } };
const MEMBER = { shared: { role: "member" } };
/** An error as lib/server/orgo.ts throws it: its status and code. */
const orgoError = (status, code) => Object.assign(new Error(`Orgo POST /computers/pc_owner/bash → ${status}`), { status, ...(code ? { code } : {}) });

await check("in a shared workspace, an Admin adds a file on the owner's computer, with their own key", async () => {
  reset();
  // Their own Bops runs on their Mac (and has a Boppy of its own): never asked.
  world.host = "mac";
  const f = await addFileTo("brief.pdf", 5, body("hello"), shared(OWNERS), ADMIN);
  assert.deepEqual({ ...f, id: undefined }, { id: undefined, name: "brief.pdf", size: 5, path: "~/Desktop/brief.pdf", botId: "boppy", hostId: "boppy", hostName: "Boppy" });
  assert.deepEqual(calls.find((c) => c.path === "bash").id, "pc_owner", "the owner's computer, named by Bops Cloud");
  const start = calls.find((c) => c.path === "/api/files/uploads");
  assert.deepEqual([start.key, start.body.desktopId], ["sk_test", "pc_owner"], "the user's own Orgo key, which Orgo checks too");
  assert.equal(calls.find((c) => c.path === "/api/files/uploads/complete").body.desktopId, "pc_owner");
  assert.deepEqual(addedFile(f.id), f, "kept for the message, like the owner's");
  // The bot's name as Bops Cloud said it, on one line (it's shown, and told to the bot).
  reset();
  const odd = await addFileTo("b.pdf", 5, body("hello"), shared({ status: 200, json: { ...OWNERS.json, hostName: " Boppy\n[x] " } }), ADMIN);
  assert.equal(odd.hostName, "Boppy [x]");
});

await check("in a shared workspace, someone Bops Cloud doesn't let add files is told why before anything goes", async () => {
  reset();
  const no = (status, error, code) => ({ status, json: { error, ...(code ? { code } : {}) } });
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(403, "The owner hasn't let you use this bot's computer, so you can't add files for it.", "member_no_computer")), ADMIN), 403, /hasn't let you use this bot's computer/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(403, "You can watch this bot, not add files for it. Ask the owner for Write.", "member_read_only")), ADMIN), 403, /not add files for it\. Ask the owner for Write/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(409, "The owner's Bops needs an update before you can add files here.", "owner_bops_old")), ADMIN), 409, /needs an update/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(402, "Alex is out of Orgo credit, so Boppy's computer can't wake up for files.")), ADMIN), 402, /out of Orgo credit/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(404, "Not found")), ADMIN), 409, /until Bops Cloud updates/, "a Bops Cloud from before");
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(404, "No such bot")), ADMIN), 404, /^That bot isn't in this workspace anymore\.$/);
  // Taken out of the workspace: said so, never that the bot left.
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(404, "No such workspace")), ADMIN), 404, /^You're not in this workspace anymore\.$/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(401, "Sign in again")), ADMIN), 404, /^You're not in this workspace anymore\.$/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(403, "Only the owner and Admins can add files here for now.", "admin_only")), MEMBER), 403, /^Only the owner and Admins can add files here for now\.$/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(no(403, "Max works on a computer in another of Alex's workspaces, so only Alex can add files to it.", "member_owner_only")), ADMIN), 403, /so only Alex can add files to it/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(null), ADMIN), 502, /Couldn't reach Bops Cloud/);
  await refusal(addFileTo("a.txt", 1, body("x"), shared({ status: 200, json: { computerId: "../x" } }), ADMIN), 502, /couldn't be added/);
  assert.equal(calls.length, 0, "nothing to Orgo");
  // Too big or empty: said before Bops Cloud is even asked.
  let asked = 0;
  await refusal(addFileTo("huge.iso", 3 * 1024 ** 3, body("x"), async () => (asked++, sharedTarget(OWNERS)), ADMIN), 413);
  assert.equal(asked, 0);
});

await check("in a shared workspace, Orgo turning it down is a plain sentence, and the claimed name is let go", async () => {
  const turnedDown = async (json, status, words, statusOut) => {
    reset();
    world.start = { status, json };
    await refusal(addFileTo("a.txt", 1, body("x"), shared(OWNERS), ADMIN), statusOut, words);
    assert.equal(puts.length, 0);
    assert.deepEqual(onDesktop(), [], "no empty file left");
  };
  // An Admin (who may write to the project) Orgo turns away: not their role, so never said to be; the computer's out of their reach.
  await turnedDown({ error: "Access denied" }, 403, /^Orgo didn't let you reach Boppy's computer, so files can't go on it\.$/, 403);
  await turnedDown({ error: "This key can't run commands.", code: "key_permission" }, 403, /^Orgo didn't let you reach Boppy's computer/, 403);
  await turnedDown({ error: "The owner hasn’t let you use this computer. Use its bots from Bops.", code: "bops_owner_only" }, 403, /^The owner hasn't let you use this computer, so files can't go on it\.$/, 403);
  await turnedDown({ error: "This API key is scoped to workspace w1. It cannot access workspace w2.", code: "workspace_scope_mismatch" }, 403, /^Your Orgo key only works in another workspace\. Sign in to Orgo again in Bops\.$/, 403);
  await turnedDown({ error: "Choose a plan to continue.", code: "COMPUTER_LOCKED" }, 402, /^Boppy's computer is locked on Orgo right now, so files can't go on it\. The owner can unlock it on Orgo\.$/, 402);
  // A Member (Orgo's "member" can't write to the project): only the owner and Admins add files there. Any other code: out of reach.
  for (const [json, words] of [
    [{ error: "Access denied" }, /^Orgo lets only the owner and Admins of this workspace add files to its computers\.$/],
    [{ error: "This key can't run commands.", code: "key_permission" }, /^Orgo didn't let you reach Boppy's computer/],
  ]) {
    reset();
    world.start = { status: 403, json };
    await refusal(addFileTo("a.txt", 1, body("x"), shared(OWNERS), MEMBER), 403, words);
  }
  // The same at the last step.
  reset();
  world.complete = { status: 403, json: { error: "Access denied" } };
  await refusal(addFileTo("a.txt", 1, body("x"), shared(OWNERS), MEMBER), 403, /Orgo lets only the owner and Admins/);
  reset();
  world.complete = { status: 403, json: { error: "Access denied" } };
  await refusal(addFileTo("a.txt", 1, body("x"), shared(OWNERS), ADMIN), 403, /^Orgo didn't let you reach Boppy's computer/);
  // On the computer's first step, Orgo's bare "Access denied" (a computer outside the workspace's project) to an Admin.
  reset();
  world.wake = orgoError(403);
  await refusal(addFileTo("a.txt", 1, body("x"), shared(OWNERS), ADMIN), 403, /^Orgo didn't let you reach Boppy's computer/);
  // And on the computer's first step: Orgo keeping them off it, or the owner's computer locked. The owner's credit is
  // never taken as the user's own (their Bops isn't told its credit ran out).
  reset();
  creditAsked = 0;
  world.wake = orgoError(403, "bops_owner_only");
  await refusal(addFileTo("a.txt", 1, body("x"), shared(OWNERS), ADMIN), 403, /hasn't let you use this computer/);
  world.wake = orgoError(402, "insufficient_credits");
  await refusal(addFileTo("a.txt", 1, body("x"), shared(OWNERS), ADMIN), 402, /Boppy's computer is locked on Orgo/);
  assert.equal(creditAsked, 0);
  // The user's own workspace keeps Orgo's own words for what isn't one of these.
  reset();
  world.start = { status: 403, json: { error: "Access denied" } };
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /^Orgo didn't take the file\. Orgo said: Access denied$/);
});

/* ---------------- The routes ---------------- */

const route = {
  files: await import(`${root}/app/api/bots/files/route.ts`),
  messages: await import(pathToFileURL(`${root}/app/api/chats/[chatId]/messages/route.ts`).href),
  shared: await import(`${root}/app/api/workspaces/shared/route.ts`),
};
const at = "http://127.0.0.1:3210";
const upload = (q, text = "hello") =>
  route.files.POST(new Request(`${at}/api/bots/files?${q}`, { method: "POST", headers: { host: "127.0.0.1:3210", "content-length": String(Buffer.byteLength(text)) }, body: text, duplex: "half" }));
const posted = (path, json) => new Request(`${at}${path}`, { method: "POST", headers: { host: "127.0.0.1:3210", "content-type": "application/json" }, body: JSON.stringify(json) });

await check("POST /api/bots/files in a shared workspace: the computer Bops Cloud names, never the user's own bot of that id; Orgo's refusals in their role", async () => {
  reset();
  // The user has a Max of their own (pc_max): the shared workspace's Max is the owner's.
  world.shared = { role: "admin", target: OWNERS };
  const r = await upload("botId=max&name=a.pdf");
  assert.equal(r.status, 200);
  assert.deepEqual(reached.asked, [["max", false]], "Bops Cloud asked, for that bot");
  assert.deepEqual(calls.filter((c) => c.path === "bash").map((c) => c.id), ["pc_owner"], "never the user's own Max's computer");
  assert.equal((await r.json()).file.hostId, "boppy");
  // A drop on its screen says so to Bops Cloud.
  reset();
  world.shared = { role: "admin", target: OWNERS };
  await upload("botId=max&name=b.pdf&to=screen");
  assert.deepEqual(reached.asked, [["max", true]]);
  // Orgo's bare refusal, as theirs: an Admin is out of reach of that computer; a Member may not add files at all.
  for (const [role, words] of [
    ["admin", /^Orgo didn't let you reach Boppy's computer/],
    ["member", /^Orgo lets only the owner and Admins/],
  ]) {
    reset();
    world.shared = { role, target: OWNERS };
    world.start = { status: 403, json: { error: "Access denied" } };
    const no = await upload("botId=max&name=c.pdf");
    assert.equal(no.status, 403);
    assert.match((await no.json()).error, words, role);
  }
  // Bops Cloud's own refusal, in its words, with nothing sent to Orgo.
  reset();
  world.shared = { role: "member", target: { status: 403, json: { error: "Only the owner and Admins can add files here for now.", code: "admin_only" } } };
  const member = await upload("botId=max&name=d.pdf");
  assert.deepEqual([member.status, (await member.json()).error], [403, "Only the owner and Admins can add files here for now."]);
  assert.equal(calls.length, 0);
  // The user's own workspace: their own Max, and Bops Cloud never asked.
  reset();
  assert.equal((await upload("botId=max&name=e.pdf")).status, 200);
  assert.deepEqual(reached.asked, []);
  assert.deepEqual(calls.filter((c) => c.path === "bash").map((c) => c.id), ["pc_max"]);
});

await check("a message naming a file that isn't here anymore is refused, never sent without it: the user's own chat, and a shared workspace's", async () => {
  reset();
  const f = await addFile(BOTS.max, "kept.pdf", 5, body("hello"));
  const say = (json) => route.messages.POST(posted("/api/chats/bot:max/messages", json), { params: Promise.resolve({ chatId: "bot:max" }) });
  const gone = await say({ text: "Read these", files: [f.id, "file_gone"] });
  assert.deepEqual([gone.status, (await gone.json()).error], [409, "A file you added isn't ready anymore. Add it again."]);
  assert.equal(reached.handled.length, 0, "nothing sent");
  assert.equal((await say({ text: "Read it", files: [f.id] })).status, 200);
  assert.deepEqual(reached.handled.at(-1).at(-1), [addedFile(f.id)], "sent with the file as it was kept");
  // A shared workspace's act: refused before Bops Cloud, and said to be unsent (the window puts the words back).
  const act = (files) => route.shared.POST(posted("/api/workspaces/shared", { key: "key_00000001", act: { act: "chat", chatId: "c1", text: "Here", files } }));
  const no = await act([{ id: "file_gone", name: "x.pdf" }]);
  assert.deepEqual([no.status, await no.json()], [409, { error: "A file you added isn't ready anymore. Add it again.", unsent: true }]);
  assert.equal(reached.acts.length, 0);
  // One that's here goes as this Bops kept it, never as the window sent it.
  assert.equal((await act([{ id: f.id, name: "other.pdf", hostName: "Someone" }])).status, 200);
  assert.deepEqual(reached.acts.at(-1).files, [addedFile(f.id)]);
});

rmSync(home, { recursive: true, force: true });
Date.now = realNow;
console.log(`bot files: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
