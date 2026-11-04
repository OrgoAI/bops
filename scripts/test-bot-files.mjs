// Tests for files the user adds for a bot (lib/server/bot-files.ts, lib/added-files.ts): on its computer through
// Orgo's file uploads (a link to put it at, the bytes to it as they come, then Orgo has the computer fetch it onto
// its Desktop, woken first), on this Mac for a bot that works here, refused with words for the user (too big, empty,
// no computer, Orgo turning it down, the computer not waking, fewer or more bytes than it said), and named safely.
// Also what the bot is told about them (filesNote) and how sizes read.
//
// The store, Orgo and storage are fakes (below). The people and ids are made up.
// Usage: node --conditions=react-server scripts/test-bot-files.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = { store: ["getState", "id"], screens: ["workComputer"], uploads: ["uploadsDir"] };
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
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") + unfaked(name, url, FAKES[name]) };
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

const dir = mkdtempSync(join(tmpdir(), "bops-bot-files-"));
const BOTS = {
  max: { id: "max", name: "Max", computerId: "pc_max", isMain: true },
  rex: { id: "rex", name: "Rex" }, // shares Max's computer
  mia: { id: "mia", name: "Mia", runsOn: "mac" },
  new: { id: "new", name: "Noa" }, // no computer yet
};
let n = 0;
let calls = [];
let puts = [];
const world = {
  host: "cloud",
  start: { status: 200, json: { upload_url: "https://storage.example/put?sig=x", upload_token: "tok_1", expires_in: 900 } },
  complete: { status: 200, json: { ok: true, placedIn: "the desktop" } },
  put: true,
  wake: true,
};
globalThis.__fake = {
  store: { getState: () => ({ host: world.host, bots: Object.values(BOTS) }), id: (p) => `${p}_${++n}` },
  screens: { workComputer: (b) => (b.id === "rex" ? BOTS.max : b) },
  uploads: { uploadsDir: () => dir },
  orgo: {
    apiKey: async () => "sk_test",
    callOrgo: async (key, path, opts) => {
      calls.push({ key, path, ...opts });
      return path === "/api/files/uploads" ? world.start : path === "/api/files/uploads/complete" ? world.complete : null;
    },
    bash: async (id, cmd) => {
      calls.push({ path: "bash", id, cmd });
      if (!world.wake) throw new Error("asleep");
      return { output: "", exit_code: 0 };
    },
  },
};
globalThis.__bopsFilePut = async (url, body, size) => {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  const bytes = Buffer.concat(chunks);
  puts.push({ url, size, bytes });
  return world.put && bytes.length === size;
};

const { addFile, addedFile, AddFileError, filesGoTo } = await import(`${root}/lib/server/bot-files.ts`);
const { cleanFileName, fileSize, filesNote, isPicture } = await import(`${root}/lib/added-files.ts`);

const body = (text) => new Blob([text]).stream();
const reset = () => {
  calls = [];
  puts = [];
  Object.assign(world, { host: "cloud", put: true, wake: true });
  world.start = { status: 200, json: { upload_url: "https://storage.example/put?sig=x", upload_token: "tok_1" } };
  world.complete = { status: 200, json: { ok: true, placedIn: "the desktop" } };
};
const refusal = async (p, status, words) => {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof AddFileError, `an AddFileError, not ${e}`);
    assert.equal(e.status, status);
    if (words) assert.match(e.message, words);
    return true;
  });
};

await check("a file goes on the bot's computer's Desktop through Orgo's uploads", async () => {
  reset();
  const f = await addFile(BOTS.max, "Q3 report.pdf", 11, body("hello world"));
  assert.deepEqual({ ...f, id: undefined }, { id: undefined, name: "Q3 report.pdf", size: 11, where: "computer", path: "~/Desktop/Q3 report.pdf", botId: "max" });
  const start = calls.find((c) => c.path === "/api/files/uploads");
  assert.deepEqual(start.body, { desktopId: "pc_max", filename: "Q3 report.pdf", size_bytes: 11 }, "no destPath: Orgo puts it on the Desktop");
  assert.equal(start.method, "POST");
  assert.equal(start.key, "sk_test");
  assert.equal(puts[0].url, "https://storage.example/put?sig=x");
  assert.equal(puts[0].bytes.toString(), "hello world", "every byte, as sent");
  assert.deepEqual(calls.find((c) => c.path === "/api/files/uploads/complete").body, { desktopId: "pc_max", upload_token: "tok_1" });
  assert.ok(calls.some((c) => c.path === "bash" && c.id === "pc_max"), "the computer is woken to take it");
  assert.deepEqual(addedFile(f.id), f, "kept for the message it goes with");
  assert.equal(addedFile("file_nope"), undefined, "only ones added here");
  assert.ok(!JSON.stringify(f).includes("tok_1") && !JSON.stringify(f).includes("sig="), "nothing of the link or its token");
});

await check("a bot that shares the main bot's computer gets it there", async () => {
  reset();
  const f = await addFile(BOTS.rex, "notes.txt", 2, body("hi"));
  assert.equal(calls.find((c) => c.path === "/api/files/uploads").body.desktopId, "pc_max");
  assert.equal(f.botId, "rex");
  assert.deepEqual(filesGoTo(BOTS.rex).where, "computer");
});

await check("a bot that works on this Mac gets it in the user's folder here", async () => {
  reset();
  const f = await addFile(BOTS.mia, "budget.xlsx", 5, body("12345"));
  assert.equal(f.where, "mac");
  assert.ok(f.path.startsWith(join(dir, "files")), f.path);
  assert.ok(f.path.endsWith("/budget.xlsx"));
  assert.equal(readFileSync(f.path, "utf8"), "12345");
  assert.equal(calls.length, 0, "nothing to Orgo");
  world.host = "mac";
  assert.deepEqual(filesGoTo(BOTS.max), { where: "mac" }, "and every bot, when Bops runs on the Mac");
});

await check("on this Mac: fewer or more bytes than it said keep nothing", async () => {
  reset();
  const before = readdirSync(join(dir, "files")).length;
  await refusal(addFile(BOTS.mia, "short.txt", 10, body("abc")), 400, /didn't arrive whole/);
  await refusal(addFile(BOTS.mia, "long.txt", 2, body("abcdef")), 400, /bigger than it said/);
  assert.equal(readdirSync(join(dir, "files")).length, before, "no half file left");
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

await check("Orgo turning it down says so, with Orgo's words", async () => {
  reset();
  world.start = { status: 403, json: { error: "This computer is in another workspace." } };
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /Orgo didn't take the file\. Orgo said: This computer is in another workspace\./);
  assert.equal(puts.length, 0);
  reset();
  world.start = { status: 200, json: { upload_url: "http://plain.example/put", upload_token: "t" } };
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /Orgo didn't take/, "only a signed https link");
});

await check("storage not taking it, the computer not waking, or Orgo not placing it: each says which", async () => {
  reset();
  world.put = false;
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /didn't upload/);
  assert.ok(!calls.some((c) => c.path === "/api/files/uploads/complete"), "never finished");
  reset();
  world.wake = false;
  await refusal(addFile(BOTS.rex, "a.txt", 1, body("x")), 503, /Max's computer didn't wake up/);
  reset();
  world.complete = { status: 400, json: { error: "Desktop is not running. Start it, then finish the upload." } };
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /didn't reach Max's computer\. Orgo said: Desktop is not running/);
  reset();
  world.complete = null;
  await refusal(addFile(BOTS.max, "a.txt", 1, body("x")), 502, /didn't reach Max's computer\.$/);
});

await check("names: the last part only, no hidden files, no control characters, long ones kept to 180", () => {
  assert.equal(cleanFileName("../../etc/passwd"), "passwd");
  assert.equal(cleanFileName("C:\\Users\\a\\b.docx"), "b.docx");
  assert.equal(cleanFileName(".bashrc"), "bashrc");
  assert.equal(cleanFileName("..."), "");
  assert.equal(cleanFileName("a\u0000b\nc\u007f.txt"), "abc.txt");
  assert.equal(cleanFileName("  spaced name.pdf  "), "spaced name.pdf");
  const long = cleanFileName(`${"x".repeat(300)}.tar.gz`);
  assert.equal(long.length, 180);
  assert.ok(long.endsWith(".gz"));
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

await check("what the bot is told: where each file is, and to open it there", () => {
  const pc = [
    { id: "f1", name: "a.pdf", size: 2048, where: "computer", path: "~/Desktop/a.pdf", botId: "max" },
    { id: "f2", name: "b.csv", size: 10, where: "computer", path: "~/Desktop/b.csv", botId: "max" },
  ];
  assert.equal(filesNote(pc, "Alex"), "[Alex added 2 files to your computer's Desktop: ~/Desktop/a.pdf (2 KB), ~/Desktop/b.csv (10 bytes). Open them there.]");
  assert.equal(filesNote(pc.slice(0, 1), "Alex"), "[Alex added a file to your computer's Desktop: ~/Desktop/a.pdf (2 KB). Open it there.]");
  assert.equal(filesNote([{ ...pc[0], where: "mac", path: "/Users/alex/.data/a.pdf" }], "Alex"), "[Alex added a file for you, saved on their Mac: /Users/alex/.data/a.pdf (2 KB)]");
  assert.equal(filesNote([], "Alex"), "");
});

rmSync(dir, { recursive: true, force: true });
assert.ok(!existsSync(dir));
console.log(`bot files: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
