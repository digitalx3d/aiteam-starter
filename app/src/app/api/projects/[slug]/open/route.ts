import { spawn } from "node:child_process";
import { resolveExistingProjectCwd } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ slug: string }>;
}

export async function POST(_request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) {
    return new Response(JSON.stringify({ error: "project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Path comes from resolveExistingProjectCwd, which validates against the
  // PROJECTS_ROOT allowlist — no user-supplied path ever reaches the shell.
  // explorer.exe exits with code 1 when it opens a folder (Windows quirk);
  // detached lets it outlive our request so the window stays open.
  try {
    const child = spawn("explorer.exe", [cwd], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ ok: true, path: cwd }), {
    headers: { "Content-Type": "application/json" },
  });
}
