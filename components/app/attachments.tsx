"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Message } from "@/lib/types";

/**
 * Images in chat: attaching them (the + button, pasting, dropping), the tray of what's about to be
 * sent, the images in a message, and looking at one full size. Big images are made smaller here,
 * before they're uploaded, so sending stays quick and bots get a sensible size.
 */

type Pic = NonNullable<Message["images"]>[number];
export type Attachment = { key: string; preview: string; status: "uploading" | "ready" | "failed"; pic?: Pic; error?: string; done: Promise<Pic | null> };

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

/** The images about to be sent with a message: each starts uploading as soon as it's added. */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const add = useCallback((files: Iterable<File>) => {
    const fresh = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 10);
    for (const file of fresh) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const preview = URL.createObjectURL(file);
      const done = (async (): Promise<Pic | null> => {
        try {
          const p = await prepare(file);
          const res = await fetch("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl: p.dataUrl }) });
          const j = (await res.json()) as { id?: string; type?: string; error?: string };
          if (!j.id) throw new Error(j.error ?? "upload failed");
          const pic = { id: j.id, type: j.type ?? p.type, w: p.w, h: p.h };
          setItems((xs) => xs.map((x) => (x.key === key ? { ...x, status: "ready", pic } : x)));
          return pic;
        } catch (e) {
          setItems((xs) => xs.map((x) => (x.key === key ? { ...x, status: "failed", error: (e as Error).message } : x)));
          return null;
        }
      })();
      setItems((xs) => [...xs, { key, preview, status: "uploading" as const, done }].slice(0, 10));
    }
  }, []);
  const remove = useCallback((key: string) => setItems((xs) => xs.filter((x) => x.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);
  return { items, add, remove, clear };
}

/** What's about to be sent: small previews with × to take one out (a spinner while it uploads). */
export function AttachmentTray({ items, onRemove }: { items: Attachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map((a) => (
        <div key={a.key} className="group/att relative size-[60px] shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of a file being attached */}
          <img src={a.preview} alt="" className={`size-full rounded-[12px] object-cover shadow-[0_0_0_1px_#0000001A] ${a.status === "failed" ? "opacity-40" : ""}`} />
          {a.status === "uploading" && (
            <span className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-white/50">
              <span className="size-4 animate-spin rounded-full border-2 border-[#0A0A0A]/20 border-t-[#0A0A0A]" />
            </span>
          )}
          {a.status === "failed" && <span data-tip={a.error ?? "Couldn't attach this"} className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-[#B42318]">Failed</span>}
          <button
            type="button"
            onClick={() => onRemove(a.key)}
            aria-label="Remove image"
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

/** The images in a message: one large, or a tidy grid; click one to see it full size. */
export function MessageImages({ images, previews, align = "end" }: { images?: Pic[]; previews?: string[]; align?: "start" | "end" }) {
  const [open, setOpen] = useState<string | null>(null);
  const srcs = previews ?? (images ?? []).map((i) => `/api/uploads/${i.id}`);
  if (!srcs.length) return null;
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
    <div onClick={onClose} className="fixed inset-0 z-[900] flex animate-[screen-in_150ms_ease-out] cursor-zoom-out items-center justify-center bg-black/70 p-10 backdrop-blur-sm">
      {/* eslint-disable-next-line @next/next/no-img-element -- full-size view of an attached image */}
      <img src={src} alt="" className="max-h-full max-w-full rounded-[12px] shadow-[0_24px_60px_-20px_#000000]" />
    </div>,
    document.body,
  );
}
