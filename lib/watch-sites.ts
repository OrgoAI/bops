/**
 * Sites Bops knows how to watch: what to call them, what to watch for by default, and quick picks
 * for the watch setup card. Shared by the server (lib/server/watches.ts) and the app.
 */

type Site = { match: RegExp; name: string; lookFor: string; picks: string[] };

const SITES: Site[] = [
  { match: /(^|\.)(x|twitter)\.com$/, name: "X", lookFor: "new DMs, replies or mentions for me", picks: ["New DMs", "Replies to me", "Mentions", "New followers"] },
  { match: /(^|\.)linkedin\.com$/, name: "LinkedIn", lookFor: "new messages, replies or connection requests for me", picks: ["New messages", "Connection requests", "Comments on my posts"] },
  { match: /^mail\.google\.com$/, name: "Gmail", lookFor: "new emails from real people that need a reply", picks: ["Emails from real people", "Anything urgent", "Replies to my threads"] },
  { match: /(^|\.)slack\.com$/, name: "Slack", lookFor: "new DMs or mentions of me", picks: ["DMs", "Mentions of me", "Threads I'm in"] },
  { match: /(^|\.)discord\.com$/, name: "Discord", lookFor: "new DMs or mentions of me", picks: ["DMs", "Mentions of me"] },
  { match: /(^|\.)instagram\.com$/, name: "Instagram", lookFor: "new DMs or comments for me", picks: ["New DMs", "Comments", "Mentions"] },
  { match: /(^|\.)github\.com$/, name: "GitHub", lookFor: "new review requests, mentions or comments for me", picks: ["Review requests", "Mentions", "Failing checks"] },
];

const GENERIC = { lookFor: "anything new that needs a reply or a decision from me", picks: ["Anything new", "Big price moves", "New items in the list", "Status changes"] };

/** True when Bops has its own picks for this address; other pages get theirs read from the page. */
export function knownSite(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SITES.some((s) => s.match.test(host));
  } catch {
    return false;
  }
}

export function siteOf(url: string, title = ""): { site: string; lookFor: string; picks: string[] } {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* not a web page */
  }
  const known = SITES.find((s) => s.match.test(host));
  if (known) return { site: known.name, lookFor: known.lookFor, picks: known.picks };
  // A local or bare-address page reads better by its title ("Messages / Inbox" says Messages).
  const named = /^(localhost|[\d.]+)$/.test(host) ? title.split(/\s[/|·–-]\s/)[0] : host;
  return { site: named || title || "this page", ...GENERIC };
}
