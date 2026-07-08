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
const appDir = path.join(__dirname, "app");

module.exports = {
  apps: [
    {
      name: "aiteam",
      cwd: appDir,
      script: path.join(appDir, "node_modules", "next", "dist", "bin", "next"),
      args: "start --port 3900 --hostname 0.0.0.0",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
  ],
};
