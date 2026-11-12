import { appStatus, changesBetween, type HostedApp, type AppCommit, type AppStatusInput } from "./hosted-apps";

export type ReviewStatus = ReturnType<typeof appStatus>;

/** A preview/release difference, not a recorded approval or an editing lock. */
export const hasUnpublishedPreview = (status: ReviewStatus) => status.action === "publish" && status.tone === "waits";

/** The Preview and the destination it was last sent to, never a claim about a GitHub deployment. */
export function statusForApp(app: HostedApp, commits: AppCommit[] = []): ReviewStatus {
  const gh = app.hosting?.github;
  const live = gh ? gh.last?.ingot ?? null : app.serving;
  return appStatus({
    head: app.head,
    preview: app.preview ? { serving: app.preview.serving, state: app.preview.live?.state ?? null } : null,
    live: { serving: live, state: app.live?.state ?? null },
    lost: !!app.hosting?.lost,
    domain: !!app.domains?.some(d => d.status !== "failed" && d.status !== "disabled"),
    wasLive: !!app.serving || app.live?.state === "succeeded",
    ...(gh ? { github: { linked: !!gh.last } } : {}),
    changes: changesBetween(commits, live, app.preview?.serving ?? null),
  });
}

export function reviewLabel(status: ReviewStatus, input?: Pick<AppStatusInput, "preview" | "live">): string {
  if (status.sentence.startsWith("Its computer is gone")) return "Needs a new home";
  if (status.tone === "working") return status.sentence.includes("preview") ? "Updating preview" : "Publishing";
  if (status.tone === "failed") return status.sentence.startsWith("The last preview update failed") ? "Preview update failed" : "Publish failed";
  if (status.action === "update-preview") return "Preview needs updating";
  if (status.action === "connect-domain") return "Not live";
  if (status.action === "publish") {
    if (status.sentence.includes("earlier")) return "Earlier version in preview";
    const n = status.sentence.match(/has (\d+) change/)?.[1];
    return n ? `${n} unpublished${n === "1" ? " change" : " changes"}` : "Unpublished changes";
  }
  if (status.sentence === "Live and up to date.") return "Up to date";
  if (status.sentence.includes("Link it")) return "Connect GitHub";
  if (input?.preview?.serving && !input.live.serving) return "Not live";
  return status.sentence.replace(/\.$/, "");
}
