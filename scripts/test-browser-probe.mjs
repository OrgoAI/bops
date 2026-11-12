import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { test } from "node:test";
import { createServer } from "node:http";
import { args, cleanupSteps, cpuIntervals, cpuSeconds, hopTimings, stats } from "./browser-speed/common.mjs";
import { now, startLink } from "./browser-speed/link.mjs";
import { attributeSample } from './browser-speed/summarize.mjs';
import { colourValue } from './browser-speed/viewer.mjs';
import WebSocket, { WebSocketServer } from 'ws';
test("timing logs are silent by default and never include typed text", () => {
    const code = `import { probeInput } from './cloud/browser-probe.ts';
    probeInput('test', 'Input.dispatchMouseEvent', {type:'mousePressed',x:12,y:34,text:'PRIVATE'});
    probeInput('test', 'Input.insertText', {text:'PRIVATE'});`;
    const run = (enabled) => spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: process.cwd(), encoding: "utf8", env: { ...process.env, BOPS_BROWSER_PROBE: enabled },
    });
    const off = run("");
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout + off.stderr, "");
    const on = run("1");
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout + on.stderr, /mousePressed/);
    assert.doesNotMatch(on.stdout + on.stderr, /PRIVATE|insertText/);
});
test("summaries retain sample counts and reject missing numeric observations", () => {
    assert.deepEqual(stats([100, 4, 7, 1]), { n: 4, median: 5.5, p90: 100 });
    assert.deepEqual(stats([]), { n: 0, median: null, p90: null });
    assert.throws(() => stats([1, NaN]), /Non-finite/);
    assert.throws(() => args(['--link-ms', '36', '--out', '.scratch/probe-test']), /0 or 35/);
});
test("proxy adds both one-way delays and streams the first event before upstream end", async () => {
    let got, finish;
    const gate = new Promise(r => { finish = r; });
    const upstream = createServer(async (req, res) => {
        got = now();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: test\ndata: {"t":"test"}\n\n');
        await gate;
        res.end('event: last\ndata: {"t":"last"}\n\n');
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const proxy = await startLink(`http://127.0.0.1:${upstream.address().port}`, 35);
    try {
        const start = now();
        const res = await fetch(`${proxy.url}/v1/browser/watch`);
        const first = await res.body.getReader().read();
        assert.ok(got - start >= 30, `upstream received after ${got - start}ms`);
        assert.ok(now() - got >= 30, `downstream delay ${now() - got}ms`);
        assert.match(new TextDecoder().decode(first.value), /event: test/);
        assert.equal(res.status, 200);
    }
    finally {
        finish();
        await proxy.close();
        upstream.closeAllConnections();
        await new Promise(r => upstream.close(r));
    }
});
test("the delay proxy only forwards a path to its own upstream, never to a host the request names", async () => {
    let upstreamHits = 0, elsewhereHits = 0;
    const upstream = createServer((req, res) => { upstreamHits++; res.end('ok'); });
    const elsewhere = createServer((req, res) => { elsewhereHits++; res.end('elsewhere'); });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    await new Promise(r => elsewhere.listen(0, '127.0.0.1', r));
    const proxy = await startLink(`http://127.0.0.1:${upstream.address().port}`, 0);
    const ask = (path) => new Promise((ok, no) => {
        const r = request({ host: '127.0.0.1', port: new URL(proxy.url).port, path, agent: false }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
        r.on('error', no);
        r.end();
    });
    try {
        const other = `127.0.0.1:${elsewhere.address().port}`;
        assert.equal(await ask(`http://${other}/v1/browser/watch`), 400, "an absolute address is refused");
        assert.equal(await ask(`//${other}/v1/browser/watch`), 400, "a scheme-relative one too");
        assert.equal(elsewhereHits, 0, "nothing reached the other host");
        assert.equal(await ask('/v1/health?x=1'), 200, "a path goes to the upstream");
        assert.equal(upstreamHits, 1);
    }
    finally {
        await proxy.close();
        for (const s of [upstream, elsewhere]) {
            s.closeAllConnections();
            await new Promise(r => s.close(r));
        }
    }
});
test("Chrome expected-display metadata can be later than the encoded frame; preserve signed deltas", () => {
    const times = { input: 0, sent: 1, cloud: 2, runner: 3, handled: 4, frame: 20, sourceReceived: 10, forwarded: 11, received: 12, painted: 14 };
    const hops = hopTimings(times);
    assert.equal(hops.frame_to_cloud, -9);
    assert.equal(hops.page_to_encoded_frame, 6);
    assert.equal(hops.encoded_frame_to_cloud, 1);
    assert.throws(() => hopTimings({ ...times, forwarded: 5 }), /encoded_frame_to_cloud/);
});
test('click attribution follows release, retains press queue depth, and cannot borrow a later sample', () => {
    const sample = { kind: 'click', value: 1, start: 100, paint: { at: 250, timestamp: .2 } };
    const input = (phase, type, at, depth = 0) => ({ phase, type, at, x: 200, y: 200, depth });
    const viewer = { inputs: [input('queued', 'mousePressed', 101, 5), input('sent', 'mousePressed', 120), input('queued', 'mouseReleased', 102, 6), input('sent', 'mouseReleased', 180)], dom: [{ type: 'mousedown', at: 100 }], decoded: [{ timestamp: .2, colours: [[220, 40, 40], [220, 180, 40]] }], received: [{ timestamp: .2, at: 210 }] };
    const logs = [input('cloud_got', 'mousePressed', 130), input('runner_got', 'mousePressed', 140), input('cloud_got', 'mouseReleased', 190), input('runner_got', 'mouseReleased', 191), { phase: 'source_frame', timestamp: .2, at: 200.5 }, { phase: 'cloud_frame', timestamp: .2, at: 201 }];
    const links = [{ ...input('proxy_act_in', 'mouseReleased', 185), actId: 1 }, { ...input('proxy_act_ready', 'mouseReleased', 187), actId: 1 }, { ...input('proxy_act_connection', 'mouseReleased', 188), actId: 1, connectionId: 4, newConnection: false, setupMs: 0 }, { ...input('proxy_act_out', 'mouseReleased', 189), actId: 1 }, { ...input('proxy_act_connection', 'mousePressed', 125), actId: 0, connectionId: 4, newConnection: false, setupMs: 0 }, { phase: 'proxy_sse_in', timestamp: .2, at: 202 }, { phase: 'proxy_sse_out', timestamp: .2, at: 205 }];
    const events = [{ kind: 'click', value: 1, at: 195 }];
    const result = attributeSample(structuredClone(sample), viewer, events, logs, links);
    assert.equal(result.times.sent, 180);
    assert.equal(result.hops.runner_to_page, 4);
    assert.equal(result.queueDepth, 5);
    assert.equal(result.queueWait, 78);
    assert.equal(result.hops.outbound_delay, 2);
    assert.equal(result.hops.connection_setup_and_write, 2);
    const missing = logs.filter(e => !(e.phase === 'cloud_got' && e.type === 'mouseReleased'));
    missing.push(input('cloud_got', 'mouseReleased', 300));
    assert.throws(() => attributeSample(structuredClone(sample), viewer, events, missing, links), /observation/);
    assert.throws(() => attributeSample({ ...sample, paint: { at: 250, timestamp: .21 } }, viewer, events, logs, links), /painted frame/);
});
test('WebSocket traffic survives the same propagation delay', { timeout: 5000 }, async () => {
    const upstream = createServer();
    const wss = new WebSocketServer({ server: upstream });
    wss.on('connection', ws => ws.on('message', (m) => ws.send(m)));
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const proxy = await startLink(`http://127.0.0.1:${upstream.address().port}`, 35);
    const ws = new WebSocket(proxy.url.replace('http:', 'ws:') + '/v1/connect', { handshakeTimeout: 1000 });
    try {
        await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
        const sent = now();
        ws.send('hello');
        const message = await new Promise((ok, no) => { ws.once('message', ok); ws.once('error', no); });
        assert.equal(String(message), 'hello');
        assert.ok(now() - sent >= 60);
    }
    finally {
        ws.terminate();
        await proxy.close();
        for (const s of wss.clients)
            s.terminate();
        await new Promise(r => wss.close(r));
        await new Promise(r => upstream.close(r));
    }
});
test('cleanup saves observations and runs every teardown even when evidence copying and stop fail', async () => {
    const calls = [];
    await assert.rejects(cleanupSteps(() => calls.push('save'), [
        () => { calls.push('copy'); throw new Error('copy failed'); },
        () => { calls.push('stop'); throw new Error('stop failed'); },
        () => calls.push('close'),
    ]), AggregateError);
    assert.deepEqual(calls, ['save', 'copy', 'stop', 'close', 'save']);
});
test('CPU uses cumulative time deltas per scenario rather than smoothed ps percentages', () => {
    assert.equal(cpuSeconds('01:30.50'), 90.5);
    assert.equal(cpuSeconds('1-02:03:04'), 93784);
    const a = { at: 1000, scenario: 'scroll', chromeTimes: { 1: 2 }, relaySeconds: 1 };
    const b = { at: 2000, scenario: 'scroll', chromeTimes: { 1: 2.5 }, relaySeconds: 1.25 };
    assert.deepEqual(cpuIntervals([a, b]), [{ scenario: 'scroll', chrome: 50, relay: 25, seconds: 1, appearedPids: 0, exitedPids: 0 }]);
    assert.equal(colourValue([255, 255, 255], 'click'), null);
});
test('CPU reports churn and only surviving-PID deltas when a helper exits', () => {
    const start = { at: 1000, scenario: 'scroll', chromeTimes: { 1: 2, 2: 1 }, relaySeconds: 1 };
    const end = { at: 2000, scenario: 'scroll', chromeTimes: { 1: 2.5 }, relaySeconds: 1.25 };
    assert.deepEqual(cpuIntervals([start, end]), [{ scenario: 'scroll', chrome: 50, relay: 25, seconds: 1, appearedPids: 0, exitedPids: 1 }]);
});
test('the saved real CPU counterexample reports surviving-PID work and churn without gating latency', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/browser-speed-cpu-counterexample.json', import.meta.url), 'utf8'));
    const [interval] = cpuIntervals([fixture.before, fixture.after]);
    assert.ok(Math.abs(interval.chrome - 7 / ((fixture.after.at - fixture.before.at) / 1000)) < 1e-9);
    assert.equal(interval.appearedPids, 0);
    assert.equal(interval.exitedPids, 3);
    const [reset] = cpuIntervals([{ at: 0, scenario: 'rest', chromeTimes: { 1: 2 }, relaySeconds: 2 }, { at: 1000, scenario: 'rest', chromeTimes: { 1: 1 }, relaySeconds: 1 }]);
    assert.equal(reset.chrome, 0);
    assert.equal(reset.relay, 0);
});
test('cold HTTP connections pay one extra RTT while warm acts reuse the paired connection', { timeout: 5000 }, async () => {
    mkdirSync('.scratch', { recursive: true });
    const logFile = '.scratch/probe-connection-test.jsonl';
    writeFileSync(logFile, '');
    const upstream = createServer(async (req, res) => { for await (const chunk of req)
        void chunk; res.end('ok'); });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const proxy = await startLink(`http://127.0.0.1:${upstream.address().port}`, 35, logFile);
    const firstAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    const secondAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    const act = agent => new Promise((ok, no) => {
        const req = request(proxy.url + '/v1/browser/act', { agent, method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.once('end', ok); });
        req.once('error', no);
        req.end(JSON.stringify({ act: 'input', method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 200, y: 200 } }));
    });
    try {
        await act(firstAgent);
        await new Promise(r => setTimeout(r, 15));
        await act(firstAgent);
        firstAgent.destroy();
        await act(secondAgent);
        const logs = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        const acts = logs.filter(e => e.phase === 'proxy_act_connection');
        assert.deepEqual(acts.map(e => e.newConnection), [true, false, true]);
        assert.equal(acts[0].connectionId, acts[1].connectionId);
        assert.notEqual(acts[0].connectionId, acts[2].connectionId);
        const opens = logs.filter(e => e.phase === 'connection_open' && e.direction === 'upstream' && e.transport === 'http');
        assert.equal(opens.length, 2);
        for (const open of opens) {
            const ready = logs.find(e => e.phase === 'connection_ready' && e.connectionId === open.connectionId);
            assert.ok(ready.at - open.at >= 65);
        }
        for (const act of acts) {
            const input = logs.find(e => e.phase === 'proxy_act_in' && e.actId === act.actId);
            const ready = logs.find(e => e.phase === 'proxy_act_ready' && e.actId === act.actId);
            assert.ok(ready.at - input.at >= 30);
        }
    }
    finally {
        firstAgent.destroy();
        secondAgent.destroy();
        await proxy.close();
        upstream.closeAllConnections();
        await new Promise(r => upstream.close(r));
    }
});
test('acts on the browser input socket are logged as POST acts are, in order, without their text', { timeout: 5000 }, async () => {
    mkdirSync('.scratch', { recursive: true });
    const logFile = '.scratch/probe-input-socket-test.jsonl';
    writeFileSync(logFile, '');
    const upstream = createServer();
    const wss = new WebSocketServer({ server: upstream });
    const got = [];
    wss.on('connection', ws => ws.on('message', (m) => got.push(JSON.parse(String(m)))));
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const proxy = await startLink(`http://127.0.0.1:${upstream.address().port}`, 35, logFile);
    const ws = new WebSocket(proxy.url.replace('http:', 'ws:') + '/v1/browser/input?bot=b', { handshakeTimeout: 1000, perMessageDeflate: false });
    try {
        await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
        const moves = Array.from({ length: 5 }, (_, i) => ({ act: 'input', method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10 + i, y: 20 } }));
        for (const m of moves)
            ws.send(JSON.stringify(m));
        ws.send(JSON.stringify({ act: 'input', method: 'Input.insertText', params: { text: 'secret-typed-words' } }));
        // A frame over 125 bytes (a 16-bit length).
        ws.send(JSON.stringify({ act: 'input', method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 200, y: 200, pad: 'x'.repeat(300) } }));
        await new Promise((ok) => { const t = setInterval(() => got.length === 7 && (clearInterval(t), ok()), 5); });
        await new Promise(r => setTimeout(r, 10));
        const text = readFileSync(logFile, 'utf8');
        assert.ok(!text.includes('secret-typed-words'), 'typed text never logged');
        const logs = text.trim().split('\n').map(l => JSON.parse(l));
        const ins = logs.filter(e => e.phase === 'proxy_act_in');
        assert.deepEqual(ins.map(e => [e.type ?? e.method, e.x]), [...moves.map(m => ['mouseMoved', m.params.x]), ['Input.insertText', undefined], ['mousePressed', 200]]);
        for (const act of ins) {
            const ready = logs.find(e => e.phase === 'proxy_act_ready' && e.actId === act.actId);
            const out = logs.find(e => e.phase === 'proxy_act_out' && e.actId === act.actId);
            const connection = logs.find(e => e.phase === 'proxy_act_connection' && e.actId === act.actId);
            assert.ok(ready.at - act.at >= 30, 'pays the outbound delay');
            assert.ok(out.at >= ready.at);
            assert.equal(connection.newConnection, false, 'sent on the open socket');
        }
    }
    finally {
        ws.terminate();
        await proxy.close();
        for (const s of wss.clients)
            s.terminate();
        await new Promise(r => wss.close(r));
        await new Promise(r => upstream.close(r));
    }
});
