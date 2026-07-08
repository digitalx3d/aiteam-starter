import { discoverProjects } from "@/lib/projects";
import {
  readHiddenProjects,
  setProjectHidden,
  writeHiddenProjects,
} from "@/lib/hidden-projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Every project (including hidden ones, each tagged) plus the raw hidden list. */
export async function GET() {
  const [projects, hidden] = await Promise.all([
    discoverProjects({ includeHidden: true }),
    readHiddenProjects(),
  ]);
  return json({ projects, hidden });
}

/** Toggle one project's hidden state: { name, hidden }. */
export async function POST(request: Request) {
  let body: { name?: unknown; hidden?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ ok: false, error: "name required" }, 400);
  const hidden = await setProjectHidden(name, Boolean(body.hidden));
  return json({ ok: true, hidden });
}

/** Replace the whole hidden list: { hidden: string[] }. */
export async function PUT(request: Request) {
  let body: { hidden?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const list = Array.isArray(body.hidden)
    ? body.hidden.filter((n): n is string => typeof n === "string")
    : [];
  await writeHiddenProjects(list);
  return json({ ok: true, hidden: [...list].sort() });
}
