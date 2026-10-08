import "server-only";
import { readFileSync } from "node:fs";
import { toFile } from "openai";
import type { Message } from "@/lib/types";
import { openaiClient } from "./openai-client";
import { saveUpload, uploadPath } from "./uploads";
import { recordTokens, usageTags } from "./usage";

/**
 * Pictures a bot makes in chat (make_image, chat.ts): drawn new with gpt-image-2.5-flare, or made from
 * pictures already in the chat with gpt-image-2.5-sunburst (OpenAI's model for precise edits). Saved
 * with the user's uploads, so the chat shows them like any other image, and through Bops Cloud their
 * tokens are counted for the bot (cloud/proxy.ts, the image routes).
 */

const client = openaiClient();
const DRAW_MODEL = process.env.BOPS_IMAGE_MODEL?.trim() || "gpt-image-2.5-flare";
const EDIT_MODEL = process.env.BOPS_IMAGE_EDIT_MODEL?.trim() || "gpt-image-2.5-sunburst";

export const SHAPES = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" } as const;
export type Shape = keyof typeof SHAPES;

/** How many of the chat's pictures an edit starts from at most. */
const MAX_FROM = 4;
/** Image types an edit can start from (not GIF). */
const EDITABLE: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** One picture, drawn from `prompt`, or made from `from` (pictures in the chat) when there are any. */
export async function makeImage(botId: string, prompt: string, shape: Shape, from: Message["images"] = []): Promise<NonNullable<Message["images"]>> {
  const size = SHAPES[shape] ?? SHAPES.square;
  const files = (from ?? []).map((i) => uploadPath(i.id)).filter((f) => !!f && !!EDITABLE[f.type]).slice(0, MAX_FROM) as { path: string; type: string }[];
  const common = { prompt, size, quality: "medium" as const, output_format: "png" as const, n: 1 };
  const model = files.length ? EDIT_MODEL : DRAW_MODEL;
  const r = files.length
    ? await client.images.edit(
        { ...common, model, image: await Promise.all(files.map((f, k) => toFile(readFileSync(/*turbopackIgnore: true*/ f.path), `picture-${k + 1}.${EDITABLE[f.type]}`, { type: f.type }))) },
        usageTags("chat", botId),
      )
    : await client.images.generate({ ...common, model }, usageTags("chat", botId));
  recordTokens("chat", model, r.usage, botId);
  const [w, h] = (r.size ?? size).split("x").map(Number);
  const made = (r.data ?? []).flatMap((d) => (d.b64_json ? [saveUpload(`data:image/png;base64,${d.b64_json}`)] : []));
  if (!made.length) throw new Error("no picture came back");
  return made.map((m) => ({ ...m, ...(w && h ? { w, h } : {}) }));
}
