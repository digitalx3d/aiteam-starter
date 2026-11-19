import path from "node:path";
import { promises as fsp, type Stats } from "node:fs";
import { getConfig } from "./config";
import { readHiddenProjects } from "./hidden-projects";

export interface ProjectListing {
  slug: string;
  name: string;
  path: string;
  modifiedMs: number;
  hasGit: boolean;
  hasClaude: boolean;
  hasPackageJson: boolean;
  hasAiteam: boolean;
  /** User-hidden via the Manage Projects modal. Only ever true when a caller
   *  passes { includeHidden: true }; the default listing omits hidden ones. */
  hidden: boolean;
}

/** The folder scanned for projects. Configurable via the Settings page. */
export function getProjectsRoot(): string {
  return getConfig().projectsRoot;
}

// aiTeam itself has its own dedicated Dashboard, so we hide it from the projects list.
const HIDDEN_PROJECTS = new Set(["aiTeam"]);

const SKIP_PREFIXES = [".", "$"];

function makeSlug(folderName: string): string {
  // Use folder name as-is. URL-encode at the boundary; decode in resolveProjectCwd.
  return folderName;
}

export function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/** Resolve a slug to an absolute project directory, with traversal-safety check. Doesn't check existence. */
export function resolveProjectCwd(slug: string): string | null {
  const decoded = decodeSlug(slug);
  if (
    !decoded ||
    decoded.includes("..") ||
    decoded.includes("/") ||
    decoded.includes("\\")
  ) {
    return null;
  }
  const projectsRoot = getProjectsRoot();
  const full = path.join(projectsRoot, decoded);
  const root = path.resolve(projectsRoot);
  const resolved = path.resolve(full);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return full;
}

/** Resolve a slug AND verify the directory exists. Use this for page-level routing. */
export async function resolveExistingProjectCwd(
  slug: string
): Promise<string | null> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return null;
  const stat = await quickStat(cwd);
  if (!stat || !stat.isDirectory()) return null;
  return cwd;
}

/**
 * True only for a slug that is, character for character, the name of a folder
 * directly under projectsRoot. For routes that write files named after the
 * slug: resolveProjectCwd() decodes and tolerates spellings the chat-state and
 * backup filenames do not, so the two could disagree about which chat a slug
 * means. Deliberately wider than discoverProjects(), which hides aiTeam
 * even though it has real chats.
 */
export async function isExactProjectSlug(slug: string): Promise<boolean> {
  if (!slug || slug !== slug.trim() || decodeSlug(slug) !== slug) return false;
  if (!resolveProjectCwd(slug)) return false;
  try {
    const names = await fsp.readdir(getProjectsRoot());
    if (!names.includes(slug)) return false;
  } catch {
    return false;
  }
  const stat = await quickStat(path.join(getProjectsRoot(), slug));
  return !!stat && stat.isDirectory();
}

async function quickStat(p: string): Promise<Stats | null> {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await quickStat(p)) !== null;
}

export async function discoverProjects(
  opts: { includeHidden?: boolean } = {}
): Promise<ProjectListing[]> {
  const projectsRoot = getProjectsRoot();
  const userHidden = new Set(await readHiddenProjects());
  let entries: string[];
  try {
    entries = await fsp.readdir(projectsRoot);
  } catch {
    return [];
  }

  // Inspect every candidate in parallel. Done one-at-a-time this was ~400ms of
  // the projects page; each project needs 5 stat calls and they don't depend on
  // each other. Every page that lists projects benefits.
  const candidates = entries.filter((name) => {
    if (SKIP_PREFIXES.some((p) => name.startsWith(p))) return false;
    // aiTeam is system-hidden (its own Dashboard) and never user-manageable.
    if (HIDDEN_PROJECTS.has(name)) return false;
    if (userHidden.has(name) && !opts.includeHidden) return false;
    return true;
  });

  const inspected = await Promise.all(
    candidates.map(async (name) => {
      const full = path.join(projectsRoot, name);
      const stat = await quickStat(full);
      if (!stat || !stat.isDirectory()) return null;

      const [hasGit, hasClaude, hasPackageJson, hasAiteam] = await Promise.all([
        exists(path.join(full, ".git")),
        exists(path.join(full, ".claude")),
        exists(path.join(full, "package.json")),
        exists(path.join(full, ".aiteam")),
      ]);

      // Filter to dirs that look like real projects. A folder with .aiteam/
      // is an aiTeam-managed project by definition, even before git init.
      if (!hasGit && !hasClaude && !hasPackageJson && !hasAiteam) return null;

      return {
        slug: makeSlug(name),
        name,
        path: full,
        modifiedMs: stat.mtimeMs,
        hasGit,
        hasClaude,
        hasPackageJson,
        hasAiteam,
        hidden: userHidden.has(name),
      } satisfies ProjectListing;
    })
  );

  const results = inspected.filter((r): r is ProjectListing => r !== null);
  results.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return results;
}
