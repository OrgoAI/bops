import "server-only";
import type { Bot, ChannelLink } from "@/lib/types";
import { accountsOf, appList, CHANNEL_APPS, composioOn } from "./composio";
import { linksFor } from "./channels";
import { mailOn } from "./mail";
import { lineOf } from "./phone";
import { getState, ownerName } from "./store";

/**
 * What a bot is told about what it can use and where it's reached, the same in each of its own
 * instructions: its chat (chat.ts), its tasks on a computer or on the user's Mac (sessions.ts) and its
 * calls (call.ts).
 *
 * - Its apps: the accounts the user gave it, each by name with read only or read & act, straight
 *   from the user's connected accounts (any app in Composio's catalog, so Google Sheets, Notion,
 *   HubSpot or Jira show up as soon as they're connected), how to use them through the app gateway
 *   (Composio's tool router: find_app_actions searches it, use_app runs what it found), and the
 *   user's other connected apps it can't use yet. Never the Slack connection (CHANNEL_APPS): it's
 *   how bots get into Slack, and Slack is listed with the places.
 * - Where the user reaches it: Bops, texts and calls on its number, email, and the Slack, Telegram and
 *   Discord it was added to (channels.ts), with what a message from there looks like and where the
 *   answer goes.
 */

type Mode =
  /** Its chat turn: the tools are there (when it has apps), and use_app's asking goes on while the chat answers. */
  | "chat"
  /** A task on a computer or the Mac. `tools`: whether find_app_actions and use_app reach Bops from there. */
  | "task"
  /** A call: it delegates, and its delegate (the chat) uses the apps. */
  | "call";

/** "a", "a and b", "a, b and c" (`or` for "a or b"). */
const listed = (items: string[], word = "and") => (items.length > 1 ? `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}` : (items[0] ?? ""));

/** The user's connected apps this bot can't use (it may tell them where to give it access). Not the Slack connection: that's how bots get into Slack. */
function notMine(b: Bot) {
  const mine = new Set(accountsOf(b).map((x) => x.account.app));
  return [...new Set((getState().accounts ?? []).filter((a) => a.status === "active" && !mine.has(a.app) && !CHANNEL_APPS.has(a.app)).map((a) => a.appName))];
}

/** What the bot knows about its apps and the app gateway, for one of its instructions. */
export function appsNote(b: Bot, mode: Mode, opts: { tools?: boolean } = {}) {
  if (!composioOn()) return "";
  const owner = ownerName();
  const list = appList(b);
  const missing = notMine(b);
  const ask = missing.length
    ? `Through Bops, ${owner} also has ${listed(missing)} connected, which you can't use yet. When they ask what you can use, or a job needs one of these, tell them they can give you access in the Vault (on your profile): it's faster and more reliable than doing it on a computer.`
    : "";
  if (!list) {
    if (mode !== "chat") return ask;
    return (
      ask ||
      `No apps are connected for you yet. When a job needs ${owner}'s email, calendar, documents, CRM or another app, tell them they can connect it in the Vault (on your profile) and give you access; until then you can do it on a computer.`
    );
  }
  const yours = `Your apps: ${owner} connected these accounts and gave you access: ${list}. In an account marked read only you can look things up but not change anything; read & act also lets you make changes.`;
  if (mode === "call") return `${yours} On a call, delegate anything that needs them: your delegate uses them.`;
  if (mode === "task" && opts.tools === false)
    return [
      yours,
      `They can't be reached from this computer in this task (you have no find_app_actions or use_app here). If a step needs one of them, say so in your answer: in your chat, ${owner} can have you do it with the app.`,
      ask,
    ]
      .filter(Boolean)
      .join(" ");
  const asking =
    mode === "chat"
      ? `use_app asks them for you, so don't ask first; then tell them in one short line what's waiting, and don't call it again`
      : `use_app asks them for you and waits for their answer, so don't ask first`;
  return [
    yours,
    `They work through Bops' app gateway (Composio's tool router), which knows every action each app has. To use one: first call find_app_actions with the job in plain words ("add a row to the Q3 budget sheet", "my open Jira issues"); it searches only your apps and answers with the exact action names (like GOOGLESHEETS_BATCH_UPDATE), their inputs, how to use them and known pitfalls. Then call use_app with one exact name from that answer and its inputs. With more than one account in an app, set account to the one the job is about (its label or address, as listed above) and say which you used.`,
    b.autoApprove
      ? `Never make up an action name or guess its inputs: if nothing fits, search again with other words. ${owner} set you to "Just do it": every action runs at once, without asking them, so do what the job needs and say what you did.`
      : `Never make up an action name or guess its inputs: if nothing fits, search again with other words. Reading runs at once. Small changes only to ${owner}'s own things (a label, a draft for them) may go at once; anything that sends, posts, shares, deletes or pays waits for ${owner}'s OK: ${asking}.`,
    `Use your apps before doing the same thing on a screen: they act in ${owner}'s real accounts, faster and surer.`,
    mode === "chat"
      ? `Use them yourself, right here in the chat: never start or hand off a task just to use one of your apps (when ${owner} names an app, a connector, Composio or MCP, they mean these). A task is for work that needs a computer besides.`
      : "",
    ask,
  ]
    .filter(Boolean)
    .join(" ");
}

const KIND_NAME = { slack: "Slack", telegram: "Telegram", discord: "Discord" } as const;

/** One place in Slack, Telegram or Discord, as the bot is told it: where, and whether it works yet. */
function channelPlace(l: ChannelLink, owner: string) {
  const where =
    l.kind === "slack"
      ? `in Slack (${l.handle}: ${[...(l.slack?.channels ?? []).map((c) => `#${c.name}`), "direct messages with the Bops app"].join(", ")})`
      : l.kind === "telegram"
        ? `in Telegram as ${l.handle}`
        : `in Discord as ${l.handle}${l.discord?.username && l.discord.username !== l.handle ? ` (${l.discord.username})` : ""}`;
  if (l.status === "error") return `${where}, not working right now (${(l.error ?? "it needs attention in Bops").replace(/\.$/, "")})`;
  return l.owner ? where : `${where}, not paired yet (until ${owner} sends you the pairing code there, you answer only the code)`;
}

/** Where the user reaches this bot, and how a message from each place shows and is answered. */
export function placesNote(b: Bot, mode: Mode) {
  const owner = ownerName();
  const line = lineOf(b);
  const channels = linksFor(b);
  const elsewhere = [
    ...(line ? [`by text at ${line.phone}${line.type === "imessage" ? " (iMessage)" : ""}`] : []),
    ...(mailOn() && b.email ? [`by email at ${b.email}`] : []),
    ...channels.map((l) => channelPlace(l, owner)),
  ];
  // iMessage lines can't take calls (they can't be trunked to the voice model); other numbers can.
  const calls = `on a call in the Bops app${line && line.type !== "imessage" ? ` or to ${line.phone}` : ""}`;
  if (mode === "task")
    return `Besides Bops, ${owner} reaches you ${[calls, ...elsewhere].join("; ")}. When this task was asked from one of those places, your final answer goes back there on its own: don't send it there yourself.`;
  if (mode === "call") return `Besides calls, ${owner} reaches you ${["in Bops", ...elsewhere].join("; ")}.`;
  return [
    `Where ${owner} reaches you: here in Bops; ${[calls, ...elsewhere].join("; ")}.`,
    channels.length
      ? `A message marked ${listed([...new Set(channels.map((l) => `[in ${KIND_NAME[l.kind]}]`))], "or")} is ${owner} writing to you there (only the account they paired counts as them; nobody else's messages reach you). Answer it like a text: your reply goes back there on its own, and so does the result of any task you start or hand off for it. Keep those replies short and plain, no tables. In a group or channel you answer only when mentioned or replied to.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
