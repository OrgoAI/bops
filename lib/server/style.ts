import "server-only";
import { ownerName } from "./store";

/**
 * How every bot writes and speaks (WRITING, SPEAKING), what it knows about Bops (ABOUT_BOPS), how it
 * asks (ASKING) and how its answer is tidied (tidyAnswer). The text lives in cloud/style.ts, which Bops
 * Cloud imports too: it answers the main bot's chat from the iPhone, so a bot says the same things on
 * the Mac and in the cloud.
 */
export { ABOUT_BOPS, ASKING, SPEAKING, tidyAnswer, WRITING } from "@/cloud/style";

/** The computer briefing, wrapped so a bot reads it as background, not something to report. */
export const withBriefing = (input: string, brief: string) =>
  brief ? `${input}\n\n<computer_state note="Background for you only. Never quote, summarize or mention it to ${ownerName()}.">\n${brief}\n</computer_state>` : input;
