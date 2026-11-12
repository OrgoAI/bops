// Node >=22 and Chrome; no Playwright needed. Only the Chrome/profile started here is stopped.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, connectPage, now, ownChrome, sleep, stats, testSite, until } from './browser-speed/common.mjs';
export async function computerProbe(out) {
    const site = await testSite();
    let chrome, cdp;
    const images = new Map();
    const raw = { frames: [], clicks: [], scroll: null, settings: { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 } };
    try {
        chrome = await ownChrome(out, site.url);
        cdp = await connectPage(chrome.port);
        await until(() => cdp.eval('!!window.__probe'), 'test page');
        cdp.on('Page.screencastFrame', (f) => {
            void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => { });
            raw.frames.push({ at: now(), timestamp: f.metadata.timestamp, bytes: Buffer.from(f.data, 'base64').length });
            images.set(f.metadata.timestamp, f.data);
        });
        await cdp.send('Page.startScreencast', raw.settings);
        await until(() => raw.frames.length, 'first screencast frame');
        await sleep(500);
        for (let i = 0; i < 30; i++) {
            const start = now();
            const before = raw.frames.length;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button: 'left', clickCount: 1 });
            const event = await until(async () => { const es = await cdp.eval('window.__probe.events'); return es.find(e => e.kind === 'click' && e.at >= start); }, 'computer click handled');
            const frame = await until(async () => {
                for (const f of raw.frames.slice(before).filter(f => f.at >= event.at)) {
                    if (f.colour === undefined) {
                        f.colour = await cdp.eval(`(async()=>{const b=await createImageBitmap(await (await fetch('data:image/jpeg;base64,${images.get(f.timestamp)}')).blob());const c=new OffscreenCanvas(1,1);const x=c.getContext('2d');x.drawImage(b,200,200,1,1,0,0,1,1);b.close();const p=x.getImageData(0,0,1,1).data;return [[40,80,220],[220,40,40]].findIndex(rgb=>rgb.every((n,i)=>Math.abs(p[i]-n)<=35));})()`);
                    }
                    if (f.colour === event.value)
                        return f;
                }
            }, 'first frame with changed click colour');
            raw.clicks.push({ start, handled: event.at, frame: frame.timestamp * 1000, received: frame.at });
            await sleep(Math.max(0, 600 - (now() - start)));
        }
        const start = now();
        while (now() - start < 5000) {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1000, y: 500, deltaY: 80, deltaX: 0 });
            await sleep(16);
        }
        const end = now();
        await sleep(250);
        const frames = raw.frames.filter(f => f.at >= start && f.at < end);
        raw.scroll = { start, end, frames: frames.length, bytes: frames.reduce((s, f) => s + f.bytes, 0) };
        const perSecond = Array.from({ length: 5 }, (_, i) => frames.filter(f => f.at >= start + i * 1000 && f.at < start + (i + 1) * 1000));
        assertCounts(raw);
        const summary = { dispatch_to_encoded_frame_ms: stats(raw.clicks.map(c => c.received - c.start)), page_to_encoded_frame_ms: stats(raw.clicks.map(c => c.received - c.handled)), dispatch_to_frame_ms: stats(raw.clicks.map(c => c.frame - c.start)), page_to_frame_ms: stats(raw.clicks.map(c => c.frame - c.handled)), scroll_fps: stats(perSecond.map(f => f.length)), scroll_bytes_per_second: stats(perSecond.map(fs => fs.reduce((s, f) => s + f.bytes, 0))), scroll_bytes_per_frame: stats(frames.map(f => f.bytes)), caveat: 'First JPEG verified to contain the changed colour; offscreen pixel sampling is used for click attribution. metadata.timestamp is expected display time, not encode completion; dispatch_to_encoded_frame_ms measures actual JPEG delivery. No physical display measurement. Owned Chrome only.' };
        writeFileSync(join(out, 'raw.json'), JSON.stringify(raw, null, 2));
        writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
        return summary;
    }
    finally {
        if (cdp) {
            await cdp.send('Page.stopScreencast').catch(() => { });
            cdp.close();
        }
        if (chrome)
            await chrome.stop();
        await site.close();
    }
}
function assertCounts(raw) {
    if (raw.clicks.length !== 30 || !raw.scroll.frames)
        throw new Error('Incomplete computer-side observations');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const options = args(process.argv.slice(2));
    console.log(JSON.stringify(await computerProbe(options.out), null, 2));
}
