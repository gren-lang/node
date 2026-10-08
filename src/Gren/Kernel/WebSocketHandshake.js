// Gren.Kernel.WebSocketHandshake
//
// RFC 6455 §4/§5 handshake helpers shared by the client and server WebSocket
// kernels (Phase 4). This file is deliberately PURE JavaScript with no Gren
// imports and no Gren value references: every Gren value constructor it will
// ever need is built by the calling kernels, and everything it produces is a
// plain JS object. That keeps it loadable and unit-testable by plain node
// (see integration-tests/websocket-core/test/harness.mjs).
//
// Only node builtin modules may be required here (node:crypto). The require
// is lazy (inside the functions) so loading this file needs no module system
// at all -- vm.runInNewContext with a `require` global is enough.
//
// Validation results are plain objects: { ok: boolean, error?: { code, message } }
// with codes "InvalidUrl", "UnsupportedScheme", "HandshakeStatus",
// "HandshakeHeaders", "HandshakeAccept", "BadRequest", "UpgradeRequired".

// RFC 6455 §1.3 magic string, appended to the client key before SHA-1.
var _WebSocketHandshake_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---------------------------------------------------------------------------
// URL parsing (client side)
// ---------------------------------------------------------------------------

// Parse a ws:// or wss:// URL into the pieces the client kernel needs.
// Returns { ok, error?, host, port, pathWithQuery, isTls }.
//
// - ws:// defaults to port 80, wss:// to port 443.
// - The full path AND query string are preserved verbatim: the Autobahn
//   fuzzingserver drives its cases through /runCase?case=N&agent=X, so the
//   upgrade request MUST carry the query (PLAN §6.3).
// - An empty path becomes "/".
// - Any scheme other than ws/wss fails with code "UnsupportedScheme";
//   unparsable URLs fail with "InvalidUrl".
// - IPv6 literals keep their brackets (WHATWG url.hostname for
//   ws://[::1]:9001/ is "[::1]"), which is what net.connect and the Host
//   header both expect.
function _WebSocketHandshake_parseWsUrl(input) {
  if (typeof input !== "string") {
    return {
      ok: false,
      error: {
        code: "InvalidUrl",
        message: "Expected a ws:// or wss:// URL string",
      },
    };
  }

  var url;
  try {
    url = new URL(input);
  } catch (e) {
    return {
      ok: false,
      error: { code: "InvalidUrl", message: "Invalid URL: " + input },
    };
  }

  var isTls;
  if (url.protocol === "ws:") {
    isTls = false;
  } else if (url.protocol === "wss:") {
    isTls = true;
  } else {
    return {
      ok: false,
      error: {
        code: "UnsupportedScheme",
        message: "Unsupported scheme: " + url.protocol,
      },
    };
  }

  var port = url.port === "" ? (isTls ? 443 : 80) : parseInt(url.port, 10);
  if (isNaN(port) || port < 0 || port > 65535) {
    return {
      ok: false,
      error: {
        code: "InvalidUrl",
        message: "Invalid port in URL: " + input,
      },
    };
  }

  var host = url.hostname;
  if (host === "") {
    return {
      ok: false,
      error: { code: "InvalidUrl", message: "Missing host in URL: " + input },
    };
  }

  var pathWithQuery = (url.pathname === "" ? "/" : url.pathname) + url.search;
  return {
    ok: true,
    host: host,
    port: port,
    pathWithQuery: pathWithQuery,
    isTls: isTls,
  };
}

// ---------------------------------------------------------------------------
// Client side: request building and response validation
// ---------------------------------------------------------------------------

// Build the HTTP upgrade request for a ws:// or wss:// connection.
// Returns { key, request } where `key` is base64(randomBytes(16)) (needed
// later to validate Sec-WebSocket-Accept) and `request` is the exact byte
// sequence to write to the socket.
//
// The Host header follows RFC 7230 §5.4 default-port elision: for the plain
// (non-TLS) scheme the port is omitted when it is 80; otherwise host:port is
// always included.
function _WebSocketHandshake_buildClientRequest(settings) {
  var crypto = require("node:crypto");

  var host = String(settings.host);
  var port = settings.port;
  var path =
    typeof settings.pathWithQuery === "string" && settings.pathWithQuery !== ""
      ? settings.pathWithQuery
      : "/";
  var isTls = settings.isTls === true;

  var key = crypto.randomBytes(16).toString("base64");

  var bareHost = host;
  if (
    bareHost.indexOf(":") !== -1 &&
    bareHost.charAt(0) !== "[" // already-bracketed IPv6 literal
  ) {
    bareHost = "[" + bareHost + "]";
  }

  var hostHeaderValue =
    !isTls && port === 80 ? bareHost : bareHost + ":" + port;

  var request =
    "GET " +
    path +
    " HTTP/1.1\r\n" +
    "Host: " +
    hostHeaderValue +
    "\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: " +
    key +
    "\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "\r\n";

  return { key: key, request: Buffer.from(request, "utf8") };
}

// Compute the Sec-WebSocket-Accept value for a Sec-WebSocket-Key (RFC 6455 §1.3).
function _WebSocketHandshake_acceptValue(key) {
  var crypto = require("node:crypto");
  return crypto
    .createHash("sha1")
    .update(String(key) + _WebSocketHandshake_GUID, "binary")
    .digest("base64");
}

// Split "name: value" header lines into lowercased-name -> value.
// Repeated names are combined as "v1, v2" so token checks stay uniform.
function _WebSocketHandshake_splitHeaderLines(target, lines) {
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === "") {
      continue;
    }
    var idx = line.indexOf(":");
    if (idx < 1) {
      return false;
    }
    var name = line.slice(0, idx).trim().toLowerCase();
    var value = line.slice(idx + 1).trim();
    if (name === "") {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      target[name] = target[name] + ", " + value;
    } else {
      target[name] = value;
    }
  }
  return true;
}

// Parse the complete header block of an HTTP/1.x response into
// { statusLine, headers } or null when the block is malformed.
function _WebSocketHandshake_parseHeaderBlock(input) {
  var buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  var text = buf.toString("latin1");
  var sep = text.indexOf("\r\n\r\n");
  var block = sep === -1 ? text : text.slice(0, sep);
  var lines = block.split("\r\n");
  if (lines.length === 0 || lines[0] === "") {
    return null;
  }

  var headers = {};
  if (!_WebSocketHandshake_splitHeaderLines(headers, lines.slice(1))) {
    return null;
  }
  return { statusLine: lines[0], headers: headers };
}

// Check whether `value` is a comma-separated list of tokens (RFC 7230 §7)
// that contains `token`, case-insensitively. Tolerates optional whitespace
// around the commas.
function _WebSocketHandshake_headerListContains(value, token) {
  if (typeof value !== "string") {
    return false;
  }
  var parts = value.split(",");
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].trim().toLowerCase() === token) {
      return true;
    }
  }
  return false;
}

// Validate the server's 101 response to a client handshake whose key was
// `key`. `responseBuffer` must contain the complete header block (ending in
// CRLF CRLF). Returns { ok, error? } with error codes "HandshakeStatus"
// (bad/incomplete status line), "HandshakeHeaders" (missing or wrong
// Upgrade/Connection) or "HandshakeAccept" (Sec-WebSocket-Accept mismatch).
// Extra/unknown headers are tolerated (autobahn 7.x leniency).
function _WebSocketHandshake_validateServerResponse(key, responseBuffer) {
  var buf = Buffer.isBuffer(responseBuffer)
    ? responseBuffer
    : Buffer.from(String(responseBuffer), "utf8");

  var text = buf.toString("latin1");
  if (text.indexOf("\r\n\r\n") === -1) {
    return {
      ok: false,
      error: {
        code: "HandshakeStatus",
        message: "Incomplete handshake response from server",
      },
    };
  }

  var parsed = _WebSocketHandshake_parseHeaderBlock(buf);
  if (parsed === null) {
    return {
      ok: false,
      error: {
        code: "HandshakeStatus",
        message: "Malformed HTTP handshake response",
      },
    };
  }

  var statusMatch = /^HTTP\/1\.([01])[ \t]+([0-9]{3})([ \t].*)?$/.exec(
    parsed.statusLine,
  );
  if (statusMatch === null || statusMatch[2] !== "101") {
    return {
      ok: false,
      error: {
        code: "HandshakeStatus",
        message: "Unexpected handshake status line: " + parsed.statusLine,
      },
    };
  }

  if (
    !_WebSocketHandshake_headerListContains(parsed.headers.upgrade, "websocket")
  ) {
    return {
      ok: false,
      error: {
        code: "HandshakeHeaders",
        message: "Missing or invalid Upgrade header in handshake response",
      },
    };
  }

  if (
    !_WebSocketHandshake_headerListContains(
      parsed.headers.connection,
      "upgrade",
    )
  ) {
    return {
      ok: false,
      error: {
        code: "HandshakeHeaders",
        message: "Missing or invalid Connection header in handshake response",
      },
    };
  }

  var expected = _WebSocketHandshake_acceptValue(key);
  var actual = parsed.headers["sec-websocket-accept"];
  if (!actual || actual.trim() !== expected) {
    return {
      ok: false,
      error: {
        code: "HandshakeAccept",
        message: "Invalid Sec-WebSocket-Accept in handshake response",
      },
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Server side: request parsing, validation, and HTTP-level replies
// ---------------------------------------------------------------------------

// Parse the request head of a WebSocket upgrade request. Accepts a Buffer or
// string containing (at least) the request line and all header lines,
// terminated by CRLF CRLF (the terminator itself need not be present).
// Returns { ok, method?, path?, headers } with lowercased header names and
// comma-combined values, or { ok: false, code: "BadRequest", message }.
function _WebSocketHandshake_parseRequestHead(input) {
  var buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  var text = buf.toString("latin1");
  var sep = text.indexOf("\r\n\r\n");
  var block = sep === -1 ? text : text.slice(0, sep);
  var lines = block.split("\r\n");

  var requestLine = lines.length > 0 ? lines[0] : "";
  var parts = requestLine.split(/[ \t]+/);
  if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2])) {
    return {
      ok: false,
      code: "BadRequest",
      message: "Malformed request line",
    };
  }

  var headers = {};
  if (!_WebSocketHandshake_splitHeaderLines(headers, lines.slice(1))) {
    return { ok: false, code: "BadRequest", message: "Malformed header line" };
  }

  return { ok: true, method: parts[0], path: parts[1], headers: headers };
}

// Validate a parsed upgrade request (RFC 6455 §5.4, RFC 7230 §6.1). Returns
// { ok: true } or { ok: false, reject } where reject is:
//   "BadRequest"      -- answer with 400 Bad Request
//   "UpgradeRequired" -- answer with 426 Upgrade Required + version header
//
// Connection/Upgrade matching is case-insensitive and comma-list tolerant.
// An empty Sec-WebSocket-Key counts as missing (autobahn 7.5.1).
function _WebSocketHandshake_validateClientRequest(parsed) {
  function reject(kind) {
    return { ok: false, reject: kind };
  }

  if (!parsed || parsed.ok !== true) {
    return reject("BadRequest");
  }
  if (parsed.method !== "GET") {
    return reject("BadRequest");
  }
  if (
    !_WebSocketHandshake_headerListContains(parsed.headers.upgrade, "websocket")
  ) {
    return reject("BadRequest");
  }
  if (
    !_WebSocketHandshake_headerListContains(
      parsed.headers.connection,
      "upgrade",
    )
  ) {
    return reject("BadRequest");
  }

  var version = parsed.headers["sec-websocket-version"];
  if (version === undefined || version.trim() !== "13") {
    // Missing or non-13 version: 426 + Sec-WebSocket-Version: 13 per plan.
    return reject("UpgradeRequired");
  }

  var key = parsed.headers["sec-websocket-key"];
  if (key === undefined || key.trim() === "") {
    return reject("BadRequest");
  }

  return { ok: true };
}

// HTTP-level rejection responses for the server handshake. The Content-Length
// is always DERIVED from the body bytes (never a hand-tuned literal, which is
// how the 426 branch once shipped declaring 18 for a 16-byte body).
function _WebSocketHandshake_rejectResponse(kind) {
  if (kind === "UpgradeRequired") {
    var body426 = "Upgrade Required";
    return Buffer.from(
      "HTTP/1.1 426 Upgrade Required\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Content-Length: " +
        Buffer.byteLength(body426, "utf8") +
        "\r\n" +
        "Connection: Closed\r\n" +
        "\r\n" +
        body426,
      "utf8",
    );
  }
  var body400 = "Bad Request";
  return Buffer.from(
    "HTTP/1.1 400 Bad Request\r\n" +
      "Content-Length: " +
      Buffer.byteLength(body400, "utf8") +
      "\r\n" +
      "Connection: Closed\r\n" +
      "\r\n" +
      body400,
    "utf8",
  );
}

// The 101 Switching Protocols response for an accepted upgrade, with the
// Sec-WebSocket-Accept value computed from the client's key.
function _WebSocketHandshake_acceptResponse(key) {
  return Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      _WebSocketHandshake_acceptValue(key) +
      "\r\n" +
      "\r\n",
    "utf8",
  );
}
