/**
 * Whose app this is (lib/brand.ts): a partner's build of Bops under its own name and look reads
 * desktop/brand.json, which scripts/brand.sh writes for that build only; without it, it's Bops.
 * - port: where its own server listens, so it runs beside Bops (each app keeps its own data folder,
 *   by its name, and its own window token).
 * - updates: false keeps it from updating itself, since the releases on bops.bot are Bops'.
 */
const fs = require("node:fs");
const path = require("node:path");

let b = {};
try {
  b = JSON.parse(fs.readFileSync(path.join(__dirname, "brand.json"), "utf8"));
} catch {}

module.exports = {
  id: b.id ?? "bops",
  name: b.name ?? "Bops",
  port: Number(b.port) || 3210,
  updates: b.updates !== false,
  /** Its own splash and icon, in desktop/brands/<id>/, when it has them. */
  splash: b.id && fs.existsSync(path.join(__dirname, "brands", b.id, "splash.html")) ? path.join(__dirname, "brands", b.id, "splash.html") : null,
  icon: b.id && fs.existsSync(path.join(__dirname, "brands", b.id, "icon.png")) ? path.join(__dirname, "brands", b.id, "icon.png") : null,
};
