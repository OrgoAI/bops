// For the test scripts that stand in for lib/server modules with fakes of their own (each lists what it fakes:
// FAKES.store, FAKES.orgo, ...): every other name the real module exports, as a stand-in that says it isn't
// faked when it's called. So a module that starts importing something new from a faked one still loads under
// the test, and a check that reaches it fails saying so, counted with the rest. (An import the stand-in lacked
// stopped the whole script at once, "does not provide an export named", before it counted anything: a gate
// that reads the counts saw nothing fail.)
import { readFileSync } from "node:fs";

/** The names module `url` exports: its exported functions, classes, consts and lets, and its export lists. */
export function exportsOf(url) {
  const src = readFileSync(new URL(url), "utf8");
  const names = [...src.matchAll(/^export (?:async )?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith("type ") && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  return [...new Set(names)];
}

/** Source for the exports of the real module at `url` that `listed` (the test's fakes of module `name`) leaves out. */
export function unfaked(name, url, listed) {
  const have = new Set(listed);
  return exportsOf(url)
    .filter((n) => !have.has(n))
    .map((n) => `\nexport const ${n} = () => { throw new Error(${JSON.stringify(`${name}.${n} isn't faked in this test: add it to its fakes`)}); };`)
    .join("");
}

/** A fake module's whole source (`source`, as test-access and test-runner-apps write theirs), with every export of the real module at `url` it lacks (unfaked). */
export function fill(name, url, source) {
  const has = [...source.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  return source + unfaked(name, url, has);
}
