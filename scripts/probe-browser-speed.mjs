// Outside-in baseline. The only implementation-specific observation is the opt-in hidden queue counter.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BOT } from './fixtures/two-person.mjs';
import { args, cleanupSteps, connectPage, cpuSeconds, cpuTree, now, sleep, testSite, until } from './browser-speed/common.mjs';
import { installViewerProbe, PALETTE } from './browser-speed/viewer.mjs';
import { summarize } from './browser-speed/summarize.mjs';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const options = args(process.argv.slice(2));
if (options['link-ms'] === undefined)
    throw new Error('--link-ms is required');
const delay = Number(options['link-ms']);
const out = options.out;
const statePath = join(root, '.scratch/two-person/stack.json');
function running() {
    try {
        const s = JSON.parse(readFileSync(statePath, 'utf8'));
        process.kill(s.pid, 0);
        return s.ready ? s : null;
    }
    catch {
        return null;
    }
}
async function stackCommand(command, env = process.env) {
    const child = spawn(process.execPath, ['scripts/dev-two-person.mjs', command], { cwd: root, env, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0)
        throw new Error(`two-person ${command} exited ${code}`);
}
const raw = { version: 2, linkMs: delay, startedAt: now(), samples: [], cpu: [], cpuErrors: [], scenarios: [], scroll: null, clock: [], errors: [] };
let started = false, stack, browser, context, page, source, site, cpuTimer;
const write = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2));
let cleanupPromise;
function cleanup() { return cleanupPromise ??= performCleanup(); }
async function performCleanup() {
    clearInterval(cpuTimer);
    if (page && !page.isClosed())
        raw.viewer = await page.evaluate(() => window.__speed).catch(() => null);
    if (source)
        raw.page = await source.eval('window.__probe').catch(() => null);
    raw.endedAt = now();
    await cleanupSteps(() => write('raw.json', raw), [
        () => {
            if (stack)
                copyFileSync(join(root, '.scratch/two-person/stack.log'), join(out, 'stack.log'));
        },
        () => {
            if (stack?.probe?.logFile)
                copyFileSync(stack.probe.logFile, join(out, 'link.jsonl'));
        },
        () => source?.close(), () => context?.close(), () => browser?.close(), () => site?.close(),
        () => started ? stackCommand('stop') : undefined,
    ]);
}
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => { raw.errors.push(signal); void cleanup().finally(() => process.exit(1)); });
try {
    raw.revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    stack = running();
    if (stack && (!stack.probe?.timing || stack.probe.delay !== delay))
        throw new Error('Existing stack has a different probe configuration; stop it explicitly before this run.');
    if (!stack) {
        started = true;
        await stackCommand('start', { ...process.env, BOPS_BROWSER_PROBE: '1', TWO_PERSON_BROWSER_LINK_MS: String(delay) });
        stack = running();
    }
    assert.ok(stack?.probe?.timing, 'timing-enabled local stack');
    raw.stack = { ports: stack.ports, urls: stack.urls, pid: stack.pid, probe: stack.probe };
    site = await testSite();
    source = await connectPage(stack.ports.chrome);
    await source.send('Page.navigate', { url: site.url });
    await until(() => source.eval('!!window.__probe'), 'source test page');
    const proc = spawnSync('ps', ['-o', 'pid=,comm=', '-p', stack.children.join(',')], { encoding: 'utf8' });
    const chromePid = Number(proc.stdout.split('\n').find(l => l.includes('Google Chrome'))?.trim().split(/\s+/)[0]);
    if (!chromePid)
        raw.cpuErrors.push({ at: now(), scenario: 'setup', error: 'Stand-in Chrome PID not observed; CPU unavailable' });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    raw.versions = { node: process.version, source: (await source.send('Browser.getVersion')).product, viewer: browser.version(), platform: process.platform };
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await context.route(/^(?!(https?|wss?):\/\/127\.0\.0\.1[:/])(?!data:)(?!blob:)/, r => r.abort());
    await context.addInitScript(installViewerProbe);
    page = await context.newPage();
    await page.goto(stack.urls.owner, { waitUntil: 'load' });
    await page.locator(`div.group\\/tab[title="${BOT.name}'s browser"]`).click({ timeout: 30000 });
    await page.locator('[data-bot-browser] canvas[data-drawn]').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Take over', exact: true }).click();
    await page.getByRole('button', { name: 'Hand back', exact: true }).waitFor();
    await until(() => page.evaluate(() => window.__speed.painted.length), 'observed canvas paint');
    const drained = () => until(() => page.evaluate(() => window.__speed.pending === 0), 'viewer queue drained', 30000);
    const point = async (x, y) => page.locator('[data-bot-browser] canvas').evaluate((c, { x, y }) => {
        const r = c.getBoundingClientRect();
        const m = window.__speed.received.at(-1).meta;
        return { x: r.left + x * r.width / m.deviceWidth, y: r.top + y * r.height / m.deviceHeight };
    }, { x, y });
    const move = async (x, y) => { const p = await point(x, y); await page.mouse.move(p.x, p.y); };
    const painted = (kind, value, start, latest = false) => until(() => page.evaluate(({ kind, start, latest, expected }) => {
        const index = kind === 'click' ? 0 : 1;
        const matches = p => p && p.at >= start && expected.every((channel, i) => Math.abs(p.colours[index][i] - channel) <= 35);
        return latest ? (matches(window.__speed.painted.at(-1)) && window.__speed.painted.at(-1)) : window.__speed.painted.find(matches);
    }, { kind, start, latest, expected: PALETTE[kind][value] }), `${kind} colour at viewer`, 30000);
    // Warm route compilation, then exclude it from the measurement interval.
    await move(200, 200);
    await drained();
    await sleep(500);
    for (const [name, readClock] of [['viewer', () => page.evaluate(() => performance.timeOrigin + performance.now())], ['source', () => source.eval('performance.timeOrigin+performance.now()')]]) {
        for (let i = 0; i < 5; i++) {
            const a = now();
            const theirs = await readClock();
            const b = now();
            raw.clock.push({ name, at: theirs, offsetMs: theirs - (a + b) / 2, uncertaintyMs: (b - a) / 2 });
        }
    }
    let scenario = 'rest';
    const sampleCPU = () => {
        try {
            if (!chromePid)
                throw new Error('Stand-in Chrome PID unavailable');
            const chrome = cpuTree(chromePid);
            const r = spawnSync('ps', ['-p', String(stack.pid), '-o', 'time='], { encoding: 'utf8' });
            if (r.status !== 0)
                throw new Error('relay ps failed');
            raw.cpu.push({ at: now(), scenario, chromeTimes: chrome.times, chromePids: chrome.pids, relaySeconds: cpuSeconds(r.stdout.trim()) });
        }
        catch (error) {
            raw.cpuErrors.push({ at: now(), scenario, error: String(error.message ?? error) });
        }
    };
    sampleCPU();
    cpuTimer = setInterval(sampleCPU, 1000);
    raw.measurementStart = now();
    raw.scenarios.push({ name: 'rest', start: raw.measurementStart });
    const nextScenario = name => { sampleCPU(); raw.scenarios.at(-1).end = now(); scenario = name; raw.scenarios.push({ name, start: now() }); sampleCPU(); };
    let clickValue = await source.eval('window.__probe.click');
    async function clickSample(scenario, moving, idleMs = 0) {
        await drained();
        await move(200, 200);
        await drained();
        await sleep(150);
        if (moving) {
            const end = now() + 2000;
            while (now() < end) {
                const t = now();
                await move(200 + 100 * Math.sin(t / 60), 200 + 70 * Math.cos(t / 80));
                await sleep(8);
            }
            await move(200, 200);
        }
        let idle;
        if (idleMs) {
            const start = now();
            await sleep(idleMs);
            idle = { start, end: now(), waitedMs: now() - start };
        }
        const start = now();
        // The pointer is already in place. Avoid Playwright click's extra mouse move warming an idle connection.
        await page.mouse.down();
        await page.mouse.up();
        clickValue ^= 1;
        const paint = await painted('click', clickValue, start);
        raw.samples.push({ scenario, kind: 'click', value: clickValue, start, paint, ...(idle ? { idle } : {}) });
        await sleep(Math.max(0, 650 - (now() - start)));
    }
    console.log(`link ${delay} ms: 30 rest clicks`);
    for (let i = 0; i < 30; i++)
        await clickSample('rest', false);
    console.log(`link ${delay} ms: 15 clicks after two seconds moving`);
    nextScenario('moving');
    for (let i = 0; i < 15; i++)
        await clickSample('moving', true);
    console.log(`link ${delay} ms: 30 hovers`);
    nextScenario('hover');
    for (let i = 0; i < 30; i++) {
        await move(1000, 400);
        await drained();
        await painted('hover', 0, 0, true);
        await sleep(100);
        const start = now();
        await move(700, 200);
        const paint = await painted('hover', 1, start);
        raw.samples.push({ scenario: 'hover', kind: 'hover', value: 1, start, paint });
        await drained();
        await sleep(150);
    }
    console.log(`link ${delay} ms: 10 clicks after six seconds idle`);
    nextScenario('idle');
    for (let i = 0; i < 10; i++)
        await clickSample('idle', false, 6000);
    await move(1000, 500);
    await drained();
    await sleep(200);
    console.log(`link ${delay} ms: five seconds scrolling`);
    nextScenario('scroll');
    const scrollStart = now();
    while (now() - scrollStart < 5000) {
        await page.mouse.wheel(0, 80);
        await sleep(16);
    }
    raw.scroll = { start: scrollStart, end: scrollStart + 5000 };
    await drained();
    await sleep(300);
    sampleCPU();
    raw.scenarios.at(-1).end = now();
    raw.measurementEnd = now();
    await page.screenshot({ path: join(out, 'viewer.png') });
}
catch (e) {
    raw.errors.push(e.stack ?? String(e));
    throw e;
}
finally {
    await cleanup();
}
try {
    const logs = readFileSync(join(out, 'stack.log'), 'utf8').split('\n').flatMap(l => {
        const m = /\[browser-probe\] (\{.*\})/.exec(l);
        return m ? [JSON.parse(m[1])] : [];
    });
    const links = readFileSync(join(out, 'link.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const summary = summarize(raw, logs, links);
    write('raw.json', raw);
    write('summary.json', summary);
    console.log(JSON.stringify(summary, null, 2));
}
catch (e) {
    raw.errors.push(e.stack ?? String(e));
    write('raw.json', raw);
    throw e;
}
