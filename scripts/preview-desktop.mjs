// A look at a bot's computer as Bops dresses it (lib/server/desktop.ts), without a computer: its home
// screen and wallpaper, written to files and screenshot in Chrome. NEXT_PUBLIC_BOPS_BRAND picks the brand.
// Usage: NEXT_PUBLIC_BOPS_BRAND=momentum node --conditions=react-server scripts/preview-desktop.mjs <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STAND_INS = new Set(["mac", "relay", "desktop-x", "mirror"]);
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const out = process.argv[2] ?? "/tmp/desktop-preview";
mkdirSync(out, { recursive: true });
const D = await import(`${root}/lib/server/desktop.ts`);
const boppy = { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true };
const pages = D.desktopPages(boppy, "inbox");
writeFileSync(join(out, "home.html"), pages.home.replace("fetch('/apps')", "Promise.resolve({json:()=>[{id:'a',name:'Google Chrome'},{id:'b',name:'Calculator'},{id:'c',name:'LibreOffice Calc'},{id:'d',name:'Xfce Terminal'},{id:'e',name:'Sublime Text'}]}).then?.call(Promise.resolve({json:()=>[{id:'a',name:'Google Chrome'},{id:'b',name:'Calculator'},{id:'c',name:'LibreOffice Calc'},{id:'d',name:'Xfce Terminal'},{id:'e',name:'Sublime Text'}]}),x=>x)"));
writeFileSync(join(out, "wall.html"), pages.wallpaper);
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
for (const f of ["home", "wall"]) {
  await p.goto(pathToFileURL(join(out, `${f}.html`)).href);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: join(out, `${f}.png`) });
}
await b.close();
console.log(`wrote ${out}/home.png and wall.png`);
