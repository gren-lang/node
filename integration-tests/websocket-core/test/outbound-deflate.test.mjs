// SG2 §5.2 — outbound permessage-deflate codec (fake socket), cases 1-8.
//
// Judge: the independent, kernel-free RFC 7692 oracle in ./deflate-oracle.mjs
// (frame parser, message assembler, §7.2.1 inflate decoder). Nothing here
// shares code with src/Gren/Kernel/WebSocketCore.js, so a kernel bug cannot be
// compensated by a matching bug in the test.
//
// FAILING-BEFORE: this file is NEW in sg2, so it MUST be run against the
// pre-edit kernel copy (goals/.../artifacts/cycle4-sg2-before-WebSocketCore.js)
// in the scratch mirror described in the goal context; the raw failing output
// is recorded next to the live (green) run. Both runs are durably recorded in
// goals/implement-rfc-7692-permessage-deflate-in-gren-la/artifacts/.
//
// Notes that are easy to get wrong (all verified against this kernel):
//   * The fake socket defers EVERY write callback; the fragmented send path
//     issues the next fragment only from the previous write callback, so a
//     driver MUST pump `socket.flushWrites(null)` in a loop until the send
//     callback settles (see pumpWrites).
//   * The frame-layout formula is keyed to the EMITTED COMPRESSED length, which
//     the oracle exposes as the assembled group payload length.
//   * A client-role message uses ONE mask key across all its fragments.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import {
  WebSocketCore as C,
  makeFakeSocket,
  makeConfig,
  collectMessages,
  loadKernelWith,
  oracleFrame,
} from "./harness.mjs";
import {
  FRAME_TRAILER,
  parseFrames,
  assembleMessages,
  createInflateDecoder,
  decodeMessages,
} from "./deflate-oracle.mjs";

const Z = zlib.constants;
const TRAILER_LENGTH = FRAME_TRAILER.length;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const FRAGMENT = 16384;
const ROLES = ["server", "client"];
const MASK_KEY = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

// ---------------------------------------------------------------------------
// Deterministic payload builders (no wall-clock randomness anywhere)
// ---------------------------------------------------------------------------

// mulberry32: 32-bit seeded PRNG.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededBytes(length, seed) {
  const rng = mulberry32(seed);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256) & 0xff;
  return out;
}

// 4 KB "repeating pattern": a fixed 260-byte unit tiled to the requested
// length. Repetitive (so it compresses well) but with a period long enough
// that a retained stream's second copy carries a cross-message back-reference.
const PATTERN_UNIT = (() => {
  const unit = Buffer.alloc(260);
  for (let i = 0; i < 260; i++) unit[i] = i % 37;
  return unit;
})();

function repeatingPattern(length) {
  const out = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += PATTERN_UNIT.length) {
    PATTERN_UNIT.copy(
      out,
      offset,
      0,
      Math.min(PATTERN_UNIT.length, length - offset),
    );
  }
  return out;
}

function repetitiveText(length) {
  const unit = "The quick brown fox jumps over the lazy dog. ";
  return unit.repeat(Math.ceil(length / unit.length) + 1).slice(0, length);
}

// ---------------------------------------------------------------------------
// Independent reference compressors (test-side zlib; the kernel's peer)
// ---------------------------------------------------------------------------

// One fresh raw-DEFLATE message: write everything, Z_SYNC_FLUSH, strip the
// 4-byte §7.2.2 marker. Byte-identical to what the kernel emits for the first
// message on a fresh deflater with the same windowBits.
function freshCompressed(bytes, windowBits = 15) {
  const out = zlib.deflateRawSync(bytes, {
    windowBits,
    finishFlush: Z.Z_SYNC_FLUSH,
  });
  return Buffer.from(out.subarray(0, out.length - TRAILER_LENGTH));
}

// ONE persistent deflater across the given messages (write + Z_SYNC_FLUSH
// each, trailer stripped): a real take-over stream whose later messages carry
// cross-message back-references.
function retainedCompressed(messages, windowBits = 15) {
  return new Promise((resolve, reject) => {
    const deflater = zlib.createDeflateRaw({ windowBits });
    const parts = [];
    deflater.on("data", (chunk) => parts.push(chunk));
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
        out.push(
          Buffer.from(joined.subarray(0, joined.length - TRAILER_LENGTH)),
        );
        i += 1;
        step();
      });
    };
    step();
  });
}

// ---------------------------------------------------------------------------
// Engine plumbing / drivers
// ---------------------------------------------------------------------------

function rolePmd(role, overrides = {}) {
  return {
    role,
    resetInboundPerMessage: false,
    resetOutboundPerMessage: false,
    serverMaxWindowBits: 15,
    clientMaxWindowBits: 15,
    ...overrides,
  };
}

function makeEnv(kernel, { role = "server", permessageDeflate = null } = {}) {
  const socket = makeFakeSocket();
  const closed = [];
  const errors = [];
  const handle = kernel._WebSocketCore_attach(
    socket,
    makeConfig({
      role,
      permessageDeflate,
      onClose: (code, reason) => closed.push({ code, reason }),
      onError: (message) => errors.push(message),
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function drain(turns = 6) {
  for (let i = 0; i < turns; i++) await tick();
}

async function waitFor(pred, what, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out: " + what);
    await tick();
  }
}

// Pump the fake socket's deferred write callbacks until `done()` holds. The
// fragmented send path only issues the next frame from the previous frame's
// write callback, so one flushWrites() is never enough for a multi-frame
// message.
async function pumpWrites(socket, done, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (done()) return;
    if (Date.now() > deadline) throw new Error("pumpWrites timed out");
    if (socket.writeCallbacks.length > 0) socket.flushWrites(null);
    await tick();
  }
}

function framesOf(socket) {
  return parseFrames(Buffer.concat(socket.writes));
}

function messagesOf(socket) {
  return assembleMessages(framesOf(socket));
}

// The number of frames a message must occupy on the wire: the fragment rule is
// applied to the EMITTED COMPRESSED payload (never the decoded length).
function expectedFrameCount(group) {
  return Math.max(1, Math.ceil(group.payload.length / FRAGMENT));
}

// Decode ONE message payload on a FRESH inflate stream; never throws, so a
// rejection (the discriminator for an omitted outbound reset) is observable.
async function tryDecodeStandalone(payload, options = {}) {
  const decoder = createInflateDecoder(options);
  try {
    const value = await decoder.decode(payload);
    await decoder.close();
    return { ok: true, value };
  } catch (error) {
    // The stream is already dead; closing it may never call back, so leak it.
    return { ok: false, error };
  }
}

// Index of the last Close frame, or -1. Used to assert that no data frame can
// reach the socket after our Close (§3.3).
function lastCloseIndex(frames) {
  let index = -1;
  frames.forEach((frame, i) => {
    if (frame.opcode === OP_CLOSE) index = i;
  });
  return index;
}

function assertNoFrameAfterClose(frames) {
  const closeAt = lastCloseIndex(frames);
  assert.ok(closeAt >= 0, "expected a Close frame on the wire");
  for (let i = closeAt + 1; i < frames.length; i++) {
    assert.fail(
      `frame ${i} (opcode 0x${frames[i].opcode.toString(16)}) reached the wire after the Close frame`,
    );
  }
}

// ---------------------------------------------------------------------------
// §5.2 case 1 — round-trip matrix
// ---------------------------------------------------------------------------

const BOUNDARY_SIZES = [0, 1, 125, 126, 127];

function roundTripEntries() {
  const entries = [];
  for (const size of BOUNDARY_SIZES) {
    entries.push({
      label: `text ${size}B`,
      kind: "text",
      value: "t".repeat(size),
    });
    entries.push({
      label: `binary ${size}B`,
      kind: "binary",
      value: Buffer.alloc(size, 0x5a),
    });
  }
  entries.push({
    label: "binary 200KB incompressible",
    kind: "binary",
    value: seededBytes(200 * 1024, 0x5ee1),
  });
  entries.push({
    label: "text 200KB repetitive",
    kind: "text",
    value: repetitiveText(200 * 1024),
  });
  return entries;
}

for (const role of ROLES) {
  for (const entry of roundTripEntries()) {
    test(`case 1 round-trip ${role} ${entry.label}`, async () => {
      const env = makeEnv(C, { role, permessageDeflate: rolePmd(role) });
      const settles = [];
      const callback = (err) => settles.push(err ?? null);
      if (entry.kind === "text") env.handle.sendText(entry.value, callback);
      else env.handle.sendBytes(entry.value, callback);
      await pumpWrites(env.socket, () => settles.length === 1);
      await drain(2);

      assert.deepEqual(
        settles,
        [null],
        "the send callback settles exactly once, cleanly",
      );

      const { messages, controlFrames } = messagesOf(env.socket);
      assert.equal(controlFrames.length, 0);
      assert.equal(messages.length, 1, "one send produces one message group");

      const [group] = messages;
      assert.equal(
        group.opcode,
        entry.kind === "text" ? OP_TEXT : OP_BINARY,
        "the frame opcode carries the message kind",
      );
      assert.equal(
        group.rsv1,
        true,
        "an emitted data message is compressed (RSV1)",
      );
      assert.equal(
        group.frames.every((frame) => frame.masked === (role === "client")),
        true,
        role === "client"
          ? "client frames are masked"
          : "server frames are unmasked",
      );

      const expected =
        entry.kind === "text" ? Buffer.from(entry.value, "utf8") : entry.value;
      const [decoded] = await decodeMessages(messages, {});
      assert.ok(
        decoded.equals(expected),
        `oracle decode mismatch for ${entry.label} (got ${decoded.length}B, want ${expected.length}B)`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// §5.2 case 2 — RSV1 placement and frame layout (keyed to COMPRESSED length)
// ---------------------------------------------------------------------------

test("case 2 single-frame message carries rsv === 4 and FIN", async () => {
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  const settles = [];
  env.handle.sendText("short and sweet", (err) => settles.push(err ?? null));
  await pumpWrites(env.socket, () => settles.length === 1);

  const { messages } = messagesOf(env.socket);
  const frames = messages[0].frames;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].rsv, 4, "RSV1 is set on the single frame");
  assert.equal(frames[0].fin, true);
});

for (const role of ROLES) {
  test(`case 2 multi-fragment layout follows the emitted compressed length (${role})`, async () => {
    const payload = seededBytes(200 * 1024, 0x134b);
    const env = makeEnv(C, { role, permessageDeflate: rolePmd(role) });
    const settles = [];
    env.handle.sendBytes(payload, (err) => settles.push(err ?? null));
    await pumpWrites(env.socket, () => settles.length === 1);
    await drain(2);

    const { messages, controlFrames } = messagesOf(env.socket);
    assert.equal(controlFrames.length, 0);
    assert.equal(messages.length, 1);

    const [group] = messages;
    const compressedLen = group.payload.length;
    assert.ok(
      compressedLen > FRAGMENT,
      `stimulus must exceed one fragment on the wire (emitted ${compressedLen}B)`,
    );

    const expectedFrames = Math.ceil(compressedLen / FRAGMENT);
    assert.equal(
      group.frames.length,
      expectedFrames,
      "ceil(compressedLen / 16384)",
    );
    assert.ok(expectedFrames >= 2);

    group.frames.forEach((frame, index) => {
      assert.equal(
        frame.rsv,
        index === 0 ? 4 : 0,
        `rsv on frame ${index} (first frame only)`,
      );
      assert.equal(
        frame.fin,
        index === group.frames.length - 1,
        `FIN on frame ${index}`,
      );
      assert.equal(
        frame.opcode,
        index === 0 ? OP_BINARY : OP_CONTINUATION,
        `opcode on frame ${index}`,
      );
    });
    assert.ok(
      group.payload.equals(freshCompressed(payload)),
      "emitted bytes are the fresh compression",
    );

    const [decoded] = await decodeMessages(messages, {});
    assert.ok(
      decoded.equals(payload),
      "the multi-frame group decodes to the input",
    );
  });
}

test("case 2 a compressible 200KB message is ONE frame (never the decoded length)", async () => {
  const payload = Buffer.from(repetitiveText(200 * 1024), "utf8");
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  const settles = [];
  env.handle.sendText(payload.toString("utf8"), (err) =>
    settles.push(err ?? null),
  );
  await pumpWrites(env.socket, () => settles.length === 1);

  const { messages } = messagesOf(env.socket);
  assert.equal(
    messages[0].frames.length,
    1,
    "small compressed payload => a single frame",
  );
  assert.equal(messages[0].rsv1, true);
  const [decoded] = await decodeMessages(messages, {});
  assert.ok(decoded.equals(payload));
});

test("case 2 control frames carry rsv === 0 (auto-pong and Close)", async () => {
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });

  const settles = [];
  env.handle.sendBytes(seededBytes(100 * 1024, 0x9a), (err) =>
    settles.push(err ?? null),
  );
  await pumpWrites(env.socket, () => settles.length === 1);

  // Inbound ping => automatic pong (the peer of a server MUST mask).
  env.socket.feed(
    oracleFrame({
      fin: true,
      rsv: 0,
      opcode: OP_PING,
      payload: Buffer.from("ping!"),
      mask: true,
      maskKey: MASK_KEY,
    }),
  );
  await drain(3);

  const closeSettles = [];
  env.handle.close(1000, "bye", (err) => closeSettles.push(err ?? null));
  await pumpWrites(env.socket, () => closeSettles.length === 1);

  const frames = framesOf(env.socket);
  const controls = frames.filter((frame) => frame.opcode >= OP_CLOSE);
  assert.equal(controls.length, 2, "expected exactly the pong and the Close");
  for (const frame of controls) {
    assert.equal(
      frame.rsv,
      0,
      `control opcode 0x${frame.opcode.toString(16)} must carry rsv === 0`,
    );
    assert.equal(frame.fin, true);
  }
  const pong = controls.find((frame) => frame.opcode === OP_PONG);
  assert.ok(pong, "a pong was emitted for the ping");
  assert.ok(pong.payload.equals(Buffer.from("ping!")));
  const close = controls.find((frame) => frame.opcode === OP_CLOSE);
  assert.equal(close.payload.readUInt16BE(0), 1000);
  // The compressed data message kept RSV1; the controls stayed clear.
  assert.equal(frames[0].rsv, 4);
});

test("case 2 a client-role fragmented message reuses ONE mask key", async () => {
  const env = makeEnv(C, {
    role: "client",
    permessageDeflate: rolePmd("client"),
  });
  const settles = [];
  env.handle.sendBytes(seededBytes(200 * 1024, 0x77b1), (err) =>
    settles.push(err ?? null),
  );
  await pumpWrites(env.socket, () => settles.length === 1);

  const { messages } = messagesOf(env.socket);
  const frames = messages[0].frames;
  assert.ok(frames.length >= 2, "stimulus must fragment");
  const keys = new Set(frames.map((frame) => frame.maskKey.toString("hex")));
  assert.equal(keys.size, 1, "one mask key per MESSAGE, never per fragment");
  assert.equal(
    frames.every((frame) => frame.masked),
    true,
  );
});

// ---------------------------------------------------------------------------
// §5.2 case 3 — boundary splitting (anti-single-write)
// ---------------------------------------------------------------------------

test("case 3a two sends in one macrotask stay separate and in order", async () => {
  const A = Buffer.from("A".repeat(1000) + "|marker-A|");
  const B = Buffer.from("B".repeat(3000) + "|marker-B|");
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server", { resetOutboundPerMessage: true }),
  });

  const settles = [];
  const cb = (err) => settles.push(err ?? null);
  env.handle.sendText(A.toString("utf8"), cb);
  env.handle.sendText(B.toString("utf8"), cb); // same macrotask, before any flush callback
  await pumpWrites(env.socket, () => settles.length === 2);
  await drain(3);

  assert.deepEqual(settles, [null, null], "exactly one settle per send");
  const { messages, controlFrames } = messagesOf(env.socket);
  assert.equal(controlFrames.length, 0);
  assert.equal(messages.length, 2, "two sends => two message groups, in order");
  assert.equal(lastCloseIndex(framesOf(env.socket)), -1);

  // resetOutboundPerMessage => each group is a standalone stream; an
  // accumulator that leaked A's bytes into B (or merged them) cannot decode.
  for (const [index, expected] of [A, B].entries()) {
    const standalone = await tryDecodeStandalone(messages[index].payload);
    assert.ok(
      standalone.ok,
      `group ${index} decodes standalone (no leaked accumulator)`,
    );
    assert.ok(
      standalone.value.equals(expected),
      `group ${index} decodes to its own input (got ${standalone.value.length}B, want ${expected.length}B)`,
    );
  }
  for (const group of messages) {
    assert.equal(
      group.frames.length,
      expectedFrameCount(group),
      "frame count follows the emitted compressed length",
    );
  }
});

test("case 3b sendText immediately followed by close()", async () => {
  const payload = Buffer.from("payload ahead of the close " + "z".repeat(400));
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server", { resetOutboundPerMessage: true }),
  });

  const sendSettles = [];
  const closeSettles = [];
  env.handle.sendText(payload.toString("utf8"), (err) =>
    sendSettles.push(err ?? null),
  );
  env.handle.close(1000, "later", (err) => closeSettles.push(err ?? null));
  await pumpWrites(
    env.socket,
    () => sendSettles.length === 1 && closeSettles.length === 1,
  );
  await drain(2);

  assert.deepEqual(sendSettles, [null]);
  assert.deepEqual(closeSettles, [null]);

  const frames = framesOf(env.socket);
  const { messages, controlFrames } = assembleMessages(frames);
  assert.equal(
    messages.length,
    1,
    "the accepted message is delivered before Close",
  );
  assert.equal(controlFrames.length, 1);
  assert.equal(
    frames[frames.length - 1].opcode,
    OP_CLOSE,
    "the Close frame is last",
  );
  assert.equal(messages[0].frames.length, expectedFrameCount(messages[0]));
  assert.equal(controlFrames[0].rsv, 0);
  assert.ok(
    controlFrames[0].payload.equals(
      Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("later")]),
    ),
  );
  assertNoFrameAfterClose(frames);

  const standalone = await tryDecodeStandalone(messages[0].payload);
  assert.ok(standalone.ok && standalone.value.equals(payload));
});

test("case 3c a fragment-bearing message races close()", async () => {
  const payload = seededBytes(200 * 1024, 0x3c3c);
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server", { resetOutboundPerMessage: true }),
  });

  const sendSettles = [];
  const closeSettles = [];
  env.handle.sendBytes(payload, (err) => sendSettles.push(err ?? null));
  await waitFor(
    () => env.socket.writes.length > 0,
    "the first fragment reaches the socket",
  );
  env.handle.close(1000, "race", (err) => closeSettles.push(err ?? null));
  await pumpWrites(
    env.socket,
    () => sendSettles.length === 1 && closeSettles.length === 1,
  );
  await drain(2);

  assert.deepEqual(sendSettles, [null]);
  assert.deepEqual(closeSettles, [null]);

  const frames = framesOf(env.socket);
  const { messages, controlFrames } = assembleMessages(frames);
  assert.equal(messages.length, 1);
  assert.equal(controlFrames.length, 1);
  assert.ok(
    messages[0].frames.length >= 2,
    "the racing message really is fragmented",
  );
  assert.equal(messages[0].frames.length, expectedFrameCount(messages[0]));
  assert.equal(frames[frames.length - 1].opcode, OP_CLOSE);
  assertNoFrameAfterClose(frames);

  const [decoded] = await decodeMessages(messages, {});
  assert.ok(decoded.equals(payload));
});

test("case 3d negative: permessageDeflate === null stays synchronous and byte-identical", async () => {
  const A = "sync-A";
  const B = "sync-B";
  const env = makeEnv(C, { role: "server", permessageDeflate: null });

  const settles = [];
  const cb = (err) => settles.push(err ?? null);
  env.handle.sendText(A, cb);
  assert.equal(
    env.socket.writes.length,
    1,
    "the first frame is written inside the call",
  );
  env.handle.sendText(B, cb);
  assert.equal(env.socket.writes.length, 2, "the second frame too");
  const closeSettles = [];
  env.handle.close(undefined, undefined, (err) =>
    closeSettles.push(err ?? null),
  );
  assert.equal(
    env.socket.writes.length,
    3,
    "Close (no code) is written inside the call",
  );

  const expected = Buffer.concat([
    oracleFrame({
      fin: true,
      rsv: 0,
      opcode: OP_TEXT,
      payload: Buffer.from(A, "utf8"),
      mask: false,
    }),
    oracleFrame({
      fin: true,
      rsv: 0,
      opcode: OP_TEXT,
      payload: Buffer.from(B, "utf8"),
      mask: false,
    }),
    oracleFrame({
      fin: true,
      rsv: 0,
      opcode: OP_CLOSE,
      payload: Buffer.alloc(0),
      mask: false,
    }),
  ]);
  assert.ok(
    Buffer.concat(env.socket.writes).equals(expected),
    "the uncompressed path is byte-identical to the hand-built frames",
  );

  await pumpWrites(
    env.socket,
    () => settles.length === 2 && closeSettles.length === 1,
  );
  assert.deepEqual(settles, [null, null]);
  assert.deepEqual(closeSettles, [null]);
});

// ---------------------------------------------------------------------------
// §5.2 case 4 — four takeover combinations, correctly wired
// ---------------------------------------------------------------------------

const TAKEOVER_A = repeatingPattern(4096);
const TAKEOVER_B = Buffer.from(TAKEOVER_A); // the same bytes

const TAKEOVER_COMBOS = [
  { out: false, in: false },
  { out: false, in: true },
  { out: true, in: false },
  { out: true, in: true },
];

const comboLabel = (combo) =>
  `outbound reset ${combo.out}, inbound reset ${combo.in}`;

// Outbound observable: is the SECOND message's emitted payload decodable as a
// STANDALONE (fresh, history-free) DEFLATE stream? True iff our compressor
// reset between the two messages, i.e. iff resetOutboundPerMessage.
async function observeOutbound(kernel, role, combo, reference, freshB) {
  const env = makeEnv(kernel, {
    role,
    permessageDeflate: rolePmd(role, { resetOutboundPerMessage: combo.out }),
  });
  const settles = [];
  env.handle.sendBytes(TAKEOVER_A, (err) => settles.push(err ?? null));
  env.handle.sendBytes(TAKEOVER_B, (err) => settles.push(err ?? null));
  await pumpWrites(env.socket, () => settles.length === 2);
  await drain(2);

  const { messages, controlFrames } = messagesOf(env.socket);
  assert.equal(controlFrames.length, 0);
  assert.equal(messages.length, 2);
  assert.deepEqual(settles, [null, null]);
  assert.ok(
    messages[0].payload.equals(freshCompressed(TAKEOVER_A)),
    `${role}: the first message is a fresh compression`,
  );

  const second = await tryDecodeStandalone(messages[1].payload);
  if (combo.out) {
    assert.ok(
      messages[1].payload.equals(freshB),
      `${role}: with an outbound reset, B is byte-identical to a fresh compression`,
    );
    assert.ok(second.ok, "B decodes standalone");
  } else {
    assert.ok(
      messages[1].payload.equals(reference[1]),
      `${role}: without an outbound reset, B is byte-identical to the retained streamed reference`,
    );
    assert.equal(
      second.ok,
      false,
      "a fresh inflate must REJECT the history-compressed B",
    );
    assert.match(String(second.error.message), /invalid distance too far back/);
  }

  // Both messages in wire order still decode with a retained (no-reset) stream.
  const both = await decodeMessages(messages, { resetPerMessage: false });
  assert.ok(both[0].equals(TAKEOVER_A) && both[1].equals(TAKEOVER_B));

  return second.ok;
}

// Inbound observable: is a HISTORY-compressed B accepted? True iff the kernel
// does NOT reset the inflate context between messages, i.e. iff
// resetInboundPerMessage is false.
async function observeInbound(kernel, role, combo, reference) {
  const env = makeEnv(kernel, {
    role,
    permessageDeflate: rolePmd(role, { resetInboundPerMessage: combo.in }),
  });
  const wire = (payload) =>
    oracleFrame({
      fin: true,
      rsv: 4,
      opcode: OP_BINARY,
      payload,
      mask: role === "server",
      maskKey: role === "server" ? MASK_KEY : undefined,
    });

  env.socket.feed(wire(reference[0]));
  env.socket.feed(wire(reference[1]));
  await waitFor(
    () => (combo.in ? env.errors.length > 0 : env.messages.length === 2),
    `inbound outcome (${comboLabel(combo)}, ${role})`,
  );
  await drain(4);

  if (combo.in) {
    assert.equal(
      env.messages.length,
      1,
      "the history-compressed B must be rejected",
    );
    assert.equal(
      msgBytes(env.messages[0]).equals(TAKEOVER_A),
      true,
      "the first message is still delivered",
    );
    assert.deepEqual(
      env.errors,
      ["Invalid WebSocket frame: invalid compressed data"],
      "the §0.1 1002 error text",
    );
    assert.equal(env.settle.errored, true, "the readable errored");
    assert.equal(env.closed.length, 1);
    assert.equal(env.closed[0].code, 1002);
    const closeFrames = framesOf(env.socket).filter(
      (frame) => frame.opcode === OP_CLOSE,
    );
    assert.equal(closeFrames.length, 1, "a Close was answered");
    assert.equal(closeFrames[0].payload.readUInt16BE(0), 1002);
    assert.equal(closeFrames[0].rsv, 0);
    return false;
  }

  assert.equal(
    env.messages.length,
    2,
    "the history-compressed B decodes when the context is kept",
  );
  assert.deepEqual(env.errors, []);
  assert.equal(msgBytes(env.messages[0]).equals(TAKEOVER_A), true);
  assert.equal(msgBytes(env.messages[1]).equals(TAKEOVER_B), true);
  return true;
}

// Standalone-compressed B must decode under BOTH inbound settings (extra
// dictionary history is simply unused) -- a correct kernel must not be failed
// for this direction (§0.3(4)).
async function assertStandaloneInboundBothWays(
  kernel,
  role,
  reference,
  freshB,
) {
  for (const resetInbound of [false, true]) {
    const env = makeEnv(kernel, {
      role,
      permessageDeflate: rolePmd(role, {
        resetInboundPerMessage: resetInbound,
      }),
    });
    const wire = (payload) =>
      oracleFrame({
        fin: true,
        rsv: 4,
        opcode: OP_BINARY,
        payload,
        mask: role === "server",
        maskKey: role === "server" ? MASK_KEY : undefined,
      });
    env.socket.feed(wire(reference[0]));
    env.socket.feed(wire(freshB));
    await waitFor(
      () => env.messages.length === 2 || env.errors.length > 0,
      `standalone B under resetInboundPerMessage ${resetInbound}`,
    );
    assert.equal(
      env.messages.length,
      2,
      `standalone B decodes (reset ${resetInbound})`,
    );
    assert.deepEqual(env.errors, []);
    assert.ok(msgBytes(env.messages[1]).equals(TAKEOVER_B));
  }
}

for (const combo of TAKEOVER_COMBOS) {
  test(`case 4 takeover wired correctly — ${comboLabel(combo)}`, async () => {
    const reference = await retainedCompressed([TAKEOVER_A, TAKEOVER_B]);
    const freshB = freshCompressed(TAKEOVER_B);
    assert.ok(
      reference[0].equals(freshCompressed(TAKEOVER_A)),
      "guard: the retained stream's first chunk equals a fresh compression of A",
    );
    assert.ok(
      !reference[1].equals(freshB),
      "guard: the retained stream's B chunk differs from a fresh compression of B",
    );

    const observed = { outbound: {}, inbound: {} };
    for (const role of ROLES) {
      observed.outbound[role] = await observeOutbound(
        C,
        role,
        combo,
        reference,
        freshB,
      );
      observed.inbound[role] = await observeInbound(C, role, combo, reference);
    }
    for (const role of ROLES) {
      assert.equal(
        observed.outbound[role],
        combo.out,
        `${role}: the outbound behaviour follows resetOutboundPerMessage`,
      );
      // resetInboundPerMessage true drops the retained history, so the
      // history-compressed B is REJECTED: historyAccepted === !resetInbound.
      assert.equal(
        observed.inbound[role],
        !combo.in,
        `${role}: the inbound behaviour follows resetInboundPerMessage`,
      );
    }
    await assertStandaloneInboundBothWays(C, "server", reference, freshB);
  });
}

test("case 4 mutant: swapping the inbound/outbound flags is detectable", async () => {
  const reference = await retainedCompressed([TAKEOVER_A, TAKEOVER_B]);
  const freshB = freshCompressed(TAKEOVER_B);

  for (const combo of TAKEOVER_COMBOS) {
    const observedOutbound = await observeOutbound(
      C,
      "server",
      combo,
      reference,
      freshB,
    );
    const observedInbound = await observeInbound(C, "server", combo, reference);

    // The flags are wired to their own side when each observable matches the
    // flag that produced it ...
    assert.equal(observedOutbound, combo.out);
    assert.equal(observedInbound, !combo.in);

    // ... so for a mixed combination each observable CONTRADICTS the swapped
    // flag: a kernel that read resetOutboundPerMessage from
    // resetInboundPerMessage (or vice versa) fails right here.
    if (combo.out !== combo.in) {
      assert.notEqual(
        observedOutbound,
        combo.in,
        "the outbound observable would contradict a swapped flag",
      );
      assert.notEqual(
        observedInbound,
        !combo.out,
        "the inbound observable would contradict a swapped flag",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// §5.2 case 5 — window bits (§0.3(3) 60500-byte stimulus)
// ---------------------------------------------------------------------------

// 30000 seeded pseudo-random bytes + 500 filler + the SAME 30000 bytes: large
// enough and repetitive enough at 30 KB distance that a 9-bit compressor must
// emit a match beyond a 9-bit window.
const WINDOW_STIMULUS = (() => {
  const half = seededBytes(30000, 0x5eed1234);
  return Buffer.concat([half, Buffer.alloc(500, 0x41), half]);
})();

test("case 5 stimulus guard: it is incompressible inside a 512-byte window", () => {
  const ref9 = freshCompressed(WINDOW_STIMULUS, 9);
  const ref15 = freshCompressed(WINDOW_STIMULUS, 15);
  assert.ok(
    ref9.length >= 1.5 * ref15.length,
    `cap-9 reference must be materially larger (ref9 ${ref9.length}, ref15 ${ref15.length})`,
  );
  assert.ok(
    ref15.length < WINDOW_STIMULUS.length - 1000,
    "the stimulus must actually compress at a 15-bit window",
  );
});

test("case 5 a 15-bit stream is rejected by a cap-width inflate (oracle sanity)", async () => {
  const ref15 = freshCompressed(WINDOW_STIMULUS, 15);
  const decoded = await tryDecodeStandalone(ref15, { windowBits: 9 });
  assert.equal(
    decoded.ok,
    false,
    "a 9-bit inflate must detect the beyond-cap distance",
  );
  assert.match(String(decoded.error.message), /invalid distance too far back/);
});

test("case 5 cap 9 and cap 15 honour windowBits on the emitted stream", async () => {
  const ref9 = freshCompressed(WINDOW_STIMULUS, 9);
  const ref15 = freshCompressed(WINDOW_STIMULUS, 15);

  const emit = async (windowBits) => {
    const env = makeEnv(C, {
      role: "client",
      permessageDeflate: rolePmd("client", { clientMaxWindowBits: windowBits }),
    });
    const settles = [];
    env.handle.sendBytes(WINDOW_STIMULUS, (err) => settles.push(err ?? null));
    await pumpWrites(env.socket, () => settles.length === 1);
    await drain(2);
    assert.deepEqual(settles, [null]);
    const { messages } = messagesOf(env.socket);
    assert.equal(messages.length, 1);
    return messages[0].payload;
  };

  const emitted9 = await emit(9);
  const emitted15 = await emit(15);

  // (a) an independent cap-width inflate accepts our own cap-width stream.
  const accepted9 = await tryDecodeStandalone(emitted9, { windowBits: 9 });
  assert.ok(accepted9.ok, "a 9-bit inflate accepts the cap-9 stream");
  assert.ok(accepted9.value.equals(WINDOW_STIMULUS));
  const accepted15 = await tryDecodeStandalone(emitted15, { windowBits: 15 });
  assert.ok(accepted15.ok, "a 15-bit inflate accepts the cap-15 stream");
  assert.ok(accepted15.value.equals(WINDOW_STIMULUS));

  // (b) numeric threshold: emitted9 is incompatible with a cap-15 encoder and
  // not bloated beyond the cap-9 reference.
  assert.ok(
    emitted9.length >= 1.5 * ref15.length,
    `emitted9 (${emitted9.length}) must be >= 1.5 * ref15 (${ref15.length})`,
  );
  assert.ok(
    emitted9.length <= 1.5 * ref9.length,
    `emitted9 (${emitted9.length}) must be <= 1.5 * ref9 (${ref9.length})`,
  );
  assert.ok(
    emitted9.equals(ref9),
    "emitted9 matches an independent cap-9 reference",
  );
  assert.ok(
    emitted15.equals(ref15),
    "emitted15 matches an independent cap-15 reference",
  );

  // Complementary: the cap-15 stream really is beyond a 9-bit window.
  const rejected15 = await tryDecodeStandalone(emitted15, { windowBits: 9 });
  assert.equal(
    rejected15.ok,
    false,
    "the cap-15 stream needs the full 15-bit window",
  );
});

test("case 5 (c) an absent/unagreed cap falls back to 15 bits in both roles", async () => {
  const ref15 = freshCompressed(WINDOW_STIMULUS, 15);

  // Client role: the negotiated client_max_window_bits was never agreed.
  const clientEnv = makeEnv(C, {
    role: "client",
    permessageDeflate: {
      role: "client",
      resetInboundPerMessage: false,
      resetOutboundPerMessage: false,
      serverMaxWindowBits: 15,
      clientMaxWindowBits: null, // absent/unagreed => §7.1.2.2 default 15
    },
  });
  const clientSettles = [];
  clientEnv.handle.sendBytes(WINDOW_STIMULUS, (err) =>
    clientSettles.push(err ?? null),
  );
  await pumpWrites(clientEnv.socket, () => clientSettles.length === 1);
  assert.deepEqual(clientSettles, [null]);
  const clientMsg = messagesOf(clientEnv.socket).messages[0].payload;
  assert.ok(clientMsg.equals(ref15), "absent client cap => 15-bit output");

  // Server role: a hand-built config with no serverMaxWindowBits at all.
  const serverEnv = makeEnv(C, {
    role: "server",
    permessageDeflate: {
      role: "server",
      resetInboundPerMessage: false,
      resetOutboundPerMessage: false,
      clientMaxWindowBits: 15,
      // serverMaxWindowBits intentionally missing
    },
  });
  const serverSettles = [];
  serverEnv.handle.sendBytes(WINDOW_STIMULUS, (err) =>
    serverSettles.push(err ?? null),
  );
  await pumpWrites(serverEnv.socket, () => serverSettles.length === 1);
  assert.deepEqual(serverSettles, [null]);
  const serverMsg = messagesOf(serverEnv.socket).messages[0].payload;
  assert.ok(serverMsg.equals(ref15), "missing server cap => 15-bit output");
});

// ---------------------------------------------------------------------------
// §5.2 case 6 — empty message
// ---------------------------------------------------------------------------

test("case 6 an empty message emits the 1-byte payload 00 with RSV1", async () => {
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  const settles = [];
  env.handle.sendText("", (err) => settles.push(err ?? null));
  await pumpWrites(env.socket, () => settles.length === 1);

  const frames = framesOf(env.socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OP_TEXT);
  assert.equal(frames[0].rsv, 4);
  assert.equal(frames[0].fin, true);
  assert.deepEqual(
    frames[0].payload,
    Buffer.from([0x00]),
    "the §7.2.2 empty-message form",
  );

  const { messages } = messagesOf(env.socket);
  const [decoded] = await decodeMessages(messages, {});
  assert.equal(decoded.length, 0, "the oracle decodes it to the empty message");
});

test("case 6 empty message with retained context, before and after a non-empty one", async () => {
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  const settles = [];
  const expect = ["hello", "", "world"];

  for (const text of expect) {
    env.handle.sendText(text, (err) => settles.push(err ?? null));
    await pumpWrites(
      env.socket,
      () => settles.length === expect.indexOf(text) + 1,
    );
  }
  await drain(2);

  const { messages } = messagesOf(env.socket);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1].payload, Buffer.from([0x00]));
  const decoded = await decodeMessages(messages, {});
  assert.deepEqual(
    decoded.map((buf) => buf.toString("utf8")),
    expect,
  );
});

// ---------------------------------------------------------------------------
// §5.2 case 7 — lifecycle (fresh vm instance + proxied require)
// ---------------------------------------------------------------------------

// A fresh kernel whose sandbox require proxies node:zlib so createDeflateRaw
// / createInflateRaw are observable. `calls.closed` counts the 'close' event
// of every deflater stream (fires for both close() and destroy()).
function instrumentedKernel() {
  const base = createRequire(import.meta.url);
  const calls = { deflate: 0, inflate: 0, closed: 0 };
  const streams = [];
  const zlibProxy = {
    ...zlib,
    constants: zlib.constants,
    createDeflateRaw(options) {
      calls.deflate += 1;
      const stream = zlib.createDeflateRaw(options);
      stream.on("close", () => {
        calls.closed += 1;
      });
      streams.push(stream);
      return stream;
    },
    createInflateRaw(options) {
      calls.inflate += 1;
      return zlib.createInflateRaw(options);
    },
  };
  const requireImpl = (id) => (id === "node:zlib" ? zlibProxy : base(id));
  const kernel = loadKernelWith(
    requireImpl,
    "src/Gren/Kernel/WebSocketCore.js",
  );
  return { kernel, calls, streams };
}

test("case 7a attach without sending allocates no deflater", async () => {
  const { kernel, calls } = instrumentedKernel();
  const env = makeEnv(kernel, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  await drain(4);
  assert.equal(
    calls.deflate,
    0,
    "a connection that never sends must create no deflater",
  );
  assert.equal(calls.inflate, 0);
  assert.equal(env.socket.writes.length, 0);
});

// BLOCKING FINDING (see the hand-off): this stimulus destroys a handle while a
// compressed send's deflate flush is still in flight, which drives
// outboundDiscardDeflater()'s flush-pending branch:
//     outboundDeflaterPendingClose = deflater;
//     try { deflater.reset(); } catch (e) {}
// On node 20.20.2 `deflater.reset()` while an async write/flush is in progress
// is a use-after-free (fixed upstream by nodejs/node commit 53bcd114b100; node
// >= the fix throws "Cannot reset zlib stream while a write is in progress").
// Measured here: the whole test process aborts with SIGSEGV/SIGABRT/SIGTRAP,
// 6/6 runs. The counts assertion below is correct and passes; the process dies
// only because of that reset(). Dropping the reset() (the deferred close alone
// is what §3.3 asks for) makes this case green.
test("case 7b 200 x (attach -> send -> destroy) leaks no deflater", async () => {
  const { kernel, calls } = instrumentedKernel();
  const iterations = 200;
  for (let i = 0; i < iterations; i++) {
    const env = makeEnv(kernel, {
      role: "server",
      permessageDeflate: rolePmd("server"),
    });
    // destroy() while the compressed send is in flight: the teardown path.
    env.handle.sendText("hello world ".repeat(50), () => {});
    env.handle.destroy();
  }
  assert.equal(
    calls.deflate,
    iterations,
    "one deflater per sending connection",
  );
  // The drain boundary matters: a teardown deferred behind the pending zlib
  // flush callback must not be counted as a leak.
  await waitFor(
    () => calls.closed === calls.deflate,
    `every deflater torn down (created ${calls.deflate}, closed ${calls.closed})`,
    15000,
  );
  assert.equal(calls.closed, iterations);
});

test("case 7c destroy() settles an in-flight send once with an error and writes nothing more", async () => {
  const { kernel } = instrumentedKernel();
  const env = makeEnv(kernel, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  const settles = [];
  env.handle.sendBytes(seededBytes(100 * 1024, 0x7c01), (err) =>
    settles.push(err ?? null),
  );
  await drain(2);

  env.handle.destroy();
  const writesAtDestroy = env.socket.writes.length;
  await drain(8);

  assert.equal(settles.length, 1, "the send callback settles exactly once");
  assert.ok(settles[0] instanceof Error, "and it settles with an error");
  assert.equal(
    env.socket.writes.length,
    writesAtDestroy,
    "no frame is written after destroy()",
  );
});

test("case 7d close() during an in-flight compressed send writes Close last", async () => {
  const { kernel } = instrumentedKernel();
  const env = makeEnv(kernel, {
    role: "server",
    permessageDeflate: rolePmd("server", { resetOutboundPerMessage: true }),
  });
  const payload = seededBytes(200 * 1024, 0x7d01);
  const sendSettles = [];
  const closeSettles = [];
  env.handle.sendBytes(payload, (err) => sendSettles.push(err ?? null));
  await waitFor(() => env.socket.writes.length > 0, "the first fragment");
  env.handle.close(1000, "during", (err) => closeSettles.push(err ?? null));
  await pumpWrites(
    env.socket,
    () => sendSettles.length === 1 && closeSettles.length === 1,
  );
  await drain(2);

  assert.deepEqual(sendSettles, [null]);
  assert.deepEqual(closeSettles, [null]);
  const frames = framesOf(env.socket);
  const { messages, controlFrames } = assembleMessages(frames);
  assert.equal(controlFrames.length, 1);
  assert.equal(
    frames[frames.length - 1].opcode,
    OP_CLOSE,
    "the Close frame is the last frame",
  );
  assertNoFrameAfterClose(frames);
  assert.ok(messages[0].frames.length >= 2, "the message really is fragmented");
  const [decoded] = await decodeMessages(messages, {});
  assert.ok(decoded.equals(payload));
});

// ---------------------------------------------------------------------------
// §5.2 case 8 — error propagation
// ---------------------------------------------------------------------------

test("case 8 failNextWrites mid-message settles once and stops fragmenting", async () => {
  const payload = seededBytes(100 * 1024, 0x8a01);
  const totalFrames = Math.ceil(freshCompressed(payload).length / FRAGMENT);
  assert.ok(
    totalFrames >= 4,
    "stimulus must supply a genuine mid-message frame",
  );

  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  const settles = [];
  const boom = new Error("write boom (mid-message)");
  env.handle.sendBytes(payload, (err) => settles.push(err ?? null));
  await waitFor(
    () => env.socket.writes.length === 1,
    "the first fragment to be written",
  );

  env.socket.failNextWrites = boom;
  env.socket.flushWrites(null); // settles frame 1 => frame 2 is written and fails
  await drain(8);

  assert.equal(settles.length, 1);
  assert.equal(settles[0], boom);
  assert.equal(
    env.socket.writes.length,
    2,
    "no fragment after the failing one",
  );
  assert.ok(2 < totalFrames);
});

test("case 8 failNextWrites on the LAST frame settles once with that error", async () => {
  const payload = seededBytes(100 * 1024, 0x8b02);
  const totalFrames = Math.ceil(freshCompressed(payload).length / FRAGMENT);
  assert.ok(totalFrames >= 3, "stimulus must have a last frame to fail");

  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });
  const settles = [];
  const boom = new Error("write boom (last frame)");
  env.handle.sendBytes(payload, (err) => settles.push(err ?? null));
  await drain(3);

  // Advance every frame but the last: the fragmented path writes the next
  // frame only from the previous frame's deferred write callback.
  await pumpWrites(
    env.socket,
    () => env.socket.writes.length === totalFrames - 1,
  );
  assert.equal(
    env.socket.writeCallbacks.length,
    1,
    "the penultimate frame is pending",
  );

  env.socket.failNextWrites = boom;
  env.socket.flushWrites(null); // settles frame N-1 => the LAST frame is written and fails
  await drain(8);

  assert.equal(settles.length, 1);
  assert.equal(settles[0], boom);
  assert.equal(
    env.socket.writes.length,
    totalFrames,
    "the last frame was written, then failed",
  );
});

test("case 8 sendText after close()/destroy() keeps the unchanged notOpenError text", () => {
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });

  env.handle.close();
  const closing = [];
  env.handle.sendText("x", (err) => closing.push(err));
  assert.equal(closing.length, 1);
  assert.equal(
    closing[0].message,
    "WebSocket is not open: readyState CLOSING (closing)",
  );

  env.handle.destroy();
  const closed = [];
  env.handle.sendText("x", (err) => closed.push(err));
  assert.equal(closed.length, 1);
  assert.equal(
    closed[0].message,
    "WebSocket is not open: readyState CLOSING (closed)",
  );
});

test("case 8 a zlib error discards the deflater without hanging a callback", async () => {
  const { kernel, calls, streams } = instrumentedKernel();
  const env = makeEnv(kernel, {
    role: "server",
    permessageDeflate: rolePmd("server"),
  });

  const settles = [];
  const boom = new Error("simulated zlib failure");
  env.handle.sendText("hello ".repeat(100), (err) => settles.push(err ?? null));
  assert.equal(streams.length, 1, "the deflater was created lazily");
  streams[0].emit("error", boom); // zlib stream error while the flush is pending
  await drain(8);

  assert.equal(settles.length, 1, "the send callback settles exactly once");
  assert.equal(settles[0], boom);
  assert.equal(env.socket.writes.length, 0, "nothing reaches the socket");
  assert.equal(
    streams[0].destroyed,
    true,
    "the erroring deflater was discarded",
  );

  // A following send must create a FRESH stream and complete cleanly.
  const nextSettles = [];
  env.handle.sendBytes(Buffer.from("clean payload ".repeat(60)), (err) =>
    nextSettles.push(err ?? null),
  );
  await pumpWrites(env.socket, () => nextSettles.length === 1);
  assert.deepEqual(nextSettles, [null]);
  assert.equal(calls.deflate, 2, "a fresh per-message deflater was created");
  const { messages } = messagesOf(env.socket);
  const [decoded] = await decodeMessages(messages, {});
  assert.equal(decoded.toString("utf8"), "clean payload ".repeat(60));
});

test("case 8 a zlib constructor rejection settles the callback with that error", async () => {
  // windowBits 16 is out of zlib's 8..15 range: createDeflateRaw throws, which
  // is a reachable zlib error path (§3.2 step 4). No callback may hang.
  const env = makeEnv(C, {
    role: "server",
    permessageDeflate: rolePmd("server", { serverMaxWindowBits: 16 }),
  });
  const settles = [];
  env.handle.sendText("hi", (err) => settles.push(err ?? null));
  await drain(6);

  assert.equal(settles.length, 1);
  assert.ok(settles[0] instanceof Error);
  assert.match(String(settles[0].message), /windowBits/);
  assert.equal(env.socket.writes.length, 0);
  assert.deepEqual(env.errors, [], "a send failure is not a protocol failure");
});
