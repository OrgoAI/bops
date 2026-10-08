"use client";

import { useEffect, useState } from "react";

/*
 * A newer Bops is out. The Mac app asks bops.bot for the newest release at launch and every hour
 * (desktop/main.cjs, "New versions"). Bops doesn't update itself, so this only says so, with what's new
 * in it when the release says (docs/releases), and sends the user to bops.bot for the download; put
 * away, it stays away for that version. In a browser there's no Mac app to ask, so it never shows.
 */

type UpdateInfo = { version: string; notes?: string[] } | null;
type Update = {
  info(): Promise<UpdateInfo>;
  onChange(fn: (info: UpdateInfo) => void): () => void;
  dismiss(version: string): Promise<void>;
  download(): Promise<void>;
};
const bridge = () => (window as unknown as { bopsMac?: { update?: Update } }).bopsMac?.update;

/** One calm line above the sidebar's bottom row while a newer release is out, and what's new in it under that. */
export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateInfo>(null);
  useEffect(() => {
    const update = bridge();
    if (!update) return;
    let stop = false;
    void update
      .info()
      .then((i) => !stop && setInfo(i))
      .catch(() => {});
    const off = update.onChange((i) => setInfo(i));
    return () => {
      stop = true;
      off();
    };
  }, []);
  if (!info) return null;
  // Without notes (an older latest.json, or a release before them) the notice is the one line alone.
  const notes = Array.isArray(info.notes) ? info.notes : [];
  return (
    <div className="mx-1 mt-3 rounded-[12px] bg-white py-2 pl-3 pr-1.5 shadow-[0_0_0_1px_#E6E6E3]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] leading-[17px] text-[#6B6B6B]">
          <span className="font-medium text-ink">Bops {info.version} is out.</span> Get it at bops.bot
        </span>
        <button onClick={() => void bridge()?.download()} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white hover:bg-[#2A2A28]">
          Download
        </button>
        <button
          onClick={() => {
            void bridge()?.dismiss(info.version);
            setInfo(null);
          }}
          aria-label="Hide until the next version"
          title="Hide until the next version"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-[#9A9A98] hover:bg-black/[0.06] hover:text-ink"
        >
          <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {notes.length > 0 && (
        <div className="mt-1.5 pb-0.5 pr-1.5">
          <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">What&apos;s new</span>
          <ul aria-label={`What's new in Bops ${info.version}`} className="mt-0.5 flex flex-col gap-0.5">
            {notes.map((note, i) => (
              <li key={i} className="flex gap-1.5 text-[12px] leading-4 text-[#6B6B6B]">
                <span aria-hidden="true" className="mt-[7px] size-[3px] shrink-0 rounded-full bg-[#9A9A98]" />
                <span className="min-w-0">{note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
