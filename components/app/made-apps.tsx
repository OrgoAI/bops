"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { AppState, MadeApp, Message } from "@/lib/types";
import { ago, post, useNow } from "./ui";

/*
 * Apps the bots make (lib/server/made-apps.ts), in Bops' right panel: an app's tab (built live, then
 * used, and changed by talking to its bot in the chat beside it), every app as a tile (Apps), and the
 * line a build leaves in the chat. Follows the Paper designs (Bops → Apps).
 */

/** Open an app in the right panel (bops-app.tsx); null where there's no panel. */
export const OpenMadeApp = createContext<((appId: string) => void) | null>(null);

export function AppsIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.3" stroke={color} strokeWidth="1.3" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.3" stroke={color} strokeWidth="1.3" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.3" stroke={color} strokeWidth="1.3" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="2.25" stroke={color} strokeWidth="1.3" />
    </svg>
  );
}

/** An app's mark: its first letter on a color of its own (from its id, so it never changes). */
const MARKS = [
  { bg: "#E8FF3A", fg: "#0A0A0A", ring: true },
  { bg: "#0A0A0A", fg: "#E8FF3A" },
  { bg: "#8FB3FF", fg: "#0A0A0A" },
  { bg: "#9EDBB0", fg: "#0A0A0A" },
  { bg: "#F2C6A8", fg: "#0A0A0A" },
  { bg: "#C9B8F0", fg: "#0A0A0A" },
];
export function AppMark({ app, size = 20 }: { app: Pick<MadeApp, "id" | "title">; size?: number }) {
  const m = MARKS[[...app.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % MARKS.length];
  return (
    <span
      className="flex shrink-0 items-center justify-center font-semibold"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), background: m.bg, color: m.fg, fontSize: Math.round(size * 0.5), boxShadow: m.ring ? "0 0 0 1px #0A0A0A" : undefined }}
    >
      {app.title.trim().charAt(0).toUpperCase() || "A"}
    </span>
  );
}

const elapsed = (since: number) => {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The frame an app runs in, and its `window.bops`: each call comes up by message and goes on to the
 * bridge route; only messages from this frame count. A problem it hits comes up too (onProblem). A call
 * the user hasn't allowed yet is asked about (onNeeds) and made again if they say yes; a tile asks nobody.
 */
function AppFrame({
  app,
  version,
  onProblem,
  onNeeds,
  className,
}: {
  app: MadeApp;
  version: number;
  onProblem?: (problem: string) => void;
  onNeeds?: (what: string, prompt: string) => Promise<boolean>;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const problem = useRef(onProblem);
  const needs = useRef(onNeeds);
  useEffect(() => {
    problem.current = onProblem;
    needs.current = onNeeds;
  }, [onProblem, onNeeds]);
  useEffect(() => {
    const on = async (e: MessageEvent) => {
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as { bops?: number; id?: number; method?: string; args?: unknown; event?: string; message?: string };
      if (!m || m.bops !== 1) return;
      if (m.event === "error") return problem.current?.(m.message ?? "Something went wrong.");
      if (m.event || typeof m.id !== "number") return;
      const call = () =>
        fetch(`/api/made-apps/${encodeURIComponent(app.id)}/bridge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: m.method, args: m.args }),
        })
          .then((r) => r.json())
          .catch((err: Error) => ({ error: err.message })) as Promise<{ result?: unknown; error?: string; needs?: string }>;
      let answer = await call();
      if (answer.needs) {
        const prompt = String((m.args as { prompt?: unknown } | undefined)?.prompt ?? "");
        const yes = needs.current ? await needs.current(answer.needs, prompt) : false;
        answer = yes ? await call() : { error: needs.current ? "Not allowed: you said not now." : "Open the app to allow it." };
      }
      frame.contentWindow?.postMessage({ bops: 1, id: m.id, result: answer.result, error: answer.error }, "*");
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [app.id]);
  return <iframe ref={ref} src={`/api/made-apps/${encodeURIComponent(app.id)}/view?v=${version}`} sandbox="allow-scripts" title={app.title} className={className ?? "min-h-0 w-full flex-1 border-0 bg-white"} />;
}

/** What a build is writing (or the code now), read again every so often while it builds. */
function useCode(appId: string, building: boolean) {
  const [code, setCode] = useState<{ code: string | null; draft: string | null }>({ code: null, draft: null });
  useEffect(() => {
    let stop = false;
    const read = async () => {
      const r = (await fetch(`/api/made-apps/${encodeURIComponent(appId)}`)
        .then((x) => x.json())
        .catch(() => null)) as { code: string | null; draft: string | null } | null;
      if (!stop && r) setCode(r);
    };
    void read();
    if (!building) return () => void (stop = true);
    const t = setInterval(read, 700);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [appId, building]);
  return code;
}

/** An app's tab: built live, then used; History and Code beside it. Changes are asked for in the chat. */
export function MadeAppTab({ state, appId }: { state: AppState; appId: string }) {
  const app = state.madeApps?.find((a) => a.id === appId);
  const [view, setView] = useState<"app" | "code" | "history">("app");
  const [problem, setProblem] = useState<{ version: number; text: string } | null>(null);
  // A question the app wants to ask its bot, waiting for the user to allow it (one at a time; more wait their turn).
  const [asking, setAsking] = useState<{ prompt: string; answer: (yes: boolean) => void } | null>(null);
  const [menu, setMenu] = useState<"open" | "delete" | null>(null);
  useNow(1000);
  if (!app) return <div className="flex flex-1 items-center justify-center text-[13px] text-[#6B6B6B]">This app was deleted.</div>;
  const maker = state.bots.find((b) => b.id === app.botId);
  const building = !!app.building;
  const shown = problem?.version === app.version ? problem.text : null;
  const botName = maker?.name ?? "its bot";
  const onNeeds = (what: string, prompt: string) =>
    what === "bot"
      ? new Promise<boolean>((done) =>
          setAsking({
            prompt,
            answer: async (yes) => {
              if (yes) await post(`/api/made-apps/${encodeURIComponent(app.id)}`, { action: "allow-bot", on: true });
              setAsking(null);
              done(yes);
            },
          }),
        )
      : Promise.resolve(false);
  const tab = (v: typeof view, label: string) => (
    <button
      onClick={() => setView(view === v ? "app" : v)}
      className={`rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 ${view === v ? "bg-ink text-white" : "text-[#3A3A38] hover:bg-black/[0.05]"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[#F0F0EE] px-4">
        <AppMark app={app} />
        <span className="truncate text-[13px] font-semibold leading-4 text-ink">{app.title}</span>
        <span className="shrink-0 font-mono text-[11px] leading-[14px] text-[#6B6B6B]">
          {building ? `building · ${elapsed(app.building!.since)}` : `v${app.version}${maker ? ` · by ${maker.name}` : ""}`}
        </span>
        <span className="flex-1" />
        <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-[#F2F2F0] px-2 py-1 text-[11px] font-medium leading-[14px] text-[#3A3A38] min-[520px]:flex">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1.5" y="2" width="9" height="6.5" rx="1" stroke="#3A3A38" strokeWidth="1.2" />
            <path d="M4 10.5h4" stroke="#3A3A38" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          Runs in Bops
        </span>
        {app.versions.length > 1 && tab("history", "History")}
        {tab("code", "Code")}
        <div className="relative shrink-0">
          <button onClick={() => setMenu(menu ? null : "open")} aria-label="More" title="More" className="flex size-7 items-center justify-center rounded-full text-[#3A3A38] hover:bg-black/[0.05]">
            <svg width="14" height="14" viewBox="0 0 14 14">
              <circle cx="3" cy="7" r="1.3" fill="currentColor" />
              <circle cx="7" cy="7" r="1.3" fill="currentColor" />
              <circle cx="11" cy="7" r="1.3" fill="currentColor" />
            </svg>
          </button>
          {menu && (
            <div className="absolute right-0 top-9 z-20 flex w-[248px] flex-col rounded-2xl bg-white p-1.5 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-8px_#00000033]">
              {menu === "delete" ? (
                <div className="flex flex-col gap-2 p-2">
                  <span className="text-[13px] leading-[18px] text-ink">Delete {app.title} and everything it keeps? This can&apos;t be undone.</span>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => void post(`/api/made-apps/${encodeURIComponent(app.id)}`, { action: "delete" })}
                      className="rounded-full bg-[#B42318] px-3 py-1.5 text-[12px] font-semibold leading-4 text-white"
                    >
                      Delete
                    </button>
                    <button onClick={() => setMenu(null)} className="rounded-full px-3 py-1.5 text-[12px] font-medium leading-4 text-ink hover:bg-black/[0.05]">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {app.allowed?.bot && (
                    <button
                      onClick={async () => {
                        await post(`/api/made-apps/${encodeURIComponent(app.id)}`, { action: "allow-bot", on: false });
                        setMenu(null);
                      }}
                      className="rounded-xl px-2.5 py-2 text-left text-[13px] leading-4 text-ink hover:bg-[#F6F6F4]"
                    >
                      Stop it asking {botName}
                    </button>
                  )}
                  <button onClick={() => setMenu("delete")} className="rounded-xl px-2.5 py-2 text-left text-[13px] leading-4 text-[#B42318] hover:bg-[#F6F6F4]">
                    Delete app
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {view === "code" ? (
        <CodeView app={app} />
      ) : view === "history" ? (
        <History app={app} onDone={() => setView("app")} />
      ) : app.version ? (
        <AppFrame key={`${app.id}:${app.version}`} app={app} version={app.version} onProblem={(text) => setProblem({ version: app.version, text })} onNeeds={onNeeds} />
      ) : building ? (
        <FirstBuild app={app} maker={maker?.name ?? "Your bot"} />
      ) : (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] leading-5 text-[#6B6B6B]">{app.error ? `It couldn't be built: ${app.error}` : "Nothing here yet."}</div>
      )}
      {shown && !building && view === "app" && <Problem app={app} text={shown} maker={maker?.name ?? "the bot"} onAsked={() => setProblem(null)} />}
      {app.error && app.version > 0 && !building && view === "app" && (
        <div className="mx-4 mb-3 shrink-0 rounded-xl bg-[#FFF4F2] px-3 py-2 text-[12px] leading-4 text-[#B42318]">The last change didn&apos;t work: {app.error}</div>
      )}
      {asking && <AllowSheet app={app} botName={botName} prompt={asking.prompt} onAnswer={asking.answer} />}
      {building && <BuildStrip app={app} />}
    </div>
  );
}

/** The app wants to ask its bot for the first time (Paper 3b): what that means, and the question. */
function AllowSheet({ app, botName, prompt, onAnswer }: { app: MadeApp; botName: string; prompt: string; onAnswer: (yes: boolean) => void }) {
  return (
    <div className="flex shrink-0 flex-col gap-3.5 border-t-[1.5px] border-ink bg-white p-[18px]">
      <div className="flex flex-col gap-1">
        <span className="text-[17px] font-bold leading-[22px] tracking-[-0.015em] text-ink">
          {app.title} wants to ask {botName}
        </span>
        <span className="text-[13px] leading-[18px] text-[#6B6B6B]">
          {botName} looks things up in the apps you connected, Knowledge and the web to answer it. Anything it would send or change still asks you first.
        </span>
      </div>
      {prompt && <div className="line-clamp-3 rounded-[10px] bg-[#F6F6F4] px-3 py-2.5 font-mono text-[11px] leading-[15px] text-ink">{prompt}</div>}
      <div className="flex gap-2">
        <button onClick={() => onAnswer(true)} className="flex-1 rounded-full bg-ink py-2.5 text-[13px] font-semibold leading-4 text-white">
          Allow
        </button>
        <button onClick={() => onAnswer(false)} className="flex-1 rounded-full py-2.5 text-[13px] font-semibold leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF]">
          Not now
        </button>
      </div>
    </div>
  );
}

/** The first version being written: what it's for, and its code as it comes. */
function FirstBuild({ app, maker }: { app: MadeApp; maker: string }) {
  const { draft } = useCode(app.id, true);
  const tail = (draft ?? "").split("\n").slice(-18).join("\n");
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-5 px-9">
      <div className="flex flex-col gap-1.5">
        <span className="text-[22px] font-bold leading-7 tracking-[-0.025em] text-ink">{maker} is building it</span>
        <span className="max-w-[420px] text-[13px] leading-[18px] text-[#6B6B6B]">It opens here when it&apos;s ready, usually in a minute or two. Keep chatting: tell {maker} what to change and it&apos;s done next.</span>
      </div>
      <pre className="max-h-[280px] min-h-[120px] overflow-hidden whitespace-pre-wrap rounded-2xl bg-[#F6F6F4] px-4 py-3 font-mono text-[11px] leading-[16px] text-[#6B6B6B] [mask-image:linear-gradient(to_bottom,transparent,black_30%)]">
        {tail || "Planning it…"}
      </pre>
    </div>
  );
}

/** Building: what's being done, and how far along. Shown over the app (a change) or under the first build. */
function BuildStrip({ app }: { app: MadeApp }) {
  const lines = Math.max(1, Math.round((app.building?.chars ?? 0) / 38));
  return (
    <div className="mx-4 mb-4 flex shrink-0 items-center gap-3 rounded-[14px] bg-ink py-2.5 pl-3.5 pr-3">
      <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-highlighter shadow-[0_0_0_4px_rgba(232,255,58,0.25)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium leading-[17px] text-white">{app.version ? "Making the change" : "Writing the app"}: {app.building?.change}</span>
        <span className="font-mono text-[11px] leading-[14px] text-[#9A9A98]">{app.building?.chars ? `${lines} lines written` : "starting"}</span>
      </span>
    </div>
  );
}

function Problem({ app, text, maker, onAsked }: { app: MadeApp; text: string; maker: string; onAsked: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-4 mb-3 flex shrink-0 items-center gap-3 rounded-[14px] bg-[#FDFFE6] py-2 pl-3.5 pr-2 shadow-[0_0_0_1px_#0A0A0A]">
      <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink" title={text}>
        It hit a problem: {text}
      </span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await post(`/api/made-apps/${encodeURIComponent(app.id)}`, { action: "fix", problem: text });
          setBusy(false);
          onAsked();
        }}
        className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12px] font-semibold leading-4 text-white disabled:opacity-50"
      >
        Ask {maker} to fix it
      </button>
    </div>
  );
}

function CodeView({ app }: { app: MadeApp }) {
  const { code, draft } = useCode(app.id, !!app.building);
  const text = (app.building ? draft : code) ?? "";
  return (
    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre bg-[#FAFAF9] px-5 py-4 font-mono text-[11.5px] leading-[17px] text-[#3A3A38]">
      {text || (app.building ? "Starting…" : "")}
    </pre>
  );
}

function History({ app, onDone }: { app: MadeApp; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const back = async (n: number) => {
    const r = await post(`/api/made-apps/${encodeURIComponent(app.id)}`, { action: "back", version: n });
    if (!r.ok) return setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't go back. Try again.");
    onDone();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-5">
      <span className="text-[20px] font-bold leading-6 tracking-[-0.02em] text-ink">History</span>
      <div className="flex flex-col">
        {[...app.versions].reverse().map((v, i) => (
          <div key={v.n} className={`flex items-start gap-3 py-3.5 ${i ? "border-t border-[#F0F0EE]" : ""}`}>
            <span className={`w-8 shrink-0 rounded-[5px] py-0.5 text-center font-mono text-[11px] font-semibold leading-[14px] ${v.n === app.version ? "bg-ink text-highlighter" : "bg-[#F2F2F0] text-[#3A3A38]"}`}>v{v.n}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[14px] font-medium leading-[18px] text-ink">{v.note}</span>
              <span className="text-[12px] leading-4 text-[#6B6B6B]">
                {ago(v.at)}
                {v.n === app.version ? " · live now" : ""}
              </span>
            </span>
            {v.n !== app.version && (
              <button onClick={() => void back(v.n)} className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold leading-4 text-ink hover:bg-black/[0.05]">
                Go back
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
      <div className="flex gap-2.5 rounded-[10px] bg-[#F6F6F4] p-3 text-[12px] leading-[17px] text-[#3A3A38]">Going back changes the app, not what it keeps.</div>
    </div>
  );
}

/** Every app in a workspace, as tiles that show each one live (Paper 2B). */
export function MadeAppsHome({ state, ws }: { state: AppState; ws: string }) {
  const open = useContext(OpenMadeApp);
  const apps = (state.madeApps ?? []).filter((a) => a.ws === ws).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-8 py-8">
      <div className="flex flex-col gap-1">
        <span className="text-[26px] font-bold leading-8 tracking-[-0.025em] text-ink">Apps</span>
        <span className="text-[13.5px] leading-[18px] text-[#6B6B6B]">
          {apps.length ? `${apps.length} made by your bots · they keep what you put in them` : "Tools your bots make for you. Ask any bot: “make me an app that…”"}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
        {apps.map((a) => {
          const maker = state.bots.find((b) => b.id === a.botId);
          return (
            <button key={a.id} onClick={() => open?.(a.id)} className="group flex flex-col gap-2.5 text-left">
              <span className="relative block h-[172px] overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_#ECECEA] group-hover:shadow-[0_0_0_1px_#0A0A0A]">
                {a.version ? (
                  // The app itself, at half size, and not to be clicked here (the tile opens it).
                  <span className="pointer-events-none absolute left-0 top-0 block h-[344px] w-[200%] origin-top-left scale-50" inert>
                    <AppFrame key={`${a.id}:${a.version}`} app={a} version={a.version} className="h-full w-full border-0 bg-white" />
                  </span>
                ) : (
                  <span className="flex h-full items-center justify-center gap-2 text-[12px] text-[#6B6B6B]">
                    <span className="size-2 animate-pulse rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" />
                    {a.building ? "Building…" : "Not built"}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2 pl-0.5">
                <AppMark app={a} size={18} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] font-medium leading-[18px] text-ink">{a.title}</span>
                  <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">
                    {maker?.name ?? "A bot"} · {a.building ? "building now" : `updated ${ago(a.updatedAt)}`}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The line a build leaves in the chat: building (with Show), made or changed (Open, Undo), or why it couldn't. */
export function MadeAppLine({ m, state }: { m: Message; state: AppState }) {
  const open = useContext(OpenMadeApp);
  const [busy, setBusy] = useState(false);
  useNow(1000);
  const app = state.madeApps?.find((a) => a.id === m.madeApp!.appId);
  const v = m.madeApp!.version;
  const building = !!app?.building && v > (app.versions.at(-1)?.n ?? 0);
  const failed = !building && /^Couldn't /.test(m.text);
  const latest = app && !building && !failed && app.version === v;
  const undone = app && !building && !failed && app.versions.some((x) => x.n > v && x.note === `Back to v${v - 1}`);
  const button = "shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium leading-4 text-ink hover:bg-black/[0.05] disabled:opacity-40";
  return (
    <div className="flex w-full max-w-[400px] items-center gap-2 self-center rounded-[14px] bg-[#F7F7F6] py-2 pl-3 pr-1.5 text-[12px] leading-4">
      {building ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" /> : app ? <AppMark app={app} size={14} /> : null}
      <span className={`min-w-0 flex-1 truncate ${failed ? "text-[#B42318]" : undone ? "text-[#9A9A98] line-through" : "text-[#3A3A3A]"}`} title={m.text}>
        {building ? `${m.text} · ${elapsed(app!.building!.since)}` : m.text}
      </span>
      {app && open && (
        <button onClick={() => open(app.id)} className={button}>
          {building ? "Show" : "Open"}
        </button>
      )}
      {latest && v > 1 && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await post(`/api/made-apps/${encodeURIComponent(app.id)}`, { action: "back", version: v - 1 });
            setBusy(false);
          }}
          className={button}
        >
          Undo
        </button>
      )}
      {undone && <span className="shrink-0 px-2 py-0.5 font-medium text-[#9A9A98]">Undone</span>}
    </div>
  );
}

/** Over the chat's composer while an app is open beside it: what the user says is about it (Message.lookingAt). */
export function LookingAt({ app, onClear }: { app: MadeApp; onClear: () => void }) {
  return (
    <div className="flex items-center gap-1.5 self-start rounded-full bg-[#F6F6F4] py-1 pl-1.5 pr-1">
      <AppMark app={app} size={16} />
      <span className="text-[12px] leading-4 text-[#3A3A38]">
        Looking at <span className="font-semibold text-ink">{app.title}</span>
      </span>
      <button onClick={onClear} aria-label="Talk about something else" title="Talk about something else" className="flex size-5 items-center justify-center rounded-full text-[#9A9A98] hover:bg-black/[0.06] hover:text-ink">
        <svg width="9" height="9" viewBox="0 0 12 12">
          <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
