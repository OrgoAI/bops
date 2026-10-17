import "server-only";
import { trackServerEvent } from "./analytics";
import { botChatId, type Routine, type Schedule } from "@/lib/types";
import { startSession } from "./sessions";
import { InvalidRoutineScheduleError, validSchedule } from "./routine-schedule";
import { addMessage, bot, getState, id, ownerName, patchSession, stateReady, update } from "./store";

/**
 * Routines and scheduled asks. Each one belongs to a bot; when it comes due it becomes a thread
 * in that bot's chat, like any other task. Times are local to this machine.
 */

function at(base: Date, time: string) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(base);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** The next time a schedule fires after `from`. */
export function nextRun(schedule: Schedule, from = Date.now()): number | undefined {
  if (schedule.kind === "once") return schedule.at > from ? schedule.at : undefined;
  const start = new Date(from);
  for (let i = 0; i < 8; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const t = at(day, schedule.time);
    if (t.getTime() <= from) continue;
    const dow = t.getDay();
    if (schedule.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (schedule.kind === "weekly" && dow !== schedule.day) continue;
    return t.getTime();
  }
  return undefined;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function clock(time: string) {
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? " AM" : " PM"}`;
}

/** "Weekdays 9:00 AM", "Fridays 4:00 PM", "Once · Oct 4, 10:00 AM". */
export function describeSchedule(schedule: Schedule) {
  if (schedule.kind === "daily") return `Every day ${clock(schedule.time)}`;
  if (schedule.kind === "weekdays") return `Weekdays ${clock(schedule.time)}`;
  if (schedule.kind === "weekly") return `${DAYS[schedule.day]}s ${clock(schedule.time)}`;
  const d = new Date(schedule.at);
  return `Once · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock(`${d.getHours()}:${d.getMinutes()}`)}`;
}

export function createRoutine(
  botId: string,
  title: string,
  goal: string,
  schedule: Schedule,
  opts: { where?: Routine["where"]; reminder?: string; textTo?: Routine["textTo"] } = {},
): Routine {
  if (!validSchedule(schedule)) throw new InvalidRoutineScheduleError();
  const r: Routine = { id: id("rtn"), botId, title, goal, schedule, enabled: true, nextRunAt: nextRun(schedule), where: opts.where, reminder: opts.reminder?.trim() || undefined, textTo: opts.textTo };
  update((s) => s.routines.push(r));
  trackServerEvent("bops_routine_created", {});
  return r;
}

export function setRoutineEnabled(routineId: string, enabled: boolean) {
  update((s) => {
    const r = s.routines.find((x) => x.id === routineId);
    if (!r) return;
    r.enabled = enabled;
    r.nextRunAt = enabled ? nextRun(r.schedule) : undefined;
  });
}

/** Where a routine's task runs from now on: the user's Mac, the cloud, or decided each time (auto). */
export function setRoutineWhere(routineId: string, where: "auto" | "cloud" | "mac") {
  update((s) => {
    const r = s.routines.find((x) => x.id === routineId);
    if (r) r.where = where;
  });
}

export function deleteRoutine(routineId: string) {
  update((s) => (s.routines = s.routines.filter((x) => x.id !== routineId)));
}

/** Run everything that's due. Called on a timer. */
function tick() {
  // Signed out on the Mac app: nobody's routines to run.
  if (!stateReady()) return;
  const now = Date.now();
  for (const r of getState().routines.filter((x) => x.enabled && x.nextRunAt && x.nextRunAt <= now)) {
    const b = bot(r.botId);
    if (!b) continue;
    const chatId = botChatId(b.id);
    // A reminder is just the message, from the bot. Anything else is a task, run where the user asked.
    // Set up by text: it reaches the user's phone too (the reminder now, a task's result when it's done).
    if (r.reminder) {
      const m = addMessage({ chatId, role: "bot", botId: b.id, text: r.reminder });
      // Texted only while the number is still one of the user's verified ones.
      if (r.textTo)
        void import("./phone")
          .then(({ isOwner, sendText }) => (isOwner(r.textTo!.to) ? sendText(r.textTo!.botId, r.textTo!.to, r.reminder!, { tag: m.id }) : undefined))
          .catch((e: Error) => console.warn(`[routines] text: ${e.message}`));
    } else {
      const s = startSession({ botId: b.id, goal: r.goal, title: r.title, chatId, sentVia: "routine", where: r.where ?? "auto" });
      if (r.textTo) patchSession(s.id, { textBack: r.textTo });
      addMessage({ chatId, role: "system", text: `Routine · ${describeSchedule(r.schedule)}`, sessionIds: [s.id] });
    }
    update(() => {
      r.lastRunAt = now;
      r.nextRunAt = r.schedule.kind === "once" ? undefined : nextRun(r.schedule, now);
      if (r.schedule.kind === "once") r.enabled = false;
    });
  }
}

/** A bot's routines, as it sees them (to change or delete them when the user asks). */
export function routinesNote(botIds: string[]) {
  const mine = getState().routines.filter((r) => botIds.includes(r.botId));
  if (!mine.length) return "Routines: none yet.";
  const owner = ownerName();
  const line = (r: Routine) =>
    `${r.id}: "${r.title}"${botIds.length > 1 ? ` (${bot(r.botId)?.name ?? r.botId})` : ""} · ${describeSchedule(r.schedule)}${r.enabled ? "" : " · paused"} · ${r.reminder ? "reminder message" : `task, runs ${r.where && r.where !== "auto" ? `on ${r.where === "mac" ? `${owner}'s Mac` : "the cloud computer"}` : "where Bops picks"}`}`;
  return `Routines (change them with manage_routine):\n${mine.map(line).join("\n")}`;
}

// The timer calls whatever version of tick was loaded last, so edits apply without a restart.
const g = globalThis as unknown as { __bopsRoutines?: NodeJS.Timeout; __bopsRoutineTick?: typeof tick };
g.__bopsRoutineTick = tick;
// One timer: a reload replaces the old one (an older version's timer called its own tick directly).
if (g.__bopsRoutines) clearInterval(g.__bopsRoutines);
g.__bopsRoutines = setInterval(() => g.__bopsRoutineTick?.(), 20_000);
