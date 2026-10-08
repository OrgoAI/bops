/**
 * Whether a task is about the site a screen has open, so a new task goes to the screen already on
 * its site instead of opening the same site on a second one (lib/server/sessions.ts pump).
 */

/** Pages that aren't anyone's site: the home screen, a local page, a search engine. */
const NOT_A_SITE = /^(localhost|[\d.]+|google\.[a-z.]+|bing\.com|duckduckgo\.com|(search\.)?yahoo\.com)$/;

/** What people call a site when its address doesn't say it. */
const ALSO_CALLED: [RegExp, string[]][] = [
  [/^(x|twitter)\.com$/, ["twitter", "tweet", "tweets", "x.com"]],
  [/^mail\.google\.com$/, ["gmail"]],
  [/^calendar\.google\.com$/, ["google calendar", "gcal"]],
  [/^docs\.google\.com$/, ["google doc", "google docs", "google sheet", "google sheets", "google slides"]],
  [/^drive\.google\.com$/, ["google drive"]],
];

/** Names too common to mean the site on their own ("google it"); their sites match by address or by what they're also called. */
const TOO_COMMON = new Set(["google"]);

function hostOf(url: string) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** A site's address without its subdomains and the name in it: openrouter.ai for platform.openrouter.ai, bbc.co.uk for www.bbc.co.uk. */
function domainOf(host: string) {
  const labels = host.split(".");
  if (labels.length < 2) return undefined;
  // A two-part ending like co.uk or com.au: the name comes before it.
  const at = labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2 ? labels.length - 3 : labels.length - 2;
  return { domain: labels.slice(at).join("."), name: labels[at] };
}

/** Whether `words` has `phrase` in it as whole words, also written together ("open router" for openrouter). */
function hasWords(words: string[], phrase: string) {
  const want = phrase.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (want.every((w, k) => words[i + k] === w)) return true;
    // Written apart: up to three words that run together into a one-word name.
    if (want.length === 1) for (let j = i + 1; j < Math.min(words.length, i + 3); j++) if (words.slice(i, j + 1).join("") === phrase) return true;
  }
  return false;
}

/**
 * Whether the task names the site `url` is on: by its address ("openrouter.ai/keys"), its name ("check
 * my OpenRouter credits"), or what it's also called ("reply on Twitter" for x.com). Home screens, blank
 * pages and search engines are no one's site.
 */
export function namesSite(task: string, url: string) {
  const host = hostOf(url);
  if (!host || NOT_A_SITE.test(host)) return false;
  const site = domainOf(host);
  if (!site) return false;
  const text = task.toLowerCase();
  if (text.includes(host) || text.includes(site.domain)) return true;
  const words = text.split(/[^a-z0-9.]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const plain = text.split(/[^a-z0-9]+/).filter(Boolean);
  if (ALSO_CALLED.some(([match, names]) => match.test(host) && names.some((n) => (n.includes(".") ? words.includes(n) : hasWords(plain, n))))) return true;
  return site.name.length >= 4 && !TOO_COMMON.has(site.name) && hasWords(plain, site.name);
}

/** Whether a page is somebody's site (not a home screen, a blank page or a search engine). */
export const onASite = (url: string) => {
  const host = hostOf(url);
  return !!host && !NOT_A_SITE.test(host);
};
