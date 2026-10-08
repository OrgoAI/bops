"use client";

import { useState } from "react";
import type { AppState, BotId, VaultLogin } from "@/lib/types";
import { AppsSection } from "./apps";
import { Mascot } from "./mascot";
import { KeyIcon } from "./screen-cards";
import { ago, CloseButton, post, teamOf } from "./ui";

/*
 * The vault: everything your bots can get into, in one place. Apps (any of Composio's catalog, several
 * accounts each) with how much each bot may do in them, and logins bots sign in with. For logins, Bops shows the site,
 * the username and who may use each; the password and 2FA setup key live in the Mac's Keychain and
 * are filled straight into the sign-in page, so no AI ever sees them.
 */

/** The Vault, as a tab on the right. Its X (or Esc, see bops-app.tsx) closes it, back to where you were. */
export function VaultTab({ state, onClose }: { state: AppState; onClose: () => void }) {
  const logins = [...(state.vault ?? [])].sort((a, b) => a.site.localeCompare(b.site));
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <KeyIcon />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">Vault</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">Your apps and logins, and which bots can use them.</span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>

        <AppsSection state={state} />

        <div className="flex items-end justify-between gap-3 pt-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold leading-5">Logins</span>
            <span className="text-[12.5px] leading-[17px] text-[#6B6B6B]">Passwords and 2FA keys stay in your Mac&apos;s Keychain and go straight into the sign-in page. No AI ever sees them.</span>
          </div>
          {editing !== "new" && (
            <button onClick={() => setEditing("new")} className="shrink-0 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold leading-4 text-white">
              Add a login
            </button>
          )}
        </div>

        {editing === "new" && <LoginForm state={state} onDone={() => setEditing(null)} />}

        {logins.length > 0 && (
          <div className="flex flex-col rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
            {logins.map((l, i) =>
              editing === l.id ? (
                <div key={l.id} className={`p-3 ${i < logins.length - 1 ? "border-b border-[#F0F0EE]" : ""}`}>
                  <LoginForm state={state} login={l} onDone={() => setEditing(null)} />
                </div>
              ) : (
                <LoginRow key={l.id} state={state} login={l} last={i === logins.length - 1} onEdit={() => setEditing(l.id)} />
              ),
            )}
          </div>
        )}

        {!logins.length && editing !== "new" && (
          <div className="py-10 text-center text-[13.5px] leading-5 text-[#6B6B6B]">No logins yet. Add one, or tick &ldquo;Save to your vault&rdquo; when a bot asks you to sign it in.</div>
        )}
      </div>
    </div>
  );
}

function SiteTile({ site }: { site: string }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[#F2F2F0] text-[14px] font-semibold uppercase text-[#3A3A38]">{site.replace(/^www\./, "")[0]}</span>
  );
}

function LoginRow({ state, login: l, last, onEdit }: { state: AppState; login: VaultLogin; last: boolean; onEdit: () => void }) {
  const [sure, setSure] = useState(false);
  const who = l.bots === "all" ? teamOf(state) : teamOf(state).filter((b) => (l.bots as BotId[]).includes(b.id));
  return (
    <div className={`group flex items-center gap-3 px-3.5 py-3 ${last ? "" : "border-b border-[#F0F0EE]"}`}>
      <SiteTile site={l.site} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-medium leading-[18px]">{l.site}</span>
          {l.hasTotp && <Badge>2FA codes</Badge>}
          {l.auto && <Badge>Auto sign-in</Badge>}
        </span>
        <span className="truncate text-[12.5px] leading-4 text-[#6B6B6B]">
          {l.username}
          {l.usedAt ? ` · used ${ago(l.usedAt) === "now" ? "just now" : `${ago(l.usedAt)} ago`}` : " · not used yet"}
        </span>
      </div>
      <span className="flex shrink-0 -space-x-1.5" title={l.bots === "all" ? "Every bot can use it" : who.map((b) => b.name).join(", ")}>
        {who.slice(0, 4).map((b) => (
          <span key={b.id} className="rounded-full bg-white p-px">
            <Mascot botId={b.id} color={b.color} size={20} antenna={false} />
          </span>
        ))}
      </span>
      {sure ? (
        <span className="flex shrink-0 items-center gap-1">
          <button onClick={() => void post("/api/vault", { id: l.id }, "DELETE")} className="rounded-full bg-[#B42318] px-2.5 py-1 text-[12px] font-semibold text-white">
            Delete
          </button>
          <button onClick={() => setSure(false)} className="rounded-full px-2 py-1 text-[12px] text-[#6B6B6B]">
            Keep
          </button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={onEdit} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[#3A3A38] hover:bg-[#F2F2F0]">
            Edit
          </button>
          <button onClick={() => setSure(true)} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[#B42318] hover:bg-[#FEF3F2]">
            Delete
          </button>
        </span>
      )}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded-full bg-[#F2F2F0] px-1.5 py-px text-[10.5px] font-medium leading-[14px] text-[#3A3A38]">{children}</span>;
}

/** Add a login, or change one. Secrets are write-only: an existing one shows as dots and can only be replaced. */
function LoginForm({ state, login, onDone }: { state: AppState; login?: VaultLogin; onDone: () => void }) {
  const [site, setSite] = useState(login?.site ?? "");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [bots, setBots] = useState<VaultLogin["bots"]>(login?.bots ?? "all");
  const [auto, setAuto] = useState(login?.auto ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "w-full rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13.5px] leading-[18px] outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  const toggleBot = (id: string) => {
    const now = bots === "all" ? state.bots.map((b) => b.id) : bots;
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    setBots(next.length === state.bots.length ? "all" : next);
  };
  const on = (id: string) => bots === "all" || bots.includes(id);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { site, username, password: password || undefined, totp: totp || undefined, bots, auto };
    const res = login ? await post("/api/vault", { id: login.id, ...body }, "PATCH") : await post("/api/vault", body);
    if (res.ok) {
      setPassword("");
      setTotp("");
      onDone();
    } else {
      setError(((await res.json()) as { error?: string }).error ?? "Couldn't save it");
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      // Esc cancels the form first; the next one closes the Vault (preventDefault tells it this one's taken).
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onDone();
      }}
      className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-[0_0_0_1px_#ECECEA,0_10px_30px_-18px_#00000040]"
    >
      <div className="grid grid-cols-2 gap-2.5">
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Site</span>
          <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="x.com" autoFocus={!login} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Email or username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={login?.hasPassword ? "•••••••• (unchanged)" : ""} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">2FA setup key · optional</span>
          <input
            type="password"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            autoComplete="off"
            placeholder={login?.hasTotp ? "•••••••• (unchanged)" : "The code under \"can't scan?\""}
            className={`${field} font-mono`}
          />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11.5px] font-medium leading-4 text-[#6B6B6B]">Who can use it</span>
        <div className="flex flex-wrap gap-1.5">
          {teamOf(state).map((b) => (
            <button
              type="button"
              key={b.id}
              onClick={() => toggleBot(b.id)}
              className={`flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12.5px] leading-4 ${on(b.id) ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#6B6B6B]"}`}
            >
              <Mascot botId={b.id} color={b.color} size={18} antenna={false} />
              {b.name}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2.5 text-[13px] leading-[18px]">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="size-4 accent-[#0A0A0A]" />
        <span>
          Sign in automatically <span className="text-[#6B6B6B]">· otherwise you get a one-tap &ldquo;Sign in as&rdquo; when a bot asks</span>
        </span>
      </label>

      {error && <span className="text-[12.5px] leading-4 text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-2">
        <button disabled={busy || !site.trim() || !username.trim() || (!login && !password)} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold leading-4 text-white disabled:opacity-40">
          {busy ? "Saving…" : login ? "Save" : "Save login"}
        </button>
        <button type="button" onClick={onDone} className="rounded-full px-3.5 py-2 text-[13px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0]">
          Cancel
        </button>
        <span className="flex-1" />
        <span className="text-[11.5px] leading-4 text-[#9A9A98]">Stored in your Mac&apos;s Keychain</span>
      </div>
    </form>
  );
}
