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

  const results: ProjectListing[] = [];
  for (const name of entries) {
    if (SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
    // aiTeam is system-hidden (its own Dashboard) and never user-manageable.
    if (HIDDEN_PROJECTS.has(name)) continue;
    const isHidden = userHidden.has(name);
    if (isHidden && !opts.includeHidden) continue;
    const full = path.join(projectsRoot, name);
    const stat = await quickStat(full);
    if (!stat || !stat.isDirectory()) continue;

    const [hasGit, hasClaude, hasPackageJson, hasAiteam] = await Promise.all([
      exists(path.join(full, ".git")),
      exists(path.join(full, ".claude")),
      exists(path.join(full, "package.json")),
      exists(path.join(full, ".aiteam")),
    ]);

    // Filter to dirs that look like real projects. A folder with .aiteam/
    // is an aiTeam-managed project by definition, even before git init.
    if (!hasGit && !hasClaude && !hasPackageJson && !hasAiteam) continue;

    results.push({
      slug: makeSlug(name),
      name,
      path: full,
      modifiedMs: stat.mtimeMs,
      hasGit,
      hasClaude,
      hasPackageJson,
      hasAiteam,
      hidden: isHidden,
    });
  }

  results.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return results;
}
