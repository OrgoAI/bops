import "server-only";
import { execFile } from "node:child_process";
import { BLOCKER_LABEL, DISPLAYS, live, workspaceOf, type Session } from "@/lib/types";
import { currentPage } from "./local";
import { sameComputer, screenEndpoint, workComputer } from "./screens";
import { bot, getState, ownerName } from "./store";

/**
 * A bot's computer, in a few lines, for the bot itself: what each screen is doing (its threads,
 * its helpers, a watched site, the user in control, or what's open on a free one), what's waiting on
 * the user, and what's up next. Built from the same state the Computer panel draws, so what a bot
 * believes about its screens is what the user sees. Chat turns, calls and thread turns all get it.
 */
export async function computerBriefing(botId: string, opts: { thread?: string } = {}): Promise<string> {
  const b = bot(botId);
  if (!b) return "";
  const state = getState();
  const owner = ownerName();
  const mac = state.host === "mac";
  // The computer it works on: its own, or the main bot's when it shares.
  const c = workComputer(b);
  const shared = c.id !== b.id;
  if (!mac && (!c.computerId || c.computerStatus !== "ready"))
    return c.computerStatus === "cloning" ? `${shared ? `${c.name}'s computer, which you share,` : "Your computer"} is being set up.` : "You don't have a computer yet; it's made on your first task.";

  const mine = state.sessions.filter((s) => s.botId === botId);
  const running = mine.filter(live);
  // Other bots' threads on a computer this bot shares: their screens aren't free.
  const mates = state.sessions.filter((s) => s.botId !== botId && live(s) && sameComputer(s.botId, botId));
  const who = (s: Session) => (opts.thread === s.id ? "this thread (you)" : opts.thread ? `your other thread "${s.title}"` : `you, on "${s.title}"`);
  const helperName = (s: Session, d: number) => {
    const at = s.helperOrder?.indexOf(d) ?? -1;
    return at >= 0 ? s.helperNames?.[at] : undefined;
  };
  // What's open on each screen, read from its browser (quick, and only where Bops can reach it).
  const pages = await Promise.all(
    DISPLAYS.map(async (d) => {
      const ep = screenEndpoint(b, d);
      return ep ? await Promise.race([currentPage(ep).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]) : null;
    }),
  );
  const pageText = (i: number) => {
    const p = pages[i];
    if (!p || /^(chrome:\/\/newtab|chrome-extension:|http:\/\/127\.0\.0\.1:7600)/.test(p.url)) return "your home screen";
    if (p.url === "about:blank") return "a blank page";
    let host = p.url;
    try {
      host = new URL(p.url).hostname.replace(/^www\./, "");
    } catch {
      /* keep the address */
    }
    return `${p.title ? `"${p.title.slice(0, 70)}" · ` : ""}${host}`;
  };

  const lines = DISPLAYS.map((d, i) => {
    const n = i + 1;
    if (state.takeover && sameComputer(state.takeover.botId, botId) && state.takeover.display === d) return `Screen ${n}: ${owner} has control right now; don't touch it.`;
    const thread = running.find((s) => s.display === d);
    if (thread) {
      const now = thread.activity ?? thread.steps.filter((st) => st.tool !== "setup" && st.tool !== "note").at(-1)?.detail;
      const stuck = thread.blocker ? ` · stuck: needs ${owner} (${BLOCKER_LABEL[thread.blocker]})` : "";
      return `Screen ${n}: ${who(thread)}${now ? ` · now: ${now.slice(0, 80)}` : ""}${stuck} · showing ${pageText(i)}.`;
    }
    const parent = running.find((s) => s.helperScreens?.includes(d));
    if (parent) {
      const name = helperName(parent, d);
      const task = parent.helperTasks?.[d];
      return `Screen ${n}: ${name ? `helper ${name}` : "a helper"} for ${opts.thread === parent.id ? "this thread" : `"${parent.title}"`}${task ? ` · ${task}` : ""} · showing ${pageText(i)}.`;
    }
    const other = mates.find((s) => s.display === d || s.helperScreens?.includes(d));
    if (other) return `Screen ${n}: ${bot(other.botId)?.name ?? "another bot"} is working there on "${other.title}"; it's not yours, don't touch it.`;
    const w = state.watches?.find((x) => !x.mac && sameComputer(x.botId, botId) && x.display === d);
    if (w)
      return `Screen ${n}: watched for ${owner} · ${w.site}, for ${w.lookFor}${w.away ? " · paused: it shows something else right now" : ""}${w.alert ? ` · waiting for ${owner}: "${w.alert.text}"` : ""}. Leave it on ${w.site}; don't use it for other work.`;
    return `Screen ${n}: free · ${pageText(i)} is open.`;
  });

  const waiting = [
    ...running.filter((s) => s.blocker).map((s) => `"${s.title}" needs ${owner}: ${BLOCKER_LABEL[s.blocker!]}`),
    ...(state.watches ?? []).filter((w) => w.botId === botId && w.alert).map((w) => `something new on ${w.site}: "${w.alert!.text}"`),
  ];
  const queued = running.filter((s) => s.status === "queued").map((s) => `"${s.title}"`);
  const recent = mine
    .filter((s) => !live(s) && s.endedAt && Date.now() - s.endedAt < 30 * 60_000)
    .slice(-3)
    .map((s) => `"${s.title}" (${s.status === "done" ? "done" : "didn't finish"})`);

  const ownersMac = await macBriefing(botId);
  return [
    `${shared ? `The computer you share with ${c.name}` : "Your computer"}${mac ? ` (browsers on ${owner}'s Mac)` : ""}, as of now:`,
    ...lines,
    ...(waiting.length ? [`Waiting on ${owner}: ${waiting.join("; ")}.`] : []),
    ...(queued.length ? [`Up next: ${queued.join(", ")}.`] : []),
    ...(recent.length ? [`Finished in the last half hour: ${recent.join(", ")}.`] : []),
    ...(ownersMac ? ["", ownersMac] : []),
  ].join("\n");
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { timeout: 1500 }, (_e, out) => resolve(String(out ?? "").trim())));

/** The user's own Mac, when bots can work there: ready or not, what they're in, what's allowed, what's running. */
async function macBriefing(botId: string) {
  const state = getState();
  const m = state.mac;
  const owner = ownerName();
  // Windows on the user's Mac that Jev watches for them (they work whether or not bots can use the Mac).
  const watched = (state.watches ?? []).filter((w) => w.mac);
  const ago = (t?: number) => (t ? `${Math.max(1, Math.round((Date.now() - t) / 60_000))} min ago` : "not yet");
  const watching = watched.length
    ? `Windows watched on ${owner}'s Mac (${watched.length}; Bops reads each when it changes, and ${bot(watched[0].botId)?.name ?? "the main bot"} gives the heads-up): ${watched
        .map((w) => `"${w.mac!.title}" in ${w.mac!.app}, for ${w.lookFor}, last read ${ago(w.readAt)}${w.away ? ", paused: the window shows something else right now" : ""}${w.alert ? `, waiting for ${owner}: "${w.alert.text}"` : ""}`)
        .join("; ")}.`
    : `No windows on ${owner}'s Mac are being watched.`;
  if (!m) return watching;
  if (!m.ready) return [`${owner}'s Mac: not available to bots (${m.reason ?? "not set up"}).`, watching].join("\n");
  // What the user is doing right now, so work on their Mac stays out of their way.
  const [front, locked] = await Promise.all([
    run("/usr/bin/lsappinfo", ["info", "-only", "name", "front"]).then((o) => /"LSDisplayName"="([^"]+)"/.exec(o)?.[1] ?? /"name"="([^"]+)"/i.exec(o)?.[1] ?? ""),
    run("/usr/sbin/ioreg", ["-n", "Root", "-d1"]).then((o) => /CGSSessionScreenIsLocked"=Yes/.test(o)),
  ]);
  const onMac = state.sessions.filter((s) => s.runsOn === "mac" && live(s));
  const yours = onMac.filter((s) => s.botId === botId);
  return [
    `${owner}'s Mac: available through computer use${locked ? " (screen locked)" : front ? `; ${owner} is in ${front} right now` : ""}.`,
    `Apps bots may always use there: ${m.alwaysApps.length ? m.alwaysApps.join(", ") : `none yet (${owner} approves each app the first time)`}.`,
    ...(yours.length ? [`Your tasks on ${owner}'s Mac: ${yours.map((s) => `"${s.title}"${s.activity ? ` (${s.activity})` : ""}`).join("; ")}.`] : []),
    ...(onMac.length > yours.length ? [`Other bots are working on ${owner}'s Mac too (${onMac.length - yours.length}).`] : []),
    ...(m.approvals.length ? [`Waiting on ${owner}'s OK: ${m.approvals.map((a) => a.message).join("; ")}.`] : []),
    watching,
  ].join("\n");
}

/**
 * The whole team at a glance, for the main bot (Sam runs the team): each bot's live work and where
 * it runs, what's waiting on the user, what finished lately. Same state the app draws, so "what's
 * everyone doing?" and "who's free?" have true answers.
 */
export function teamBriefing(mainId: string) {
  const state = getState();
  const main = state.bots.find((b) => b.id === mainId);
  const others = state.bots.filter((b) => b.id !== mainId && workspaceOf(b) === workspaceOf(main));
  if (!others.length) return "Your team: just you so far.";
  const now = Date.now();
  const owner = ownerName();
  const where = (s: Session) => (s.runsOn === "mac" ? `on ${owner}'s Mac` : s.askWhere ? `waiting for ${owner} to pick Mac or cloud` : "in the cloud");
  const lines = others.map((b) => {
    const mine = state.sessions.filter((s) => s.botId === b.id);
    const running = mine.filter(live);
    const doing = running.map((s) => `"${s.title}" (${s.status === "queued" ? "up next" : (s.activity ?? "working")}, ${where(s)}${s.blocker ? `, stuck: needs ${owner}, ${BLOCKER_LABEL[s.blocker]}` : ""})`);
    const alerts = (state.watches ?? []).filter((w) => w.botId === b.id && w.alert).map((w) => `heads-up on ${w.site}: "${w.alert!.text}"`);
    const watching = (state.watches ?? []).filter((w) => w.botId === b.id).map((w) => w.site);
    const done = mine
      .filter((s) => !live(s) && s.endedAt && now - s.endedAt < 60 * 60_000)
      .slice(-2)
      .map((s) => `"${s.title}" (${s.status === "done" ? "done" : "didn't finish"})`);
    // A bot that shares works on the main bot's computer (workComputer); it has none of its own.
    const c = workComputer(b);
    const computer = c.id !== b.id ? "Works on your computer." : c.computerStatus === "ready" ? "" : c.computerStatus === "cloning" ? "Its computer is being set up." : "No computer yet.";
    return [
      `- ${b.name} (${b.role}${b.runsOn && b.runsOn !== "auto" ? `, works on ${b.runsOn === "mac" ? `${owner}'s Mac` : "the cloud"}` : ""}):`,
      doing.length ? `working on ${doing.join("; ")}.` : "free.",
      watching.length ? `Watching ${watching.join(", ")}.` : "",
      alerts.length ? `Waiting on ${owner}: ${alerts.join("; ")}.` : "",
      done.length ? `Finished in the last hour: ${done.join(", ")}.` : "",
      computer,
    ]
      .filter(Boolean)
      .join(" ");
  });
  return ["Your team, as of now (you run it):", ...lines].join("\n");
}
