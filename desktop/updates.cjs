/**
 * New versions, got by Bops itself (desktop/main.cjs, "New versions"). main.cjs asks bops.bot for the
 * newest release and, when it's newer than this app, hands it here (found). With "Download updates
 * automatically" on (Settings → This Mac, the default) it's downloaded at once, quietly; with it off it
 * waits for the user's Download. Electron's autoUpdater (Squirrel.Mac) does the download: it reads the
 * same latest.json, fetches the release's signed zip, checks it's signed by the same team as this app,
 * and stages it; macOS swaps it in when Bops quits or restarts ("Restart" in the notice).
 *
 * The autoUpdater only fetches what the file names, newer or not, and every call fetches it again: so
 * it's asked only here, after main.cjs found the version newer and checked the zip the file names
 * (offers), at most once at a time, never for a version already on its way, and not while one is staged
 * (Restart installs that one first). An app that can't replace itself (opened from the DMG, from
 * Downloads where macOS runs it from a copy, or in a folder this user can't write) never asks: its
 * notice sends the user to bops.bot, as before.
 *
 * A download that failed leaves Squirrel unable to fetch that zip again in the same updater: its
 * downloads keep their own cache (in memory, gone when Bops quits), so the next try asks bops.bot "only
 * if it changed" (If-None-Match), bops.bot answers 304 Not Modified, and Squirrel takes that as nothing
 * to download (update-not-available, within a second, nothing fetched). So the try after a failure
 * gets a new updater first (setFeedURL makes one), which asks for the whole zip again.
 *
 * Plain CommonJS with no npm packages (the app's desktop/ folder ships without node_modules), and
 * everything Electron arrives as an argument, so scripts/test-updates.mjs runs it in plain node.
 */

const FEED_URL = "https://bops.bot/download/latest.json";
// Squirrel's words for an app it can't replace (a read-only volume, a translocated copy, no write access).
const CANT_WRITE = /read.only|translocat|can.?t write|cannot write|not writable|permission denied|EACCES|EROFS|EPERM/i;
// Its words for a zip whose app isn't signed so this one can update to it: that zip never will be.
// (Not ditto's "Couldn't read pkzip signature", which follows a zip that didn't unpack: see NO_SPACE.)
const BAD_SIGNATURE = /code requirement|(?<!pkzip )signature/i;
// The Mac's disk too full to unpack the update: ditto's "No space left on device" (ENOSPC), and macOS's
// "there isn't enough space" when even the zip can't be saved.
const NO_SPACE = /ENOSPC|no space left|(isn.t|not) enough (free )?space|disk is full/i;
// What a download needs free: the zip (about 210 MB) and the app it unpacks to (about 530 MB), with room
// to spare (a Mac with 1.4 GB free still ran out). The notice says "about 2 GB" (update-notice.tsx).
const SPACE_NEEDED = 2e9;
// A download that didn't finish waits this long before the switch tries the same version again (after
// the first failure, then the second); after the third it waits for a newer version or the user's
// Download. Each one is the whole zip, about 155 MB: one bad release mustn't fetch it every hour.
const RETRY_AFTER = [60 * 60_000, 4 * 60 * 60_000];
const MAX_TRIES = 3;

/**
 * What the notice shows: { phase, version, notes, asked, failed, why }. phase is "none", "available" (out,
 * not downloading), "downloading", "ready" (staged: Restart installs it) or "manual" (this copy can't
 * update itself: bops.bot). asked: the user clicked Download, so the download shows. failed: the last
 * download the user waited for didn't finish (Try again). why: "space" when that was because the Mac's
 * disk is full (shown whether the user waited for it or not), else "".
 */
function createUpdates({ autoUpdater, app, fs, path, note, send, execPath = process.execPath, env = process.env, now = Date.now }) {
  const file = () => path.join(app.getPath("userData"), "updates.json");
  let state = { phase: "none", version: undefined, notes: [], asked: false, failed: false, why: "" };
  // The newest release main.cjs found ({ version, notes }); what's on its way; what's staged.
  let latest;
  let fetching;
  let staged;
  let fed = false;
  // A download failed: the next one gets a new updater first (see the top of this file).
  let fresh = false;
  let selfOk;
  let feed;
  // The downloads of one version that didn't finish: { version, count, at, never, space } (never: its
  // zip's signature is wrong, so it won't ever; space: the last one ran out of disk space).
  let tries;

  function set(next) {
    const before = JSON.stringify(state);
    state = { ...state, ...next };
    if (JSON.stringify(state) === before) return;
    note(`${state.phase}${state.version ? ` ${state.version}` : ""}${state.asked ? " (asked)" : ""}${state.failed ? " (didn't finish)" : ""}${state.why ? ` (${state.why})` : ""}`);
    send({ ...state });
  }

  /** The Settings switch, from userData/updates.json: on unless the user turned it off. */
  function auto() {
    try {
      return JSON.parse(fs.readFileSync(file(), "utf8")).auto !== false;
    } catch {
      return true;
    }
  }
  function setAuto(on) {
    try {
      fs.writeFileSync(file(), JSON.stringify({ auto: !!on }));
    } catch (e) {
      note(`couldn't save the setting: ${e?.message ?? e}`);
    }
    note(`download updates automatically: ${on ? "on" : "off"}`);
    if (on && state.phase === "available") download(state.version);
    return { auto: auto(), canSelfUpdate: canSelfUpdate() };
  }

  /** Whether this copy of Bops can replace itself: in an Applications folder, not run from a DMG or a translocated copy, and writable. Asked once. */
  function canSelfUpdate() {
    if (selfOk !== undefined) return selfOk;
    const bundle = path.resolve(execPath, "../../..");
    let why = "";
    if (!app.isInApplicationsFolder()) why = "it isn't in Applications";
    else if (execPath.includes("/AppTranslocation/")) why = "macOS runs it from a translocated copy";
    else if (execPath.startsWith("/Volumes/")) why = "it runs from a disk image";
    else
      try {
        fs.accessSync(bundle, fs.constants.W_OK);
        fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
      } catch {
        why = `${bundle} can't be written`;
      }
    selfOk = !why;
    if (why) note(`can't update itself (${why}): new versions are on bops.bot`);
    return selfOk;
  }

  /** Where the autoUpdater reads the release: bops.bot, or (to test a build) BOPS_UPDATE_FEED when it's on this Mac. */
  function feedUrl() {
    if (feed) return feed;
    feed = FEED_URL;
    const asked = env.BOPS_UPDATE_FEED;
    if (asked) {
      let url;
      try {
        url = new URL(asked);
      } catch {}
      if (url && /^https?:$/.test(url.protocol) && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) feed = url.href;
      else note(`BOPS_UPDATE_FEED ignored (only http on 127.0.0.1 or localhost): ${asked}`);
    }
    return feed;
  }

  /**
   * The zip latest.json names for `version`, checked before anything is fetched: Squirrel installs
   * whatever the file names (an older signed build too, or over plain http), so it must be this version's
   * zip on bops.bot (or, for a test feed, on the same Mac). Says what's wrong, or "" when it's fine.
   */
  function offers(file, version) {
    if (file?.currentRelease !== version) return `its currentRelease isn't ${version}`;
    const entry = Array.isArray(file.releases) ? file.releases.find((r) => r?.updateTo?.version === version) : undefined;
    const url = entry?.updateTo?.url;
    if (typeof url !== "string") return `it names no zip for ${version}`;
    const zip = `Bops-${version}-arm64-mac.zip`;
    if (url === `https://bops.bot/download/${zip}`) return "";
    try {
      const at = new URL(url);
      const from = new URL(feedUrl());
      if (from.href !== FEED_URL && at.host === from.host && /^https?:$/.test(at.protocol) && at.pathname.endsWith(`/${zip}`)) return "";
    } catch {}
    return `its zip for ${version} isn't bops.bot's: ${url}`;
  }

  /** Free space on the disk Squirrel unpacks to (~/Library/Caches), in bytes, or undefined when it can't tell. */
  function freeSpace() {
    try {
      const s = fs.statfsSync(path.join(app.getPath("home"), "Library", "Caches"));
      return s.bavail * s.bsize;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the switch leaves `version` alone for now: its last downloads didn't finish (see
   * RETRY_AFTER). After one ran out of space nothing downloads on its own until there's room again
   * (any version: each try fills the disk up again); with room, the usual waits and MAX_TRIES still hold.
   */
  function holding(version) {
    if (tries?.space) {
      const free = freeSpace();
      if (free !== undefined && free < SPACE_NEEDED) return true;
    }
    if (tries?.version !== version) return false;
    if (tries.never) return true;
    if (tries.count >= MAX_TRIES) return true;
    return now() - tries.at < RETRY_AFTER[tries.count - 1];
  }

  /** A newer release than this app (main.cjs checked). */
  function found(release) {
    const { version, notes = [] } = release;
    latest = { version, notes };
    if (version === fetching || version === staged) return;
    // One on its way already: this one follows when it's done (downloaded or not).
    if (fetching) return;
    if (!canSelfUpdate()) return set({ phase: "manual", version, notes, asked: false, failed: false, why: "" });
    // A staged one stays until it's installed: Restart installs it, and the newer one downloads after.
    // (A second download while one is staged would race the Restart for Squirrel's staged copy.)
    if (staged) return;
    const same = state.version === version && state.phase === "available";
    // With the switch on it goes straight to downloading, which the notice doesn't show: it never
    // flashes "is out" first.
    if (auto() && !holding(version)) return download(version, { asked: same && state.asked });
    // A download that didn't finish keeps saying so (and why) until the next one starts.
    set({ phase: "available", version, notes, asked: same && state.asked, failed: same && state.failed, why: same && state.failed ? state.why : "" });
  }

  /** latest.json names a zip this app won't fetch (see offers): the notice sends the user to bops.bot. */
  function manual(release, why) {
    const { version, notes = [] } = release;
    latest = { version, notes };
    note(`won't download ${version}: ${why}`);
    if (fetching || staged) return;
    set({ phase: "manual", version, notes, asked: false, failed: false, why: "" });
  }

  /** Downloads `version` in the app (the user's Download, the switch, or found with it on). */
  function download(version, { asked = false } = {}) {
    if (!latest || version !== latest.version) return;
    if (asked && state.version === version && state.phase !== "ready") set({ asked: true });
    if (fetching || version === staged) return;
    if (!canSelfUpdate()) return set({ phase: "manual", version, notes: latest.notes, asked: false, failed: false, why: "" });
    // A new updater after a failed download, or its cached zip answers "nothing to download" (top of file).
    if (!fed || fresh) {
      try {
        // Throws in a build that isn't signed: no update can be checked against it.
        autoUpdater.setFeedURL({ url: feedUrl(), serverType: "json" });
        if (fed) note("a new updater for this download (the last one didn't finish)");
        fed = true;
        fresh = false;
      } catch (e) {
        note(`can't update itself: ${e?.message ?? e}`);
        selfOk = false;
        return set({ phase: "manual", version, notes: latest.notes, asked: false, failed: false, why: "" });
      }
    }
    fetching = version;
    note(`downloading ${version} from ${feedUrl()}`);
    if (!staged) set({ phase: "downloading", version, notes: latest.notes, asked: asked || (state.version === version && state.asked), failed: false, why: "" });
    try {
      autoUpdater.checkForUpdates();
    } catch (e) {
      failed(e);
    }
  }

  /** The download ended (done or not): a newer release found meanwhile goes next. */
  function next(version) {
    if (latest && latest.version !== version) found(latest);
  }

  function failed(e) {
    const version = fetching;
    fetching = undefined;
    const message = String(e?.message ?? e);
    note(`the download${version ? ` of ${version}` : ""} didn't finish: ${message}`);
    // Nothing was on its way (an error after one finished): only logged.
    if (!version) return;
    const space = NO_SPACE.test(message);
    // Whatever went wrong, the next try needs a new updater (see the top of this file).
    fresh = true;
    if (!space && CANT_WRITE.test(message)) {
      selfOk = false;
      if (!staged && latest) set({ phase: "manual", version: latest.version, notes: latest.notes, asked: false, failed: false, why: "" });
      return;
    }
    const again = tries?.version === version;
    tries = { version, count: again ? tries.count + 1 : 1, at: now(), space, never: (again && tries.never) || (!space && BAD_SIGNATURE.test(message)) };
    // Try again when the user waited for it (Download, or the switch off); quiet when the switch got it
    // unasked (a later hourly check tries again, see holding). Out of space always says so: no later
    // check gets it until there's room.
    if (!staged && latest) set({ phase: "available", version: latest.version, notes: latest.notes, failed: space || state.asked || !auto(), why: space ? "space" : "" });
    next(version);
  }

  // Squirrel reads latest.json again itself, so what it staged is the version its release names ("Bops
  // 0.0.91"), which is newer than the one asked for when a release came out in between.
  autoUpdater.on("update-downloaded", (_e, _notes, name) => {
    const named = /\d+\.\d+\.\d+/.exec(String(name ?? ""))?.[0];
    const version = named ?? fetching ?? latest?.version;
    fetching = undefined;
    staged = version;
    set({ phase: "ready", version, notes: latest?.version === version ? latest.notes : state.version === version ? state.notes : [], asked: false, failed: false, why: "" });
    next(version);
  });
  autoUpdater.on("update-not-available", () => fetching && failed(new Error("the feed offered nothing to download")));
  autoUpdater.on("error", (e) => failed(e));

  return {
    auto,
    setAuto,
    canSelfUpdate,
    feedUrl,
    found,
    manual,
    offers,
    download,
    ready: () => state.phase === "ready",
    state: () => ({ ...state }),
  };
}

module.exports = { createUpdates, FEED_URL, SPACE_NEEDED };
