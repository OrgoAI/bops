/** What the Bops page may ask the Mac app for: its screens and windows, to show them live, its permissions, and whether a newer version is out. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bopsMac", {
  screens: () => ipcRenderer.invoke("mac-screens"),
  openScreenSettings: () => ipcRenderer.invoke("mac-screen-settings"),
  // The Mac previews in a small window of their own that floats over every app.
  popOut: () => ipcRenderer.invoke("mac-pip-open"),
  closePip: () => ipcRenderer.invoke("mac-pip-close"),
  showMain: () => ipcRenderer.invoke("mac-show-main"),
  // What Bops may use on this Mac (screen, microphone, notifications), asked for in one place.
  permissions: {
    status: () => ipcRenderer.invoke("perm-status"),
    request: (id) => ipcRenderer.invoke("perm-request", id),
    openSettings: (id) => ipcRenderer.invoke("perm-settings", id),
    // Full access's apps, each with its Automation answer (null until Bops can read them).
    automationApps: () => ipcRenderer.invoke("perm-automation-apps"),
  },
  // Screen Recording turned on since launch only works after a restart.
  screenNeedsRestart: () => ipcRenderer.invoke("perm-screen-restart"),
  // Restart Bops, cleanly: the state saved, cached sessions dropped, the server started
  // again, and the app opened again. Still signed in, nothing lost (desktop/main.cjs).
  relaunch: () => ipcRenderer.invoke("relaunch"),
  // A newer release on bops.bot ({ version, notes } or null), as it changes; Bops doesn't update itself.
  update: {
    info: () => ipcRenderer.invoke("update-info"),
    onChange: (fn) => {
      const on = (_, info) => fn(info);
      ipcRenderer.on("update", on);
      return () => ipcRenderer.off("update", on);
    },
    dismiss: (version) => ipcRenderer.invoke("update-dismiss", version),
    download: () => ipcRenderer.invoke("update-download"),
  },
});
