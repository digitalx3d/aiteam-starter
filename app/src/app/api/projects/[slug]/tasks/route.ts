import {
  listTasks,
  createTask,
  TASK_STATUSES,
  TASK_PRIORITIES,
  type TaskStatus,
  type TaskPriority,
} from "@/lib/tasks";
import { resolveExistingProjectCwd } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ slug: string }>;
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(_request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);
  const tasks = await listTasks(slug);
  return new Response(JSON.stringify({ tasks }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("invalid json");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return jsonError("title is required");

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
  const description =
    typeof body.description === "string" ? body.description : undefined;

  const task = await createTask(slug, {
    title,
    description,
    assignee,
    status,
    priority,
    due,
  });
  if (!task) return jsonError("failed to create task", 500);
  return new Response(JSON.stringify({ task }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
