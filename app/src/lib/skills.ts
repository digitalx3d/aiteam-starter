import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "./config";

/*
 * Skill discovery across every location Claude Code loads skills from:
 *
 *   1. <skillsDir>/<slug>/SKILL.md            (~/.claude/skills — user level)
 *      - real directories   -> "team"      (authored here)
 *      - junctions/symlinks -> "installed" (npx skills installs into
 *        ~/.agents/skills and links them here)
 *   2. ~/.agents/skills/<slug>/SKILL.md       -> "installed" (cross-tool
 *      Agent Skills standard location; deduped against #1 by real path)
 *   3. ~/.claude/plugins/installed_plugins.json -> each plugin's
 *      <installPath>/skills/<slug>/SKILL.md
 *      - marketplace "claude-plugins-official" -> "official"
 *      - anything else                         -> "plugin"
 *   4. <aiteamDir>/.claude/skills/<slug>/SKILL.md -> "project"
 *
 * Everything is deduped by resolved real path, first source wins in the order
 * above (so a linked install shows once, classified by where it really lives).
 */

// Types + labels live in skill-types.ts (node-free) so client components can
// import them without dragging node:fs into the browser bundle.
import type { SkillInfo, SkillOrigin } from "./skill-types";
export type { SkillInfo, SkillOrigin } from "./skill-types";

interface ParsedMarkdown {
  meta: Record<string, string>;
  body: string;
}

function parseFrontmatter(text: string): ParsedMarkdown {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    meta[m[1]] = val;
  }
  return { meta, body: match[2] };
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

async function readSkillDir(
  dir: string,
  slug: string,
  origin: SkillOrigin,
  plugin?: string
): Promise<SkillInfo | null> {
  const skillPath = path.join(dir, "SKILL.md");
  try {
    const text = await fsp.readFile(skillPath, "utf8");
    const { meta, body } = parseFrontmatter(text);
    return {
      slug: plugin ? `${plugin}:${slug}` : slug,
      name: meta.name || slug,
      description: meta.description || "",
      body: body.trim(),
      path: skillPath,
      origin,
      plugin,
    };
  } catch {
    return null; // no SKILL.md (or unreadable) — not a skill dir
  }
}

/** List immediate subdirectories (including junctions/symlinks, which is how
 *  `npx skills` installs appear on Windows). */
async function listSkillEntries(
  root: string
): Promise<Array<{ name: string; isLink: boolean }>> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, isLink: e.isSymbolicLink() }));
  } catch {
    return [];
  }
}

interface InstalledPluginsFile {
  plugins?: Record<string, Array<{ installPath?: string }>>;
}

export async function discoverAllSkills(): Promise<SkillInfo[]> {
  const cfg = getConfig();
  const home = os.homedir();
  const agentsStandardDir = path.join(home, ".agents", "skills");
  const pluginsFile = path.join(home, ".claude", "plugins", "installed_plugins.json");

  const seen = new Set<string>(); // resolved real paths of SKILL.md files
  const skills: SkillInfo[] = [];

  async function add(skill: SkillInfo | null): Promise<void> {
    if (!skill) return;
    let key: string;
    try {
      key = norm(await fsp.realpath(skill.path));
    } catch {
      key = norm(skill.path);
    }
    if (seen.has(key)) return;
    seen.add(key);
    skills.push(skill);
  }

  // 1. User-level skills dir. Junctions point at installed skills; real
  //    directories are team-authored.
  const userRoot = cfg.skillsDir;
  for (const e of await listSkillEntries(userRoot)) {
    const dir = path.join(userRoot, e.name);
    let origin: SkillOrigin = "team";
    if (e.isLink) {
      origin = "installed";
    } else {
      try {
        const real = norm(await fsp.realpath(dir));
        if (real.startsWith(norm(agentsStandardDir))) origin = "installed";
      } catch {
        /* keep team */
      }
    }
    await add(await readSkillDir(dir, e.name, origin));
  }

  // 2. Cross-tool standard location (anything not already linked above).
  for (const e of await listSkillEntries(agentsStandardDir)) {
    await add(await readSkillDir(path.join(agentsStandardDir, e.name), e.name, "installed"));
  }

  // 3. Plugin-bundled skills, from the plugin registry (authoritative for
  //    which install path is active — the cache dir also holds stale versions).
  try {
    const reg = JSON.parse(
      await fsp.readFile(pluginsFile, "utf8")
    ) as InstalledPluginsFile;
    for (const [key, installs] of Object.entries(reg.plugins ?? {})) {
      const [pluginName, marketplace] = key.split("@");
      const origin: SkillOrigin =
        marketplace === "claude-plugins-official" ? "official" : "plugin";
      for (const inst of installs ?? []) {
        if (!inst.installPath) continue;
        const skillsRoot = path.join(inst.installPath, "skills");
        for (const e of await listSkillEntries(skillsRoot)) {
          await add(
            await readSkillDir(path.join(skillsRoot, e.name), e.name, origin, pluginName)
          );
        }
      }
    }
  } catch {
    /* no plugins installed — fine */
  }

  // 4. Project-level skills in the aiTeam repo.
  const projectRoot = path.join(cfg.aiteamDir, ".claude", "skills");
  for (const e of await listSkillEntries(projectRoot)) {
    await add(await readSkillDir(path.join(projectRoot, e.name), e.name, "project"));
  }

  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}
