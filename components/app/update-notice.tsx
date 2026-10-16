"use client";

import { useEffect, useState } from "react";

/*
 * A newer Bops. The Mac app asks bops.bot for the newest release at launch and every hour and
 * downloads it itself (desktop/main.cjs, "New versions"): quietly with "Download updates
 * automatically" on (Settings → This Mac, UpdateSettings below), so the notice only turns up once it's
 * ready, with Restart to install it (quitting installs it too). With the switch off it says the version
 * is out, with Download, then that it's downloading, then ready. A download the user waited for that
 * didn't finish says so, with Try again. A copy of Bops that can't replace itself (opened from the DMG
 * or Downloads) sends the user to bops.bot, as before. What's new in it shows under the line when the
 * release says (docs/releases); put away, it stays away for that version. In a browser there's no Mac
 * app to ask, so it never shows.
 */

type UpdatePhase = "available" | "downloading" | "ready" | "manual";
type UpdateInfo = { version: string; notes?: string[]; phase?: UpdatePhase; asked?: boolean; failed?: boolean } | null;
type UpdateAuto = { auto: boolean; canSelfUpdate: boolean } | null;
type Update = {
  info(): Promise<UpdateInfo>;
  onChange(fn: (info: UpdateInfo) => void): () => void;
  dismiss(version: string): Promise<void>;
  download(): Promise<void>;
  install?(): Promise<void>;
  auto?(): Promise<UpdateAuto>;
  setAuto?(on: boolean): Promise<UpdateAuto>;
};
const bridge = () => (window as unknown as { bopsMac?: { update?: Update } }).bopsMac?.update;

const button = "shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white hover:bg-[#2A2A28]";

/** One calm line above the sidebar's bottom row while a newer release is out, and what's new in it under that. */
export function UpdateNotice() {
  // `late`: the card turned up while Bops was open (a check after launch), so it rises in; what launch
  // already knew just shows. Set as the card appears and kept while it stays, so a later check never replays it.
  const [{ info, late }, setShown] = useState<{ info: UpdateInfo; late: boolean }>({ info: null, late: false });
  useEffect(() => {
    const update = bridge();
    if (!update) return;
    let stop = false;
    void update
      .info()
      .then((i) => !stop && setShown((s) => ({ info: i, late: s.late })))
      .catch(() => {});
    const off = update.onChange((i) => setShown((s) => ({ info: i, late: s.info ? s.late : true })));
    return () => {
      stop = true;
      off();
    };
  }, []);
  return <UpdateCard info={info} late={late} onDismiss={() => setShown({ info: null, late: false })} />;
}

/** The notice itself, for where the update is at. Nothing while it downloads unasked (it shows once ready). */
export function UpdateCard({ info, late, onDismiss }: { info: UpdateInfo; late: boolean; onDismiss: () => void }) {
  if (!info) return null;
  // An app from before phases (or a copy that can't update itself) only sends the user to bops.bot.
  const phase = info.phase ?? "manual";
  if (phase === "downloading" && !info.asked) return null;
  // Without notes (an older latest.json, or a release before them) the notice is the one line alone.
  const notes = Array.isArray(info.notes) ? info.notes : [];
  return (
    <div className={`mx-1 mt-3 rounded-[12px] bg-white py-2 pl-3 pr-1.5 shadow-[0_0_0_1px_#E6E6E3] ${late ? "motion-rise-in" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] leading-[17px] text-[#6B6B6B]">
          {phase === "ready" ? (
            <span className="font-medium text-ink">Bops {info.version} is ready.</span>
          ) : phase === "downloading" ? (
            <span className="font-medium text-ink">Bops {info.version} is downloading.</span>
          ) : phase === "available" && info.failed ? (
            <span className="font-medium text-ink">The download didn&apos;t finish.</span>
          ) : phase === "available" ? (
            <span className="font-medium text-ink">Bops {info.version} is out.</span>
          ) : (
            <>
              <span className="font-medium text-ink">Bops {info.version} is out.</span> Get it at bops.bot
            </>
          )}
        </span>
        {phase === "ready" ? (
          <button onClick={() => void bridge()?.install?.()} className={button}>
            Restart
          </button>
        ) : phase === "downloading" ? null : (
          <button onClick={() => void bridge()?.download()} className={button}>
            {phase === "available" && info.failed ? "Try again" : "Download"}
          </button>
        )}
        <button
          onClick={() => {
            void bridge()?.dismiss(info.version);
            onDismiss();
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

/**
 * Settings → This Mac: whether new versions download by themselves (on unless turned off). Only in the
 * Mac app, and only for a copy that can update itself: one opened from the DMG or Downloads always
 * sends the user to bops.bot, so there's nothing to switch.
 */
export function UpdateSettings() {
  const [info, setInfo] = useState<UpdateAuto>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void bridge()
      ?.auto?.()
      .then(setInfo)
      .catch(() => {});
  }, []);
  if (!info?.canSelfUpdate) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      const next = await bridge()?.setAuto?.(!info.auto);
      if (next) setInfo(next);
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium">Download updates automatically</span>
        <span className="text-[12px] leading-4 text-[#6B6B6B]">New versions download in the background. Restart Bops to use one.</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={info.auto}
        aria-label="Download updates automatically"
        disabled={busy}
        onClick={() => void toggle()}
        className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-60 ${info.auto ? "bg-ink" : "bg-[#E6E6E3]"}`}
      >
        <span className={`absolute top-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_#00000033] transition-[left] ${info.auto ? "left-[19px]" : "left-[3px]"}`} />
      </button>
    </div>
  );
}
