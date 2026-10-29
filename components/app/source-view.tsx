"use client";

import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  chatBlocks,
  draftedReply,
  emojiOf,
  fileSize,
  initialOf,
  linkSpans,
  personName,
  recipientsLine,
  safeHref,
  SOURCE_NAME,
  sourceAppOf,
  sourceError,
  type ChatMessage,
  type ChatThread,
  type IssueSource,
  type MailMessage,
  type MailThread,
  type Person,
  type SourceAnswer,
  type SourceFile,
  type Span,
} from "@/lib/source-view";
import { Spinner } from "./mascot";
import { OpenLink } from "./panel-tabs";
import { small } from "./side-group";
import { clockTime } from "./ui";
import { readAllowed } from "./view-only";
import { BRAND } from "@/lib/brand";

/*
 * The email or thread an issue came from, on the issue's page (orbit-issues.tsx IssueView), and a drafted
 * reply's (reply-drafts.tsx): read live from the user's own account when it opens (GET
 * /api/orbit/issues/{id}/source, /api/drafts/source; lib/server/issue-source.ts), never kept here either.
 *
 * Gmail's looks like Gmail: the subject and how many, each message a row with who and when, the older ones
 * folded to a line, the newest open, each opening and folding on a click, Expand all at three or more; open,
 * who it went to (folded "to me, +2"), its words, its quoted history behind Show quoted text, and its files
 * by name and size. Slack's and Discord's look like a thread there: the channel, the first message, "N more
 * replies" folded in the middle of a long one and the newest three, each message with who, when, its words
 * with light marks and its reactions. Under either, a Reply box for the user's own words, sent once.
 *
 * Every word is drawn as text: an email's HTML was made text on the server and is never put in the page (this
 * window can reach Bops' own API, so a script in an email must never run here), no picture of an email's is
 * loaded (tracking pixels), and a link opens the way the app opens any (a tab of its own), only http, https or
 * mailto. In a workspace shared with the user nothing is read: a line says only its owner can see the original.
 */

type Source = { answer: SourceAnswer | null; reload: (quiet?: boolean) => void };

/** The source at `url` (null: nothing to read), read when it's asked for; reload(true) reads it again without blanking it. */
function useSource(url: string | null): Source {
  const [got, setGot] = useState<{ url: string; answer: SourceAnswer } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let on = true;
    const down: SourceAnswer = { error: `Couldn't reach ${BRAND.name}. Try again.`, code: "down" };
    void fetch(tick ? `${url}${url.includes("?") ? "&" : "?"}fresh=1` : url, { cache: "no-store" })
      .then(async (r) => (await r.json().catch(() => null)) as SourceAnswer | null)
      .then((j) => on && setGot({ url, answer: j && ("source" in j || "error" in j) ? j : down }))
      .catch(() => on && setGot({ url, answer: down }));
    return () => {
      on = false;
    };
  }, [url, tick]);
  return {
    answer: url && got?.url === url ? got.answer : null,
    reload: (quiet = false) => {
      if (!quiet) setGot(null);
      setTick((t) => t + 1);
    },
  };
}

/* ---------------- On the issue's page ---------------- */

type IssueLike = { id: string; sourceApp?: string; url?: string; history?: { at: number; who?: string; text: string; kind?: string }[] };

/**
 * The issue's email or thread, with a Reply box under it; nothing for an app Bops can't show (its summary and
 * Open link say it all). `onReplied`: a reply went (its history has a new line).
 */
export function IssueSource({ issue, ws, onReplied }: { issue: IssueLike; ws: string; onReplied?: () => void }) {
  const app = sourceAppOf(issue.sourceApp);
  const url = `/api/orbit/issues/${encodeURIComponent(issue.id)}/source?ws=${encodeURIComponent(ws)}`;
  // A workspace shared with the user: its threads are its owner's, never read from here.
  const allowed = readAllowed(url);
  const { answer, reload } = useSource(app && allowed ? url : null);
  if (!app) return null;
  const label = <span className="px-1 text-[12px] font-medium leading-4 text-[color:var(--c-9a9a98)]">{app === "gmail" ? "Email" : "Thread"}</span>;
  if (!allowed)
    return (
      <div data-source="shared" className="flex flex-col gap-2">
        {label}
        <Quiet>{sourceError("shared", app)}</Quiet>
      </div>
    );
  const drafted = draftedReply(issue.history);
  return (
    <div data-source={answer ? ("source" in answer ? "shown" : answer.code) : "loading"} className="flex flex-col gap-2">
      {label}
      {!answer ? (
        <Reading app={app} />
      ) : "error" in answer ? (
        <Quiet>
          <span>{answer.error}</span>
          {(answer.code === "down" || answer.code === "gone") && (
            <button onClick={() => reload()} className={`${small("plain")} -ml-2.5 self-start`}>
              Try again
            </button>
          )}
        </Quiet>
      ) : (
        <SourceThread source={answer.source} openLink={!issue.url}>
          <ReplyBox
            key={`${answer.source.app}.${answer.source.app === "gmail" ? answer.source.threadId : answer.source.channel.id}`}
            source={answer.source}
            initial={drafted?.text ?? ""}
            hint={drafted ? `${drafted.who && drafted.who !== "Bops" ? `${drafted.who} drafted this reply` : "A reply drafted for this issue"}. Change it as you like.` : undefined}
            send={async (text, all, nonce) => {
              const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws, text, all, nonce }) }).catch(() => null);
              if (!r) return { error: `Couldn't reach ${BRAND.name}. Try again.` };
              const j = ((await r.json().catch(() => null)) ?? {}) as { ok?: boolean; error?: string; sent?: { at: number; to: string }; logged?: boolean };
              if (!r.ok || !j.ok || !j.sent) return { error: j.error ?? "It didn't send." };
              onReplied?.();
              // The thread as it is now, with the reply in it.
              setTimeout(() => reload(true), 1500);
              return { sent: j.sent, logged: j.logged !== false };
            }}
          />
        </SourceThread>
      )}
    </div>
  );
}

/** A drafted reply's email or thread, under its card (reply-drafts.tsx): read only, the card is its reply. */
export function DraftSource({ messageId, draftId, app }: { messageId: string; draftId: string; app: "gmail" | "slack" | "discord" }) {
  const url = `/api/drafts/source?messageId=${encodeURIComponent(messageId)}&draftId=${encodeURIComponent(draftId)}`;
  const allowed = readAllowed(url);
  const { answer, reload } = useSource(allowed ? url : null);
  if (!allowed) return <Quiet>{sourceError("shared", app)}</Quiet>;
  if (!answer) return <Reading app={app} />;
  if ("error" in answer)
    return (
      <Quiet>
        <span>{answer.error}</span>
        {answer.code === "down" && (
          <button onClick={() => reload()} className={`${small("plain")} -ml-2.5 self-start`}>
            Try again
          </button>
        )}
      </Quiet>
    );
  return <SourceThread source={answer.source} openLink />;
}

function Reading({ app }: { app: "gmail" | "slack" | "discord" }) {
  return (
    <div data-reading role="status" className="flex flex-col gap-2.5 rounded-2xl bg-white px-3.5 py-3 shadow-[0_0_0_1px_var(--c-ececea)]">
      <span className="flex items-center gap-2 text-[12.5px] leading-4 text-[color:var(--c-9a9a98)]">
        <Spinner size={12} color="#9A9A98" />
        {app === "gmail" ? "Reading the email…" : `Reading the thread in ${SOURCE_NAME[app]}…`}
      </span>
      <span className="h-2.5 w-2/3 rounded-full bg-[color:var(--c-f2f2f0)]" />
      <span className="h-2.5 w-5/6 rounded-full bg-[color:var(--c-f4f4f2)]" />
      <span className="h-2.5 w-1/2 rounded-full bg-[color:var(--c-f6f6f4)]" />
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5 rounded-xl bg-[color:var(--c-f7f7f6)] px-3 py-2.5 text-[13px] leading-[19px] text-[color:var(--c-6b6b6b)] [overflow-wrap:anywhere]">{children}</div>;
}

/** The thread, Gmail's or a chat's, with `children` under it (the Reply box). `openLink`: say where to open it there, when the page doesn't already. */
export function SourceThread({ source, openLink, children }: { source: IssueSource; openLink?: boolean; children?: ReactNode }) {
  return (
    <div data-thread={source.app} className="flex min-w-0 flex-col overflow-hidden rounded-2xl bg-white shadow-[0_0_0_1px_var(--c-ececea)]">
      {source.app === "gmail" ? <MailView thread={source} /> : <ChatView thread={source} />}
      {openLink && source.url && (
        <div className="border-t border-[color:var(--c-f0f0ee)] px-3.5 py-2">
          <Link href={source.url} className="text-[12.5px] font-medium text-ink underline decoration-[color:var(--c-c9c9c6)] underline-offset-[3px] hover:decoration-ink">
            {`Open in ${SOURCE_NAME[source.app]}`}
          </Link>
        </div>
      )}
      {children}
    </div>
  );
}

/* ---------------- Pieces ---------------- */

/** A link, opened as the app opens any (a tab of its own); only http, https and mailto go anywhere, the rest is text. */
function Link({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const openLink = useContext(OpenLink);
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (!openLink || safe.startsWith("mailto:")) return;
        e.preventDefault();
        openLink(safe);
      }}
      className={className ?? "text-[#1D4ED8] underline decoration-[#1D4ED8]/30 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-[#1D4ED8]"}
    >
      {children}
    </a>
  );
}

/** Spans, drawn as text. */
function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, k) =>
        s.t === "link" && s.href ? (
          <Link key={k} href={s.href}>
            {s.text}
          </Link>
        ) : s.t === "b" ? (
          <strong key={k} className="font-semibold">
            {s.text}
          </strong>
        ) : s.t === "i" ? (
          <em key={k}>{s.text}</em>
        ) : s.t === "s" ? (
          <s key={k}>{s.text}</s>
        ) : s.t === "code" ? (
          <code key={k} className="rounded-[5px] bg-[color:var(--c-f2f2f0)] px-1 py-px font-mono text-[12px] text-[#B42318] [overflow-wrap:anywhere]">
            {s.text}
          </code>
        ) : s.t === "mention" ? (
          <span key={k} className="rounded-[5px] bg-[#EEF3FF] px-0.5 font-medium text-[#1D4ED8]">
            {s.text}
          </span>
        ) : (
          <span key={k}>{s.text}</span>
        ),
      )}
    </>
  );
}

const TINTS = [
  ["#E8EEFC", "#2F55C9"],
  ["#E7F6EE", "#1F7A4A"],
  ["#FDF0E6", "#A3501B"],
  ["#F3EAFB", "#7340A8"],
  ["#FCE8EC", "#B42348"],
  ["#E6F4F6", "#1E6B78"],
];
const tintOf = (key: string) => TINTS[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];

/** Someone's mark: their first letter on a tint of their own (round for email, a rounded square for chat). */
function Avatar({ name, email, id, square, size = 28 }: { name?: string; email?: string; id?: string; square?: boolean; size?: number }) {
  const [bg, fg] = tintOf(email ?? id ?? name ?? "?");
  return (
    <span aria-hidden className={`flex shrink-0 select-none items-center justify-center font-semibold ${square ? "rounded-lg" : "rounded-full"}`} style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.round(size * 0.44) }}>
      {initialOf(name, email)}
    </span>
  );
}

function Files({ files }: { files: SourceFile[] }) {
  if (!files.length) return null;
  return (
    <div data-files className="flex flex-wrap gap-1.5">
      {files.map((f, k) => (
        <span key={`${f.name}.${k}`} data-file={f.name} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-xl bg-[color:var(--c-f6f6f4)] px-2.5 py-1.5 text-[12px] leading-4 text-[color:var(--c-3a3a38)]">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-[color:var(--c-6b6b6b)]">
            <path d="M10.5 4.5l-5 5a1.4 1.4 0 002 2l5.5-5.5a2.8 2.8 0 00-4-4L3.5 7.5a4.2 4.2 0 006 6l4-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0 truncate">{f.name}</span>
          {fileSize(f.size) && <span className="shrink-0 text-[color:var(--c-9a9a98)]">{fileSize(f.size)}</span>}
        </span>
      ))}
    </div>
  );
}

const day = (at: number) => new Date(at).toDateString();
/** When, short: the time today, else the date ("Oct 20", with the year when it isn't this one). */
function shortWhen(at?: number) {
  if (!at) return "";
  const d = new Date(at);
  if (day(at) === day(Date.now())) return clockTime(at);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
const fullWhen = (at?: number) => (at ? new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
/** A chat message's time: the time today, else the date and the time. */
const chatWhen = (at?: number) => (!at ? "" : day(at) === day(Date.now()) ? clockTime(at) : `${shortWhen(at)}, ${clockTime(at)}`);

/* ---------------- Gmail ---------------- */

const people = (ps: Person[]) => ps.map((p) => (p.me ? "me" : p.name && p.email ? `${p.name} <${p.email}>` : (p.email ?? p.name ?? ""))).filter(Boolean).join(", ");

function MailView({ thread }: { thread: MailThread }) {
  const ms = thread.messages;
  const newest = ms.at(-1)?.id;
  const [open, setOpen] = useState<Set<string>>(() => new Set(newest ? [newest] : []));
  const all = ms.length > 0 && ms.every((m) => open.has(m.id));
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <div className="flex items-start gap-2 px-3.5 pb-2.5 pt-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span data-subject className="text-[14.5px] font-semibold leading-5 text-ink [overflow-wrap:anywhere]">
            {thread.subject || "(no subject)"}
          </span>
          <span className="truncate text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{[`${ms.length} ${ms.length === 1 ? "message" : "messages"}`, thread.account.title].filter(Boolean).join(" · ")}</span>
        </div>
        {ms.length >= 3 && (
          <button onClick={() => setOpen(all ? new Set() : new Set(ms.map((m) => m.id)))} className={`${small("plain")} shrink-0`}>
            {all ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>
      {ms.map((m) => (
        <div key={m.id} className="border-t border-[color:var(--c-f0f0ee)]">
          {open.has(m.id) ? <MailOpen m={m} onFold={() => toggle(m.id)} /> : <MailFolded m={m} onOpen={() => toggle(m.id)} />}
        </div>
      ))}
      {thread.more && <div className="border-t border-[color:var(--c-f0f0ee)] px-3.5 py-2 text-[12px] leading-4 text-[color:var(--c-9a9a98)]">This thread has more. Open it in Gmail for the rest.</div>}
    </>
  );
}

function MailFolded({ m, onOpen }: { m: MailMessage; onOpen: () => void }) {
  return (
    <button onClick={onOpen} aria-expanded={false} data-mail={m.id} className="flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-[#FAFAF9]">
      <Avatar name={m.from.name} email={m.from.email} size={24} />
      <span className="max-w-[40%] shrink-0 truncate text-[13px] font-medium leading-[18px] text-ink">{personName(m.from, "Me")}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-[color:var(--c-6b6b6b)]">{m.snippet}</span>
      {m.files.length > 0 && (
        <svg width="11" height="11" viewBox="0 0 16 16" aria-label="Has files" className="shrink-0 text-[color:var(--c-9a9a98)]">
          <path d="M10.5 4.5l-5 5a1.4 1.4 0 002 2l5.5-5.5a2.8 2.8 0 00-4-4L3.5 7.5a4.2 4.2 0 006 6l4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="shrink-0 text-[12px] tabular-nums leading-4 text-[color:var(--c-9a9a98)]" title={fullWhen(m.at)}>
        {shortWhen(m.at)}
      </span>
    </button>
  );
}

function MailOpen({ m, onFold }: { m: MailMessage; onFold: () => void }) {
  const [details, setDetails] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const to = recipientsLine(m.to, m.cc);
  return (
    <div data-mail={m.id} data-open className="flex min-w-0 flex-col gap-2.5 px-3.5 pb-3.5 pt-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Avatar name={m.from.name} email={m.from.email} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button onClick={onFold} aria-expanded title="Fold" className="flex min-w-0 items-baseline gap-1.5 text-left">
            <span className="min-w-0 max-w-full truncate text-[13.5px] font-semibold leading-[18px] text-ink">{personName(m.from, "Me")}</span>
            {m.from.email && <span className="min-w-0 shrink-[2] truncate text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{`<${m.from.email}>`}</span>}
          </button>
          {to && (
            <button onClick={() => setDetails(!details)} aria-expanded={details} data-to className="flex max-w-full items-center gap-1 self-start text-left text-[12px] leading-4 text-[color:var(--c-6b6b6b)] [overflow-wrap:anywhere] hover:text-ink">
              {to}
              <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className={`transition-transform ${details ? "rotate-180" : ""}`}>
                <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        <span className="shrink-0 pt-px text-[12px] tabular-nums leading-4 text-[color:var(--c-9a9a98)]" title={fullWhen(m.at)}>
          {shortWhen(m.at)}
        </span>
      </div>
      {details && (
        <dl data-details className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl bg-[color:var(--c-f6f6f4)] px-3 py-2 text-[12px] leading-4">
          {(
            [
              ["From", people([m.from])],
              ["To", people(m.to)],
              ["Cc", people(m.cc)],
              ["Reply to", people(m.replyTo ?? [])],
              ["Date", fullWhen(m.at)],
            ] as const
          )
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-[color:var(--c-9a9a98)]">{k}</dt>
                <dd className="min-w-0 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
        </dl>
      )}
      {m.body && (
        <div data-body className="min-w-0 whitespace-pre-wrap text-[13.5px] leading-5 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">
          <Spans spans={linkSpans(m.body)} />
        </div>
      )}
      {m.quoted && (
        <>
          <button onClick={() => setQuoted(!quoted)} aria-expanded={quoted} data-quoted-toggle className="self-start rounded-full bg-[color:var(--c-f2f2f0)] px-2.5 py-0.5 text-[12px] font-medium leading-4 text-[color:var(--c-6b6b6b)] hover:bg-[color:var(--c-eaeae7)] hover:text-ink">
            {quoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {quoted && (
            <div data-quoted className="min-w-0 whitespace-pre-wrap border-l-2 border-[color:var(--c-e6e6e3)] pl-3 text-[13px] leading-[19px] text-[color:var(--c-6b6b6b)] [overflow-wrap:anywhere]">
              <Spans spans={linkSpans(m.quoted)} />
            </div>
          )}
        </>
      )}
      <Files files={m.files} />
    </div>
  );
}

/* ---------------- Slack and Discord ---------------- */

/** How many of a long thread's newest replies show while the rest is folded. */
const NEWEST = 3;

function ChatView({ thread }: { thread: ChatThread }) {
  const [all, setAll] = useState(false);
  const ms = thread.messages;
  const slack = thread.app === "slack";
  // Slack: the thread's first message, then its replies. Discord: the channel's messages around the one it's about.
  const first: ChatMessage | undefined = slack ? ms[0] : undefined;
  const replies = slack ? ms.slice(1) : ms;
  const fold = !all && replies.length > NEWEST + 1;
  const hidden = fold ? replies.length - NEWEST : 0;
  const where = thread.channel.dm ? (thread.channel.name ? `Direct message with ${thread.channel.name}` : "Direct message") : `#${thread.channel.name ?? thread.channel.id}`;
  const line = (m: ChatMessage) => <ChatLine key={m.id} m={m} thread={thread} />;
  return (
    <>
      <div className="flex items-start gap-2 px-3.5 pb-2 pt-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span data-channel className="truncate text-[14.5px] font-semibold leading-5 text-ink">
            {where}
          </span>
          <span className="truncate text-[12px] leading-4 text-[color:var(--c-9a9a98)]">
            {[slack ? `${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : `${ms.length} ${ms.length === 1 ? "message" : "messages"}`, thread.account.title].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
      <div className="flex min-w-0 flex-col pb-1.5">
        {first && line(first)}
        {first && replies.length > 0 && (
          <div className="flex items-center gap-2 px-3.5 py-1 text-[11.5px] font-medium leading-4 text-[color:var(--c-9a9a98)]">
            <span>{`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}</span>
            <span className="h-px flex-1 bg-[color:var(--c-f0f0ee)]" />
          </div>
        )}
        {fold ? (
          <>
            <button onClick={() => setAll(true)} data-more className="mx-3.5 my-1 self-start rounded-full bg-[color:var(--c-f2f2f0)] px-3 py-1 text-[12px] font-medium leading-4 text-[color:var(--c-3a3a38)] hover:bg-[color:var(--c-eaeae7)]">
              {`${hidden} more ${hidden === 1 ? "reply" : "replies"}`}
            </button>
            {replies.slice(-NEWEST).map(line)}
          </>
        ) : (
          replies.map(line)
        )}
      </div>
      {thread.more && <div className="border-t border-[color:var(--c-f0f0ee)] px-3.5 py-2 text-[12px] leading-4 text-[color:var(--c-9a9a98)]">{`This thread has more. Open it in ${SOURCE_NAME[thread.app]} for the rest.`}</div>}
    </>
  );
}

function ChatLine({ m, thread }: { m: ChatMessage; thread: ChatThread }) {
  const blocks = chatBlocks(m.text, thread.app, thread.names, thread.channels);
  return (
    <div data-chat={m.id} className="flex min-w-0 gap-2.5 px-3.5 py-1.5">
      <Avatar name={m.user.name} id={m.user.id} square size={30} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13.5px] font-semibold leading-[18px] text-ink">{m.user.name}</span>
          {m.user.bot && <span className="shrink-0 rounded bg-[color:var(--c-f2f2f0)] px-1 text-[10px] font-semibold uppercase leading-[14px] text-[color:var(--c-6b6b6b)]">App</span>}
          <span className="shrink-0 text-[11.5px] tabular-nums leading-4 text-[color:var(--c-9a9a98)]" title={fullWhen(m.at)}>
            {chatWhen(m.at)}
          </span>
          {m.edited && <span className="shrink-0 text-[11px] leading-4 text-[color:var(--c-b0b0ad)]">(edited)</span>}
        </span>
        {blocks.map((b, k) =>
          b.t === "pre" ? (
            <pre key={k} className="max-w-full overflow-x-auto rounded-xl bg-[color:var(--c-f6f6f4)] px-3 py-2 font-mono text-[12px] leading-[17px] text-[color:var(--c-3a3a38)]">
              {b.text}
            </pre>
          ) : b.t === "quote" ? (
            <div key={k} className="min-w-0 whitespace-pre-wrap border-l-2 border-[#DCDCD8] pl-2.5 text-[13.5px] leading-5 text-[color:var(--c-6b6b6b)] [overflow-wrap:anywhere]">
              <Spans spans={b.spans} />
            </div>
          ) : (
            <div key={k} className="min-w-0 whitespace-pre-wrap text-[13.5px] leading-5 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">
              <Spans spans={b.spans} />
            </div>
          ),
        )}
        <Files files={m.files} />
        {m.reactions.length > 0 && (
          <div data-reactions className="flex flex-wrap gap-1">
            {m.reactions.map((r) => (
              <span key={r.name} title={`:${r.name}:`} className="flex items-center gap-1 rounded-full bg-[color:var(--c-f2f2f0)] px-2 py-px text-[11.5px] leading-[18px] text-[color:var(--c-3a3a38)]">
                <span>{emojiOf(r.name)}</span>
                <span className="tabular-nums text-[color:var(--c-6b6b6b)]">{r.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Replying ---------------- */

type Sent = { sent: { at: number; to: string }; logged: boolean };
type SendFn = (text: string, all: boolean, nonce: string) => Promise<Sent | { error: string }>;

const nonceOf = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9_-]/g, "");

/**
 * The Reply box under a thread: who it goes to, shown before Send (an email's sender, or with Reply all everyone
 * on it but the user; Slack's thread; the Discord channel), the user's words, and Send, which sends once (one at a
 * time, each click its own). `initial`: the reply drafted for the issue, to start from.
 */
function ReplyBox({ source, initial, hint, send }: { source: IssueSource; initial: string; hint?: string; send: SendFn }) {
  const [text, setText] = useState(initial);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const going = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Sent | null>(null);
  const mail = source.app === "gmail" ? source.reply : undefined;
  if (source.app === "gmail" && !mail)
    return <div className="border-t border-[color:var(--c-f0f0ee)] px-3.5 py-2.5 text-[12.5px] leading-[18px] text-[color:var(--c-6b6b6b)]">{`${BRAND.name} can't tell who to reply to here. Reply in Gmail.`}</div>;
  const others = mail ? mail.all.to.length + mail.all.cc.length : 0;
  const go = async () => {
    const words = text.trim();
    if (!words || going.current) return;
    going.current = true;
    setBusy(true);
    setError(null);
    const r = await send(words, all && others > 0, nonceOf()).catch(() => ({ error: `Couldn't reach ${BRAND.name}. Try again.` }));
    going.current = false;
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setDone(r);
    setText("");
  };
  const who = (p: Person) => (p.name && p.email ? `${p.name} <${p.email}>` : (p.email ?? p.name ?? ""));
  const where = source.app === "gmail" ? "" : source.channel.dm ? (source.channel.name ? `To ${source.channel.name}` : "In the direct message") : `In #${source.channel.name ?? source.channel.id}`;
  return (
    <div data-reply className="flex flex-col gap-2 border-t border-[color:var(--c-f0f0ee)] bg-[color:var(--c-fcfcfb)] px-3.5 py-3">
      {mail ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          {others > 0 && (
            <div role="radiogroup" aria-label="Reply to" className="flex gap-1">
              {[false, true].map((on) => (
                <button
                  key={String(on)}
                  role="radio"
                  aria-checked={all === on}
                  onClick={() => setAll(on)}
                  disabled={busy}
                  className={`rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 ${all === on ? "bg-ink text-white" : "bg-[color:var(--c-f2f2f0)] text-[color:var(--c-3a3a38)] hover:bg-[color:var(--c-eaeae7)]"}`}
                >
                  {on ? "Reply all" : "Reply"}
                </button>
              ))}
            </div>
          )}
          <span data-reply-to className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">
            To
            <code className="rounded-md bg-[color:var(--c-f2f2f0)] px-1.5 py-0.5 text-[11.5px] leading-4 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">{who(mail.to)}</code>
            {all &&
              mail.all.to.map((p) => (
                <code key={p.email} className="rounded-md bg-[color:var(--c-f2f2f0)] px-1.5 py-0.5 text-[11.5px] leading-4 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">
                  {who(p)}
                </code>
              ))}
            {all && mail.all.cc.length > 0 && (
              <>
                <span className="pl-1">Cc</span>
                {mail.all.cc.map((p) => (
                  <code key={p.email} className="rounded-md bg-[color:var(--c-f2f2f0)] px-1.5 py-0.5 text-[11.5px] leading-4 text-[color:var(--c-3a3a38)] [overflow-wrap:anywhere]">
                    {who(p)}
                  </code>
                ))}
              </>
            )}
          </span>
        </div>
      ) : (
        <span data-reply-to className="text-[12px] leading-4 text-[color:var(--c-6b6b6b)] [overflow-wrap:anywhere]">
          {source.app === "slack" ? `${where}, in its thread` : where}
        </span>
      )}
      {hint && text === initial && initial && <span className="text-[11.5px] leading-4 text-[color:var(--c-9a9a98)]">{hint}</span>}
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDone(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void go();
          }
        }}
        disabled={busy}
        aria-label={mail ? `Reply to ${personName(mail.to)}` : `Reply in ${SOURCE_NAME[source.app]}`}
        placeholder={mail ? `Reply to ${personName(mail.to)}` : source.app === "slack" ? "Reply in the thread" : "Reply in the channel"}
        rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
        className="w-full min-w-0 resize-y rounded-xl bg-white px-3 py-2 text-[13px] leading-[19px] text-ink shadow-[0_0_0_1px_var(--c-e6e6e3)] outline-none placeholder:text-[color:var(--c-9a9a98)] focus:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] disabled:text-[color:var(--c-6b6b6b)]"
      />
      {error && (
        <span role="alert" className="text-[12px] leading-4 text-[#B42318] [overflow-wrap:anywhere]">
          {error}
        </span>
      )}
      {done && (
        <span data-sent role="status" className="flex flex-wrap items-center gap-1.5 text-[12px] leading-4 text-[color:var(--c-3a3a38)]">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-[#2BB673]">
            <path d="M3 8.5l3 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0 [overflow-wrap:anywhere]">{`Sent to ${done.sent.to} · ${clockTime(done.sent.at)}`}</span>
          {!done.logged && <span className="text-[color:var(--c-9a9a98)]">{"It couldn't be noted in the history."}</span>}
        </span>
      )}
      <div className="flex items-center gap-1.5">
        <button onClick={() => void go()} disabled={busy || !text.trim()} className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white disabled:opacity-50">
          {busy ? (
            <>
              <Spinner size={11} color="#FFFFFF" />
              Sending
            </>
          ) : (
            "Send"
          )}
        </button>
        <span className="text-[11.5px] leading-4 text-[color:var(--c-9a9a98)]">{`From ${source.account.title} in ${SOURCE_NAME[source.app]}`}</span>
      </div>
    </div>
  );
}
