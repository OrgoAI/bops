/**
 * The app's own calls to its server (desktop/main.cjs: a restart, the Mac going to sleep). They carry the
 * window's token in a header, as the window carries it in its cookie: on the Mac app the server lets nothing
 * else through but its open paths (proxy.ts), and a call without it gets "Only the Bops app can do that."
 * Returns fetch's arguments.
 */
function ownCall(base, token, path, { method = "GET", json, timeoutMs = 3000 } = {}) {
  const headers = { "x-bops-window": token };
  if (json !== undefined) headers["content-type"] = "application/json";
  return [`${base}${path}`, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}), signal: AbortSignal.timeout(timeoutMs) }];
}

module.exports = { ownCall };
