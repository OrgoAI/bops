// Makes the short samples a bot's settings page plays for each of the nine call voices (public/voices/<voice>.mp3,
// lib/types.ts CALL_VOICES), with OpenAI's speech endpoint and a line that names no one. Run once by hand, with
// OPENAI_API_KEY in the environment (never printed); a voice the API refuses is skipped, and the page then says it
// has no sample yet. Not a test: it calls OpenAI.
// Usage: OPENAI_API_KEY=... node scripts/make-voice-samples.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const VOICES = ["cedar", "ash", "echo", "ballad", "verse", "marin", "coral", "shimmer", "sage"];
const LINE = "Hi, this is how I sound on a call. What can I do for you?";
const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.log("No OPENAI_API_KEY: no samples made.");
  process.exit(0);
}
const dir = new URL("../public/voices/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const voice of VOICES) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: LINE, response_format: "mp3" }),
  }).catch(() => null);
  if (!res?.ok) {
    console.log(`${voice}: skipped (${res ? res.status : "no answer"})`);
    continue;
  }
  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(new URL(`${voice}.mp3`, dir), audio);
  console.log(`${voice}: ${audio.length} bytes`);
}
