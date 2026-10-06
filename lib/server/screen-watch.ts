import "server-only";
import { live, type Blocker, type FormField, type PageKind, type ScreenRead } from "@/lib/types";
import { chose, decide, yes, type Question } from "./decide";
import { pageText, type PageButton, type PageField } from "./local";
import { mirror } from "./mirror";
import { getState, ownerName, patchSession, session, update } from "./store";

/**
 * Reads a bot's screen with Jev. Each time the page changes (seen through the mirror), Jev reads
 * the page text and answers at once: is something here only the user can get past, does the bot need
 * to get past it for its task, and does the page show private data. On a sign-in or verification
 * page a second call matches the page's fields (which one takes the email, the password, the code)
 * so Bops can draw a native card that fills them. Runs wherever the mirror can reach: the Mac, or
 * Orgo over the tailnet.
 */

const QUESTIONS: Record<"blocker" | "stops_task" | "sensitive" | "kind", Question> = {
  kind: {
    type: "choice",
    instructions: "What kind of page is `page`?",
    criteria: {
      email_compose: "Writing an email or message: a compose window with To, Subject and a body",
      article: "An article, post, documentation or other long text to read",
      checkout: "A cart, checkout or payment page",
      results: "Search results or a list of items to pick from",
      other: "Anything else: a home page, a dashboard, a form, an app",
    },
  },
  blocker: {
    type: "choice",
    instructions: "A bot is working in the browser tab shown in `page` for the user. What is the page showing right now?",
    criteria: {
      normal: "An ordinary page the bot can read or keep working on by itself",
      sign_in: "A login or sign-in form asking for an account, email, username or password",
      two_factor: "A prompt for a verification code, a one-time code, or approval on another device",
      captcha: "A captcha, an 'are you human' check, or a bot check",
      payment: "A checkout or payment step asking to confirm a purchase or enter card details",
      error: "An error page: access denied, blocked, not found, or the page failed to load",
    },
  },
  stops_task: {
    type: "noul",
    instructions:
      "To finish `task`, does the bot have to get past this page by signing in, entering a code, passing a human check, or confirming a payment, which only the user can do?",
    criteria: {
      true: "The bot can't finish `task` until the user gets it past this page",
      false: "The bot can finish `task` without getting past this page, for example it only needs to read or describe it",
    },
  },
  sensitive: {
    type: "noul",
    instructions:
      "Does `page` show private information that someone looking over the user's shoulder shouldn't see: passwords, bank or card numbers, account balances, private messages or emails, or personal ID numbers?",
  },
};
/** Below this, Jev isn't sure enough to interrupt the user. */
const SURE = 0.75;

const describe = (f: PageField) =>
  [f.label, f.placeholder, f.name && `name "${f.name}"`, f.autocomplete && `autocomplete "${f.autocomplete}"`, `type ${f.type}`].filter(Boolean).join(" · ");

/** Which of the page's fields take the account, the password and the code. */
async function matchForm(page: Page): Promise<ScreenRead["form"]> {
  if (!page.fields.length) return undefined;
  const options = Object.fromEntries([...page.fields.map((f) => [f.id, describe(f)]), ["none", "None of these fields"]]);
  const owner = ownerName();
  const ask = (what: string): Question => ({ type: "choice", instructions: `Which field on this ${page.title || "page"} is where ${owner} types ${what}?`, criteria: options });
  const a = await decide(
    { url: page.url, title: page.title, fields: Object.fromEntries(page.fields.map((f) => [f.id, describe(f)])) },
    {
      identifier: ask("their account email, phone number or username"),
      password: ask("their password"),
      code: ask("a verification code or one-time code sent to them"),
    },
  );
  if (!a) return undefined;
  const pick = (k: "identifier" | "password" | "code"): FormField | undefined => {
    const c = chose(a[k]);
    const f = c && c.choice !== "none" && c.confidence >= 0.5 ? page.fields.find((x) => x.id === c.choice) : undefined;
    const fallback = k === "identifier" ? "Email or phone" : k === "password" ? "Password" : "Code";
    return f ? { id: f.id, label: f.label || f.placeholder || fallback, secret: k !== "identifier" } : undefined;
  };
  const form = { identifier: pick("identifier"), password: pick("password"), code: pick("code") };
  return form.identifier || form.password || form.code ? form : undefined;
}

type Page = { url: string; title: string; text: string; fields: PageField[]; buttons: PageButton[] };

/** The checkout's total (picked from the amounts on the page) and the button that pays. */
async function matchPayment(page: Page): Promise<ScreenRead["payment"]> {
  const amounts = [...new Set(page.text.match(/(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP))/g) ?? [])].slice(0, 30);
  const buttons = page.buttons.slice(0, 40);
  const owner = ownerName();
  const a = await decide(
    { url: page.url, title: page.title, text: page.text.slice(0, 2500) },
    {
      ...(amounts.length
        ? { total: { type: "choice" as const, instructions: `Which amount is the total ${owner} will be charged if they pay now?`, criteria: Object.fromEntries([...amounts.map((x, i) => [`a${i}`, x]), ["none", "None of these"]]) } }
        : {}),
      ...(buttons.length
        ? { pay: { type: "choice" as const, instructions: `Which button completes the purchase and charges ${owner}?`, criteria: Object.fromEntries([...buttons.map((b) => [b.id, b.text]), ["none", "None of these buttons pays"]]) } }
        : {}),
    },
  );
  const total = chose(a?.total);
  const pay = chose(a?.pay);
  const btn = pay && pay.choice !== "none" && pay.confidence >= 0.5 ? buttons.find((b) => b.id === pay.choice) : undefined;
  return {
    amount: total && total.choice !== "none" && total.confidence >= 0.4 ? amounts[Number(total.choice.slice(1))] : undefined,
    merchant: new URL(page.url).hostname.replace(/^www\./, ""),
    confirm: btn ? { id: btn.id, text: btn.text } : undefined,
  };
}

/** An email draft's To, Subject and body fields, and its Send button. */
async function matchEmail(page: Page): Promise<ScreenRead["email"]> {
  if (!page.fields.length) return undefined;
  const options = Object.fromEntries([...page.fields.map((f) => [f.id, describe(f)]), ["none", "None of these fields"]]);
  const ask = (what: string): Question => ({ type: "choice", instructions: `Which field of this email is ${what}?`, criteria: options });
  const a = await decide(
    { url: page.url, title: page.title, fields: Object.fromEntries(page.fields.map((f) => [f.id, describe(f)])) },
    {
      to: ask("the recipients (To)"),
      subject: ask("the subject line"),
      body: ask("the message body"),
      ...(page.buttons.length
        ? { send: { type: "choice" as const, instructions: "Which button sends this email?", criteria: Object.fromEntries([...page.buttons.map((b) => [b.id, b.text]), ["none", "None of these sends it"]]) } }
        : {}),
    },
  );
  if (!a) return undefined;
  const field = (k: "to" | "subject" | "body", fallback: string): FormField | undefined => {
    const c = chose(a[k]);
    const f = c && c.choice !== "none" && c.confidence >= 0.5 ? page.fields.find((x) => x.id === c.choice) : undefined;
    return f ? { id: f.id, label: f.label || f.placeholder || fallback, secret: false } : undefined;
  };
  const send = chose(a.send);
  const btn = send && send.choice !== "none" && send.confidence >= 0.5 ? page.buttons.find((b) => b.id === send.choice) : undefined;
  const email = { to: field("to", "To"), subject: field("subject", "Subject"), body: field("body", "Message"), send: btn ? { id: btn.id, text: btn.text } : undefined };
  return email.body || email.to ? email : undefined;
}

/** Read one screen now and record what's on it. Returns null if the page couldn't be read. */
export async function readScreen(botId: string, display: number, endpoint: string, task: string, sessionId?: string): Promise<ScreenRead | null> {
  const page = await pageText(endpoint).catch(() => null);
  if (!page?.url || page.url === "about:blank") return null;
  const a = await decide({ task, page: { url: page.url, title: page.title, text: page.text, fields: page.fields } }, QUESTIONS);
  if (!a) return null;
  const pick = chose(a.blocker);
  // Only a page that stands between the bot and its task needs the user; one it just has to read doesn't.
  const blocker =
    pick && pick.choice !== "normal" && pick.confidence >= SURE && (yes(a.stops_task) ?? 1) >= 0.5 ? (pick.choice as Blocker) : undefined;
  const k = chose(a.kind);
  const kind = (k && k.confidence >= 0.5 ? k.choice : "other") as PageKind;
  // Each card needs its own read of the page; only ask for the one this page calls for.
  const form = blocker === "sign_in" || blocker === "two_factor" ? await matchForm(page) : undefined;
  const payment = blocker === "payment" ? await matchPayment(page) : undefined;
  const email = kind === "email_compose" ? await matchEmail(page) : undefined;
  const read: ScreenRead = { url: page.url, title: page.title, blocker, sensitive: (yes(a.sensitive) ?? 0) >= 0.5, at: Date.now(), kind, form, payment, email, sessionId };
  update((state) => {
    state.screens ??= {};
    state.screens[`${botId}:${display}`] = read;
  });
  return read;
}

export function watchScreen(botId: string, display: number, endpoint: string, sessionId: string) {
  const key = `${botId}:${display}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  let lastAt = 0;
  let stopped = false;
  // Whatever page was left open from earlier work isn't this thread's problem; wait until the bot moves.
  // (The same address with a different title, like a sign-in page reloaded over its dashboard, counts as moving.)
  const leftOver = pageText(endpoint).then((p) => `${p.url}|${p.title}`, () => "");
  let moved = false;

  const check = async () => {
    timer = undefined;
    if (stopped) return;
    lastAt = Date.now();
    const page = await pageText(endpoint).catch(() => null);
    if (!page?.url) return;
    // Once the bot has acted on the screen (typed, clicked, pressed a key), whatever's there is its business.
    const acted = session(sessionId)?.steps.some((st) => !["setup", "note", "helper"].includes(st.tool));
    if (!moved && !acted && `${page.url}|${page.title}` === (await leftOver)) return;
    moved = true;
    const fingerprint = `${page.url}|${page.title}|${page.text.length}|${page.fields.length}`;
    if (fingerprint === last) return;
    last = fingerprint;
    const read = await readScreen(botId, display, endpoint, session(sessionId)?.goal ?? "", sessionId);
    if (!read || stopped) return;
    // A sign-in the vault can handle by itself never needs the user.
    if (read.blocker && read.form) {
      const { autoSignIn } = await import("./vault");
      if (await autoSignIn(botId, display, read).catch(() => false)) return;
    }
    // The thread's chip shows it ("needs you to sign in"), and its computer draws the card; no extra chat line.
    const s = session(sessionId);
    if (s && live(s) && !s.dismissed && s.blocker !== read.blocker) patchSession(sessionId, { blocker: read.blocker });
  };

  // New pages get a quick look; changes within a page at most every few seconds.
  const unsubscribe = mirror(endpoint).subscribe((json) => {
    if (json.startsWith('{"type":"bops-tabs"')) return;
    if (timer) return;
    const newPage = json.startsWith('{"type":4') || json.startsWith('{"type":2');
    const wait = newPage ? 1200 : Math.max(1200, 4000 - (Date.now() - lastAt));
    timer = setTimeout(() => void check(), wait);
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    const s = session(sessionId);
    const reset = s?.status === "failed" && /reset/i.test(s.error ?? "");
    // A blocker or a draft the bot ended on stays (with its screen read, for the card), so the
    // thread keeps showing it needs the user and the card stays up; so does an article, for Read along.
    const kept = getState().screens?.[key];
    if (!reset && (s?.blocker || kept?.email || kept?.kind === "article")) return;
    if (s?.blocker) patchSession(sessionId, { blocker: undefined });
    if (getState().screens?.[key]) update((state) => void delete state.screens![key]);
  };
}
