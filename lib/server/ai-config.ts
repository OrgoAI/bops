import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deleteSecret, getSecret, setSecret } from "./keychain";

export type AiModelKind = "chat" | "session" | "hard";

export type DirectAiConfig = {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  sessionModel: string;
  hardModel: string;
  /** Off by default: otherwise the key is copied to the user's Orgo VM for cloud-computer agent runs. */
  allowCloudExecutors: boolean;
  /** Strong privacy: disables Bops Cloud proxies, state backup and webhook tunnel entirely. */
  blockBopsCloud: boolean;
};

const SECRET = "ai-api:key:v1";
const DEFAULT_BASE = "https://api.openai.com/v1";

function root() {
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Bops");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Bops");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "bops");
}
const file = () => join(root(), "ai.json");

const defaults = (): DirectAiConfig => ({
  enabled: false,
  baseUrl: DEFAULT_BASE,
  chatModel: process.env.BOPS_CHAT_MODEL ?? process.env.BOPS_SAM_MODEL ?? "gpt-6.1-sol",
  sessionModel: process.env.BOPS_SESSION_MODEL ?? "gpt-6.1-sol",
  hardModel: process.env.BOPS_HARD_MODEL ?? "gpt-6-astra",
  allowCloudExecutors: false,
  blockBopsCloud: true,
});

export function normalizeAiBaseUrl(value: string) {
  const raw = (value || DEFAULT_BASE).trim().replace(/\/+$/, "");
  const u = new URL(raw);
  if (u.username || u.password) throw new Error("Put credentials in the API key field, not the URL.");
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new Error("AI API URLs must use HTTPS (HTTP is allowed only for localhost).");
  return raw;
}

export function directAiConfig(): DirectAiConfig {
  const d = defaults();
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Partial<DirectAiConfig>;
    return {
      enabled: raw.enabled === true,
      baseUrl: normalizeAiBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : d.baseUrl),
      chatModel: typeof raw.chatModel === "string" && raw.chatModel.trim() ? raw.chatModel.trim() : d.chatModel,
      sessionModel: typeof raw.sessionModel === "string" && raw.sessionModel.trim() ? raw.sessionModel.trim() : d.sessionModel,
      hardModel: typeof raw.hardModel === "string" && raw.hardModel.trim() ? raw.hardModel.trim() : d.hardModel,
      allowCloudExecutors: raw.allowCloudExecutors === true,
      blockBopsCloud: raw.blockBopsCloud !== false,
    };
  } catch {
    return d;
  }
}

export function saveDirectAiConfig(input: Partial<DirectAiConfig>) {
  const was = directAiConfig();
  const next: DirectAiConfig = {
    enabled: input.enabled ?? was.enabled,
    baseUrl: normalizeAiBaseUrl(input.baseUrl ?? was.baseUrl),
    chatModel: (input.chatModel ?? was.chatModel).trim() || defaults().chatModel,
    sessionModel: (input.sessionModel ?? was.sessionModel).trim() || defaults().sessionModel,
    hardModel: (input.hardModel ?? was.hardModel).trim() || defaults().hardModel,
    allowCloudExecutors: input.allowCloudExecutors ?? was.allowCloudExecutors,
    blockBopsCloud: input.blockBopsCloud ?? was.blockBopsCloud,
  };
  mkdirSync(dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file());
  return next;
}

export const directAiEnabled = () => directAiConfig().enabled;
export const strictPrivacyEnabled = () => {
  const c = directAiConfig();
  return c.enabled && c.blockBopsCloud;
};

export async function directAiKey() {
  return getSecret(SECRET);
}

export async function setDirectAiKey(value: string | null) {
  const key = value?.trim();
  if (key) await setSecret(SECRET, key);
  else await deleteSecret(SECRET);
}

export async function directAiPublic() {
  const config = directAiConfig();
  return { ...config, hasKey: !!(await directAiKey()), privacy: "direct" as const };
}

export function aiModel(kind: AiModelKind) {
  const c = directAiConfig();
  if (c.enabled) return kind === "chat" ? c.chatModel : kind === "session" ? c.sessionModel : c.hardModel;
  if (kind === "chat") return process.env.BOPS_CHAT_MODEL ?? process.env.BOPS_SAM_MODEL ?? "gpt-6.1-sol";
  if (kind === "session") return process.env.BOPS_SESSION_MODEL ?? "gpt-6.1-sol";
  return process.env.BOPS_HARD_MODEL ?? "gpt-6-astra";
}

export function aiConfigExists() {
  return existsSync(file());
}
