import path from "node:path";
import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import { discoverProjects, getProjectsRoot } from "./projects";

/**
 * The Servers page: which of OUR servers are up. Look-only by design: nothing
 * here starts, stops or restarts anything.
 *
 * "Ours" means one of:
 *   - a pm2 app (the always-on services: the dashboard and anything else you run under pm2)
 *   - a listening process whose command line points into the projects folder
 *   - a listening process on a port some project declares in package.json
 *   - a listening developer runtime (node, python, java, ...) we can't place
 * Windows, Dropbox, Tailscale and the like are left out on purpose.
 *
 * Windows: ports come from `netstat -ano`, command lines from Win32_Process.
 * Mac and Linux: ports from `lsof`, command lines from `ps`.
 */

export type ServerStatus = "up" | "down" | "stopped" | "conflict";

export interface ServerPort {
  port: number;
  /** Bound address as netstat prints it: 0.0.0.0, 127.0.0.1, [::], [::1]. */
  address: string;
}

export interface ServerRow {
  key: string;
  name: string;
  project: string | null;
  kind: "always-on" | "dev";
  status: ServerStatus;
  ports: ServerPort[];
  /** The port this server is supposed to answer on, when we know it. */
  expectedPort: number | null;
  pid: number | null;
  command: string | null;
  /** Plain-English explanation for anything not simply up or stopped. */
  note: string | null;
  uptimeSince: string | null;
  restarts: number | null;
  memoryMb: number | null;
  /** Other projects whose package.json claims the same port. */
  sharedWith: string[];
}

export interface ServersSnapshot {
  rows: ServerRow[];
  /** Always-on services that are down. Drives the sidebar's red dot. */
  downCount: number;
  checkedAt: string;
  /** Set when pm2 couldn't be read, so "no always-on apps" isn't mistaken for "all fine". */
  pm2Error: string | null;
}

interface Listener extends ServerPort {
  pid: number;
}

interface ProcInfo {
  pid: number;
  parentPid: number | null;
  name: string;
  command: string;
}

interface Pm2App {
  name: string;
  pid: number;
  status: string;
  cwd: string | null;
  args: string[];
  uptimeSince: string | null;
  restarts: number | null;
  memoryMb: number | null;
}

interface DeclaredPort {
  project: string;
  port: number;
  /** "app/package.json · dev" */
  source: string;
}

/** Runtimes that are almost always one of our dev servers or tools. */
const DEV_IMAGES = new Set([
  "node.exe",
  "python.exe",
  "pythonw.exe",
  "java.exe",
  "bun.exe",
  "deno.exe",
  "php.exe",
  "ruby.exe",
  "dotnet.exe",
]);

/** Package folders one level down that commonly hold the runnable app. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

function run(
  file: string,
  args: string[],
  timeoutMs = 8_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        // pm2 is a .cmd shim on Windows, which execFile can't start without a shell.
        shell: file === "pm2",
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

async function readListeners(): Promise<Listener[]> {
  if (process.platform !== "win32") return readListenersPosix();
  const out = await run("netstat", ["-ano"]);
  const seen = new Set<string>();
  const listeners: Listener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    const local = cols[1];
    const i = local.lastIndexOf(":");
    const port = Number(local.slice(i + 1));
    const pid = Number(cols[4]);
    if (!Number.isFinite(port) || !Number.isFinite(pid) || pid === 0) continue;
    const address = local.slice(0, i);
    const key = `${pid}:${port}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ port, address, pid });
  }
  return listeners;
}

/**
 * Mac and Linux: `lsof -F pn` prints one field per line, "p<pid>" then one
 * "n<address>:<port>" per listening socket. Needs lsof (built into macOS; most
 * Linux installs have it). Only the current user's processes are visible
 * without sudo, which is fine: ours are the user's.
 */
async function readListenersPosix(): Promise<Listener[]> {
  const out = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]);
  const seen = new Set<string>();
  const listeners: Listener[] = [];
  let pid = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1)) || 0;
      continue;
    }
    if (!line.startsWith("n") || !pid) continue;
    const local = line.slice(1);
    const i = local.lastIndexOf(":");
    const port = Number(local.slice(i + 1));
    if (i < 0 || !Number.isFinite(port)) continue;
    const raw = local.slice(0, i);
    const address = raw === "*" ? "0.0.0.0" : raw;
    const key = `${pid}:${port}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ port, address, pid });
  }
  return listeners;
}

async function readProcessesPosix(pids: number[]): Promise<Map<number, ProcInfo>> {
  const map = new Map<number, ProcInfo>();
  try {
    const out = await run("ps", ["-o", "pid=,ppid=,args=", "-p", pids.join(",")]);
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const command = m[3];
      const exe = command.split(/\s+/)[0] ?? "";
      map.set(Number(m[1]), {
        pid: Number(m[1]),
        parentPid: Number(m[2]),
        name: path.basename(exe),
        command,
      });
    }
  } catch {
    /* no command lines: rows still render, just less well attributed */
  }
  return map;
}

async function readProcesses(pids: number[]): Promise<Map<number, ProcInfo>> {
  const map = new Map<number, ProcInfo>();
  const unique = [...new Set(pids)].filter((p) => p > 4);
  if (unique.length === 0) return map;
  if (process.platform !== "win32") return readProcessesPosix(unique);
  // Filtering by pid keeps this ~0.5s; the full process table takes ~2s.
  const filter = unique.map((p) => `ProcessId=${p}`).join(" OR ");
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    `Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
  try {
    const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!out.trim()) return map;
    const parsed = JSON.parse(out) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const p of list as Record<string, unknown>[]) {
      const pid = Number(p.ProcessId);
      if (!Number.isFinite(pid)) continue;
      map.set(pid, {
        pid,
        parentPid: Number.isFinite(Number(p.ParentProcessId)) ? Number(p.ParentProcessId) : null,
        name: String(p.Name ?? ""),
        command: typeof p.CommandLine === "string" ? p.CommandLine : "",
      });
    }
  } catch {
    /* no command lines: rows still render, just less well attributed */
  }
  return map;
}

async function readPm2(): Promise<{ apps: Pm2App[]; error: string | null }> {
  try {
    const out = await run("pm2", ["jlist"]);
    // pm2 can print a banner line before the JSON on first run.
    const start = out.indexOf("[");
    const parsed = JSON.parse(start >= 0 ? out.slice(start) : out) as Record<string, unknown>[];
    const apps = parsed.map((a) => {
      const env = (a.pm2_env ?? {}) as Record<string, unknown>;
      const monit = (a.monit ?? {}) as Record<string, unknown>;
      const rawArgs = env.args;
      const args = Array.isArray(rawArgs)
        ? rawArgs.map(String)
        : typeof rawArgs === "string"
        ? rawArgs.split(/\s+/)
        : [];
      const uptime = Number(env.pm_uptime);
      const memory = Number(monit.memory);
      return {
        name: String(a.name ?? "?"),
        pid: Number(a.pid) || 0,
        status: String(env.status ?? "unknown"),
        cwd: typeof env.pm_cwd === "string" ? env.pm_cwd : null,
        args,
        uptimeSince:
          env.status === "online" && Number.isFinite(uptime) && uptime > 0
            ? new Date(uptime).toISOString()
            : null,
        restarts: Number.isFinite(Number(env.restart_time)) ? Number(env.restart_time) : null,
        memoryMb: Number.isFinite(memory) && memory > 0 ? Math.round(memory / 1048576) : null,
      } satisfies Pm2App;
    });
    return { apps, error: null };
  } catch (err) {
    return { apps: [], error: (err as Error).message.split("\n")[0] };
  }
}

/** `--port 3910`, `--port=3910`, `-p 3910`, `PORT=3910`. */
const PORT_PATTERN = /(?:--port[= ]|(?:^|\s)-p[= ]|PORT=)(\d{2,5})\b/g;

function portsInText(text: string): number[] {
  const ports: number[] = [];
  for (const m of text.matchAll(PORT_PATTERN)) {
    const n = Number(m[1]);
    if (n > 0 && n < 65536) ports.push(n);
  }
  return ports;
}

async function readPackageScripts(file: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await fsp.readFile(file, "utf8")) as { scripts?: unknown };
    if (!pkg.scripts || typeof pkg.scripts !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let declaredCache: { list: DeclaredPort[]; at: number } | null = null;

/** Ports each project pins in its package.json scripts (root and one folder down). */
async function readDeclaredPorts(projects: string[]): Promise<DeclaredPort[]> {
  if (declaredCache && Date.now() - declaredCache.at < 60_000) return declaredCache.list;
  const root = getProjectsRoot();
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const base = path.join(root, project);
      const dirs = [""];
      try {
        for (const e of await fsp.readdir(base, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
            dirs.push(e.name);
          }
        }
      } catch {
        return [];
      }
      const found: DeclaredPort[] = [];
      for (const dir of dirs) {
        const scripts = await readPackageScripts(path.join(base, dir, "package.json"));
        for (const [name, cmd] of Object.entries(scripts)) {
          for (const port of portsInText(cmd)) {
            const rel = dir ? `${dir}/package.json` : "package.json";
            if (!found.some((f) => f.port === port)) {
              found.push({ project, port, source: `${rel} · ${name}` });
            }
          }
        }
      }
      return found;
    })
  );
  const list = perProject.flat();
  declaredCache = { list, at: Date.now() };
  return list;
}

/** "C:\Code\BakerySite\node_modules\..." -> "BakerySite", matched case-insensitively. */
function projectFromCommand(command: string, root: string, known: Set<string>): string | null {
  const norm = command.replace(/\//g, "\\").toLowerCase();
  const prefix = path.resolve(root).replace(/\//g, "\\").toLowerCase() + "\\";
  const at = norm.indexOf(prefix);
  if (at < 0) return null;
  const rest = command.replace(/\//g, "\\").slice(at + prefix.length);
  const folder = rest.split(/[\\"\s]/)[0];
  if (!folder) return null;
  for (const k of known) if (k.toLowerCase() === folder.toLowerCase()) return k;
  return folder;
}

/**
 * `node scripts/serve.mjs` carries no folder, because it was started from
 * inside the project. Windows won't tell us a process's working folder, so
 * look for the one project that has that script file.
 */
async function projectFromRelativeScript(
  command: string,
  projects: string[],
  ports: number[]
): Promise<string | null> {
  const m = command.match(/^"?node(?:\.exe)?"?\s+"?([^"\s]+\.(?:mjs|cjs|js|ts))"?/i);
  if (!m || /^[a-z]:|^[\\/]/i.test(m[1])) return null;
  const rel = m[1];
  const root = getProjectsRoot();
  const hits = await Promise.all(
    projects.map(async (p) => {
      try {
        await fsp.access(path.join(root, p, rel));
        return p;
      } catch {
        return null;
      }
    })
  );
  let found = hits.filter((h): h is string => h !== null);
  if (found.length > 1 && ports.length > 0) {
    // Several projects have a script by that name: keep the ones whose
    // script mentions the port it is listening on.
    const mentions = await Promise.all(
      found.map(async (p) => {
        try {
          const text = await fsp.readFile(path.join(root, p, rel), "utf8");
          return ports.some((n) => new RegExp(`\\b${n}\\b`).test(text)) ? p : null;
        } catch {
          return null;
        }
      })
    );
    const narrowed = mentions.filter((h): h is string => h !== null);
    if (narrowed.length > 0) found = narrowed;
  }
  if (found.length === 1) return found[0];
  // Still a tie between a project and its versioned copies (BakerySite,
  // BakerySite-1.3): the original folder is the best guess.
  const [shortest] = [...found].sort((x, y) => x.length - y.length);
  return shortest && found.every((p) => p.startsWith(shortest)) ? shortest : null;
}

function labelFor(proc: ProcInfo | undefined): string {
  if (!proc) return "Unknown process";
  const c = proc.command.toLowerCase();
  if (c.includes("cloud-firestore-emulator")) return "Firestore emulator";
  if (c.includes("firebase") && c.includes("emulators")) return "Firebase emulators";
  if (c.includes("vite")) return "Vite dev server";
  if (c.includes("next") && /\bdev\b/.test(c)) return "Next.js dev server";
  if (c.includes("next") && /\bstart\b/.test(c)) return "Next.js server";
  if (c.includes("astro")) return "Astro dev server";
  if (c.includes("wrangler")) return "Wrangler dev server";
  // A plain `node scripts/foo.mjs`: name it after the script.
  const script = proc.command.match(/([\w.-]+\.(?:mjs|cjs|js|ts|py))\b/);
  if (script) return script[1];
  return proc.name || "Unknown process";
}

/**
 * One entry per port number. A server bound to both 0.0.0.0 and [::] is one
 * door, not two; keep the address that is reachable from the most places.
 */
function collapsePorts(ports: ServerPort[]): ServerPort[] {
  const reach = (a: string) => (a === "0.0.0.0" || a === "[::]" ? 0 : 1);
  const best = new Map<number, ServerPort>();
  for (const p of ports) {
    const cur = best.get(p.port);
    if (!cur || reach(p.address) < reach(cur.address)) best.set(p.port, p);
  }
  return [...best.values()].sort((a, b) => a.port - b.port);
}

function expectedPortFromArgs(args: string[]): number | null {
  const ports = portsInText(args.join(" "));
  return ports[0] ?? null;
}

let snapshotCache: { snap: ServersSnapshot; at: number } | null = null;
let inflight: Promise<ServersSnapshot> | null = null;

export async function getServersSnapshot(): Promise<ServersSnapshot> {
  if (snapshotCache && Date.now() - snapshotCache.at < 8_000) return snapshotCache.snap;
  // The page and the sidebar badge can ask at the same moment; do the work once.
  if (inflight) return inflight;
  inflight = buildSnapshot().finally(() => {
    inflight = null;
  });
  const snap = await inflight;
  snapshotCache = { snap, at: Date.now() };
  return snap;
}

async function buildSnapshot(): Promise<ServersSnapshot> {
  const root = getProjectsRoot();
  const projectList = (await discoverProjects()).map((p) => p.slug);
  if (!projectList.includes("aiTeam")) projectList.unshift("aiTeam");
  const known = new Set(projectList);

  const [listeners, pm2, declared] = await Promise.all([
    readListeners().catch(() => [] as Listener[]),
    readPm2(),
    readDeclaredPorts(projectList),
  ]);
  const procs = await readProcesses([
    ...listeners.map((l) => l.pid),
    ...pm2.apps.map((a) => a.pid),
  ]);

  const rows: ServerRow[] = [];
  const claimedPids = new Set<number>();

  // ---- Always-on: pm2 apps ----
  for (const app of pm2.apps) {
    const owns = (l: Listener) =>
      app.pid > 0 && (l.pid === app.pid || procs.get(l.pid)?.parentPid === app.pid);
    const ports = listeners.filter(owns);
    ports.forEach((l) => claimedPids.add(l.pid));
    const expectedPort = expectedPortFromArgs(app.args);
    const online = app.status === "online";
    let status: ServerStatus = online ? "up" : "down";
    let note: string | null = online ? null : `pm2 reports it as "${app.status}".`;
    if (online && expectedPort && !ports.some((p) => p.port === expectedPort)) {
      status = "down";
      const squatter = listeners.find((l) => l.port === expectedPort);
      note = squatter
        ? `Running, but port ${expectedPort} is held by another program (${labelFor(procs.get(squatter.pid))}, process ${squatter.pid}).`
        : `Running, but nothing is answering on port ${expectedPort}.`;
    }
    rows.push({
      key: `pm2:${app.name}`,
      name: app.name,
      project: app.cwd ? projectFromCommand(app.cwd + "\\", root, known) : null,
      kind: "always-on",
      status,
      ports: ports.map(({ port, address }) => ({ port, address })),
      expectedPort,
      pid: app.pid || null,
      command: procs.get(app.pid)?.command || null,
      note,
      uptimeSince: app.uptimeSince,
      restarts: app.restarts,
      memoryMb: app.memoryMb,
      sharedWith: [],
    });
  }

  // ---- Dev servers that are running right now ----
  const byPid = new Map<number, Listener[]>();
  for (const l of listeners) {
    if (claimedPids.has(l.pid)) continue;
    const list = byPid.get(l.pid) ?? [];
    list.push(l);
    byPid.set(l.pid, list);
  }
  const running: ServerRow[] = [];
  for (const [pid, ls] of byPid) {
    const proc = procs.get(pid);
    let project = proc ? projectFromCommand(proc.command, root, known) : null;
    if (!project && proc) project = await projectFromRelativeScript(
        proc.command,
        projectList,
        ls.map((l) => l.port)
      );
    if (!project) {
      const claimants = new Set(
        declared.filter((d) => ls.some((l) => l.port === d.port)).map((d) => d.project)
      );
      if (claimants.size === 1) project = [...claimants][0];
    }
    // Installed apps bundle their own node.exe (Adobe Creative Cloud does);
    // those are not ours even though the runtime is.
    const installedApp = !!proc && /\\program files( \(x86\))?\\/i.test(proc.command);
    const ours =
      project !== null || (!!proc && !installedApp && DEV_IMAGES.has(proc.name.toLowerCase()));
    if (!ours) continue;
    const ports = ls
      .map(({ port, address }) => ({ port, address }))
      .sort((a, b) => a.port - b.port);
    running.push({
      key: `pid:${pid}`,
      name: labelFor(proc),
      project,
      kind: "dev",
      status: "up",
      ports,
      expectedPort: null,
      pid,
      command: proc?.command || null,
      note: project ? null : "Couldn't tell which project started this.",
      uptimeSince: null,
      restarts: null,
      memoryMb: null,
      sharedWith: [],
    });
  }

  // A helper a tool starts for itself (the Firestore emulator under the
  // Firebase CLI) belongs on its parent's row, not a row of its own.
  for (const child of [...running]) {
    const parentPid = child.pid !== null ? procs.get(child.pid)?.parentPid : null;
    const parent = parentPid ? running.find((r) => r.pid === parentPid) : undefined;
    if (!parent) continue;
    parent.ports.push(...child.ports);
    parent.ports.sort((a, b) => a.port - b.port);
    parent.project ??= child.project;
    if (parent.project) parent.note = null;
    running.splice(running.indexOf(child), 1);
  }

  // ---- Declared dev ports that aren't running ----
  const stopped: ServerRow[] = [];
  for (const d of declared) {
    const sharedWith = declared
      .filter((o) => o.port === d.port && o.project !== d.project)
      .map((o) => o.project);
    const mine = running.find(
      (r) => r.project === d.project && r.ports.some((p) => p.port === d.port)
    );
    if (mine) {
      mine.expectedPort = d.port;
      mine.sharedWith = sharedWith;
      continue;
    }
    const holder = listeners.find((l) => l.port === d.port);
    const holderRow = holder
      ? [...rows, ...running].find((r) => r.pid === holder.pid)
      : undefined;
    // aiTeam's dev script names 3900 because that's where the live dashboard
    // runs. The always-on row already covers it; listing it as "taken" is noise.
    if (holderRow && holderRow.project === d.project) continue;
    let note: string | null = null;
    if (holder) {
      const row = holderRow;
      const who = row?.project ?? labelFor(procs.get(holder.pid));
      note = `Port ${d.port} is taken by ${who}, so this one couldn't start right now.`;
    }
    stopped.push({
      key: `declared:${d.project}:${d.port}`,
      name: d.source,
      project: d.project,
      kind: "dev",
      status: holder ? "conflict" : "stopped",
      ports: [],
      expectedPort: d.port,
      pid: null,
      command: null,
      note,
      uptimeSince: null,
      restarts: null,
      memoryMb: null,
      sharedWith,
    });
  }

  rows.push(...running, ...stopped);
  for (const r of rows) r.ports = collapsePorts(r.ports);
  return {
    rows,
    downCount: rows.filter((r) => r.kind === "always-on" && r.status === "down").length,
    checkedAt: new Date().toISOString(),
    pm2Error: pm2.error,
  };
}
