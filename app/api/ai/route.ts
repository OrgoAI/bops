import { directAiConfig, directAiKey, directAiPublic, saveDirectAiConfig, setDirectAiKey, type DirectAiConfig } from "@/lib/server/ai-config";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await directAiPublic(), { headers: { "Cache-Control": "no-store" } });
}

type Body = Partial<DirectAiConfig> & {
  apiKey?: string;
  clearKey?: boolean;
  test?: boolean;
};

function text(value: unknown, name: string, max = 300) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const v = value.trim();
  if (v.length > max) throw new Error(`${name} is too long.`);
  return v;
}

async function testConnection() {
  const c = directAiConfig();
  const key = await directAiKey();
  if (!key) throw new Error("Add an API key first.");
  const res = await fetch(`${c.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? "Check the API key." : "Check the API URL and provider status.";
    throw new Error(`Provider returned HTTP ${res.status}. ${hint}`);
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
  return { ok: true, models: Array.isArray(json?.data) ? json!.data!.length : undefined };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const current = directAiConfig();
    const next: Partial<DirectAiConfig> = {};
    if (body.enabled !== undefined) next.enabled = body.enabled === true;
    if (body.allowCloudExecutors !== undefined) next.allowCloudExecutors = body.allowCloudExecutors === true;
    if (body.blockBopsCloud !== undefined) next.blockBopsCloud = body.blockBopsCloud === true;
    const baseUrl = text(body.baseUrl, "API URL", 500);
    const chatModel = text(body.chatModel, "Chat model");
    const sessionModel = text(body.sessionModel, "Session model");
    const hardModel = text(body.hardModel, "Hard-task model");
    if (baseUrl !== undefined) next.baseUrl = baseUrl;
    if (chatModel !== undefined) next.chatModel = chatModel;
    if (sessionModel !== undefined) next.sessionModel = sessionModel;
    if (hardModel !== undefined) next.hardModel = hardModel;

    const existingKey = await directAiKey();
    const suppliedKey = body.apiKey !== undefined ? text(body.apiKey, "API key", 4096) : undefined;
    const willHaveKey = !body.clearKey && (!!suppliedKey || !!existingKey);
    const willEnable = next.enabled ?? current.enabled;
    if (willEnable && !willHaveKey)
      return Response.json({ ...(await directAiPublic()), error: "Add an API key before turning on Direct AI." }, { status: 400 });

    // Validate/store non-secret settings only after the key requirement is satisfied.
    saveDirectAiConfig({ ...current, ...next, ...(body.clearKey ? { enabled: false } : {}) });
    if (body.clearKey) await setDirectAiKey(null);
    else if (suppliedKey) await setDirectAiKey(suppliedKey);

    const saved = await directAiPublic();
    const { ensureCloud, stopCloud } = await import("@/lib/server/cloud-tunnel");
    if (saved.enabled && saved.blockBopsCloud) await stopCloud();
    else ensureCloud();
    const tested = body.test ? await testConnection() : undefined;
    return Response.json({ ...saved, tested }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message || "Couldn't save AI settings." }, { status: 400 });
  }
}
