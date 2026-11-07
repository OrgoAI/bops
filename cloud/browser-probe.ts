// Opt-in timings for the local browser latency probe. Never log input text or credentials.
export function probeTiming(phase: string, detail: Record<string, unknown>) {
  if (process.env.BOPS_BROWSER_PROBE === "1")
    console.log(`[browser-probe] ${JSON.stringify({ phase, at: performance.timeOrigin + performance.now(), ...detail })}`);
}

export function probeInput(phase: string, method: unknown, params: unknown) {
  if (process.env.BOPS_BROWSER_PROBE !== "1" || method !== "Input.dispatchMouseEvent" || !params || typeof params !== "object") return;
  const p = params as Record<string, unknown>;
  probeTiming(phase, { type: p.type, x: p.x, y: p.y, deltaY: p.deltaY });
}
