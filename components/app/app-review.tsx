"use client";

import { useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Copy, Info, Lock } from "lucide-react";
import type { AppCommit } from "@/lib/hosted-apps";
import { hasUnpublishedPreview, reviewLabel, type ReviewStatus } from "@/lib/app-review";
import { AppDisclosure, appAttention, appAttentionTag, appGhost, appIcon, appList, appOutline, appPrimary, appRow, appTag, segment, segmented } from "./app-controls";
import { Fold } from "./fold";
import { useDismiss } from "./new-thread";
import { ago, AskInPlace } from "./ui";

/** Revealed only on request; clipboard failures keep the value available for manual copying. */
export function AppPassword({ password, waiting, error }: { password: string | null; waiting?: boolean; error?: string | null }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => { setOpen(false); button.current?.focus(); }, box);
  return <div className="relative" ref={box}>
    <button ref={button} className={appOutline} onClick={() => { setOpen(!open); setCopied(false); }} aria-expanded={open}><Lock {...appIcon}/>{open ? "Hide password" : "Show password"}</button>
    {open && <div role="dialog" aria-label="Preview password" data-password-popover className="absolute left-0 top-[calc(100%+6px)] z-30 flex w-[240px] flex-col gap-3 rounded-[12px] bg-paper p-3 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]">
      {password ? <><span data-preview-password className="select-all break-all text-[14px] font-medium">{password}</span><button className={`${appOutline} w-full`} onClick={() => void navigator.clipboard.writeText(password).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true))}>{copied ? <Check {...appIcon}/> : <Copy {...appIcon}/>}{copied ? "Copied" : "Copy password"}</button>{copyError && <span role="alert" className="text-[13px] text-pencil">Couldn&apos;t copy. Select the password to copy it.</span>}</> : <span role={error ? "alert" : "status"} className="text-[13px] text-pencil">{waiting ? "Reading password…" : error ?? "Ask the owner for the password."}</span>}
    </div>}
  </div>;
}

type Version = Pick<AppCommit, "id" | "message" | "author" | "at"> & Partial<Pick<AppCommit, "changes">>;
/** `allSites`: Restore puts the version on every site's Preview (an app of more than one site), and says so. */
export function AppVersions({ versions, preview, published, busy, onRestore, whyRestore, allSites = false, children }: { versions: Version[]; preview: string | null; published: string | null; busy?: boolean; onRestore?: (id: string) => void; whyRestore?: (id: string) => string | undefined; allSites?: boolean; children?: ReactNode }) {
  const restore = allSites ? "Restore to preview, all sites" : "Restore to preview";
  return <div data-history className={`${appList} @container`}>
    {versions.map(v => <div key={v.id} data-version={v.id} className={`${appRow} flex-wrap @[600px]:flex-nowrap`}>
      <span className="min-w-0 flex-1 basis-full truncate text-[14px] leading-[18px] @[600px]:basis-0" title={`${v.message}\n${v.id}${v.changes ? `\n${v.changes.added} added, ${v.changes.modified} changed, ${v.changes.deleted} deleted` : ""}`}>{v.message.split("\n")[0] || "No message"}</span>
      <span data-version-tag className="w-[84px] shrink-0 text-[12.5px] font-medium leading-4">{v.id === preview ? "Preview" : v.id === published ? "Published" : ""}</span>
      <span className="hidden w-[120px] shrink-0 truncate text-right text-[12.5px] text-pencil @[600px]:block" title={v.author}>{v.author}</span>
      <span className="w-8 shrink-0 text-right text-[12px] tabular-nums text-pencil" title={new Date(v.at).toLocaleString()}>{ago(v.at)}</span>
      {onRestore && <span data-tip={whyRestore?.(v.id)}><button className={appGhost} disabled={busy || v.id === preview || !!whyRestore?.(v.id)} aria-label={`Restore ${v.message} to preview${allSites ? ", all sites" : ""}`} onClick={() => { if (!whyRestore?.(v.id)) onRestore(v.id); }}>{restore}</button></span>}
    </div>)}
    {children}
  </div>;
}

/**
 * Same review decisions for the owner and members; callers retain their existing request contracts. `updateAlso`: Update
 * preview stays beside Publish (an Admin's page, which has no Technical details line of its own to update it from), so
 * whoever may publish may also rebuild the Preview. "Add a domain" shows only with `onDomain`: without it (a member),
 * Update preview takes its place, or nothing.
 */
export function AppReview({ status, previewUrl, liveUrl, previewAt, publishedAt, versions = [], password, github, destination, busy, whyUpdate, whyPublish, onUpdate, onPublish, onDomain, technical, history, env = "preview", onEnv, publishLine, historyOpen = false, updateAlso = false }: {
  historyOpen?: boolean; publishLine?: string; status: ReviewStatus; previewUrl: string | null; liveUrl: string | null; previewAt: string | null; publishedAt: string | null;
  versions?: Version[]; password?: ReactNode; github?: boolean; destination: string; busy?: boolean; whyUpdate?: string; whyPublish?: string;
  onUpdate?: () => void; onPublish?: (at: string) => Promise<boolean>; onDomain?: () => void;
  technical: ReactNode; history?: ReactNode; env?: "preview" | "prod"; onEnv?: (env: "preview" | "prod") => void; updateAlso?: boolean;
}) {
  const [help, setHelp] = useState(false);
  const [confirm, setConfirm] = useState<{ at: string; note: string; destination: string } | null>(null);
  const [sending, setSending] = useState(false);
  const shown = env === "preview" ? previewAt : publishedAt;
  const change = versions.find(v => v.id === shown);
  // (A domain to add with no way to add one here: Update preview, the one thing that can still be pressed.)
  const noDomainHere = status.action === "connect-domain" && !onDomain;
  const update = status.action === "update-preview" || (!!onUpdate && (!onPublish || noDomainHere));
  const domain = status.action === "connect-domain" && !update;
  const label = update ? "Update preview" : domain ? "Add a domain" : "Publish changes";
  const why = update ? whyUpdate : whyPublish;
  const primary = update ? !!onUpdate : domain ? !!onDomain : !!onPublish;
  const updateBeside = updateAlso && !update && !!onUpdate;
  const url = env === "preview" ? previewUrl : liveUrl;
  const moved = !!confirm && (confirm.at !== previewAt || confirm.destination !== destination);
  const unpublished = hasUnpublishedPreview(status);
  return <div className="@container flex min-w-0 flex-col gap-5" data-review-content>
    <div className="flex flex-wrap items-center gap-3">
      <div role="tablist" aria-label="App view" className={segmented}>{(["preview", "prod"] as const).map(p => <button key={p} role="tab" aria-selected={env === p} data-tip={p === "preview" ? "Review changes here before publishing." : github ? "The version last sent to GitHub. Website deployment is managed there." : "The website your visitors use. Production is the technical name."} onClick={() => { onEnv?.(p); setConfirm(null); }} className={segment(env === p)}>{p === "preview" ? "Preview" : "Live"}</button>)}</div>
      <button className={appGhost} aria-label="About preview and live" aria-expanded={help} onClick={() => setHelp(!help)}><Info {...appIcon}/></button><span className="flex-1"/>
      <span data-review-state className={unpublished ? appAttentionTag : appTag} data-tip={status.sentence}>{reviewLabel(status)}</span>
    </div>
    <Fold lazy open={help}><div data-view-help className="flex flex-col gap-2 rounded-xl bg-desk p-3 text-[13px] leading-[18px]"><p><strong>Preview</strong> is your review copy. Review it before starting a different change; keep editing if you’re improving this one.</p><p><strong>Live</strong> {github ? "shows the version last sent to GitHub. Your website updates through its connected deployment." : "is the website visitors use."}</p></div></Fold>
    <div className="flex flex-col rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        {url ? <a href={url} target="_blank" rel="noreferrer" className={env === "preview" && unpublished && !confirm ? appAttention : appOutline}>{env === "preview" ? unpublished ? "Review preview" : "Open preview" : "Open website"}<ArrowUpRight {...appIcon}/></a> : <span className="text-[13px] text-pencil">{env === "preview" ? "No preview yet" : github ? "Website address not available" : "Not live yet"}</span>}
        {env === "preview" && password}<span className="hidden flex-1 @[512px]:block"/>
        {env === "preview" && updateBeside && <span data-tip={whyUpdate}><button data-review-update className={appOutline} disabled={busy || sending || !!whyUpdate} onClick={() => onUpdate?.()}>Update preview</button></span>}
        {env === "preview" && primary && <span data-tip={why ?? status.sentence}><button data-review-publish className={appPrimary} disabled={busy || sending || !!why || (!status.action && !update)} onClick={() => { if (update) onUpdate?.(); else if (domain) onDomain?.(); else if (previewAt) setConfirm({ at: previewAt, note: change?.message ?? previewAt, destination }); }}>{busy || sending ? "Working…" : label}</button></span>}
      </div>
      <div className="flex items-center gap-3 border-t border-rule px-4 py-4"><span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-[18px]" title={change?.message}>{change?.message.split("\n")[0] ?? (shown ? "Version details unavailable" : "No version here yet")}</span><span className={appTag}>{env === "preview" ? "Preview" : github ? "Sent to GitHub" : "Last published"}</span>{change && <span className="shrink-0 text-[12.5px] text-pencil">{ago(change.at)}</span>}</div>
    </div>
    {confirm && <div data-publish-confirmation><AskInPlace title="Publish this preview?" line={publishLine ?? (github ? "Sends this reviewed version to GitHub. Your connected website may update automatically." : "Makes this reviewed version available on your live website.")} action="Publish changes" cancelLabel="Keep reviewing" busy={sending} disabled={moved || !!whyPublish} onCancel={() => setConfirm(null)} onConfirm={async () => { if (moved || !onPublish) return; setSending(true); try { if (await onPublish(confirm.at)) setConfirm(null); } finally { setSending(false); } }}><div className="flex flex-col gap-1 text-[13px] leading-[18px]"><span className="font-medium">{confirm.note}</span><span className="break-all text-pencil">{confirm.destination}</span>{moved && <span role="alert">The preview or destination changed. Keep reviewing to check it again.</span>}</div></AskInPlace></div>}
    {history && <AppDisclosure title="Version history" initiallyOpen={historyOpen}>{history}</AppDisclosure>}
    <AppDisclosure title="Technical details">{technical}</AppDisclosure>
  </div>;
}
