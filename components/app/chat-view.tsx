"use client";

import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BLOCKER_ASK, live, pairChatId, TAPBACK_EMOJI, TAPBACKS, type AppApproval, type AppState, type Bot, type Chat, type Message, type Session, type Tapback } from "@/lib/types";
import { Tapback as TapbackBalloon, TapbackGlyph, tapbackVars } from "@/components/message-ui/tapback";
import { Mascot } from "./mascot";
import { OpenLink } from "./panel-tabs";
import { ApprovalCard, MacIcon } from "./mac-tab";
import { AttachmentTray, MessageImages, useAttachments } from "./attachments";
import { ComposerInput } from "./composer-input";
import { ChatAvatar, chatName, clockTime, needsYou, post, StatusIcon, teamOf, useNow } from "./ui";

/** Light markdown for bot text: **bold** and [links](url). */
/** How many messages a chat draws at first, and how many more each "Show earlier messages" adds. */
const PAGE = 60;

export function Rich({ text }: { text: string }) {
  // Code blocks (ASCII diagrams, commands) keep their monospace layout; the rest is inline text.
  const blocks = text.split(/```[a-z0-9-]*\n?([\s\S]*?)```/g);
  return (
    <>
      {blocks.map((b, i) =>
        i % 2 ? (
          <pre key={i} className="my-1.5 overflow-x-auto whitespace-pre rounded-xl bg-black/[0.045] px-3 py-2 font-mono text-[12px] leading-[17px] [overflow-wrap:normal]">
            {b.replace(/\n$/, "")}
          </pre>
        ) : (
          <Prose key={i} text={b} />
        ),
      )}
    </>
  );
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Text between code blocks: Markdown tables become real tables, "# Headings" bold lines, the rest inline text. */
function Prose({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let buf: string[] = [];
  // Blank lines around a table or heading would add a second gap on top of its own spacing.
  const flush = () => {
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length) out.push(<Inline key={`t${out.length}`} text={buf.join("\n")} />);
    buf = [];
  };
  const skipBlank = () => {
    while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
  };
  let i = 0;
  for (; i < lines.length; i++) {
    // A table: a header row, a |---| rule, then its rows.
    if (isRow(lines[i]) && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush();
      const head = cells(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      i--;
      skipBlank();
      out.push(
        <span key={`g${out.length}`} className="my-1.5 block overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px] leading-[18px]">
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j} className="border-b border-black/10 px-2 py-1 font-semibold first:pl-0">
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k}>
                  {r.map((c, j) => (
                    <td key={j} className="border-b border-black/[0.06] px-2 py-1 align-top first:pl-0">
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </span>,
      );
      continue;
    }
    const heading = /^\s*#{1,4}\s+(.*)$/.exec(lines[i]);
    if (heading) {
      flush();
      out.push(
        <strong key={`h${out.length}`} className="block font-semibold">
          {heading[1]}
        </strong>,
      );
      skipBlank();
      continue;
    }
    buf.push(lines[i]);
  }
  flush();
  return <>{out}</>;
}

/** Light inline markdown: **bold** and [links](url). */
function Inline({ text }: { text: string }) {
  // Links open as a tab on the right; ⌘-click still opens your browser. A page a bot made opens there too.
  const openLink = useContext(OpenLink);
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        // `code`: monospace, and it wraps like text (moves, ids, commands can be long).
        const code = /^`([^`\n]+)`$/.exec(p);
        if (code) return <code key={i} className="rounded-[5px] bg-black/[0.06] px-1 py-px font-mono text-[12.5px] [overflow-wrap:anywhere]">{code[1]}</code>;
        const bold = /^\*\*([^*]+)\*\*$/.exec(p);
        if (bold) return <strong key={i} className="font-semibold">{bold[1]}</strong>;
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
        if (link) {
          const page = link[2].startsWith("/api/pages/");
          return (
            <a
              key={i}
              href={link[2]}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!openLink || e.metaKey || e.ctrlKey || e.shiftKey || !(page || /^https?:/.test(link[2]))) return;
                e.preventDefault();
                openLink(page ? new URL(link[2], window.location.href).href : link[2], page ? link[1] : undefined);
              }}
              className={page ? "inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-0.5 font-medium no-underline shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]" : "underline decoration-[#C9C9C6] underline-offset-2 hover:decoration-ink"}
            >
              {link[1]}
            </a>
          );
        }
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

/* ---------------- Chat ---------------- */

export function ChatView({
  state,
  chat: c,
  wide,
  onOpenThread,
  onShowBot,
  onShowMac,
  onShowScreen,
  onUpgrade,
  peek,
  call,
  onCall,
  callSlot,
}: {
  state: AppState;
  chat: Chat;
  /** The right panel is collapsed, so the chat centers itself. */
  wide: boolean;
  onOpenThread: (s: Session) => void;
  onShowBot: (botId: string) => void;
  /** Open the "Your Mac" tab. */
  onShowMac: () => void;
  /** Open a bot's computer on one screen, e.g. the watched screen a heads-up is about. */
  onShowScreen: (botId: string, display: number) => void;
  /** Open the Account sheet, where AI credit is bought. */
  onUpgrade?: () => void;
  peek?: React.ReactNode;
  /** The bot you're on a call with, if any. The call belongs to the app, so it outlives this chat. */
  call: string | null;
  onCall: (botId: string) => void;
  /** Where the call bar sits while you're in the caller's chat (the app draws it there). */
  callSlot: (el: HTMLElement | null) => void;
}) {
  const [draft, setDraft] = useState("");
  // The message an inline reply is to (iMessage's swipe-to-reply), and the reply view that's open.
  const [replyingTo, setReplying] = useState<Message | null>(null);
  const [repliesOpen, setRepliesOpen] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => state.messages.filter((m) => m.chatId === c.id), [state.messages, c.id]);
  // Only the latest messages are drawn (a long chat had hundreds, all rendered and laid out on every
  // update); "Show earlier messages" adds more. A different chat starts again from the latest.
  const [window_, setWindow] = useState<{ chat: string; shown: number }>({ chat: c.id, shown: PAGE });
  const shown = window_.chat === c.id ? window_.shown : PAGE;
  const setShown = (f: (n: number) => number) => setWindow({ chat: c.id, shown: f(shown) });
  const hiddenCount = Math.max(0, messages.length - shown);
  const visible = hiddenCount ? messages.slice(hiddenCount) : messages;
  // A thread gets one chip, on the latest message about it, so it moves down as the thread moves on.
  const chipHome = useMemo(() => {
    const home = new Map<string, string>();
    for (const m of messages) for (const sid of m.sessionIds ?? []) home.set(sid, m.id);
    return home;
  }, [messages]);
  const members = c.botIds.map((b) => state.bots.find((x) => x.id === b)).filter(Boolean) as Bot[];
  // App actions waiting for you, asked in this chat or by one of its threads.
  const appAsks = (state.appApprovals ?? []).filter((a) => a.chatId === c.id || state.sessions.some((x) => x.id === a.sessionId && x.chatId === c.id));
  const solo = c.kind === "bot" ? members[0] : undefined;
  // A bot's chat shows all its work; a group only the threads started in that group.
  const running = state.sessions.filter((s) => live(s) && (c.kind === "group" ? s.chatId === c.id : c.botIds.includes(s.botId)));
  const sessionById = (sid: string) => state.sessions.find((s) => s.id === sid);
  const chipsFor = (m: Message) => (m.sessionIds ?? []).filter((sid) => chipHome.get(sid) === m.id);
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  // Both belong to the chat they were started in.
  const replying = replyingTo?.chatId === c.id ? replyingTo : null;
  const openReplies = repliesOpen && messages.some((m) => m.id === repliesOpen) ? repliesOpen : null;
  const replyCount = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of messages) if (m.replyTo) n.set(m.replyTo, (n.get(m.replyTo) ?? 0) + 1);
    return n;
  }, [messages]);
  const startReply = (m: Message) => {
    setReplying(m);
    document.getElementById("composer")?.focus();
  };
  // Two bots' conversation, open over the chat ("Asked ● Sam").
  const [pair, setPair] = useState<{ id: string; focus?: string } | null>(null);
  const rowProps = (m: Message) => ({
    replyCount: replyCount.get(m.id) ?? 0,
    root: m.replyTo ? messages.find((x) => x.id === m.replyTo) : undefined,
    onReply: () => startReply(m),
    onOpenReplies: () => setRepliesOpen(m.replyTo ?? m.id),
    onShowMac,
  });
  const repliedAfterUser = messages.slice(lastUserIdx + 1).some((m) => m.role === "bot");

  // Opening a chat lands on its latest message; only new messages in the open chat glide in.
  const shownChat = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: shownChat.current === c.id ? "smooth" : "instant" });
    shownChat.current = c.id;
  }, [messages.length, c.typing.length, c.id]);

  // Marked read only when there's something unread: each mark is a state change every open page reloads.
  const lastAt = messages.at(-1)?.at ?? 0;
  useEffect(() => {
    if ((c.readAt ?? 0) >= lastAt) return;
    void post(`/api/chats/${encodeURIComponent(c.id)}/read`);
  }, [c.id, c.readAt, lastAt]);

  // What the user just sent shows at once, before the server has it (then the real message takes its place).
  const [pending, setPending] = useState<{ id: string; chatId: string; text: string; at: number; previews?: string[] }[]>([]);
  // Images about to go with the next message (the + button, pasting, or dropping them on the chat).
  const attach = useAttachments();
  const filePicker = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const attaching = attach.items.filter((a) => a.status !== "failed");
  const send = async () => {
    const text = draft.trim();
    if (!text && !attaching.length) return;
    const items = attaching;
    setDraft("");
    setReplying(null);
    attach.clear();
    const mine = { id: `pending_${Date.now()}`, chatId: c.id, text, at: Date.now(), previews: items.length ? items.map((a) => a.preview) : undefined };
    setPending((p) => [...p, mine]);
    // Shows at once; goes once its images have finished uploading (usually they already have).
    const images = (await Promise.all(items.map((a) => a.done))).filter((x) => !!x);
    if (!text && !images.length) return setPending((p) => p.filter((x) => x.id !== mine.id));
    await post(`/api/chats/${encodeURIComponent(c.id)}/messages`, { text, replyTo: replying?.id, images: images.length ? images : undefined }).finally(() =>
      setPending((p) => p.filter((x) => x.id !== mine.id)),
    );
  };
  const filesOf = (d: DataTransfer | null) => [...(d?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  // Sent messages the server's state doesn't have yet.
  const waiting = pending.filter((p) => p.chatId === c.id && !messages.some((m) => m.role === "user" && m.text === p.text && m.at >= p.at - 5000));

  const status = c.typing.length
    ? c.kind === "group"
      ? `${c.typing.map((b) => state.bots.find((x) => x.id === b)?.name).join(", ")} typing…`
      : "Typing…"
    : running.length
      ? `Working on ${running.length} thing${running.length === 1 ? "" : "s"}`
      : solo
        ? solo.role
        : members.map((m) => m.name).join(", ") + " and you";

  const width = wide ? "mx-auto w-full max-w-[680px]" : "";

  return (
    <PairOpen.Provider value={(id, focus) => setPair({ id, focus })}>
    <main
      className="relative flex min-h-0 min-w-0 flex-1 flex-col border-r border-[#ECECEA] bg-white"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const files = filesOf(e.dataTransfer);
        if (files.length) {
          attach.add(files);
          document.getElementById("composer")?.focus();
        }
      }}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-3 z-[40] flex items-center justify-center rounded-[20px] border-2 border-dashed border-[#0A0A0A]/25 bg-white/85 backdrop-blur-[2px]">
          <span className="text-[14px] font-medium text-[#3A3A38]">Drop images to send {solo ? `to ${solo.name}` : "to the group"}</span>
        </div>
      )}
      {pair && <PairSheet state={state} pairId={pair.id} focusId={pair.focus} onClose={() => setPair(null)} />}
      <div className="absolute right-5 top-[18px] z-10 flex items-center gap-2">
        {solo && !call && (
          <button
            onClick={() => onCall(solo.id)}
            aria-label={`Call ${solo.name}`}
            title={`Call ${solo.name}`}
            className="flex size-11 items-center justify-center rounded-full bg-white shadow-[0_0_0_1px_#E6E6E3,0_8px_20px_-10px_#00000040] hover:shadow-[0_0_0_1px_#C9C9C6,0_8px_20px_-10px_#00000040]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0A0A0A" strokeWidth="1.7" strokeLinejoin="round">
              <path d="M5 3.5h3.2l1.6 4.2-2.1 1.4a11 11 0 0 0 5.2 5.2l1.4-2.1 4.2 1.6V17a2.5 2.5 0 0 1-2.7 2.5C9.4 19 5 14.6 4.5 8.2A2.5 2.5 0 0 1 5 3.5z" />
            </svg>
          </button>
        )}
        {peek}
      </div>
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* The header floats over the conversation: messages soften into a blur as they pass under it. */}
        <header className={`sticky top-0 z-[5] flex shrink-0 flex-col items-center pb-1.5 ${call && call === solo?.id ? "pt-[18px]" : "pt-3"}`}>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-8 top-0">
            <div className="absolute inset-0 backdrop-blur-[2px] [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" />
            <div className="absolute inset-0 backdrop-blur-[6px] [mask-image:linear-gradient(to_bottom,black_30%,transparent_75%)]" />
            <div className="absolute inset-0 bg-gradient-to-b from-white from-45% via-white/80 via-75% to-white/0" />
          </div>
          {call && call === solo?.id ? (
            // On a call, the call takes the header's place (the app draws it over this slot).
            <div ref={callSlot} className="h-[52px] self-stretch" />
          ) : (
            <>
              <button onClick={() => solo && onShowBot(solo.id)} className="relative top-2 z-10" title={solo ? `${solo.name}'s profile` : undefined}>
                <ChatAvatar chat={c} bots={state.bots} size={40} />
              </button>
              <div className="relative flex flex-col items-center rounded-[14px] bg-white px-3.5 pb-1.5 pt-2.5 shadow-[0_0_0_1px_#E6E6E3,0_6px_16px_-8px_#00000020]">
                <span className="text-[14px] font-semibold leading-[18px]">{chatName(c, state.bots)}</span>
                <span className="text-[12px] leading-[15px] text-[#9A9A98]">{status}</span>
              </div>
            </>
          )}
        </header>
        <div className={`flex flex-1 flex-col justify-end gap-1.5 px-5 pb-9 pt-8 ${width}`}>
          {messages.length === 0 && (
            <div className="m-auto max-w-[300px] py-10 text-center text-[14px] leading-5 text-[#6B6B6B]">
              {solo
                ? solo.isMain
                  ? teamOf(state).length > 1
                    ? `Text ${solo.name} anything. ${solo.name} hands work to the right bot and keeps you posted.`
                    : `Text ${solo.name} anything. ${solo.name} works on its own computer, and can build you a team of bots when you need one.`
                  : `Text ${solo.name} directly. Long tasks show up here as threads you can open.`
                : "Say hi to the group. @mention a bot to point at it."}
            </div>
          )}
          {hiddenCount > 0 && (
            <button onClick={() => setShown((n) => n + PAGE)} className="mb-2 self-center rounded-full px-3 py-1 text-[12.5px] font-medium text-[#6B6B6B] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6] hover:text-ink">
              Show earlier messages
            </button>
          )}
          {visible.map((m, i) => {
            const prev = i === 0 ? messages[hiddenCount - 1] : visible[i - 1];
            const gap = !prev || m.at - prev.at > 15 * 60_000;
            return (
              <Fragment key={m.id}>
                {gap && <div className="self-center py-1.5 text-[12px] leading-4 text-[#9A9A98]">{dayTime(m.at)}</div>}
                <MessageRow
                  m={m}
                  state={state}
                  showSender={c.kind === "group" || (!!m.botId && m.botId !== solo?.id)}
                  continued={!!prev && prev.role === m.role && prev.botId === m.botId && !gap}
                  sessionById={sessionById}
                  chipIds={chipsFor(m)}
                  onOpenThread={onOpenThread}
                  onShowScreen={onShowScreen}
                  {...rowProps(m)}
                />
                {i + hiddenCount === lastUserIdx && repliedAfterUser && (
                  <div className="self-end px-1 pb-1 text-[11px] leading-[14px] text-[#9A9A98]">Read {clockTime(m.at)}</div>
                )}
              </Fragment>
            );
          })}
          {waiting.map((p) => (
            <div key={p.id} className="flex max-w-[86%] flex-col items-end gap-1 self-end">
              {p.previews && <MessageImages previews={p.previews} />}
              {p.text && <div className="whitespace-pre-wrap rounded-[18px] bg-[#0A0A0A] px-3.5 py-2 text-[14px] leading-5 text-white [overflow-wrap:anywhere]">{p.text}</div>}
            </div>
          ))}
          {c.typing.map((b) => {
            const tb = state.bots.find((x) => x.id === b);
            // Waiting on a teammate's answer: "Asking ● Max…" over the typing dots.
            const asking = c.asking?.[b] ? state.bots.find((x) => x.id === c.asking![b]) : undefined;
            return (
              <div key={b} className="flex flex-col gap-1 self-start">
                {asking && (
                  <span className="flex items-center gap-1.5 pl-3 text-[12.5px] leading-4 text-[#9A9A98]">
                    Asking
                    <Mascot botId={asking.id} color={asking.color} size={15} antenna={false} />
                    <span className="text-[#6B6B6B]">{asking.name}…</span>
                  </span>
                )}
              <div className="flex items-end gap-2">
                {c.kind === "group" && tb && <Mascot botId={tb.id} color={tb.color} size={24} />}
                <div className="flex items-center gap-[5px] rounded-[18px] bg-[#F2F2F0] px-4 py-[13px]">
                  <span className="size-[7px] animate-pulse rounded-full bg-[#9A9A98]" />
                  <span className="size-[7px] animate-pulse rounded-full bg-[#B5B5B2] [animation-delay:150ms]" />
                  <span className="size-[7px] animate-pulse rounded-full bg-[#D9D9D6] [animation-delay:300ms]" />
                </div>
              </div>
              </div>
            );
          })}
        </div>
        {/* The composer floats over the bottom of the conversation, like the header over the top:
            messages soften into a blur and fade as they pass under it. */}
        <div className={`sticky bottom-0 z-[5] flex shrink-0 flex-col px-4 pb-4 [&>*:not([aria-hidden])]:relative ${width}`}>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-8 bottom-0">
            <div className="absolute inset-0 backdrop-blur-[2px] [mask-image:linear-gradient(to_top,black_55%,transparent)]" />
            <div className="absolute inset-0 backdrop-blur-[6px] [mask-image:linear-gradient(to_top,black_30%,transparent_75%)]" />
              <div className="absolute inset-0 bg-gradient-to-t from-white from-45% via-white/80 via-75% to-white/0" />
            </div>
          {state.credits?.out && <OutOfCredit onUpgrade={onUpgrade} />}
          {appAsks.length > 0 && (
            <div className="mb-2.5 flex flex-col gap-2">
              {appAsks.map((a) => (
                <AppApprovalCard key={a.id} state={state} approval={a} />
              ))}
            </div>
          )}
          {!!state.mac?.approvals.length && (
            <div className="mb-2.5 flex flex-col gap-2">
              {state.mac.approvals.slice(0, 2).map((a) => (
                <ApprovalCard key={a.id} state={state} approval={a} compact />
              ))}
              {state.mac.approvals.length > 2 && (
                <button onClick={onShowMac} className="self-center text-[12.5px] font-medium text-ink hover:underline">
                  {state.mac.approvals.length - 2} more waiting on your Mac ›
                </button>
              )}
            </div>
          )}
          {replying && (
            <div className="mx-2 -mb-px flex items-center gap-2 rounded-t-[16px] bg-[#F7F7F6] px-3.5 py-2 shadow-[0_0_0_1px_#ECECEA]">
              <ReplyArrow />
              <span className="min-w-0 flex-1 truncate text-[12.5px] leading-4 text-[#6B6B6B]">
                Replying to <span className="font-medium text-ink">{replying.role === "user" ? "yourself" : (state.bots.find((x) => x.id === replying.botId)?.name ?? "the bot")}</span>
                {" · "}
                {replying.text}
              </span>
              <button onClick={() => setReplying(null)} aria-label="Cancel reply" className="flex size-5 items-center justify-center rounded-md text-[#9A9A98] hover:bg-black/[0.06] hover:text-ink">
                <svg width="9" height="9" viewBox="0 0 12 12">
                  <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex flex-col rounded-[22px] bg-white py-2 pl-2 pr-2 shadow-[0_0_0_1px_#E2E2DF]"
          >
            <AttachmentTray items={attach.items} onRemove={attach.remove} />
            <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => filePicker.current?.click()}
              aria-label="Attach images"
              data-tip="Attach images · or paste / drop them"
              className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0] hover:text-ink"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <input
              ref={filePicker}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                attach.add(e.target.files ?? []);
                e.target.value = "";
                document.getElementById("composer")?.focus();
              }}
            />
            <ComposerInput
              id="composer"
              value={draft}
              onChange={setDraft}
              onPaste={(e) => {
                const files = filesOf(e.clipboardData);
                if (!files.length) return;
                e.preventDefault();
                attach.add(files);
              }}
              onKeyDown={(e) => e.key === "Escape" && replying && (e.stopPropagation(), setReplying(null))}
              placeholder={replying ? "Reply" : solo ? `Text ${solo.name}` : "Message the group · @ to mention"}
              className="min-w-0 flex-1 bg-transparent py-[6px] text-[14px] leading-[18px] outline-none placeholder:text-[#9A9A98]"
            />
            <button type="submit" aria-label="Send" disabled={!draft.trim() && !attaching.length} className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-ink disabled:opacity-30">
              <SendIcon />
            </button>
            </div>
          </form>
        </div>
      </div>

      {openReplies && (
        <RepliesView
          state={state}
          rootId={openReplies}
          messages={messages}
          showSender={c.kind === "group"}
          onClose={() => setRepliesOpen(null)}
          onSend={(text) => post(`/api/chats/${encodeURIComponent(c.id)}/messages`, { text, replyTo: openReplies })}
          rowProps={rowProps}
          sessionById={sessionById}
          onOpenThread={onOpenThread}
          onShowScreen={onShowScreen}
        />
      )}
    </main>
    </PairOpen.Provider>
  );
}

/**
 * One inline-reply conversation on its own, like tapping "2 Replies" in Messages: the message it
 * started from, its replies, and a composer that keeps replying to it.
 */
function RepliesView({
  state,
  rootId,
  messages,
  showSender,
  onClose,
  onSend,
  rowProps,
  sessionById,
  onOpenThread,
  onShowScreen,
}: {
  state: AppState;
  rootId: string;
  messages: Message[];
  showSender: boolean;
  onClose: () => void;
  onSend: (text: string) => Promise<unknown>;
  rowProps: (m: Message) => Pick<RowProps, "replyCount" | "root" | "onReply" | "onOpenReplies" | "onShowMac">;
  sessionById: (id: string) => Session | undefined;
  onOpenThread: (s: Session) => void;
  onShowScreen: (botId: string, display: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const list = messages.filter((m) => m.id === rootId || m.replyTo === rootId);
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [list.length]);
  const typing = state.chats.find((x) => x.id === list[0]?.chatId)?.typing ?? [];
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white/80 px-3 pb-3 pt-[52px] backdrop-blur-md" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="mx-auto flex min-h-0 w-full max-w-[640px] flex-1 flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000038]">
        <div className="flex items-center gap-2 border-b border-[#F0F0EE] py-3 pl-4 pr-3">
          <ReplyArrow />
          <span className="flex-1 text-[14px] font-semibold leading-[18px]">
            {list.length - 1} {list.length === 2 ? "reply" : "replies"}
          </span>
          <button onClick={onClose} aria-label="Close replies" className="flex size-[30px] items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
            <svg width="11" height="11" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-[18px] pb-3 pt-5">
          {list.map((m, i) => (
            <Fragment key={m.id}>
              <MessageRow
                m={m}
                state={state}
                showSender={showSender || (m.role === "bot" && !!m.botId)}
                continued={false}
                sessionById={sessionById}
                chipIds={[]}
                onOpenThread={onOpenThread}
                onShowScreen={onShowScreen}
                {...rowProps(m)}
                inReplies
              />
              {i === 0 && <div className="my-1.5 h-px bg-[#F0F0EE]" />}
            </Fragment>
          ))}
          {typing.length > 0 && <span className="self-start pl-1 text-[12px] text-[#9A9A98]">{typing.map((t) => state.bots.find((b) => b.id === t)?.name).join(", ")} typing…</span>}
          <div ref={end} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft("");
            void onSend(text);
          }}
          className="m-3 mt-0 flex items-end gap-2.5 rounded-[22px] bg-white py-2 pl-4 pr-2 shadow-[0_0_0_1px_#E2E2DF]"
        >
          <ComposerInput
            autoFocus
            value={draft}
            onChange={setDraft}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="Reply"
            className="min-w-0 flex-1 bg-transparent py-[6px] text-[14px] leading-[18px] outline-none placeholder:text-[#9A9A98]"
          />
          <button type="submit" aria-label="Send" disabled={!draft.trim()} className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-ink disabled:opacity-30">
            <SendIcon />
          </button>
        </form>
      </div>
    </div>
  );
}

function ReplyArrow() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" className="shrink-0 text-[#6B6B6B]">
      <path d="M6.5 3.5L2.5 7.5l4 4M2.5 7.5h7a4 4 0 0 1 4 4v1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function dayTime(t: number) {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return `${sameDay ? "Today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clockTime(t)}`;
}

export function SendIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16">
      <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type RowProps = {
  m: Message;
  state: AppState;
  showSender: boolean;
  continued: boolean;
  sessionById: (id: string) => Session | undefined;
  chipIds: string[];
  onOpenThread: (s: Session) => void;
  onShowScreen: (botId: string, display: number) => void;
  /** Open the Your Mac tab (a heads-up about a watched Mac window). */
  onShowMac: () => void;
  /** Inline replies to this message, shown as "2 replies" under it. */
  replyCount: number;
  /** The message this one replies to, quoted above it. */
  root?: Message;
  onReply: () => void;
  onOpenReplies: () => void;
  /** Drawn inside the replies view: no quote or count, they'd say what's already on screen. */
  inReplies?: boolean;
};

const QUICK_EMOJI = ["🔥", "🙏", "👀", "🎉"];

/** The latest message in each chat and for each watch, worked out once per state (not once per message drawn). */
const lastsCache = new WeakMap<Message[], { byChat: Map<string, string>; byWatch: Map<string, string> }>();
function lasts(all: Message[]) {
  let v = lastsCache.get(all);
  if (!v) {
    v = { byChat: new Map(), byWatch: new Map() };
    for (const x of all) {
      v.byChat.set(x.chatId, x.id);
      if (x.watch) v.byWatch.set(x.watch.id, x.id);
    }
    lastsCache.set(all, v);
  }
  return v;
}

function MessageRow({ m, state, showSender, continued, sessionById, chipIds, onOpenThread, onShowScreen, onShowMac, replyCount, root, onReply, onOpenReplies, inReplies }: RowProps) {
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  // Right-click or long-press opens the message's menu: tapbacks above, Reply / Copy / Delete below.
  const [menu, setMenu] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdable = {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu(true);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      press.current = setTimeout(() => setMenu(true), 450);
    },
    onPointerUp: () => press.current && clearTimeout(press.current),
    onPointerLeave: () => press.current && clearTimeout(press.current),
  };
  const outgoing = m.role === "user";
  // The bot's latest message can offer replies as buttons (see ASKING); tapping one sends it.
  const newest = lasts(state.messages).byChat.get(m.chatId) === m.id;
  const mine = m.reactions?.find((r) => r.by === "owner");
  const setReaction = (r: { type?: Tapback; emoji?: string } | null) => {
    setPicking(false);
    setMenu(false);
    const same = r && mine && (r.type ? mine.type === r.type : mine.emoji === r.emoji);
    void post(`/api/chats/${encodeURIComponent(m.chatId)}/messages`, { id: m.id, reaction: same ? null : r }, "PATCH");
  };
  const nameOf = (by: string | undefined) => (by === "owner" ? "You" : (state.bots.find((x) => x.id === by)?.name ?? "A bot"));

  // Tapbacks sit on the bubble's top corner, away from its sender, like Messages: yours blue, the bots' gray.
  const balloons = !!m.reactions?.length && (
    <span
      className={`pointer-events-none absolute -top-[18px] z-[2] flex ${outgoing ? "-left-3.5 flex-row" : "-right-3.5 flex-row-reverse"}`}
      style={{ ...tapbackVars("light", "macos"), "--im-bg": "#FFFFFF" } as React.CSSProperties}
      title={m.reactions.map((r) => `${nameOf(r.by)} ${r.emoji ?? TAPBACK_EMOJI[r.type!]}`).join(" · ")}
    >
      {m.reactions.slice(-3).map((r, i) => (
        <span key={r.by} className="pointer-events-auto" style={{ marginLeft: outgoing && i ? -8 : 0, marginRight: !outgoing && i ? -8 : 0 }}>
          <TapbackBalloon reaction={r.type} emoji={r.emoji} own={r.by === "owner"} side={outgoing ? "left" : "right"} platform="macos" />
        </span>
      ))}
    </span>
  );

  // Hovering a message: react, reply, delete. The picker opens above the bubble.
  const actions = (
    <span className={`flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 ${picking ? "opacity-100" : ""} ${outgoing ? "flex-row-reverse" : ""}`}>
      <button onClick={() => setPicking(!picking)} aria-label="React" title="React" className="flex size-6 items-center justify-center rounded-md text-[#9A9A98] hover:bg-black/[0.05] hover:text-ink">
        <svg width="14" height="14" viewBox="0 0 16 16">
          <circle cx="7.5" cy="8.5" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5.3 9.8c.6.9 1.3 1.3 2.2 1.3s1.6-.4 2.2-1.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="5.6" cy="7" r=".8" fill="currentColor" />
          <circle cx="9.4" cy="7" r=".8" fill="currentColor" />
        </svg>
      </button>
      {!inReplies && (
        <button onClick={onReply} aria-label="Reply" title="Reply" className="flex size-6 items-center justify-center rounded-md text-[#9A9A98] hover:bg-black/[0.05] hover:text-ink">
          <ReplyArrow />
        </button>
      )}
      {/* Copy on hover; deleting is in the right-click menu. */}
      <button
        onClick={() => {
          void navigator.clipboard.writeText(m.text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        aria-label={copied ? "Copied" : "Copy"}
        className={`flex size-6 items-center justify-center rounded-md hover:bg-black/[0.05] ${copied ? "text-[#2BB673]" : "text-[#9A9A98] hover:text-ink"}`}
      >
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 3.2A1.6 1.6 0 0 0 9 2.5H4.1A1.6 1.6 0 0 0 2.5 4.1V9a1.6 1.6 0 0 0 .7 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        )}
      </button>
    </span>
  );
  const close = () => {
    setPicking(false);
    setMenu(false);
  };
  const menuItem = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-4 hover:bg-[#F2F2F0]";
  const actionMenu = menu && (
    <div className={`absolute top-[calc(100%+6px)] z-40 flex w-[168px] flex-col rounded-xl bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040] ${outgoing ? "right-0" : "left-0"}`}>
      {!inReplies && (
        <button
          onClick={() => {
            close();
            onReply();
          }}
          className={menuItem}
        >
          <ReplyArrow />
          Reply
        </button>
      )}
      <button
        onClick={() => {
          close();
          void navigator.clipboard.writeText(m.text);
        }}
        className={menuItem}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" className="shrink-0 text-[#6B6B6B]">
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 3.2A1.6 1.6 0 0 0 9 2.5H4.1A1.6 1.6 0 0 0 2.5 4.1V9a1.6 1.6 0 0 0 .7 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        Copy
      </button>
      <button
        onClick={() => {
          close();
          void post(`/api/chats/${encodeURIComponent(m.chatId)}/messages`, { id: m.id }, "DELETE");
        }}
        className={`${menuItem} text-[#B42318] hover:bg-[#FEF3F2]`}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" className="shrink-0">
          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        Delete
      </button>
    </div>
  );
  const picker = (picking || menu) && (
    <>
      <div className="fixed inset-0 z-30" onClick={close} onContextMenu={(e) => (e.preventDefault(), close())} />
      <div
        className={`absolute bottom-[calc(100%+6px)] z-40 flex items-center gap-0.5 rounded-full bg-white px-1.5 py-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040] ${outgoing ? "right-0" : "left-0"}`}
      >
        {TAPBACKS.map((t) => (
          <button key={t} onClick={() => setReaction({ type: t })} aria-label={t} className={`flex size-[34px] items-center justify-center rounded-full hover:bg-[#F2F2F0] ${mine?.type === t ? "bg-[#0088FF]/15" : ""}`}>
            <TapbackGlyph type={t} size={20} />
          </button>
        ))}
        <span className="mx-0.5 h-5 w-px bg-[#ECECEA]" />
        {QUICK_EMOJI.map((e) => (
          <button key={e} onClick={() => setReaction({ emoji: e })} aria-label={e} className={`flex size-[34px] items-center justify-center rounded-full text-[19px] hover:bg-[#F2F2F0] ${mine?.emoji === e ? "bg-[#0088FF]/15" : ""}`}>
            {e}
          </button>
        ))}
      </div>
    </>
  );
  // A reply quotes what it answers; the message replied to says how many replies it has.
  const quote = root && !inReplies && (
    <button onClick={onOpenReplies} className={`flex max-w-full items-center gap-1.5 px-1 text-[11.5px] leading-4 text-[#9A9A98] hover:text-[#6B6B6B] ${outgoing ? "self-end" : "self-start"}`}>
      <ReplyArrow />
      <span className="truncate">
        {root.role === "user" ? "You" : nameOf(root.botId)}: {root.text}
      </span>
    </button>
  );
  const replies = replyCount > 0 && !inReplies && (
    <button onClick={onOpenReplies} className={`px-1.5 text-[12px] font-medium leading-4 text-[#0A84FF] hover:underline ${outgoing ? "self-end" : "self-start"}`}>
      {replyCount} {replyCount === 1 ? "reply" : "replies"}
    </button>
  );

  // A thread a newer one took over shows as that newer one (its id was moved over), so skip leftovers.
  const chips = (chipIds.map(sessionById).filter(Boolean) as Session[]).filter((s) => !s.replacedBy);
  // A heads-up from a watched screen offers to show it, or to have the bot draft a reply right there.
  // Only the latest heads-up about a screen keeps its buttons; older ones are just history.
  const latest = m.watch && lasts(state.messages).byWatch.get(m.watch.id) === m.id;
  const watch = latest ? state.watches?.find((w) => w.id === m.watch!.id) : undefined;
  const watchActions = watch && (
    <div className="flex gap-1.5 pl-0.5">
      <button
        onClick={() => {
          // A watched Mac window shows in Your Mac (it cuts to the window with the news).
          if (watch.mac) onShowMac();
          else onShowScreen(watch.botId, watch.display);
          void post("/api/watches", { id: watch.id, action: "seen" }, "PATCH");
        }}
        className="rounded-full bg-white px-3 py-1 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]"
      >
        Show me
      </button>
      <button
        onClick={() => void post("/api/watches", { id: watch.id, action: "draft" }, "PATCH")}
        className="rounded-full bg-highlighter px-3 py-1 text-[12.5px] font-semibold leading-4 shadow-[0_0_0_1px_#0000001F]"
      >
        Draft a reply
      </button>
    </div>
  );
  // Several running at once: one quiet way to stop them all, right under them.
  const runningHere = chips.filter((s) => live(s) && !s.askWhere);
  const chipList = chips.length > 0 && (
    <div className="flex flex-col items-start gap-1.5 pt-0.5">
      {chips.map((s) => (
        <Fragment key={s.id}>
          <SessionChip session={s} state={state} onClick={() => onOpenThread(s)} />
          {needsYou(s) && (
            <NeedsYouCard
              session={s}
              state={state}
              quote
              onShow={() => (s.lastDisplay !== undefined || s.display !== undefined ? onShowScreen(s.botId, (s.display ?? s.lastDisplay)!) : onOpenThread(s))}
              onSomethingElse={() => onOpenThread(s)}
            />
          )}
        </Fragment>
      ))}
      {runningHere.length > 1 && (
        <button
          onClick={() => runningHere.forEach((s) => void post("/api/sessions", { sessionId: s.id }, "DELETE"))}
          className="pl-1 text-[12px] font-medium leading-4 text-[#9A9A98] hover:text-[#B42318]"
        >
          Stop all {runningHere.length}
        </button>
      )}
      {chips
        .filter((s) => s.askWhere && live(s))
        .map((s) => (
          <div key={`${s.id}-where`} className="flex gap-1.5 pl-1">
            <button onClick={() => void post(`/api/sessions/${s.id}/where`, { to: "mac" })} className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white">
              <MacIcon size={13} />
              On your Mac
            </button>
            <button onClick={() => void post(`/api/sessions/${s.id}/where`, { to: "cloud" })} className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]">
              <CloudIcon />
              In the cloud
            </button>
          </div>
        ))}
    </div>
  );

  if (m.role === "user")
    return (
      <div className="group/msg flex max-w-[78%] flex-col items-end gap-1 self-end">
        {quote}
        {/* Room above the bubble for its tapbacks, so they don't cover the quote or sender line. */}
        <div className={`flex min-w-0 max-w-full items-center gap-1 ${m.reactions?.length ? "mt-3.5" : ""}`}>
          {actions}
          <div className="relative min-w-0" {...holdable}>
            {picker}
            {actionMenu}
            {balloons}
            <div className="flex flex-col items-end gap-1">
              {!!m.images?.length && <MessageImages images={m.images} />}
              {m.text && <div className="select-text whitespace-pre-wrap rounded-[18px] bg-ink px-3.5 py-2 text-[14px] leading-5 text-white [overflow-wrap:anywhere]">{m.text}</div>}
            </div>
          </div>
        </div>
        {m.via === "sms" && (
          <span data-tip="You texted this from your phone; the answer goes back by text" className="flex items-center gap-1 pr-1 text-[11.5px] leading-4 text-[#9A9A98]">
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden className="shrink-0">
              <rect x="4.2" y="1.5" width="7.6" height="13" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M7 12.2h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            via text
          </span>
        )}
        {m.via && m.via !== "sms" && (
          <span data-tip={`You sent this in ${CHANNEL_NAME[m.via]}; the answer went back there`} className="flex items-center gap-1 pr-1 text-[11.5px] leading-4 text-[#9A9A98]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/logos/${m.via}.svg`} alt="" width={11} height={11} className="shrink-0 rounded-[3px] opacity-80" />
            via {CHANNEL_NAME[m.via]}
          </span>
        )}
        {replies}
        {chipList}
      </div>
    );

  // A text or call to the bot's number from someone else.
  if (m.role === "system" && m.sms) return <TextCard m={m} state={state} />;

  // A call shows as a bubble from you in the bot's color, like a call in Messages.
  if (m.call) {
    const caller = state.bots.find((x) => `bot:${x.id}` === m.chatId);
    const fill = !caller || caller.isMain ? "#0A0A0A" : caller.color;
    const mins = Math.floor(m.call.seconds / 60);
    return (
      <div
        className="flex items-center gap-2 self-end rounded-[18px] px-3.5 py-2 text-[14px] leading-5"
        style={{ background: fill, color: readableOn(fill) }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
          <path d="M12 9c-3.3 0-6.3.9-8.4 2.4-.6.4-.8 1.2-.5 1.9l.9 1.8c.3.7 1.1 1 1.8.8l2.6-.8c.6-.2 1-.7 1-1.3v-1.6c.9-.3 1.8-.4 2.6-.4s1.7.1 2.6.4v1.6c0 .6.4 1.1 1 1.3l2.6.8c.7.2 1.5-.1 1.8-.8l.9-1.8c.3-.7.1-1.5-.5-1.9C18.3 9.9 15.3 9 12 9z" />
        </svg>
        {mins ? `${mins}m ` : ""}
        {m.call.seconds % 60}s · {m.call.phone ? "Phone call" : "Call"} ended
      </div>
    );
  }

  if (m.role === "system" && m.email) return <EmailCard m={m} state={state} />;

  if (m.role === "system" && m.memory) return <MemoryNote m={m} />;

  if (m.role === "system")
    return (
      <div className="flex flex-col items-center gap-1.5 self-center py-0.5">
        <div className="flex items-center gap-1.5 rounded-full bg-[#F7F7F6] px-3 py-1 text-[12px] leading-4 text-[#6B6B6B]">{m.text}</div>
        {chipList}
      </div>
    );

  const b = state.bots.find((x) => x.id === m.botId);
  return (
    <div className="group/msg flex max-w-[86%] items-end gap-2 self-start">
      {showSender && (b && !continued ? <Mascot botId={b.id} color={b.color} size={24} /> : <span className="w-6 shrink-0" />)}
      <div className="flex min-w-0 flex-col gap-1">
        {showSender && b && !continued && <div className="pl-3 text-[11px] leading-[14px] text-[#9A9A98]">{b.name}</div>}
        {!!m.asked?.length && <AskedLine state={state} asked={m.asked} by={m.botId} />}
        {quote}
        <div className={`flex min-w-0 max-w-full items-center gap-1 self-start ${m.reactions?.length ? "mt-3.5" : ""}`}>
          <div className="relative min-w-0" {...holdable}>
            {picker}
            {actionMenu}
            {balloons}
            <div className="whitespace-pre-wrap rounded-[18px] bg-[#F2F2F0] px-3.5 py-2 text-[14px] leading-5 [overflow-wrap:anywhere]">
              <Rich text={withoutBriefing(m.text)} />
            </div>
          </div>
          {actions}
        </div>
        {replies}
        {newest && !!m.options?.length && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {m.options.map((o) => (
              <button
                key={o}
                onClick={() => void post(`/api/chats/${encodeURIComponent(m.chatId)}/messages`, { text: o })}
                className="rounded-full bg-white px-3 py-1.5 text-[13px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]"
              >
                {o}
              </button>
            ))}
          </div>
        )}
        {m.emailed && (
          <span data-tip={`Also sent to ${m.emailed}, as a reply to your email`} className="flex items-center gap-1 pl-3 text-[11.5px] leading-4 text-[#9A9A98]">
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden className="shrink-0">
              <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M2.5 4.5 8 8.6l5.5-4.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            Emailed to you
          </span>
        )}
        {watchActions}
        {chipList}
      </div>
    </div>
  );
}

/** Opens two bots' conversation with each other (from "Asked ● Sam" over a reply). */
const PairOpen = createContext<(pairId: string, focusId?: string) => void>(() => {});

/** Over a reply: the teammates the bot asked first ("Asked ● Sam"). Click to open their conversation, at that exchange. */
function AskedLine({ state, asked, by }: { state: AppState; asked: NonNullable<Message["asked"]>; by?: string }) {
  const open = useContext(PairOpen);
  const seen = new Set<string>();
  const first = asked.filter((a) => !seen.has(a.botId) && seen.add(a.botId));
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-3 text-[12.5px] leading-4 text-[#9A9A98]">
      Asked
      {first.map((a) => {
        const t = state.bots.find((b) => b.id === a.botId);
        if (!t) return null;
        return (
          <button
            key={a.botId}
            onClick={() => by && open(pairChatId(by, t.id), a.questionId)}
            title={`See what was asked and what ${t.name} said`}
            className="flex items-center gap-1 rounded-full text-[#6B6B6B] hover:text-ink"
          >
            <Mascot botId={t.id} color={t.color} size={15} antenna={false} />
            {t.name}
            <svg width="8" height="8" viewBox="0 0 12 12" aria-hidden>
              <path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        );
      })}
    </div>
  );
}

/** A bot's name as a label, in its color (Sam's, which is black, in ink). */
const nameColor = (b: Bot) => (b.isMain || /^#0[0-9a-f]{5}$/i.test(b.color) ? "#0A0A0A" : `color-mix(in oklab, ${b.color} 75%, black)`);

/**
 * Two bots' conversation with each other (what Max asked Sam, and what Sam said, over time), over
 * the chat: both of them in the header, each message under its sender's name in its color, a time
 * between exchanges, and Close chat. Opens at the exchange it was opened from.
 */
function PairSheet({ state, pairId, focusId, onClose }: { state: AppState; pairId: string; focusId?: string; onClose: () => void }) {
  const bots = pairId
    .slice(5)
    .split(":")
    .map((id) => state.bots.find((b) => b.id === id))
    .filter(Boolean) as Bot[];
  const messages = state.messages.filter((m) => m.chatId === pairId);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const target = focusId ? el.querySelector<HTMLElement>(`[data-msg="${focusId}"]`) : null;
    if (target) target.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
  }, [focusId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const label = (b: Bot) => `${b.name} · ${b.isMain ? "Chief of Staff" : b.role}`;
  return (
    <div className="absolute inset-0 z-40 flex animate-[screen-in_200ms_ease-out] flex-col bg-white">
      <div className="flex shrink-0 justify-center px-5 pb-2 pt-4">
        <div className="flex max-w-full items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4 shadow-[0_0_0_1px_#ECECEA]">
          {bots.map((b, i) => (
            <Fragment key={b.id}>
              {i > 0 && (
                <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0 text-[#C9C9C6]" aria-hidden>
                  <path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <span className={`flex min-w-0 items-center gap-2 ${i > 0 ? "pl-0.5" : ""}`}>
                <Mascot botId={b.id} color={b.color} size={26} antenna={false} />
                <span className="truncate text-[13.5px] font-medium leading-[18px]">{label(b)}</span>
              </span>
            </Fragment>
          ))}
        </div>
      </div>
      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-5 pb-24 pt-4">
        {messages.length === 0 && <div className="m-auto text-[13.5px] text-[#9A9A98]">Nothing between them yet.</div>}
        {messages.map((m, i) => {
          const b = state.bots.find((x) => x.id === m.botId);
          const prev = messages[i - 1];
          const gap = !prev || m.at - prev.at > 15 * 60_000;
          const continued = !!prev && prev.botId === m.botId && !gap;
          const next = messages[i + 1];
          // The mascot sits by the last message of each run, like iMessage.
          const lastOfRun = !next || next.botId !== m.botId || next.at - m.at > 15 * 60_000;
          return (
            <Fragment key={m.id}>
              {gap && <div className="self-center py-2 text-[12px] leading-4 text-[#9A9A98]">{dayTime(m.at)}</div>}
              <div data-msg={m.id} className={`flex max-w-[88%] items-end gap-2 self-start ${continued ? "" : "pt-1.5"}`}>
                {b && lastOfRun ? <Mascot botId={b.id} color={b.color} size={24} /> : <span className="w-6 shrink-0" />}
                <div className="flex min-w-0 flex-col gap-1">
                  {b && !continued && (
                    <span className="pl-3 text-[12px] font-medium leading-4" style={{ color: nameColor(b) }}>
                      {label(b)}
                    </span>
                  )}
                  <div className={`whitespace-pre-wrap rounded-[18px] bg-[#F2F2F0] px-3.5 py-2 text-[14px] leading-5 [overflow-wrap:anywhere] ${m.id === focusId ? "shadow-[0_0_0_2px_#0A0A0A1F]" : ""}`}>
                    <Rich text={m.text} />
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-white via-white/90 to-white/0 pb-5 pt-10">
        <button onClick={onClose} className="pointer-events-auto rounded-full bg-white px-5 py-2.5 text-[14px] font-medium shadow-[0_0_0_1px_#E2E2DF,0_8px_20px_-10px_#00000040] hover:bg-[#F7F7F6]">
          Close chat
        </button>
      </div>
    </div>
  );
}

/**
 * "Remembered: …" with an Undo, and, when the fact may replace an older one (their parents moved),
 * an offer to forget the old one. Nothing is forgotten without their tap.
 */
/** "+15551234567" → "+1 (555) 123-4567". */
const prettyPhone = (n: string) => {
  const d = n.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : n || "an unknown number";
};

/** A text or a call to the bot's number from someone other than the user: who, and what they said. */
function TextCard({ m, state }: { m: Message; state: AppState }) {
  const t = m.sms!;
  const b = state.bots.find((x) => `bot:${x.id}` === m.chatId);
  const call = !!m.call;
  const mins = m.call ? Math.floor(m.call.seconds / 60) : 0;
  return (
    <div className="flex w-full max-w-[460px] flex-col gap-1.5 self-start">
      <div className="flex items-center gap-1.5 pl-1 text-[11.5px] leading-4 text-[#9A9A98]">
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
          {call ? (
            <path d="M3.5 2.5h2.6l1 2.6-1.5 1a7 7 0 003.3 3.3l1-1.5 2.6 1v2.6a1 1 0 01-1 1A10 10 0 012.5 3.5a1 1 0 011-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          ) : (
            <>
              <rect x="4.2" y="1.5" width="7.6" height="13" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M7 12.2h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </>
          )}
        </svg>
        {call ? `Call to ${b?.name ?? "the bot"}` : `Text to ${b?.name ?? "the bot"}`} · {clockTime(m.at)}
        {call && m.call ? ` · ${mins ? `${mins}m ` : ""}${m.call.seconds % 60}s` : ""}
      </div>
      <div className="flex flex-col gap-1 rounded-[16px] bg-white px-3.5 py-2.5 shadow-[0_0_0_1px_#E6E6E3,0_6px_16px_-12px_#00000030]">
        <div className="flex items-baseline gap-1.5 text-[12.5px] leading-4">
          <span className="text-[#9A9A98]">From</span>
          <span className="font-medium text-ink">{prettyPhone(t.from)}</span>
        </div>
        <div className="select-text whitespace-pre-wrap text-[13.5px] leading-5 text-[#3A3A38] [overflow-wrap:anywhere]">{m.text}</div>
      </div>
      {!!m.images?.length && <MessageImages images={m.images} align="start" />}
    </div>
  );
}

/** "Jordan Lee <jordan@acme.com>" → its name and address. */
const person = (s: string) => {
  const x = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  return x && x[1] ? { name: x[1], address: x[2] } : { name: s, address: "" };
};

/** An email the bot got or sent, as a card in its chat: who, the subject, the text (opens in full), images and files. */
function EmailCard({ m, state }: { m: Message; state: AppState }) {
  const e = m.email!;
  const [open, setOpen] = useState(false);
  const b = state.bots.find((x) => `bot:${x.id}` === m.chatId);
  const from = person(e.from);
  const long = m.text.length > 280 || m.text.split("\n").length > 4;
  const label = e.dir === "in" ? (e.fromOwner ? `You emailed ${b?.name ?? "the bot"}` : `Email to ${b?.name ?? "the bot"}`) : `${b?.name ?? "The bot"} sent an email`;
  return (
    <div className={`flex w-full max-w-[460px] flex-col gap-1.5 self-start ${e.bulk ? "opacity-75" : ""}`}>
      <div className="flex items-center gap-1.5 pl-1 text-[11.5px] leading-4 text-[#9A9A98]">
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
          <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.5 4.5 8 8.6l5.5-4.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        {label} · {clockTime(m.at)}
        {e.bulk && <span data-tip="A newsletter or automatic email: the bot doesn't speak up about these">· automatic</span>}
      </div>
      <div className="flex flex-col gap-1 rounded-[16px] bg-white px-3.5 py-2.5 shadow-[0_0_0_1px_#E6E6E3,0_6px_16px_-12px_#00000030]">
        <div className="flex min-w-0 items-baseline gap-1.5 text-[12.5px] leading-4">
          <span className="shrink-0 text-[#9A9A98]">{e.dir === "in" ? "From" : "To"}</span>
          {e.dir === "in" ? (
            <span className="min-w-0 truncate" title={e.from}>
              <span className="font-medium text-ink">{from.name}</span>
              {from.address && <span className="text-[#9A9A98]"> {from.address}</span>}
            </span>
          ) : (
            <span className="min-w-0 truncate font-medium text-ink" title={[...e.to, ...(e.cc ?? [])].join(", ")}>
              {e.to.map((t) => person(t).name).join(", ")}
              {e.cc?.length ? <span className="font-normal text-[#9A9A98]"> · cc {e.cc.length}</span> : null}
            </span>
          )}
        </div>
        <div className="text-[14px] font-semibold leading-5 [overflow-wrap:anywhere]">{e.subject}</div>
        {m.text && (
          <div className={`select-text whitespace-pre-wrap text-[13.5px] leading-5 text-[#3A3A38] [overflow-wrap:anywhere] ${open ? "" : "line-clamp-4"}`}>{m.text}</div>
        )}
        {long && (
          <button onClick={() => setOpen(!open)} className="self-start text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
            {open ? "Show less" : "Show all"}
          </button>
        )}
        {!!e.files?.length && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {e.files.map((f, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full bg-[#F2F2F0] px-2.5 py-1 text-[12px] leading-4 text-[#3A3A38]">
                <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
                  <path d="M10.5 4.5 5.6 9.4a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.4 4.4 0 0 0 6.2 6.2l4.4-4.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                {f.name}
                <span className="text-[#9A9A98]">{f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1e3))} KB`}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {!!m.images?.length && <MessageImages images={m.images} align="start" />}
    </div>
  );
}

function MemoryNote({ m }: { m: Message }) {
  const mem = m.memory!;
  const [busy, setBusy] = useState(false);
  const act = (action: "undo" | "forget-old") => {
    setBusy(true);
    void post("/api/memory", { action, messageId: m.id }).finally(() => setBusy(false));
  };
  const button = "shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium leading-4 text-ink hover:bg-black/[0.05] disabled:opacity-40";
  return (
    <div className="flex w-full max-w-[400px] flex-col self-center rounded-[14px] bg-[#F7F7F6] py-2 pl-3 pr-1.5 text-[12px] leading-4">
      <div className="flex items-start gap-2">
        <svg width="13" height="13" viewBox="0 0 16 16" className="mt-[1.5px] shrink-0 text-[#9A9A98]" aria-hidden>
          <path d="M8 2.5c-2.6 0-4.5 1.9-4.5 4.3 0 1.5.8 2.6 1.8 3.4v2.3h5.4v-2.3c1-.8 1.8-1.9 1.8-3.4 0-2.4-1.9-4.3-4.5-4.3zM6.3 14.5h3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <div className="min-w-0 flex-1 pt-px">
          <span className="font-medium text-[#6B6B6B]">{mem.undone ? "Not remembered" : "Remembered"}</span>
          <span className={`line-clamp-2 text-[#3A3A3A] ${mem.undone ? "text-[#9A9A98] line-through" : ""}`} title={mem.fact}>
            {mem.fact}
          </span>
        </div>
        {!mem.undone && (
          <button disabled={busy} onClick={() => act("undo")} className={button}>
            Undo
          </button>
        )}
      </div>
      {mem.old && !mem.undone && (
        <div className="mt-1.5 flex items-center gap-2 border-t border-[#ECECEA] pt-1.5 pl-[21px]">
          {mem.old.forgotten ? (
            <span className="min-w-0 flex-1 text-[#9A9A98]">Forgot the old one</span>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-[#9A9A98]" title={mem.old.text}>
                Replaces: {mem.old.text}
              </span>
              <button disabled={busy} onClick={() => act("forget-old")} className={button}>
                Forget old
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Black or white text, whichever reads on a bot's color. */
function readableOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#0A0A0A" : "#FFFFFF";
}

/** A thread, collapsed to one line in the chat. Opens the thread sheet. */
function SessionChip({ session: s, state, onClick }: { session: Session; state: AppState; onClick: () => void }) {
  const b = state.bots.find((x) => x.id === s.botId);
  const waiting = needsYou(s);
  return (
    <button
      onClick={onClick}
      className="flex max-w-full items-center gap-[9px] rounded-[14px] bg-white py-[9px] pl-3 pr-3.5 text-left shadow-[0_0_0_1px_#E6E6E3] hover:shadow-[0_0_0_1px_#C9C9C6]"
    >
      <StatusIcon session={s} size={14} dark />
      <span className={`truncate text-[14px] leading-[18px] ${live(s) || waiting ? "text-ink" : "text-[#6B6B6B]"}`}>{s.title}</span>
      {/* Where it runs: the user's Mac or the cloud (deciding: nothing yet). */}
      {s.runsOn === "mac" ? (
        <span title="On your Mac" className="flex shrink-0 items-center gap-1 rounded-full bg-[#F2F2F0] px-1.5 py-px text-[11px] leading-[14px] text-[#3A3A38]">
          <MacIcon size={11} />
          Your Mac
        </span>
      ) : s.askWhere && live(s) ? (
        <span className="shrink-0 text-[12px] leading-4 text-[#6B6B6B]">· where?</span>
      ) : null}
      {waiting && <span className="shrink-0 text-[12px] leading-4 text-[#6B6B6B]">· {s.blocker ? `needs ${BLOCKER_ASK[s.blocker]}` : "needs you"}</span>}
      {b && s.sentVia !== "you" && s.chatId !== `bot:${b.id}` && <span className="shrink-0 text-[12px] leading-4 text-[#9A9A98]">· {b.name}</span>}
    </button>
  );
}

/* ---------------- Thread sheet ---------------- */

type Line =
  | { kind: "note"; at: number; text: string }
  | { kind: "steps"; at: number; steps: { tool: string; detail: string; who?: string; screen?: number }[] }
  | { kind: "reply"; at: number; role: "user" | "bot"; text: string }
  | { kind: "event"; at: number; text: string };

/** Build the thread's transcript: narration as prose, tool steps folded, replies in order. */
function timeline(s: Session): Line[] {
  const lines: Line[] = [];
  for (const st of s.steps) {
    if (st.tool === "setup") continue;
    if (st.tool === "note") lines.push({ kind: "note", at: st.at, text: st.who ? `${st.who}: ${st.detail}` : st.detail });
    else {
      const last = lines[lines.length - 1];
      if (last?.kind === "steps") last.steps.push(st);
      else lines.push({ kind: "steps", at: st.at, steps: [st] });
    }
  }
  for (const r of s.replies) lines.push(r.note ? { kind: "event", at: r.at, text: r.note } : { kind: "reply", at: r.at, role: r.role, text: r.text });
  if (!s.replies.length && s.answer) lines.push({ kind: "reply", at: s.endedAt ?? Date.now(), role: "bot", text: s.answer });
  return lines.sort((a, b) => a.at - b.at);
}

export function ThreadSheet({ state, session: s, onClose, onShowComputer }: { state: AppState; session: Session; onClose: () => void; onShowComputer: () => void }) {
  // "Working for 1m 23s" counts up while it's open.
  useNow(live(s) ? 1000 : 60_000);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [openSteps, setOpenSteps] = useState<number[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const b = state.bots.find((x) => x.id === s.botId)!;
  const via = s.sentVia === "routine" ? undefined : s.sentVia === "you" ? b : state.bots.find((x) => x.id === s.sentVia);
  const lines = timeline(s);
  const toolCount = s.steps.filter((x) => x.tool !== "note" && x.tool !== "setup").length;
  const started = s.startedAt ?? s.createdAt;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length, s.status]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await post(`/api/sessions/${s.id}/reply`, { text });
  };

  return (
    // Clicking anywhere outside the sheet closes it, like the × does.
    <div onClick={onClose} className="absolute inset-0 z-20 flex flex-col bg-white/70 px-3 pb-3 pt-[52px] backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000038]">
        <div className="flex items-center gap-2.5 border-b border-[#F0F0EE] py-3.5 pl-4 pr-3.5">
          <Mascot botId={b.id} color={b.color} size={32} />
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="truncate text-[15px] font-semibold leading-[18px]">{s.title}</span>
            <button onClick={onShowComputer} className="flex items-center gap-1.5 text-left text-[12px] leading-4 text-[#6B6B6B] hover:text-ink">
              {b.name} · {s.runsOn === "mac" ? "on your Mac · " : ""}
              {s.askWhere && live(s) ? "waiting for you" : live(s) ? "working" : s.status === "done" ? "finished" : "stopped"} · {toolCount} steps
            </button>
          </div>
          {s.runsOn !== "mac" && state.mac?.ready && (s.blocker || s.status === "failed") && (
            <button
              onClick={() => void post(`/api/sessions/${s.id}/where`, { move: true })}
              title="Do this on your Mac instead, where your apps and sign-ins are"
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]"
            >
              <MacIcon size={13} />
              Try on your Mac
            </button>
          )}
          {live(s) ? (
            <button onClick={() => void post("/api/sessions", { sessionId: s.id }, "DELETE")} className="rounded-full px-3 py-1.5 text-[13px] font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
              Stop
            </button>
          ) : (
            <button
              onClick={() => {
                onClose();
                void post(`/api/sessions/${s.id}`, {}, "DELETE");
              }}
              className="rounded-full px-3 py-1.5 text-[13px] font-medium text-[#B42318] shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#FEF3F2]"
            >
              Delete
            </button>
          )}
          <button onClick={onClose} aria-label="Close thread" className="flex size-[34px] items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] pb-3 pt-4">
          <div className="flex w-[86%] flex-col items-end gap-1.5 self-end">
            <div className="flex items-center gap-1.5 text-[12px] leading-4 text-[#6B6B6B]">
              {via && <Mascot botId={via.id} color={via.color} size={16} antenna={false} />}
              {s.sentVia === "routine" ? "Sent by a routine" : `Sent via ${via?.name ?? "the main bot"}`}
            </div>
            <div className="flex flex-col gap-2 rounded-[18px] bg-[#FBFFE0] px-[15px] pb-2.5 pt-[11px] shadow-[0_0_0_1px_#EEF7A8]">
              <div className={`whitespace-pre-wrap text-[14px] leading-[21px] ${expanded ? "" : "line-clamp-3"}`}>{s.goal}</div>
              {s.goal.length > 160 && (
                <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 self-start text-[13px] leading-4 text-[#6B6B6B]">
                  {expanded ? "Show less" : "Show more"}
                  <svg width="10" height="10" viewBox="0 0 10 10" className={expanded ? "rotate-180" : ""}>
                    <path d="M2 3.5l3 3 3-3" fill="none" stroke="#6B6B6B" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2.5 pt-1.5">
            {/* It can't start until the user says where: the choice is right here, not only in the chat. */}
            {s.askWhere && live(s) && (
              <div className="flex flex-col gap-2 rounded-[14px] bg-[#FBFFD9] px-3.5 py-3 shadow-[0_0_0_1px_#E8F28A]">
                <span className="text-[13.5px] font-medium leading-[18px]">Where should {b.name} do this?</span>
                <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">It starts as soon as you pick. Your messages here go along with it.</span>
                <div className="flex gap-1.5 pt-0.5">
                  <button onClick={() => void post(`/api/sessions/${s.id}/where`, { to: "mac" })} className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white">
                    <MacIcon size={12} />
                    Your Mac
                  </button>
                  <button onClick={() => void post(`/api/sessions/${s.id}/where`, { to: "cloud" })} className="rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]">
                    {b.name}&rsquo;s computer
                  </button>
                </div>
              </div>
            )}
            <span className="text-[13px] leading-4 text-[#9A9A98]">
              {s.askWhere && live(s) ? `Waiting for you for ${since(started)}` : live(s) ? `Working for ${since(started)}` : s.status === "queued" ? "Up next" : `Worked for ${since(started, s.endedAt)}`}
              {s.helperNames?.length
                ? ` · with helpers ${s.helperNames.join(", ")}`
                : live(s) && s.helperScreens?.length
                  ? ` · with ${s.helperScreens.length} helper${s.helperScreens.length === 1 ? "" : "s"}`
                  : ""}
            </span>
            <div className="h-px bg-[#ECECEA]" />
          </div>

          {lines.map((l, i) =>
            l.kind === "note" ? (
              <p key={i} className="text-[14px] leading-[22px] [overflow-wrap:anywhere]">
                {l.text}
              </p>
            ) : l.kind === "steps" ? (
              <div key={i} className="flex flex-col gap-1 self-start">
                <button
                  onClick={() => setOpenSteps(openSteps.includes(i) ? openSteps.filter((x) => x !== i) : [...openSteps, i])}
                  className="flex items-center gap-2 self-start rounded-[10px] bg-[#F7F7F6] py-[5px] pl-2 pr-2.5 text-left hover:bg-[#F0F0EE]"
                >
                  <svg width="13" height="13" viewBox="0 0 14 14">
                    <rect x="1.5" y="2" width="11" height="7.5" rx="1.5" fill="none" stroke="#6B6B6B" strokeWidth="1.3" />
                    <path d="M5 12h4" fill="none" stroke="#6B6B6B" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  <span className="max-w-[280px] truncate text-[12px] leading-4 text-[#3A3A38]">{l.steps[l.steps.length - 1].detail}</span>
                  <span className="font-mono text-[11px] leading-[14px] text-[#9A9A98]">
                    {l.steps.length} step{l.steps.length === 1 ? "" : "s"} {openSteps.includes(i) ? "‹" : "›"}
                  </span>
                </button>
                {openSteps.includes(i) && (
                  <div className="flex flex-col gap-0.5 pl-2">
                    {l.steps.map((st, j) => (
                      <div key={j} className="flex gap-2 font-mono text-[11.5px] leading-[17px]">
                        <span className="w-[86px] shrink-0 truncate text-[#9A9A98]">{st.who ?? st.tool}</span>
                        <span className="min-w-0 break-words">
                          {st.detail}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : l.kind === "event" ? (
              <span key={i} className="self-center text-[12px] leading-4 text-[#9A9A98]">
                {l.text}
              </span>
            ) : l.role === "user" ? (
              <div key={i} className="max-w-[80%] self-end whitespace-pre-wrap rounded-[18px] bg-ink px-3.5 py-2 text-[14px] leading-5 text-white">
                {l.text}
              </div>
            ) : (
              <div key={i} className="whitespace-pre-wrap text-[14px] leading-[22px] [overflow-wrap:anywhere]">
                <Rich text={l.role === "bot" ? withoutBriefing(l.text) : l.text} />
              </div>
            ),
          )}
          {s.status === "failed" && s.error && (
            <div className="rounded-xl bg-[#FBFFE0] px-3 py-2.5 text-[13px] leading-5 shadow-[0_0_0_1px_#E6F57A]">{s.error}</div>
          )}
          {live(s) && <span className="animate-pulse text-[14px] leading-[18px] text-[#B5B5B2]">{s.status === "queued" ? "Queued" : "Thinking"}</span>}
          <div ref={end} />
        </div>

        {needsYou(s) && (
          <div className="px-3 pb-2">
            <NeedsYouCard session={s} state={state} onShow={onShowComputer} onSomethingElse={() => document.getElementById("thread-reply")?.focus()} />
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="px-3 pb-3"
        >
          <div className="flex items-end gap-2.5 rounded-[22px] bg-white py-2 pl-3.5 pr-2 shadow-[0_0_0_1px_#E2E2DF]">
            <ComposerInput
              id="thread-reply"
              value={draft}
              onChange={setDraft}
              placeholder={live(s) ? "Reply in thread · goes in after this step" : "Reply in thread · picks it back up"}
              className="min-w-0 flex-1 bg-transparent py-[6px] text-[14px] leading-[18px] outline-none placeholder:text-[#9A9A98]"
            />
            <button type="submit" aria-label="Send" disabled={!draft.trim()} className="flex size-[30px] items-center justify-center rounded-full bg-ink disabled:opacity-30">
              <SendIcon />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function since(from: number, to = Date.now()) {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/* ---------------- New message: the To: picker ---------------- */

export function ToPicker({ state, onOpenChat, onCancel }: { state: AppState; onOpenChat: (chatId: string) => void; onCancel: () => void }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"pick" | "bot" | "group">("pick");
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const bots = teamOf(state).filter((b) => !q || `${b.name} ${b.role}`.toLowerCase().includes(q));

  const openBot = (botId: string) => onOpenChat(`bot:${botId}`);
  const createBot = async () => {
    const res = await post("/api/bots", { name, role });
    const json = (await res.json()) as { chatId?: string; error?: string };
    if (json.chatId) onOpenChat(json.chatId);
    else setError(json.error ?? "Couldn't create that bot");
  };
  const createGroup = async () => {
    const res = await post("/api/chats", { botIds: picked, title: name });
    const json = (await res.json()) as { chatId?: string };
    if (json.chatId) onOpenChat(json.chatId);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (!(e.metaKey || e.ctrlKey) || mode !== "pick") return;
      const n = Number(e.key);
      if (!n) return;
      e.preventDefault();
      if (n === 1) setMode("bot");
      else if (n === 2) setMode("group");
      else if (bots[n - 3]) openBot(bots[n - 3].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-[#ECECEA] bg-white">
      <div className="flex h-[54px] items-center gap-2 border-b border-[#ECECEA] bg-[#FCFCFB] px-5">
        <span className="text-[15px] leading-5 text-[#6B6B6B]">To:</span>
        {picked.map((p) => {
          const b = state.bots.find((x) => x.id === p)!;
          return (
            <button key={p} onClick={() => setPicked(picked.filter((x) => x !== p))} className="flex items-center gap-1.5 rounded-full bg-[#EEEEEC] py-0.5 pl-1 pr-2 text-[13px]">
              <Mascot botId={b.id} color={b.color} size={18} />
              {b.name} ×
            </button>
          );
        })}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "group" ? "Add bots to the group…" : "Start a chat with…"}
          className="min-w-0 flex-1 bg-transparent text-[15px] leading-5 outline-none placeholder:text-[#9A9A98]"
        />
        <button onClick={onCancel} className="text-[13px] text-[#6B6B6B] hover:text-ink">
          Cancel
        </button>
      </div>

      {/* Clicking the empty space around the menu closes it, like clicking out of a popover. */}
      <div onClick={(e) => e.target === e.currentTarget && onCancel()} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3.5">
        <div className="flex flex-col gap-0.5 rounded-[20px] bg-white p-2 shadow-[0_0_0_1px_#E6E6E3,0_18px_40px_-18px_#0000002E]">
          {mode === "bot" ? (
            <div className="flex flex-col gap-2.5 p-2">
              <span className="text-[14px] font-semibold">Create a new bot</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Nova" className="rounded-xl px-3 py-2 text-[14px] shadow-[0_0_0_1px_#E2E2DF] outline-none" />
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="What it does, e.g. Research" className="rounded-xl px-3 py-2 text-[14px] shadow-[0_0_0_1px_#E2E2DF] outline-none" />
              <span className="text-[12px] leading-4 text-[#6B6B6B]">
                It works on {teamOf(state).find((b) => b.isMain)?.name ?? "the main bot"}&apos;s computer, on screens of its own there. You can give it a computer of its own in its Details.
              </span>
              {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
              <div className="flex gap-2">
                <button disabled={!name.trim()} onClick={() => void createBot()} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-30">
                  Create
                </button>
                <button onClick={() => setMode("pick")} className="rounded-full px-4 py-2 text-[13px] shadow-[0_0_0_1px_#E2E2DF]">
                  Back
                </button>
              </div>
            </div>
          ) : (
            <>
              {mode === "pick" && (
                <>
                  <PickerRow icon={<span className="text-[16px]">+</span>} label="Create new bot" kbd={<Kbd n={1} />} onClick={() => setMode("bot")} focused />
                  <PickerRow icon={<GroupIcon />} label="Create group chat" kbd={<Kbd n={2} />} onClick={() => setMode("group")} />
                  <div className="mx-2.5 my-1 h-px bg-[#F0F0EE]" />
                </>
              )}
              {mode === "group" && (
                <div className="flex items-center gap-2 px-2.5 pb-1 pt-1.5">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name (optional)" className="min-w-0 flex-1 rounded-xl px-3 py-2 text-[14px] shadow-[0_0_0_1px_#E2E2DF] outline-none" />
                  <button disabled={picked.length < 2} onClick={() => void createGroup()} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-30">
                    Start group
                  </button>
                </div>
              )}
              {bots.map((b, i) => (
                <PickerRow
                  key={b.id}
                  icon={<Mascot botId={b.id} color={b.color} size={30} />}
                  label={b.name}
                  sub={b.role}
                  kbd={mode === "pick" && i < 7 ? <Kbd n={i + 3} /> : mode === "group" ? <Check on={picked.includes(b.id)} /> : undefined}
                  onClick={() => (mode === "group" ? setPicked(picked.includes(b.id) ? picked.filter((x) => x !== b.id) : [...picked, b.id]) : openBot(b.id))}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function Kbd({ n }: { n: number }) {
  return (
    <span className="flex gap-[3px]">
      <span className="rounded-[5px] bg-white px-1.5 py-0.5 text-[11px] leading-[14px] text-[#6B6B6B] shadow-[0_0_0_1px_#E2E2DF]">⌘</span>
      <span className="rounded-[5px] bg-white px-1.5 py-0.5 font-mono text-[11px] leading-[14px] text-[#6B6B6B] shadow-[0_0_0_1px_#E2E2DF]">{n}</span>
    </span>
  );
}

function PickerRow({ icon, label, sub, kbd, onClick, focused }: { icon: React.ReactNode; label: string; sub?: string; kbd?: React.ReactNode; onClick: () => void; focused?: boolean }) {
  return (
    <button onClick={onClick} className={`flex h-12 items-center gap-3 rounded-xl px-2.5 text-left ${focused ? "bg-[#EEEEEC]" : "hover:bg-[#F7F7F6]"}`}>
      <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-[#F2F2F0]">{icon}</span>
      <span className="flex flex-1 items-center gap-1.5">
        <span className="text-[14px] font-medium leading-[18px]">{label}</span>
        {sub && <span className="text-[13px] leading-4 text-[#9A9A98]">{sub}</span>}
      </span>
      {kbd}
    </button>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span className={`flex size-5 items-center justify-center rounded-md ${on ? "bg-ink" : "shadow-[0_0_0_1.5px_#C9C9C6]"}`}>
      {on && (
        <svg width="11" height="11" viewBox="0 0 14 14">
          <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="#E9FF3B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function GroupIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16">
      <circle cx="6" cy="5.5" r="2.3" fill="none" stroke="#3A3A38" strokeWidth="1.3" />
      <path d="M1.8 13c.4-2.3 2.1-3.6 4.2-3.6s3.8 1.3 4.2 3.6" fill="none" stroke="#3A3A38" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="11.3" cy="5.8" r="1.8" fill="none" stroke="#3A3A38" strokeWidth="1.3" />
      <path d="M11.6 9.6c1.5.2 2.5 1.3 2.8 3" fill="none" stroke="#3A3A38" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" className="shrink-0">
      <path d="M4.5 12.5h7.2a2.8 2.8 0 0 0 .4-5.6 4 4 0 0 0-7.7.9 2.4 2.4 0 0 0 .1 4.7z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A bot waiting on the user, as a card they can act on in one tap: sign it in, answer with one of the
 * replies it offered, retry, or move it to their Mac, instead of working out what to type back.
 */
function NeedsYouCard({ session: s, state, quote, onShow, onSomethingElse }: { session: Session; state: AppState; quote?: boolean; onShow: () => void; onSomethingElse: () => void }) {
  const [busy, setBusy] = useState(false);
  const b = state.bots.find((x) => x.id === s.botId);
  const name = b?.name ?? "The bot";
  const reply = async (text: string) => {
    setBusy(true);
    await post(`/api/sessions/${s.id}/reply`, { text });
    setBusy(false);
  };
  const toMac = s.runsOn !== "mac" && !!state.mac?.ready;
  // Dismiss means done with it: the thread stops and never asks again.
  const dismiss = () => {
    setBusy(true);
    void post(`/api/sessions/${s.id}`, { dismiss: true }, "PATCH");
  };
  const failed = s.status === "failed";
  const title = s.blocker ? `${name} needs ${BLOCKER_ASK[s.blocker]}` : failed ? `${name} couldn't finish` : `${name} is waiting on you`;
  // The question itself, so the card says what to answer (the last sentence that asks something).
  const question = quote && !s.blocker && !failed ? (s.answer ?? "").split(/(?<=[.!?])\s+|\n+/).reverse().find((x) => x.trim().endsWith("?"))?.trim() : undefined;
  const show: Record<string, string> = { sign_in: `Sign in for ${name}`, two_factor: "Enter the code", captcha: "Solve the check", payment: "Review the payment", error: "Look at the screen" };
  const primary = "rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-white disabled:opacity-50";
  const plain = "rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6] disabled:opacity-50";
  return (
    <div className="flex w-full max-w-[460px] flex-col gap-2.5 rounded-2xl bg-[#FBFFE0] px-3.5 py-3 shadow-[0_0_0_1px_#E6F57A]">
      <span className="flex items-center gap-2 text-[13.5px] font-semibold leading-[18px]">
        <span className="size-2 shrink-0 rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" />
        {title}
      </span>
      {question && <span className="-mt-1 pl-4 text-[13.5px] leading-[19px] text-[#3A3A38]">{question}</span>}
      <div className="flex flex-wrap gap-1.5">
        {s.blocker ? (
          <>
            <button disabled={busy} onClick={onShow} className={primary}>
              {show[s.blocker]}
            </button>
            {toMac && (
              <button disabled={busy} onClick={() => void post(`/api/sessions/${s.id}/where`, { move: true })} className={plain}>
                Try on your Mac
              </button>
            )}
            <button disabled={busy} onClick={dismiss} className={plain}>
              Dismiss
            </button>
          </>
        ) : failed ? (
          <>
            <button disabled={busy} onClick={() => void reply("Try again.")} className={primary}>
              Try again
            </button>
            {toMac && (
              <button disabled={busy} onClick={() => void post(`/api/sessions/${s.id}/where`, { move: true })} className={plain}>
                Try on your Mac
              </button>
            )}
            <button disabled={busy} onClick={dismiss} className={plain}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            {s.options?.map((o, i) => (
              <button key={o} disabled={busy} onClick={() => void reply(o)} className={i === 0 ? primary : plain}>
                {o}
              </button>
            ))}
            {!s.options?.length && (
              <button disabled={busy} onClick={onSomethingElse} className={primary}>
                Answer
              </button>
            )}
            <button disabled={busy} onClick={dismiss} className={plain}>
              Never mind
            </button>
            {!!s.options?.length && (
              <button disabled={busy} onClick={onSomethingElse} className="px-2 py-1.5 text-[13px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
                Something else…
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Older answers may still carry a computer briefing a bot echoed back; it isn't news for the user. */
const withoutBriefing = (text: string) =>
  text
    .split(/\n{2,}/)
    .filter((p) => !/^\s*(computer briefing|briefing)\s*:/i.test(p) && !/^\s*computer\s*:.*\b(screens?|idle|free|untouched|home screen)\b/i.test(p))
    .join("\n\n") || text;

/** A bot wants to do something in one of your apps that changes it (send, create, pay): you see what, and say yes or no. */
const CHANNEL_NAME: Record<string, string> = { slack: "Slack", telegram: "Telegram", discord: "Discord" };

function AppApprovalCard({ state, approval: a }: { state: AppState; approval: AppApproval }) {
  const [busy, setBusy] = useState(false);
  const b = state.bots.find((x) => x.id === a.botId);
  const s = state.sessions.find((x) => x.id === a.sessionId);
  const decide = async (yes: boolean) => {
    setBusy(true);
    await post("/api/apps/approvals", { id: a.id, yes });
  };
  const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-white p-3.5 shadow-[0_0_0_1px_#0000000F,0_10px_30px_-16px_#00000059]">
      <div className="flex items-start gap-2.5">
        {b && <Mascot botId={b.id} color={b.color} size={26} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13.5px] font-semibold leading-[18px]">
            {b?.name ?? "A bot"} wants to: {a.title}
          </span>
          {s && <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">For &ldquo;{s.title}&rdquo;</span>}
        </div>
      </div>
      {a.detail && <pre className={`${a.app === "email" ? "max-h-[280px]" : "max-h-[180px]"} overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#F7F7F6] px-3 py-2 font-sans text-[12.5px] leading-[18px] text-[#3A3A38] [overflow-wrap:anywhere]`}>{a.detail}</pre>}
      <div className="flex gap-1.5">
        <button disabled={busy} onClick={() => void decide(true)} className={`${btn} bg-ink text-white`}>
          {a.app === "email" ? "Send" : "Do it"}
        </button>
        <button disabled={busy} onClick={() => void decide(false)} className={`${btn} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
          {a.app === "email" ? "Don\u2019t send" : "Don\u2019t"}
        </button>
      </div>
    </div>
  );
}

/**
 * The user's AI credit is used up (state.credits): the bots are paused until there's more. Upgrade
 * opens the Account sheet. While it shows, Bops asks Orgo again whenever the app comes back to the
 * front (the user may have just paid in the browser), and the card goes once there's credit.
 */
function OutOfCredit({ onUpgrade }: { onUpgrade?: () => void }) {
  useEffect(() => {
    const check = () => void fetch("/api/plan?fresh=1", { cache: "no-store" }).catch(() => {});
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  return (
    <div className="mb-2.5 flex items-center gap-3 rounded-[16px] bg-white px-3.5 py-2.5 shadow-[0_0_0_1px_#E2E2DF]">
      <span className="min-w-0 flex-1 text-[12.5px] leading-[17px] text-[#3A3A38]">Out of AI credit. Your bots are paused until you add more.</span>
      {onUpgrade && (
        <button onClick={onUpgrade} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white">
          Upgrade
        </button>
      )}
    </div>
  );
}
