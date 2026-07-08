// Keeps the aiTeam dashboard's Tailscale tunnel alive.
//
// The app (pm2 `aiteam`) auto-recovers, but the `tailscale serve` tunnel does
// not: it was found missing on 2026-06-20 with the machine up 9 days and no
// Tailscale upgrade — i.e. it can vanish during normal operation, untied to any
// reboot. This runs under pm2 (headless, no window), checks every 10 minutes,
// and re-asserts the tunnel only when it's actually gone (otherwise a no-op).
//
// Register once:
//   pm2 start Z:\GitHub\aiTeam\scripts\tunnel-watchdog.mjs --name tunnel-watchdog
//   pm2 save
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Dashboard port: ~/.aiteam/settings.json appPort > PORT env > 3900 —
// the same resolution the dispatch courier and ecosystem.config.js use.
function resolvePort() {
  try {
    const s = JSON.parse(
      readFileSync(join(homedir(), ".aiteam", "settings.json"), "utf8")
    );
    if (s.appPort) return String(s.appPort);
  } catch {
    /* fall through */
  }
  return String(process.env.PORT || "3900");
}
const PORT = resolvePort();
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const TS =
  [
    "C:/Program Files/Tailscale/tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].find((p) => existsSync(p)) || "tailscale";

const stamp = () => new Date().toISOString();

function ts(args) {
  return new Promise((resolve) => {
    execFile(TS, args, { windowsHide: true }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || "", stderr: stderr || "" })
    );
  });
}

async function check() {
  const { err, stdout } = await ts(["serve", "status"]);
  if (err) {
    // tailscaled not ready / not logged in — skip this tick, try again later.
    console.error(`[${stamp()}] serve status unavailable, will retry: ${err.message}`);
    return;
  }
  if (stdout.includes(PORT)) return; // tunnel up — quiet no-op
  console.log(`[${stamp()}] tunnel for :${PORT} is missing — re-asserting`);
  const res = await ts(["serve", "--bg", "--yes", PORT]);
  if (res.err) console.error(`[${stamp()}] re-assert FAILED: ${res.stderr || res.err.message}`);
  else console.log(`[${stamp()}] tunnel re-asserted OK`);
}

console.log(`[${stamp()}] tunnel-watchdog up — checking :${PORT} every ${INTERVAL_MS / 60000} min`);
check();
setInterval(check, INTERVAL_MS);
