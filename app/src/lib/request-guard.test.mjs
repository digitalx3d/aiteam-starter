// Tests for the dashboard's front-door check. Run from the app folder:
//   node --test src/lib/request-guard.test.mjs
// Node 22.18+ strips the TypeScript types on import, so no build step.
import { test } from "node:test";
import assert from "node:assert/strict";

const { checkRequest, hostnameOf, makeHostCheck, LOOPBACK_HOSTS } = await import("./request-guard.ts");

// Loopback plus one Tailscale name, as an owner would list it in settings.json.
const TAILNET = "my-pc.tail1234.ts.net";
const allowed = makeHostCheck([TAILNET]);

function req(over = {}) {
  return {
    method: "POST",
    pathname: "/api/dispatch",
    host: "localhost:3900",
    origin: null,
    contentType: "application/json",
    hasBody: true,
    ...over,
  };
}
const ok = (input) => checkRequest(input, allowed).ok;

test("a cross-site text/plain POST is refused", () => {
  for (const pathname of ["/api/dispatch", "/api/chat"]) {
    const r = checkRequest(req({ pathname, contentType: "text/plain", origin: "https://evil.example" }), allowed);
    assert.equal(r.ok, false, pathname);
    assert.match(r.reason, /Origin/);
  }
});

test("JSON with a foreign Origin is refused", () => {
  assert.equal(ok(req({ origin: "https://evil.example" })), false);
  assert.equal(ok(req({ origin: "http://localhost:5173" })), false, "another local site on another port");
  assert.equal(ok(req({ origin: `https://${TAILNET}:8446` })), false, "another app on the same tailnet name");
  assert.equal(ok(req({ origin: "null" })), false, "sandboxed frame or file:// page");
  assert.equal(ok(req({ origin: "not a url" })), false);
});

test("a foreign Host is refused on every method (DNS rebinding)", () => {
  for (const method of ["GET", "POST", "DELETE", "HEAD", "OPTIONS"]) {
    assert.equal(ok(req({ method, host: "evil.example:3900", origin: "http://evil.example:3900" })), false, method);
  }
  assert.equal(ok(req({ host: null })), false, "no Host");
  assert.equal(ok(req({ host: "" })), false, "empty Host");
  assert.equal(ok(req({ method: "GET", host: "192.168.1.20:3900" })), false, "a LAN address is not listed");
  assert.equal(ok(req({ method: "GET", host: "localhost.evil.example" })), false);
});

test("without extras, only loopback names are accepted", () => {
  const plain = makeHostCheck();
  for (const name of LOOPBACK_HOSTS) assert.equal(plain(name), true, name);
  assert.equal(plain(TAILNET), false);
  assert.equal(checkRequest(req({ method: "GET", host: TAILNET }), plain).ok, false);
});

test("dispatch.mjs and the scheduled scripts: JSON, no Origin, localhost", () => {
  assert.equal(ok(req()), true);
  assert.equal(ok(req({ host: "127.0.0.1:3900" })), true);
  assert.equal(ok(req({ host: "localhost:3960" })), true, "any port the owner picked");
  // end-session and the vault auto-commit: POST with no body at all.
  assert.equal(ok(req({ pathname: "/api/chat/end-session", contentType: null, hasBody: false })), true);
  assert.equal(ok(req({ method: "DELETE", pathname: "/api/dispatch/abc", contentType: null, hasBody: false })), true);
});

test("dashboard pages: same-origin posts from every address the owner uses", () => {
  const cases = [
    ["localhost:3900", "http://localhost:3900"],
    ["127.0.0.1:3900", "http://127.0.0.1:3900"],
    ["[::1]:3900", "http://[::1]:3900"],
    [TAILNET, `https://${TAILNET}`],
    [`${TAILNET}:8443`, `https://${TAILNET}:8443`],
    ["My-PC.tail1234.ts.net", `https://${TAILNET}`],
    [`${TAILNET}:443`, `https://${TAILNET}`],
  ];
  for (const [host, origin] of cases) {
    assert.equal(ok(req({ host, origin })), true, `${origin} -> ${host}`);
  }
  assert.equal(ok(req({ host: "localhost:4000", origin: "http://localhost:3900" })), false, "different port, different origin");
});

test("a body must be JSON, except where the route takes something else", () => {
  for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
    assert.equal(ok(req({ contentType: type })), false, String(type));
  }
  assert.equal(ok(req({ contentType: "application/json; charset=utf-8" })), true);
  assert.equal(ok(req({ contentType: "Application/JSON" })), true);
  assert.equal(ok(req({ method: "PUT", pathname: "/api/settings", contentType: "text/plain", origin: "http://localhost:3900" })), false);
  // Image attachments.
  assert.equal(ok(req({ pathname: "/api/upload", contentType: "multipart/form-data; boundary=----x", origin: "http://localhost:3900" })), true);
  assert.equal(ok(req({ pathname: "/api/upload/", contentType: "multipart/form-data; boundary=----x", origin: "http://localhost:3900" })), true);
  assert.equal(ok(req({ pathname: "/api/upload", contentType: "text/plain" })), false);
  assert.equal(ok(req({ pathname: "/api/upload", contentType: "multipart/form-data", origin: "https://evil.example" })), false, "Origin still applies");
});

test("chat and settings take the dashboard's own pages only", () => {
  const page = "http://localhost:3900";
  for (const [method, pathname] of [["POST", "/api/chat"], ["PUT", "/api/settings"]]) {
    assert.equal(ok(req({ method, pathname })), false, `${pathname} with no Origin, as curl sends`);
    assert.equal(ok(req({ method, pathname: `${pathname}/` })), false, `${pathname}/ with no Origin`);
    assert.equal(ok(req({ method, pathname: pathname.toUpperCase() })), false, `${pathname} in capitals`);
    assert.equal(ok(req({ method, pathname, origin: page })), true, `${pathname} from a dashboard page`);
    assert.equal(ok(req({ method, pathname, origin: "https://evil.example" })), false, `${pathname} from another site`);
    assert.equal(ok(req({ method, pathname, host: TAILNET, origin: `https://${TAILNET}` })), true, `${pathname} over Tailscale`);
  }
  assert.equal(ok(req({ method: "GET", pathname: "/api/settings", hasBody: false, contentType: null })), true, "reading settings is unchanged");
});

test("every other route still takes a script with no Origin", () => {
  for (const pathname of ["/api/dispatch", "/api/chat/end-session", "/api/chat/reset"]) {
    assert.equal(ok(req({ pathname })), true, pathname);
  }
});

test("GET is not held to Origin or Content-Type", () => {
  assert.equal(ok(req({ method: "GET", origin: "https://evil.example", contentType: null, hasBody: false })), true);
});

test("hostnameOf", () => {
  assert.equal(hostnameOf("Localhost:3900"), "localhost");
  assert.equal(hostnameOf("[::1]:3900"), "::1");
  assert.equal(hostnameOf(`${TAILNET}.`), TAILNET);
  assert.equal(hostnameOf("bad host"), null);
  assert.equal(hostnameOf(null), null);
});
