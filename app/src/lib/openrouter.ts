/**
 * Minimal OpenRouter chat client for War Room "outside consultant" speakers.
 * One call = one whole reply (no streaming), matching how agent bubbles land.
 * Returns null on any failure so the engine can retry or skip the speaker
 * without posting an error bubble — same contract as spawnText.
 */

export interface OpenRouterCall {
  apiKey: string;
  /** OpenRouter model id, e.g. "openai/gpt-5.1". Append ":online" for the web plugin. */
  model: string;
  system: string;
  message: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function openRouterChat(
  call: OpenRouterCall
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? 180_000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${call.apiKey}`,
        "Content-Type": "application/json",
        // Attribution headers OpenRouter uses for its dashboard; optional.
        "HTTP-Referer": "https://github.com/aiteam-dashboard",
        "X-Title": "aiTeam War Room",
      },
      body: JSON.stringify({
        model: call.model,
        // Generous cap: reasoning models spend part of this budget thinking
        // before they emit the (word-capped) reply.
        max_tokens: call.maxTokens ?? 4096,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.message },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
