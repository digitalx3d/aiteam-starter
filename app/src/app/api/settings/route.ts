import {
  CONFIG_KEYS,
  getConfig,
  getConfigInfo,
  saveSettings,
  type ConfigKey,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload(): string {
  const info = getConfigInfo();
  return JSON.stringify({
    values: getConfig(),
    settingsFile: info.settingsFile,
    fields: info.fields,
  });
}

export async function GET() {
  return new Response(payload(), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function PUT(request: Request) {
  let body: { values?: Record<string, unknown> };
  try {
    body = (await request.json()) as { values?: Record<string, unknown> };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!body?.values || typeof body.values !== "object") {
    return new Response(JSON.stringify({ error: "values object is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const updates: Partial<Record<ConfigKey, string>> = {};
  for (const key of CONFIG_KEYS) {
    if (!(key in body.values)) continue;
    const v = body.values[key];
    if (typeof v !== "string") {
      return new Response(
        JSON.stringify({ error: `${key} must be a string` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    updates[key] = v;
  }

  try {
    saveSettings(updates);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `failed to write settings: ${(err as Error).message}` }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(payload(), {
    headers: { "Content-Type": "application/json" },
  });
}
