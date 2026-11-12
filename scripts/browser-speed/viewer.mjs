// Injected into the viewer before the app boots. Measures the real EventSource, decoder and canvas.
export function installViewerProbe() {
    const clock = () => performance.timeOrigin + performance.now();
    const state = window.__speed = { inputs: [], dom: [], received: [], decoded: [], painted: [], pending: 0 };
    window.addEventListener('bops-browser-probe', ({ detail }) => {
        state.inputs.push(detail);
        if (detail.phase === 'queued')
            state.pending++;
        if (detail.phase === 'settled')
            state.pending--;
    });
    for (const type of ['mousedown', 'mousemove'])
        document.addEventListener(type, e => {
            if (e.target.closest?.('[data-bot-browser]'))
                state.dom.push({ type, at: performance.timeOrigin + e.timeStamp, x: e.clientX, y: e.clientY });
        }, true);
    let incoming = null;
    const EventSourceOriginal = window.EventSource;
    window.EventSource = class extends EventSourceOriginal {
        constructor(...args) {
            super(...args);
            this.addEventListener('frame', (e) => {
                const m = JSON.parse(e.data);
                incoming = { at: clock(), timestamp: m.meta.timestamp, bytes: m.data.length * 3 / 4 - (m.data.endsWith('==') ? 2 : m.data.endsWith('=') ? 1 : 0), wireBytes: new TextEncoder().encode(e.data).length, meta: m.meta };
                state.received.push(incoming);
            });
        }
    };
    const bitmaps = new WeakMap();
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 2;
    sampleCanvas.height = 1;
    const sample = sampleCanvas.getContext('2d', { willReadFrequently: true });
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    const colours = (context, width, height, meta) => {
        const points = [[200, 200], [700, 200]];
        return points.map(([x, y]) => [...context.getImageData(Math.floor(x * width / meta.deviceWidth), Math.floor(y * height / meta.deviceHeight), 1, 1).data].slice(0, 3));
    };
    const create = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (...args) => {
        const frame = incoming;
        const b = await create(...args);
        if (frame) {
            bitmaps.set(b, frame);
            // Two one-pixel samples; reuse the app's decode, never start another capture or decoder.
            [[200, 200], [700, 200]].forEach(([x, y], i) => draw.call(sample, b, x * b.width / frame.meta.deviceWidth, y * b.height / frame.meta.deviceHeight, 1, 1, i, 0, 1, 1));
            const p = sample.getImageData(0, 0, 2, 1).data;
            state.decoded.push({ at: clock(), timestamp: frame.timestamp, colours: [[...p.slice(0, 3)], [...p.slice(4, 7)]] });
        }
        return b;
    };
    let latest = null, seen = null;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const result = draw.apply(this, args);
        if (this.canvas.closest?.('[data-bot-browser]') && bitmaps.has(args[0]))
            latest = { frame: bitmaps.get(args[0]), canvas: this.canvas, drawnAt: clock() };
        return result;
    };
    const tick = () => {
        if (latest && latest.frame.timestamp !== seen) {
            const { frame, canvas, drawnAt } = latest;
            if (canvas.width && canvas.height) {
                state.painted.push({ at: clock(), drawnAt, timestamp: frame.timestamp, colours: colours(canvas.getContext('2d', { willReadFrequently: true }), canvas.width, canvas.height, frame.meta) });
                seen = frame.timestamp;
            }
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
export const PALETTE = { click: [[40, 80, 220], [220, 40, 40]], hover: [[220, 180, 40], [40, 180, 70]] };
export const colourValue = (rgb, kind) => {
    const value = PALETTE[kind].findIndex(expected => expected.every((channel, i) => Math.abs(rgb[i] - channel) <= 35));
    return value < 0 ? null : value;
};
