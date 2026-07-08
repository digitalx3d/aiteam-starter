import { parseTranscript } from "@/lib/dispatch-transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/dispatch/:id/transcript
 * Returns the worker's tool-by-tool activity, parsed from its teed stream-json
 * transcript. Powers the Agents tab live activity feed (Level B). Polled by the
 * client while a dispatch is running; one fetch is enough once it's finished.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const entries = await parseTranscript(id);
  return new Response(JSON.stringify({ entries }), {
    headers: { "Content-Type": "application/json" },
  });
}
