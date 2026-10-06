#!/usr/bin/env node
/**
 * Renders the bots' pictures (edge/public/mascot: PNG for Slack and Discord, JPG for Telegram) and the
 * Bops logo (edge/public/brand), from the same drawing the app uses (lib/mascot.ts). Run after
 * changing the mascot, copy edge/public/{mascot,brand} to cloud/public (Bops Cloud serves them), then
 * deploy the cloud and edge/ (cd edge && fly deploy). Needs Chrome (Playwright).
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mascotMarkup, PICTURE_COLORS, PICTURE_SHAPES } from "../lib/mascot.ts";

const CREAM = "#FDFFF6";
const jobs = [{ name: "main-0A0A0A", markup: mascotMarkup("boppy", "#0A0A0A"), bg: CREAM }];
for (const c of PICTURE_COLORS) jobs.push({ name: `blob-${c.slice(1)}`, markup: mascotMarkup("bot", c), bg: CREAM });
for (const [id, c] of Object.entries(PICTURE_SHAPES)) jobs.push({ name: `${id}-${c.slice(1)}`, markup: mascotMarkup(id, c), bg: CREAM });

mkdirSync("edge/public/mascot", { recursive: true });
mkdirSync("edge/public/brand", { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
const shot = async (markup, bg, size, scale, out, jpg) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;background:${bg};display:flex;align-items:center;justify-content:center"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size * scale}" height="${size * scale}">${markup}</svg></body></html>`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size } });
  if (jpg) await page.screenshot({ path: out.replace(/\.png$/, ".jpg"), type: "jpeg", quality: 92, clip: { x: 0, y: 0, width: size, height: size } });
};
for (const j of jobs) await shot(j.markup, j.bg, 512, 0.8, `edge/public/mascot/${j.name}.png`, true);
// The logo: Boppy, vibing, ink headphones on the highlighter.
const logo = mascotMarkup("boppy", "#0A0A0A", { accent: false });
await shot(logo, "#E9FF3B", 512, 0.74, "edge/public/brand/bops-512.png");
await shot(logo, "#E9FF3B", 1024, 0.74, "edge/public/brand/bops-1024.png");
await browser.close();
console.log(`rendered ${jobs.length} mascots and the logo`);
