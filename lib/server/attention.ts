import "server-only";
import { botChatId, MAIN_WORKSPACE, workspaceOf } from "@/lib/types";
import { chose, decide } from "./decide";
import { addMessage, getState, ownerName, stateReady, update } from "./store";

/**
 * The user's attention, spent carefully. Each piece of news (something new on a watched screen, a
 * finished task) gets one of three levels from Jev, given what they're doing right now:
 *   now:   worth interrupting them (the screen comes forward, a chime, a notification if Bops is behind)
 *   quiet: it shows where it belongs (the chat, the sidebar's New), no interruption
 *   later: held, and told together in one "While you were busy" message when they're free
 */

export type Level = "now" | "quiet" | "later";

/** Who the user is on a call with, if anyone (calls start and end through lib/server/call.ts). */
const g = globalThis as unknown as { bopsCall?: { botId: string; at: number }; bopsDigestTimer?: ReturnType<typeof setInterval> };
export const callStarted = (botId: string) => (g.bopsCall = { botId, at: Date.now() });
export const callEnded = () => (g.bopsCall = undefined);
/** On a call right now (a call left open by a crash counts for two hours at most). */
const onCall = () => !!g.bopsCall && Date.now() - g.bopsCall.at < 2 * 3600_000;

/** What the user is doing, in words, for Jev. */
function context() {
  const st = getState();
  const lastSaid = [...st.messages].reverse().find((m) => m.role === "user")?.at ?? 0;
  const mins = Math.round((Date.now() - lastSaid) / 60_000);
  return {
    time_for_owner: new Date().toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" }),
    on_a_call: onCall(),
    driving_a_bot_screen: !!st.takeover,
    minutes_since_owner_last_messaged: mins,
  };
}

/**
 * How much of the user's attention this deserves now. `kind` says what it is: news on a watched screen
 * (a person writing to them, a price crossing a line) or a task finishing. Tasks are never held for
 * later (their result is already in the chat). When Jev can't answer: watches interrupt, tasks don't.
 */
export async function urgency(item: { kind: "watch" | "task"; what: string; news: string; lookFor?: string }): Promise<Level> {
  const ctx = context();
  const owner = ownerName();
  const a = await decide(
    { owner_right_now: ctx, item },
    {
      level: {
        type: "choice",
        instructions:
          item.kind === "watch"
            ? `Something new showed up where ${owner} asked to be told (${item.what}, watching for: ${item.lookFor ?? "anything that needs them"}): "${item.news}". Given what ${owner} is doing right now (owner_right_now), how should it reach them? Someone asking them something directly, something time-sensitive, or what they explicitly asked to hear about right away interrupts. Routine news can wait in the chat. Low-value news, while they're on a call or busy, can be held for later.`
            : `A task ${owner}'s assistant did just finished (${item.what}): "${item.news.slice(0, 600)}". Given what ${owner} is doing right now (owner_right_now), is it worth interrupting them (they asked for it and are waiting on it, it needs their decision, or it's time-sensitive), or can it just wait in the chat?`,
        criteria:
          item.kind === "watch"
            ? { now: "Interrupt them now", quiet: "Show it, no interruption", later: "Hold it and tell them later, with other news" }
            : { now: "Interrupt them now", quiet: "Let it wait in the chat" },
      },
    },
  );
  const c = chose(a?.level);
  if (!c) return item.kind === "watch" ? "now" : "quiet";
  return c.choice as Level;
}

/* ---------------- Held for later ---------------- */

/** Hold a piece of news, to tell the user with the rest when they're free. */
export function holdForLater(item: { botId: string; text: string; watchId?: string }) {
  update((s) => (s.digest ??= []).push({ ...item, at: Date.now() }));
}

/**
 * Tell the user what was held, in one message from the workspace's main bot, once they're free: not
 * on a call, and either they've messaged since the first item (they're around) or it's waited 20 minutes.
 * Checked every minute.
 */
function flush() {
  const st = getState();
  const held = st.digest ?? [];
  if (!held.length || onCall()) return;
  const first = Math.min(...held.map((h) => h.at));
  const around = st.messages.some((m) => m.role === "user" && m.at > first);
  if (!around && Date.now() - first < 20 * 60_000) return;
  // One message per workspace, from its main bot.
  const byWs = new Map<string, typeof held>();
  for (const h of held) {
    const b = st.bots.find((x) => x.id === h.botId);
    const ws = workspaceOf(b);
    byWs.set(ws, [...(byWs.get(ws) ?? []), h]);
  }
  update((s) => (s.digest = []));
  for (const [ws, items] of byWs) {
    const main = st.bots.find((b) => b.isMain && workspaceOf(b) === ws) ?? st.bots.find((b) => b.isMain && workspaceOf(b) === MAIN_WORKSPACE);
    if (!main) continue;
    addMessage({ chatId: botChatId(main.id), role: "bot", botId: main.id, text: `While you were busy:\n${items.map((h) => `• ${h.text}`).join("\n")}` });
  }
}

if (g.bopsDigestTimer) clearInterval(g.bopsDigestTimer);
g.bopsDigestTimer = setInterval(() => stateReady() && flush(), 60_000);

/** A finished task's result: if Jev says it's worth interrupting the user for, it chimes (and notifies, if Bops is behind). */
export function pingIfWorthIt(messageId: string, title: string, answer: string) {
  void urgency({ kind: "task", what: title, news: answer }).then((level) => {
    if (level !== "now") return;
    update((s) => {
      const m = s.messages.find((x) => x.id === messageId);
      if (m) m.ping = true;
    });
  });
}
