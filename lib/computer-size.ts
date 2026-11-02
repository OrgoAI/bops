/**
 * The size of the user's free Bops computer, billed by use: Medium or Large (lib/bops-billing.ts
 * COMPUTER_SIZES, each with Orgo's price in its plan read), picked once in Pick your computer
 * (components/app/computer-size.tsx) and switched in Settings, Your plan. The words for both, the phases
 * of a switch, and the word that a computer changed size, for the live views. Shared by the server and the
 * app (no server imports).
 *
 * Every price and hour count comes from Orgo's plan read: nothing here names one.
 */
import { BOPS_USAGE } from "@/cloud/protocol";
import { hoursFor, rateText, type ComputerSize, type ComputerSizeChange, type SizeOffer } from "@/lib/bops-billing";

/** What the local server answers about the size (GET /api/computer/size). */
export type SizeView = {
  /** Pick your computer is to be shown: billed by use, Orgo lists sizes, and it hasn't been answered on this account. */
  needed: boolean;
  /** The sizes on offer, in Orgo's order; empty when Orgo listed none (then there's nothing to pick). */
  sizes: SizeOffer[];
  /** The size the computer is now, or null when there's none yet. */
  current: ComputerSize | null;
  /** The size picked when the card opens: the computer's own, else the one picked before, else Orgo's default. */
  preselect: ComputerSize | null;
  /** How the size is switched now (lib/bops-billing.ts ComputerSizeChange); null while it's set up. */
  change: ComputerSizeChange;
  /** A switch under way, and how far it has got. */
  switching?: SizePhase;
};

/** How far a switch has got: waking the computer for it, switching, or restarting it so its memory fits the smaller size. */
export type SizePhase = "waking" | "switching" | "restarting";

/** What the app says while a switch is under way. */
export const PHASE_WORDS: Record<SizePhase, string> = {
  waking: "Waking your computer to switch…",
  switching: "Switching…",
  restarting: "Restarting your computer to switch…",
};

/** What a switch may do to the computer, said before one (Settings asks; Pick your computer says it under the choices). */
export const RESTART_WORDS = "Your computer may restart, and anything open on it may close.";

/** What Pick your computer says around its choices (`planLine` instead of `line` when the computer is part of the Orgo plan). */
export const PICK_WORDS = {
  title: "Pick your computer",
  line: "Your bots work on a computer in the cloud. You pay for it only while it works.",
  planLine: "Your bots work on a computer in the cloud. It is part of your Orgo plan.",
  ai: "AI is paid from the same credit.",
  later: "You can change this anytime in Settings.",
  notNow: "Not now",
  action: "Continue",
};

/** What each size is good for, in a line. A size without one says nothing more. */
const BLURB: Partial<Record<ComputerSize, string>> = {
  medium: "Good for most tasks.",
  large: "Faster, with smoother screen video.",
};

/** "2 cores, 8 GB": a size's cores and memory, as far as Orgo said them. */
export const specsText = (s: SizeOffer) => [s.cpu !== undefined ? `${s.cpu} ${s.cpu === 1 ? "core" : "cores"}` : "", s.ramGb !== undefined ? `${s.ramGb} GB` : ""].filter(Boolean).join(", ");

/**
 * One choice on the card: its name, cores and memory, price, how long $5 runs it, and what it's good for.
 * On the Orgo plan (`change` "plan"), what it costs is the plan's: no price and no hours, "Part of your
 * Orgo plan." instead.
 */
export function offerWords(s: SizeOffer, change?: ComputerSizeChange) {
  const start = BOPS_USAGE.startCents;
  const plan = change === "plan";
  return {
    name: s.name,
    specs: specsText(s),
    price: plan ? "" : `${rateText(s.hourlyCents)} an hour`,
    lasts: plan ? "Part of your Orgo plan." : `${rateText(start)} runs it for about ${hoursFor(s.hourlyCents, start)} hours.`,
    blurb: BLURB[s.key] ?? "",
  };
}

/**
 * The line under Your computer in Settings: "Medium: 2 cores, 8 GB, 80 GB. $0.055 an hour while it works."
 * On the Orgo plan (`change` "plan"), what it costs is the plan's: "Part of your Orgo plan." instead.
 */
export function settingsHint(s: SizeOffer, change: ComputerSizeChange | undefined) {
  const specs = [specsText(s), s.diskGb !== undefined ? `${s.diskGb} GB` : ""].filter(Boolean).join(", ");
  const head = specs ? `${s.name}: ${specs}.` : `${s.name}.`;
  return change === "plan" ? `${head} Part of your Orgo plan.` : `${head} ${rateText(s.hourlyCents)} an hour while it works.`;
}

/** Asking before a switch: its title, and what it costs (never on the Orgo plan, whose own price stands) and does. */
export function confirmWords(s: SizeOffer, change: ComputerSizeChange | undefined) {
  return { title: `Switch to ${s.name}?`, line: change === "plan" ? RESTART_WORDS : `${s.name} costs ${rateText(s.hourlyCents)} an hour while it works. ${RESTART_WORDS}`, action: "Switch" };
}

/** What the app says when a switch is done. */
export const doneWords = (s: SizeOffer) => `Your computer is ${s.name} now.`;

/** Why a switch didn't happen, in the app's words (the server answers with these; Orgo's own words where they're the plan's). */
export const SIZE_REFUSED = {
  failed: "Couldn't change your computer's size. Try again in a minute.",
  pending: "Your computer is still being set up. You can switch in a minute.",
  working: "Your bots are working on it. Switch when they finish.",
  wakeCredit: "Add Orgo credit to wake your computer, then switch.",
  keeps: "Your plan's computer keeps its size.",
  busy: "Your computer is already switching. Try again in a minute.",
  credit: (s: SizeOffer) => `Add Orgo credit to switch to ${s.name}. You need enough for an hour.`,
};

/**
 * The event a live view listens for (components/app/live-desktop.tsx): a computer changed size, so its
 * stream starts again the way the new size streams. It carries the computer's id (detail.computerId).
 */
const RESIZED = "bops:computer-resized";

/** Say a computer changed size, to the live views in this window (only that computer's stream afresh; with no id, all do). */
export const computerResized = (computerId?: string) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(RESIZED, { detail: { computerId } }));
};

/** Call `f` with the computer's id (when it was said) whenever a computer changes size; returns how to stop. */
export function onComputerResized(f: (computerId: string | undefined) => void) {
  if (typeof window === "undefined") return () => {};
  const on = (e: Event) => f((e as CustomEvent<{ computerId?: string } | null>).detail?.computerId);
  window.addEventListener(RESIZED, on);
  return () => window.removeEventListener(RESIZED, on);
}
