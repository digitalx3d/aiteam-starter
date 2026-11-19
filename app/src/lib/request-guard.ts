/**
 * The dashboard's front-door check, run by src/proxy.ts before any route.
 * Pure: no I/O, so it is tested directly (request-guard.test.mjs).
 *
 * Why it exists: the dashboard has no login, and POST /api/chat or
 * /api/dispatch starts a Claude session that can run commands. request.json()
 * ignores Content-Type, so without this check any web page the owner opened
 * could start one with a single blind cross-site request (text/plain body, no
 * preflight). Three rules close it:
 *
 *   1. Host must be a name this dashboard answers to, on every request:
 *      localhost, 127.0.0.1, ::1, plus any names listed in settings.json
 *      "allowedHosts" (for example a Tailscale name). This stops DNS
 *      rebinding: there the browser thinks it is talking to evil.example, so
 *      that is the Host it sends. Scripts in a page cannot set Host.
 *   2. A state-changing request (anything but GET, HEAD, OPTIONS) that carries
 *      an Origin must come from the address it was sent to. Browsers send
 *      Origin on every such request, same-origin included; scripts and
 *      dispatch.mjs send none and are unaffected. "null" (sandboxed frames,
 *      file:// pages) is refused. POST /api/chat and PUT /api/settings go
 *      further and refuse a request with no Origin at all: only the
 *      dashboard's own pages call them and a browser always sends it. The
 *      first takes whatever arrives as the owner typing; the second can move
 *      the folders the app reads its agents and hooks from. A program can
 *      forge the header, so this stops a job that was misled into one plain
 *      command, not one told exactly how to get past it.
 *   3. A body on such a request must be JSON, except where a route takes
 *      something else (BODY_TYPES). A cross-site page can only send text/plain,
 *      a form, or multipart without asking first, and never JSON.
 *
 * X-Forwarded-Host is ignored on purpose: a rebound page is same-origin to the
 * browser and may set it freely. Tailscale serve passes the real Host through,
 * which is why a Tailscale name has to be listed in "allowedHosts".
 */

export interface GuardInput {
  method: string;
  pathname: string;
  /** The raw Host header. */
  host: string | null;
  origin: string | null;
  contentType: string | null;
  /** True when the request carries a body (Content-Length > 0 or chunked). */
  hasBody: boolean;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Names every install answers to: this machine's loopback addresses. */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/**
 * Body types allowed per route, beyond JSON. `null` would mean any (only for a
 * route guarded by its own secret header); none needs that today.
 */
const BODY_TYPES: Record<string, string[] | null> = {
  // Chat and notes image attachments (FormData).
  "/api/upload": ["multipart/form-data"],
};

/** "Localhost:3900" -> "localhost"; "[::1]:3900" -> "::1"; null if unusable. */
export function hostnameOf(host: string | null): string | null {
  if (!host) return null;
  try {
    const name = new URL(`http://${host.trim()}`).hostname.toLowerCase();
    return name.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Host check for the proxy: loopback, plus the extra names from settings
 * (already lowercased, no scheme or port).
 */
export function makeHostCheck(extra: readonly string[] = []): (hostname: string) => boolean {
  const allowed = new Set([...LOOPBACK_HOSTS, ...extra]);
  return (hostname) => allowed.has(hostname);
}

/** True when `origin` names the same scheme-less host and port as `host`. */
function sameAddress(origin: URL, host: string): boolean {
  try {
    // Parse the Host with the Origin's scheme so a default port compares equal
    // whether or not it is written ("x" and "x:443" under https).
    const target = new URL(`${origin.protocol}//${host.trim()}`);
    return target.host.toLowerCase() === origin.host.toLowerCase();
  } catch {
    return false;
  }
}

/** Called only by the dashboard's own pages, so a missing Origin means a script. */
const BROWSER_ONLY = new Set(["/api/chat", "/api/settings"]);

export function checkRequest(
  input: GuardInput,
  isAllowedHost: (hostname: string) => boolean
): GuardResult {
  const hostname = hostnameOf(input.host);
  if (!hostname) return { ok: false, reason: "missing or unreadable Host header" };
  if (!isAllowedHost(hostname)) {
    return { ok: false, reason: `Host ${input.host} is not an address of this dashboard` };
  }

  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };

  const path = input.pathname.replace(/\/+$/, "").toLowerCase();

  if (input.origin === null && BROWSER_ONLY.has(path)) {
    return { ok: false, reason: `${input.pathname} takes requests from the dashboard's own pages only` };
  }

  if (input.origin !== null) {
    let origin: URL;
    try {
      origin = new URL(input.origin);
    } catch {
      return { ok: false, reason: `unreadable Origin ${input.origin}` };
    }
    if (origin.origin === "null" || !sameAddress(origin, input.host as string)) {
      return { ok: false, reason: `Origin ${input.origin} is not this dashboard` };
    }
  }

  if (input.hasBody) {
    const allowed = Object.prototype.hasOwnProperty.call(BODY_TYPES, path)
      ? BODY_TYPES[path]
      : [];
    if (allowed !== null) {
      const type = (input.contentType ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json" && !allowed.includes(type)) {
        return {
          ok: false,
          reason: `Content-Type ${input.contentType ?? "(none)"} refused; send application/json`,
        };
      }
    }
  }

  return { ok: true };
}
