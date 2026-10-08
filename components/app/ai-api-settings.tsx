"use client";

import { useEffect, useState } from "react";

type AiApiInfo = {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  sessionModel: string;
  hardModel: string;
  allowCloudExecutors: boolean;
  blockBopsCloud: boolean;
  hasKey: boolean;
  privacy: "direct";
  error?: string;
  tested?: { ok: boolean; models?: number };
};

export function AiApiSettings() {
  const [info, setInfo] = useState<AiApiInfo | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const load = () =>
    fetch("/api/ai", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: AiApiInfo) => setInfo(j));
  useEffect(() => {
    void load();
  }, []);
  if (!info) return null;

  const change = <K extends keyof AiApiInfo>(name: K, value: AiApiInfo[K]) => setInfo({ ...info, [name]: value });
  const save = async (test = false) => {
    setBusy(true);
    setNote("");
    try {
      const body = {
        enabled: info.enabled,
        baseUrl: info.baseUrl,
        chatModel: info.chatModel,
        sessionModel: info.sessionModel,
        hardModel: info.hardModel,
        allowCloudExecutors: info.allowCloudExecutors,
        blockBopsCloud: info.blockBopsCloud,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        test,
      };
      const res = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json()) as AiApiInfo;
      setInfo({ ...info, ...j });
      if (!res.ok) throw new Error(j.error || "Couldn't save AI API settings.");
      setKey("");
      setNote(test ? `Connected directly${j.tested?.models !== undefined ? ` · ${j.tested.models} models visible` : ""}` : "Saved");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    const res = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clearKey: true, enabled: false }) });
    const j = (await res.json()) as AiApiInfo;
    setInfo({ ...info, ...j });
    setKey("");
    setNote(res.ok ? "Local API key removed" : j.error || "Couldn't remove the key.");
    setBusy(false);
  };
  const input = "h-8 min-w-0 flex-1 rounded-[9px] bg-[#F7F7F6] px-2.5 text-[12.5px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold">AI API</span>
          <span className="text-[12px] leading-4 text-[#6B6B6B]">Use your own API directly instead of Bops Cloud for AI prompts and model outputs.</span>
        </div>
        <button
          onClick={() => change("enabled", !info.enabled)}
          className={`relative h-6 w-11 rounded-full transition-colors ${info.enabled ? "bg-ink" : "bg-[#D7D7D3]"}`}
          aria-label="Use my own AI API"
        >
          <span className={`absolute top-1 size-4 rounded-full bg-white transition-all ${info.enabled ? "left-6" : "left-1"}`} />
        </button>
      </div>
      <div className="flex flex-col gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
        <div className="flex items-start gap-2 rounded-[10px] bg-[#F5F7F2] px-3 py-2 text-[12px] leading-[17px] text-[#3A3A38]">
          <span className="mt-1 size-2 shrink-0 rounded-full bg-[#2BB673]" />
          <span><b>Direct AI.</b> Your AI requests go from this PC to the API URL below. The chosen AI provider still receives what you send to its models. Turn on strict privacy below to block Bops Cloud completely.</span>
        </div>
        <label className="flex items-center gap-3">
          <span className="w-[122px] shrink-0 text-[12.5px] font-medium">API URL</span>
          <input value={info.baseUrl} onChange={(e) => change("baseUrl", e.target.value)} placeholder="https://api.openai.com/v1" className={input} />
        </label>
        <label className="flex items-center gap-3">
          <span className="w-[122px] shrink-0 text-[12.5px] font-medium">API key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={info.hasKey ? "Saved securely on this PC" : "sk-…"} autoComplete="off" className={input} />
          {info.hasKey && <button disabled={busy} onClick={() => void clear()} className="text-[12px] font-medium text-[#B42318]">Remove</button>}
        </label>
        <div className="grid grid-cols-[122px_1fr] items-center gap-x-3 gap-y-2">
          <span className="text-[12.5px] font-medium">Fast chat model</span>
          <input value={info.chatModel} onChange={(e) => change("chatModel", e.target.value)} className={input} />
          <span className="text-[12.5px] font-medium">Task model</span>
          <input value={info.sessionModel} onChange={(e) => change("sessionModel", e.target.value)} className={input} />
          <span className="text-[12.5px] font-medium">Hard-task model</span>
          <input value={info.hardModel} onChange={(e) => change("hardModel", e.target.value)} className={input} />
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 border-t border-[#F0F0EE] pt-3">
          <input type="checkbox" checked={info.blockBopsCloud} onChange={(e) => change("blockBopsCloud", e.target.checked)} className="mt-0.5" />
          <span className="flex flex-col">
            <span className="text-[12.5px] font-medium">Strict privacy: block Bops Cloud</span>
            <span className="text-[11.5px] leading-4 text-[#6B6B6B]">Recommended for no Bops data sharing. Disables Bops Cloud AI proxies, state backup and webhook tunnel. Hosted Composio, Honcho, phone and similar cloud-backed services will be unavailable unless you self-host their keys.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 border-t border-[#F0F0EE] pt-3">
          <input type="checkbox" checked={info.allowCloudExecutors} onChange={(e) => change("allowCloudExecutors", e.target.checked)} className="mt-0.5" />
          <span className="flex flex-col">
            <span className="text-[12.5px] font-medium">Allow my API key on my Orgo cloud computers</span>
            <span className="text-[11.5px] leading-4 text-[#6B6B6B]">Off by default for maximum privacy. Turn it on only if you want cloud-computer agent tasks; Bops copies the key to your Orgo VM for that task runtime.</span>
          </span>
        </label>
        <span className="text-[11.5px] leading-4 text-[#6B6B6B]">OpenAI works with all Bops AI features. A custom URL must implement the OpenAI Responses API; long-running cloud threads also require compatible Agents APIs.</span>
        <div className="flex items-center gap-2">
          <button disabled={busy} onClick={() => void save(true)} className="rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50">
            {busy ? "Checking…" : "Save & test"}
          </button>
          <button disabled={busy} onClick={() => void save(false)} className="rounded-full bg-[#F2F2F0] px-3.5 py-1.5 text-[12.5px] font-medium disabled:opacity-50">Save</button>
          {note && <span className={`text-[12px] ${/couldn|error|returned|check|no api/i.test(note) ? "text-[#B42318]" : "text-[#2C6E49]"}`}>{note}</span>}
        </div>
      </div>
    </div>
  );
}

