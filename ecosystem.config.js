// pm2 process definition for the aiTeam dashboard (production build).
//
//   Start:   pm2 start ecosystem.config.js
//   Persist: pm2 save     <- writes the dump that `pm2 resurrect` restores
//
// After a reboot, `pm2 resurrect` has to run at logon. Exactly ONE thing should
// do that: two startup paths give you two pm2 daemons racing for the same port.
//   Windows:     powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-pm2-startup.ps1
//                (one logon task; verify after a restart with scripts/verify-startup.ps1)
//   Mac / Linux: pm2 startup, then follow the command it prints.
//
// Rebuild and restart after an update: node scripts/deploy-dashboard.mjs
// (refuses while a teammate is mid-task; a restart would kill them).
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
