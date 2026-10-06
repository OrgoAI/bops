import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * An app's real logo, from Composio's logo service, kept on disk after the first fetch so the Vault
 * and the app picker draw instantly (and offline). Only app slugs: letters, digits, _ and -.
 */
const DIR = `${process.cwd()}/.data/logos`;

export async function GET(_request: Request, ctx: { params: Promise<{ app: string }> }) {
  const { app } = await ctx.params;
  if (!/^[a-z0-9_-]{1,64}$/i.test(app)) return new Response("not found", { status: 404 });
  const file = `${DIR}/${app}`;
  const headers = (type: string) => ({ "Content-Type": type, "Cache-Control": "public, max-age=604800" });
  if (existsSync(file) && existsSync(`${file}.type`)) return new Response(readFileSync(file), { headers: headers(readFileSync(`${file}.type`, "utf8")) });
  const res = await fetch(`https://logos.composio.dev/api/${app}`).catch(() => null);
  const type = res?.headers.get("content-type") ?? "";
  if (!res?.ok || !/^image\//.test(type)) return new Response("not found", { status: 404 });
  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, body);
  writeFileSync(`${file}.type`, type);
  return new Response(body, { headers: headers(type) });
}
