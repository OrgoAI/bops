"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { appStatus, changesBetween, roomHeld, roomLine, roomTakes, ROOM_WORDS, type DeployState } from "@/lib/hosted-apps";
import { hasUnpublishedPreview, reviewLabel } from "@/lib/app-review";
import { AppDisclosure, appAttention, appIcon, appList, appOutline, appRow } from "./app-controls";
import { AppPassword, AppReview, AppVersions } from "./app-review";
import { Fold } from "./fold";
import { useEffect, useState } from "react";
import type { AppJobKind, MemberAppAct, SharedApp, SharedAppRemoval, SharedApps, SharedRoom } from "@/cloud/protocol";
import { DOMAIN_WORDS } from "@/lib/hosted-apps";
import { REPLY_WAITS_LINE } from "@/lib/shared";
import type { AppState } from "@/lib/types";
import { GithubForm, ghFormOf, ghMirrorOf, NO_GH_FORM, type GhForm } from "./github-form";
import { PasswordShown } from "./preview-password";
import { memberAct } from "./shared-act";
import { ago } from "./ui";
import { KeyVariables } from "./app-key-links";
import { InlineConfirm } from "./side-group";

/*
 * Your Apps in a workspace someone shared with the user, when its owner gave them Your Apps (lib/shared.ts SharedOpen.apps,
 * cloud/ws-slice.ts appsFor): its apps on the web as the owner's Mac last read them. Read sees each app's sites and
 * addresses (each site's Preview link, where a member's Deploy goes, with its state), what they serve, deploys and
 * history, and domains; Write also sees a Preview's password, deploys, goes back to an earlier Preview deploy, changes
 * a site's settings and uses one of the workspace's own domains, each sent to the owner's Bops (memberAct), which does
 * it and keeps it on the app under their name. An Admin, once the owner's Bops takes it (SharedOpen.adminPublish), also
 * publishes (what its Preview serves goes on Published) and goes back on Published. An Admin, or a Member with App
 * secrets, once the owner's Bops takes it (SharedOpen.appGithub), also sets where an app publishes on GitHub, links it,
 * and brings GitHub's changes in (GithubPart): Bops Cloud keeps the setting, and the app's own computer does the rest,
 * with the owner's Mac on or off. Never its variables, logs or a domain to buy: the owner's. Under the list, one quiet line
 * for each computer the apps are on (SharedApps.room): how many more apps it has room for, or that it's full; at Write, a
 * Deploy that would make an app's first Preview where its computer has no room says so before it's pressed. Advice only:
 * the room is the owner's Mac's last read, so a member's Deploy and Restore are never held on it; orgo-web refuses one
 * that doesn't fit, and that refusal is said as any act's is.
 */

/** What a member tried to do, as "<who> tried to …" says it (SHARED_APPS_WORDS.tried), by act. */
const TRIED: Partial<Record<MemberAppAct["act"] | "publish", string>> = {
  publish: "publish it",
  deploy: "deploy it",
  rollback: "go back to an earlier deploy",
  settings: "change its settings",
  github: "change where it publishes",
  githubLink: "link it to GitHub",
  githubPull: "bring in GitHub's changes",
  remove: "remove it",
  removeSite: "remove a site",
  removeLeftOver: "remove a left over",
  deleteCode: "delete its code",
};
/** What a member asked its computer to do, as "<who> asked its computer to …" says it (SHARED_APPS_WORDS.asked), by act. */
const ASKED: Partial<Record<MemberAppAct["act"], string>> = {
  deploy: "deploy it",
  rollback: "go back to an earlier deploy",
  settings: "change its settings",
  domain: "point a domain at it",
  githubLink: "link it to GitHub",
  githubPull: "bring in GitHub's changes",
  remove: "remove it",
  removeSite: "remove a site",
  removeLeftOver: "remove a left over",
};

/** Every word the shared page says (the tests read them for dashes and the old name). */
export const SHARED_APPS_WORDS = {
  title: "Your Apps",
  readLine: (ws: string) => `Apps on the web in ${ws}. You can look.`,
  writeLine: (ws: string) => `Apps on the web in ${ws}. You can deploy them.`,
  asOf: (when: string) => `As of ${when}`,
  none: "No apps on the web here yet.",
  readOnly: "Ask the owner for Write to deploy.",
  noVariables: "Only the owner sees its variables.",
  noLogs: "Build logs show in the owner's Bops.",
  noBuying: "Only the owner buys domains.",
  useDomain: "Use one of this workspace's domains",
  sending: "Sending to the owner's Bops…",
  waiting: REPLY_WAITS_LINE,
  failed: "That didn't go. Try again.",
  deploy: "Deploy",
  publish: "Publish",
  goBack: "Go back to this one",
  save: "Save",
  use: "Use",
  history: "History",
  deploys: "Deploys",
  settings: "Settings",
  domains: "Domains",
  sites: "Sites",
  preview: "Preview",
  published: "Published",
  askPassword: "Ask the owner for its password.",
  live: "Live",
  notOnWeb: "Not on the web yet",
  subdomain: "Subdomain",
  /** Where an Admin's Publish goes, said as they confirm it: the owner's Bops publishes it. */
  publishLine: "Sends this reviewed preview to the owner's Bops for publishing.",
  /** Where it goes, when there's no domain or repo to name. */
  destination: "Publishing destination configured by the owner",
  /** As an Admin confirms Publish: where it goes when its production is on GitHub. */
  publishGithub: (g: { repo: string; branch: string }) => `Publish sends it to GitHub (${g.repo}, ${g.branch}), where its own deploy puts it live.`,
  /** As an Admin confirms Publish: its domains aren't pointed at Orgo yet, so a published change isn't what their visitors see. */
  publishWaiting: (domains: string, many = false) => `Visitors to ${domains} won't see a publish until ${many ? "their" : "its"} DNS points at Orgo.`,
  acted: (who: string, a: Pick<MemberAppAct, "act" | "site"> & { domain?: string; env?: "prod"; leftOver?: string }) => {
    switch (a.act) {
      case "deploy":
        return a.env === "prod" ? `${who} published it` : `${who} deployed it`;
      case "rollback":
        return `${who} went back to an earlier deploy`;
      case "settings":
        return `${who} changed ${a.site ? `${a.site}'s` : "its"} settings`;
      case "github":
        return `${who} changed where it publishes`;
      case "githubLink":
        return `${who} linked it to GitHub`;
      case "githubPull":
        return `${who} brought in GitHub's changes`;
      case "remove":
        return `${who} removed it`;
      case "removeSite":
        return `${who} removed ${a.site ?? "a site"}`;
      case "removeLeftOver":
        return `${who} removed the left over ${a.leftOver ?? ""}`.trimEnd();
      case "deleteCode":
        return `${who} deleted its code`;
      default:
        return `${who} pointed ${a.domain ?? "a domain"} at it`;
    }
  },
  tried: (who: string, act: MemberAppAct["act"] | "publish", said: string) => `${who} tried to ${TRIED[act] ?? "use a domain"}: ${said}`,
  /**
   * What its computer is doing now for them (SharedApp.acts `going`): a GitHub Link or Bring in, or, in a workspace where
   * everything goes through the cloud, any of a member's acts (`env` "prod": Publish).
   */
  asked: (who: string, act: MemberAppAct["act"], env?: "prod") => `${who} asked its computer to ${act === "deploy" && env === "prod" ? "publish it" : (ASKED[act] ?? "bring in GitHub's changes")}…`,
  /** The words for an act Bops Cloud sends to the app's own computer (a pending act "cloud"), and an Admin's Publish there. */
  sendingComputer: "Sending to its computer…",
  publishLineComputer: "Sends this reviewed preview to its computer for publishing.",
  /** Remove (RemovePart), for an Admin or a Member with Remove apps (SharedOpen.appRemove). */
  removeApp: "Remove app",
  removeAppAsk: (app: string) => `Remove ${app}? Its sites and their domains come off the web, and it leaves this workspace.`,
  removeCode: "Delete its code in Ingot too, with all its history. This can't be undone.",
  removeSite: (site: string) => `Remove ${site}`,
  removeSiteAsk: (site: string) => `Remove ${site}? It comes off the web with its domains. The code stays the app's.`,
  leftOvers: "Left over on its computer",
  leftOversLine: "Made by an older Bops or a test. Bops never deploys to these.",
  removeLeftOverAsk: (name: string) => `Remove ${name}? It stops serving for good.`,
  remove: "Remove",
  keep: "Keep",
  removing: "Removing…",
  /** An app someone removed (SharedApps.removed), at the top of the page. */
  removed: (who: string, app: string) => `${who} removed ${app}`,
  codeLeft: "Its code is still in Ingot.",
  deleteCode: "Delete its code",
  codeDeleted: "Its code was deleted too.",
  codeNotDeleted: (why: string) => `Its code wasn't deleted: ${why}`,
  /** Its GitHub production (GithubPart), at Write, for whoever may change it (SharedOpen.appGithub). */
  github: "GitHub",
  githubWhere: (g: { repo: string; branch: string; path?: string }) => `Publishes to GitHub ${g.repo}, ${g.branch}, ${g.path ? `folder ${g.path}` : "the whole repo"}.`,
  githubLinked: (sha: string, when: string) => `Last the same as GitHub at ${sha} (${when}).`,
  githubNotLinked: "It isn't linked yet. Link it before you publish.",
  githubOnOrgo: "It publishes on Orgo.",
  githubStart: "Publish to GitHub instead",
  githubChange: "Change where it publishes",
  githubLink: "Link to GitHub",
  githubPull: "Bring in GitHub's changes",
  githubPullAsk: "GitHub's version wins where both changed a file. Bring them in?",
  githubPullYes: "Bring them in",
  githubOrgo: "Publish on Orgo instead",
  cancel: "Cancel",
  githubOneFolder: "It runs more than one site, and one GitHub folder is one app, so it publishes on Orgo.",
  githubKeyNote: "A new repo, branch, folder or workflow needs a GitHub key of this workspace's own in Keys.",
  linkFirst: "Link it to GitHub first.",
  /** Publish, while its computer links it to GitHub or brings GitHub's changes in. */
  githubWait: "Its computer is busy with GitHub. Publish once it's done.",
  /** How many more apps a computer has room for (lib/hosted-apps.ts roomLine), as the owner's Your Apps says it. */
  ...ROOM_WORDS,
};
/** The GitHub form's words here (github-form.tsx GithubForm): Save links it too. */
export const SHARED_GITHUB_FORM_WORDS = {
  title: "Publish to GitHub",
  blurb: "Ingot stays where it's worked on and previewed. Publish pushes what the Preview serves into this folder, and that repo's own workflow deploys it. Its computer links it as you save.",
  save: "Save and link",
  saving: "Saving…",
};
const W = SHARED_APPS_WORDS;

const STATE_WORDS: Record<string, string> = { queued: "Waiting to deploy", running: "Deploying", succeeded: "Live", failed: "Failed", cancelled: "Deploy stopped", superseded: "Deploy replaced" };
const stateWord = (s: string | null | undefined) => (s && STATE_WORDS[s]) || W.notOnWeb;
const shortId = (id: string) => id.slice(0, 7);

/** When the owner's Mac read them: the time today, else the day too. */
export function asOf(at: number, now = Date.now()) {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** What a member's act on an app says, done or not (or still being done on its computer), with when (the owner's rows and the member's own). */
export function actLine(a: NonNullable<SharedApp["acts"]>[number]) {
  if (a.going) return `${W.asked(a.name, a.act, a.env)} · ${asOf(a.at)}`;
  return `${a.ok ? W.acted(a.name, a) : W.tried(a.name, a.act === "deploy" && a.env === "prod" ? "publish" : a.act, a.said ?? W.failed)} · ${asOf(a.at)}`;
}
/**
 * What a GitHub act or a remove that went says of itself (how many changes came in, files that go up with the next
 * Publish, what Orgo kept of a site taken down), under its line.
 */
const saysMore = (act: string) => act === "github" || act === "githubLink" || act === "githubPull" || act === "removeSite" || act === "removeLeftOver";

const BUTTON = "rounded-full px-3 py-1 text-[12px] font-medium leading-4 disabled:opacity-50";

/**
 * A computer as its room's line names it: its bot's ("Boppy's computer"), when that's one the viewer sees (Bops Cloud
 * sends its id only then), else for the apps on it; null when it can't be named (no line).
 */
export function roomComputer(r: SharedRoom, bots: readonly { id: string; name: string }[]): string | null {
  const b = r.bot ? bots.find((x) => x.id === r.bot) : undefined;
  if (b) return W.computer(b.name);
  return r.appNames.length ? W.computerOf(r.appNames) : null;
}

/**
 * What a member's Deploy of an app would make on its computer, as far as their page can tell (lib/hosted-apps.ts
 * roomTakes), for the full line said beside it (advice: never a hold): a site never live with no Preview yet is deployed
 * for the first time (it takes what a new app takes), one live before with no Preview yet gets its Preview. A site's
 * Preview counts as read only when the owner's Mac said it (its link, its deploy, or what it serves, null included: a
 * `preview` of null alone is also what it sends when Orgo couldn't say); one it didn't read, or a Bops from before
 * Preview, is counted as making nothing, as on the owner's page. Whether Published's project is there isn't shown.
 */
export function sharedTakes(a: SharedApp) {
  return roomTakes(
    (a.sites ?? []).map((s) => {
      const read = s.previewServing !== undefined || s.previewLive !== undefined || typeof s.preview === "string";
      return {
        projectId: s.live || s.serving ? s.name : null,
        ...(read ? { preview: { projectId: s.preview || s.previewLive ? s.name : null, url: s.preview ?? null, serving: s.previewServing ?? null } } : {}),
      };
    }),
  );
}

/**
 * The removes this window sent with their code to go too (`repo`, an Admin's), by their key: once the app's computer took
 * it off the web and Bops Cloud kept its removal with the code still left (SharedAppRemoval.codeLeft), this window asks
 * Bops Cloud to delete the code, once (codeSent). Only this window's: another Admin's, or one from before, shows Delete its code.
 */
const codeAsked = new Set<string>();
const codeSent = new Set<string>();

export function SharedAppsPage({ state }: { state: AppState }) {
  const apps = state.shared?.apps;
  const write = apps?.level === "write";
  const admin = state.shared?.role === "admin";
  const rows = apps?.removed;
  // Its code, for a remove this window sent with it: asked for once, as soon as the app is off the web.
  useEffect(() => {
    for (const r of rows ?? [])
      if (r.ok && r.codeLeft && codeAsked.has(r.key) && !codeSent.has(r.key)) {
        codeSent.add(r.key);
        void memberAct({ act: "deleteCode", app: r.app });
      }
  }, [rows]);
  const removed = rows ?? [];
  if (!apps) return null;
  // Each computer's room, named for its bot (or its apps): one line each.
  const rooms = Object.entries(apps.room ?? {}).flatMap(([key, r]) => {
    const computer = roomComputer(r, state.bots);
    return computer ? [{ key, r, computer }] : [];
  });
  // An Admin whose owner's Bops publishes for them (Bops Cloud says so only then: ADMIN_PUBLISH_MIN_VERSION).
  const publish = write && admin && state.shared?.adminPublish === true;
  // Where apps publish on GitHub, their Link and Bring in: an Admin's, or a Member's with App secrets (GITHUB_ACTS_MIN_VERSION).
  const github = write && state.shared?.appGithub === true;
  // What the apps' own computers do now, in a workspace where everything goes through the cloud (none: the owner's Mac does it all).
  const jobs = write ? state.shared?.appJobs : undefined;
  const remove = write && state.shared?.appRemove === true;
  return (
    <div data-shared-apps className="@container flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-8 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3"><h1 className="text-[26px] font-bold leading-8 tracking-[-0.025em] text-ink">{W.title}</h1>{apps.at > 0 && <span data-apps-asof className="text-[12px] leading-4 text-pencil">{W.asOf(asOf(apps.at))}</span>}</header>
      {!!removed.length && (
        <div data-apps-removed className="flex flex-col gap-1">
          {removed.map((r) => (
            <RemovedLine key={r.key} row={r} admin={admin && write} />
          ))}
        </div>
      )}
      {!apps.list.length ? (
        <span className="text-[13px] text-[#6B6B6B]">{W.none}</span>
      ) : (
        <div className={appList}>
          {apps.list.map((a) => {
            const on = rooms.find((x) => x.r.appNames.includes(a.name));
            return <SharedAppCard key={a.name} app={a} apps={apps} publish={publish} github={github} jobs={jobs} remove={remove} admin={admin} acts={(state.shared?.appActs ?? []).filter((x) => x.act.app === a.name)} room={on && roomHeld(on.r, on.computer, sharedTakes(a), W)} />;
          })}
        </div>
      )}
      {rooms.length > 0 && (
        <div data-apps-room className="flex flex-col gap-1">
          {rooms.map(({ key, r, computer }) => (
            <span key={key} data-room-line data-room-full={r.apps === 0 || undefined} className="text-[12.5px] leading-[18px] text-[#9A9A98]">
              {roomLine(r, computer, W)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An app someone removed (SharedApps.removed): who, which and when, or why it didn't go; what Orgo kept or what came of its
 * code (its `said`); and while its code is still in Ingot, that, with Delete its code for an Admin.
 */
function RemovedLine({ row: r, admin }: { row: SharedAppRemoval; admin: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const del = async () => {
    setBusy(true);
    setError(null);
    const got = await memberAct({ act: "deleteCode", app: r.app });
    setBusy(false);
    if (!got.ok) setError(got.error ?? W.failed);
  };
  return (
    <span data-app-removed={r.app} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-4">
      <span className={r.ok ? "text-[#6B6B6B]" : "text-[#B42318]"}>{`${r.ok ? W.removed(r.name, r.app) : W.tried(r.name, "remove", r.said ?? W.failed)} · ${asOf(r.at)}`}</span>
      {r.ok && r.said && <span data-removed-said className="text-[#6B6B6B]">{r.said}</span>}
      {r.ok && r.codeLeft && <span data-code-left className="text-[#6B6B6B]">{W.codeLeft}</span>}
      {r.ok && r.codeLeft && admin && (
        <button type="button" data-delete-code disabled={busy} onClick={() => void del()} className={`${BUTTON} text-[#B42318] shadow-[0_0_0_1px_#E2E2DF]`}>
          {busy ? W.removing : W.deleteCode}
        </button>
      )}
      {error && (
        <span role="alert" className="text-[#B42318]">
          {error}
        </span>
      )}
    </span>
  );
}

type Pending = NonNullable<NonNullable<AppState["shared"]>["appActs"]>[number];

/**
 * One app: its state, address and Deploy (and an Admin's Publish); its sites, history, deploys, settings and domains open
 * below. `room`: its computer's full line, where a Deploy would make its first Preview there and there's no room: said
 * beside Deploy at Write as advice, never a hold (the room is the last read of it; orgo-web refuses a deploy that doesn't
 * fit, said as any refusal is).
 */
function SharedAppCard({
  app: a,
  apps,
  acts,
  publish,
  github = false,
  jobs,
  remove = false,
  admin = false,
  room,
}: {
  app: SharedApp;
  apps: SharedApps;
  acts: Pending[];
  publish: boolean;
  github?: boolean;
  /** The kinds its computer does now (SharedOpen.appJobs): a button whose kind isn't one is hidden. None: every one shows (the owner's Mac does them). */
  jobs?: AppJobKind[];
  /** Remove app, a site or a left over (SharedOpen.appRemove). */
  remove?: boolean;
  admin?: boolean;
  room?: string;
}) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [env, setEnv] = useState<"preview" | "prod">("preview");
  const write = apps.level === "write";
  // Up top, its own site's Preview, where a member's Deploy goes; Published's from an owner's Bops that sends no Preview.
  // By its link: Bops Cloud drops a null previewLive (a Preview with no deploy yet).
  const site = a.sites?.[0];
  const pv = !!site && (!!site.preview || site.previewLive != null);
  const live = (pv ? site.previewLive : site?.live) ?? null;
  const serving = pv ? site.previewServing : site?.serving;
  const going = acts.find((x) => x.state !== "failed");
  const send = async (act: MemberAppAct, key?: string) => {
    setSaid(null);
    const r = await memberAct(act, key);
    if (!r.ok) setSaid(r.error ?? W.failed);
    return r.ok;
  };
  // Whether a kind of act goes through now: always where the owner's Mac does them (no `jobs`), else only the kinds its computer does.
  const can = (kind: AppJobKind) => !jobs || jobs.includes(kind);
  const newest = a.acts?.[0];
  // A Link or Bring in its computer is doing now: nothing else on the app until it's said how it went (a Preview deploy isn't the mirror's).
  const ghGoing = !!a.acts?.some((x) => x.going);
  const busy = !!going || ghGoing;
  const deployState = (s: string | null | undefined): DeployState | null => s === "queued" || s === "running" || s === "succeeded" || s === "failed" || s === "cancelled" || s === "superseded" ? s : null;
  // Production on GitHub: Live is the changeset last sent there, as the owner's own Your Apps reads it (lib/app-review.ts
  // statusForApp), never Orgo's Published, which a push doesn't move. Bops Cloud says it as `at` (null: not linked yet); one
  // from before says it at Write only (`linked`, with its folder `path`), and one before that not at all: Published's then,
  // and linked as far as this page knows (the owner's Bops says so if it isn't, and Publish stays pressable as before).
  const gh = a.github;
  const ghAt = !gh ? undefined : gh.at !== undefined ? gh.at : gh.linked ? gh.linked.ingot : gh.path !== undefined ? null : undefined;
  const liveAt = ghAt !== undefined ? ghAt : site?.serving ?? null;
  const status = appStatus({
    head: a.head?.id ?? null,
    preview: pv ? { serving: serving ?? null, state: deployState(live?.state) } : null,
    live: { serving: liveAt, state: deployState(site?.live?.state) },
    domain: !!site?.domains?.some(d => d.status !== "failed" && d.status !== "disabled"),
    wasLive: !!site?.serving,
    lost: a.lost,
    ...(gh ? { github: { linked: ghAt !== null } } : {}),
    changes: changesBetween(a.commits ?? [], liveAt, serving ?? null),
  });
  // Publish waits while its computer works on GitHub, and until it's linked there (it would be refused).
  const whyPublish = ghGoing ? W.githubWait : ghAt === null ? W.linkFirst : undefined;
  // Where an Admin's Publish goes, said where they confirm it: GitHub, or Published on domains that don't point at Orgo
  // yet (its visitors don't see a publish until they do), else its domain.
  const waitingOn = site?.domains?.length && site.domains.every((d) => d.status !== "active") && !site.url ? site.domains.map((d) => d.domain) : [];
  const where = gh ? W.publishGithub(gh) : waitingOn.length ? W.publishWaiting(waitingOn.join(" and "), waitingOn.length > 1) : null;
  const destination = gh ? `${gh.repo} · ${gh.branch}` : (site?.url ?? a.url)?.replace(/^https?:\/\//, "") ?? (waitingOn.length ? waitingOn.join(" and ") : W.destination);
  return (
    <div data-shared-app={a.name} className="flex min-w-0 flex-col">
      <div className={appRow}>
        <button type="button" onClick={() => setOpen(x => !x)} aria-expanded={open} aria-label={`Open ${a.name}`} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {open ? <ChevronDown {...appIcon}/> : <ChevronRight {...appIcon}/>}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-[14px] font-medium leading-[18px]">{a.name}</span><span className="truncate text-[12.5px] leading-[17px] text-pencil">{a.url?.replace(/^https?:\/\//, "") ?? site?.preview?.replace(/^https?:\/\//, "") ?? "No preview yet"}</span></span>
        </button>
        <span className="hidden w-[120px] shrink-0 text-right text-[12px] text-pencil @[600px]:block">{open ? "" : reviewLabel(status)}</span>
        <span className="flex w-[120px] shrink-0 justify-end">{!open && <button className={hasUnpublishedPreview(status) ? appAttention : appOutline} onClick={() => setOpen(true)}>{status.action === "publish" ? "Review changes" : "Open app"}</button>}</span>
      </div>
      {(going || acts.some((x) => x.state === "failed") || said || newest) && (
        <div className="flex flex-col gap-0.5 px-4 pb-2.5 text-[12px] leading-4">
          {going && <span className="text-[#6B6B6B]">{going.state === "waiting" ? W.waiting : going.state === "cloud" ? W.sendingComputer : W.sending}</span>}
          {acts
            .filter((x) => x.state === "failed")
            .map((x) => (
              <span key={x.key} role="alert" className="text-[#B42318]">
                {x.error ?? W.failed}
              </span>
            ))}
          {said && (
            <span role="alert" className="text-[#B42318]">
              {said}
            </span>
          )}
          {newest && <span data-act-line className={newest.ok || newest.going ? "text-[#6B6B6B]" : "text-[#B42318]"}>{actLine(newest)}</span>}
          {newest?.ok && !newest.going && newest.said && saysMore(newest.act) && (
            <span data-act-said className="text-[#6B6B6B]">
              {newest.said}
            </span>
          )}
        </div>
      )}
      <Fold lazy open={open}><div className="flex min-w-0 flex-col gap-5 border-b border-rule px-4 py-4">
        {!write && <span className="text-[13px] text-pencil">{W.readOnly}</span>}
        <AppReview status={status} previewUrl={pv ? site?.preview ?? null : a.url ?? null} liveUrl={a.url ?? null} previewAt={serving ?? null} publishedAt={liveAt} versions={a.commits} env={env} onEnv={setEnv} github={!!gh} destination={destination} publishLine={where ?? (jobs ? W.publishLineComputer : W.publishLine)} busy={!!going} whyPublish={whyPublish} updateAlso
          roomNote={write && room ? { update: room } : undefined}
          password={site?.previewProtected ? <AppPassword password={write ? site.previewPassword ?? null : null}/> : undefined}
          onUpdate={write && can("deploy") ? () => void send({ act: "deploy", app: a.name }) : undefined}
          onPublish={publish && can("deploy") ? at => send({ act: "deploy", app: a.name, env: "prod", ...(pv && !a.siteNames?.length ? { at } : {}) }) : undefined}
          history={a.commits?.length ? <AppVersions versions={a.commits} preview={serving ?? null} published={liveAt} busy={!!going} allSites={!!a.siteNames?.length} onRestore={write && can("deploy") ? id => void send({ act: "deploy", app: a.name, at: id }) : undefined}/> : undefined}
          technical={<div data-technical-details className="flex flex-col gap-4 rounded-xl bg-desk p-4">
          <Part title={W.sites}>
            {(a.sites ?? []).map((s) => (
              <span key={s.name} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-[12.5px] leading-[18px]">
                  <span className="font-medium">{s.name}</span>
                  {s.preview && <span className="text-[#9A9A98]">{W.published}</span>}
                  <span className="text-[#6B6B6B]">{stateWord(s.live?.state)}</span>
                  {s.url && <span className="text-[#3A3A38]">{s.url}</span>}
                  {(s.domains ?? []).map((d) => (
                    // Its state beside it until it's live (a state this build doesn't know reads as waiting), as the owner's Your Apps says it.
                    <span key={d.domain} data-domain-state={d.status} className="rounded-full bg-[#F6F6F4] px-2 py-0.5 text-[11.5px] text-[#3A3A38]">
                      {d.status === "active" ? d.domain : `${d.domain} · ${DOMAIN_WORDS[d.status as keyof typeof DOMAIN_WORDS] ?? DOMAIN_WORDS.pending}`}
                    </span>
                  ))}
                </span>
                {s.preview && <PreviewLine site={s} link={s.preview} write={write} />}
              </span>
            ))}
          </Part>
          {!!a.deploys?.length && (
            <Part title={W.deploys}>
              {a.deploys.map((d) => (
                <span key={d.id} className="flex items-center gap-2 text-[12.5px] leading-[18px]">
                  <span className="min-w-0 flex-1 truncate">
                    {[stateWord(d.state), d.env === "preview" ? W.preview : d.env === "prod" ? W.published : null, d.at ? shortId(d.at) : null, d.site !== a.name ? d.site : null, d.when ? ago(d.when) : null].filter(Boolean).join(" · ")}
                  </span>
                  {d.live && <span className="text-[#1E7A4C]">{W.live}</span>}
                  {/* Members go back on its Preview only (lib/server/member-acts.ts); an Admin who may publish, on Published too. */}
                  {write && can("rollback") && d.canRollback && !d.live && (d.env !== "prod" || publish) && (
                    <button type="button" disabled={!!going} onClick={() => void send({ act: "rollback", app: a.name, deployment: d.id, ...(d.site !== a.name ? { site: d.site } : {}), ...(d.env === "prod" ? { env: "prod" as const } : {}) })} className={`${BUTTON} shadow-[0_0_0_1px_#E2E2DF]`}>
                      {W.goBack}
                    </button>
                  )}
                </span>
              ))}
            </Part>
          )}
          {write && github && <GithubPart app={a} busy={busy} onSend={(act) => void send(act)} />}
          {write && can("settings") && a.settings && <AppDisclosure title="Settings"><SettingsPart app={a} disabled={!!going} onSave={(act) => void send(act)}/></AppDisclosure>}
          {write && can("domain") && !!apps.owned?.length && <DomainPart app={a} owned={apps.owned} disabled={!!going} onUse={(act) => void send(act)} />}
          {write && remove && <RemovePart app={a} admin={admin} busy={busy} can={can} onSend={send} />}
            <span className="text-[12px] text-pencil">{[W.noVariables, W.noLogs, W.noBuying].join(" ")}</span>
          </div>}/>
      </div></Fold>
    </div>
  );
}

/**
 * Taking it off the web, for an Admin or a Member with Remove apps (SharedOpen.appRemove), each asked once more as the
 * owner's own Remove is (app-settings.tsx AppEnd): the app (its code too, an Admin's), each of its other sites, and its
 * left overs on its computer (SharedApp.leftOver: by name, never an id). Each kind only where its computer does it now
 * (`can`). What it's doing shows on the app's line, as every act's does.
 */
function RemovePart({ app: a, admin, busy, can, onSend }: { app: SharedApp; admin: boolean; busy: boolean; can: (kind: AppJobKind) => boolean; onSend: (act: MemberAppAct, key?: string) => Promise<boolean> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [repo, setRepo] = useState(false);
  const [sending, setSending] = useState(false);
  const close = () => {
    setOpen(null);
    setRepo(false);
  };
  const go = async (act: MemberAppAct, key?: string) => {
    setSending(true);
    const ok = await onSend(act, key);
    setSending(false);
    if (ok) close();
  };
  const dropApp = () => {
    // Its code too: this window deletes it once the app is off the web (codeAsked).
    const key = repo ? crypto.randomUUID().replace(/-/g, "") : undefined;
    if (key) codeAsked.add(key);
    void go({ act: "remove", app: a.name, ...(repo ? { repo: true as const } : {}) }, key);
  };
  const sites = can("removeSite") ? (a.siteNames ?? []) : [];
  const left = can("removeLeftOver") ? (a.leftOver ?? []) : [];
  const off = busy || sending;
  if (!can("remove") && !sites.length && !left.length) return null;
  return (
    <div data-shared-remove className="flex flex-col gap-1.5 border-t border-[#F0F0EE] pt-3">
      {!!left.length && (
        <Part title={W.leftOvers}>
          <span className="text-[12px] text-[#9A9A98]">{W.leftOversLine}</span>
          {left.map((l) => (
            <span key={l.name} data-left-over={l.name} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-[12.5px] leading-[18px]">
                <span className="min-w-0 flex-1 truncate">{[l.name, l.port ? `port ${l.port}` : null].filter(Boolean).join(" · ")}</span>
                <button type="button" disabled={off} onClick={() => setOpen(`left:${l.name}`)} className={`${BUTTON} shadow-[0_0_0_1px_#E2E2DF]`}>
                  {W.remove}
                </button>
              </span>
              {open === `left:${l.name}` && <InlineConfirm text={W.removeLeftOverAsk(l.name)} action={W.remove} cancel={W.keep} doing={W.removing} busy={sending} onConfirm={() => void go({ act: "removeLeftOver", app: a.name, leftOver: l.name })} onCancel={close} />}
            </span>
          ))}
        </Part>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {sites.map((site) => (
          <button key={site} type="button" data-remove-site={site} disabled={off} onClick={() => setOpen(`site:${site}`)} className={`${BUTTON} shadow-[0_0_0_1px_#E2E2DF]`}>
            {W.removeSite(site)}
          </button>
        ))}
        <span className="flex-1" />
        {can("remove") && (
          <button type="button" data-remove-app disabled={off} onClick={() => setOpen("app")} className={`${BUTTON} text-[#B42318] shadow-[0_0_0_1px_#E2E2DF]`}>
            {W.removeApp}
          </button>
        )}
      </div>
      {sites.map((site) =>
        open === `site:${site}` ? <InlineConfirm key={site} text={W.removeSiteAsk(site)} action={W.remove} cancel={W.keep} doing={W.removing} busy={sending} onConfirm={() => void go({ act: "removeSite", app: a.name, site })} onCancel={close} /> : null,
      )}
      {open === "app" && (
        <InlineConfirm
          text={W.removeAppAsk(a.name)}
          action={W.remove}
          cancel={W.keep}
          doing={W.removing}
          busy={sending}
          onConfirm={dropApp}
          onCancel={close}
          extra={
            admin ? (
              <label className="flex items-center gap-2 text-[12px] leading-4 text-[#3A3A38]">
                <input type="checkbox" data-remove-code checked={repo} disabled={sending} onChange={(e) => setRepo(e.target.checked)} className="size-3.5 accent-[#0A0A0A]" />
                {W.removeCode}
              </label>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * A site's Preview, where a member's Deploy goes: its state and link, and while the link asks for a password, the password
 * at Write (the owner gave them all of Your Apps), as the owner sees it; at Read, or when the owner's Bops couldn't read it, who to ask.
 */
function PreviewLine({ site: s, link, write }: { site: NonNullable<SharedApp["sites"]>[number]; link: string; write: boolean }) {
  return (
    <span data-shared-preview className="flex flex-wrap items-center gap-2 text-[12.5px] leading-[18px]">
      <span className="text-[#9A9A98]">{W.preview}</span>
      <span className="text-[#6B6B6B]">{stateWord(s.previewLive?.state)}</span>
      <a href={link} target="_blank" rel="noreferrer" title={link} className="min-w-0 truncate font-mono text-[11.5px] leading-4 text-[#3A3A38] hover:underline">
        {link}
      </a>
      {s.previewProtected && (write && s.previewPassword ? <PasswordShown password={s.previewPassword} /> : <span className="text-[12px] leading-4 text-[#9A9A98]">{W.askPassword}</span>)}
    </span>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold leading-4 text-[#9A9A97]">{title}</span>
      {children}
    </div>
  );
}

/**
 * Its production on GitHub, for an Admin or a Member with App secrets (SharedOpen.appGithub): where it publishes and where
 * it was last the same as GitHub; Bring in GitHub's changes (asked first: GitHub's version wins where both changed a file)
 * and Link, which its own computer does; and where it publishes, set or changed (Save and link) or back on Orgo, which
 * Bops Cloud keeps (a new repo, branch, folder or workflow only with a GitHub key of the workspace's own). One folder is
 * one app: an app of more sites stays on Orgo.
 */
function GithubPart({ app: a, busy, onSend }: { app: SharedApp; busy: boolean; onSend: (act: MemberAppAct) => void }) {
  const [form, setForm] = useState<GhForm | null>(null);
  const [asking, setAsking] = useState(false);
  const g = a.github;
  const btn = `${BUTTON} shadow-[0_0_0_1px_#E2E2DF]`;
  if (a.siteNames?.length)
    return (
      <Part title={W.github}>
        <span className="text-[12.5px] text-[#6B6B6B]">{W.githubOneFolder}</span>
      </Part>
    );
  return (
    <Part title={W.github}>
      <div data-shared-github className="flex flex-col gap-1.5 text-[12.5px] leading-[18px]">
        <span className="text-[#3A3A38]">{g ? W.githubWhere(g) : W.githubOnOrgo}</span>
        {g && <span className="text-[#6B6B6B]">{g.linked ? W.githubLinked(shortId(g.linked.sha), asOf(g.linked.when)) : W.githubNotLinked}</span>}
        {!form &&
          (asking ? (
            <span data-gh-pull-ask className="flex flex-wrap items-center gap-2">
              <span className="text-[#3A3A38]">{W.githubPullAsk}</span>
              <button type="button" disabled={busy} onClick={() => (setAsking(false), onSend({ act: "githubPull", app: a.name }))} className={`${BUTTON} bg-ink text-white`}>
                {W.githubPullYes}
              </button>
              <button type="button" onClick={() => setAsking(false)} className="text-[12px] text-[#6B6B6B] hover:text-ink">
                {W.cancel}
              </button>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              {g?.linked && (
                <button type="button" data-gh-pull disabled={busy} onClick={() => setAsking(true)} className={btn}>
                  {W.githubPull}
                </button>
              )}
              {g && !g.linked && (
                <button type="button" data-gh-link disabled={busy} onClick={() => onSend({ act: "githubLink", app: a.name })} className={`${BUTTON} bg-ink text-white`}>
                  {W.githubLink}
                </button>
              )}
              <button type="button" data-gh-change disabled={busy} onClick={() => setForm(g ? ghFormOf(g) : { ...NO_GH_FORM })} className={btn}>
                {g ? W.githubChange : W.githubStart}
              </button>
            </span>
          ))}
        {form && (
          <>
            <GithubForm
              form={form}
              onChange={setForm}
              busy={busy}
              words={SHARED_GITHUB_FORM_WORDS}
              onSave={() => (setForm(null), onSend({ act: "github", app: a.name, github: ghMirrorOf(form), link: true }))}
              onCancel={() => setForm(null)}
            />
            <span className="flex flex-wrap items-center gap-2 text-[12px] text-[#9A9A98]">
              {W.githubKeyNote}
              {g && (
                <button type="button" data-gh-orgo disabled={busy} onClick={() => (setForm(null), onSend({ act: "github", app: a.name, github: null }))} className="text-[#6B6B6B] underline-offset-2 hover:text-ink hover:underline">
                  {W.githubOrgo}
                </button>
              )}
            </span>
          </>
        )}
      </div>
    </Part>
  );
}

const FIELD = "h-8 min-w-0 rounded-[10px] bg-[#F7F7F6] px-2.5 text-[12.5px] outline-none shadow-[0_0_0_1px_#E6E6E3] focus:shadow-[0_0_0_1.5px_#0A0A0A]";

/** A site's settings (port and the four commands), saved by the owner's Bops. Never its variables. */
function SettingsPart({ app: a, disabled, onSave }: { app: SharedApp; disabled: boolean; onSave: (act: MemberAppAct) => void }) {
  const site = Object.keys(a.settings ?? {})[0] ?? a.name;
  const was = a.settings?.[site];
  const [port, setPort] = useState(was?.port ? String(was.port) : "");
  const [start, setStart] = useState(was?.start ?? "");
  const [build, setBuild] = useState(was?.build ?? "");
  const [install, setInstall] = useState(was?.install ?? "");
  const changed = port !== (was?.port ? String(was.port) : "") || start !== (was?.start ?? "") || build !== (was?.build ?? "") || install !== (was?.install ?? "");
  const n = Number(port);
  return (
    <Part title={W.settings}>
      <div data-shared-settings className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-[12.5px]">
        <span className="text-[#6B6B6B]">Port</span>
        <input aria-label="Port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} className={FIELD} />
        <span className="text-[#6B6B6B]">Install</span>
        <input aria-label="Install" value={install} onChange={(e) => setInstall(e.target.value)} className={FIELD} />
        <span className="text-[#6B6B6B]">Build</span>
        <input aria-label="Build" value={build} onChange={(e) => setBuild(e.target.value)} className={FIELD} />
        <span className="text-[#6B6B6B]">Start</span>
        <input aria-label="Start" value={start} onChange={(e) => setStart(e.target.value)} className={FIELD} />
      </div>
      <span className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || !changed || (port !== "" && (!Number.isInteger(n) || n < 1 || n > 65535))}
          onClick={() =>
            onSave({ act: "settings", app: a.name, ...(site !== a.name ? { site } : {}), ...(port ? { port: n } : {}), ...(install !== (was?.install ?? "") ? { install } : {}), ...(build !== (was?.build ?? "") ? { build } : {}), ...(start !== (was?.start ?? "") ? { start } : {}) })
          }
          className={`${BUTTON} bg-ink text-white`}
        >
          {W.save}
        </button>
        <span className="text-[12px] text-[#9A9A98]">{W.noVariables}</span>
      </span>
      <KeyVariables app={a.name} />
    </Part>
  );
}

/** Use one of the workspace's own domains (bought through Orgo) for the app, with a subdomain. Buying one stays the owner's. */
function DomainPart({ app: a, owned, disabled, onUse }: { app: SharedApp; owned: NonNullable<SharedApps["owned"]>; disabled: boolean; onUse: (act: MemberAppAct) => void }) {
  const [zone, setZone] = useState(owned[0].id);
  const [sub, setSub] = useState("");
  const ok = sub === "" || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub);
  return (
    <Part title={W.domains}>
      <span className="text-[12.5px] text-[#3A3A38]">{W.useDomain}</span>
      <span data-shared-domain className="flex flex-wrap items-center gap-2">
        <input aria-label={W.subdomain} placeholder="www" value={sub} onChange={(e) => setSub(e.target.value.toLowerCase().slice(0, 63))} className={`${FIELD} w-[110px]`} />
        <span className="text-[#9A9A98]">.</span>
        <select aria-label={W.domains} value={zone} onChange={(e) => setZone(e.target.value)} className={`${FIELD} appearance-none pr-6`}>
          {owned.map((d) => (
            <option key={d.id} value={d.id}>
              {d.domain}
            </option>
          ))}
        </select>
        <button type="button" disabled={disabled || !ok} onClick={() => onUse({ act: "domain", app: a.name, zone, ...(sub ? { subdomain: sub } : {}) })} className={`${BUTTON} bg-ink text-white`}>
          {W.use}
        </button>
      </span>
      <span className="text-[12px] text-[#9A9A98]">{W.noBuying}</span>
    </Part>
  );
}
