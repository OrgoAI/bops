// Tests for adding files in chat and on a bot's screen (components/app/attachments.tsx): sendFile puts the file's
// bytes as they are to POST /api/bots/files (its name and bot in the address), saying how much has gone up, and says
// why when it can't (too big before anything goes, the server's own words, Bops not answering); the message box's
// tile for a file says its name, its size or how far it is, and why it failed; a sent message's files say their name,
// size and where they are. The chat's box takes any file (not only images), and the message names the files it
// added by id. The .tsx files are compiled with the TypeScript in node_modules as they load and rendered to HTML.
// Usage: node scripts/test-attachments-ui.mjs   (not with --conditions=react-server: client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});

globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3210" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };

/** A stand-in XMLHttpRequest: what was sent, and the answer each test sets. */
const xhrs = [];
let answer = { status: 200, body: { file: { id: "file_1", name: "plan.pdf", size: 4, where: "computer", path: "~/Desktop/plan.pdf", botId: "max" } } };
class FakeXHR {
  constructor() {
    this.headers = {};
    this.upload = {};
    xhrs.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  send(body) {
    this.body = body;
    queueMicrotask(() => {
      if (answer === "down") return this.onerror?.();
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
      this.status = answer.status;
      this.responseText = JSON.stringify(answer.body);
      this.onload?.();
    });
  }
}
globalThis.XMLHttpRequest = FakeXHR;

const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");
const { AttachmentTray, MessageFiles, ScreenDrops, sendFile } = await import(`${root}/components/app/attachments.tsx`);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name}\n  ${e.stack?.split("\n").slice(0, 5).join("\n  ")}`);
  }
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();

await check("sendFile: the bytes as they are, to the bot's file route, with how far it's gone", async () => {
  xhrs.length = 0;
  const file = new File(["abcd"], "my plan & notes.pdf", { type: "application/pdf" });
  const parts = [];
  const added = await sendFile("max", file, (p) => parts.push(p));
  const x = xhrs[0];
  assert.equal(x.method, "POST");
  assert.equal(x.url, "/api/bots/files?botId=max&name=my%20plan%20%26%20notes.pdf");
  assert.equal(x.headers["Content-Type"], "application/octet-stream");
  assert.equal(x.body, file, "the file itself, not read into the page");
  assert.deepEqual(parts, [0.5, 1]);
  assert.equal(added.path, "~/Desktop/plan.pdf");
});

await check("sendFile: too big says so before anything goes; the server's words when it refuses; Bops not answering", async () => {
  xhrs.length = 0;
  const big = { name: "huge.iso", size: 3 * 1024 ** 3, type: "" };
  await assert.rejects(sendFile("max", big), /Too big\. 2 GB at most\./);
  await assert.rejects(sendFile("max", new File([], "empty.txt")), /empty/);
  assert.equal(xhrs.length, 0, "nothing sent");
  answer = { status: 409, body: { error: "Noa has no computer yet." } };
  await assert.rejects(sendFile("noa", new File(["x"], "a.txt")), /Noa has no computer yet\./);
  answer = { status: 500, body: "not json" };
  await assert.rejects(sendFile("max", new File(["x"], "a.txt")), /Couldn't add this file/);
  answer = "down";
  await assert.rejects(sendFile("max", new File(["x"], "a.txt")), /Couldn't reach Bops/);
  answer = { status: 200, body: { file: { id: "file_1", name: "plan.pdf", size: 4, where: "computer", path: "~/Desktop/plan.pdf", botId: "max" } } };
});

await check("the message box: a file's tile says its name and how far it is, then its size and where, or why not", () => {
  const base = { key: "k", kind: "file", name: "Q3 report.pdf", size: 3.2 * 1024 ** 2, done: Promise.resolve(null) };
  const row = (a) => text(renderToStaticMarkup(h(AttachmentTray, { items: [a], onRemove: () => {} })));
  assert.match(row({ ...base, status: "uploading", progress: 0.42 }), /Q3 report\.pdf Uploading 42%/);
  assert.match(row({ ...base, status: "uploading", progress: 1 }), /Putting it on its computer…/);
  assert.match(row({ ...base, status: "ready", progress: 1, file: { where: "computer" } }), /Q3 report\.pdf 3\.2 MB · on its computer/);
  assert.match(row({ ...base, status: "ready", file: { where: "mac" } }), /3\.2 MB · on your Mac/);
  assert.match(row({ ...base, status: "failed", error: "Too big. 2 GB at most." }), /Too big\. 2 GB at most\./);
  const html = renderToStaticMarkup(h(AttachmentTray, { items: [{ ...base, status: "ready" }], onRemove: () => {} }));
  assert.match(html, /aria-label="Remove Q3 report\.pdf"/);
  assert.doesNotMatch(html, /<img/, "no picture for a file");
});

await check("a sent message's files: name, size, and where they are", () => {
  const html = renderToStaticMarkup(
    h(MessageFiles, {
      files: [
        { name: "plan.pdf", size: 2048, where: "computer" },
        { name: "b.csv", size: 10, where: "mac" },
      ],
      botName: "Max",
    }),
  );
  assert.match(text(html), /plan\.pdf 2 KB · on Max's computer's Desktop/);
  assert.match(text(html), /b\.csv 10 bytes · on your Mac/);
  assert.match(text(renderToStaticMarkup(h(MessageFiles, { files: [{ name: "c.txt", size: 5 }] }))), /^c\.txt 5 bytes$/, "a pending one, before it's sent: no where yet");
  assert.equal(renderToStaticMarkup(h(MessageFiles, { files: [] })), "");
});

await check("a bot's screen: over it while dragging, then a note per file", () => {
  assert.match(text(renderToStaticMarkup(h(ScreenDrops, { over: true, drops: [], onClose: () => {}, host: "Max" }))), /Drop to put it on Max's Desktop/);
  const notes = text(
    renderToStaticMarkup(
      h(ScreenDrops, {
        over: false,
        drops: [
          { key: "1", name: "a.pdf", status: "uploading", progress: 0.3 },
          { key: "2", name: "b.pdf", status: "uploading", progress: 1 },
          { key: "3", name: "c.pdf", status: "ready", progress: 1 },
          { key: "4", name: "d.pdf", status: "failed", progress: 0, error: "Max's computer didn't wake up. Try again." },
        ],
        onClose: () => {},
        host: "Max",
      }),
    ),
  );
  assert.match(notes, /a\.pdf Uploading 30%/);
  assert.match(notes, /b\.pdf Putting it on Max's computer…/);
  assert.match(notes, /c\.pdf On the Desktop/);
  assert.match(notes, /d\.pdf Max's computer didn't wake up\. Try again\./);
  assert.equal(renderToStaticMarkup(h(ScreenDrops, { over: false, drops: [], onClose: () => {}, host: "Max" })), "");
});

await check("the chat's box takes any file, and the message names the files it added", () => {
  const chat = readFileSync(`${root}/components/app/chat-view.tsx`, "utf8");
  assert.doesNotMatch(chat, /accept="image\/\*"/, "the + takes any file");
  assert.match(chat, /aria-label="Add images or files"/);
  assert.match(chat, /files: files\.length \? files : undefined/, "the message names them by id");
  assert.match(chat, /useAttachments\(\(\) => \(state\.shared \? undefined : fileBot\?\.id\)\)/, "never in a shared workspace");
  const computer = readFileSync(`${root}/components/app/computer.tsx`, "utf8");
  assert.match(computer, /useScreenDrop\(hasComputer && !mac \? b\.id : undefined\)/, "a cloud computer's screen only");
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
