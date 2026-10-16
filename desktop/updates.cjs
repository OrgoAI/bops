/**
 * New versions, got by Bops itself (desktop/main.cjs, "New versions"). main.cjs asks bops.bot for the
 * newest release and, when it's newer than this app, hands it here (found). With "Download updates
 * automatically" on (Settings → This Mac, the default) it's downloaded at once, quietly; with it off it
 * waits for the user's Download. Electron's autoUpdater (Squirrel.Mac) does the download: it reads the
 * same latest.json, fetches the release's signed zip, checks it's signed by the same team as this app,
 * and stages it; macOS swaps it in when Bops quits or restarts ("Restart" in the notice).
 *
 * The autoUpdater only fetches what the file names, newer or not, and every call fetches it again: so
 * it's asked only here, after main.cjs found the version newer, at most once at a time and never for a
 * version already on its way or staged. An app that can't replace itself (opened from the DMG, from
 * Downloads where macOS runs it from a copy, or in a folder this user can't write) never asks: its
 * notice sends the user to bops.bot, as before.
 *
 * Plain CommonJS with no npm packages (the app's desktop/ folder ships without node_modules), and
 * everything Electron arrives as an argument, so scripts/test-updates.mjs runs it in plain node.
 */

const FEED_URL = "https://bops.bot/download/latest.json";
// Squirrel's words for an app it can't replace (a read-only volume, a translocated copy, no write access).
const CANT_WRITE = /read.only|translocat|can.?t write|cannot write|not writable|permission denied|EACCES|EROFS|EPERM/i;

/**
 * What the notice shows: { phase, version, notes, asked, failed }. phase is "none", "available" (out,
 * not downloading), "downloading", "ready" (staged: Restart installs it) or "manual" (this copy can't
 * update itself: bops.bot). asked: the user clicked Download, so the download shows. failed: the last
 * download the user waited for didn't finish (Try again).
 */
function createUpdates({ autoUpdater, app, fs, path, note, send, execPath = process.execPath, env = process.env }) {
  const file = () => path.join(app.getPath("userData"), "updates.json");
  let state = { phase: "none", version: undefined, notes: [], asked: false, failed: false };
  // The newest release main.cjs found ({ version, notes }); what's on its way; what's staged.
  let latest;
  let fetching;
  let staged;
  let fed = false;
  let selfOk;
  let feed;

  function set(next) {
    const before = JSON.stringify(state);
    state = { ...state, ...next };
    if (JSON.stringify(state) === before) return;
    note(`${state.phase}${state.version ? ` ${state.version}` : ""}${state.asked ? " (asked)" : ""}${state.failed ? " (didn't finish)" : ""}`);
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

  /** A newer release than this app (main.cjs checked). */
  function found(release) {
    const { version, notes = [] } = release;
    latest = { version, notes };
    if (version === fetching || version === staged) return;
    // One on its way already: this one follows when it's done (downloaded or not).
    if (fetching) return;
    if (!canSelfUpdate()) return set({ phase: "manual", version, notes, asked: false, failed: false });
    // A staged one stays what the notice shows until the newer one replaces it.
    if (staged) return auto() && download(version);
    const same = state.version === version && state.phase === "available";
    set({ phase: "available", version, notes, asked: same && state.asked, failed: same && state.failed });
    if (auto()) download(version);
  }

  /** Downloads `version` in the app (the user's Download, the switch, or found with it on). */
  function download(version, { asked = false } = {}) {
    if (!latest || version !== latest.version) return;
    if (asked && state.version === version && state.phase !== "ready") set({ asked: true });
    if (fetching || version === staged) return;
    if (!canSelfUpdate()) return set({ phase: "manual", version, notes: latest.notes, asked: false, failed: false });
    if (!fed) {
      try {
        // Throws in a build that isn't signed: no update can be checked against it.
        autoUpdater.setFeedURL({ url: feedUrl(), serverType: "json" });
        fed = true;
      } catch (e) {
        note(`can't update itself: ${e?.message ?? e}`);
        selfOk = false;
        return set({ phase: "manual", version, notes: latest.notes, asked: false, failed: false });
      }
    }
    fetching = version;
    note(`downloading ${version} from ${feedUrl()}`);
    if (!staged) set({ phase: "downloading", version, notes: latest.notes, failed: false });
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
    if (CANT_WRITE.test(message)) {
      selfOk = false;
      if (!staged && latest) set({ phase: "manual", version: latest.version, notes: latest.notes, asked: false, failed: false });
      return;
    }
    // Quiet with the switch on (the next hourly check tries again); Try again with it off.
    if (!staged && latest) set({ phase: "available", version: latest.version, notes: latest.notes, failed: !auto() });
    next(version);
  }

  autoUpdater.on("update-downloaded", () => {
    const version = fetching ?? latest?.version;
    fetching = undefined;
    staged = version;
    set({ phase: "ready", version, notes: latest?.version === version ? latest.notes : state.notes, asked: false, failed: false });
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
    download,
    ready: () => state.phase === "ready",
    state: () => ({ ...state }),
  };
}

module.exports = { createUpdates, FEED_URL };
