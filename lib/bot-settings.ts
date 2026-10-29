import { mayAskIn, ownMemory, teamIn, worksForNow } from "@/lib/chain";
import { mailRule, type MailRule } from "@/lib/permission";
import { AGENTS, aiOf } from "@/lib/agents";
import { live, workspaceOf, type AgentKind, type AppState, type Bot, type BotSettings, type CallVoice } from "@/lib/types";

/**
 * A bot's settings page (components/app/bot-settings.tsx): its sections, every word it says, and the one line each
 * card and each of the panel's rows shows closed. Pure: the page, the panel and the tests read them alike.
 */

/** The page's sections, in the order its left column lists them. "phone" is Contact for a bot nobody can call. */
export type SettingsSection = "team" | "ai" | "email" | "phone" | "skills" | "routines" | "memory" | "computer";
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["team", "ai", "email", "phone", "skills", "routines", "memory", "computer"];

/**
 * Whether Bops Cloud turns calls away as this Mac does (cloud/voice.ts turnedAway) while the Mac is away. False until a
 * Bops Cloud deploy carries that change; the release that deploys it flips this, and the "Bops Cloud still answers"
 * lines go.
 */
export const CLOUD_HONOURS_CALL_SETTINGS = false;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const bots = (n: number) => `${n} ${n === 1 ? "bot" : "bots"}`;
const and = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Every word the page, the panel's rows and the sequences say (the tests read them all for dashes and the old name). */
export const SETTINGS_WORDS = {
  openFull: "Open full settings",
  back: "Back to chat",
  group: "Settings",
  sections: { team: "Team", ai: "AI", email: "Email", phone: "Phone and voice", contact: "Contact", skills: "Skills", routines: "Routines", memory: "Memory", computer: "Computer" },
  collapse: "Back to the side panel",
  close: "Close",
  sequencesRow: "Sequences",
  settingsOf: (name: string) => `${name} settings`,
  // The header
  chiefHeader: "Chief of staff · runs the team",
  worksForHeader: (person: string, lead: string) => `Works for ${person} · reports to ${lead}`,
  roleHeader: (role: string, lead: string) => `${role} · reports to ${lead}`,
  ownMemory: "own memory",
  // Lines
  // The org chart's own pair of words (team-chart.tsx CHART_WORDS): reports to, can ask.
  chiefTeam: (n: number) => `Runs the team · can ask ${bots(n)}`,
  reportsTo: (lead: string, asks: string) => `Reports to ${lead} · can ask ${asks}`,
  noBots: "no bots",
  byDefault: (agent: string) => `${agent} by default`,
  alsoRuns: (agents: string) => `also runs ${agents}`,
  threadsRunning: (n: number) => `${n} ${n === 1 ? "thread" : "threads"} running`,
  seqBoth: (e: number, p: number) => `Email: ${e} on · Phone: ${p} on`,
  seqNoPhone: (e: number) => `Email: ${e} on · no phone yet`,
  seqNoEmail: (p: number) => `No email yet · Phone: ${p} on`,
  seqNone: "No email or phone yet",
  // Team
  openChart: "Open the org chart",
  reportsToLabel: "Reports to",
  // Email
  emailSummary: (address: string, n: number) => `${address} · ${n} ${n === 1 ? "sequence" : "sequences"} on`,
  pausedSummary: (address: string, who: string) => `${address} · paused until ${who} upgrade${who === "you" ? "" : "s"}`,
  noEmail: "No email yet",
  noInbox: "No inbox yet.",
  emailLabel: "email",
  emailSequencesLater: "Its sequences show up once it has an email.",
  sequences: "Sequences",
  nOn: (n: number) => `${n} on`,
  builtIn: "Built in",
  locked: "Always on: this is you talking to it.",
  repliesToOthers: "Replies to others",
  replies: { never: "Never", ask: "With your OK", allow: "On its own" } satisfies Record<MailRule, string>,
  repliesNote: {
    ask: "It asks you before it emails anyone but you.",
    allow: "It emails others without asking.",
    allowJustDoIt: "Just do it is on, so it emails others without asking. It still asks about people it found through business data.",
    never: "Its inbox never emails anyone but you. Mail from an app you connected still goes by Approvals.",
  },
  loopGuard: "Loop guard",
  mailGuard: ["Never answers automatic mail", "Never answers its own mail", "Speaks up on at most 12 emails an hour"],
  phoneGuard: ["Only texts you", "Never calls or texts a bot", "Stops when someone texts STOP", "Hangs up after 2 quiet minutes"],
  ifSendFails: "If a send fails",
  ifTextFails: "If a text fails",
  // AgentMail's client tries a send twice more when AgentMail is busy or failing (408, 429, 5xx; lib/server/mail.ts
  // am()), never after no answer (it may have gone); a send that still fails is said in the chat (mail.ts sendFailed).
  mailFails: ["Tries 2 more times if AgentMail is busy", "Says so in chat"],
  textFails: ["Says so in chat"],
  // Today
  nothingToday: "Nothing yet today.",
  mailToday: (o: { in: number; replied: number; held: number; failed: number }) =>
    [`Today ${o.in} in`, o.replied && `${o.replied} replied`, o.held && `${o.held} held by the loop guard`, o.failed && `${o.failed} didn't send`].filter(Boolean).join(" · "),
  phoneToday: (o: { calls: number; texts: number; taken: number }) =>
    [`Today ${o.calls} ${o.calls === 1 ? "call" : "calls"}`, `${o.texts} ${o.texts === 1 ? "text" : "texts"}`, o.taken && `${o.taken} ${o.taken === 1 ? "message" : "messages"} taken`].filter(Boolean).join(" · "),
  openChat: "Open chat",
  // Phone and voice
  phoneSummary: (number: string, voice: string | null, n: number) => [number, voice && `${voice} voice`, `${n} ${n === 1 ? "sequence" : "sequences"} on`].filter(Boolean).join(" · "),
  notTaking: "not taking calls",
  phoneLabel: "mobile · texts and calls",
  teamNumber: (kind: string) => `mobile · ${kind} · the team's number`,
  voice: "Voice",
  pickedForName: "Picked for its name",
  pickedForNameIs: (v: string) => `Picked for its name (${v})`,
  voiceName: (v: CallVoice | string) => cap(v),
  play: (v: string) => `Play ${v}`,
  stop: "Stop",
  noSample: (v: string) => `No sample for ${v} yet.`,
  voiceFailed: "Couldn't change the voice. Try again.",
  // Calls to the number: until its line has a voice set for this one (Workspace.lineVoices), the line's own; then the
  // same voice, or AgentPhone's closest by name (lineVoiceNote).
  voiceNote: (number: string) => `Calls in Bops use this voice. Calls to ${number} use the line's own voice for now.`,
  voiceNoteSame: (number: string) => `Calls in Bops and calls to ${number} use this voice.`,
  voiceNoteClosest: (number: string, name: string) => `Calls in Bops use this voice. Calls to ${number} use ${name}, the closest phone voice.`,
  answersCalls: "Answers calls",
  answersOn: (number: string) => `Picks up when anyone calls ${number}.`,
  answersOnYou: (number: string) => `Picks up when you call ${number}. Someone else calls is off, so anyone else hears a short no.`,
  answersOff: (name: string) => `When you call, you hear that ${name} isn't taking calls and can text instead. Anyone else hears a short no.`,
  cloudStillAnswers: "While your Mac is away, Bops Cloud still answers.",
  // Contact
  phone: "Phone",
  noneYet: "None yet",
  noNumber: "No number yet",
  reachedThrough: (main: string) => `Reached through ${main}'s number`,
  voiceLater: "Its voice settings show up once it has a number.",
  // Skills, Routines, Memory
  skillsCount: (n: number) => (n ? `${n} ${n === 1 ? "skill" : "skills"}` : "No skills yet"),
  noRoutines: "No routines yet",
  memoryOwn: "Keeps its memory to itself",
  memoryTeam: "Uses the team's memory",
  // Saving
  failed: "That didn't save. Try again.",
  offline: "Couldn't reach Bops. Try again.",
  olderBops: "One of your Macs runs an older Bops. These settings hold there once it updates.",
};

/** "+15551230142" → "+1 (555) 123 0142": the page writes numbers with spaces, as its mockups do. */
export const spacedPhone = (n: string) => {
  const d = n.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)} ${d.slice(7)}` : n;
};

/** Who and where it is on the chart, for the line under its name: works for or its role, who it reports to, its own memory. */
export function headerLine(state: AppState, b: Bot): { text: string; ownMemory: boolean } {
  const t = teamIn(state, workspaceOf(b));
  const own = ownMemory(state, b.id);
  if (b.id === t.chief?.id) return { text: SETTINGS_WORDS.chiefHeader, ownMemory: own };
  const lead = t.lead.get(b.id) ?? t.chief?.id;
  const leadName = state.bots.find((x) => x.id === lead)?.name ?? "";
  const who = worksForNow(state, b.id);
  return { text: who ? SETTINGS_WORDS.worksForHeader(who.name, leadName) : SETTINGS_WORDS.roleHeader(b.role, leadName), ownMemory: own };
}

/** The Team card's line closed, and the panel's Team row: who it reports to and whom it may ask (by name, up to two). */
export function teamLine(state: AppState, b: Bot): string {
  const t = teamIn(state, workspaceOf(b));
  const asks = t.bots.filter((x) => x.id !== b.id && mayAskIn(t, b.id, x.id));
  if (b.id === t.chief?.id) return SETTINGS_WORDS.chiefTeam(asks.length);
  const lead = t.lead.get(b.id) ?? t.chief?.id;
  const name = (id: string) => state.bots.find((x) => x.id === id)?.name ?? id;
  const said = asks.length === 0 ? SETTINGS_WORDS.noBots : asks.length <= 2 ? and(asks.map((x) => name(x.id))) : bots(asks.length);
  const line = SETTINGS_WORDS.reportsTo(lead ? name(lead) : "", said);
  return ownMemory(state, b.id) ? `${line} · ${SETTINGS_WORDS.ownMemory}` : line;
}

/** The AI card's line closed, and the panel's AI row (until dev/bot-agents gives it agents): how hard it thinks, and where it works. */
export function aiLine(state: AppState, b: Bot): string {
  // Its AI profile (lib/agents.ts): the agent its new threads start on, the others it can run, its threads running now.
  const ai = aiOf(b, state);
  const def = ai.agents.find((x) => x.id === ai.default) ?? ai.agents[0];
  const others = [...new Set(ai.agents.filter((x) => x.id !== def?.id && x.kind !== def?.kind).map((x) => AGENTS[x.kind].name))];
  const running = state.sessions.filter((s) => s.botId === b.id && live(s)).length;
  return [SETTINGS_WORDS.byDefault(AGENTS[def?.kind ?? "bops"].name), others.length ? SETTINGS_WORDS.alsoRuns(and(others)) : "", running ? SETTINGS_WORDS.threadsRunning(running) : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The kinds of agent a bot can run, its Default first: the marks on the panel's AI row. */
export function aiKinds(state: AppState, b: Bot): AgentKind[] {
  const ai = aiOf(b, state);
  const def = ai.agents.find((x) => x.id === ai.default) ?? ai.agents[0];
  return [...new Set([def?.kind ?? "bops", ...ai.agents.map((x) => x.kind)])];
}

/**
 * What the Voice row says about calls to the number (`agentId`'s line): the same voice or AgentPhone's closest once
 * its line was set for the voice shown (`voice`, Workspace.lineVoices), else the line's own voice for now.
 */
export function lineVoiceNote(state: Pick<AppState, "workspaces">, b: Pick<Bot, "id" | "workspaceId">, agentId: string | undefined, voice: CallVoice | null, number: string): string {
  const lv = agentId ? state.workspaces?.find((w) => w.id === workspaceOf(b))?.lineVoices?.[agentId] : undefined;
  if (!lv || !voice || lv.for !== voice) return SETTINGS_WORDS.voiceNote(number);
  return lv.exact ? SETTINGS_WORDS.voiceNoteSame(number) : SETTINGS_WORDS.voiceNoteClosest(number, lv.name);
}

/** The Replies to others note under its choice. */
export function repliesNote(b: Pick<Bot, "autoApprove" | "permissions">, s: BotSettings): string {
  const rule = mailRule(b, s);
  const own = (b.permissions ?? []).some((r) => r.action === "Send an email");
  if (rule === "allow") return own ? SETTINGS_WORDS.repliesNote.allow : SETTINGS_WORDS.repliesNote.allowJustDoIt;
  return SETTINGS_WORDS.repliesNote[rule];
}
