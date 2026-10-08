"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Spinner } from "./mascot";

/*
 * Restart Bops, for when something's off: in the account menu, on the setup screen (the badge on your
 * initials opens it) and on the Screen Recording card. It asks first, then the Mac app restarts
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

/** "Restart Bops?", over everything (a sheet too). Restart hands over to the Mac app, which closes the window. */
export function RestartConfirm({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // Escape closes this alone, not the sheet under it (the app closes its sheets on Escape, on window).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, onClose]);
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
  const pill = "rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-4 disabled:opacity-50";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={() => !busy && onClose()}>
      <div
        role="alertdialog"
        aria-labelledby="restart-title"
        aria-describedby="restart-line"
        onClick={(e) => e.stopPropagation()}
        className="flex w-[340px] flex-col rounded-[18px] bg-white p-5 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <span id="restart-title" className="text-[15px] font-semibold leading-5">
          Restart Bops?
        </span>
        <span id="restart-line" className="pt-1 text-[13px] leading-[18px] text-[#6B6B6B]">
          Your bots pause for a few seconds.
        </span>
        {failed && <span className="pt-2 text-[12.5px] leading-[18px] text-[#B42318]">Couldn&apos;t restart. Quit Bops and open it again.</span>}
        <div className="flex justify-end gap-2 pt-5">
          <button disabled={busy} onClick={onClose} className={`${pill} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
            Cancel
          </button>
          <button autoFocus disabled={busy} onClick={() => void restart()} className={`${pill} flex min-w-[76px] items-center justify-center bg-ink text-white`}>
            {busy ? <Spinner size={12} color="#FFFFFF" /> : "Restart"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
