import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { buildVonBraunSystemPrompt } from "./claude-persona";
import { getConfig } from "./config";
import { listExistingDecisions, promoteDecisions } from "./decision-promote";

const SUMMARY_TOKEN_CAP = 4000;

/**
 * Transcripts can exceed the distill model's context window (legacy sessions
 * have reached millions of estimated tokens). Keep the TAIL: the primer
 * describes the state of things AFTER the session, so the most recent turns
 * carry nearly all of the signal. ~400k chars ~= 100k tokens, comfortably
 * inside the window with the persona and brief on top.
 */
const TRANSCRIPT_CHAR_CAP = 400_000;

export function capTranscript(md: string): string {
  if (md.length <= TRANSCRIPT_CHAR_CAP) return md;
  return (
    "(NOTE: this session was very long; the earlier part of the transcript has been " +
    "truncated. What follows is the most recent portion.)\n\n" +
    md.slice(-TRANSCRIPT_CHAR_CAP)
  );
}

function safeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function summaryPath(scope: string): string {
  return path.join(
    getConfig().vaultDir,
    "agents",
    "claude",
    "summaries",
    `${safeScope(scope)}.md`
  );
}

const DECISIONS_MARKER = "===DECISIONS===";

function buildDistillationBrief(
  scope: string,
  transcriptMd: string,
  existingDecisions: { title: string; project: string | null; topic: string | null }[]
): string {
  const existingList =
    existingDecisions.length > 0
      ? existingDecisions
          .slice(0, 100)
          .map((d) => `- ${d.title} (project: ${d.project ?? "?"}, topic: ${d.topic ?? "?"})`)
          .join("\n")
      : "- (none recorded yet)";

  return `Below is the transcript of your just-ended session in scope "${scope}".

You are Claude Von Braun, compressing this session for your next self. Write a primer that next-you (a fresh session in this same scope) needs to walk in already oriented. You are writing TO next-CVB. This is not a generic summary; it is a hand-off to yourself.

Format: markdown, with these section headers exactly (skip any that have no content):

## Decided
What was decided this session, with status. One bullet per decision; include who participated and active vs superseded markers when relevant. Link to the decision file in the vault if one was written.

## In flight
Work currently assigned to teammates, dispatches that have not returned yet, threads in motion. One bullet per item; name the owner.

## Blocked
What is blocked, on whom or what, what would unblock it. Be specific about the next required move.

## Context
Key context next-you needs that is not already in the persona files, project context docs, or vault decisions. The stuff that exists only because of this session's conversation.

## Open threads
Questions left unanswered, options surfaced but not chosen, things flagged for next time. One bullet per item.

Hard rules:
- ${SUMMARY_TOKEN_CAP} tokens TOTAL for the primer. Be ruthless.
- No filler, no AI cliches, no em-dashes (you know the team rules).
- Do not restate persona basics. Next-you has them loaded.
- Do not recap the whole session play-by-play. Write the state-of-the-team-AFTER this session.
- Skip empty sections rather than padding them.
- ASCII only. No fancy typography.

AFTER the primer, on its own line, output exactly:
${DECISIONS_MARKER}
followed by a JSON array recording decisions that were NEWLY made or explicitly changed in THIS session - the bar is: a teammate would need to know this in a month. Each element:
{"title": "<short specific title>", "project": "<project slug, or team, or cross-cutting>", "topic": "<short-slug>", "severity": "low|medium|high", "status": "active", "agents": ["<who participated>"], "body": "<2-5 sentences: what was decided, why, and what it replaces if anything>"}
Output [] if this session made no decisions worth recording. Do NOT re-emit decisions already on record:
${existingList}
ASCII only. Nothing after the JSON array.

Read the transcript below and produce: the primer, then the ${DECISIONS_MARKER} line, then the JSON array. No preamble, no closing remarks.

---

${capTranscript(transcriptMd)}
`;
}

export interface RunClaudeJsonOptions {
  /** Full system-prompt layer to append (written to a temp file). */
  persona: string;
  /** The user-turn brief, piped via stdin. */
  brief: string;
  cwd: string;
  /** Temp-file prefix so parallel distills don't collide. */
  tempPrefix: string;
}

/**
 * Run one non-interactive `claude -p` Sonnet call and return the result text.
 *
 * The persona runs tens of KB. Passing it inline via --append-system-prompt
 * overflows Windows' 32767-char CreateProcess command-line limit, making spawn
 * fail with ENAMETOOLONG. So: persona goes in a temp file passed via
 * --append-system-prompt-file, the brief goes on stdin, and the command line
 * itself stays small. shell:false avoids cmd.exe quoting/arg limits.
 */
export async function runClaudeJson(
  opts: RunClaudeJsonOptions
): Promise<string | null> {
  const personaFile = path.join(
    os.tmpdir(),
    `${opts.tempPrefix}-${process.pid}-${Date.now()}.md`
  );
  await fsp.writeFile(personaFile, opts.persona, "utf8");

  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt-file",
    personaFile,
  ];

  let stdout = "";
  let stderr = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(getConfig().claudeBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        cwd: opts.cwd,
      });
      child.stdout.on("data", (c) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c) => {
        stderr += c.toString("utf8");
      });
      child.stdin.write(opts.brief);
      child.stdin.end();
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500) || "(no stderr)"}`));
      });
      child.on("error", reject);
    });
  } catch (err) {
    console.error(`[distill] claude call failed (${opts.tempPrefix}):`, err);
    return null;
  } finally {
    await fsp.rm(personaFile, { force: true }).catch(() => {});
  }

  // `--output-format json` returns a result object with a `result` field
  // containing the assistant's final text. Tolerate variations defensively.
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const candidates = [
      parsed.result,
      (parsed.message as Record<string, unknown> | undefined)?.content,
      parsed.text,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) return c.trim();
    }
    return null;
  } catch {
    return stdout.trim() || null;
  }
}

/** Append a one-line marker to an agent's distill log (best-effort). */
export async function logDistillLine(agent: string, line: string): Promise<void> {
  try {
    const logDir = path.join(getConfig().agentsDir, agent, "logs");
    await fsp.mkdir(logDir, { recursive: true });
    await fsp.appendFile(
      path.join(logDir, "distill.log"),
      `[${new Date().toISOString()}] ${line}\n`,
      "utf8"
    );
  } catch {
    /* logging is best-effort */
  }
}

interface DistillOptions {
  transcriptMd: string;
  scope: string;
  cwd: string;
  /** Vault-relative path of the archived transcript, for decision provenance. */
  transcriptPath?: string | null;
}

async function runDistillation(opts: DistillOptions): Promise<void> {
  const persona = await buildVonBraunSystemPrompt(opts.cwd, { skipRollingSummary: true });
  if (!persona) {
    console.error("[distill] no persona available; skipping");
    return;
  }

  const existingDecisions = await listExistingDecisions().catch(() => []);
  const brief = buildDistillationBrief(opts.scope, opts.transcriptMd, existingDecisions);
  const output = await runClaudeJson({
    persona,
    brief,
    cwd: opts.cwd,
    tempPrefix: `cvb-distill-persona-${safeScope(opts.scope)}`,
  });
  if (!output) {
    console.error(`[distill] empty result for scope ${opts.scope}; skipping write`);
    return;
  }

  // Split primer from the decisions payload. A missing marker means an older
  // prompt shape or a model that skipped it - treat everything as the primer.
  const markerAt = output.indexOf(DECISIONS_MARKER);
  const summaryText = (markerAt === -1 ? output : output.slice(0, markerAt)).trim();
  const decisionsRaw = markerAt === -1 ? null : output.slice(markerAt + DECISIONS_MARKER.length);

  if (!summaryText) {
    console.error(`[distill] empty primer for scope ${opts.scope}; skipping write`);
    return;
  }

  const now = new Date().toISOString();
  const safeScopeName = safeScope(opts.scope);
  const frontmatter = [
    "---",
    `title: Rolling primer for next session in ${opts.scope}`,
    "type: rolling-summary",
    `scope: ${opts.scope}`,
    `created: ${now}`,
    `updated: ${now}`,
    "distilled_by: claude-von-braun",
    "distill_model: claude-sonnet-4-6",
    `token_cap: ${SUMMARY_TOKEN_CAP}`,
    "---",
    "",
    `# Rolling primer for next session in ${opts.scope}`,
    "",
    `> Distilled by CVB from the most recent ended session. Loaded into the next session's system prompt automatically.`,
    "",
  ].join("\n");

  const outPath = summaryPath(opts.scope);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, `${frontmatter}\n${summaryText}\n`, "utf8");
  await logDistillLine(
    "claude",
    `distilled scope=${safeScopeName} bytes=${summaryText.length} -> ${outPath}`
  );

  // Decision auto-promotion. Isolated: a failure here never affects the primer.
  if (decisionsRaw && decisionsRaw.trim()) {
    try {
      const res = await promoteDecisions(decisionsRaw, {
        scope: opts.scope,
        transcriptPath: opts.transcriptPath ?? null,
      });
      if (res.written.length || res.skipped.length) {
        await logDistillLine(
          "claude",
          `decisions scope=${safeScopeName} written=[${res.written.join(", ")}] skipped=[${res.skipped.join("; ")}]`
        );
      }
    } catch (err) {
      console.error(`[distill] decision promotion failed for scope ${opts.scope}:`, err);
    }
  }
}

/**
 * Public: kick off the distillation in the background. Returns immediately;
 * the actual claude call and write happen on the event loop after the response
 * has been sent. Errors are logged, not thrown.
 */
export function distillSessionAsync(opts: DistillOptions): void {
  // The void here is intentional: fire-and-forget. The end-session route returns
  // before this resolves so the user doesn't wait on Sonnet's roundtrip.
  void runDistillation(opts).catch((err) => {
    console.error(`[distill] background run threw for scope ${opts.scope}:`, err);
  });
}
