"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AppCommit, AppCommitsAnswer, AppHosting, DeployState, HostedApp, HostedAppAction, HostedAppsAnswer } from "@/lib/hosted-apps";
import { botChatId, workspaceOf, type AppState } from "@/lib/types";
import { ago, post } from "./ui";

/*
 * Apps the workspace runs on the web (lib/hosted-apps.ts), in Bops' right panel. Each one is an Ingot repo,
 * worked on on a bot's Bops computer. The Apps page's "On the web" list has one line per app: its state, its public
 * address, the short id of the changeset its site serves, and Deploy. An app's tab has its address (open,
 * copy), "Work on it" (its bot's chat, with words typed in) and Deploy; its history from Ingot, newest
 * first, where any changeset can be deployed; and the newest deploy's log, folded. The
 * list is read again every few seconds while a deploy waits or runs, whenever this Mac queues a deploy
 * (appsStamp), and otherwise when the window comes back into focus. The history is read again when the
 * app's newest changeset or deploy changes, and when the window comes back into focus, never on a timer.
 */

/** Open an app on the web in its tab (bops-app.tsx), by its Ingot repo's name; null where there's no panel. */
export const OpenHostedApp = createContext<((ws: string, name: string) => void) | null>(null);

/** How often the list (and a running deploy's log) is read again while a deploy waits or runs. */
const POLL_MS = 3000;

/** The newest deploy's log as GET /api/hosted-apps/[name]/logs answers it: what came after `after`, and where to read on from. */
export type DeployLogAnswer = { state: DeployState | null; log: string; next: string | number | null; more: boolean };

export const deploying = (a: Pick<HostedApp, "live">) => a.live?.state === "queued" || a.live?.state === "running";

/** Its public address: the newest deploy's, else the one kept from the first. */
export const urlOf = (a: HostedApp) => a.live?.url ?? a.hosting?.url ?? null;

/** What it says where its address would be, when it has none: live with no address yet, or not on the web yet. */
export const noAddress = (a: HostedApp, never = "Not on the web yet") => (a.serving || a.live?.state === "succeeded" ? "No address yet" : never);

/** A changeset's short id, as its line shows it (all of it in the tooltip). */
export const short = (id: string) => id.slice(0, 7);

/** Where a workspace's apps are worked on and run, by repo name, as the app's state has it (Workspace.hostedApps). */
const hostingIn = (state: Pick<AppState, "workspaces"> | null | undefined, ws: string): Record<string, AppHosting> =>
  state?.workspaces?.find((w) => w.id === ws)?.hostedApps ?? {};

/**
 * What of a workspace's apps changes in the app's state when this Mac deploys one (where it runs, its
 * site, a deploy queued): the list is read again whenever it does, so the page follows a bot's deploy
 * while the window keeps its focus.
 */
export const appsStamp = (state: Pick<AppState, "workspaces"> | null | undefined, ws: string) =>
  Object.entries(hostingIn(state, ws))
    .map(([name, h]) => `${name}:${h.botId}:${h.computerId}:${h.projectId ?? ""}:${h.url ?? ""}:${h.queuedAt ?? ""}`)
    .sort()
    .join(",");

/**
 * "Work on it": the bot to ask (the one whose computer holds its working folder, else the workspace's main
 * bot, the first of them in this workspace with a chat to put the words in) and the words, to finish and
 * send. Null when none has a chat.
 */
export function workOn(state: Pick<AppState, "workspaces" | "bots" | "chats"> | null | undefined, ws: string, app: Pick<HostedApp, "name" | "hosting">) {
  if (!state) return null;
  const main = state.bots.find((b) => b.isMain && workspaceOf(b) === ws)?.id;
  for (const id of [app.hosting?.botId, hostingIn(state, ws)[app.name]?.botId, main]) {
    const bot = id ? state.bots.find((b) => b.id === id && workspaceOf(b) === ws) : undefined;
    if (bot && state.chats.some((c) => c.id === botChatId(bot.id))) return { botId: bot.id, name: bot.name, text: `Change the app “${app.name}”: ` };
  }
  return null;
}

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

const PULSE = "animate-pulse bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]";
const STATES: Record<DeployState, { word: string; dot: string }> = {
  queued: { word: "Waiting to deploy", dot: PULSE },
  running: { word: "Deploying", dot: PULSE },
  succeeded: { word: "Live", dot: "bg-[#2BB673]" },
  failed: { word: "Failed", dot: "bg-[#B42318]" },
  cancelled: { word: "Deploy stopped", dot: "bg-[#9A9A98]" },
  superseded: { word: "Deploy replaced", dot: "bg-[#9A9A98]" },
};

const NEVER = { word: "Not on the web yet", dot: "shadow-[inset_0_0_0_1.5px_#C9C9C6]" };

/** What its newest deploy says, in a word and a dot, and in full for the tooltip (the changeset it built, when, and why it failed). */
export function stateOf(a: Pick<HostedApp, "live">) {
  // (A state this build doesn't know reads as none.)
  const s = (a.live?.state && STATES[a.live.state]) || NEVER;
  const facts = [s.word, a.live?.at ? short(a.live.at) : null, a.live?.when ? ago(a.live.when) : null].filter(Boolean).join(" · ");
  return { ...s, tip: a.live?.error ? `${facts}: ${a.live.error}` : facts };
}

/**
 * Apps a deploy is being sent for, from any list or tab in this window: none of their Deploy buttons can be
 * pressed again until it's answered (a second press would queue two deploys).
 */
const sending = new Set<string>();
const sendingHeard = new Set<() => void>();
let sendingAt = 0;
function setSending(name: string, on: boolean) {
  if (on) sending.add(name);
  else sending.delete(name);
  sendingAt++;
  for (const f of sendingHeard) f();
}
/** Read again whenever a deploy starts or stops being sent anywhere in the window. */
const useSending = () =>
  useSyncExternalStore(
    (f) => (sendingHeard.add(f), () => void sendingHeard.delete(f)),
    () => sendingAt,
    () => 0,
  );

/** Why Deploy can't be pressed for it now (undefined: it can). `at`: a changeset picked from its history, not the newest. */
export function whyNot(answer: Pick<HostedAppsAnswer, "enabled" | "why">, a: HostedApp, at?: string) {
  if (!answer.enabled) return answer.why || "Deploying isn't open here.";
  if (!at && !a.head) return "Nothing is committed yet.";
  if (deploying(a)) return "A deploy is running. Wait for it to finish.";
  if (sending.has(a.name)) return "A deploy is being sent. Wait for it.";
  return undefined;
}

const json = async <T,>(url: string): Promise<T | null> => {
  const r = await fetch(url, { cache: "no-store" }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as T | null) : null;
};

const at = (name: string) => `/api/hosted-apps/${encodeURIComponent(name)}`;

/** The workspace's apps (null: they couldn't be read). */
export async function readApps(ws: string): Promise<HostedAppsAnswer | null> {
  const a = await json<HostedAppsAnswer>(`/api/hosted-apps?ws=${encodeURIComponent(ws)}`);
  return a && Array.isArray(a.apps) ? a : null;
}

/**
 * An app's changesets, newest first, from Ingot: the newest page, or the one older than `before` (null:
 * they couldn't be read; `offline`: Ingot can't be reached now).
 */
export async function readCommits(ws: string, name: string, before?: string | null): Promise<AppCommitsAnswer | null> {
  const a = await json<AppCommitsAnswer>(`${at(name)}/commits?ws=${encodeURIComponent(ws)}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
  return a && Array.isArray(a.commits) ? a : null;
}

/** The newest deploy's log after `after` (null: from the start). */
export const readLog = (ws: string, name: string, after: string | number | null) =>
  json<DeployLogAnswer>(`${at(name)}/logs?ws=${encodeURIComponent(ws)}${after === null ? "" : `&after=${encodeURIComponent(String(after))}`}`);

/** Deploy (the newest changeset, or `at`): the app as it is now, its deploy queued, or why not. */
export async function act(name: string, body: HostedAppAction): Promise<{ app?: HostedApp; error?: string }> {
  const r = await post(at(name), body).catch(() => null);
  const answer = ((await r?.json().catch(() => null)) ?? {}) as { app?: HostedApp; error?: string };
  return r?.ok ? { app: answer.app } : { error: answer.error || "Couldn't deploy it. Try again." };
}

/** Calls `f` whenever the window comes back into focus, until what it answers is called. */
const whenFocused = (f: () => void) => {
  window.addEventListener("focus", f);
  return () => window.removeEventListener("focus", f);
};

/** The last list read for each workspace, so the page or a tab opened again shows it at once (and reads it again). */
const lastRead = new Map<string, HostedAppsAnswer>();

/**
 * The workspace's apps, read again every few seconds while one deploys, whenever `stamp` (appsStamp)
 * changes, else when the window is focused again.
 */
function useHostedApps(ws: string, stamp = "") {
  const [got, setGot] = useState<{ ws: string; answer: HostedAppsAnswer | null; failed: boolean } | null>(null);
  const answer = (got?.ws === ws ? got.answer : null) ?? lastRead.get(ws) ?? null;
  const failed = got?.ws === ws && got.failed && !answer;
  const busy = !!answer?.apps.some(deploying);
  useEffect(() => {
    let stop = false;
    const read = async () => {
      const r = await readApps(ws);
      if (stop) return;
      if (r) lastRead.set(ws, r);
      // One that couldn't be read keeps what was there.
      setGot((g) => ({ ws, answer: r ?? (g?.ws === ws ? g.answer : null), failed: !r }));
    };
    void read();
    if (busy) {
      const t = setInterval(read, POLL_MS);
      return () => {
        stop = true;
        clearInterval(t);
      };
    }
    const off = whenFocused(() => void read());
    return () => {
      stop = true;
      off();
    };
  }, [ws, busy, stamp]);
  /**
   * An app as a deploy answered it: shown at once, and read again from then on while its deploy runs. What
   * it serves meanwhile, if that answer doesn't say, is what was read last.
   */
  const put = (app: HostedApp) => {
    const base = answer ?? { enabled: true, apps: [] };
    const was = base.apps.find((a) => a.name === app.name);
    const now = { ...app, serving: app.serving ?? was?.serving ?? null };
    const next = { ...base, apps: was ? base.apps.map((a) => (a.name === app.name ? now : a)) : [...base.apps, now] };
    lastRead.set(ws, next);
    setGot({ ws, answer: next, failed: false });
  };
  return { answer, failed, put };
}

/**
 * A deploy being sent: `busy(key, name)` for the button that sent it (it says Deploying…), while the app's
 * other buttons, here and in any other view, wait (sending). Why the last one couldn't be sent.
 */
function useDeploy(onChanged: (app: HostedApp) => void) {
  useSending();
  const [pressed, setPressed] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ name: string; text: string } | null>(null);
  const run = async (key: string, name: string, body: HostedAppAction) => {
    if (sending.has(name)) return;
    setSending(name, true);
    setPressed((p) => ({ ...p, [name]: key }));
    setError(null);
    const r = await act(name, body);
    setSending(name, false);
    setPressed(({ [name]: _done, ...rest }) => (void _done, rest));
    if (r.app) onChanged(r.app);
    else if (r.error) setError({ name, text: r.error });
  };
  const busy = (key: string, name: string) => pressed[name] === key && sending.has(name);
  return { busy, error, run };
}

function StateDot({ app }: { app: HostedApp }) {
  const s = stateOf(app);
  return <span data-tip={s.tip} className={`size-2 shrink-0 rounded-full ${s.dot}`} />;
}

/**
 * Deploy, or "Deploy this one": pressed only when `why` is empty, else greyed with why in its tooltip
 * (on what holds it: a disabled button gets no pointer events in some browsers). A press never reaches
 * the row it's on.
 */
function DeployButton({ why, busy, onClick, label = "Deploy", primary }: { why?: string; busy: boolean; onClick: () => void; label?: string; primary?: boolean }) {
  const look = primary
    ? "rounded-full bg-ink px-3 py-1 font-semibold text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]"
    : "rounded-full px-2.5 py-1 font-medium text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-white disabled:text-[#9A9A98] disabled:shadow-[0_0_0_1px_#ECECEA]";
  return (
    <span data-tip={why} onClick={(e) => e.stopPropagation()} className="flex shrink-0">
      <button disabled={!!why || busy} onClick={onClick} className={`whitespace-nowrap text-[12px] leading-4 ${look}`}>
        {busy ? "Deploying…" : label}
      </button>
    </span>
  );
}

function UrlLink({ url }: { url: string }) {
  // It opens in the browser (the Mac app sends a new window's address there), never on the row under it.
  return (
    <a href={url} target="_blank" rel="noreferrer" title={url} onClick={(e) => e.stopPropagation()} className="min-w-0 shrink-[2] truncate font-mono text-[11.5px] leading-4 text-[#6B6B6B] hover:text-ink hover:underline">
      {bare(url)}
    </a>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        void navigator.clipboard
          ?.writeText(url)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {})
      }
      aria-label={copied ? "Copied" : "Copy link"}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 14 14">
          <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M9.5 2.6A1.6 1.6 0 0 0 8 2H3.6A1.6 1.6 0 0 0 2 3.6V8a1.6 1.6 0 0 0 .6 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

const QUIET = "text-[12.5px] leading-[18px] text-[#9A9A98]";
const PROBLEM = "truncate text-[12px] leading-4 text-[#B42318]";

/**
 * The Apps page's "On the web" list (made-apps.tsx MadeAppsHome), read from the server (again when this
 * Mac queues a deploy: appsStamp).
 */
export function HostedApps({ state, ws }: { state?: Pick<AppState, "workspaces"> | null; ws: string }) {
  const { answer, failed, put } = useHostedApps(ws, appsStamp(state, ws));
  return <HostedAppsList ws={ws} answer={answer} failed={failed} onChanged={put} />;
}

/**
 * One line per app: its state, name, public address (opened in the browser), the short id of the changeset
 * its site serves, and Deploy (the newest changeset). The rest of the line opens its tab. Nothing until
 * it's read, one quiet line when there are none, and nothing at all when there are none and deploying
 * isn't open here (no invitation to make a site that can't go on the web).
 */
export function HostedAppsList({ ws, answer, failed, onChanged }: { ws: string; answer: HostedAppsAnswer | null; failed?: boolean; onChanged: (app: HostedApp) => void }) {
  const open = useContext(OpenHostedApp);
  const { busy, error, run } = useDeploy(onChanged);
  const wrong = error && answer?.apps.find((a) => a.name === error.name);
  if (answer && !answer.enabled && !answer.apps.length) return null;
  return (
    <div data-hosted-apps className="flex flex-col gap-1">
      <span className="text-[12px] font-semibold leading-4 text-[#6B6B6B]">On the web</span>
      {!answer ? (
        failed && <span className={QUIET}>Couldn&apos;t read them just now.</span>
      ) : !answer.apps.length ? (
        <span className={QUIET}>Ask a bot to make a website.</span>
      ) : (
        <div className="-mx-2 flex flex-col">
          {answer.apps.map((a) => {
            const url = urlOf(a);
            return (
              <div
                key={a.name}
                data-hosted-app={a.name}
                data-state={a.live?.state ?? "none"}
                onClick={() => open?.(ws, a.name)}
                className="flex h-8 cursor-default items-center gap-2 rounded-lg px-2 hover:bg-[#F6F6F4]"
              >
                <StateDot app={a} />
                {/* The row's button for the keyboard: its press comes up to the row. */}
                <button title={a.name} className="min-w-0 shrink truncate text-left text-[13px] font-medium leading-4 text-ink">
                  {a.name}
                </button>
                {url ? <UrlLink url={url} /> : <span className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">{noAddress(a, "Not deployed yet")}</span>}
                <span className="flex-1" />
                {a.serving && (
                  <span data-serving title={`Its site serves ${a.serving}`} className="shrink-0 font-mono text-[11px] leading-[14px] text-[#6B6B6B]">
                    {short(a.serving)}
                  </span>
                )}
                <DeployButton why={whyNot(answer, a)} busy={busy(a.name, a.name)} onClick={() => void run(a.name, a.name, { ws, action: "deploy" })} />
              </div>
            );
          })}
        </div>
      )}
      {wrong && (
        <span className={PROBLEM} title={error.text}>
          {wrong.name}: {error.text}
        </span>
      )}
    </div>
  );
}

/**
 * An app's tab: read with the list (so it shows at once from the Apps page, and again when this Mac queues
 * a deploy: appsStamp), and its history. `onAsk`: a bot's chat with words typed in (bops-app.tsx askBot),
 * for "Work on it".
 */
export function HostedAppTab({
  state,
  ws,
  name,
  onAsk,
}: {
  state?: Pick<AppState, "workspaces" | "bots" | "chats"> | null;
  ws: string;
  name: string;
  onAsk?: (botId: string, text?: string) => void;
}) {
  const { answer, failed, put } = useHostedApps(ws, appsStamp(state, ws));
  const app = answer?.apps.find((a) => a.name === name);
  // Read again when a commit or a deploy moves it on.
  const { history, older } = useHistory(ws, name, `${app?.head ?? ""}:${app?.live?.id ?? ""}:${app?.live?.state ?? ""}:${app?.serving ?? ""}`);
  if (!answer || !app)
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-[#6B6B6B]">
        {answer ? "This app isn't here any more." : failed ? "Couldn't read this app. Try again in a moment." : ""}
      </div>
    );
  const ask = onAsk && workOn(state, ws, app);
  return (
    <HostedAppView
      ws={ws}
      answer={answer}
      app={app}
      history={history}
      older={older}
      work={ask ? { name: ask.name, go: () => onAsk(ask.botId, ask.text) } : null}
      onChanged={put}
    />
  );
}

/**
 * The history after a newer read of its newest page (`fresh`): that page, and the older pages read before
 * under it when the page reaches into them (else the newest page alone, with its own `next`).
 */
export function withNewest(fresh: AppCommitsAnswer, was: AppCommitsAnswer | null | false): AppCommitsAnswer {
  if (!was || was.offline || fresh.offline || !fresh.commits.length) return fresh;
  const last = fresh.commits[fresh.commits.length - 1].id;
  const i = was.commits.findIndex((c) => c.id === last);
  return i < 0 ? fresh : { ...fresh, commits: [...fresh.commits, ...was.commits.slice(i + 1)], next: was.next };
}

/** The history with an older page read (`page`, from `before` = the history's `next`) under it. */
export function withOlder(was: AppCommitsAnswer, page: AppCommitsAnswer): AppCommitsAnswer {
  const seen = new Set(was.commits.map((c) => c.id));
  return { ...was, commits: [...was.commits, ...page.commits.filter((c) => !seen.has(c.id))], next: page.next };
}

/** Reading older changesets: while one is read, whether the last one failed, and the press that reads it. */
type Older = { reading: boolean; failed: boolean; go: () => void };

/**
 * An app's changesets (null: being read; false: they couldn't be), read again when `stamp` changes and
 * when the window comes back into focus. One read that fails keeps what was there. `older`: the next page.
 */
function useHistory(ws: string, name: string, stamp: string) {
  const [history, setHistory] = useState<AppCommitsAnswer | null | false>(null);
  const [paging, setPaging] = useState({ reading: false, failed: false });
  useEffect(() => {
    let stop = false;
    const read = () =>
      void readCommits(ws, name).then((r) => {
        if (!stop) setHistory((was) => (r ? withNewest(r, was) : was || false));
      });
    read();
    const off = whenFocused(read);
    return () => {
      stop = true;
      off();
    };
  }, [ws, name, stamp]);
  const go = () => {
    if (!history || !history.next || paging.reading) return;
    const before = history.next;
    setPaging({ reading: true, failed: false });
    void readCommits(ws, name, before).then((page) => {
      setPaging({ reading: false, failed: !page || !!page.offline });
      // (Only onto the history it was read from: a newer read since starts from the newest page again.)
      if (page && !page.offline) setHistory((was) => (was && was.next === before ? withOlder(was, page) : was));
    });
  };
  return { history, older: { ...paging, go } satisfies Older };
}

/** A commit's message as its line shows it: the first line. */
const firstLine = (message: string) => message.split("\n", 1)[0].trim();

/**
 * An app: its state, name, address (open, copy), "Work on it" (`work`: its bot's chat with words typed in,
 * when there's one to ask) and Deploy (the newest changeset); its history, newest first, one line per
 * changeset (short id, message, author, when, files added, changed and deleted), the one its site serves
 * marked Live and any other deployable from its line ("Deploy this one", shown as the line is pointed at),
 * older ones a page at a time; while Ingot can't be reached, one quiet line instead;
 * and its newest deploy's log, folded.
 */
export function HostedAppView({
  ws,
  answer,
  app,
  history,
  older,
  work,
  onChanged,
}: {
  ws: string;
  answer: Pick<HostedAppsAnswer, "enabled" | "why">;
  app: HostedApp;
  /** null: being read; false: it couldn't be. */
  history: AppCommitsAnswer | null | false;
  older?: Older;
  work?: { name: string; go: () => void } | null;
  onChanged: (app: HostedApp) => void;
}) {
  const { busy, error, run } = useDeploy(onChanged);
  const url = urlOf(app);
  const online = history && !history.offline ? history : null;
  // What its site serves, as the list read last says (it's read again while a deploy runs), else as the history does.
  const serving = app.serving ?? online?.commits.find((c) => c.serving)?.id ?? null;
  // What a deploy waiting or running builds (the newest, when it doesn't say).
  const going = deploying(app) ? (app.live?.at ?? online?.head ?? app.head) : null;
  /** The end of a changeset's line: Live (its site serves it), Deploying, else "Deploy this one". */
  const end = (c: AppCommit) => {
    if (c.id === serving)
      return (
        <span data-live className="flex shrink-0 items-center gap-1 rounded-full bg-[#EAF7EF] px-2 py-0.5 text-[11px] font-medium leading-4 text-[#1E7A4C]">
          <span className="size-1.5 rounded-full bg-[#2BB673]" />
          Live
        </span>
      );
    if (c.id === going)
      return (
        <span data-going className="flex shrink-0 items-center gap-1 rounded-full bg-[#F2F2F0] px-2 py-0.5 text-[11px] font-medium leading-4 text-[#3A3A38]">
          <span className={`size-1.5 rounded-full ${PULSE}`} />
          Deploying
        </span>
      );
    return (
      // Shown as its line is pointed at or reached with the keyboard, so the history reads as a list.
      <span className="flex shrink-0 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
        <DeployButton label="Deploy this one" why={whyNot(answer, app, c.id)} busy={busy(c.id, app.name)} onClick={() => void run(c.id, app.name, { ws, action: "deploy", at: c.id })} />
      </span>
    );
  };
  return (
    <div data-hosted-tab={app.name} className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#F0F0EE] px-4">
        <StateDot app={app} />
        <span title={app.name} className="min-w-0 shrink truncate text-[13px] font-semibold leading-4 text-ink">
          {app.name}
        </span>
        {url ? (
          <>
            <UrlLink url={url} />
            <CopyLink url={url} />
          </>
        ) : (
          <span className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">{noAddress(app)}</span>
        )}
        <span className="flex-1" />
        {work && (
          <button
            onClick={work.go}
            data-tip={`Opens ${work.name}'s chat with this typed, not sent`}
            className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F6F6F4]"
          >
            Work on it
          </button>
        )}
        <DeployButton primary why={whyNot(answer, app)} busy={busy("newest", app.name)} onClick={() => void run("newest", app.name, { ws, action: "deploy" })} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-3">
        {(app.live?.state === "failed" || error) && (
          <div className="flex flex-col gap-1">
            {app.live?.state === "failed" && (
              <span className={PROBLEM} title={app.live.error ?? undefined}>
                The last deploy failed{app.live.error ? `: ${app.live.error}` : "."}
              </span>
            )}
            {error && (
              <span className={PROBLEM} title={error.text}>
                {error.text}
              </span>
            )}
          </div>
        )}
        <div data-history className="flex flex-col">
          <span className="pb-1 text-[12px] font-semibold leading-4 text-[#6B6B6B]">History</span>
          {history === null ? (
            <span className={QUIET}>Reading it…</span>
          ) : history === false ? (
            <span className={QUIET}>Couldn&apos;t read the history just now.</span>
          ) : history.offline ? (
            <span data-offline className={QUIET}>
              Ingot isn&apos;t answering just now, so the history isn&apos;t here.
            </span>
          ) : !history.commits.length ? (
            <span className={QUIET}>No commits yet.</span>
          ) : (
            <>
              <div className="-mx-2 flex flex-col">
                {history.commits.map((c) => (
                  <CommitLine key={c.id} commit={c} serving={c.id === serving} end={end(c)} />
                ))}
              </div>
              {history.next && older && (
                <button
                  data-older
                  onClick={older.go}
                  disabled={older.reading}
                  className="-mx-2 mt-0.5 h-7 self-start rounded-lg px-2 text-[12px] leading-4 text-[#6B6B6B] hover:bg-[#F6F6F4] hover:text-ink disabled:text-[#9A9A98] disabled:hover:bg-transparent"
                >
                  {older.reading ? "Reading…" : older.failed ? "Couldn't read older ones. Try again" : "Show older"}
                </button>
              )}
            </>
          )}
        </div>
        {/* One log per deploy: a deploy that ends keeps its log open where it was. */}
        {app.live && <DeployLog key={app.live.id} ws={ws} name={app.name} live={app.live} />}
      </div>
    </div>
  );
}

/**
 * One changeset: its short id (all of it in the tooltip), its message's first line (all of it in the
 * tooltip), who and when, how many files it added, changed and deleted, and how its line ends (`end`).
 */
function CommitLine({ commit: c, serving, end }: { commit: AppCommit; serving: boolean; end: ReactNode }) {
  const message = firstLine(c.message);
  return (
    <div data-commit={c.id} data-serving={serving || undefined} className="group flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-[#F6F6F4]">
      <span title={c.id} className="w-[52px] shrink-0 font-mono text-[11.5px] leading-4 text-[#6B6B6B]">
        {short(c.id)}
      </span>
      <span title={c.message} className={`min-w-0 flex-1 truncate text-[12.5px] leading-4 ${message ? "text-ink" : "text-[#9A9A98]"}`}>
        {message || "No message"}
      </span>
      <span title={c.author} className="max-w-[110px] shrink-0 truncate text-[12px] leading-4 text-[#6B6B6B]">
        {c.author}
      </span>
      <span title={new Date(c.at).toLocaleString()} className="w-8 shrink-0 text-right text-[12px] leading-4 text-[#9A9A98]">
        {ago(c.at)}
      </span>
      <Changes changes={c.changes} />
      {end}
    </div>
  );
}

/** Files added, changed and deleted, as +2 ~1 -1 (the ones with none left out), in words in the tooltip. */
function Changes({ changes }: { changes?: AppCommit["changes"] | null }) {
  const { added = 0, modified = 0, deleted = 0 } = changes ?? {};
  const parts = [
    { n: added, mark: "+", word: "added", look: "text-[#1E7A4C]" },
    { n: modified, mark: "~", word: "changed", look: "text-[#6B6B6B]" },
    { n: deleted, mark: "-", word: "deleted", look: "text-[#B42318]" },
  ].filter((p) => p.n > 0);
  if (!parts.length) return null;
  const files = added + modified + deleted;
  const tip = `${files} ${files === 1 ? "file" : "files"}: ${parts.map((p) => `${p.n} ${p.word}`).join(", ")}`;
  return (
    <span data-changes title={tip} className="flex shrink-0 gap-1 font-mono text-[11px] leading-4">
      {parts.map((p) => (
        <span key={p.mark} className={p.look}>
          {p.mark}
          {p.n}
        </span>
      ))}
    </span>
  );
}

/**
 * The newest deploy's log, folded. Opened, it's read from the start, then on from where it got to
 * (`next`): at once while there's more, every few seconds while the deploy waits or runs. A read that
 * fails is tried again then too (a few times in a row at most), and says so under what was read.
 */
function DeployLog({ ws, name, live }: { ws: string; name: string; live: NonNullable<HostedApp["live"]> }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<{ text: string; state: DeployState | null; failed: boolean } | null>(null);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!open) return;
    let stop = false;
    let after: string | number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let state: DeployState | null = live.state;
    let misses = 0;
    const read = async () => {
      const first = after === null;
      const r = await readLog(ws, name, after);
      if (stop) return;
      if (!r) {
        setLog((l) => ({ text: first ? "" : (l?.text ?? ""), state: l?.state ?? null, failed: true }));
        if (++misses < 10 && (state === "queued" || state === "running")) timer = setTimeout(read, POLL_MS);
        return;
      }
      misses = 0;
      state = r.state;
      after = r.next ?? after;
      setLog((l) => ({ text: (first ? "" : (l?.text ?? "")) + (r.log ?? ""), state: r.state, failed: false }));
      if (r.more || r.state === "queued" || r.state === "running") timer = setTimeout(read, r.more ? 250 : POLL_MS);
    };
    void read();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // The deploy's state as it opened is where reading starts; the reads say it from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ws, name]);
  // The newest line stays in sight as more comes.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log?.text]);
  const state = (open && log?.state) || live.state;
  const facts = [live.at ? short(live.at) : null, state ? STATES[state]?.word : null, live.when ? ago(live.when) : null].filter(Boolean).join(" · ");
  return (
    <div data-deploy-log className="flex flex-col gap-1.5">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="-mx-2 flex h-8 items-center gap-2 rounded-lg px-2 text-left hover:bg-[#F6F6F4]">
        <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 text-[#6B6B6B] transition-transform ${open ? "rotate-90" : ""}`}>
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="shrink-0 text-[12px] font-semibold leading-4 text-[#6B6B6B]">Deploy log</span>
        <span className="min-w-0 truncate text-[12px] leading-4 text-[#9A9A98]">{facts}</span>
      </button>
      {open && (
        <pre ref={box} className="max-h-[320px] min-h-[64px] overflow-auto whitespace-pre-wrap break-all rounded-xl bg-[#F6F6F4] px-3 py-2.5 font-mono text-[11px] leading-[16px] text-[#3A3A38]">
          {log?.text || (!log ? "Reading it…" : log.failed ? "Couldn't read the log." : "Nothing logged yet.")}
        </pre>
      )}
      {open && log?.text && log.failed && <span className={QUIET}>Couldn&apos;t read more of the log.</span>}
    </div>
  );
}
