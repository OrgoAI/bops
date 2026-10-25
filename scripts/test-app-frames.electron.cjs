// Electron's side of scripts/test-app-frames.mjs (which starts it; not run on its own): desktop/app-frames.cjs
// installed as desktop/main.cjs installs it, then each case's window page, with its app in a webview, in a
// hidden window for a few seconds; what each window saw (the calls it answered, the events) goes to RESULTS.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { installAppFrames } = require("../desktop/app-frames.cjs");

const { BOPS, CASES, RESULTS, USER_DATA } = process.env;
app.setPath("userData", USER_DATA);
app.dock?.hide();
// One window at a time: closing one isn't the end.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  installAppFrames({ app, session, server: BOPS, preload: path.join(__dirname, "..", "desktop", "app-frame-preload.cjs"), log: (m) => console.error(m) });
  // Let the proxy settle (main.cjs opens its splash first).
  await new Promise((r) => setTimeout(r, 300));
  const out = {};
  for (const name of CASES.split(",")) {
    const win = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { webviewTag: true } });
    // (Its load can report a failure when the app's own navigation is stopped: what counts is what it saw.)
    await win.loadURL(`${BOPS}/parent/${name}`).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    out[name] = JSON.parse(await win.webContents.executeJavaScript("JSON.stringify({ calls: window.calls, events: window.events, attached: !!document.getElementById('app').getWebContentsId })"));
    win.destroy();
  }
  fs.writeFileSync(RESULTS, JSON.stringify(out));
  app.quit();
});
