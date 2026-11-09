"use client";

// Approval prototype only. Every mutation below changes this page's sample state, never a workspace.
import { useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Globe, Info, LayoutGrid, Lock } from "lucide-react";
import { Sidebar } from "@/components/app/sidebar";
import { TabBar, type PanelTab } from "@/components/app/panel-tabs";
import { AskInPlace, RoundButton, useAppState } from "@/components/app/ui";
import { Fold } from "@/components/app/fold";
import { Switch } from "@/components/app/team-chart";
import { ChatView } from "@/components/app/chat-view";
import { TooltipLayer } from "@/components/app/tooltip";
import { useDismiss } from "@/components/app/new-thread";

const noop = () => {};
const icon = { size: 16, strokeWidth: 1.5, "aria-hidden": true as const };
// The private CRM/Issues/Sidebar recipes remain mock-only until approval permits a shared extraction.
const outline = "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-desk";
const primary = "inline-flex shrink-0 items-center justify-center rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium leading-4 text-paper disabled:bg-desk disabled:text-pencil";
const ghost = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-pencil hover:bg-desk hover:text-ink";
const list = "flex flex-col overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]";
const row = "flex items-center gap-3 border-b border-rule px-3.5 py-3 hover:bg-desk";
const field = "h-8 min-w-0 flex-1 rounded-[8px] bg-desk px-2.5 text-[14px] text-ink outline-none placeholder:text-pencil focus:shadow-[0_0_0_1.5px_#0A0A0A]";
const tag = "shrink-0 rounded-full bg-desk px-2.5 py-1 text-[12px] font-medium leading-4 text-ink";
const versions = [
  { note: "Updated the home page introduction", raw: "Home line: Pick a project type on the left to get started.", who: "Four Corners", when: "8m", id: "a1a1a1a" },
  { note: "Improved the publishing instructions", raw: "IMPROVING.md: preview first, then Publish to GitHub", who: "Four Corners", when: "1d", id: "b2b2b2b" },
  { note: "Updated the agent guide", raw: "Agent guide: a route per request kind", who: "Orgo team", when: "3d", id: "c3c3c3c" },
  { note: "Updated the brochure cover", raw: "Brochure template: photo under the title on covers", who: "Four Corners", when: "4d", id: "d4d4d4d" },
];
const apps = [
  { name: "fourcorners", where: "fourcorners.brandlord.agency", kind: "web", status: "1 unpublished", action: "Review changes" },
  { name: "cclc", where: "q4vd9kz2mt8p.orgo.dev", kind: "web", status: "Not live", action: "Open preview" },
  { name: "brochure-maker", where: "brochures.fourcorners.travel", kind: "web", status: "Updating preview", action: "" },
  { name: "Trip budget", where: "In Bops", kind: "tool", status: "", action: "Open" },
  { name: "Brochure checklist", where: "In Bops", kind: "tool", status: "", action: "Open" },
];
type Screen = "home" | "app" | "settings" | "admin";
type Stage = "ready" | "current" | "behind";

export default function Mock() {
  const state = useAppState();
  const [screen, setScreen] = useState<Screen>("home");
  const [opened, setOpened] = useState(true);
  const [place, setPlace] = useState("Preview");
  const [stage, setStage] = useState<Stage>("ready");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [publishedVersion, setPublishedVersion] = useState(1);
  const [history, setHistory] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [help, setHelp] = useState(false);
  const [chat, setChat] = useState(false);
  const [protectedPreview, setProtectedPreview] = useState(true);
  const [notice, setNotice] = useState("");
  const [localRunning, setLocalRunning] = useState(false);
  const passwordBox = useRef<HTMLDivElement>(null);
  const passwordButton = useRef<HTMLButtonElement>(null);
  useDismiss(showPassword, () => { setShowPassword(false); passwordButton.current?.focus(); }, passwordBox);
  if (!state || !state.chats[0] || !state.bots[0]) return null;
  const admin = screen === "admin";
  const pending = stage !== "current";
  const go = (next: Screen) => {
    setScreen(next); setPlace("Preview"); setPublishing(false); setShowPassword(false);
    setTechnical(false); setHistory(false); setChat(false); setHelp(false); setNotice("");
  };
  const tabs: PanelTab[] = [{ id: "apps", kind: "made-apps", ws: "ws_main" }, ...(screen === "app" || screen === "settings" ? [{ id: "site", kind: "hosted-app" as const, ws: "ws_main", name: "fourcorners" }] : [])];
  const openPreview = <a href="/your-apps-v4/preview" target="_blank" rel="noreferrer" className={outline}>Open preview<ArrowUpRight {...icon}/></a>;
  const publishLabel = stage === "behind" ? "Update preview" : "Publish changes";
  const change = versions[place === "Live" ? publishedVersion : previewVersion];
  const restore = (n: number) => {
    setPreviewVersion(n); setStage(n === publishedVersion ? "current" : "ready");
    setPlace("Preview"); setPublishing(false); setNotice("Restored to preview");
  };

  const appContent = <div className="flex min-w-0 flex-col gap-5" data-review-content>
    <div className="flex flex-wrap items-center gap-3">
      {/* CRM's Bar/Line segmented picker, with the two decisions people need here. */}
      <div role="tablist" aria-label="App view" className="flex gap-0.5 rounded-full bg-desk p-[3px]">
        {["Preview", "Live"].map(p => <button key={p} role="tab" aria-selected={place === p} data-tip={p === "Preview" ? "Review changes here before publishing. A password protects this copy." : "The website your visitors use. Production is the technical name."} onClick={() => { setPlace(p); setPublishing(false); setShowPassword(false); setNotice(""); }} className={`rounded-full px-2.5 py-1 text-[12px] leading-4 ${place === p ? "bg-paper font-medium text-ink shadow-[0_0_0_1px_#0000000F]" : "text-pencil hover:text-ink"}`}>{p}</button>)}
      </div>
      <button className={ghost} aria-label="About preview and live" aria-expanded={help} onClick={() => setHelp(!help)}><Info {...icon}/></button>
      <span className="flex-1"/>
      <span data-review-state className={tag}>{stage === "behind" ? "Preview needs updating" : pending ? "1 unpublished change" : "Up to date"}</span>
    </div>
    <Fold lazy open={help}><div className="flex flex-col gap-2 rounded-xl bg-desk p-3 text-[13px] leading-[18px]" data-view-help>
      <p><strong>Preview</strong> is your private review copy.</p><p><strong>Live</strong> is the website visitors use.</p>
    </div></Fold>
    <div className="flex flex-col rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        {place === "Preview" ? openPreview : <a href="/your-apps-v4/preview?view=live" target="_blank" rel="noreferrer" className={outline}>Open website<ArrowUpRight {...icon}/></a>}
        {place === "Preview" && <div className="relative" ref={passwordBox}>
          <button ref={passwordButton} className={outline} onClick={() => setShowPassword(!showPassword)} aria-expanded={showPassword}><Lock {...icon}/>{showPassword ? "Hide password" : "Show password"}</button>
          {showPassword && <div role="dialog" aria-label="Preview password" data-password-popover className="absolute left-0 top-[calc(100%+6px)] z-30 flex w-[240px] flex-col gap-3 rounded-[12px] bg-paper p-3 shadow-[0_0_0_1px_#0000000F,0_12px_32px_-12px_#00000040]">
            <span className="select-all text-[14px] font-medium" data-preview-password>Kw7mQ2p</span>
            <button className={outline+" w-full"} onClick={() => void navigator.clipboard.writeText("Kw7mQ2p").then(() => setCopied(true))}>{copied ? <Check {...icon}/> : <Copy {...icon}/>}{copied ? "Copied" : "Copy password"}</button>
          </div>}
        </div>}
        <span className="flex-1"/>
        {place === "Preview" && <button data-review-publish className={primary} disabled={!pending || publishing} data-tip={stage === "behind" ? "Put Boppy's latest saved work on the private preview first." : pending ? "Review this version, then choose where to publish it." : "This preview has already been published."} onClick={() => { if (stage === "behind") { setStage("ready"); setPreviewVersion(0); } else { setPublishing(true); setShowPassword(false); } }}>{publishLabel}</button>}
      </div>
      <div className="flex items-center gap-3 border-t border-rule px-4 py-4">
        <span className="min-w-0 flex-1 text-[14px] font-medium leading-[18px]">{change.note}</span>
        <span className={tag}>{place === "Preview" ? "Preview" : "Last published"}</span>
        <span className="shrink-0 text-[12.5px] text-pencil">{change.when}</span>
      </div>
    </div>
    {publishing && <div data-publish-confirmation><AskInPlace title="Publish this preview?" line="Sends this reviewed version to GitHub. Your connected website may update automatically." action="Publish changes" cancelLabel="Keep reviewing" onCancel={() => setPublishing(false)} onConfirm={() => { setPublishedVersion(previewVersion); setStage("current"); setPublishing(false); setNotice("Preview sent to GitHub"); }}>
      <div className="flex flex-col gap-1 text-[13px] leading-[18px]"><span className="font-medium">{versions[previewVersion].note}</span><span className="break-all text-pencil">OrgoAI/orgo-brandlord · main · formula/</span></div>
    </AskInPlace></div>}
    {notice && <span role="status" className="text-[13px] leading-[18px] text-pencil">{notice}</span>}
    <div className="flex flex-wrap items-center gap-2">
      <button className={ghost} aria-expanded={history} onClick={() => setHistory(!history)}>{history ? <ChevronDown {...icon}/> : <ChevronRight {...icon}/>}Version history</button>
      <button className={ghost} aria-expanded={technical} onClick={() => setTechnical(!technical)}>{technical ? <ChevronDown {...icon}/> : <ChevronRight {...icon}/>}Technical details</button>
    </div>
    <Fold lazy open={history}><div className={list} data-mock-versions>
      {versions.map((v,i) => <div key={v.id} className={row} data-mock-version>
        <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px]" title={v.raw}>{v.note}</span>
        <span data-mock-tag className="w-[84px] shrink-0 text-[12.5px] font-medium leading-4">{i === previewVersion ? "Preview" : i === publishedVersion ? "Published" : ""}</span>
        <span className="w-[120px] shrink-0 truncate text-right text-[12.5px] text-pencil" title={v.who}>{v.who}</span><span className="w-8 shrink-0 text-right text-[12px] tabular-nums text-pencil">{v.when}</span>
        <button className={ghost} disabled={i === previewVersion} aria-label={`Restore ${v.note} to preview`} onClick={() => restore(i)}>Restore to preview</button>
      </div>)}
    </div></Fold>
    <Fold lazy open={technical}><div className="flex flex-col gap-4 rounded-xl bg-desk p-4 text-[13px] leading-[18px]" data-technical-details>
      <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-3 gap-y-2"><dt className="text-pencil">Preview URL</dt><dd className="break-all">ggn7sjpkwnz8.orgo.dev</dd><dt className="text-pencil">Version</dt><dd>{versions[previewVersion].id}</dd><dt className="text-pencil">Publish to</dt><dd className="break-all">GitHub · OrgoAI/orgo-brandlord · main · formula/</dd></dl>
      {!admin && !state.shared && <div className="flex flex-col gap-3 border-t border-rule pt-4" data-local-details><div className="flex items-center gap-3"><span className="flex-1 font-medium">Boppy&apos;s working copy (Local)</span><span className="text-pencil">{localRunning ? "Running" : "Stopped"}</span><button className={outline} onClick={() => setLocalRunning(!localRunning)}>{localRunning ? "Stop" : "Start"}</button></div><p className="text-pencil">Boppy builds here. Update preview creates the separate copy you review.</p></div>}
    </div></Fold>
  </div>;

  return <div className="flex h-screen flex-col overflow-hidden bg-paper font-sans text-ink antialiased" data-mock-screen={screen}>
    <TooltipLayer/>
    <div className="flex h-11 shrink-0 border-b border-rule bg-desk"><div className="w-[340px] shrink-0"/><div className="flex min-w-0 flex-1 items-center gap-2 px-3.5"><TabBar state={state} tabs={tabs} active={screen === "app" || screen === "settings" ? "site" : "apps"} chatBotId={state.bots[0].id} onPick={id => id === "apps" && go("home")} onClose={() => go("home")} onNew={noop}/></div></div>
    <div className="flex min-h-0 flex-1">
      <div className="flex shrink-0 bg-desk"><Sidebar state={state} chatId={state.chats[0].id} footer="apps" onOpenChat={noop} onOpenThread={noop} onCompose={noop} onSettings={noop} onAccount={noop} onSetup={noop} onVault={noop} onApps={() => go("home")} onTeam={noop} onOpenWatch={noop} onOpenMemory={noop} onOpenAutopilot={noop}/></div>
      {chat && <div className="flex min-w-0 flex-1"><ChatView state={state} chat={state.chats[0]} wide={false} onOpenThread={noop} onShowBot={noop} onShowMac={noop} onShowScreen={noop} call={null} onCall={noop} callSlot={noop}/></div>}
      <main className="flex min-w-0 flex-1 flex-col gap-6 overflow-auto px-8 py-8">
        {(screen === "home" || admin) && <><header className="flex items-center justify-between gap-3"><h1 className="text-[26px] font-bold leading-8 tracking-[-0.025em]">Your Apps</h1>{!admin && <button className={outline}>Add app</button>}</header>
          <div className={list} data-mock-list>{apps.filter(a => !admin || a.kind === "web").map((a,i) => <div key={a.name}>
            <div className={row} data-mock-row>
              <button aria-label={`Open ${a.name}`} aria-expanded={admin && i === 0 ? opened : undefined} className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => admin ? setOpened(!opened) : go("app")}>
                <span className="text-pencil">{admin && i === 0 ? opened ? <ChevronDown {...icon}/> : <ChevronRight {...icon}/> : a.kind === "web" ? <Globe {...icon}/> : <LayoutGrid {...icon}/>}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-[14px] font-medium leading-[18px]">{a.name}</span><span className="truncate text-[12.5px] leading-[17px] text-pencil">{a.where}</span></span>
              </button>
              <span className="w-[120px] shrink-0 text-right text-[12px] text-pencil">{admin && i === 0 && opened ? "" : i === 0 ? stage === "current" ? "Up to date" : stage === "behind" ? "Preview needs updating" : "1 unpublished" : a.status}</span>
              <span className="flex w-[120px] shrink-0 justify-end">{a.action && !(admin && i === 0 && opened) && (i === 0 ? <button className={outline} onClick={() => admin ? setOpened(true) : go("app")}>{stage === "current" ? "Open app" : "Review changes"}</button> : <a className={outline} href={`/your-apps-v4/preview?app=${encodeURIComponent(a.name)}`} target="_blank" rel="noreferrer">{a.action}</a>)}</span>
            </div>
            {admin && i === 0 && <Fold open={opened}><div className="flex min-w-0 flex-col gap-5 border-b border-rule px-4 py-4">{appContent}<button className={ghost+" self-start"} onClick={() => go("settings")}>Settings</button></div></Fold>}
          </div>)}</div>
        </>}
        {(screen === "app" || screen === "settings") && <><header className="flex flex-wrap items-center gap-3"><RoundButton label="Back to Your Apps" onClick={() => go("home")}><ArrowLeft {...icon}/></RoundButton><h1 className="min-w-0 flex-1 text-[20px] font-semibold leading-6 tracking-[-0.01em]">fourcorners{screen === "settings" && <span className="font-normal text-pencil"> / Settings</span>}</h1><button className={ghost} onClick={() => setChat(!chat)}>Ask Boppy</button><button className={outline} onClick={() => go(screen === "settings" ? "app" : "settings")}>{screen === "settings" ? "Back to app" : "Settings"}</button></header>
          {screen === "app" ? appContent : <div className="flex max-w-[560px] flex-col gap-6">
            <Switch label="Protect preview with a password" on={protectedPreview} onFlip={setProtectedPreview}/>
            <button className={ghost+" self-start"} aria-expanded={technical} onClick={() => setTechnical(!technical)}>{technical ? <ChevronDown {...icon}/> : <ChevronRight {...icon}/>}Technical settings</button>
            <Fold lazy open={technical}><div className="flex flex-col gap-3" data-technical-settings>{[["Port","3000"],["Install","npm ci"],["Build","npm run build"],["Start","npm start"]].map(([label,value]) => <label key={label} className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-2 text-[13px] text-pencil"><span>{label}</span><input className={field} defaultValue={value}/></label>)}<button className={primary+" self-end"}>Save</button></div></Fold>
          </div>}
        </>}
      </main>
    </div>
    <nav data-mock-navigation className="fixed bottom-3 right-3 flex gap-2 rounded-full bg-desk p-2">{(["home","app","settings","admin"] as const).map(s => <button key={s} data-mock-go={s} onClick={() => go(s)} className={ghost}>{s}</button>)}<button data-mock-stage="current" className={ghost} onClick={() => { setPublishedVersion(previewVersion); setStage("current"); }}>Current</button><button data-mock-stage="behind" className={ghost} onClick={() => { setStage("behind"); setPreviewVersion(1); }}>Behind</button><button data-mock-stage="ready" className={ghost} onClick={() => { setStage("ready"); setPreviewVersion(0); setPublishedVersion(1); }}>Ready</button></nav>
  </div>;
}
