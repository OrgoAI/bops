"use client";

import { ErrorLine, RetryLabel } from "./code-entry";
import { unverified, type OwnerPhoneState, type PhoneCodeInfo } from "./owner-phone";

/**
 * The saved number the banner offers a code for: the first one that isn't verified, while no code is
 * out and numbers can be verified here. Undefined when the banner isn't showing.
 */
export function bannerNumber(info: PhoneCodeInfo, phone: OwnerPhoneState) {
  if (info.verify === false || phone.waiting) return undefined;
  return unverified(info.owners)[0];
}

/**
 * At the top of How your bots reach you, while a saved number isn't verified (one saved before codes
 * existed, say): until it is, texts and calls from it count as anyone else's. One action: text a code
 * to that number, with the OK to texts already on record; the code is typed in the mobile row below
 * (useOwnerPhone), and the banner goes while it's out. Its own answers show here: what went wrong,
 * and the wait after too many codes. Each number's row below has its own Remove (and Verify, for
 * any other number still to verify).
 */
export function ReachBanner({ info, phone }: { info: PhoneCodeInfo; phone: OwnerPhoneState }) {
  const first = bannerNumber(info, phone);
  if (!first) return null;
  const more = unverified(info.owners).length - 1;
  const wait = phone.retryFor("banner", first.number);
  return (
    <div className="flex flex-col gap-2 rounded-[12px] bg-[#FFF8EC] p-3 shadow-[0_0_0_1px_#F4E2C2]">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-4 text-[#7A4800]">
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7 3.8v3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="7" cy="10" r="0.85" fill="currentColor" />
        </svg>
        Verify your mobile
      </span>
      <span className="text-[12px] leading-[17px] text-[#6B4A12]">
        {more
          ? `Your bots don't know ${first.pretty} and ${more} more are you yet. Until they're verified, texts and calls from them are treated like anyone else's.`
          : `Your bots don't know ${first.pretty} is you yet. Until it's verified, texts and calls from it are treated like anyone else's, and your bots won't text it.`}
      </span>
      <span className="flex items-center gap-3">
        <button
          disabled={phone.busy || !!wait}
          onClick={() => void phone.send(first.number, false, first.pretty, "banner")}
          className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 tabular-nums text-white disabled:opacity-40"
        >
          {wait ? <RetryLabel key={wait.at} seconds={wait.seconds} onDone={() => phone.setRetry(null)} /> : more ? `Text a code to ${first.pretty}` : "Text me a code"}
        </button>
      </span>
      <ErrorLine text={phone.errorFor("banner")} />
    </div>
  );
}
