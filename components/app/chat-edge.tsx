"use client";

import { useEffect, useRef, useState } from "react";

/** Where this Mac remembers how wide the chat's column is beside the side panel (px). */
const CHAT_WIDTH_KEY = "bops.chatWidth";
/** The chat's column as it always was, and where a double click on its edge puts it back. */
export const CHAT_WIDTH = 440;
/** The narrowest the chat goes (its message box and buttons still fit)... */
export const CHAT_MIN = 360;
/** ...and the narrowest the side panel is made by a wide chat, the computer on it still worth looking at. */
export const PANEL_MIN = 400;
/** Arrow keys on the edge move it this far. */
const STEP = 24;
/** While the edge is dragged the chat's width is this variable on the page, so a move redraws the columns and not the app. */
const DRAGGED = "--bops-chat-dragged";

/** A width for the chat: whole pixels, no narrower than CHAT_MIN, never so wide the panel gets under PANEL_MIN (`room`: the two together). */
export function chatWidthIn(w: number, room: number): number {
  return Math.round(Math.max(CHAT_MIN, Math.min(w, room - PANEL_MIN)));
}

/**
 * The grid's columns (the title bar's are the same): the sidebar's (or its rail's), then the chat's and the side panel's, or the
 * chat alone across the rest (`chat` null). The chat's column is as wide as you dragged it, less in a window too small for that and
 * PANEL_MIN beside it, never under CHAT_MIN; while its edge is dragged, as wide as that (DRAGGED). Lengths only, so the columns still
 * slide as the sidebar's width changes.
 */
export function gridColumns(sidebar: number, chat: number | null): string {
  if (chat === null) return `${sidebar}px minmax(0,1fr)`;
  return `${sidebar}px minmax(${CHAT_MIN}px,min(var(${DRAGGED},${chat}px),calc(100% - ${sidebar + PANEL_MIN}px))) minmax(0,1fr)`;
}

/** The chat's width as this Mac remembers it: CHAT_WIDTH until its edge is dragged. */
export function storedChatWidth(): number {
  const n = typeof window === "undefined" ? NaN : Number(localStorage.getItem(CHAT_WIDTH_KEY));
  return Number.isFinite(n) && n >= CHAT_MIN ? Math.round(n) : CHAT_WIDTH;
}

/**
 * The edge between the chat's column and the side panel, at the panel's left: drag it to give the computer more room or less, double
 * click to put it back, or the arrow keys once it's focused. This Mac remembers. While it's dragged a cover over the window keeps the
 * pointer from the computer's screen and the pages in the panel (their frames would take it), with a resize cursor wherever it goes;
 * `onDragging` tells the app, whose columns don't slide meanwhile, so the edge stays under the pointer. The width it's let go at is
 * `onWidth`'s; until then only DRAGGED changes.
 */
export function ChatEdge({
  from,
  width,
  onWidth,
  onDragging,
}: {
  /** Where the chat's column starts across the window: the sidebar's width, or its rail's. */
  from: number;
  width: number;
  onWidth: (w: number) => void;
  onDragging: (on: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(width);
  // Gone mid drag (the panel closed): the drag ends with it.
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const keep = (w: number) => {
    last.current = w;
    onWidth(w);
    localStorage.setItem(CHAT_WIDTH_KEY, String(w));
  };
  const room = () => window.innerWidth - from;
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Chat width"
        aria-valuenow={width}
        aria-valuemin={CHAT_MIN}
        tabIndex={0}
        title="Drag to resize"
        className="group absolute inset-y-0 -left-1 z-40 flex w-2 cursor-col-resize justify-center outline-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const handle = e.currentTarget;
          handle.setPointerCapture(e.pointerId);
          // Where on the edge it was grabbed, so the edge doesn't jump to the pointer.
          const grab = e.clientX - (handle.parentElement?.getBoundingClientRect().left ?? e.clientX);
          last.current = width;
          setDragging(true);
          onDragging(true);
          const page = document.documentElement.style;
          const move = (ev: PointerEvent) => {
            const w = chatWidthIn(ev.clientX - grab - from, room());
            if (w === last.current) return;
            last.current = w;
            page.setProperty(DRAGGED, `${w}px`);
          };
          const end = () => {
            stop.current = null;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
            setDragging(false);
            onDragging(false);
            keep(last.current);
            // Once the columns are drawn from the width kept, so they never go back to the old one for a frame.
            requestAnimationFrame(() => page.removeProperty(DRAGGED));
          };
          stop.current = end;
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end);
          window.addEventListener("pointercancel", end);
        }}
        onDoubleClick={() => keep(CHAT_WIDTH)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          keep(chatWidthIn(chatWidthIn(width, room()) + (e.key === "ArrowLeft" ? -STEP : STEP), room()));
        }}
      >
        <div className={`h-full w-[2px] transition-colors ${dragging ? "bg-[#C9C9C6]" : "group-hover:bg-[#DCDCD9] group-focus-visible:bg-[#C9C9C6]"}`} />
      </div>
      {dragging && <div aria-hidden className="fixed inset-0 z-[100] cursor-col-resize" />}
    </>
  );
}
