#!/usr/bin/env node
// deploy-dashboard.mjs: rebuild the dashboard and restart it under pm2, but
// never while a teammate is mid-task.
//
//   node scripts/deploy-dashboard.mjs              build, then restart
//   node scripts/deploy-dashboard.mjs --check-only just report who is working
//   node scripts/deploy-dashboard.mjs --force      deploy even if someone is
//
// Why the check: dispatched workers are child processes of the dashboard, so
// restarting it KILLS them mid-task and strands their ticket on "running" with
// no report. The script asks the live dashboard what is in flight, once before
// the build and again right before the restart (a build takes a while, and a
// job can start in between). If the dashboard does not answer, there is nothing
// to protect, so it proceeds: deploying is usually how you fix a dead one.
//
// Order matters: if the build fails, it stops before the restart, so the
// running dashboard keeps serving the old, working build.
//
// Exit codes: 0 done (or clear, with --check-only), 1 build or restart failed,
// 2 stopped because a dispatch is in flight.
//
// Port: appPort from ~/.aiteam/settings.json, else 3900. Never the generic
// PORT environment variable, which some other tool may have left behind.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const CHECK_ONLY = args.has("--check-only");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repoRoot, "app");

function dashboardPort() {
  try {
    const s = JSON.parse(readFileSync(path.join(homedir(), ".aiteam", "settings.json"), "utf8"));
    if (s && s.appPort) return Number(s.appPort);
  } catch {
    /* no settings file: default */
  }
  return 3900;
}

const port = dashboardPort();

async function openDispatches() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/dispatch`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { answered: false, tickets: [] };
    const body = await res.json();
    return { answered: true, tickets: Array.isArray(body.tickets) ? body.tickets : [] };
  } catch {
    return { answered: false, tickets: [] };
  }
}

async function assertNoOpenDispatches(stage) {
  const { answered, tickets } = await openDispatches();
  if (!answered) {
    console.log(`==> Dispatch check (${stage}): the dashboard did not answer on port ${port}, so nothing to protect. Proceeding.`);
    return;
  }
  if (tickets.length === 0) {
    console.log(`==> Dispatch check (${stage}): nothing in flight.`);
    return;
  }
  console.log(`\n${tickets.length} dispatch(es) in flight:`);
  for (const t of tickets) {
    const mins = t.startedAt ? Math.round((Date.now() - t.startedAt) / 60000) : null;
    const age = mins === null ? "" : `  (running ${mins} min)`;
    console.log(`  - ${t.agent} on [${t.project || "aiteam"}] ${t.status}${age}`);
    if (t.brief) {
      let b = String(t.brief).replace(/\s+/g, " ");
      if (b.length > 100) b = b.slice(0, 97) + "...";
      console.log(`      ${b}`);
    }
  }
  console.log("");
  if (FORCE) {
    console.log("--force given: deploying anyway. These workers will be killed and their tickets closed as interrupted.");
    return;
  }
  console.log("Deploy STOPPED. Restarting now would kill them mid-task and lose their reports.");
  console.log("Wait for them to finish, or re-run with --force to deploy anyway.");
  process.exit(2);
}

function run(cmd, cmdArgs, cwd) {
  // shell: true so npm and pm2 resolve to their .cmd shims on Windows.
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0;
}

await assertNoOpenDispatches("before the build");
if (CHECK_ONLY) {
  console.log("--check-only given: stopping before the build.");
  process.exit(0);
}

console.log("==> Building the dashboard (npm run build)");
if (!run("npm", ["run", "build"], appDir)) {
  console.log("Build FAILED. Nothing was restarted; the running dashboard is untouched.");
  process.exit(1);
}

await assertNoOpenDispatches("before the restart");

console.log("==> Restarting the pm2 app 'aiteam'");
if (!run("pm2", ["restart", "aiteam"], repoRoot)) {
  console.log("pm2 restart failed. Is the app registered? From the repo root: pm2 start ecosystem.config.js && pm2 save");
  process.exit(1);
}
console.log(`==> Done. Dashboard: http://localhost:${port}`);
