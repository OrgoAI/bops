/**
 * The one way an app a bot made talks to Bops' window (desktop/app-frames.cjs): its `window.bops` calls
 * and what it reports go up to the webview in the window (sendToHost), and the answers come down. The
 * page sees only `window.bopsHost` (lib/made-app-page.ts uses it); nothing of Electron's or Node's.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bopsHost", {
  post: (message) => ipcRenderer.sendToHost("bops-app", message),
  listen: (fn) => void ipcRenderer.on("bops-app", (_event, message) => fn(message)),
});
