import path from "node:path";
import { existsSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveExistingProjectCwd } from "@/lib/projects";
import { getConfig } from "@/lib/config";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ slug: string }>;
}

/**
 * Which Windows session this process is in. Session 0 is the non-interactive
 * "Services" session: a process there has no desktop, so anything it launches
 * (explorer.exe included) opens on a desktop nobody can see. The dashboard
 * lands in session 0 whenever pm2 was resurrected by a scheduled task set to
 * "run whether user is logged on or not" — which is exactly how a reboot
 * silently broke this feature. Cached: a process never changes session.
 */
let cachedSessionId: number | null | undefined;
async function windowsSessionId(): Promise<number | null> {
  if (cachedSessionId !== undefined) return cachedSessionId;
  try {
    const { stdout } = await execFileAsync("tasklist", [
      "/FI",
      `PID eq ${process.pid}`,
      "/FO",
      "CSV",
      "/NH",
    ]);
    // "node.exe","23004","Services","0","88,072 K"
    const cols = stdout.trim().split(",");
    const parsed = Number(cols[3]?.replace(/"/g, "").trim());
    cachedSessionId = Number.isFinite(parsed) ? parsed : null;
  } catch {
    cachedSessionId = null;
  }
  return cachedSessionId;
}

/**
 * Open a folder on the interactive desktop from a session-0 process. The task
 * scheduler is the only route across the session boundary: a one-shot task
 * created with /IT ("interactive only") runs in the logged-on user's session,
 * so the window actually appears. Created, run, and deleted per click.
 */
async function openViaScheduledTask(cwd: string): Promise<void> {
  const taskName = `aiTeamOpenFolder_${process.pid}_${Date.now()}`;
  await execFileAsync("schtasks", [
    "/Create",
    "/TN",
    taskName,
    "/SC",
    "ONCE",
    "/ST",
    "00:00",
    "/TR",
    `explorer.exe "${cwd}"`,
    "/IT",
    "/F",
  ]);
  try {
    await execFileAsync("schtasks", ["/Run", "/TN", taskName]);
  } finally {
    // Give the task a moment to actually launch before removing it.
    setTimeout(() => {
      void execFileAsync("schtasks", ["/Delete", "/TN", taskName, "/F"]).catch(
        () => {}
      );
    }, 15_000);
  }
}

/**
 * Windows refuses to let a background process take the foreground, and the
 * dashboard is exactly that — a background web server. Plain `explorer.exe
 * <path>` therefore opens the folder at the BOTTOM of the window stack, behind
 * the browser you clicked from, which reads as "nothing happened."
 * open-folder.ps1 opens (or reuses) the window and then raises it properly.
 * If the script is missing for any reason, fall back to the plain launch —
 * a buried window still beats no window.
 */
function windowsOpener(cwd: string): { cmd: string; args: string[] } {
  const script = path.join(/*turbopackIgnore: true*/ getConfig().aiteamDir, "scripts", "open-folder.ps1");
  if (existsSync(/*turbopackIgnore: true*/ script)) {
    // Forward slashes are load-bearing, not cosmetic. powershell.exe re-parses
    // its own command line and strips backslashes out of unquoted arguments, so
    // a normal Windows path arrives as "Z:GitHubaiTeam" and PowerShell exits
    // before running a line of the script — silently, since we ignore its
    // output. Windows accepts forward slashes everywhere, and the script
    // normalizes them back on arrival.
    const fwd = (p: string) => p.replace(/\\/g, "/");
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        fwd(script),
        "-Path",
        fwd(cwd),
      ],
    };
  }
  return { cmd: "explorer.exe", args: [cwd] };
}

function openDirect(cwd: string): void {
  if (process.platform !== "win32") {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [cwd], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // Without a listener, a spawn failure raises an unhandled 'error' event
    // and takes the whole dashboard process down.
    child.on("error", (err) => {
      console.error("[open] failed to launch file manager:", err);
    });
    child.unref();
    return;
  }

  const { cmd, args } = windowsOpener(cwd);
  const viaPowershell = cmd === "powershell.exe";

  // powershell.exe is fussy about how it's launched, in two ways that both
  // fail SILENTLY (it exits before running a line of the script):
  //   - detached: true  — it wants to belong to its parent's process group
  //   - stdio: "ignore" — it wants real stdout/stderr handles, not NUL
  // So this one runs attached with pipes. It finishes in a couple of seconds
  // and the Explorer window it opens belongs to the shell, not to us, so
  // nothing is left hanging. explorer.exe and the mac/linux openers are happy
  // detached, which is why they still are.
  const child = spawn(cmd, args, {
    detached: !viaPowershell,
    stdio: viaPowershell ? ["ignore", "pipe", "pipe"] : "ignore",
    windowsHide: true,
  });
  child.on("error", (err) => {
    console.error("[open] failed to launch file manager:", err);
  });
  if (!viaPowershell) {
    child.unref();
    return;
  }
  // Keep the failure visible. Silence here is what made the original bug take
  // so long to pin down. (explorer.exe is exempt: it exits 1 even on success.)
  let stderr = "";
  child.stdout?.resume();
  child.stderr?.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  child.on("close", (code) => {
    if (code !== 0) {
      console.error(
        `[open] open-folder.ps1 exited ${code} for ${cwd}: ${stderr.trim() || "(no stderr)"}`
      );
    }
  });
}

export async function POST(_request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) {
    return new Response(JSON.stringify({ error: "project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Path comes from resolveExistingProjectCwd, which validates against the
  // PROJECTS_ROOT allowlist — no user-supplied path ever reaches the shell.
  try {
    if (process.platform === "win32" && (await windowsSessionId()) === 0) {
      await openViaScheduledTask(cwd);
      return new Response(
        JSON.stringify({ ok: true, path: cwd, via: "scheduled-task" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    openDirect(cwd);
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, path: cwd, via: "direct" }), {
    headers: { "Content-Type": "application/json" },
  });
}
