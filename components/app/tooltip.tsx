"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Tooltips for the whole app, from one place. Anything with a `title` (or `data-tip`), and any
 * icon-only button with an `aria-label`, gets a small dark tooltip shortly after the pointer rests
 * on it (macOS's native ones take about a second and look out of place; the title is set aside
 * only while hovered, so it stays for screen readers). Once one has shown, the
 * next one shows at once, so moving along a row of icons reads them off quickly. Pressing, typing
 * or scrolling hides it.
 */
const DELAY_MS = 320;
const WARM_MS = 600;

type Tip = { text: string; x: number; y: number; below: boolean };

/** What an element's tooltip says, if it has one. */
function tipOf(el: HTMLElement) {
  if (el.dataset.tip) return el.dataset.tip;
  // An icon-only control is named by its aria-label; one with words on it says it already.
  const label = el.getAttribute("aria-label");
  if (label && !(el.textContent ?? "").trim()) return label;
  return null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    // The element whose title is set aside while it's hovered (put back after, for screen readers and tests).
    let borrowed: { el: HTMLElement; title: string } | null = null;
    let warmUntil = 0;
    const hide = () => {
      clearTimeout(timer);
      if (current) warmUntil = Date.now() + WARM_MS;
      if (borrowed?.el.isConnected && !borrowed.el.hasAttribute("title")) borrowed.el.setAttribute("title", borrowed.title);
      borrowed = null;
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.("[title],[data-tip],button[aria-label],[role=button][aria-label],a[aria-label]") as HTMLElement | null;
      if (el === current) return;
      hide();
      if (!el) return;
      // The native tooltip would show too, late: the title is set aside while the pointer is on it.
      const title = el.getAttribute("title");
      if (title) {
        borrowed = { el, title };
        el.removeAttribute("title");
      }
      const text = title || tipOf(el);
      if (!text) return;
      current = el;
      const show = () => {
        if (current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const below = r.top < 44;
        setTip({ text, x: Math.min(Math.max(r.left + r.width / 2, 12), window.innerWidth - 12), y: below ? r.bottom + 6 : r.top - 6, below });
      };
      if (Date.now() < warmUntil) show();
      else timer = setTimeout(show, DELAY_MS);
    };
    const out = (e: PointerEvent) => {
      if (current && !current.contains(e.relatedTarget as Node | null)) hide();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[1000] max-w-[280px] animate-[screen-in_120ms_ease-out] rounded-[8px] bg-[#0A0A0A]/92 px-2 py-1 text-center text-[12px] font-medium leading-4 text-white shadow-[0_6px_16px_-6px_#00000080]"
      style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? "0" : "-100%"})` }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
