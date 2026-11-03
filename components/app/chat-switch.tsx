"use client";

import { useState } from "react";
import { workBot, workspaceOf, type AppState } from "@/lib/types";
import { currentWorkspace, post } from "./ui";

/**
 * Settings, General: whether the open workspace's bots answer with every Mac closed (chat through Bops Cloud: its bots'
 * computers answer). Bops Cloud keeps the switch and writes it on the workspace (Workspace.chatOn, chatAuto): it turns
 * on by itself once the bots' computers are ready, unless the owner chose the Mac here. Turned off, it's the Mac's for
 * good (until turned on again here, which gives Bops Cloud the say back). Only the owner sees it, only where Bops Cloud
 * says it applies, and only for a workspace with a bot that works on a computer of its own.
 */

export type ChatSwitchView = { wsId: string; on: boolean; line: string };

/** The words under the switch, as the workspace stands. */
export const CHAT_LINES = {
  cloud: "Your bots answer from their own computers, even with every Mac closed.",
  soon: "Your bots will answer from their own computers once those are ready. Until then your Mac answers.",
  mac: "Your bots answer from your Mac while Bops is open.",
};
/** The same, for an Admin of a workspace shared with them: the owner's bots and Mac. */
export const CHAT_LINES_SHARED = {
  cloud: "The bots answer from their own computers, even with every Mac closed.",
  soon: "The bots will answer from their own computers once those are ready. Until then the owner's Mac answers.",
  mac: "The bots answer from the owner's Mac while Bops is open there.",
};

/** The switch for the open workspace, or null where there's none (see above). */
export function chatSwitchOf(state: AppState): ChatSwitchView | null {
  // An Admin of a shared workspace says it too, once its Bops Cloud takes an Admin's choice (it said adminActs or ownerOld).
  const admin = state.shared?.role === "admin" && (!!state.shared.adminActs || !!state.shared.ownerOld);
  if ((state.shared && !admin) || (!state.shared && state.host === "mac")) return null;
  const wsId = currentWorkspace(state);
  const w = state.workspaces?.find((x) => x.id === wsId);
  if (!w || (w.chatOn === undefined && !w.chatAuto)) return null;
  // (A shared workspace's bots' computers stay in its copy: an Admin's screens say which bots have one.)
  const computers = state.shared ? !!state.shared.screens?.length : state.bots.some((b) => workspaceOf(b) === wsId && b.runsOn !== "mac" && !!workBot(b, state.bots).computerId);
  if (!computers) return null;
  const lines = state.shared ? CHAT_LINES_SHARED : CHAT_LINES;
  if (w.chatOn === "cloud") return { wsId, on: true, line: lines.cloud };
  if (w.chatOn !== "mac" && w.chatAuto) return { wsId, on: true, line: lines.soon };
  return { wsId, on: false, line: lines.mac };
}

/** Turn it on ("auto": Bops Cloud decides) or off (the Mac, chosen). Bops' words when it didn't go, else null. */
export async function setChat(wsId: string, on: boolean, shared = false): Promise<string | null> {
  const chat = on ? "auto" : "mac";
  // (An Admin's, of a shared workspace: through Bops Cloud, kept as an Admin's choice: lib/server/shared-people.ts.)
  const res = await (shared ? post("/api/workspaces/shared/settings", { chat }, "PATCH") : post("/api/workspaces", { id: wsId, chat }, "PATCH")).catch(() => null);
  if (res?.ok) return null;
  const j = ((await res?.json().catch(() => null)) ?? {}) as { error?: unknown };
  return typeof j.error === "string" && j.error ? j.error : "Couldn't reach Bops. Try again.";
}

export function ChatSwitch({ state }: { state: AppState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = chatSwitchOf(state);
  if (!view) return null;
  const flip = async () => {
    setBusy(true);
    try {
      setError(await setChat(view.wsId, !view.on, !!state.shared));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
      <span className="text-[13px] font-semibold">Chat</span>
      <div className="flex items-center gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium">{state.shared ? "Answer with every Mac closed" : "Answer with your Mac closed"}</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">{view.line}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={view.on}
          aria-label={state.shared ? "Answer with every Mac closed" : "Answer with your Mac closed"}
          disabled={busy}
          onClick={() => void flip()}
          className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-60 ${view.on ? "bg-ink" : "bg-[#E6E6E3]"}`}
        >
          <span className={`absolute top-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-[left] ${view.on ? "left-[19px]" : "left-[3px]"}`} />
        </button>
      </div>
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}
