// RFC 7692 §7.1 permessage-deflate server-negotiation unit tests. Drives the
// pure _WebSocketHandshake_parseExtensionsHeader / _parseWindowBits /
// _negotiateServer functions through the same vm harness as
// handshake.test.mjs: offer parsing, per-element validity, and the echo-only
// response line.
import test from "node:test";
import assert from "node:assert/strict";

import { WebSocketHandshake as H } from "./harness.mjs";

const parseExtensionsHeader = H._WebSocketHandshake_parseExtensionsHeader;
const parseWindowBits = H._WebSocketHandshake_parseWindowBits;
const negotiateServer = H._WebSocketHandshake_negotiateServer;

// Parse an offer the way the server kernel does, then negotiate it.
function negotiate(value) {
  const parsed = parseExtensionsHeader(value);
  assert.equal(parsed.ok, true, "expected parseable offer: " + value);
  return negotiateServer(parsed.elements);
}

function expectDecline(value) {
  assert.deepEqual(
    negotiate(value),
    { responseLine: null, params: null },
    "expected decline: " + value,
  );
}

function expectAccept(value, responseLine, params) {
  assert.deepEqual(negotiate(value), { responseLine, params }, value);
}

const BARE_PARAMS = {
  serverNoContextTakeover: false,
  clientNoContextTakeover: false,
  serverMaxWindowBits: 15,
  clientMaxWindowBits: null,
};

test("no offer at all declines", () => {
  assert.deepEqual(negotiateServer([]), { responseLine: null, params: null });
  assert.deepEqual(negotiateServer(undefined), {
    responseLine: null,
    params: null,
  });
});

test("a bare offer is accepted with the bare response line", () => {
  expectAccept("permessage-deflate", "permessage-deflate", BARE_PARAMS);
});

test("all four parameters are echoed in fixed order", () => {
  expectAccept(
    "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10; client_max_window_bits=12",
    "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10; client_max_window_bits=12",
    {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      serverMaxWindowBits: 10,
      clientMaxWindowBits: 12,
    },
  );
});

test("the response line is always built in the fixed parameter order", () => {
  expectAccept(
    "permessage-deflate; client_max_window_bits=9; server_max_window_bits=9",
    "permessage-deflate; server_max_window_bits=9; client_max_window_bits=9",
    {
      serverNoContextTakeover: false,
      clientNoContextTakeover: false,
      serverMaxWindowBits: 9,
      clientMaxWindowBits: 9,
    },
  );
});

test("a valueless client_max_window_bits offer is echoed as =15", () => {
  expectAccept(
    "permessage-deflate; client_max_window_bits",
    "permessage-deflate; client_max_window_bits=15",
    { ...BARE_PARAMS, clientMaxWindowBits: 15 },
  );
});

test("the extension name and parameter names are matched case-insensitively", () => {
  expectAccept("PerMessage-Deflate", "permessage-deflate", BARE_PARAMS);
  expectAccept(
    "PERMESSAGE-DEFLATE; CLIENT_MAX_WINDOW_BITS",
    "permessage-deflate; client_max_window_bits=15",
    { ...BARE_PARAMS, clientMaxWindowBits: 15 },
  );
});

test("declines an element with a duplicate parameter name", () => {
  expectDecline(
    "permessage-deflate; client_max_window_bits=15; client_max_window_bits=14",
  );
  expectDecline(
    "permessage-deflate; client_max_window_bits=15; Client_Max_Window_Bits=14",
  );
  expectDecline(
    "permessage-deflate; server_no_context_takeover; server_no_context_takeover",
  );
});

test("declines takeover parameters carrying a value", () => {
  expectDecline("permessage-deflate; server_no_context_takeover=1");
  expectDecline("permessage-deflate; client_no_context_takeover=1");
});

test("declines invalid server_max_window_bits offers", () => {
  expectDecline("permessage-deflate; server_max_window_bits"); // valueless
  expectDecline("permessage-deflate; server_max_window_bits=abc");
  for (const bits of ["19", "08", "7", "0", "16", "015"]) {
    expectDecline("permessage-deflate; server_max_window_bits=" + bits);
  }
});

test("declines a valued client_max_window_bits outside 8..15", () => {
  for (const bits of ["20", "7", "08", "abc"]) {
    expectDecline("permessage-deflate; client_max_window_bits=" + bits);
  }
});

test("declines unknown parameter names", () => {
  expectDecline("permessage-deflate; x-unknown=1");
  expectDecline("permessage-deflate; server_no_context_takeover; x-foo");
});

test("ignores other extension names instead of accepting them", () => {
  expectDecline("x-custom");
  expectDecline("x-custom; a=b");
  expectDecline("x-a, x-b; p=1");
});

test("the first valid permessage-deflate element wins", () => {
  expectAccept(
    "permessage-deflate; x-unknown=1, permessage-deflate; server_max_window_bits=11",
    "permessage-deflate; server_max_window_bits=11",
    { ...BARE_PARAMS, serverMaxWindowBits: 11 },
  );
  expectAccept(
    "x-a, permessage-deflate; client_max_window_bits=10, permessage-deflate",
    "permessage-deflate; client_max_window_bits=10",
    { ...BARE_PARAMS, clientMaxWindowBits: 10 },
  );
});

test("declines when no permessage-deflate element is valid", () => {
  expectDecline("x-a, permessage-deflate; x-unknown=1");
  expectDecline(
    "permessage-deflate; server_no_context_takeover=yes, permessage-deflate; server_max_window_bits=40",
  );
});

test("parseWindowBits is the single window-bits validity gate", () => {
  for (let n = 8; n <= 15; n++) {
    assert.equal(parseWindowBits(String(n)), n);
  }
  for (const bad of [
    "0",
    "7",
    "16",
    "19",
    "08",
    "015",
    "150",
    "",
    "abc",
    null,
    undefined,
    15,
  ]) {
    assert.equal(parseWindowBits(bad), null, JSON.stringify(bad));
  }
});

test("negotiates an offer with ABNF-legal empty list elements", () => {
  // RFC 7230 §7 `1#element`: a leading/trailing comma is legal and empty
  // elements are skipped -- the offer is still negotiated, never 400'd.
  expectAccept("permessage-deflate,", "permessage-deflate", BARE_PARAMS);
  expectAccept(",permessage-deflate", "permessage-deflate", BARE_PARAMS);
  expectAccept(
    "permessage-deflate; client_max_window_bits=15,",
    "permessage-deflate; client_max_window_bits=15",
    { ...BARE_PARAMS, clientMaxWindowBits: 15 },
  );
});

test("skips an element the parser marked invalid", () => {
  // A quoted value that unescapes to a non-token makes that ELEMENT invalid:
  // negotiation skips it and never echoes it, and an invalid element on its
  // own is a decline (the handshake then proceeds without extensions).
  expectAccept(
    'permessage-deflate; x="a,b", permessage-deflate; server_max_window_bits=11',
    "permessage-deflate; server_max_window_bits=11",
    { ...BARE_PARAMS, serverMaxWindowBits: 11 },
  );
  expectDecline('permessage-deflate; x="a,b"');
});
