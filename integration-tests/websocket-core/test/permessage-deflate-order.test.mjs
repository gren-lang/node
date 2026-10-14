// Deterministic fake-socket regressions for the RFC 7692 inbound receive path
// (§1 PARSER_PAUSED + §2 one-shot decode) of src/Gren/Kernel/WebSocketCore.js.
//
// FAILING-BEFORE EVIDENCE: this file was first run against the UNMODIFIED
// cycle-1 tree (HEAD dda8f9d + cycle-1 work) and the full output recorded in
//   goals/implement-rfc-7692-permessage-deflate-in-gren-la/artifacts/cycle2-sg1-failing-before.txt
// Both context modes (`resetInboundPerMessage: true` and `false`) fail there;
// a byte copy of the pre-edit kernel is kept next to it as
// cycle2-sg1-before-WebSocketCore.js (copy it back over the kernel to
// re-measure the before state; never use git for that).
//
// Harness gotchas (verified): oracleFrame's `rsv` is a 3-bit mask shifted into
// bits 4-6, so RSV1 is `rsv: 4` (`rsv: 1` sets RSV3). With role "server" the
// peer's frames MUST be masked (`mask: true`). The fake socket's `feed()`
// emits one `data` event, so two sequential feed() calls in the same macrotask
// guarantee the second message arrives while the first message's async decode
// is still pending -- the exact window §1 protects.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import {
  WebSocketCore as C,
  makeFakeSocket,
  makeConfig,
  collectMessages,
  oracleFrame,
} from "./harness.mjs";

const Z = zlib.constants;
const maskKey = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
const DEFLATE_TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

// ---------------------------------------------------------------------------
// Engine plumbing
// ---------------------------------------------------------------------------

function setup(overrides = {}) {
  const socket = makeFakeSocket();
  const closed = [];
  const errors = [];
  const handle = C._WebSocketCore_attach(
    socket,
    makeConfig({
      role: "server",
      onClose: (code, reason) => closed.push({ code, reason }),
      onError: (message) => errors.push(message),
      permessageDeflate: {
        role: "server",
        resetInboundPerMessage: false,
        serverMaxWindowBits: 15,
        clientMaxWindowBits: 15,
      },
      ...overrides,
    }),
  );
  const messages = collectMessages(handle);
  return {
    socket,
    handle,
    closed,
    errors,
    messages,
    settle: handle.readable.__settle,
  };
}

function msgBytes(message) {
  const view = message.view;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function msgStrings(messages) {
  return messages.map((m) => msgBytes(m).toString("utf8"));
}

// Poll until `pred()` holds; the deadline is a failure of the test, never a
// silent pass. Absence assertions (no delivery) additionally break on the
// first delivery so a broken implementation fails fast instead of hanging.
async function waitFor(pred, what, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out: " + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Oracle payloads (node zlib, independent of the kernel)
// ---------------------------------------------------------------------------

// ONE persistent deflater across messages, Z_SYNC_FLUSH after each, with the
// trailing 00 00 FF FF stripped: a real take-over stream whose later messages
// carry cross-message back-references (RFC 7692 §7.2.2).
function persistentPayloads(messages) {
  return new Promise((resolve, reject) => {
    const deflater = zlib.createDeflateRaw({ windowBits: 15 });
    const parts = [];
    deflater.on("data", (c) => parts.push(c));
    deflater.on("error", reject);
    const out = [];
    let i = 0;
    const step = () => {
      if (i === messages.length) {
        deflater.close();
        resolve(out);
        return;
      }
      deflater.write(messages[i]);
      deflater.flush(Z.Z_SYNC_FLUSH, () => {
        const joined = Buffer.concat(parts.splice(0));
        out.push(joined.subarray(0, joined.length - DEFLATE_TRAILER.length));
        i += 1;
        step();
      });
    };
    step();
  });
}

// One fresh deflater per message (Z_SYNC_FLUSH, trailer stripped): decodes
// under resetInboundPerMessage true AND false (it never references history).
function freshPayload(bytes) {
  const d = zlib.deflateRawSync(bytes, { finishFlush: Z.Z_SYNC_FLUSH });
  return d.subarray(0, d.length - DEFLATE_TRAILER.length);
}

// level 0 => stored blocks only (RFC 1951 §3.2.4), so a cut strictly inside
// the block's data area leaves the DEFLATE sequence incomplete and a cut on
// the last 5 bytes excluded: truncation detection is deterministic, not
// heuristic (§2 documented limit 1).
function storedPayload(bytes) {
  return zlib.deflateRawSync(bytes, { level: 0 });
}

async function payloadsFor(reset, messages) {
  return reset ? messages.map(freshPayload) : persistentPayloads(messages);
}

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

function compFrame(payload, opts = {}) {
  return oracleFrame({
    rsv: 4,
    opcode: 0x1,
    payload,
    mask: true,
    maskKey,
    ...opts,
  });
}

function contFrame(payload, opts = {}) {
  return oracleFrame({
    rsv: 0,
    opcode: 0x0,
    payload,
    mask: true,
    maskKey,
    ...opts,
  });
}

function plainFrame(payload, opts = {}) {
  return oracleFrame({
    rsv: 0,
    opcode: 0x1,
    payload,
    mask: true,
    maskKey,
    ...opts,
  });
}

function closeCode(closed) {
  return closed.length > 0 ? closed[0].code : null;
}

// ---------------------------------------------------------------------------
// §5a(a): pending-window ordering, BOTH context modes
// ---------------------------------------------------------------------------

const ORDER_MODES = [
  { reset: true, label: "resetInboundPerMessage: true" },
  { reset: false, label: "resetInboundPerMessage: false" },
];

for (const mode of ORDER_MODES) {
  test(`§5a(a) pending window: two separate feeds stay in order — ${mode.label}`, async () => {
    const env = setup({
      permessageDeflate: {
        role: "server",
        resetInboundPerMessage: mode.reset,
        serverMaxWindowBits: 15,
        clientMaxWindowBits: 15,
      },
    });
    const texts = [
      Buffer.from("order-one:" + "x".repeat(400), "utf8"),
      Buffer.from("order-two:" + "y".repeat(400), "utf8"),
    ];
    const wire = await payloadsFor(mode.reset, texts);

    env.socket.feed(compFrame(wire[0]));
    env.socket.feed(compFrame(wire[1])); // arrives while msg1's decode is pending

    await waitFor(
      () => env.messages.length >= 2 || env.closed.length > 0,
      "both ordered messages",
    );
    assert.deepEqual(env.messages.map(msgBytes), texts);
    assert.deepEqual(env.closed, []);
    assert.deepEqual(env.errors, []);
  });

  test(`§5a(a) variant: msg2 fragmented across two frames — ${mode.label}`, async () => {
    const env = setup({
      permessageDeflate: {
        role: "server",
        resetInboundPerMessage: mode.reset,
        serverMaxWindowBits: 15,
        clientMaxWindowBits: 15,
      },
    });
    const texts = [
      Buffer.from("frag-one:" + "a".repeat(300), "utf8"),
      Buffer.from("frag-two:" + "b".repeat(600), "utf8"),
    ];
    const wire = await payloadsFor(mode.reset, texts);
    const cut = Math.floor(wire[1].length / 2);

    env.socket.feed(compFrame(wire[0]));
    env.socket.feed(compFrame(wire[1].subarray(0, cut), { fin: false }));
    env.socket.feed(contFrame(wire[1].subarray(cut), { fin: true }));

    await waitFor(
      () => env.messages.length >= 2 || env.closed.length > 0,
      "both ordered messages (fragmented msg2)",
    );
    assert.deepEqual(env.messages.map(msgBytes), texts);
    assert.deepEqual(env.closed, []);
    assert.deepEqual(env.errors, []);
  });

  test(`§5a(a) variant: plain (non-RSV1) msg2 after compressed msg1 — ${mode.label}`, async () => {
    const env = setup({
      permessageDeflate: {
        role: "server",
        resetInboundPerMessage: mode.reset,
        serverMaxWindowBits: 15,
        clientMaxWindowBits: 15,
      },
    });
    const first = Buffer.from("plain-after:" + "p".repeat(300), "utf8");
    const plain = Buffer.from("second message is not compressed", "utf8");
    const wire = await payloadsFor(mode.reset, [first]);

    env.socket.feed(compFrame(wire[0]));
    env.socket.feed(plainFrame(plain));

    await waitFor(
      () => env.messages.length >= 2 || env.closed.length > 0,
      "compressed then plain message",
    );
    assert.deepEqual(env.messages.map(msgBytes), [first, plain]);
    assert.deepEqual(env.closed, []);
    assert.deepEqual(env.errors, []);
  });

  test(`§5a(a) variant: three messages in three feeds — ${mode.label}`, async () => {
    const env = setup({
      permessageDeflate: {
        role: "server",
        resetInboundPerMessage: mode.reset,
        serverMaxWindowBits: 15,
        clientMaxWindowBits: 15,
      },
    });
    const texts = [
      Buffer.from("three-one:" + "1".repeat(200), "utf8"),
      Buffer.from("three-two:" + "2".repeat(200), "utf8"),
      Buffer.from("three-three:" + "3".repeat(200), "utf8"),
    ];
    const wire = await payloadsFor(mode.reset, texts);

    env.socket.feed(compFrame(wire[0]));
    env.socket.feed(compFrame(wire[1]));
    env.socket.feed(compFrame(wire[2]));

    await waitFor(
      () => env.messages.length >= 3 || env.closed.length > 0,
      "three ordered messages",
    );
    assert.deepEqual(env.messages.map(msgBytes), texts);
    assert.deepEqual(env.closed, []);
    assert.deepEqual(env.errors, []);
  });
}

// ---------------------------------------------------------------------------
// §5a(b): truncated DEFLATE (n8) — 1002, nothing delivered, no overtaking
// ---------------------------------------------------------------------------

test("§5a(b) truncated DEFLATE 62 60 => 1002, following frame not delivered", async () => {
  const env = setup({
    permessageDeflate: {
      role: "server",
      resetInboundPerMessage: true,
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 15,
    },
  });
  env.socket.feed(compFrame(Buffer.from([0x62, 0x60])));
  env.socket.feed(plainFrame(Buffer.from("must never overtake the 1002")));

  await waitFor(
    () => env.closed.length > 0 || env.messages.length > 0,
    "1002 for the truncated payload",
  );
  assert.equal(closeCode(env.closed), 1002, "truncated DEFLATE closes 1002");
  assert.equal(env.messages.length, 0, "no fabricated bytes delivered");
  assert.equal(env.errors.length, 1);
});

// ---------------------------------------------------------------------------
// §5a(c): RSV1 policy
// ---------------------------------------------------------------------------

test("§5a(c) RSV1 on a continuation => 1002", () => {
  const env = setup();
  env.socket.feed(compFrame(Buffer.alloc(8, 0x11), { fin: false }));
  env.socket.feed(contFrame(Buffer.alloc(4, 0x22), { rsv: 4, fin: true }));
  env.socket.flushWrites();
  assert.equal(closeCode(env.closed), 1002);
  assert.equal(env.messages.length, 0);
});

test("§5a(c) RSV1 on a control frame => 1002", () => {
  const env = setup();
  env.socket.feed(
    oracleFrame({
      rsv: 4,
      opcode: 0x9,
      payload: Buffer.alloc(0),
      mask: true,
      maskKey,
    }),
  );
  env.socket.flushWrites();
  assert.equal(closeCode(env.closed), 1002);
  assert.equal(env.messages.length, 0);
});

test("§5a(c) RSV1 with permessageDeflate null => 1002", () => {
  const env = setup({ permessageDeflate: null });
  env.socket.feed(compFrame(storedPayload(Buffer.from("denied"))));
  env.socket.flushWrites();
  assert.equal(closeCode(env.closed), 1002);
  assert.equal(env.messages.length, 0);
});

// ---------------------------------------------------------------------------
// §5a(d): accumulation bound (§2 step 0)
// ---------------------------------------------------------------------------

test("§5a(d) compressed accumulation past 2*maxMessageSize+65536 => 1009", () => {
  const maxMessageSize = 4096;
  const limit = 2 * maxMessageSize + 65536;
  const env = setup({ maxMessageSize });

  // First frame (RSV1, no FIN) plus two continuations: 60000 bytes accumulated,
  // still inside the policy bound.
  env.socket.feed(compFrame(Buffer.alloc(20000, 0x5a), { fin: false }));
  env.socket.feed(contFrame(Buffer.alloc(20000, 0x5b), { fin: false }));
  env.socket.feed(contFrame(Buffer.alloc(20000, 0x5c), { fin: false }));
  env.socket.flushWrites();
  assert.equal(60000 <= limit, true);
  assert.deepEqual(env.closed, [], "60000 bytes is under the bound");
  assert.equal(env.messages.length, 0);

  // Fourth frame pushes the accumulated total past the bound.
  env.socket.feed(contFrame(Buffer.alloc(20000, 0x5d), { fin: false }));
  env.socket.flushWrites();
  assert.equal(80000 > limit, true);
  assert.equal(closeCode(env.closed), 1009);
  assert.equal(env.messages.length, 0, "no message delivered");
});

// ---------------------------------------------------------------------------
// §5a(e): zero-length compressed payload => empty message, no zlib call
// ---------------------------------------------------------------------------

test("§5a(e) zero-length compressed payload delivers the empty message", async () => {
  const env = setup({
    permessageDeflate: {
      role: "server",
      resetInboundPerMessage: true,
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 15,
    },
  });
  env.socket.feed(compFrame(Buffer.alloc(0)));

  await waitFor(
    () => env.messages.length >= 1 || env.closed.length > 0,
    "empty message",
  );
  assert.equal(env.messages.length, 1);
  assert.equal(msgBytes(env.messages[0]).length, 0);
  assert.equal(env.messages[0].kind, "text");
  assert.deepEqual(env.closed, []);
  assert.deepEqual(env.errors, []);
});

// ---------------------------------------------------------------------------
// §5a(f): bounded, SEEDED corpus (200 valid + 50 mid-block truncations)
// ---------------------------------------------------------------------------

// mulberry32: tiny seeded PRNG -- no wall-clock randomness anywhere.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededMessages(rng, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const len = 64 + Math.floor(rng() * 4000);
    const bytes = Buffer.alloc(len);
    for (let j = 0; j < len; j += 1) bytes[j] = Math.floor(rng() * 256);
    out.push(bytes);
  }
  return out;
}

test("§5a(f) seeded corpus: 200 valid stored-block messages decode byte-exact", async () => {
  const rng = mulberry32(0xc0ffee);
  const messages = seededMessages(rng, 200);
  const wire = messages.map(storedPayload);

  const env = setup({
    permessageDeflate: {
      role: "server",
      resetInboundPerMessage: true,
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 15,
    },
  });
  for (const payload of wire) {
    env.socket.feed(compFrame(payload, { opcode: 0x2 }));
  }

  await waitFor(
    () => env.messages.length >= 200 || env.closed.length > 0,
    "200 valid corpus messages",
    10000,
  );
  assert.equal(env.messages.length, 200);
  assert.deepEqual(env.closed, []);
  assert.deepEqual(env.errors, []);
  for (let i = 0; i < 200; i += 1) {
    assert.deepEqual(msgBytes(env.messages[i]), messages[i], "message " + i);
  }
});

test("§5a(f) seeded corpus: 50 cuts strictly inside the payload => 1002, no delivery", async () => {
  const rng = mulberry32(0x5eed1234);
  const messages = seededMessages(rng, 50);

  for (let i = 0; i < messages.length; i += 1) {
    const payload = storedPayload(messages[i]);
    // Strictly inside the stored block's data area and never within the last
    // 8 bytes: the payload cannot be completed by anything the receiver
    // appends, so it must be rejected (never a shorter valid message).
    const cut = 8 + Math.floor(rng() * (payload.length - 16));
    assert.ok(
      cut > 5 && cut <= payload.length - 8,
      "cut stays inside the block",
    );

    const env = setup({
      permessageDeflate: {
        role: "server",
        resetInboundPerMessage: true,
        serverMaxWindowBits: 15,
        clientMaxWindowBits: 15,
      },
    });
    env.socket.feed(compFrame(payload.subarray(0, cut), { opcode: 0x2 }));

    await waitFor(
      () => env.closed.length > 0 || env.messages.length > 0,
      "1002 for corpus truncation " + i,
    );
    assert.equal(closeCode(env.closed), 1002, "truncation " + i);
    assert.equal(env.messages.length, 0, "no delivery for truncation " + i);
  }
});

// ---------------------------------------------------------------------------
// §5a(g): take-over evidence with real cross-message back-references
// ---------------------------------------------------------------------------

test("§5a(g) take-over: 6 repetitive messages, tens of bytes on the wire, byte-exact", async () => {
  const texts = [];
  for (let i = 0; i < 6; i += 1) {
    texts.push(Buffer.from(("Block-" + i + ":").repeat(2000), "utf8"));
  }
  const wire = await persistentPayloads(texts);
  for (let i = 0; i < wire.length; i += 1) {
    assert.ok(
      wire[i].length < 200,
      "message " +
        i +
        " must be tiny on the wire (was " +
        wire[i].length +
        "B)",
    );
  }

  const env = setup({
    permessageDeflate: {
      role: "server",
      resetInboundPerMessage: false,
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 15,
    },
  });
  for (let i = 0; i < 6; i += 1) {
    env.socket.feed(compFrame(wire[i]));
  }

  await waitFor(
    () => env.messages.length >= 6 || env.closed.length > 0,
    "6 take-over messages",
  );
  assert.equal(env.messages.length, 6);
  assert.deepEqual(env.closed, []);
  assert.deepEqual(env.errors, []);
  for (let i = 0; i < 6; i += 1) {
    assert.deepEqual(
      msgBytes(env.messages[i]),
      texts[i],
      "take-over message " + i,
    );
  }
});

// ---------------------------------------------------------------------------
// §5a(h)/(i) — COMPRESSED-ONLY variants (D2a): the uncompressed 1009/1007
// paths are already pinned in framing.test.mjs (:655-680, :277-289), so these
// add exactly the *decompressed-bytes* cases the file lacked.
//
// These are REGRESSION PINS, not failing-before tests: the pre-edit kernel
// already implements both (decompressed-size cap and post-decompression UTF-8),
// so their pre-edit-kernel run is GREEN -- recorded, never fabricated, in
// goals/implement-rfc-7692-permessage-deflate-in-gren-la/artifacts/cycle3-sg1-n14-pins.md.
// ---------------------------------------------------------------------------

test("§5a(h1) decompressed size == maxMessageSize is delivered byte-exact", async () => {
  const maxMessageSize = 65536;
  const payload = Buffer.alloc(maxMessageSize, 0x61);
  payload.write("END-OF-CAP-PAYLOAD", maxMessageSize - 18, "utf8");
  const env = setup({ maxMessageSize });

  env.socket.feed(compFrame(freshPayload(payload)));

  await waitFor(
    () => env.messages.length >= 1 || env.closed.length > 0,
    "cap-sized message delivered",
  );
  assert.deepEqual(env.closed, [], "nothing closed at exactly the cap");
  assert.equal(env.messages.length, 1);
  assert.deepEqual(
    msgBytes(env.messages[0]),
    payload,
    "the delivered payload is byte-exact (a truncation at the cap must fail)",
  );
});

test("§5a(h2) decompressed size == maxMessageSize + 1 => one 1009, nothing delivered", async () => {
  const maxMessageSize = 65536;
  const payload = Buffer.alloc(maxMessageSize + 1, 0x61);
  const env = setup({ maxMessageSize });

  env.socket.feed(compFrame(freshPayload(payload)));

  await waitFor(
    () => env.closed.length > 0 || env.messages.length > 0,
    "1009 for cap + 1",
  );
  assert.equal(closeCode(env.closed), 1009, "one over the cap closes 1009");
  assert.equal(env.closed.length, 1, "exactly one close");
  assert.equal(env.messages.length, 0, "no partial bytes delivered");
});

test("§5a(i) post-decompression invalid UTF-8 (text) => one 1007, nothing delivered", async () => {
  const env = setup({
    permessageDeflate: {
      role: "server",
      resetInboundPerMessage: true,
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 15,
    },
  });
  // "hi" followed by an invalid UTF-8 sequence: the compressed (RSV1, opcode
  // 0x1) message decompresses to bytes the text validator must reject.
  const payload = Buffer.from([0x68, 0x69, 0xc3, 0x28]);
  const compressed = freshPayload(payload);
  assert.equal(compressed.length > 0, true, "the payload is really compressed");

  env.socket.feed(compFrame(compressed));

  await waitFor(
    () => env.closed.length > 0 || env.messages.length > 0,
    "1007 for invalid UTF-8 after decompression",
  );
  assert.equal(
    closeCode(env.closed),
    1007,
    "invalid decompressed text closes 1007",
  );
  assert.equal(env.closed.length, 1, "exactly one close");
  assert.equal(env.messages.length, 0, "nothing delivered");
});
