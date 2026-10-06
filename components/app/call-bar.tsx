"use client";

import { useEffect, useRef, useState } from "react";
import type { Bot } from "@/lib/types";
import { Mascot } from "./mascot";

type Phase = "connecting" | "live" | "ending" | "ended" | "failed";

/** How many dots the waveform shows; each is one slice of recent sound, newest on the right. */
const DOTS = 14;

/**
 * A voice call with a bot, over GPT-Live (WebRTC), as a bar that takes the chat header's place, so the
 * conversation (and any threads the call starts) stays in view. The bot talks in its own voice;
 * when the user asks for something to be done, GPT-Live delegates and Bops runs it through the bot's
 * chat brain (threads, hand-offs, schedules), then the bot says how it went.
 */
/**
 * What you hear while the bot's phone rings: the North American ringback (440 + 480 Hz together),
 * soft, with short rings (half a real phone's) so the wait feels like a call, not a modem. Stops the
 * moment it's called off.
 */
function ring() {
  const ctx = new AudioContext();
  const out = ctx.createGain();
  out.gain.value = 0.05;
  out.connect(ctx.destination);
  const burst = (at: number) => {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + 0.04);
    env.gain.setValueAtTime(1, at + 0.8);
    env.gain.linearRampToValueAtTime(0, at + 0.88);
    env.connect(out);
    for (const f of [440, 480]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(env);
      osc.start(at);
      osc.stop(at + 0.9);
    }
  };
  burst(ctx.currentTime + 0.05);
  const loop = setInterval(() => burst(ctx.currentTime + 0.02), 1700);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    clearInterval(loop);
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    setTimeout(() => void ctx.close().catch(() => {}), 200);
  };
}

/**
 * The line going dead when a call ends (you hung up, or the bot did): two soft falling tones, like
 * an iPhone's end-of-call. Plays on its own, after the call's audio is gone.
 */
function hangUpTone() {
  const ctx = new AudioContext();
  const out = ctx.createGain();
  out.gain.value = 0.08;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  [
    [620, 0],
    [460, 0.17],
  ].forEach(([f, dt]) => {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0 + dt);
    env.gain.linearRampToValueAtTime(1, t0 + dt + 0.015);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.15);
    env.connect(out);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f;
    osc.connect(env);
    osc.start(t0 + dt);
    osc.stop(t0 + dt + 0.16);
  });
  setTimeout(() => void ctx.close().catch(() => {}), 600);
}

/** The bot lets it ring at least this long before picking up, like a person reaching for their phone. */
const RING_AT_LEAST_MS = 1300;

/**
 * `compact`: you're in another chat (or the computer), so the call waits small in the sidebar's
 * corner: who, the time, mute and hang up. Click the bot to go back to its chat.
 */
export function CallBar({ bot: b, owner, onClose, compact, onOpen }: { bot: Bot; owner?: string; onClose: () => void; compact?: boolean; onOpen?: () => void }) {
  // The name the bot greets you by, read when the call connects (a later change shouldn't restart the call).
  const ownerRef = useRef(owner);
  useEffect(() => {
    ownerRef.current = owner;
  }, [owner]);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(false);
  const [caption, setCaption] = useState<{ who: "you" | "bot"; text: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(DOTS).fill(0));
  const events = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const meters = useRef<{ you?: AnalyserNode; bot?: AnalyserNode; ctx?: AudioContext }>({});
  const startedAt = useRef<number | null>(null);
  const heard = useRef("");
  const said = useRef("");
  // The whole call as turns ("owner" / "bot"), for long-term memory when it ends.
  const transcript = useRef<{ who: "owner" | "bot"; text: string }[]>([]);
  // The hang-up tone, once per call (hanging up and the session closing both end it).
  const toned = useRef(false);
  const endTone = () => {
    if (toned.current) return;
    toned.current = true;
    hangUpTone();
  };
  const turn = (who: "owner" | "bot", delta: string) => {
    const last = transcript.current.at(-1);
    if (last?.who === who) last.text += delta;
    else transcript.current.push({ who, text: delta });
  };
  const closed = useRef(false);

  useEffect(() => {
    let gone = false;
    const send = (event: object) => events.current?.readyState === "open" && events.current.send(JSON.stringify(event));

    // This attempt's own connection, so cleaning up never touches a newer attempt's (React may mount twice).
    let mine: { pc?: RTCPeerConnection; channel?: RTCDataChannel; stream?: MediaStream; ctx?: AudioContext } = {};
    const cleanup = () => {
      mine.stream?.getTracks().forEach((t) => t.stop());
      mine.channel?.close();
      mine.pc?.close();
      void mine.ctx?.close();
      if (meters.current.ctx === mine.ctx) meters.current = {};
      mine = {};
    };
    const meter = (stream: MediaStream, who: "you" | "bot") => {
      const ctx = (mine.ctx ??= new AudioContext());
      meters.current.ctx = ctx;
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(node);
      meters.current[who] = node;
    };

    /** Wait for a thread to finish (while the call lasts), then pass its answer back to say aloud. */
    const followUp = async (delegationId: string, sessionId: string) => {
      for (let i = 0; i < 120 && !gone && !closed.current; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as { state: { sessions: { id: string; title: string; status: string; answer?: string; error?: string }[] } };
        const t = state.state.sessions.find((x) => x.id === sessionId);
        if (!t || t.status === "queued" || t.status === "starting" || t.status === "running") continue;
        send({
          type: "session.commentary.append",
          delegation_id: delegationId,
          content: t.status === "done" ? `"${t.title}" is done: ${t.answer ?? "finished"}` : `"${t.title}" didn't finish: ${t.error ?? "it stopped"}`,
        });
        return;
      }
    };

    /** The user asked for something to be done: run it as the bot, then hand back what to say. */
    const onDelegation = async (delegationId: string) => {
      const request = heard.current.trim();
      heard.current = "";
      setWorking(true);
      try {
        const res = await fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delegate", botId: b.id, request }) });
        const json = (await res.json()) as { result?: string; sessionIds?: string[]; error?: string };
        send({ type: "session.commentary.append", delegation_id: delegationId, content: json.result ?? `That didn't work: ${json.error ?? "something went wrong"}.` });
        // Work it started keeps going on the computer; if it finishes during the call, say how it went.
        for (const id of json.sessionIds ?? []) void followUp(delegationId, id);
      } catch {
        send({ type: "session.commentary.append", delegation_id: delegationId, content: "I couldn't reach my computer just now." });
      } finally {
        setWorking(false);
      }
    };

    // It rings from the moment you call until the bot picks up (or the call doesn't go through).
    const stopRing = ring();
    const rangLongEnough = new Promise((r) => setTimeout(r, RING_AT_LEAST_MS));
    const hush = () => stopRing();
    void (async () => {
      try {
        const pc = new RTCPeerConnection();
        mine.pc = pc;
        pc.addEventListener("track", (e) => {
          const remote = new MediaStream([e.track]);
          if (audio.current) {
            audio.current.srcObject = remote;
            void audio.current.play().catch(() => {});
          }
          meter(remote, "bot");
        });
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (gone) return stream.getTracks().forEach((t) => t.stop());
        mic.current = stream;
        mine.stream = stream;
        for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
        meter(stream, "you");

        // The event channel has to exist before the offer.
        const channel = pc.createDataChannel("oai-events");
        events.current = channel;
        mine.channel = channel;
        channel.addEventListener("message", ({ data }) => {
          const event = JSON.parse(String(data)) as { type: string; delta?: string; delegation?: { id: string; target?: string } };
          if (event.type === "session.started") {
            hush();
            startedAt.current = Date.now();
            setPhase("live");
            // The bot speaks first, the way anyone picks up a call.
            send({ type: "session.commentary.append", delegation_id: null, content: `You just picked up the call. Say only: "Hello? Can you hear me?" Then wait for ${ownerRef.current?.trim() || "the user"}.` });
          } else if (event.type === "session.closed") {
            closed.current = true;
            if (startedAt.current) endTone();
            setPhase("ended");
            cleanup();
          } else if (event.type === "session.input_transcript.delta" && event.delta) {
            turn("owner", event.delta);
            if (said.current) said.current = "";
            heard.current += event.delta;
            setCaption({ who: "you", text: heard.current.trim() });
          } else if (event.type === "session.output_transcript.delta" && event.delta) {
            turn("bot", event.delta);
            said.current += event.delta;
            setCaption({ who: "bot", text: said.current.replace(/^[\s.,;:!?]+/, "").trim() });
          } else if (event.type === "session.delegation.created" && event.delegation?.target === "client") {
            void onDelegation(event.delegation.id);
          }
        });
        channel.addEventListener("close", () => {
          if (!closed.current && !gone && events.current === channel) {
            if (startedAt.current) endTone();
            setPhase("ended");
            cleanup();
          }
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (pc.iceGatheringState !== "complete")
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5000);
            pc.addEventListener("icegatheringstatechange", () => {
              if (pc.iceGatheringState === "complete") {
                clearTimeout(t);
                resolve();
              }
            });
          });
        await rangLongEnough;
        if (gone) return;
        const res = await fetch("/api/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", botId: b.id, sdp: pc.localDescription?.sdp }),
        });
        const json = (await res.json()) as { transport?: { sdp: string }; error?: string };
        if (!json.transport) throw new Error(json.error ?? "the call didn't connect");
        if (gone) return;
        await pc.setRemoteDescription({ type: "answer", sdp: json.transport.sdp });
      } catch (e) {
        if (gone) return;
        hush();
        setError((e as Error).message.includes("Permission") ? "Bops needs microphone access for calls." : (e as Error).message);
        setPhase("failed");
        cleanup();
      }
    })();

    return () => {
      gone = true;
      hush();
      if (!closed.current && mine.channel?.readyState === "open") mine.channel.send(JSON.stringify({ type: "session.close" }));
      setTimeout(cleanup, 300);
    };
  }, [b.id]);

  // The waveform: every ~90ms, how loud the call is right now (whoever is talking) becomes the newest dot.
  useEffect(() => {
    if (phase !== "live") return;
    const buf = new Uint8Array(512);
    const loudness = (node: AnalyserNode | undefined, gain: number) => {
      if (!node) return 0;
      node.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * gain);
    };
    const t = setInterval(() => {
      // The bot's audio arrives quieter than a mic, so it gets a little more gain.
      const level = Math.max(loudness(meters.current.bot, 7), muted ? 0 : loudness(meters.current.you, 3.5));
      setLevels((l) => [...l.slice(1), level]);
    }, 90);
    return () => clearInterval(t);
  }, [phase, muted]);

  // The call timer.
  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setSeconds(Math.round((Date.now() - (startedAt.current ?? Date.now())) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // A call that ended on its own (or failed) leaves after a moment.
  useEffect(() => {
    if (phase !== "ended") return;
    const t = setTimeout(onClose, 1500);
    return () => clearTimeout(t);
  }, [phase, onClose]);

  const hangUp = () => {
    if (startedAt.current) endTone();
    if (startedAt.current) void fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "end", botId: b.id, seconds, transcript: transcript.current.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text) }) });
    if (events.current?.readyState === "open" && !closed.current) {
      setPhase("ending");
      events.current.send(JSON.stringify({ type: "session.close" }));
      setTimeout(onClose, 600);
    } else onClose();
  };

  const toggleMute = () => {
    const next = !muted;
    mic.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const status =
    phase === "connecting" ? "Ringing…" : phase === "live" ? (working ? "On it…" : clock) : phase === "ending" ? "Hanging up…" : phase === "failed" ? "Call failed" : "Call ended";

  return (
    <div className="relative z-30 flex animate-[call-in_220ms_ease-out] flex-col items-center">
      <audio ref={audio} autoPlay />
      <div className="flex items-center gap-1.5 rounded-full bg-white p-1.5 shadow-[0_0_0_1px_#E6E6E3,0_10px_28px_-14px_#00000059]">
        <button
          onClick={onOpen}
          disabled={!compact}
          title={compact ? `Back to ${b.name}` : undefined}
          className="flex size-10 shrink-0 items-center justify-center rounded-full enabled:hover:brightness-95"
          style={{ background: `color-mix(in oklab, ${b.color} 18%, white)` }}
        >
          <Mascot botId={b.id} color={b.color} size={28} />
        </button>
        <div className="flex w-[74px] shrink-0 flex-col pl-1">
          <span className="truncate text-[14px] font-semibold leading-[18px]">{b.name}</span>
          <span className={`font-mono text-[12px] leading-[15px] ${phase === "failed" ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>{status}</span>
        </div>

        <div className={`h-10 w-[104px] items-center justify-between px-1.5 ${compact ? "hidden" : "flex"}`} aria-hidden>
          {levels.map((l, i) => (
            <span
              key={i}
              className={`w-[3px] rounded-full transition-[height,background-color] duration-100 ${phase === "connecting" ? "animate-pulse bg-[#D4D4D1]" : l > 0.08 ? "bg-ink" : "bg-[#D4D4D1]"}`}
              style={{ height: `${3 + Math.round(l * 20)}px`, animationDelay: phase === "connecting" ? `${i * 70}ms` : undefined }}
            />
          ))}
        </div>

        <RoundButton label={captions ? "Hide captions" : "Show captions"} on={captions} hidden={compact} onClick={() => setCaptions(!captions)}>
          <path d="M10 3.5c4 0 7 2.6 7 5.8s-3 5.8-7 5.8c-.8 0-1.6-.1-2.3-.3L4 16.5l.9-3C3.7 12.4 3 10.9 3 9.3 3 6.1 6 3.5 10 3.5z" strokeLinejoin="round" />
          <circle cx="7" cy="9.3" r=".6" fill="currentColor" />
          <circle cx="10" cy="9.3" r=".6" fill="currentColor" />
          <circle cx="13" cy="9.3" r=".6" fill="currentColor" />
        </RoundButton>
        <RoundButton label={muted ? "Unmute" : "Mute"} on={muted} disabled={phase !== "live"} onClick={toggleMute}>
          <rect x="7" y="2.5" width="6" height="10" rx="3" />
          <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
          {muted && <path d="M3 3l14 14" />}
        </RoundButton>
        <button onClick={hangUp} aria-label="Hang up" title="Hang up" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#E5484D] hover:bg-[#D93D42]">
          <svg width="15" height="15" viewBox="0 0 16 16" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
          </svg>
        </button>
      </div>

      {/* Captions hang under the bar, over the chat, so turning them on never moves the conversation. */}
      {(error || (captions && caption && !compact)) && (
        <p
          className={`absolute ${compact ? "bottom-full mb-2" : "top-full mt-2"} line-clamp-3 w-max max-w-[400px] rounded-2xl bg-white/95 px-3.5 py-2 text-center text-[13px] leading-[19px] shadow-[0_0_0_1px_#0000000D,0_6px_16px_-8px_#00000040] ${
            error ? "text-[#B42318]" : caption?.who === "you" ? "italic text-[#6B6B6B]" : "text-ink"
          }`}
        >
          {error ?? caption?.text}
        </p>
      )}
    </div>
  );
}

function RoundButton({ label, on, disabled, hidden, onClick, children }: { label: string; on: boolean; disabled?: boolean; hidden?: boolean; onClick: () => void; children: React.ReactNode }) {
  if (hidden) return null;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-40 ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#E9E9E6]"}`}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        {children}
      </svg>
    </button>
  );
}
