// Tests for the hand over what you can click (app/globals.css, the base layer's cursor rules): app/globals.css
// compiled by Tailwind as the app's build does, the rules in the base layer and every one of them in :where
// (nothing in them outranks anything, and utilities come after base), so a component's own cursor class wins:
// a screen's crosshair or none, a tab's grab, a cell's I-beam. Then which cursor each control gets, worked out
// in a DOM (linkedom) from the compiled rules in order: buttons and what acts as one (tabs, menu items,
// options, switches, checkboxes, radios), <summary>, <select>, the checkbox's label, the inputs that are
// buttons or pickers get the pointer; disabled ones (disabled, aria-disabled, data-disabled) the arrow; text
// fields keep the I-beam (auto), disabled or not, inside a pointer's label or not; and anything else none.
//
// Usage: node scripts/test-pointer-cursor.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { compile } = await import("@tailwindcss/node");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

const source = readFileSync(`${root}/app/globals.css`, "utf8");
const UTILITIES = ["cursor-crosshair", "cursor-none", "cursor-grab", "cursor-text", "cursor-default", "cursor-pointer"];
const css = (await compile(source, { base: `${root}/app`, onDependency() {} })).build(UTILITIES);

/** Each top-level `@layer name { ... }` block of the compiled CSS, with its body, in order. */
function layers(text) {
  const out = [];
  for (const m of text.matchAll(/@layer ([a-z-]+) \{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; depth && i < text.length; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
    out.push({ name: m[1], at: m.index, body: text.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

/** The rules that set nothing but a cursor, in order: { selector, cursor }. */
const cursorRules = (body) => [...body.matchAll(/(?:^|[}\s])([^{}]+?)\s*\{\s*cursor: ([a-z-]+);\s*\}/g)].map((m) => ({ selector: m[1].trim(), cursor: m[2] }));

const base = layers(css).filter((l) => l.name === "base");
const rules = base.flatMap((l) => cursorRules(l.body));
// Pseudo-elements (the file input's button) aren't elements a DOM matches; checked on their own below.
const elementRules = rules.filter((r) => !r.selector.includes("::"));

/** The cursor the base layer gives `el`: the last rule that matches (all of them weigh nothing, so order decides), or null. */
const cursorOf = (el) => elementRules.reduce((c, r) => (el.matches(r.selector) ? r.cursor : c), null);

await test("in the base layer, under the utilities: the order is theme, base, components, utilities, and a cursor class lands in utilities", () => {
  assert.match(css, /@layer theme, base, components, utilities;/);
  assert.ok(rules.some((r) => r.cursor === "pointer") && rules.some((r) => r.cursor === "default") && rules.some((r) => r.cursor === "auto"), JSON.stringify(rules));
  // Nothing outside the base layer sets the pointer for these.
  const outside = css.replace(/@layer base \{[\s\S]*?\n\}/g, "");
  assert.doesNotMatch(outside, /:where\(\s*button/, "the button rule is only in the base layer");
  const utilities = layers(css).find((l) => l.name === "utilities");
  for (const u of UTILITIES) assert.match(utilities.body, new RegExp(`\\.${u} \\{\\s*cursor: ${u.slice(7)};`), `${u} is a utility`);
});

await test("every rule weighs nothing (all in :where), so a component's own cursor class always wins over it", () => {
  assert.ok(elementRules.length >= 3, JSON.stringify(rules));
  for (const r of elementRules) {
    // A list of :where(...) parts, joined or comma separated, and nothing outside them.
    let rest = r.selector;
    for (;;) {
      const at = rest.indexOf(":where(");
      if (at === -1) break;
      assert.equal(rest.slice(0, at).replace(/[\s,]/g, ""), "", `${r.selector}: only :where(...) at its top level`);
      let depth = 1;
      let i = at + ":where(".length;
      for (; depth && i < rest.length; i++) depth += rest[i] === "(" ? 1 : rest[i] === ")" ? -1 : 0;
      rest = rest.slice(i);
    }
    assert.equal(rest.trim(), "", `${r.selector}: only :where(...) at its top level`);
  }
});

const { document } = parseHTML(`<!doctype html><html><body>
  <button id="button">Save</button>
  <button id="button-disabled" disabled>Save</button>
  <button id="button-aria-disabled" aria-disabled="true">Save</button>
  <button id="button-data-disabled" data-disabled="">Save</button>
  <button id="button-data-enabled" data-disabled="false">Save</button>
  <span id="role-button" role="button" tabindex="0">x</span>
  <span id="role-button-disabled" role="button" aria-disabled="true">x</span>
  <div id="tab" role="tab">Tab</div>
  <div id="menuitem" role="menuitem">Item</div>
  <div id="menuitemradio" role="menuitemradio">Item</div>
  <div id="menuitemcheckbox" role="menuitemcheckbox">Item</div>
  <div id="option" role="option">Tag</div>
  <div id="option-disabled" role="option" aria-disabled="true">Tag</div>
  <button id="switch" role="switch">On</button>
  <button id="switch-disabled" role="switch" disabled>On</button>
  <button id="role-checkbox" role="checkbox">Pick</button>
  <button id="role-radio" role="radio">Pick</button>
  <details><summary id="summary">More</summary>Body</details>
  <select id="select"><option>a</option></select>
  <select id="select-disabled" disabled><option>a</option></select>
  <input id="checkbox" type="checkbox">
  <input id="checkbox-disabled" type="checkbox" disabled>
  <input id="radio" type="radio">
  <input id="range" type="range">
  <input id="file" type="file">
  <input id="color" type="color">
  <input id="submit" type="submit">
  <input id="input-button" type="button">
  <input id="reset" type="reset">
  <label id="label-wraps"><input type="checkbox"> Quiet</label>
  <label id="label-wraps-disabled"><input type="checkbox" disabled> Quiet</label>
  <input id="for-me" type="checkbox"><label id="label-for" for="for-me">Pick</label>
  <input id="for-me-off" type="checkbox" disabled><label id="label-for-disabled" for="for-me-off">Pick</label>
  <label id="label-text"><span>Name</span><input id="text-in-label"></label>
  <input id="text">
  <input id="text-typed" type="text">
  <input id="email" type="email">
  <input id="time" type="time">
  <input id="text-disabled" disabled>
  <input id="combobox" role="combobox">
  <textarea id="textarea"></textarea>
  <textarea id="textarea-disabled" disabled></textarea>
  <div id="row" role="option"><input id="text-in-option"></div>
  <div id="plain">Text</div>
  <div id="plain-aria-disabled" aria-disabled="true">Group</div>
  <a id="link" href="/x">Link</a>
  <div id="screen"><canvas id="canvas"></canvas><video id="video"></video><img id="img" alt=""></div>
</body></html>`);
const cursor = (id) => {
  const el = document.getElementById(id);
  assert.ok(el, id);
  return cursorOf(el);
};

await test("a button and what acts as one show the hand: role button, tab, menu items, option, switch, checkbox and radio drawn as buttons", () => {
  for (const id of ["button", "button-data-enabled", "role-button", "tab", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "switch", "role-checkbox", "role-radio"]) assert.equal(cursor(id), "pointer", id);
});

await test("disabled, the arrow: disabled, aria-disabled and data-disabled (not data-disabled=false)", () => {
  for (const id of ["button-disabled", "button-aria-disabled", "button-data-disabled", "role-button-disabled", "option-disabled", "switch-disabled", "select-disabled", "checkbox-disabled"]) assert.equal(cursor(id), "default", id);
});

await test("<summary>, <select>, and the inputs that are buttons or pickers show the hand", () => {
  for (const id of ["summary", "select", "checkbox", "radio", "range", "file", "color", "submit", "input-button", "reset"]) assert.equal(cursor(id), "pointer", id);
  // The file input's own button too, and the arrow when the input is disabled.
  assert.ok(rules.some((r) => r.selector === "::file-selector-button" && r.cursor === "pointer"), JSON.stringify(rules));
  assert.ok(rules.some((r) => r.selector === ":disabled::file-selector-button" && r.cursor === "default"), JSON.stringify(rules));
});

await test("a checkbox's label, wrapping it or just after it with for: the hand, and the arrow while the checkbox is disabled", () => {
  assert.equal(cursor("label-wraps"), "pointer");
  assert.equal(cursor("label-for"), "pointer");
  assert.equal(cursor("label-wraps-disabled"), "default");
  assert.equal(cursor("label-for-disabled"), "default");
  // A text field's label isn't a control: nothing set.
  assert.equal(cursor("label-text"), null);
});

await test("text fields keep the I-beam (auto), disabled or not, even inside something that shows the hand", () => {
  for (const id of ["text", "text-typed", "email", "time", "text-disabled", "combobox", "textarea", "textarea-disabled", "text-in-label", "text-in-option"]) assert.equal(cursor(id), "auto", id);
  assert.equal(cursor("row"), "pointer", "the option around it still shows the hand");
});

await test("anything else is left alone: plain text, a group marked disabled, a link (the browser's own hand), and a screen's canvas, video and picture", () => {
  for (const id of ["plain", "plain-aria-disabled", "link", "screen", "canvas", "video", "img"]) assert.equal(cursor(id), null, id);
});

await test("the source: one commented block in app/globals.css, in @layer base", () => {
  const at = source.indexOf("scripts/test-pointer-cursor.mjs");
  assert.ok(at > 0, "the block says where it's tested");
  const block = source.slice(source.indexOf("@layer base {", at), source.indexOf("\n}\n", at));
  for (const s of ['[role="button"]', "button,", "summary,", "select,", ':disabled,', '[aria-disabled="true"]', '[data-disabled]:not([data-disabled="false"])']) assert.ok(block.includes(s), s);
});

console.log(`\n${passed} passed`);
