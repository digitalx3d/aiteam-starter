// Path configuration for the vault-index scripts.
//
// Mirrors app/src/lib/config.ts exactly (same settings file, same env vars,
// same defaults) so there is ONE source of truth for paths: ~/.aiteam/settings.json.
// These scripts are standalone Node (no app build, no node_modules) so they
// re-implement the tiny resolution chain instead of importing the TS module.
//
// Resolution order (highest wins): settings file > env var > default.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SETTINGS_FILE =
  process.env.AITEAM_SETTINGS_FILE ||
  path.join(os.homedir(), ".aiteam", "settings.json");

// scripts/vault-index/config.mjs -> repo root is two levels up.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const FIELDS = {
  // Same defaults as setup.mjs and app/src/lib/config.ts: the folder the
  // aiTeam repo sits in, and a vault beside it.
  projectsRoot: { env: "PROJECTS_ROOT", def: () => path.dirname(REPO_ROOT) },
  vaultDir: { env: "VAULT_DIR", def: () => path.join(path.dirname(REPO_ROOT), "vault") },
  claudeProjectsDir: {
    env: "CLAUDE_PROJECTS_DIR",
    def: () => path.join(os.homedir(), ".claude", "projects"),
  },
  aiteamDir: { env: "AITEAM_DIR", def: () => REPO_ROOT },
  // The running dashboard, for auto-commit calls to /api/chat/end-session.
  // Not a path, but resolved the same way so it can live in settings.json too.
  appUrl: { env: "AITEAM_APP_URL", def: () => "http://localhost:3900" },
};

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function getConfig() {
  const saved = readSettings();
  const cfg = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    const fromFile = saved[key];
    cfg[key] =
      (typeof fromFile === "string" && fromFile.trim()) ||
      process.env[field.env] ||
      field.def();
  }
  // appPort (set by the starter's setup.mjs) shifts the default appUrl; an
  // explicit appUrl (settings or env) still wins above.
  if (!saved.appUrl && !process.env.AITEAM_APP_URL && saved.appPort) {
    cfg.appUrl = `http://localhost:${String(saved.appPort)}`;
  }
  cfg.indexDir = path.join(cfg.vaultDir, ".index");
  cfg.dbPath = path.join(cfg.indexDir, "index.db");
  return cfg;
}
