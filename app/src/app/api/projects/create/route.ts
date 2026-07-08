import path from "node:path";
import { promises as fsp } from "node:fs";
import { getProjectsRoot } from "@/lib/projects";
import { buildProjectScaffold } from "@/lib/project-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateProjectBody {
  /** "new" creates a new folder; "existing" requires the folder to already exist. */
  mode: "new" | "existing";
  /** Folder name under PROJECTS_ROOT. Used as slug + display name. */
  name: string;
  /** One-line description for project-context.md. */
  description: string;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isValidName(name: string): boolean {
  if (!name || name.length > 64) return false;
  // No path separators, no traversal, no leading dot, no leading dollar.
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  if (name.startsWith(".") || name.startsWith("$")) return false;
  // Reasonable folder-name character set.
  return /^[A-Za-z0-9._-][A-Za-z0-9 ._-]*$/.test(name);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  let body: CreateProjectBody;
  try {
    body = (await request.json()) as CreateProjectBody;
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const { mode, name, description } = body || ({} as CreateProjectBody);

  if (mode !== "new" && mode !== "existing") {
    return jsonError("mode must be 'new' or 'existing'", 400);
  }
  if (!isValidName(name)) {
    return jsonError(
      "name must be 1-64 chars, no slashes or '..', no leading '.' or '$'",
      400
    );
  }
  if (typeof description !== "string" || description.length > 280) {
    return jsonError("description must be a string under 280 chars", 400);
  }

  // Resolve project root with traversal safety.
  const projectsRoot = getProjectsRoot();
  const root = path.resolve(projectsRoot);
  const projectDir = path.resolve(path.join(projectsRoot, name));
  if (projectDir !== root && !projectDir.startsWith(root + path.sep)) {
    return jsonError("resolved path escapes the projects root", 400);
  }

  const aiteamDir = path.join(projectDir, ".aiteam");
  const projectExists = await pathExists(projectDir);
  const aiteamExists = await pathExists(aiteamDir);

  if (mode === "new") {
    if (projectExists) {
      return jsonError(
        `folder already exists: ${projectDir}. Use 'existing' mode to add .aiteam/ to an existing folder.`,
        409
      );
    }
  } else {
    // existing
    if (!projectExists) {
      return jsonError(
        `folder does not exist: ${projectDir}. Use 'new' mode to create it.`,
        404
      );
    }
    if (aiteamExists) {
      return jsonError(
        `.aiteam/ already exists inside ${projectDir}. Refusing to clobber.`,
        409
      );
    }
  }

  // Create the project folder if needed, then scaffold .aiteam/.
  try {
    if (mode === "new") {
      await fsp.mkdir(projectDir, { recursive: false });
    }
    await fsp.mkdir(aiteamDir, { recursive: false });
    await fsp.mkdir(path.join(aiteamDir, "agents"), { recursive: false });
    await fsp.mkdir(path.join(aiteamDir, "tasks"), { recursive: false });

    const files = buildProjectScaffold({ name, description });
    for (const f of files) {
      const filePath = path.join(aiteamDir, f.relativePath);
      // Ensure any nested directory exists (defense in depth — scaffold output
      // is currently flat under agents/ and tasks/, but harmless to recurse).
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, f.content, { encoding: "utf8", flag: "wx" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(`scaffold failed: ${message}`, 500);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      slug: name,
      path: projectDir,
      aiteamPath: aiteamDir,
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }
  );
}
