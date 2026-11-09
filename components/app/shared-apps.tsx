"use client";

import { useState } from "react";
import type { MemberAppAct, SharedApp, SharedApps } from "@/cloud/protocol";
import { appStatus, changesBetween, type AppStatusInput } from "@/lib/hosted-apps";
import { REPLY_WAITS_LINE } from "@/lib/shared";
import type { AppState } from "@/lib/types";
import { Fold, StatusLine, Tag } from "./app-status";
import { PasswordShown } from "./preview-password";
import { memberAct } from "./shared-act";
import { ago } from "./ui";

/*
 * Your Apps in a workspace someone shared with the user, when its owner gave them Your Apps (lib/shared.ts SharedOpen.apps,
 * cloud/ws-slice.ts appsFor): its apps on the web as the owner's Mac last read them, each with what's going on in a
 * sentence (what the preview has, whether live is behind it: lib/hosted-apps.ts appStatus, the same words the owner
 * reads) and the one thing to press. Read sees each app's sites and addresses (its Preview link, where a member's
 * Update preview goes, with its state), what they serve, its changes and deploys, and domains; Write also sees a
 * Preview's password, updates the preview, goes back to an earlier Preview deploy, changes a site's build settings and
 * uses one of the workspace's own domains, each sent to the owner's Bops (memberAct), which does it and keeps it on the
 * app under their name. An Admin, once the owner's Bops takes it (SharedOpen.adminPublish), also publishes (what its
 * Preview serves goes on Published) and goes back on Published. Never its variables, logs or a domain to buy: the owner's.
 */

/** Every word the shared page says (the tests read them for dashes and the old name). */
export const SHARED_APPS_WORDS = {
  title: "Your Apps",
  readLine: (ws: string) => `Apps on the web in ${ws}. You can look.`,
  writeLine: (ws: string) => `Apps on the web in ${ws}. You can update their previews.`,
  asOf: (when: string) => `As of ${when}`,
  none: "No apps on the web here yet.",
  readOnly: "Ask the owner for Write to update the preview.",
  noVariables: "Only the owner sees its variables.",
  noLogs: "Build logs show in the owner's Bops.",
  noBuying: "Only the owner buys domains.",
  useDomain: "Use one of this workspace's domains",
  sending: "Sending to the owner's Bops…",
  waiting: REPLY_WAITS_LINE,
  failed: "That didn't go. Try again.",
  deploy: "Update preview",
  publish: "Publish",
  previewThis: "Preview this one",
  goBack: "Go back to this one",
  save: "Save",
  use: "Use",
  changes: "Changes",
  earlierDeploys: "Earlier deploys",
  buildSettings: "Build settings",
  settings: "Settings",
  domains: "Domains",
  sites: "Sites",
  preview: "Preview",
  published: "Published",
  askPassword: "Ask the owner for its password.",
  live: "Live",
  running: "Running",
  notOnWeb: "Not on the web yet",
  subdomain: "Subdomain",
  needsPreview: "The preview isn't live yet.",
  samePublished: "What's published is the preview already.",
  needsDomain: "It needs a domain first. Use one of the workspace's domains below.",
  acted: (who: string, a: Pick<MemberAppAct, "act" | "site"> & { domain?: string; env?: "prod" }) =>
    a.act === "deploy" ? (a.env === "prod" ? `${who} published it` : `${who} updated the preview`) : a.act === "rollback" ? `${who} went back to an earlier deploy` : a.act === "settings" ? `${who} changed ${a.site ? `${a.site}'s` : "its"} settings` : `${who} pointed ${a.domain ?? "a domain"} at it`,
  tried: (who: string, act: MemberAppAct["act"] | "publish", said: string) =>
    `${who} tried to ${act === "publish" ? "publish it" : act === "deploy" ? "update the preview" : act === "rollback" ? "go back to an earlier deploy" : act === "settings" ? "change its settings" : "use a domain"}: ${said}`,
};
const W = SHARED_APPS_WORDS;

/** A deploy's state in a word: on the Preview, a finished one is Running; on Published, Live. */
const STATE_WORDS: Record<string, string> = { queued: "Waiting to deploy", running: "Deploying", failed: "Failed", cancelled: "Deploy stopped", superseded: "Deploy replaced" };
const stateWord = (s: string | null | undefined, env: "preview" | "prod" = "prod") => (s === "succeeded" ? (env === "preview" ? W.running : W.live) : (s && STATE_WORDS[s]) || W.notOnWeb);

/** When the owner's Mac read them: the time today, else the day too. */
export function asOf(at: number, now = Date.now()) {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** What a member's act on an app says, done or not, with when (the owner's rows and the member's own). */
export function actLine(a: NonNullable<SharedApp["acts"]>[number]) {
  return `${a.ok ? W.acted(a.name, a) : W.tried(a.name, a.act === "deploy" && a.env === "prod" ? "publish" : a.act, a.said ?? W.failed)} · ${asOf(a.at)}`;
}

type Site = NonNullable<SharedApp["sites"]>[number];
type DeployState = AppStatusInput["live"]["state"];
const asState = (s: string | null | undefined): DeployState => (s === "queued" || s === "running" || s === "succeeded" || s === "failed" || s === "cancelled" || s === "superseded" ? s : null);

/**
 * What an app's status sentence is made of (lib/hosted-apps.ts appStatus), from what the owner's Mac wrote for members:
 * its newest changeset, its own site's Preview and Published, and whether it has a domain to live on. A Bops from before
 * Preview sends no Preview: then its one address stands for both, so the sentence never asks for a preview it can't have.
 */
export function sharedStatus(a: SharedApp, site: Site | undefined): AppStatusInput {
  const pv = !!site && (!!site.preview || site.previewLive != null);
  const domain = !!site?.domains?.some((d) => d.status !== "failed" && d.status !== "disabled") || !!site?.url;
  const live = { serving: site?.serving ?? null, state: asState(site?.live?.state) };
  const commits = a.commits ?? [];
  const changes = pv ? changesBetween(commits, live.serving, site.previewServing ?? null) : null;
  const newest = pv && site.previewServing ? commits.find((c) => c.id === site.previewServing) : undefined;
  return {
    head: a.head === undefined ? live.serving : (a.head?.id ?? null),
    preview: pv ? { serving: site.previewServing ?? null, state: asState(site.previewLive?.state) } : { serving: live.serving, state: live.state },
    live,
    domain,
    wasLive: !!site?.serving || site?.live?.state === "succeeded",
    ...(a.lost ? { lost: true } : {}),
    changes,
    change: changes && newest ? newest.message.split("\n", 1)[0].trim() : null,
  };
}

const BUTTON = "rounded-full px-3 py-1 text-[12px] font-medium leading-4 disabled:opacity-50";
const FILLED = `${BUTTON} bg-ink text-white`;
const OUTLINED = `${BUTTON} text-ink shadow-[0_0_0_1px_#E2E2DF] hover:bg-[#F6F6F4]`;
const HEAD = "text-[12px] font-semibold leading-4 text-[#9A9A97]";

export function SharedAppsPage({ state }: { state: AppState }) {
  const apps = state.shared?.apps;
  const ws = state.shared?.name ?? "";
  if (!apps) return null;
  const write = apps.level === "write";
  // An Admin whose owner's Bops publishes for them (Bops Cloud says so only then: ADMIN_PUBLISH_MIN_VERSION).
  const publish = write && state.shared?.role === "admin" && state.shared.adminPublish === true;
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
            <SharedAppCard key={a.name} app={a} apps={apps} publish={publish} acts={(state.shared?.appActs ?? []).filter((x) => x.act.app === a.name)} />
          ))}
        </div>
      )}
    </div>
  );
}

type Pending = NonNullable<NonNullable<AppState["shared"]>["appActs"]>[number];

/**
 * One app: its name and address, what's going on in a sentence, and Update preview (and an Admin's Publish), the one to
 * press now filled; opened below, its Preview's link and password, its changes (each tagged where it is), and, folded,
 * its earlier deploys, its build settings; then its domains.
 */
function SharedAppCard({ app: a, apps, acts, publish }: { app: SharedApp; apps: SharedApps; acts: Pending[]; publish: boolean }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const write = apps.level === "write";
  // Up top, its own site's Preview, where a member's Update preview goes; Published's from an owner's Bops that sends no Preview.
  // By its link: Bops Cloud drops a null previewLive (a Preview with no deploy yet).
  const site = a.sites?.[0];
  const pv = !!site && (!!site.preview || site.previewLive != null);
  const going = acts.find((x) => x.state !== "failed");
  const send = async (act: MemberAppAct) => {
    setSaid(null);
    const r = await memberAct(act);
    if (!r.ok) setSaid(r.error ?? W.failed);
  };
  const newest = a.acts?.[0];
  const status = sharedStatus(a, site);
  const next = appStatus(status).action;
  // Why Publish can't be pressed now: no Preview live yet, nothing on it that isn't published, or no domain to live on.
  const whyNotPublish = !pv || !site.previewServing ? W.needsPreview : site.previewServing === site.serving ? W.samePublished : !status.domain && !status.wasLive ? W.needsDomain : undefined;
  const commits = a.commits ?? [];
  return (
    <div data-shared-app={a.name} className="flex flex-col rounded-[14px] bg-white shadow-[0_0_0_1px_#ECECEA]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`size-2 shrink-0 rounded-full ${site?.live?.state === "succeeded" ? "bg-[#2BB673]" : site?.live?.state === "failed" ? "bg-[#B42318]" : "bg-[#C9C9C6]"}`} />
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold leading-[18px]">{a.name}</span>
            {site?.url && <span className="min-w-0 truncate font-mono text-[11.5px] leading-4 text-[#6B6B6B]">{site.url.replace(/^https?:\/\//, "")}</span>}
          </span>
          <StatusLine input={status} />
        </button>
        {write ? (
          <>
            <button type="button" data-act="deploy" disabled={!!going} onClick={() => void send({ act: "deploy", app: a.name })} className={next === "update-preview" ? FILLED : OUTLINED}>
              {W.deploy}
            </button>
            {/* An Admin's Publish, as the owner's: what its Preview serves goes on Published (the changeset seen here, for an app of one site). */}
            {publish && (
              <span data-tip={whyNotPublish} className="flex">
                <button
                  type="button"
                  data-shared-publish
                  disabled={!!going || !!whyNotPublish}
                  onClick={() => void send({ act: "deploy", app: a.name, env: "prod", ...(pv && site.previewServing && !a.siteNames?.length ? { at: site.previewServing } : {}) })}
                  className={next === "publish" ? FILLED : OUTLINED}
                >
                  {W.publish}
                </button>
              </span>
            )}
          </>
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
        <div className="motion-fade-in flex flex-col gap-3 border-t border-[#F0F0EE] px-4 py-3">
          {/* Its Preview: the link, where Update preview goes, and its password; of an app with more sites, each site's line. */}
          {(a.sites ?? []).length > 1 ? (
            <Part title={W.sites}>
              {(a.sites ?? []).map((s) => (
                <span key={s.name} className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-[12.5px] leading-[18px]">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-[#6B6B6B]">{stateWord(s.live?.state)}</span>
                    {s.url && <span className="font-mono text-[11.5px] text-[#3A3A38]">{s.url.replace(/^https?:\/\//, "")}</span>}
                  </span>
                  {s.preview && <PreviewLine site={s} link={s.preview} write={write} />}
                </span>
              ))}
            </Part>
          ) : (
            site?.preview && (
              <Part title={W.preview}>
                <PreviewLine site={site} link={site.preview} write={write} />
              </Part>
            )
          )}
          {!!commits.length && (
            <Part title={W.changes}>
              {commits.map((c) => {
                const onPreview = pv && c.id === site.previewServing;
                const isLive = !!site && c.id === site.serving;
                return (
                  <span key={c.id} data-commit={c.id} title={c.id} className="group flex h-7 items-center gap-2 text-[12.5px] leading-[18px]">
                    <span className="min-w-0 flex-1 truncate">{c.message.split("\n", 1)[0].trim() || "No message"}</span>
                    <span className="shrink-0 text-[#9A9A98]">{`${c.author} · ${ago(c.at)}`}</span>
                    {onPreview && <Tag kind="preview" />}
                    {isLive && <Tag kind="live" />}
                    {write && !onPreview && !isLive && (
                      <span className="flex shrink-0 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                        <button type="button" disabled={!!going} onClick={() => void send({ act: "deploy", app: a.name, at: c.id })} className={OUTLINED}>
                          {W.previewThis}
                        </button>
                      </span>
                    )}
                  </span>
                );
              })}
            </Part>
          )}
          {!!a.deploys?.length && (
            <Fold id="deploys" title={W.earlierDeploys} aside={W.noLogs}>
              <div className="flex flex-col gap-1.5">
                {a.deploys.map((d) => (
                  <span key={d.id} className="flex items-center gap-2 text-[12.5px] leading-[18px]">
                    <span className="min-w-0 flex-1 truncate">
                      {[stateWord(d.state, d.env === "preview" ? "preview" : "prod"), d.env === "preview" ? W.preview : d.env === "prod" ? W.published : null, d.site !== a.name ? d.site : null, d.when ? ago(d.when) : null].filter(Boolean).join(" · ")}
                    </span>
                    {d.live && <Tag kind={d.env === "preview" ? "preview" : "live"} />}
                    {/* Members go back on its Preview only (lib/server/member-acts.ts); an Admin who may publish, on Published too. */}
                    {write && d.canRollback && !d.live && (d.env !== "prod" || publish) && (
                      <button type="button" disabled={!!going} onClick={() => void send({ act: "rollback", app: a.name, deployment: d.id, ...(d.site !== a.name ? { site: d.site } : {}), ...(d.env === "prod" ? { env: "prod" as const } : {}) })} className={OUTLINED}>
                        {W.goBack}
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </Fold>
          )}
          {write && a.settings && (
            <Fold id="settings" title={W.buildSettings} aside={W.noVariables}>
              <SettingsPart app={a} disabled={!!going} onSave={(act) => void send(act)} />
            </Fold>
          )}
          {write && !!apps.owned?.length && <DomainPart app={a} owned={apps.owned} disabled={!!going} onUse={(act) => void send(act)} />}
        </div>
      )}
    </div>
  );
}

/**
 * A site's Preview, where a member's Update preview goes: its state and link, and while the link asks for a password,
 * the password at Write (the owner gave them all of Your Apps), as the owner sees it; at Read, or when the owner's Bops
 * couldn't read it, who to ask.
 */
function PreviewLine({ site: s, link, write }: { site: Site; link: string; write: boolean }) {
  return (
    <span data-shared-preview className="flex flex-wrap items-center gap-2 text-[12.5px] leading-[18px]">
      <span className="text-[#6B6B6B]">{stateWord(s.previewLive?.state, "preview")}</span>
      <a href={link} target="_blank" rel="noreferrer" title={link} className="min-w-0 truncate font-mono text-[11.5px] leading-4 text-[#3A3A38] hover:underline">
        {link.replace(/^https?:\/\//, "")}
      </a>
      {s.previewProtected && (write && s.previewPassword ? <PasswordShown password={s.previewPassword} /> : <span className="text-[12px] leading-4 text-[#9A9A98]">{W.askPassword}</span>)}
    </span>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={HEAD}>{title}</span>
      {children}
    </div>
  );
}

const FIELD = "h-8 min-w-0 rounded-[10px] bg-[#F7F7F6] px-2.5 text-[12.5px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]";

/** A site's build settings (port and the four commands), saved by the owner's Bops. Never its variables. */
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
    <div className="flex flex-col gap-1.5">
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
          className={FILLED}
        >
          {W.save}
        </button>
        <span className="text-[12px] text-[#9A9A98]">{W.noVariables}</span>
      </span>
    </div>
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
        <button type="button" disabled={disabled || !ok} onClick={() => onUse({ act: "domain", app: a.name, zone, ...(sub ? { subdomain: sub } : {}) })} className={FILLED}>
          {W.use}
        </button>
      </span>
      <span className="text-[12px] text-[#9A9A98]">{W.noBuying}</span>
    </Part>
  );
}
