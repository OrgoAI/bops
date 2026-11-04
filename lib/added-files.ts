/**
 * Files the user adds for a bot (the + in the message box, dropping them on the chat or on a bot's screen): not
 * pictures for the model to look at (those are Message.images), but files put where the bot works, for it to open
 * there. On its computer they go on the Desktop (Orgo's file uploads); a bot that works on this Mac gets them in the
 * user's folder here. Shared by the page and the server.
 */

export type AddedFile = {
  id: string;
  /** Its name as it is there (cleanFileName). */
  name: string;
  size: number;
  /** On the bot's computer, or on this Mac (a bot that works here). */
  where: "computer" | "mac";
  /** Where it is: ~/Desktop/<name> on a computer, the full path on this Mac. */
  path: string;
  /** The bot it was added for (its computer, when it shares the main bot's, is that one). */
  botId: string;
};

/** Orgo's large file uploads take up to 2 GiB (orgo-web lib/files/transfer.ts). */
export const FILE_MAX = 2 * 1024 ** 3;
/** At most this many files and pictures wait in the message box at once. */
export const ATTACH_MAX = 10;

/** Pictures the model looks at; any other file, a picture in another format too, goes where the bot works. */
export const isPicture = (type: string) => /^image\/(png|jpeg|webp|gif)$/i.test(type);

/**
 * A file's name safe to put on a computer: its last part only, no control characters, no leading dots (a hidden
 * file, or . and ..), at most 180 characters with its extension kept. Empty when nothing is left.
 */
export function cleanFileName(raw: string): string {
  const last = (raw.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+/, "");
  if (last.length <= 180) return last;
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 && last.length - dot <= 16 ? last.slice(dot) : "";
  return last.slice(0, 180 - ext.length) + ext;
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

/** What a bot is told about files the user added (in its chat, and in a task started from that message). */
export function filesNote(files: readonly AddedFile[], who: string): string {
  if (!files.length) return "";
  const list = files.map((f) => `${f.path} (${fileSize(f.size)})`).join(", ");
  const one = files.length === 1;
  return files.every((f) => f.where === "mac")
    ? `[${who} added ${one ? "a file" : `${files.length} files`} for you, saved on their Mac: ${list}]`
    : `[${who} added ${one ? "a file" : `${files.length} files`} to your computer's Desktop: ${list}. Open ${one ? "it" : "them"} there.]`;
}
