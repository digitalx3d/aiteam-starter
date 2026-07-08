import {
  getTask,
  updateTask,
  deleteTask,
  TASK_STATUSES,
  TASK_PRIORITIES,
  type TaskStatus,
  type TaskPriority,
} from "@/lib/tasks";
import { resolveExistingProjectCwd } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ slug: string; id: string }>;
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(_request: Request, ctx: Ctx) {
  const { slug, id } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);
  const task = await getTask(slug, id);
  if (!task) return jsonError("task not found", 404);
  return new Response(JSON.stringify({ task }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { slug, id } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("invalid json");
  }

  const title = typeof body.title === "string" ? body.title : undefined;
  const description =
    typeof body.description === "string" ? body.description : undefined;
  const status =
    typeof body.status === "string" && (TASK_STATUSES as string[]).includes(body.status)
      ? (body.status as TaskStatus)
      : undefined;
  const priority =
    typeof body.priority === "string" &&
    (TASK_PRIORITIES as string[]).includes(body.priority)
      ? (body.priority as TaskPriority)
      : undefined;
  const assignee =
    body.assignee === null
      ? null
      : typeof body.assignee === "string"
      ? body.assignee
      : undefined;
  const due =
    body.due === null
      ? null
      : typeof body.due === "string"
      ? body.due
      : undefined;

  const updated = await updateTask(slug, id, {
    title,
    description,
    assignee,
    status,
    priority,
    due,
  });
  if (!updated) return jsonError("task not found", 404);
  return new Response(JSON.stringify({ task: updated }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const { slug, id } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);
  const ok = await deleteTask(slug, id);
  if (!ok) return jsonError("task not found", 404);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
