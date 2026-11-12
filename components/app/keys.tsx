"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { sameApp } from "@/lib/routine-catalog";
import type { DiffLine } from "@/lib/skill-proposals";
import { askHeadline } from "@/lib/permission";
import { KEYS_GIVEN_LINE, OWNERS_KEY_LINE, REPLY_WAITS_LINE } from "@/lib/shared";
import { MAIN_WORKSPACE, workspaceOf, type AppApproval, type AppState, type Bot, type FileChange, type LastUses, type Message, type Watch } from "@/lib/types";
import { BotChips, PencilIcon, rowIconBtn, rowTrashBtn, TrashIcon, usedLine } from "./apps";
import { Mascot } from "./mascot";
import { anchorOf, AppRoutines, hasTemplates, RoutineSuggest, usePendingSuggest } from "./routines";
import { Fold } from "./fold";
import { KeyIcon } from "./screen-cards";
import { DiffRow } from "./skill-proposals";
import { Chevron, undash } from "./side-group";
import { post, teamOf } from "./ui";
import { appsShown } from "@/lib/apps-access";
import { EveryAppSwitch } from "./app-key-links";
import { readAllowed } from "./view-only";

/*
 * Keys (lib/server/keys.ts): the user's API keys their bots may call services with. They're kept in the
 * user's Orgo vault, the same one as Orgo's Settings, Secrets, by the vault's own names (STRIPE_SECRET_KEY):
 * for this workspace only, or for all workspaces, as there. A workspace's bots use both; its own wins. A value goes to Orgo on Save, and comes back only when the
 * user asks to see or copy it (KeyValue): it lives in that row while it's shown and nowhere else. Only which
 * bots may use which key (Bot.keys) is kept, in the state.
 *
 * In a workspace shared with the user (lib/server/shared-keys.ts), the page is that workspace's: someone with Keys (an
 * Admin, or a Member given it in People) adds, replaces, removes, sees and copies This workspace's own keys, which orgo-web
 * keeps in the owner's vault, and switches bots on and off for any key it sees; the owner's keys for all their workspaces
 * show by name alone, marked as the owner's. Without Keys, a line says who gives it. The user's own keys aren't there.
 */

type Provider = { name: string; label: string; where: string; tip: string; readOnly: boolean };
export type Scope = "workspace" | "all";
/**
 * A key as GET /api/keys lists it for the open workspace. `usedIn`: the other workspaces it's switched on in (Used in,
 * lib/server/logins.ts); `from`: the workspace it's from, when it's another's switched on here (its value, a new one
 * and removing it are that workspace's).
 */
export type KeyRow = Provider & { updatedAt: string | null; scope: Scope; bots: string[]; usedIn?: string[]; from?: string; owner?: true };
/** A key's id on the Logins page: its scope and name (one name may be in both). */
export const keyId = (k: Pick<KeyRow, "scope" | "name">) => `${k.scope}:${k.name}`;
/**
 * `shared`: in a workspace shared with the user, whether they have Keys there and whether the owner's Bops takes their
 * bots' switches (`acts`). `notice`: orgo-web couldn't list This workspace's keys just now (the owner's still show).
 */
type KeysInfo = { signedIn: boolean; keys: KeyRow[]; providers: Provider[]; workspaceKeys?: boolean; error?: string; shared?: { keys: boolean; acts: boolean }; notice?: string };

/** The two scopes, as Orgo's Secrets names them. */
const SCOPES: { id: Scope; label: string; tip: string }[] = [
  { id: "workspace", label: "This workspace", tip: "Only this workspace's bots use it. It shows in Orgo's Settings, Secrets under this workspace." },
  { id: "all", label: "All workspaces", tip: "In your Orgo account, for all your workspaces. It shows in Orgo's Settings, Secrets too." },
];
const scopeLabel = (scope: Scope) => SCOPES.find((x) => x.id === scope)!;

/** A shared workspace's keys for all the owner's workspaces, and another of theirs switched on here: theirs alone. */
const OWNERS_TIP = "The owner's own key. Only the owner can see, replace or remove it, or let a bot use it. You can stop a bot using it.";
/** In a shared workspace, without Keys. */
const NO_KEYS_LINE = `People with Keys manage this workspace's keys. ${KEYS_GIVEN_LINE}`;
/** In a shared workspace whose owner's Bops can't take the bots' switches yet (SharedWsSlice.keyActs). */
const SWITCH_UPDATE_LINE = "The owner's Bops needs an update before you can switch bots for it.";

const STRIPE_NAMES = ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"];

/**
 * The service a pasted key is for, by how it starts, of the ones Bops can call (`names`), or null when it doesn't say. A
 * Stripe key keeps a Stripe name already `picked` (Stripe has two). Only what each service's own keys start with: an
 * OpenAI "sk-" never takes Stripe's "sk_".
 */
export function serviceOfKey(value: string, names: readonly string[], picked?: string): string | null {
  const v = value.trim();
  const has = (n: string) => (names.includes(n) ? n : null);
  if (/^(github_pat_|ghp_|gho_|ghu_|ghs_)/.test(v)) return has("GITHUB_TOKEN");
  if (v.startsWith("sk-ant-admin")) return has("ANTHROPIC_ADMIN_KEY");
  if (v.startsWith("sk-ant-")) return has("ANTHROPIC_API_KEY");
  if (v.startsWith("sk-admin-")) return has("OPENAI_ADMIN_KEY");
  if (/^(sk|rk)_(live|test)_/.test(v)) return picked && STRIPE_NAMES.includes(picked) && names.includes(picked) ? picked : has("STRIPE_SECRET_KEY");
  if (v.startsWith("sk-")) return has("OPENAI_API_KEY");
  if (v.startsWith("xoxb-")) return has("SLACK_BOT_TOKEN");
  if (v.startsWith("lin_api_")) return has("LINEAR_API_KEY");
  if (v.startsWith("ntn_")) return has("NOTION_API_KEY");
  if (v.startsWith("re_")) return has("RESEND_API_KEY");
  if (v.startsWith("phx_")) return has("POSTHOG_PERSONAL_API_KEY");
  return null;
}

/** Every Keys list on the page, so a save or a remove in the Vault shows on a bot's profile too. */
const readers = new Set<() => void>();
const keysChanged = () => readers.forEach((f) => f());

/**
 * GET /api/keys: the services Bops can call and the keys in the vault (names only). `failed` when it didn't
 * answer. `ws`: the workspace they're read for (the server answers for the current one): another one and
 * what was shown goes at once and is read again, so Reveal or Remove never acts on a row of the last one.
 */
function useKeys(ws: string) {
  const [info, setInfo] = useState<KeysInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [readFor, setReadFor] = useState(ws);
  if (readFor !== ws) {
    setReadFor(ws);
    setInfo(null);
  }
  const read = useCallback((fresh = false) => {
    void fetch(`/api/keys${fresh ? "?fresh=1" : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as Partial<KeysInfo>;
        if (r.ok && Array.isArray(j.keys) && Array.isArray(j.providers)) {
          setInfo(j as KeysInfo);
          setFailed(null);
        } else setFailed(undash(j.error ?? "Couldn't read your keys."));
      })
      .catch(() => setFailed("Couldn't reach Bops."));
  }, []);
  useEffect(() => {
    read();
    const again = () => read(true);
    readers.add(again);
    return () => void readers.delete(again);
  }, [read, ws]);
  return { info, failed, retry: () => read(true) };
}

/**
 * The names of the keys the Vault has (both scopes), for an agent that runs on one (lib/agents.ts agentState: none
 * there, and it says so). Undefined until they're read, when the Vault can't say (not signed in, no answer), or
 * when not asked for (`on`: the bot has an agent on a key): nothing is fetched then.
 */
export function useVaultKeyNames(ws: string, on: boolean): ReadonlySet<string> | undefined {
  const [names, setNames] = useState<{ ws: string; names: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    if (!on) return;
    let gone = false;
    const read = (fresh = false) =>
      void fetch(`/api/keys${fresh ? "?fresh=1" : ""}`, { cache: "no-store" })
        .then(async (r) => {
          const j = (await r.json().catch(() => ({}))) as Partial<KeysInfo>;
          if (!gone && r.ok && j.signedIn !== false && Array.isArray(j.keys)) setNames({ ws, names: new Set(j.keys.map((k) => k.name)) });
        })
        .catch(() => {});
    read();
    const again = () => read(true);
    readers.add(again);
    return () => {
      gone = true;
      readers.delete(again);
    };
  }, [on, ws]);
  return on && names?.ws === ws ? names.names : undefined;
}

/** "Oct 15", as Orgo's Secrets shows when a secret was set. */
const setOn = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null);

const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";

/* ---------------- Seeing and copying a key ---------------- */

/** How long a shown key stays on screen, and a copied one in the clipboard. */
const SHOW_MS = 30_000;
const CLIPBOARD_MS = 60_000;

/** POST /api/keys/reveal: a key's value from the Orgo vault, or words for why not. Not cached, and not kept. */
async function reveal(name: string, scope: Scope): Promise<{ value: string } | { error: string }> {
  try {
    const res = await fetch("/api/keys/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, scope }), cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as { value?: unknown; error?: string };
    return res.ok && typeof j.value === "string" ? { value: j.value } : { error: undash(j.error ?? "Couldn't get the key. Try again.") };
  } catch {
    return { error: "Couldn't reach Bops. Try again." };
  }
}

/** The Mac app's copy (desktop/main.cjs): concealed from clipboard managers, kept off other devices, cleared after a minute. */
const macCopy = () => (window as unknown as { bopsMac?: { copySecret?: (v: string) => Promise<boolean> } }).bopsMac?.copySecret;

/**
 * In a plain browser: after a while, empty the clipboard if it still holds `value` (the user may have copied
 * something else since). The browser only lets a page at the clipboard while it has focus, and after a copy
 * the user is usually pasting somewhere else; so when it's refused, it's tried again when the window is back.
 */
function clearClipboardLater(value: string) {
  const clear = () =>
    navigator.clipboard.readText().then((now) => (now === value ? navigator.clipboard.writeText("") : undefined));
  setTimeout(() => {
    void clear().catch(() => window.addEventListener("focus", () => void clear().catch(() => {}), { once: true }));
  }, CLIPBOARD_MS);
}

const iconBtn = "flex h-7 shrink-0 items-center justify-center gap-1 rounded-full text-[12px] font-medium leading-4 transition-colors disabled:opacity-50";

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      {off && <path d="M2.5 2.5l11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * A key's Show and Copy buttons, and the key itself while it's shown. Shown, it hides again after SHOW_MS,
 * when the window loses focus, and when the row goes. Copied, the clipboard is emptied after CLIPBOARD_MS if
 * it still holds it. The value is fetched from the vault each time and kept only in this row while it shows.
 */
function useKeyValue(name: string, scope: Scope, onError: (e: string | null) => void) {
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setShown(null);
  }, []);
  useEffect(() => {
    if (shown === null) return;
    window.addEventListener("blur", hide);
    return () => window.removeEventListener("blur", hide);
  }, [shown, hide]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const fetchValue = async () => {
    setBusy(true);
    onError(null);
    const r = await reveal(name, scope);
    setBusy(false);
    if ("error" in r) {
      onError(r.error);
      return null;
    }
    return r.value;
  };
  const toggle = async () => {
    if (shown !== null) return hide();
    const v = await fetchValue();
    if (v === null) return;
    setShown(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(hide, SHOW_MS);
  };
  const copy = async () => {
    const v = shown ?? (await fetchValue());
    if (v === null) return;
    const viaMac = macCopy();
    if (viaMac) {
      if (!(await viaMac(v).catch(() => false))) return onError("Couldn't copy it. Try again.");
    } else {
      try {
        await navigator.clipboard.writeText(v);
      } catch {
        return onError("Couldn't copy it. Click the window and try again.");
      }
      clearClipboardLater(v);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return { shown, busy, copied, toggle, copy };
}

/** In the add form: a bot that will use the key, or won't: tap to change it. */
function BotChip({ bot: b, on, disabled, tip, onClick }: { bot: Bot; on: boolean; disabled?: boolean; tip: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-[26px] items-center gap-1.5 rounded-full pl-1 pr-2.5 text-[12px] font-medium leading-4 disabled:opacity-50 ${on ? "bg-[#FBFFE0] text-ink shadow-[0_0_0_1.5px_#0A0A0A]" : "text-[#6B6B6B] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"}`}
    >
      <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
      {b.name}
    </button>
  );
}

/** PATCH /api/keys: let a bot use a key, or stop it. The chips read Bot.keys, so the state's refresh shows it. */
async function grant(name: string, botId: string, allowed: boolean): Promise<string | null> {
  try {
    const res = await post("/api/keys", { name, botId, allowed }, "PATCH");
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? null : undash(j.error ?? "That didn't change. Try again.");
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/* ---------------- Vault ---------------- */

/**
 * API keys in the Vault: each key in the vault (its vault name, where it applies, when it was set), the bots
 * that may use it (a chip each, like a Connected App's), Replace and Remove; and Add key. `keysFor`: opened from
 * a bot's profile to add one for that bot, so it comes into view with the form open and that bot picked.
 * `uses`: when each key was last used, and by which bot.
 */
export function KeysSettings({
  state,
  keysFor,
  uses,
  onOpenWatch,
  picked: open,
  onPick,
  onKeys,
}: {
  state: AppState;
  keysFor?: string;
  uses?: LastUses;
  onOpenWatch: (w: Watch) => void;
  /** The key open in the Logins page's side panel (keyId), and how a key's name opens it there. */
  picked?: string | null;
  onPick?: (k: KeyRow) => void;
  /** The keys as last read, for the side panel. */
  onKeys?: (keys: KeyRow[]) => void;
}) {
  const { info, failed, retry } = useKeys(state.workspace ?? MAIN_WORKSPACE);
  useEffect(() => {
    if (info) onKeys?.(info.keys);
  }, [info, onKeys]);
  // A workspace shared with the user: its own keys, only with Keys there (lib/server/shared-keys.ts).
  const shared = !!state.shared;
  const holds = !shared || !!info?.shared?.keys;
  const team = teamOf(state);
  const main = team.find((b) => b.isMain) ?? team[0];
  const picked = keysFor && team.some((b) => b.id === keysFor) ? keysFor : main?.id;
  // The form: a new key (for these bots), or a new value for a saved one.
  const [form, setForm] = useState<{ replace?: KeyRow; bots: string[] } | null>(keysFor ? { bots: picked ? [picked] : [] } : null);
  // This workspace or All workspaces, as Orgo's Secrets shows them; only All workspaces where this
  // workspace has no Orgo workspace of its own (an Orgo without them).
  // Opens on This workspace only when it has keys of its own (every key from before is for all workspaces);
  // a new key is for all workspaces unless This workspace was picked.
  // In a shared workspace it opens on This workspace, where keys are added there.
  const [tab, setTab] = useState<Scope | null>(null);
  const scope: Scope = info?.workspaceKeys ? (tab ?? (shared || info.keys.some((k) => k.scope === "workspace") ? "workspace" : "all")) : "all";
  // A new key goes where the user is looking: the tab shown, whether it was picked or opened on. A shared workspace's, This workspace's alone.
  const addScope: Scope = shared ? "workspace" : scope;
  const shown = info?.keys.filter((k) => k.scope === scope) ?? [];
  const [saved, setSaved] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const loaded = !!info;
  useEffect(() => {
    if (keysFor && loaded) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [keysFor, loaded]);
  // The Vault already open when a bot's profile asks to add a key for it: open the form for that bot.
  const [askedFor, setAskedFor] = useState(keysFor);
  if (keysFor !== askedFor) {
    setAskedFor(keysFor);
    if (keysFor && picked) setForm({ bots: [picked] });
  }
  const done = (name: string, note?: string) => {
    setForm(null);
    setSaved(note ?? (shared ? `${name} saved for this workspace.` : `${name} saved to your Orgo vault.`));
    setTimeout(() => setSaved(null), note ? 6000 : 2500);
  };
  const add = () => {
    if (shared) setTab("workspace");
    setForm({ bots: main ? [main.id] : [] });
  };
  // A key with starter routines (Stripe, Plain) offers them on its row, and by itself right after it's saved.
  const anchors = useRef(new Map<string, HTMLElement>());
  const [asked, setAsked] = useState<string | null>(null);
  const suggest = usePendingSuggest(state, (s) => !shared && shown.some((k) => sameApp(k.name, s.app)));
  const routinesFor = asked ? { app: asked, botId: undefined } : suggest.pending ? { app: suggest.pending.app, botId: suggest.pending.botId } : null;

  // A service's routines show once, on its first key (STRIPE_API_KEY and STRIPE_SECRET_KEY are both Stripe).
  const firstOfApp = (name: string) => shown.find((x) => sameApp(x.name, name))?.name === name;

  let body: React.ReactNode;
  if (!info)
    body = failed ? (
      <span role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] leading-[18px] text-[#6B6B6B]">
        {failed}
        <button onClick={retry} className="font-medium text-ink underline-offset-2 hover:underline">
          Try again
        </button>
      </span>
    ) : (
      <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">Checking</span>
    );
  else if (!info.signedIn) body = <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{undash(info.error ?? "Sign in to Orgo to use Keys.")}</span>;
  else if (!holds) body = <span data-no-keys className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{NO_KEYS_LINE}</span>;
  else if (!shown.length && !form)
    body = (
      <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">
        {saved ?? (scope === "workspace" ? "No keys for this workspace yet." : shared ? "The owner has no keys for all their workspaces." : "No keys yet. Add one for Stripe, OpenAI, GitHub and more.")}
        {info.notice && <span className="block pt-1 text-[#B42318]">{undash(info.notice)}</span>}
      </span>
    );
  else
    body = (
      <>
        {shown.map((k) => (
          <Fragment key={`${k.scope}:${k.name}`}>
            <KeyLine
              k={k}
              state={state}
              picked={open === keyId(k)}
              onPick={onPick && (() => onPick(k))}
              team={team}
              used={shared ? null : usedLine(uses?.[k.name], team)}
              onReplace={() => setForm({ replace: k, bots: [] })}
              // A shared workspace's routines are the owner's.
              onRoutines={!shared && hasTemplates(k.name) ? () => setAsked(k.name) : undefined}
              routines={!shared && hasTemplates(k.name) && firstOfApp(k.name) && <AppRoutines state={state} app={k.name} onOpenWatch={onOpenWatch} />}
              switchesOff={shared && !info.shared?.acts}
              anchorRef={(el) => void (el ? anchors.current.set(k.name, el) : anchors.current.delete(k.name))}
            />
            {/* A new value for this key, right under it. */}
            {form?.replace?.name === k.name && form.replace.scope === k.scope && <AddKey info={info} team={team} replace={k} scope={k.scope} shared={shared} bots={[]} first={false} onSaved={done} onCancel={() => setForm(null)} />}
          </Fragment>
        ))}
        {form?.replace ? null : form ? (
          <AddKey info={info} team={team} scope={addScope} shared={shared} bots={form.bots} first={!shown.length} onSaved={done} onCancel={() => setForm(null)} />
        ) : (
          saved && <span className="motion-fade-in pt-3 text-[12px] leading-4 text-[#6B6B6B]">{saved}</span>
        )}
        {failed && (
          <span role="alert" className="pt-2 text-[12px] leading-4 text-[#B42318]">
            {failed}
          </span>
        )}
        {info.notice && (
          <span role="alert" className="pt-2 text-[12px] leading-4 text-[#B42318]">
            {undash(info.notice)}
          </span>
        )}
      </>
    );

  return (
    <div ref={ref} className="flex scroll-mt-4 flex-col gap-2 pt-2">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold leading-5">Keys</span>
          <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">
            {shared
              ? "This workspace's keys, kept in the owner's Orgo vault. Bots call through Orgo and never see them."
              : "Kept in your Orgo vault, the same keys as Orgo's Settings, Secrets. Bots call through Orgo and never see them."}
          </span>
        </div>
        {info?.signedIn && holds && !form && (
          <button onClick={add} className="flex shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold leading-4 text-white hover:bg-[#2A2A28]">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Add a key
          </button>
        )}
      </div>
      {info?.signedIn && holds && info.workspaceKeys && (
        <div role="tablist" aria-label="Where the keys apply" className="flex gap-1 self-start rounded-full bg-[#F2F2F0] p-0.5">
          {SCOPES.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={scope === x.id}
              data-tip={shared ? (x.id === "workspace" ? "This workspace's own keys." : "The owner's keys for all their workspaces.") : x.tip}
              onClick={() => {
                setTab(x.id);
                if (form && !form.replace) setForm(null);
              }}
              className={`rounded-full px-3 py-1 text-[12.5px] font-medium leading-4 ${scope === x.id ? "bg-white text-ink shadow-[0_0_0_1px_#E6E6E3]" : "text-[#6B6B6B] hover:text-ink"}`}
            >
              {x.label}
              <span className="pl-1 font-normal tabular-nums text-[#9A9A98]">{info.keys.filter((k) => k.scope === x.id).length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col rounded-2xl bg-white p-3.5 shadow-[0_0_0_1px_#ECECEA]">{body}</div>
      {routinesFor && (
        <RoutineSuggest
          key={`${routinesFor.app}:${routinesFor.botId ?? ""}`}
          state={state}
          app={routinesFor.app}
          botId={routinesFor.botId}
          pickBot
          anchor={() => anchorOf(anchors.current, routinesFor.app)}
          onClose={() => {
            setAsked(null);
            suggest.handled();
          }}
        />
      )}
    </div>
  );
}

/** Who may use a key: a bot can, or can't. */
const KEY_CHOICES: { id: "act" | "none"; name: string; hint: string }[] = [
  { id: "act", name: "Can use it", hint: "Calls through Orgo and never sees the key. Anything but a read asks you first." },
  { id: "none", name: "No access", hint: "Can't use it." },
];

/**
 * One key in the vault in two lines, as a Connected App's account reads: its name, when it was set, and Show,
 * Copy, Replace and Remove as icons; then the bots that may use it (a chip each) and when one last did.
 */
function KeyLine({
  k,
  state,
  picked,
  onPick,
  team,
  used,
  onReplace,
  onRoutines,
  routines,
  anchorRef,
  switchesOff,
  onRemoved,
  onBusy,
}: {
  k: KeyRow;
  state: AppState;
  /** Open in the Logins page's side panel; `onPick` opens it there from its name. */
  picked?: boolean;
  onPick?: () => void;
  team: Bot[];
  /** "Used 2h ago by Iris", when a bot of this workspace did. */
  used: string | null;
  onReplace: () => void;
  /** Opens its starter routines, when it has some; the button that does is the popover's anchor. */
  onRoutines?: () => void;
  /** What bots run from it on their own (routines.tsx AppRoutines), under its bots. */
  routines?: React.ReactNode;
  anchorRef: (el: HTMLSpanElement | null) => void;
  /** In a shared workspace whose owner's Bops can't take the bots' switches yet: they're shown, not changed. */
  switchesOff?: boolean;
  /** Told once it's removed (a key card in the chat goes on then). */
  onRemoved?: () => void;
  /** Told while one of its writes (a bot's switch, a remove) is on its way: a key card's Done waits for it. */
  onBusy?: (busy: boolean) => void;
}) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = useKeyValue(k.name, k.scope, setError);
  useEffect(() => onBusy?.(busy), [busy, onBusy]);
  const toggle = async (b: Bot, allowed: boolean) => {
    setBusy(true);
    setError(await grant(k.name, b.id, allowed));
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post(`/api/keys/${encodeURIComponent(k.name)}${k.scope === "workspace" ? "?scope=workspace" : ""}`, {}, "DELETE");
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(undash(j.error ?? "That didn't remove it. Try again."));
        setBusy(false);
        return;
      }
      // Done: the list reads again and drops this row. If that read fails, the row isn't stuck on Removing.
      setBusy(false);
      setSure(false);
      keysChanged();
      onRemoved?.();
    } catch {
      setError("Couldn't reach Bops. Try again.");
      setBusy(false);
    }
  };
  const when = setOn(k.updatedAt);
  // Another workspace's, switched on here (Used in): its value, a new one and removing it are that workspace's. In a
  // shared workspace, the owner's own (for all their workspaces, or another of theirs): theirs alone.
  const owners = !!state.shared && !!k.owner;
  const fromName = owners ? null : k.from ? (state.workspaces?.find((w) => w.id === k.from)?.name ?? "another workspace") : null;
  // Where it applies is the tab it's under, so the line says only what's this key's own.
  const meta = [owners && "The owner's", fromName && `From ${fromName}`, k.readOnly && "Read only", when && `Updated ${when}`].filter(Boolean).join(" · ");
  // Its bots' switches in a shared workspace that haven't landed: waiting for the owner's Bops, or (the newest) not gone and why.
  const sends = state.shared?.keySends?.filter((x) => x.name === k.name) ?? [];
  const sendFailed = sends.at(-1)?.state === "failed" ? sends.at(-1) : undefined;
  const sendWaits = sends.some((x) => x.state === "waiting");
  return (
    <div data-key={keyId(k)} className={`flex flex-col gap-1.5 border-b border-[#F0F0EE] py-3 first:pt-0 ${picked ? "-mx-2 rounded-xl px-2 shadow-[0_0_0_1.5px_#0A0A0A]" : ""}`}>
      <div className="flex items-center gap-2">
        {/* Where focus goes when the last of its routines is deleted (autopilot.tsx, focusAfterRemove). */}
        {onPick ? (
          <button type="button" data-list-heading onClick={onPick} aria-pressed={!!picked} className="min-w-0 truncate rounded-md text-left font-mono text-[13px] font-medium leading-[18px] outline-none hover:underline focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]">
            {k.name}
          </button>
        ) : (
          <span data-list-heading tabIndex={-1} className="min-w-0 truncate font-mono text-[13px] font-medium leading-[18px] outline-none">
            {k.name}
          </span>
        )}
        {meta && (
          <span data-tip={`${owners ? OWNERS_TIP : scopeLabel(k.scope).tip}${k.readOnly ? " Orgo lets bots only read with it." : ""}`} className="min-w-0 shrink-[3] truncate text-[12px] leading-4 text-[#9A9A98]">
            {meta}
          </span>
        )}
        <span className="flex-1" />
        <div data-key-controls className={`flex shrink-0 items-center ${fromName || owners ? "hidden" : ""}`}>
          <button
            type="button"
            disabled={busy || v.busy}
            onClick={() => void v.toggle()}
            aria-label={v.shown !== null ? "Hide key" : "Show key"}
            data-tip={v.shown !== null ? "Hide key" : "Show key"}
            className={`${iconBtn} w-7 ${v.shown !== null ? "bg-[#F2F2F0] text-ink" : "text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink"}`}
          >
            <EyeIcon off={v.shown !== null} />
          </button>
          <button
            type="button"
            disabled={busy || v.busy}
            onClick={() => void v.copy()}
            aria-label="Copy key"
            data-tip={v.copied ? undefined : "Copy key"}
            className={`${iconBtn} ${v.copied ? "bg-[#2BB673]/15 px-2.5 text-[#1E8A55]" : "w-7 text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink"}`}
          >
            {v.copied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                  <path d="M3 8.5l3 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Copied
              </>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                <rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M10.5 3.2A1.6 1.6 0 0 0 9 2.5H4.1A1.6 1.6 0 0 0 2.5 4.1V9a1.6 1.6 0 0 0 .7 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            )}
          </button>
          {onRoutines && (
            <span ref={anchorRef} className="flex pl-1">
              <button disabled={busy} onClick={onRoutines} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
                Add routines
              </button>
            </span>
          )}
          <button type="button" disabled={busy} onClick={onReplace} aria-label="Replace key" data-tip="Replace key" className={rowIconBtn}>
            <PencilIcon />
          </button>
          <button type="button" disabled={busy} onClick={() => setSure(true)} aria-label="Remove key" data-tip="Remove key" className={rowTrashBtn}>
            <TrashIcon />
          </button>
        </div>
      </div>
      {v.shown !== null && (
        <div className="motion-fade-in flex flex-col gap-1">
          <span className="select-text break-all rounded-[10px] bg-[#F7F7F6] px-3 py-2 font-mono text-[12px] leading-[17px] text-ink shadow-[0_0_0_1px_#ECECEA]">
            {v.shown}
          </span>
          <span className="text-[11.5px] leading-4 text-[#9A9A98]">Hides in 30 seconds, or when you leave the window.</span>
        </div>
      )}
      {!!team.length && (
        <div className="flex items-center gap-2">
          {/* The owner's own key: only the bots using it are offered, to stop them (OWNERS_KEY_LINE); none is added. */}
          <div data-tip={owners ? OWNERS_KEY_LINE : undefined} className="min-w-0 flex-1">
            <BotChips
              team={owners ? team.filter((b) => b.keys?.includes(k.name)) : team}
              choices={KEY_CHOICES}
              level={(b) => (b.keys?.includes(k.name) ? "act" : "none")}
              what={k.name}
              disabled={busy || switchesOff}
              onSet={(b, to) => void (owners && to === "act" ? undefined : toggle(b, to === "act"))}
            />
          </div>
          {used && <span className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">{used}</span>}
        </div>
      )}
      {switchesOff && !!team.length && <span className="text-[12px] leading-4 text-[#9A9A98]">{SWITCH_UPDATE_LINE}</span>}
      {sendWaits && <span className="text-[12px] leading-4 text-[#9A9A98]">{REPLY_WAITS_LINE}</span>}
      {sendFailed?.error && sendFailed.error !== error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
          {undash(sendFailed.error)}
        </span>
      )}
      {routines}
      {appsShown(state) && <EveryAppSwitch k={k} />}
      {sure && (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[#FEF3F2] px-3 py-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-[#3A3A38]">
            {state.shared ? (
              <>Remove {k.name} from this workspace? Its bots stop using it, and it&apos;s gone from Orgo too.</>
            ) : (
              <>Remove {k.name} ({scopeLabel(k.scope).label.toLowerCase()}) from your Orgo vault? Your bots stop using it, and it&apos;s gone from Orgo too.</>
            )}
          </span>
          <button disabled={busy} onClick={() => void remove()} className={`${btn} bg-[#B42318] text-white`}>
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
      <span role="status" className="sr-only">
        {v.copied ? `${k.name} copied` : ""}
      </span>
    </div>
  );
}

/** Orgo's computers run their agents on these keys from the same vault (orgo-web lib/computer-agent). */
const ORGO_USES: Record<string, string> = { ANTHROPIC_API_KEY: "Anthropic", OPENAI_API_KEY: "OpenAI" };

/**
 * Add a key: a service from the list Bops can call (by its vault name, as in Orgo's Secrets), the key pasted into a password field, and the bots that may use it. `replace`: a new value for a saved key,
 * which keeps who may use it. The value is cleared once Orgo has it. A key pasted that says whose it is by how it starts
 * (serviceOfKey) picks that service; picked another by hand after, one line says whose it looks like. `shared`: a workspace
 * shared with the user, whose own keys these are (This workspace's, in the owner's vault). `service`: the one a bot asked for
 * on a key card in the chat (KeyAskCard), which this form saves alone: no list to pick from, and Esc doesn't put the card away.
 */
function AddKey({
  info,
  team,
  replace,
  scope,
  shared,
  bots: startBots,
  first,
  onSaved,
  onCancel,
  service,
  cancelLabel = "Cancel",
}: {
  info: KeysInfo;
  team: Bot[];
  replace?: KeyRow;
  /** This workspace's own key, or one for all workspaces. */
  scope: Scope;
  shared?: boolean;
  bots: string[];
  first: boolean;
  onSaved: (name: string, note?: string) => void;
  onCancel: () => void;
  service?: string;
  cancelLabel?: string;
}) {
  // Every name Orgo can call. A service with two (Stripe) shows each one's name.
  const services = info.providers;
  const twice = (label: string) => services.filter((x) => x.label === label).length > 1;
  const inScope = info.keys.filter((k) => k.scope === scope);
  const [pick, setPick] = useState(replace?.name ?? service ?? services.find((p) => !inScope.some((k) => k.name === p.name))?.name ?? services[0]?.name ?? "");
  const [value, setValue] = useState("");
  const [bots, setBots] = useState(startBots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = replace?.name ?? pick;
  const p = info.providers.find((x) => x.name === name);
  // The service the key pasted says it's for (serviceOfKey), and the one that last picked it: a hand pick after stands.
  const names = services.map((x) => x.name);
  const found = value ? serviceOfKey(value, names, pick) : null;
  const lastFound = useRef<string | null>(null);
  const looksLike = found && found !== name ? services.find((x) => x.name === found) : undefined;
  const typed = (v: string) => {
    setValue(v);
    const f = serviceOfKey(v, names, pick);
    if (f && f !== lastFound.current && !replace && !service) {
      setPick(f);
      setError(null);
    }
    lastFound.current = f;
  };
  const isSaved = !replace && inScope.some((k) => k.name === name);
  const canSave = !!p && !!value.trim() && !busy;
  const save = async () => {
    if (!canSave || !p) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/keys", { name, value, botIds: replace ? [] : bots, scope });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; note?: string };
      if (!res.ok || !j.ok) return setError(undash(j.error ?? "That didn't save. Try again."));
      setValue("");
      keysChanged();
      onSaved(name, j.note ? undash(j.note) : undefined);
    } catch {
      setError("Couldn't reach Bops. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const field = "h-8 rounded-full bg-[#F7F7F6] px-3 text-[13px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        // Closes the form, and keeps the Vault open (the app's Esc would close it). A key card stays.
        if (e.key === "Escape" && !service) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      className={`flex flex-col gap-2.5 ${first ? "" : replace ? "my-3 rounded-[12px] bg-[#FCFCFB] p-3 shadow-[0_0_0_1px_#ECECEA]" : "mt-3 rounded-[12px] bg-[#FCFCFB] p-3 shadow-[0_0_0_1px_#ECECEA]"}`}
    >
      {replace ? (
        <span className="text-[13px] leading-[18px]">
          New value for <span className="font-mono text-[12.5px] font-medium">{replace.name}</span>
        </span>
      ) : service ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative flex">
            <select
              aria-label="Service"
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setError(null);
              }}
              className="h-8 appearance-none rounded-full bg-white pl-3 pr-7 text-[13px] text-ink shadow-[0_0_0_1px_#E6E6E3] outline-none hover:bg-[#FCFCFB] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
            >
              {services.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label}
                  {twice(s.label) ? ` (${s.name})` : ""}
                  {inScope.some((k) => k.name === s.name) ? " (saved)" : ""}
                </option>
              ))}
            </select>
            <svg width="10" height="10" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden>
              <path d="M3 4.5l3 3 3-3" fill="none" stroke="#6B6B6B" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span data-tip="Its name in your Orgo vault" className="font-mono text-[11.5px] text-[#6B6B6B]">
            {name}
          </span>
        </div>
      )}
      {p ? (
        <span className="text-[12px] leading-[17px] text-[#3A3A38]">
          {p.tip}
          {p.readOnly ? ` Orgo lets bots only read from ${p.label}.` : ""} <span className="text-[#9A9A98]">Get one in {p.where}.</span>
          {isSaved && <span className="text-[#9A9A98]"> {shared ? "Saving replaces the one this workspace has." : "Saving replaces the one in your vault."}</span>}
          {info.workspaceKeys && <span className="text-[#9A9A98]"> {scope === "workspace" ? "For this workspace only." : "For all your workspaces."}</span>}
          {ORGO_USES[p.name] && !shared && <span className="text-[#9A9A98]"> Orgo computers that use your {ORGO_USES[p.name]} key use this one too.</span>}
        </span>
      ) : null}
      <input
        type="password"
        value={value}
        onChange={(e) => typed(e.target.value)}
        placeholder={p ? `Paste your ${p.label} key` : "Paste the key"}
        aria-label="Key"
        autoComplete="off"
        spellCheck={false}
        // On a key card the chat's message box keeps the focus: the card comes while someone may be typing there.
        autoFocus={!service}
        className={`${field} w-full font-mono text-[12.5px]`}
      />
      {looksLike && (
        <span data-looks-like className="text-[12px] leading-4 text-[#B54708]">
          This key looks like {looksLike.label}&apos;s.
        </span>
      )}
      {!replace && !!team.length && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="pr-0.5 text-[12px] leading-4 text-[#9A9A98]">Bots that may use it</span>
          {team.map((b) => {
            const on = bots.includes(b.id);
            return <BotChip key={b.id} bot={b} on={on} tip={on ? `${b.name} may use it` : `Let ${b.name} use it`} onClick={() => setBots(on ? bots.filter((x) => x !== b.id) : [...bots, b.id])} />;
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!canSave} className={`${btn} bg-ink text-white disabled:opacity-40`}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
          {cancelLabel}
        </button>
        {error && (
          <span role="alert" className="min-w-0 text-[12px] leading-4 text-[#B42318]">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/* ---------------- A key card in the chat ---------------- */

/**
 * A bot asking for a key it needs (AppApproval kind "key", lib/server/keys.ts askForKey), as its card in the chat: the
 * Logins form itself (AddKey, the service the bot named and that bot picked; the same save to the vault, or a shared
 * workspace's own), or that key's own Logins row (KeyLine: Show, Copy, Replace, Remove, its bots) when it's there already
 * or the bot was asked to bring the card back. A save, a remove or Done answers it (`onAnswer` once), and the bot goes on:
 * the server reads the vault again and leaves one quiet line in the chat, never the key. Not now answers no. Whoever can't
 * add keys here (a Member without Keys, or anyone who can't answer it: `answerer`) reads it, with one line saying who can.
 * The value lives only in the form's field until Orgo has it.
 */
export function KeyAskCard({
  state,
  approval: a,
  answerer,
  busy,
  onAnswer,
  className = "",
  children,
}: {
  state: AppState;
  approval: AppApproval;
  /** "you", or the line saying who answers it (lib/shared.ts askAnswerer). */
  answerer: string;
  busy: boolean;
  onAnswer: (reply: "once" | "reject") => void;
  className?: string;
  /** The answer's own lines from a shared workspace (on its way, or why it didn't go). */
  children?: React.ReactNode;
}) {
  const { info, failed, retry } = useKeys(state.workspace ?? MAIN_WORKSPACE);
  const [replacing, setReplacing] = useState<string | null>(null);
  // A write of its key row on its way (a bot's switch, a remove): Done waits for it, so the bot goes on with what was set.
  const [rowBusy, setRowBusy] = useState(false);
  const name = a.resources[0] ?? "";
  const b = state.bots.find((x) => x.id === a.botId);
  // Saved in a shared workspace: the bot's switch is an act the owner's Bops does (shared-keys.ts sharedSave), so the card
  // answers once it landed, never before, as the bot would go on without it: the bot has the key and no switch of it is
  // still on its way (the window shows one on its way as done already: lib/server/shared-core.ts switchedKeys). Meanwhile
  // it says so, and Go on without it answers anyway (the switch not gone, or the owner's Bops shut).
  const [waitTick, setWaitTick] = useState(false);
  const sends = state.shared?.keySends?.filter((x) => x.name === name && x.botId === a.botId) ?? [];
  const ticked = !!b?.keys?.includes(name) && !sends.some((x) => x.state !== "failed");
  const answered = useRef(false);
  useEffect(() => {
    if (!waitTick || !ticked || answered.current) return;
    answered.current = true;
    onAnswer("once");
  }, [waitTick, ticked, onAnswer]);
  const [note, setNote] = useState<string | null>(null);
  const saved = (_: string, said?: string) => {
    if (!state.shared || !b || ticked) return onAnswer("once");
    setNote(said ?? null);
    setWaitTick(true);
  };
  const sendFailed = sends.at(-1)?.state === "failed" ? sends.at(-1) : undefined;
  const botName = b?.name ?? "The bot";
  const shared = !!state.shared;
  const p = info?.providers.find((x) => x.name === name);
  const rows = info?.keys.filter((k) => k.name === name) ?? [];
  const team = teamOf(state);
  // Where it's saved: as Logins' Add a key would, This workspace where it has keys of its own (a shared workspace: always).
  const scope: Scope = info?.workspaceKeys && (shared || info.keys.some((k) => k.scope === "workspace")) ? "workspace" : "all";
  const mine = answerer === "you" && (!shared || !!info?.shared?.keys);
  const line = "text-[12.5px] leading-[18px] text-[#6B6B6B]";
  let body: React.ReactNode;
  if (answerer !== "you") body = <span data-who-answers className={line}>{answerer}</span>;
  else if (!info)
    body = failed ? (
      <span role="alert" className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${line}`}>
        {failed}
        <button type="button" onClick={retry} className="font-medium text-ink underline-offset-2 hover:underline">
          Try again
        </button>
      </span>
    ) : (
      <span className={line}>Checking</span>
    );
  else if (!info.signedIn) body = <span className={line}>{undash(info.error ?? "Sign in to Orgo to use Keys.")}</span>;
  else if (!p) body = <span className={line}>Bops can&apos;t call that service yet.</span>;
  else if (!mine) body = <span data-who-answers className={line}>{NO_KEYS_LINE}</span>;
  else if (waitTick)
    body = (
      <div className="flex flex-col gap-2">
        <span data-key-waits className={line}>
          Saved. {botName} can use it once the workspace&apos;s Bops lets it. {sends.some((x) => x.state === "waiting") ? REPLY_WAITS_LINE : ""}
        </span>
        {(note ?? sendFailed?.error) && (
          <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
            {undash(note ?? sendFailed!.error!)}
          </span>
        )}
        <button type="button" disabled={busy} onClick={() => onAnswer("once")} className={`${btn} self-start bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
          Go on without it
        </button>
      </div>
    );
  else if (rows.length)
    body = (
      <div className="flex flex-col">
        {rows.map((k) => (
          <Fragment key={keyId(k)}>
            <KeyLine
              k={k}
              state={state}
              team={team}
              used={null}
              onReplace={() => setReplacing(keyId(k))}
              anchorRef={() => {}}
              switchesOff={shared && !info.shared?.acts}
              onRemoved={() => onAnswer("once")}
              onBusy={setRowBusy}
            />
            {replacing === keyId(k) && <AddKey info={info} team={team} replace={k} scope={k.scope} shared={shared} bots={[]} first={false} onSaved={() => onAnswer("once")} onCancel={() => setReplacing(null)} />}
          </Fragment>
        ))}
        {!replacing && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" disabled={busy || rowBusy} onClick={() => onAnswer("once")} className={`${btn} bg-ink text-white`}>
              Done
            </button>
            <button type="button" disabled={busy} onClick={() => onAnswer("reject")} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
              Not now
            </button>
          </div>
        )}
      </div>
    );
  else
    body = <AddKey info={info} team={team} scope={scope} shared={shared} bots={b ? [b.id] : []} first service={name} cancelLabel="Not now" onSaved={saved} onCancel={() => onAnswer("reject")} />;
  return (
    <div data-key-card={name} className={`flex flex-col gap-2.5 rounded-2xl bg-white p-3.5 shadow-[0_0_0_1px_#0000000F,0_10px_30px_-16px_#00000059] ${className}`}>
      <div className="flex items-start gap-2.5">
        {b && <Mascot botId={b.id} color={b.color} size={26} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13.5px] font-semibold leading-[18px] [overflow-wrap:anywhere]">{askHeadline(botName, { action: a.action, reason: a.reason && undash(a.reason) })}</span>
          {/* Bops' own words for what it is, never the bot's: which service, where it's kept, that the bot never sees it. */}
          {p && (
            <span data-ask-facts className="text-[12px] leading-4 text-[#6B6B6B]">
              {p.label} key · kept in {shared ? "the owner's" : "your"} Orgo vault, {botName} never sees it
            </span>
          )}
          {a.askedFor && <span data-asked-for className="truncate text-[12px] leading-4 text-[#6B6B6B]">{a.askedFor} asked for it</span>}
        </div>
      </div>
      {body}
      {children}
    </div>
  );
}

/* ---------------- A bot's profile ---------------- */

type BotKeysProps = { state: AppState; bot: Bot; onAdd: () => void; className: string };

/**
 * On a bot's profile: the keys in the vault, on or off for this bot, and the way to the Vault to add one. In a workspace
 * shared with the user, only with Keys there: GET /api/keys answers with that workspace's keys then (the owner's marked as
 * theirs), and without Keys it has none to show.
 */
/**
 * A bot's rows: one per name, since this workspace's key and the account's by the same name are one to a bot,
 * and that one is the workspace's (Orgo's broker picks it), whichever the vault listed first.
 */
export function botKeyRows<K extends { name: string; scope: Scope }>(keys: K[]): K[] {
  return keys.filter((k, i, all) => {
    const own = all.findIndex((x) => x.name === k.name && x.scope === "workspace");
    return own === -1 ? all.findIndex((x) => x.name === k.name) === i : own === i;
  });
}

export function BotKeys(props: BotKeysProps) {
  return props.state.shared && !props.state.shared.keys ? null : <BotKeysCard {...props} />;
}

function BotKeysCard({ state, bot: b, onAdd, className }: BotKeysProps) {
  const { info, failed, retry } = useKeys(workspaceOf(b));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = botKeyRows(info?.keys ?? []);
  // A key this bot uses with starter routines (Stripe, Plain) offers them on its row, and by itself right after it's saved for this bot.
  const routinesOn = (name: string) => !state.shared && hasTemplates(name) && !!b.keys?.includes(name);
  const anchors = useRef(new Map<string, HTMLElement>());
  const [asked, setAsked] = useState<string | null>(null);
  const suggest = usePendingSuggest(state, (s) => s.botId === b.id && keys.some((k) => routinesOn(k.name) && sameApp(k.name, s.app)));
  const popover = asked ?? suggest.pending?.app ?? null;
  if (!info)
    return failed ? (
      <div className={`flex w-full flex-col rounded-2xl ${className}`}>
        <span className="px-4 pb-1 pt-[11px] text-[13px] font-semibold leading-4">Keys</span>
        <span role="alert" className="flex flex-wrap items-center gap-x-3 px-4 pb-3 pt-0.5 text-[12px] leading-4 text-[#6B6B6B]">
          {failed}
          <button onClick={retry} className="font-medium text-ink underline-offset-2 hover:underline">
            Try again
          </button>
        </span>
      </div>
    ) : null;
  const toggle = async (name: string, allowed: boolean) => {
    setBusy(name);
    setError(await grant(name, b.id, allowed));
    setBusy(null);
  };
  return (
    <div className={`flex w-full flex-col rounded-2xl ${className}`}>
      <div className="flex items-center justify-between px-4 pb-1 pt-[11px]">
        <span className="text-[13px] font-semibold leading-4">Keys</span>
        {info.signedIn && (
          <button onClick={onAdd} className="text-[12px] font-medium leading-4 text-ink">
            Add in Logins ›
          </button>
        )}
      </div>
      {!info.signedIn || !keys.length ? (
        <div className="px-4 pb-3 pt-0.5 text-[12px] leading-4 text-[#6B6B6B]">{info.signedIn ? (state.shared ? "No keys for this workspace yet" : "No keys in your Orgo vault yet") : undash(info.error ?? "Sign in to Orgo to use Keys.")}</div>
      ) : (
        keys.map((k, i) => {
          const on = !!b.keys?.includes(k.name);
          // The owner's own key in a shared workspace: turned off here, never on (OWNERS_KEY_LINE).
          const ownersOff = !!state.shared && !!k.owner && !on;
          return (
            <div key={k.name} className={`flex items-center gap-2.5 px-4 py-[9px] ${i === keys.length - 1 ? "pb-3" : "border-b border-black/[0.05]"}`}>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-[18px]">{k.name}</span>
              {/* Whose key it is, as the Vault says: an account one shows on every workspace's bots, off until switched on. */}
              <span data-tip={state.shared && k.owner ? OWNERS_TIP : scopeLabel(k.scope).tip} className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">
                {state.shared && k.owner ? "The owner's" : scopeLabel(k.scope).label}
              </span>
              {routinesOn(k.name) && (
                <span ref={(el) => void (el ? anchors.current.set(k.name, el) : anchors.current.delete(k.name))} className="flex shrink-0">
                  <button
                    onClick={() => setAsked(k.name)}
                    className="h-[22px] rounded-full bg-black/[0.05] px-2 text-[11.5px] leading-4 text-[#3A3A38] outline-none hover:bg-black/[0.08] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
                  >
                    Add routines
                  </button>
                </span>
              )}
              <button
                role="switch"
                aria-checked={on}
                aria-label={on ? `Stop ${b.name} using ${k.name}` : `Let ${b.name} use ${k.name}`}
                data-tip={ownersOff ? OWNERS_KEY_LINE : undefined}
                disabled={busy === k.name || ownersOff || (!!state.shared && !state.shared.keyActs)}
                onClick={() => void toggle(k.name, !on)}
                className={`flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 disabled:opacity-60 ${on ? "justify-end bg-ink" : "justify-start bg-[#D9D9D6]"}`}
              >
                <span className={`size-[18px] rounded-full ${on ? "bg-highlighter" : "bg-white"}`} />
              </button>
            </div>
          );
        })
      )}
      {error && (
        <span role="alert" className="px-4 pb-3 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
      {popover && (
        <RoutineSuggest
          key={popover}
          state={state}
          app={popover}
          botId={b.id}
          anchor={() => anchorOf(anchors.current, popover)}
          onClose={() => {
            setAsked(null);
            suggest.handled();
          }}
        />
      )}
    </div>
  );
}

/* ---------------- In the chat ---------------- */

const CALL = /^(.+) (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

/** `quiet`: a read the bot made on its own (no one asked) that didn't work: said with its other reads, never in red. */
export type ApiCall = { who?: string; label: string; method: string; path: string; failed?: string; quiet?: true };

/**
 * A note an API call left in the chat (keys.ts callApi), or null: a GET's "Called Stripe GET /v1/customers",
 * and an approved write's result, "Max: Called Stripe POST /v1/refunds" or "Max couldn't call it: why",
 * which carries what was called in its appResult.
 */
export function apiCallOf(m: Message): ApiCall | null {
  if (m.role !== "system") return null;
  if (m.appResult) {
    const x = CALL.exec(m.appResult.action);
    if (!x) return null;
    const call = { label: x[1], method: x[2], path: x[3] };
    const failed = /^(.+?) couldn't call it: ([\s\S]+)$/.exec(m.text);
    // A read the bot made on its own that didn't work (a file that isn't there): one of its reads, quietly.
    if (failed && m.appResult.read) return { ...call, failed: failed[2], quiet: true };
    if (failed) return { ...call, who: failed[1], failed: failed[2] };
    const did = /^(.+?): Called /.exec(m.text);
    return did ? { ...call, who: did[1] } : null;
  }
  const x = /^Called (.+) (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(m.text);
  return x ? { label: x[1], method: x[2], path: x[3] } : null;
}

const methodColor = (method: string) => (method === "DELETE" ? "text-[#B42318]" : method === "GET" ? "text-[#6B6B6B]" : "text-ink");

/**
 * Whether a call changed something: anything but a GET, or one the user said yes to (`who`), as only a call that changes
 * something asks first (lib/server/keys.ts callApi): a Slack GET that posts.
 */
const changes = (c: ApiCall) => c.method !== "GET" || c.who !== undefined;

/** Whether a call goes in a quiet line (ApiCalls): any that worked, and a read the bot made on its own that didn't. */
export const quietCall = (c: ApiCall) => c.failed === undefined || !!c.quiet;

/** Whether two calls say one line (ApiCalls): the same service and who, both reads or both changes, both quiet. */
export const oneLine = (a: ApiCall, b: ApiCall) => quietCall(a) && quietCall(b) && a.label === b.label && a.who === b.who && changes(a) === changes(b);

/**
 * Calls to one service in a row, in plain words, with how many: "Looked at 6 files on GitHub", "Boppy changed a file on
 * GitHub". A file is what a path to one's contents names (GitHub's /contents/); anything else is a thing.
 */
export function callsSaid(calls: ApiCall[]) {
  const [c] = calls;
  const files = calls.every((x) => /\/contents(?:\/|$)/.test(x.path));
  const what = calls.length === 1 ? (files ? "a file" : "something") : `${calls.length} ${files ? "files" : "things"}`;
  const failed = calls.filter((x) => x.failed !== undefined).length;
  const did = `${changes(c) ? "changed" : "looked at"} ${what} on ${c.label}${failed ? `, ${failed} didn't work` : ""}`;
  return c.who ? `${c.who} ${did}` : did[0].toUpperCase() + did.slice(1);
}

/**
 * The calls a chat's messages end on, in a row as its line says them (oneLine, a quarter of an hour apart at most),
 * oldest first: for the sidebar's last line (sidebar.tsx). None when the last isn't a call that went.
 */
export function lastCalls(messages: Message[]): ApiCall[] {
  const calls: ApiCall[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const call = apiCallOf(messages[i]);
    if (!call || !quietCall(call) || (calls.length > 0 && (!oneLine(call, calls[0]) || messages[i + 1].at - messages[i].at > 15 * 60_000))) break;
    calls.unshift(call);
  }
  return calls;
}

/**
 * A bot's calls to one service in a row (oneLine) as one quiet line in the chat (callsSaid), which opens the list of
 * what was called, each method and path whole; a single call's on hover too. A read the bot made on its own that didn't
 * work is one of them, said as such ("didn't work" and why); a failed write keeps its own note (ApiNote).
 */
export function ApiCalls({ calls }: { calls: ApiCall[] }) {
  const [open, setOpen] = useState(false);
  const one = calls.length === 1 ? `${calls[0].method} ${calls[0].path}` : undefined;
  return (
    <div className="flex max-w-[440px] flex-col items-center gap-1">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-api-calls
        title={one}
        className="flex max-w-full items-center gap-1.5 rounded-full bg-[#F7F7F6] px-3 py-1 text-left text-[12px] leading-4 text-[#6B6B6B] outline-none hover:bg-[#F0F0EE] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
      >
        <span className="flex shrink-0 text-[#9A9A98]">
          <KeyIcon />
        </span>
        <span className="min-w-0">{callsSaid(calls)}</span>
        <Chevron open={open} />
      </button>
      <Fold open={open} lazy className="w-full">
        <ul className="flex flex-col gap-0.5 px-3 pt-0.5 text-[11px] leading-4 text-[#3A3A38]">
          {calls.map((c, i) => (
            <li key={i} data-api-call className="font-mono [overflow-wrap:anywhere]">
              <span className={`font-semibold ${methodColor(c.method)}`}>{c.method}</span> {c.path}
              {c.failed !== undefined && <span className="font-sans text-[#9A9A98]"> · didn&apos;t work: {undash(c.failed)}</span>}
            </li>
          ))}
        </ul>
      </Fold>
    </div>
  );
}

/** An API call in the chat, as a note like an app's: who called which service, the method and the path. */
export function ApiNote({ call: c }: { call: ApiCall }) {
  const what = c.failed !== undefined ? `${c.who ?? "The bot"} couldn't call ${c.label}` : c.who ? `${c.who} called ${c.label}` : `Called ${c.label}`;
  return (
    <div className="flex max-w-[440px] flex-col items-center gap-1">
      <div title={c.path.length > 48 ? c.path : undefined} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-[#F7F7F6] px-3 py-1 text-[12px] leading-4 text-[#6B6B6B]">
        <span className="flex shrink-0 text-[#9A9A98]">
          <KeyIcon />
        </span>
        <span className="shrink-0">{what}</span>
        <span className={`shrink-0 font-mono text-[11px] font-semibold ${methodColor(c.method)}`}>{c.method}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-[#3A3A38]">{c.path}</span>
      </div>
      {c.failed && <span className="line-clamp-2 px-2 text-center text-[12px] leading-4 text-[#B42318]">{undash(c.failed)}</span>}
    </div>
  );
}

/** A request for a call_api write: the service, method and path, and the vault key Orgo sends it with (AppApproval.api). Null for another kind. */
export function apiAskOf(a: AppApproval): { name: string; label: string; method: string; path: string; change?: FileChange } | null {
  if (a.kind !== "api" || !a.api) return null;
  return { name: a.api.key ?? a.api.label, label: a.api.label, method: a.api.method, path: a.api.path, ...(a.api.change ? { change: a.api.change } : {}) };
}

/** What a change does to each file, in a word. */
const FILE_OP = { add: "added", change: "changed", delete: "deleted" } as const;
const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A line of a change's words under its file: one taken out or put in, or Bops' note between them ("at line 12"). */
type ChangeRow = DiffLine | { note: string };

/**
 * A change's words (AppApproval.preview, as lib/server/repo-change.ts writes them), file by file: the lines before the
 * first file but the repository and branch, which the facts line says already (a new branch's base stays), each file's
 * lines under its own "<path>: changed, 59 B" line, in the card's order, and how many lines it changes (null when one
 * isn't a line: an older Bops's "and 4 more lines"). Null when the words aren't in that shape, which the card shows as they are.
 */
/** How a task's card says the bot's own words, last and labelled (lib/server/repo-change.ts, keys.ts): a page it read may have written them. */
export const BOT_WORDS = "In the bot's words: ";

export function changeOf(change: FileChange, preview: string): { head: string[]; files: ChangeRow[][]; changed: number | null; said?: string } | null {
  // A line is never empty ("+ " at least), so a blank line only ever ends a part. A task's card ends with the bot's
  // words (BOT_WORDS), kept apart from the diff and shown last.
  const all = preview.split("\n\n");
  const said = all.length > 1 && all[all.length - 1].startsWith(BOT_WORDS) ? all[all.length - 1].slice(BOT_WORDS.length) : undefined;
  const parts = said === undefined ? all : all.slice(0, -1);
  const skip = parts.length - change.files.length;
  if (skip !== 0 && skip !== 1) return null;
  const files: ChangeRow[][] = [];
  for (const [i, f] of change.files.entries()) {
    const [first, ...rest] = parts[skip + i].split("\n");
    if (!first.startsWith(`${f.path}: `)) return null;
    files.push(rest.map((l) => (/^[+-] /.test(l) ? { t: l[0] as "+" | "-", s: l.slice(2) } : { note: l })));
  }
  const rows = files.flat();
  return {
    head: skip ? parts[0].split("\n").filter((l) => l !== `${change.repo}, branch ${change.branch}`) : [],
    files,
    changed: rows.every((r) => "t" in r || /^at line \d+$/.test(r.note)) ? rows.filter((r) => "t" in r).length : null,
    ...(said !== undefined ? { said } : {}),
  };
}

/** The closed card's quiet line for a change: "2 files · 14 lines changed" (just the files when the lines can't be counted). */
export function changeSize(change: FileChange, shown: ReturnType<typeof changeOf>) {
  const n = change.files.length;
  const lines = shown?.changed;
  return `${n} file${n === 1 ? "" : "s"}${lines ? ` · ${lines} line${lines === 1 ? "" : "s"} changed` : ""}`;
}

/**
 * The call an approval card asks about, under Details (closed until it's opened): the method, the whole path, then what
 * goes with it, and whose key Orgo sends it with. The card's headline and facts line say it in plain words above.
 *
 * A change to files says its size on the closed card in one quiet line beside Details, and opens to every line it
 * changes, file by file, in one scroll area that never outgrows the window: all of what Allow writes. Details stays
 * under the pointer as it opens and shuts: its row sits under what it opens (the dock over the composer grows upward),
 * and while the fold moves, whatever scrolls the card (that dock, once it's as tall as it gets) takes up any difference.
 */
export function ApiAsk({ ask, detail, botName }: { ask: NonNullable<ReturnType<typeof apiAskOf>>; detail: string; botName: string }) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const flip = () => {
    setOpen(!open);
    const el = row.current;
    let box = el?.parentElement ?? null;
    while (box && !/^(auto|scroll)$/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (!el || !box) return;
    const scroller = box;
    const y = el.getBoundingClientRect().top;
    // As long as the fold moves (fold.tsx: 200 ms), then a frame or two more.
    const end = performance.now() + 320;
    const hold = () => {
      const d = el.getBoundingClientRect().top - y;
      if (Math.abs(d) >= 0.5) scroller.scrollTop += d;
      if (performance.now() < end) requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  };
  const toggle = (
    <button
      onClick={ask.change ? flip : () => setOpen(!open)}
      aria-expanded={open}
      data-ask-details
      className="flex items-center gap-1 self-start rounded-md py-0.5 text-[12px] font-medium leading-4 text-[#6B6B6B] outline-none hover:text-ink focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
    >
      Details
      <Chevron open={open} up={!!ask.change} />
    </button>
  );
  const keyLine = (
    <span className="text-[12px] leading-4 text-[#6B6B6B]">
      Orgo sends it to {ask.label} with your key (<span className="font-mono text-[11px]">{ask.name}</span>). {botName} never sees the key.
    </span>
  );
  if (ask.change) {
    const change = ask.change;
    const shown = changeOf(change, detail);
    return (
      <div className="flex flex-col gap-1">
        <Fold open={open} up>
          <div className="flex flex-col gap-1.5 pb-1">
            {/* As tall as leaves the open card inside the dock over the composer (45vh: chat-view.tsx), the rest of the card
                being about 16rem, so its lines scroll here alone; never under 7.5rem or over 320px. */}
            <div
              role="region"
              aria-label="What changes"
              tabIndex={0}
              data-change-diff
              className="flex max-h-[clamp(7.5rem,calc(45vh-16rem),320px)] flex-col gap-2 overflow-y-auto rounded-xl bg-[#F7F7F6] py-1.5 outline-none focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
            >
              {shown?.head.map((l) => (
                <span key={l} className="px-3 text-[12px] leading-4 text-[#6B6B6B] [overflow-wrap:anywhere]">
                  {l}
                </span>
              ))}
              {change.files.map((f, i) => (
                <div key={f.path} data-change-file className="flex flex-col gap-0.5">
                  {/* Each file under its name: what happens to it and its size, as the facts line counts it. A picture from the
                      chat: the copy that goes in, beside its name, with its size in pixels, in place of lines. */}
                  <div className="flex items-start gap-2 px-3 text-[12.5px] leading-[18px]">
                    {f.image?.id && readAllowed(`/api/uploads/${f.image.id}`) && (
                      // eslint-disable-next-line @next/next/no-img-element -- the picture that goes in, served by this app
                      <img data-change-image src={`/api/uploads/${f.image.id}`} alt={`${f.path}, as it goes in`} className="size-10 shrink-0 rounded-md bg-white object-contain shadow-[0_0_0_1px_#0000000F]" />
                    )}
                    <span className="min-w-0 flex-1 select-text font-mono text-[12px] text-ink [overflow-wrap:anywhere]">{f.path}</span>
                    <span className={`shrink-0 ${f.op === "delete" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>
                      {FILE_OP[f.op]}
                      {f.bytes !== undefined ? ` · ${sizeOf(f.bytes)}` : ""}
                      {f.image?.w && f.image.h ? ` · ${f.image.w} × ${f.image.h}` : ""}
                    </span>
                  </div>
                  {!!shown?.files[i].length && (
                    <pre className="font-mono text-[11.5px] leading-4 text-[#3A3A38]">
                      {shown.files[i].map((r, j) =>
                        "note" in r ? (
                          <div key={j} className="whitespace-pre-wrap px-3 text-[#9A9A98] [overflow-wrap:anywhere]">
                            {r.note}
                          </div>
                        ) : (
                          <DiffRow key={j} line={r} />
                        ),
                      )}
                    </pre>
                  )}
                </div>
              ))}
              {shown?.said !== undefined && (
                <span data-change-said className="px-3 text-[12px] leading-4 text-[#6B6B6B] [overflow-wrap:anywhere]">
                  {BOT_WORDS}
                  {shown.said}
                </span>
              )}
              {/* An older Bops's words, in another shape: as they are. */}
              {!shown && detail && <pre className="whitespace-pre-wrap px-3 font-mono text-[11.5px] leading-4 text-[#3A3A38] [overflow-wrap:anywhere]">{detail}</pre>}
            </div>
            {keyLine}
          </div>
        </Fold>
        <div ref={row} className="flex items-center gap-2">
          {toggle}
          <span data-change-size className="text-[12px] leading-4 text-[#6B6B6B]">
            {changeSize(change, shown)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {toggle}
      <Fold open={open}>
        <div className="flex flex-col gap-1.5 pt-0.5">
          <div className="flex flex-col gap-1.5 rounded-xl bg-[#F7F7F6] px-3 py-2">
            <div className="flex items-start gap-2 font-mono text-[12.5px] leading-[18px]">
              <span className={`shrink-0 rounded-md bg-white px-1.5 text-[11.5px] font-semibold shadow-[0_0_0_1px_#E6E6E3] ${methodColor(ask.method)}`}>{ask.method}</span>
              <span className="min-w-0 select-text text-ink [overflow-wrap:anywhere]">{ask.path}</span>
            </div>
            {detail && <pre className="max-h-[180px] overflow-y-auto whitespace-pre-wrap font-mono text-[11.5px] leading-4 text-[#3A3A38] [overflow-wrap:anywhere]">{detail}</pre>}
          </div>
          {keyLine}
        </div>
      </Fold>
    </div>
  );
}
