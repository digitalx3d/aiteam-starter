// pm2 process definition for the aiTeam dashboard (production build).
//
//   Start:   pm2 start ecosystem.config.js
//   Persist: pm2 save     <- writes the dump that `pm2 resurrect` restores
//
// The machine already has a "ClaudeClawStartup" scheduled task that runs
// `pm2 resurrect` at boot, so once saved the dashboard comes back automatically
// after a reboot — no separate startup task needed.
//
// Paths are derived from this file's location (__dirname) so there is no
// hardcoded drive letter; this stays correct if the repo moves.

const path = require("path");
const fs = require("fs");
const os = require("os");
const appDir = path.join(__dirname, "app");

// Dashboard port: ~/.aiteam/settings.json appPort > PORT env > 3900.
// Same source and same precedence as the dispatch courier and tunnel
// watchdog: the settings file is explicit and per-install, so it outranks
// an ambient PORT env var (the 2026-05 machine-level-PORT footgun).
let port = String(process.env.PORT || "3900");
try {
  const s = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".aiteam", "settings.json"), "utf8")
  );
  if (s.appPort) port = String(s.appPort);
} catch {
  /* no settings file — default */
}

module.exports = {
  apps: [
    {
      name: "aiteam",
      cwd: appDir,
      script: path.join(appDir, "node_modules", "next", "dist", "bin", "next"),
      args: `start --port ${port} --hostname 0.0.0.0`,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
  ],
};
