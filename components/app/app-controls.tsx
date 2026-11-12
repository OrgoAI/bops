"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fold } from "./fold";

// Recipes shared with CRM. Keep the app's existing type, radius, and material.
export const appIcon = { size: 16, strokeWidth: 1.5, "aria-hidden": true as const };
const appAction = "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] leading-4 text-ink disabled:text-pencil";
export const appOutline = `${appAction} font-medium shadow-[0_0_0_1px_#E6E6E3] hover:bg-desk`;
export const appAttention = `${appAction} bg-highlighter font-semibold hover:bg-highlighter/80 disabled:bg-desk`;
export const appPrimary = "inline-flex shrink-0 items-center justify-center rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium leading-4 text-paper disabled:bg-desk disabled:text-pencil";
export const appGhost = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-pencil hover:bg-desk hover:text-ink disabled:opacity-50";
export const appList = "flex flex-col overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]";
export const appRow = "flex items-center gap-3 border-b border-rule px-3.5 py-3 hover:bg-desk";
const appTagBase = "shrink-0 rounded-full px-2.5 py-1 text-[12px] leading-4 text-ink";
export const appTag = `${appTagBase} bg-desk font-medium`;
export const appAttentionTag = `${appTagBase} bg-highlighter font-semibold`;
export const segmented = "flex shrink-0 gap-0.5 rounded-full bg-black/[0.05] p-[3px]";
export const segment = (on: boolean, blocked = false) => `rounded-full px-2.5 py-1 text-[12px] leading-4 ${on ? "bg-paper text-ink shadow-[0_0_0_1px_#0000000F]" : blocked ? "cursor-default text-[#C9C9C6]" : "text-pencil hover:text-ink"}`;

export function AppDisclosure({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <div className="flex flex-col gap-2">
    <button className={`${appGhost} self-start`} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown {...appIcon}/> : <ChevronRight {...appIcon}/>}{title}</button>
    <Fold lazy open={open}>{children}</Fold>
  </div>;
}
