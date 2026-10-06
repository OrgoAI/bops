/** What the Bops page may ask the Mac app for: its screens and windows, to show them live, and its permissions. */
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
  },
  // Screen Recording turned on since launch only works after a restart.
  screenNeedsRestart: () => ipcRenderer.invoke("perm-screen-restart"),
  relaunch: () => ipcRenderer.invoke("relaunch"),
});
