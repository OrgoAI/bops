"use client";

import { useEffect, useState } from "react";
import type { Person } from "@/lib/types";
import { PersonAvatar, post } from "./ui";

/*
 * Starting a conversation with people on Bops (lib/server/people.ts), from the To picker: anyone you've
 * talked with before, or someone by their email. One person makes a direct message; two or more, a
 * group you can name. An email that isn't on Bops yet is asked in, and joins when they sign up with it.
 */

type Pick = { userId?: string; email?: string; name: string; onBops: boolean };

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export function NewPeopleChat({ onOpenChat, onBack }: { onOpenChat: (chatId: string) => void; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [known, setKnown] = useState<Person[]>([]);
  const [picked, setPicked] = useState<Pick[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void fetch("/api/people")
      .then((r) => r.json())
      .then((j: { people?: Person[] }) => !stop && setKnown(j.people ?? []))
      .catch(() => {});
    return () => void (stop = true);
  }, []);

  const q = query.trim().toLowerCase();
  const already = (p: { userId?: string; email?: string | null }) => picked.some((x) => (p.userId && x.userId === p.userId) || (!!p.email && x.email === p.email.toLowerCase()));
  const matches = known.filter((p) => !already(p) && (!q || `${p.name ?? ""} ${p.email ?? ""}`.toLowerCase().includes(q))).slice(0, 6);
  const typedEmail = isEmail(q) && !known.some((p) => p.email?.toLowerCase() === q) && !already({ email: q }) ? q : null;

  const add = (p: Pick) => {
    setPicked([...picked, p]);
    setQuery("");
    setError(null);
  };
  // Someone by email: found on Bops (their name), or asked in.
  const addEmail = async (email: string) => {
    setBusy(true);
    const r = await fetch("/api/people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "find", email }) })
      .then((x) => x.json())
      .catch(() => ({ error: "Couldn't reach Bops Cloud." }));
    setBusy(false);
    const res = r as { person?: Person | null; error?: string };
    if (res.error) return setError(res.error);
    add(res.person ? { userId: res.person.userId, email, name: res.person.name ?? email, onBops: true } : { email, name: email, onBops: false });
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await post("/api/people", {
      action: "start",
      userIds: picked.filter((p) => p.userId).map((p) => p.userId),
      emails: picked.filter((p) => !p.userId).map((p) => p.email),
      title: picked.length > 1 ? title.trim() || undefined : undefined,
    });
    const j = (await r.json().catch(() => ({}))) as { chatId?: string; error?: string };
    setBusy(false);
    if (j.chatId) onOpenChat(j.chatId);
    else setError(j.error ?? "Couldn't start it. Try again.");
  };

  return (
    <div className="flex flex-col gap-3 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">Message someone</span>
        <button onClick={onBack} className="text-[12px] text-[#6B6B6B] hover:text-ink">
          Back
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-[14px] px-2.5 py-2 shadow-[0_0_0_1.5px_#0A0A0A]">
        {picked.map((p) => (
          <button
            key={p.userId ?? p.email}
            onClick={() => setPicked(picked.filter((x) => x !== p))}
            title={p.onBops ? "Remove" : "Not on Bops yet: they'll join when they sign up with this email. Remove"}
            className={`flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[13px] ${p.onBops ? "bg-[#F2F2F0]" : "bg-white shadow-[0_0_0_1px_#E2E2DF]"}`}
          >
            <PersonAvatar person={{ userId: p.userId ?? p.email ?? p.name, name: p.name, email: p.email }} size={20} />
            {p.name} ×
          </button>
        ))}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typedEmail) void addEmail(typedEmail);
            else if (e.key === "Enter" && matches[0]) add({ userId: matches[0].userId, email: matches[0].email ?? undefined, name: matches[0].name ?? matches[0].email ?? "Someone", onBops: true });
            else if (e.key === "Backspace" && !query && picked.length) setPicked(picked.slice(0, -1));
          }}
          placeholder={picked.length ? "Add more…" : "Name or email"}
          className="min-w-[140px] flex-1 bg-transparent px-1 text-[14px] leading-5 outline-none placeholder:text-[#9A9A98]"
        />
      </div>
      <div className="flex flex-col">
        {matches.map((p) => (
          <button
            key={p.userId}
            onClick={() => add({ userId: p.userId, email: p.email ?? undefined, name: p.name ?? p.email ?? "Someone", onBops: true })}
            className="flex items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-[#F6F6F4]"
          >
            <PersonAvatar person={p} size={30} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[14px] font-medium leading-[18px]">{p.name ?? p.email}</span>
              <span className="truncate text-[12px] leading-4 text-[#6B6B6B]">{p.email}</span>
            </span>
          </button>
        ))}
        {typedEmail && (
          <button disabled={busy} onClick={() => void addEmail(typedEmail)} className="flex items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-[#F6F6F4]">
            <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-[14px] text-[#9A9A98] shadow-[inset_0_0_0_1.5px_#D6D6D3]">@</span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[14px] font-medium leading-[18px]">{typedEmail}</span>
              <span className="text-[12px] leading-4 text-[#6B6B6B]">Add them. If they&apos;re not on Bops yet, they join when they sign up.</span>
            </span>
          </button>
        )}
        {!matches.length && !typedEmail && !picked.length && (
          <span className="px-2 py-2 text-[12.5px] leading-[18px] text-[#6B6B6B]">Type the email they use for Bops (their Orgo account). People you&apos;ve messaged show here.</span>
        )}
      </div>
      {picked.length > 1 && (
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Group name (optional)" className="rounded-xl px-3 py-2 text-[14px] shadow-[0_0_0_1px_#E2E2DF] outline-none" />
      )}
      {error && <span className="text-[12px] text-[#B42318]">{error}</span>}
      <div className="flex items-center gap-3">
        <button disabled={!picked.length || busy} onClick={() => void start()} className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-30">
          {picked.length > 1 ? "Start group" : "Message"}
        </button>
        <span className="text-[12px] leading-4 text-[#9A9A98]">{picked.length > 1 ? "A group you can name and add to later." : "One person makes a direct message."}</span>
      </div>
    </div>
  );
}
