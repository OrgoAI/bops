"use client";

import { useEffect, useState } from "react";
import { BRAIN_KEYS, BRAIN_NAMES, BRAINS_ON, brainOf, brainRuns, planName, signInOn, threadRunner, workBot, type AppState, type Bot, type Brain, type BrainAuth, type BrainKind, type Session } from "@/lib/types";
import { BotChip, BotChips, PencilIcon, rowIconBtn, rowTrashBtn, TrashIcon } from "./apps";
import { Mascot } from "./mascot";
import { undash } from "./side-group";
import { currentWorkspace, post, teamOf } from "./ui";

/*
 * Brain (lib/server/brains.ts): what a bot's tasks run on. Bops agent, Bops' own, on AI credit; or a brain
 * the user brings: Claude Code, signed in with their own Claude plan through Claude Code's own sign-in on
 * the bot's computer (the user does it on that live screen; Bops never sees the login), or on their own
 * Anthropic key from the Vault; or Codex on their own OpenAI key. In Settings, a row for Bops agent and one
 * per brain, two lines each like a key's: its name and how it signs in, then the bots on it. In a bot's
 * profile, the brain it uses.
 */

/** Show one of a bot's screens up close (bops-app.tsx showScreen): where a sign-in opened. */
type Shown = (botId: string, display: number) => void;

const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
const dark = `${btn} bg-ink text-white hover:bg-[#2A2A28]`;
const light = `${btn} bg-[#F2F2F0] text-ink hover:bg-[#EAEAE7]`;

/**
 * Which brain runs a thread (threadRunner), or a bot's tasks, as a small plain chip: "Claude Code", "Codex",
 * or "Bops agent" ("agent", only where that isn't what the user would think: a thread that stays on Bops
 * agent while its bot is on a brain now). `className`: its background where the gray doesn't read (a profile's glass).
 */
export function BrainBadge({ kind, title, className = "bg-[#F2F2F0]" }: { kind: BrainKind | "agent"; title: string; className?: string }) {
  return (
    <span title={title} className={`shrink-0 rounded-full px-1.5 py-px text-[11px] leading-[14px] text-[#3A3A38] ${className}`}>
      {kind === "agent" ? "Bops agent" : BRAIN_NAMES[kind]}
    </span>
  );
}

/**
 * A thread's badge (BrainBadge, chat-view.tsx): the brain that runs it (threadRunner), or Bops agent for one
 * that stays there while its bot's tasks run on a brain now (it started on Bops agent, or Bops agent took it
 * over), so the user can tell it's on AI credit. Nothing for the rest, nor in a build without brains (BRAINS_ON).
 */
export function threadBadge(s: Session, state: AppState): { kind: BrainKind | "agent"; title: string } | undefined {
  if (!BRAINS_ON) return undefined;
  const who = threadRunner(s);
  if (who && who !== "agent") return { kind: who, title: `${BRAIN_NAMES[who]} ran this` };
  const b = state.bots.find((x) => x.id === s.botId);
  if (who !== "agent" || !b || !brainOf(b, state) || brainRuns(b, state) === "none" || s.runsOn === "mac") return undefined;
  return { kind: "agent", title: s.brainRun?.started ? "Bops agent took this over, so it finishes it, on AI credit" : "Started on Bops agent, so it finishes there, on AI credit" };
}

/** "Sam's computer": the computer `b` works on (its own, or the one it shares). */
const computerOf = (state: AppState, b: Bot) => `${workBot(b, state.bots).name}'s computer`;

/** "Sam's computer", "Sam's and Rook's computers". */
function computersSaid(names: string[]) {
  if (names.length === 1) return `${names[0]}'s computer`;
  return `${names.slice(0, -1).join("'s, ")}'s and ${names.at(-1)}'s computers`;
}

/** The bots on a brain, in the team's order. */
const botsOn = (team: Bot[], x: Brain) => team.filter((b) => x.bots.includes(b.id));

/** The first bot on a plan brain whose computer it isn't signed in on: where its Sign in button signs in. */
export function needsSignIn(state: AppState, x: Brain): Bot | undefined {
  if (x.auth !== "plan" || state.host === "mac") return undefined;
  return botsOn(state.bots, x).find((b) => !signInOn(x, workBot(b, state.bots).computerId));
}

/**
 * How a brain signs in, in a few words: "Max plan · signed in on Sam's computer", "Signing in on Sam's
 * computer", "Not signed in", "Key: ANTHROPIC_API_KEY". `keys`: the Vault's key names, once read, to say a
 * key brain's key isn't there.
 */
export function brainLine(state: AppState, x: Brain, keys?: string[]): string {
  if (x.auth === "key") return `Key: ${x.keyName ?? BRAIN_KEYS[x.kind]}${keys && !keys.includes(x.keyName ?? BRAIN_KEYS[x.kind]) ? " · not in Logins" : ""}`;
  const going = x.signingIn;
  // Whose computer it is: the bot that has it (a computer that's gone isn't anyone's any more).
  const owner = (computerId: string) => state.bots.find((b) => b.computerId === computerId)?.name;
  if (going && !going.failed) {
    const who = owner(going.computerId);
    return who ? `Signing in on ${who}'s computer` : "Signing in";
  }
  // Only computers a bot still has, each with its own plan: one plan when they agree ("Max plan · signed in on
  // Sam's and Rook's computers"), else each ("Max plan on Sam's computer, Pro plan on Rook's computer").
  const on = (x.signIns ?? []).flatMap((s) => {
    const who = owner(s.computerId);
    return who ? [{ who, plan: planName(s.account?.plan) }] : [];
  });
  const plans = [...new Set(on.map((s) => s.plan))];
  if (plans.length === 1) return `${plans[0]} · signed in on ${computersSaid([...new Set(on.map((s) => s.who))])}`;
  if (plans.length > 1) return on.map((s) => `${s.plan} on ${s.who}'s computer`).join(", ");
  if (going?.failed) return "Sign-in didn't finish";
  return "Not signed in";
}

/** Start a plan brain's sign-in on the computer `botId` works on; the app shows that screen. Null, or why not. Also a waiting thread's Sign in (chat-view.tsx NeedsYouCard). */
export async function brainSignIn(brainId: string, botId: string, onShowScreen: Shown): Promise<string | null> {
  try {
    const res = await post("/api/brains/sign-in", { brainId, botId });
    const j = (await res.json().catch(() => ({}))) as { botId?: string; display?: number; error?: string };
    if (!res.ok || typeof j.display !== "number" || !j.botId) return undash(j.error ?? "The sign-in didn't start. Try again.");
    onShowScreen(j.botId, j.display);
    return null;
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/**
 * Open a thread Claude Code runs in a terminal on its screen, for the user to work with it there (sessions.ts
 * openInTerminal, chat-view.tsx ThreadSheet); the app shows that screen. Null, or why not.
 */
export async function openInTerminal(sessionId: string, onShowScreen: Shown): Promise<string | null> {
  try {
    const res = await post(`/api/sessions/${sessionId}/terminal`, {});
    const j = (await res.json().catch(() => ({}))) as { botId?: string; display?: number; error?: string };
    if (!res.ok || typeof j.display !== "number" || !j.botId) return undash(j.error ?? "The terminal didn't open. Try again.");
    onShowScreen(j.botId, j.display);
    return null;
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/** A call to the brain routes: null when it went through, else what went wrong. */
async function call(url: string, body: unknown, method = "POST"): Promise<string | null> {
  try {
    const res = await post(url, body, method);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? null : undash(j.error ?? "That didn't change. Try again.");
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/** The Vault's API key names the current workspace sees, by where they are (GET /api/keys), or null until read. */
function useVaultKeys() {
  const [keys, setKeys] = useState<{ name: string; scope: "workspace" | "all" }[] | null>(null);
  useEffect(() => {
    let gone = false;
    void fetch("/api/keys", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ keys?: { name: string; scope: "workspace" | "all" }[] }>) : null))
      .then((j) => !gone && setKeys(j?.keys ?? []))
      .catch(() => !gone && setKeys([]));
    return () => {
      gone = true;
    };
  }, []);
  return keys;
}

/* ---------------- Settings ---------------- */

/**
 * Settings, Brain: Bops agent first (on AI credit, with the bots on it), then each brain the user added, and
 * Add a brain. `onShowScreen`: a sign-in started, show that bot's screen (Settings closes); `onOpenVault`:
 * to add a key there.
 */
export function BrainSettings({ state, onShowScreen, onOpenVault }: { state: AppState; onShowScreen: Shown; onOpenVault: () => void }) {
  const team = teamOf(state);
  const brains = (state.brains ?? []).filter((x) => x.workspaceId === currentWorkspace(state));
  const keys = useVaultKeys();
  const [adding, setAdding] = useState(false);
  const agent = team.filter((b) => !brainOf(b, state));
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold">Brain</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">What your bots work with. Bops agent runs on AI credit. Claude Code and Codex run on your own plan or key.</span>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="flex shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold leading-4 text-white hover:bg-[#2A2A28]">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Add a brain
          </button>
        )}
      </div>
      <div className="flex flex-col rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        <div className="flex flex-col gap-1.5 border-b border-[#F0F0EE] py-3 first:pt-0 last:border-0 last:pb-0">
          <div className="flex min-h-7 items-center gap-2">
            <span className="min-w-0 truncate text-[13.5px] font-medium leading-[18px]">Bops agent</span>
            <span className="min-w-0 truncate text-[12px] leading-4 text-[#9A9A98]">AI credit</span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {agent.length ? agent.map((b) => <BotChip key={b.id} bot={b} tip={`${b.name} works with Bops agent`} />) : <span className="text-[12px] leading-4 text-[#9A9A98]">No bot uses it</span>}
          </div>
        </div>
        {brains.map((x) => (
          <BrainRow key={x.id} state={state} brain={x} keys={keys?.map((k) => k.name)} onShowScreen={onShowScreen} />
        ))}
        {adding && <AddBrain state={state} keys={keys} onShowScreen={onShowScreen} onOpenVault={onOpenVault} onDone={() => setAdding(false)} />}
      </div>
    </div>
  );
}

/** A bot on a brain's chips: it uses it, may pick it in its profile, or neither. */
const BRAIN_CHOICES: { id: "use" | "may" | "none"; name: string; hint: string }[] = [
  { id: "use", name: "Uses it", hint: "Its tasks run on this brain." },
  { id: "may", name: "Can pick it", hint: "Its profile offers it. Its tasks stay on Bops agent until you pick it." },
  { id: "none", name: "Can't use it", hint: "Its profile doesn't offer it." },
];

/**
 * One brain in two lines, as a key's row reads: its name, how it signs in (and Sign in, while a bot on it
 * has a computer it isn't signed in on), Rename and Remove as icons; then its bots, a chip each.
 */
function BrainRow({ state, brain: x, keys, onShowScreen }: { state: AppState; brain: Brain; keys?: string[]; onShowScreen: Shown }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(x.name);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = teamOf(state);
  const going = x.signingIn && !x.signingIn.failed ? x.signingIn : undefined;
  const next = going ? undefined : needsSignIn(state, x);
  const signedIn = (x.signIns ?? []).filter((s) => state.bots.some((b) => b.computerId === s.computerId));
  const run = async (f: () => Promise<string | null>) => {
    setBusy(true);
    setError(await f());
    setBusy(false);
  };
  const save = () => {
    setNaming(false);
    if (name.trim() && name.trim() !== x.name) void run(() => call("/api/brains", { id: x.id, name }, "PATCH"));
    else setName(x.name);
  };
  const who = (b: Bot) => (b.brain === x.id && x.bots.includes(b.id) ? "use" : x.bots.includes(b.id) ? "may" : "none");
  const account = signedIn[0]?.account;
  return (
    <div className="flex flex-col gap-1.5 border-b border-[#F0F0EE] py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="flex min-h-7 items-center gap-2">
        {naming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), setName(x.name), setNaming(false)))}
            aria-label="Name"
            className="h-7 w-[180px] rounded-lg bg-white px-2 text-[12.5px] outline-none shadow-[0_0_0_1.5px_#0A0A0A]"
          />
        ) : (
          <span className="min-w-0 truncate text-[13.5px] font-medium leading-[18px]">{x.name}</span>
        )}
        <span
          data-tip={account ? [account.email, account.orgName].filter(Boolean).join(", ") || undefined : x.signingIn?.failed ? undash(x.signingIn.failed) : undefined}
          className={`min-w-0 shrink-[3] truncate text-[12px] leading-4 ${x.signingIn?.failed && !signedIn.length ? "text-[#B54708]" : "text-[#9A9A98]"}`}
        >
          {brainLine(state, x, keys)}
        </span>
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-1">
          {going && (
            <>
              <button disabled={busy} onClick={() => onShowScreen(going.botId, going.display)} className={light}>
                Show
              </button>
              <button disabled={busy} onClick={() => void run(() => call("/api/brains/sign-in", { brainId: x.id }, "DELETE"))} className={light}>
                Cancel
              </button>
            </>
          )}
          {next && (
            <button disabled={busy} onClick={() => void run(() => brainSignIn(x.id, next.id, onShowScreen))} className={dark}>
              Sign in on {computerOf(state, next)}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => setNaming(true)} aria-label="Rename" data-tip="Rename" className={rowIconBtn}>
            <PencilIcon />
          </button>
          <button type="button" disabled={busy} onClick={() => setSure(true)} aria-label="Remove" data-tip="Remove" className={rowTrashBtn}>
            <TrashIcon />
          </button>
        </div>
      </div>
      {!!team.length && (
        <BotChips
          team={team}
          choices={BRAIN_CHOICES}
          level={who}
          // Picked, but its tasks all run on this Mac, where Bops agent runs them (brainRuns).
          note={(b) => (who(b) === "may" ? "not picked" : who(b) === "use" && brainRuns(b, state) === "none" ? "on your Mac, Bops agent" : undefined)}
          what={x.name}
          disabled={busy}
          onSet={(b, level) => void run(() => call("/api/brains", { id: x.id, botId: b.id, level }, "PATCH"))}
        />
      )}
      {x.auth === "plan" && signedIn.length > 0 && !going && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {signedIn.map((s) => {
            const host = state.bots.find((b) => b.computerId === s.computerId)!;
            return (
              <button key={s.computerId} disabled={busy} onClick={() => void run(() => call("/api/brains/sign-out", { brainId: x.id, botId: host.id }))} className="text-[12px] leading-4 text-[#6B6B6B] hover:text-ink disabled:opacity-50">
                Sign out on {host.name}&apos;s computer
              </button>
            );
          })}
        </div>
      )}
      {sure && (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#FEF3F2] px-3 py-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-[#3A3A38]">
            Remove {x.name}? Its bots go back to Bops agent{x.auth === "plan" ? ", and it signs out on the computers it's signed in on" : ""}.
          </span>
          <button disabled={busy} onClick={() => void run(() => call("/api/brains", { id: x.id }, "DELETE"))} className={`${btn} bg-[#B42318] text-white`}>
            {busy ? "Removing…" : "Remove"}
          </button>
          <button disabled={busy} onClick={() => setSure(false)} className={`${btn} bg-white hover:bg-[#F7F7F6]`}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

/** In the add form: a bot that will use the brain, or won't. */
function PickBot({ bot: b, on, onClick }: { bot: Bot; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex h-[26px] items-center gap-1.5 rounded-full pl-1 pr-2.5 text-[12px] font-medium leading-4 ${on ? "bg-[#FBFFE0] text-ink shadow-[0_0_0_1.5px_#0A0A0A]" : "text-[#6B6B6B] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"}`}
    >
      <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
      {b.name}
    </button>
  );
}

const choice = (on: boolean) => `flex flex-1 flex-col gap-0.5 rounded-[12px] px-3 py-2.5 text-left ${on ? "bg-[#FBFFE0] shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"}`;

/** How Claude Code signs in, in its own words: a Claude subscription, or an Anthropic (Console) API key. Codex: an OpenAI key. */
const SIGN_INS: Record<BrainKind, { id: BrainAuth; name: string; hint: string }[]> = {
  claude: [
    { id: "plan", name: "Claude account with subscription", hint: "Pro, Max, Team, or Enterprise. You sign in with Claude Code's own sign-in on the bot's computer." },
    { id: "key", name: "Anthropic API key", hint: "Your key from Logins. Usage is billed to your Anthropic account." },
  ],
  codex: [{ id: "key", name: "OpenAI API key", hint: "Your key from Logins. Usage is billed to your OpenAI account." }],
};

/**
 * Add a brain: Claude Code or Codex, then how it signs in (Claude Code's own choices; Codex, a key only),
 * then the bots that use it. A key saved in the Vault is offered, never taken without asking. A plan
 * brain ends on "Sign in on Sam's computer", which opens its sign-in on that computer's screen.
 */
export function AddBrain({
  state,
  keys,
  kind: startKind,
  onShowScreen,
  onOpenVault,
  onDone,
}: {
  state: AppState;
  keys: { name: string; scope: "workspace" | "all" }[] | null;
  /** Start at this one, asking how it signs in. */
  kind?: BrainKind;
  onShowScreen: Shown;
  onOpenVault: () => void;
  onDone: () => void;
}) {
  const team = teamOf(state);
  const main = team.find((b) => b.isMain) ?? team[0];
  const [kind, setKind] = useState<BrainKind | null>(startKind ?? null);
  const [auth, setAuth] = useState<BrainAuth | null>(startKind === "codex" ? "key" : null);
  const [bots, setBots] = useState<string[]>(main ? [main.id] : []);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyName = kind ? BRAIN_KEYS[kind] : undefined;
  // This workspace's own key wins over the account's, as for the bots' calls (lib/server/keys.ts).
  const saved = keyName ? (keys?.find((k) => k.name === keyName && k.scope === "workspace") ?? keys?.find((k) => k.name === keyName)) : undefined;
  const vendor = kind === "codex" ? "OpenAI" : "Anthropic";
  const first = team.find((b) => bots.includes(b.id));
  const pickKind = (k: BrainKind) => {
    setKind(k);
    // Codex has one way in, so it's chosen; Claude Code asks, whatever the Vault has.
    setAuth(k === "codex" ? "key" : null);
    setError(null);
  };
  const add = async () => {
    if (!kind || !auth) return;
    setBusy(true);
    setError(null);
    try {
      let brainId = made;
      if (!brainId) {
        const res = await post("/api/brains", { kind, auth, bots, use: true, ...(auth === "key" && saved ? { keyScope: saved.scope } : {}) });
        const j = (await res.json().catch(() => ({}))) as { brain?: Brain; error?: string };
        if (!res.ok || !j.brain) return setError(undash(j.error ?? "That didn't add it. Try again."));
        brainId = j.brain.id;
        setMade(brainId);
      }
      if (auth === "plan" && first) {
        const why = await brainSignIn(brainId, first.id, onShowScreen);
        if (why) return setError(why);
      }
      onDone();
    } catch {
      setError("Couldn't reach Bops. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      onKeyDown={(e) => {
        // Closes the form, and keeps Settings open.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
      className="motion-rise-in mt-3 flex flex-col gap-2.5 rounded-[12px] bg-[#FCFCFB] p-3 shadow-[0_0_0_1px_#ECECEA]"
    >
      <span className="text-[12px] font-medium leading-4 text-[#6B6B6B]">Which one?</span>
      <div className="flex gap-2">
        {(["claude", "codex"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} disabled={!!made} onClick={() => pickKind(k)} className={choice(kind === k)}>
            <span className="text-[13px] font-semibold leading-[18px]">{BRAIN_NAMES[k]}</span>
            <span className="text-[12px] leading-4 text-[#6B6B6B]">{k === "claude" ? "Anthropic's coding agent" : "OpenAI's coding agent"}</span>
          </button>
        ))}
      </div>
      {kind && (
        <>
          <span className="pt-1 text-[12px] font-medium leading-4 text-[#6B6B6B]">How should it sign in?</span>
          {saved && kind === "claude" && <span className="text-[12.5px] leading-[18px] text-[#3A3A38]">You have an Anthropic key saved. Use it, or sign in with your Claude plan?</span>}
          <div className="flex gap-2">
            {SIGN_INS[kind].map((s) => (
              <button key={s.id} type="button" aria-pressed={auth === s.id} disabled={!!made} onClick={() => setAuth(s.id)} className={choice(auth === s.id)}>
                <span className="text-[13px] font-semibold leading-[18px]">{s.name}</span>
                <span className="text-[12px] leading-4 text-[#6B6B6B]">{s.hint}</span>
              </button>
            ))}
          </div>
          {auth === "key" &&
            (saved ? (
              <span className="text-[12px] leading-4 text-[#6B6B6B]">
                Uses <span className="font-mono text-[11.5px] text-ink">{saved.name}</span> from Logins{saved.scope === "workspace" ? ", this workspace's" : ""}.
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-2 text-[12px] leading-4 text-[#6B6B6B]">
                {keys === null ? "Checking Logins" : `Add your ${vendor} key in Logins first. Only ${BRAIN_NAMES[kind ?? "claude"]} on the bot's computer gets it.`}
                {keys !== null && (
                  <button type="button" onClick={onOpenVault} className="font-medium text-ink underline-offset-2 hover:underline">
                    Open Logins
                  </button>
                )}
              </span>
            ))}
        </>
      )}
      {kind && auth && !!team.length && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="pr-0.5 text-[12px] leading-4 text-[#9A9A98]">Bots that use it</span>
          {team.map((b) => (
            <PickBot key={b.id} bot={b} on={bots.includes(b.id)} onClick={() => setBots(bots.includes(b.id) ? bots.filter((y) => y !== b.id) : [...bots, b.id])} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {kind && auth && (
          <button type="submit" disabled={busy || (auth === "key" ? !saved : !first || state.host === "mac")} className={`${dark} disabled:opacity-40`}>
            {busy ? "Starting…" : auth === "plan" && first ? `Sign in on ${computerOf(state, first)}` : "Add"}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onDone} className={light}>
          {made ? "Done" : "Cancel"}
        </button>
        {auth === "plan" && state.host === "mac" && <span className="text-[12px] leading-4 text-[#6B6B6B]">Your bots work on this Mac, so there&apos;s no bot computer to sign in on.</span>}
        {error && (
          <span role="alert" className="min-w-0 text-[12px] leading-4 text-[#B42318]">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/* ---------------- A bot's profile ---------------- */

/**
 * In a bot's profile, by Thinking: the brain its tasks run on, Bops agent or one of the brains it's on, and a
 * plain line with Sign in when its plan brain isn't signed in on the computer it works on. Nothing when no
 * brain has it.
 */
export function BotBrain({ state, bot: b, onShowScreen, className }: { state: AppState; bot: Bot; onShowScreen?: Shown; className: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = (state.brains ?? []).filter((x) => x.bots.includes(b.id));
  if (!mine.length) return null;
  const now = brainOf(b, state);
  const computerId = workBot(b, state.bots).computerId;
  // Its brain's sign-in, when it's going on this bot's computer (one on another bot's isn't this one's).
  const going = now?.signingIn && !now.signingIn.failed && now.signingIn.computerId === computerId ? now.signingIn : undefined;
  const signedIn = now?.auth === "plan" ? signInOn(now, computerId) : undefined;
  // A task on this Mac runs on Bops agent, whatever its brain (sessions.ts run).
  const where = brainRuns(b, state);
  const runs = !now
    ? "Bops agent, on AI credit"
    : now.auth === "key"
      ? `${BRAIN_NAMES[now.kind]} on your ${now.kind === "codex" ? "OpenAI" : "Anthropic"} key`
      : going
        ? `Signing in on ${computerOf(state, b)}`
        : signedIn
          ? `${BRAIN_NAMES[now.kind]} on your ${planName(signedIn.account?.plan)}`
          : `Not signed in on ${computerOf(state, b)}`;
  const hint = !now
    ? runs
    : where === "none"
      ? state.host === "mac"
        ? "Your bots work on this Mac, so they run on Bops agent, on AI credit"
        : `${b.name} works on your Mac, so its tasks run on Bops agent, on AI credit`
      : where === "some"
        ? `${runs} · tasks on your Mac run on Bops agent`
        : runs;
  const pick = async (brainId: string | null) => {
    setBusy(true);
    setError(await call("/api/brains/bot", { botId: b.id, brainId }));
    setBusy(false);
  };
  const options: { id: string | null; name: string }[] = [{ id: null, name: "Bops agent" }, ...mine.map((x) => ({ id: x.id, name: x.name }))];
  return (
    <div className={`flex w-full flex-col gap-2 rounded-2xl px-4 py-3 ${className}`}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold leading-4">Brain</span>
          <span className={`text-[12px] leading-4 ${now?.auth === "plan" && where !== "none" && !signedIn && !going ? "text-[#B54708]" : "text-[#6B6B6B]"}`}>{hint}</span>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-0.5 rounded-[14px] bg-black/[0.05] p-[3px]">
          {options.map((o) => (
            <button
              key={o.id ?? "agent"}
              disabled={busy}
              onClick={() => (now?.id ?? null) !== o.id && void pick(o.id)}
              className={`max-w-[150px] truncate rounded-full px-2.5 py-1 text-[12px] leading-4 disabled:opacity-60 ${(now?.id ?? null) === o.id ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
      {now?.auth === "plan" && where !== "none" && onShowScreen && (going || !signedIn) && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] leading-4 text-[#3A3A38]">
            {going ? "Claude Code's sign-in is open on its screen." : now.signingIn?.failed ? `The last sign-in didn't finish: ${undash(now.signingIn.failed)}` : `Sign in with your Claude plan on ${computerOf(state, b)} to use it.`}
          </span>
          {going ? (
            <button onClick={() => onShowScreen(going.botId, going.display)} className={light}>
              Show
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(await brainSignIn(now.id, b.id, onShowScreen));
                setBusy(false);
              }}
              className={dark}
            >
              Sign in
            </button>
          )}
        </div>
      )}
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}
