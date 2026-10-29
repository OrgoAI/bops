"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppDeploy, AppEnv, HostedApp, HostedAppsAnswer, HostedSite, LocalAnswer, LocalSite, StagingSite } from "@/lib/hosted-apps";
import { readSettings, Variables } from "./app-settings";
import { act, deploying, isSending, OpenHostedApp, PROBLEM, PULSE, short, UrlLink, useSending } from "./hosted-apps";
import { useDismiss } from "./new-thread";
import { OpenLink } from "./panel-tabs";
import { InlineConfirm, undash } from "./side-group";
import { post } from "./ui";

/*
 * An app's three environments, all on its bot's own computer (lib/hosted-apps.ts AppEnv), in the words a person
 * building with a bot reads them (Lovable's): Local, the live preview while the bot works (its working folder
 * run as a dev server there, not public: Open preview puts it beside the bot's chat); Preview (Staging: a second
 * deploy project of each site, its shareable https link, where Deploy goes); and Published (Prod: its own
 * address and real domains, which Publish fills with what the preview serves). One line each: its state in a
 * word (Running, Starting, Deploying, Failed, Stopped, Not deployed yet), where it is, the changeset it serves,
 * and its one action: Start, Open preview and Stop (Local), Deploy (Preview), Publish, with Roll back and Domain
 * in Published's menu (Domain is Cloudflare first). On the Apps page under each app; on its tab, a line pressed
 * picks what the sections under it are about. Asks are inline: no dialogs.
 */

/** Open an app's tab with something already open there (Domain: Prod picked, Add a domain open), read once by the tab. */
const opening = new Map<string, "domain">();
export const openIntent = (name: string) => {
  const x = opening.get(name);
  opening.delete(name);
  return x;
};

/** What each is called where people read it: Staging is the app's Preview, Prod what's Published. */
export const ENV_NAMES: Record<AppEnv, string> = { local: "Local", staging: "Preview", prod: "Published" };

/** A state in a word, its dot, and more in its tooltip. */
type EnvState = { word: string; dot: string; tip?: string };
const DOTS = { on: "bg-[#2BB673]", bad: "bg-[#B42318]", off: "shadow-[inset_0_0_0_1.5px_#C9C9C6]", grey: "bg-[#9A9A98]" };

/** Staging's or Prod's state from what Orgo says of its newest deploy and what it serves. */
export function deployState(x: { live: HostedApp["live"]; serving: string | null } | undefined | null): EnvState {
  const s = x?.live?.state;
  if (s === "queued" || s === "running") return { word: "Deploying", dot: PULSE };
  if (s === "failed") return { word: "Failed", dot: DOTS.bad, tip: x?.live?.error ? `Its last deploy failed: ${x.live.error}` : "Its last deploy failed." };
  if (s === "succeeded" || x?.serving) return { word: "Running", dot: DOTS.on };
  if (s === "cancelled" || s === "superseded") return { word: "Stopped", dot: DOTS.grey };
  return { word: "Not deployed yet", dot: DOTS.off };
}

/** Local's state, from its computer (null: not read yet; `asleep`: its computer sleeps). */
export function localState(x: LocalSite | undefined, read: LocalAnswer | null): EnvState {
  if (!read) return { word: "Reading…", dot: DOTS.off };
  if (read.asleep) return { word: "Stopped", dot: DOTS.off, tip: "Its computer is asleep, so nothing runs there. Start wakes it." };
  if (read.why) return { word: "Not known", dot: DOTS.off, tip: read.why };
  if (!x || x.state === "stopped") return { word: "Stopped", dot: DOTS.off };
  if (x.state === "starting") return { word: "Starting", dot: PULSE, tip: "Its port doesn't answer yet. A first start installs what it needs." };
  if (x.state === "failed") return { word: "Failed", dot: DOTS.bad, tip: x.error ? `It stopped: ${x.error}` : "It stopped." };
  return { word: "Running", dot: DOTS.on };
}

/** Of an app with more sites, the state of all of them in one word: any deploying, any failed, else all running. */
function allSites(xs: { live: HostedApp["live"]; serving: string | null }[]): EnvState {
  const each = xs.map(deployState);
  const word = each.find((s) => s.word === "Deploying") ?? each.find((s) => s.word === "Failed") ?? (each.every((s) => s.word === "Running") ? each[0] : each.find((s) => s.word !== "Running") ?? each[0]);
  const on = each.filter((s) => s.word === "Running").length;
  return word.word === "Running" || on === 0 ? word : { ...word, tip: `${on} of ${xs.length} sites running` };
}

/** An app's Local, read from its computer: again when the window comes back, every few seconds while one starts, and as an act answers it. */
export function useLocal(ws: string, name: string, on = true) {
  const [read, setRead] = useState<{ key: string; answer: LocalAnswer | null }>({ key: "", answer: null });
  const key = `${ws}\n${name}`;
  const answer = read.key === key ? read.answer : (kept.get(key) ?? null);
  const starting = !!answer && Object.values(answer.sites).some((x) => x.state === "starting");
  useEffect(() => {
    if (!on) return;
    let stop = false;
    const get = async () => {
      const r = await fetch(`/api/hosted-apps/${encodeURIComponent(name)}/local?ws=${encodeURIComponent(ws)}`, { cache: "no-store" }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as LocalAnswer | null) : null;
      if (stop || !j?.sites) return;
      kept.set(key, j);
      setRead({ key, answer: j });
    };
    void get();
    const t = starting ? setInterval(get, 3000) : undefined;
    window.addEventListener("focus", get);
    return () => {
      stop = true;
      if (t) clearInterval(t);
      window.removeEventListener("focus", get);
    };
  }, [ws, name, key, on, starting]);
  const put = (a: LocalAnswer) => {
    kept.set(key, a);
    setRead({ key, answer: a });
  };
  return { answer, put };
}
const kept = new Map<string, LocalAnswer>();

/** A site's Local started, stopped or opened on its computer's screen: the app's Locals as they are then, or why not. */
export async function localAct(ws: string, name: string, body: { action: "start" | "stop" | "open"; site?: string; command?: string }): Promise<{ ok?: LocalAnswer; error?: string }> {
  const r = await post(`/api/hosted-apps/${encodeURIComponent(name)}/local`, { ws, ...body }).catch(() => null);
  const j = ((await r?.json().catch(() => null)) ?? {}) as LocalAnswer & { error?: string };
  return r?.ok && j.sites ? { ok: j } : { error: undash(j.error || "Couldn't reach its computer. Try again.") };
}

const BTN =
  "whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-white disabled:text-[#9A9A98] disabled:shadow-[0_0_0_1px_#ECECEA]";
const DARK = "whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[12px] font-semibold leading-4 text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]";

/** A button greyed with why in its tooltip (on what holds it: a disabled button gets no pointer events in some browsers). */
function Btn({ why, busy, label, doing, onClick, dark, tag }: { why?: string; busy?: boolean; label: string; doing?: string; onClick: () => void; dark?: boolean; tag: string }) {
  return (
    <span data-tip={why} onClick={(e) => e.stopPropagation()} className="flex shrink-0">
      <button data-act={tag} disabled={!!why || busy} onClick={onClick} className={dark ? DARK : BTN}>
        {busy ? (doing ?? `${label}…`) : label}
      </button>
    </span>
  );
}

/**
 * Why Deploy to Staging or Promote to Prod can't be pressed now (undefined: it can). Promote needs Staging to
 * serve something, and to serve something Prod doesn't already.
 */
export function whyNotEnv(answer: Pick<HostedAppsAnswer, "enabled" | "why">, a: HostedApp, env: "staging" | "prod", sites: (HostedSite | HostedApp)[]): string | undefined {
  if (!answer.enabled) return answer.why || "Deploying isn't open here.";
  if (isSending(a.name)) return "A deploy is being sent. Wait for it.";
  const staging = sites.map((x) => x.staging);
  if (env === "staging") {
    if (!a.head) return "Nothing is committed yet.";
    if (staging.some((x) => x && deploying(x))) return "The preview is deploying. Wait for it to finish.";
    return undefined;
  }
  if (a.hosting?.lost) return "Its computer is gone. Deploy a preview to give it a new home.";
  if (sites.some((x) => deploying(x))) return "It's publishing. Wait for it to finish.";
  if (!staging.some((x) => x?.serving)) return "The preview isn't live yet. Deploy a preview first.";
  if (sites.every((x) => !x.staging?.serving || x.staging.serving === x.serving)) return "What's published is the preview already.";
  return undefined;
}

type Line = { env: AppEnv; state: EnvState; where: ReactNode; at: string | null };

/**
 * The three lines of an app (`app`: of one of its sites, as siteView makes it, or the app itself), with their
 * actions. `sites`: every site it's about (one, or all of an app's on the Apps page). `picked`/`onPick`: on its
 * tab, which one the sections under it are about. `onDomain`: Domain in Prod's menu (its tab opens Add a domain).
 */
export function AppEnvs({
  ws,
  answer,
  app,
  site,
  sites,
  local,
  onLocal,
  onChanged,
  picked,
  onPick,
  onDomain,
  compact,
}: {
  ws: string;
  answer: Pick<HostedAppsAnswer, "enabled" | "why">;
  app: HostedApp;
  /** The site it's about, of an app with more (none: the app's own, or all of them on the Apps page). */
  site?: string;
  sites: (HostedSite | HostedApp)[];
  local: LocalAnswer | null;
  onLocal: (a: LocalAnswer) => void;
  onChanged: (app: HostedApp) => void;
  picked?: AppEnv;
  onPick?: (env: AppEnv) => void;
  onDomain?: () => void;
  compact?: boolean;
}) {
  useSending();
  const open = useContext(OpenHostedApp);
  const openLink = useContext(OpenLink);
  const openBot = useContext(OpenBotComputer);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [back, setBack] = useState<{ d: AppDeploy } | "none" | null>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  useDismiss(menu, () => setMenu(false), menuBox);
  const own = site ?? app.name;
  const many = sites.length > 1;
  const loc = local?.sites[own];
  const run = async (key: string, f: () => Promise<{ app?: HostedApp; error?: string; said?: string }>) => {
    setBusy(key);
    setError(null);
    setSaid(null);
    const r = await f();
    setBusy(null);
    if (r.app) onChanged(r.app);
    if (r.error) setError(undash(r.error));
    if (r.said) setSaid(undash(r.said));
  };
  const deploy = () => run("staging", () => act(app.name, { ws, action: "deploy", env: "staging", ...(site ? { site } : {}) }));
  const promote = () => {
    const at = app.staging?.serving;
    return run("promote", () => act(app.name, site && at ? { ws, action: "promote", site, at } : !many && at ? { ws, action: "promote", site: app.name, at } : { ws, action: "promote" }));
  };
  const localDo = async (action: "start" | "stop" | "open") => {
    setBusy(`local:${action}`);
    setError(null);
    setSaid(null);
    const r = await localAct(ws, app.name, { action, ...(site ? { site } : {}) });
    setBusy(null);
    if (r.ok) onLocal(r.ok);
    if (r.error) setError(r.error);
    if (action === "open" && r.ok?.opened) {
      setSaid("Opened on its computer's screen.");
      if (app.hosting?.botId) openBot?.(app.hosting.botId);
    }
  };
  /**
   * Open preview: Local beside the bot's chat. From this Mac over the tailnet, in the panel's own tab (else the
   * browser); otherwise on its computer's screen, which the panel then shows.
   */
  const openPreview = () => {
    if (!loc?.url) return void localDo("open");
    if (openLink) return openLink(loc.url, `${app.name} preview`);
    window.open(loc.url, "_blank", "noopener");
  };
  /** Roll back: Prod's newest deploy that can be put back, asked once more first. */
  const rollbackAsk = async () => {
    setMenu(false);
    setBusy("rollback-read");
    setError(null);
    const r = await readSettings(ws, app.name, site);
    setBusy(null);
    if (!r.ok) return setError(r.no.error);
    const d = r.ok.deploys.find((x) => !x.live && x.canRollback);
    setBack(d ? { d } : "none");
  };
  const rollback = (d: AppDeploy) => run("rollback", () => act(app.name, { ws, action: "rollback", deployment: d.id, ...(site ? { site } : {}) }));
  const prodUrl = app.live?.url ?? app.hosting?.url ?? null;
  // Its computer gone: Staging's and Prod's projects went with it.
  const lost: EnvState | null = app.hosting?.lost ? { word: "Needs a new home", dot: DOTS.off, tip: "Its computer is gone, and its projects with it. Deploy a preview to give it a new home." } : null;
  const stagingOf = (x: { staging?: StagingSite }) => x.staging;
  const lines: Line[] = [
    {
      env: "local",
      state: localState(loc, local),
      where: loc && (loc.state === "running" || loc.state === "starting") ? (
        loc.url ? <UrlLink url={loc.url} /> : <span className="truncate font-mono text-[11.5px] leading-4 text-[#6B6B6B]">{`localhost:${loc.port} on its computer`}</span>
      ) : (
        <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{many && !site ? "Its working folder, on its computer" : "Not public: on its computer"}</span>
      ),
      at: null,
    },
    {
      env: "staging",
      state: lost ?? (many && !site ? allSites(sites.map((x) => stagingOf(x) ?? { live: null, serving: null })) : deployState(app.staging)),
      where: app.staging?.url ? <UrlLink url={app.staging.url} /> : <span className="truncate text-[12px] leading-4 text-[#9A9A98]">{app.staging?.projectId && app.staging.serving ? "No address yet" : "A link to share once deployed"}</span>,
      at: app.staging?.serving ?? null,
    },
    {
      env: "prod",
      state: lost ?? (many && !site ? allSites(sites) : deployState(app)),
      where: prodUrl ? <UrlLink url={prodUrl} /> : <span className="truncate text-[12px] leading-4 text-[#9A9A98]">Not on the web yet</span>,
      at: app.serving,
    },
  ];
  const actions = (env: AppEnv) => {
    if (env === "local") {
      const up = loc && (loc.state === "running" || loc.state === "starting");
      const why = app.hosting?.lost ? "Its computer is gone. Deploy a preview to give it a new home." : local?.why;
      return up ? (
        <>
          <Btn tag="local-open" label="Open preview" doing="Opening…" busy={busy === "local:open"} why={why} onClick={openPreview} />
          <Btn tag="local-stop" label="Stop" doing="Stopping…" busy={busy === "local:stop"} why={why} onClick={() => void localDo("stop")} />
        </>
      ) : (
        <Btn tag="local-start" label="Start" doing="Starting…" busy={busy === "local:start"} why={why} onClick={() => void localDo("start")} />
      );
    }
    if (env === "staging") return <Btn tag="deploy" label="Deploy" doing="Deploying…" busy={busy === "staging"} why={whyNotEnv(answer, app, "staging", sites)} onClick={() => void deploy()} />;
    return (
      <>
        <Btn tag="promote" dark label="Publish" doing="Publishing…" busy={busy === "promote"} why={whyNotEnv(answer, app, "prod", sites)} onClick={() => void promote()} />
        <div ref={menuBox} className="relative flex shrink-0" onClick={(e) => e.stopPropagation()}>
          <button data-prod-menu aria-label="More for Published" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="flex size-6 items-center justify-center rounded-md text-[#6B6B6B] hover:bg-black/[0.05] hover:text-ink">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <circle cx="2.5" cy="6" r="1.1" fill="currentColor" />
              <circle cx="6" cy="6" r="1.1" fill="currentColor" />
              <circle cx="9.5" cy="6" r="1.1" fill="currentColor" />
            </svg>
          </button>
          {menu && (
            <div role="menu" aria-label="Published" className="absolute right-0 top-[calc(100%+4px)] z-20 flex min-w-[180px] flex-col rounded-[12px] bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]">
              <button data-rollback role="menuitem" disabled={!prodUrl && !app.serving} onClick={() => void rollbackAsk()} className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] leading-4 text-ink hover:bg-[#F6F6F4] disabled:text-[#9A9A98]">
                Roll back
              </button>
              <button
                data-domain-menu
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  if (onDomain) return onDomain();
                  opening.set(app.name, "domain");
                  open?.(ws, app.name);
                }}
                className="rounded-lg px-2.5 py-1.5 text-left text-[12.5px] leading-4 text-ink hover:bg-[#F6F6F4]"
              >
                Domain
              </button>
            </div>
          )}
        </div>
      </>
    );
  };
  return (
    <div data-app-envs className={`flex flex-col ${compact ? "" : "gap-0.5"}`}>
      {!compact && <span className="pb-1 text-[12px] font-semibold leading-4 text-[#6B6B6B]">Local, Preview and Published</span>}
      <div className={compact ? "flex flex-col" : "-mx-2 flex flex-col gap-0.5"}>
        {lines.map((l) => {
          const isPicked = picked === l.env;
          return (
            <div
              key={l.env}
              data-app-env={l.env}
              data-app-env-state={l.state.word}
              data-app-env-picked={isPicked || undefined}
              onClick={onPick ? () => onPick(l.env) : undefined}
              className={`relative flex min-w-0 items-center gap-2 rounded-lg ${compact ? "h-7 pl-[26px] pr-2" : "h-8 px-2"} ${onPick ? "cursor-pointer" : ""} ${isPicked ? "bg-[#F2F2F0] shadow-[0_0_0_1px_#E2E2DF]" : onPick ? "hover:bg-[#F6F6F4]" : ""}`}
            >
              <span data-tip={l.state.tip ?? l.state.word} className={`size-1.5 shrink-0 rounded-full ${l.state.dot}`} />
              {onPick ? (
                <button aria-pressed={isPicked} className={`w-[52px] shrink-0 text-left text-[12.5px] leading-4 text-ink ${isPicked ? "font-semibold" : "font-medium"}`}>
                  {ENV_NAMES[l.env]}
                </button>
              ) : (
                <span className="w-[52px] shrink-0 text-[12.5px] font-medium leading-4 text-ink">{ENV_NAMES[l.env]}</span>
              )}
              <span data-tip={l.state.tip} className="w-[96px] shrink-0 truncate text-[12px] leading-4 text-[#6B6B6B]">
                {l.state.word}
              </span>
              <span className="flex min-w-0 flex-1 items-center">{l.where}</span>
              {l.at && (
                <span data-app-env-at title={l.at} className="shrink-0 font-mono text-[11px] leading-[14px] text-[#6B6B6B]">
                  {short(l.at)}
                </span>
              )}
              <span className="flex shrink-0 items-center gap-1">{actions(l.env)}</span>
            </div>
          );
        })}
      </div>
      {back && (
        <div className={compact ? "pl-[26px] pr-2 pt-1" : "pt-1"} onClick={(e) => e.stopPropagation()}>
          {back === "none" ? (
            <span className="flex items-center gap-2 text-[12px] leading-4 text-[#6B6B6B]">
              Nothing published earlier to put back.
              <button onClick={() => setBack(null)} className="text-ink underline">
                Close
              </button>
            </span>
          ) : (
            <InlineConfirm
              text={`Publish ${back.d.at ? short(back.d.at) : "its earlier deploy"} again? No build: it's on its computer already.`}
              action="Roll back"
              doing="Rolling back…"
              busy={busy === "rollback"}
              onConfirm={() => {
                const d = (back as { d: AppDeploy }).d;
                void rollback(d).then(() => setBack(null));
              }}
              onCancel={() => setBack(null)}
            />
          )}
        </div>
      )}
      {error && (
        <span role="alert" className={`${PROBLEM} ${compact ? "pl-[26px]" : ""} whitespace-normal`}>
          {error}
        </span>
      )}
      {said && <span className={`text-[12px] leading-4 text-[#6B6B6B] ${compact ? "pl-[26px]" : ""}`}>{said}</span>}
      {busy === "rollback-read" && <span className={`text-[12px] leading-4 text-[#9A9A98] ${compact ? "pl-[26px]" : ""}`}>Reading its deploys…</span>}
    </div>
  );
}

const HEAD = "pb-1 text-[12px] font-semibold leading-4 text-[#6B6B6B]";
const HINT = "text-[12px] leading-4 text-[#9A9A98]";

/** Open a bot's computer in the panel (bops-app.tsx), its screen showing; null where there's no panel. */
export const OpenBotComputer = createContext<((botId: string) => void) | null>(null);

/**
 * Local, picked on an app's tab (of the picked site): where it runs and how to open it, the command it runs
 * (its own, typed here, kept on its computer; else what its folder says, npm run dev or a plain site's
 * index.html), Start or Restart with it, and its own variables (on top of Staging's, kept on its computer).
 */
export function LocalSection({ ws, app, site, local, onLocal }: { ws: string; app: HostedApp; site?: string; local: LocalAnswer | null; onLocal: (a: LocalAnswer) => void }) {
  const own = site ?? app.name;
  const x = local?.sites[own];
  const openBot = useContext(OpenBotComputer);
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const command = typed ?? x?.command ?? "";
  const up = x && (x.state === "running" || x.state === "starting");
  const start = async () => {
    setBusy("start");
    setError(null);
    const r = await localAct(ws, app.name, { action: "start", ...(site ? { site } : {}), ...(command.trim() && command.trim() !== x?.command ? { command: command.trim() } : {}) });
    setBusy(null);
    if (r.ok) {
      onLocal(r.ok);
      setTyped(null);
    } else setError(r.error ?? null);
  };
  const open = async () => {
    setBusy("open");
    setError(null);
    const r = await localAct(ws, app.name, { action: "open", ...(site ? { site } : {}) });
    setBusy(null);
    if (r.ok) {
      onLocal(r.ok);
      if (app.hosting?.botId) openBot?.(app.hosting.botId);
    } else setError(r.error ?? null);
  };
  const s = localState(x, local);
  return (
    <div data-local-section className="flex flex-col gap-3">
      <div className="flex flex-col">
        <span className={HEAD}>Local</span>
        <span className={HINT}>The live preview while its bot works: its working folder run as a dev server on its computer. It isn&apos;t on the web: it opens beside the bot&apos;s chat, on its computer&apos;s screen, or from this Mac when Bops reaches its computer.</span>
        <div className="flex min-h-8 items-center gap-2">
          <span className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
          <span data-local-state className="text-[12.5px] leading-4 text-ink">
            {s.word}
          </span>
          {up && x?.port ? (
            x.url ? (
              <UrlLink url={x.url} />
            ) : (
              <span className="font-mono text-[11.5px] leading-4 text-[#6B6B6B]">localhost:{x.port} on its computer</span>
            )
          ) : null}
          <span className="flex-1" />
          {up && !x?.url && <Btn tag="local-open-tab" label="Open preview" doing="Opening…" busy={busy === "open"} onClick={() => void open()} />}
        </div>
        {(s.tip && s.word !== "Running") && <span className={HINT}>{s.tip}</span>}
      </div>
      <form
        data-local-command
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void start();
        }}
        className="flex flex-col gap-1.5"
      >
        <label className="flex min-w-0 items-center gap-2">
          <span className="w-[64px] shrink-0 text-[12px] leading-4 text-[#6B6B6B]">Command</span>
          <input
            aria-label="Its command"
            value={command}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            placeholder="Found from its folder: npm run dev, or index.html"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg bg-white px-2.5 py-1.5 font-mono text-[12px] leading-4 text-ink shadow-[0_0_0_1px_#E2E2DF] outline-none focus:shadow-[0_0_0_1.5px_#0A0A0A]"
          />
          <button type="submit" disabled={!!busy || !!app.hosting?.lost} className={DARK}>
            {busy === "start" ? "Starting…" : up ? "Restart" : "Start"}
          </button>
        </label>
        <span className={HINT}>It listens on the port in $PORT. A first start installs what it needs.</span>
        {error && (
          <span role="alert" className={`${PROBLEM} whitespace-normal`}>
            {error}
          </span>
        )}
      </form>
      <Variables ws={ws} name={app.name} names={x?.env ?? []} onSaved={(names) => local && onLocal({ ...local, sites: { ...local.sites, ...(x ? { [own]: { ...x, env: names } } : {}) } })} />
    </div>
  );
}
