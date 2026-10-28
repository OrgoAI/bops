"use client";

import { useState } from "react";
import { botHasLabel, cleanLabel, sameLabel } from "@/lib/skill-labels";
import { APP_LEVELS, botChatId, workBot, workspaceOf, type AppLevel, type AppState, type Bot } from "@/lib/types";
import { categoriesOpen, GROUP_NAME as ORBIT } from "@/lib/memory-categories";
import { AppLogo, accountTitle, botApps } from "./apps";
import { BotKeys } from "./keys";
import { botSkills, skillsIn, workspaceLabelsOf } from "./skills";
import { post } from "./ui";
import { undash } from "./side-group";
import { you, yourMac } from "@/lib/shared";

/*
 * Skills: what a bot can do, on one screen of its profile (bot-panel.tsx). Its workspace's skills and apps
 * that it has (the same list as Skills, in Knowledge, skills.tsx), the Connected Apps it may use and how far,
 * its API keys, and what it can always do. What it runs on its own is its Routines tab (routines.tsx).
 * Everything is read from the app's state; opening a row goes where it's managed already (the Skills
 * page, the Vault, the chat's "Save as skill"). A group with nothing in it isn't shown: one quiet line at the end
 * says how to add what's missing. Skill labels is the owner's checklist of the workspace's labels this bot has
 * (Bot.skillLabels, as Who has what in Skills sets it), only in their own window.
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
  onOpenSkills,
}: {
  state: AppState;
  bot: Bot;
  onOpenChat: (chatId: string) => void;
  onOpenVault: () => void;
  onOpenKeys: (botId: string) => void;
  /** Skills, in Knowledge, at one of them ("skill:<slug>"). */
  onOpenSkills: (focus?: string) => void;
}) {
  const skills = botSkills(state, b);
  const apps = botApps(state, b);
  const keyed = !!b.keys?.length;
  const chat = () => onOpenChat(botChatId(b.id));
  // What's not set up yet, said once at the end instead of an empty card each.
  const missing = [
    !skills.length && { label: "Save a skill from its chat", onClick: chat },
    !apps.length && { label: "Add Connected Apps in Logins", onClick: onOpenVault },
    !keyed && { label: "Add keys in Logins", onClick: () => onOpenKeys(b.id) },
  ].filter((x): x is { label: string; onClick: () => void } => !!x);

  return (
    <div className="flex w-full flex-col gap-3">
      {!state.shared && <LabelChecklist state={state} bot={b} />}

      {skills.length > 0 && (
        <Group title="Skills" count={skills.length} action={{ label: "All skills ›", onClick: () => onOpenSkills() }}>
          {skills.map((r, i) => (
            <Row
              key={`${r.kind}:${r.slug}`}
              title={`${undash(r.name)}${r.kind === "app" ? " (app)" : ""}`}
              line={`${r.status === "draft" ? "Draft · " : r.version ? `v${r.version} · ` : ""}${undash(r.description)}`}
              dim={r.status === "draft"}
              last={i === skills.length - 1}
              onClick={() => onOpenSkills(`${r.kind}:${r.slug}`)}
            />
          ))}
        </Group>
      )}

      {apps.length > 0 && (
        <Group title="Connected Apps" count={apps.length} action={{ label: "Manage in Logins ›", onClick: onOpenVault }}>
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
      {keyed && <BotKeys state={state} bot={b} onAdd={() => onOpenKeys(b.id)} className={GLASS} />}

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
 * and teammates. A bot with no number shows no texting. Only the main bot hands work off; the others ask.
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
    // (A shared workspace's bot never works on the viewer's own Mac, whatever their app's host: only on the owner's, when it's set to.)
    b.runsOn === "mac" || (!state.shared && state.host === "mac") ? `Works on ${yourMac(state)}` : host.id === b.id ? "Works on its computer" : `Works on ${host.name}'s computer`,
    b.email && !b.mail?.paused ? "Email" : "",
    line || ownLine ? `Texts ${you(state)}` : "",
    calls ? "Takes calls" : "",
    categoriesOpen(state) ? ORBIT : "",
    state.businessData && !b.dataOff ? "Looks up companies and people" : "",
    teammates ? (b.isMain ? "Hands work to teammates" : "Asks teammates") : "",
  ].filter(Boolean);
}

function Group({ title, count, action, children }: { title: string; count: number; action?: { label: string; onClick: () => void }; children: React.ReactNode }) {
  return (
    <div className={`flex w-full flex-col rounded-2xl ${GLASS}`}>
      <div className="flex items-center justify-between px-4 pb-1 pt-[11px]">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-4">
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

/** A row that opens where the thing is managed: a name and a grey line. */
function Row({ title, line, dim, last, onClick }: { title: string; line?: string; dim?: boolean; last: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex w-full flex-col px-4 py-[9px] text-left hover:bg-white/50 ${last ? "rounded-b-2xl pb-3" : "border-b border-black/[0.05]"}`}>
      <span className={`truncate text-[14px] leading-[18px] ${dim ? "text-[#9A9A98]" : "text-ink"}`}>{title}</span>
      {line && <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{line}</span>}
    </button>
  );
}

/**
 * Which of the workspace's skill labels this bot has (Bot.skillLabels: lib/skill-labels.ts botHasSkill), as a short
 * checklist with Every label (new ones too) above it. A skill that names its own bots goes by them whatever this
 * says. The owner's, in the window (app/api/skills refuses it in a shared workspace).
 */
function LabelChecklist({ state, bot: b }: { state: AppState; bot: Bot }) {
  const ws = workspaceOf(b);
  const { skills } = skillsIn(state, ws);
  const labels = workspaceLabelsOf(skills, state.workspaces?.find((w) => w.id === ws)?.skillLabelInfo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!labels.length) return null;
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/skills", { ws, botId: b.id, ...body });
      if (!res.ok) setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "That didn't work. Try again.");
    } catch {
      setError("Couldn't reach Bops. Try again.");
    }
    setBusy(false);
  };
  const every = !b.skillLabels;
  const box = (on: boolean) => `flex size-4 shrink-0 items-center justify-center rounded-[4px] ${on ? "bg-ink text-white" : "bg-white shadow-[0_0_0_1px_#D6D6D3]"}`;
  const tick = (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.5l2.5 2.5 4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <Group title="Skill labels" count={every ? labels.length : labels.filter((l) => botHasLabel(b, l)).length}>
      <div data-bot-labels className="flex flex-col gap-0.5 px-4 pb-3 pt-1">
        <button type="button" role="checkbox" aria-checked={every} disabled={busy} onClick={() => void send({ action: "bot-labels", labels: every ? labels : null })} className="flex items-center gap-2 py-1 text-left text-[13px] leading-4 disabled:opacity-50">
          <span className={box(every)}>{every && tick}</span>
          Every label, new ones too
        </button>
        {labels.map((l) => {
          const on = botHasLabel(b, l);
          const n = skills.filter((r) => sameLabel(cleanLabel(r.label), l)).length;
          return (
            <button key={l} type="button" role="checkbox" aria-checked={on} disabled={busy} onClick={() => void send({ action: "bot-label", label: l, on: !on })} className="flex items-center gap-2 py-1 pl-4 text-left text-[13px] leading-4 disabled:opacity-50">
              <span className={box(on)}>{on && tick}</span>
              <span className="min-w-0 flex-1 truncate">{l}</span>
              <span className="tabular-nums text-[12px] text-[#9A9A98]">{n}</span>
            </button>
          );
        })}
        {error && (
          <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
            {error}
          </span>
        )}
      </div>
    </Group>
  );
}
