import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig } from "./config";
import { readOperatingRules, operatingRulesSection } from "./team-rules";

function cvbDir(): string {
  return path.join(getConfig().agentsDir, "claude");
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function safeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function rollingSummaryPath(scope: string): string {
  return path.join(
    getConfig().vaultDir,
    "agents",
    "claude",
    "summaries",
    `${safeScope(scope)}.md`
  );
}

export interface PersonaBuildOptions {
  /** When true, do not include the rolling summary. Used by the distillation
   *  call so the distilling Claude does not see its own past primer. */
  skipRollingSummary?: boolean;
  /** Chat scope identifier ("default" or "project:<slug>"). Required to look up
   *  the matching rolling summary; if omitted, no summary is included. */
  scope?: string;
}

/**
 * Build the Claude Von Braun system prompt for a chat session.
 *
 * Layers (in order, concatenated with section separators):
 *   1. Identity + voice + hard rules (soul.md)
 *   2. Current scope and approval gates (agents.md)
 *   3. Tools and dispatch surface (tools.md)
 *   4. (Optional) Project-specific override at <cwd>/.aiteam/agents/claude.md
 *   5. (Optional) Rolling primer from the previous session in this scope at
 *      vault/agents/claude/summaries/<scope>.md
 *
 * Heartbeat.md is intentionally not included; it is procedural and CVB can
 * read it on demand when starting a working block.
 *
 * Returns null if no persona files were found (caller should skip the flag).
 */
export async function buildVonBraunSystemPrompt(
  cwd: string,
  opts: PersonaBuildOptions = {}
): Promise<string | null> {
  const dir = cvbDir();
  const [soul, agents, tools] = await Promise.all([
    readMaybe(path.join(dir, "soul.md")),
    readMaybe(path.join(dir, "agents.md")),
    readMaybe(path.join(dir, "tools.md")),
  ]);

  if (!soul && !agents && !tools) return null;

  const projectOverride = await readMaybe(
    path.join(cwd, ".aiteam", "agents", "claude.md")
  );

  const rollingSummary =
    opts.scope && !opts.skipRollingSummary
      ? await readMaybe(rollingSummaryPath(opts.scope))
      : null;

  const operatingRules = await readOperatingRules();

  // Tell CVB exactly which chat he is in, so he never mistakes a project chat for
  // the main one. This is the fix for CVB claiming a project dispatch reports "to the
  // dashboard": his persona used to hardcode "you are the Dashboard session".
  const scope = opts.scope ?? "default";
  const inProject = scope.startsWith("project:");
  const scopeName = inProject ? scope.slice("project:".length) : null;
  const whereLine = inProject
    ? `You are running in **the ${scopeName} project chat** — cwd is the ${scopeName} project folder. Keep this conversation about ${scopeName}. When you dispatch a teammate for ${scopeName} work (with \`--project ${scopeName}\`), their report and your follow-up appear HERE, in this project chat, NOT in The Bridge.`
    : `You are running in **The Bridge** — the main, cross-project chat (cwd is the aiTeam app folder). This is for team-level and cross-project work. Anything specific to one project belongs in that project's own chat, and a project dispatch's report lands in that project's chat, not here.`;

  const sections: string[] = [];
  sections.push(`# Where you are right now\n\n${whereLine}`);
  if (soul) sections.push("---\n\n" + soul.trim());
  if (agents) sections.push("---\n\n" + agents.trim());
  if (tools) sections.push("---\n\n" + tools.trim());
  // Canonical team operating rules, injected from the single vault source so they
  // are always present and cannot drift across persona copies.
  if (operatingRules) {
    sections.push("---\n\n" + operatingRulesSection(operatingRules));
  }
  if (projectOverride) {
    sections.push(
      "---\n\n# Project-specific overrides for this chat\n\n" +
        projectOverride.trim()
    );
  }
  if (rollingSummary) {
    sections.push(
      "---\n\n# Rolling primer from your previous session in this scope\n\n" +
        "The following primer was distilled by you (CVB) from your last ended session in this same chat scope. " +
        "It is here so you walk in already oriented to what is in flight, decided, blocked, and open. " +
        "Treat it as fresh context from your immediate past self.\n\n" +
        rollingSummary.trim()
    );
  }

  return sections.join("\n\n");
}
