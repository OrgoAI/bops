"use client";

import { screenMap, screenNo } from "@/lib/screens";
import { askKind, chatAsks } from "@/lib/asks";
import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BLOCKER_ASK, live, pairChatId, workspaceOf, TAPBACK_EMOJI, TAPBACKS, type AppApproval, type AppState, type Bot, type Chat, type Message, type Session, type Tapback } from "@/lib/types";
import { Tapback as TapbackBalloon, TapbackGlyph, tapbackVars } from "@/components/message-ui/tapback";
import { Mascot } from "./mascot";
import { OpenLink } from "./panel-tabs";
import { crmOpen } from "@/lib/crm-access";
import { CrmNote } from "./crm";
import { MacIcon } from "./mac-tab";
import { AttachmentTray, MessageImages, useAttachments } from "./attachments";
import { ComposerInput } from "./composer-input";
import { MicButton } from "./mic-button";
import { Fold } from "./fold";
import { SaveSkillDialog } from "./skill-dialog";
import { undash } from "./side-group";
import { ApiAsk, apiAskOf, apiCallOf, ApiNote } from "./keys";
import { ChatAvatar, chatName, clockTime, needsYou, post, StatusIcon, teamOf, useNow } from "./ui";

/** Light markdown for bot text: **bold** and [links](url). */
/** How many messages a chat draws at first, and how many more each "Show earlier messages" adds. */
const PAGE = 60;

/** The bot whose text this is, so a file it links opens from its computer (see Inline). */
const LinkedBy = createContext<string | undefined>(undefined);

/** A link to a file a bot made, not a web page: a path on its computer (/workspace/…) or on this Mac (~/…, /Users/…). */
const isFileLink = (href: string) => /^(\/workspace\/|~\/|\/Users\/|file:\/\/\/)/.test(href);

export function Rich({ text, botId }: { text: string; botId?: string }) {
  // Code blocks (ASCII diagrams, commands) keep their monospace layout; the rest is inline text.
  const blocks = text.split(/```[a-z0-9-]*\n?([\s\S]*?)```/g);
  return (
    <LinkedBy.Provider value={botId}>
      {blocks.map((b, i) =>
        i % 2 ? (
          <pre key={i} className="my-1.5 overflow-x-auto whitespace-pre rounded-xl bg-black/[0.045] px-3 py-2 font-mono text-[12px] leading-[17px] [overflow-wrap:normal]">
            {b.replace(/\n$/, "")}
          </pre>
        ) : (
          <Prose key={i} text={b} />
        ),
      )}
    </LinkedBy.Provider>
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
  // So does a file it linked: Bops fetches it from the bot's computer (or this Mac) first, as the link itself goes nowhere.
  const openLink = useContext(OpenLink);
  const botId = useContext(LinkedBy);
  const openFile = async (href: string, label: string, browser: boolean) => {
    const res = await fetch("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId, href }) });
    const r = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!r.url) return window.alert(r.error ?? "Couldn't open that file.");
    const url = new URL(r.url, window.location.href).href;
    if (browser || !openLink) window.open(url, "_blank");
    else openLink(url, label);
  };
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
                if (botId && isFileLink(link[2])) {
                  e.preventDefault();
                  void openFile(link[2], link[1], e.metaKey || e.ctrlKey || e.shiftKey);
                  return;
                }
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
  prefill,
  onPrefilled,
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
  /**
   * Words asked to be in chat `chatId`'s message box (bops-app.tsx askBot), to change and send: put in
   * once, after what's typed already, on a line of its own, and the box focused. `at` tells one ask from
   * the next, so it's never put in again; `onPrefilled` says it's in.
   */
  prefill?: { chatId: string; text: string; at: number } | null;
  onPrefilled?: () => void;
}) {
  const [draft, setDraft] = useState("");
  // The last ask put in the box (its prefill.at): in once, while this chat shows, then left alone.
  const [prefilled, setPrefilled] = useState<number | null>(null);
  if (prefill && prefill.chatId === c.id && prefilled !== prefill.at) {
    setPrefilled(prefill.at);
    const add = prefill.text;
    if (add) setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${add}` : add));
  }
  // Kept current for the effect below, which runs once for each ask.
  const prefilledDone = useRef(onPrefilled);
  useLayoutEffect(() => {
    prefilledDone.current = onPrefilled;
  });
  useEffect(() => {
    if (prefilled === null) return;
    const box = document.getElementById("composer");
    if (box instanceof HTMLTextAreaElement) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    prefilledDone.current?.();
  }, [prefilled]);
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
  // What's waiting on you, pinned over the composer: threads started here (in the main bot's chat,
  // every bot's: lib/asks.ts chatAsks), and app actions asked here or by one of those threads.
  const threadAsks = chatAsks(state, c.id);
  const mainChat = c.kind === "bot" && state.bots.some((b) => b.isMain && c.botIds.includes(b.id));
  const appAsks = (state.appApprovals ?? []).filter(
    (a) => a.chatId === c.id || state.sessions.some((x) => x.id === a.sessionId && x.chatId === c.id) || (mainChat && workspaceOf(state.bots.find((b) => b.id === a.botId) ?? members[0]) === workspaceOf(members[0])),
  );
  const [allAsks, setAllAsks] = useState(false);
  const shownAsks = allAsks ? threadAsks : threadAsks.slice(0, 2);
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
  // "Save as skill" from the chat's menu: the bot rereads this chat and drafts one (skill-dialog.tsx).
  const [saving, setSaving] = useState<{ botId: string; chatId: string } | null>(null);
  // Stable, so the dialog's own timers aren't reset by every state poll.
  const closeSaving = useCallback(() => setSaving(null), []);
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
    el.scrollTo({ top: el.scrollHeight, behavior: shownChat.current === c.id && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant" });
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
  // When each of the last few messages went, so the real copy can carry on its pending one's motion (arrivalOf).
  const [sent, setSent] = useState<{ chatId: string; text: string; at: number }[]>([]);
  // Images about to go with the next message (the + button, pasting, or dropping them on the chat).
  const attach = useAttachments();
  const filePicker = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  // What went wrong with the mic, shown under the composer for a few seconds.
  const [micError, setMicError] = useState<string | null>(null);
  useEffect(() => {
    if (!micError) return;
    const t = setTimeout(() => setMicError(null), 6000);
    return () => clearTimeout(t);
  }, [micError]);
  const attaching = attach.items.filter((a) => a.status !== "failed");
  const send = async () => {
    const text = draft.trim();
    if (!text && !attaching.length) return;
    const items = attaching;
    // Every preview in the tray (the failed ones too), let go once the pending copy showing them has gone.
    const previews = attach.items.map((a) => a.preview);
    setDraft("");
    setReplying(null);
    attach.clear();
    const mine = { id: `pending_${Date.now()}`, chatId: c.id, text, at: Date.now(), previews: items.length ? items.map((a) => a.preview) : undefined };
    const drop = () => {
      setPending((p) => p.filter((x) => x.id !== mine.id));
      previews.forEach((u) => URL.revokeObjectURL(u));
    };
    setPending((p) => [...p, mine]);
    setSent((s) => [...s.slice(-19), { chatId: c.id, text, at: mine.at }]);
    // Shows at once; goes once its images have finished uploading (usually they already have).
    const images = (await Promise.all(items.map((a) => a.done))).filter((x) => !!x);
    if (!text && !images.length) return drop();
    await post(`/api/chats/${encodeURIComponent(c.id)}/messages`, { text, replyTo: replying?.id, images: images.length ? images : undefined }).finally(drop);
  };
  const filesOf = (d: DataTransfer | null) => [...(d?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  // Sent messages the server's state doesn't have yet.
  const waiting = pending.filter((p) => p.chatId === c.id && !messages.some((m) => m.role === "user" && m.text === p.text && m.at >= p.at - 5000));

  // What was already here when the chat opened just shows; only what arrives while it's open moves
  // in. Seeded once per chat, during render (an effect would be a frame late), with every message,
  // not only those drawn, so "Show earlier messages" never animates.
  const typingKey = (botId: string) => `typing:${botId}:${messages.at(-1)?.id ?? ""}`;
  const seed = () => new Set([...messages.map((m) => m.id), ...waiting.map((p) => p.id), ...c.typing.map(typingKey), ...appAsks.map((a) => a.id)]);
  const [opened, setOpened] = useState(() => ({ chat: c.id, seen: seed() }));
  if (opened.chat !== c.id) setOpened({ chat: c.id, seen: seed() });
  const seen = opened.seen;
  const arrivalOf = (m: Message): Arrival | undefined => {
    if (seen.has(m.id)) return undefined;
    // The bots' messages and notes rise in, and so do yours sent from your phone or Slack (new here too).
    if (m.role !== "user" || m.via) return { kind: "rise" };
    // Sent from here: its pending copy already moved in, so the real one carries on from where that is
    // (matched the way `waiting` matches it). Anything else of yours, say from the replies view, just shows.
    const went = sent.findLast((s) => s.chatId === m.chatId && s.text === m.text && m.at >= s.at - 5000);
    return went ? { kind: "send", since: went.at } : undefined;
  };
  // The first reply to your last message, which is what puts "Read" under it.
  const readBy = messages.slice(lastUserIdx + 1).find((m) => m.role === "bot");
  // The reply bar folds shut still saying what it was to (the reply itself is gone by then).
  const [barReply, setBarReply] = useState<Message | null>(null);
  if (replying && replying !== barReply) setBarReply(replying);
  const bar = replying ?? (barReply?.chatId === c.id ? barReply : null);

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
      {saving && <SaveSkillDialog botId={saving.botId} chatId={saving.chatId} onClose={closeSaving} />}
      <div className="absolute right-5 top-[18px] z-10 flex items-center gap-2">
        {/* The chat's own menu (a bot's chat, like Call): Save as skill rereads this chat for how the bot did a job. */}
        {solo && !call && (
          <MoreMenu
            key={c.id}
            label="More"
            size="chat"
            items={[{ label: "Save as skill", icon: <SkillIcon />, onClick: () => setSaving({ botId: solo.id, chatId: c.id }) }]}
          />
        )}
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
                {gap && <div className={`self-center py-1.5 text-[12px] leading-4 text-[#9A9A98] ${seen.has(m.id) ? "" : "motion-rise-in"}`}>{dayTime(m.at)}</div>}
                <MessageRow
                  m={m}
                  state={state}
                  showSender={c.kind === "group" || (!!m.botId && m.botId !== solo?.id)}
                  continued={!!prev && prev.role === m.role && prev.botId === m.botId && !gap}
                  sessionById={sessionById}
                  chipIds={chipsFor(m)}
                  onOpenThread={onOpenThread}
                  onShowScreen={onShowScreen}
                  arrival={arrivalOf(m)}
                  {...rowProps(m)}
                />
                {i + hiddenCount === lastUserIdx && repliedAfterUser && (
                  <div className={`self-end px-1 pb-1 text-[11px] leading-[14px] text-[#9A9A98] ${readBy && !seen.has(readBy.id) ? "motion-fade-in" : ""}`}>Read {clockTime(m.at)}</div>
                )}
              </Fragment>
            );
          })}
          {waiting.map((p) => (
            // Up from the composer as you send it (not again when you come back to the chat before it lands).
            <div key={p.id} className={`flex max-w-[86%] flex-col items-end gap-1 self-end ${seen.has(p.id) ? "" : "motion-send-in"}`}>
              {p.previews && <MessageImages previews={p.previews} />}
              {p.text && <div className="whitespace-pre-wrap rounded-[18px] bg-[#0A0A0A] px-3.5 py-2 text-[14px] leading-5 text-white [overflow-wrap:anywhere]">{p.text}</div>}
            </div>
          ))}
          {c.typing.map((b) => {
            const tb = state.bots.find((x) => x.id === b);
            // Waiting on a teammate's answer: "Asking ● Max…" over the typing dots.
            const asking = c.asking?.[b] ? state.bots.find((x) => x.id === c.asking![b]) : undefined;
            // Rises in when the bot starts typing; one already typing as the chat opens is just there.
            return (
              <RiseIn key={b} fresh={!seen.has(typingKey(b))} className="flex flex-col gap-1 self-start">
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
                  {/* A wave, each dot 150 ms behind the last. The delays are a whole 1.2 s wave early, so
                      no dot sits dark and still before its turn comes. */}
                  {[0, 150, 300].map((delay) => (
                    <span key={delay} className="motion-typing-dot size-[7px] rounded-full bg-[#9A9A98]" style={{ animationDelay: `${delay - 1200}ms` }} />
                  ))}
                </div>
              </div>
              </RiseIn>
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
          {(appAsks.length > 0 || threadAsks.length > 0) && (
            <div className="mb-2.5 flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
              {shownAsks.map((x) => (
                <NeedsYouCard
                  key={x.id}
                  session={x}
                  state={state}
                  quote
                  pinned
                  onShow={() => (x.display ?? x.lastDisplay) !== undefined ? onShowScreen(x.botId, (x.display ?? x.lastDisplay)!) : onOpenThread(x)}
                  onSomethingElse={() => onOpenThread(x)}
                  onOpen={() => onOpenThread(x)}
                />
              ))}
              {threadAsks.length > shownAsks.length && (
                <button onClick={() => setAllAsks(true)} className="self-start pl-1 text-[12px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
                  {threadAsks.length - shownAsks.length} more waiting on you
                </button>
              )}
              {appAsks.map((a) => (
                <AppApprovalCard key={a.id} state={state} approval={a} className={seen.has(a.id) ? "" : "motion-rise-in"} />
              ))}
            </div>
          )}
          {/* Folds open over the composer. Keyed by chat, so switching chats shows it as it is there, with
              no fold. Relative even while shut (aria-hidden), so it folds away above the scrim, not under it.
              pt-px keeps its top ring inside the fold's clip; its last row was under the form's anyway. */}
          <Fold key={c.id} open={!!replying} className="relative">
            {bar && (
              <div className="pt-px">
                <div className="mx-2 -mb-px flex items-center gap-2 rounded-t-[16px] bg-[#F7F7F6] px-3.5 py-2 shadow-[0_0_0_1px_#ECECEA]">
                  <ReplyArrow />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] leading-4 text-[#6B6B6B]">
                    Replying to <span className="font-medium text-ink">{bar.role === "user" ? "yourself" : (state.bots.find((x) => x.id === bar.botId)?.name ?? "the bot")}</span>
                    {" · "}
                    {bar.text}
                  </span>
                  <button onClick={() => setReplying(null)} aria-label="Cancel reply" className="flex size-5 items-center justify-center rounded-md text-[#9A9A98] hover:bg-black/[0.06] hover:text-ink">
                    <svg width="9" height="9" viewBox="0 0 12 12">
                      <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </Fold>

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
            <MicButton
              botId={solo?.id}
              onError={setMicError}
              onText={(said) => {
                setMicError(null);
                setDraft((d) => (d.trim() ? `${d.trimEnd()} ${said}` : said));
                document.getElementById("composer")?.focus();
              }}
            />
            <button type="submit" aria-label="Send" disabled={!draft.trim() && !attaching.length} className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-ink disabled:opacity-30">
              <SendIcon />
            </button>
            </div>
          </form>
          {micError && <div className="px-3 pt-1.5 text-[12px] leading-4 text-[#B42318]">{micError}</div>}
        </div>
      </div>

      {openReplies && (
        <RepliesView
          key={openReplies}
          state={state}
          rootId={openReplies}
          messages={messages}
          showSender={c.kind === "group"}
          onClose={() => {
            repliesShown = null;
            setRepliesOpen(null);
          }}
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

/** The replies sheet showing last: coming back to its chat shows it in place, without its entrance again (closing it clears this). */
let repliesShown: string | null = null;

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
  // What was here when it opened just shows; a reply that comes in while it's open moves in, and
  // yours (sent from here, with nothing pending before it) goes up from the composer.
  const [seen] = useState(() => new Set(list.map((m) => m.id)));
  const arrivalOf = (m: Message): Arrival | undefined => (seen.has(m.id) ? undefined : { kind: m.role === "user" ? "send" : "rise" });
  // Opened now (not shown again with its chat): the scrim fades in (its blur stays as it is) and the card comes up from below.
  const [opening] = useState(() => repliesShown !== rootId);
  useEffect(() => {
    repliesShown = rootId;
  }, [rootId]);
  return (
    <div className={`${opening ? "motion-fade-in " : ""}absolute inset-0 z-20 flex flex-col bg-white/80 px-3 pb-3 pt-[52px] backdrop-blur-md`} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`${opening ? "motion-sheet-in " : ""}mx-auto flex min-h-0 w-full max-w-[640px] flex-1 flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000038]`}>
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
                arrival={arrivalOf(m)}
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

/** A row of a small menu (the message menu, and the "⋯" ones). */
const MENU_ITEM = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-4 hover:bg-[#F2F2F0]";

/**
 * A round "⋯" button and the small menu it opens under it, out of its right corner: the chat's (next to
 * Call) and a thread's (next to Stop). A click outside or Esc closes it; Esc closes only it, not the
 * sheet or page under it.
 */
function MoreMenu({ label, size, items }: { label: string; size: "chat" | "sheet"; items: { label: string; icon: React.ReactNode; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [open]);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          size === "chat"
            ? "flex size-11 items-center justify-center rounded-full bg-white shadow-[0_0_0_1px_#E6E6E3,0_8px_20px_-10px_#00000040] hover:shadow-[0_0_0_1px_#C9C9C6,0_8px_20px_-10px_#00000040]"
            : "flex size-[34px] items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]"
        }
      >
        <svg width={size === "chat" ? 18 : 14} height={size === "chat" ? 18 : 14} viewBox="0 0 16 16" aria-hidden>
          <circle cx="3.2" cy="8" r="1.35" fill="#0A0A0A" />
          <circle cx="8" cy="8" r="1.35" fill="#0A0A0A" />
          <circle cx="12.8" cy="8" r="1.35" fill="#0A0A0A" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} onContextMenu={(e) => (e.preventDefault(), setOpen(false))} />
          <div role="menu" className="motion-menu-in absolute right-0 top-[calc(100%+6px)] z-40 flex w-[184px] origin-top-right flex-col rounded-xl bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040]">
            {items.map((x) => (
              <button
                key={x.label}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  x.onClick();
                }}
                className={MENU_ITEM}
              >
                {x.icon}
                {x.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** "Save as skill": steps in a list, with a mark for keeping them. */
function SkillIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" className="shrink-0 text-[#6B6B6B]" aria-hidden>
      <path d="M6 4h7.5M6 8h7.5M6 12h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="2.8" cy="4" r="1" fill="currentColor" />
      <circle cx="2.8" cy="8" r="1" fill="currentColor" />
      <circle cx="2.8" cy="12" r="1" fill="currentColor" />
    </svg>
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
  /** New since the chat opened, and how it moves in (undefined: it was already here, so it just shows). */
  arrival?: Arrival;
};

/**
 * How a new message moves in: rising into the list, or, for yours, up from the composer. `since` is
 * when you sent it, so the real copy picks up where its pending one was instead of starting again.
 */
type Arrival = { kind: "rise" } | { kind: "send"; since?: number };

/**
 * A div that rises in if it's new when it mounts. Decided then, once, so a later render (a poll, a
 * message landing above it) can't start it again.
 */
function RiseIn({ fresh, className, children }: { fresh: boolean; className: string; children: React.ReactNode }) {
  const [rise] = useState(fresh);
  return <div className={`${className} ${rise ? "motion-rise-in" : ""}`}>{children}</div>;
}

/** A tapback's identity: a different one from the same person is a new reaction (it pops in). */
const reactionKey = (r: NonNullable<Message["reactions"]>[number]) => `${r.by}:${r.type ?? r.emoji}`;

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

function MessageRow({ m, state, showSender, continued, sessionById, chipIds, onOpenThread, onShowScreen, onShowMac, replyCount, root, onReply, onOpenReplies, inReplies, arrival }: RowProps) {
  // Decided once, as the row mounts: a poll or a new tapback draws it again but never replays it.
  // Yours carries on its pending copy's motion (a negative delay starts it partway, or past the end).
  const [enter] = useState(() =>
    !arrival ? undefined : arrival.kind === "send" ? { className: "motion-send-in", style: arrival.since ? { animationDelay: `${arrival.since - Date.now()}ms` } : undefined } : { className: "motion-rise-in", style: undefined },
  );
  const enterClass = enter?.className ?? "";
  // What was already here when the row mounted sits still: its tapbacks.
  const [reactedAtMount] = useState(() => new Set(m.reactions?.map(reactionKey)));
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  // Links open as a tab on the right (a watched web page's "Open page" too).
  const openLink = useContext(OpenLink);
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
          <TapbackBalloon reaction={r.type} emoji={r.emoji} own={r.by === "owner"} side={outgoing ? "left" : "right"} platform="macos" animateIn={!reactedAtMount.has(reactionKey(r))} />
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
  const menuItem = MENU_ITEM;
  // Both open out of the bubble's corner they hang from: right for yours, left for the bot's.
  const actionMenu = menu && (
    <div className={`motion-menu-in absolute top-[calc(100%+6px)] z-40 flex w-[168px] flex-col rounded-xl bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040] ${outgoing ? "right-0 origin-top-right" : "left-0 origin-top-left"}`}>
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
        className={`motion-menu-in absolute bottom-[calc(100%+6px)] z-40 flex items-center gap-0.5 rounded-full bg-white px-1.5 py-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040] ${outgoing ? "right-0 origin-bottom-right" : "left-0 origin-bottom-left"}`}
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
  // A web page watched with no screen offers the page itself (as a tab here, like a link; ⌘-click: the
  // browser), and to stop watching it.
  // Only the latest heads-up about a screen keeps its buttons; older ones are just history.
  const latest = m.watch && lasts(state.messages).byWatch.get(m.watch.id) === m.id;
  const watch = latest ? state.watches?.find((w) => w.id === m.watch!.id) : undefined;
  const page = watch?.page;
  const watchActions = watch && page ? (
    <div className="flex gap-1.5 pl-0.5">
      <button
        onClick={(e) => {
          if (openLink && !(e.metaKey || e.ctrlKey || e.shiftKey)) openLink(page.url);
          else window.open(page.url, "_blank", "noreferrer");
          if (watch.alert) void post("/api/watches", { id: watch.id, action: "seen" }, "PATCH");
        }}
        title={page.url}
        className="rounded-full bg-white px-3 py-1 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]"
      >
        Open page
      </button>
      <button
        onClick={() => void post(`/api/watches?id=${encodeURIComponent(watch.id)}`, {}, "DELETE")}
        className="rounded-full bg-white px-3 py-1 text-[12.5px] font-medium leading-4 text-[#6B6B6B] shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#FEF3F2] hover:text-[#B42318]"
      >
        Stop watching
      </button>
    </div>
  ) : watch && (
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
      {/* Bots can't write in the apps on the user's Mac for now (lib/server/mac.ts), so a Mac window gets no draft. */}
      {!watch.mac && (
        <button
          onClick={() => void post("/api/watches", { id: watch.id, action: "draft" }, "PATCH")}
          className="rounded-full bg-highlighter px-3 py-1 text-[12.5px] font-semibold leading-4 shadow-[0_0_0_1px_#0000001F]"
        >
          Draft a reply
        </button>
      )}
    </div>
  );
  // Several running at once: one quiet way to stop them all, right under them.
  const runningHere = chips.filter((s) => live(s) && !s.askWhere);
  const chipList = chips.length > 0 && (
    <div className="flex flex-col items-start gap-1.5 pt-0.5">
      {chips.map((s, i) => {
        // Parts of one request (Session.group) show under its name, with how many are still going.
        const parts = s.group ? chips.filter((x) => x.group?.id === s.group!.id) : [];
        const grouped = parts.length > 1;
        return (
          <Fragment key={s.id}>
            {grouped && parts[0] === s && (
              <span className={`flex items-center gap-1.5 pl-1 text-[12px] font-medium leading-4 text-[#6B6B6B] ${i ? "pt-1" : ""}`}>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
                  <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                {s.group!.title} · {parts.length} parts
                {parts.some(live) ? ` · ${parts.filter(live).length} going` : ""}
              </span>
            )}
            {/* What it waits on is pinned over the composer (NeedsYouCard), so it can't scroll away. */}
            <div className={grouped ? "pl-3" : ""}>
              <SessionChip session={s} state={state} onClick={() => onOpenThread(s)} />
            </div>
          </Fragment>
        );
      })}
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
      {/* The bot (or someone's words) suggested the Mac, but the user didn't ask: nothing moves until they say so (sessions.ts offerMove). Only while it runs (once it's over, a move would do it all again), and not while its card above offers Try on your Mac. */}
      {chips
        .filter((s) => s.offerMac && live(s) && s.runsOn !== "mac" && state.mac?.ready && !(needsYou(s) && (s.blocker || s.status === "failed")))
        .map((s) => (
          <div key={`${s.id}-move`} className="flex gap-1.5 pl-1">
            <button onClick={() => void post(`/api/sessions/${s.id}/where`, { move: true })} className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white">
              <MacIcon size={13} />
              Move to your Mac?
            </button>
            <button onClick={() => void post(`/api/sessions/${s.id}/where`, { move: false })} className="rounded-full bg-white px-3 py-1.5 text-[12.5px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6]">
              Not now
            </button>
          </div>
        ))}
    </div>
  );

  if (m.role === "user")
    return (
      <div className={`group/msg flex max-w-[78%] flex-col items-end gap-1 self-end ${enterClass}`} style={enter?.style}>
        {quote}
        {/* Room above the bubble for its tapbacks, so they don't cover the quote or sender line (it eases open as the first one pops in). */}
        <div className={`flex min-w-0 max-w-full items-center gap-1 transition-[margin] duration-200 ease-out motion-reduce:transition-none ${m.reactions?.length ? "mt-3.5" : ""}`}>
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
  if (m.role === "system" && m.sms) return <TextCard m={m} state={state} className={enterClass} />;

  // A call shows as a bubble from you in the bot's color, like a call in Messages.
  if (m.call) {
    const caller = state.bots.find((x) => `bot:${x.id}` === m.chatId);
    const fill = !caller || caller.isMain ? "#0A0A0A" : caller.color;
    const mins = Math.floor(m.call.seconds / 60);
    return (
      <div
        className={`flex items-center gap-2 self-end rounded-[18px] px-3.5 py-2 text-[14px] leading-5 ${enterClass}`}
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

  if (m.role === "system" && m.email) return <EmailCard m={m} state={state} className={enterClass} />;

  // Something just remembered rises in with the soft wash Orbit gives what it learns.
  if (m.role === "system" && m.memory) return <MemoryNote m={m} className={enter ? "motion-new-item" : ""} />;

  // A bot's save to the CRM: Open the file, or Undo it (only where the CRM is open: lib/crm-access.ts).
  // CrmNote takes no class, so a new one rises in inside a box that leaves its own alignment as it was.
  if (m.role === "system" && m.crm)
    return crmOpen(state) ? (
      enter ? (
        <div className={`flex w-full flex-col ${enterClass}`}>
          <CrmNote m={m} />
        </div>
      ) : (
        <CrmNote m={m} />
      )
    ) : null;

  // A call a bot made with one of your keys (keys.tsx): the service, the method and the path.
  const api = apiCallOf(m);
  if (m.role === "system")
    return (
      <div className={`flex w-full flex-col items-center gap-1.5 self-center py-0.5 ${enterClass}`}>
        {api ? <ApiNote call={api} /> : <SystemNote text={m.text} />}
        {chipList}
      </div>
    );

  const b = state.bots.find((x) => x.id === m.botId);
  // Posted by a routine (a reminder, or a run in the chat): which one, by its name while it's there.
  const fromRoutine = m.routine && state.routines.find((r) => r.id === m.routine!.id);
  return (
    <div className={`group/msg flex max-w-[86%] items-end gap-2 self-start ${enterClass}`}>
      {showSender && (b && !continued ? <Mascot botId={b.id} color={b.color} size={24} /> : <span className="w-6 shrink-0" />)}
      <div className="flex min-w-0 flex-col gap-1">
        {showSender && b && !continued && <div className="pl-3 text-[11px] leading-[14px] text-[#9A9A98]">{b.name}</div>}
        {m.routine && <div className="truncate pl-3 text-[11px] leading-[14px] text-[#9A9A98]">{fromRoutine ? `From a routine · ${undash(fromRoutine.title)}` : "From a routine"}</div>}
        {!!m.asked?.length && <AskedLine state={state} asked={m.asked} by={m.botId} />}
        {quote}
        <div className={`flex min-w-0 max-w-full items-center gap-1 self-start transition-[margin] duration-200 ease-out motion-reduce:transition-none ${m.reactions?.length ? "mt-3.5" : ""}`}>
          <div className="relative min-w-0" {...holdable}>
            {picker}
            {actionMenu}
            {balloons}
            <div className="flex flex-col items-start gap-1">
              {/* Pictures the bot made (make_image). */}
              {!!m.images?.length && <MessageImages images={m.images} align="start" />}
              {(m.text || !m.images?.length) && (
                <div className="whitespace-pre-wrap rounded-[18px] bg-[#F2F2F0] px-3.5 py-2 text-[14px] leading-5 [overflow-wrap:anywhere]">
                  <Rich text={withoutBriefing(m.text)} botId={m.botId} />
                </div>
              )}
            </div>
          </div>
          {actions}
        </div>
        {replies}
        {m.needed && m.resultOf && <AnsweredLine message={m} session={sessionById(m.resultOf)} />}
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
    // A dialog: Esc closes it before the Vault or a profile on the right (see bops-app.tsx).
    <div role="dialog" aria-label="Chat between your bots" className="absolute inset-0 z-40 flex animate-[screen-in_200ms_ease-out] flex-col bg-white">
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
                    <Rich text={m.text} botId={m.botId} />
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
function TextCard({ m, state, className = "" }: { m: Message; state: AppState; className?: string }) {
  const t = m.sms!;
  const b = state.bots.find((x) => `bot:${x.id}` === m.chatId);
  const call = !!m.call;
  const mins = m.call ? Math.floor(m.call.seconds / 60) : 0;
  return (
    <div className={`flex w-full max-w-[460px] flex-col gap-1.5 self-start ${className}`}>
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
function EmailCard({ m, state, className = "" }: { m: Message; state: AppState; className?: string }) {
  const e = m.email!;
  const [open, setOpen] = useState(false);
  const b = state.bots.find((x) => `bot:${x.id}` === m.chatId);
  const from = person(e.from);
  const long = m.text.length > 280 || m.text.split("\n").length > 4;
  const label = e.dir === "in" ? (e.fromOwner ? `You emailed ${b?.name ?? "the bot"}` : `Email to ${b?.name ?? "the bot"}`) : `${b?.name ?? "The bot"} sent an email`;
  return (
    <div className={`flex w-full max-w-[460px] flex-col gap-1.5 self-start ${e.bulk ? "opacity-75" : ""} ${className}`}>
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

// A short note is a pill; a long one (a message sent on to a task) a card, three lines until clicked.
function SystemNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 80) return <div className="flex items-center gap-1.5 rounded-full bg-[#F7F7F6] px-3 py-1 text-[12px] leading-4 text-[#6B6B6B]">{text}</div>;
  const quoted = text.match(/^([^:“\n]{1,80}):\s*(“[\s\S]*)$/);
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      title={open ? undefined : "Show all"}
      className="w-full max-w-[400px] rounded-[14px] bg-[#F7F7F6] px-3 py-2 text-left text-[12px] leading-4 text-[#6B6B6B] [overflow-wrap:anywhere] hover:bg-[#F2F2F0]"
    >
      {quoted && <span className="block font-medium">{quoted[1]}</span>}
      <span className={`whitespace-pre-wrap ${quoted ? "text-[#3A3A3A]" : ""} ${open ? "block" : "line-clamp-3"}`}>{quoted ? quoted[2] : text}</span>
    </button>
  );
}

function MemoryNote({ m, className = "" }: { m: Message; className?: string }) {
  const mem = m.memory!;
  const [busy, setBusy] = useState(false);
  const act = (action: "undo" | "forget-old") => {
    setBusy(true);
    void post("/api/memory", { action, messageId: m.id }).finally(() => setBusy(false));
  };
  const button = "shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium leading-4 text-ink hover:bg-black/[0.05] disabled:opacity-40";
  return (
    <div className={`flex w-full max-w-[400px] flex-col self-center rounded-[14px] bg-[#F7F7F6] py-2 pl-3 pr-1.5 text-[12px] leading-4 ${className}`}>
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
      {/* Which screen it's on, live: the number on the panel's tiles. */}
      {live(s) && s.runsOn !== "mac" && s.display !== undefined && (
        <span title={`On screen ${screenNo(s.display)} of ${b?.name ?? "its bot"}'s computer`} className="shrink-0 rounded-full bg-[#F2F2F0] px-1.5 py-px text-[11px] tabular-nums leading-[14px] text-[#3A3A38]">
          Screen {screenNo(s.display)}
        </span>
      )}
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
  // Passed on from outside Bops (someone's email): shown as that, not as the user's words.
  for (const r of s.replies)
    lines.push(r.note ? { kind: "event", at: r.at, text: r.note } : r.from ? { kind: "event", at: r.at, text: `Passed on from ${r.from}: ${r.text}` } : { kind: "reply", at: r.at, role: r.role, text: r.text });
  if (!s.replies.length && s.answer) lines.push({ kind: "reply", at: s.endedAt ?? Date.now(), role: "bot", text: s.answer });
  return lines.sort((a, b) => a.at - b.at);
}

/** The thread whose sheet was showing last (see ThreadSheet: coming back to it doesn't replay its opening). */
let sheetShown: string | null = null;
/** The thread sheet was closed, however that happened (Esc, a chat opened): its next opening plays again (bops-app). */
export function forgetSheet() {
  sheetShown = null;
}

export function ThreadSheet({ state, session: s, onClose: close, onShowComputer }: { state: AppState; session: Session; onClose: () => void; onShowComputer: () => void }) {
  // "Working for 1m 23s" counts up while it's open.
  useNow(live(s) ? 1000 : 60_000);
  // Opening it plays its entrance; coming back to it (the chat column is drawn again after a
  // full-screen computer) doesn't. Closing it from here lets the next opening play again.
  const [opening] = useState(() => sheetShown !== s.id);
  useEffect(() => {
    sheetShown = s.id;
  }, [s.id]);
  const onClose = () => {
    sheetShown = null;
    close();
  };
  // Asking for you when it opened: the card is just there. One that comes up while it's open rises in.
  const [askedAtOpen, setAskedAtOpen] = useState(() => ({ id: s.id, asked: needsYou(s) }));
  if (askedAtOpen.id !== s.id) setAskedAtOpen({ id: s.id, asked: needsYou(s) });
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [openSteps, setOpenSteps] = useState<number[]>([]);
  // "Save as skill" for this thread alone (skill-dialog.tsx), by the thread it's for.
  const [saving, setSaving] = useState<string | null>(null);
  const closeSaving = useCallback(() => setSaving(null), []);
  const end = useRef<HTMLDivElement>(null);
  const b = state.bots.find((x) => x.id === s.botId)!;
  const via = s.sentVia === "routine" ? undefined : s.sentVia === "you" ? b : state.bots.find((x) => x.id === s.sentVia);
  // The routine whose run this is, while it's there (Session.routineId).
  const routine = s.routineId ? state.routines.find((r) => r.id === s.routineId) : undefined;
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
    // Clicking anywhere outside the sheet closes it, like the × does. Opening, the scrim fades in
    // (its blur stays as it is) and the sheet comes up from below.
    <div onClick={onClose} className={`absolute inset-0 z-20 flex flex-col bg-white/70 px-3 pb-3 pt-[52px] backdrop-blur-[2px] ${opening ? "motion-fade-in" : ""}`}>
      <div onClick={(e) => e.stopPropagation()} className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_0_0_1px_#0000000F,0_24px_60px_-20px_#00000038] ${opening ? "motion-sheet-in" : ""}`}>
        {/* Portalled over everything; inside the card, so its clicks never reach the scrim and close the sheet. */}
        {saving === s.id && <SaveSkillDialog botId={s.botId} chatId={s.chatId} sessionId={s.id} onClose={closeSaving} />}
        <div className="flex items-center gap-2.5 border-b border-[#F0F0EE] py-3.5 pl-4 pr-3.5">
          <Mascot botId={b.id} color={b.color} size={32} />
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="truncate text-[15px] font-semibold leading-[18px]">{s.title}</span>
            <button onClick={onShowComputer} className="flex items-center gap-1.5 text-left text-[12px] leading-4 text-[#6B6B6B] hover:text-ink">
              {b.name} · {s.runsOn === "mac" ? "on your Mac · " : ""}
              {s.askWhere && live(s) ? "waiting for you" : live(s) ? "working" : s.status === "done" ? "finished" : "stopped"} · {toolCount} steps
              {/* Its screen, by the number the panel and the bots use. */}
              {s.runsOn !== "mac" && (live(s) && s.display !== undefined ? ` · screen ${screenNo(s.display)}` : !live(s) && s.lastDisplay !== undefined ? ` · left off on screen ${screenNo(s.lastDisplay)}` : "")}
            </button>
          </div>
          {s.runsOn !== "mac" && state.mac?.ready && (s.blocker || s.status === "failed" || (s.offerMac && live(s))) && (
            <button
              onClick={() => void post(`/api/sessions/${s.id}/where`, { move: true })}
              title="Do this on your Mac instead, on your home internet"
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]"
            >
              <MacIcon size={13} />
              {s.offerMac && live(s) && !s.blocker ? "Move to your Mac" : "Try on your Mac"}
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
          {/* Save as skill: the bot rereads this thread for how it did the job. Keyed by thread, so another one's sheet starts it shut. */}
          <MoreMenu key={s.id} label="More" size="sheet" items={[{ label: "Save as skill", icon: <SkillIcon />, onClick: () => setSaving(s.id) }]} />
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
              {s.sentVia === "routine" ? (routine ? `Sent by a routine · ${undash(routine.title)}` : "Sent by a routine") : `Sent via ${via?.name ?? "the main bot"}`}
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
            <LeftOff state={state} session={s} onShow={onShowComputer} />
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
                <Rich text={l.role === "bot" ? withoutBriefing(l.text) : l.text} botId={l.role === "bot" ? s.botId : undefined} />
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
          <div className={`px-3 pb-2 ${askedAtOpen.asked ? "" : "motion-rise-in"}`}>
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
              placeholder={live(s) ? "Reply in thread · it sees this as it works" : "Reply in thread · picks it back up"}
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
 * replies it offered, say they approved it on their phone, let a flagged step go on, retry, or move it
 * to their Mac, instead of working out what to type back. `pinned`: over a chat's composer (lib/asks.ts
 * chatAsks), where it names the thread and says the bot's words, since its message may be far above
 * or in another bot's chat.
 */
function NeedsYouCard({
  session: s,
  state,
  quote,
  pinned,
  onShow,
  onSomethingElse,
  onOpen,
}: {
  session: Session;
  state: AppState;
  quote?: boolean;
  pinned?: boolean;
  onShow: () => void;
  onSomethingElse: () => void;
  onOpen?: () => void;
}) {
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
  const kind = askKind(s);
  const failed = kind === "failed";
  const display = s.display ?? s.lastDisplay;
  const title = s.blocker
    ? `${name} needs ${BLOCKER_ASK[s.blocker]}`
    : failed
      ? `${name} couldn't finish`
      : kind === "elsewhere"
        ? `${name} needs you to approve it on your phone`
        : kind === "safety"
          ? `${name} needs your OK to go on`
          : `${name} is waiting on you`;
  const answer = withoutBriefing(s.answer ?? "").trim();
  // The question itself, so the card says what to answer (the last sentence that asks something); pinned, the bot's words when none asks.
  const asked = answer.split(/(?<=[.!?])\s+|\n+/).reverse().find((x) => x.trim().endsWith("?"))?.trim();
  const question = quote && !s.blocker && !failed ? (asked ?? (pinned ? answer : undefined)) : pinned && failed ? s.error : undefined;
  const show: Record<string, string> = { sign_in: `Sign in for ${name}`, two_factor: "Enter the code", captcha: "Solve the check", payment: "Review the payment", error: "Look at the screen" };
  const primary = "rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-semibold leading-4 text-white disabled:opacity-50";
  const plain = "rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium leading-4 shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F7F7F6] disabled:opacity-50";
  const showScreen = display !== undefined && (
    <button disabled={busy} onClick={onShow} className={plain}>
      Show screen
    </button>
  );
  return (
    <div className="flex w-full max-w-[460px] flex-col gap-2.5 rounded-2xl bg-[#FBFFE0] px-3.5 py-3 shadow-[0_0_0_1px_#E6F57A]">
      <span className="flex items-center gap-2 text-[13.5px] font-semibold leading-[18px]">
        {pinned && b ? <Mascot botId={b.id} color={b.color} size={18} antenna={false} /> : <span className="size-2 shrink-0 rounded-full bg-highlighter shadow-[0_0_0_1.5px_#0A0A0A]" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {pinned && onOpen && (
          <button onClick={onOpen} className="max-w-[45%] shrink-0 truncate text-[12px] font-medium leading-4 text-[#6B6B6B] hover:text-ink" title="Open the thread">
            {s.title}
            {display !== undefined ? ` · screen ${screenNo(display)}` : ""}
          </button>
        )}
      </span>
      {question && <span className={`-mt-1 pl-4 text-[13.5px] leading-[19px] text-[#3A3A38] ${pinned ? "line-clamp-3 whitespace-pre-wrap" : ""}`}>{question}</span>}
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
        ) : kind === "elsewhere" || kind === "safety" ? (
          <>
            <button disabled={busy} onClick={() => void reply(kind === "elsewhere" ? "I approved it. Carry on." : "Go on.")} className={primary}>
              {kind === "elsewhere" ? "Done, I approved it" : "Go on"}
            </button>
            {showScreen}
            <button disabled={busy} onClick={dismiss} className={plain}>
              {kind === "safety" ? "Stop" : "Never mind"}
            </button>
            <button disabled={busy} onClick={onSomethingElse} className="px-2 py-1.5 text-[13px] font-medium leading-4 text-[#6B6B6B] hover:text-ink">
              Something else…
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
            {pinned && showScreen}
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

/** Under a thread's question kept in the chat: how the user answered it, once they have. */
function AnsweredLine({ message: m, session: s }: { message: Message; session?: Session }) {
  if (!s) return null;
  const answer = s.replies.find((r) => r.role === "user" && r.at > m.at);
  const said = answer ? `You answered: “${answer.text.length > 80 ? `${answer.text.slice(0, 79)}…` : answer.text}”` : s.dismissed ? "You dismissed it" : undefined;
  if (!said) return null;
  return (
    <span className="flex items-center gap-1 pl-3 text-[11.5px] leading-4 text-[#9A9A98]">
      <svg width="11" height="11" viewBox="0 0 14 14" aria-hidden className="shrink-0">
        <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate">{said}</span>
    </span>
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

function AppApprovalCard({ state, approval: a, className = "" }: { state: AppState; approval: AppApproval; className?: string }) {
  const [busy, setBusy] = useState(false);
  const b = state.bots.find((x) => x.id === a.botId);
  const s = state.sessions.find((x) => x.id === a.sessionId);
  // A call to an API with one of your keys (keys.tsx): which service, and the method and path in full.
  const api = apiAskOf(a);
  const decide = async (yes: boolean) => {
    setBusy(true);
    await post("/api/apps/approvals", { id: a.id, yes });
  };
  const btn = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
  return (
    <div className={`flex flex-col gap-2.5 rounded-2xl bg-white p-3.5 shadow-[0_0_0_1px_#0000000F,0_10px_30px_-16px_#00000059] ${className}`}>
      <div className="flex items-start gap-2.5">
        {b && <Mascot botId={b.id} color={b.color} size={26} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13.5px] font-semibold leading-[18px]">
            {api ? `${b?.name ?? "A bot"} wants to call ${api.label}` : `${b?.name ?? "A bot"} wants to: ${a.title}`}
          </span>
          {s && <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">For &ldquo;{s.title}&rdquo;</span>}
        </div>
      </div>
      {api && <ApiAsk ask={api} detail={a.detail} botName={b?.name ?? "The bot"} />}
      {a.detail && !api && <pre className={`${a.app === "email" ? "max-h-[280px]" : "max-h-[180px]"} overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#F7F7F6] px-3 py-2 font-sans text-[12.5px] leading-[18px] text-[#3A3A38] [overflow-wrap:anywhere]`}>{a.detail}</pre>}
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

/**
 * Where a finished thread left off: its last frame (the screen as it let go: /api/frames), the page it
 * was on, and its screen's number. If another task has that screen now, it says so: the panel would show
 * that task, not this one's work.
 */
function LeftOff({ state, session: s, onShow }: { state: AppState; session: Session; onShow: () => void }) {
  if (live(s) || s.runsOn === "mac" || s.lastDisplay === undefined || !s.lastFrameAt) return null;
  const now = screenMap(state, s.botId).find((x) => x.display === s.lastDisplay);
  const taken = now && now.sessionId !== s.id && now.kind !== "free" ? state.bots.find((x) => x.id === now.botId)?.name ?? "Another task" : null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium leading-4 text-[#6B6B6B]">Where it left off · screen {screenNo(s.lastDisplay)}</span>
      <button onClick={onShow} title={taken ? `${taken} is using screen ${screenNo(s.lastDisplay)} now` : "Show its screen"} className="overflow-hidden rounded-xl shadow-[0_0_0_1px_#E6E6E3] hover:shadow-[0_0_0_1px_#C9C9C6]">
        {/* eslint-disable-next-line @next/next/no-img-element -- a local frame from this Mac, not a remote image */}
        <img src={`/api/frames?session=${s.id}&t=${s.lastFrameAt}`} alt={`The screen as ${s.title} left it`} className="block w-full" />
      </button>
      <span className="truncate text-[12px] leading-4 text-[#9A9A98]">
        {s.lastPage ? (s.lastPage.title ?? s.lastPage.url) : ""}
        {taken ? `${s.lastPage ? " · " : ""}screen ${screenNo(s.lastDisplay)} is in use by ${taken} now` : ""}
      </span>
    </div>
  );
}
