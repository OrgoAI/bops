import { categoriesOn, editItem, forgetItem, refresh, snapshot, sortOlder, tidyUp, wsOrCurrent } from "@/lib/server/memory-categories";
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
  action: "refresh" | "sort-older" | "tidy-up" | "edit" | "forget" | "add";
  text?: string;
  ws?: string;
  id?: string;
  title?: string;
  detail?: string;
  done?: boolean;
  hidden?: boolean;
};

/**
 * refresh: look at memory now (and sort what's new now). sort-older: sort 300 more of the older facts.
 * tidy-up: ask memory to tidy up (dreaming), at most once an hour.
 * edit {id, title?, detail?, done?, hidden?}. forget {id}: memory forgets what it learned only about it.
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
  if ((b.action === "edit" || b.action === "forget") && !/^[0-9a-f]{10}$/.test(b.id ?? "")) return Response.json({ error: "That's gone already." }, { status: 400 });
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
        await forgetItem(ws, b.id ?? "");
        break;
      case "add": {
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (!text) return Response.json({ error: "Write something to add." }, { status: 400 });
        const said = await learn(ws, text.slice(0, 500));
        // Not saved (kept from someone, memory off, another account): said as the error.
        if (!said.startsWith("Saved") && !said.startsWith("Already known")) return Response.json({ error: said }, { status: 400 });
        return Response.json({ ...snapshot(ws), note: said.startsWith("Already known") ? "Orbit knows that already." : "Saved. It shows up here in a few seconds." });
      }
      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
    return Response.json(snapshot(ws));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
