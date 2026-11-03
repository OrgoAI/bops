import type { AppApproval, Bot, BotSettings, PermissionRule } from "@/lib/types";

/**
 * What a bot does without asking the user, as Claude Code's "don't ask again" decides it: a rule is for one bot and
 * one action ("Send an email", "Send Email in Gmail (work)", "Call Stripe", "Use a paid lookup"), whatever the
 * recipients or details of each call. The last rule the bot has for that action wins; none asks. Pure: the app and
 * the server read it alike.
 *
 * A bot's rules come from Always allow on its requests (Bot.permissions). A rule saved before this was for an action
 * and one resource; it reads as a rule for that action. "Just do it" (Bot.autoApprove) allows what no rule says,
 * except what it still asks about (`guarded`: what could move money, someone found through business data) and what
 * it never covers (`justDoIt` false: a key's call that changes something, a paid lookup).
 */

/** The effect of bot `b`'s own rules for `action`: its last rule for it, else none. */
export const ruleFor = (b: Pick<Bot, "permissions">, action: string): PermissionRule["effect"] | undefined => (b.permissions ?? []).findLast((r) => r.action === action)?.effect;

/** Whether bot `b` does `action` without asking: a rule of its allows it, else Just do it covers it. */
export function allows(b: Pick<Bot, "autoApprove" | "permissions">, action: string, opts: { justDoIt?: boolean; guarded?: boolean } = {}): boolean {
  const rule = ruleFor(b, action);
  if (rule) return rule === "allow";
  return !!b.autoApprove && opts.justDoIt !== false && !opts.guarded;
}

/**
 * The rule Always allow saves for `action`, none when the bot's rules allow it already. Its resource is "*", as a Bops
 * from before reads a rule (an action and a resource), so there too it covers that action for anyone.
 */
export function alwaysRule(action: string, had: readonly PermissionRule[] = []): PermissionRule | null {
  return had.findLast((r) => r.action === action)?.effect === "allow" ? null : { action, resource: "*", effect: "allow" };
}

/** An action as it reads after "<bot> wants to": its first word lowercased ("Send Email in Gmail" reads "send Email in Gmail"). */
export const toDo = (action: string) => action.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());

/**
 * A request's headline, on its card and in the sidebar: "<Bot> wants to: <reason>" in the bot's plain words when it gave
 * one (AppApproval.reason), else "<Bot> wants to <action>" ("Max wants to call GitHub").
 */
export const askHeadline = (botName: string, a: Pick<AppApproval, "action" | "reason">) => (a.reason ? `${botName} wants to: ${a.reason}` : `${botName} wants to ${toDo(a.action)}`);

/**
 * What a call with one of the user's keys does, in Bops' own words from its service and method, never the bot's (its
 * reason can be wrong, or planted by a page it read): "GitHub · adds or changes something", "Stripe · deletes something".
 * A query sent as a POST (GraphQL) and a GET that asks (Slack's) can do anything, and say so.
 */
export function apiFacts(api: Pick<NonNullable<AppApproval["api"]>, "label" | "method" | "path" | "change">) {
  // A change to files in one go: how many it changes and deletes, and on which branch ("GitHub · changes 2 files on site/orange").
  if (api.change) {
    const gone = api.change.files.filter((f) => f.op === "delete").length;
    const kept = api.change.files.length - gone;
    const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
    return `${api.label} · ${kept ? `changes ${files(kept)}${gone ? ` and deletes ${gone}` : ""}` : `deletes ${files(gone)}`} on ${api.change.branch}`;
  }
  const method = api.method.toUpperCase();
  const what = method === "DELETE" ? "deletes something" : method === "GET" || /\/graphql(\/|$)/i.test(api.path) ? "may add, change or delete something" : "adds or changes something";
  return `${api.label} · ${what}`;
}

/** Whether a call with a key deletes something (its facts line says so, in the colour for it). */
export const apiDeletes = (api: Pick<NonNullable<AppApproval["api"]>, "method" | "change">) => api.method.toUpperCase() === "DELETE" || !!api.change?.files.some((f) => f.op === "delete");

/** What else Always allow covers of a request's kind, besides this call. */
const ANY: Record<NonNullable<AppApproval["kind"]>, string> = {
  app: "whoever it's for and whatever it says",
  email: "whoever it's to and whatever it says",
  api: "whatever it sends",
  data: "whatever it looks up",
  brain: "whatever it runs",
};

/** What Always allow covers, as the card says it: "Always allow Max to send an email, whoever it's to and whatever it says." */
export const alwaysScope = (botName: string, a: Pick<AppApproval, "action" | "kind">) => `Always allow ${botName} to ${toDo(a.action)}, ${ANY[a.kind ?? "app"]}.`;

/** The action every email to anyone but the user asks for (lib/server/mail.ts withOk): new ones and replies. */
export const SEND_EMAIL = "Send an email";

/** How a bot answers mail to others, as its settings page shows it (Replies to others). */
export type MailRule = "never" | "ask" | "allow";

/**
 * Bot `b`'s Replies to others: Never when its settings say so (`s`, BotSettings.mailNever), else its last "Send an email"
 * rule, else what Just do it does with no rule (it sends without asking, except to someone found through business data).
 */
export function mailRule(b: Pick<Bot, "autoApprove" | "permissions">, s?: Pick<BotSettings, "mailNever">): MailRule {
  if (s?.mailNever) return "never";
  const rule = ruleFor(b, SEND_EMAIL);
  if (rule) return rule;
  return b.autoApprove ? "allow" : "ask";
}

/**
 * Bot rules with Replies to others set to `effect`: every "Send an email" rule goes, and one comes back in its place, so
 * the pick holds whatever Just do it says later. Never keeps an ask rule (BotSettings.mailNever says the rest), which a
 * Bops from before reads as it is. Every other action's rules stay, in order.
 */
export function withMailRule(rules: readonly PermissionRule[] | undefined, effect: MailRule): PermissionRule[] {
  const rest = (rules ?? []).filter((r) => r.action !== SEND_EMAIL);
  return [...rest, { action: SEND_EMAIL, resource: "*", effect: effect === "allow" ? "allow" : "ask" }];
}
