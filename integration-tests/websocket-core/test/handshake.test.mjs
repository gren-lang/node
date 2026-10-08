// Handshake unit tests: URL parsing, client request/response validation,
// server request parsing and HTTP-level replies (RFC 6455 §4/§1.3).
import test from "node:test";
import assert from "node:assert/strict";

import { WebSocketHandshake as H } from "./harness.mjs";

const parseWsUrl = H._WebSocketHandshake_parseWsUrl;
const buildClientRequest = H._WebSocketHandshake_buildClientRequest;
const acceptValue = H._WebSocketHandshake_acceptValue;
const validateServerResponse = H._WebSocketHandshake_validateServerResponse;
const parseRequestHead = H._WebSocketHandshake_parseRequestHead;
const validateClientRequest = H._WebSocketHandshake_validateClientRequest;
const rejectResponse = H._WebSocketHandshake_rejectResponse;
const acceptResponse = H._WebSocketHandshake_acceptResponse;

test("acceptValue matches the RFC 6455 §1.3 example", () => {
  assert.equal(
    acceptValue("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("parseWsUrl handles ws:// defaults and basic forms", () => {
  const r = parseWsUrl("ws://example.com/");
  assert.equal(r.ok, true);
  assert.equal(r.host, "example.com");
  assert.equal(r.port, 80);
  assert.equal(r.pathWithQuery, "/");
  assert.equal(r.isTls, false);
});

test("parseWsUrl handles wss:// default port 443", () => {
  const r = parseWsUrl("wss://secure.example.com/chat");
  assert.equal(r.ok, true);
  assert.equal(r.port, 443);
  assert.equal(r.pathWithQuery, "/chat");
  assert.equal(r.isTls, true);
});

test("parseWsUrl preserves full path and query string", () => {
  // The autobahn fuzzingserver drives cases via /runCase?case=N&agent=X
  const r = parseWsUrl("ws://127.0.0.1:9001/runCase?case=42&agent=gren-node");
  assert.equal(r.ok, true);
  assert.equal(r.host, "127.0.0.1");
  assert.equal(r.port, 9001);
  assert.equal(r.pathWithQuery, "/runCase?case=42&agent=gren-node");
});

test("parseWsUrl maps empty path to /", () => {
  const r = parseWsUrl("ws://example.com");
  assert.equal(r.ok, true);
  assert.equal(r.pathWithQuery, "/");
});

test("parseWsUrl keeps explicit ports", () => {
  const r = parseWsUrl("ws://example.com:8080/x");
  assert.equal(r.ok, true);
  assert.equal(r.port, 8080);
});

test("parseWsUrl accepts IPv6 literals (bracketed in the Host)", () => {
  const r = parseWsUrl("ws://[::1]:9001/v6");
  assert.equal(r.ok, true);
  assert.equal(r.host, "[::1]");
  assert.equal(r.port, 9001);
  assert.equal(r.pathWithQuery, "/v6");
});

test("parseWsUrl rejects non-ws schemes incl. http/https", () => {
  for (const url of [
    "http://example.com/",
    "https://example.com/",
    "ftp://example.com/",
    "wss+unix:///x",
  ]) {
    const r = parseWsUrl(url);
    assert.equal(r.ok, false, url + " must be rejected");
    assert.equal(r.error.code, "UnsupportedScheme", url);
  }
});

test("parseWsUrl rejects garbage with InvalidUrl", () => {
  for (const url of ["", "not a url", "://", ":::"]) {
    const r = parseWsUrl(url);
    assert.equal(r.ok, false, JSON.stringify(url) + " must be rejected");
    assert.equal(r.error.code, "InvalidUrl");
  }
  const r = parseWsUrl(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "InvalidUrl");
});

test("buildClientRequest produces the exact byte layout", () => {
  const { key, request } = buildClientRequest({
    host: "example.com",
    port: 1234,
    pathWithQuery: "/runCase?case=7&agent=a",
    isTls: false,
  });

  // key is base64 of 16 random bytes
  const raw = Buffer.from(key, "base64");
  assert.equal(raw.length, 16);

  const expected =
    "GET /runCase?case=7&agent=a HTTP/1.1\r\n" +
    "Host: example.com:1234\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: " +
    key +
    "\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "\r\n";
  assert.equal(Buffer.isBuffer(request), true);
  assert.equal(request.toString("utf8"), expected);
});

test("buildClientRequest omits the port for plain ws on 80 only", () => {
  const plain80 = buildClientRequest({
    host: "example.com",
    port: 80,
    pathWithQuery: "/x",
    isTls: false,
  });
  assert.match(
    plain80.request.toString(),
    /^GET \/x HTTP\/1\.1\r\nHost: example\.com\r\n/,
  );

  const tls443 = buildClientRequest({
    host: "example.com",
    port: 443,
    pathWithQuery: "/x",
    isTls: true,
  });
  assert.match(
    tls443.request.toString(),
    /^GET \/x HTTP\/1\.1\r\nHost: example\.com:443\r\n/,
  );

  const ws8080 = buildClientRequest({
    host: "example.com",
    port: 8080,
    pathWithQuery: "/x",
    isTls: false,
  });
  assert.match(
    ws8080.request.toString(),
    /^GET \/x HTTP\/1\.1\r\nHost: example\.com:8080\r\n/,
  );
});

test("buildClientRequest brackets bare IPv6 hosts", () => {
  const { request } = buildClientRequest({
    host: "::1",
    port: 9001,
    pathWithQuery: "/",
    isTls: false,
  });
  assert.match(request.toString(), /^Host: \[::1\]:9001\r$/m);
});

test("buildClientRequest generates a fresh key per call", () => {
  const a = buildClientRequest({ host: "h", port: 1, pathWithQuery: "/" });
  const b = buildClientRequest({ host: "h", port: 1, pathWithQuery: "/" });
  assert.notEqual(a.key, b.key);
});

function responseBytes(lines, extraTerminator = true) {
  return Buffer.from(
    lines.join("\r\n") + (extraTerminator ? "\r\n\r\n" : ""),
    "latin1",
  );
}

const GOOD_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const GOOD_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

test("validateServerResponse accepts a conforming 101", () => {
  const res = responseBytes([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + GOOD_ACCEPT,
    "X-Extra: tolerated",
  ]);
  assert.deepEqual(validateServerResponse(GOOD_KEY, res), { ok: true });
});

test("validateServerResponse tolerates HTTP/1.0 101", () => {
  const res = responseBytes([
    "HTTP/1.0 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + GOOD_ACCEPT,
  ]);
  assert.deepEqual(validateServerResponse(GOOD_KEY, res), { ok: true });
});

test("validateServerResponse accepts comma-list Connection/Upgrade", () => {
  const res = responseBytes([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: HTTP/2.0, websocket",
    "Connection: keep-alive, Upgrade",
    "Sec-WebSocket-Accept: " + GOOD_ACCEPT,
  ]);
  assert.deepEqual(validateServerResponse(GOOD_KEY, res), { ok: true });
});

test("validateServerResponse accepts case-insensitive tokens", () => {
  const res = responseBytes([
    "HTTP/1.1 101 Switching Protocols",
    "upgrade: WebSocket",
    "cOnNeCtIoN: uPgRaDe",
    "sec-websocket-accept: " + GOOD_ACCEPT,
  ]);
  assert.deepEqual(validateServerResponse(GOOD_KEY, res), { ok: true });
});

test("validateServerResponse rejects non-101 status (200 -> HandshakeStatus)", () => {
  const res = responseBytes([
    "HTTP/1.1 200 OK",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + GOOD_ACCEPT,
  ]);
  const r = validateServerResponse(GOOD_KEY, res);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "HandshakeStatus");
});

test("validateServerResponse rejects garbage status line", () => {
  const res = responseBytes(["NOT-HTTP 101", "Upgrade: websocket"]);
  const r = validateServerResponse(GOOD_KEY, res);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "HandshakeStatus");
});

test("validateServerResponse rejects incomplete response (no final CRLFCRLF)", () => {
  const res = responseBytes(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + GOOD_ACCEPT,
    ],
    false,
  );
  const r = validateServerResponse(GOOD_KEY, res);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "HandshakeStatus");
});

test("validateServerResponse rejects missing/wrong Upgrade (HandshakeHeaders)", () => {
  for (const upgrade of [null, "websocketx", "h2c"]) {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    if (upgrade !== null) lines.push("Upgrade: " + upgrade);
    lines.push("Connection: Upgrade");
    lines.push("Sec-WebSocket-Accept: " + GOOD_ACCEPT);
    const r = validateServerResponse(GOOD_KEY, responseBytes(lines));
    assert.equal(r.ok, false, String(upgrade));
    assert.equal(r.error.code, "HandshakeHeaders");
  }
});

test("validateServerResponse rejects missing/wrong Connection (HandshakeHeaders)", () => {
  for (const connection of [null, "keep-alive", "upgradee"]) {
    const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket"];
    if (connection !== null) lines.push("Connection: " + connection);
    lines.push("Sec-WebSocket-Accept: " + GOOD_ACCEPT);
    const r = validateServerResponse(GOOD_KEY, responseBytes(lines));
    assert.equal(r.ok, false, String(connection));
    assert.equal(r.error.code, "HandshakeHeaders");
  }
});

test("validateServerResponse rejects wrong accept value (HandshakeAccept)", () => {
  const res = responseBytes([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept:AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ]);
  const r = validateServerResponse(GOOD_KEY, res);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "HandshakeAccept");
});

test("validateServerResponse rejects missing accept header", () => {
  const res = responseBytes([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
  ]);
  const r = validateServerResponse(GOOD_KEY, res);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "HandshakeAccept");
});

function goodRequestHead(extra = []) {
  return [
    "GET /chat HTTP/1.1",
    "Host: server.example.com",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...extra,
    "",
    "",
  ].join("\r\n");
}

test("parseRequestHead parses method/path and lowercases header names", () => {
  const r = parseRequestHead(
    Buffer.from(goodRequestHead(["X-Whatever: Foo"]), "utf8"),
  );
  assert.equal(r.ok, true);
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/chat");
  assert.equal(r.headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
  assert.equal(r.headers["x-whatever"], "Foo");
  assert.equal(r.headers.upgrade, "websocket");
});

test("parseRequestHead combines repeated headers as a comma list", () => {
  const r = parseRequestHead(
    Buffer.from(
      "GET / HTTP/1.1\r\n" +
        "Upgrade: websocket\r\n" +
        "Upgrade: keepalive-x\r\n" +
        "\r\n",
      "utf8",
    ),
  );
  assert.equal(r.ok, true);
  assert.equal(r.headers.upgrade, "websocket, keepalive-x");
});

test("parseRequestHead works without the trailing blank line yet", () => {
  const r = parseRequestHead(
    "GET /p HTTP/1.1\r\nHost: h\r\nUpgrade: websocket",
  );
  assert.equal(r.ok, true);
  assert.equal(r.path, "/p");
});

test("parseRequestHead rejects malformed requests", () => {
  for (const bad of [
    "NOTAREQUEST\r\n\r\n",
    "GET HTTP/1.1\r\n\r\n",
    "GET / HTTP/1.1\r\nthis-has-no-colon\r\n\r\n",
  ]) {
    const r = parseRequestHead(Buffer.from(bad, "utf8"));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, "BadRequest");
  }
});

test("validateClientRequest accepts a conforming request", () => {
  const parsed = parseRequestHead(Buffer.from(goodRequestHead(), "utf8"));
  assert.deepEqual(validateClientRequest(parsed), { ok: true });
});

test("validateClientRequest tolerates case + comma lists in tokens", () => {
  const head =
    "GET / HTTP/1.1\r\n" +
    "upgrade: WebSocket\r\n" +
    "Connection: keep-alive, Upgrade\r\n" +
    "Sec-WebSocket-Key: abc\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "\r\n";
  const parsed = parseRequestHead(Buffer.from(head, "utf8"));
  assert.deepEqual(validateClientRequest(parsed), { ok: true });
});

test("validateClientRequest rejects missing/wrong Upgrade -> BadRequest", () => {
  for (const head of [
    "GET / HTTP/1.1\r\nConnection: Upgrade\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n",
    "GET / HTTP/1.1\r\nUpgrade: h2c\r\nConnection: Upgrade\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n",
  ]) {
    const r = validateClientRequest(
      parseRequestHead(Buffer.from(head, "utf8")),
    );
    assert.equal(r.ok, false);
    assert.equal(r.reject, "BadRequest");
  }
});

test("validateClientRequest rejects missing/wrong Connection -> BadRequest", () => {
  const head =
    "GET / HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n";
  const r = validateClientRequest(parseRequestHead(Buffer.from(head, "utf8")));
  assert.equal(r.ok, false);
  assert.equal(r.reject, "BadRequest");
});

test("validateClientRequest rejects wrong/missing version -> UpgradeRequired", () => {
  const wrong = validateClientRequest(
    parseRequestHead(
      Buffer.from(
        "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 8\r\n\r\n",
        "utf8",
      ),
    ),
  );
  assert.equal(wrong.reject, "UpgradeRequired");

  const missing = validateClientRequest(
    parseRequestHead(
      Buffer.from(
        "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: a\r\n\r\n",
        "utf8",
      ),
    ),
  );
  assert.equal(missing.reject, "UpgradeRequired");
});

test("validateClientRequest rejects missing/empty key -> BadRequest", () => {
  const missing = validateClientRequest(
    parseRequestHead(
      Buffer.from(
        "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n",
        "utf8",
      ),
    ),
  );
  assert.equal(missing.reject, "BadRequest");

  const empty = validateClientRequest(
    parseRequestHead(
      Buffer.from(
        "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \r\nSec-WebSocket-Version: 13\r\n\r\n",
        "utf8",
      ),
    ),
  );
  assert.equal(empty.reject, "BadRequest");
});

test("validateClientRequest rejects non-GET method -> BadRequest", () => {
  const head =
    "POST / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n";
  const r = validateClientRequest(parseRequestHead(Buffer.from(head, "utf8")));
  assert.equal(r.reject, "BadRequest");
});

test("validateClientRequest rejects unparseable input", () => {
  assert.deepEqual(validateClientRequest({ ok: false }), {
    ok: false,
    reject: "BadRequest",
  });
  assert.deepEqual(validateClientRequest(null), {
    ok: false,
    reject: "BadRequest",
  });
});

// Parse a rejection response and assert its declared Content-Length equals
// the actual body byte length (the 426 branch once shipped declaring 18 for
// a 16-byte body).
function assertRejectResponseWellFormed(buffer, statusLineRe) {
  const text = buffer.toString("latin1");
  assert.match(text, statusLineRe);
  const sep = text.indexOf("\r\n\r\n");
  assert.ok(sep !== -1, "header/body separator present");
  const head = text.slice(0, sep);
  const body = buffer.subarray(sep + 4);
  const cl = head.match(/\r\nContent-Length: (\d+)\b/i);
  assert.ok(cl, "Content-Length header present");
  assert.equal(
    Number(cl[1]),
    Buffer.byteLength(body),
    "declared Content-Length must equal actual body bytes",
  );
  return { head, body };
}

test("rejectResponse(400) is a well-formed Bad Request", () => {
  const buf = rejectResponse("BadRequest");
  const { body } = assertRejectResponseWellFormed(
    buf,
    /^HTTP\/1\.1 400 Bad Request\r\n/,
  );
  assert.equal(body.toString("utf8"), "Bad Request");
});

test("rejectResponse(426) carries Sec-WebSocket-Version: 13 and a consistent Content-Length", () => {
  const buf = rejectResponse("UpgradeRequired");
  const { head, body } = assertRejectResponseWellFormed(
    buf,
    /^HTTP\/1\.1 426 Upgrade Required\r\n/,
  );
  assert.match(head, /\r\nSec-WebSocket-Version: 13\r\n/);
  assert.equal(body.toString("utf8"), "Upgrade Required");
  // the historic bug: 18 declared for this 16-byte body
  assert.equal(Number(head.match(/\r\nContent-Length: (\d+)\b/i)[1]), 16);
});

test("acceptResponse computes Sec-WebSocket-Accept from the key", () => {
  const text = acceptResponse(GOOD_KEY).toString("latin1");
  assert.match(text, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(text, /\r\nUpgrade: websocket\r\n/);
  assert.match(text, /\r\nConnection: Upgrade\r\n/);
  assert.match(
    text,
    /\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/,
  );
  assert.match(text, /\r\n\r\n$/);
});
