"use client";

// Temporary look-only gallery. These are the shipped siblings, not new versions of them.
import { useState } from "react";
import { Sidebar } from "@/components/app/sidebar";
import { TabBar } from "@/components/app/panel-tabs";
import { ChatView } from "@/components/app/chat-view";
import { ComputerView } from "@/components/app/computer";
import { CrmView } from "@/components/app/crm";
import { IssuesPage } from "@/components/app/orbit-issues";
import { TeamChart } from "@/components/app/team-chart";
import { useAppState } from "@/components/app/ui";

const noop = () => {};
export default function References() {
  const state = useAppState();
  const [screen, setScreen] = useState("chat");
  if (!state || !state.chats[0] || !state.bots[0]) return null;
  return <div className="flex h-screen flex-col bg-paper font-sans text-ink">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-rule bg-desk px-4">
      <TabBar state={state} tabs={[]} active="chat" chatBotId={state.bots[0].id} onPick={noop} onClose={noop} onNew={noop} />
      {['chat','computer','crm','issues','team'].map(s => <button key={s} data-reference={s} onClick={() => setScreen(s)} className="rounded-full px-3 py-1 text-[13px] hover:bg-paper">{s}</button>)}
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="flex bg-desk"><Sidebar state={state} chatId={state.chats[0].id} onOpenChat={noop} onOpenThread={noop} onCompose={noop} onSettings={noop} onAccount={noop} onSetup={noop} onVault={noop} onApps={noop} onTeam={noop} onOpenWatch={noop} onOpenMemory={noop} onOpenAutopilot={noop} /></div>
      <div className="flex min-w-0 flex-1">
        {screen === 'chat' && <ChatView state={state} chat={state.chats[0]} wide onOpenThread={noop} onShowBot={noop} onShowMac={noop} onShowScreen={noop} call={null} onCall={noop} callSlot={noop} />}
        {screen === 'computer' && <ComputerView state={state} bot={state.bots[0]} display={100} onDisplay={noop} mode="panel" />}
        {screen === 'crm' && <CrmView state={state} ws="ws_main" file="Sample pipeline" mode="focus" onClose={noop} />}
        {screen === 'issues' && <IssuesPage ws="ws_main" nav={null} onClose={noop} />}
        {screen === 'team' && <TeamChart state={state} people={[]} />}
      </div>
    </div>
  </div>;
}
