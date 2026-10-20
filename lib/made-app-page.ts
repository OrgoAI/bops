import { transform } from "sucrase";

/**
 * The page an app a bot made runs in (lib/server/made-apps.ts builds and keeps the apps): its TSX
 * compiled, React and Tailwind from Bops (public/made-apps), and `window.bops`, which talks to the
 * window around the page by message. No server-only imports, so scripts/test-made-apps.mjs can run it.
 */

/** Modules an app may import: React, which the page carries. */
export const MODULES = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];

/** TSX to plain script for the page: imports become require() of the modules it carries. */
export function compile(code: string) {
  return transform(code, { transforms: ["typescript", "jsx", "imports"], production: true }).code;
}

/**
 * `window.bops` inside the app: each call goes to the window (the frame's parent), which answers it.
 * A web link it shows opens in a tab of Bops (the sandbox allows no windows of its own).
 * localStorage and sessionStorage throw in a sandboxed page, so code that reaches for them gets a
 * stand-in that forgets on reload instead of crashing (bops.data is where an app keeps things).
 */
const BRIDGE = `(()=>{let n=0;const w=new Map();
addEventListener("message",e=>{if(e.source!==parent)return;const m=e.data;if(!m||m.bops!==1||!w.has(m.id))return;const p=w.get(m.id);w.delete(m.id);m.error?p[1](new Error(m.error)):p[0](m.result)});
const call=(method,args)=>new Promise((ok,no)=>{const id=++n;w.set(id,[ok,no]);parent.postMessage({bops:1,id,method,args},"*")});
window.bops={data:{get:k=>call("data.get",{key:k}),set:(k,v)=>call("data.set",{key:k,value:v}),delete:k=>call("data.delete",{key:k}),list:p=>call("data.list",{prefix:p})},ask:(prompt,o)=>call("ask",{prompt,json:!!(o&&o.json)}),bot:(prompt,o)=>call("bot",{prompt,json:!!(o&&o.json)})};
const report=m=>parent.postMessage({bops:1,event:"error",message:String(m).slice(0,1500)},"*");
window.__bopsReport=report;addEventListener("error",e=>report(e.message));addEventListener("unhandledrejection",e=>report((e.reason&&e.reason.message)||e.reason));
const mem=()=>{const d=new Map();return{getItem:k=>d.has(String(k))?d.get(String(k)):null,setItem:(k,v)=>void d.set(String(k),String(v)),removeItem:k=>void d.delete(String(k)),clear:()=>d.clear(),key:i=>[...d.keys()][i]??null,get length(){return d.size}}};
for(const k of["localStorage","sessionStorage"])try{Object.defineProperty(window,k,{value:mem(),configurable:true})}catch{}
addEventListener("click",e=>{const a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;const u=a.href;if(!/^https?:/i.test(u))return;e.preventDefault();parent.postMessage({bops:1,event:"open",url:u},"*")},true);
parent.postMessage({bops:1,event:"ready"},"*");})();`;

/** Runs the compiled app: React from the page, its default export rendered, and a problem shown and reported, not a blank page. */
const RUN = (compiled: string) => `(()=>{const mods=window.__bopsModules;const exports={};const module={exports};
const require=n=>{if(n in mods)return mods[n];throw new Error('Apps can only import "react" ("'+n+'" is not there)')};
const show=e=>{const r=document.getElementById("root");r.innerHTML="";const d=document.createElement("div");d.style.cssText="font:14px system-ui;padding:24px;color:#0A0A0A";d.textContent="This app hit a problem: "+((e&&e.message)||e);r.appendChild(d);window.__bopsReport(String((e&&e.message)||e))};
class Catch extends React.Component{constructor(p){super(p);this.state={e:null}}static getDerivedStateFromError(e){return{e}}componentDidCatch(e){window.__bopsReport(String(e&&e.message||e))}render(){return this.state.e?React.createElement("div",{style:{font:"14px system-ui",padding:24}},"This app hit a problem: "+this.state.e.message):this.props.children}}
try{(function(exports,require,module,React){
${compiled}
})(exports,require,module,window.React);const App=module.exports.default||exports.default;if(typeof App!=="function")throw new Error("The app has no default export.");
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Catch,null,React.createElement(App)))}catch(e){show(e)}})();`;

/** The whole page: the app's code, compiled, with the runtimes passed in (their text). A problem compiling shows in the app, not as a blank page. */
export function appPage(title: string, code: string, runtimes: { react: string; tailwind: string }) {
  let compiled: string;
  try {
    compiled = compile(code);
  } catch (e) {
    compiled = `throw new Error(${JSON.stringify(`The code didn't compile: ${(e as Error).message}`)});`;
  }
  const safe = (js: string) => js.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<>&"]/g, "")}</title>
<style>html,body{margin:0;min-height:100%;background:#fff;color:#0A0A0A;font-family:Geist,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}#root{min-height:100vh}</style>
<script>${safe(runtimes.react)}</script>
<script>${safe(runtimes.tailwind)}</script>
<script>${BRIDGE}</script>
</head><body><div id="root"></div><script>${safe(RUN(compiled))}</script></body></html>`;
}
