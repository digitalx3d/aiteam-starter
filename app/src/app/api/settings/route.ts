import {
  CONFIG_KEYS,
  WEB_EDITABLE_KEYS,
  getConfigInfo,
  getPublicConfig,
  saveSettings,
  type ConfigKey,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Secrets (the OpenRouter key) never appear here: `values` leaves them out and
// each field carries only `isSet`. The front-door guard (src/proxy.ts) keeps
// other sites from reading or writing this route at all.
function payload(): string {
  const info = getConfigInfo();
  return JSON.stringify({
    values: getPublicConfig(),
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
    if (!WEB_EDITABLE_KEYS.includes(key)) {
      return new Response(
        JSON.stringify({
          error: `${key} can't be changed from the web page; edit the settings file or re-run setup.mjs`,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
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
