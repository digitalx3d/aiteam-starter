import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getProjectsRoot, resolveProjectCwd } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// aiTeam itself doesn't appear in the project list (HIDDEN_PROJECTS) but the
// default dashboard chat still needs an image dir. Map missing/default slug to
// "aiTeam" so the path resolves to Z:\GitHub\aiTeam\chat-images\.
const DEFAULT_PROJECT_SLUG = "aiTeam";

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
]);

const EXT_FROM_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per file

function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${randomBytes(3).toString("hex")}`
  );
}

function resolveProjectChatImagesDir(slugOrEmpty: string): string | null {
  const slug = (slugOrEmpty || "").trim() || DEFAULT_PROJECT_SLUG;
  // Special-case aiTeam: not in HIDDEN_PROJECTS-aware resolveProjectCwd, but the
  // directory exists at PROJECTS_ROOT\aiTeam either way.
  if (slug === DEFAULT_PROJECT_SLUG) {
    return path.join(getProjectsRoot(), DEFAULT_PROJECT_SLUG, "chat-images");
  }
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return null;
  return path.join(cwd, "chat-images");
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  const slugField = form.get("project");
  const slug = typeof slugField === "string" ? slugField : "";
  const dir = resolveProjectChatImagesDir(slug);
  if (!dir) {
    return json({ error: `Unknown project: ${slug}` }, 400);
  }

  const files = form.getAll("file").filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return json({ error: "At least one file is required" }, 400);
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return json({ error: `mkdir failed: ${(err as Error).message}` }, 500);
  }

  const saved: Array<{ url: string; path: string; name: string; mime: string; size: number }> = [];
  for (const file of files) {
    if (!ALLOWED_MIME.has(file.type)) {
      return json({ error: `Unsupported MIME: ${file.type || "(none)"}` }, 415);
    }
    if (file.size > MAX_BYTES) {
      return json({ error: `${file.name} exceeds 20 MB limit` }, 413);
    }
    const ext = EXT_FROM_MIME[file.type] || ".bin";
    const filename = `${stamp()}${ext}`;
    const absolute = path.join(dir, filename);
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      await fsp.writeFile(absolute, buf);
    } catch (err) {
      return json({ error: `write failed: ${(err as Error).message}` }, 500);
    }
    const projectFolderName = slug || DEFAULT_PROJECT_SLUG;
    saved.push({
      // Browser-renderable URL via the file-serving route.
      url: `/api/files/${encodeURIComponent(projectFolderName)}/chat-images/${encodeURIComponent(filename)}`,
      // Absolute Windows path — what we include in the prompt so Claude's Read
      // tool can pick it up as multimodal input.
      path: absolute,
      name: file.name,
      mime: file.type,
      size: file.size,
    });
  }

  return json({ ok: true, files: saved });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
