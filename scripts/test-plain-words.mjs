// Tests for lib/plain-words.ts: what a bot's words and steps say to someone who isn't a developer.
// Usage: node --experimental-strip-types scripts/test-plain-words.mjs
import assert from "node:assert/strict";
import { dropCitations, isLocalLink, localOnlyLine, plainStep, plainText, plainTitle } from "../lib/plain-words.ts";

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const cite = (id) => `cite${id}`;

check("citation markers go, with the space before them, and nothing else changes", () => {
  assert.equal(dropCitations(`I found the logo files. ${cite("turn0search3")}`), "I found the logo files.");
  assert.equal(dropCitations(`seven walking days ${cite("turn1view0")}${cite("turn1view5")}.`), "seven walking days.");
  assert.equal(dropCitations(`From the guide fileciteturn2file0, page 3.`), "From the guide, page 3.");
  assert.equal(dropCitations("Plain words, kept: a, b; c. Run `cd .` first."), "Plain words, kept: a, b; c. Run `cd .` first.");
});

check("a bot's message as plain text: a link's words, no address, brackets, **, backticks, # or bullets", () => {
  assert.equal(plainText("See [the preview](https://trailguides.example.com/preview)."), "See the preview.");
  assert.equal(plainText("**Done**: `look.ts` is back."), "Done: look.ts is back.");
  assert.equal(plainText("# Plan\n- [Book](https://trailguides.example.com/b)\n* **Pay**\n+ Go\n• Rest"), "Plan\nBook\nPay\nGo\nRest");
  assert.equal(plainText("Run:\n```bash\nnpm run dev\n```\nthen look."), "Run:\nnpm run dev\n\nthen look.");
  assert.equal(plainText(`Found it. ${cite("turn0search3")}`), "Found it.", "citation markers go too");
  // What isn't a mark stays: a bare address, a minus, a lone star, a hyphenated word, a number list.
  for (const t of ["Live: https://trailguides.example.com/live", "-5 degrees", "a * b", "re-run it", "1. Book\n2. Pay", "C# and #tags"]) assert.equal(plainText(t), t, t);
});

check("code stays as the chat shows it: a code block's lines and `code` verbatim, only the ``` and backticks go", () => {
  assert.equal(plainText("```\ncode **x** [l](u)\n- y\n```"), "code **x** [l](u)\n- y\n");
  assert.equal(plainText("Match `src/**` or `lib/**` here."), "Match src/** or lib/** here.");
  assert.equal(plainText("Type `[a](b)` then **go**."), "Type [a](b) then go.");
});

check("steps are said as a person would", () => {
  assert.equal(plainStep("clicked (666, 115)"), "Clicked on the screen");
  assert.equal(plainStep("ran python3 - <<'PY' from urllib.request import urlopen"), "Looked things up online");
  assert.equal(plainStep("ran python3 - <<'PY' from pathlib import Path import json"), "Worked on the files");
  assert.equal(plainStep("ran npx playwright install --with-deps chromium"), "Set up the app");
  assert.equal(plainStep("ran pdftoppm -png camino-DRAFT.pdf page"), "Checked the PDF");
  assert.equal(plainStep("ran git log --oneline -5"), "Looked at the code history");
  assert.equal(plainStep("ran npm test"), "Ran a command", "a test run isn't setting the app up");
  assert.equal(plainStep("ran git commit -m fix"), "Ran a command", "nor is a commit looking at history");
  assert.equal(plainStep("Read https://trailguides.example.com/start?redirect=%2F"), "Read trailguides.example.com");
  assert.equal(plainStep("Check the corrected draft itinerary"), "Check the corrected draft itinerary", "a step already in words stays");
});

check("a thread's title says where an app's copy runs, its computer, not Local or localhost; the rest stays", () => {
  assert.equal(plainTitle("Run Trail Guides Local"), "Run Trail Guides on its computer");
  assert.equal(plainTitle("Show Trail Guides locally"), "Show Trail Guides on its computer");
  assert.equal(plainTitle("Open the brochure on localhost:3101"), "Open the brochure on its computer");
  assert.equal(plainTitle("Check http://localhost:3000/start for the cover"), "Check its computer for the cover");
  assert.equal(plainTitle("Trail Guides draft brochure"), "Trail Guides draft brochure", "already plain");
  assert.equal(plainTitle("Local news digest"), "Local news digest", "Local only where it ends the title");
  assert.equal(plainTitle("Call the local printer"), "Call the local printer");
  assert.equal(plainTitle("Check localhost:3000?view=home"), "Check its computer");
  assert.equal(plainTitle("Open localhost:3000. Then check the cover"), "Open its computer. Then check the cover", "a full stop after the port ends it");
  assert.equal(plainTitle("Read http://localhost.example.com/docs"), "Read http://localhost.example.com/docs", "another host stays");
  // Only the run target an app's copy has on the bot's computer (its Local): a title that runs, starts or opens an app
  // there. Any other title ending in "local" is the word, and stays.
  assert.equal(plainTitle("Start trail-guides Local"), "Start trail-guides on its computer");
  assert.equal(plainTitle("Restart the brochure site locally"), "Restart the brochure site on its computer");
  for (const title of ["Shop local", "Shop locally", "Buy local", "Support local", "Think global, act local", "Keep it local", "Run local", "Find the best coffee local", "Call the printer locally"])
    assert.equal(plainTitle(title), title, title);
});

check("a localhost link is one to the computer it runs on, and says so", () => {
  for (const href of ["http://localhost:3101/", "http://localhost", "https://127.0.0.1:8080/x?y", "http://LOCALHOST:3000#a"]) assert.ok(isLocalLink(href), href);
  for (const href of ["https://trailguides.example.com", "http://localhost.example.com/", "/api/pages/x", "http://127.0.0.12/"]) assert.ok(!isLocalLink(href), href);
  assert.equal(localOnlyLine("Nova"), "opens only on Nova's computer");
  assert.equal(localOnlyLine(undefined), "opens only on the bot's computer");
});

console.log(`\nplain words: ${passed} passed`);
