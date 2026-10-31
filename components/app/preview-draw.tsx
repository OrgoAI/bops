"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Draw, on the Preview tab (preview-tab.tsx): a sheet over the page to mark it up with a pen, an arrow or a box,
 * in one red that reads on any page. Done puts a picture of the page with the marks on it in the bot's message box
 * (composer-bridge.tsx), unsent; Cancel (or Esc) leaves it as it was. The marks are kept as shapes in the page's own
 * pixels, so the picture (taken at the screen's scale) gets them sharp at its own size.
 */

type Point = [number, number];
export type Shape = { kind: "pen"; points: Point[] } | { kind: "arrow" | "box"; from: Point; to: Point };
export type Pen = Shape["kind"];

const INK = "#F04438";
const WIDTH = 3;

/** What paintShapes draws with: a canvas's 2D context, or any stand in with these. */
type Ctx = Pick<CanvasRenderingContext2D, "beginPath" | "moveTo" | "lineTo" | "stroke" | "strokeRect"> & { strokeStyle: unknown; lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin };

/** The marks on `ctx`, `scale` of its pixels to the page's: pen strokes, arrows with their heads, boxes. */
export function paintShapes(ctx: Ctx, shapes: readonly Shape[], scale = 1) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = WIDTH * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const at = (p: Point): Point => [p[0] * scale, p[1] * scale];
  for (const s of shapes) {
    if (s.kind === "box") {
      const [x0, y0] = at(s.from);
      const [x1, y1] = at(s.to);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      continue;
    }
    const points = s.kind === "pen" ? s.points.map(at) : [at(s.from), at(s.to)];
    if (!points.length) continue;
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const p of points.slice(1)) ctx.lineTo(...p);
    if (points.length === 1) ctx.lineTo(...points[0]);
    ctx.stroke();
    if (s.kind === "arrow") {
      // Its head: two strokes back from its tip, either side of its line.
      const [[x0, y0], [x1, y1]] = points;
      const a = Math.atan2(y1 - y0, x1 - x0);
      const len = 14 * scale;
      ctx.beginPath();
      ctx.moveTo(x1 - len * Math.cos(a - Math.PI / 7), y1 - len * Math.sin(a - Math.PI / 7));
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 - len * Math.cos(a + Math.PI / 7), y1 - len * Math.sin(a + Math.PI / 7));
      ctx.stroke();
    }
  }
}

/** Whether a shape is big enough to keep (a click isn't a box or an arrow). */
export const kept = (s: Shape) => (s.kind === "pen" ? s.points.length > 0 : Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) >= 4);

/** A picture of the page (a data URL, at its own size) with the marks on it, as a PNG; null when it can't be made. */
export async function composite(page: string, shapes: readonly Shape[], css: { w: number; h: number }): Promise<File | null> {
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = page;
  });
  if (!img || !img.naturalWidth || !css.w) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(img, 0, 0);
  paintShapes(g, shapes, img.naturalWidth / css.w);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new File([blob], "drawing.png", { type: "image/png" }) : null;
}

const TOOL = "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0] aria-pressed:bg-ink aria-pressed:text-white";
const PENS: { id: Pen; name: string }[] = [
  { id: "pen", name: "Pen" },
  { id: "arrow", name: "Arrow" },
  { id: "box", name: "Box" },
];

/** The sheet over the page, with its bar: Pen, Arrow, Box, Undo, Cancel and Done. */
export function DrawLayer({ onDone, onCancel, error }: { onDone: (shapes: Shape[], css: { w: number; h: number }) => Promise<void>; onCancel: () => void; error?: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pen, setPen] = useState<Pen>("pen");
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [now, setNow] = useState<Shape | null>(null);
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Its size follows the page's (the panel resized, a width picked).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const o = new ResizeObserver(fit);
    o.observe(el);
    return () => o.disconnect();
  }, []);

  // Drawn again as the marks change, sharp at the screen's scale.
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    g.clearRect(0, 0, c.width, c.height);
    paintShapes(g, now ? [...shapes, now] : shapes, dpr);
  }, [shapes, now, size]);

  const pointAt = (e: React.PointerEvent): Point => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  return (
    <div ref={box} data-preview-draw className="absolute inset-0 z-10 cursor-crosshair">
      <canvas
        ref={canvas}
        className="absolute inset-0 size-full touch-none"
        onPointerDown={(e) => {
          if (busy || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = pointAt(e);
          setNow(pen === "pen" ? { kind: "pen", points: [p] } : { kind: pen, from: p, to: p });
        }}
        onPointerMove={(e) => {
          if (!now) return;
          const p = pointAt(e);
          setNow(now.kind === "pen" ? { ...now, points: [...now.points, p] } : { ...now, to: p });
        }}
        onPointerUp={() => {
          if (now && kept(now)) setShapes([...shapes, now]);
          setNow(null);
        }}
        onPointerCancel={() => setNow(null)}
      />
      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 cursor-default items-center gap-0.5 rounded-full bg-white p-1 shadow-[0_0_0_1px_#E6E6E3,0_8px_24px_-12px_#00000059]">
        {PENS.map((p) => (
          <button key={p.id} data-draw-pen={p.id} aria-pressed={pen === p.id} onClick={() => setPen(p.id)} className={TOOL}>
            {p.name}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-[#E6E6E3]" />
        <button disabled={!shapes.length || busy} onClick={() => setShapes(shapes.slice(0, -1))} className={`${TOOL} disabled:opacity-30`}>
          Undo
        </button>
        <button disabled={busy} onClick={onCancel} className={TOOL}>
          Cancel
        </button>
        <button
          data-draw-done
          disabled={!shapes.length || busy}
          onClick={async () => {
            setBusy(true);
            await onDone(shapes, size);
            setBusy(false);
          }}
          className="flex h-7 items-center rounded-full bg-ink px-3 text-[12px] font-semibold leading-4 text-white disabled:bg-[#E6E6E3] disabled:text-[#9A9A98]"
        >
          {busy ? "Adding…" : "Done"}
        </button>
      </div>
      {error && (
        <span role="alert" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white px-3 py-1.5 text-[12px] leading-4 text-[#B42318] shadow-[0_0_0_1px_#FECDCA]">
          {error}
        </span>
      )}
    </div>
  );
}
