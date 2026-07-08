/*
 * Shared skill types + labels, importable from BOTH server code and client
 * components. Keep this module free of node imports — lib/skills.ts (the
 * filesystem scanner) must not be pulled into a browser bundle.
 */

export type SkillOrigin = "team" | "installed" | "official" | "plugin" | "project";

export const ORIGIN_LABELS: Record<SkillOrigin, string> = {
  team: "Team-built",
  installed: "Installed",
  official: "Claude official",
  plugin: "Plugin",
  project: "Project",
};

export interface SkillInfo {
  /** Directory name; for plugin skills prefixed as "plugin:slug". */
  slug: string;
  name: string;
  description: string;
  body: string;
  /** Absolute path to the SKILL.md file on disk. */
  path: string;
  origin: SkillOrigin;
  /** Plugin name for plugin-provided skills (e.g. "superpowers"). */
  plugin?: string;
}
