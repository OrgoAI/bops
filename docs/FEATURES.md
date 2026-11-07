# Feature checks

| Feature | How to reach it | Expected result | Files | Verify |
|---|---|---|---|---|
| Browser latency measurement | `node scripts/probe-browser-speed.mjs --link-ms 0 --out .scratch/probe-0` (repeat with 35) | 85 colour changes including ten clicks after six seconds idle, five seconds scrolling, raw JSON and hop/connection summaries, cleanup | `scripts/browser-speed/`, `scripts/probe-browser-speed.mjs`, `docs/BROWSER-SPEED.md` | `scripts/verify browser-speed`, then the command in this row |
| Computer draw and encode measurement | `node scripts/probe-computer-side.mjs --out .scratch/computer-probe` | 30 clicks, five seconds scrolling, owned Chrome stopped | `scripts/probe-computer-side.mjs` | Same static gate, then this row's command |
