import assert from 'node:assert/strict';
import { stats, hopTimings, cpuIntervals } from './common.mjs';
import { colourValue } from './viewer.mjs';
export function attributeSample(s, viewer, pageEvents, logs, links) {
    const near = (a, b) => Math.abs(a - b) < 2;
    const within = at => at >= s.start - 2 && at <= s.paint.at + 2;
    const type = s.kind === 'click' ? 'mouseReleased' : 'mouseMoved';
    const x = s.kind === 'click' ? 200 : 700;
    const queued = viewer.inputs.find(e => e.phase === 'queued' && e.type === type && near(e.x, x) && near(e.y, 200) && within(e.at));
    assert.ok(queued, `${s.scenario}: queued observation`);
    const sent = viewer.inputs.find(e => e.phase === 'sent' && e.type === type && near(e.x, x) && near(e.y, 200) && e.at >= queued.at && within(e.at));
    assert.ok(sent, `${s.scenario}: sent observation`);
    const cloud = logs.find(e => e.phase === 'cloud_got' && e.type === type && near(e.x, x) && near(e.y, 200) && e.at >= sent.at - 2 && within(e.at));
    const runner = logs.find(e => e.phase === 'runner_got' && e.type === type && near(e.x, x) && near(e.y, 200) && e.at >= cloud?.at && within(e.at));
    const handled = pageEvents.find(e => e.kind === s.kind && e.value === s.value && e.at >= runner?.at - 2 && within(e.at));
    assert.ok(cloud && runner && handled, `${s.scenario}: Cloud, runner and page observations`);
    const decoded = viewer.decoded.find(f => logs.some(e => e.phase === 'source_frame' && e.timestamp === f.timestamp && e.at >= handled.at && within(e.at)) && colourValue(f.colours[s.kind === 'click' ? 0 : 1], s.kind) === s.value);
    const received = viewer.received.find(f => f.timestamp === decoded?.timestamp && within(f.at));
    const produced = logs.find(e => e.phase === 'source_frame' && e.timestamp === decoded?.timestamp && within(e.at));
    const forwarded = logs.find(e => e.phase === 'cloud_frame' && e.timestamp === decoded?.timestamp && within(e.at));
    assert.ok(decoded && received && produced && forwarded, `${s.scenario}: first changed frame observations`);
    const dom = viewer.dom.find(e => e.type === (s.kind === 'click' ? 'mousedown' : 'mousemove') && within(e.at));
    assert.ok(dom, `${s.scenario}: real viewer input`);
    const times = { input: dom.at, queued: queued.at, sent: sent.at, cloud: cloud.at, runner: runner.at, handled: handled.at, frame: decoded.timestamp * 1000, sourceReceived: produced.at, forwarded: forwarded.at, received: received.at, painted: s.paint.at };
    s.times = times;
    const press = s.kind === 'click' ? viewer.inputs.find(e => e.phase === 'queued' && e.type === 'mousePressed' && near(e.x, x) && near(e.y, 200) && within(e.at)) : queued;
    assert.ok(press, 'press queue observation');
    s.queueDepth = press.depth;
    assert.equal(s.paint.timestamp, decoded.timestamp, 'painted frame must be the first changed source frame');
    const proxyIn = links.find(e => e.phase === 'proxy_act_in' && e.type === type && near(e.x, x) && near(e.y, 200) && e.at >= sent.at - 2 && within(e.at));
    const proxyOut = links.find(e => e.phase === 'proxy_act_out' && e.type === type && near(e.x, x) && near(e.y, 200) && e.at >= proxyIn?.at && within(e.at));
    const proxyReady = links.find(e => e.phase === 'proxy_act_ready' && e.actId === proxyIn?.actId && within(e.at));
    const connection = links.find(e => e.phase === 'proxy_act_connection' && e.actId === proxyIn?.actId && within(e.at));
    const frameIn = links.find(e => e.phase === 'proxy_sse_in' && e.timestamp === decoded.timestamp && within(e.at));
    const frameOut = links.find(e => e.phase === 'proxy_sse_out' && e.timestamp === decoded.timestamp && within(e.at));
    assert.ok(proxyIn && proxyReady && proxyOut && connection && frameIn && frameOut, 'proxy hop observations');
    Object.assign(times, { proxyIn: proxyIn.at, proxyReady: proxyReady.at, proxyOut: proxyOut.at, frameIn: frameIn.at, frameOut: frameOut.at });
    s.connection = { connectionId: connection.connectionId, newConnection: connection.newConnection, setupMs: connection.setupMs };
    if (s.kind === 'click') {
        const pressConnection = links.find(e => e.phase === 'proxy_act_connection' && e.type === 'mousePressed' && near(e.x, x) && near(e.y, 200) && within(e.at));
        assert.ok(pressConnection, 'press connection observation');
        s.pressConnection = { connectionId: pressConnection.connectionId, newConnection: pressConnection.newConnection, setupMs: pressConnection.setupMs };
    }
    s.hops = { ...hopTimings(times), send_to_local_forward: times.proxyIn - times.sent, outbound_delay: times.proxyReady - times.proxyIn, connection_setup_and_write: times.proxyOut - times.proxyReady, proxy_to_cloud: times.cloud - times.proxyOut, cloud_to_proxy: times.frameIn - times.forwarded, inbound_delay: times.frameOut - times.frameIn, proxy_to_viewer: times.received - times.frameOut };
    for (const [key, ms] of Object.entries(s.hops))
        if (!['page_to_frame', 'frame_to_cloud'].includes(key))
            assert.ok(ms >= -2, `${key}: reversed boundary ${ms}`);
    s.total = times.painted - times.input;
    s.queueWait = times.sent - times.queued;
    return s;
}
export function summarize(raw, logs, links = []) {
    const delay = raw.linkMs;
    raw.timings = logs.filter(l => l.at >= raw.measurementStart && l.at <= raw.measurementEnd);
    for (const s of raw.samples)
        attributeSample(s, raw.viewer, raw.page.events, logs, links);
    const summary = { linkMs: delay, metrics: {}, hops: {}, byScenario: {}, caveats: ["Local two-person apps use next dev; not production or a real Orgo computer.", "Canvas photon is first requestAnimationFrame pixel observation; physical display and network jitter are not measured.", "CPU sums clamped per-PID time deltas only for PIDs present in both samples. Appearing/exiting helpers cause a slight undercount; churn is recorded. CPU is informational and cannot gate latency. Relay process includes fixture servers and proxy.", "New upstream TCP connections pay one extra modeled RTT in addition to data propagation; local HTTP has no TLS. The real HTTPS leg pays one more RTT for TLS per new connection than measured.", "Two pixels are read from each reused decoded bitmap; measurement overhead is included.", "Chrome metadata.timestamp is expected display time, which can follow actual JPEG delivery. Metadata deltas are signed, not transit durations. Actual page_to_encoded_frame and encoded_frame_to_cloud use the runner's frame callback. See Chromium page_handler.cc ScreencastFrameTimestamp."] };
    for (const scenario of ['rest', 'moving', 'hover', 'idle']) {
        const samples = raw.samples.filter(s => s.scenario === scenario);
        assert.equal(samples.length, scenario === 'moving' ? 15 : scenario === 'idle' ? 10 : 30);
        summary.metrics[`${scenario}_to_photon_ms`] = stats(samples.map(s => s.total));
        summary.metrics[`${scenario}_queue_depth`] = stats(samples.map(s => s.queueDepth));
        summary.metrics[`${scenario}_queue_wait_ms`] = stats(samples.map(s => s.queueWait));
        if (scenario !== 'hover')
            summary.metrics[`${scenario}_press_connection_setup_ms`] = stats(samples.map(s => s.pressConnection.setupMs));
        summary.byScenario[scenario] = Object.fromEntries(Object.keys(samples[0].hops).map(h => [h, stats(samples.map(s => s.hops[h]))]));
    }
    for (const sample of raw.samples.filter(s => s.scenario === 'idle')) {
        assert.ok(sample.idle?.waitedMs >= 6000, 'six-second idle wait');
        assert.ok(!links.some(e => e.phase === 'proxy_act_in' && e.at > sample.idle.start && e.at < sample.start - 2), 'idle must not send an act before the click');
    }
    for (const hop of Object.keys(raw.samples[0].hops))
        summary.hops[hop] = stats(raw.samples.map(s => s.hops[hop]));
    const inScroll = (t) => t >= raw.scroll.start && t < raw.scroll.end;
    const sourceFrames = raw.timings.filter(f => f.phase === 'source_frame' && inScroll(f.at));
    const viewerFrames = raw.viewer.painted.filter(f => inScroll(f.at));
    const receivedFrames = raw.viewer.received.filter(f => inScroll(f.at));
    const bins = (rows, time, value) => Array.from({ length: 5 }, (_, i) => rows.filter(r => time(r) >= raw.scroll.start + i * 1000 && time(r) < raw.scroll.start + (i + 1) * 1000).reduce((sum, r) => sum + value(r), 0));
    summary.metrics.source_scroll_fps = stats(bins(sourceFrames, f => f.at, () => 1));
    summary.metrics.viewer_scroll_fps = stats(bins(viewerFrames, f => f.at, () => 1));
    summary.metrics.jpeg_bytes_per_second = stats(bins(receivedFrames, f => f.at, f => f.bytes));
    summary.metrics.sse_json_bytes_per_second = stats(bins(receivedFrames, f => f.at, f => f.wireBytes));
    summary.metrics.jpeg_bytes_per_frame = stats(receivedFrames.map(f => f.bytes));
    raw.cpuIntervals = cpuIntervals(raw.cpu);
    summary.metrics.chrome_cpu_percent = stats(raw.cpuIntervals.map(c => c.chrome).filter(Number.isFinite));
    summary.metrics.relay_cpu_percent = stats(raw.cpuIntervals.map(c => c.relay).filter(Number.isFinite));
    summary.cpu = { nonBlocking: true, samplingErrors: raw.cpuErrors ?? [], appearedPids: raw.cpuIntervals.reduce((n, c) => n + c.appearedPids, 0), exitedPids: raw.cpuIntervals.reduce((n, c) => n + c.exitedPids, 0), byScenario: {} };
    for (const scenario of ['rest', 'moving', 'hover', 'idle', 'scroll']) {
        const rows = raw.cpuIntervals.filter(c => c.scenario === scenario);
        summary.metrics[`chrome_${scenario}_cpu_percent`] = stats(rows.map(c => c.chrome).filter(Number.isFinite));
        summary.metrics[`relay_${scenario}_cpu_percent`] = stats(rows.map(c => c.relay).filter(Number.isFinite));
        summary.cpu.byScenario[scenario] = { intervals: rows.length, appearedPids: rows.reduce((n, c) => n + c.appearedPids, 0), exitedPids: rows.reduce((n, c) => n + c.exitedPids, 0) };
    }
    summary.connections = {};
    for (const window of raw.scenarios ?? []) {
        const acts = links.filter(e => e.phase === 'proxy_act_connection' && e.at >= window.start && e.at <= window.end);
        const opens = links.filter(e => e.phase === 'connection_open' && e.at >= window.start && e.at <= window.end);
        summary.connections[window.name] = { acts: acts.length, actsOpeningConnection: acts.filter(e => e.newConnection).length, actsReusingConnection: acts.filter(e => !e.newConnection).length, downstreamConnections: opens.filter(e => e.direction === 'downstream').length, upstreamConnections: opens.filter(e => e.direction === 'upstream').length };
    }
    summary.connections.idlePressesOpeningConnection = raw.samples.filter(s => s.scenario === 'idle' && s.pressConnection?.newConnection).length;
    const from = raw.samples[0].start, to = raw.samples.at(-1).paint.at;
    const produced = new Set(logs.filter(l => l.phase === 'source_frame' && l.at >= from && l.at <= to).map(f => f.timestamp));
    const received = new Set(raw.viewer.received.map(f => f.timestamp));
    summary.integrity = { unreceivedSourceFrames: [...produced].filter(t => !received.has(t)).length, clock: raw.clock };
    assert.equal(summary.integrity.unreceivedSourceFrames, 0, 'Source colour attribution requires every source frame during input scenarios');
    // Others watching while the driver drives: when each first painted the change, from the driver's own input, and how
    // long after the driver's window it was; and each one's frames a second while scrolling.
    summary.driver = raw.driver ?? 'owner';
    summary.watchers = (raw.watchers ?? []).map(w => w.who);
    if (summary.watchers.length) {
        for (const scenario of ['rest', 'moving', 'hover', 'idle']) {
            const seen = raw.samples.filter(s => s.scenario === scenario).flatMap(s => s.watchers.map(w => ({ total: w.at - s.times.input, behind: w.at - s.paint.at })));
            assert.equal(seen.length, raw.samples.filter(s => s.scenario === scenario).length * summary.watchers.length, `${scenario}: every watcher saw every change`);
            summary.metrics[`watcher_${scenario}_to_photon_ms`] = stats(seen.map(w => w.total));
            summary.metrics[`watcher_${scenario}_behind_driver_ms`] = stats(seen.map(w => w.behind));
        }
        summary.metrics.watcher_scroll_fps = stats(raw.watchers.flatMap(w => bins(w.painted.filter(f => inScroll(f.at)), f => f.at, () => 1)));
        summary.caveats.push("Watchers are pages on this same Mac (one headless Chrome), so they share its CPU with the driver; in real use each is on its own Mac. Per-hop splits are the driver's; a watcher's figures are its first paint of the change.");
    }
    assert.ok(sourceFrames.length > 0 && viewerFrames.length > 0 && receivedFrames.length > 0, 'non-empty scrolling observations');
    return summary;
}
