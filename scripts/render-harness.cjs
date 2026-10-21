// The Mac app's page reader (desktop/render.cjs) on its own, for scripts/test-render.mjs: Electron runs
// this instead of the app, with no window shown, no Dock icon, and its data in a throwaway folder. It
// listens on BOPS_RENDER_SOCKET for requests with BOPS_UI_TOKEN, says "ready" once it does, and quits
// when the test closes its input.
// Usage (from the test): node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/render-harness.cjs
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startRenderService } = require("../desktop/render.cjs");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "bops-render-harness-"));
app.setPath("userData", data);
app.dock?.hide();
// Hidden windows come and go; that's no reason to quit.
app.on("window-all-closed", () => {});
app.whenReady().then(() => {
  const service = startRenderService({ socketPath: process.env.BOPS_RENDER_SOCKET, token: process.env.BOPS_UI_TOKEN, log: (line) => process.stderr.write(`${line}\n`) });
  const quit = () => {
    service.close();
    fs.rmSync(data, { recursive: true, force: true });
    app.exit(0);
  };
  process.stdin.on("end", quit);
  process.stdin.on("close", quit);
  process.stdin.resume();
  service.listening.then(
    () => process.stdout.write("ready\n"),
    (e) => {
      process.stderr.write(`render service didn't start: ${e.message}\n`);
      quit();
    },
  );
});
