import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

let failed = 0;
const row = (ok, label, detail = "") => {
  console.log(`${ok ? "[OK]" : "[FAIL]"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed++;
};
const cmd = (name, args = ["--version"]) => {
  try { return execFileSync(name, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return ""; }
};

row(process.platform === "win32", "Windows", `${os.release()} ${os.arch()}`);
row(Number(process.versions.node.split(".")[0]) >= 22, "Node.js 22+", process.version);
row(!!cmd("git.exe"), "Git", cmd("git.exe"));
row(!!cmd("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]), "PowerShell");

const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
const browsers = [
  process.env.BOPS_CHROME_PATH,
  ...roots.flatMap((r) => [
    path.join(r, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]),
].filter(Boolean);
const browser = browsers.find((p) => fs.existsSync(p));
row(!!browser, "Chrome or Edge", browser || "Set BOPS_CHROME_PATH in .env.local");

row(fs.existsSync(path.join(process.cwd(), "desktop", "main.cjs")), "Bops desktop source");
row(fs.existsSync(path.join(process.cwd(), "WINDOWS11.md")), "Windows port files");

console.log("");
if (failed) {
  console.log(`${failed} required check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("Windows 11 prerequisites look good.");
}
