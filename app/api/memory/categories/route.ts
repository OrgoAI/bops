import { categoriesOn, deleteEverywhere, deletePreview, editItem, forgetItems, refresh, snapshot, sortOlder, tidyUp, wsOrCurrent } from "@/lib/server/memory-categories";
import { learn } from "@/lib/server/memory";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/*
 * The categories that fill themselves from memory (lib/server/memory-categories.ts), for the sidebar
 * and their page. Only the Bops window may call these (proxy.ts). `ws` is the workspace, the current
 * one when not given.
 */

/** A workspace's categories as sorted so far ({on: false} where there are none: memory off, signed out, not open to this account). */
export async function GET(request: Request) {
  const u = new URL(request.url).searchParams;
  const ws = wsOrCurrent(u.get("ws"));
  const rev = Number(u.get("rev"));
  try {
    return Response.json(snapshot(ws, u.has("rev") && Number.isFinite(rev) ? rev : undefined));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

type Body = {
  action: "refresh" | "sort-older" | "tidy-up" | "edit" | "forget" | "deleteEverywhere" | "add";
  text?: string;
  ws?: string;
  id?: string;
  ids?: string[];
  preview?: boolean;
  sessions?: string[];
  title?: string;
  detail?: string;
  done?: boolean;
  hidden?: boolean;
};

/**
 * refresh: look at memory now (and sort what's new now). sort-older: sort 300 more of the older facts.
 * tidy-up: ask memory to tidy up (dreaming), at most once an hour.
 * edit {id, title?, detail?, done?, hidden?}.
 * forget {ids} (or {id}): gone from Orbit at once; memory deletes every fact and card line they were
 * learned from, for good (checked, and tried again until it's gone).
 * deleteEverywhere {id, preview?, sessions?}: with preview, answers {sessions: [{id, name, at, facts,
 * alsoFor}]}, the chats and calls in memory it would delete (alsoFor: the other items learned from each)
 * and `note`. Without, Forget and delete those sessions from memory (only the ids in `sessions`, when
 * given: what the user was shown), and answers the categories with `deleted` (their names).
 * add {text}: something the user tells Orbit ("Priya Shah is my accountant"), saved to memory as a fact
 * (as a bot's remember is) and sorted in a few seconds; with `note`, what memory said ("Saved.", "Already known: …").
 * Answers the categories as they are after it.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!categoriesOn()) return Response.json({ error: "Memory isn't set up." }, { status: 404 });
  const b = ((await request.json().catch(() => null)) ?? {}) as Body;
  const ws = wsOrCurrent(b.ws);
  // Items' ids are 10 hex characters (memory-categories.ts upsert).
  const itemId = (x: unknown) => typeof x === "string" && /^[0-9a-f]{10}$/.test(x);
  const ids = b.action === "forget" ? (Array.isArray(b.ids) ? b.ids : b.id !== undefined ? [b.id] : []) : [];
  if (b.action === "forget" && (!ids.length || ids.length > 500 || !ids.every(itemId))) return Response.json({ error: "That's gone already." }, { status: 400 });
  if ((b.action === "edit" || b.action === "deleteEverywhere") && !itemId(b.id)) return Response.json({ error: "That's gone already." }, { status: 400 });
  if (b.sessions !== undefined && (!Array.isArray(b.sessions) || !b.sessions.every((x) => typeof x === "string"))) return Response.json({ error: "Unknown sessions." }, { status: 400 });
  try {
    switch (b.action) {
      case "refresh":
        await refresh(ws);
        break;
      case "sort-older":
        await sortOlder(ws);
        break;
      case "tidy-up":
        await tidyUp(ws);
        break;
      case "edit":
        editItem(ws, b.id ?? "", { title: b.title, detail: b.detail, done: b.done, hidden: b.hidden });
        break;
      case "forget":
        forgetItems(ws, ids as string[]);
        break;
      case "deleteEverywhere": {
        if (b.preview === true) return Response.json({ sessions: await deletePreview(ws, b.id ?? ""), note: "These chats stay in your Bops chat history; their memory copy is deleted." });
        const gone = await deleteEverywhere(ws, b.id ?? "", b.sessions);
        return Response.json({ ...snapshot(ws), deleted: gone.map((x) => x.name) });
      }
      case "add": {
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (!text) return Response.json({ error: "Write something to add." }, { status: 400 });
        const said = await learn(ws, text.slice(0, 500));
        // Not saved (kept from someone, memory off, another account): said as the error.
        if (!said.startsWith("Saved") && !said.startsWith("Already known")) return Response.json({ error: said }, { status: 400 });
        return Response.json({ ...snapshot(ws), note: said.startsWith("Already known") ? "That's known already." : "Saved. It shows up here in a few seconds." });
      }
      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
    return Response.json(snapshot(ws));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
