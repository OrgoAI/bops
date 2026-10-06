"use client";

import { useEffect, type RefObject } from "react";

/**
 * Native bubbles are filled with one gradient fixed to the screen, so a bubble's color depends on
 * where it currently sits. This keeps every `[data-slot="message-bubble"]` and every
 * `[data-slot="typing-indicator"]` inside `container` in sync
 * by writing `--bubble-bottom` (the body's bottom edge relative to the screen frame) on scroll and
 * resize. It touches the DOM directly, so scrolling never re-renders React.
 *
 * `frame` is the element that represents the device screen (defaults to the container).
 */
export function useBubbleScreenSpace(container: RefObject<HTMLElement | null>, frame?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const screenElement = frame?.current ?? root;
      const screen = screenElement.getBoundingClientRect();
      const scaleY = screen.height / screenElement.clientHeight || 1;
      // The typing indicator is an incoming bubble too, so it needs the same screen-space fill.
      root.querySelectorAll<HTMLElement>('[data-slot="message-bubble"], [data-slot="typing-indicator"]').forEach(bubble => {
        // The typing indicator is its own body; a message bubble keeps its body in a child.
        const body = bubble.querySelector<HTMLElement>('[data-slot="bubble"], [data-slot="emoji"]') ?? (bubble.dataset.slot === "typing-indicator" ? bubble : null);
        if (!body) return;
        const bottom = (body.getBoundingClientRect().bottom - screen.top) / scaleY;
        bubble.style.setProperty("--bubble-bottom", `${bottom.toFixed(2)}px`);
      });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    root.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { cancelAnimationFrame(raf); root.removeEventListener("scroll", schedule); observer.disconnect(); mutations.disconnect(); };
  }, [container, frame]);
}
