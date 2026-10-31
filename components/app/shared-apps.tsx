"use client";

import { useState } from "react";
import type { MemberAppAct, SharedApp, SharedApps } from "@/cloud/protocol";
import type { AppState } from "@/lib/types";
import { PasswordShown } from "./preview-password";
import { memberAct } from "./shared-act";
import { ago } from "./ui";

/*
 * Your Apps in a workspace someone shared with the user, when its owner gave them Your Apps (lib/shared.ts SharedOpen.apps,
 * cloud/ws-slice.ts appsFor): its apps on the web as the owner's Mac last read them. Read sees each app's sites and
 * addresses (each site's Preview link, where a member's Deploy goes, with its state), what they serve, deploys and
 * history, and domains; Write also sees a Preview's password, deploys, goes back to an earlier Preview deploy, changes
 * a site's settings and uses one of the workspace's own domains, each sent to the owner's Bops (memberAct), which does
 * it and keeps it on the app under their name. Never its variables, logs or a domain to buy: the owner's.
 */

/** Every word the shared page says (the tests read them for dashes and the old name). */
export const SHARED_APPS_WORDS = {
  title: "Apps",
  readLine: (ws: string) => `Apps on the web in ${ws}. You can look.`,
  writeLine: (ws: string) => `Apps on the web in ${ws}. You can deploy them.`,
  asOf: (when: string) => `As of ${when}`,
  none: "No apps on the web here yet.",
  readOnly: "Ask the owner for Write to deploy.",
  noVariables: "Only the owner sees its variables.",
  noLogs: "Build logs show in the owner's Bops.",
  noBuying: "Only the owner buys domains.",
  useDomain: "Use one of this workspace's domains",
  sending: "Sending to the owner's Bops…",
  waiting: "Waiting for the owner's Bops to open.",
  failed: "That didn't go. Try again.",
  deploy: "Deploy",
  goBack: "Go back to this one",
  save: "Save",
  use: "Use",
  history: "History",
  deploys: "Deploys",
  settings: "Settings",
  domains: "Domains",
  sites: "Sites",
  preview: "Preview",
  published: "Published",
  askPassword: "Ask the owner for its password.",
  live: "Live",
  notOnWeb: "Not on the web yet",
  subdomain: "Subdomain",
  acted: (who: string, a: Pick<MemberAppAct, "act" | "site"> & { domain?: string }) =>
    a.act === "deploy" ? `${who} deployed it` : a.act === "rollback" ? `${who} went back to an earlier deploy` : a.act === "settings" ? `${who} changed ${a.site ? `${a.site}'s` : "its"} settings` : `${who} pointed ${a.domain ?? "a domain"} at it`,
  tried: (who: string, act: MemberAppAct["act"], said: string) =>
    `${who} tried to ${act === "deploy" ? "deploy it" : act === "rollback" ? "go back to an earlier deploy" : act === "settings" ? "change its settings" : "use a domain"}: ${said}`,
};
const W = SHARED_APPS_WORDS;

const STATE_WORDS: Record<string, string> = { queued: "Waiting to deploy", running: "Deploying", succeeded: "Live", failed: "Failed", cancelled: "Deploy stopped", superseded: "Deploy replaced" };
const stateWord = (s: string | null | undefined) => (s && STATE_WORDS[s]) || W.notOnWeb;
const shortId = (id: string) => id.slice(0, 7);

/** When the owner's Mac read them: the time today, else the day too. */
export function asOf(at: number, now = Date.now()) {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** What a member's act on an app says, done or not, with when (the owner's rows and the member's own). */
export function actLine(a: NonNullable<SharedApp["acts"]>[number]) {
  return `${a.ok ? W.acted(a.name, a) : W.tried(a.name, a.act, a.said ?? W.failed)} · ${asOf(a.at)}`;
}

const BUTTON = "rounded-full px-3 py-1 text-[12px] font-medium leading-4 disabled:opacity-50";

export function SharedAppsPage({ state }: { state: AppState }) {
  const apps = state.shared?.apps;
  const ws = state.shared?.name ?? "";
  if (!apps) return null;
  const write = apps.level === "write";
  return (
    <div data-shared-apps className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-8 py-8">
      <div className="flex flex-col gap-1">
        <span className="text-[26px] font-bold leading-8 tracking-[-0.025em] text-ink">{W.title}</span>
        <span className="text-[13.5px] leading-[18px] text-[#6B6B6B]">{write ? W.writeLine(ws) : W.readLine(ws)}</span>
        {apps.at > 0 && <span className="text-[12px] leading-4 text-[#9A9A98]">{W.asOf(asOf(apps.at))}</span>}
      </div>
      {!apps.list.length ? (
        <span className="text-[13px] text-[#6B6B6B]">{W.none}</span>
      ) : (
        <div className="flex flex-col gap-3">
          {apps.list.map((a) => (
            <SharedAppCard key={a.name} app={a} apps={apps} acts={(state.shared?.appActs ?? []).filter((x) => x.act.app === a.name)} />
          ))}
        </div>
      )}
      <span className="text-[12px] leading-4 text-[#9A9A98]">{[W.noVariables, W.noLogs, W.noBuying].join(" ")}</span>
    </div>
  );
}

type Pending = NonNullable<NonNullable<AppState["shared"]>["appActs"]>[number];

/** One app: its state, address and Deploy; its sites, history, deploys, settings and domains open below. */
function SharedAppCard({ app: a, apps, acts }: { app: SharedApp; apps: SharedApps; acts: Pending[] }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const write = apps.level === "write";
  // Up top, its own site's Preview, where a member's Deploy goes; Published's from an owner's Bops that sends no Preview.
  // By its link: Bops Cloud drops a null previewLive (a Preview with no deploy yet).
  const site = a.sites?.[0];
  const pv = !!site && (!!site.preview || site.previewLive != null);
  const live = (pv ? site.previewLive : site?.live) ?? null;
  const serving = pv ? site.previewServing : site?.serving;
  const going = acts.find((x) => x.state !== "failed");
  const send = async (act: MemberAppAct) => {
    setSaid(null);
    const r = await memberAct(act);
    if (!r.ok) setSaid(r.error ?? W.failed);
  };
  const newest = a.acts?.[0];
  return (
    <div data-shared-app={a.name} className="flex flex-col rounded-[14px] bg-white shadow-[0_0_0_1px_#ECECEA]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`size-2 shrink-0 rounded-full ${live?.state === "succeeded" ? "bg-[#2BB673]" : live?.state === "failed" ? "bg-[#B42318]" : "bg-[#C9C9C6]"}`} />
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="flex min-w-0 flex-1 flex-col text-left">
          <span className="truncate text-[14px] font-semibold leading-[18px]">{a.name}</span>
          <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">
            {[pv ? W.preview : null, stateWord(live?.state), serving ? shortId(serving) : null, pv ? site.preview : a.url].filter(Boolean).join(" · ")}
          </span>
        </button>
        {write ? (
          <button type="button" disabled={!!going} onClick={() => void send({ act: "deploy", app: a.name })} className={`${BUTTON} bg-ink text-white`}>
            {W.deploy}
          </button>
        ) : (
          <span data-tip={W.readOnly} className="flex">
            <button type="button" disabled className={`${BUTTON} text-[#9A9A98] shadow-[0_0_0_1px_#ECECEA]`}>
              {W.deploy}
            </button>
          </span>
        )}
      </div>
      {(going || acts.some((x) => x.state === "failed") || said || newest) && (
        <div className="flex flex-col gap-0.5 px-4 pb-2.5 text-[12px] leading-4">
          {going && <span className="text-[#6B6B6B]">{going.state === "waiting" ? W.waiting : W.sending}</span>}
          {acts
            .filter((x) => x.state === "failed")
            .map((x) => (
              <span key={x.key} role="alert" className="text-[#B42318]">
                {x.error ?? W.failed}
              </span>
            ))}
          {said && (
            <span role="alert" className="text-[#B42318]">
              {said}
            </span>
          )}
          {newest && <span data-act-line className={newest.ok ? "text-[#6B6B6B]" : "text-[#B42318]"}>{actLine(newest)}</span>}
        </div>
      )}
      {!write && open && <span className="px-4 pb-2 text-[12px] leading-4 text-[#6B6B6B]">{W.readOnly}</span>}
      {open && (
        <div className="motion-fade-in flex flex-col gap-3 border-t border-[#F0F0ED] px-4 py-3">
          <Part title={W.sites}>
            {(a.sites ?? []).map((s) => (
              <span key={s.name} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-[12.5px] leading-[18px]">
                  <span className="font-medium">{s.name}</span>
                  {s.preview && <span className="text-[#9A9A98]">{W.published}</span>}
                  <span className="text-[#6B6B6B]">{stateWord(s.live?.state)}</span>
                  {s.url && <span className="text-[#3A3A38]">{s.url}</span>}
                  {(s.domains ?? []).map((d) => (
                    <span key={d.domain} className="rounded-full bg-[#F6F6F4] px-2 py-0.5 text-[11.5px] text-[#3A3A38]">
                      {d.domain}
                    </span>
                  ))}
                </span>
                {s.preview && <PreviewLine site={s} link={s.preview} write={write} />}
              </span>
            ))}
          </Part>
          {!!a.commits?.length && (
            <Part title={W.history}>
              {a.commits.map((c) => (
                <span key={c.id} className="flex items-center gap-2 text-[12.5px] leading-[18px]">
                  <span className="font-mono text-[11.5px] text-[#9A9A98]">{shortId(c.id)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.message}</span>
                  <span className="shrink-0 text-[#9A9A98]">{`${c.author} · ${ago(c.at)}`}</span>
                  {write && (
                    <button type="button" disabled={!!going} onClick={() => void send({ act: "deploy", app: a.name, at: c.id })} className={`${BUTTON} shadow-[0_0_0_1px_#E2E2DF]`}>
                      {W.deploy}
                    </button>
                  )}
                </span>
              ))}
            </Part>
          )}
          {!!a.deploys?.length && (
            <Part title={W.deploys}>
              {a.deploys.map((d) => (
                <span key={d.id} className="flex items-center gap-2 text-[12.5px] leading-[18px]">
                  <span className="min-w-0 flex-1 truncate">
                    {[stateWord(d.state), d.env === "preview" ? W.preview : d.env === "prod" ? W.published : null, d.at ? shortId(d.at) : null, d.site !== a.name ? d.site : null, d.when ? ago(d.when) : null].filter(Boolean).join(" · ")}
                  </span>
                  {d.live && <span className="text-[#1E7A4C]">{W.live}</span>}
                  {/* Members go back on its Preview only (lib/server/member-acts.ts): never on a Published deploy. */}
                  {write && d.canRollback && !d.live && d.env !== "prod" && (
                    <button type="button" disabled={!!going} onClick={() => void send({ act: "rollback", app: a.name, deployment: d.id, ...(d.site !== a.name ? { site: d.site } : {}) })} className={`${BUTTON} shadow-[0_0_0_1px_#E2E2DF]`}>
                      {W.goBack}
                    </button>
                  )}
                </span>
              ))}
            </Part>
          )}
          {write && a.settings && <SettingsPart app={a} disabled={!!going} onSave={(act) => void send(act)} />}
          {write && !!apps.owned?.length && <DomainPart app={a} owned={apps.owned} disabled={!!going} onUse={(act) => void send(act)} />}
        </div>
      )}
    </div>
  );
}

/**
 * A site's Preview, where a member's Deploy goes: its state and link, and while the link asks for a password, the password
 * at Write (the owner gave them all of Your Apps), as the owner sees it; at Read, or when the owner's Bops couldn't read it, who to ask.
 */
function PreviewLine({ site: s, link, write }: { site: NonNullable<SharedApp["sites"]>[number]; link: string; write: boolean }) {
  return (
    <span data-shared-preview className="flex flex-wrap items-center gap-2 text-[12.5px] leading-[18px]">
      <span className="text-[#9A9A98]">{W.preview}</span>
      <span className="text-[#6B6B6B]">{stateWord(s.previewLive?.state)}</span>
      <a href={link} target="_blank" rel="noreferrer" title={link} className="min-w-0 truncate font-mono text-[11.5px] leading-4 text-[#3A3A38] hover:underline">
        {link}
      </a>
      {s.previewProtected && (write && s.previewPassword ? <PasswordShown password={s.previewPassword} /> : <span className="text-[12px] leading-4 text-[#9A9A98]">{W.askPassword}</span>)}
    </span>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase leading-4 tracking-[0.02em] text-[#9A9A97]">{title}</span>
      {children}
    </div>
  );
}

const FIELD = "h-8 min-w-0 rounded-[10px] bg-[#F7F7F6] px-2.5 text-[12.5px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]";

/** A site's settings (port and the four commands), saved by the owner's Bops. Never its variables. */
function SettingsPart({ app: a, disabled, onSave }: { app: SharedApp; disabled: boolean; onSave: (act: MemberAppAct) => void }) {
  const site = Object.keys(a.settings ?? {})[0] ?? a.name;
  const was = a.settings?.[site];
  const [port, setPort] = useState(was?.port ? String(was.port) : "");
  const [start, setStart] = useState(was?.start ?? "");
  const [build, setBuild] = useState(was?.build ?? "");
  const [install, setInstall] = useState(was?.install ?? "");
  const changed = port !== (was?.port ? String(was.port) : "") || start !== (was?.start ?? "") || build !== (was?.build ?? "") || install !== (was?.install ?? "");
  const n = Number(port);
  return (
    <Part title={W.settings}>
      <div data-shared-settings className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-[12.5px]">
        <span className="text-[#6B6B6B]">Port</span>
        <input aria-label="Port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} className={FIELD} />
        <span className="text-[#6B6B6B]">Install</span>
        <input aria-label="Install" value={install} onChange={(e) => setInstall(e.target.value)} className={FIELD} />
        <span className="text-[#6B6B6B]">Build</span>
        <input aria-label="Build" value={build} onChange={(e) => setBuild(e.target.value)} className={FIELD} />
        <span className="text-[#6B6B6B]">Start</span>
        <input aria-label="Start" value={start} onChange={(e) => setStart(e.target.value)} className={FIELD} />
      </div>
      <span className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || !changed || (port !== "" && (!Number.isInteger(n) || n < 1 || n > 65535))}
          onClick={() =>
            onSave({ act: "settings", app: a.name, ...(site !== a.name ? { site } : {}), ...(port ? { port: n } : {}), ...(install !== (was?.install ?? "") ? { install } : {}), ...(build !== (was?.build ?? "") ? { build } : {}), ...(start !== (was?.start ?? "") ? { start } : {}) })
          }
          className={`${BUTTON} bg-ink text-white`}
        >
          {W.save}
        </button>
        <span className="text-[12px] text-[#9A9A98]">{W.noVariables}</span>
      </span>
    </Part>
  );
}

/** Use one of the workspace's own domains (bought through Orgo) for the app, with a subdomain. Buying one stays the owner's. */
function DomainPart({ app: a, owned, disabled, onUse }: { app: SharedApp; owned: NonNullable<SharedApps["owned"]>; disabled: boolean; onUse: (act: MemberAppAct) => void }) {
  const [zone, setZone] = useState(owned[0].id);
  const [sub, setSub] = useState("");
  const ok = sub === "" || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub);
  return (
    <Part title={W.domains}>
      <span className="text-[12.5px] text-[#3A3A38]">{W.useDomain}</span>
      <span data-shared-domain className="flex flex-wrap items-center gap-2">
        <input aria-label={W.subdomain} placeholder="www" value={sub} onChange={(e) => setSub(e.target.value.toLowerCase().slice(0, 63))} className={`${FIELD} w-[110px]`} />
        <span className="text-[#9A9A98]">.</span>
        <select aria-label={W.domains} value={zone} onChange={(e) => setZone(e.target.value)} className={`${FIELD} appearance-none pr-6`}>
          {owned.map((d) => (
            <option key={d.id} value={d.id}>
              {d.domain}
            </option>
          ))}
        </select>
        <button type="button" disabled={disabled || !ok} onClick={() => onUse({ act: "domain", app: a.name, zone, ...(sub ? { subdomain: sub } : {}) })} className={`${BUTTON} bg-ink text-white`}>
          {W.use}
        </button>
      </span>
      <span className="text-[12px] text-[#9A9A98]">{W.noBuying}</span>
    </Part>
  );
}
