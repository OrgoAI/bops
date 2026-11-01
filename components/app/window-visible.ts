"use client";

import { useSyncExternalStore } from "react";

const subscribe = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};

/**
 * Whether the app's window is on screen (the page's visibility: hidden while the window is minimized,
 * or covered where macOS says so). Polling rests while it's hidden.
 */
export const useWindowVisible = () =>
  useSyncExternalStore(
    subscribe,
    () => document.visibilityState !== "hidden",
    () => true,
  );

const subscribeFocus = (changed: () => void) => {
  window.addEventListener("focus", changed);
  window.addEventListener("blur", changed);
  return () => {
    window.removeEventListener("focus", changed);
    window.removeEventListener("blur", changed);
  };
};

/** Whether the app's window is the one in front (it can be on show behind another app's and not be). */
export const useWindowFocused = () =>
  useSyncExternalStore(
    subscribeFocus,
    () => document.hasFocus(),
    () => true,
  );
