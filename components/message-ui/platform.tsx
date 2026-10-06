"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Which native Messages app to replicate. Sizes, spacing, and chrome all key off this. */
export type Platform = "ios" | "macos";

const PlatformContext = createContext<Platform>("ios");

export function PlatformProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): Platform {
  return useContext(PlatformContext);
}
