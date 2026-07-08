import { startWarRoom } from "@/lib/warroom-engine";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartRequest {
  idea?: string;
  objective?: string;
  model?: string;
  roster?: string[];
  rosterConfig?: Array<{ name?: string; model?: string; extra?: string }>;
  outsiders?: Array<{ displayName?: string; model?: string; extra?: string }>;
  rounds?: number;
  pace?: string;
  personaWeight?: number;
  research?: string;
}

function bad(error: string, status = 400): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/warroom
 * Body: { idea, objective, model?, roster?, rosterConfig?, outsiders?,
 *         rounds?, pace?, personaWeight?, research? }
 * Starts a War Room session. The rounds run out-of-band; watch them via
 * GET /api/warroom/:id/stream. Returns the new session id immediately.
 */
export async function POST(request: Request) {
  let body: StartRequest;
  try {
    body = (await request.json()) as StartRequest;
  } catch {
    return bad("Invalid JSON");
  }

  const idea = body.idea?.trim();
  const objective = body.objective?.trim();
  if (!idea) return bad("idea is required");
  if (!objective) return bad("objective is required");

  const rosterConfig = Array.isArray(body.rosterConfig)
    ? body.rosterConfig
        .filter((e) => e && typeof e.name === "string" && e.name.trim())
        .map((e) => ({
          name: e.name!.trim(),
          model: typeof e.model === "string" ? e.model.trim() : undefined,
          extra:
            typeof e.extra === "string" ? e.extra.trim().slice(0, 400) : undefined,
        }))
    : undefined;

  const outsiders = Array.isArray(body.outsiders)
    ? body.outsiders
        .filter(
          (o) =>
            o &&
            typeof o.displayName === "string" &&
            o.displayName.trim() &&
            typeof o.model === "string" &&
            o.model.trim()
        )
        .map((o) => ({
          displayName: o.displayName!.trim(),
          model: o.model!.trim(),
          extra:
            typeof o.extra === "string" ? o.extra.trim().slice(0, 400) : undefined,
        }))
    : undefined;

  if (outsiders && outsiders.length > 0 && !getConfig().openrouterApiKey) {
    return bad(
      "Outside consultants need an OpenRouter API key. Add one on the Settings page (or unset the outside consultants)."
    );
  }

  const session = await startWarRoom({
    idea,
    objective,
    model: body.model || "sonnet",
    roster: Array.isArray(body.roster) ? body.roster : undefined,
    rosterConfig,
    outsiders,
    rounds: typeof body.rounds === "number" ? body.rounds : undefined,
    pace: typeof body.pace === "string" ? body.pace : undefined,
    personaWeight:
      typeof body.personaWeight === "number" ? body.personaWeight : undefined,
    research:
      body.research === "opening" || body.research === "deep"
        ? body.research
        : "off",
  });

  return new Response(
    JSON.stringify({ id: session.id, session }),
    { status: 202, headers: { "Content-Type": "application/json" } }
  );
}
