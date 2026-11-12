"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserEvent, BrowserPerson } from "@/cloud/protocol";
import { arrived, at, DIP_MS, REST_MS, retarget, travel, type Point, type Travel } from "@/lib/cursor-path";
import type { Bot } from "@/lib/types";
import { initialsFrom } from "./account";
import { Mascot } from "./mascot";

/*
 * Who is moving on the bot's page, drawn beside the frame (never in it: the page is the bot's, this is Bops's own DOM
 * over the picture of it). Each driver has a cursor: an ink arrow with its name riding at its lower right, the bot's
 * with its face and name, a person's with their initials and first name. It travels like a hand (lib/cursor-path.ts),
 * arrives before it presses (a press that comes first hurries the rest of the way), dips and rings once where it
 * pressed, and fades after resting a while. The viewer's own pointer is never drawn twice: their own events don't come
 * here (`you`). Their own press on the page rings at once where they pressed (CursorFeed.ring, from bot-browser.tsx),
 * rather than once the page's answer comes back; nothing of it reaches the page.
 *
 * Reduced motion: the cursor is simply there, with no arc and no dip; the ring where it pressed still shows (it's what
 * happened, not decoration), held still.
 */

type PointerEvent = Extract<BrowserEvent, { t: "pointer" }>;
/**
 * The stream's pointer events, handed on as they come (bot-browser.tsx): a cursor moves at each without a render. `ring`:
 * the viewer's own press on the page, at its CSS pixels, shown at once.
 */
export type CursorFeed = { on: (fn: (e: PointerEvent) => void) => () => void; emit: (e: PointerEvent) => void; onRing: (fn: (p: Point) => void) => () => void; ring: (p: Point) => void };
export function cursorFeed(): CursorFeed {
  const fns = new Set<(e: PointerEvent) => void>();
  const rings = new Set<(p: Point) => void>();
  return {
    on: (fn) => {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    emit: (e) => fns.forEach((f) => f(e)),
    onRing: (fn) => {
      rings.add(fn);
      return () => void rings.delete(fn);
    },
    ring: (p) => rings.forEach((f) => f(p)),
  };
}

/** One driver's cursor: where it's going, when it last moved, a press waiting for it to get there. */
type Cursor = { travel: Travel; last: number; press: Point | null; rest?: ReturnType<typeof setTimeout> };
type Ring = { id: number; x: number; y: number };
/** How long a ring where it pressed shows. */
const RING_MS = 650;
const keyOf = (by: BrowserPerson | null) => by?.id ?? "bot";
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `page`: the page's size in CSS pixels (the frame's deviceWidth and deviceHeight), so a point on it lands on the picture
 * at whatever size that's shown. `driver`: whose cursor is live now (the person in control, else the bot); another's
 * fades at once rather than resting where it was. `idle`: the bot has stopped browsing, so its cursor fades now too.
 */
export function BrowserCursors({ bot, feed, page, driver, idle = false }: { bot: Bot; feed: CursorFeed; page: { width: number; height: number }; driver: BrowserPerson | null; idle?: boolean }) {
  const [people, setPeople] = useState<Record<string, BrowserPerson | null>>({});
  const [rings, setRings] = useState<Ring[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const cursors = useRef(new Map<string, Cursor>());
  const width = useRef(page.width);
  const frame = useRef(0);
  useEffect(() => {
    width.current = page.width;
  }, [page.width]);

  useEffect(() => {
    const scale = () => (layer.current?.clientWidth ?? 0) / (width.current || 1);
    const rest = (key: string, now = false) => {
      const c = cursors.current.get(key);
      if (!c) return;
      if (c.rest) clearTimeout(c.rest);
      const fade = () => els.current.get(key)?.setAttribute("data-rest", "");
      if (now) fade();
      else c.rest = setTimeout(fade, REST_MS);
    };
    /** A ring where something pressed, for RING_MS. */
    const ringAt = (p: Point) => {
      const id = performance.now() + Math.random();
      setRings((r) => [...r, { id, x: p.x, y: p.y }]);
      setTimeout(() => setRings((r) => r.filter((x) => x.id !== id)), RING_MS);
    };
    const press = (key: string, p: Point) => {
      const el = els.current.get(key);
      if (el && !reducedMotion()) {
        el.setAttribute("data-pressed", "");
        setTimeout(() => el.removeAttribute("data-pressed"), DIP_MS);
      }
      ringAt(p);
    };
    /** Each cursor where its travel has it now; a press that was waiting for it, once it's there. Again next frame while any moves. */
    const place = () => {
      frame.current = 0;
      const now = performance.now();
      const s = scale();
      const w = layer.current?.clientWidth ?? 0;
      let moving = false;
      for (const [key, c] of cursors.current) {
        const el = els.current.get(key);
        const p = at(c.travel, now);
        if (el) {
          el.style.transform = `translate3d(${p.x * s}px, ${p.y * s}px, 0)`;
          // The name rides at the lower right, and to the left near the right edge (it never leaves the frame).
          const tag = el.querySelector<HTMLElement>("[data-cursor-tag]");
          if (tag) el.toggleAttribute("data-flip", p.x * s + tag.offsetWidth + 24 > w);
        }
        if (!arrived(c.travel, now)) moving = true;
        else if (c.press) {
          press(key, c.press);
          c.press = null;
        }
      }
      if (moving) frame.current = requestAnimationFrame(place);
    };
    const off = feed.on((e) => {
      if (e.you) return;
      const key = keyOf(e.by);
      const now = performance.now();
      const to = { x: e.x, y: e.y };
      const c = cursors.current.get(key);
      const isPress = e.kind === "down";
      if (!c) {
        // First seen: it's there, faded in, rather than flying in from a corner.
        cursors.current.set(key, { travel: travel(to, to, now, "jump"), last: now, press: isPress ? to : null });
        setPeople((p) => ({ ...p, [key]: e.by }));
      } else if (e.kind !== "up") {
        c.travel = retarget(c.travel, to, now, { press: isPress, sinceLast: now - c.last, reduced: reducedMotion() });
        if (isPress) c.press = to;
        c.last = now;
      }
      els.current.get(key)?.removeAttribute("data-rest");
      rest(key);
      if (!frame.current) frame.current = requestAnimationFrame(place);
    });
    // The viewer's own press: its ring at once, where they pressed (no cursor of theirs: their own pointer is there).
    const offRing = feed.onRing(ringAt);
    // The frame shown at another size: each cursor stays over the same point of the page.
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => !frame.current && (frame.current = requestAnimationFrame(place))) : null;
    if (layer.current) ro?.observe(layer.current);
    const all = cursors.current;
    return () => {
      off();
      offRing();
      ro?.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      for (const c of all.values()) if (c.rest) clearTimeout(c.rest);
    };
  }, [feed]);

  // Control changed hands: only the one driving now stays; the other fades where it is.
  const live = keyOf(driver);
  useEffect(() => {
    for (const [key, el] of els.current) if (key !== live || (idle && key === "bot")) el.setAttribute("data-rest", "");
  }, [live, idle]);

  return (
    <div ref={layer} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" data-browser-cursors>
      {rings.map((r) => (
        <span
          key={r.id}
          data-cursor-ring
          className="absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink opacity-90 motion-safe:animate-[cursor-ring_650ms_cubic-bezier(0.2,0.8,0.2,1)_forwards]"
          style={{ left: `${(r.x / (page.width || 1)) * 100}%`, top: `${(r.y / (page.height || 1)) * 100}%` }}
        />
      ))}
      {Object.entries(people).map(([key, by]) => (
        <div
          key={key}
          ref={(el) => {
            if (el) els.current.set(key, el);
            else els.current.delete(key);
          }}
          data-agent-cursor={key}
          className="group/cursor absolute left-0 top-0 transition-opacity duration-300 ease-out will-change-transform data-[rest]:opacity-0"
        >
          <svg width="18" height="22" viewBox="0 0 18 22" className="absolute left-0 top-0 origin-top-left drop-shadow-[0_1px_2px_rgb(10_10_10_/_0.28)] transition-transform duration-[120ms] ease-out group-data-[pressed]/cursor:scale-90">
            <path d="M1.5 1.5v15.2l4.1-3.7 2.8 6.3 2.9-1.3-2.7-6.1h5.6z" fill="#0A0A0A" stroke="#FFFFFF" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span
            data-cursor-tag
            className="absolute left-0 top-0 flex h-7 translate-x-[13px] translate-y-[19px] items-center gap-1.5 whitespace-nowrap rounded-full bg-white py-1 pl-1 pr-2.5 text-[13px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#0A0A0A,0_4px_10px_-4px_rgb(10_10_10_/_0.3)] transition-transform duration-200 ease-out group-data-[flip]/cursor:translate-x-[calc(-100%-4px)] motion-reduce:transition-none"
          >
            {by ? (
              <span className="flex size-5 items-center justify-center rounded-full bg-[#EEEEEC] text-[11px] font-semibold text-[#3A3A38]">{initialsFrom(by.name)}</span>
            ) : (
              <Mascot botId={bot.id} color={bot.color} size={20} antenna={false} />
            )}
            <span data-cursor-name>{by ? firstName(by.name) : bot.name}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
