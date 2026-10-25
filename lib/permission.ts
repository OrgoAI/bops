import type { AppApproval, Bot, PermissionRule } from "@/lib/types";

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
