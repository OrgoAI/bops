"use client";

import { useCallback, useEffect, useState } from "react";
import { rowTrashBtn, TrashIcon } from "./apps";
import { undash } from "./side-group";

/*
 * Apps that use a key from Keys (lib/server/app-keys.ts): an app variable that points at one of This workspace's keys by
 * name, and orgo-web fills the value in at each build. Two places:
 *   - EveryAppSwitch, on a key's row in Keys: "Every app in this workspace can use it", one switch a key. It needs no app
 *     row, so a brand new app gets the key with nobody acting and the owner's Mac off.
 *   - KeyVariables, beside an app's Variables (the owner's, and a member's with Keys and Your Apps at Write): its keys
 *     from Keys, one app's own under a name of its choosing, and every app's.
 * Only names reach the window. Each reads GET /api/keys/apps itself, so its mount is one line wherever it shows; an Orgo
 * that can't link keys yet (`old`) gets a line instead of the switches.
 */

export const APP_KEYS_WORDS = {
  every: "Every app in this workspace can use it",
  everyTip: "Each app gets it as a variable of the same name when it's built, new apps too. Anyone who can change an app's code can read it.",
  everyOn: "Every app gets it when it's built. A new value reaches Previews at once and Published at its next Publish.",
  title: "From Keys",
  forEvery: "every app",
  missing: "Keys has none now",
  use: "Use a key from Keys",
  pick: "Pick a key",
  as: "As",
  add: "Add",
  cancel: "Cancel",
  none: "This workspace has no keys of its own yet. Add one in Keys first.",
  reach: "Same for its Preview and Published. A new value in Keys reaches its Preview at once and Published at its next Publish.",
  readable: "Anyone who can change this app's code can read these keys.",
  failed: "That didn't change. Try again.",
  offline: "Couldn't reach Bops. Try again.",
};
const W = APP_KEYS_WORDS;

/** A link as GET /api/keys/apps lists it: the app ("*": every app), the variable, the key; `missing`: Keys has none now. */
export type AppKeyLink = { app: string; name: string; key: string; missing?: true };
export type Answer = { links: AppKeyLink[]; can: { every: boolean; app: boolean }; old?: true; said?: string };

const readers = new Set<() => void>();
/** Every list reads again (a link changed here). */
const linksChanged = () => readers.forEach((f) => f());
/** One read of a list at a time, whoever asks: every key's row on the Keys page reads the same list. */
const reading = new Map<string, Promise<Answer | null>>();

function readLinks(query: string): Promise<Answer | null> {
  const was = reading.get(query);
  if (was) return was;
  const p = fetch(`/api/keys/apps${query}`, { cache: "no-store" })
    .then(async (r) => {
      const j = (await r.json().catch(() => null)) as Answer | null;
      return r.ok && j && Array.isArray(j.links) ? j : null;
    })
    .catch(() => null)
    .finally(() => reading.delete(query));
  reading.set(query, p);
  return p;
}

/** The links of one app and every app's (`app`), or every link; null until read, or when this user can't see them. */
function useAppKeyLinks(app?: string) {
  const query = app ? `?app=${encodeURIComponent(app)}` : "";
  const [answer, setAnswer] = useState<Answer | null>(null);
  const read = useCallback(() => void readLinks(query).then(setAnswer), [query]);
  useEffect(() => {
    read();
    readers.add(read);
    return () => void readers.delete(read);
  }, [read]);
  return answer;
}

/** Link or unlink, then every list reads again: null, or why not in plain words. */
async function putLink(body: { app: string; name?: string; key: string | null }): Promise<string | null> {
  try {
    const res = await fetch("/api/keys/apps", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    linksChanged();
    return res.ok ? null : undash(j.error ?? W.failed);
  } catch {
    return W.offline;
  }
}

const HINT = "text-[12px] leading-4 text-[#9A9A98]";
const ALERT = "text-[12px] leading-4 text-[#B42318]";

/**
 * On a key's row in Keys: whether every app in the workspace gets it. Only for This workspace's own keys (never the
 * owner's for all their workspaces, nor another workspace's switched on here), for someone with Keys.
 */
export function EveryAppSwitch({ k }: { k: { name: string; scope: string; owner?: true; from?: string } }) {
  const answer = useAppKeyLinks();
  return <EveryAppRow k={k} answer={answer} />;
}

/** EveryAppSwitch, once the links are read (null: not yet, or this user can't see them). */
export function EveryAppRow({ k, answer }: { k: { name: string; scope: string; owner?: true; from?: string }; answer: Answer | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (k.scope !== "workspace" || k.owner || k.from || !answer) return null;
  if (answer.old) return answer.said ? <span data-app-keys-old className={HINT}>{undash(answer.said)}</span> : null;
  const on = answer.links.some((l) => l.app === "*" && l.key === k.name);
  const flip = async () => {
    setBusy(true);
    setError(await putLink(on ? { app: "*", name: k.name, key: null } : { app: "*", key: k.name }));
    setBusy(false);
  };
  return (
    <div data-every-app={k.name} className="flex flex-col gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${W.every}: ${k.name}`}
        data-tip={W.everyTip}
        disabled={busy || !answer.can.every}
        onClick={() => void flip()}
        className="flex items-center gap-2 self-start text-left text-[12.5px] leading-[18px] text-[#3A3A38] disabled:opacity-60"
      >
        <span className={`flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-0.5 ${on ? "justify-end bg-ink" : "justify-start bg-[#D9D9D6]"}`}>
          <span className={`size-[14px] rounded-full ${on ? "bg-highlighter" : "bg-white"}`} />
        </span>
        {W.every}
      </button>
      {on && <span className={HINT}>{W.everyOn}</span>}
      {error && (
        <span role="alert" className={ALERT}>
          {error}
        </span>
      )}
    </div>
  );
}

/** This workspace's own keys, to pick one from (GET /api/keys, as the Keys page lists them). */
function useWorkspaceKeys(on: boolean) {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!on) return;
    void fetch("/api/keys", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { keys?: { name: string; scope: string; owner?: true; from?: string }[] }) =>
        setNames((j.keys ?? []).filter((x) => x.scope === "workspace" && !x.owner && !x.from).map((x) => x.name)),
      )
      .catch(() => setNames([]));
  }, [on]);
  return names;
}

/**
 * Beside an app's Variables: the keys it uses from Keys, its own (with Remove) and every app's, and "Use a key from Keys".
 * Nothing for someone who can't see them (no Keys); the rows alone for someone who can't change this app's.
 */
export function KeyVariables({ app }: { app: string }) {
  const answer = useAppKeyLinks(app);
  return <KeyVariablesList app={app} answer={answer} />;
}

/** KeyVariables, once the links are read (null: not yet, or this user can't see them). */
export function KeyVariablesList({ app, answer }: { app: string; answer: Answer | null }) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useWorkspaceKeys(adding);
  if (!answer) return null;
  if (answer.old) return answer.said ? <span data-app-keys-old className={`mt-2 ${HINT}`}>{undash(answer.said)}</span> : null;
  const links = answer.links.filter((l) => l.app === app || l.app === "*");
  // A variable set by this app's own link isn't every app's here.
  const shown = links.filter((l) => l.app === app || !links.some((x) => x.app === app && x.name === l.name));
  if (!shown.length && !answer.can.app) return null;
  const send = async (body: { app: string; name?: string; key: string | null }) => {
    setBusy(true);
    const no = await putLink(body);
    setError(no);
    setBusy(false);
    if (!no) {
      setAdding(false);
      setKey("");
      setName("");
    }
  };
  return (
    <div data-key-vars className="mt-3 flex flex-col">
      <span className="text-[12px] leading-[18px] text-[#6B6B6B]">{W.title}</span>
      <div className="-mx-2 flex flex-col">
        {shown.map((l) => (
          <div key={`${l.app}:${l.name}`} data-key-var={l.name} className="group flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 hover:bg-[#F6F6F4]">
            <span title={l.name} className="min-w-0 shrink truncate font-mono text-[12px] leading-4 text-ink">
              {l.name}
            </span>
            <span className={`min-w-0 truncate ${HINT}`}>
              {[`from Keys (${l.key})`, l.app === "*" && W.forEvery, l.missing && W.missing].filter(Boolean).join(", ")}
            </span>
            <span className="flex-1" />
            {l.app === app && answer.can.app && (
              <button
                type="button"
                aria-label={`Stop ${l.name} using ${l.key}`}
                data-tip="Remove"
                disabled={busy}
                onClick={() => void send({ app, name: l.name, key: null })}
                className={`${rowTrashBtn} opacity-0 focus:opacity-100 group-hover:opacity-100`}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        ))}
      </div>
      {answer.can.app &&
        (adding ? (
          <form
            data-key-var-add
            className="mt-1 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (key) void send({ app, key, ...(name.trim() && name.trim() !== key ? { name: name.trim() } : {}) });
            }}
          >
            {keys && !keys.length ? (
              <span className={HINT}>{W.none}</span>
            ) : (
              <>
                <select aria-label={W.pick} value={key} onChange={(e) => setKey(e.target.value)} className="h-7 rounded-lg bg-white px-2 font-mono text-[12px] shadow-[0_0_0_1px_#E6E6E3]">
                  <option value="">{W.pick}</option>
                  {(keys ?? []).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={W.as}
                  placeholder={key || W.as}
                  value={name}
                  onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                  className="h-7 w-44 rounded-lg bg-white px-2 font-mono text-[12px] shadow-[0_0_0_1px_#E6E6E3]"
                />
                <button type="submit" disabled={busy || !key} className="h-7 rounded-full bg-ink px-3 text-[12px] font-medium text-white disabled:opacity-50">
                  {W.add}
                </button>
              </>
            )}
            <button type="button" disabled={busy} onClick={() => setAdding(false)} className="h-7 rounded-full px-2 text-[12px] text-[#6B6B6B] hover:text-ink">
              {W.cancel}
            </button>
          </form>
        ) : (
          <button
            type="button"
            data-key-var-use
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className="-mx-2 mt-0.5 flex h-7 items-center gap-1.5 self-start rounded-lg px-2 text-[12px] leading-4 text-[#6B6B6B] hover:bg-[#F6F6F4] hover:text-ink"
          >
            {W.use}
          </button>
        ))}
      {!!shown.length && <span className={`pt-0.5 ${HINT}`}>{W.reach}</span>}
      {(adding || !!shown.length) && <span className={`pt-0.5 ${HINT}`}>{W.readable}</span>}
      {error && (
        <span role="alert" className={`pt-1 ${ALERT}`}>
          {error}
        </span>
      )}
    </div>
  );
}
