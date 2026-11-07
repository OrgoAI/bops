import { Agent, createServer, request } from "node:http";
import { appendFileSync } from "node:fs";
import { connect } from 'node:net';
export const now = () => performance.timeOrigin + performance.now();
/** A fixed propagation delay, not a bandwidth cap or a serial sleep per chunk. */
export async function startLink(target, delayMs, logFile) {
    const sockets = new Set();
    const upstreams = new Set();
    const timers = new Set();
    const agents = new Set(), paired = new WeakMap(), info = new WeakMap();
    let nextConnection = 0, nextAct = 0;
    const log = (phase, detail) => logFile && appendFileSync(logFile, JSON.stringify({ phase, at: now(), ...detail }) + "\n");
    const later = (fn, ms = delayMs) => {
        const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
        timers.add(timer);
    };
    const openConnection = (options, downstreamId, transport, callback) => {
        const connectionId = ++nextConnection, startAt = now();
        log('connection_open', { direction: 'upstream', connectionId, downstreamId, transport, setupDelayMs: 2 * delayMs });
        later(() => {
            const socket = connect(options);
            sockets.add(socket);
            const metadata = { connectionId, downstreamId, startAt };
            info.set(socket, metadata);
            let settled = false;
            socket.once('error', error => { if (!settled) {
                settled = true;
                callback(error);
            } });
            socket.once('connect', () => {
                if (settled)
                    return;
                settled = true;
                metadata.readyAt = now();
                log('connection_ready', { direction: 'upstream', connectionId, downstreamId, transport, setupMs: metadata.readyAt - startAt });
                callback(null, socket);
            });
            socket.once('close', () => { sockets.delete(socket); log('connection_close', { direction: 'upstream', connectionId, downstreamId, transport }); });
        }, 2 * delayMs);
    };
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        const body = Buffer.concat(chunks);
        let act;
        if (req.url === "/v1/browser/act") {
            let parsed;
            try {
                parsed = JSON.parse(body.toString());
            }
            catch {
                parsed = {};
            }
            const p = parsed.params ?? {};
            act = { actId: ++nextAct, act: parsed.act, method: parsed.method, type: p.type, x: p.x, y: p.y };
            log("proxy_act_in", act);
        }
        later(() => {
            if (res.destroyed)
                return;
            if (act)
                log("proxy_act_ready", act);
            const up = request(new URL(req.url, target), { agent: paired.get(req.socket).agent, method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (reply) => {
                let pending = "";
                if (act)
                    log("proxy_reply_in", { status: reply.statusCode });
                later(() => {
                    if (!res.destroyed)
                        res.writeHead(reply.statusCode, reply.headers);
                });
                reply.on("data", (chunk) => {
                    const events = [];
                    // Parse only event boundaries for timings, forward original bytes without re-encoding.
                    if (req.url.startsWith("/v1/browser/watch")) {
                        pending += chunk.toString();
                        let end;
                        while ((end = pending.indexOf("\n\n")) >= 0) {
                            const event = pending.slice(0, end);
                            pending = pending.slice(end + 2);
                            const data = /^data: (.+)$/m.exec(event);
                            if (data) {
                                let m;
                                try {
                                    m = JSON.parse(data[1]);
                                }
                                catch {
                                    continue;
                                }
                                const event = { t: m.t, timestamp: m.meta?.timestamp };
                                events.push(event);
                                log("proxy_sse_in", event);
                            }
                        }
                    }
                    later(() => {
                        if (res.destroyed)
                            return;
                        res.write(chunk);
                        for (const event of events)
                            log('proxy_sse_out', event);
                        log("proxy_chunk_out", { path: req.url.split("?")[0], bytes: chunk.length });
                    });
                });
                reply.on("end", () => later(() => {
                    if (!res.destroyed)
                        res.end();
                }));
                reply.on("error", () => res.destroy());
            });
            up.once('socket', socket => {
                if (act) {
                    const connection = info.get(socket);
                    log('proxy_act_connection', { ...act, ...connection, newConnection: !up.reusedSocket, setupMs: up.reusedSocket ? 0 : connection.readyAt - connection.startAt });
                }
            });
            up.once('finish', () => { if (act)
                log('proxy_act_out', act); });
            upstreams.add(up);
            up.once("close", () => upstreams.delete(up));
            up.on("error", () => {
                if (!res.destroyed)
                    res.destroy();
            });
            res.once("close", () => up.destroy());
            up.end(body);
        });
    });
    // Preserve all app Cloud tunnels, including future browser WebSocket transports. Delay raw bytes in both
    // directions independently, so several chunks in flight do not pay a serial delay per chunk.
    server.on('upgrade', (req, socket, head) => {
        const destination = new URL(target);
        const downstreamId = paired.get(socket).connectionId;
        let up;
        const writeLater = (to, data) => later(() => {
            if (!to.destroyed)
                to.write(data);
        });
        const headers = { ...req.headers, host: destination.host };
        const requestHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';
        const pending = [Buffer.concat([Buffer.from(requestHead), head])];
        openConnection({ port: Number(destination.port), host: destination.hostname }, downstreamId, 'websocket', (error, connected) => {
            if (error || socket.destroyed) {
                connected?.destroy();
                socket.destroy();
                return;
            }
            up = connected;
            for (const chunk of pending)
                writeLater(up, chunk);
            pending.length = 0;
            up.on('data', data => writeLater(socket, data));
            up.on('end', () => later(() => socket.end()));
            up.on('error', () => socket.destroy());
            up.on('close', () => later(() => socket.destroy()));
        });
        socket.on('data', data => { if (up)
            writeLater(up, data);
        else
            pending.push(data); });
        socket.on('end', () => later(() => up?.end()));
        socket.on('error', () => up?.destroy());
        socket.on('close', () => up?.destroy());
    });
    server.on("connection", (s) => {
        const connectionId = ++nextConnection;
        log('connection_open', { direction: 'downstream', connectionId, transport: 'tcp' });
        const agent = new Agent({ keepAlive: true, maxSockets: 1 });
        agents.add(agent);
        agent.createConnection = (options, callback) => { openConnection(options, connectionId, 'http', callback); return undefined; };
        paired.set(s, { connectionId, agent });
        sockets.add(s);
        s.once('close', () => { sockets.delete(s); agent.destroy(); agents.delete(agent); log('connection_close', { direction: 'downstream', connectionId, transport: 'tcp' }); });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        server, url: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
            for (const timer of timers)
                clearTimeout(timer);
            for (const agent of agents)
                agent.destroy();
            for (const up of upstreams)
                up.destroy();
            for (const s of sockets)
                s.destroy();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
