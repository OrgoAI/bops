"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  belowIn,
  cleanChain,
  directOf,
  entryOf,
  levelIn,
  MAX_DEPTH,
  mayAskIn,
  mayHandOffIn,
  nameFromKey,
  pairKey,
  sidewaysIn,
  teamIn,
  type Chain,
  type ChainBot,
  type Team,
} from "@/lib/chain";
import { accessKey, levelOf, type AccessLevel, type MemberAccess } from "@/lib/member-access";
import { peopleShort, type PeopleRoom } from "@/lib/plan-includes";
import { sharesComputer, workBot, workspaceOf, type AppState, type Bot } from "@/lib/types";
import { Mascot } from "./mascot";
import { LevelPicker, withLevel } from "./members";
import { CloseButton, currentWorkspace, refreshState } from "./ui";

/*
 * The team chart (lib/chain.ts): who each bot of the open workspace answers to, who may ask whom, and who
 * sees and uses each bot. A sheet of its own, opened from the workspace menu, the People sheet and a bot's
 * profile; the owner's only (never with a workspace shared with them open). The tree is drawn from the
 * state at once; a card dragged onto another, a line's popover, the switch and the bot's sheet each save
 * the whole chart at once (PATCH /api/workspaces { id, chain }), with an Undo for a few seconds, and put it
 * back when Bops says no. People's levels are the People sheet's own (PATCH /api/members).
 */

/** Every word the chart says, in one place (the tests read them for dashes and the old name). */
export const CHART_WORDS = {
  title: "Org chart",
  subtitle: (ws: string) => `${ws}: who reports to whom, and who can ask whom`,
  switchLabel: "Bots can ask each other",
  everyone: "Everyone",
  upDown: "Up and down only",
  ownSetting: (n: number) => `${n} ${n === 1 ? "bot has its" : "bots have their"} own setting`,
  legendAnswers: "reports to",
  legendAsk: "can ask",
  legendCant: "can't ask",
  legendMemory: "keeps its memory to itself",
  legendHands: "hands work down",
  chiefSees: (chief: string) => `${chief} sees what every bot is doing.`,
  upDownOpen: "Up and down a line is always open. Tap a bot to edit.",
  you: "You",
  chiefRole: "Chief of staff",
  seesAll: "Sees every bot's work",
  personsBot: (p: string) => `${p}'s bot`,
  tagOwn: "Keeps to itself",
  tagNoWork: "No handoffs",
  tagShares: (chief: string) => `Shares ${chief}'s computer`,
  ghost: "Your next bot goes here.",
  makeBot: "Make a bot",
  ghostNote: "With more bots, you decide here who asks whom.",
  everyoneBadge: "Everyone can ask everyone",
  mostBadge: "Most bots can ask each other",
  upDownBadge: "Asking is up and down only",
  mostlyUpDownBadge: "Asking is mostly up and down",
  answersTo: "Reports to",
  chiefOption: (name: string) => `${name}, chief of staff`,
  worksFor: "Works for",
  nobody: "Nobody in particular",
  toldWorksFor: (p: string) => `It's told it works for ${p}.`,
  cantUseYet: (p: string, bot: string) => `${p} can't use ${bot} yet. Give ${p} Write?`,
  cantUseNow: (p: string, bot: string) => `${p} can't use ${bot} now.`,
  cantUseYetShort: (p: string, bot: string) => `${p} can't use ${bot} yet.`,
  giveWriteAsk: (p: string) => `Give ${p} Write?`,
  giveWrite: "Give Write",
  sideways: "Talks with bots beside it",
  sidewaysOn: (n: number) => `It can ask ${n} ${n === 1 ? "bot" : "bots"} beside it, and they can ask it.`,
  sidewaysOff: (names: string) => `It talks only with ${names}, in its line.`,
  sidewaysNone: (names: string) => `No bot beside it talks sideways, so it talks only with ${names}, in its line.`,
  canAsk: "Can ask",
  alsoAllowed: "Also allowed",
  canAskTip: (lead: string, b: string) => `${lead} leads ${b}, so they can always ask each other.`,
  chiefTip: (chief: string) => `${chief} runs the team: every bot can ask it.`,
  takesWork: (lead: string) => `Takes work from ${lead}`,
  takesWorkOff: "Only you and its people give it work.",
  handsDown: "Hands work to the bots under it",
  memory: "Memory",
  memoryOwn: "Keeps its memory to itself",
  memoryOwnNote: (bot: string) => `What it learns stays with ${bot}. Other bots never read it.`,
  memoryTeam: "It uses the team's memory, like every bot.",
  readsTeam: "Still knows what the team knows",
  readsTeamNote: "It reads the team's memory and Knowledge, and adds nothing to them.",
  memoryFromNow: (bot: string) => `From now on, what ${bot} learns stays with ${bot}. What it learned before stays with the team.`,
  bringAsk: (bot: string) => `Bring what ${bot} learned into the team's memory?`,
  bringIn: "Bring it in",
  keepApart: "Keep it apart",
  keptNote: (bot: string) => `What ${bot} kept to itself is kept apart. Its Memory tab can bring it in or delete it.`,
  brought: (n: number) => `Brought ${n} ${n === 1 ? "fact" : "facts"} into the team's memory.`,
  bringFailed: "Couldn't bring that in. Its Memory tab can try again.",
  computer: "Computer",
  computerShared: (bot: string, chief: string) => `${bot} works on ${chief}'s computer. Logins and files there are shared with the bots on it.`,
  computerOwn: (bot: string) => `${bot} works on its own computer.`,
  giveComputer: "Give it its own computer",
  sharesNote: (a: string, b: string, chief: string) => `${a} and ${b} share ${chief}'s computer. Logins and files there are shared.`,
  giveOwnComputer: (bot: string) => `Give ${bot} its own computer`,
  preset: (p: string) => `Make it ${p}'s own`,
  presetConfirm: (p: string, bot: string) => `${p} gets Write on ${bot}. It talks only with its line, keeps its memory to itself, and other people stop seeing it.`,
  presetGo: "Make it theirs",
  cancel: "Cancel",
  giveBot: (p: string) => `Give ${p} a bot`,
  newBotFor: (p: string) => `Make a new bot for ${p}`,
  olderBops: "One of your Macs runs an older Bops. These rules hold there once it updates.",
  sheetSub: (what: string, lead: string) => `${what} · reports to ${lead}`,
  chiefSub: "Chief of staff · every bot reports to it",
  people: "Team",
  peopleIntro: "Who can see and use each bot. Tap a level to change it.",
  peopleOnBot: "Who can see and use it.",
  ownBot: (bot: string) => `Their own bot: ${bot}`,
  noBots: "No bots yet",
  invited: "Invited",
  readNote: "Read: sees everything the bot does.",
  writeNote: "Write: can also chat with it and have it work.",
  orgoNote: "On orgo.ai, people can watch every computer.",
  seesChats: (p: string, bot: string) => `${p} can see ${bot}'s chats.`,
  nobodyYet: "Nobody else yet. Add people in Team to give them a bot of their own.",
  openPeople: "Open Team",
  done: "Done",
  saved: "Saved.",
  undo: "Undo",
  failed: "Couldn't save that. Try again.",
  ownerOnly: "Only the owner can change the org chart.",
  underItself: (bot: string) => `${bot} can't report to a bot under it.`,
  tooDeep: `The chart goes ${MAX_DEPTH} bots deep at most.`,
  lineTitle: (a: string, b: string) => `${a} and ${b}`,
  lineCanAsk: (a: string, b: string) => `${a} can ask ${b}`,
  lineCant: (a: string, b: string) => `${a} can't ask ${b}`,
  bothAsk: (a: string, b: string) => `${a} and ${b} can ask each other`,
  lineLeads: (lead: string, b: string) => `${lead} leads ${b}, so they can always ask each other.`,
  mayAskLabel: (a: string, b: string) => `${a} can ask ${b}`,
  answersLine: (lead: string, n: number) => `Reports to ${lead} · can ask ${n} ${n === 1 ? "bot" : "bots"}`,
  chiefLine: (n: number) => `Runs the team · can ask ${n} ${n === 1 ? "bot" : "bots"}`,
  more: (n: number) => `+${n}`,
};

/** Someone who may see the workspace's bots, as the chart shows them: from People (GET /api/members), or a test's. */
export type ChartPerson = { key: string; id?: string; name: string; email?: string; access: MemberAccess; invited?: boolean };

/** People's dots, by their order. */
const DOTS = ["#2F6BFF", "#E5484D", "#1F9D55", "#B54708", "#7C3AED", "#0E7490"];

/* ---------------- Layout ---------------- */

const CARD_W = 172;
const CHIEF_W = 206;
const CARD_H = 158;
const CHIEF_H = 164;
const H_GAP = 56;
const V_GAP = 64;
const ROW_GAP = 40;
const PER_ROW = 5;
const OWNER_H = 78;
const PAD = 24;
/** The ghost card under a chief with no bots yet, and its note. */
const GHOST_H = 140;
/** The row the bot's AI chip takes on its card (dev/bot-ai adds the chip, and its height here). Nothing for now. */
const AI_CHIP_H = 0;

type Box = { id: string; x: number; y: number; w: number; h: number };
/** A row of a lead's bots: from its top to the bottom of its deepest bot, and where each bot's own tree spans. */
type Band = { top: number; bottom: number; spans: { id: string; left: number; right: number }[] };

/* What a bot's card shows, and so how tall it is: its tags, a person who lost Write, and the people who see it. */
const CARD_INNER = CARD_W - 24;
/** About how wide a short line of the card's small type is (10.5px), a little over, so a card is never too short. */
const textW = (text: string) => text.length * 6.2;
/** How many rows chips of these widths take, wrapped in the card (a gap of 4 between them). */
function rowsFor(widths: number[]) {
  let rows = 0;
  let x = 0;
  for (const w0 of widths) {
    const w = Math.min(w0, CARD_INNER);
    if (!rows || x + 4 + w > CARD_INNER) {
      rows++;
      x = w;
    } else x += 4 + w;
  }
  return rows;
}
type CardFacts = { tags: string[]; lost: string; chips: { p: ChartPerson; label: string }[]; more: number };
/** A card's height: the most it shows, never less than CARD_H. */
function cardHeight(f: CardFacts) {
  let h = 12 + 52 + 6 + 18 + 16 + 12 + AI_CHIP_H;
  const tags = rowsFor(f.tags.map((x) => textW(x) + 16));
  if (tags) h += 8 + tags * 18 + (tags - 1) * 4;
  if (f.lost) h += 4 + 14;
  const chips = rowsFor([...f.chips.map((c) => textW(c.label) + 22), ...(f.more ? [textW(CHART_WORDS.more(f.more)) + 12] : [])]);
  if (chips) h += 6 + chips * 18 + (chips - 1) * 4;
  return Math.max(CARD_H, Math.ceil(h));
}

/**
 * Where each card goes: the owner on top, the chief under, each bot's bots under it, five a row at most. `heightOf`:
 * each bot's card (the chief's is fixed); a row is as tall as its tallest tree. `rows`: each lead's rows, for its lines.
 */
function layoutOf(t: Team, heightOf: (id: string) => number): { boxes: Map<string, Box>; rows: Map<string, Band[]>; width: number; height: number } {
  const boxes = new Map<string, Box>();
  const rows = new Map<string, Band[]>();
  const chief = t.chief?.id;
  const size = (id: string) => (id === chief ? { w: CHIEF_W, h: CHIEF_H } : { w: CARD_W, h: heightOf(id) });
  type Sub = { id: string; width: number; height: number; rows: Sub[][] };
  const subtree = (id: string, guard = 0): Sub => {
    const kids = guard > MAX_DEPTH + 1 ? [] : directOf(t, id).map((k) => subtree(k, guard + 1));
    const rows: Sub[][] = [];
    for (let i = 0; i < kids.length; i += PER_ROW) rows.push(kids.slice(i, i + PER_ROW));
    const rowW = (r: Sub[]) => r.reduce((n, s) => n + s.width, 0) + H_GAP * (r.length - 1);
    const rowH = (r: Sub[]) => Math.max(...r.map((s) => s.height));
    const width = Math.max(size(id).w, ...rows.map(rowW));
    const height = size(id).h + (rows.length ? V_GAP + rows.reduce((n, r) => n + rowH(r), 0) + ROW_GAP * (rows.length - 1) : 0);
    return { id, width, height, rows };
  };
  const place = (s: Sub, left: number, top: number) => {
    const { w, h } = size(s.id);
    boxes.set(s.id, { id: s.id, x: left + s.width / 2 - w / 2, y: top, w, h });
    let y = top + h + V_GAP;
    const bands: Band[] = [];
    for (const r of s.rows) {
      const rw = r.reduce((n, x) => n + x.width, 0) + H_GAP * (r.length - 1);
      let x = left + s.width / 2 - rw / 2;
      const spans: Band["spans"] = [];
      for (const k of r) {
        spans.push({ id: k.id, left: x, right: x + k.width });
        place(k, x, y);
        x += k.width + H_GAP;
      }
      const bottom = y + Math.max(...r.map((k) => k.height));
      bands.push({ top: y, bottom, spans });
      y = bottom + ROW_GAP;
    }
    if (bands.length) rows.set(s.id, bands);
  };
  if (!chief) return { boxes, rows, width: 0, height: 0 };
  const root = subtree(chief);
  const width = Math.max(root.width, CARD_W * 2 + H_GAP) + PAD * 2;
  place(root, (width - root.width) / 2, PAD + OWNER_H);
  // Room under the cards for an exception's arc and its words; with no bots yet, for the ghost card.
  const ghost = root.rows.length ? 0 : V_GAP + GHOST_H;
  return { boxes, rows, width, height: PAD + OWNER_H + root.height + ghost + (Object.values(t.chain.pairs ?? {}).some(Boolean) ? 96 : 28) };
}

/** A chain as Bops would keep it, to tell whether a change changes anything (`at` aside). */
function sameChain(a: Chain, b: Chain) {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, norm(x)])) : v;
  const { at: _a, ...x } = a;
  const { at: _b, ...y } = b;
  void _a;
  void _b;
  return JSON.stringify(norm(x)) === JSON.stringify(norm(y));
}

/* ---------------- Changing the chart ---------------- */

/** `chain` with bot `id`'s entry changed (a field set to undefined goes); entries left empty go. */
function withBot(chain: Chain, id: string, patch: Partial<Record<keyof ChainBot, unknown>>): Chain {
  const was = chain.bots?.[id] ?? {};
  const next: Record<string, unknown> = { ...was };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const bots = { ...(chain.bots ?? {}) };
  if (Object.keys(next).length) bots[id] = next as ChainBot;
  else delete bots[id];
  const out: Chain = { ...chain, bots };
  if (!Object.keys(bots).length) delete out.bots;
  return out;
}

/** `chain` with one way of an exception set: a asks b (`on`), or not; back to no exception when that's what sideways says anyway. */
function withPair(t: Team, chain: Chain, a: string, b: string, on: boolean): Chain {
  const pairs = { ...(chain.pairs ?? {}) };
  const bySideways = sidewaysIn(t, a) === "open" && sidewaysIn(t, b) === "open";
  if (on === bySideways) delete pairs[pairKey(a, b)];
  else pairs[pairKey(a, b)] = on;
  const out: Chain = { ...chain, pairs };
  if (!Object.keys(pairs).length) delete out.pairs;
  return out;
}

/** How deep a bot's own bots go under it (0: none). */
const heightOf = (t: Team, id: string): number => Math.max(0, ...directOf(t, id).map((k) => 1 + heightOf(t, k)));

/** Why bot `id` can't answer to `lead` (null: it can). */
function cantLead(t: Team, id: string, lead: string, name: (id: string) => string): string | null {
  if (lead === id || belowIn(t, id).includes(lead)) return CHART_WORDS.underItself(name(id));
  if ((t.depth.get(lead) ?? 0) + 1 + heightOf(t, id) > MAX_DEPTH) return CHART_WORDS.tooDeep;
  return null;
}

/** People, from Bops (GET /api/members): null while not known, or when there are none to show (signed out, self hosted). */
function usePeople(given?: ChartPerson[] | null) {
  const [read, setRead] = useState<ChartPerson[] | null>(null);
  // What the plan says about adding people, for the People part when there's nobody yet.
  const [room, setRoom] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (given !== undefined) return;
    let gone = false;
    void fetch("/api/members", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { state?: string; people?: { id: string; name: string; email?: string; access: MemberAccess }[]; invites?: { email: string; access: MemberAccess }[]; seats?: PeopleRoom }) => {
        if (gone) return;
        if (j?.state !== "ready") return setRead(null);
        setRoom(j.seats ? (peopleShort(j.seats, { withAccess: j.people?.length ?? 0, invited: j.invites?.length ?? 0 })?.text ?? null) : null);
        const people = (j.people ?? []).flatMap((p) => {
          const key = accessKey(p);
          return key ? [{ key, id: p.id, name: p.name, email: p.email, access: p.access }] : [];
        });
        const invites = (j.invites ?? []).map((i) => ({ key: i.email.toLowerCase(), name: i.email, email: i.email, access: i.access, invited: true }));
        setRead([...people, ...invites]);
      })
      .catch(() => !gone && setRead(null));
    return () => {
      gone = true;
    };
  }, [given, again]);
  return { people: given !== undefined ? given : read, room, reload: () => setAgain((n) => n + 1) };
}

/* ---------------- The sheet ---------------- */

/** A person's level on a bot as it was, for an Undo (Make it theirs, Give Write) to put back. */
type LevelChange = { p: ChartPerson; botId: string; level: AccessLevel };
/** What a toast's Undo puts back: the chart, and people's levels changed with it. */
type UndoTo = { chain: Chain; levels?: LevelChange[] };

/**
 * Everything the chart holds to change it, for the chart and for a bot's settings page (bot-settings.tsx): the chart as
 * shown (a change being saved at once), people and their levels, the toast with its Undo, and each way to save.
 */
export function useChartEditor(state: AppState, givenPeople?: ChartPerson[] | null) {
  const wsId = currentWorkspace(state);
  const ws = state.workspaces?.find((w) => w.id === wsId);
  // A change being saved, shown at once; Bops' copy comes back with the state.
  const [pending, setPending] = useState<Chain | null>(null);
  const chain = pending ?? ws?.chain ?? {};
  const t = teamIn({ bots: state.bots, workspaces: [{ id: wsId, chain }] }, wsId);
  const byId = new Map(state.bots.map((b) => [b.id, b]));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const [toast, setToast] = useState<{ text: string; undo?: UndoTo; error?: boolean } | null>(null);
  const { people, room, reload } = usePeople(givenPeople);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A Mac or runner on the account on a Bops from before the chart (GET /api/workspaces?olderBops=1): said under it.
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

  const say = (text: string, o: { undo?: UndoTo; error?: boolean } = {}) => {
    setToast({ text, ...o });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);

  /**
   * Save the whole chart: shown at once, put back when Bops says no. Says Saved (or `said`), with an Undo to what it
   * was (and to people's `levels` changed with it), unless `undoable` is false. Nothing is sent, or said, when Bops
   * would keep the same chart. True when it's kept.
   */
  const save = async (next: Chain, o: { undoable?: boolean; said?: string; levels?: LevelChange[] } = {}): Promise<boolean> => {
    const was = chain;
    // Shown as Bops keeps it; sent whole, as Bops cleans it again with what it has (people just given a bot too).
    const shown = cleanChain(next, t.bots, ws?.memberAccess);
    if (!o.levels?.length && sameChain(shown, cleanChain(chain, t.bots, ws?.memberAccess))) return true;
    setPending(shown);
    let ok = false;
    try {
      const res = await fetch("/api/workspaces", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wsId, chain: next }) });
      ok = res.ok;
      if (!ok && res.status === 403) {
        setPending(null);
        say(CHART_WORDS.ownerOnly, { error: true });
        return false;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // Back to what Bops keeps.
      setPending(null);
      say(CHART_WORDS.failed, { error: true });
      return false;
    }
    await refreshState();
    setPending(null);
    if (o.undoable !== false) say(o.said ?? CHART_WORDS.saved, { undo: { chain: was, levels: o.levels } });
    return true;
  };

  /** What a person sees now: the workspace's copy (synced), else what People said. */
  const accessOf = (p: ChartPerson): MemberAccess => (ws?.memberAccess && Object.hasOwn(ws.memberAccess, p.key) ? ws.memberAccess[p.key] : p.access);
  const levelFor = (p: ChartPerson, botId: string) => levelOf(accessOf(p), botId);
  /** A person's level on one bot, through People's own PATCH /api/members: a member by id, an invite still waiting by its email. True when it went. */
  const sendLevel = async (p: ChartPerson, botId: string, level: AccessLevel) => {
    const access = withLevel(accessOf(p), botId, level);
    const body = p.id ? { memberId: p.id, access } : p.invited ? { invite: p.email ?? p.key, access } : null;
    if (!body) return false;
    const res = await fetch("/api/members", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    return !!res?.ok;
  };
  const shown = async () => {
    await refreshState();
    reload();
  };
  /** Levels put back as they were (an Undo, or a change that went only part of the way). */
  const putBack = async (levels: LevelChange[]) => {
    for (const l of [...levels].reverse()) await sendLevel(l.p, l.botId, l.level);
    if (levels.length) await shown();
  };
  /** A person's level on a bot, from the People sheet's own control. */
  const setLevel = async (p: ChartPerson, botId: string, level: AccessLevel) => {
    if (!p.id) return;
    if (!(await sendLevel(p, botId, level))) say(CHART_WORDS.failed, { error: true });
    await shown();
  };
  /**
   * Make it someone's own (the preset): their Write on it and everyone else's None (an invite still waiting too),
   * through People's own PATCH, then the chart (works for them, talks only with its line, keeps its memory to
   * itself) in one save. All or nothing: what went is put back when a step fails. Its Undo puts back both.
   */
  const makeTheirs = async (p: ChartPerson, botId: string) => {
    const others = (people ?? []).filter((q) => q.key !== p.key && (q.id || q.invited) && levelFor(q, botId) !== "none");
    const done: LevelChange[] = [];
    for (const [who, level] of [[p, "write"] as const, ...others.map((q) => [q, "none"] as const)]) {
      const before = levelFor(who, botId);
      if (!(await sendLevel(who, botId, level))) {
        await putBack(done);
        return say(CHART_WORDS.failed, { error: true });
      }
      done.push({ p: who, botId, level: before });
    }
    await shown();
    if (!(await save(withBot(chain, botId, { for: p.key, forName: p.name.split(" ")[0], sideways: "closed", memory: "own", kept: undefined }), { levels: done }))) await putBack(done);
  };
  /** Give the person picked for "Works for" Write on the bot (they see no bot yet), then say it works for them, in one Undo. */
  const giveWriteFor = async (p: ChartPerson, botId: string) => {
    const before = levelFor(p, botId);
    if (!(await sendLevel(p, botId, "write"))) return say(CHART_WORDS.failed, { error: true });
    await shown();
    const levels = [{ p, botId, level: before }];
    if (!(await save(withBot(chain, botId, { for: p.key, forName: p.name.split(" ")[0] }), { levels }))) await putBack(levels);
  };
  /** An Undo: people's levels as they were, then the chart. */
  const undo = async (back: UndoTo) => {
    await putBack(back.levels ?? []);
    await save(back.chain, { undoable: false });
  };
  /**
   * "Bring it in": the chart first, with what it kept still kept apart until it's brought in (the route lets go of
   * that once it is), so a save that failed brings nothing in; then what it learned, into the team's memory.
   */
  const bringIn = async (botId: string) => {
    if (!(await save(withBot(chain, botId, { memory: undefined, readsTeam: undefined, kept: true }), { undoable: false }))) return;
    const res = await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "bring-in", bot: botId }) }).catch(() => null);
    const j = ((await res?.json().catch(() => null)) ?? {}) as { count?: number };
    await refreshState();
    if (res?.ok && typeof j.count === "number") say(CHART_WORDS.brought(j.count));
    else say(CHART_WORDS.bringFailed, { error: true });
  };
  /** A bot that shares the main bot's computer gets one of its own (PATCH /api/bots, as its profile does). */
  const giveComputer = async (botId: string) => {
    const res = await fetch("/api/bots", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId, computer: "own" }) }).catch(() => null);
    const j = ((await res?.json().catch(() => null)) ?? {}) as { error?: string };
    if (!res?.ok) say(j.error ?? CHART_WORDS.failed, { error: true });
    await refreshState();
  };
  return { wsId, ws, chain, t, byId, name, toast, setToast, say, save, people, room, reload, older, accessOf, levelFor, setLevel, makeTheirs, giveWriteFor, undo, bringIn, giveComputer };
}

export type ChartEditor = ReturnType<typeof useChartEditor>;

/**
 * The Org chart: Settings' section of who answers to whom (bops-app.tsx Settings), a part of the page like its others.
 * A bot's card opens its side panel here (BotSheet), a line its popover; Esc closes those first, then the app's own Esc
 * goes back from Settings.
 */
export function TeamChart({
  state,
  focus,
  people: givenPeople,
  onMakeBot,
  onOpenPeople,
}: {
  state: AppState;
  /** Kept for the tests and older callers: the chart is a section now, with nothing of its own to close. */
  onClose?: () => void;
  /** A bot whose sheet is open from the start (from its profile). */
  focus?: string;
  /** Who sees the bots (tests, and a page drawn without Bops): read from People when not given. */
  people?: ChartPerson[] | null;
  /** The sidebar's + (a new bot). */
  onMakeBot?: () => void;
  /** Team, in Settings. */
  onOpenPeople?: () => void;
}) {
  const { ws, chain, t, byId, name, toast, setToast, say, save, people, room, older, levelFor, setLevel, makeTheirs, giveWriteFor, undo, bringIn, giveComputer } = useChartEditor(state, givenPeople);
  const [picked, setPicked] = useState<string | null>(focus ?? null);
  const [popover, setPopover] = useState<{ a: string; b: string; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [shaking, setShaking] = useState<string | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  // The chart takes the keyboard when it opens (a bot's sheet open from the start takes it itself).
  useEffect(() => {
    if (!focus) dialog.current?.focus({ preventScroll: true });
  }, [focus]);
  // The preset asked for from the People part: the bot's sheet opens with it.
  const [presetFor, setPresetFor] = useState<{ botId: string; key: string } | null>(null);

  /** The bot's sheet closed: the keyboard goes back to its card. */
  const closeSheet = () => {
    const id = picked;
    setPicked(null);
    setPresetFor(null);
    if (id) setTimeout(() => dialog.current?.querySelector<HTMLElement>(`[data-card="${id}"]`)?.focus(), 0);
  };
  /** Esc closes what's on top first: a line's popover, then the bot's sheet; only then the chart (bops-app.tsx). */
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (popover) setPopover(null);
    else if (picked) closeSheet();
    else return;
    e.stopPropagation();
  };

  const drop = (target: string) => {
    const id = dragging;
    setDragging(null);
    setOver(null);
    if (!id || id === t.chief?.id) return;
    const why = cantLead(t, id, target, name);
    if (why) {
      setShaking(id);
      setTimeout(() => setShaking(null), 500);
      return say(why, { error: true });
    }
    if ((t.lead.get(id) ?? t.chief?.id) === target) return;
    void save(withBot(chain, id, { lead: target === t.chief?.id ? undefined : target }));
  };

  if (!ws || state.shared) return null;
  const chief = t.chief ? byId.get(t.chief.id) : undefined;
  // What each card shows, which says how tall it is.
  const facts = new Map(t.bots.map((tb) => [tb.id, cardFacts(t, state, byId.get(tb.id), people, levelFor)]));
  const { boxes, rows, width, height } = layoutOf(t, (id) => cardHeight(facts.get(id)!));
  const others = t.bots.filter((b) => b.id !== t.chief?.id);
  // Bots with a sideways setting of their own: the switch doesn't change them.
  const own = others.filter((b) => chain.bots?.[b.id]?.sideways !== undefined).length;
  const many = others.length > 6;
  const pickedBot = picked ? byId.get(picked) : undefined;
  const listed = (people ?? []).filter((p) => !p.invited);

  return (
      <div
        ref={dialog}
        role="region"
        aria-labelledby="chart-title"
        tabIndex={-1}
        data-team-chart
        onKeyDown={onKey}
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden outline-none"
      >
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3 px-[26px] pb-3 pt-6">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span id="chart-title" className="text-[22px] font-bold leading-7 tracking-[-0.02em]">
                {CHART_WORDS.title}
              </span>
              <span className="text-[13px] leading-[19px] text-[#6B6B6B]">{CHART_WORDS.subtitle(ws.name)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 px-[26px] pb-3">
            <span className="text-[13px] font-medium leading-4 text-[#3A3A38]">{CHART_WORDS.switchLabel}</span>
            <div role="radiogroup" aria-label={CHART_WORDS.switchLabel} data-sideways-switch className="flex gap-0.5 rounded-[10px] bg-[#F6F6F4] p-[2px] shadow-[inset_0_0_0_1px_#E8E8E5]">
              {(["open", "closed"] as const).map((v) => {
                const on = (chain.sideways ?? "open") === v;
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => !on && void save({ ...chain, sideways: v === "open" ? undefined : "closed" })}
                    className={`rounded-[8px] px-2.5 py-1 text-[12.5px] leading-4 ${on ? "bg-white font-semibold text-ink shadow-[0_1px_2px_#00000014]" : "text-[#3A3A38] hover:text-ink"}`}
                  >
                    {v === "open" ? CHART_WORDS.everyone : CHART_WORDS.upDown}
                  </button>
                );
              })}
            </div>
            {own > 0 && <span className="text-[12px] leading-4 text-[#8A8A88]">{CHART_WORDS.ownSetting(own)}</span>}
          </div>

          {/* The chart and everything under it: the chart keeps at least 300px and scrolls in its frame; the rest
              (notes, People) scrolls under it when there's more than fits. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-chart-scroll>
            <div className="relative mx-[26px] flex min-h-[300px] flex-1 flex-col overflow-auto rounded-[18px] bg-[#F6F6F4] [background-image:radial-gradient(#DDDDD8_1px,transparent_1px)] [background-size:18px_18px]" onClick={() => setPopover(null)}>
              <div className="relative mx-auto shrink-0" style={{ width, height }}>
                <Wires t={t} boxes={boxes} rows={rows} picked={picked} many={many} ghost={others.length === 0} name={name} onLine={(a, b, x, y) => setPopover({ a, b, x, y })} />
                {/* You, on top. */}
                {chief && (
                  <div className="absolute flex -translate-x-1/2 flex-col items-center" style={{ left: width / 2, top: PAD - 6 }}>
                    <div className="grid size-[46px] place-items-center rounded-full bg-ink text-[15px] font-semibold text-white shadow-[0_0_0_4px_#FFFFFF,0_4px_14px_#0000001F]">{initials(state)}</div>
                    <div className="mt-2 rounded-full bg-white px-2.5 py-[3px] text-[12.5px] leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#E8E8E5]">{CHART_WORDS.you}</div>
                  </div>
                )}
                {t.bots.map((tb) => {
                  const b = byId.get(tb.id);
                  const box = boxes.get(tb.id);
                  if (!b || !box) return null;
                  return (
                    <Card
                      key={b.id}
                      bot={b}
                      box={box}
                      t={t}
                      state={state}
                      facts={facts.get(b.id)!}
                      people={people}
                      picked={picked === b.id}
                      dragging={!!dragging}
                      glow={!!dragging && dragging !== b.id && !cantLead(t, dragging, b.id, name)}
                      over={over === b.id}
                      shaking={shaking === b.id}
                      onPick={() => {
                        setPopover(null);
                        if (picked === b.id) closeSheet();
                        else setPicked(b.id);
                      }}
                      onDragStart={() => b.id !== t.chief?.id && setDragging(b.id)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onDragOver={() => dragging && setOver(b.id)}
                      onDrop={() => drop(b.id)}
                    />
                  );
                })}
                {others.length === 0 && chief && <Ghost box={boxes.get(chief.id)!} onMakeBot={onMakeBot} />}
                {many && !picked && (
                  <div className="absolute right-4 top-4 rounded-full bg-white/90 px-3 py-1 text-[11.5px] leading-4 text-[#6B6B6B] shadow-[0_0_0_1px_#E8E8E5]" data-ask-badge>
                    {askBadge(t, chain)}
                  </div>
                )}
                {popover && <LinePopover t={t} chain={chain} {...popover} name={name} onSave={(next) => void save(next)} onClose={() => setPopover(null)} />}
              </div>
              {/* With one bot there's nothing to read yet, and the ghost card has the room. */}
              {others.length > 0 && <Legend memory={others.some((b) => entryOf(t, b.id).memory === "own")} />}
            </div>

            <p className="px-[26px] pt-3 text-[12.5px] leading-[18px] text-[#6B6B6B]">
              {chief && `${CHART_WORDS.chiefSees(chief.name)} `}
              {CHART_WORDS.upDownOpen}
            </p>
            {/* Bots that can't ask each other on one computer: what's there is shared all the same. */}
            {chief &&
              sharedPairs(t, state).map(([a, b]) => (
                <div key={`${a}|${b}`} data-shares-note className="mx-[26px] mt-2 flex items-center justify-between gap-3 rounded-[12px] bg-[#FFF7E6] px-3 py-2 text-[12.5px] leading-[18px] text-[#8A5A00] shadow-[inset_0_0_0_1px_#F5D9A6]">
                  <span>{CHART_WORDS.sharesNote(name(a), name(b), chief.name)}</span>
                  <button type="button" onClick={() => void giveComputer(a)} className="shrink-0 rounded-full bg-white px-3 py-1 text-[12px] font-medium text-ink shadow-[0_0_0_1px_#F5D9A6] hover:bg-[#FFFDF8]">
                    {CHART_WORDS.giveOwnComputer(name(a))}
                  </button>
                </div>
              ))}
            {/* A Mac or runner on the account on a Bops from before the chart: it runs turns by the old rules until it updates. */}
            {older && (
              <p className="px-[26px] pt-2 text-[12px] leading-4 text-[#B54708]" data-older-bops>
                {CHART_WORDS.olderBops}
              </p>
            )}

            {people !== null && (
              <PeoplePart
                open={peopleOpen}
                onToggle={() => setPeopleOpen(!peopleOpen)}
                people={people}
                bots={t.bots.map((x) => byId.get(x.id)!).filter(Boolean)}
                t={t}
                levelFor={levelFor}
                planNote={room}
                onPickBot={(id) => setPicked(id)}
                onOpenPeople={onOpenPeople}
                onGiveBot={(p, botId) => {
                  setPresetFor({ botId, key: p.key });
                  setPicked(botId);
                }}
                onMakeBot={onMakeBot}
              />
            )}
            <div className="h-4 shrink-0" />
          </div>
          {toast && (
            <div role={toast.error ? "alert" : "status"} className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink px-4 py-2 text-[12.5px] leading-4 text-white shadow-[0_8px_24px_#00000033]">
              <span>{toast.text}</span>
              {toast.undo && (
                <button
                  type="button"
                  onClick={() => {
                    const back = toast.undo!;
                    setToast(null);
                    void undo(back);
                  }}
                  className="font-semibold text-highlighter hover:underline"
                >
                  {CHART_WORDS.undo}
                </button>
              )}
            </div>
          )}
        </div>
        {pickedBot && (
          <BotSheet
            key={pickedBot.id}
            bot={pickedBot}
            state={state}
            t={t}
            chain={chain}
            people={listed}
            peopleKnown={people !== null}
            levelFor={levelFor}
            name={name}
            onSave={(next, said) => save(next, { said })}
            onLevel={(p, level) => void setLevel(p, pickedBot.id, level)}
            onGiveWriteFor={(p) => void giveWriteFor(p, pickedBot.id)}
            onBringIn={() => void bringIn(pickedBot.id)}
            onClose={closeSheet}
            presetKey={presetFor?.botId === pickedBot.id ? presetFor.key : undefined}
            onPreset={(p) => {
              setPresetFor(null);
              void makeTheirs(p, pickedBot.id);
            }}
            onGiveComputer={() => void giveComputer(pickedBot.id)}
          />
        )}
      </div>
  );
}

/**
 * The quiet badge with more than 6 bots: whether everyone can ask everyone, asking is up and down only, or most of
 * one or the other (a bot with its own setting, an exception).
 */
function askBadge(t: Team, chain: Chain) {
  const chief = t.chief?.id;
  const inLine = (a: string, b: string) => belowIn(t, a).includes(b) || belowIn(t, b).includes(a);
  const pairs = t.bots.flatMap((a) => t.bots.filter((b) => b.id !== a.id).map((b) => [a.id, b.id] as const));
  if (pairs.every(([a, b]) => mayAskIn(t, a, b))) return CHART_WORDS.everyoneBadge;
  if (chain.sideways !== "closed") return CHART_WORDS.mostBadge;
  return pairs.some(([a, b]) => a !== chief && b !== chief && !inLine(a, b) && mayAskIn(t, a, b)) ? CHART_WORDS.mostlyUpDownBadge : CHART_WORDS.upDownBadge;
}

/** The owner's initials, for the chip on top. */
function initials(state: AppState) {
  const n = state.owner?.name || state.account?.user.name || "";
  const parts = n.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)![0] : (parts[0]?.slice(0, 2) ?? "Y")).toUpperCase();
}

/* ---------------- The lines ---------------- */

/** Two bots beside each other in one row (the same lead), left to right. */
function neighbours(t: Team): [string, string][] {
  const out: [string, string][] = [];
  for (const b of t.bots) {
    const kids = directOf(t, b.id);
    for (let i = 0; i + 1 < kids.length; i++) if ((i + 1) % PER_ROW !== 0) out.push([kids[i], kids[i + 1]]);
  }
  return out;
}

/** Enter or Space on a line, as a tap. */
const keyTap = (go: () => void) => (e: ReactKeyboardEvent) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  e.stopPropagation();
  go();
};

function Wires({
  t,
  boxes,
  rows,
  picked,
  many,
  ghost,
  name,
  onLine,
}: {
  t: Team;
  boxes: Map<string, Box>;
  rows: Map<string, Band[]>;
  picked: string | null;
  many: boolean;
  /** No bots yet: a dashed line to the ghost card. */
  ghost: boolean;
  name: (id: string) => string;
  onLine: (a: string, b: string, x: number, y: number) => void;
}) {
  const chief = t.chief?.id;
  const top = chief ? boxes.get(chief) : undefined;
  const lines: React.ReactNode[] = [];
  // The owner to the chief.
  if (top) lines.push(<path key="owner" d={`M${top.x + top.w / 2} ${PAD + 64} L${top.x + top.w / 2} ${top.y}`} stroke="#0A0A0A" strokeWidth="2" fill="none" />);
  if (top && ghost) lines.push(<path key="ghost" d={`M${top.x + top.w / 2} ${top.y + top.h} L${top.x + top.w / 2} ${top.y + top.h + V_GAP}`} stroke="#C9C9C5" strokeWidth="2" strokeDasharray="5 5" fill="none" />);
  /** A line a tap (or Enter) opens the popover of, said by its two bots' names for the keyboard and screen readers. */
  const tappable = (key: string, a: string, b: string, x: number, y: number, dim: boolean, body: React.ReactNode, extra: Record<string, string> = {}) => (
    <g
      key={key}
      {...extra}
      role="button"
      tabIndex={0}
      aria-label={CHART_WORDS.lineTitle(name(a), name(b))}
      opacity={dim ? 0.35 : 1}
      className="cursor-pointer outline-none [&:focus-visible_path]:stroke-[3.5]"
      onClick={(e) => (e.stopPropagation(), onLine(a, b, x, y))}
      onKeyDown={keyTap(() => onLine(a, b, x, y))}
    >
      {body}
    </g>
  );
  /** Answers to: the line itself, and an arrow at the bot when its lead hands work down. */
  const answers = (lead: string, b: string, d: string, x2: number, y2: number) => (
    <>
      <path d={d} stroke="transparent" strokeWidth="14" fill="none" />
      <path data-line="answers" d={d} stroke="#0A0A0A" strokeWidth="2" fill="none" strokeLinejoin="round" />
      {mayHandOffIn(t, lead, b) && <path d={`M${x2 - 5} ${y2 - 9} L${x2} ${y2 - 2} L${x2 + 5} ${y2 - 9}`} stroke="#0A0A0A" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
    </>
  );
  // A lead's second row on (more than PER_ROW bots): by a bracket, never under a card of the rows above.
  const rowOf = new Map<string, number>();
  for (const bands of rows.values()) bands.forEach((band, r) => band.spans.forEach((sp) => rowOf.set(sp.id, r)));
  // Answers to: down the tree, an arrow where the lead hands work down. The first row of a lead's bots: a curve each.
  for (const b of t.bots) {
    const lead = t.lead.get(b.id);
    const p = lead ? boxes.get(lead) : undefined;
    const c = boxes.get(b.id);
    if (!p || !c || !lead || (rowOf.get(b.id) ?? 0) > 0) continue;
    const [x1, y1, x2, y2] = [p.x + p.w / 2, p.y + p.h, c.x + c.w / 2, c.y];
    const mid = (y1 + y2) / 2;
    const dim = !!picked && picked !== b.id && picked !== lead;
    lines.push(tappable(`l-${b.id}`, lead, b.id, (x1 + x2) / 2, mid, dim, answers(lead, b.id, `M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`, x2, y2)));
  }
  // The rows after: one trunk from the lead, down the gaps between the trees of each row above (the one nearest
  // its way), to a bus in the gap over the row, and a drop to each of its bots.
  for (const [lead, bands] of rows) {
    const p = boxes.get(lead);
    if (!p || bands.length < 2) continue;
    const [x0, y0] = [p.x + p.w / 2, p.y + p.h];
    const busY = (k: number) => (k === 0 ? y0 + V_GAP / 2 : bands[k - 1].bottom + ROW_GAP / 2);
    for (let r = 1; r < bands.length; r++) {
      let x = x0;
      const pts: [number, number][] = [
        [x0, y0],
        [x0, busY(0)],
      ];
      for (let k = 0; k < r; k++) {
        const sp = bands[k].spans;
        const lanes = [sp[0].left - H_GAP / 2, ...sp.slice(1).map((q, i) => (sp[i].right + q.left) / 2), sp[sp.length - 1].right + H_GAP / 2].map((v) => Math.max(6, v));
        const lane = lanes.reduce((a, v) => (Math.abs(v - x) < Math.abs(a - x) ? v : a));
        pts.push([lane, busY(k)], [lane, busY(k + 1)]);
        x = lane;
      }
      const kids = bands[r].spans.map((q) => q.id);
      const dim = !!picked && picked !== lead && !kids.includes(picked);
      lines.push(<path key={`t-${lead}-${r}`} data-line="trunk" d={`M${pts.map(([a, b]) => `${a} ${b}`).join(" L")}`} stroke="#0A0A0A" strokeWidth="2" fill="none" strokeLinejoin="round" opacity={dim ? 0.35 : 1} />);
      const yb = busY(r);
      for (const id of kids) {
        const c = boxes.get(id);
        if (!c) continue;
        const cx = c.x + c.w / 2;
        const one = !!picked && picked !== lead && picked !== id;
        lines.push(tappable(`l-${id}`, lead, id, cx, (yb + c.y) / 2, one, answers(lead, id, `M${x} ${yb} L${cx} ${yb} L${cx} ${c.y}`, cx, c.y)));
      }
    }
  }
  // Beside each other: can ask (dotted, arrowheads when one way) or can't (dashed, with a cross).
  const shown = new Set<string>();
  for (const [a, b] of neighbours(t)) {
    const A = boxes.get(a);
    const B = boxes.get(b);
    if (!A || !B) continue;
    shown.add(pairKey(a, b)).add(pairKey(b, a));
    const ab = mayAskIn(t, a, b);
    const ba = mayAskIn(t, b, a);
    if (ab && ba && many && picked !== a && picked !== b) continue;
    // At the cards' middle as their shortest is drawn, whatever each one's height.
    const y = A.y + CARD_H / 2;
    const [x1, x2] = [A.x + A.w + 6, B.x - 6];
    const dim = !!picked && picked !== a && picked !== b;
    const mx = (x1 + x2) / 2;
    lines.push(
      tappable(
        `s-${a}-${b}`,
        a,
        b,
        mx,
        y,
        dim,
        <>
          <path d={`M${x1} ${y} L${x2} ${y}`} stroke="transparent" strokeWidth="16" />
          {ab || ba ? (
            <>
              <path d={`M${x1} ${y} L${x2} ${y}`} stroke="#2F6BFF" strokeWidth="2" strokeDasharray="2 6" strokeLinecap="round" fill="none" />
              {ab && !ba && <path d={`M${x2 - 7} ${y - 5} L${x2} ${y} L${x2 - 7} ${y + 5}`} stroke="#2F6BFF" strokeWidth="2" fill="none" strokeLinecap="round" />}
              {ba && !ab && <path d={`M${x1 + 7} ${y - 5} L${x1} ${y} L${x1 + 7} ${y + 5}`} stroke="#2F6BFF" strokeWidth="2" fill="none" strokeLinecap="round" />}
            </>
          ) : (
            <>
              <path d={`M${x1} ${y} L${x2} ${y}`} stroke="#E5484D" strokeWidth="2" strokeDasharray="5 5" fill="none" />
              <circle cx={mx} cy={y} r="11" fill="#FFFFFF" stroke="#E5484D" strokeWidth="1.8" />
              <path d={`M${mx - 4.5} ${y - 4.5} L${mx + 4.5} ${y + 4.5} M${mx + 4.5} ${y - 4.5} L${mx - 4.5} ${y + 4.5}`} stroke="#E5484D" strokeWidth="2" strokeLinecap="round" />
              <text x={mx} y={y - 20} textAnchor="middle" fontSize="11" fontWeight="600" fill="#E5484D">
                {CHART_WORDS.legendCant}
              </text>
            </>
          )}
        </>,
        { "data-line": ab || ba ? "ask" : "cant", "data-pair": `${a}|${b}` },
      ),
    );
  }
  // An exception between two bots not side by side: an arc under them, said in words (both ways when both are allowed).
  for (const [key, on] of Object.entries(t.chain.pairs ?? {})) {
    const [a, b] = key.split(">");
    if (!on || shown.has(key) || (mayAskIn(t, b, a) && shown.has(pairKey(b, a)))) continue;
    const A = boxes.get(a);
    const B = boxes.get(b);
    if (!A || !B || !mayAskIn(t, a, b)) continue;
    shown.add(key);
    const [x1, y1, x2, y2] = [A.x + A.w / 2, A.y + A.h + 4, B.x + B.w / 2, B.y + B.h + 4];
    const dip = Math.max(y1, y2) + 64;
    const dim = !!picked && picked !== a && picked !== b;
    lines.push(
      tappable(
        `p-${key}`,
        a,
        b,
        (x1 + x2) / 2,
        dip - 12,
        dim,
        <>
          <path d={`M${x1} ${y1} C${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`} stroke="#2F6BFF" strokeWidth="2" strokeDasharray="2 6" strokeLinecap="round" fill="none" />
          <foreignObject x={(x1 + x2) / 2 - 110} y={dip - 30} width="220" height="26">
            <div className="flex justify-center">
              <span className="rounded-full bg-white px-2.5 py-[3px] text-[11px] leading-4 text-[#2F6BFF] shadow-[0_0_0_1px_#CFE0FF]">{mayAskIn(t, b, a) ? CHART_WORDS.bothAsk(name(a), name(b)) : CHART_WORDS.mayAskLabel(name(a), name(b))}</span>
            </div>
          </foreignObject>
        </>,
        { "data-line": "exception" },
      ),
    );
  }
  return <svg className="absolute left-0 top-0 h-full w-full overflow-visible">{lines}</svg>;
}

/** What a line says when tapped: whether each of the two may ask the other, or that one leads the other. */
function LinePopover({ t, chain, a, b, x, y, name, onSave, onClose }: { t: Team; chain: Chain; a: string; b: string; x: number; y: number; name: (id: string) => string; onSave: (next: Chain) => void; onClose: () => void }) {
  const lead = t.lead.get(b) === a ? a : t.lead.get(a) === b ? b : null;
  const fixed = lead || a === t.chief?.id || b === t.chief?.id || belowIn(t, a).includes(b) || belowIn(t, b).includes(a);
  return (
    <div
      role="dialog"
      aria-label={CHART_WORDS.lineTitle(name(a), name(b))}
      data-line-popover
      onClick={(e) => e.stopPropagation()}
      className="motion-menu-in absolute z-20 flex w-[270px] -translate-x-1/2 flex-col gap-2 rounded-[14px] bg-white p-3 shadow-[0_0_0_1px_#E6E6E3,0_12px_32px_#0000001F]"
      style={{ left: x, top: y + 14 }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold leading-4">{CHART_WORDS.lineTitle(name(a), name(b))}</span>
        <button type="button" aria-label="Close" onClick={onClose} className="text-[#9A9A98] hover:text-ink">
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {fixed ? (
        <span className="text-[12px] leading-4 text-[#6B6B6B]">
          {CHART_WORDS.lineLeads(name(lead ?? (belowIn(t, a).includes(b) || a === t.chief?.id ? a : b)), name(lead === a || belowIn(t, a).includes(b) || a === t.chief?.id ? b : a))}
        </span>
      ) : (
        ([
          [a, b],
          [b, a],
        ] as const).map(([x1, x2]) => (
          <Switch key={`${x1}>${x2}`} label={CHART_WORDS.lineCanAsk(name(x1), name(x2))} on={mayAskIn(t, x1, x2)} onFlip={(on) => onSave(withPair(t, chain, x1, x2, on))} />
        ))
      )}
    </div>
  );
}

function Legend({ memory }: { memory: boolean }) {
  return (
    <div className="sticky left-0 mx-auto mb-3.5 mt-auto flex w-fit shrink-0 items-center gap-4 whitespace-nowrap rounded-[12px] bg-white/90 px-3 py-2 text-[11.5px] leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#E8E8E5]">
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <path d="M0 4 H26" stroke="#0A0A0A" strokeWidth="2" />
        </svg>
        {CHART_WORDS.legendAnswers}
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <path d="M7 1 V12 M2.5 7.5 L7 12 L11.5 7.5" stroke="#0A0A0A" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {CHART_WORDS.legendHands}
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <path d="M1 4 H25" stroke="#2F6BFF" strokeWidth="2" strokeDasharray="2 5" strokeLinecap="round" />
        </svg>
        {CHART_WORDS.legendAsk}
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="26" height="8" aria-hidden>
          <path d="M0 4 H26" stroke="#E5484D" strokeWidth="2" strokeDasharray="5 4" />
        </svg>
        {CHART_WORDS.legendCant}
      </span>
      {memory && (
        <span className="flex items-center gap-1.5">
          <Lock />
          {CHART_WORDS.legendMemory}
        </span>
      )}
    </div>
  );
}

export function Lock() {
  return (
    <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden>
      <rect x="1" y="5" width="9" height="6.5" rx="1.6" fill="#C9A227" />
      <path d="M3 5V3.6a2.5 2.5 0 015 0V5" fill="none" stroke="#8A6D12" strokeWidth="1.4" />
    </svg>
  );
}

/* ---------------- A bot's card ---------------- */

/** What a bot's card shows besides its name (and so how tall it is): its tags, its person who can't use it, who sees it. */
function cardFacts(t: Team, state: AppState, b: Bot | undefined, people: ChartPerson[] | null, levelFor: (p: ChartPerson, botId: string) => AccessLevel): CardFacts {
  if (!b || b.id === t.chief?.id) return { tags: [], lost: "", chips: [], more: 0 };
  const e = entryOf(t, b.id);
  const who = whoFor(t, state, b.id, people);
  const tags = [
    e.memory === "own" ? CHART_WORDS.tagOwn : "",
    e.takesWork === false ? CHART_WORDS.tagNoWork : "",
    sharesWarning(t, state, b) ? CHART_WORDS.tagShares(state.bots.find((x) => x.id === t.chief?.id)?.name ?? "") : "",
  ].filter(Boolean);
  // Its person can't use it: "now" once their level changed since the chart last did (Write taken away), else "yet".
  const lost = who && !who.write ? (who.since ? CHART_WORDS.cantUseNow(who.name, b.name) : CHART_WORDS.cantUseYetShort(who.name, b.name)) : "";
  const seen = (people ?? []).filter((p) => !p.invited && levelFor(p, b.id) !== "none");
  // Three at most: two and "+n" when there are more.
  const shown = seen.length > 3 ? seen.slice(0, 2) : seen;
  return { tags, lost, chips: shown.map((p) => ({ p, label: `${p.name.split(" ")[0]} · ${levelFor(p, b.id) === "write" ? "Write" : "Read"}` })), more: seen.length - shown.length };
}

function Card({
  bot: b,
  box,
  t,
  state,
  facts: f,
  people,
  picked,
  dragging,
  glow,
  over,
  shaking,
  onPick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  bot: Bot;
  box: Box;
  t: Team;
  state: AppState;
  facts: CardFacts;
  people: ChartPerson[] | null;
  picked: boolean;
  /** A card is being dragged: every card takes the drop, and says why when it can't lead it. */
  dragging: boolean;
  glow: boolean;
  over: boolean;
  shaking: boolean;
  onPick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}) {
  const chief = b.id === t.chief?.id;
  const e = entryOf(t, b.id);
  const who = whoFor(t, state, b.id, people);
  return (
    <div
      data-card={b.id}
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      draggable={!chief}
      onClick={(ev) => (ev.stopPropagation(), onPick())}
      onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), onPick())}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(ev) => {
        // Every card takes the drop while one is dragged (a drop is only heard where dragover was taken), so one that
        // can't lead it says why; only one that can glows.
        if (!dragging) return;
        ev.preventDefault();
        if (glow) onDragOver();
      }}
      onDrop={(ev) => {
        ev.preventDefault();
        onDrop();
      }}
      className={`absolute flex cursor-pointer select-none flex-col items-center rounded-[16px] bg-white px-3 pb-3 pt-3 transition-[opacity,box-shadow] duration-150 ${
        picked ? "shadow-[0_0_0_2px_#0A0A0A,0_8px_26px_#0000001F]" : over ? "shadow-[0_0_0_2px_#2F6BFF,0_8px_26px_#2F6BFF33]" : glow ? "shadow-[0_0_0_1.5px_#9DB8FF,0_6px_18px_#0000000D]" : "shadow-[0_0_0_1px_#E8E8E5,0_1px_2px_#0000000A,0_6px_18px_#0000000D]"
      } ${shaking ? "motion-shake" : ""}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      {chief && <span className="absolute left-[11px] top-[9px] text-[13px] text-[#E2B007]" aria-label="Chief of staff">★</span>}
      {e.memory === "own" && (
        <span className="absolute right-[10px] top-[9px]" data-tip={CHART_WORDS.legendMemory}>
          <Lock />
        </span>
      )}
      <span className="shrink-0">
        <Mascot botId={b.id} color={b.color} size={chief ? 64 : 52} />
      </span>
      {/* Its name and role never give way to what's under them. */}
      <span className="mt-1.5 max-w-full shrink-0 truncate text-[14px] font-semibold leading-[18px]">{b.name}</span>
      <span className="max-w-full shrink-0 truncate text-[11.5px] leading-4 text-[#8A8A88]">{chief ? CHART_WORDS.chiefRole : who ? CHART_WORDS.personsBot(who.name) : b.role}</span>
      {/* The bot's AI chip (dev/bot-ai): its provider and model go here, its row's height in AI_CHIP_H. Nothing for now. */}
      <CardAiChip bot={b} />
      {chief ? (
        <span className="mt-2 rounded-full bg-[#F6F6F4] px-2.5 py-[3px] text-[11px] leading-4 text-[#3A3A38] shadow-[inset_0_0_0_1px_#E8E8E5]">{CHART_WORDS.seesAll}</span>
      ) : (
        f.tags.length > 0 && (
          <div className="mt-2 flex max-w-full flex-wrap justify-center gap-1">
            {f.tags.map((x) => (
              <span key={x} className="truncate rounded-full bg-[#F6F6F4] px-2 py-[2px] text-[10.5px] leading-[14px] text-[#3A3A38] shadow-[inset_0_0_0_1px_#E8E8E5]">
                {x}
              </span>
            ))}
          </div>
        )
      )}
      {f.lost && <span className="mt-1 max-w-full shrink-0 truncate text-[10.5px] leading-[14px] text-[#B54708]">{f.lost}</span>}
      {f.chips.length > 0 && (
        <div className="mt-auto flex max-w-full flex-wrap justify-center gap-1 pt-1.5" data-people-chips>
          {f.chips.map(({ p, label }) => (
            <span key={p.key} className="inline-flex max-w-full items-center gap-1 rounded-full bg-white px-1.5 py-[2px] text-[10.5px] leading-[14px] text-[#3A3A38] shadow-[0_0_0_1px_#E8E8E5]">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: dotOf(people ?? [], p) }} />
              <span className="truncate">{label}</span>
            </span>
          ))}
          {f.more > 0 && (
            <span className="rounded-full bg-[#F6F6F4] px-1.5 py-[2px] text-[10.5px] leading-[14px] text-[#3A3A38] shadow-[inset_0_0_0_1px_#E8E8E5]" data-more>
              {CHART_WORDS.more(f.more)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The spot for a bot's AI chip on its card (the per bot AI picker, dev/bot-ai). Renders nothing for now. */
function CardAiChip({ bot: _bot }: { bot: Bot }) {
  void _bot;
  return null;
}

const dotOf = (people: ChartPerson[], p: ChartPerson) => DOTS[Math.max(0, people.findIndex((x) => x.key === p.key)) % DOTS.length];

/**
 * The person a bot works for, as People names them (else as kept), whether or not they can use it now, and
 * (`since`) whether their level changed after the chart last did: Write taken away from them, not never given.
 */
function whoFor(t: Team, state: AppState, botId: string, people: ChartPerson[] | null): { key: string; name: string; write: boolean; since: boolean } | undefined {
  const e = entryOf(t, botId);
  if (!e.for) return undefined;
  const ws = state.workspaces?.find((w) => w.id === t.ws);
  const p = people?.find((x) => x.key === e.for);
  const at = ws?.memberAccess && Object.hasOwn(ws.memberAccess, e.for) ? ws.memberAccess[e.for].at : undefined;
  return { key: e.for, name: p?.name.split(" ")[0] || e.forName || nameFromKey(e.for), write: levelIn(ws, e.for, botId) === "write", since: typeof at === "number" && at > (t.chain.at ?? 0) };
}

/**
 * Two bots that can't ask each other working on one computer (the main bot's, shared): logins and files there
 * are shared all the same. True for a bot that shares the main bot's computer with one it can't ask.
 */
function sharesWarning(t: Team, state: AppState, b: Bot): boolean {
  if (b.isMain || !sharesComputer(b)) return false;
  const host = workBot(b, state.bots).id;
  return t.bots.some((x) => {
    const o = state.bots.find((y) => y.id === x.id);
    return !!o && o.id !== b.id && workBot(o, state.bots).id === host && !mayAskIn(t, b.id, o.id) && !mayAskIn(t, o.id, b.id);
  });
}

/** Pairs of bots on the main bot's computer that can't ask each other (either way): the first gets its own computer. */
function sharedPairs(t: Team, state: AppState): [string, string][] {
  const host = t.chief?.id;
  const on = t.bots.filter((x) => {
    const b = state.bots.find((y) => y.id === x.id);
    return !!b && !b.isMain && sharesComputer(b) && workBot(b, state.bots).id === host;
  });
  const out: [string, string][] = [];
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) if (!mayAskIn(t, on[i].id, on[j].id) && !mayAskIn(t, on[j].id, on[i].id)) out.push([on[i].id, on[j].id]);
  return out.slice(0, 3);
}

function Ghost({ box, onMakeBot }: { box: Box; onMakeBot?: () => void }) {
  return (
    <div className="absolute flex flex-col items-center gap-2" style={{ left: box.x + box.w / 2 - 120, top: box.y + box.h + V_GAP, width: 240 }} data-ghost>
      <div className="flex w-full flex-col items-center gap-2 rounded-[16px] border-[1.5px] border-dashed border-[#C9C9C5] bg-white/60 px-4 py-5">
        <span className="text-[13px] font-medium leading-4 text-[#3A3A38]">{CHART_WORDS.ghost}</span>
        {onMakeBot && (
          <button type="button" onClick={onMakeBot} className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white hover:bg-[#262626]">
            {CHART_WORDS.makeBot}
          </button>
        )}
      </div>
      <span className="text-center text-[12px] leading-4 text-[#8A8A88]">{CHART_WORDS.ghostNote}</span>
    </div>
  );
}

/* ---------------- A switch ---------------- */

export function Switch({ label, on, onFlip, disabled, tip }: { label: string; on: boolean; onFlip: (on: boolean) => void; disabled?: boolean; tip?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-tip={tip}
      disabled={disabled}
      onClick={() => onFlip(!on)}
      className="flex w-full items-center justify-between gap-3 text-left text-[13px] leading-[18px] text-[#3A3A38] disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">{label}</span>
      <span className={`relative h-5 w-[34px] shrink-0 rounded-full transition-colors ${on ? "bg-ink" : "bg-[#D9D9D5]"}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-all ${on ? "left-[16px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

/* ---------------- A bot's sheet ---------------- */

const SECTION = "flex flex-col gap-2 pt-4";
const HEAD = "text-[12px] font-semibold uppercase tracking-[0.02em] text-[#8A8A88]";
const NOTE = "text-[11.5px] leading-[16px] text-[#8A8A88]";
const BOXED = "w-full rounded-[12px] py-2 pl-3 pr-8 shadow-[0_0_0_1px_#E8E8E5]";

/** A select drawn as the sheet's boxed row, with its caret. */
function Picker({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <select aria-label={label} value={value} onChange={(ev) => onChange(ev.target.value)} className={`${BOXED} appearance-none bg-white text-[13px] leading-[18px] text-ink`}>
        {children}
      </select>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8A8A88]">
        <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/**
 * A bot's place on the chart, and who sees it: everything a bot's sheet holds between its header and its footer (who
 * it answers to, works for, may ask, its memory, its computer, people's levels, Make it theirs). Shared with its
 * settings page (bot-settings.tsx), which draws it in its Team card with `inline` (the preset's button here, no footer).
 */
export function BotTeamFields({
  bot: b,
  state,
  t,
  chain,
  people,
  peopleKnown,
  levelFor,
  name,
  onSave,
  onLevel,
  onGiveWriteFor,
  onBringIn,
  presetKey,
  onPreset,
  onGiveComputer,
  preset,
  inline,
  leadLabel = CHART_WORDS.answersTo,
}: {
  bot: Bot;
  state: AppState;
  t: Team;
  chain: Chain;
  people: ChartPerson[];
  peopleKnown: boolean;
  levelFor: (p: ChartPerson, botId: string) => AccessLevel;
  name: (id: string) => string;
  /** Save the chart; `said`: what the toast says then (Saved., else). True when it's kept. */
  onSave: (next: Chain, said?: string) => Promise<boolean>;
  onLevel: (p: ChartPerson, level: AccessLevel) => void;
  /** "Works for" someone who sees no bot yet: give them Write, then it works for them. */
  onGiveWriteFor: (p: ChartPerson) => void;
  /** Its own memory off, and what it learned brought into the team's ("Bring it in"). */
  onBringIn: () => void;
  /** The preset asked for from the People part, for this person: its confirm open from the start. */
  presetKey?: string;
  /** Make it this person's own (the preset), once confirmed. */
  onPreset: (p: ChartPerson) => void;
  onGiveComputer: () => void;
  /** The preset's confirm, held by the sheet (its footer has the button). */
  preset?: [string | null, (key: string | null) => void];
  /** Drawn on its own (the settings page): the preset's button at the bottom. */
  inline?: boolean;
  /** What "Answers to" is called here (the settings page says Reports to). */
  leadLabel?: string;
}) {

  const chief = b.id === t.chief?.id;
  // Turning its own memory off asks first: bring what it learned into the team's, or keep it apart.
  const [asking, setAsking] = useState(false);
  // Make it someone's own: the person, while its confirm is open (from the People part, open at once). The sheet holds it
  // when its footer has the button (`preset`); else it's held here, and the button is drawn here (`inline`).
  const own = useState<string | null>(presetKey ?? null);
  const [presetOpen, setPresetOpen] = preset ?? own;
  // "Works for" someone who sees no bot yet: kept only once they have Write (Bops keeps no "for" without their access).
  const [askFor, setAskFor] = useState<string | null>(null);
  const ws = state.workspaces?.find((w) => w.id === t.ws);
  const hasAccess = (key: string) => !!ws?.memberAccess && Object.hasOwn(ws.memberAccess, key);
  const chiefName = t.chief ? name(t.chief.id) : "";
  const e = entryOf(t, b.id);
  const lead = t.lead.get(b.id);
  const who = whoFor(t, state, b.id, people);
  const below = belowIn(t, b.id);
  const line = new Set([...below, ...lineOfTeam(t, b.id)]);
  const beside = t.bots.filter((x) => x.id !== b.id && x.id !== t.chief?.id && !line.has(x.id)).map((x) => x.id);
  const asks = t.bots.filter((x) => x.id !== b.id).map((x) => x.id);
  const sideways = sidewaysIn(t, b.id) === "open";
  const besideAsk = beside.filter((x) => mayAskIn(t, b.id, x) && mayAskIn(t, x, b.id));
  const leads = t.bots.filter((x) => x.id !== b.id && !cantLead(t, b.id, x.id, name)).map((x) => x.id);
  const set = (patch: Partial<Record<keyof ChainBot, unknown>>, said?: string) => onSave(withBot(chain, b.id, patch), said);
  const { presetPerson, isTheirs } = presetOf(t, b, people, levelFor, presetOpen);
  // How it talks with the bots beside it, in words: the ones that ask both ways while it talks sideways (or that no bot
  // beside it does), then every other way allowed, one way each, and the exceptions that stop what sideways allows.
  const lineNames = namesOf([...lineOfTeam(t, b.id), ...below].map(name));
  const counted = sideways ? besideAsk : [];
  const allowed = beside
    .filter((x) => !counted.includes(x))
    .flatMap((x) => [...(mayAskIn(t, b.id, x) ? [CHART_WORDS.lineCanAsk(b.name, name(x))] : []), ...(mayAskIn(t, x, b.id) ? [CHART_WORDS.lineCanAsk(name(x), b.name)] : [])]);
  const stopped = Object.entries(chain.pairs ?? {}).flatMap(([key, v]) => {
    const [x, y] = key.split(">");
    if (v !== false || (x !== b.id && y !== b.id) || !beside.includes(x === b.id ? y : x) || sidewaysIn(t, x) !== "open" || sidewaysIn(t, y) !== "open") return [];
    return [CHART_WORDS.lineCant(name(x), name(y))];
  });
  const sidewaysNote = [
    sideways && besideAsk.length
      ? CHART_WORDS.sidewaysOn(besideAsk.length)
      : sideways && beside.length && !beside.some((x) => sidewaysIn(t, x) === "open")
        ? CHART_WORDS.sidewaysNone(lineNames)
        : CHART_WORDS.sidewaysOff(lineNames),
    allowed.length ? `${CHART_WORDS.alsoAllowed}: ${allowed.join(". ")}.` : "",
    stopped.length ? `${stopped.join(". ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const askingFor = askFor ? people.find((p) => p.key === askFor) : undefined;
  return (
    <div
      className="flex flex-col"
      data-team-fields={b.id}
      onKeyDown={(ev) => {
        // Esc closes its own question first (Bring it in, Make it theirs, Give Write), then what it's in.
        if (ev.key !== "Escape" || (!asking && !presetOpen && !askFor)) return;
        ev.preventDefault();
        ev.stopPropagation();
        setAsking(false);
        setPresetOpen(null);
        setAskFor(null);
      }}
    >
      {!chief && (
        <>
          <div className={SECTION}>
            <span className={HEAD}>{leadLabel}</span>
            <Picker label={leadLabel} value={lead ?? ""} onChange={(v) => set({ lead: v === t.chief?.id ? undefined : v })}>
              {leads.map((id) => (
                <option key={id} value={id}>
                  {id === t.chief?.id ? CHART_WORDS.chiefOption(name(id)) : name(id)}
                </option>
              ))}
            </Picker>
          </div>

          {peopleKnown && people.length > 0 && (
            <div className={SECTION}>
              <span className={HEAD}>{CHART_WORDS.worksFor}</span>
              <Picker
                label={CHART_WORDS.worksFor}
                value={askFor ?? e.for ?? ""}
                onChange={(v) => {
                  const p = people.find((x) => x.key === v);
                  setAskFor(null);
                  // Someone who sees no bot yet: Write first (Give Write), then it works for them.
                  if (p && !hasAccess(p.key)) return setAskFor(p.key);
                  void set({ for: p?.key, forName: p ? p.name.split(" ")[0] : undefined });
                }}
              >
                <option value="">{CHART_WORDS.nobody}</option>
                {people.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name} · {levelFor(p, b.id) === "write" ? "Write" : levelFor(p, b.id) === "read" ? "Read" : "None"}
                  </option>
                ))}
              </Picker>
              {askingFor ? (
                <span className={`${NOTE} flex items-center justify-between gap-2`} data-give-write>
                  <span>{CHART_WORDS.cantUseYet(askingFor.name.split(" ")[0], b.name)}</span>
                  {askingFor.id && (
                    <button
                      type="button"
                      autoFocus
                      onClick={() => {
                        setAskFor(null);
                        onGiveWriteFor(askingFor);
                      }}
                      className="shrink-0 rounded-full bg-[#F2F2F0] px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-[#EAEAE7]"
                    >
                      {CHART_WORDS.giveWrite}
                    </button>
                  )}
                </span>
              ) : (
                <>
                  {who && who.write && <span className={NOTE}>{CHART_WORDS.toldWorksFor(who.name)}</span>}
                  {who && !who.write && (
                    <span className={`${NOTE} flex items-center justify-between gap-2`} data-give-write>
                      <span>{who.since ? `${CHART_WORDS.cantUseNow(who.name, b.name)} ${CHART_WORDS.giveWriteAsk(who.name)}` : CHART_WORDS.cantUseYet(who.name, b.name)}</span>
                      {people.find((p) => p.key === who.key)?.id && (
                        <button type="button" onClick={() => onLevel(people.find((p) => p.key === who.key)!, "write")} className="shrink-0 rounded-full bg-[#F2F2F0] px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-[#EAEAE7]">
                          {CHART_WORDS.giveWrite}
                        </button>
                      )}
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          <div className={SECTION}>
            <span className={HEAD}>{CHART_WORDS.canAsk}</span>
            <div className="flex flex-wrap gap-1.5" data-can-ask>
              {asks.map((id) => {
                const on = mayAskIn(t, b.id, id);
                const fixed = id === t.chief?.id || line.has(id);
                const ob = state.bots.find((x) => x.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={on}
                    disabled={fixed}
                    data-tip={fixed ? (id === t.chief?.id ? CHART_WORDS.chiefTip(name(id)) : CHART_WORDS.canAskTip(name(below.includes(id) ? b.id : id), name(below.includes(id) ? id : b.id))) : undefined}
                    onClick={() => onSave(withPair(t, chain, b.id, id, !on))}
                    className={`inline-flex items-center gap-1.5 rounded-full py-[5px] pl-1.5 pr-2.5 text-[12.5px] leading-4 ${
                      on ? "bg-[#EEF4FF] text-[#1D4ED8] shadow-[inset_0_0_0_1px_#CFE0FF]" : "bg-white text-[#8A8A88] line-through decoration-[#C9C9C5] shadow-[inset_0_0_0_1px_#E8E8E5]"
                    } ${fixed ? "cursor-default" : "hover:brightness-[0.98]"}`}
                  >
                    {ob && <Mascot botId={ob.id} color={ob.color} size={18} />}
                    {name(id)}
                  </button>
                );
              })}
            </div>
            <Switch
              label={CHART_WORDS.sideways}
              on={sideways}
              onFlip={(on) => set({ sideways: (on ? "open" : "closed") === (chain.sideways ?? "open") ? undefined : on ? "open" : "closed" })}
            />
            {/* How it talks sideways, and the exceptions the owner made that differ from that, one way or the other. */}
            <span className={NOTE} data-sideways-note>
              {sidewaysNote}
            </span>
          </div>

          <div className={SECTION}>
            <Switch label={CHART_WORDS.takesWork(lead ? name(lead) : chiefName)} on={e.takesWork !== false} onFlip={(on) => set({ takesWork: on ? undefined : false })} />
            {e.takesWork === false && <span className={NOTE}>{CHART_WORDS.takesWorkOff}</span>}
            {below.length > 0 && <Switch label={CHART_WORDS.handsDown} on={e.handsDown !== false} onFlip={(on) => set({ handsDown: on ? undefined : false })} />}
          </div>

          <div className={SECTION} data-memory>
            <span className={HEAD}>{CHART_WORDS.memory}</span>
            <div className={BOXED.replace("pr-8", "pr-3")}>
              <Switch
                label={CHART_WORDS.memoryOwn}
                on={e.memory === "own" || asking}
                onFlip={(on) => {
                  if (on) void set({ memory: "own", kept: undefined }, CHART_WORDS.memoryFromNow(b.name));
                  else setAsking(true);
                }}
              />
            </div>
            {asking ? (
              <div className="flex flex-col gap-2 rounded-[12px] bg-[#F6F6F4] px-3 py-2.5" data-bring-ask>
                <span className="text-[12.5px] leading-[18px] text-ink">{CHART_WORDS.bringAsk(b.name)}</span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    autoFocus
                    onClick={() => {
                      setAsking(false);
                      // The chart first (what it learns from now on goes to the team's), then what it learned before.
                      onBringIn();
                    }}
                    className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white hover:bg-[#262626]"
                  >
                    {CHART_WORDS.bringIn}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAsking(false);
                      void set({ memory: undefined, readsTeam: undefined, kept: true });
                    }}
                    className="rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E8E8E5] hover:bg-[#F7F7F6]"
                  >
                    {CHART_WORDS.keepApart}
                  </button>
                </span>
              </div>
            ) : e.memory === "own" ? (
              <>
                <span className={NOTE}>{CHART_WORDS.memoryOwnNote(b.name)}</span>
                <Switch label={CHART_WORDS.readsTeam} on={e.readsTeam !== false} onFlip={(on) => set({ readsTeam: on ? undefined : false })} />
                <span className={NOTE}>{CHART_WORDS.readsTeamNote}</span>
              </>
            ) : (
              <span className={NOTE}>{e.kept ? CHART_WORDS.keptNote(b.name) : CHART_WORDS.memoryTeam}</span>
            )}
          </div>

        </>
      )}

      {!chief && (
        <div className={SECTION} data-computer>
          <span className={HEAD}>{CHART_WORDS.computer}</span>
          {sharesComputer(b) ? (
            <div className="flex flex-col gap-2 rounded-[12px] bg-[#F6F6F4] px-3 py-2.5">
              <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">{CHART_WORDS.computerShared(b.name, chiefName)}</span>
              <button type="button" onClick={onGiveComputer} className="self-start rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E8E8E5] hover:bg-[#F7F7F6]">
                {CHART_WORDS.giveComputer}
              </button>
            </div>
          ) : (
            <span className={NOTE}>{CHART_WORDS.computerOwn(b.name)}</span>
          )}
        </div>
      )}

      {peopleKnown && (
        <div className={SECTION}>
          <span className={HEAD}>{CHART_WORDS.people}</span>
          {people.length === 0 ? (
            <span className={NOTE}>{CHART_WORDS.nobodyYet}</span>
          ) : (
            <div className="flex flex-col" data-sheet-people>
              {people.map((p) => (
                <div key={p.key} className="flex items-center gap-2.5 border-b border-[#F0F0ED] py-2 last:border-0">
                  <span className="grid size-[26px] shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: dotOf(people, p) }}>
                    {p.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] leading-4">{p.name}</span>
                    {p.email && <span className="truncate text-[11px] leading-[14px] text-[#8A8A88]">{p.email}</span>}
                  </span>
                  <LevelPicker label={`What ${p.name} can do with ${b.name}`} value={levelFor(p, b.id)} onChange={(level) => onLevel(p, level)} disabled={!p.id} />
                </div>
              ))}
            </div>
          )}
          <span className={NOTE}>
            {CHART_WORDS.readNote} {CHART_WORDS.writeNote}
          </span>
        </div>
      )}

      {presetPerson && presetOpen && (
        <div data-preset-confirm className="mt-5 flex flex-col gap-2.5 rounded-[14px] bg-[#F6F6F4] p-3.5 shadow-[inset_0_0_0_1px_#E8E8E5]">
          <span className="text-[13px] font-semibold leading-4">{CHART_WORDS.preset(presetPerson.name.split(" ")[0])}</span>
          <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">{CHART_WORDS.presetConfirm(presetPerson.name.split(" ")[0], b.name)}</span>
          <span className="flex gap-2">
            <button type="button" autoFocus onClick={() => (setPresetOpen(null), onPreset(presetPerson))} className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white hover:bg-[#262626]">
              {CHART_WORDS.presetGo}
            </button>
            <button type="button" onClick={() => setPresetOpen(null)} className="rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E8E8E5] hover:bg-[#F7F7F6]">
              {CHART_WORDS.cancel}
            </button>
          </span>
        </div>
      )}

      {inline && presetPerson && !presetOpen && !isTheirs && (
        <button type="button" onClick={() => setPresetOpen(presetPerson.key)} className="mt-4 self-start rounded-full bg-white px-4 py-2 text-[13px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E8E8E5] hover:bg-[#F7F7F6]">
          {CHART_WORDS.preset(presetPerson.name.split(" ")[0])}
        </button>
      )}
    </div>
  );
}

/** Whose own Make it theirs would make the bot (the person asked for from the People part, else the one it works for), and whether it is already. */
function presetOf(t: Team, b: Bot, people: ChartPerson[], levelFor: (p: ChartPerson, botId: string) => AccessLevel, presetOpen: string | null) {
  const e = entryOf(t, b.id);
  const presetPerson = b.id === t.chief?.id ? undefined : people.find((p) => p.id && p.key === (presetOpen ?? e.for));
  // Already theirs: works for them, only its line, its own memory, and nobody else sees it.
  const isTheirs =
    !!presetPerson && e.for === presetPerson.key && sidewaysIn(t, b.id) === "closed" && e.memory === "own" && levelFor(presetPerson, b.id) === "write" && people.every((q) => q.key === presetPerson.key || levelFor(q, b.id) === "none");
  return { presetPerson, isTheirs };
}

function BotSheet({
  bot: b,
  onClose,
  ...props
}: {
  bot: Bot;
  state: AppState;
  t: Team;
  chain: Chain;
  people: ChartPerson[];
  peopleKnown: boolean;
  levelFor: (p: ChartPerson, botId: string) => AccessLevel;
  name: (id: string) => string;
  /** Save the chart; `said`: what the toast says then (Saved., else). True when it's kept. */
  onSave: (next: Chain, said?: string) => Promise<boolean>;
  onLevel: (p: ChartPerson, level: AccessLevel) => void;
  /** "Works for" someone who sees no bot yet: give them Write, then it works for them. */
  onGiveWriteFor: (p: ChartPerson) => void;
  /** Its own memory off, and what it learned brought into the team's ("Bring it in"). */
  onBringIn: () => void;
  onClose: () => void;
  /** The preset asked for from the People part, for this person: its confirm open from the start. */
  presetKey?: string;
  /** Make it this person's own (the preset), once confirmed. */
  onPreset: (p: ChartPerson) => void;
  onGiveComputer: () => void;
}) {
  const { t, state, people, levelFor, name, presetKey } = props;
  const chief = b.id === t.chief?.id;
  const [presetOpen, setPresetOpen] = useState<string | null>(presetKey ?? null);
  // The keyboard comes to the sheet when it opens.
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => sheet.current?.focus(), []);
  const chiefName = t.chief ? name(t.chief.id) : "";
  const lead = t.lead.get(b.id);
  const who = whoFor(t, state, b.id, people);
  const { presetPerson, isTheirs } = presetOf(t, b, people, levelFor, presetOpen);
  return (
    <aside
      ref={sheet}
      tabIndex={-1}
      aria-label={b.name}
      data-bot-sheet={b.id}
      onKeyDown={(ev) => {
        // Esc closes Make it theirs first (its confirm may be open from the start, with the sheet itself focused), then the sheet (the chart's).
        if (ev.key !== "Escape" || !presetOpen) return;
        ev.stopPropagation();
        setPresetOpen(null);
      }}
      className="motion-fade-in flex w-[400px] shrink-0 flex-col overflow-y-auto border-l border-[#E8E8E5] bg-white px-[22px] pb-6 pt-[22px] outline-none"
    >
      <div className="flex items-center gap-3">
        <Mascot botId={b.id} color={b.color} size={48} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[17px] font-semibold leading-[22px]">{b.name}</span>
          <span className="truncate text-[12.5px] leading-4 text-[#8A8A88]">
            {chief ? CHART_WORDS.chiefSub : CHART_WORDS.sheetSub(who ? CHART_WORDS.personsBot(who.name) : b.role, lead ? name(lead) : chiefName)}
          </span>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      {/* The bot's AI (dev/bot-ai): its provider tiles, model and what it pays with go here. Nothing for now. */}
      <BotAiSection bot={b} />

      <BotTeamFields {...props} bot={b} preset={[presetOpen, setPresetOpen]} />

      {/* Done, and the preset, always in reach: kept at the bottom while the sheet scrolls. */}
      <div className="sticky -bottom-6 -mx-[22px] mt-auto flex items-center justify-end gap-2 bg-white px-[22px] pb-6 pt-3 shadow-[0_-1px_0_#F0F0ED]">
        {/* Make it the person it works for's own, when it isn't yet. */}
        {presetPerson && !presetOpen && !isTheirs && (
          <button type="button" onClick={() => setPresetOpen(presetPerson.key)} className="rounded-full bg-white px-4 py-2 text-[13px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E8E8E5] hover:bg-[#F7F7F6]">
            {CHART_WORDS.preset(presetPerson.name.split(" ")[0])}
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-full bg-ink px-4 py-2 text-[13px] font-medium leading-4 text-white hover:bg-[#262626]">
          {CHART_WORDS.done}
        </button>
      </div>
    </aside>
  );
}

/** The spot in a bot's sheet for its AI (the per bot AI picker: provider tiles, model, what it pays with; dev/bot-ai). Renders nothing for now. */
function BotAiSection({ bot: _bot }: { bot: Bot }) {
  void _bot;
  return null;
}

const lineOfTeam = (t: Team, id: string) => {
  const out: string[] = [];
  for (let at = t.lead.get(id); at && !out.includes(at); at = t.lead.get(at)) out.push(at);
  return out;
};
const namesOf = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/* ---------------- People ---------------- */

function PeoplePart({
  open,
  onToggle,
  people,
  bots,
  t,
  levelFor,
  planNote,
  onPickBot,
  onOpenPeople,
  onGiveBot,
  onMakeBot,
}: {
  open: boolean;
  onToggle: () => void;
  people: ChartPerson[];
  bots: Bot[];
  t: Team;
  levelFor: (p: ChartPerson, botId: string) => AccessLevel;
  planNote: string | null;
  onPickBot: (id: string) => void;
  onOpenPeople?: () => void;
  /** Give someone with no bots one: a bot nobody has as their own, with the preset to make it theirs. */
  onGiveBot: (p: ChartPerson, botId: string) => void;
  onMakeBot?: () => void;
}) {
  const [giving, setGiving] = useState<string | null>(null);
  const free = bots.filter((b) => b.id !== t.chief?.id && !entryOf(t, b.id).for);
  return (
    <div className="flex flex-col px-[26px] pt-3" data-people-part>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex items-center gap-1.5 self-start text-[13px] font-semibold leading-4 text-ink">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`transition-transform ${open ? "rotate-90" : ""}`}>
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {CHART_WORDS.people} ({people.filter((p) => !p.invited).length})
      </button>
      {open && (
        <div className="flex flex-col gap-3 pt-2">
          <span className="text-[12px] leading-4 text-[#6B6B6B]">{CHART_WORDS.peopleIntro}</span>
          {people.length === 0 ? (
            <div className="flex items-center justify-between gap-3 text-[12.5px] leading-[18px] text-[#6B6B6B]">
              <span>{planNote ?? CHART_WORDS.nobodyYet}</span>
              {onOpenPeople && (
                <button type="button" onClick={onOpenPeople} className="shrink-0 rounded-full bg-[#F2F2F0] px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-[#EAEAE7]">
                  {CHART_WORDS.openPeople}
                </button>
              )}
            </div>
          ) : (
            people.map((p) => {
              const theirs = bots.filter((b) => levelFor(p, b.id) !== "none");
              const ownBot = bots.find((b) => entryOf(t, b.id).for === p.key);
              return (
                <div key={p.key} className="flex flex-col gap-1.5 border-b border-[#F0F0ED] pb-3 last:border-0">
                  <div className="flex items-center justify-between gap-2 text-[13px] leading-4">
                    <span className="font-medium">
                      {p.name}
                      {p.invited ? ` · ${CHART_WORDS.invited}` : ""}
                    </span>
                    {p.email && <span className="text-[12px] text-[#8A8A88]">{p.email}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {theirs.length ? (
                      theirs.map((b) => (
                        <button key={b.id} type="button" onClick={() => onPickBot(b.id)} className="rounded-full bg-[#F6F6F4] px-2.5 py-1 text-[12px] leading-4 text-[#3A3A38] shadow-[inset_0_0_0_1px_#E8E8E5] hover:bg-[#EFEFEC]">
                          {b.name} · {levelFor(p, b.id) === "write" ? "Write" : "Read"}
                        </button>
                      ))
                    ) : (
                      <span className="flex items-center gap-2 text-[12px] text-[#8A8A88]">
                        {CHART_WORDS.noBots}
                        {p.id && (
                          <button type="button" onClick={() => setGiving(giving === p.key ? null : p.key)} className="rounded-full bg-[#F2F2F0] px-2.5 py-1 font-medium text-ink hover:bg-[#EAEAE7]">
                            {CHART_WORDS.giveBot(p.name.split(" ")[0])}
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {giving === p.key && (
                    <div className="flex flex-wrap gap-1.5" data-give-bot>
                      {free.map((b) => (
                        <button key={b.id} type="button" onClick={() => (setGiving(null), onGiveBot(p, b.id))} className="inline-flex items-center gap-1.5 rounded-full bg-white py-1 pl-1.5 pr-2.5 text-[12px] leading-4 text-ink shadow-[inset_0_0_0_1px_#E8E8E5] hover:bg-[#F7F7F6]">
                          <Mascot botId={b.id} color={b.color} size={16} />
                          {b.name}
                        </button>
                      ))}
                      {onMakeBot && (
                        <button type="button" onClick={onMakeBot} className="rounded-full bg-white px-2.5 py-1 text-[12px] leading-4 text-ink shadow-[inset_0_0_0_1px_#E8E8E5] hover:bg-[#F7F7F6]">
                          {CHART_WORDS.newBotFor(p.name.split(" ")[0])}
                        </button>
                      )}
                    </div>
                  )}
                  {ownBot && <span className="text-[12px] leading-4 text-[#6B6B6B]">{CHART_WORDS.ownBot(ownBot.name)}</span>}
                  {theirs
                    .filter((b) => entryOf(t, b.id).for && entryOf(t, b.id).for !== p.key)
                    .map((b) => (
                      <span key={b.id} className="text-[12px] leading-4 text-[#B54708]">
                        {CHART_WORDS.seesChats(p.name, b.name)}
                      </span>
                    ))}
                </div>
              );
            })
          )}
          <div className="flex flex-col gap-0.5 text-[12px] leading-4 text-[#8A8A88]">
            <span>{CHART_WORDS.readNote}</span>
            <span>{CHART_WORDS.writeNote}</span>
            <span>{CHART_WORDS.orgoNote}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Elsewhere ---------------- */

/**
 * A bot's place on the chart in a line, for its profile: "Reports to Sam · can ask 3 bots" (the main bot:
 * "Runs the team · can ask 4 bots"). Null in a workspace shared with the user.
 */
export function chartLine(state: AppState, botId: string): string | null {
  if (state.shared) return null;
  const b = state.bots.find((x) => x.id === botId);
  if (!b) return null;
  const t = teamIn(state, workspaceOf(b));
  const n = t.bots.filter((x) => mayAskIn(t, botId, x.id)).length;
  const lead = t.lead.get(botId);
  return lead ? CHART_WORDS.answersLine(state.bots.find((x) => x.id === lead)?.name ?? lead, n) : CHART_WORDS.chiefLine(n);
}

/** The workspace menu's row, and the People sheet's link: a small tree. */
export function ChartIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="5.5" y="1.5" width="5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1" y="10.5" width="5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="10.5" width="5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5.5v2.5M3.5 10.5V8h9v2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

