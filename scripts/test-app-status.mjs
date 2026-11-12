// An app's status in a sentence, and the one thing to press (lib/hosted-apps.ts appStatus): every branch, in the order
// it's decided; how many changes sit between live and the preview (changesBetween). Usage: node scripts/test-app-status.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
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
const { appStatus, changesBetween } = await import(pathToFileURL(`${root}/lib/hosted-apps.ts`).href);
const { reviewLabel, hasUnpublishedPreview } = await import(pathToFileURL(`${root}/lib/app-review.ts`).href);

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const base = { head: "h2", preview: { serving: "h2", state: "succeeded" }, live: { serving: "h1", state: "succeeded" }, domain: true, wasLive: true };
const NO_DASHES = /[–—]| - /;

check("its computer gone: a new home, by updating the preview", () => assert.deepEqual(appStatus({ ...base, lost: true }), { sentence: "Its computer is gone. Update the preview to give it a new home.", action: "update-preview", tone: "waits" }));
check("nothing committed: nothing built, nothing to press", () => assert.deepEqual(appStatus({ ...base, head: null }), { sentence: "Nothing built yet.", tone: "quiet" }));
check("a preview deploy on its way says so, and nothing to press", () => {
  for (const state of ["queued", "running"]) assert.deepEqual(appStatus({ ...base, preview: { serving: "h1", state } }), { sentence: "Updating the preview…", tone: "working" });
});
check("a publish on its way: Publishing, or Pushing to GitHub", () => {
  assert.deepEqual(appStatus({ ...base, live: { serving: "h1", state: "running" } }), { sentence: "Publishing…", tone: "working" });
  assert.deepEqual(appStatus({ ...base, live: { serving: "h1", state: "running" }, github: { linked: true } }), { sentence: "Pushing to GitHub…", tone: "working" });
});
check("a failed preview update or publish: said, and the same press offered again", () => {
  assert.deepEqual(appStatus({ ...base, preview: { serving: "h1", state: "failed" } }), { sentence: "The last preview update failed.", action: "update-preview", tone: "failed" });
  assert.deepEqual(appStatus({ ...base, live: { serving: "h1", state: "failed" } }), { sentence: "The last publish failed.", action: "publish", tone: "failed" });
  assert.deepEqual(appStatus({ ...base, live: { serving: "h1", state: "failed" }, preview: null }), { sentence: "The last publish failed.", action: "update-preview", tone: "failed" }, "with no preview to publish from, the preview comes first");
});
check("a failed preview update with a preview that still serves something not live: Publish stays the press, said with the failure", () => {
  const failed = { ...base, head: "h3", preview: { serving: "h2", state: "failed" }, live: { serving: "h1", state: "succeeded" }, changes: 1 };
  assert.deepEqual(appStatus(failed), { sentence: "The last preview update failed. What the preview still has can be published.", action: "publish", tone: "failed" });
  assert.equal(appStatus({ ...failed, github: { linked: true } }).action, "publish", "on GitHub, linked");
  assert.equal(appStatus({ ...failed, github: { linked: false } }).action, "update-preview", "not linked to GitHub: nothing to publish to");
  assert.equal(appStatus({ ...failed, domain: false, wasLive: false }).action, "update-preview", "nowhere to publish to");
  assert.equal(appStatus({ ...failed, preview: { serving: null, state: "failed" } }).action, "update-preview", "a preview serving nothing");
  assert.equal(reviewLabel(appStatus(failed)), "Preview update failed");
  assert.equal(hasUnpublishedPreview(appStatus(failed)), false, "a failure never borrows the pending review color");
});
check("a failed publish reads as one, whichever press comes next", () => {
  assert.equal(reviewLabel(appStatus({ ...base, live: { serving: "h1", state: "failed" } })), "Publish failed");
  assert.equal(reviewLabel(appStatus({ ...base, live: { serving: "h1", state: "failed" }, preview: null })), "Publish failed", "even with the preview to update first");
  assert.equal(reviewLabel(appStatus({ ...base, preview: { serving: "h1", state: "failed" } })), "Preview update failed");
});
check("the preview behind the newest change (or none yet): Update preview", () => {
  assert.deepEqual(appStatus({ ...base, preview: { serving: "h1", state: "succeeded" } }), { sentence: "The preview is behind the latest change.", action: "update-preview", tone: "waits" });
  assert.deepEqual(appStatus({ ...base, preview: null }), { sentence: "The preview is behind the latest change.", action: "update-preview", tone: "waits" });
});
check("an earlier version put back on the preview (Restore): Publish, to go back to it, never Update preview; a newer one than live, behind the head: Publish too", () => {
  assert.deepEqual(appStatus({ ...base, head: "h3", preview: { serving: "h1", state: "succeeded" }, live: { serving: "h2", state: "succeeded" }, changes: 0, change: "First look" }), { sentence: "The preview has an earlier version than live.", detail: "First look", action: "publish", tone: "waits" });
  assert.deepEqual(appStatus({ ...base, head: "h3", preview: { serving: "h2", state: "succeeded" }, live: { serving: "h1", state: "succeeded" }, changes: 1 }), { sentence: "The preview has 1 change that isn't live.", action: "publish", tone: "waits" });
  assert.equal(appStatus({ ...base, head: "h3", preview: { serving: "h1", state: "succeeded" }, live: { serving: "h1", state: "succeeded" } }).action, "update-preview", "the preview at what's live, behind the head: Update preview");
  assert.equal(appStatus({ ...base, head: "h3", preview: { serving: "h1", state: "succeeded" }, live: { serving: "h2", state: "failed" }, changes: 0 }).action, "publish", "a failed publish with an earlier version on the preview: publish it again");
});
check("on GitHub but not linked: the link comes first (in Published's menu), nothing to press here", () => assert.deepEqual(appStatus({ ...base, github: { linked: false } }), { sentence: "The preview is ready. Link it to GitHub to publish.", tone: "waits" }));
check("preview and live the same: up to date; with no domain and never live, not published yet: Connect a domain", () => {
  assert.deepEqual(appStatus({ ...base, live: { serving: "h2", state: "succeeded" } }), { sentence: "Live and up to date.", tone: "quiet" });
  assert.deepEqual(appStatus({ ...base, live: { serving: "h2", state: "succeeded" }, github: { linked: true }, domain: false, wasLive: false }), { sentence: "Live and up to date.", tone: "quiet" });
});
check("the preview ahead with no domain and never live: Connect a domain", () => assert.deepEqual(appStatus({ ...base, domain: false, wasLive: false }), { sentence: "The preview is ready. Connect a domain to publish it.", action: "connect-domain", tone: "waits" }));
check("the preview ahead of live: Publish, with the known count only and the newest change", () => {
  assert.deepEqual(appStatus(base), { sentence: "The preview has changes that aren't live.", action: "publish", tone: "waits" });
  assert.deepEqual(appStatus({ ...base, changes: 3, change: "Home line" }), { sentence: "The preview has 3 changes that aren't live.", detail: "Home line", action: "publish", tone: "waits" });
  assert.deepEqual(appStatus({ ...base, changes: null }).sentence, "The preview has changes that aren't live.");
  assert.deepEqual(appStatus({ ...base, domain: false, wasLive: true }).action, "publish", "live before with no domain publishes all the same");
  assert.deepEqual(appStatus({ ...base, domain: false, wasLive: false, github: { linked: true } }).action, "publish", "GitHub production needs no domain");
});
check("changesBetween: live and the preview in the history, by their distance; not known when either isn't there", () => {
  const log = [{ id: "h4" }, { id: "h3" }, { id: "h2" }, { id: "h1" }];
  assert.equal(changesBetween(log, "h1", "h3"), 2);
  assert.equal(changesBetween(log, "h2", "h2"), 0);
  assert.equal(changesBetween(log, "h9", "h3"), null);
  assert.equal(changesBetween(log, "h1", "h9"), null);
  assert.equal(changesBetween(log, null, "h3"), null);
  assert.equal(changesBetween(log, "h1", null), null);
  assert.equal(changesBetween(log, "h3", "h1"), 0, "live ahead of the preview reads as nothing waiting");
});
check("no dashes in any sentence", () => {
  const all = [appStatus(base), appStatus({ ...base, lost: true }), appStatus({ ...base, head: null }), appStatus({ ...base, github: { linked: false } }), appStatus({ ...base, domain: false, wasLive: false }), appStatus({ ...base, preview: { serving: "h2", state: "failed" } })];
  for (const s of all) assert.ok(!NO_DASHES.test(s.sentence), s.sentence);
});
console.log(`${passed} passed`);
