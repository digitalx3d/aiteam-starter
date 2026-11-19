import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { writeFileSync, unlink } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "./config";

export interface SpawnOptions {
  cwd: string;
  sessionId: string;
  /** When true the session already exists and we resume. When false we create with --session-id. */
  resume: boolean;
  message: string;
  /** Model alias or full ID. Default: haiku. */
  model?: string;
  /** Permission mode. Default: acceptEdits. */
  permissionMode?: "acceptEdits" | "bypassPermissions";
  /** Tool names to auto-approve for this turn (in addition to acceptEdits defaults). e.g. ["Bash"]. */
  allowedTools?: string[];
  /** Tool names to hard-block for this turn (passed to --disallowedTools). e.g. ["Task"]. */
  disallowedTools?: string[];
  /** Appended to Claude's default system prompt via --append-system-prompt. Set on session
   *  creation to bake in the Claude Von Braun persona; omit on resume to avoid context bloat. */
  appendSystemPrompt?: string;
  /** Reasoning effort (low|medium|high|xhigh|max). A real CLI knob on Opus/Sonnet;
   *  silently skipped for models that don't support it (e.g. haiku). */
  effort?: string;
  /** Extra Claude Code settings for THIS session only, written to a temp file and
   *  passed via --settings (layered on top of user/project settings, not replacing).
   *  Used to wire CVB's guard + clock hooks into dashboard chat spawns without
   *  affecting workers or terminal Claudes. */
  settings?: Record<string, unknown>;
}

export interface SpawnResult {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  exitPromise: Promise<{ code: number | null; stderr: string }>;
}

const DEFAULT_PERMISSION_MODE = "acceptEdits";

function getCommonFlags(permissionMode: string = DEFAULT_PERMISSION_MODE): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];
}

/**
 * The effort that will actually be applied for a given model. Effort is
 * unsupported on haiku, so it's dropped there. Exported so callers can record
 * what a spawn really ran with instead of what they asked for.
 */
export function effectiveEffort(
  model: string | null | undefined,
  effort: string | null | undefined
): string | null {
  if (!effort) return null;
  return /haiku/i.test(model ?? "") ? null : effort;
}

export function spawnClaude(opts: SpawnOptions): SpawnResult {
  const sessionFlag = opts.resume
    ? ["--resume", opts.sessionId]
    : ["--session-id", opts.sessionId];
  const modelFlag = opts.model ? ["--model", opts.model] : [];
  const effort = effectiveEffort(opts.model, opts.effort);
  const effortFlag = effort ? ["--effort", effort] : [];
  const allowedFlag =
    opts.allowedTools && opts.allowedTools.length > 0
      ? ["--allowedTools", opts.allowedTools.join(",")]
      : [];
  const disallowedFlag =
    opts.disallowedTools && opts.disallowedTools.length > 0
      ? ["--disallowedTools", opts.disallowedTools.join(",")]
      : [];
  // The persona can exceed Windows' ~32KB CreateProcess command-line limit, so
  // we write it to a temp file and pass --append-system-prompt-file (the path
  // is short, the content lives in the file). File is cleaned up after exit.
  let systemPromptFile: string | null = null;
  if (opts.appendSystemPrompt && opts.appendSystemPrompt.length > 0) {
    systemPromptFile = path.join(
      tmpdir(),
      `cvb-persona-${randomUUID()}.md`
    );
    writeFileSync(systemPromptFile, opts.appendSystemPrompt, "utf8");
  }
  const systemPromptFlag = systemPromptFile
    ? ["--append-system-prompt-file", systemPromptFile]
    : [];
  // Per-session settings (e.g. CVB's guard + clock hooks). Written to a temp file
  // and passed via --settings; layered on top of user/project settings, cleaned up
  // on exit like the persona file.
  let settingsFile: string | null = null;
  if (opts.settings) {
    settingsFile = path.join(tmpdir(), `cvb-settings-${randomUUID()}.json`);
    writeFileSync(settingsFile, JSON.stringify(opts.settings), "utf8");
  }
  const settingsFlag = settingsFile ? ["--settings", settingsFile] : [];
  const commonFlags = getCommonFlags(opts.permissionMode);
  const args = [
    ...commonFlags,
    ...modelFlag,
    ...effortFlag,
    ...allowedFlag,
    ...disallowedFlag,
    ...systemPromptFlag,
    ...settingsFlag,
    ...sessionFlag,
  ];

  // shell:false intentional. On Windows, shell:true routes through cmd.exe which
  // caps the command line at ~8KB. We pass the persona via --append-system-prompt-file
  // (path-based) to dodge Windows' ~32KB CreateProcess limit entirely.
  // claude resolves as a .exe in PATH on Windows; this works cross-platform.
  const child = spawn(getConfig().claudeBin, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  // Swallow EPIPE on stdin when the process never started (spawn failed).
  child.stdin.on("error", () => {});

  const exitPromise = new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      let settled = false;
      const finish = (code: number | null, errMsg?: string) => {
        if (settled) return;
        settled = true;
        if (systemPromptFile) {
          unlink(systemPromptFile, () => {
            /* best-effort cleanup */
          });
        }
        if (settingsFile) {
          unlink(settingsFile, () => {
            /* best-effort cleanup */
          });
        }
        const merged = errMsg
          ? `${errMsg}${stderr ? "\n" + stderr : ""}`
          : stderr;
        resolve({ code, stderr: merged });
      };
      // A failed spawn (e.g. a cwd that doesn't exist → ENOENT) emits 'error'
      // and NEVER 'close'. Without this the caller hangs forever awaiting exit
      // and the dispatch ticket stays stuck on "running". Surface it as a
      // failure (code -1) so the ticket is marked failed with the reason.
      child.on("error", (err) => finish(-1, `spawn error: ${err.message}`));
      child.on("close", (code) => finish(code));
    }
  );

  try {
    child.stdin.write(opts.message);
    child.stdin.end();
  } catch {
    /* process never started; the 'error' handler resolves exitPromise */
  }

  return { child, exitPromise };
}
