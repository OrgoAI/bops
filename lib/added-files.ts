/**
 * Files the user adds for a bot (the + in the message box, dropping them on the chat or on a bot's screen): not
 * pictures for the model to look at (those are Message.images), but files put on the Desktop of the computer the bot
 * works on (Orgo's file uploads, lib/server/bot-files.ts), for it to open there. Shared by the page and the server.
 */

export type AddedFile = {
  id: string;
  /** Its name as it is there: cleanFileName, then the first one free on that Desktop (report (2).pdf). */
  name: string;
  size: number;
  /** Where it is on that computer: ~/Desktop/<name>. */
  path: string;
  /** The bot it was added for. */
  botId: string;
  /** The bot whose computer it's on (botId's own, or the main bot's when it shares that one), and its name. */
  hostId: string;
  hostName: string;
};

/** Orgo's large file uploads take up to 2 GiB (orgo-web lib/files/transfer.ts). */
export const FILE_MAX = 2 * 1024 ** 3;
/** At most this many files and pictures wait in the message box at once. */
export const ATTACH_MAX = 10;

/** Pictures the model looks at; any other file, a picture in another format too, goes where the bot works. */
export const isPicture = (type: string) => /^image\/(png|jpeg|webp|gif)$/i.test(type);

/** The most a name may take, in UTF-8 bytes: 255 is the limit on the Mac and on Linux, with room left for " (2)". */
const NAME_BYTES = 240;
const bytes = (t: string) => new TextEncoder().encode(t).length;

/**
 * A file's name safe to put on a computer: its last part only, no control characters, no leading dots (a hidden
 * file, or . and ..), at most NAME_BYTES with its extension kept, cut between characters (never inside one). Empty
 * when nothing is left.
 */
export function cleanFileName(raw: string): string {
  const last = (raw.split(/[\\/]/).pop() ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+/, "");
  if (bytes(last) <= NAME_BYTES) return last;
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 && last.length - dot <= 16 ? last.slice(dot) : "";
  let stem = "";
  for (const ch of Array.from(ext ? last.slice(0, dot) : last)) {
    if (bytes(stem + ch + ext) > NAME_BYTES) break;
    stem += ch;
  }
  return stem + ext;
}

/** 812 bytes, 14 KB, 3.2 MB, 1.1 GB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n >= 10 || u === 0 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
}

/**
 * What a bot is told about files the user added (in its chat, in a thread, in a task started from that message).
 * `readerHost`: the bot whose computer the one reading works on ("mac" for a task on this Mac); a file on that
 * computer is on "your computer's", any other on "<its bot>'s computer's" Desktop, so a bot on another computer (a
 * group's, a hand-off's) never looks for it on its own.
 */
export function filesNote(files: readonly AddedFile[], who: string, readerHost?: string): string {
  if (!files.length) return "";
  const hosts = new Map<string, AddedFile[]>();
  for (const f of files) hosts.set(f.hostId, [...(hosts.get(f.hostId) ?? []), f]);
  return [...hosts.values()]
    .map((on) => {
      const one = on.length === 1;
      const list = on.map((f) => `${f.path} (${fileSize(f.size)})`).join(", ");
      const mine = !!readerHost && on[0].hostId === readerHost;
      return mine
        ? `[${who} added ${one ? "a file" : `${on.length} files`} to your computer's Desktop: ${list}. Open ${one ? "it" : "them"} there.]`
        : `[${who} added ${one ? "a file" : `${on.length} files`} to ${on[0].hostName}'s computer's Desktop: ${list}. ${one ? "It's" : "They're"} on that computer, not this one.]`;
    })
    .join(" ");
}
