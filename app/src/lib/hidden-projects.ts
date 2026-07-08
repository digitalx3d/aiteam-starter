import path from "node:path";
import { promises as fsp } from "node:fs";
import { SETTINGS_FILE } from "./config";

/**
 * User-hidden projects. A small JSON list living next to the Settings file
 * (~/.aiteam/hidden-projects.json) so it survives the same way settings do.
 * Hiding a project removes it from the /projects list AND the dashboard Top-4.
 * This is separate from the hardcoded system-hide of "aiTeam" in projects.ts,
 * which is not user-managed.
 */
function hiddenFile(): string {
  return path.join(path.dirname(SETTINGS_FILE), "hidden-projects.json");
}

export async function readHiddenProjects(): Promise<string[]> {
  try {
    const raw = await fsp.readFile(hiddenFile(), "utf8");
    const parsed = JSON.parse(raw) as { hidden?: unknown };
    if (Array.isArray(parsed?.hidden)) {
      return parsed.hidden.filter(
        (n): n is string => typeof n === "string" && n.trim().length > 0
      );
    }
  } catch {
    /* missing or malformed -> nothing hidden */
  }
  return [];
}

export async function writeHiddenProjects(names: string[]): Promise<void> {
  const unique = Array.from(
    new Set(names.map((n) => n.trim()).filter(Boolean))
  ).sort();
  const file = hiddenFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    JSON.stringify({ hidden: unique }, null, 2) + "\n",
    "utf8"
  );
}

/** Toggle a single project's hidden state. Returns the new (sorted) hidden list. */
export async function setProjectHidden(
  name: string,
  hidden: boolean
): Promise<string[]> {
  const current = new Set(await readHiddenProjects());
  if (hidden) current.add(name.trim());
  else current.delete(name.trim());
  const next = Array.from(current).sort();
  await writeHiddenProjects(next);
  return next;
}
