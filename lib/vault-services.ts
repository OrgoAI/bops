import type { AppAccount, VaultLogin } from "@/lib/types";

/*
 * The Vault's services (components/app/vault.tsx): what's one thing to the user, grouped. An app's
 * accounts, its MCP server ("GitHub MCP" is GitHub) and the site's saved login ("stripe.com" is Stripe)
 * are one row; Google's apps (Gmail, Calendar, Drive…) are one "Google".
 */

/** Apps that are one service to the user ("Google"), by their Composio slug. */
const FAMILY: Record<string, { key: string; name: string }> = {
  gmail: { key: "google", name: "Google" },
  googlecalendar: { key: "google", name: "Google" },
  googledrive: { key: "google", name: "Google" },
  googledocs: { key: "google", name: "Google" },
  googlesheets: { key: "google", name: "Google" },
  googleslides: { key: "google", name: "Google" },
  googlemeet: { key: "google", name: "Google" },
  googletasks: { key: "google", name: "Google" },
};
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const isMcp = (a: AppAccount) => /\bmcp$/i.test(a.appName.trim()) || /mcp$/i.test(a.app);
export const bareName = (a: AppAccount) => a.appName.replace(/\s*mcp$/i, "").trim() || a.appName;
/** A login's service: its site's name without the www and the domain ending ("stripe.com": "stripe"). */
export const siteKey = (site: string) => {
  const parts = site.replace(/^www\./, "").split(".");
  return norm(parts.length > 1 ? parts[parts.length - 2] : parts[0]);
};

/** One service in the Vault: the app accounts (and MCP servers) and logins that are the same thing to the user. */
export type Service = { key: string; name: string; accounts: AppAccount[]; logins: VaultLogin[] };

export function servicesOf(accounts: AppAccount[], logins: VaultLogin[]): Service[] {
  const m = new Map<string, Service>();
  const get = (key: string, name: string) => {
    const s = m.get(key) ?? { key, name, accounts: [], logins: [] };
    m.set(key, s);
    return s;
  };
  for (const a of accounts) {
    const f = FAMILY[a.app];
    get(f?.key ?? norm(bareName(a)), f?.name ?? bareName(a)).accounts.push(a);
  }
  for (const l of logins) get(siteKey(l.site), m.get(siteKey(l.site))?.name ?? l.site.replace(/^www\./, "")).logins.push(l);
  return [...m.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** When a bot last touched a service (or it was added, if never): for folding the ones not used lately. */
export const lastUsed = (s: Service) => Math.max(0, ...s.accounts.map((a) => a.usedAt ?? a.at), ...s.logins.map((l) => l.usedAt ?? l.addedAt));
export const signedOut = (s: Service) => s.accounts.filter((a) => a.status === "expired");
/** More services than this, and the ones no bot used for FOLD_AFTER_MS fold into one line. */
export const FOLD_OVER = 10;
export const FOLD_AFTER_MS = 14 * 24 * 60 * 60_000;

