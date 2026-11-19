"use client";

import { useState } from "react";
import { workBot, workspaceOf, type AppState, type Bot, type Workspace } from "@/lib/types";
import { AskInPlace, currentWorkspace, post } from "./ui";

/**
 * Settings, General: whether the open workspace runs everything in the cloud (cloud/turns.ts allCloud: its bots answer on
 * their own computers, Your Apps and the team's changes run there too, even with every Mac closed). Bops Cloud keeps the
 * switch and writes it on the workspace (Workspace.chatOn, chatAuto, chatTrouble). Turned on it sends "cloud", a choice
 * Bops Cloud never moves by itself; turned off it sends "mac", the owner's Mac, and asks first every time. Never
 * disabled. Shown to the owner and an Admin, for a workspace with a bot that works on a computer of its own (one set to
 * work on the Mac counts: in the cloud it works on its computer). On, it says what keeps it from answering now
 * (CHAT_TROUBLE): what Bops Cloud said (Workspace.chatTrouble), else, to the owner, a bot with no computer or a group
 * whose bots work on different computers.
 */

/** `closed`: Bops Cloud won't give the choice back to it here (Workspace.chatAutoOff); the switch works all the same. `trouble`: why it can't answer now. */
export type ChatSwitchView = { wsId: string; on: boolean; line: string; closed: boolean; trouble?: string };

/** The words under the switch, as the workspace stands. */
export const CHAT_LINES = {
  cloud: "Chats, Your Apps and your team's changes run in the cloud, even with your Mac closed. Slack, texts and some routines still wait for your Mac.",
  soon: "Everything moves to the cloud once your bots' computers are ready. Until then your Mac does it.",
  mac: "Your Mac does the work while Bops is open there. Your team waits while it's closed.",
  closed: "Your Mac does the work while Bops is open there. Your team waits while it's closed.",
};
/** The same, for an Admin of a workspace shared with them: the owner's bots and Mac. */
export const CHAT_LINES_SHARED = {
  cloud: "Chats, Your Apps and the team's changes run in the cloud, even with the owner's Mac closed. Slack, texts and some routines still wait for that Mac.",
  soon: "Everything moves to the cloud once the bots' computers are ready. Until then the owner's Mac does it.",
  mac: "The owner's Mac does the work while Bops is open there. The team waits while it's closed.",
  closed: "The owner's Mac does the work while Bops is open there. The team waits while it's closed.",
};
/** Asked before turning it off, every time. */
export const OFF_ASK = { title: "Turn off the cloud?", line: "Your Mac does the work again, and your team waits for it while your Mac is closed." };
export const OFF_ASK_SHARED = { title: "Turn off the cloud?", line: "The owner's Mac does the work again, and the team waits for it while that Mac is closed." };

/** The switch's title, and what it does. */
export const CHAT_TITLE = "Cloud";
export const CHAT_LABEL = "Run everything in the cloud";

/**
 * Why a workspace in the cloud can't answer now, by the note Bops Cloud keeps (Workspace.chatTrouble.note, cloud/turns.ts
 * NOTES' keys), naming the bot whose computer it is; `owner` for the words that name them.
 */
export const CHAT_TROUBLE: Record<string, (bot: string, owner: string) => string> = {
  stopped: (bot) => `${bot}'s computer is stopped, so ${bot} can't answer. Start it again in ${bot}'s settings.`,
  deleted: (bot) => `${bot}'s computer was deleted. Give ${bot} a computer in ${bot}'s settings.`,
  noHours: (bot) => `${bot}'s computer is out of Free hours for today.`,
  hourly: (bot) => `${bot}'s computer is paid by the hour, and the owner hasn't let messages wake it.`,
  noCredit: (bot) => `The owner is out of Orgo credit, so ${bot}'s computer can't wake up.`,
  paused: (bot) => `${bot}'s computer is paused.`,
  cant: (bot) => `${bot}'s computer couldn't wake up.`,
  noRunner: (bot) => `${bot}'s computer isn't set up to answer yet. The owner's Bops sets it up the next time it opens.`,
  old: (bot) => `${bot}'s computer runs an older Bops. The owner's Bops updates it the next time it opens.`,
  noComputer: (bot) => `${bot} has no computer, so ${bot} can't answer in the cloud. Give ${bot} a computer in ${bot}'s settings.`,
  split: () => "A group's bots work on different computers, so that group can't answer in the cloud yet.",
  // The owner's account is set to This Mac (Settings): the computer's own keeper won't set up its Bops (cloud/turns.ts, from its report).
  accountMac: (bot) => `Your bots work on This Mac in Settings, so ${bot}'s computer doesn't answer in the cloud. Set Settings to Cloud.`,
  // Said only while the computer's own keeper sets its Bops up or updates it (cloud/turns.ts selfNote), and of a shared computer Bops can't run on.
  settingUp: (bot) => `${bot}'s computer is setting up its Bops. It answers in a few minutes.`,
  updating: (bot) => `${bot}'s computer is updating its Bops. It answers in a few minutes.`,
  sharedOff: (bot) => `${bot}'s computer is shared with the team, and Orgo doesn't let Bops run on it yet.`,
};

/** Said instead of turning the switch on, sending nothing, while the owner's account is set to This Mac (/api/runs-on: "mac"). */
export const ACCOUNT_MAC = "Your bots work on This Mac in Settings. Set Settings to Cloud first, then turn this on.";

/** The hint under a bot's "Your Mac" choice, which a workspace in the cloud doesn't take (bot-settings-ai.tsx, bot-panel.tsx). */
export const MAC_OFF_HINT = "This workspace runs in the cloud, so its bots work on their own computers.";

/** Whether bot `b`'s workspace runs everything in the cloud (Workspace.chatOn "cloud"): its "Your Mac" choice is off then. */
export const inCloud = (state: Pick<AppState, "workspaces">, b: Pick<Bot, "workspaceId">) => state.workspaces?.some((w) => w.id === workspaceOf(b) && w.chatOn === "cloud") ?? false;

/** What keeps workspace `w` from answering in the cloud now, in CHAT_TROUBLE's words, or undefined. */
function troubleOf(state: AppState, w: Workspace): string | undefined {
  const name = (id: string | undefined) => state.bots.find((b) => b.id === id)?.name?.trim() || "A bot";
  const owner = state.shared?.owner ?? state.owner?.name ?? "The owner";
  const t = w.chatTrouble;
  if (t && Object.hasOwn(CHAT_TROUBLE, t.note)) return CHAT_TROUBLE[t.note](name(t.botId), owner);
  // What the owner's own state shows (an Admin's copy has only what they see): a bot with no computer, a group split.
  if (state.shared) return undefined;
  const bots = state.bots.filter((b) => workspaceOf(b) === w.id);
  const none = bots.find((b) => !workBot(b, state.bots).computerId);
  if (none) return CHAT_TROUBLE.noComputer(name(none.id), owner);
  const split = (state.chats ?? []).some((c) => {
    if (c.kind !== "group" || (c.workspaceId ?? workspaceOf(state.bots.find((b) => b.id === c.botIds[0]) ?? {})) !== w.id) return false;
    const on = new Set(c.botIds.map((id) => state.bots.find((b) => b.id === id)).map((b) => (b ? (workBot(b, state.bots).computerId ?? "").toLowerCase() : "")));
    return on.size > 1;
  });
  return split ? CHAT_TROUBLE.split("", owner) : undefined;
}

/** The switch for the open workspace, or null where there's none (see above). */
export function chatSwitchOf(state: AppState): ChatSwitchView | null {
  // An Admin of a shared workspace says it too, once its Bops Cloud takes an Admin's choice (it said adminActs or ownerOld).
  const admin = state.shared?.role === "admin" && (!!state.shared.adminActs || !!state.shared.ownerOld);
  if ((state.shared && !admin) || (!state.shared && state.host === "mac")) return null;
  const wsId = currentWorkspace(state);
  const w = state.workspaces?.find((x) => x.id === wsId);
  if (!w) return null;
  // (A shared workspace's bots' computers stay in its copy: an Admin's screens say which bots have one.) A bot set to
  // work on the Mac counts: in the cloud it works on its own computer.
  const computers = state.shared ? !!state.shared.screens?.length : state.bots.some((b) => workspaceOf(b) === wsId && !!workBot(b, state.bots).computerId);
  if (!computers) return null;
  const lines = state.shared ? CHAT_LINES_SHARED : CHAT_LINES;
  const closed = w.chatAutoOff === true;
  if (w.chatOn === "cloud") {
    const trouble = troubleOf(state, w);
    return { wsId, on: true, line: lines.cloud, closed, ...(trouble ? { trouble } : {}) };
  }
  if (w.chatOn !== "mac" && w.chatAuto) return { wsId, on: true, line: lines.soon, closed };
  return { wsId, on: false, line: closed ? lines.closed : lines.mac, closed };
}

/**
 * Turn it on ("cloud": everything there, a choice) or off (the Mac, chosen). Bops' words when it didn't go, else null. The
 * owner's own turned on while their account is set to This Mac (Settings: /api/runs-on says "mac") sends nothing and says
 * so (ACCOUNT_MAC): their bots' computers wouldn't set up their Bops to answer. Not known (no answer): sent as before.
 */
export async function setChat(wsId: string, on: boolean, shared = false): Promise<string | null> {
  const chat = on ? "cloud" : "mac";
  if (on && !shared) {
    const runsOn = await fetch("/api/runs-on", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { runsOn?: unknown } | null) => j?.runsOn)
      .catch(() => undefined);
    if (runsOn === "mac") return ACCOUNT_MAC;
  }
  // (An Admin's, of a shared workspace: through Bops Cloud, kept as an Admin's choice: lib/server/shared-people.ts.)
  const res = await (shared ? post("/api/workspaces/shared/settings", { chat }, "PATCH") : post("/api/workspaces", { id: wsId, chat }, "PATCH")).catch(() => null);
  if (res?.ok) return null;
  const j = ((await res?.json().catch(() => null)) ?? {}) as { error?: unknown };
  return typeof j.error === "string" && j.error ? j.error : "Couldn't reach Bops. Try again.";
}

export function ChatSwitch({ state }: { state: AppState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Turning it off: asked first, in place, for the switch as it was then (its workspace, on): one that changed meanwhile
  // (another Mac turned it off, another workspace open) isn't asked about.
  const [asking, setAsking] = useState<string | null>(null);
  const view = chatSwitchOf(state);
  if (!view) return null;
  const ask = state.shared ? OFF_ASK_SHARED : OFF_ASK;
  const seen = `${view.wsId}:${view.on}`;
  const flip = async (on = !view.on) => {
    setAsking(null);
    setBusy(true);
    try {
      setError(await setChat(view.wsId, on, !!state.shared));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
      <span className="text-[13px] font-semibold">{CHAT_TITLE}</span>
      <div className="flex items-center gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium">{CHAT_LABEL}</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">{view.line}</span>
          {view.trouble && (
            <span data-chat-trouble className="text-[12px] leading-4 text-[#B54708]">
              {view.trouble}
            </span>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={view.on}
          aria-label={CHAT_LABEL}
          disabled={busy}
          onClick={() => (view.on ? setAsking(seen) : void flip())}
          className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-60 ${view.on ? "bg-ink" : "bg-[#E6E6E3]"}`}
        >
          <span className={`absolute top-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-[left] ${view.on ? "left-[19px]" : "left-[3px]"}`} />
        </button>
      </div>
      {asking === seen && <AskInPlace compact title={ask.title} line={ask.line} action="Turn off" focus="cancel" busy={busy} onConfirm={() => void flip(false)} onCancel={() => setAsking(null)} />}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}
