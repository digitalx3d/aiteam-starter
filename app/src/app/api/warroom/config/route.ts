import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/warroom/config
 * Tells the setup screen which optional War Room features are available.
 * Never returns the key itself, only whether one is configured.
 */
export async function GET() {
  const openrouterConfigured = Boolean(getConfig().openrouterApiKey);
  return new Response(JSON.stringify({ openrouterConfigured }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
