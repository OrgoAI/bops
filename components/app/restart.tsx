"use client";

import { useState, useSyncExternalStore } from "react";
import { AskInPlace } from "./ui";

/*
 * Restart Bops, for when something's off: in the account menu, in Settings, This Mac (the badge on your initials
 * opens it) and on the Screen Recording card. It asks first, in place, then the Mac app restarts
 * cleanly through its bridge (window.bopsMac.relaunch, desktop/main.cjs): the state is saved, the
 * cached sessions go, the server starts again, and the window opens again. You stay signed
 * in and nothing is lost. Only in the Mac app: a browser can't restart it.
 */

type Bridge = { relaunch?: () => Promise<void> };
const bridge = () => (window as unknown as { bopsMac?: Bridge }).bopsMac;

const noop = () => () => {};
/** Whether this page can restart Bops: it's in the Mac app (false while rendering on the server, so the page hydrates cleanly). */
export const useCanRestart = () => useSyncExternalStore(noop, () => !!bridge()?.relaunch, () => false);

/** The circular arrow on Restart Bops. */
export function RestartIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <path d="M13 8a5 5 0 11-1.6-3.7" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.9 1.9v2.8H9.1" fill="none" stroke="#0A0A0A" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * "Restart Bops?", asked in place of the button that asked (ui.tsx AskInPlace): Restart hands over to the Mac app,
 * which closes the window; Cancel (or Esc) puts the button back. `compact`: in a menu or a card's row.
 */
export function RestartAsk({ onCancel, compact = false }: { onCancel: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const restart = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await bridge()?.relaunch?.();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <AskInPlace
      compact={compact}
      title="Restart Bops?"
      line="Your bots pause for a few seconds."
      action="Restart"
      busy={busy}
      error={failed ? "Couldn't restart. Quit Bops and open it again." : null}
      onConfirm={() => void restart()}
      onCancel={onCancel}
    />
  );
}

/** Restart Bops as a button (`className`, `children`) that turns into its question where it is. */
export function RestartButton({ className, compact, children }: { className: string; compact?: boolean; children: React.ReactNode }) {
  const [asking, setAsking] = useState(false);
  if (asking) return <RestartAsk compact={compact} onCancel={() => setAsking(false)} />;
  return (
    <button type="button" onClick={() => setAsking(true)} className={className}>
      {children}
    </button>
  );
}
