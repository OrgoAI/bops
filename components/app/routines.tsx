"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { describeSchedule } from "@/cloud/schedule";
import { sameApp, templatesFor, type RoutineTemplate } from "@/lib/routine-catalog";
import { runningNow, type AppState, type Bot, type Routine, type Schedule, type Watch } from "@/lib/types";
import { AppLogo, botApps } from "./apps";
import { appNameOf, autopilotOf, FilterPill, filterRoutines, monitorNeedsYou, RoutineList, scheduleNeedsYou, sourceApps, TagChips, useOpenRow, zoneOf } from "./autopilot";
import { RoutineWeek, useClock } from "./routine-week";
import { asCadence, asSchedule, CadencePicker, sameCadence, suggestedOf, tidy, type Cadence } from "./cadence-picker";
import { Mascot, Spinner } from "./mascot";
import { Chevron, small, undash } from "./side-group";
import { post, teamOf, useNow } from "./ui";

/*
 * Routines from a Connected App. Once an app is connected, the bot that handles it offers what it can
 * do there on its own (lib/routine-catalog.ts): a popover on the app's icon, a row each, the usual ones
 * ticked, each opening in place to say what it does, when (its suggested times, or any other), its tags, what it never
 * does without asking, and the skill it follows. "Set up N" makes them, owned by that bot, marked with
 * the app they came from. It opens by itself when a connect just finished (AppState.suggest, one at a
 * time, until it's answered or put off), and again from "Add routines". In the Vault it first asks which
 * bot handles it. And a bot's Routines, on its profile (BotRoutines): what it runs on its own, with its
 * Connected Apps to add more from.
 */

/** A template as offered: whether this bot already runs it. */
type Offer = RoutineTemplate & { already: boolean };

/** Whether this bot already runs a template (a routine or monitor that came from it). */
const runsAlready = (state: AppState, botId: string, app: string, id: string) =>
  state.routines.some((r) => r.botId === botId && r.source?.template === id && sameApp(r.source.app, app)) ||
  (state.watches ?? []).some((w) => w.botId === botId && w.source?.template === id && sameApp(w.source.app, app));

/** The anchor kept for an app, by any of its names (a key saved as STRIPE_API_KEY is Stripe's). */
export const anchorOf = (anchors: Map<string, HTMLElement>, app: string) => anchors.get(app) ?? [...anchors].find(([a]) => sameApp(a, app))?.[1] ?? null;

/** Whether a Connected App has routines to offer at all. */
export const hasTemplates = (app: string) => templatesFor(app).length > 0;

/**
 * Suggestions already closed in this window, by when they were made (AppState.suggest.at): shared by every
 * place that shows one, so one closed on Details doesn't open again on the Routines tab before the server's
 * answer arrives, or ever when that answer failed.
 */
const handledSuggests = new Set<number>();

/**
 * The suggestion waiting from a connect that just finished (AppState.suggest), if this place shows it:
 * once closed anywhere it isn't shown again (the server clears it too), until the next one.
 */
export function usePendingSuggest(state: AppState, here: (s: { app: string; botId: string }) => boolean) {
  const s = state.suggest;
  const [, setSeen] = useState(0);
  const pending = s && !handledSuggests.has(s.at) && hasTemplates(s.app) && here(s) ? s : null;
  return {
    pending,
    handled: () => {
      if (!s) return;
      handledSuggests.add(s.at);
      setSeen((n) => n + 1);
    },
  };
}

/** Puts the waiting suggestion off (Not now): the server forgets it. */
const dismiss = () => void post("/api/routines/suggestions/dismiss", {}).catch(() => {});

/** What Bops offers this bot for this app, or what the catalog here says when Bops can't be asked. */
function useOffers(state: AppState, app: string, botId: string | null) {
  const [got, setGot] = useState<{ key: string; templates: Offer[] } | null>(null);
  const key = `${app}:${botId ?? ""}`;
  const local = useRef<() => Offer[]>(() => []);
  useLayoutEffect(() => {
    local.current = () => (botId ? templatesFor(app).map((t) => ({ ...t, already: runsAlready(state, botId, app, t.id) })) : []);
  });
  useEffect(() => {
    if (!botId) return;
    let gone = false;
    fetch(`/api/routines/suggestions?app=${encodeURIComponent(app)}&botId=${encodeURIComponent(botId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ templates?: Offer[] }>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => !gone && setGot({ key, templates: Array.isArray(j.templates) ? j.templates : local.current() }))
      .catch(() => !gone && setGot({ key, templates: local.current() }));
    return () => {
      gone = true;
    };
  }, [app, botId, key]);
  return got?.key === key ? got.templates : null;
}

/** Where the popover sits: under its anchor, or over it when there's more room above; inside the window. */
function usePlace(anchor: () => HTMLElement | null, width: number) {
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const get = useRef(anchor);
  // Kept current before the effect below reads it (effects run in order).
  useLayoutEffect(() => {
    get.current = anchor;
  });
  useLayoutEffect(() => {
    const put = () => {
      const el = get.current();
      if (!el) return;
      const r = el.getBoundingClientRect();
      const left = Math.max(12, Math.min(r.left - 8, window.innerWidth - width - 12));
      const below = window.innerHeight - r.bottom - 20;
      const above = r.top - 20;
      setPlace(below >= 320 || below >= above ? { left, top: r.bottom + 8, maxHeight: below } : { left, bottom: window.innerHeight - r.top + 8, maxHeight: above });
    };
    put();
    window.addEventListener("resize", put);
    // Any scroll under it (the Vault's, the profile's) moves its anchor.
    window.addEventListener("scroll", put, true);
    return () => {
      window.removeEventListener("resize", put);
      window.removeEventListener("scroll", put, true);
    };
  }, [width]);
  return place;
}

const WIDTH = 368;

/**
 * "<Bot> can handle <App> for you": the routines a bot can run for a Connected App, to tick and set up.
 * `pickBot` asks which bot handles it first (in the Vault; one bot owns each routine), `botId` preselected,
 * else the main bot. Esc and a click outside put it off (Not now); focus stays inside while it's open
 * and goes back to its anchor after.
 */
export function RoutineSuggest({
  state,
  app,
  botId: start,
  pickBot,
  anchor,
  onClose,
}: {
  state: AppState;
  app: string;
  botId?: string;
  pickBot?: boolean;
  /** The app's icon it opens on. */
  anchor: () => HTMLElement | null;
  onClose: () => void;
}) {
  const appName = appNameOf(state, app);
  // The bots that can use the app, the main bot first; any of the team when none can yet.
  const team = teamOf(state);
  const users = team.filter((b) => botApps(state, b).some((x) => sameApp(x.app, app)) || !!b.keys?.some((k) => sameApp(k, app)));
  const choices = users.length ? users : team;
  const [botId, setBotId] = useState<string | null>(() => start ?? (choices.find((b) => b.isMain) ?? choices[0])?.id ?? null);
  const bot = state.bots.find((b) => b.id === botId);
  // What it runs already counts as it's made (some of a Set up can fail, and the popover stays for those).
  const offers = useOffers(state, app, botId)?.map((t) => (t.already || !botId || !runsAlready(state, botId, app, t.id) ? t : { ...t, already: true })) ?? null;
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  // When each one runs, as changed here (its schedule, the zone its times are in).
  const [whens, setWhens] = useState<Record<string, { schedule?: Cadence; zone?: string }>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = state.owner?.timeZone;
  // Before each meeting is offered when the app is Google Calendar or the bot uses it.
  const calendar = sameApp(app, "googlecalendar") || (!!bot && botApps(state, bot).some((x) => sameApp(x.app, "googlecalendar")));
  const box = useRef<HTMLDivElement>(null);
  const place = usePlace(anchor, WIDTH);

  const ticked = (t: Offer) => !t.already && (ticks[t.id] ?? t.defaultOn);
  const picked = (offers ?? []).filter(ticked);
  /** Its schedule as picked here, when that isn't the starter's own. */
  const scheduleOf = (t: Offer): Schedule | undefined => {
    const s = whens[t.id]?.schedule;
    return t.schedule && s && !sameCadence(s, asCadence(t.schedule)) ? asSchedule(tidy(s)) : undefined;
  };
  /** The zone picked for it here, when that isn't the owner's. */
  const zoneOf = (t: Offer) => {
    const z = whens[t.id]?.zone;
    return z && z !== tz ? z : undefined;
  };
  const whenOf = (t: Offer) => {
    const s = scheduleOf(t);
    return s ? describeSchedule(s as Parameters<typeof describeSchedule>[0], zoneOf(t) ?? tz) : undash(t.when);
  };

  // Kept current for the listeners below, which are set once.
  const close = useRef(onClose);
  const notNow = useRef(() => {});
  const suggested = !!state.suggest && sameApp(state.suggest.app, app);
  useLayoutEffect(() => {
    close.current = onClose;
    notNow.current = () => {
      if (suggested) dismiss();
      close.current();
    };
  });

  // Focus moves in once there's something to focus, and back to where it was after.
  const back = useRef<Element | null>(null);
  useEffect(() => {
    back.current = document.activeElement;
    return () => {
      const el = back.current;
      const anchorEl = anchor();
      // Back to where it was asked from, or its icon when it opened on its own.
      if (el instanceof HTMLElement && el !== document.body && el.isConnected) el.focus();
      else anchorEl?.querySelector<HTMLElement>("button")?.focus();
    };
    // Once, on open and close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ready = !!offers && !!place;
  useEffect(() => {
    if (!ready) return;
    const first = box.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)");
    first?.focus({ preventScroll: true });
  }, [ready, botId]);

  // Esc puts it off, and only it (the page under it stays); a click outside does too.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      notNow.current();
    };
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor()?.contains(t)) return;
      notNow.current();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab goes round inside it.
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const all = [...box.current.querySelectorAll<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex='0']")].filter((el) => !el.closest("[inert]"));
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      all[all.length - 1].focus();
    } else if (!e.shiftKey && i === all.length - 1) {
      e.preventDefault();
      all[0].focus();
    }
  };

  const setUp = async () => {
    if (!botId || !picked.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post("/api/routines/suggestions", {
        app,
        botId,
        templates: picked.map((t) => ({ id: t.id, ...(scheduleOf(t) ? { schedule: scheduleOf(t) } : {}), ...(zoneOf(t) ? { timeZone: zoneOf(t) } : {}) })),
      });
      const j = (await res.json().catch(() => null)) as { created?: string[]; errors?: string[]; error?: string } | null;
      if (!res.ok || j?.error) {
        setError(j?.error ? undash(j.error) : "That didn't work. Try again.");
        setBusy(false);
        return;
      }
      // Some made, some not: the made ones show as Already on, and why the rest weren't stays here.
      if (j?.errors?.length) {
        setError(j.errors.map(undash).join(" "));
        setTicks({});
        setBusy(false);
        return;
      }
      onClose();
    } catch {
      setError("Couldn't reach Bops. Try again.");
      setBusy(false);
    }
  };

  if (!place) return null;
  const titleId = `routines-for-${app}`;
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={trap}
      style={{ left: place.left, top: place.top, bottom: place.bottom, width: WIDTH, maxHeight: Math.max(240, place.maxHeight) }}
      className="motion-dialog-in fixed z-50 flex flex-col overflow-hidden rounded-[18px] bg-white shadow-[0_0_0_1px_#0000000F,0_20px_50px_-18px_#00000059]"
    >
      <div className="flex items-start gap-3 px-4 pb-2 pt-3.5">
        <AppLogo app={app} name={appName} size={30} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={titleId} className="text-[14.5px] font-semibold leading-[19px]">
            {bot ? `${bot.name} can handle ${appName} for you` : `Your bots can handle ${appName} for you`}
          </span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">Pick what it does on its own. You can change these any time in Routines.</span>
        </div>
      </div>

      {pickBot && choices.length > 1 && (
        <div className="flex flex-col gap-1.5 px-4 pb-2">
          <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">Who handles it</span>
          <div role="radiogroup" aria-label="Who handles it" className="flex flex-wrap gap-1.5">
            {choices.map((b) => {
              const on = b.id === botId;
              return (
                <button
                  key={b.id}
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    if (on) return;
                    setBotId(b.id);
                    setTicks({});
                    setOpenId(null);
                  }}
                  className={`flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12.5px] leading-4 outline-none focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
                >
                  <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
                  {b.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
        {!offers ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size={14} />
          </div>
        ) : (
          offers.map((t) => (
            <OfferRow
              key={t.id}
              offer={t}
              ticked={ticked(t)}
              when={whenOf(t)}
              schedule={whens[t.id]?.schedule ?? (t.schedule ? asCadence(t.schedule) : undefined)}
              zone={whens[t.id]?.zone ?? tz}
              ownerZone={tz}
              calendar={calendar}
              open={openId === t.id}
              disabled={busy}
              onTick={(on) => setTicks({ ...ticks, [t.id]: on })}
              onSchedule={(s) => setWhens((w) => ({ ...w, [t.id]: { ...w[t.id], schedule: s } }))}
              onZone={(z) => setWhens((w) => ({ ...w, [t.id]: { ...w[t.id], zone: z } }))}
              onToggle={() => setOpenId(openId === t.id ? null : t.id)}
            />
          ))
        )}
      </div>

      {error && (
        <span role="alert" className="px-4 pb-1 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
      <div className="flex items-center justify-end gap-1.5 border-t border-[#F0F0EE] px-3 py-2.5">
        <button onClick={() => notNow.current()} disabled={busy} className="rounded-full px-3 py-1.5 text-[13px] font-medium leading-4 text-[#3A3A38] outline-none hover:bg-[#F2F2F0] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-40">
          Not now
        </button>
        <button
          onClick={() => void setUp()}
          disabled={busy || !picked.length}
          className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-white outline-none hover:bg-[#2A2A28] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A,0_0_0_3px_#FFFFFF_inset] disabled:opacity-40"
        >
          {busy ? "Setting up…" : `Set up ${picked.length}`}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** One routine offered: a box to tick, its name and when; the chevron opens what it does, in place. */
function OfferRow({
  offer: t,
  ticked,
  when,
  schedule,
  zone,
  ownerZone,
  calendar,
  open,
  disabled,
  onTick,
  onSchedule,
  onZone,
  onToggle,
}: {
  offer: Offer;
  ticked: boolean;
  when: string;
  schedule?: Cadence;
  zone?: string;
  ownerZone?: string;
  calendar: boolean;
  open: boolean;
  disabled: boolean;
  onTick: (on: boolean) => void;
  onSchedule: (s: Cadence) => void;
  onZone: (z: string) => void;
  onToggle: () => void;
}) {
  const id = `offer-${t.id}`;
  return (
    <div className={`flex flex-col rounded-xl ${open ? "bg-[#F7F7F6]" : ""}`}>
      <div className="flex items-start gap-2.5 px-2 py-2">
        <input
          id={id}
          type="checkbox"
          checked={t.already || ticked}
          disabled={t.already || disabled}
          onChange={(e) => onTick(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[#0A0A0A] disabled:opacity-50"
        />
        <label htmlFor={id} className="flex min-w-0 flex-1 cursor-default flex-col">
          <span className={`text-[13.5px] font-medium leading-[18px] ${t.already ? "text-[#9A9A98]" : "text-ink"}`}>{undash(t.title)}</span>
          <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{t.already ? `Already on · ${when}` : when}</span>
        </label>
        <button
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-more`}
          aria-label={`${open ? "Hide" : "Show"} what ${undash(t.title)} does`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-[#9A9A98] outline-none hover:bg-black/[0.05] hover:text-ink focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
        >
          <Chevron open={open} />
        </button>
      </div>
      {open && (
        <div id={`${id}-more`} className="motion-fade-in flex flex-col gap-2 pb-3 pl-[34px] pr-3 text-[12.5px] leading-[17px] text-[#3A3A38]">
          <span>{undash(t.summary)}</span>
          {schedule && !t.already ? (
            <CadencePicker
              value={schedule}
              onChange={(s) => {
                onSchedule(s);
                // Changing when it runs means it's wanted.
                if (!ticked) onTick(true);
              }}
              zone={zone}
              ownerZone={ownerZone}
              onZone={onZone}
              presets={suggestedOf(t)}
              calendar={calendar}
              disabled={disabled}
            />
          ) : (
            <Line label="When">{when}</Line>
          )}
          {!!t.tags?.length && <TagChips tags={t.tags} />}
          {t.neverWithoutAsking.length > 0 && <Line label="Never without asking">{t.neverWithoutAsking.map(undash).join(", ")}</Line>}
          {t.skill && <Line label="Follows">{`The ${undash(t.skill)} skill`}</Line>}
        </div>
      )}
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span>
      <span className="text-[#9A9A98]">{label}: </span>
      {children}
    </span>
  );
}

/** An app's icon that opens its routines: the popover's anchor. */
export function AppRoutinesButton({
  app,
  name,
  size,
  label,
  onClick,
  anchorRef,
}: {
  app: string;
  name: string;
  size: number;
  label: string;
  onClick: () => void;
  anchorRef: (el: HTMLSpanElement | null) => void;
}) {
  return (
    <span ref={anchorRef} className="flex">
      <button onClick={onClick} aria-label={label} data-tip={label} className="flex rounded-[8px] outline-none hover:opacity-80 focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]">
        <AppLogo app={app} name={name} size={size} />
      </button>
    </span>
  );
}

/* ---------------- A bot's Routines, on its profile ---------------- */

/**
 * What a bot runs on its own: its schedules and monitors (when, next run, how the last went, the
 * Connected App each came from, tags), each opening in place to run, pause, edit or delete it. Filtered
 * to one Connected App (from Details) when `app` is set. Its Connected Apps that have routines to offer
 * sit on top: one opens the popover to add more. A waiting suggestion for this bot opens there by itself.
 */
export function BotRoutines({
  state,
  bot: b,
  app: only,
  onApp,
  onOpenAll,
  onOpenWatch,
}: {
  state: AppState;
  bot: Bot;
  app: string | null;
  onApp: (app: string | null) => void;
  /** The workspace's Routines page. */
  onOpenAll: () => void;
  onOpenWatch: (w: Watch) => void;
}) {
  const now = useClock(30_000);
  const mine = autopilotOf(state, b.id);
  const shown = filterRoutines(state, mine, { app: only ?? undefined });
  // One picked in the week opens below.
  const [picked, setPicked] = useState<{ id: string; at: number } | null>(null);
  const { openId, toggle, list } = useOpenRow(picked?.id, picked?.at, !!picked && shown.schedules.some((r) => r.id === picked.id));
  const tz = state.owner?.timeZone;
  const zone = useCallback((r: Routine) => zoneOf(r, tz), [tz]);
  const fromApps = sourceApps(mine);
  // Its Connected Apps with routines to offer, then its keys that have some (Stripe, Plain).
  const offers = [
    ...botApps(state, b)
      .filter((x) => hasTemplates(x.app))
      .map((x) => ({ app: x.app, appName: x.appName })),
    ...(b.keys ?? []).filter((k, i, all) => hasTemplates(k) && all.findIndex((x) => sameApp(x, k)) === i).map((k) => ({ app: k, appName: appNameOf(state, k) })),
  ];
  const anchors = useRef(new Map<string, HTMLElement>());
  const [asked, setAsked] = useState<string | null>(null);
  const suggest = usePendingSuggest(state, (s) => s.botId === b.id && offers.some((x) => sameApp(x.app, s.app)));
  const popover = asked ?? suggest.pending?.app ?? null;
  const total = mine.schedules.length + mine.monitors.length;
  const needs = [...mine.schedules.filter((r) => scheduleNeedsYou(r, state)), ...mine.monitors.filter(monitorNeedsYou)].length;

  return (
    <div className="flex w-full flex-col gap-3">
      {offers.length > 0 && (
        <div className="flex w-full items-center gap-3 rounded-2xl bg-white/60 px-4 py-3 shadow-[inset_0_0_0_1px_#FFFFFF,0_0_0_1px_#0000000F]">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] font-semibold leading-4">Add routines</span>
            <span className="text-[12px] leading-4 text-[#6B6B6B]">{(b.keys ?? []).some(hasTemplates) ? `From the Connected Apps and keys ${b.name} uses` : `From the Connected Apps ${b.name} uses`}</span>
          </div>
          <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {offers.map((x) => (
              <AppRoutinesButton
                key={x.app}
                app={x.app}
                name={x.appName}
                size={26}
                label={`Add routines for ${x.appName}`}
                onClick={() => setAsked(x.app)}
                anchorRef={(el) => void (el ? anchors.current.set(x.app, el) : anchors.current.delete(x.app))}
              />
            ))}
          </span>
        </div>
      )}

      {total > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[13px] font-semibold leading-4">
              Routines <span className="font-normal tabular-nums text-[#9A9A98]">{only ? `${shown.schedules.length + shown.monitors.length} of ${total}` : total}</span>
            </span>
            {needs > 0 && <span className="rounded-full bg-[#FEF3F2] px-2 py-0.5 text-[11.5px] font-medium leading-4 text-[#B42318]">{needs === 1 ? "1 needs you" : `${needs} need you`}</span>}
            <span className="flex-1" />
            <button onClick={onOpenAll} className="text-[12px] font-medium leading-4 text-ink">
              All bots ›
            </button>
          </div>
          {fromApps.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Connected App">
              <FilterPill on={!only} onClick={() => onApp(null)}>
                All
              </FilterPill>
              {fromApps.map((a) => (
                <FilterPill key={a} on={only === a} onClick={() => onApp(only === a ? null : a)}>
                  <AppLogo app={a} name={appNameOf(state, a)} size={14} />
                  {appNameOf(state, a)}
                </FilterPill>
              ))}
            </div>
          )}
          {shown.schedules.length > 0 && (
            <div className="rounded-2xl bg-white/60 p-3 shadow-[inset_0_0_0_1px_#FFFFFF,0_0_0_1px_#0000000F]">
              <RoutineWeek
                routines={shown.schedules}
                bots={[b]}
                tz={tz}
                now={now}
                zoneOf={zone}
                running={(r) => runningNow(r, state.sessions)}
                needsYou={(r) => scheduleNeedsYou(r, state)}
                onOpen={(id) => setPicked({ id, at: Date.now() })}
              />
            </div>
          )}
          <div ref={list}>
            <RoutineList
              state={state}
              schedules={shown.schedules}
              monitors={shown.monitors}
              openId={openId}
              onToggle={toggle}
              onOpenWatch={onOpenWatch}
              className="bg-white/60 shadow-[inset_0_0_0_1px_#FFFFFF,0_0_0_1px_#0000000F]"
            />
          </div>
        </div>
      )}

      {!total && (
        <span className="px-2 text-center text-[12px] leading-4 text-[#9A9A98]">
          {offers.length ? `Pick some above, or ask ${b.name} to do something on a schedule` : `Ask ${b.name} to do something on a schedule, or to watch a page`}
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

/** How many routines and monitors a bot runs from one Connected App. */
export function routinesFrom(state: AppState, botId: string, app: string) {
  const { schedules, monitors } = autopilotOf(state, botId);
  return schedules.filter((r) => !!r.source && sameApp(r.source.app, app)).length + monitors.filter((w) => !!w.source && sameApp(w.source.app, app)).length;
}

/** "3 routines", "1 routine". */
export const routineCount = (n: number) => `${n} routine${n === 1 ? "" : "s"}`;

export { small };

/* ---------------- An app's Routines, in the Vault ---------------- */

/**
 * What every bot runs from one Connected App or key: its schedules and monitors (when, next run, how the
 * last went), grouped by bot when more than one runs some, each opening in place to run, pause, edit or
 * delete it, as on the Routines page. Nothing when none came from it.
 */
export function AppRoutines({ state, app, onOpenWatch }: { state: AppState; app: string; onOpenWatch: (w: Watch) => void }) {
  useNow(30_000);
  const shown = filterRoutines(state, autopilotOf(state), { app });
  const { openId, toggle, list } = useOpenRow(undefined, undefined, false);
  const total = shown.schedules.length + shown.monitors.length;
  if (!total) return null;
  const needs = shown.schedules.filter((r) => scheduleNeedsYou(r, state)).length + shown.monitors.filter(monitorNeedsYou).length;
  const groups = teamOf(state)
    .map((b) => ({ bot: b, schedules: shown.schedules.filter((r) => r.botId === b.id), monitors: shown.monitors.filter((w) => w.botId === b.id) }))
    .filter((g) => g.schedules.length + g.monitors.length);
  return (
    <div ref={list} className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 px-2 text-[12px] font-medium leading-4 text-[#6B6B6B]">
        Routines <span className="font-normal tabular-nums text-[#9A9A98]">{total}</span>
        {needs > 0 && <span className="rounded-full bg-[#FEF3F2] px-2 py-px text-[11px] font-medium leading-4 text-[#B42318]">{needs === 1 ? "1 needs you" : `${needs} need you`}</span>}
      </span>
      {groups.map((g) => (
        <div key={g.bot.id} className="flex flex-col gap-1.5">
          {groups.length > 1 && (
            <span className="flex items-center gap-1.5 px-2 text-[11.5px] leading-4 text-[#9A9A98]">
              <Mascot botId={g.bot.id} color={g.bot.color} size={14} antenna={false} />
              {g.bot.name}
            </span>
          )}
          <RoutineList state={state} schedules={g.schedules} monitors={g.monitors} openId={openId} onToggle={toggle} onOpenWatch={onOpenWatch} />
        </div>
      ))}
    </div>
  );
}

/** How many routines and monitors every bot runs from one Connected App or key. */
export function routinesOfApp(state: AppState, app: string) {
  const { schedules, monitors } = filterRoutines(state, autopilotOf(state), { app });
  return schedules.length + monitors.length;
}
