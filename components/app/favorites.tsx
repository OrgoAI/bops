"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { favoritesOf, storedFavorites, toggledFavorite, type FavoriteKind } from "@/lib/favorites";
import type { AppState } from "@/lib/types";
import { currentWorkspace, post } from "./ui";

/*
 * What the sidebar's Favorites and Knowledge's chips share (lib/favorites.ts has the rules): a
 * workspace's pins with the change being saved shown at once, the pin mark, and the small menu a
 * right-click opens on a chip or a pinned row.
 */

/** The saves sent so far, one after another (the last one sent settles when all have). */
let saving: Promise<unknown> = Promise.resolve();

/**
 * The whole list saved for a workspace (PATCH /api/workspaces): it replaces the one there, defaults
 * included. Each save waits for the one before it (from the sidebar or Knowledge alike), so the server
 * gets them in the order they were made and the newest list is the one it keeps.
 */
export function saveFavorites(ws: string, list: string[]) {
  const next = saving.then(() => post("/api/workspaces", { id: ws, favorites: list }, "PATCH"));
  saving = next.catch(() => {});
  return next;
}

/**
 * A workspace's pins (`ws`, else the one shown; no state: none, and nothing to change): `stored` as
 * kept (a newer Bops's pins too, so a save never drops them), `shown` those this build knows. A change
 * shows at once, while it's saved, and the state's own takes over once it's in. `pinned` and `toggle`
 * for one kind, `save` for a whole new order. A workspace shared with the user is read only (`can`
 * false): its pins are its owner's, and none are saved.
 */
export function useFavorites(state: AppState | undefined, ws = state ? currentWorkspace(state) : "") {
  const [pending, setPending] = useState<{ ws: string; list: string[] } | null>(null);
  const kept = storedFavorites(state?.workspaces?.find((w) => w.id === ws));
  const stored = pending?.ws === ws ? pending.list : kept;
  const shown = favoritesOf({ favorites: stored });
  const can = !!state && !!ws && !state.shared;
  const save = (list: string[]) => {
    if (!can) return;
    setPending({ ws, list });
    void saveFavorites(ws, list)
      .catch(() => {})
      .finally(() => setPending((p) => (p?.list === list ? null : p)));
  };
  return {
    stored,
    shown,
    pinned: (id: FavoriteKind) => shown.includes(id),
    toggle: (id: FavoriteKind) => save(toggledFavorite(stored, id)),
    save,
    can,
  };
}

export type Favorites = ReturnType<typeof useFavorites>;

/** A pin: outlined, or filled while pinned. */
export function PinIcon({ on = false, size = 11 }: { on?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5.8 2.2h4.4l-.7 3.6 2.4 2.6H4.1l2.4-2.6z" />
      <path d="M8 8.4v5.4" fill="none" />
    </svg>
  );
}

export type MenuItem = { label: string; onPick: () => void; disabled?: boolean };

/**
 * A small menu where the right-click was (`x`, `y`; kept inside the window), as the bots' menu opens:
 * the first item has focus, arrows move between them, Enter picks, Esc or a click away closes it, and
 * focus goes back where it was. A right-click from the keyboard (the menu key) has no point: menuPoint
 * opens it at the row's own corner.
 */
export function SideMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    const away = () => close.current();
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
      if (back?.isConnected) back.focus();
    };
  }, []);
  const move = (by: number) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + by + all.length) % all.length]?.focus();
  };
  return (
    <>
      <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} onWheel={onClose} />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        style={{ left: at.left, top: at.top }}
        onKeyDown={(e) => {
          const go = { Escape: onClose, Tab: onClose, ArrowDown: () => move(1), ArrowUp: () => move(-1) }[e.key];
          if (!go) return;
          // Esc closes the menu and only the menu (the page under it stays open).
          e.preventDefault();
          e.stopPropagation();
          go();
        }}
        className="motion-menu-in fixed z-50 flex min-w-[188px] origin-top-left flex-col rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_#0000000F,0_18px_40px_-14px_#00000047]"
      >
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onPick();
            }}
            className="flex h-8 items-center rounded-lg px-2.5 text-left text-[13px] leading-4 text-ink outline-none hover:bg-[color:var(--c-f2f2f0)] focus-visible:bg-[color:var(--c-f2f2f0)] disabled:text-[color:var(--c-c9c9c6)] disabled:hover:bg-transparent"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** Where a menu opens for a right-click: at the pointer, or at the element's corner when it came from the keyboard (no pointer). */
export function menuPoint(e: React.MouseEvent) {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + 12, y: r.bottom - 4 };
}
