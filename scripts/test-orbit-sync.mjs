// Tests for Orbit's metadata in the workspace's Orgo project (lib/server/orbit-sync.ts, and what it does in
// lib/server/memory-categories.ts and lib/server/orbit-issues.ts): nothing goes for a workspace without an
// Orgo project; after a sort the items that changed go as one PUT (debounced; private lines, hidden items
// and card lines stay on the Mac); what another Mac sorted, changed, merged or deleted comes back with GET
// ?since= (deleted applied first); a Forget sends the delete and the keyed hashes, and memory deletes the
// facts Orgo answers too; the hashes are HMAC-SHA256 under the workspace's secret (Workspace.orbitKey),
// plain ones from before still match, and the secret never goes to Orgo; Delete everywhere lists the
// sessions Orgo knows of (only bops-chat- and bops-task- ones); issues are Orgo's rows (status, priority,
// tags, one per thread or ticket), their history the session, and a delete keeps a session something else
// still uses; an Orgo without the routes (404 or 405) is asked again in 6 hours; Orgo down never stops Orbit.
//
// Honcho is a fake answering the REST calls its SDK makes, OpenAI a fake /v1/responses that sorts each fact
// from a table, and orgo-web a fake answering exactly as app/api/projects/[id]/orbit/** do (lib/orbit/body.ts
// views): nothing reaches a real service or the user's own data. The state and files live in a throwaway folder.
// Usage: node --conditions=react-server scripts/test-orbit-sync.mjs
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.TZ = "America/New_York";
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
process.env.ORGO_API_KEY = "sk_test_orbit";
process.env.OPENAI_API_KEY = "sk-test-orbit";
process.env.HONCHO_API_KEY = "hc-test-orbit";
process.env.BOPS_MEMORY_MODEL = "gpt-test-memory";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-orbit-sync-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "sessions"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 4000) {
  for (const end = realNow() + ms; realNow() < end; await sleep(20)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const iso = (ms) => new Date(ms).toISOString();

/* ---------------- Honcho: a fake of the REST calls the SDK makes ---------------- */

// Each bank (a Honcho workspace): its peers, each peer's card, its facts (conclusions) and the dreams asked for.
// `fail(call)` answers a call instead (a failure), `hold(call)` keeps it waiting until releaseHoncho().
const honcho = { banks: new Map(), calls: [], unknown: [], fail: null, hold: null, held: [], seq: 0 };
function hbank(id) {
  let b = honcho.banks.get(id);
  if (!b) honcho.banks.set(id, (b = { peers: new Set(), cards: new Map(), facts: [], dreams: [], sessions: new Map() }));
  return b;
}
const asConclusion = (f) => ({ id: f.id, content: f.text, observer_id: f.observer, observed_id: f.observed, session_id: f.session, created_at: iso(f.at), level: f.level, source_ids: f.from ?? null, times_derived: 1 });
function addFact(bank, text, { at = Date.now(), session = null, level = "explicit" } = {}) {
  const seq = ++honcho.seq;
  const f = { id: `c${seq}`, text, at, session, level, seq, observer: "user", observed: "user" };
  hbank(bank).facts.push(f);
  return f;
}
const removeFact = (bank, id) => void (hbank(bank).facts = hbank(bank).facts.filter((f) => f.id !== id));
const factIds = (bank) => hbank(bank).facts.map((f) => f.id);

async function honchoAnswer(req, url) {
  const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : undefined, auth: req.headers.get("authorization") };
  honcho.calls.push(call);
  if (honcho.hold?.(call)) await new Promise((r) => honcho.held.push(r));
  const failed = honcho.fail?.(call);
  if (failed) return failed;
  const p = url.pathname.split("/").slice(1);
  const created_at = iso(0);
  if (p[0] !== "v3" || p[1] !== "workspaces") return unknownCall(call);
  // Workspaces and peers: get or create.
  if (p.length === 2 && req.method === "POST") {
    hbank(call.body.id);
    return json({ id: call.body.id, metadata: {}, configuration: {}, created_at });
  }
  const b = hbank(p[2]);
  const rest = p.slice(3).join("/");
  if (rest === "peers" && req.method === "POST") {
    b.peers.add(call.body.id);
    return json({ id: call.body.id, workspace_id: p[2], metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, created_at });
  }
  const card = rest.match(/^peers\/([^/]+)\/card$/);
  if (card && req.method === "GET") return json({ peer_card: b.cards.get(card[1]) ?? null });
  if (card && req.method === "PUT") {
    b.cards.set(card[1], call.body.peer_card);
    return json({ peer_card: call.body.peer_card });
  }
  // Conclusions: newest first, 100 a page at most, with the total, for one observer and observed; and by
  // id, as getMany asks (filters.id.in), the ones that aren't there left out.
  if (rest === "conclusions/list" && req.method === "POST") {
    const f = call.body?.filters ?? {};
    for (const k of Object.keys(f)) if (!["observer_id", "observed_id", "id"].includes(k)) honcho.unknown.push(`conclusions/list filter ${k}`);
    if (f.id !== undefined && !Array.isArray(f.id?.in)) honcho.unknown.push(`conclusions/list filter id ${JSON.stringify(f.id)}`);
    const ids = Array.isArray(f.id?.in) ? new Set(f.id.in) : null;
    const page = Number(call.query.page ?? 1);
    const size = Number(call.query.size ?? 50);
    if (size > 100) return json({ detail: "size can be 100 at most" }, 422);
    const all = b.facts
      .filter((x) => (!f.observer_id || x.observer === f.observer_id) && (!f.observed_id || x.observed === f.observed_id) && (!ids || ids.has(x.id)))
      .sort((x, y) => y.at - x.at || y.seq - x.seq);
    return json({ items: all.slice((page - 1) * size, page * size).map(asConclusion), total: all.length, page, size, pages: Math.ceil(all.length / size) });
  }
  if (rest === "conclusions/query" && req.method === "POST") return json([]);
  if (rest === "conclusions" && req.method === "POST") return json(call.body.conclusions.map((c) => asConclusion(addFact(p[2], c.content, { session: c.session_id ?? null }))));
  const one = rest.match(/^conclusions\/([^/]+)$/);
  if (one && req.method === "DELETE") {
    if (!b.facts.some((x) => x.id === one[1])) return json({ detail: "Conclusion not found" }, 404);
    removeFact(p[2], one[1]);
    return new Response(null, { status: 204 });
  }
  // Sessions: made (get or create), listed (metadata filters match by containment), deleted with their messages.
  const asSession = (x) => ({ id: x.id, workspace_id: p[2], is_active: true, metadata: x.metadata, configuration: x.configuration, created_at });
  if (rest === "sessions" && req.method === "POST") {
    let x = b.sessions.get(call.body.id);
    if (!x) b.sessions.set(call.body.id, (x = { id: call.body.id, metadata: call.body.metadata ?? {}, configuration: call.body.configuration ?? {}, peers: { ...(call.body.peers ?? {}) }, messages: [] }));
    return json(asSession(x));
  }
  if (rest === "sessions/list" && req.method === "POST") {
    const f = call.body?.filters ?? {};
    const all = [...b.sessions.values()].filter((x) => (!f.id || x.id === f.id) && Object.entries(f.metadata ?? {}).every(([k, v]) => JSON.stringify(x.metadata[k]) === JSON.stringify(v)));
    return json({ items: all.map(asSession), total: all.length, page: 1, size: 50, pages: 1 });
  }
  const sess = rest.match(/^sessions\/([^/]+)(?:\/(.*))?$/);
  if (sess) {
    const x = b.sessions.get(sess[1]);
    if (!x) return json({ detail: "Session not found" }, 404);
    if (!sess[2] && req.method === "DELETE") {
      b.sessions.delete(x.id);
      return new Response(null, { status: 202 });
    }
    if (!sess[2] && req.method === "PUT") {
      if (call.body.metadata) x.metadata = call.body.metadata;
      if (call.body.configuration) x.configuration = call.body.configuration;
      return json(asSession(x));
    }
    if (sess[2] === "peers" && req.method === "POST") {
      Object.assign(x.peers, call.body);
      return json(asSession(x));
    }
    const pc = sess[2]?.match(/^peers\/([^/]+)\/config$/);
    if (pc && req.method === "PUT") {
      x.peers[pc[1]] = { ...x.peers[pc[1]], ...call.body };
      return new Response(null, { status: 204 });
    }
    if (sess[2] === "messages" && req.method === "POST") {
      const made = call.body.messages.map((m) => ({ id: `m${++honcho.seq}`, content: m.content, peer_id: m.peer_id, session_id: x.id, workspace_id: p[2], metadata: m.metadata ?? {}, configuration: m.configuration, created_at: m.created_at ?? iso(Date.now()), token_count: 1 }));
      x.messages.push(...made);
      return json(made);
    }
    if (sess[2] === "messages/list" && req.method === "POST") return json({ items: x.messages, total: x.messages.length, page: 1, size: 50, pages: 1 });
  }
  if (rest === "schedule_dream" && req.method === "POST") {
    b.dreams.push(call.body);
    return new Response(null, { status: 204 });
  }
  return unknownCall(call);
}
const unknownCall = (call) => (honcho.unknown.push(`${call.method} ${call.path}`), json({ detail: "Not Found" }, 404));

/* ---------------- OpenAI: a fake /v1/responses that sorts each fact from a table ---------------- */

const SORTS = new Map();
const item = (category, title, more = {}) => ({ category, title, detail: "", key: "", when: "", who: "", done: false, ...more });
const openai = { calls: [] };
const response = (text) => ({
  id: `resp_${openai.calls.length}`,
  object: "response",
  model: "gpt-test",
  status: "completed",
  output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});
async function openaiAnswer(req) {
  const body = JSON.parse(await req.text());
  if (body.text?.format?.name !== "memory_items") return json(response("NONE"));
  const input = JSON.parse(body.input);
  openai.calls.push(input.facts.map((f) => f.fact));
  return json(response(JSON.stringify({ facts: input.facts.map((f) => ({ i: f.i, items: SORTS.get(f.fact) ?? [] })) })));
}
/** Every fact text the model was asked to sort since call `h`. */
const askedSince = (h) => openai.calls.slice(h).flat();

/* ---------------- orgo-web: a fake answering as app/api/projects/[id]/orbit/** do ---------------- */

// Each project's Orbit, as its tables keep it, and every call. `down`: Orgo doesn't answer. `missing`: an Orgo
// without the routes (Next's own 404 page, no JSON). `hold(call)` keeps a call waiting until releaseOrgo().
const orgo = { calls: [], projects: new Map(), down: false, missing: false, hold: null, held: [], answer: null };
const CATEGORIES = ["people", "todos", "events", "promises", "companies", "projects", "decisions", "preferences"];
const STATUSES = ["open", "waiting_them", "waiting_us", "done"];
const PRIORITIES = ["urgent", "high", "normal", "low"];
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHEN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;
function oproj(id) {
  let p = orgo.projects.get(id);
  if (!p) orgo.projects.set(id, (p = { items: new Map(), issues: new Map(), events: [], tombstones: new Map(), deletions: [] }));
  return p;
}
const releaseOrgo = () => {
  orgo.hold = null;
  for (const r of orgo.held.splice(0)) r();
};
const isoOf = (v) => (v === null || v === undefined ? null : new Date(typeof v === "number" ? v : Date.parse(v)).toISOString());
const itemView = (r) => ({
  id: r.id,
  bopsId: r.bopsId,
  category: r.category,
  key: r.key,
  title: r.title,
  detail: r.detail,
  whenAt: r.whenAt,
  done: r.done,
  marked: r.marked,
  who: r.who,
  honchoBank: r.honchoBank,
  firstSeen: r.firstSeen,
  lastSeen: r.lastSeen,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
  sources: r.sources.map((s) => ({ honchoConclusionId: s.honchoConclusionId, honchoSessionId: s.honchoSessionId ?? null, said: s.said ?? null, at: isoOf(s.at) })),
});
const issueView = (r) => ({
  id: r.id,
  honchoBank: r.honchoBank,
  honchoSessionId: r.honchoSessionId,
  title: r.title,
  summary: r.summary,
  status: r.status,
  priority: r.priority,
  tags: r.tags,
  sourceApp: r.sourceApp,
  externalId: r.externalId,
  url: r.url,
  customerName: r.customerName,
  customerItemId: null,
  botId: r.botId,
  routineId: r.routineId,
  openedAt: iso(r.openedAt),
  closedAt: r.closedAt ? iso(r.closedAt) : null,
  updatedAt: iso(r.updatedAt),
});
const invalid = (error) => json({ error, code: "invalid_orbit" }, 400);
/** A row of another Mac's, put straight into Orgo (as its PUT would have). */
function orgoItem(pid, o) {
  const t = o.updatedAt ?? Date.now();
  const r = { id: randomUUID(), detail: null, whenAt: null, done: false, marked: false, who: null, honchoBank: "bops", firstSeen: iso(t), lastSeen: iso(t), createdAt: t, updatedAt: t, sources: [], ...o };
  oproj(pid).items.set(r.bopsId, r);
  return r;
}
const sameItem = (a, b) => JSON.stringify({ ...itemView(a), id: 0, createdAt: 0, updatedAt: 0 }) === JSON.stringify({ ...itemView(b), id: 0, createdAt: 0, updatedAt: 0 });

async function orgoAnswer(req, url) {
  const text = req.method === "GET" || req.method === "DELETE" ? await req.text() : await req.text();
  const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text ? JSON.parse(text) : undefined, auth: req.headers.get("authorization") };
  orgo.calls.push(call);
  if (orgo.hold?.(call)) await new Promise((r) => orgo.held.push(r));
  if (orgo.down) throw new TypeError("fetch failed (Orgo is down)");
  if (orgo.missing) return new Response("<!DOCTYPE html><title>404: This page could not be found.</title>", { status: 404, headers: { "content-type": "text/html" } });
  if (call.auth !== `Bearer ${process.env.ORGO_API_KEY}`) return json({ error: "Unauthorized" }, 401);
  // A test's own answer for some calls (a 401, a 409, a 400 for one item).
  const forced = orgo.answer?.(call);
  if (forced) return forced;
  const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/orbit(?:\/(.*))?$/);
  if (!m || !UUID.test(m[1])) return new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } });
  const p = oproj(m[1]);
  const rest = m[2] ?? "";
  const b = call.body ?? {};
  const now = Date.now();
  // GET …/orbit[?since=]: everything (full) or what changed after since, with a 2 minute overlap; deleted first.
  if (rest === "" && req.method === "GET") {
    const raw = call.query.since;
    const since = raw ? (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)) : null;
    if (raw && !Number.isFinite(since)) return invalid("since is epoch ms or an ISO date.");
    const full = since === null || since < now - 30 * 86_400_000;
    const after = full ? -Infinity : since - 2 * 60_000;
    const items = [...p.items.values()].filter((r) => r.updatedAt > after);
    const live = new Set([...p.items.keys()]);
    return json({
      items: items.map(itemView),
      issues: [...p.issues.values()].filter((r) => r.updatedAt > after).map(issueView),
      tombstones: [...p.tombstones.entries()].filter(([, t]) => t.createdAt > after).map(([hash, t]) => ({ hash, kind: t.kind, createdAt: iso(t.createdAt) })),
      deleted: full ? [] : p.deletions.filter((d) => d.at > after && !(d.kind === "item" && live.has(d.ref))).map((d) => (d.kind === "item" ? { kind: "item", bopsId: d.ref, at: iso(d.at) } : { kind: "issue", id: d.ref, at: iso(d.at) })),
      at: iso(now),
      full,
    });
  }
  // PUT …/orbit/items: upsert by bopsId, sources replaced; the same (category, key) under another bopsId is merged into it.
  if (rest === "items" && req.method === "PUT") {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 500) return invalid("The request is not valid.");
    for (const x of b.items) {
      if (x.private === true) return invalid("Private items stay on the Mac.");
      if (x.detailPrivate === true) return invalid("A private detail stays on the Mac.");
      if (!x.bopsId || !CATEGORIES.includes(x.category) || !x.key || !x.title || !x.honchoBank || x.title.length > 300 || x.key.length > 300) return invalid("The request is not valid.");
      if (x.whenAt != null && !WHEN.test(x.whenAt)) return invalid("A date (YYYY-MM-DD) or a datetime.");
      if (!Array.isArray(x.sources ?? []) || (x.sources ?? []).length > 100) return invalid("The request is not valid.");
      for (const s of x.sources ?? []) if (s.private === true || !s.honchoConclusionId || (s.said ?? "").length > 500) return invalid("Private lines stay on the Mac.");
      if (new Set((x.sources ?? []).map((s) => s.honchoConclusionId)).size !== (x.sources ?? []).length) return invalid("Each honchoConclusionId appears once.");
    }
    if (new Set(b.items.map((x) => x.bopsId)).size !== b.items.length) return invalid("Each bopsId appears once.");
    const out = { created: 0, updated: 0, unchanged: 0, merged: [], items: [] };
    for (const x of b.items) {
      const next = {
        bopsId: x.bopsId,
        category: x.category,
        key: x.key,
        title: x.title,
        detail: x.detail ?? null,
        whenAt: x.whenAt ?? null,
        done: !!x.done,
        marked: !!x.marked,
        who: x.who ?? null,
        honchoBank: x.honchoBank,
        firstSeen: isoOf(x.firstSeen),
        lastSeen: isoOf(x.lastSeen),
        sources: (x.sources ?? []).map((s) => ({ honchoConclusionId: s.honchoConclusionId, honchoSessionId: s.honchoSessionId ?? null, said: s.said ?? null, at: s.at ?? null })),
      };
      const other = [...p.items.values()].find((r) => r.bopsId !== x.bopsId && r.category === x.category && r.key === x.key);
      if (other) {
        const had = new Set(other.sources.map((s) => s.honchoConclusionId));
        const add = next.sources.filter((s) => !had.has(s.honchoConclusionId));
        if (other.sources.length + add.length > 100) return json({ error: "An Orbit item keeps 100 sources at most.", code: "orbit_full", what: "itemSources", limit: 100 }, 409);
        p.items.delete(x.bopsId);
        if (add.length) {
          other.sources.push(...add);
          other.updatedAt = now;
          out.updated++;
        } else out.unchanged++;
        out.merged.push({ bopsId: x.bopsId, intoBopsId: other.bopsId });
        out.items.push(itemView(other));
        continue;
      }
      const was = p.items.get(x.bopsId);
      if (was) {
        const cand = { ...was, ...next };
        if (sameItem(was, cand)) out.unchanged++;
        else {
          Object.assign(was, next, { updatedAt: now });
          out.updated++;
        }
        out.items.push(itemView(p.items.get(x.bopsId)));
      } else {
        const r = { id: randomUUID(), ...next, createdAt: now, updatedAt: now };
        p.items.set(x.bopsId, r);
        out.created++;
        out.items.push(itemView(r));
      }
    }
    return json(out);
  }
  // DELETE …/orbit/items {bopsIds}: the rows go; the Honcho ids they had are answered; other items' sources naming those conclusions go too.
  if (rest === "items" && req.method === "DELETE") {
    if (!Array.isArray(b.bopsIds) && !Array.isArray(b.ids)) return invalid("Send ids or bopsIds, not both.");
    const rows = [...p.items.values()].filter((r) => (b.bopsIds ?? []).includes(r.bopsId) || (b.ids ?? []).includes(r.id));
    const conclusions = [...new Set(rows.flatMap((r) => r.sources.map((s) => s.honchoConclusionId)))].sort();
    const sessions = [...new Set(rows.flatMap((r) => r.sources.map((s) => s.honchoSessionId)).filter(Boolean))].sort();
    for (const r of rows) p.items.delete(r.bopsId);
    for (const r of p.items.values()) {
      const left = r.sources.filter((s) => !conclusions.includes(s.honchoConclusionId));
      if (left.length !== r.sources.length) {
        r.sources = left;
        r.updatedAt = now;
      }
    }
    const bopsIds = rows.map((r) => r.bopsId).sort();
    for (const id of bopsIds) p.deletions.push({ kind: "item", ref: id, at: now });
    return json({ deleted: rows.length, deletedBopsIds: bopsIds, honchoConclusionIds: conclusions, honchoSessionIds: sessions });
  }
  if (rest === "items/delete-everywhere-preview" && req.method === "POST") {
    const r = p.items.get(b.bopsId);
    if (!r) return json({ error: "Item not found.", code: "item_not_found" }, 404);
    const sessions = [...new Set(r.sources.map((s) => s.honchoSessionId).filter(Boolean))].sort();
    return json({
      sessions: sessions.map((s) => ({
        honchoSessionId: s,
        otherItems: [...p.items.values()].filter((o) => o.bopsId !== r.bopsId && o.sources.some((x) => x.honchoSessionId === s)).length,
        issues: [...p.issues.values()].filter((i) => i.honchoSessionId === s).length,
      })),
    });
  }
  if (rest === "tombstones" && req.method === "POST") {
    if (!Array.isArray(b.hashes) || !b.hashes.length || b.hashes.length > 1000 || !b.hashes.every((h) => HASH.test(h))) return invalid("A sha256 hash as 64 lowercase hex characters.");
    let added = 0;
    for (const h of b.hashes)
      if (!p.tombstones.has(h)) {
        p.tombstones.set(h, { kind: b.kind ?? "item", createdAt: now });
        added++;
      }
    return json({ added });
  }
  if (rest === "issues" && req.method === "GET") {
    const limit = Math.min(Math.max(Number(call.query.limit) || 50, 1), 200);
    return json({ issues: [...p.issues.values()].sort((a, c) => c.updatedAt - a.updatedAt).slice(0, limit).map(issueView) });
  }
  if (rest === "issues" && req.method === "POST") {
    if (!b.honchoSessionId || !b.title) return invalid("The request is not valid.");
    if (b.externalId && !b.sourceApp) return invalid("An externalId needs its sourceApp.");
    if (b.status && !STATUSES.includes(b.status)) return invalid("The request is not valid.");
    if (b.priority && !PRIORITIES.includes(b.priority)) return invalid("The request is not valid.");
    const was = b.sourceApp && b.externalId ? [...p.issues.values()].find((i) => i.sourceApp === b.sourceApp && i.externalId === b.externalId) : null;
    const fields = ["title", "summary", "status", "priority", "tags", "url", "customerName", "botId", "routineId", "honchoBank"];
    if (was) {
      for (const k of fields) if (b[k] !== undefined) was[k] = b[k];
      was.closedAt = was.status === "done" ? (was.closedAt ?? now) : null;
      was.updatedAt = now;
      if (b.note) p.events.push({ issue: was.id, kind: "note", text: b.note });
      return json({ issue: issueView(was), created: false }, 200);
    }
    const r = { id: randomUUID(), honchoSessionId: b.honchoSessionId, honchoBank: b.honchoBank ?? null, title: b.title, summary: b.summary ?? null, status: b.status ?? "open", priority: b.priority ?? "normal", tags: b.tags ?? [], sourceApp: b.sourceApp ?? null, externalId: b.externalId ?? null, url: b.url ?? null, customerName: b.customerName ?? null, botId: b.botId ?? null, routineId: b.routineId ?? null, openedAt: b.openedAt ? Number(new Date(b.openedAt)) : now, updatedAt: now };
    r.closedAt = r.status === "done" ? now : null;
    p.issues.set(r.id, r);
    p.events.push({ issue: r.id, kind: "opened" });
    return json({ issue: issueView(r), created: true }, 201);
  }
  const one = rest.match(/^issues\/([^/]+)$/);
  if (one) {
    const r = p.issues.get(one[1]);
    if (!UUID.test(one[1]) || !r) return json({ error: "Issue not found.", code: "issue_not_found" }, 404);
    if (req.method === "PATCH") {
      const keys = Object.keys(b).filter((k) => k !== "actor");
      if (!keys.length) return invalid("Send at least one of status, priority, tags, title, summary, note, events.");
      for (const k of ["status", "priority", "tags", "title", "summary"]) if (b[k] !== undefined) r[k] = b[k];
      r.closedAt = r.status === "done" ? (r.closedAt ?? now) : null;
      r.updatedAt = now;
      for (const e of b.events ?? []) p.events.push({ issue: r.id, ...e });
      if (b.note) p.events.push({ issue: r.id, kind: "note", text: b.note });
      return json({ issue: issueView(r) });
    }
    if (req.method === "DELETE") {
      const s = r.honchoSessionId;
      p.issues.delete(r.id);
      p.deletions.push({ kind: "issue", ref: r.id, at: now });
      const stillUsedBy = { issues: [...p.issues.values()].filter((i) => i.honchoSessionId === s).length, items: [...p.items.values()].filter((i) => i.sources.some((x) => x.honchoSessionId === s)).length };
      return json({ honchoSessionId: stillUsedBy.issues + stillUsedBy.items === 0 ? s : null, session: s, stillUsedBy });
    }
    if (req.method === "GET") return json({ issue: issueView(r), events: [] });
  }
  return new Response("<!DOCTYPE html>", { status: 405 });
}
/** The calls to a project's Orbit since `h`: "PUT items", "GET ", "POST tombstones"… */
const orgoSince = (h, what) => orgo.calls.slice(h).filter((c) => !what || `${c.method} ${c.path.replace(/^\/api\/projects\/[^/]+\/orbit\/?/, "")}` === what);

globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") return openaiAnswer(req);
  if (url.origin === "https://api.honcho.dev") return honchoAnswer(req, url);
  if (url.origin === "https://orgo.test") return orgoAnswer(req, url);
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const S = await import(`${root}/lib/server/store.ts`);
const Mem = await import(`${root}/lib/server/memory.ts`);
const MC = await import(`${root}/lib/server/memory-categories.ts`);
const OS = await import(`${root}/lib/server/orbit-sync.ts`);
const R = await import(`${root}/app/api/memory/categories/route.ts`);
const RI = await import(`${root}/app/api/orbit/issues/route.ts`);
const RI1 = await import(`${root}/app/api/orbit/issues/[id]/route.ts`);
const { botChatId, MAIN_WORKSPACE } = await import(`${root}/lib/types.ts`);
const T = OS.orbitSyncForTests;

/* ---------------- Helpers ---------------- */

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 6).join("\n  ") ?? e.message}`);
  }
}
const spoken = [];
const request = async (handler, method, path, body, params) => {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handler(new Request(`http://localhost:3210${path}`, init), params ? { params: Promise.resolve(params) } : undefined);
  const out = { status: res.status, body: await res.json() };
  spoken.push(JSON.stringify(out.body));
  return out;
};
const get = (ws) => request(R.GET, "GET", `/api/memory/categories?ws=${encodeURIComponent(ws)}`);
const post = (body) => request(R.POST, "POST", "/api/memory/categories", body);
const refresh = async (ws) => {
  const r = await post({ action: "refresh", ws });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const listIssues = (ws, q = "") => request(RI.GET, "GET", `/api/orbit/issues?ws=${ws}${q}`);
const openIssue = (ws, body) => request(RI.POST, "POST", "/api/orbit/issues", { ws, ...body });
const patchIssue = (ws, id, body) => request(RI1.PATCH, "PATCH", `/api/orbit/issues/${id}`, { ws, ...body }, { id });
const oneIssue = (ws, id) => request(RI1.GET, "GET", `/api/orbit/issues/${id}?ws=${ws}`, undefined, { id });
const removeIssue = (ws, id) => request(RI1.DELETE, "DELETE", `/api/orbit/issues/${id}?ws=${ws}`, undefined, { id });
function one(items, category, title) {
  const found = items.filter((i) => i.category === category && i.title === title);
  assert.equal(found.length, 1, `one ${category} item called ${title} (there are: ${items.filter((i) => i.category === category).map((i) => i.title).join(", ") || "none"})`);
  return found[0];
}
const fileFor = (ws) => join(work, ".data", "memory-categories", `ws-${ws}.json`);
const indexOf = (ws) => JSON.parse(readFileSync(fileFor(ws), "utf8"));
const secretOf = (ws) => S.getState().workspaces.find((w) => w.id === ws)?.orbitKey;
const keyed = (ws, text) => createHmac("sha256", secretOf(ws)).update(text).digest("hex");
const plainSha = (text) => createHash("sha256").update(text).digest("hex");
function seed(ws, list) {
  const bank = Mem.bankOf(ws);
  const out = {};
  let n = 0;
  for (const [name, text, items, opts = {}] of list) {
    SORTS.set(text, items);
    out[name] = addFact(bank, text, { at: Date.now() - 3_600_000 + ++n * 1000, ...opts });
  }
  return out;
}
/** Every look and forget done, then whatever the sync has waiting sent now (as its timers would). */
async function settle(ws = MAIN) {
  await until(() => {
    const b = globalThis.bopsCategories?.spaces.get(ws);
    return !b?.running && !b?.purging;
  }, `${ws}'s looks to end`);
  await T.flushAll();
}
/** The fake's item row for a local item. */
const rowOf = (pid, bopsId) => oproj(pid).items.get(bopsId);

const MAIN = MAIN_WORKSPACE;
const PID = "11111111-2222-4333-8444-555555555555";
const PID_B = "22222222-2222-4333-8444-555555555555";
const CHAT = `bops-chat-${botChatId("max").replace(/[^A-Za-z0-9_-]/g, "-")}`;
S.update((s) => {
  s.owner = { name: "Tiger", timeZone: "America/New_York" };
  s.account = { user: { id: "u_tiger", email: "tiger@example.com" }, signedInAt: 0 };
  s.bots.push({ id: "max", name: "Max", role: "Sales", color: "#5B8CFF", isMain: false, computerStatus: "none" });
  s.chats.push({ id: botChatId("max"), kind: "bot", botIds: ["max"], createdAt: 0, typing: [] }, { id: "other-mac-chat", kind: "bot", botIds: ["max"], createdAt: 0, typing: [] });
  const main = s.workspaces.find((w) => w.id === MAIN);
  main.orgoProjectId = PID;
  s.workspaces.push({ id: "ws_local", name: "Local", createdAt: 0 }, { id: "ws_b", name: "Shop", createdAt: 0, orgoProjectId: PID_B });
});
const OTHER_CHAT = "bops-chat-other-mac-chat";

/* ---------------- Without an Orgo project ---------------- */

await check("a workspace without an Orgo project sorts as ever, and nothing goes to Orgo", async () => {
  const h = orgo.calls.length;
  seed("ws_local", [["l1", "Tiger's barber is Sol.", [item("people", "Sol", { key: "sol", detail: "Your barber" })]]]);
  const r = await refresh("ws_local");
  one(r.items, "people", "Sol");
  await settle("ws_local");
  assert.equal(orgo.calls.length - h, 0, "no call to Orgo");
  assert.equal(T.pendingCount(), 0);
});

/* ---------------- Sending ---------------- */

let F;
let ana;
await check("after a sort the items go in one PUT, debounced: facts' and sessions' ids, never a private line, a hidden item or a card line", async () => {
  F = seed(MAIN, [
    ["a1", "Tiger's sister Ana lives in Lisbon.", [item("people", "Ana", { key: "ana", detail: "Your sister" })], { session: CHAT }],
    ["d1", "Tiger flies to Denver next Tuesday.", [item("events", "Flight to Denver", { key: "flight to denver 2026-10-20", when: "2026-10-20" })]],
    ["p1", "Mara's phone number is +44 7700 900123.", [item("people", "Mara", { key: "mara", detail: "Phone number on file" })]],
    ["l2", "Leo is Tiger's climbing partner.", [item("people", "Leo", { key: "leo", detail: "Your climbing partner" })]],
    ["l1", "Leo lives at 12 Elm Street.", [item("people", "Leo", { key: "leo", detail: "Lives at 12 Elm Street" })]],
  ]);
  hbank("bops").cards.set("user", ["Tiger's lawyer is Ben Ode."]);
  SORTS.set("Tiger's lawyer is Ben Ode.", [item("people", "Ben Ode", { key: "ben ode", detail: "Your lawyer" })]);
  const h = orgo.calls.length;
  const r = await refresh(MAIN);
  ana = one(r.items, "people", "Ana");
  assert.ok(T.pendingCount() >= 1, "waiting to go");
  assert.equal(orgoSince(h, "PUT items").length, 0, "not at once: gathered first");
  await settle();
  const puts = orgoSince(h, "PUT items");
  assert.equal(puts.length, 1, "one PUT");
  const sent = puts[0].body.items;
  assert.deepEqual(sent.map((x) => x.title).sort(), ["Ana", "Ben Ode", "Flight to Denver", "Leo"], "Mara, learned only from a phone number, stays on the Mac");
  const a = sent.find((x) => x.title === "Ana");
  assert.deepEqual(
    { ...a, firstSeen: undefined, lastSeen: undefined },
    { bopsId: ana.id, category: "people", key: "people:ana", title: "Ana", detail: "Your sister", whenAt: null, done: false, marked: false, who: null, honchoBank: "bops", firstSeen: undefined, lastSeen: undefined, sources: [{ honchoConclusionId: F.a1.id, honchoSessionId: CHAT, said: "Tiger's sister Ana lives in Lisbon.", at: iso(F.a1.at) }] },
  );
  const leo = sent.find((x) => x.title === "Leo");
  assert.equal(leo.detail, null, "a line from a private line (an address) goes empty");
  assert.deepEqual(leo.sources.map((s) => s.honchoConclusionId), [F.l2.id], "and the private fact's source stays here");
  assert.deepEqual(sent.find((x) => x.title === "Ben Ode").sources, [], "a card line isn't a fact id");
  assert.equal(sent.find((x) => x.title === "Flight to Denver").whenAt, "2026-10-20");
  const body = JSON.stringify(orgo.calls);
  for (const secret of ["+44 7700 900123", "12 Elm Street", "card:"]) assert.ok(!body.includes(secret), `never sent: ${secret}`);
  assert.equal(orgoSince(h, "GET ").length, 1, "the window's open read Orgo once");
  assert.equal(orgoSince(h, "GET ")[0].query.since, undefined, "all of it, the first time");
});

await check("only what changed goes again: nothing changed, no PUT; a rename, that item alone; a hidden item doesn't go", async () => {
  let h = orgo.calls.length;
  await refresh(MAIN);
  await settle();
  assert.equal(orgoSince(h, "PUT items").length, 0, "nothing changed");
  h = orgo.calls.length;
  assert.equal((await post({ action: "edit", ws: MAIN, id: ana.id, title: "Ana Reyes" })).status, 200);
  await settle();
  const puts = orgoSince(h, "PUT items");
  assert.deepEqual(puts.map((c) => c.body.items.map((x) => x.title)), [["Ana Reyes"]]);
  assert.equal(rowOf(PID, ana.id).title, "Ana Reyes");
  h = orgo.calls.length;
  const dentist = one((await get(MAIN)).body.items, "events", "Flight to Denver");
  await post({ action: "edit", ws: MAIN, id: dentist.id, hidden: true });
  await settle();
  assert.equal(orgoSince(h, "PUT items").length, 0, "hidden: not sent");
  await post({ action: "edit", ws: MAIN, id: dentist.id, hidden: false });
  await settle();
});

/* ---------------- Reading ---------------- */

let F2;
await check("what another Mac sorted comes with GET ?since=, its facts known here (never sorted again)", async () => {
  F2 = seed(MAIN, [["s1", "Priya Shah is Tiger's new designer.", [item("people", "Priya Shah", { key: "priya shah", detail: "Your designer" })], { session: OTHER_CHAT }]]);
  orgoItem(PID, { bopsId: "b0b0b0b0b0", category: "people", key: "people:priya shah", title: "Priya Shah", detail: "Your designer", sources: [{ honchoConclusionId: F2.s1.id, honchoSessionId: OTHER_CHAT, said: "Priya Shah is Tiger's new designer.", at: iso(F2.s1.at) }] });
  const h = orgo.calls.length;
  OS.pullSoon(MAIN);
  await settle();
  const reads = orgoSince(h, "GET ");
  assert.equal(reads.length, 1);
  assert.ok(reads[0].query.since, "with since: what changed after the last read");
  const priya = one((await get(MAIN)).body.items, "people", "Priya Shah");
  assert.equal(priya.id, "b0b0b0b0b0", "the other Mac's id");
  assert.equal(priya.detail, "Your designer");
  const n = openai.calls.length;
  await refresh(MAIN);
  assert.ok(!askedSince(n).includes("Priya Shah is Tiger's new designer."), "its fact isn't sorted again here");
  await settle();
  assert.equal(orgoSince(h, "PUT items").filter((c) => c.body.items.some((x) => x.bopsId === "b0b0b0b0b0")).length, 0, "and isn't sent back: Orgo has it as it is");
});

await check("deleted on another Mac goes here (deleted first), and its facts aren't sorted again", async () => {
  // Another Mac forgets Priya: its DELETE, as orgo-web does it.
  const p = oproj(PID);
  p.items.delete("b0b0b0b0b0");
  p.deletions.push({ kind: "item", ref: "b0b0b0b0b0", at: Date.now() });
  OS.pullSoon(MAIN);
  await settle();
  assert.ok(!(await get(MAIN)).body.items.some((i) => i.title === "Priya Shah"), "gone here");
  const n = openai.calls.length;
  await refresh(MAIN);
  assert.ok(!askedSince(n).includes("Priya Shah is Tiger's new designer."), "its fact isn't sorted again");
  await settle();
  assert.ok(!(await get(MAIN)).body.items.some((i) => i.title === "Priya Shah"), "still gone");
});

await check("an item Orgo merges (the same key on another Mac) takes that one's id here, and gets the other Mac's facts", async () => {
  const theirs = addFact("bops", "Dana Reyes runs Acme's office.", { at: Date.now() - 10_000 });
  // On Orgo before this Mac's last read window: it learns of it only from the merge.
  orgoItem(PID, { bopsId: "c0c0c0c0c0", category: "people", key: "people:dana reyes", title: "Dana Reyes", detail: "Runs Acme's office", updatedAt: Date.now() - 3_600_000, sources: [{ honchoConclusionId: theirs.id, honchoSessionId: null, said: "Dana Reyes runs Acme's office.", at: iso(theirs.at) }] });
  SORTS.set("Dana Reyes runs Acme's office.", []);
  seed(MAIN, [["k1", "Tiger met Dana Reyes at the fair.", [item("people", "Dana Reyes", { key: "dana reyes", detail: "Met at the fair" })]]]);
  await refresh(MAIN);
  await settle();
  const dana = one((await get(MAIN)).body.items, "people", "Dana Reyes");
  assert.equal(dana.id, "c0c0c0c0c0", "the id Orgo merged it into");
  assert.ok(dana.sources.some((s) => s.fact === theirs.id), "with what the other Mac knew");
  const row = rowOf(PID, "c0c0c0c0c0");
  assert.equal(row.sources.length, 2, "Orgo has both facts");
  assert.equal(oproj(PID).items.size, [...oproj(PID).items.values()].filter((r) => r.key === "people:dana reyes").length + [...oproj(PID).items.values()].filter((r) => r.key !== "people:dana reyes").length);
  assert.equal([...oproj(PID).items.values()].filter((r) => r.key === "people:dana reyes").length, 1, "one Dana there");
});

/* ---------------- Forgetting ---------------- */

await check("Forget sends the delete and keyed hashes; memory deletes the facts Orgo answers too (another Mac's)", async () => {
  // Another Mac also learned Ana from a fact this Mac sorted as nothing.
  const extra = addFact("bops", "Ana visits every summer.", { at: Date.now() - 5000 });
  SORTS.set("Ana visits every summer.", []);
  await refresh(MAIN);
  await settle();
  rowOf(PID, ana.id).sources.push({ honchoConclusionId: extra.id, honchoSessionId: null, said: "Ana visits every summer.", at: iso(extra.at) });
  const h = orgo.calls.length;
  assert.equal((await post({ action: "forget", ws: MAIN, id: ana.id })).status, 200);
  await settle();
  await MC.purge(MAIN);
  const dels = orgoSince(h, "DELETE items");
  assert.deepEqual(dels.map((c) => c.body), [{ bopsIds: [ana.id] }]);
  assert.ok(!rowOf(PID, ana.id), "gone in Orgo");
  assert.ok(!factIds("bops").includes(F.a1.id), "this Mac's fact deleted in memory");
  assert.ok(!factIds("bops").includes(extra.id), "and the one Orgo said, from the other Mac");
  const tombs = orgoSince(h, "POST tombstones");
  const items = tombs.filter((c) => c.body.kind === "item").flatMap((c) => c.body.hashes);
  const facts = tombs.filter((c) => c.body.kind === "fact").flatMap((c) => c.body.hashes);
  assert.ok(items.includes(keyed(MAIN, "item|people:ana")), "the item's hash, keyed with the workspace's secret");
  assert.ok(!items.includes(plainSha("item|people:ana")), "never a plain sha256 of the key");
  assert.ok(facts.length >= 2 && facts.every((x) => /^[0-9a-f]{64}$/.test(x)), "the facts' hashes");
  assert.ok(oproj(PID).tombstones.has(keyed(MAIN, "item|people:ana")));
  const idx = indexOf(MAIN);
  assert.equal(idx.out, undefined, "nothing left to send");
  assert.ok(!JSON.stringify(orgo.calls).includes(secretOf(MAIN)), "the secret never goes to Orgo");
  assert.match(secretOf(MAIN), /^[A-Za-z0-9_-]{43}$/, "a 32 byte secret, in the state (synced to the other Macs)");
});

await check("hashes from another Mac (the same secret) keep what it forgot gone here: memory's new fact about it is deleted", async () => {
  oproj(PID).tombstones.set(keyed(MAIN, "item|people:old flame"), { kind: "item", createdAt: Date.now() });
  OS.pullSoon(MAIN);
  await settle();
  const G = seed(MAIN, [["o1", "Tiger's old flame is Rui.", [item("people", "Old Flame", { key: "old flame" })], { level: "deductive" }]]);
  const r = await refresh(MAIN);
  assert.ok(!r.items.some((i) => i.title === "Old Flame"), "not in Orbit");
  await settle();
  await MC.purge(MAIN);
  assert.ok(!factIds("bops").includes(G.o1.id), "and deleted from memory");
});

await check("a plain sha256 hash an index kept from before still matches here (and isn't made again)", async () => {
  const idx = indexOf(MAIN);
  idx.tomb.items[plainSha("item|people:zed")] = Date.now();
  writeFileSync(fileFor(MAIN), JSON.stringify(idx));
  globalThis.bopsCategories.spaces.get(MAIN).index = undefined;
  const G = seed(MAIN, [["z1", "Zed works nights.", [item("people", "Zed", { key: "zed" })], { level: "deductive" }]]);
  const r = await refresh(MAIN);
  assert.ok(!r.items.some((i) => i.title === "Zed"), "buried");
  await settle();
  await MC.purge(MAIN);
  assert.ok(!factIds("bops").includes(G.z1.id));
  assert.ok(indexOf(MAIN).keys?.[0] === secretOf(MAIN), "the index knows the secret in use");
});

await check("Delete everywhere lists the Bops chats Orgo knows an item from (another Mac's too), never another agent's session", async () => {
  const H = seed(MAIN, [["h1", "Hana Kim is Tiger's accountant.", [item("people", "Hana Kim", { key: "hana kim", detail: "Your accountant" })], { session: CHAT }]]);
  for (const id of [CHAT, OTHER_CHAT, "hermes-9"]) hbank("bops").sessions.set(id, { id, metadata: { app: "bops" }, configuration: {}, peers: {}, messages: [] });
  const hana = one((await refresh(MAIN)).items, "people", "Hana Kim");
  await settle();
  // The other Mac learned her from its chat and from another agent's session.
  rowOf(PID, hana.id).sources.push({ honchoConclusionId: "c-other-1", honchoSessionId: OTHER_CHAT, said: null, at: null }, { honchoConclusionId: "c-other-2", honchoSessionId: "hermes-9", said: null, at: null });
  orgoItem(PID, { bopsId: "d0d0d0d0d0", category: "people", key: "people:leo park", title: "Leo Park", sources: [{ honchoConclusionId: "c-other-3", honchoSessionId: OTHER_CHAT, said: null, at: null }] });
  const pv = await post({ action: "deleteEverywhere", ws: MAIN, id: hana.id, preview: true });
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.body.sessions.map((x) => x.id).sort(), [CHAT, OTHER_CHAT].sort(), "this Mac's chat and the other Mac's; never hermes-9");
  assert.deepEqual(pv.body.sessions.find((x) => x.id === OTHER_CHAT).alsoFor, ["1 more item"], "what else it taught there");
  const d = await post({ action: "deleteEverywhere", ws: MAIN, id: hana.id, sessions: [CHAT, OTHER_CHAT] });
  assert.equal(d.status, 200);
  await settle();
  await MC.purge(MAIN);
  assert.ok(!hbank("bops").sessions.has(OTHER_CHAT) && !hbank("bops").sessions.has(CHAT), "both chats' memory copies deleted");
  assert.ok(hbank("bops").sessions.has("hermes-9"), "another agent's session stays");
  assert.ok(!factIds("bops").includes(H.h1.id));
  hbank("bops").sessions.set(CHAT, { id: CHAT, metadata: { app: "bops" }, configuration: {}, peers: {}, messages: [] });
});

await check("Orgo down: the preview is this Mac's own, and Orbit answers as ever", async () => {
  seed(MAIN, [["w1", "Wes is Tiger's plumber.", [item("people", "Wes", { key: "wes", detail: "Your plumber" })], { session: CHAT }]]);
  const wes = one((await refresh(MAIN)).items, "people", "Wes");
  orgo.down = true;
  const pv = await post({ action: "deleteEverywhere", ws: MAIN, id: wes.id, preview: true });
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.body.sessions.map((x) => x.id), [CHAT]);
  orgo.down = false;
});

/* ---------------- Issues ---------------- */

let issue;
await check("opening an issue: its row in Orgo first, then its session (the history); the same thread again is the same issue", async () => {
  const h = orgo.calls.length;
  const r = await openIssue(MAIN, { title: "Acme can't sign in", summary: "SSO fails.", priority: "high", tags: ["Customer"], sourceApp: "gmail", externalId: "thr_1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  issue = r.body.issue;
  const posts = orgoSince(h, "POST issues");
  assert.equal(posts.length, 1);
  assert.deepEqual(
    { ...posts[0].body, openedAt: undefined },
    { honchoSessionId: issue.id, honchoBank: "bops", title: "Acme can't sign in", summary: "SSO fails.", status: "open", priority: "high", tags: ["Customer"], sourceApp: "gmail", externalId: "thr_1", url: null, customerName: null, botId: null, routineId: null, openedAt: undefined },
  );
  const row = [...oproj(PID).issues.values()].find((x) => x.honchoSessionId === issue.id);
  assert.ok(row, "Orgo has it");
  assert.equal(issue.orgoId, row.id, "with Orgo's id");
  const sess = hbank("bops").sessions.get(issue.id);
  assert.ok(sess, "its session");
  assert.equal(sess.metadata.orgoId, undefined, "Orgo's id isn't in memory");
  const again = await openIssue(MAIN, { title: "Acme can't sign in", summary: "Still failing.", sourceApp: "gmail", externalId: "thr_1" });
  assert.equal(again.status, 200);
  assert.equal(again.body.issue.id, issue.id, "the same issue");
  assert.equal(oproj(PID).issues.size, 1, "one row");
});

await check("Orgo's row is what the issue is: a change on another Mac shows here, and a change here goes there as a PATCH", async () => {
  const row = [...oproj(PID).issues.values()].find((x) => x.honchoSessionId === issue.id);
  row.status = "waiting_them";
  row.updatedAt = Date.now();
  const l = await listIssues(MAIN, "&fresh=1");
  assert.equal(l.status, 200);
  assert.equal(l.body.issues.find((x) => x.id === issue.id)?.status, "waiting_them", "the other Mac's status");
  const h = orgo.calls.length;
  const p = await patchIssue(MAIN, issue.id, { priority: "urgent", note: "Called them." });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const patches = orgoSince(h).filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((c) => c.body), [{ priority: "urgent", note: "Called them." }], "only what changed");
  assert.equal(p.body.issue.status, "waiting_them", "its status stays Orgo's");
  assert.equal(row.priority, "urgent");
  const one1 = await oneIssue(MAIN, issue.id);
  assert.ok(one1.body.issue.history.some((e) => e.text === "Called them."), "the history is the session's");
});

await check("another Mac opened the same thread first: Orgo answers its issue, and this Mac makes no session", async () => {
  const theirs = `issue-${randomUUID()}`;
  hbank("bops").sessions.set(theirs, { id: theirs, metadata: { app: "bops", type: "issue", ws: MAIN, status: "open", priority: "normal", tags: [], title: "Refund", summary: "", openedAt: Date.now(), updatedAt: Date.now() }, configuration: {}, peers: {}, messages: [] });
  const t = Date.now();
  oproj(PID).issues.set("33333333-2222-4333-8444-555555555555", { id: "33333333-2222-4333-8444-555555555555", honchoSessionId: theirs, honchoBank: "bops", title: "Refund", summary: null, status: "open", priority: "normal", tags: [], sourceApp: "slack", externalId: "T9", url: null, customerName: null, botId: null, routineId: null, openedAt: t, updatedAt: t, closedAt: null });
  const before = hbank("bops").sessions.size;
  const r = await openIssue(MAIN, { title: "Refund for Bo", sourceApp: "slack", externalId: "T9" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, false);
  assert.equal(r.body.issue.id, theirs, "the other Mac's issue");
  assert.equal(hbank("bops").sessions.size, before, "no second session");
});

await check("deleting an issue: its row, then its session; a session something else still uses stays (and is no longer an issue)", async () => {
  const shared = (await openIssue(MAIN, { title: "Printer jam", sourceApp: "gmail", externalId: "thr_2" })).body.issue;
  // An item's fact came from that session (Orgo says so on the delete).
  orgoItem(PID, { bopsId: "e0e0e0e0e0", category: "todos", key: "todos:fix printer", title: "Fix the printer", sources: [{ honchoConclusionId: "c-printer", honchoSessionId: shared.id, said: null, at: null }] });
  let d = await removeIssue(MAIN, shared.id);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.ok(![...oproj(PID).issues.values()].some((x) => x.honchoSessionId === shared.id), "the row is gone");
  assert.ok(hbank("bops").sessions.has(shared.id), "the session stays: an item still uses it");
  assert.equal(hbank("bops").sessions.get(shared.id).metadata.type, "issue-deleted", "and it's not an issue any more");
  const l = await listIssues(MAIN, "&fresh=1");
  assert.ok(!l.body.issues.some((x) => x.id === shared.id), "not listed");
  d = await removeIssue(MAIN, issue.id);
  assert.equal(d.status, 200);
  assert.ok(!hbank("bops").sessions.has(issue.id), "nothing else used this one: its session is deleted");
  oproj(PID).items.delete("e0e0e0e0e0");
});

await check("an issue deleted on another Mac: a change here finds it gone", async () => {
  const x = (await openIssue(MAIN, { title: "Door code", sourceApp: "gmail", externalId: "thr_3" })).body.issue;
  oproj(PID).issues.delete(x.orgoId);
  const p = await patchIssue(MAIN, x.id, { status: "done" });
  assert.equal(p.status, 404, JSON.stringify(p.body));
  const l = await listIssues(MAIN, "&fresh=1");
  assert.ok(!l.body.issues.some((y) => y.id === x.id));
});

await check("an issue delete Orgo can't take now (401, 403, 429) stays to send and goes once Orgo takes it; one whose row Orgo couldn't say goes at the next sync too", async () => {
  const refuseDeletes = (status) => (orgo.answer = (c) => (c.method === "DELETE" && c.path.includes("/orbit/issues/") ? json({ error: "no" }, status) : null));
  const x = (await openIssue(MAIN, { title: "Leaky tap", sourceApp: "gmail", externalId: "thr_9" })).body.issue;
  assert.ok(x.orgoId);
  const rowThere = () => [...oproj(PID).issues.values()].some((r) => r.honchoSessionId === x.id);
  refuseDeletes(401);
  assert.equal((await removeIssue(MAIN, x.id)).status, 200);
  assert.ok(!(await listIssues(MAIN)).body.issues.some((i) => i.id === x.id), "gone here at once");
  assert.ok(rowThere(), "401: still in Orgo");
  assert.ok(T.pendingCount() >= 1, "a sync is asked for");
  for (const status of [403, 429]) {
    refuseDeletes(status);
    await T.flushAll();
    assert.ok(rowThere(), `${status}: still in Orgo, kept to send`);
  }
  orgo.answer = null;
  await T.flushAll();
  assert.ok(!rowThere(), "the row went once Orgo took it");
  assert.ok(!hbank("bops").sessions.has(x.id), "then its session");
  // Deleted while Orgo was down, with no Orgo id on this Mac (opened elsewhere): its row is looked up and deleted at the next sync.
  const y = (await openIssue(MAIN, { title: "Gate code", sourceApp: "gmail", externalId: "thr_10" })).body.issue;
  const cached = globalThis.bopsIssues.lists.get(MAIN).cache.issues.find((i) => i.id === y.id);
  delete cached.orgoId;
  orgo.down = true;
  assert.equal((await removeIssue(MAIN, y.id)).status, 200);
  orgo.down = false;
  assert.ok([...oproj(PID).issues.values()].some((r) => r.honchoSessionId === y.id), "still in Orgo meanwhile");
  await T.flushAll();
  assert.ok(![...oproj(PID).issues.values()].some((r) => r.honchoSessionId === y.id), "found by its session and deleted");
  assert.ok(!hbank("bops").sessions.has(y.id), "then its session");
});

await check("Orgo down: an issue opens all the same (in memory), and goes to Orgo at the next sync", async () => {
  orgo.down = true;
  const r = await openIssue(MAIN, { title: "Wifi down", sourceApp: "gmail", externalId: "thr_4" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.issue.orgoId, undefined);
  orgo.down = false;
  OS.pullSoon(MAIN);
  await settle();
  const row = [...oproj(PID).issues.values()].find((x) => x.honchoSessionId === r.body.issue.id);
  assert.ok(row, "sent");
  const l = await listIssues(MAIN, "&fresh=1");
  assert.equal(l.body.issues.find((x) => x.id === r.body.issue.id)?.orgoId, row.id);
});

await check("issues kept only in memory from before go to Orgo at the first full read", async () => {
  const bank = Mem.bankOf("ws_b");
  const old = `issue-${randomUUID()}`;
  hbank(bank).sessions.set(old, { id: old, metadata: { app: "bops", type: "issue", ws: "ws_b", status: "waiting_us", priority: "low", tags: [], title: "Old ticket", summary: "From before", sourceApp: "plain", externalId: "tk_1", openedAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000 }, configuration: {}, peers: {}, messages: [] });
  await get("ws_b");
  await settle("ws_b");
  const row = [...oproj(PID_B).issues.values()].find((x) => x.honchoSessionId === old);
  assert.ok(row, "sent");
  assert.deepEqual([row.title, row.status, row.priority, row.sourceApp, row.externalId], ["Old ticket", "waiting_us", "low", "plain", "tk_1"]);
});

/* ---------------- Routes missing, Orgo down, one at a time ---------------- */

await check("an Orgo without the routes (404): left alone for 6 hours, issues in memory only meanwhile, then asked again", async () => {
  orgo.missing = true;
  seed(MAIN, [["m1", "Kai is Tiger's tailor.", [item("people", "Kai", { key: "kai", detail: "Your tailor" })]]]);
  await refresh(MAIN);
  await settle();
  const until6h = T.missingUntil(PID);
  assert.ok(until6h > Date.now() + 5.9 * 3_600_000, "6 hours");
  const h = orgo.calls.length;
  seed(MAIN, [["m2", "Kai works on Saturdays.", [item("people", "Kai", { key: "kai", detail: "Your tailor, Saturdays" })]]]);
  await refresh(MAIN);
  await settle();
  const r = await openIssue(MAIN, { title: "Late order", sourceApp: "gmail", externalId: "thr_5" });
  assert.equal(r.status, 201);
  assert.equal(orgo.calls.length - h, 0, "not asked meanwhile");
  orgo.missing = false;
  skew += 6 * 3_600_000 + 60_000;
  await refresh(MAIN);
  await settle();
  assert.ok(rowOf(PID, one((await get(MAIN)).body.items, "people", "Kai").id), "asked again, and sent");
});

await check("Orgo not answering: Orbit works the same, and what waits goes after a backoff", async () => {
  orgo.down = true;
  seed(MAIN, [["n1", "Noa is Tiger's coach.", [item("people", "Noa", { key: "noa", detail: "Your coach" })]]]);
  const r = await refresh(MAIN);
  const noa = one(r.items, "people", "Noa");
  await settle();
  assert.ok(!rowOf(PID, noa.id), "not there yet");
  assert.ok(T.pendingCount() >= 1, "waiting to go again");
  orgo.down = false;
  await T.flushAll();
  assert.ok(rowOf(PID, noa.id), "sent once Orgo answers");
});

await check("one sync per workspace at a time: a change while a PUT is under way waits for it", async () => {
  seed(MAIN, [["q1", "Ivo is Tiger's driver.", [item("people", "Ivo", { key: "ivo", detail: "Your driver" })]]]);
  await refresh(MAIN);
  let inside = 0;
  let most = 0;
  orgo.hold = (c) => {
    inside++;
    most = Math.max(most, inside);
    return c.method === "PUT";
  };
  const first = T.start(MAIN);
  await until(() => orgo.held.length, "the PUT to be under way");
  seed(MAIN, [["q2", "Ivo drives a blue van.", [item("people", "Ivo", { key: "ivo", detail: "Your driver, blue van" })]]]);
  await refresh(MAIN);
  const second = T.start(MAIN);
  assert.equal(second, first, "the same sync");
  releaseOrgo();
  await first;
  await T.flushAll();
  assert.equal(rowOf(PID, one((await get(MAIN)).body.items, "people", "Ivo").id).detail, "Your driver, blue van", "the newer one went after");
});

/* ---------------- Review fixes ---------------- */

await check("an item whose facts were deleted here (the memory panel's Delete) is deleted in Orgo too, and the next read doesn't bring it back", async () => {
  const f = seed(MAIN, [["v1", "Vic fixes the boiler on Fridays.", [item("people", "Vic", { key: "vic", detail: "Fixes the boiler" })]]]);
  const vic = one((await refresh(MAIN)).items, "people", "Vic");
  await settle();
  assert.ok(rowOf(PID, vic.id), "sent");
  // Deleted from memory on this Mac (memory.ts forgetFact, then dropFacts): nothing backs the item now.
  removeFact(Mem.bankOf(MAIN), f.v1.id);
  orgo.calls = [];
  MC.dropFacts(Mem.bankOf(MAIN), [f.v1.id]);
  await settle();
  const del = orgo.calls.find((c) => c.method === "DELETE" && c.path === `/api/projects/${PID}/orbit/items`);
  assert.ok(del, orgo.calls.map((c) => `${c.method} ${c.path}`).join(", "));
  assert.ok(JSON.stringify(del.body ?? del.query).includes(vic.id), "its id");
  assert.ok(!rowOf(PID, vic.id), "gone in Orgo");
  // A full read of Orgo now: it stays gone.
  OS.pullSoon(MAIN);
  await settle();
  assert.ok(!(await refresh(MAIN)).items.some((i) => i.title === "Vic"), "not brought back");
  assert.equal(indexOf(MAIN).out, undefined, "nothing left to send");
});

await check("a forget Orgo can't take now (401, 403, 409 full, 429) stays to send, and goes once Orgo takes it", async () => {
  seed(MAIN, [["w1", "Wren is Tiger's neighbour.", [item("people", "Wren", { key: "wren", detail: "Your neighbour" })]]]);
  const wren = one((await refresh(MAIN)).items, "people", "Wren");
  await settle();
  assert.ok(rowOf(PID, wren.id), "sent");
  const hash = keyed(MAIN, "item|people:wren");
  const refuse = (status, code, paths) => (orgo.answer = (c) => (c.method !== "PUT" && c.method !== "GET" && paths.some((x) => c.path.endsWith(`/orbit/${x}`)) ? json({ error: "no", code }, status) : null));
  const kept = (what, del) => {
    const out = indexOf(MAIN).out;
    assert.ok(out, `${what}: still to send`);
    assert.equal(out.del.includes(wren.id), del, `${what}: the delete ${del ? "kept" : "sent"}`);
    assert.ok(Object.hasOwn(out.items, hash), `${what}: the hash kept`);
    assert.ok(T.pendingCount() >= 1, `${what}: sent again later`);
  };
  refuse(401, "unauthorized", ["items", "tombstones"]);
  assert.equal((await post({ action: "forget", ws: MAIN, id: wren.id })).status, 200);
  await settle();
  kept("401", true);
  assert.ok(rowOf(PID, wren.id), "401: still in Orgo");
  refuse(403, "forbidden", ["items", "tombstones"]);
  await T.flushAll();
  kept("403", true);
  refuse(409, "orbit_full", ["tombstones"]);
  await T.flushAll();
  kept("409 full", false);
  assert.ok(!rowOf(PID, wren.id), "the delete went");
  refuse(429, "rate_limited", ["tombstones"]);
  await T.flushAll();
  kept("429", false);
  orgo.answer = null;
  await T.flushAll();
  assert.ok(!rowOf(PID, wren.id), "gone in Orgo");
  assert.ok(oproj(PID).tombstones.has(keyed(MAIN, "item|people:wren")), "with its hash");
  assert.equal(indexOf(MAIN).out, undefined, "nothing left to send");
});

await check("an item another Mac sent again after a forget here (it hadn't heard yet) stays gone, and its delete goes again", async () => {
  const wrenId = "e0e0e0e0e0";
  // Another Mac, not yet read the forget, sorted a fact it worked out from an old chat into Wren and sent it.
  const late = addFact("bops", "Wren waters the plants.", { at: Date.now() + 1000, session: OTHER_CHAT });
  SORTS.set("Wren waters the plants.", []);
  orgoItem(PID, { bopsId: wrenId, category: "people", key: "people:wren", title: "Wren", detail: "Your neighbour", sources: [{ honchoConclusionId: late.id, honchoSessionId: OTHER_CHAT, said: "Wren waters the plants.", at: iso(late.at) }] });
  const h = orgo.calls.length;
  OS.pullSoon(MAIN);
  await settle();
  await T.flushAll();
  assert.ok(!(await get(MAIN)).body.items.some((i) => i.title === "Wren"), "not back here");
  assert.deepEqual(orgoSince(h, "DELETE items").map((c) => c.body), [{ bopsIds: [wrenId] }], "its delete went again");
  assert.ok(!rowOf(PID, wrenId), "and it's gone in Orgo");
  assert.ok(!orgoSince(h, "PUT items").some((c) => c.body.items.some((x) => x.key === "people:wren")), "never sent from here");
  await MC.purge(MAIN);
  assert.ok(!factIds("bops").includes(late.id), "the other Mac's fact deleted from memory too");
});

await check("one the user brought back on another Mac (said in that chat after the forget) comes back here", async () => {
  const forgotAt = Date.now();
  seed(MAIN, [["v1", "Vic is Tiger's tailor.", [item("people", "Vic", { key: "vic", detail: "Your tailor" })]]]);
  const vic = one((await refresh(MAIN)).items, "people", "Vic");
  await settle();
  assert.equal((await post({ action: "forget", ws: MAIN, id: vic.id })).status, 200);
  await settle();
  await MC.purge(MAIN);
  S.update((s) => void s.messages.push({ id: "m_vic_again", chatId: "other-mac-chat", role: "user", text: "Vic is my tailor again.", at: forgotAt + 60_000 }));
  const again = addFact("bops", "Vic is Tiger's tailor again.", { at: forgotAt + 61_000, session: OTHER_CHAT });
  SORTS.set("Vic is Tiger's tailor again.", []);
  orgoItem(PID, { bopsId: "f0f0f0f0f0", category: "people", key: "people:vic", title: "Vic", detail: "Your tailor", sources: [{ honchoConclusionId: again.id, honchoSessionId: OTHER_CHAT, said: "Vic is Tiger's tailor again.", at: iso(again.at) }] });
  OS.pullSoon(MAIN);
  await settle();
  one((await get(MAIN)).body.items, "people", "Vic");
  assert.ok(rowOf(PID, "f0f0f0f0f0"), "kept in Orgo");
  // Its hash comes again with later reads (the overlap, a read whole): what brought it back still does.
  oproj(PID).tombstones.get(keyed(MAIN, "item|people:vic")).createdAt = Date.now();
  OS.pullSoon(MAIN);
  await settle();
  one((await get(MAIN)).body.items, "people", "Vic");
});

await check("hashes that come for an item here (forgotten on another Mac meanwhile) take it away here, and delete it there", async () => {
  seed(MAIN, [["k1", "Kit is Tiger's accountant.", [item("people", "Kit", { key: "kit", detail: "Your accountant" })]]]);
  const kit = one((await refresh(MAIN)).items, "people", "Kit");
  await settle();
  // The other Mac forgot Kit before this one's copy reached Orgo: Orgo has the hash and this Mac's row.
  oproj(PID).tombstones.set(keyed(MAIN, "item|people:kit"), { kind: "item", createdAt: Date.now() });
  const h = orgo.calls.length;
  OS.pullSoon(MAIN);
  await settle();
  await T.flushAll();
  assert.ok(!(await get(MAIN)).body.items.some((i) => i.title === "Kit"), "gone here");
  assert.deepEqual(orgoSince(h, "DELETE items").map((c) => c.body), [{ bopsIds: [kit.id] }]);
  assert.ok(!rowOf(PID, kit.id), "and there");
});

await check("an item Orgo refuses (400) isn't sent again until it changes, and a full read doesn't delete it here", async () => {
  orgo.answer = (c) => (c.method === "PUT" && c.body?.items?.some((x) => x.title === "Yara") ? json({ error: "The request is not valid.", code: "invalid_orbit" }, 400) : null);
  seed(MAIN, [["y1", "Yara is Tiger's piano teacher.", [item("people", "Yara", { key: "yara", detail: "Your piano teacher" })]]]);
  const yara = one((await refresh(MAIN)).items, "people", "Yara");
  await settle();
  assert.ok(!rowOf(PID, yara.id), "Orgo didn't take it");
  assert.ok(indexOf(MAIN).refused?.[yara.id], "kept as refused");
  assert.equal(indexOf(MAIN).pushed?.[yara.id], undefined, "not as something Orgo has");
  let h = orgo.calls.length;
  await refresh(MAIN);
  await settle();
  assert.equal(orgoSince(h, "PUT items").length, 0, "not sent again");
  // A read whole (the last one over 30 days ago).
  const idx = indexOf(MAIN);
  idx.remote.at = iso(Date.now() - 40 * 86_400_000);
  writeFileSync(fileFor(MAIN), JSON.stringify(idx));
  globalThis.bopsCategories.spaces.get(MAIN).index = undefined;
  h = orgo.calls.length;
  OS.pullSoon(MAIN);
  await settle();
  assert.equal(orgoSince(h, "GET ").length, 1, "read once");
  one((await get(MAIN)).body.items, "people", "Yara");
  orgo.answer = null;
  assert.equal((await post({ action: "edit", ws: MAIN, id: yara.id, title: "Yara Lind" })).status, 200);
  await settle();
  assert.equal(rowOf(PID, yara.id)?.title, "Yara Lind", "changed, it goes again");
  assert.ok(indexOf(MAIN).pushed?.[yara.id], "and Orgo has it now");
});

await check("an older Orgo's 409 for a merge past 100 sources: the batch goes in halves, the rest gets in", async () => {
  orgoItem(PID, { bopsId: "a0a0a0a0a0", category: "people", key: "people:busy bee", title: "Busy Bee", updatedAt: Date.now() - 3_600_000, sources: Array.from({ length: 100 }, (_, i) => ({ honchoConclusionId: `busy${i}`, honchoSessionId: null, said: null, at: iso(Date.now() - 7_200_000 + i) })) });
  seed(MAIN, [
    ["bb", "Busy Bee called Tiger.", [item("people", "Busy Bee", { key: "busy bee", detail: "Called you" })]],
    ["cc", "Cato is Tiger's barista.", [item("people", "Cato", { key: "cato", detail: "Your barista" })]],
  ]);
  const h = orgo.calls.length;
  const r = await refresh(MAIN);
  const busy = one(r.items, "people", "Busy Bee");
  const cato = one(r.items, "people", "Cato");
  await settle();
  const puts = orgoSince(h, "PUT items");
  assert.ok(puts.length >= 3, `split (${puts.length} PUTs)`);
  assert.ok(rowOf(PID, cato.id), "the rest of the batch went in");
  assert.ok(indexOf(MAIN).refused?.[busy.id], "the one past the limit waits until it changes");
  const n = orgo.calls.length;
  await refresh(MAIN);
  await settle();
  assert.equal(orgoSince(n, "PUT items").length, 0, "and isn't sent on every sort");
});

await check("nothing unexpected: no rejections, no dashes in what's said, no unknown Honcho calls", async () => {
  assert.deepEqual(rejections, []);
  assert.deepEqual(honcho.unknown.filter((u) => !u.includes("conclusions/query")), []);
  for (const s of spoken) assert.ok(!/[–—]/.test(s), `no dashes: ${s.slice(0, 200)}`);
  assert.ok(!warned.some((w) => /TypeError|undefined is not/.test(w)), warned.join("\n"));
});

T.reset();
console.log(`\norbit sync: ${passed} passed, ${failures} failed`);
if (failures) console.log(`The throwaway folder is kept for a look: ${scratch}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
