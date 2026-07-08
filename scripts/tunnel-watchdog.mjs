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
import { existsSync } from "node:fs";

const PORT = "3900";
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const TS = existsSync("C:/Program Files/Tailscale/tailscale.exe")
  ? "C:/Program Files/Tailscale/tailscale.exe"
  : "tailscale";

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
