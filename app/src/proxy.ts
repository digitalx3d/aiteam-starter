import { NextResponse, type NextRequest } from "next/server";
import { checkRequest, makeHostCheck } from "@/lib/request-guard";
import { getExtraAllowedHosts } from "@/lib/config";

// Next 16 renamed middleware to proxy (node_modules/next/dist/docs/01-app/
// 03-api-reference/03-file-conventions/proxy.md); it runs on the Node.js
// runtime, before every matched route. The rules and why they exist are in
// lib/request-guard.ts. Runs on pages as well as /api, so a rebound page
// cannot read the dashboard either; only build assets skip it.

let loggedHosts = false;

export function proxy(request: NextRequest) {
  const extra = getExtraAllowedHosts();
  if (!loggedHosts) {
    loggedHosts = true;
    console.log(
      `[request-guard] accepting Host names: ${["localhost", "127.0.0.1", "::1", ...extra].join(", ")}`
    );
  }

  const h = request.headers;
  const length = Number(h.get("content-length") ?? "0");
  const input = {
    method: request.method,
    pathname: request.nextUrl.pathname,
    host: h.get("host"),
    origin: h.get("origin"),
    contentType: h.get("content-type"),
    hasBody: (Number.isFinite(length) && length > 0) || h.has("transfer-encoding"),
  };

  const verdict = checkRequest(input, makeHostCheck(extra));
  if (verdict.ok) return NextResponse.next();

  console.warn(`[request-guard] refused ${input.method} ${input.pathname}: ${verdict.reason}`);
  return NextResponse.json({ error: `refused: ${verdict.reason}` }, { status: 403 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
