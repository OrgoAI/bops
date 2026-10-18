/** What the Bops page may ask the Mac app for: its screens and windows, to show them live, its permissions, and new versions. */
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
    status: (ids) => ipcRenderer.invoke("perm-status", ids),
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
  // Copy a key from the Vault, kept out of clipboard managers and other devices, and cleared after a minute.
  copySecret: (value) => ipcRenderer.invoke("copy-secret", value),
  // Skills: pick a folder in Finder to import (its path only), and show a skill's folder in Finder.
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  revealFolder: (dir) => ipcRenderer.invoke("reveal-folder", dir),
  // The page shown when Bops can't start (desktop/trouble.html): start again, or open the logs folder.
  startup: {
    retry: () => ipcRenderer.invoke("startup-retry"),
    logs: () => ipcRenderer.invoke("startup-logs"),
  },
  // A newer release ({ version, notes, phase, asked, failed } or null), as it changes. Bops downloads it
  // itself (quietly, unless the user turned that off in Settings) and Restart installs it; a copy that
  // can't replace itself sends the user to bops.bot (desktop/main.cjs, "New versions").
  update: {
    info: () => ipcRenderer.invoke("update-info"),
    onChange: (fn) => {
      const on = (_, info) => fn(info);
      ipcRenderer.on("update", on);
      return () => ipcRenderer.off("update", on);
    },
    dismiss: (version) => ipcRenderer.invoke("update-dismiss", version),
    // Get it in the app (or on bops.bot, for a copy that can't replace itself); also Try again.
    download: () => ipcRenderer.invoke("update-download"),
    // Restart Bops with the downloaded version.
    install: () => ipcRenderer.invoke("update-install"),
    // Settings' "Download updates automatically": { auto, canSelfUpdate }, or null in a build that doesn't update.
    auto: () => ipcRenderer.invoke("update-auto"),
    setAuto: (on) => ipcRenderer.invoke("update-set-auto", !!on),
  },
});
