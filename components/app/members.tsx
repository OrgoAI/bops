"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trackEvent } from "@/lib/analytics";
import { emailOf, ROLE_LINES, ROLE_NAMES, WORDS, type FullAccess, type Invite, type InviteSent, type MemberRole, type MembersInfo, type MembersRefusal, type Person } from "@/lib/members";
import { peopleAside, peopleShort, upgradeLabel } from "@/lib/plan-includes";
import type { AppState } from "@/lib/types";
import { initialsFrom, LoadFailed, Notice, Placeholder, Section, signOutOfOrgo } from "./account";
import { Spinner } from "./mascot";
import { usePlan } from "./plan-note";
import { CloseButton, NeedsYouDot } from "./ui";
import { Badge } from "./vault";

/*
 * People: who can see the user's bots' computers on orgo.ai, from the button at the bottom left of the
 * sidebar. They're the members of the user's Orgo workspace named "bops", which holds the computers of
 * every Bops workspace: the user invites people by email, sends an invite again or cancels it, changes
 * what someone can do (View only, or Full access when the app offers it) and removes people. Bops keeps
 * none of it: everything comes from GET /api/members (lib/server/members.ts), which reads Orgo with the
 * user's key, and orgo-web decides who may be added (Free nobody, Pro 2 people, Max up to 5). The app
 * never makes share links: a link lets in whoever holds it.
 */

/* ---------------- The button and its count ---------------- */

/** Every count on the page, so a change in the sheet shows on the button at once (like refreshState). */
const counters = new Set<() => void>();
export const refreshMembersCount = () => counters.forEach((read) => read());

/**
 * How many people have access besides the user (GET /api/members?count=1): null while it isn't known, and
 * when there's none to show (signed out, self-hosted). Read when someone signs in, again when Bops comes
 * back to the front (at most once a minute), and after every change in the sheet.
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
 * The People button, beside the user's initials: two people, and a grey count of who has access besides
 * the user (guests too, invites not). Grey, not highlighter: nothing here needs the user.
 */
export function MembersButton({ state, onClick }: { state: AppState; onClick: () => void }) {
  const count = useMembersCount(state);
  return (
    <button
      onClick={onClick}
      title="People: who can see your bots' computers"
      aria-label={count ? `People, ${count} with access` : "People"}
      className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FCFCFB]"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="6" cy="5.6" r="2.4" fill="none" stroke="#0A0A0A" strokeWidth="1.4" />
        <path d="M1.8 13.2c.6-2.3 2.2-3.5 4.2-3.5s3.6 1.2 4.2 3.5" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M10.4 3.5a2.4 2.4 0 010 4.4M12 9.9c1.2.4 2 1.5 2.3 3.3" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {count ? (
        <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#EEEEEC] px-1 text-[11px] font-semibold leading-none tabular-nums text-[#3A3A38] shadow-[0_0_0_2px_#F9F9F8]">
          {count}
        </span>
      ) : null}
    </button>
  );
}

/* ---------------- The sheet ---------------- */

type Ready = Extract<MembersInfo, { state: "ready" }>;
/** What the route answered: a state, or why it couldn't say ({code, error}). */
type Read = MembersInfo | (MembersRefusal & { state?: undefined });
/** A change's answer: its status (0: Bops itself didn't answer) and JSON. */
type Answer = { status: number; json: Record<string, unknown> };
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
 * The People sheet, over the app like Account and Settings: Esc or a click outside closes it (a dialog
 * on it closes first). It reads who has access as it opens, again when Bops comes back to the front and
 * every 30 seconds while it's open, showing what it has meanwhile. `onUpgrade` opens the plans (Account),
 * on top of it.
 */
export function Members({ state, onClose, onUpgrade }: { state: AppState; onClose: () => void; onUpgrade: () => void }) {
  const [read, setRead] = useState<Read | null>(null);
  const [loading, setLoading] = useState(true);
  // The route itself failed (a 500, or not JSON): the sheet says so and offers a retry.
  const [failed, setFailed] = useState(false);
  const shown = useRef<Read | null>(null);
  /** Read it again. `quiet`: in the background, where a hiccup keeps what's shown rather than an error over it. */
  const load = useCallback(
    ({ quiet = false } = {}) =>
      fetch("/api/members", { cache: "no-store" })
        .then((res) => res.json() as Promise<Read>)
        .then((j) => (j && typeof j === "object" && (typeof j.state === "string" || typeof (j as MembersRefusal).code === "string") ? j : null))
        .catch(() => null)
        .then((next) => {
          setLoading(false);
          if (quiet && shown.current?.state === "ready" && !next?.state) return;
          if (!next) return setFailed(true);
          shown.current = next;
          setRead(next);
          setFailed(false);
        }),
    [],
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
        const res = await fetch("/api/members", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        status = res.status;
        json = ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
      } catch {
        status = 0;
      }
      await load({ quiet: true });
      refreshMembersCount();
      return { status, json };
    },
    [load],
  );

  // Counted once a sheet has shown who has access.
  const opened = useRef(false);
  const people = read?.state === "ready" ? read.people.length : null;
  useEffect(() => {
    if (people === null || opened.current) return;
    opened.current = true;
    trackEvent("bops_members_opened", { people });
  }, [people]);

  const signOut = async () => {
    await signOutOfOrgo();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="members-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-[760px] flex-col overflow-y-auto rounded-[22px] bg-white shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#F0F0EE] px-[22px] py-[18px]">
          <div className="flex flex-col gap-0.5">
            <span id="members-title" className="text-[18px] font-semibold leading-[22px]">
              People
            </span>
            <span className="text-[13px] leading-[17px] text-[#6B6B6B]">Who can see your bots&apos; computers, in every workspace. Never this Mac.</span>
          </div>
          <CloseButton onClick={onClose} />
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
              <Notice
                action={
                  <button onClick={() => void signOut()} className={quiet}>
                    Sign out
                  </button>
                }
              >
                {read.why === "rejected" ? WORDS.rejected : WORDS.noKey}
              </Notice>
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

        {read?.state === "ready" ? (
          <div className="px-[22px] pb-5 pt-5 text-[12px] leading-4 text-[#9A9A98]">
            People you add sign in on orgo.ai with the email you invite. They see whatever is on your bots&apos; screens, like an open inbox, but never this Mac, your chats or
            your vault.{" "}
            <a href={read.orgoUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
              Open on orgo.ai
            </a>
          </div>
        ) : (
          <div className="pb-5" />
        )}
      </div>
    </div>
  );
}

/** Who has access, and adding people: the sheet once Orgo has said. */
function ReadyView({ info, state, act, onRetry, onUpgrade }: { info: Ready; state: AppState; act: Act; onRetry: () => void; onUpgrade: () => void }) {
  const someoneFull = info.people.some((p) => p.role === "admin");
  return (
    <>
      {(info.fullAccess === "off" || info.host === "mac") && (
        <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
          {info.fullAccess === "off" && (
            <Notice>
              Your bots&apos; computers hold keys from this Mac, so Full access is off.
              {someoneFull && " Anyone who already has it can read the keys Bops puts on those computers. Switch them to View only."}
            </Notice>
          )}
          {info.host === "mac" && <Notice>Right now your bots work on this Mac, which people you add never see. They&apos;d only see your bots&apos; cloud computers.</Notice>}
        </div>
      )}
      <AddSomeone info={info} state={state} act={act} onRetry={onRetry} onUpgrade={onUpgrade} />
      <WhoHasAccess info={info} act={act} />
      {info.invites.length > 0 && <Invited info={info} act={act} />}
    </>
  );
}

/* ---------------- Add someone ---------------- */

/**
 * The invite form while the plan has room (with "1 of 2 people" beside it), else why not and the upgrade
 * that has room, in the plan's words (lib/plan-includes.ts peopleShort, with orgo-web's numbers).
 */
function AddSomeone({ info, state, act, onRetry, onUpgrade }: { info: Ready; state: AppState; act: Act; onRetry: () => void; onUpgrade: () => void }) {
  const s = info.seats;
  if (!s)
    return (
      <Section title="Add someone">
        <Notice
          action={
            <button onClick={onRetry} className={quiet}>
              Try again
            </button>
          }
        >
          {WORDS.planUnavailable}
        </Notice>
      </Section>
    );
  const waiting = info.invites.filter((i) => !i.expired).length;
  const short = peopleShort(s, { withAccess: info.people.length, invited: waiting });
  // Over the limit (a plan changed after they joined), the block says how many: "4 of 2" would only puzzle.
  const aside = s.limit !== null && s.used > s.limit ? null : peopleAside(s);
  const counter = aside && (
    <span data-tip="People with access, and invites still waiting" className="text-[12px] tabular-nums text-[#9A9A98]">
      {aside}
    </span>
  );
  if (s.canAdd) return <Section title="Add someone" aside={counter}>{<InviteForm info={info} act={act} />}</Section>;
  const upgrade = short ? short.upgrade : s.upgrade;
  return (
    <Section title="Add someone" aside={s.plan === "free_bops" ? null : counter}>
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
        {s.plan === "free_bops" && <OrgoPlanLine state={state} />}
      </Notice>
    </Section>
  );
}

/** On Free, for someone who pays for Orgo: that plan is for their other Orgo workspaces, not the bots' computers. */
function OrgoPlanLine({ state }: { state: AppState }) {
  const tier = usePlan(state)?.plan?.tier;
  if (!tier || tier.toLowerCase() === "free") return null;
  return <span className="block text-[#6B6B6B]">Your Orgo plan covers your other Orgo workspaces, not your bots&apos; computers.</span>;
}

/** The line under the form: what happened last (muted, or red for a problem), with the invite's link when the email didn't go out. */
type Said = { tone: "muted" | "bad"; text: string; link?: string; brief?: true };

/**
 * Invite someone by email, with View only picked each time it opens and after every invite (Full access
 * only when the app offers it, with its one warning under the field). The address is checked here first:
 * its shape, not the user's own, not someone who has access. Typing an address with an invite waiting
 * sends that invite again, with the access picked now.
 */
function InviteForm({ info, act }: { info: Ready; act: Act }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const offer = info.fullAccess;
  const picked = offer === "not_yet" ? "viewer" : role;
  const again = info.invites.some((i) => i.email === email.trim().toLowerCase());
  // "Sent" for a moment on the button, and "Invite sent to …" for a few seconds under it.
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

  const send = async () => {
    const address = emailOf(email);
    if (!address) return setSaid({ tone: "bad", text: WORDS.badEmail });
    if (info.you.email?.toLowerCase() === address) return setSaid({ tone: "bad", text: WORDS.self });
    if (info.people.some((p) => p.email?.toLowerCase() === address)) return setSaid({ tone: "bad", text: WORDS.alreadyIn(address) });
    setBusy(true);
    setSaid(null);
    const r = await act("POST", { email: address, role: picked });
    setBusy(false);
    if (r.status !== 200) return setSaid({ tone: "bad", text: saidOf(r) });
    const made = r.json as InviteSent;
    setEmail("");
    setRole("viewer");
    setSent(made.emailSent);
    setSaid(
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
            setSaid((x) => (x?.tone === "bad" ? null : x));
          }}
          placeholder="name@example.com"
          aria-label="Their email"
          autoComplete="off"
          className="h-10 min-w-0 flex-1 rounded-full bg-white px-4 text-[14px] shadow-[0_0_0_1px_#E6E6E3] outline-none placeholder:text-[#9A9A98] focus:shadow-[0_0_0_1.5px_#0A0A0A]"
        />
        {offer !== "not_yet" && <AccessPicker value={role} onChange={setRole} fullAccess={offer} disabled={busy} />}
        <button type="submit" disabled={!email.trim() || busy} className="h-10 shrink-0 rounded-full bg-ink px-4 text-[13px] font-medium text-white disabled:opacity-50">
          {busy ? "Sending…" : sent ? "Sent" : again ? "Resend invite" : "Send invite"}
        </button>
      </div>
      <RoleLine role={picked} />
      {said && (
        <span role={said.tone === "bad" ? "alert" : "status"} className={`flex flex-wrap items-center gap-x-2 text-[12px] leading-4 ${said.tone === "bad" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>
          {said.text}
          {said.link && <CopyLink link={said.link} />}
        </span>
      )}
    </form>
  );
}

/** What the picked access means. Full access's is the one warning before it's sent, marked like what needs the user. */
function RoleLine({ role }: { role: MemberRole }) {
  return role === "admin" ? (
    <span className="flex items-start gap-1.5 pt-0.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
      <NeedsYouDot className="mt-px" />
      {ROLE_LINES.admin}
    </span>
  ) : (
    <span className="pt-0.5 text-[12.5px] leading-[18px] text-[#6B6B6B]">{ROLE_LINES.viewer}</span>
  );
}

/**
 * View only or Full access, as a segmented control. With Full access off, that choice stays visible but
 * can't be picked, and says why on hover.
 */
function AccessPicker({ value, onChange, fullAccess, disabled }: { value: MemberRole; onChange: (role: MemberRole) => void; fullAccess: FullAccess; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="What they can do on your bots' computers" className={`flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px] ${disabled ? "opacity-50" : ""}`}>
      {(["viewer", "admin"] as const).map((r) => {
        const on = value === r;
        const off = r === "admin" && fullAccess !== "on" && !on;
        return (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={off || undefined}
            disabled={disabled}
            data-tip={off ? WORDS.fullAccessOffTip : undefined}
            onClick={() => !on && !off && onChange(r)}
            className={`rounded-full px-2.5 py-1 text-[12px] leading-4 ${on ? "bg-white text-ink shadow-[0_0_0_1px_#0000000F]" : off ? "cursor-default text-[#C9C9C6]" : "text-[#6B6B6B] hover:text-ink"}`}
          >
            {ROLE_NAMES[r]}
          </button>
        );
      })}
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

/** The user first (they own it all), then everyone else by name, each with what they can do. */
function WhoHasAccess({ info, act }: { info: Ready; act: Act }) {
  const you = info.you;
  return (
    <Section title="Who has access">
      <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
        <div className={row}>
          <div className="flex items-center gap-3">
            <Face label={you.name} you />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[14px] font-medium leading-[18px]">{you.name}</span>
                <Badge>You</Badge>
              </span>
              {you.email && you.email !== you.name && <span className="truncate text-[12.5px] leading-4 text-[#6B6B6B]">{you.email}</span>}
            </div>
            <span className="shrink-0 text-[12.5px] text-[#9A9A98]">Owner</span>
          </div>
        </div>
        {info.people.map((p) => (
          <PersonRow key={p.id} person={p} fullAccess={info.fullAccess} act={act} />
        ))}
        {!info.people.length && <div className="px-3.5 py-3 text-[12.5px] leading-4 text-[#9A9A98]">Just you so far.</div>}
      </div>
    </Section>
  );
}

/**
 * Someone with access: who, and what they can do. View only applies at once; Full access asks first. In
 * the View only release their access is words, and Full access has a Make View only on hover. Remove asks
 * first too.
 */
function PersonRow({ person: p, fullAccess, act }: { person: Person; fullAccess: FullAccess; act: Act }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"remove" | "full" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const change = async (role: MemberRole) => {
    setBusy(true);
    setError(null);
    setConfirmError(null);
    const r = await act("PATCH", { memberId: p.id, role });
    setBusy(false);
    if (r.status === 200) return setAsking(null);
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
            {p.guest && <Badge>Guest</Badge>}
          </span>
          {p.guest ? (
            <span className="truncate text-[12.5px] leading-4 text-[#6B6B6B]">Joined with a link on orgo.ai</span>
          ) : (
            p.email && p.email !== p.name && <span className="truncate text-[12.5px] leading-4 text-[#6B6B6B]">{p.email}</span>
          )}
        </div>
        {fullAccess === "not_yet" ? (
          <>
            {p.role === "admin" && (
              <button disabled={busy} onClick={() => void change("viewer")} className={`${rowAction} text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-50`}>
                {busy ? "Changing…" : "Make View only"}
              </button>
            )}
            <span className="shrink-0 text-[12.5px] text-[#6B6B6B]">{ROLE_NAMES[p.role]}</span>
          </>
        ) : (
          <AccessPicker value={p.role} fullAccess={fullAccess} disabled={busy} onChange={(role) => (role === "admin" ? setAsking("full") : void change(role))} />
        )}
        <button onClick={() => setAsking("remove")} className={`${rowAction} shrink-0 text-[#B42318] hover:bg-[#FEF3F2]`}>
          Remove
        </button>
      </div>
      {error && (
        <span role="alert" className="pl-12 pt-1.5 text-[12px] leading-4 text-[#B42318]">
          {error}
        </span>
      )}
      {asking === "remove" && (
        <Confirm
          title={`Remove ${p.name}?`}
          line={`They lose access to your bots' computers right away.${p.role === "admin" ? " Anything they changed on the computers stays." : ""}`}
          action="Remove"
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
          title={`Give ${p.name} Full access?`}
          line={ROLE_LINES.admin}
          action="Give Full access"
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

/** Invites still waiting, newest first, and whether they can be accepted now (the plan is checked again when they are). */
function Invited({ info, act }: { info: Ready; act: Act }) {
  const s = info.seats;
  const free = !!s && (s.plan === "free_bops" || s.limit === 0);
  const over = !!s && s.limit !== null && s.used > s.limit;
  const plan = s?.plan === "max_bops" ? "Max" : "Pro";
  const tip = free ? "Free doesn't include adding people." : `You have more people than ${plan} includes. ${plan === "Max" ? "Cancel invites or remove people." : "Cancel invites, remove people or upgrade."}`;
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
          <InviteRow key={i.email} invite={i} fullAccess={info.fullAccess} act={act} />
        ))}
      </div>
    </Section>
  );
}

/**
 * An invite: to whom, with what access, and when it expires. Resend (Send again once it's expired) emails
 * a new link and the old one stops working; Copy link is for sending it another way; Cancel asks once.
 * A Full access invite is sent again only while the app offers Full access.
 */
function InviteRow({ invite: i, fullAccess, act }: { invite: Invite; fullAccess: FullAccess; act: Act }) {
  const [busy, setBusy] = useState<"resend" | "cancel" | null>(null);
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
    const r = await act("POST", { email: i.email, role: i.role });
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
  const canResend = i.role === "viewer" || fullAccess === "on";
  const showing = busy === "resend" || sent;
  return (
    <div className={row}>
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#F7F7F6] text-[13px] font-semibold uppercase text-[#9A9A98] shadow-[inset_0_0_0_1px_#E6E6E3]">
          {i.email[0]}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] font-medium leading-[18px]">{i.email}</span>
          <span className="truncate text-[12.5px] leading-4 text-[#6B6B6B]">
            {ROLE_NAMES[i.role]}
            {i.expiresAt !== null && ` · ${i.expired ? "expired" : "expires"} ${day(i.expiresAt)}`}
          </span>
        </div>
        {sure ? (
          <span className="flex shrink-0 items-center gap-1">
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
 * "Remove Jamie?" or "Give Jamie Full access?", over everything (the sheet too), like Restart Bops. Esc
 * closes this alone; the sheet under it stays.
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
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, onClose]);
  const button = "rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-4 disabled:opacity-50";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={() => !busy && onClose()}>
      <div
        role="alertdialog"
        aria-labelledby="member-confirm-title"
        aria-describedby="member-confirm-line"
        onClick={(e) => e.stopPropagation()}
        className="flex w-[340px] flex-col rounded-[18px] bg-white p-5 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <span id="member-confirm-title" className="text-[15px] font-semibold leading-5">
          {title}
        </span>
        <span id="member-confirm-line" className="pt-1 text-[13px] leading-[18px] text-[#6B6B6B]">
          {line}
        </span>
        {error && (
          <span role="alert" className="pt-2 text-[12.5px] leading-[18px] text-[#B42318]">
            {error}
          </span>
        )}
        <div className="flex justify-end gap-2 pt-5">
          <button disabled={busy} onClick={onClose} className={`${button} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
            Cancel
          </button>
          <button autoFocus disabled={busy} onClick={onConfirm} className={`${button} flex min-w-[76px] items-center justify-center text-white ${danger ? "bg-[#B42318]" : "bg-ink"}`}>
            {busy ? <Spinner size={12} color="#FFFFFF" /> : action}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
