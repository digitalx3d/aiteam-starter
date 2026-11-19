// pm2 process definition for the aiTeam dashboard (production build).
//
//   Start:   pm2 start ecosystem.config.js
//   Persist: pm2 save     <- writes the dump that `pm2 resurrect` restores
//
// To bring it back after a reboot, have `pm2 resurrect` run at logon
// (`pm2 startup` sets that up on Mac and Linux; on Windows use a Task
// Scheduler task or the pm2-windows-startup package).
//
// Paths are derived from this file's location (__dirname) so there is no
// hardcoded drive letter; this stays correct if the repo moves.

const path = require("path");
const fs = require("fs");
const os = require("os");
const appDir = path.join(__dirname, "app");

// Dashboard port: ~/.aiteam/settings.json appPort, else 3900. Never the
// generic PORT environment variable: a stray PORT left by some other tool
// would silently move the dashboard. Same rule as the dispatch courier and
// the tunnel watchdog.
let port = "3900";
try {
  const s = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".aiteam", "settings.json"), "utf8")
  );
  if (s.appPort) port = String(s.appPort);
} catch {
  /* no settings file: default */
}

module.exports = {
  apps: [
    {
      name: "aiteam",
      cwd: appDir,
      script: path.join(appDir, "node_modules", "next", "dist", "bin", "next"),
      // 127.0.0.1: this machine only. The dashboard has no login, so it must
      // not listen on the network. Tailscale serve still reaches it, because
      // it connects through localhost.
      args: `start --port ${port} --hostname 127.0.0.1`,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
  ],
};
