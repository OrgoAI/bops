"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { trackEvent } from "@/lib/analytics";
import { ACCESS_LABELS, ACCESS_LEVELS, accessSummary, appsSummary, computerSummary, fitComputer, inviteDefault, isAccessLevel, levelOf, POWER_WORDS, POWERS, powersSummary, usesComputer, writesAny, type AccessLevel, type MemberAccess, type Power } from "@/lib/member-access";
import { appsOwnShown } from "@/lib/apps-access";
import {
  ACCESS_TIPS,
  ACCESS_WORDS,
  ADMIN_SHEET_WORDS,
  ADMIN_WORDS,
  APPS_TIPS,
  APPS_WORDS,
  CLOUD_SHARES_APPS,
  COMPUTER_WORDS,
  emailOf,
  KEYS_WORDS,
  ROLE_LINES,
  ROLE_LINES_SHARED,
  ROLE_NAMES,
  WORDS,
  type Invite,
  type InviteSent,
  type MemberRole,
  type MembersInfo,
  type MembersRefusal,
  type Person,
} from "@/lib/members";
import { peopleAside, peopleShort, upgradeLabel } from "@/lib/plan-includes";
import { workspaceOf, type AppState, type Bot } from "@/lib/types";
import { initialsFrom, LoadFailed, Notice, Placeholder, Section, useSignOut } from "./account";
import { Mascot, Spinner } from "./mascot";
import { usePlan } from "./plan-note";
import { AskInPlace, NeedsYouDot, teamOf } from "./ui";
import { Badge } from "./vault";
import { ChartIcon } from "./team-chart";
import { AppsIcon } from "./made-apps";

/*
 * Team: who sees the user's bots, a section of Settings (from the user's initials at the bottom left of the sidebar). They're the
 * members of the user's Orgo workspace named "bops", which holds the computers of every Bops workspace:
 * the user invites people by email, sends an invite again or cancels it, picks which of the open
 * workspace's bots each person sees in Bops (none, read or write per bot, and for bots made later:
 * BotAccess, lib/member-access.ts), makes someone an Admin (every bot, its computer and Your Apps, whatever
 * is picked) or a Member (what's picked) and removes people. Each row says the role: Owner, Admin or Member. Who they are comes from GET /api/members
 * (lib/server/members.ts), which reads Orgo with the user's key, and orgo-web decides who may be added
 * (Free nobody, Pro 2 people, Max up to 5); which bots each sees is kept in the workspace
 * (Workspace.memberAccess) and comes back with them. The app never makes share links: a link lets in
 * whoever holds it.
 */

/* ---------------- The count on your initials ---------------- */

/** Every count on the page, so a change in the sheet shows on the button at once (like refreshState). */
const counters = new Set<() => void>();
export const refreshMembersCount = () => counters.forEach((read) => read());

/**
 * How many people have access besides the user (GET /api/members?count=1): null while it isn't known, and
 * when there's none to show (signed out, self-hosted). Read when someone signs in, again when Bops comes
 * back to the front (at most once a minute), and after every change in Team.
 */
export function useMembersCount(state: AppState) {
  const [count, setCount] = useState<{ user: string; n: number | null } | null>(null);
  const user = state.account?.user.id;
  useEffect(() => {
    if (!user) return;
    let stop = false;
    let last = 0;
    const read = () => {
      last = Date.now();
      void fetch("/api/members?count=1", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ count?: unknown }>) : null))
        .then((j) => !stop && setCount({ user, n: typeof j?.count === "number" ? j.count : null }))
        .catch(() => {});
    };
    const onFocus = () => Date.now() - last >= 60_000 && read();
    read();
    counters.add(read);
    window.addEventListener("focus", onFocus);
    return () => {
      stop = true;
      counters.delete(read);
      window.removeEventListener("focus", onFocus);
    };
  }, [user]);
  return user && count?.user === user ? count.n : null;
}

/**
 * How many people have access besides the user (guests too, invites not), as a grey count on the corner of the user's
 * initials in the sidebar's footer, where Team is (their menu, sidebar.tsx YouMenu). Grey, not highlighter: nothing here
 * needs the user. Nothing while there's none, or none known. `count`: given (tests), else read (useMembersCount).
 */
export function TeamCount({ count }: { count: number | null }) {
  if (!count) return null;
  return (
    <span data-team-count className="pointer-events-none absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#EEEEEC] px-1 text-[11px] font-semibold leading-none tabular-nums text-[#3A3A38] shadow-[0_0_0_2px_#F9F9F8]">
      {count}
    </span>
  );
}

/** The people besides the user, in words for a label: "2 with access" (null: none, or not known). */
export const teamWords = (count: number | null) => (count ? `${count} with access` : null);

/* ---------------- Team, in Settings ---------------- */

type Ready = Extract<MembersInfo, { state: "ready" }>;
/** What the route answered: a state, or why it couldn't say ({code, error}). */
type Read = MembersInfo | (MembersRefusal & { state?: undefined });
/** A change's answer: its status (0: Bops itself didn't answer) and JSON. */
/** What a change answered, and (`read`) who has access as the sheet read it after, when that read came back. */
type Answer = { status: number; json: Record<string, unknown>; read?: Read };
/** A change sent to /api/members; the sheet reads who has access again before it answers. */
type Act = (method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) => Promise<Answer>;

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** Why an invite didn't go, in the route's words (the refusals each say what to do). */
const saidOf = (r: Answer) => (r.status === 0 ? WORDS.appUnreachable : typeof r.json.error === "string" && r.json.error ? r.json.error : WORDS.orgoError);
/**
 * Why a change to someone didn't go, under their row: a refusal's own words (they don't have access
 * anymore, Full access is off), else the row's plain `fallback` for Orgo not answering or failing.
 */
const errorOf = (r: Answer, fallback: string) =>
  r.status === 0 ? WORDS.appUnreachable : typeof r.json.error === "string" && r.json.code !== "UNREACHABLE" && r.json.code !== "ORGO_ERROR" ? r.json.error : fallback;

const pill = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4";
const quiet = `${pill} shrink-0 bg-[#F2F2F0] hover:bg-[#EAEAE7]`;

/**
 * Team: Settings' section of who sees which bots (bops-app.tsx Settings), a part of the page like its others. It
 * reads who has access as it opens, again when Bops comes back to the front and every 30 seconds while it's open,
 * showing what it has meanwhile. `onUpgrade` goes to the plans (Settings, Plan and credit); `onClose`, signing out
 * from here leaves Settings too.
 */
export function Members({
  state,
  onClose,
  onUpgrade,
  onTeamChart,
  source = "/api/members",
}: {
  state: AppState;
  onClose?: () => void;
  onUpgrade: () => void;
  /** The team chart (team-chart.tsx), for the open workspace. */ onTeamChart?: () => void;
  /** Where it reads and changes who's in: the user's own (app/api/members), or, for an Admin, the shared workspace open (app/api/workspaces/shared/people). */
  source?: string;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [loading, setLoading] = useState(true);
  // The route itself failed (a 500, or not JSON): Team says so and offers a retry.
  const [failed, setFailed] = useState(false);
  const shown = useRef<Read | null>(null);
  /**
   * Read it again, giving back what it read when that's shown now. `quiet`: in the background, where a
   * hiccup keeps what's shown rather than an error over it.
   */
  const load = useCallback(
    ({ quiet = false } = {}): Promise<Read | undefined> =>
      fetch(source, { cache: "no-store" })
        .then((res) => res.json() as Promise<Read>)
        .then((j) => (j && typeof j === "object" && (typeof j.state === "string" || typeof (j as MembersRefusal).code === "string") ? j : null))
        .catch(() => null)
        .then((next) => {
          setLoading(false);
          if (quiet && shown.current?.state === "ready" && !next?.state) return undefined;
          if (!next) return void setFailed(true);
          shown.current = next;
          setRead(next);
          setFailed(false);
          return next;
        }),
    [source],
  );
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const again = () => void load({ quiet: true });
    const every = setInterval(again, 30_000);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(every);
      window.removeEventListener("focus", again);
    };
  }, [load]);
  const retry = () => {
    setLoading(true);
    void load();
  };
  const act: Act = useCallback(
    async (method, body) => {
      let status = 0;
      let json: Record<string, unknown> = {};
      try {
        const res = await fetch(source, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        status = res.status;
        json = ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
      } catch {
        status = 0;
      }
      const read = await load({ quiet: true });
      refreshMembersCount();
      return { status, json, ...(read ? { read } : {}) };
    },
    [load, source],
  );

  // Counted once Team has shown who has access.
  const opened = useRef(false);
  const people = read?.state === "ready" ? read.people.length : null;
  useEffect(() => {
    if (people === null || opened.current) return;
    opened.current = true;
    trackEvent("bops_members_opened", { people });
  }, [people]);

  const leaving = useSignOut(onClose);

  return (
    <section aria-labelledby="members-title" data-team className="flex max-w-[760px] flex-col">
        <div className="flex flex-col gap-0.5 px-[22px] pt-6">
            <span id="members-title" className="text-[22px] font-bold leading-7 tracking-[-0.02em]">
              Team
            </span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">{state.shared ? "Who sees which of the owner's bots, and their computers." : "Who sees which of your bots, and their computers."}</span>
            {/* Who answers to whom, and who may ask whom: the team chart (your own workspace only). */}
            {onTeamChart && !state.shared && (
              <button type="button" data-chart-link onClick={onTeamChart} className="mt-1 flex items-center gap-1.5 self-start text-[12.5px] font-medium leading-4 text-ink hover:underline">
                <ChartIcon size={13} />
                See the org chart
              </button>
            )}
        </div>

        {!read ? (
          failed && !loading ? (
            <Section title="Add someone">
              <LoadFailed onRetry={retry} text={WORDS.loadFailed} />
            </Section>
          ) : (
            <>
              <Placeholder title="Add someone" />
              <Placeholder title="Who has access" />
            </>
          )
        ) : read.state === "ready" ? (
          <ReadyView info={read} state={state} act={act} onRetry={retry} onUpgrade={onUpgrade} />
        ) : (
          <Section title="Add someone">
            {read.state === "self_hosted" ? (
              <Notice
                action={
                  <a href={read.orgoUrl} target="_blank" rel="noreferrer" className={quiet}>
                    Open orgo.ai
                  </a>
                }
              >
                {WORDS.selfHosted}
              </Notice>
            ) : read.state === "signed_out" ? (
              <>
                <Notice
                  action={
                    !leaving.ask && (
                      <button disabled={leaving.busy} onClick={() => void leaving.signOut()} className={`${quiet} disabled:opacity-50`}>
                        Sign out
                      </button>
                    )
                  }
                >
                  {read.why === "rejected" ? WORDS.rejected : WORDS.noKey}
                </Notice>
                {leaving.ask}
              </>
            ) : read.state === "no_computers" ? (
              <Notice>{WORDS.noComputers}</Notice>
            ) : (
              <Notice
                action={
                  <button onClick={retry} disabled={loading} className={`${quiet} disabled:opacity-50`}>
                    Try again
                  </button>
                }
              >
                {read.code === "UNREACHABLE" ? WORDS.unreachable : read.code === "ORGO_ERROR" ? WORDS.orgoLoadError : read.error}
              </Notice>
            )}
          </Section>
        )}

        {read?.state === "ready" && read.shared ? (
          <div className="px-[22px] pb-5 pt-5 text-[12px] leading-4 text-[#9A9A98]">
            <a href={read.orgoUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
              Open on orgo.ai
            </a>
          </div>
        ) : read?.state === "ready" ? (
          <div className="px-[22px] pb-5 pt-5 text-[12px] leading-4 text-[#9A9A98]">
            People you add sign in with the email you invite. In Bops they see everything of the bots you pick, your chats with them too. On orgo.ai they see every bot&apos;s
            computer, like an open inbox, and can ask Orgo&apos;s agent to work on it. {read.keysOnComputers ? "Never your saved logins." : "Never your saved logins or keys."}{" "}
            <a href={read.orgoUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
              Open on orgo.ai
            </a>
          </div>
        ) : (
          <div className="pb-5" />
        )}
    </section>
  );
}

/** Who has access, and adding people: the section once Orgo has said. */
function ReadyView({ info, state, act, onRetry, onUpgrade }: { info: Ready; state: AppState; act: Act; onRetry: () => void; onUpgrade: () => void }) {
  // Bops' own keys on the computers: said whenever anyone else is in (View only too: Orgo's agent, which
  // they may use on any of the computers, runs as root there), and when they're why the app has no Full access.
  const someoneElse = info.people.length > 0 || info.invites.length > 0;
  const keys = info.fullAccess === "off" || (info.keysOnComputers && someoneElse);
  const bots = sheetBots(state, info.wsId, !!info.shared);
  // Your Apps, beside each person's bots: only where apps are open to the owner (lib/apps-access.ts).
  const apps = appsOwnShown(state);
  const older = useOlderBops(apps);
  // An Admin's sheet of a workspace shared with them: changes only once orgo-web and Bops Cloud let them (else it reads only, saying why).
  const readsOnly = !!info.shared && !info.shared.can;
  return (
    <AppsScope.Provider value={{ shown: apps, older, roles: info.fullAccess === "on", keys: info.keysScope !== "not_yet" }}>
      <SheetScope.Provider value={info.shared ?? null}>
      {info.shared?.line && (
        <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
          <Notice>{info.shared.line}</Notice>
        </div>
      )}
      {!info.shared && (keys || info.host === "mac" || !bots) && (
        <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
          {!bots && <Notice>{WORDS.sharedOpen}</Notice>}
          {keys && <Notice>{info.fullAccess === "off" ? `${WORDS.keysOff}${someoneElse ? ` ${WORDS.keysOffAnyone}` : ""}` : WORDS.keysHeld}</Notice>}
          {info.host === "mac" && (
            <Notice>Right now your bots work on this Mac, whose screens people you add never see. They see the chats and threads of the bots you pick, and your bots&apos; cloud computers.</Notice>
          )}
        </div>
      )}
      {!readsOnly && <AddSomeone info={info} state={state} bots={bots} act={act} onRetry={onRetry} onUpgrade={onUpgrade} />}
      <WhoHasAccess info={info} bots={bots} act={act} />
      {info.invites.length > 0 && (
        <fieldset disabled={readsOnly} className="contents">
          <Invited info={info} bots={bots} act={act} />
        </fieldset>
      )}
      </SheetScope.Provider>
    </AppsScope.Provider>
  );
}

/**
 * The sheet of a workspace shared with the user, for an Admin there (MembersInfo.shared): their own row is "You" (with
 * Leave), the owner's has no controls and says what stays theirs, and a plan with no room says to ask the owner. Null in
 * the user's own sheet.
 */
const SheetScope = createContext<{ me: string; can: boolean; line?: string } | null>(null);

/* ---------------- Which bots they see ---------------- */

/**
 * The bots people can be given: the workspace's whose people Team lists (`wsId`, MembersInfo; the
 * open one when it isn't said), its main bot first. Null while a workspace shared with the user is open:
 * the window's bots are that one's then, and Team is about the user's own.
 */
export function sheetBots(state: AppState, wsId?: string, sharedSheet = false): Bot[] | null {
  // An Admin's sheet of the shared workspace open: its bots are the window's (every one of them is theirs to give).
  if (state.shared) return sharedSheet && state.shared.role === "admin" ? [...state.bots].sort((a, b) => Number(b.isMain) - Number(a.isMain)) : null;
  const team = wsId ? state.bots.filter((b) => workspaceOf(b) === wsId) : teamOf(state);
  return [...team].sort((a, b) => Number(b.isMain) - Number(a.isMain));
}

/**
 * Whether the sheet shows Your Apps (apps open to the owner), whether a Mac on the account runs a Bops from before it,
 * and whether Bops Cloud gives people their role yet (MembersInfo.fullAccess "on": Admin is offered, and Your Apps
 * reach people; else "not_yet" until it updates).
 */
const AppsScope = createContext<{ shown: boolean; older: boolean; roles: boolean; keys?: boolean }>({ shown: false, older: false, roles: true });

/** A Mac or runner on the account on a Bops from before (the org chart's check, GET /api/workspaces?olderBops=1), asked only when `ask`. */
function useOlderBops(ask: boolean) {
  const [older, setOlder] = useState(false);
  useEffect(() => {
    if (!ask) return;
    let gone = false;
    void fetch("/api/workspaces?olderBops=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { older?: boolean } | null) => !gone && setOlder(j?.older === true))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [ask]);
  return older;
}

/** A person's line under their name: their bots, then Your Apps where the sheet shows it. */
function useSummary() {
  const { shown } = useContext(AppsScope);
  return (access: MemberAccess, ids: string[]) => [accessSummary(access, ids), shown && appsSummary(access), computerSummary(access), powersSummary(access.can)].filter(Boolean).join(" · ");
}

/**
 * `access` with one bot at `level`, or (`botId` null) every bot at `level`, new ones too. A bot at the
 * level of the rest isn't named, as cleanAccess keeps it, so the same access always looks the same. Your Apps and Use its computer stay.
 */
export function withLevel(access: MemberAccess, botId: string | null, level: AccessLevel): MemberAccess {
  const apps = keptBeside(access);
  if (botId === null) return { others: level, bots: {}, ...apps };
  const bots: Record<string, AccessLevel> = Object.fromEntries(Object.entries(access.bots).filter(([id]) => id !== botId));
  if (level !== access.others) bots[botId] = level;
  return { others: access.others, bots, ...apps };
}

/** What a bot change keeps as it was: Your Apps, Use its computer and the switches (a bot picked never turns a switch off). */
const keptBeside = (access: MemberAccess) => ({
  ...(access.apps ? { apps: access.apps } : {}),
  ...(access.computer ? { computer: access.computer } : {}),
  ...(access.can ? { can: access.can } : {}),
});

/**
 * `access` with bots made later at `level`, each bot of `botIds` (and each named) kept at the level it has now: named
 * only when that isn't the new level, as cleanAccess keeps it.
 */
export function withOthers(access: MemberAccess, botIds: readonly string[], level: AccessLevel): MemberAccess {
  const bots: Record<string, AccessLevel> = {};
  for (const id of new Set([...botIds, ...Object.keys(access.bots)])) {
    const now = levelOf(access, id);
    if (now !== level) bots[id] = now;
  }
  return { others: level, bots, ...keptBeside(access) };
}

/** The level every bot of `botIds` and bots made later share, or undefined when they differ (All bots then shows none picked). */
export const allLevel = (access: MemberAccess, botIds: readonly string[]): AccessLevel | undefined =>
  botIds.every((id) => levelOf(access, id) === access.others) ? access.others : undefined;

/** `access` with Your Apps at `level`, the bots as they are. */
export const withApps = (access: MemberAccess, level: AccessLevel): MemberAccess => ({ ...access, apps: level });

/** `access` with Use its computer on or off ("none" is sent, so the server turns off what it kept), the rest as it is. */
export const withComputer = (access: MemberAccess, on: boolean): MemberAccess => ({ ...access, computer: on ? "use" : "none" });

/** Keys as the panel shows it beside Use its computer: on or off, how to change it, and the line under it. */
export type KeysPick = { on: boolean; onChange?: (on: boolean) => void; disabled?: boolean; locked?: boolean; note?: string };

/**
 * Everything someone may do, in three groups, each with its name over it:
 * - Bots: All bots (every bot here and bots made later, picked only while they're all the same), one row per bot, then
 *   Bots you make later (only that: the bots above keep theirs). Each None, Read or Write; under them what each means.
 * - Apps and computers: Your Apps (None, Read or Write), Use its computer and Keys (Off or On), each line under them.
 * - What they can change (PowerRows): each switch Off or On.
 * One line a row, names cut short. Use its computer comes with Write: taking away someone's last Write turns it off too
 * (fitComputer). An invite (`invite`) shows Use its computer and Keys off, to turn on once they've joined: orgo-web keeps
 * both per member, and there's no member yet. `keys`: Keys' row (a person's, or an invite's off); none, no row.
 */
export function BotAccess({ bots, value, onChange, disabled, invite, keys }: { bots: Bot[]; value: MemberAccess; onChange: (next: MemberAccess) => void; disabled?: boolean; invite?: boolean; keys?: KeysPick }) {
  const scope = useContext(AppsScope);
  const ids = bots.map((b) => b.id);
  const all = allLevel(value, ids);
  // Your Apps comes with a bot: none seen, nothing of the workspace opens for them.
  const hasBot = value.others !== "none" || bots.some((b) => levelOf(value, b.id) !== "none");
  // Use its computer comes with Write: someone who can't chat never sets a bot going there.
  const writes = writesAny(value, ids);
  const computerOn = !invite && usesComputer(value);
  const pickLevel = (botId: string | null, level: AccessLevel) => onChange(fitComputer(withLevel(value, botId, level), ids));
  const pickLater = (level: AccessLevel) => onChange(fitComputer(withOthers(value, ids, level), ids));
  const appsNote = scope.shown && (!hasBot || !CLOUD_SHARES_APPS || !scope.roles) ? (!hasBot ? APPS_WORDS.needsBot : APPS_WORDS.notYet) : null;
  const keysOff: KeysPick | undefined = invite ? { on: false, disabled: true } : keys;
  return (
    <div data-bot-access className="flex flex-col gap-4">
      <AccessGroup title={ACCESS_WORDS.bots}>
        <div className="flex max-h-[290px] flex-col overflow-y-auto rounded-[12px] px-2.5 shadow-[0_0_0_1px_#E6E6E3]">
          <AccessRow icon={<EveryBot />} name={ACCESS_WORDS.all} tip={all ? ACCESS_WORDS.allTip : ACCESS_WORDS.allMixed} level={all} onPick={(level) => pickLevel(null, level)} disabled={disabled} />
          {bots.map((b) => (
            <AccessRow
              key={b.id}
              icon={<Mascot botId={b.id} color={b.color} size={16} />}
              name={b.name}
              level={levelOf(value, b.id)}
              onPick={(level) => pickLevel(b.id, level)}
              disabled={disabled}
            />
          ))}
          <AccessRow icon={<LaterBots />} name={ACCESS_WORDS.later} tip={ACCESS_WORDS.laterTip} level={value.others} onPick={pickLater} disabled={disabled} />
        </div>
        <ul data-access-levels className="flex flex-col gap-0.5 px-1 text-[12px] leading-4 text-[#6B6B6B]">
          {ACCESS_LEVELS.map((level) => (
            <li key={level}>
              <span className="font-medium text-[#3A3A38]">{ACCESS_LABELS[level]}:</span> {ACCESS_TIPS[level].charAt(0).toLowerCase() + ACCESS_TIPS[level].slice(1)}
            </li>
          ))}
        </ul>
      </AccessGroup>
      <AccessGroup title={scope.shown ? ACCESS_WORDS.more : ACCESS_WORDS.moreNoApps}>
        <div className="flex flex-col divide-y divide-[#F0F0EE] rounded-[12px] px-2.5 shadow-[0_0_0_1px_#E6E6E3]">
          {/* Your Apps: a scope of its own (lib/member-access.ts MemberAccess.apps), only with a bot (workspaces.ts showsAny). */}
          {scope.shown && (
            <div data-apps-access>
              <AccessRow
                icon={<AppsIcon size={16} />}
                name={APPS_WORDS.row}
                level={!hasBot ? "none" : isAccessLevel(value.apps) ? value.apps : undefined}
                tips={APPS_TIPS}
                onPick={(level) => onChange(withApps(value, level))}
                disabled={disabled || !hasBot}
              />
            </div>
          )}
          {/* Use its computer (MemberAccess.computer), only with Write on a bot, never on an invite. On without Write (a bot deleted under them, or orgo-web's list says so): shown as on, and it can only be turned off. */}
          <div data-computer-access>
            <ComputerRow on={computerOn} onChange={(on) => onChange(withComputer(value, on))} disabled={disabled || invite} onLocked={!writes} />
          </div>
          {/* Keys: kept by orgo-web per member (lib/server/members.ts changeKeys), beside Use its computer. */}
          {keysOff && <KeysRow on={keysOff.on} onChange={keysOff.onChange} disabled={keysOff.disabled} locked={keysOff.locked} />}
        </div>
        <div className="flex flex-col gap-1 px-1 text-[12px] leading-4 text-[#6B6B6B]">
          {scope.shown && <span data-apps-legend>{APPS_WORDS.legend}</span>}
          {appsNote && <span data-apps-note>{appsNote}</span>}
          {scope.shown && scope.older && <span data-apps-older>{APPS_WORDS.older}</span>}
          <span data-computer-note>{invite ? COMPUTER_WORDS.afterJoin : writes ? COMPUTER_WORDS.legend : computerOn ? COMPUTER_WORDS.onWithoutWrite : COMPUTER_WORDS.needsWrite}</span>
          {!invite && keys?.note && <span data-keys-note>{keys.note}</span>}
        </div>
      </AccessGroup>
      {/* What they may change: each a switch of its own (lib/member-access.ts MemberAccess.can, Power). */}
      <PowerRows can={value.can} onChange={(can) => onChange({ ...value, can })} disabled={disabled} />
    </div>
  );
}

/** One group of the panel: its name over it, then its rows and their lines. */
function AccessGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section data-access-group={title} className="flex flex-col gap-1.5">
      <h4 className="px-1 text-[12.5px] font-semibold leading-4 text-ink">{title}</h4>
      {children}
    </section>
  );
}

/** What PowerRows says (no dashes: shown as they are). */
export const POWER_SHEET_WORDS = {
  title: "What they can change",
  admin: "An Admin can change all of this.",
  legend: "Only the owner can delete the workspace.",
};

/** `can` with one switch on or off: always an object, so every switch off is kept as off (`{}`), not as never set. */
export const withPower = (can: Partial<Record<Power, true>> | undefined, power: Power, on: boolean): Partial<Record<Power, true>> => {
  const next: Partial<Record<Power, true>> = { ...(can ?? {}) };
  if (on) next[power] = true;
  else delete next[power];
  return next;
};

/**
 * What someone may change (lib/member-access.ts MemberAccess.can: the org chart, bot settings, memory and skills, workspace
 * settings, app secrets, spending, the owner's Mac), each Off or On as Use its computer is, saying on hover what it covers.
 * `locked`: an Admin's, every one on.
 */
export function PowerRows({ can, onChange, disabled, locked, lead }: { can?: Partial<Record<Power, true>>; onChange?: (next: Partial<Record<Power, true>>) => void; disabled?: boolean; locked?: boolean; lead?: React.ReactNode }) {
  return (
    <div data-powers className="flex flex-col gap-1.5">
      <h4 className="px-1 text-[12.5px] font-semibold leading-4 text-ink">{POWER_SHEET_WORDS.title}</h4>
      <div className="flex flex-col divide-y divide-[#F0F0EE] rounded-[12px] px-2.5 shadow-[0_0_0_1px_#E6E6E3]">
        {lead}
        {POWERS.map((power) => {
          const on = locked || can?.[power] === true;
          return (
            <div key={power} data-power={power} className="flex h-[30px] shrink-0 items-center gap-2">
              <PowerMark />
              <span className="min-w-0 flex-1 truncate text-[12.5px] leading-4 text-ink" data-tip={POWER_WORDS[power].tip}>
                {POWER_WORDS[power].name}
              </span>
              <div role="radiogroup" aria-label={POWER_WORDS[power].name} data-tip={locked ? POWER_SHEET_WORDS.admin : undefined} className={`flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[2px] ${disabled || locked ? "opacity-50" : ""}`}>
                {[false, true].map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    role="radio"
                    aria-checked={on === value}
                    disabled={disabled || locked}
                    data-tip={locked ? POWER_SHEET_WORDS.admin : POWER_WORDS[power].tip}
                    onClick={() => on !== value && onChange?.(withPower(can, power, value))}
                    className={`rounded-full px-2 py-0.5 text-[11.5px] leading-4 ${on === value ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
                  >
                    {value ? COMPUTER_WORDS.on : COMPUTER_WORDS.off}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <span data-powers-note className="px-1 text-[12px] leading-4 text-[#6B6B6B]">
        {locked ? `${POWER_SHEET_WORDS.admin} ${POWER_SHEET_WORDS.legend}` : POWER_SHEET_WORDS.legend}
      </span>
    </div>
  );
}

/** A power's mark, as big as a bot's: a pencil. */
function PowerMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path d="M3 13l.6-2.6L10.8 3.2a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7L5.6 12.4 3 13z" fill="none" stroke="#9A9A98" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** Use its computer's row: Off or On, as small as a bot's levels, each saying on hover what it lets them do. `onLocked`: On can't be picked (it can still be turned off). */
function ComputerRow({ on, onChange, disabled, onLocked }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; onLocked?: boolean }) {
  const dim = disabled || (onLocked && !on);
  return (
    <div className="flex h-[30px] shrink-0 items-center gap-2">
      <ComputerMark />
      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-4 text-ink">{COMPUTER_WORDS.row}</span>
      <div role="radiogroup" aria-label={COMPUTER_WORDS.row} className={`flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[2px] ${dim ? "opacity-50" : ""}`}>
        {[false, true].map((value) => (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={on === value}
            disabled={disabled || (value && onLocked && !on)}
            data-tip={value ? COMPUTER_WORDS.onTip : COMPUTER_WORDS.offTip}
            onClick={() => on !== value && onChange(value)}
            className={`rounded-full px-2 py-0.5 text-[11.5px] leading-4 ${on === value ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
          >
            {value ? COMPUTER_WORDS.on : COMPUTER_WORDS.off}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Use its computer's mark, as big as a bot's: a screen on its stand. */
function ComputerMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <rect x="2" y="3" width="12" height="8" rx="1.5" fill="none" stroke="#9A9A98" strokeWidth="1.3" />
      <path d="M6 13.5h4M8 11v2.5" stroke="#9A9A98" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Keys' row (lib/members.ts KEYS_WORDS): Off or On, as Use its computer's is, beside it in the same box (BotAccess), or
 * over an Admin's switches. orgo-web keeps it per member (PATCH {memberId, keys}: lib/server/members.ts changeKeys).
 * `locked`: an Admin's, always on.
 */
export function KeysRow({ on, onChange, disabled, locked }: { on: boolean; onChange?: (on: boolean) => void; disabled?: boolean; locked?: boolean }) {
  return (
    <div data-keys-access>
      <div className="flex h-[30px] shrink-0 items-center gap-2">
        <KeysMark />
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-4 text-ink">{KEYS_WORDS.row}</span>
        <div role="radiogroup" aria-label={KEYS_WORDS.row} data-tip={locked ? KEYS_WORDS.admin : undefined} className={`flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[2px] ${disabled || locked ? "opacity-50" : ""}`}>
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              role="radio"
              aria-checked={on === value}
              disabled={disabled || locked}
              data-tip={locked ? KEYS_WORDS.admin : value ? KEYS_WORDS.onTip : KEYS_WORDS.offTip}
              onClick={() => on !== value && onChange?.(value)}
              className={`rounded-full px-2 py-0.5 text-[11.5px] leading-4 ${on === value ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : "text-[#6B6B6B] hover:text-ink"}`}
            >
              {value ? COMPUTER_WORDS.on : COMPUTER_WORDS.off}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Keys' mark, as big as a bot's: a key. */
function KeysMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle cx="5.5" cy="8" r="2.8" fill="none" stroke="#9A9A98" strokeWidth="1.3" />
      <path d="M8.3 8h5.2M11.5 8v2.2M13.5 8v1.6" stroke="#9A9A98" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** One row of the picker. `label`: what its levels are for, said to a screen reader when it isn't `name`; `tip` is said to one too. */
function AccessRow({
  icon,
  name,
  label,
  tip,
  level,
  loose,
  onPick,
  disabled,
  tips,
}: {
  icon: React.ReactNode;
  name: string;
  label?: string;
  tip?: string;
  /** Unset: no level picked yet (Your Apps before one is given). */
  level: AccessLevel | undefined;
  loose?: boolean;
  onPick: (level: AccessLevel) => void;
  disabled?: boolean;
  /** What each level means here (a bot's, unless given: Your Apps has its own). */
  tips?: Record<AccessLevel, string>;
}) {
  const tipId = useId();
  return (
    <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-[#F0F0EE] last:border-0">
      {icon}
      <span data-tip={tip} className="min-w-0 flex-1 truncate text-[12.5px] leading-4 text-ink">
        {name}
      </span>
      {tip && (
        <span id={tipId} className="sr-only">
          {tip}
        </span>
      )}
      <LevelPicker label={`What they can do with ${label ?? name}`} describedBy={tip ? tipId : undefined} value={level} loose={loose} onChange={onPick} disabled={disabled} tips={tips} />
    </div>
  );
}

/**
 * None, Read or Write, as a small segmented control, each saying on hover what it lets them do. `loose`:
 * the level picked isn't every bot's (Every bot with single bots set apart), so it shows lighter and
 * picking it again still counts.
 */
export function LevelPicker({
  label,
  describedBy,
  value,
  loose,
  onChange,
  disabled,
  tips = ACCESS_TIPS,
}: {
  label: string;
  describedBy?: string;
  value: AccessLevel | undefined;
  loose?: boolean;
  onChange: (level: AccessLevel) => void;
  disabled?: boolean;
  tips?: Record<AccessLevel, string>;
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} className={`flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[2px] ${disabled ? "opacity-50" : ""}`}>
      {ACCESS_LEVELS.map((level) => {
        const on = value === level;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            data-tip={tips[level]}
            onClick={() => (!on || loose) && onChange(level)}
            className={`rounded-full px-2 py-0.5 text-[11.5px] leading-4 ${on && !loose ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : on ? "bg-white/60 text-[#3A3A38] hover:text-ink" : "text-[#6B6B6B] hover:text-ink"}`}
          >
            {ACCESS_LABELS[level]}
          </button>
        );
      })}
    </div>
  );
}

/** The first row's mark, as big as a bot's: four in a square. */
function EveryBot() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      {[4.5, 11.5].flatMap((x) => [4.5, 11.5].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="2.6" fill="#C9C9C6" />))}
    </svg>
  );
}

/** Bots you make later's mark, as big as a bot's: a plus in a dashed ring. */
function LaterBots() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="6.3" fill="none" stroke="#C9C9C6" strokeWidth="1.3" strokeDasharray="2.2 1.8" />
      <path d="M8 5.3v5.4M5.3 8h5.4" stroke="#9A9A98" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** "Choose bots" or "Bots": opens the picker under it, and closes it. */
function BotsToggle({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-expanded={open} onClick={onClick} className="flex shrink-0 items-center gap-0.5 rounded-full text-[12px] font-medium leading-4 text-[#3A3A38] hover:text-ink">
      {label}
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
        <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/* ---------------- Add someone ---------------- */

/**
 * The invite form while the plan has room (with "1 of 2 people" beside it), else why not and the upgrade
 * that has room, in the plan's words (lib/plan-includes.ts peopleShort, with orgo-web's numbers). Without
 * orgo-web's numbers nobody is added: it couldn't read the plan, or it's an orgo-web from before its plan
 * rule. What the last invite did is kept here, not in the form: the invite that takes the last seat swaps
 * the form for the plan's block, and its line (an email that didn't go out, with its link) stays under it.
 */
function AddSomeone({ info, state, bots, act, onRetry, onUpgrade }: { info: Ready; state: AppState; bots: Bot[] | null; act: Act; onRetry: () => void; onUpgrade: () => void }) {
  const [said, setSaid] = useState<Said | null>(null);
  // "Sent" for a moment on the button, and "Invite sent to …" for a few seconds under it.
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 1500);
    return () => clearTimeout(t);
  }, [sent]);
  useEffect(() => {
    if (!said?.brief) return;
    const t = setTimeout(() => setSaid((x) => (x === said ? null : x)), 4000);
    return () => clearTimeout(t);
  }, [said]);
  const line = said && <SaidLine said={said} />;
  const s = info.seats;
  if (!s)
    return (
      <Section title="Add someone">
        {info.seatsError === "ORGO_NOT_READY" ? (
          <Notice>{WORDS.orgoNotReady}</Notice>
        ) : (
          <Notice
            action={
              <button onClick={onRetry} className={quiet}>
                Try again
              </button>
            }
          >
            {WORDS.planUnavailable}
          </Notice>
        )}
        {/* The notice says why adding waits, so only what an invite did before is kept: sent, or its link. */}
        {said?.tone === "muted" && line}
      </Section>
    );
  const waiting = info.invites.filter((i) => !i.expired).length;
  const short = peopleShort(s, { withAccess: info.people.length, invited: waiting });
  // Over the limit (a plan changed after they joined), the block says how many: "4 of 2" would only puzzle.
  // A limit of 0 has nothing to count; any other limit shows it, Free's too.
  const aside = s.limit === 0 || (s.limit !== null && s.used > s.limit) ? null : peopleAside(s);
  const counter = aside && (
    <span data-tip="People with access, and invites still waiting" className="text-[12px] tabular-nums text-[#9A9A98]">
      {aside}
    </span>
  );
  if (s.canAdd)
    return (
      <Section title="Add someone" aside={counter}>
        <InviteForm info={info} bots={bots} act={act} sent={sent} onSent={setSent} onSaid={setSaid} />
        {line}
      </Section>
    );
  // Only an upgrade orgo-web offers: with none (Bops plans aren't sold now), no button that leads nowhere.
  const upgrade = s.upgrade && (short ? short.upgrade : s.upgrade);
  // An Admin's sheet: the plan is the owner's to change. Ask the owner only when there's more to get (an upgrade orgo-web offers, or the Orgo plan when billed by use).
  if (info.shared)
    return (
      <Section title="Add someone" aside={counter}>
        <Notice>
          {short?.text ?? WORDS.upgradeRequired}
          {s.upgrade || s.plan === "usage" ? ` ${ADMIN_SHEET_WORDS.seats}` : ""}
        </Notice>
        {line}
      </Section>
    );
  return (
    <Section title="Add someone" aside={counter}>
      <Notice
        action={
          upgrade && (
            <button onClick={onUpgrade} className={`${pill} shrink-0 bg-ink text-white`}>
              {upgradeLabel(upgrade)}
            </button>
          )
        }
      >
        {short?.text ?? WORDS.upgradeRequired}
        {short?.note && <span className="block text-[#6B6B6B]">{short.note}</span>}
        {s.plan === "free_bops" && s.limit === 0 && <OrgoPlanLine state={state} />}
      </Notice>
      {line}
    </Section>
  );
}

/** On a Free that adds nobody, for someone who pays for Orgo: that plan is for their other Orgo workspaces, not the bots' computers. */
function OrgoPlanLine({ state }: { state: AppState }) {
  const tier = usePlan(state)?.plan?.tier;
  if (!tier || tier.toLowerCase() === "free") return null;
  return <span className="block text-[#6B6B6B]">Your Orgo plan covers your other Orgo workspaces, not your bots&apos; computers.</span>;
}

/** What the last invite did (muted, or red for a problem), with the invite's link when the email didn't go out. */
type Said = { tone: "muted" | "bad"; text: string; link?: string; brief?: true };

/** The line under the form, or under the plan's block once the invite took the last seat. */
function SaidLine({ said }: { said: Said }) {
  return (
    <span role={said.tone === "bad" ? "alert" : "status"} className={`flex flex-wrap items-center gap-x-2 text-[12px] leading-4 ${said.tone === "bad" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>
      {said.text}
      {said.link && <CopyLink link={said.link} />}
    </span>
  );
}

/**
 * Invite someone by email, as a Member each time it opens and after every invite (or an Admin, with its one
 * warning under the field, and no bots to pick: an Admin has every bot), and a Member's bots: every bot
 * there now to read and bots made later hidden (inviteDefault) until the user chooses, under Choose bots.
 * The address is checked here first: its shape, not the user's own, not someone who has access. Typing an
 * address with an invite waiting sends that invite again, with the bots it has unless others are chosen
 * (they show, and the picker starts from them, as soon as the address is typed). What happened goes
 * to AddSomeone (`onSaid`, `onSent`), which outlasts the form. With a shared workspace open (`bots` null)
 * there are no bots to pick, and the invite goes without any: a new one then sees no bot until chosen,
 * and one sent again keeps what it had (lib/server/members.ts invite).
 */
function InviteForm({
  info,
  bots,
  act,
  sent,
  onSent,
  onSaid,
}: {
  info: Ready;
  bots: Bot[] | null;
  act: Act;
  sent: boolean;
  onSent: (sent: boolean) => void;
  onSaid: Dispatch<SetStateAction<Said | null>>;
}) {
  const summary = useSummary();
  const scopeShown = useContext(AppsScope).shown;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("viewer");
  // The bots chosen, null for the default: it follows the workspace's bots until the user picks.
  const [chosen, setChosen] = useState<MemberAccess | null>(null);
  // Open from the start: what they get is in front of the user before it's sent, never behind a toggle.
  const [choosing, setChoosing] = useState(true);
  const [busy, setBusy] = useState(false);
  const ids = bots?.map((b) => b.id) ?? [];
  const waiting = info.invites.find((i) => i.email === email.trim().toLowerCase());
  const again = !!waiting;
  // An invite sent again keeps its bots, as its row's Resend does: never every bot, unasked.
  const access = chosen ?? waiting?.access ?? inviteDefault(ids);
  const picked = role;
  // An Admin has every bot: there's nothing to pick, and nothing is sent.
  const picking = !!bots && picked === "viewer";

  const send = async () => {
    const address = emailOf(email);
    if (!address) return onSaid({ tone: "bad", text: WORDS.badEmail });
    if (info.you.email?.toLowerCase() === address) return onSaid({ tone: "bad", text: WORDS.self });
    if (info.people.some((p) => p.email?.toLowerCase() === address)) return onSaid({ tone: "bad", text: WORDS.alreadyIn(address) });
    setBusy(true);
    onSaid(null);
    // The sheet reads who has access again before this answers: an invite that took the last seat has
    // already swapped this form for the plan's block, so what happened is said by AddSomeone.
    const r = await act("POST", { email: address, role: picked, ...(picking ? { access } : {}) });
    setBusy(false);
    if (r.status !== 200) return onSaid({ tone: "bad", text: saidOf(r) });
    const made = r.json as InviteSent;
    setEmail("");
    setRole("viewer");
    setChosen(null);
    setChoosing(true);
    onSent(made.emailSent);
    onSaid(
      made.emailSent
        ? { tone: "muted", text: `Invite sent to ${made.email}.`, brief: true }
        : { tone: "muted", text: "Invite made, but the email didn't go out. Copy the link and send it to them yourself.", ...(made.link ? { link: made.link } : {}) },
    );
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim() && !busy) void send();
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <input
          type="email"
          autoFocus
          value={email}
          readOnly={busy}
          maxLength={254}
          onChange={(e) => {
            setEmail(e.target.value);
            onSaid((x) => (x?.tone === "bad" ? null : x));
          }}
          placeholder="name@example.com"
          aria-label="Their email"
          autoComplete="off"
          className="h-10 min-w-0 flex-1 rounded-full bg-white px-4 text-[14px] shadow-[0_0_0_1px_#E6E6E3] outline-none placeholder:text-[#9A9A98] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
        />
        <AccessPicker value={role} onChange={setRole} disabled={busy} />
        <button type="submit" disabled={!email.trim() || busy} className="h-10 shrink-0 rounded-full bg-ink px-4 text-[13px] font-medium text-white disabled:opacity-50">
          {busy ? "Sending…" : sent ? "Sent" : again ? "Resend invite" : "Send invite"}
        </button>
      </div>
      {picking && (
        <span className="flex min-w-0 items-center gap-2 pt-0.5 text-[12.5px] leading-[18px] text-[#6B6B6B]">
          <span data-access-summary className="truncate">
            {summary(access, ids)}
          </span>
          <BotsToggle open={choosing} label={scopeShown ? "Choose access" : "Choose bots"} onClick={() => setChoosing((x) => !x)} />
        </span>
      )}
      {picking && choosing && <BotAccess bots={bots} value={access} onChange={setChosen} disabled={busy} invite />}
      <RoleLine role={picked} />
    </form>
  );
}

/** The role words for this sheet: the owner's, or an Admin's of a workspace shared with them (SheetScope), where the apps and the workspace are the owner's. */
const useRoleLines = () => (useContext(SheetScope) ? ROLE_LINES_SHARED : ROLE_LINES);

/** What the picked role means. An Admin's is the one warning before it's sent, marked like what needs the user. */
function RoleLine({ role }: { role: MemberRole }) {
  const lines = useRoleLines();
  return role === "admin" ? (
    <span className="flex items-start gap-1.5 pt-0.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
      <NeedsYouDot className="mt-px" />
      {lines.admin}
    </span>
  ) : (
    <span className="pt-0.5 text-[12.5px] leading-[18px] text-[#6B6B6B]">{lines.viewer}</span>
  );
}

/** Member or Admin, as a segmented control named Role: one choice makes someone an Admin (only once Bops Cloud gives people their role: AppsScope.roles). */
function AccessPicker({ value, onChange, disabled }: { value: MemberRole; onChange: (role: MemberRole) => void; disabled?: boolean }) {
  const { roles } = useContext(AppsScope);
  const lines = useRoleLines();
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-[12px] text-[#9A9A98]">Role</span>
      <div role="radiogroup" aria-label="Their role" className={`flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px] ${disabled ? "opacity-50" : ""}`}>
        {(["viewer", "admin"] as const).map((r) => {
          const on = value === r;
          // Not offered yet: Bops Cloud would give an Admin no bots (someone an Admin already can still be made a Member).
          const held = r === "admin" && !roles && !on;
          return (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled || held}
              data-tip={held ? WORDS.fullAccessNotYet : r === "admin" ? lines.admin : lines.viewer}
              onClick={() => !on && onChange(r)}
              className={`rounded-full px-2.5 py-1 text-[12px] leading-4 ${on ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : held ? "text-[#B5B5B3]" : "text-[#6B6B6B] hover:text-ink"}`}
            >
              {ROLE_NAMES[r]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Who has access ---------------- */

/** A person's initials on a circle: the user's in ink and highlighter, as on Account. */
function Face({ label, you }: { label: string; you?: boolean }) {
  return (
    <span className={`flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${you ? "bg-ink text-highlighter" : "bg-[#EEEEEC] text-[#6B6B6B]"}`}>
      {initialsFrom(label)}
    </span>
  );
}

const row = "group flex flex-col border-b border-[#F0F0EE] px-3.5 py-3 last:border-0";
const rowAction = "rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";

/**
 * The grey line under a name: who (their email, or how a guest joined) and, after a dot, which bots they
 * see, kept whole while the email is cut short.
 */
function SubLine({ who, children }: { who?: string | null; children?: React.ReactNode }) {
  if (!who && !children) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-4 text-[#6B6B6B]">
      {/* Who first: their access line beside it gives way before it does. */}
      {who && <span className={`truncate ${children ? "max-w-[55%] shrink-0" : ""}`}>{who}</span>}
      {who && children && <span aria-hidden>·</span>}
      {children}
    </span>
  );
}

/** The user first (they own it all, every bot), then everyone else by name, each with what they can do. */
function WhoHasAccess({ info, bots, act }: { info: Ready; bots: Bot[] | null; act: Act }) {
  // (In an Admin's sheet, `you` is the owner: no controls, and what stays theirs.)
  const you = info.you;
  const shared = !!info.shared;
  return (
    <Section title="Who has access">
      <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
        <div className={row}>
          <div className="flex items-center gap-3">
            <Face label={you.name} you={!shared} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[14px] font-medium leading-[18px]">{you.name}</span>
                {!shared && <Badge>You</Badge>}
              </span>
              <SubLine who={you.email && you.email !== you.name ? you.email : null}>
                <span className="shrink-0">Every bot</span>
              </SubLine>
              {shared && <span data-owner-line className="text-[12px] leading-4 text-[#6B6B6B]">{ADMIN_SHEET_WORDS.owner}</span>}
            </div>
            <span className="shrink-0 text-[12.5px] text-[#9A9A98]">Owner</span>
          </div>
        </div>
        {info.people.map((p) => (
          <PersonRow key={p.id} person={p} bots={bots} act={act} />
        ))}
        {!info.people.length && <div className="px-3.5 py-3 text-[12.5px] leading-4 text-[#9A9A98]">Just you so far.</div>}
      </div>
    </Section>
  );
}

/**
 * Someone with access: who, their role, and a Member's bots (an Admin has every bot, so there's nothing to pick). Under Bots, every
 * bot change is saved at once (PATCH {memberId, access}), one at a time with the newest last, and shown
 * as picked while it saves; one that's turned down goes back to what was saved, with why under the row.
 * Use its computer goes to orgo-web first (lib/server/members.ts): one orgo-web turns down stays as it was, the same way.
 * Member applies at once (back to the bots they had as one); Admin asks first. Remove asks first too. Removing an
 * Admin, or making them a Member, says that a computer password they copied keeps working: never "access ended"
 * when it hasn't.
 */
function PersonRow({ person: p, bots, act }: { person: Person; bots: Bot[] | null; act: Act }) {
  const summary = useSummary();
  const scopeShown = useContext(AppsScope).shown;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // They were made a Member here: they may still hold what being an Admin gave them.
  const [demoted, setDemoted] = useState(false);
  const [asking, setAsking] = useState<"remove" | "full" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // The bots as picked while that's saving; then what was saved, until Team reads them again
  // (`from`: what it had read for them when that save landed), so a read that fails after a save
  // doesn't show the old ones.
  const [draft, setDraft] = useState<MemberAccess | null>(null);
  const [kept, setKept] = useState<{ from: MemberAccess; to: MemberAccess } | null>(null);
  const [saving, setSaving] = useState(false);
  const sending = useRef(false);
  const queued = useRef<MemberAccess | null>(null);
  const access = draft ?? (kept && kept.from === p.access ? kept.to : p.access);
  const ids = bots?.map((b) => b.id) ?? [];
  const pick = async (next: MemberAccess) => {
    setDraft(next);
    setError(null);
    queued.current = next;
    if (sending.current) return;
    sending.current = true;
    setSaving(true);
    // What Team has for them: as rendered now, then as each save's read after it came back (this
    // render's `p` is never read again, so a save queued behind another is held to the newer read).
    let from = p.access;
    while (queued.current) {
      const send = queued.current;
      queued.current = null;
      const r = await act("PATCH", { memberId: p.id, access: send });
      if (r.status !== 200) {
        queued.current = null;
        setError(errorOf(r, usesComputer(send) !== usesComputer(from) ? "Couldn't change Use its computer. Try again." : "Couldn't change their bots. Try again."));
        break;
      }
      const read = r.read?.state === "ready" ? r.read.people.find((x) => x.id === p.id) : undefined;
      if (read) from = read.access;
      setKept({ from, to: send });
    }
    sending.current = false;
    setSaving(false);
    setDraft(null);
  };
  const keysCloud = useContext(AppsScope).keys !== false;
  // Keys, as picked while it saves, then as orgo-web's list says (an Admin's always on).
  const [keysDraft, setKeysDraft] = useState<boolean | null>(null);
  const keysNow = p.role === "admin" || (keysDraft ?? p.keys === true);
  const pickKeys = async (on: boolean) => {
    setKeysDraft(on);
    setError(null);
    const r = await act("PATCH", { memberId: p.id, keys: on });
    if (r.status !== 200) {
      setKeysDraft(null);
      setError(errorOf(r, KEYS_WORDS.unchanged));
      return;
    }
    const read = r.read?.state === "ready" ? r.read.people.find((x) => x.id === p.id) : undefined;
    // orgo-web's list says it now: shown as it says; one that doesn't say yet keeps what was picked.
    if (read?.keys !== undefined) setKeysDraft(null);
  };
  const hadFull = p.role === "admin" || demoted;
  const admin = p.role === "admin";
  // An Admin's sheet of a shared workspace: their own row is "You" (Leave), and nothing changes while they may not change people.
  const sheet = useContext(SheetScope);
  const me = !!sheet && sheet.me === p.id;
  const locked = !!sheet && !sheet.can;
  // A computer password they copied as an Admin outlasts it, until the computer's password changes.
  const copied = hadFull;
  const change = async (role: MemberRole) => {
    setBusy(true);
    setError(null);
    setConfirmError(null);
    const r = await act("PATCH", { memberId: p.id, role });
    setBusy(false);
    if (r.status === 200) {
      if (role === "viewer" && p.role === "admin") setDemoted(true);
      return setAsking(null);
    }
    const text = errorOf(r, "Couldn't change their access. Try again.");
    if (asking) setConfirmError(text);
    else setError(text);
  };
  const remove = async () => {
    setBusy(true);
    setConfirmError(null);
    const r = await act("DELETE", { memberId: p.id });
    setBusy(false);
    if (r.status !== 200) setConfirmError(errorOf(r, "Couldn't remove them. Try again."));
  };
  return (
    <div className={row}>
      <div className="flex items-center gap-3">
        <Face label={p.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-medium leading-[18px]">{p.name}</span>
            {me && <Badge>You</Badge>}
            {p.guest && <Badge>Guest</Badge>}
          </span>
          <SubLine who={p.guest ? "Joined with a link on orgo.ai" : p.email && p.email !== p.name ? p.email : null}>
            {admin && (
              <span data-access-summary className="min-w-0 truncate" title={ADMIN_WORDS.row}>
                {ADMIN_WORDS.row}
              </span>
            )}
            {bots && !admin && (
              <>
                <span data-access-summary className="min-w-0 truncate" title={[summary(access, ids), keysNow && KEYS_WORDS.summary].filter(Boolean).join(" · ")}>
                  {[summary(access, ids), keysNow && KEYS_WORDS.summary].filter(Boolean).join(" · ")}
                </span>
                {!locked && <BotsToggle open={choosing} label={scopeShown ? "Access" : "Bots"} onClick={() => setChoosing((x) => !x)} />}
                {saving && <Spinner size={11} color="#9A9A98" />}
              </>
            )}
          </SubLine>
        </div>
        {/* Their own row on an Admin's sheet: Leave only (shared-people.ts refuses a change to their own role). */}
        {locked || me ? <span className="shrink-0 text-[12.5px] text-[#9A9A98]">{ROLE_NAMES[p.role]}</span> : <AccessPicker value={p.role} disabled={busy} onChange={(role) => (role === "admin" ? setAsking("full") : void change(role))} />}
        {/* Asked in place: while it asks, its question under the row stands for it. */}
        {asking !== "remove" && (!locked || me) && (
          <button onClick={() => setAsking("remove")} className={`${rowAction} shrink-0 text-[#B42318] hover:bg-[#FEF3F2]`}>
            {me ? "Leave" : "Remove"}
          </button>
        )}
      </div>
      {bots && choosing && !admin && (
        <div className="flex flex-col gap-2 pl-12 pt-2">
          {/* Keys: a scope of its own, kept by orgo-web (lib/server/members.ts changeKeys), beside Use its computer. */}
          {/* A share link's guest never gets Keys (orgo-web refuses it): shown off, with why; one on still turns off. */}
          <BotAccess
            bots={bots}
            value={access}
            onChange={(next) => void pick(next)}
            keys={{
              on: keysNow,
              onChange: (on) => void pickKeys(on),
              disabled: locked || (p.guest && !keysNow),
              note: p.guest ? KEYS_WORDS.guest : keysCloud ? (sheet ? KEYS_WORDS.legendShared : KEYS_WORDS.legend) : KEYS_WORDS.notYet,
            }}
          />
        </div>
      )}
      {/* An Admin always has Keys, and may change everything but delete the workspace: shown on and locked. */}
      {admin && (
        <div className="flex flex-col gap-2 pl-12 pt-2">
          <PowerRows locked lead={<KeysRow on locked />} />
        </div>
      )}
      {error && (
        <span role="alert" className="pl-12 pt-1.5 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
      {copied && p.role === "viewer" && (
        <span role="status" className="pl-12 pt-1.5 text-[12px] leading-4 text-[#6B6B6B]">
          {`${sheet ? ADMIN_WORDS.toMemberTipShared : ADMIN_WORDS.toMemberTip} ${WORDS.copiedPassword}`}
        </span>
      )}
      {asking === "remove" && (
        <Confirm
          title={me ? "Leave this workspace?" : `Remove ${p.name}?`}
          line={
            me
              ? "You lose access to its bots and their computers right away. The owner or an Admin can add you again."
              : `They lose access to ${sheet ? "the bots" : "your bots"} and their computers right away.${hadFull ? " Anything they changed on the computers stays." : ""}${copied ? ` ${WORDS.copiedPassword}` : ""}`
          }
          action={me ? "Leave" : "Remove"}
          danger
          busy={busy}
          error={confirmError}
          onConfirm={() => void remove()}
          onClose={() => {
            setAsking(null);
            setConfirmError(null);
          }}
        />
      )}
      {asking === "full" && (
        <Confirm
          title={ADMIN_WORDS.confirmTitle(p.name)}
          line={sheet ? ADMIN_WORDS.confirmBodyShared : ADMIN_WORDS.confirmBody}
          action={ADMIN_WORDS.confirm}
          busy={busy}
          error={confirmError}
          onConfirm={() => void change("admin")}
          onClose={() => {
            setAsking(null);
            setConfirmError(null);
          }}
        />
      )}
    </div>
  );
}

/* ---------------- Invited ---------------- */

/**
 * Invites still waiting, newest first, and whether they can be accepted now (the plan is checked again when they are):
 * not when the plan includes nobody, or more people are counted than it includes (orgo-web's numbers, never its name).
 */
function Invited({ info, bots, act }: { info: Ready; bots: Bot[] | null; act: Act }) {
  const s = info.seats;
  const free = !!s && s.limit === 0;
  const over = !!s && s.limit !== null && s.used > s.limit;
  const tip = free ? WORDS.invitedNone : WORDS.invitedOver;
  return (
    <Section
      title="Invited"
      aside={
        (free || over) && (
          <span data-tip={tip} className="text-[12px] text-[#9A9A98]">
            Can&apos;t be accepted right now
          </span>
        )
      }
    >
      <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
        {info.invites.map((i) => (
          <InviteRow key={i.email} invite={i} bots={bots} canSend={!!s} act={act} />
        ))}
      </div>
    </Section>
  );
}

/**
 * An invite: to whom, their role (changed in place, without sending it again: PATCH {invite, role}), a Member's bots,
 * and when it expires. Resend (Send again once it's expired) emails a new link, with the same role and bots, and the
 * old one stops working; Copy link is for sending it another way; Cancel asks once. None is sent while adding people
 * waits for orgo-web's numbers (`canSend` false: the route would turn it down). An orgo-web that can't change a waiting
 * invite's role says so, and Resend then sends it with the role picked.
 */
function InviteRow({ invite: i, bots, canSend, act }: { invite: Invite; bots: Bot[] | null; canSend: boolean; act: Act }) {
  const summary = useSummary();
  const [busy, setBusy] = useState<"resend" | "cancel" | "role" | null>(null);
  // The role picked here when orgo-web couldn't change it in place: Resend sends it with that one.
  const [role, setRole] = useState<MemberRole>(i.role);
  const [sure, setSure] = useState(false);
  const [sent, setSent] = useState(false);
  // A minute between sends.
  const [resting, setResting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 1500);
    return () => clearTimeout(t);
  }, [sent]);
  useEffect(() => {
    if (!resting) return;
    const t = setTimeout(() => setResting(false), 60_000);
    return () => clearTimeout(t);
  }, [resting]);
  const resend = async () => {
    setBusy("resend");
    setError(null);
    const r = await act("POST", { email: i.email, role, ...(role === "viewer" ? { access: i.access } : {}) });
    setBusy(null);
    // A plan refusal says why in the plan's words; anything else is the row's plain line.
    if (r.status !== 200) return setError(r.status === 402 ? saidOf(r) : errorOf(r, "Couldn't resend. Try again."));
    setSent(true);
    setResting(true);
  };
  const cancel = async () => {
    setBusy("cancel");
    setError(null);
    const r = await act("DELETE", { email: i.email });
    setBusy(null);
    setSure(false);
    if (r.status !== 200) setError(errorOf(r, "Couldn't cancel the invite. Try again."));
  };
  const changeRole = async (next: MemberRole) => {
    setBusy("role");
    setError(null);
    setRole(next);
    const r = await act("PATCH", { invite: i.email, role: next });
    setBusy(null);
    if (r.status === 200) return;
    // An orgo-web before it: the role stays picked here, for Resend.
    if ((r.json as Partial<MembersRefusal>).code === "INVITE_ROLE_NOT_READY") return setError(ADMIN_WORDS.inviteRoleNotReady);
    setRole(i.role);
    setError(errorOf(r, "Couldn't change their role. Try again."));
  };
  const canResend = canSend;
  const showing = busy === "resend" || sent;
  return (
    <div className={row}>
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#F7F7F6] text-[13px] font-semibold uppercase text-[#9A9A98] shadow-[inset_0_0_0_1px_#E6E6E3]">
          {i.email[0]}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-medium leading-[18px]">{i.email}</span>
          <span data-access-summary className="truncate text-[12.5px] leading-4 text-[#6B6B6B]">
            {role === "admin" ? ADMIN_WORDS.row : bots && summary(i.access, bots.map((b) => b.id))}
            {i.expiresAt !== null && `${role === "admin" || bots ? " · " : ""}${i.expired ? "expired" : "expires"} ${day(i.expiresAt)}`}
          </span>
        </div>
        {!sure && <AccessPicker value={role} disabled={!!busy} onChange={(next) => void changeRole(next)} />}
        {sure ? (
          <span className="motion-rise-in flex shrink-0 items-center gap-1">
            <button disabled={!!busy} onClick={() => void cancel()} className="rounded-full bg-[#B42318] px-2.5 py-1 text-[12px] font-semibold leading-4 text-white disabled:opacity-50">
              {busy === "cancel" ? "Cancelling…" : "Cancel invite"}
            </button>
            <button disabled={!!busy} onClick={() => setSure(false)} className="rounded-full px-2 py-1 text-[12px] leading-4 text-[#6B6B6B]">
              Keep
            </button>
          </span>
        ) : (
          <span className={`flex shrink-0 items-center gap-1 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${showing ? "opacity-100" : "opacity-0"}`}>
            {canResend && (
              <button
                disabled={!!busy || resting}
                data-tip={resting ? "Sent. You can send it again in a minute." : "Sends a new email. The old link stops working."}
                onClick={() => void resend()}
                className="rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-50"
              >
                {busy === "resend" ? "Sending…" : sent ? "Sent" : i.expired ? "Send again" : "Resend"}
              </button>
            )}
            {i.link && <CopyLink link={i.link} tip={`Works only for someone signed in to Orgo as ${i.email}`} />}
            <button disabled={!!busy} onClick={() => setSure(true)} className="rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-[#B42318] hover:bg-[#FEF3F2]">
              Cancel
            </button>
          </span>
        )}
      </div>
      {error && (
        <span role="alert" className="pl-12 pt-1.5 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
}

/** An invite's link, copied to send another way: "Copied" for a moment after. */
function CopyLink({ link, tip }: { link: string; tip?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      data-tip={copied ? undefined : tip}
      onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}
      className="rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]"
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

/* ---------------- Asking first ---------------- */

/**
 * "Remove Jamie?" or "Give Jamie Full access?", asked in place under their row (ui.tsx AskInPlace). Esc is Cancel,
 * and only Cancel: the page stays.
 */
function Confirm({
  title,
  line,
  action,
  danger,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  line: string;
  action: string;
  danger?: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="pt-2">
      <AskInPlace compact title={title} line={line} action={action} danger={danger} busy={busy} error={error} onConfirm={onConfirm} onCancel={onClose} />
    </div>
  );
}
