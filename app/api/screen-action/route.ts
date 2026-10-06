import { fieldValues, fillField, pressButton } from "@/lib/server/local";
import { readScreen } from "@/lib/server/screen-watch";
import { screenEndpoint } from "@/lib/server/screens";
import { replyToSession } from "@/lib/server/sessions";
import { bot, getState, ownerName, patchSession, session, update } from "@/lib/server/store";
import { live } from "@/lib/types";

/**
 * The user acting on a card drawn over a bot's page. Everything happens on the real page: approving a
 * payment presses its pay button, sending an email fills the draft's fields with the user's edits and
 * presses Send. Then the thread that got there picks up, told what the user did.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    botId: string;
    display: number;
    action: "pay" | "decline" | "send" | "discard";
    values?: { to?: string; subject?: string; body?: string };
  };
  const b = bot(body.botId);
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  const key = `${b.id}:${body.display}`;
  const endpoint = screenEndpoint(b, body.display);
  const read = getState().screens?.[key];
  if (!endpoint || !read) return Response.json({ error: "nothing to act on on this screen" }, { status: 409 });
  const s = read.sessionId ? session(read.sessionId) : undefined;
  const owner = ownerName();
  const resume = (text: string, note: string) => {
    if (s) {
      patchSession(s.id, { blocker: undefined });
      if (!live(s)) replyToSession(s.id, text, note);
    }
  };

  try {
    if (body.action === "pay") {
      if (!read.payment?.confirm) return Response.json({ error: "couldn't find the pay button; take over to finish" }, { status: 409 });
      await pressButton(endpoint, read.payment.confirm.id);
      resume(`${owner} approved the payment${read.payment.amount ? ` of ${read.payment.amount}` : ""} and pressed "${read.payment.confirm.text}" themselves. Look at the screen and carry on.`, `You approved ${read.payment.amount ?? "the payment"}`);
    } else if (body.action === "decline") {
      resume(`${owner} declined this payment. Don't buy it. Leave the checkout, and tell them in one sentence what you'll do instead.`, "You declined the payment");
    } else if (body.action === "send") {
      const e = read.email;
      if (!e?.send) return Response.json({ error: "couldn't find the Send button; take over to send it" }, { status: 409 });
      for (const k of ["to", "subject", "body"] as const) if (e[k] && body.values?.[k] !== undefined) await fillField(endpoint, e[k]!.id, body.values[k]!);
      await pressButton(endpoint, e.send.id);
      resume(`${owner} reviewed your draft and sent the email themselves. Confirm it went out, then carry on.`, "You sent the email");
    } else if (body.action === "discard") {
      update((state) => void delete state.screens![key]);
      resume(`${owner} doesn't want to send that email. Leave the draft as it is and tell them in one sentence.`, "You held the email");
      return Response.json({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 2000));
    const next = await readScreen(b.id, body.display, endpoint, s?.goal ?? "", read.sessionId);
    return Response.json({ ok: true, read: next });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** The email draft as it stands on the page (what the bot wrote), for the card to show and edit. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const b = bot(url.searchParams.get("bot") ?? "");
  const display = Number(url.searchParams.get("display") ?? 100);
  const endpoint = b && screenEndpoint(b, display);
  const e = b && getState().screens?.[`${b.id}:${display}`]?.email;
  if (!endpoint || !e) return Response.json({ error: "no draft on this screen" }, { status: 404 });
  try {
    const v = await fieldValues(endpoint, [e.to?.id, e.subject?.id, e.body?.id].filter(Boolean) as string[]);
    return Response.json({ to: e.to ? v[e.to.id] : undefined, subject: e.subject ? v[e.subject.id] : undefined, body: e.body ? v[e.body.id] : undefined });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

