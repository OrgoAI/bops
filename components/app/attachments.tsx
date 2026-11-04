"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { ATTACH_MAX, FILE_MAX, fileSize, isPicture, type AddedFile } from "@/lib/added-files";
import type { Message } from "@/lib/types";
import { readAllowed } from "./view-only";

/**
 * Images and files in chat: attaching them (the + button, pasting, dropping), the tray of what's about to be
 * sent, the images and files in a message, and looking at an image full size. Big images are made smaller here,
 * before they're uploaded, so sending stays quick and bots get a sensible size. Any other file goes where the bot
 * works (its computer's Desktop, lib/added-files.ts) as soon as it's added, and the message tells the bot where.
 */

type Pic = NonNullable<Message["images"]>[number];
/** What an attachment turned into once it's uploaded: an image the bot sees, or a file where it works. */
export type Attached = { pic: Pic } | { file: AddedFile } | { failed: { name: string; error: string } };
export type Attachment = {
  key: string;
  kind: "image" | "file";
  /** An image's local preview (an object URL); none for a file. */
  preview?: string;
  name: string;
  size: number;
  /** A file's bot: where it goes, and the chats it's for (a bot's own, or a group it's in). */
  botId?: string;
  status: "uploading" | "ready" | "failed";
  /** How much of a file has gone up, 0 to 1 (then its computer still has to fetch it). */
  progress?: number;
  pic?: Pic;
  file?: AddedFile;
  error?: string;
  done: Promise<Attached | null>;
};

/** sendFile was stopped (the file taken out before it went): nothing to say about it. */
export const STOPPED = "stopped";

/**
 * Put `file` on the Desktop of the computer bot `botId` works on (POST /api/bots/files, the bytes as they are),
 * saying how much has gone up. `screen`: dropped on that computer's own screen. `signal` stops it (the upload too,
 * so nothing arrives), rejecting with STOPPED. Answers the added file, or throws with what went wrong in words.
 */
export function sendFile(botId: string, file: File, onProgress?: (part: number) => void, { signal, screen = false }: { signal?: AbortSignal; screen?: boolean } = {}): Promise<AddedFile> {
  return new Promise((resolve, reject) => {
    if (file.size > FILE_MAX) return reject(new Error("Too big. 2 GB at most."));
    if (!file.size) return reject(new Error("That file is empty."));
    if (signal?.aborted) return reject(new Error(STOPPED));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/bots/files?botId=${encodeURIComponent(botId)}&name=${encodeURIComponent(file.name)}${screen ? "&to=screen" : ""}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let j: { file?: AddedFile; error?: string } = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 200 && j.file) resolve(j.file);
      else reject(new Error(j.error ?? "Couldn't add this file"));
    };
    xhr.onerror = () => reject(new Error("Couldn't reach Bops. Try again."));
    xhr.onabort = () => reject(new Error(STOPPED));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

const MAX_EDGE = 2000;
const KEEP_BYTES = 1.5 * 1024 * 1024;

/** The image as a data URL, at most 2000 px on its long side (re-encoded as JPEG when it's big). */
async function prepare(file: File): Promise<{ dataUrl: string; type: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("couldn't read that image"));
      i.src = url;
    });
    const { naturalWidth: w0, naturalHeight: h0 } = img;
    const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
    const keep = scale === 1 && file.size <= KEEP_BYTES && /^image\/(png|jpeg|webp|gif)$/.test(file.type);
    if (keep) {
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(file);
      });
      return { dataUrl, type: file.type, w: w0, h: h0 };
    }
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.88), type: "image/jpeg", w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The images and files about to be sent with a message: each starts uploading as soon as it's added (a file to
 * where `target()` works: the chat's bot, or the group's main bot). A file is for its bot's chats only (ChatView
 * shows and sends only those); taking one out (×) stops its upload. Each image's preview is an object URL, which
 * holds on to its image (a pasted one's in Bops' main process) until it's let go: on taking one out, on leaving
 * with them still there, and (ChatView.send) once its message no longer shows it.
 */
export function useAttachments(target?: () => string | undefined) {
  const [items, setItems] = useState<Attachment[]>([]);
  const live = useRef(items);
  const to = useRef(target);
  // Each file's upload, to stop it when it's taken out (or the box goes).
  const stops = useRef(new Map<string, AbortController>());
  useEffect(() => {
    live.current = items;
    to.current = target;
  });
  useEffect(() => {
    const going = stops.current;
    return () => {
      live.current.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview);
      });
      going.forEach((c) => c.abort());
    };
  }, []);
  /** Adds them (ten in all at most; files only when there's a bot to put them with); answers the keys of the ones added. */
  const add = useCallback((files: Iterable<File>) => {
    const botId = to.current?.();
    // Ten at most: one past that is not added, or uploaded.
    const fresh = [...files].filter((f) => isPicture(f.type) || f.type.startsWith("image/") || !!botId).slice(0, Math.max(0, ATTACH_MAX - live.current.length));
    const keys: string[] = [];
    const set = (key: string, patch: Partial<Attachment>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    for (const file of fresh) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      keys.push(key);
      // A picture the model can look at goes as one; any other file (a PDF, a sheet, a HEIC photo) where the bot works.
      const picture = isPicture(file.type) || (file.type.startsWith("image/") && !botId);
      const preview = picture ? URL.createObjectURL(file) : undefined;
      const stop = picture ? undefined : new AbortController();
      if (stop) stops.current.set(key, stop);
      const done = (async (): Promise<Attached | null> => {
        try {
          if (!picture) {
            const added = await sendFile(botId!, file, (part) => set(key, { progress: part }), { signal: stop!.signal });
            set(key, { status: "ready", file: added, progress: 1 });
            return { file: added };
          }
          const p = await prepare(file);
          const res = await fetch("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl: p.dataUrl }) });
          const j = (await res.json()) as { id?: string; type?: string; error?: string };
          if (!j.id) throw new Error(j.error ?? "upload failed");
          const pic = { id: j.id, type: j.type ?? p.type, w: p.w, h: p.h };
          set(key, { status: "ready", pic });
          return { pic };
        } catch (e) {
          const error = (e as Error).message;
          if (error === STOPPED) return null;
          set(key, { status: "failed", error });
          return { failed: { name: file.name, error } };
        } finally {
          stops.current.delete(key);
        }
      })();
      const item: Attachment = { key, kind: picture ? "image" : "file", preview, name: file.name, size: file.size, ...(picture ? {} : { botId }), status: "uploading", progress: picture ? undefined : 0, done };
      setItems((xs) => [...xs, item].slice(0, ATTACH_MAX));
    }
    return keys;
  }, []);
  /** Takes one out (×): its preview let go, its upload stopped. */
  const remove = useCallback((key: string) => {
    const gone = live.current.find((x) => x.key === key);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    stops.current.get(key)?.abort();
    setItems((xs) => xs.filter((x) => x.key !== key));
  }, []);
  /** Lets these go from the box as their message is sent (their uploads go on: the message waits for them). */
  const release = useCallback((keys: Iterable<string>) => {
    const sent = new Set(keys);
    setItems((xs) => xs.filter((x) => !sent.has(x.key)));
  }, []);
  return { items, add, remove, release };
}

/** A file dropped on a bot's screen, on its way to that computer's Desktop (useScreenDrop). */
export type ScreenDrop = { key: string; name: string; status: "uploading" | "ready" | "failed"; progress: number; error?: string };

/**
 * Files dropped on a bot's screen go on that computer's Desktop (sendFile), with a note for each: how much has gone
 * up, then that it's there (gone after a few seconds), or why not (until it's closed). Off (`botId` unset), a drop
 * is left to the window, which refuses it (bops-app.tsx).
 */
export function useScreenDrop(botId: string | undefined) {
  const [over, setOver] = useState(false);
  const [drops, setDrops] = useState<ScreenDrop[]>([]);
  const set = (key: string, patch: Partial<ScreenDrop>) => setDrops((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const close = useCallback((key: string) => setDrops((xs) => xs.filter((x) => x.key !== key)), []);
  const take = (files: File[]) => {
    if (!botId) return;
    for (const file of files.slice(0, ATTACH_MAX)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setDrops((xs) => [...xs, { key, name: file.name, status: "uploading", progress: 0 }]);
      sendFile(botId, file, (part) => set(key, { progress: part }), { screen: true }).then(
        () => {
          set(key, { status: "ready", progress: 1 });
          setTimeout(() => close(key), 5000);
        },
        (e: Error) => set(key, { status: "failed", error: e.message }),
      );
    }
  };
  const has = (e: DragEvent) => !!botId && [...e.dataTransfer.types].includes("Files");
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!has(e)) return;
      // Its own: not also the chat's around it, nor the window's refusal (bops-app.tsx).
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      if (!over) setOver(true);
    },
    onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false),
    onDrop: (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      take([...e.dataTransfer.files]);
    },
  };
  return { over: over && !!botId, drops, close, dropProps };
}

/** Over a bot's screen while files are dragged on it, and the notes of the ones on their way (useScreenDrop). */
export function ScreenDrops({ over, drops, onClose, host }: { over: boolean; drops: ScreenDrop[]; onClose: (key: string) => void; host: string }) {
  return (
    <>
      {over && (
        <div className="pointer-events-none absolute inset-2 z-[40] flex items-center justify-center rounded-[18px] border-2 border-dashed border-[#0A0A0A]/25 bg-white/80 backdrop-blur-[2px]">
          <span className="text-[14px] font-medium text-[#3A3A38]">Drop to put it on {host}&apos;s Desktop</span>
        </div>
      )}
      {!!drops.length && (
        <div className="absolute bottom-3 left-1/2 z-[41] flex w-[min(320px,calc(100%-24px))] -translate-x-1/2 flex-col gap-1.5">
          {drops.map((d) => (
            <div key={d.key} role="status" className="flex items-center gap-2.5 rounded-[14px] bg-white py-2 pl-3 pr-2 shadow-[0_0_0_1px_#E2E2DF,0_8px_24px_-12px_#0000004D]">
              <FileIcon className={`shrink-0 ${d.status === "failed" ? "text-[#B42318]" : "text-[#6B6B6B]"}`} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[12.5px] font-medium leading-4 text-ink">{d.name}</span>
                <span className={`truncate text-[11px] leading-[14px] ${d.status === "failed" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>
                  {d.status === "failed" ? d.error : d.status === "ready" ? "On the Desktop" : d.progress < 1 ? `Uploading ${Math.round(d.progress * 100)}%` : `Putting it on ${host}'s computer…`}
                </span>
              </div>
              {d.status !== "uploading" && (
                <button type="button" onClick={() => onClose(d.key)} aria-label="Close" className="flex size-6 shrink-0 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0]">
                  <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
                    <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** What's about to be sent: small previews with × to take one out (a spinner while it uploads). */
export function AttachmentTray({ items, onRemove }: { items: Attachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map((a) => (
        <div key={a.key} className={`group/att relative h-[60px] shrink-0 ${a.kind === "file" ? "w-[188px]" : "w-[60px]"}`}>
          {a.kind === "file" ? (
            <FileTile name={a.name} size={a.size} status={a.status} progress={a.progress} error={a.error} host={a.file?.hostName} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview of a file being attached
            <img src={a.preview} alt="" className={`size-full rounded-[12px] object-cover shadow-[0_0_0_1px_#0000001A] ${a.status === "failed" ? "opacity-40" : ""}`} />
          )}
          {a.kind === "image" && a.status === "uploading" && (
            <span className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-white/50">
              <span className="size-4 animate-spin rounded-full border-2 border-[#0A0A0A]/20 border-t-[#0A0A0A]" />
            </span>
          )}
          {a.kind === "image" && a.status === "failed" && <span data-tip={a.error ?? "Couldn't attach this"} className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-[#B42318]">Failed</span>}
          <button
            type="button"
            onClick={() => onRemove(a.key)}
            aria-label={a.kind === "file" ? `Remove ${a.name}` : "Remove image"}
            className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-[#0A0A0A] text-white shadow-[0_0_0_2px_#FFFFFF]"
          >
            <svg width="8" height="8" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/** A page with its corner folded: a file. */
function FileIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden className={className}>
      <path d="M3 1h8l6 6v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="#FFFFFF" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M11 1v4a2 2 0 0 0 2 2h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** A file in the message box: its name and size, how much has gone up, or why it couldn't go. */
function FileTile({ name, size, status, progress, error, host }: { name: string; size: number; status: Attachment["status"]; progress?: number; error?: string; host?: string }) {
  const line =
    status === "failed"
      ? (error ?? "Couldn't add this file")
      : status === "ready"
        ? `${fileSize(size)} · on ${host ? `${host}'s` : "its"} computer`
        : progress !== undefined && progress < 1
          ? `Uploading ${Math.round(progress * 100)}%`
          : "Putting it on its computer…";
  return (
    <div data-tip={status === "failed" ? line : undefined} className="flex size-full items-center gap-2.5 overflow-hidden rounded-[12px] bg-[#F7F7F6] pl-3 pr-4 shadow-[0_0_0_1px_#0000001A]">
      <FileIcon className={status === "failed" ? "text-[#B42318]" : "text-[#6B6B6B]"} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium leading-4 text-ink">{name}</span>
        <span className={`truncate text-[11px] leading-[14px] ${status === "failed" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>{line}</span>
        {status === "uploading" && (
          <span className="h-[3px] w-full overflow-hidden rounded-full bg-[#0A0A0A]/10">
            <span className="block h-full rounded-full bg-[#0A0A0A]/60 transition-[width] duration-200" style={{ width: `${Math.round((progress ?? 1) * 100)}%` }} />
          </span>
        )}
      </div>
    </div>
  );
}

/** The files added with a message: each one's name, size and whose computer's Desktop it's on. */
export function MessageFiles({ files, align = "end" }: { files: { name: string; size: number; hostName?: string }[]; align?: "start" | "end" }) {
  if (!files.length) return null;
  return (
    <div className={`flex max-w-[320px] flex-col gap-1.5 ${align === "end" ? "items-end self-end" : "items-start self-start"}`}>
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} className="flex max-w-full items-center gap-2.5 rounded-[14px] bg-white py-2 pl-3 pr-4 shadow-[0_0_0_1px_#E2E2DF]">
          <FileIcon className="shrink-0 text-[#6B6B6B]" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[13px] font-medium leading-4 text-ink">{f.name}</span>
            <span className="truncate text-[11.5px] leading-[14px] text-[#6B6B6B]">
              {fileSize(f.size)}
              {f.hostName ? ` · on ${f.hostName}'s computer's Desktop` : ""}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The images in a message: one large, or a tidy grid; click one to see it full size. */
export function MessageImages({ images, previews, align = "end" }: { images?: Pic[]; previews?: string[]; align?: "start" | "end" }) {
  const [open, setOpen] = useState<string | null>(null);
  const srcs = previews ?? (images ?? []).map((i) => `/api/uploads/${i.id}`);
  if (!srcs.length) return null;
  // A workspace shared with the user: its images are the owner's, kept where they were sent from, not here.
  if (!previews && !readAllowed(srcs[0]))
    return (
      <div className={`rounded-[14px] px-3 py-2 text-[12.5px] leading-4 text-[#6B6B6B] shadow-[0_0_0_1px_#E6E6E3] ${align === "end" ? "self-end" : "self-start"}`}>
        {srcs.length === 1 ? "An image" : `${srcs.length} images`}. Images in a shared workspace aren&apos;t shown yet.
      </div>
    );
  const one = srcs.length === 1;
  const ratio = (i: number) => (images?.[i]?.w && images[i].h ? images[i].w! / images[i].h! : undefined);
  return (
    <div className={`flex flex-wrap gap-1.5 ${align === "end" ? "justify-end self-end" : "self-start"} ${one ? "max-w-[300px]" : "max-w-[320px]"}`}>
      {srcs.map((src, i) => (
        <button key={src} type="button" onClick={() => setOpen(src)} aria-label="Open image" className="overflow-hidden rounded-[16px] shadow-[0_0_0_1px_#0000000F]">
          {/* eslint-disable-next-line @next/next/no-img-element -- images the user attached, served by this app */}
          <img
            src={src}
            alt=""
            loading="lazy"
            className={one ? "block max-h-[320px] w-auto max-w-[300px] object-contain" : "block size-[104px] object-cover"}
            style={one && ratio(i) ? { aspectRatio: ratio(i) } : undefined}
          />
        </button>
      ))}
      {open && <Lightbox src={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One image, full size, over everything. Click anywhere or press Esc to close. */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const closer = useRef(onClose);
  useEffect(() => {
    closer.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closer.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image"
      onClick={onClose}
      className="fixed inset-0 z-[900] flex animate-[screen-in_150ms_ease-out] cursor-zoom-out items-center justify-center bg-black/70 p-10 backdrop-blur-sm"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- full-size view of an attached image */}
      <img src={src} alt="" className="max-h-full max-w-full rounded-[12px] shadow-[0_24px_60px_-20px_#000000]" />
    </div>,
    document.body,
  );
}
