"use client";

// Static approval mock only. Delete this route before the PR. No publishing or settings requests.
import { useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronRight, Copy, Globe, LayoutGrid, Lock, MessageCircle, Settings } from "lucide-react";
import { Sidebar } from "@/components/app/sidebar";
import { TabBar, type PanelTab } from "@/components/app/panel-tabs";
import { RoundButton, useAppState } from "@/components/app/ui";
import { Fold } from "@/components/app/fold";
import { Switch } from "@/components/app/team-chart";
import { ChatView } from "@/components/app/chat-view";

const noop = () => {};
const icon = { size: 16, strokeWidth: 1.5, 'aria-hidden': true as const };
// Private sibling recipes, unchanged in shape; palette literals resolve to globals.css tokens.
// CRM Add row (crm.tsx); extract with the sibling after mock approval.
const outline = "shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-ink shadow-[0_0_0_1px_#E6E6E3] hover:bg-desk";
const primary = "shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium leading-4 text-paper";
const ghost = "shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-pencil hover:bg-desk hover:text-ink";
// Issues list enclosure and row (orbit-issues.tsx), CRM table's fixed columns.
const list = "flex flex-col overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]";
const row = "flex items-center gap-3 border-b border-rule px-3.5 py-3 hover:bg-desk";
// Sidebar NameInput shape; use the same input/focus edge and the app's tokens.
const field = "h-8 min-w-0 flex-1 rounded-[8px] bg-desk px-2.5 text-[14px] text-ink outline-none placeholder:text-pencil focus:shadow-[0_0_0_1.5px_#0A0A0A]";
const title = "text-[20px] font-semibold leading-6 tracking-[-0.01em]";
const rows = [
  { name: "fourcorners", where: "OrgoAI/orgo-brandlord", kind: "web", action: "Publish to GitHub" },
  { name: "cclc", where: "q4vd9kz2mt8p.orgo.dev", kind: "web", action: "Open preview" },
  { name: "brochure-maker", where: "brochures.fourcorners.travel", kind: "web", action: "Updating preview" },
  { name: "Trip budget", where: "In Bops", kind: "tool", action: "Open" },
  { name: "Brochure checklist", where: "In Bops", kind: "tool", action: "Open" },
];
const versions = [
  { note: "Home line: Pick a project type on the left to get started.", who: "Four Corners", when: "8m", tag: "Preview" },
  { note: "IMPROVING.md: preview first, then Publish to GitHub", who: "Four Corners", when: "1d", tag: "Published" },
  { note: "Agent guide: a route per request kind", who: "Orgo team", when: "3d", tag: "" },
  { note: "Brochure template: photo under the title on covers", who: "Four Corners", when: "4d", tag: "" },
];

type Screen = "home" | "app" | "settings" | "admin";
export default function Mock() {
  const state = useAppState();
  const [screen, setScreen] = useState<Screen>("home");
  const [opened, setOpened] = useState(true);
  const [environment, setEnvironment] = useState("Preview");
  const [chat, setChat] = useState(false);
  const [restored, setRestored] = useState(false);
  const [password, setPassword] = useState(true);
  if (!state || !state.chats[0] || !state.bots[0]) return null;
  const go = (next: Screen) => { setScreen(next); setChat(false); };
  const tabs: PanelTab[] = [{id:"apps",kind:"made-apps",ws:"ws_main"}, ...(screen === "app" || screen === "settings" ? [{id:"site",kind:"hosted-app" as const,ws:"ws_main",name:"fourcorners"}] : [])];
  const versionsList = <div className={list} data-mock-versions>
    {versions.map((v,i) => <div key={v.note} className={row} data-mock-version>
      <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px]" title={v.note}>{v.note}</span>
      <span data-mock-tag className="w-[84px] shrink-0 text-[12.5px] font-medium leading-4">{restored ? (i === 2 ? 'Preview' : i === 1 ? 'Published' : '') : v.tag}</span>
      <span className="w-[120px] shrink-0 truncate text-right text-[12.5px] leading-4 text-pencil" title={v.who}>{v.who}</span>
      <span className="w-8 shrink-0 text-right text-[12px] tabular-nums leading-4 text-pencil">{v.when}</span>
      <button className={ghost + " w-[84px]"} disabled={i === (restored ? 2 : 0)} onClick={() => setRestored(true)} style={{visibility:i === (restored ? 2 : 0) ? 'hidden' : undefined}}>Restore</button>
    </div>)}
  </div>;
  const environments = <div className={list} data-mock-environments>
    <div className={row}>
      <span className="w-[84px] shrink-0 text-[14px] font-medium leading-[18px]">Published</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-[14px] leading-[18px]">OrgoAI/orgo-brandlord</span><span className="truncate text-[12.5px] leading-[17px] text-pencil">main · formula/</span></div>
      <span className="min-w-0 max-w-[180px] truncate text-[12.5px] text-pencil">Preview first, then Publish</span>
      <button className={ghost} aria-label="Open published app"><ArrowUpRight {...icon}/></button>
    </div>
    <div className={row}>
      <span className="w-[84px] shrink-0 text-[14px] font-medium leading-[18px]">Preview</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-[14px] leading-[18px]">ggn7sjpkwnz8.orgo.dev</span><span className="flex items-center gap-1.5 text-[12.5px] leading-[17px] text-pencil"><Lock {...icon}/>Password<button className="flex items-center" aria-label="Copy preview password"><Copy {...icon}/></button></span></div>
      <button className={primary}>Publish to GitHub</button>
      <button className={ghost} aria-label="Open preview"><ArrowUpRight {...icon}/></button>
    </div>
    {screen !== "admin" && <div className={row}>
      <span className="w-[84px] shrink-0 text-[14px] font-medium leading-[18px]">Local</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-[14px] leading-[18px]">Boppy</span><span className="text-[12.5px] leading-[17px] text-pencil">Stopped</span></div>
      <button className={outline}>Start</button>
    </div>}
  </div>;
  return <div className="flex h-screen flex-col overflow-hidden bg-paper font-sans text-ink antialiased" data-mock-screen={screen}>
    <div className="flex h-11 shrink-0 border-b border-rule bg-desk">
      <div className="w-[340px] shrink-0"/>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3.5"><TabBar state={state} tabs={tabs} active={screen === 'app' || screen === 'settings' ? 'site' : 'apps'} chatBotId={state.bots[0].id} onPick={id => id === 'apps' && go('home')} onClose={() => go('home')} onNew={noop}/></div>
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="flex shrink-0 bg-desk"><Sidebar state={state} chatId={state.chats[0].id} footer="apps" onOpenChat={noop} onOpenThread={noop} onCompose={noop} onSettings={noop} onAccount={noop} onSetup={noop} onVault={noop} onApps={() => go('home')} onTeam={noop} onOpenWatch={noop} onOpenMemory={noop} onOpenAutopilot={noop}/></div>
      {chat && <div className="flex min-w-0 flex-1"><ChatView state={state} chat={state.chats[0]} wide={false} onOpenThread={noop} onShowBot={noop} onShowMac={noop} onShowScreen={noop} call={null} onCall={noop} callSlot={noop}/></div>}
      <main className="flex min-w-0 flex-1 flex-col gap-6 overflow-auto px-8 py-8">
        {(screen === 'home' || screen === 'admin') && <>
          <header className="flex items-center justify-between gap-3"><h1 className="text-[26px] font-bold leading-8 tracking-[-0.025em]">Your Apps</h1>{screen === 'home' && <button className={outline}>Add app</button>}</header>
          <div className={list} data-mock-list>
            {rows.filter(r => screen !== 'admin' || r.kind === 'web').map((r,i) => <div key={r.name}>
              <div className={row} data-mock-row>
                <button aria-label={`Open ${r.name}`} aria-expanded={screen === 'admin' && i === 0 ? opened : undefined} className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => screen === 'admin' ? setOpened(!opened) : go('app')}>
                  <span className="text-pencil">{screen === 'admin' && i === 0 ? (opened ? <ChevronDown {...icon}/> : <ChevronRight {...icon}/>) : r.kind === 'web' ? <Globe {...icon}/> : <LayoutGrid {...icon}/>}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-[14px] font-medium leading-[18px]">{r.name}</span><span className="truncate text-[12.5px] leading-[17px] text-pencil">{r.where}</span></span>
                </button>
                {screen === 'admin' && i === 0 && opened ? null : r.action === 'Updating preview' ? <span className="px-3 text-[12.5px] text-pencil">{r.action}</span> : <button className={i===0 ? primary : outline}>{r.action}</button>}
              </div>
              {screen === 'admin' && i === 0 && <Fold open={opened}><div className="flex flex-col gap-5 border-b border-rule bg-paper px-4 py-4">{environments}<h2 className="text-[14px] font-semibold leading-5">Versions</h2>{versionsList}<button className={ghost + " self-start"} onClick={() => go('settings')}>Settings</button></div></Fold>}
            </div>)}
          </div>
        </>}
        {(screen === 'app' || screen === 'settings') && <>
          <header className="flex items-center gap-3">
            <RoundButton label="Back to Your Apps" onClick={() => go('home')}><ArrowLeft {...icon}/></RoundButton>
            <h1 className={title + " min-w-0 flex-1 truncate"}>fourcorners{screen === 'settings' && <span className="font-normal text-pencil"> / Settings</span>}</h1>
            <button className={outline + " flex items-center gap-1.5"} onClick={() => setChat(!chat)}><MessageCircle {...icon}/>Ask Boppy</button>
            <RoundButton label={screen === 'settings' ? 'Back to app' : 'Settings'} onClick={() => go(screen === 'settings' ? 'app' : 'settings')} active={screen === 'settings'}><Settings {...icon}/></RoundButton>
          </header>
          {screen === 'app' && <>{environments}<div className="flex items-center justify-between"><h2 className="text-[14px] font-semibold leading-5">Versions</h2><button className={outline}>Update preview</button></div>{versionsList}</>}
          {screen === 'settings' && <>
            {/* CRM's Bar/Line picker; only the labels change. */}
            <div className="flex self-start gap-0.5 rounded-full bg-desk p-[3px]" role="tablist" aria-label="Environment">
              {['Local','Preview','Published'].map(e => <button role="tab" aria-selected={environment===e} key={e} onClick={() => setEnvironment(e)} className={`rounded-full px-2.5 py-1 text-[12px] leading-4 ${environment===e ? 'bg-paper text-ink shadow-[0_0_0_1px_#0000000F]' : 'text-pencil hover:text-ink'}`}>{e}</button>)}
            </div>
            <div className="flex max-w-[560px] flex-col gap-6">
              <div className="flex flex-col gap-3"><h2 className="text-[14px] font-semibold leading-5">Commands</h2>{[['Port','3000'],['Install','npm ci'],['Build','npm run build'],['Start','npm start']].map(([label,value]) => <label key={label} className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-2 text-[13px] text-pencil"><span>{label}</span><input className={field} defaultValue={value}/></label>)}<button className={primary+' self-end'}>Save</button></div>
              <div className="flex flex-col gap-3 border-t border-rule pt-4"><h2 className="text-[14px] font-semibold leading-5">Password</h2><Switch label="Protect preview" on={password} onFlip={setPassword}/><span className="flex items-center gap-3 text-[14px]">Kw7mQ2p<button className={ghost} aria-label="Copy password"><Copy {...icon}/></button></span></div>
              <div className="flex flex-col gap-3 border-t border-rule pt-4"><h2 className="text-[14px] font-semibold leading-5">Variables</h2><div className={row}><span className="flex-1 text-[13px]">DATABASE_URL</span><button className={ghost}>Edit</button></div><button className={outline+' self-start'}>Add variable</button></div>
            </div>
          </>}
        </>}
      </main>
    </div>
    {/* Mock navigation is kept outside the product content, hidden for all delivered screenshots. */}
    <nav data-mock-navigation className="fixed bottom-3 right-3 flex gap-2 rounded-full bg-desk p-2">
      {(['home','app','settings','admin'] as const).map(s => <button key={s} data-mock-go={s} onClick={() => go(s)} className={ghost}>{s}</button>)}
    </nav>
  </div>;
}
