import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mascotSvg } from "@/lib/mascot";
import { botWash } from "@/lib/look";
import { live, type Bot } from "@/lib/types";
import { chose, decide } from "./decide";
import { orgo } from "./orgo";
import { sameComputer } from "./screens";
import { getState } from "./store";

/**
 * Dresses a bot's Orgo computer as the bot's own: its wallpaper (the bot's wash, with faint line
 * doodles), Chrome in its color, a home screen on every new tab (mascot, clock, the computer's
 * real apps), and a dock on each screen. Bops renders the bot-specific pages here and the
 * computer's bops-desktop script applies them.
 */

const hex = (c: string) => c.replace("#", "").padEnd(6, "0");
/** Mix a color toward white (t = how much of the color stays). */
function tint(color: string, t: number) {
  const h = hex(color);
  const ch = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) * t + 255 * (1 - t));
  return `#${[0, 2, 4].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}
const accent = (b: Bot) => (b.isMain ? "#E9FF3B" : b.color);

/**
 * Each bot's computer has its own look: its color, and a motif of faint line doodles scattered over
 * the wallpaper and home screen like stickers on a laptop. The built-in bots' motifs fit their jobs;
 * a new bot gets one picked from its role.
 */
const MOTIFS = {
  outbound: {
    about: "Sales, outreach, marketing, growth, prospecting, sending messages out",
    icons: [
      "M3 11l18-8-8 18-2-8-8-2zM11 13l10-10", // paper plane
      "M3 6h18v12H3zM3 6l9 7 9-7", // envelope
      "M3 10v4h3l7 4V6L6 10H3zM17 9a4 4 0 0 1 0 6", // megaphone
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", // target
      "M5 19L19 5M9 5h10v10", // arrow out
      "M12 2v6M12 16v6M2 12h6M16 12h6", // sparkle
    ],
  },
  recruiting: {
    about: "Recruiting, hiring, people, candidates, HR, interviews",
    icons: [
      "M7 20h10M8 20l1-9h6l1 9M7 7V4h2v2h2V4h2v2h2V4h2v3l-2 4H9L7 7z", // rook
      "M12 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 20c1-4 4-6 7-6s6 2 7 6", // person
      "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 15l5 5", // magnifier
      "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z", // star
      "M3 6h18v12H3zM7 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0M13 10h5M13 14h5", // id card
      "M4 5h16v10H9l-5 4z", // chat
    ],
  },
  inbox: {
    about: "Email, inbox, messages, support, scheduling, reading and replying",
    icons: [
      "M3 6h18v12H3zM3 6l9 7 9-7", // envelope
      "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", // eye
      "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5", // tray
      "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20h4", // bell
      "M4 12l5 5L20 6", // check
      "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5", // at
    ],
  },
  finance: {
    about: "Finance, money, accounting, invoices, payments, budgets, numbers",
    icons: [
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v10M15 9.5c0-1.2-1.3-2-3-2s-3 .8-3 2 1.3 1.8 3 2 3 .8 3 2-1.3 2-3 2-3-.8-3-2", // coin
      "M12 20C7 16 3 13 3 8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9 2.5C21 13 17 16 12 20z", // heart
      "M3 20h18M5 16l4-5 4 3 6-8", // chart
      "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6", // receipt
      "M3 7h16v12H3zM3 7l12-3v3M15 13h2", // wallet
      "M12 2v6M12 16v6M2 12h6M16 12h6", // sparkle
    ],
  },
  chief: {
    about: "Chief of staff, running the team, planning, coordination, operations",
    icons: [
      "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z", // star
      "M8 4h8v3H8zM6 5H5v16h14V5h-1M8 11h8M8 15h6", // clipboard
      "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5", // calendar
      "M13 2L4 14h7l-1 8 9-12h-7z", // bolt
      "M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3", // highlighter
      "M4 12l5 5L20 6", // check
    ],
  },
  nature: {
    about: "Anything else: creative, research, general help",
    icons: [
      "M12 3c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z", // drop
      "M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4", // sparkle
      "M4 20C4 10 10 4 20 4c0 10-6 16-16 16zM4 20L14 10", // leaf
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v4M12 18v4M2 12h4M18 12h4", // flower
      "M6 14a6 6 0 0 1 12 0M3 14h18M8 14v5h8v-5", // mushroom
      "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 4v16M4 12h16", // citrus
    ],
  },
} as const;
type Motif = keyof typeof MOTIFS;
const BUILT_IN: Record<string, Motif> = { sam: "chief", otto: "outbound", rook: "recruiting", iris: "inbox", penny: "finance" };

/** The bot's motif: its own for the built-in bots, else whichever fits its role best (Jev picks). */
async function motifFor(b: Bot): Promise<Motif> {
  if (BUILT_IN[b.id]) return BUILT_IN[b.id];
  const a = await decide(
    { bot: b.name, job: b.role },
    { motif: { type: "choice", instructions: "Which theme fits this bot's job best?", criteria: Object.fromEntries(Object.entries(MOTIFS).map(([k, m]) => [k, m.about])) } },
    { botId: b.id },
  );
  const pick = chose(a?.motif)?.choice;
  return pick && pick in MOTIFS ? (pick as Motif) : "nature";
}

const SPOTS = [
  [8, 14, 0, 22], [22, 70, 1, -10], [16, 40, 2, 15], [34, 22, 3, 0], [40, 84, 4, 12], [60, 12, 5, -18],
  [70, 58, 0, 8], [84, 26, 2, -25], [90, 76, 1, 30], [52, 90, 3, -6], [76, 88, 5, 20], [6, 88, 4, -14],
] as const;
/** The wallpaper's doodles sit mostly in the margins around the floating window, where they show. */
const EDGE_SPOTS = [
  [2.2, 8, 0, 18], [2.6, 30, 1, -12], [2, 52, 2, 10], [2.8, 74, 3, -8], [3, 92, 4, 14],
  [94.6, 6, 5, -16], [95.2, 26, 0, 12], [94.8, 48, 2, -20], [95, 70, 1, 8], [94.4, 90, 3, -10],
  [14, 1.2, 4, 6], [34, 1.6, 5, -10], [56, 1, 0, 14], [78, 1.4, 1, -6],
  [10, 93, 2, 10], [26, 95, 3, -12], [74, 94, 4, 8], [88, 95, 5, -14],
] as const;

function doodles(motif: Motif, stroke: string, opacity: number, spots: readonly (readonly [number, number, number, number])[] = SPOTS, size = 30) {
  return spots.map(
    ([x, y, d, r]) =>
      `<svg class="d" style="left:${x}%;top:${y}%;transform:rotate(${r}deg);opacity:${opacity}" width="${size}" height="${size}" viewBox="0 0 24 24"><path d="${MOTIFS[motif].icons[d]}" fill="none" stroke="${stroke}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  ).join("");
}

const BASE_CSS = `*{box-sizing:border-box;margin:0}html,body{height:100%}body{font-family:Inter,"Helvetica Neue",Arial,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}.d{position:absolute;pointer-events:none}`;

/** The bot's wash with its doodles drawn in a deeper shade of its color, faint like pencil on paper. */
function wallpaper(b: Bot, motif: Motif) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}body{background:${botWash(b)}}</style></head><body>${doodles(motif, `color-mix(in oklab, ${accent(b)} 55%, #1a1a1a)`, 0.34, EDGE_SPOTS, 40)}</body></html>`;
}

function home(b: Bot, motif: Motif) {
  const mascot = mascotSvg(b.id, b.color, 104);
  const ink = b.isMain ? "#2E3300" : `color-mix(in oklab, ${b.color} 45%, #1a1a1a)`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${b.name}</title>
<link rel="icon" href="/favicon.svg">
<style>${BASE_CSS}
body{background:${tint(accent(b), 0.1)};color:${ink};display:flex;flex-direction:column;align-items:center;padding-top:9vh;overflow:auto}
.bubble{position:relative;max-width:240px;background:#fff;border-radius:14px;padding:10px 30px 10px 13px;font-size:13px;line-height:18px;color:#3a3a38;box-shadow:0 0 0 1px #0000000f,0 8px 20px -10px #00000026}
.bubble:after{content:"";position:absolute;left:50%;bottom:-7px;width:14px;height:14px;background:#fff;transform:translateX(-50%) rotate(45deg);border-radius:2px}
.bubble button{position:absolute;right:8px;top:7px;border:0;background:none;color:#9a9a98;font-size:14px;cursor:pointer}
.mascot{margin-top:14px}
.clock{display:flex;align-items:flex-end;gap:6px;margin-top:10px}.clock b{font-size:64px;font-weight:500;letter-spacing:-.04em;line-height:68px}.clock span{font-size:12px;opacity:.6;padding-bottom:10px}
h1{font-size:19px;font-weight:450;margin-top:6px;opacity:.85}
.apps{display:grid;grid-template-columns:repeat(5,92px);gap:18px 10px;margin-top:46px;padding-bottom:60px}
.app{display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer;border:0;background:none;color:inherit;font:inherit}
.app i{width:46px;height:46px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #0000000d,0 4px 10px -6px #00000040;transition:transform .15s}
.app:hover i{transform:translateY(-2px)}.app img{width:30px;height:30px}.app em{font-style:normal;font-size:12px;opacity:.8;max-width:92px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.app i b{font-size:18px;font-weight:600;color:${ink}}
</style></head><body>${doodles(motif, tint(accent(b), 0.55), 0.55)}
<div class="bubble" id="bubble">This is my computer. Watch me work, or take control when you need to.<button onclick="this.parentNode.style.visibility='hidden'">×</button></div>
<div class="mascot">${mascot}</div>
<div class="clock"><b id="t"></b><span id="ap"></span></div>
<h1>Welcome back, ${b.name}</h1>
<div class="apps" id="apps"></div>
<script>
// The tab's title (the home screen extension shows this page in a frame and can't know the name itself).
const title=()=>parent.postMessage({bopsTitle:document.title},'*');title();setTimeout(title,1500);
const tick=()=>{const d=new Date();let h=d.getHours();document.getElementById('ap').textContent=h<12?'AM':'PM';h=h%12||12;document.getElementById('t').textContent=h+':'+String(d.getMinutes()).padStart(2,'0')};tick();setInterval(tick,10000);
fetch('/apps').then(r=>r.json()).then(apps=>{const g=document.getElementById('apps');for(const a of apps){const el=document.createElement('button');el.className='app';el.innerHTML=(a.icon?'<i><img src="/icon?id='+encodeURIComponent(a.id)+'"></i>':'<i><b>'+a.name[0]+'</b></i>')+'<em></em>';el.querySelector('em').textContent=a.name;el.onclick=()=>fetch('/launch?id='+encodeURIComponent(a.id));g.appendChild(el)}});
</script></body></html>`;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

/**
 * Apply the bot's look to its computer. Chrome restarts onto the home screen unless the bot is
 * mid-task, or `restartChrome` is false (then each screen picks the changes up the next time its
 * Chrome starts, e.g. a screen reset).
 */
export async function applyDesktop(b: Bot, { restartChrome = true }: { restartChrome?: boolean } = {}) {
  if (!b.computerId) return;
  const motif = await motifFor(b);
  const rgb = (c: string) => [0, 2, 4].map((i) => parseInt(hex(c).slice(i, i + 2), 16)).join(";;");
  const look = {
    name: b.name,
    color: b.color,
    motif,
    theme: tint(accent(b), b.isMain ? 0.55 : 0.4),
    dock: rgb(tint(accent(b), 0.18)),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const files: [string, string | Buffer, string][] = [
    ["/opt/bops/desktop/bot.json", JSON.stringify(look), "0644"],
    ["/opt/bops/desktop/wall.html", wallpaper(b, motif), "0644"],
    ["/opt/bops/desktop/home.html", home(b, motif), "0644"],
    ["/opt/bops/desktop/favicon.svg", mascotSvg(b.id, b.color, 32), "0644"],
    ["/opt/bops/bops-home.py", readFileSync(join(process.cwd(), "vm/bops-home.py")), "0755"],
    ["/usr/local/bin/bops-desktop", readFileSync(join(process.cwd(), "vm/bin/bops-desktop")), "0755"],
    ["/usr/local/bin/bops-chrome", readFileSync(join(process.cwd(), "vm/bin/bops-chrome")), "0755"],
    // The screen tools and their ledger, kept current with Bops (threads, helpers, one agent per screen).
    ["/opt/bops/screen_mcp.py", readFileSync(join(process.cwd(), "vm/screen_mcp.py")), "0644"],
    ["/usr/local/bin/bops-screens", readFileSync(join(process.cwd(), "vm/bin/bops-screens")), "0755"],
  ];
  // Mid-task means any bot's task on this computer: bots that share the main bot's work on its Chrome too.
  const busy = !restartChrome || getState().sessions.some((s) => sameComputer(s.botId, b.id) && live(s));
  const run = (command: string, timeout = 60) => orgo.bash(b.computerId!, command, timeout);
  await run(
    "mkdir -p /opt/bops/desktop && (command -v hsetroot >/dev/null && command -v plank >/dev/null && command -v gsettings >/dev/null || (apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq hsetroot plank libglib2.0-bin >/dev/null 2>&1))",
    180,
  );
  // One file per call: Orgo drops very long commands.
  for (const [path, body, mode] of files) {
    const r = await run(`echo ${b64(body)} | base64 -d > ${path} && chmod ${mode} ${path} && echo ok`);
    if (!r.output.includes("ok")) throw new Error(`couldn't write ${path}: ${r.output.slice(0, 200)}`);
  }
  // Restart the home server so it serves this version, then dress the screens. The script runs
  // detached and we poll its log: the dock and home server it starts would otherwise keep the call
  // open until Orgo times it out.
  await run(
    `pkill -f "[b]ash /usr/local/bin/bops-desktop"; pkill -f "[p]ython3 /opt/bops/bops-home.py"; sleep 0.3; : > /var/log/bops/desktop.log; setsid nohup bops-desktop ${busy ? "" : "--restart-chrome"} > /var/log/bops/desktop.log 2>&1 < /dev/null & echo started`,
  );
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const out = (await run("tail -3 /var/log/bops/desktop.log")).output.trim();
    if (out.includes("dressed as")) return out;
  }
  throw new Error("the desktop setup didn't finish in two minutes");
}
