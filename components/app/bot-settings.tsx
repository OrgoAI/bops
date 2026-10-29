"use client";

import { useEffect, useId, useRef, useState } from "react";
import { mailRule } from "@/lib/permission";
import { aiLine, CLOUD_HONOURS_CALL_SETTINGS, headerLine, lineVoiceNote, repliesNote, SETTINGS_SECTIONS, SETTINGS_WORDS as W, spacedPhone, teamLine, type SettingsSection } from "@/lib/bot-settings";
import { onCount, todayOf } from "@/lib/sequences";
import { ownMemory } from "@/lib/chain";
import { appsStayLine, botChatId, CALL_VOICES, live, settingsOf, sharesComputer, workBot, workspaceOf, type AppState, type Bot, type BotSettings, type CallVoice, type Session } from "@/lib/types";
import { readOnly, you, your, yourMac } from "@/lib/shared";
import type { AutopilotSection } from "./autopilot";
import { autopilotOf } from "./autopilot";
import { ComputerChoice, ContactActions, contactOf, DeleteBot, Field, GetEmail, GetNumber, GLASS, HowIWork, PlanNeeded, PlanRoom, Uses, usePhonePlan, type PhonePlan } from "./bot-panel";
import { AiSlot } from "./bot-settings-ai";
import { BotMemory } from "./bot-memory";
import { BotSkills } from "./bot-skills";
import { WhereToFind } from "./channels";
import { ComputerSummary } from "./computer";
import { BotKeys } from "./keys";
import { LineLink } from "./line-link";
import { Mascot } from "./mascot";
import { BotRoutines, routineCount } from "./routines";
import { Segmented } from "./segmented";
import { FactChips, InnerLabel, Sequences, TodayRow, useBotSave } from "./sequences";
import { botSkills } from "./skills";
import { BotTeamFields, CHART_WORDS, Lock, Switch, useChartEditor } from "./team-chart";
import { botWash, post } from "./ui";

/*
 * A bot's settings, expanded: a page over the whole window (bops-app.tsx draws it over the sidebar, the chat and the
 * side panel, which stay as they were underneath). A column on the left with Back to chat, the bot, and its sections,
 * each with a square marker filled with the bot's own colour when picked; the bot's header in its colour; then one
 * card per section, each closing to a line. Two parts: BotSettingsPage (the frame) and BotSettingsBody (the cards),
 * which assumes nothing of the frame, so a Bots section in Settings can draw it later.
 */

/** What the page's links do: the panel's own callbacks. Each that goes elsewhere closes the page first (bops-app.tsx). */
export type SettingsLinks = {
  onOpenChat: (chatId: string) => void;
  onOpenThread: (s: Session) => void;
  onOpenVault: () => void;
  onOpenComputer: (botId: string) => void;
  onOpenKeys: (botId: string) => void;
  onShowScreen?: (botId: string, display: number) => void;
  onOpenAutopilot: (section: AutopilotSection, item?: string, bot?: string) => void;
  onOpenSkills: (focus?: string) => void;
  onAsk: (botId: string, text?: string) => void;
  /** The plans (Account), over the page. */
  onUpgrade: () => void;
  /** The org chart at this bot, over the page. */
  onOpenChart?: (botId: string) => void;
};

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whether a Mac or runner on the account runs a Bops from before these settings (the org chart's check). */
function useOlderBops() {
  const [older, setOlder] = useState(false);
  useEffect(() => {
    let gone = false;
    void fetch("/api/workspaces?olderBops=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { older?: boolean } | null) => !gone && setOlder(j?.older === true))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  return older;
}

/** The square marker of a section's row (the owner's pick): an ink border and the bot's colour when picked, else empty. */
function Marker({ on, color }: { on: boolean; color: string }) {
  return <span aria-hidden data-marker className={`size-4 shrink-0 rounded-[4.5px] border-[1.5px] ${on ? "border-ink" : "border-[#9A9A97]"}`} style={on ? { background: color } : undefined} />;
}

export function BotSettingsPage({
  state,
  bot: b,
  at,
  onBack,
  onCollapse,
  links,
}: {
  state: AppState;
  bot: Bot;
  /** The section it opened at (its card open and picked); none: the top, with AI and Email open. */
  at?: SettingsSection;
  /** Back to chat, the X and Esc: the app as it was. */
  onBack: () => void;
  /** Back to the side panel, at the matching tab. */
  onCollapse: (at?: SettingsSection) => void;
  links: SettingsLinks;
}) {
  // The row picked: the section it opened at, else AI (open at first with Email), then the last one clicked.
  const [picked, setPicked] = useState<SettingsSection>(at ?? "ai");
  const [open, setOpen] = useState<Set<SettingsSection>>(() => new Set(at ? [at] : ["ai", "email"]));
  const main = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const plan = usePhonePlan();
  const { reach } = contactOf(state, b, plan);
  const wsName = state.workspaces?.find((w) => w.id === workspaceOf(b))?.name ?? "";
  /** A card to the top of the column (once it's open). */
  const scrollTo = (s: SettingsSection, smooth: boolean, focus = false) =>
    setTimeout(() => {
      const card = main.current?.querySelector<HTMLElement>(`#settings-${s}`);
      card?.scrollIntoView?.({ block: "start", behavior: smooth && !reduced() ? "smooth" : "auto" });
      // Picked in the left column: the keyboard goes on from the card's own header.
      if (focus) card?.querySelector<HTMLElement>("button[aria-expanded]")?.focus({ preventScroll: true });
    }, 0);
  const go = (s: SettingsSection) => {
    setPicked(s);
    setOpen((o) => new Set(o).add(s));
    scrollTo(s, true, true);
  };
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    // Only as it opens: a later section comes with a new page (bops-app.tsx keys it).
    if (at) scrollTo(at, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sectionName = (s: SettingsSection) => (s === "phone" && !reach ? W.sections.contact : W.sections[s]);
  const tool = "flex size-8 items-center justify-center rounded-full bg-white/60 shadow-[0_0_0_1px_#E6E6E3] hover:bg-white";
  const head = headerLine(state, b);

  return (
    <section
      data-bot-settings={b.id}
      aria-label={W.settingsOf(b.name)}
      onKeyDown={(e) => {
        // Esc goes back to the chat, once nothing nearer wanted it (a menu, a question, unsaved words), and only that:
        // the app's own Esc (bops-app.tsx) would close what's under the page too.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }}
      className="motion-fade-in grid h-full min-h-0 grid-cols-[228px_minmax(0,1fr)] bg-white"
    >
      <nav aria-label={W.group} className="flex min-h-0 flex-col overflow-y-auto bg-[#FBFBFA] px-3.5 py-[18px] shadow-[inset_-1px_0_0_#ECECEA]">
        <button type="button" onClick={onBack} data-back className="flex items-center gap-2 self-start px-2 pb-3.5 pt-1 text-[12.5px] leading-4 text-[#6B6B6B] hover:text-ink">
          <span aria-hidden>‹</span>
          {W.back}
        </button>
        <div className="flex items-center gap-2.5 px-2 pb-4 pt-1">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in oklab, ${b.color} 15%, white)` }}>
            <Mascot botId={b.id} color={b.color} size={30} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-semibold leading-[18px]">{b.name}</span>
            {wsName && <span className="truncate text-[11.5px] leading-4 text-[#6B6B6B]">{wsName}</span>}
          </span>
        </div>
        <span className="px-2.5 pb-1.5 pt-2.5 text-[11px] uppercase leading-4 tracking-[0.02em] text-[#9A9A97]">{W.group}</span>
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => go(s)}
            aria-current={picked === s ? "true" : undefined}
            data-picked={picked === s || undefined}
            data-nav={s}
            className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-left text-[13.5px] leading-[18px] ${picked === s ? "bg-[#EFEFEC] font-semibold text-ink" : "text-[#3A3A38] hover:bg-black/[0.03]"}`}
          >
            <Marker on={picked === s} color={b.color} />
            {sectionName(s)}
          </button>
        ))}
      </nav>

      <div ref={main} className="relative min-h-0 overflow-y-auto">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px]" style={{ backgroundImage: `linear-gradient(180deg, transparent 40%, #FFFFFF 100%), ${botWash(b)}` }} />
        <div className="absolute right-[22px] top-[18px] z-10 flex gap-2">
          <button type="button" onClick={() => onCollapse(picked)} aria-label={W.collapse} data-tip={W.collapse} data-collapse className={tool}>
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
              <path d="M12.5 1.5L8.5 5.5M8.5 2v3.5H12M1.5 12.5L5.5 8.5M5.5 12V8.5H2" fill="none" stroke="#0A0A0A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" onClick={onBack} aria-label={W.close} data-close className={tool}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="relative max-w-[900px] px-[34px] py-[22px]">
          <div className="mt-2 flex items-center gap-5">
            <span className="grid size-[112px] shrink-0 place-items-center rounded-full bg-white/75 shadow-[0_0_0_6px_#FFFFFF8C]">
              <Mascot botId={b.id} color={b.color} size={84} />
            </span>
            <div className="flex min-w-0 flex-col">
              <h1 ref={heading} tabIndex={-1} className="truncate text-[30px] font-bold leading-9 tracking-[-0.015em] outline-none">
                {b.name}
              </h1>
              <span className="mt-1 flex items-center gap-1 text-[14px] leading-5 text-[#3A3A38]" data-header-line>
                {head.text}
                {head.ownMemory && (
                  <>
                    <span> · </span>
                    <Lock />
                    {W.ownMemory}
                  </>
                )}
              </span>
              <div className="mt-3.5">
                <ContactActions state={state} bot={b} plan={plan} onOpenChat={links.onOpenChat} size={44} />
              </div>
            </div>
          </div>
          <BotSettingsBody state={state} bot={b} plan={plan} open={open} onToggle={(s) => setOpen((o) => (o.has(s) ? new Set([...o].filter((x) => x !== s)) : new Set(o).add(s)))} links={links} sectionName={sectionName} />
        </div>
      </div>
    </section>
  );
}

/** One card: its header (a chevron, the title, the line on the right) opens and closes it. */
function SettingsCard({ id, title, summary, open, onToggle, children }: { id: SettingsSection; title: string; summary: React.ReactNode; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div id={`settings-${id}`} data-card={id} className={`scroll-mt-4 rounded-2xl ${GLASS}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`settings-${id}-body`} className="flex w-full items-center gap-3 px-4 py-[13px] text-left">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`shrink-0 text-[#9A9A98] transition-transform ${open ? "rotate-90" : ""}`}>
          <path d="M3.5 2l4 3-4 3z" fill="currentColor" />
        </svg>
        <span className="shrink-0 text-[13px] font-semibold leading-4">{title}</span>
        {/* A block of its own, so a long line ends in an ellipsis rather than mid letter. */}
        <span className="ml-auto block min-w-0 truncate text-right text-[12px] leading-4 text-[#6B6B6B]" data-summary title={typeof summary === "string" ? summary : undefined}>
          {summary}
        </span>
      </button>
      {open && (
        <div id={`settings-${id}-body`} className="motion-fade-in px-4 pb-3.5 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** The card's own line at the bottom (saved, failed, the older Macs note). */
const Note = ({ children, tone }: { children: React.ReactNode; tone?: "error" }) => (
  <span className={`mt-2.5 block text-[12px] leading-4 ${tone === "error" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>{children}</span>
);

/** How it works on its computer, in a line (the Computer card's, as ComputerChoice words it). */
export function computerLine(state: AppState, b: Bot): string {
  if (!state.shared && state.host === "mac") return `Works on ${yourMac(state)}`;
  if (sharesComputer(b)) return b.isMain ? `Works on ${your(state)} free Bops computer` : `Works on ${workBot({ ...b, computer: "shared" }, state.bots).name}'s computer`;
  return b.freeComputer ? "Its own Bops computer" : "Its own cloud computer";
}

/** The voice its calls are in, by name: the one picked, else the one picked for its name (Bot.voice), unknown before its first call. */
const voiceShown = (b: Bot, set: BotSettings) => (set.callVoice ? W.voiceName(set.callVoice) : b.voice ? W.voiceName(b.voice) : null);

export function BotSettingsBody({
  state,
  bot: b,
  plan,
  open,
  onToggle,
  links,
  sectionName,
}: {
  state: AppState;
  bot: Bot;
  plan: PhonePlan;
  open: Set<SettingsSection>;
  onToggle: (s: SettingsSection) => void;
  links: SettingsLinks;
  sectionName: (s: SettingsSection) => string;
}) {
  const older = useOlderBops();
  const contact = contactOf(state, b, plan);
  const { reach, line, main } = contact;
  const today = todayOf(state, b);
  const set = settingsOf(state, b);
  const [only, setOnly] = useState<string | null>(null);
  const routines = autopilotOf(state, b.id);
  const nRoutines = routines.schedules.length + routines.monitors.length;
  const skills = botSkills(state, b).length;
  const paused = `paused until ${you(state)} upgrade${state.shared ? "s" : ""} again`;
  const emailSummary = b.email ? (b.mail?.paused ? `${b.email} · ${paused}` : W.emailSummary(b.email, onCount(set, "email"))) : W.noEmail;
  const phoneSummary = reach
    ? [W.phoneSummary(spacedPhone(reach), voiceShown(b, set), onCount(set, "phone")), set.answersCalls === false && W.notTaking, b.phoneLine?.paused && paused].filter(Boolean).join(" · ")
    : line && main && !b.isMain
      ? W.reachedThrough(main.name)
      : W.noNumber;

  const card = (s: SettingsSection, summary: React.ReactNode, body: React.ReactNode) => (
    <SettingsCard key={s} id={s} title={sectionName(s)} summary={summary} open={open.has(s)} onToggle={() => onToggle(s)}>
      {body}
    </SettingsCard>
  );
  const cards: Record<SettingsSection, () => React.ReactNode> = {
    team: () => card("team", teamLine(state, b), <TeamBody state={state} bot={b} older={older} onOpenChart={links.onOpenChart} />),
    ai: () => card("ai", aiLine(state, b), <AiBody state={state} bot={b} links={links} />),
    email: () => card("email", emailSummary, <EmailBody state={state} bot={b} set={set} plan={plan} contact={contact} today={today} older={older} onUpgrade={links.onUpgrade} />),
    phone: () =>
      card(
        "phone",
        phoneSummary,
        reach ? (
          <PhoneBody state={state} bot={b} set={set} reach={reach} today={today} older={older} onOpenChat={() => links.onOpenChat(botChatId(b.id))} />
        ) : (
          <ContactBody bot={b} plan={plan} contact={contact} onUpgrade={links.onUpgrade} />
        ),
      ),
    skills: () => card("skills", W.skillsCount(skills), <BotSkills state={state} bot={b} onOpenChat={links.onOpenChat} onOpenVault={links.onOpenVault} onOpenKeys={links.onOpenKeys} onOpenSkills={links.onOpenSkills} />),
    routines: () =>
      card("routines", nRoutines ? routineCount(nRoutines) : W.noRoutines, <BotRoutines state={state} bot={b} app={only} onApp={setOnly} onOpenAutopilot={links.onOpenAutopilot} onAsk={links.onAsk} />),
    memory: () => card("memory", ownMemory(state, b.id) ? W.memoryOwn : W.memoryTeam, <BotMemory state={state} bot={b} onOpenThread={links.onOpenThread} />),
    computer: () => card("computer", computerLine(state, b), <ComputerBody state={state} bot={b} links={links} onRoutines={(app) => (setOnly(app), onToggle("routines"))} />),
  };
  return (
    <>
      <div className="mt-6 flex flex-col gap-2.5">{SETTINGS_SECTIONS.map((s) => cards[s]())}</div>
      <div className="mt-6 flex flex-col gap-3.5">
        <WhereToFind state={state} bot={b} />
        <ShareAndPause state={state} bot={b} />
        {!b.isMain && <DeleteBot bot={b} apps={appsStayLine(state, b)} />}
      </div>
    </>
  );
}

/** Share contact and Pause: the panel's two buttons under its cards. */
function ShareAndPause({ state, bot: b }: { state: AppState; bot: Bot }) {
  const [copied, setCopied] = useState(false);
  const running = state.sessions.filter((s) => s.botId === b.id && live(s)).length;
  const share = async () => {
    await navigator.clipboard.writeText([`${b.name} (${b.role}, Bops)`, b.phone, b.email].filter(Boolean).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex w-full gap-2">
      <button type="button" onClick={() => void share()} className={`flex-1 rounded-[14px] px-4 py-[11px] text-left text-[14px] leading-[18px] ${GLASS}`}>
        {copied ? "Copied" : "Share contact"}
      </button>
      <button
        type="button"
        onClick={() => void post("/api/sessions", { botId: b.id }, "DELETE")}
        disabled={!running}
        className={`flex-1 rounded-[14px] px-4 py-[11px] text-left text-[14px] leading-[18px] text-[#B42318] disabled:text-[#C9C9C6] ${GLASS}`}
      >
        {running ? `Pause ${b.name} · ${running} running` : `${b.name} is idle`}
      </button>
    </div>
  );
}

/* ---------------- Team ---------------- */

function TeamBody({ state, bot: b, older, onOpenChart }: { state: AppState; bot: Bot; older: boolean; onOpenChart?: (botId: string) => void }) {
  const ed = useChartEditor(state);
  const listed = (ed.people ?? []).filter((p) => !p.invited);
  if (!ed.ws || !ed.t.bots.some((x) => x.id === b.id)) return null;
  return (
    <div data-team-body>
      <BotTeamFields
        bot={b}
        state={state}
        t={ed.t}
        chain={ed.chain}
        people={listed}
        peopleKnown={ed.people !== null}
        levelFor={ed.levelFor}
        name={ed.name}
        onSave={(next, said) => ed.save(next, { said })}
        onLevel={(p, level) => void ed.setLevel(p, b.id, level)}
        onGiveWriteFor={(p) => void ed.giveWriteFor(p, b.id)}
        onBringIn={() => void ed.bringIn(b.id)}
        onPreset={(p) => void ed.makeTheirs(p, b.id)}
        onGiveComputer={() => void ed.giveComputer(b.id)}
        leadLabel={W.reportsToLabel}
        inline
      />
      {ed.toast && (
        <span role={ed.toast.error ? "alert" : "status"} data-team-toast className={`mt-3 flex items-center gap-2 text-[12px] leading-4 ${ed.toast.error ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>
          {ed.toast.text}
          {ed.toast.undo && (
            <button type="button" onClick={() => (ed.setToast(null), void ed.undo(ed.toast!.undo!))} className="font-medium text-ink hover:underline">
              {CHART_WORDS.undo}
            </button>
          )}
        </span>
      )}
      {older && <Note>{CHART_WORDS.olderBops}</Note>}
      {onOpenChart && (
        <button type="button" onClick={() => onOpenChart(b.id)} data-open-chart className="mt-3 text-[12.5px] font-medium leading-4 text-ink hover:underline">
          {W.openChart} ›
        </button>
      )}
    </div>
  );
}

/* ---------------- AI, and how it works ---------------- */

function AiBody({ state, bot: b, links }: { state: AppState; bot: Bot; links: SettingsLinks }) {
  const { busy, error, send } = useBotSave(b.id);
  return (
    <div className="flex flex-col gap-3.5">
      <AiSlot state={state} bot={b} onShowScreen={links.onShowScreen} onOpenThread={links.onOpenThread} onOpenChat={links.onOpenChat} onAddKey={links.onOpenKeys} />
      <div className="h-px bg-black/[0.05]" />
      <HowIWork key={b.id} bot={b} className="bg-white/70 shadow-[0_0_0_1px_#ECECEA]" />
      <Segmented
        title="Approvals"
        hint={b.autoApprove ? "Sends, posts and changes things without asking. Still asks before paying" : `Asks ${you(state)} before it sends, posts, deletes or pays`}
        value={b.autoApprove ? "yes" : "no"}
        options={[
          ["no", "Ask first"],
          ["yes", "Just do it"],
        ]}
        disabled={busy}
        onPick={(v) => void send({ autoApprove: v === "yes" })}
      />
      {state.businessData && (
        <Segmented
          title="Business data"
          hint={b.dataOff ? "No lookups of companies, people or contacts" : "Looks up companies, people, work emails and company news. Cents a lookup, from AI credit"}
          value={b.dataOff ? "off" : "on"}
          options={[
            ["on", "On"],
            ["off", "Off"],
          ]}
          disabled={busy}
          onPick={(v) => void send({ dataOff: v === "off" })}
        />
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

/* ---------------- Email ---------------- */

type Contact = ReturnType<typeof contactOf>;

function EmailBody({ state, bot: b, set, plan, contact, today, older, onUpgrade }: { state: AppState; bot: Bot; set: BotSettings; plan: PhonePlan; contact: Contact; today: ReturnType<typeof todayOf>; older: boolean; onUpgrade: () => void }) {
  const { busy, error, send } = useBotSave(b.id);
  const { emailRoom, emailOnAsk } = contact;
  if (!b.email)
    return (
      <div className="flex flex-col" data-email-empty>
        <div className="-mx-4">
          <Field label={W.emailLabel} empty={W.noInbox} />
          {emailRoom && <PlanRoom short={emailRoom} onUpgrade={onUpgrade} />}
          {!emailRoom && !plan.room && plan.planNeeded && <PlanNeeded what="An email address" bot={b} onUpgrade={onUpgrade} />}
          {emailOnAsk && <GetEmail bot={b} />}
        </div>
        <Note>{W.emailSequencesLater}</Note>
      </div>
    );
  const rule = mailRule(b, set);
  return (
    <div className="flex flex-col" data-email-body>
      <div className="-mx-4">
        <Field label={b.mail?.paused ? `email · paused until ${you(state)} upgrade${state.shared ? "s" : ""} again` : W.emailLabel} value={b.email} empty={W.noInbox} />
      </div>
      <Sequences bot={b} set={set} channel="email" today={today} />
      <div className="mt-3.5" data-replies>
        <Segmented
          title={W.repliesToOthers}
          hint={repliesNote(b, set)}
          value={rule}
          options={[
            ["never", W.replies.never],
            ["ask", W.replies.ask],
            ["allow", W.replies.allow],
          ]}
          disabled={busy || readOnly(state)}
          onPick={(v) => void send({ othersMail: v })}
        />
        {error && (
          <span role="alert" className="mt-1.5 block text-[12px] leading-4 text-[#B42318]">
            {error}
          </span>
        )}
      </div>
      <InnerLabel>{W.loopGuard}</InnerLabel>
      <FactChips items={W.mailGuard} />
      <InnerLabel>{W.ifSendFails}</InnerLabel>
      <FactChips items={W.mailFails} plain />
      <TodayRow text={today.mailIn || today.replied || today.mailFailed ? W.mailToday({ in: today.mailIn, replied: today.replied, held: today.held, failed: today.mailFailed }) : W.nothingToday} />
      {older && <Note>{W.olderBops}</Note>}
    </div>
  );
}

/* ---------------- Phone and voice, or Contact ---------------- */

function PhoneBody({ state, bot: b, set, reach, today, older, onOpenChat }: { state: AppState; bot: Bot; set: BotSettings; reach: string; today: ReturnType<typeof todayOf>; older: boolean; onOpenChat: () => void }) {
  const { busy, error, send } = useBotSave(b.id);
  const line = state.workspaces?.find((w) => w.id === workspaceOf(b))?.line;
  const number = spacedPhone(reach);
  const answers = set.answersCalls !== false;
  return (
    <div className="flex flex-col" data-phone-body>
      <div className="-mx-4">
        <Field
          label={line && b.isMain ? W.teamNumber(line.type === "imessage" ? "iMessage" : "texts") : b.phoneLine?.paused ? `mobile · paused until ${you(state)} upgrade${state.shared ? "s" : ""} again` : W.phoneLabel}
          value={number}
          empty={W.noNumber}
        />
        <LineLink key={reach} phone={reach} className="px-4 pb-[11px]" />
      </div>
      <VoicePicker state={state} bot={b} set={set} number={number} agentId={line && b.isMain ? line.agentId : b.phoneLine?.agentId} />
      <div className="mt-3 flex flex-col gap-1" data-answers>
        <Switch label={W.answersCalls} on={answers} disabled={busy} onFlip={(on) => void send({ answersCalls: on })} />
        <span className="text-[11.5px] leading-4 text-[#6B6B6B]">
          {answers ? (set.sequencesOff?.othersCalls ? W.answersOnYou(number) : W.answersOn(number)) : `${W.answersOff(b.name)}${CLOUD_HONOURS_CALL_SETTINGS ? "" : ` ${W.cloudStillAnswers}`}`}
        </span>
        {error && (
          <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
            {error}
          </span>
        )}
      </div>
      <Sequences bot={b} set={set} channel="phone" today={today} />
      {set.sequencesOff?.othersCalls && !CLOUD_HONOURS_CALL_SETTINGS && <Note>{W.cloudStillAnswers}</Note>}
      <InnerLabel>{W.loopGuard}</InnerLabel>
      <FactChips items={W.phoneGuard} />
      <InnerLabel>{W.ifTextFails}</InnerLabel>
      <FactChips items={W.textFails} plain />
      <TodayRow
        text={today.calls || today.texts ? W.phoneToday({ calls: today.calls, texts: today.texts, taken: today.taken }) : W.nothingToday}
        action={
          <button type="button" onClick={onOpenChat} className="shrink-0 rounded-full bg-white px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
            {W.openChat}
          </button>
        }
      />
      {older && <Note>{W.olderBops}</Note>}
    </div>
  );
}

/** A bot nobody can call yet: no number, the existing Get a number flow, and no voice. */
function ContactBody({ bot: b, plan, contact, onUpgrade }: { bot: Bot; plan: PhonePlan; contact: Contact; onUpgrade: () => void }) {
  const { line, main, numberRoom } = contact;
  return (
    <div className="flex flex-col" data-contact-body>
      <div className="-mx-4">
        <Field label={W.phone} empty={W.noneYet} />
        {!line && !b.phone && <GetNumber bot={b} plan={plan} room={numberRoom} onUpgrade={onUpgrade} />}
      </div>
      {line && main && !b.isMain && <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">{`Text ${main.name} at ${spacedPhone(line.phone)}: ${main.name} passes work to ${b.name}.`}</span>}
      {/* Only for a bot that can get a number of its own: one reached through the team's number never does. */}
      {!line && <Note>{W.voiceLater}</Note>}
    </div>
  );
}

/**
 * The voice its calls are in: a play button, its name and a caret; the menu lists Picked for its name and the nine,
 * each with its own play. A sample plays one at a time (a second stops the first); one that won't load says so and
 * its button goes. The menu is a group of buttons (pick, and play beside each): it takes focus once as it opens, closes
 * on Esc, a pick or a click outside, and Esc and a pick give focus back to the voice button.
 */
function VoicePicker({ state, bot: b, set, number, agentId }: { state: AppState; bot: Bot; set: BotSettings; number: string; agentId?: string }) {
  const { busy, error, send } = useBotSave(b.id);
  const [menu, setMenu] = useState(false);
  const [playing, setPlaying] = useState<CallVoice | null>(null);
  const [missing, setMissing] = useState<CallVoice[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  // The sample playing now (only events read it).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current: CallVoice | null = set.callVoice ?? ((CALL_VOICES as readonly string[]).find((v) => v === b.voice) as CallVoice | undefined) ?? null;
  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };
  useEffect(() => () => audioRef.current?.pause(), []);
  // Open: focus goes to the menu once (never again on a later render), and a click outside closes it.
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.focus({ preventScroll: true });
    const away = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);
  const close = () => {
    setMenu(false);
    buttonRef.current?.focus({ preventScroll: true });
  };
  const play = (v: CallVoice) => {
    if (playing === v) return stop();
    stop();
    const a = new Audio(`/voices/${v}.mp3`);
    audioRef.current = a;
    const fail = () => {
      if (audioRef.current !== a) return;
      audioRef.current = null;
      setPlaying(null);
      setMissing((m) => (m.includes(v) ? m : [...m, v]));
      setSaid(W.noSample(W.voiceName(v)));
    };
    a.onerror = fail;
    a.onended = () => audioRef.current === a && setPlaying(null);
    setSaid(null);
    setPlaying(v);
    void a.play()?.catch?.(fail);
  };
  const pick = async (v: CallVoice | null) => {
    close();
    if (!(await send({ callVoice: v }))) setSaid(W.voiceFailed);
  };
  return (
    <div ref={boxRef} className="relative mt-2 flex flex-col gap-1" data-voice>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-[#3A3A38]">{W.voice}</span>
        {current && !missing.includes(current) && <PlayButton v={current} playing={playing === current} onPlay={play} />}
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={menu}
          aria-controls={menu ? menuId : undefined}
          disabled={busy}
          onClick={() => setMenu((m) => !m)}
          data-voice-button
          className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] font-semibold leading-4 text-ink hover:bg-black/[0.04] disabled:opacity-60"
        >
          {set.callVoice ? W.voiceName(set.callVoice) : b.voice ? W.pickedForNameIs(W.voiceName(b.voice)) : W.pickedForName}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="text-[#8A8A88]">
            <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {menu && (
        <div
          ref={menuRef}
          id={menuId}
          role="group"
          aria-label={W.voice}
          tabIndex={-1}
          data-voice-menu
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
          className="motion-menu-in absolute right-0 top-8 z-20 flex w-[240px] flex-col rounded-[14px] bg-white p-1.5 shadow-[0_12px_32px_-8px_#0000002E,0_0_0_1px_#E8E8E5] outline-none"
        >
          <button type="button" aria-pressed={!set.callVoice} onClick={() => void pick(null)} data-voice-option="" className={`rounded-[9px] px-2.5 py-1.5 text-left text-[13px] leading-[18px] hover:bg-black/[0.04] ${!set.callVoice ? "font-semibold" : ""}`}>
            {b.voice ? W.pickedForNameIs(W.voiceName(b.voice)) : W.pickedForName}
          </button>
          {CALL_VOICES.map((v) => (
            <div key={v} className="flex items-center gap-2 rounded-[9px] px-2.5 py-1 hover:bg-black/[0.04]">
              {!missing.includes(v) && <PlayButton v={v} playing={playing === v} onPlay={play} />}
              <button type="button" aria-pressed={set.callVoice === v} onClick={() => void pick(v)} data-voice-option={v} className={`min-w-0 flex-1 py-0.5 text-left text-[13px] leading-[18px] ${set.callVoice === v ? "font-semibold" : ""}`}>
                {W.voiceName(v)}
              </button>
            </div>
          ))}
        </div>
      )}
      <span className="text-[11.5px] leading-4 text-[#6B6B6B]" data-voice-note>
        {lineVoiceNote(state, b, agentId, current, number)}
      </span>
      {(said || error) && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {said ?? error}
        </span>
      )}
    </div>
  );
}

/** A voice's sample: play, or Stop while it plays. */
function PlayButton({ v, playing, onPlay }: { v: CallVoice; playing: boolean; onPlay: (v: CallVoice) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onPlay(v);
      }}
      aria-label={playing ? W.stop : W.play(W.voiceName(v))}
      data-play={v}
      className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-white hover:bg-[#262626]"
    >
      {playing ? (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
          <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" />
        </svg>
      ) : (
        <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden>
          <path d="M1.5 1l5.5 3.5L1.5 8z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

/* ---------------- Computer ---------------- */

function ComputerBody({ state, bot: b, links, onRoutines }: { state: AppState; bot: Bot; links: SettingsLinks; onRoutines: (app: string | null) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <ComputerSummary state={state} bot={b} className="w-full bg-white/70 shadow-[0_0_0_1px_#ECECEA]" onOpen={() => links.onOpenComputer(b.id)} />
      {(!b.isMain || sharesComputer(b)) && state.host !== "mac" && !readOnly(state) && <ComputerChoice state={state} bot={b} className="bg-white/70 shadow-[0_0_0_1px_#ECECEA]" onUpgrade={links.onUpgrade} />}
      {!state.shared && <Uses state={state} bot={b} onOpenVault={links.onOpenVault} onOpenRoutines={onRoutines} className="bg-white/70 shadow-[0_0_0_1px_#ECECEA]" />}
      <BotKeys state={state} bot={b} onAdd={() => links.onOpenKeys(b.id)} className="bg-white/70 shadow-[0_0_0_1px_#ECECEA]" />
    </div>
  );
}
