"use client";

import { APP_LEVELS, botChatId, workBot, workspaceOf, type AppLevel, type AppState, type Bot, type Routine, type Watch } from "@/lib/types";
import { categoriesOpen, GROUP_NAME as ORBIT } from "@/lib/memory-categories";
import { AppLogo, accountTitle, botApps } from "./apps";
import { autopilotOf, AutopilotIcon, nextWords, RAN, trouble, type AutopilotSection } from "./autopilot";
import { BotKeys } from "./keys";
import { since, undash } from "./side-group";
import { watchName } from "./watch-overlay";

/*
 * Skills: what a bot can do, on one screen of its profile (bot-panel.tsx). Its procedures, the apps it
 * may use and how far, its API keys, what it does on its own (Autopilot), and what it can always do.
 * Everything is read from the app's state; opening a row goes where it's managed already (the Autopilot
 * page, the Vault, the chat's "Save as procedure"). A group with nothing in it isn't shown: one quiet
 * line at the end says how to add what's missing.
 */

const GLASS = "bg-white/60 shadow-[inset_0_0_0_1px_#FFFFFF,0_0_0_1px_#0000000F]";

/** How far a bot goes in an account: read only, or acting, asking first unless it's set to Just do it. */
const levelWords = (level: AppLevel, b: Bot) => (level === "read" ? APP_LEVELS[0].name : b.autoApprove ? "Just does it" : "Asks first");

export function BotSkills({
  state,
  bot: b,
  onOpenChat,
  onOpenVault,
  onOpenKeys,
  onOpenAutopilot,
}: {
  state: AppState;
  bot: Bot;
  onOpenChat: (chatId: string) => void;
  onOpenVault: () => void;
  onOpenKeys: (botId: string) => void;
  onOpenAutopilot: (section: AutopilotSection, item?: string) => void;
}) {
  const { schedules, monitors, procedures } = autopilotOf(state, b.id);
  const apps = botApps(state, b);
  const tz = state.owner?.timeZone;
  const keyed = !!b.keys?.length;
  const chat = () => onOpenChat(botChatId(b.id));
  // What's not set up yet, said once at the end instead of an empty card each.
  const missing = [
    !procedures.length && { label: "Save a procedure from its chat", onClick: chat },
    !apps.length && { label: "Add apps in Vault", onClick: onOpenVault },
    !keyed && { label: "Add keys in Vault", onClick: () => onOpenKeys(b.id) },
  ].filter((x): x is { label: string; onClick: () => void } => !!x);

  return (
    <div className="flex w-full flex-col gap-3">
      {procedures.length > 0 && (
        <Group title="Procedures" count={procedures.length} action={{ label: "Save from a chat ›", onClick: chat }}>
          {procedures.map((p, i) => (
            <Row key={p.id} title={undash(p.name)} line={undash(p.whenToUse)} last={i === procedures.length - 1} onClick={() => onOpenAutopilot("procedures", p.id)} />
          ))}
        </Group>
      )}

      {apps.length > 0 && (
        <Group title="Apps" count={apps.length} action={{ label: "Manage in Vault ›", onClick: onOpenVault }}>
          {apps.map((x, i) => (
            <div key={x.app} className={`flex items-center gap-2.5 px-4 py-[9px] ${i === apps.length - 1 ? "pb-3" : "border-b border-black/[0.05]"}`}>
              <AppLogo app={x.app} name={x.appName} size={22} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] leading-[18px]">{x.appName}</span>
                {x.accounts.length > 1 && <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{x.accounts.map((a) => accountTitle(a.account)).join(", ")}</span>}
              </div>
              <span className="flex shrink-0 flex-wrap justify-end gap-1">
                {[...new Set(x.accounts.map((a) => levelWords(a.level, b)))].map((w) => (
                  <span key={w} className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11.5px] leading-4 text-[#3A3A38]">
                    {w}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </Group>
      )}

      {/* Its keys: the Vault's, on or off for this bot, as on Details. */}
      {keyed && <BotKeys bot={b} onAdd={() => onOpenKeys(b.id)} className={GLASS} />}

      {schedules.length + monitors.length > 0 && (
        <Group title="Autopilot" count={schedules.length + monitors.length} icon={<AutopilotIcon size={13} />}>
          {schedules.map((r, i) => (
            <ScheduleRow key={r.id} routine={r} state={state} tz={tz} last={!monitors.length && i === schedules.length - 1} onClick={() => onOpenAutopilot("schedules", r.id)} />
          ))}
          {monitors.map((w, i) => (
            <MonitorRow key={w.id} watch={w} last={i === monitors.length - 1} onClick={() => onOpenAutopilot("monitors", w.id)} />
          ))}
        </Group>
      )}

      <div className={`flex w-full flex-col gap-2 rounded-2xl px-4 py-3 ${GLASS}`}>
        <span className="text-[13px] font-semibold leading-4">Built in</span>
        <span className="flex flex-wrap gap-1.5">
          {builtIn(state, b).map((x) => (
            <span key={x} className="rounded-full bg-black/[0.05] px-2.5 py-1 text-[12px] leading-4 text-[#3A3A38]">
              {x}
            </span>
          ))}
        </span>
      </div>

      {missing.length > 0 && (
        <span className="flex flex-wrap justify-center gap-x-3 gap-y-1 px-2 text-[12px] leading-4 text-[#9A9A98]">
          {missing.map((m) => (
            <button key={m.label} onClick={m.onClick} className="hover:text-ink">
              {m.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * What the bot can always do, from what it has now (lib/server/chat.ts offers the same): the web,
 * pictures and pages, its computer, and only what's set up of email, texts, calls, Orbit, business data
 * and teammates. A bot with no number shows no texting.
 */
function builtIn(state: AppState, b: Bot): string[] {
  const line = state.workspaces?.find((w) => w.id === workspaceOf(b))?.line;
  const ownLine = !!b.phone && !!b.phoneLine && !b.phoneLine.paused;
  // Calls reach the workspace's number (its main bot) or a bot's own, as on Details.
  const calls = line ? !!b.isMain : ownLine;
  const host = workBot(b, state.bots);
  const teammates = state.bots.some((x) => x.id !== b.id && workspaceOf(x) === workspaceOf(b));
  return [
    "Searches and reads the web",
    "Makes pictures and pages",
    b.runsOn === "mac" || state.host === "mac" ? "Works on your Mac" : host.id === b.id ? "Works on its computer" : `Works on ${host.name}'s computer`,
    b.email && !b.mail?.paused ? "Email" : "",
    line || ownLine ? "Texts you" : "",
    calls ? "Takes calls" : "",
    categoriesOpen(state) ? ORBIT : "",
    state.businessData && !b.dataOff ? "Looks up companies and people" : "",
    teammates ? "Hands work to teammates" : "",
  ].filter(Boolean);
}

function Group({ title, count, icon, action, children }: { title: string; count: number; icon?: React.ReactNode; action?: { label: string; onClick: () => void }; children: React.ReactNode }) {
  return (
    <div className={`flex w-full flex-col rounded-2xl ${GLASS}`}>
      <div className="flex items-center justify-between px-4 pb-1 pt-[11px]">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-4">
          {icon}
          {title}
          <span className="font-normal tabular-nums text-[#9A9A98]">{count}</span>
        </span>
        {action && (
          <button onClick={action.onClick} className="text-[12px] font-medium leading-4 text-ink">
            {action.label}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** A row that opens where the thing is managed: a name, a grey line, and a red one when something went wrong. */
function Row({ title, line, bad, dim, last, onClick }: { title: string; line?: string; bad?: string | null; dim?: boolean; last: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex w-full flex-col px-4 py-[9px] text-left hover:bg-white/50 ${last ? "rounded-b-2xl pb-3" : "border-b border-black/[0.05]"}`}>
      <span className={`truncate text-[14px] leading-[18px] ${dim ? "text-[#9A9A98]" : "text-ink"}`}>{title}</span>
      {line && <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{line}</span>}
      {bad && <span className="truncate text-[12px] leading-4 text-[#B42318]">{bad}</span>}
    </button>
  );
}

/** A schedule: when it runs next (or Running now, Paused, Done), and how its last run went. */
function ScheduleRow({ routine: r, state, tz, last, onClick }: { routine: Routine; state: AppState; tz?: string; last: boolean; onClick: () => void }) {
  const bad = trouble(r);
  const ran = !bad && r.last && r.last.status !== "running" ? `${RAN[r.last.status]} ${since(r.last.at)}` : "";
  return <Row title={undash(r.title)} line={[nextWords(r, state.sessions, tz), ran].filter(Boolean).join(" · ")} bad={bad} dim={!r.enabled} last={last} onClick={onClick} />;
}

/** A monitor: what it looks for, then its news, or when it last looked; red when a page couldn't be read. */
function MonitorRow({ watch: w, last, onClick }: { watch: Watch; last: boolean; onClick: () => void }) {
  const checked = w.page?.checkedAt ?? w.readAt;
  const status = w.paused ? "Paused" : w.alert ? `New: ${undash(w.alert.text)}` : checked ? `Checked ${since(checked)}` : "";
  const bad = w.page?.error && !w.paused ? `Couldn't read the page: ${undash(w.page.error)}` : null;
  return <Row title={watchName(w)} line={[undash(w.lookFor), status].filter(Boolean).join(" · ")} bad={bad} dim={!!w.paused || !!w.away} last={last} onClick={onClick} />;
}
