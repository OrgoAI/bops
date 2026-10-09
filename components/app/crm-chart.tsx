"use client";

import { useEffect, useId, useRef, useState } from "react";
import { formatNumber, niceTicks, type Group } from "@/lib/crm-csv";

/*
 * The CRM's chart (crm.tsx): one series, drawn by hand in SVG. Bars run sideways, so long names and
 * many groups read well; a line shows a total over time. Hover or keyboard focus shows a readout,
 * and a click (or Enter) picks a bar or a point, which filters the table below it.
 */

/** Every color the chart uses. One series is ink; a pick keeps its mark ink and greys the rest. Light only, like the app. */
export const CHART = {
  ink: "#0A0A0A",
  hover: "#3A3A38",
  muted: "#C9C9C6",
  mutedHover: "#9A9A98",
  grid: "#F0F0EE",
  baseline: "#E6E6E3",
  tick: "#9A9A98",
  label: "#6B6B6B",
  value: "#3A3A38",
  ring: "#FFFFFF",
} as const;

/** Bars: one row each (the whole row is the target), the bar itself thinner, room on the right for its value. */
const PITCH = 32;
const BAR = 20;
const PAD = 4;
const VALUE_ROOM = 64;
/** The line: room above, the plot, the band of month labels under it. */
const TOP = 16;
const PLOT = 172;
const BAND = 24;

const rowsWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

type Shared = {
  groups: Group[];
  width: number;
  money: string | null;
  /** Counting rows (no sum). */
  count: boolean;
  /** The picked mark, the hovered one: indexes, or -1 / null. */
  picked: number;
  hover: number | null;
  optionId: (i: number) => string;
  said: (g: Group) => string;
  onHover: (i: number | null) => void;
  onPick: (i: number) => void;
};

/** Where things go on the bar chart, for the bars and for the readout beside one. */
function barLayout(groups: Group[], width: number, wide: boolean) {
  const labelW = wide ? 200 : 132;
  const x0 = labelW + 8;
  const x1 = Math.max(x0 + 40, width - VALUE_ROOM);
  let lo = 0;
  let hi = 0;
  for (const g of groups) {
    lo = Math.min(lo, g.value);
    hi = Math.max(hi, g.value);
  }
  const x = (v: number) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0);
  return { labelW, x, base: x(0), top: (i: number) => PAD + i * PITCH, height: groups.length * PITCH + PAD * 2 };
}

/** Where things go on the line chart. */
function lineLayout(groups: Group[], width: number, money: string | null, count: boolean) {
  let lo = 0;
  let hi = 0;
  for (const g of groups) {
    lo = Math.min(lo, g.value);
    hi = Math.max(hi, g.value);
  }
  const ticks = niceTicks(lo, hi, 4, count);
  const bottom = ticks[0];
  const topValue = ticks[ticks.length - 1];
  const tickText = ticks.map((t) => formatNumber(t, { money, compact: true }));
  const gutter = Math.max(32, Math.max(...tickText.map((t) => t.length)) * 7 + 10);
  const left = gutter + 12;
  const right = Math.max(left + 1, width - 12);
  const n = groups.length;
  const spacing = n > 1 ? (right - left) / (n - 1) : right - left;
  const px = (i: number) => (n === 1 ? (left + right) / 2 : left + i * spacing);
  const py = (v: number) => TOP + (1 - (v - bottom) / (topValue - bottom || 1)) * PLOT;
  return { ticks, tickText, gutter, left, spacing, px, py, height: TOP + PLOT + BAND };
}

/** A bar: square at the baseline, rounded at its end. */
function barPath(base: number, tip: number, y: number, h: number) {
  const r = Math.min(4, Math.abs(tip - base), h / 2);
  const d = tip >= base ? 1 : -1;
  const edge = tip - d * r;
  const sweep = d > 0 ? 1 : 0;
  return `M${base},${y}H${edge}A${r},${r} 0 0 ${sweep} ${tip},${y + r}V${y + h - r}A${r},${r} 0 0 ${sweep} ${edge},${y + h}H${base}Z`;
}

function Bars({ wide, ...s }: Shared & { wide: boolean }) {
  const { labelW, x, base, top, height } = barLayout(s.groups, s.width, wide);
  return (
    <div className="relative" style={{ height }}>
      <svg width={s.width} height={height} className="block overflow-visible">
        <line x1={base} x2={base} y1={0} y2={height} stroke={CHART.baseline} strokeWidth={1} shapeRendering="crispEdges" />
        {s.groups.map((g, i) => {
          const y = top(i) + (PITCH - BAR) / 2;
          const tip = x(g.value);
          const over = s.hover === i;
          const fill = s.picked < 0 ? (over ? CHART.hover : CHART.ink) : s.picked === i ? CHART.ink : over ? CHART.mutedHover : CHART.muted;
          const left = g.value < 0;
          return (
            <g
              key={g.key}
              id={s.optionId(i)}
              role="option"
              aria-selected={s.picked === i}
              aria-label={s.said(g)}
              className="cursor-pointer"
              onPointerEnter={() => s.onHover(i)}
              onPointerLeave={() => s.onHover(null)}
              onClick={() => s.onPick(i)}
            >
              <rect x={0} y={top(i)} width={s.width} height={PITCH} fill="transparent" />
              {g.value !== 0 && <path d={barPath(base, tip, y, BAR)} fill={fill} />}
              <text
                x={left ? tip - 6 : tip + 6}
                y={top(i) + PITCH / 2}
                dominantBaseline="central"
                textAnchor={left ? "end" : "start"}
                fontSize={12}
                fill={CHART.value}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {s.count ? g.count.toLocaleString("en-US") : formatNumber(g.value, { money: s.money, compact: true })}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Names as text the page lays out (cut with an ellipsis); the whole row under them is the bar's target. */}
      {s.groups.map((g, i) => (
        <div key={g.key} className="pointer-events-none absolute left-0 flex items-center" style={{ top: top(i), height: PITCH, width: labelW }}>
          <span className={`truncate text-[13px] leading-4 ${s.picked === i ? "font-medium text-ink" : "text-[#3A3A38]"}`}>{g.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Month labels: the year on the first one and on each January ("Sep 2026", "Oct", …, "Jan 2027"). */
function axisLabel(g: Group, i: number) {
  const m = /^(\d{4})-(\d{2})$/.exec(g.key);
  if (!m) return g.label;
  return i === 0 || m[2] === "01" ? g.label : g.label.slice(0, 3);
}

function Line(s: Shared) {
  const L = lineLayout(s.groups, s.width, s.money, s.count);
  const n = s.groups.length;
  // Labels at least 44px apart.
  const every = Math.max(1, Math.ceil(44 / Math.max(1, L.spacing)));
  const nearest = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = e.clientX - r.left + L.gutter;
    return Math.min(n - 1, Math.max(0, n === 1 ? 0 : Math.round((at - L.left) / L.spacing)));
  };
  const path = s.groups.map((g, i) => `${i ? "L" : "M"}${L.px(i)},${L.py(g.value)}`).join("");
  return (
    <svg width={s.width} height={L.height} className="block overflow-visible">
      {L.ticks.map((t, k) => (
        <g key={t}>
          <line x1={L.gutter} x2={s.width} y1={L.py(t)} y2={L.py(t)} stroke={CHART.grid} strokeWidth={1} shapeRendering="crispEdges" />
          <text x={L.gutter - 8} y={L.py(t)} textAnchor="end" dominantBaseline="central" fontSize={12} fill={CHART.tick} style={{ fontVariantNumeric: "tabular-nums" }}>
            {L.tickText[k]}
          </text>
        </g>
      ))}
      {s.hover !== null && s.hover !== s.picked && <line x1={L.px(s.hover)} x2={L.px(s.hover)} y1={TOP} y2={TOP + PLOT} stroke={CHART.baseline} strokeWidth={1} shapeRendering="crispEdges" />}
      {s.picked >= 0 && <line x1={L.px(s.picked)} x2={L.px(s.picked)} y1={TOP} y2={TOP + PLOT} stroke={CHART.ink} strokeWidth={1} shapeRendering="crispEdges" />}
      <path d={path} fill="none" stroke={CHART.ink} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {s.groups.map((g, i) => {
        const big = s.hover === i || s.picked === i;
        const drawn = n <= 24 || i === n - 1 || big;
        return (
          <g key={g.key} id={s.optionId(i)} role="option" aria-selected={s.picked === i} aria-label={s.said(g)}>
            <circle cx={L.px(i)} cy={L.py(g.value)} r={big ? 5 : 4} fill={drawn ? CHART.ink : "transparent"} stroke={drawn ? CHART.ring : "none"} strokeWidth={2} />
          </g>
        );
      })}
      {s.groups.map((g, i) => {
        if (i % every !== 0) return null;
        const text = axisLabel(g, i);
        const w = text.length * 6.6;
        const x = L.px(i);
        // Kept inside the plot: never under the value labels on the left, never past the right edge.
        const anchor = x + w / 2 > s.width ? "end" : x - w / 2 < L.gutter ? "start" : "middle";
        return (
          <text key={g.key} x={anchor === "end" ? s.width : anchor === "start" ? L.gutter : x} y={TOP + PLOT + 18} textAnchor={anchor} fontSize={12} fill={CHART.label}>
            {text}
          </text>
        );
      })}
      {/* The whole plot is the target: the nearest month answers, wherever the pointer is. */}
      <rect
        x={L.gutter}
        y={0}
        width={Math.max(0, s.width - L.gutter)}
        height={TOP + PLOT + 8}
        fill="transparent"
        className="cursor-pointer"
        onPointerMove={(e) => s.onHover(nearest(e))}
        onPointerLeave={() => s.onHover(null)}
        onClick={(e) => s.onPick(nearest(e))}
      />
    </svg>
  );
}

/** The readout by a mark: the full value, then what it is and how many rows. Text only, never markup. */
function Readout({ g, count, money, style }: { g: Group; count: boolean; money: string | null; style: React.CSSProperties }) {
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-[10px] bg-white px-2.5 py-1.5 shadow-[0_0_0_1px_#E6E6E3,0_8px_24px_-12px_#00000040]"
      style={style}
    >
      <div className="text-[13px] font-semibold leading-[18px] text-ink tabular-nums">{count ? rowsWord(g.count) : formatNumber(g.value, { money })}</div>
      <div className="text-[12px] leading-4 text-[#6B6B6B]">{count ? g.label : `${g.label} · ${rowsWord(g.count)}`}</div>
    </div>
  );
}

/** About how wide a readout is, to keep it inside the chart. */
const READOUT_W = 170;

/**
 * One chart. `count`: the groups' values are row counts (else sums, in `money` when the column is).
 * `wide`: full width, with more room for names. `selected` is the picked group's key; picking it again
 * (or Esc) lets it go.
 */
export function CrmChart({
  groups,
  kind,
  title,
  money,
  count,
  wide,
  selected,
  onSelect,
}: {
  groups: Group[];
  kind: "bar" | "line";
  title: string;
  money: string | null;
  count: boolean;
  wide: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // The hovered mark and the one the keyboard is on, by their group's key: grouped another way, they're gone.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Whether the chart has keyboard focus (the readout shows for it too).
  const [keyboard, setKeyboard] = useState(false);
  const id = useId();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = groups.length;
  const at = (key: string | null) => {
    const i = key === null ? -1 : groups.findIndex((g) => g.key === key);
    return i >= 0 ? i : null;
  };
  const hover = at(hoverKey);
  const active = at(activeKey);
  const picked = at(selected) ?? -1;
  const optionId = (i: number) => `${id}-mark-${i}`;
  const pick = (i: number) => onSelect(groups[i]?.key === selected ? null : (groups[i]?.key ?? null));
  const said = (g: Group) => `${g.label}: ${count ? rowsWord(g.count) : `${formatNumber(g.value, { money })}, ${rowsWord(g.count)}`}`;
  const shown = hover ?? (keyboard ? active : null);
  const goTo = (i: number) => setActiveKey(groups[Math.min(n - 1, Math.max(0, i))]?.key ?? null);

  const keys = (e: React.KeyboardEvent) => {
    const steps: Record<string, number> = kind === "bar" ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
    const step = steps[e.key];
    if (step && n) {
      e.preventDefault();
      setKeyboard(true);
      goTo(active === null ? (step > 0 ? 0 : n - 1) : active + step);
    } else if ((e.key === "Home" || e.key === "End") && n) {
      e.preventDefault();
      setKeyboard(true);
      goTo(e.key === "Home" ? 0 : n - 1);
    } else if ((e.key === "Enter" || e.key === " ") && active !== null) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape" && selected !== null) {
      // Only when there's a pick to let go: otherwise Esc goes on and leaves the tab, as anywhere.
      e.stopPropagation();
      onSelect(null);
    }
  };

  const shared: Shared = { groups, width, money, count, picked, hover, optionId, said, onHover: (i) => setHoverKey(i === null ? null : (groups[i]?.key ?? null)), onPick: pick };
  let style: React.CSSProperties | null = null;
  if (shown !== null && width) {
    const g = groups[shown];
    if (kind === "bar") {
      // Beside the bar's value when there's room; else over the end of its own bar. Either way on its own
      // row, so it never covers another bar or its value.
      const b = barLayout(groups, width, wide);
      const end = Math.max(b.x(g.value), b.base);
      const mid = b.top(shown) + PITCH / 2;
      style = end + 58 + READOUT_W <= width ? { left: end + 58, top: mid, transform: "translateY(-50%)" } : { left: Math.max(READOUT_W, end - 8), top: mid, transform: "translate(-100%, -50%)" };
    } else {
      const l = lineLayout(groups, width, money, count);
      const x = l.px(shown);
      const y = l.py(g.value);
      const dx = x < READOUT_W / 2 ? "0" : x > width - READOUT_W / 2 ? "-100%" : "-50%";
      style = y < 64 ? { left: x, top: y + 14, transform: `translateX(${dx})` } : { left: x, top: y - 14, transform: `translate(${dx}, -100%)` };
    }
  }

  return (
    <div ref={box} className="relative w-full" onPointerLeave={() => setHoverKey(null)}>
      <div
        role="listbox"
        tabIndex={0}
        aria-label={title}
        aria-activedescendant={keyboard && active !== null ? optionId(active) : undefined}
        onKeyDown={keys}
        onFocus={(e) => {
          if (!e.currentTarget.matches(":focus-visible")) return;
          setKeyboard(true);
          if (active === null) goTo(picked >= 0 ? picked : 0);
        }}
        onBlur={() => setKeyboard(false)}
        className="rounded-[10px] outline-none focus-visible:[outline:1.5px_solid_#0A0A0A] focus-visible:[outline-offset:4px]"
      >
        {width > 0 && n > 0 && (kind === "bar" ? <Bars {...shared} wide={wide} /> : <Line {...shared} />)}
      </div>
      {style && shown !== null && <Readout g={groups[shown]} count={count} money={money} style={style} />}
    </div>
  );
}
