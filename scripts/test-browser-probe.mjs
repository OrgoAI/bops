import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("timing logs are silent by default and never include typed text", () => {
  const code = `import { probeInput } from './cloud/browser-probe.ts';
    probeInput('test', 'Input.dispatchMouseEvent', {type:'mousePressed',x:12,y:34,text:'PRIVATE'});
    probeInput('test', 'Input.insertText', {text:'PRIVATE'});`;
  const run = (enabled) => spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, BOPS_BROWSER_PROBE: enabled },
  });
  const off = run("");
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stdout + off.stderr, "");
  const on = run("1");
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout + on.stderr, /mousePressed/);
  assert.doesNotMatch(on.stdout + on.stderr, /PRIVATE|insertText/);
});
