import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getProjectsRoot } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

// Files are served from <PROJECTS_ROOT>/<project>/chat-images/<...> or
// <PROJECTS_ROOT>/<project>/note-images/<...>. The catch-all segment is the
// path relative to PROJECTS_ROOT. We require the path to include one of the
// allowed segment names so a misconfigured URL can't read arbitrary repo content.
const ALLOWED_IMAGE_DIRS = new Set(["chat-images", "note-images"]);
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await ctx.params;
  if (!segments || segments.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const decoded = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  if (decoded.some((s) => s.includes("..") || s.includes("\0"))) {
    return new Response("Bad path", { status: 400 });
  }
  if (!decoded.some((s) => ALLOWED_IMAGE_DIRS.has(s))) {
    return new Response("Only chat-images/note-images paths are served", { status: 403 });
  }

  const ext = path.extname(decoded[decoded.length - 1]).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    return new Response("Unsupported file type", { status: 415 });
  }

  const projectsRoot = getProjectsRoot();
  const root = path.resolve(projectsRoot);
  const absolute = path.resolve(path.join(projectsRoot, ...decoded));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return new Response("Path escapes project root", { status: 400 });
  }

  let stat;
  try {
    stat = await fsp.stat(absolute);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("Not a file", { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
