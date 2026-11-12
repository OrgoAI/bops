// Sample apps for Your Apps on the local two-person stack (scripts/dev-two-person.mjs), answered at the browser's edge by
// scripts/test-your-apps-e2e.mjs: the owner's Bops is shown three apps on the web and two tools the bots made, and sam
// (an Admin) is shown the same apps as the owner's Mac would have written them for members. Nothing here is real: every
// name, link and password is made up, and no request these answer ever leaves this Mac.
import { BOT, COMPUTER, OWNER, PROJECT, SAM } from "./two-person.mjs";

/** An Orgo team sign-in: apps are open to it (cloud/apps-team.ts). The owner's, in place of their made-up one. */
export const TEAM_EMAIL = "tess@orgo.ai";

const NOW = Date.now();
const min = (n) => NOW - n * 60_000;
const hr = (n) => min(n * 60);
/** A changeset id: 40 hex characters, made of a short mark. */
export const id = (mark) => mark.repeat(40).slice(0, 40);

/* ---------------- fourcorners: the preview has one change that isn't live ---------------- */

export const FC = {
  name: "fourcorners",
  head: id("a1"),
  prodAt: id("b2"),
  preview: "https://ggn7sjpkwnz8.orgo.dev",
  label: "ggn7sjpkwnz8",
  domain: "fourcorners.brandlord.agency",
  password: "Kw7mQ2p",
};
export const CCLC = { name: "cclc", head: id("c1"), preview: "https://q4vd9kz2mt8p.orgo.dev", label: "q4vd9kz2mt8p" };
export const BROCHURE = { name: "brochure-maker", head: id("d2"), prodAt: id("d1"), preview: "https://m2kq8vxs7bhw.orgo.dev", label: "m2kq8vxs7bhw", domain: "brochures.fourcorners.travel" };

const live = (dId, at, state, when) => ({ id: dId, at, state, when, error: null, url: null });

/** The commits of each app, newest first (AppCommit). */
export const COMMITS = {
  fourcorners: [
    { id: FC.head, message: "Home line: Pick a project type on the left to get started.", author: "Four Corners", at: min(8), changes: { added: 0, modified: 1, deleted: 0 } },
    { id: FC.prodAt, message: "IMPROVING.md: preview first, then Publish to GitHub", author: "Four Corners", at: hr(26), changes: { added: 1, modified: 0, deleted: 0 } },
    { id: id("c3"), message: "Agent guide: a route per request kind", author: "Orgo team", at: hr(70), changes: { added: 0, modified: 3, deleted: 0 } },
    { id: id("d4"), message: "Brochure template: photo under the title on covers", author: "Four Corners", at: hr(96), changes: { added: 2, modified: 4, deleted: 1 } },
  ],
  cclc: [
    { id: CCLC.head, message: "Board members page: photos and titles", author: "CCLC", at: hr(3), changes: { added: 1, modified: 2, deleted: 0 } },
    { id: id("e5"), message: "From GitHub: 68 files", author: "Tiger", at: hr(50), changes: { added: 68, modified: 0, deleted: 0 } },
  ],
  "brochure-maker": [
    { id: BROCHURE.head, message: "Export as PDF from the Share menu", author: "Boppy", at: min(3), changes: { added: 1, modified: 2, deleted: 0 } },
    { id: BROCHURE.prodAt, message: "First version: three brochure layouts", author: "Boppy", at: hr(30), changes: { added: 12, modified: 0, deleted: 0 } },
  ],
};

/** What the owner's page reads (GET /api/hosted-apps), as it is now: the drive changes it as buttons are pressed. */
export function hostedApps() {
  return {
    enabled: true,
    apps: [
      {
        name: FC.name,
        head: FC.head,
        updatedAt: min(8),
        hosting: {
          botId: BOT.id,
          computerId: COMPUTER.id,
          projectId: "p_fc",
          preview: FC.label,
          github: { repo: "OrgoAI/orgo-brandlord", branch: "main", path: "formula", keep: ["clients/cclc/"], last: { sha: "3c04ce04f1a9b2d7e6c5a4b3c2d1e0f9a8b7c6d5", ingot: FC.prodAt, when: hr(26) } },
        },
        serving: FC.prodAt,
        live: live("d_fc_1", FC.prodAt, "succeeded", hr(26)),
        preview: { projectId: "pp_fc", url: FC.preview, label: FC.label, serving: FC.head, live: live("d_fc_p1", FC.head, "succeeded", min(6)), protected: true, passwordAt: min(6) },
        domain: `https://${FC.domain}`,
        domains: [{ domain: FC.domain, status: "active" }],
      },
      {
        name: CCLC.name,
        head: CCLC.head,
        updatedAt: hr(3),
        // (Its Published project exists (made at its first settings save), with no domain yet: Add a domain is offered.)
        hosting: { botId: BOT.id, computerId: COMPUTER.id, projectId: "p_cclc", preview: CCLC.label },
        serving: null,
        live: null,
        preview: { projectId: "pp_cclc", url: CCLC.preview, label: CCLC.label, serving: CCLC.head, live: live("d_cclc_p1", CCLC.head, "succeeded", hr(3)), protected: true, passwordAt: hr(3) },
        domain: null,
      },
      {
        name: BROCHURE.name,
        head: BROCHURE.head,
        updatedAt: min(3),
        hosting: { botId: BOT.id, computerId: COMPUTER.id, projectId: "p_br", preview: BROCHURE.label },
        serving: BROCHURE.prodAt,
        live: live("d_br_1", BROCHURE.prodAt, "succeeded", hr(30)),
        preview: { projectId: "pp_br", url: BROCHURE.preview, label: BROCHURE.label, serving: BROCHURE.prodAt, live: live("d_br_p2", BROCHURE.head, "running", min(1)), protected: true, passwordAt: hr(30) },
        domain: `https://${BROCHURE.domain}`,
        domains: [{ domain: BROCHURE.domain, status: "active" }],
      },
    ],
  };
}

/** What the owner's state carries of them (Workspace.hostedApps), for appsStamp and Work on it. */
export const hostingInState = () => Object.fromEntries(hostedApps().apps.map((a) => [a.name, a.hosting]));

/** A site's settings and recent deploys (GET …/settings), Published's or the Preview's. */
export function settings(name, env) {
  const a = hostedApps().apps.find((x) => x.name === name);
  const deploys =
    name === FC.name
      ? env === "preview"
        ? [
            { id: "d_fc_p1", state: "succeeded", at: FC.head, rollback: false, when: min(6), error: null, live: true, canRollback: false },
            { id: "d_fc_p0", state: "succeeded", at: FC.prodAt, rollback: false, when: hr(26), error: null, live: false, canRollback: true },
          ]
        : [
            { id: "d_fc_1", state: "succeeded", at: FC.prodAt, rollback: false, when: hr(26), error: null, live: true, canRollback: false },
            { id: "d_fc_0", state: "succeeded", at: id("c3"), rollback: false, when: hr(70), error: null, live: false, canRollback: true },
          ]
      : [];
  return {
    url: env === "preview" ? (a?.preview?.url ?? null) : null,
    settings: name === CCLC.name && env !== "preview" ? null : { port: env === "preview" ? 3101 : 3100, install: "npm ci", build: "npm run build", start: "npm start", health: "/" },
    env: env === "preview" ? ["DATABASE_URL", "NEXTAUTH_SECRET", "PREVIEW_BANNER"] : ["DATABASE_URL", "NEXTAUTH_SECRET"],
    deploys,
    ...(env === "preview" ? { prodEnv: ["DATABASE_URL", "NEXTAUTH_SECRET"] } : {}),
  };
}

/** Its domains and their DNS (GET …/dns). */
export function dns(name) {
  if (name === FC.name)
    return {
      url: null,
      domains: [{ id: "dom_fc", domain: FC.domain, status: "active", cert: "issued", managed: false, zone: null, publish: [{ type: "CNAME", name: "fourcorners", value: "edge.orgo.dev", found: "ok" }], where: "Cloudflare" }],
      zones: [],
    };
  if (name === BROCHURE.name)
    return {
      url: null,
      domains: [{ id: "dom_br", domain: BROCHURE.domain, status: "active", cert: "issued", managed: true, zone: "z_fct", publish: [] }],
      zones: [
        {
          id: "z_fct",
          domain: "fourcorners.travel",
          serving: true,
          ttl: 300,
          records: [
            { id: "r1", type: "A", name: "brochures", fqdn: BROCHURE.domain, value: "203.0.113.10", locked: "Orgo wrote it so brochures.fourcorners.travel reaches its computer." },
            { id: "r2", type: "TXT", name: "", fqdn: "fourcorners.travel", value: "v=spf1 -all", locked: null },
          ],
          renewal: { on: true, cents: 1400, years: 1, payer: "you", state: "scheduled", error: null, expires: NOW + 200 * 86_400_000 },
        },
      ],
    };
  return { url: null, domains: [], zones: [] };
}

/** Its Local, as its computer said (GET …/local). */
export const local = (name) => ({ sites: { [name]: { state: "stopped", port: 3000, devPort: 3000, command: "npm run dev", since: null, error: null, env: [] } }, bot: { id: BOT.id, name: BOT.name } });

/** Its Preview's password (GET …/password). */
export const password = (name) => {
  const a = hostedApps().apps.find((x) => x.name === name);
  return { url: a?.preview?.url ?? null, on: true, password: FC.password, cookie: null, at: a?.preview?.passwordAt };
};

/** Options for Add a domain (GET …/domains). */
export const domainOptions = () => ({ buy: { open: false, why: "Buying domains isn't open here." }, owned: [{ id: "z_fct", domain: "fourcorners.travel", inUse: [{ name: BROCHURE.domain, app: BROCHURE.name }] }], contact: null, cloudflare: { zones: [{ id: "cfz1", domain: "brandlord.agency", inUse: [{ name: FC.domain, app: FC.name }] }] } });

/** A deploy's log (GET …/logs). */
export const log = () => ({ state: "succeeded", log: "Installing…\nBuilding…\nStarting on port 3100\nHealthy.\n", next: null, more: false });

/* ---------------- The tools the bots made (tiles) ---------------- */

export const MADE = [
  {
    id: "app_trip_budget",
    title: "Trip budget",
    botId: BOT.id,
    chatId: `bot:${BOT.id}`,
    ws: PROJECT.wsId,
    version: 3,
    versions: [
      { n: 1, note: "A budget with a line per cost", at: hr(50) },
      { n: 2, note: "Totals per day", at: hr(26) },
      { n: 3, note: "Export as PDF", at: hr(2) },
    ],
    createdAt: hr(50),
    updatedAt: hr(2),
  },
  {
    id: "app_brochure_checklist",
    title: "Brochure checklist",
    botId: BOT.id,
    chatId: `bot:${BOT.id}`,
    ws: PROJECT.wsId,
    version: 1,
    versions: [{ n: 1, note: "The checklist, ticked per brochure", at: hr(30) }],
    createdAt: hr(30),
    updatedAt: hr(30),
  },
];

/** What a made app shows in its frame (GET /api/made-apps/[id]/view): a small page in the app's name. */
export function madeAppPage(appId) {
  const a = MADE.find((x) => x.id === appId);
  const rows = appId === "app_trip_budget" ? ["Flights · $420", "Hotel · $180", "Guides · $960", "Meals · $75"] : ["Cover photo", "Three days", "Prices checked", "Printed proof"];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${a?.title ?? "App"}</title><style>body{margin:0;padding:28px;font:15px/1.5 -apple-system,Helvetica,sans-serif;color:#0a0a0a;background:#fff}h1{font-size:22px;margin:0 0 18px}li{list-style:none;padding:10px 0;border-top:1px solid #ececea}ul{padding:0;margin:0}</style></head><body><h1>${a?.title ?? "App"}</h1><ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul></body></html>`;
}

/* ---------------- What sam, an Admin, is shown (SharedApps) ---------------- */

/** The owner's rows under each app: what members did (MemberAppAct). */
export const ACTS = {
  fourcorners: [{ key: "act1", userId: SAM.id, name: SAM.name, act: "deploy", env: "prod", ok: true, at: hr(26) }],
};

export function sharedApps() {
  const apps = hostedApps().apps;
  const site = (a) => ({
    name: a.name,
    url: a.domain,
    preview: a.preview?.url ?? null,
    previewLive: a.preview?.live ? { id: a.preview.live.id, state: a.preview.live.state, when: a.preview.live.when } : null,
    previewServing: a.preview?.serving ?? null,
    ...(a.preview?.protected ? { previewProtected: true, previewPassword: FC.password } : {}),
    serving: a.serving,
    live: a.live ? { id: a.live.id, state: a.live.state, when: a.live.when } : null,
    ...(a.domains ? { domains: a.domains } : {}),
  });
  const deploysOf = (a) =>
    [...settings(a.name, "preview").deploys.map((d) => ({ ...d, site: a.name, env: "preview" })), ...settings(a.name).deploys.map((d) => ({ ...d, site: a.name, env: "prod" }))].map(({ error: _e, ...d }) => (void _e, d));
  return {
    level: "write",
    at: min(10),
    list: apps.map((a) => ({
      name: a.name,
      botId: BOT.id,
      head: { id: a.head, message: COMMITS[a.name][0].message, at: COMMITS[a.name][0].at },
      // Its production on GitHub, as Bops Cloud says it (cloud/ws-slice.ts githubOf): repo, branch and the changeset last sent there.
      ...(a.hosting?.github ? { github: { repo: a.hosting.github.repo, branch: a.hosting.github.branch, at: a.hosting.github.last?.ingot ?? null } } : {}),
      sites: [site(a)],
      commits: COMMITS[a.name],
      deploys: deploysOf(a),
      settings: { [a.name]: { port: 3100, install: "npm ci", build: "npm run build", start: "npm start" } },
      ...(ACTS[a.name] ? { acts: ACTS[a.name] } : {}),
    })),
    owned: [{ id: "z_fct", domain: "fourcorners.travel" }],
  };
}

export { BOT, COMPUTER, OWNER, PROJECT, SAM };
