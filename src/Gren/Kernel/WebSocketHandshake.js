/*

*/

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
// "HandshakeHeaders", "HandshakeAccept", "HandshakeExtensions", "BadRequest",
// "UpgradeRequired".

// RFC 6455 §1.3 magic string, appended to the client key before SHA-1.
var _WebSocketHandshake_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// RFC 7692 §7.1 permessage-deflate extension name and its four parameters.
var _WebSocketHandshake_PMCE_NAME = "permessage-deflate";

// The default permessage-deflate offer (RFC 7692 §7.1.2.2: the client
// advertises a 15-bit window; the bare parameter name is legal in an offer).
// The PARAMS OBJECT is the single source of truth for the offer: the wire
// header string is DERIVED from it below, and kernels pass only the boolean
// `extensions: true` flag to _WebSocketHandshake_buildClientRequest.
// `clientMaxWindowBitsOffered` separates "offered valuelessly" from "not
// offered at all" (the RFC 7692 §7.1.2.2 answer rule).
var _WebSocketHandshake_DEFAULT_OFFER_PARAMS = {
  serverMaxWindowBits: null,
  clientMaxWindowBits: 15,
  clientMaxWindowBitsOffered: true,
};

// Derive a Sec-WebSocket-Extensions offer value from an offer-params object in
// the shape _WebSocketHandshake_validateServerAnswer consumes. A null/absent
// window-bits value is not offered at all; `clientMaxWindowBitsOffered` with no
// value emits the valueless `client_max_window_bits` offer form. Parameters are
// emitted in the RFC 7692 §7.1 fixed order.
function _WebSocketHandshake_buildOfferHeader(params) {
  var header = _WebSocketHandshake_PMCE_NAME;
  if (params.serverNoContextTakeover === true) {
    header += "; server_no_context_takeover";
  }
  if (params.clientNoContextTakeover === true) {
    header += "; client_no_context_takeover";
  }
  if (typeof params.serverMaxWindowBits === "number") {
    header += "; server_max_window_bits=" + params.serverMaxWindowBits;
  }
  if (typeof params.clientMaxWindowBits === "number") {
    header += "; client_max_window_bits=" + params.clientMaxWindowBits;
  } else if (params.clientMaxWindowBitsOffered === true) {
    header += "; client_max_window_bits";
  }
  return header;
}

// The single wire offer the client sends for `extensions: true`, DERIVED from
// the params object above so the two can never drift apart.
var _WebSocketHandshake_DEFAULT_OFFER = _WebSocketHandshake_buildOfferHeader(
  _WebSocketHandshake_DEFAULT_OFFER_PARAMS,
);

// RFC 7230 §3.2.6 token.
var _WebSocketHandshake_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// RFC 7692 §7.1.2: *_max_window_bits is "1*DIGIT" without leading zeroes and
// 8 <= n <= 15.
var _WebSocketHandshake_WINDOW_BITS_RE = /^(?:8|9|1[0-5])$/;

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
//
// `settings.extensions === true` appends the default permessage-deflate offer
// header (RFC 7692 §7.1) after the Version line; undefined/null/anything else
// leaves the request byte-identical to the pre-extensions layout.
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

  var extensionsHeader =
    settings.extensions === true
      ? "Sec-WebSocket-Extensions: " +
        _WebSocketHandshake_DEFAULT_OFFER +
        "\r\n"
      : "";

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
    extensionsHeader +
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

// ---------------------------------------------------------------------------
// permessage-deflate negotiation (RFC 7692 §5/§6/§7.1, RFC 6455 §9.1)
// ---------------------------------------------------------------------------

// True when `value` is a single RFC 7230 §3.2.6 token.
function _WebSocketHandshake_isToken(value) {
  return typeof value === "string" && _WebSocketHandshake_TOKEN_RE.test(value);
}

// Unescape an RFC 7230 §3.2.6 quoted-string (the leading quote included in
// `raw`), returning its contents, or null when `raw` is not a well-formed
// quoted-string covering the whole value.
function _WebSocketHandshake_unquote(raw) {
  if (typeof raw !== "string" || raw.charAt(0) !== '"' || raw.length < 2) {
    return null;
  }
  var out = "";
  for (var i = 1; i < raw.length; i++) {
    var c = raw.charAt(i);
    if (c === "\\") {
      if (i + 1 >= raw.length) {
        return null;
      }
      out += raw.charAt(i + 1);
      i++;
      continue;
    }
    if (c === '"') {
      return i === raw.length - 1 ? out : null;
    }
    out += c;
  }
  return null;
}

// Split `value` on every occurrence of `separator` that lies OUTSIDE an
// RFC 7230 §3.2.6 quoted-string, honouring quoted-pairs (an escaped quote does
// not end the string). Returns the raw pieces, or null when a quoted-string is
// left unterminated -- a genuine ABNF violation the caller reports as ok:false.
function _WebSocketHandshake_splitOutsideQuotes(value, separator) {
  var pieces = [];
  var current = "";
  var inQuotes = false;
  for (var i = 0; i < value.length; i++) {
    var c = value.charAt(i);
    if (inQuotes) {
      current += c;
      if (c === "\\") {
        if (i + 1 >= value.length) {
          return null;
        }
        current += value.charAt(++i);
      } else if (c === '"') {
        inQuotes = false;
      }
    } else if (c === '"') {
      inQuotes = true;
      current += c;
    } else if (c === separator) {
      pieces.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (inQuotes) {
    return null;
  }
  pieces.push(current);
  return pieces;
}

// Parse a Sec-WebSocket-Extensions header value. RFC 6455 §9.1:
//   extension-list    = 1#extension
//   extension         = extension-token *( ";" extension-param )
//   extension-param   = token [ "=" (token | quoted-string) ]
// Returns { ok, elements } with elements = [{ name, params }] in
// offer-preference order and params = [{ name, value }]: parameter names are
// lowercased, values are unescaped and verbatim (null when valueless).
//
// The list is split on `,` (and each element on `;`) only OUTSIDE
// quoted-strings, and quoted-pairs are unescaped (RFC 7230 §7). ABNF-legal
// EMPTY list elements are skipped, but a present header that yields no real
// element at all (",", ",,," and friends) is still ok:false because RFC 7230
// §7 `1#element` requires at least one. ok:false is reserved for genuine ABNF
// violations: an unterminated quoted-string, an invalid param-name token, and a
// value that is neither a token nor a well-formed quoted-string.
//
// A quoted value whose unescaped content is NOT a token (e.g. `a="sp ace"`)
// makes that ELEMENT invalid instead of the header: the element carries
// `valid: false`, _negotiateServer skips it, and _validateServerAnswer fails
// when the invalid element is the permessage-deflate one. Duplicate parameter
// names are likewise NOT a parse error -- they make the element invalid during
// negotiation/validation.
function _WebSocketHandshake_parseExtensionsHeader(value) {
  if (value === undefined || value === null) {
    return { ok: true, elements: [] };
  }
  var bad = { ok: false, elements: [] };
  if (typeof value !== "string") {
    return bad;
  }

  var rawElements = _WebSocketHandshake_splitOutsideQuotes(value, ",");
  if (rawElements === null) {
    return bad;
  }

  var elements = [];
  for (var i = 0; i < rawElements.length; i++) {
    // RFC 7230 §7: `1#element` is `element *( OWS "," OWS element )` plus a
    // legal trailing "OWS \",\"", so empty list elements are simply skipped.
    if (rawElements[i].trim() === "") {
      continue;
    }
    var parts = _WebSocketHandshake_splitOutsideQuotes(rawElements[i], ";");
    if (parts === null) {
      return bad;
    }
    var name = parts[0].trim();
    if (!_WebSocketHandshake_isToken(name)) {
      return bad;
    }
    var elementValid = true;
    var params = [];
    for (var j = 1; j < parts.length; j++) {
      var param = parts[j].trim();
      var eq = param.indexOf("=");
      var paramName;
      var paramValue;
      if (eq === -1) {
        paramName = param;
        paramValue = null;
      } else {
        paramName = param.slice(0, eq).trim();
        var rawValue = param.slice(eq + 1).trim();
        if (rawValue.charAt(0) === '"') {
          paramValue = _WebSocketHandshake_unquote(rawValue);
          if (paramValue === null) {
            return bad;
          }
          // RFC 7692 §7.1: a quoted value that unescapes to a non-token makes
          // the element invalid -- decline it, do not 400 the whole header.
          if (!_WebSocketHandshake_isToken(paramValue)) {
            elementValid = false;
          }
        } else {
          // An unquoted value must be a token: a genuine ABNF violation.
          if (!_WebSocketHandshake_isToken(rawValue)) {
            return bad;
          }
          paramValue = rawValue;
        }
      }
      if (!_WebSocketHandshake_isToken(paramName)) {
        return bad;
      }
      params.push({ name: paramName.toLowerCase(), value: paramValue });
    }
    var element = { name: name, params: params };
    if (!elementValid) {
      element.valid = false;
    }
    elements.push(element);
  }
  return elements.length === 0 ? bad : { ok: true, elements: elements };
}

// RFC 7692 §7.1.2 window-bits validity check, shared by server negotiation
// and client-answer validation: "1*DIGIT" with no leading zeroes and
// 8 <= n <= 15 (0-7, >15, leading zeroes, non-digits and valueless parameters
// are all invalid). Returns the number, or null when `value` is invalid.
function _WebSocketHandshake_parseWindowBits(value) {
  if (
    typeof value !== "string" ||
    !_WebSocketHandshake_WINDOW_BITS_RE.test(value)
  ) {
    return null;
  }
  return parseInt(value, 10);
}

// Validate one offered permessage-deflate element against RFC 7692 §7.1.
// Returns the offered parameters, or null when the element is invalid
// (duplicate parameter, valued no_context_takeover, malformed/out-of-range or
// valueless server_max_window_bits, malformed valued client_max_window_bits,
// or an unknown parameter name).
function _WebSocketHandshake_parseServerElement(element) {
  var seen = {};
  var params = {
    serverNoContextTakeover: false,
    clientNoContextTakeover: false,
    serverMaxWindowBits: null,
    clientMaxWindowBitsOffered: false,
    clientMaxWindowBits: null,
  };
  for (var i = 0; i < element.params.length; i++) {
    var param = element.params[i];
    var name = param.name; // lowercased by the parser
    if (Object.prototype.hasOwnProperty.call(seen, name)) {
      return null;
    }
    seen[name] = true;
    if (name === "server_no_context_takeover") {
      if (param.value !== null) {
        return null;
      }
      params.serverNoContextTakeover = true;
    } else if (name === "client_no_context_takeover") {
      if (param.value !== null) {
        return null;
      }
      params.clientNoContextTakeover = true;
    } else if (name === "server_max_window_bits") {
      // §7.1.2.1 requires a value in an offer: valueless is invalid.
      var serverBits = _WebSocketHandshake_parseWindowBits(param.value);
      if (serverBits === null) {
        return null;
      }
      params.serverMaxWindowBits = serverBits;
    } else if (name === "client_max_window_bits") {
      // §7.1.2.2 permits the valueless form in an offer; a value must be valid.
      params.clientMaxWindowBitsOffered = true;
      if (param.value !== null) {
        var clientBits = _WebSocketHandshake_parseWindowBits(param.value);
        if (clientBits === null) {
          return null;
        }
        params.clientMaxWindowBits = clientBits;
      }
    } else {
      return null;
    }
  }
  return params;
}

// Server-side permessage-deflate negotiation over a parsed offer: echo-only,
// never inventing a parameter (RFC 7692 §7.1). The candidate is the FIRST
// element named permessage-deflate (case-insensitive) that is element-valid;
// other extension names are ignored and never accepted, and earlier invalid
// candidates are skipped -- including elements the parser marked
// `valid: false` (a quoted parameter value that unescapes to a non-token). Returns { responseLine, params } with nulls when the
// server declines (handshake proceeds without extensions).
//
// The response line is built in the fixed order
//   permessage-deflate[; server_no_context_takeover][; client_no_context_takeover]
//                     [; server_max_window_bits=N][; client_max_window_bits=N]
// echoing only what was offered (a valueless client_max_window_bits offer is
// echoed as =15, §7.1.2.2). params.serverMaxWindowBits records 15 when not
// agreed; params.clientMaxWindowBits stays null when not agreed so sg2's
// compressor can tell "not agreed" from an explicit 15.
function _WebSocketHandshake_negotiateServer(elements) {
  var decline = { responseLine: null, params: null };
  if (!Array.isArray(elements)) {
    return decline;
  }

  var agreed = null;
  for (var i = 0; i < elements.length; i++) {
    if (elements[i].valid === false) {
      continue;
    }
    if (
      String(elements[i].name).toLowerCase() !== _WebSocketHandshake_PMCE_NAME
    ) {
      continue;
    }
    var candidate = _WebSocketHandshake_parseServerElement(elements[i]);
    if (candidate !== null) {
      agreed = candidate;
      break;
    }
  }
  if (agreed === null) {
    return decline;
  }

  var responseLine = _WebSocketHandshake_PMCE_NAME;
  if (agreed.serverNoContextTakeover) {
    responseLine += "; server_no_context_takeover";
  }
  if (agreed.clientNoContextTakeover) {
    responseLine += "; client_no_context_takeover";
  }
  if (agreed.serverMaxWindowBits !== null) {
    responseLine += "; server_max_window_bits=" + agreed.serverMaxWindowBits;
  }
  var clientMaxWindowBits = null;
  if (agreed.clientMaxWindowBitsOffered) {
    clientMaxWindowBits =
      agreed.clientMaxWindowBits === null ? 15 : agreed.clientMaxWindowBits;
    responseLine += "; client_max_window_bits=" + clientMaxWindowBits;
  }

  return {
    responseLine: responseLine,
    params: {
      serverNoContextTakeover: agreed.serverNoContextTakeover,
      clientNoContextTakeover: agreed.clientNoContextTakeover,
      serverMaxWindowBits:
        agreed.serverMaxWindowBits === null ? 15 : agreed.serverMaxWindowBits,
      clientMaxWindowBits: clientMaxWindowBits,
    },
  };
}

// Client-side validation of the server's answer to the permessage-deflate
// offer we sent (RFC 7692 §5/§7.1). `elements` is the parse of the response
// Sec-WebSocket-Extensions value ([] when the header is absent) and
// `clientOfferParams` describes our own offer:
// { serverMaxWindowBits, clientMaxWindowBits, clientMaxWindowBitsOffered },
// where a null window is one we did not offer and `clientMaxWindowBitsOffered`
// is false when the offer did not carry client_max_window_bits at all.
//
// Returns { ok: true, params: null } when the server declined (no
// permessage-deflate element at all), { ok: true, params } with the agreed
// parameters otherwise, and { ok: false, error } with code
// "HandshakeExtensions" when the answer is invalid: more than one
// permessage-deflate element, any other extension name (never offered), an
// element the parser marked invalid, a duplicate parameter, a value on a
// no_context_takeover parameter, a valueless/out-of-range *_max_window_bits,
// a window larger than we offered, a client_max_window_bits answer when the
// offer did not contain that parameter at all (RFC 7692 §7.1.2.2 -- a
// valueless offer followed by a valued answer stays legal), or an unknown
// parameter name.
function _WebSocketHandshake_validateServerAnswer(elements, clientOfferParams) {
  var fail = {
    ok: false,
    error: {
      code: "HandshakeExtensions",
      message: "Invalid Sec-WebSocket-Extensions in handshake response",
    },
  };
  if (!Array.isArray(elements)) {
    return fail;
  }

  var pmceCount = 0;
  var element = null;
  for (var i = 0; i < elements.length; i++) {
    if (
      String(elements[i].name).toLowerCase() === _WebSocketHandshake_PMCE_NAME
    ) {
      pmceCount++;
      element = elements[i];
    }
  }
  if (pmceCount === 0) {
    return { ok: true, params: null };
  }
  // Exactly one permessage-deflate element and no other extension name: any
  // other token is an extension the client never offered (RFC 6455 §9.1). An
  // element the parser marked invalid (a quoted parameter value that unescapes
  // to a non-token) is never an acceptable answer either.
  if (pmceCount !== 1 || elements.length !== 1 || element.valid === false) {
    return fail;
  }

  var offer = clientOfferParams || {};
  var seen = {};
  var params = {
    serverNoContextTakeover: false,
    clientNoContextTakeover: false,
    serverMaxWindowBits: null,
    clientMaxWindowBits: null,
  };
  for (var j = 0; j < element.params.length; j++) {
    var param = element.params[j];
    var name = param.name; // lowercased by the parser
    if (Object.prototype.hasOwnProperty.call(seen, name)) {
      return fail;
    }
    seen[name] = true;
    if (name === "server_no_context_takeover") {
      if (param.value !== null) {
        return fail;
      }
      params.serverNoContextTakeover = true;
    } else if (name === "client_no_context_takeover") {
      if (param.value !== null) {
        return fail;
      }
      params.clientNoContextTakeover = true;
    } else if (name === "server_max_window_bits") {
      var serverBits = _WebSocketHandshake_parseWindowBits(param.value);
      if (
        serverBits === null ||
        (typeof offer.serverMaxWindowBits === "number" &&
          serverBits > offer.serverMaxWindowBits)
      ) {
        return fail;
      }
      params.serverMaxWindowBits = serverBits;
    } else if (name === "client_max_window_bits") {
      var clientBits = _WebSocketHandshake_parseWindowBits(param.value);
      // RFC 7692 §7.1.2.2: the answer parameter is legal only when the offer
      // contained it -- "offered valuelessly" is NOT "not offered".
      if (
        clientBits === null ||
        offer.clientMaxWindowBitsOffered === false ||
        (typeof offer.clientMaxWindowBits === "number" &&
          clientBits > offer.clientMaxWindowBits)
      ) {
        return fail;
      }
      params.clientMaxWindowBits = clientBits;
    } else {
      return fail;
    }
  }

  return {
    ok: true,
    params: {
      serverNoContextTakeover: params.serverNoContextTakeover,
      clientNoContextTakeover: params.clientNoContextTakeover,
      serverMaxWindowBits:
        params.serverMaxWindowBits === null ? 15 : params.serverMaxWindowBits,
      clientMaxWindowBits: params.clientMaxWindowBits,
    },
  };
}

// Validate the server's 101 response to a client handshake whose key was
// `key`. `responseBuffer` must contain the complete header block (ending in
// CRLF CRLF). Optional `options` marks whether the client sent a
// permessage-deflate offer: `offeredParams` is the params object actually
// offered (the answer is validated against THAT object, not against a
// constant, so a non-default offer is honoured), and the legacy truthy
// `offeredExtensions` means "we offered the default offer". With neither key
// the response extensions header is ignored (null/undefined = no offer).
//
// Returns { ok, error? } with error codes "HandshakeStatus" (bad/incomplete
// status line), "HandshakeHeaders" (missing or wrong Upgrade/Connection),
// "HandshakeAccept" (Sec-WebSocket-Accept mismatch) or "HandshakeExtensions"
// (invalid extension answer). Extra/unknown headers are tolerated (autobahn
// 7.x leniency).
//
// With no offer the response extensions header is ignored entirely and the
// result is EXACTLY { ok: true } (the pre-extensions shape); with an offer the
// result is { ok: true, params } where params is the agreed parameters or null
// when the server declined.
function _WebSocketHandshake_validateServerResponse(
  key,
  responseBuffer,
  options,
) {
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

  var offeredParams = options ? options.offeredParams : undefined;
  if (offeredParams === undefined || offeredParams === null) {
    var offeredExtensions = options ? options.offeredExtensions : undefined;
    if (offeredExtensions === undefined || offeredExtensions === null) {
      return { ok: true };
    }
    // Legacy callers only mark "we offered": the default offer IS
    // _WebSocketHandshake_DEFAULT_OFFER_PARAMS by construction.
    offeredParams = _WebSocketHandshake_DEFAULT_OFFER_PARAMS;
  }

  var parsedExtensions = _WebSocketHandshake_parseExtensionsHeader(
    parsed.headers["sec-websocket-extensions"],
  );
  if (!parsedExtensions.ok) {
    return {
      ok: false,
      error: {
        code: "HandshakeExtensions",
        message: "Malformed Sec-WebSocket-Extensions in handshake response",
      },
    };
  }

  var answer = _WebSocketHandshake_validateServerAnswer(
    parsedExtensions.elements,
    offeredParams,
  );
  if (!answer.ok) {
    return answer;
  }
  return { ok: true, params: answer.params };
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
// Sec-WebSocket-Accept value computed from the client's key. A non-empty
// `extensionsLine` (the negotiated Sec-WebSocket-Extensions value) is emitted
// after the Accept line; null/undefined/"" keeps the v1 byte layout exactly.
function _WebSocketHandshake_acceptResponse(key, extensionsLine) {
  var extensionsHeader =
    typeof extensionsLine === "string" && extensionsLine !== ""
      ? "Sec-WebSocket-Extensions: " + extensionsLine + "\r\n"
      : "";
  return Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      _WebSocketHandshake_acceptValue(key) +
      "\r\n" +
      extensionsHeader +
      "\r\n",
    "utf8",
  );
}
