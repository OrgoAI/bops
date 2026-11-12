import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { now } from "./link.mjs";
import { endGroup } from '../fixtures/cleanup.mjs';
export { now };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function cleanupSteps(save, steps) {
    const errors = [];
    for (const step of [save, ...steps, save])
        try {
            await step();
        }
        catch (e) {
            errors.push(e);
        }
    if (errors.length)
        throw new AggregateError(errors, 'Probe cleanup failed; observations saved when writable');
}
export function cpuSeconds(value) {
    const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
    const parts = clock.split(':').map(Number);
    const seconds = parts.reduce((sum, n) => sum * 60 + n, 0) + Number(days) * 86400;
    if (!Number.isFinite(seconds))
        throw new Error(`Invalid ps CPU time: ${value}`);
    return seconds;
}
export function cpuIntervals(samples) {
    const result = [];
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        const seconds = (b.at - a.at) / 1000;
        if (a.scenario !== b.scenario || seconds < .05)
            continue;
        const before = a.chromeTimes ?? {}, after = b.chromeTimes ?? {};
        const shared = Object.keys(after).filter(pid => pid in before);
        // CPU is informational: omit work from appearing/exiting PIDs and clamp counter resets.
        // This slightly undercounts; retain churn so the report can say exactly where it happened.
        const ticks = shared.reduce((sum, pid) => sum + Math.max(0, Math.round(after[pid] * 100) - Math.round(before[pid] * 100)), 0);
        const chrome = Number.isFinite(ticks) ? ticks / seconds : null;
        const relayTicks = Math.max(0, Math.round(b.relaySeconds * 100) - Math.round(a.relaySeconds * 100));
        const relay = Number.isFinite(relayTicks) ? relayTicks / seconds : null;
        result.push({ scenario: b.scenario, chrome, relay, seconds, appearedPids: Object.keys(after).filter(pid => !(pid in before)).length, exitedPids: Object.keys(before).filter(pid => !(pid in after)).length });
    }
    return result;
}
export async function until(check, what, ms = 15000) {
    const end = now() + ms;
    while (now() < end) {
        const v = await check();
        if (v)
            return v;
        await sleep(20);
    }
    throw new Error(`Timed out: ${what}`);
}
export function stats(values) {
    if (values.some((v) => !Number.isFinite(v)))
        throw new Error("Non-finite observation");
    const a = [...values].sort((x, y) => x - y);
    const percentile = (p) => a.length ? a[Math.max(0, Math.ceil(a.length * p) - 1)] : null;
    return { n: a.length, median: a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null, p90: percentile(.9) };
}
export function hopTimings(t) {
    const hops = { input_to_send: t.sent - t.input, send_to_cloud: t.cloud - t.sent, cloud_to_runner: t.runner - t.cloud, runner_to_page: t.handled - t.runner, page_to_frame: t.frame - t.handled, frame_to_cloud: t.forwarded - t.frame, cloud_to_viewer: t.received - t.forwarded, viewer_to_paint: t.painted - t.received, page_to_encoded_frame: t.sourceReceived - t.handled, encoded_frame_to_cloud: t.forwarded - t.sourceReceived };
    for (const [hop, ms] of Object.entries(hops)) {
        if (!Number.isFinite(ms))
            throw new Error(`${hop}: missing observation`);
        // Chrome reports expected display time, not encode completion. These two deltas are signed by design.
        if (!['page_to_frame', 'frame_to_cloud'].includes(hop) && ms < -2)
            throw new Error(`${hop} clock/order violation ${ms}`);
    }
    return hops;
}
export function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!['--link-ms', '--out', '--driver', '--watchers'].includes(argv[i]) || !argv[i + 1])
            throw new Error("Usage: --link-ms <0|35> --out <directory> [--driver owner|sam] [--watchers <0-3>]");
        out[argv[i].slice(2)] = argv[i + 1];
    }
    if (!out.out)
        throw new Error("--out is required");
    if (out['link-ms'] !== undefined && !['0', '35'].includes(out['link-ms']))
        throw new Error("--link-ms must be 0 or 35");
    // Who drives the bot's browser (sam: a Member of the shared workspace, by its Orgo id), and how many others watch it
    // at once: the other person first, then more tabs of either, each its own stream.
    out.driver ??= 'owner';
    if (!['owner', 'sam'].includes(out.driver))
        throw new Error("--driver must be owner or sam");
    out.watchers = Number(out.watchers ?? 0);
    if (!Number.isInteger(out.watchers) || out.watchers < 0 || out.watchers > 3)
        throw new Error("--watchers must be 0 to 3");
    out.out = resolve(out.out);
    mkdirSync(out.out, { recursive: true });
    return out;
}
export async function testSite() {
    const html = readFileSync(new URL('./page.html', import.meta.url));
    const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(html));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
export class CDP {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.id = 0;
        this.pending = new Map();
        this.handlers = new Map();
        this.open = new Promise((ok, no) => { this.ws.addEventListener('open', ok, { once: true }); this.ws.addEventListener('error', no, { once: true }); });
        this.ws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            if (m.id) {
                const p = this.pending.get(m.id);
                if (p) {
                    clearTimeout(p.timer);
                    this.pending.delete(m.id);
                    if (m.error)
                        p.no(new Error(m.error.message));
                    else
                        p.ok(m.result);
                }
            }
            else
                for (const fn of this.handlers.get(m.method) ?? [])
                    fn(m.params);
        });
    }
    on(event, fn) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); }
    async send(method, params = {}) {
        await this.open;
        const id = ++this.id;
        return new Promise((ok, no) => {
            const timer = setTimeout(() => { this.pending.delete(id); no(new Error(`CDP timeout: ${method}`)); }, 15000);
            this.pending.set(id, { ok, no, timer });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails)
            throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
    }
    close() {
        this.ws.close();
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.no(new Error('CDP closed'));
        }
        this.pending.clear();
    }
}
export async function connectPage(port) {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const tab = tabs.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
    if (!tab)
        throw new Error('No page on owned DevTools port');
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.open;
    return cdp;
}
export async function ownChrome(out, url) {
    const profile = join(out, 'chrome-profile');
    if (existsSync(profile))
        throw new Error(`Owned profile already exists: ${profile}`);
    const choices = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : process.platform === 'win32' ? [join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')] : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
    const binary = process.env.CHROME || choices.find((p) => p.includes('/') ? existsSync(p) : spawnSync('which', [p], { stdio: 'ignore' }).status === 0);
    if (!binary)
        throw new Error('Chrome not found; set CHROME to its executable');
    mkdirSync(profile);
    const chrome = spawn(binary, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--use-mock-keychain', '--password-store=basic', '--window-size=1280,800', url], { stdio: 'ignore', detached: process.platform !== 'win32' });
    let launchError;
    chrome.once('error', e => { launchError = e; });
    const stop = async () => {
        if (chrome.pid) {
            chrome.kill('SIGTERM');
            await until(() => chrome.exitCode !== null || chrome.signalCode !== null, 'owned Chrome exit', 5000).catch(() => chrome.kill('SIGKILL'));
            if (process.platform === 'win32')
                spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
            else if (!await endGroup(chrome.pid))
                throw new Error('Owned Chrome helpers did not exit');
        }
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    };
    try {
        const port = await until(() => {
            if (launchError)
                throw launchError;
            try {
                return Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
            }
            catch {
                return null;
            }
        }, 'owned Chrome DevTools');
        return { pid: chrome.pid, port, stop };
    }
    catch (e) {
        await stop();
        throw e;
    }
}
export function cpuTree(rootPid) {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,time='], { encoding: 'utf8' });
    if (r.status !== 0)
        throw new Error('ps sampling failed');
    const rows = r.stdout.trim().split('\n').map(l => { const [pid, ppid, time] = l.trim().split(/\s+/); return [Number(pid), Number(ppid), cpuSeconds(time)]; });
    const ids = new Set([rootPid]);
    let size;
    do {
        size = ids.size;
        for (const [pid, ppid] of rows)
            if (ids.has(ppid))
                ids.add(pid);
    } while (size !== ids.size);
    return { at: now(), times: Object.fromEntries(rows.filter(([pid]) => ids.has(pid)).map(([pid, , time]) => [pid, time])), pids: [...ids] };
}
