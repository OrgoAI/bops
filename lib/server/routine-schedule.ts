import type { Schedule } from "@/lib/types";

export class InvalidRoutineScheduleError extends Error {
  constructor() {
    super("Invalid schedule: use HH:mm (00:00–23:59), a weekday from 0 to 6, or a finite one-off timestamp.");
  }
}

/** Check schedules before Date can turn invalid hours or minutes into a different time. */
export function validSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schedule = value as Record<string, unknown>;
  if (schedule.kind === "once") return typeof schedule.at === "number" && Number.isFinite(schedule.at);
  if (schedule.kind !== "daily" && schedule.kind !== "weekdays" && schedule.kind !== "weekly") return false;
  if (typeof schedule.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return false;
  return schedule.kind !== "weekly" || (typeof schedule.day === "number" && Number.isInteger(schedule.day) && schedule.day >= 0 && schedule.day <= 6);
}
