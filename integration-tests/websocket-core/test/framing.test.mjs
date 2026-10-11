// Framing FSM unit tests against the §4.3 validation matrix of
// tasks/native-websocket/PLAN.md. Every inbound byte sequence is built with
// the independent hand-rolled oracle encoder in harness.mjs (written from
// the RFC, not from kernel code) and fed to an attach()-ed engine driven by
// a fake socket implementing only the documented socket interface.
import test from "node:test";
import assert from "node:assert/strict";

import {
  WebSocketCore as C,
  makeFakeSocket,
  makeConfig,
  collectMessages,
  oracleFrame,
  oracleParse,
} from "./harness.mjs";

const maskKey = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

// Attach an engine to a fake socket; returns everything tests need.
function setup(overrides = {}) {
  const socket = makeFakeSocket();
  const closed = [];
  const errors = [];
  const handle = C._WebSocketCore_attach(
    socket,
    makeConfig({
      onClose: (code, reason) => closed.push({ code, reason }),
      onError: (message) => errors.push(message),
      ...overrides,
    }),
  );
  const messages = collectMessages(handle);
  const settle = handle.readable.__settle;
  return { socket, handle, closed, errors, messages, settle };
}

// Decode everything the engine has written to the fake socket so far.
function writtenFrames(socket) {
  return oracleParse(Buffer.concat(socket.writes));
}

function viewBytes(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function serverText(text, opts = {}) {
  return oracleFrame({
    opcode: 0x1,
    payload: Buffer.from(text, "utf8"),
    mask: true,
    maskKey,
    ...opts,
  });
}

// Feed bytes to a configured engine and assert exactly one protocol Close
// (opcode 0x8) went out. Returns the close record + reply frame.
function expectProtocolClose(feeder, overrides = {}) {
  const env = setup(overrides);
  feeder(env.socket);
  env.socket.flushWrites();
  assert.equal(env.closed.length, 1, "expected exactly one close");
  const frames = writtenFrames(env.socket);
  assert.equal(frames.length, 1, "expected exactly one reply frame");
  assert.equal(frames[0].opcode, 0x8);
  return { ...env, closed: env.closed[0], reply: frames[0] };
}

// ---------------------------------------------------------------------------
// pure helper units
// ---------------------------------------------------------------------------

test("maskXor round-trips with a rolling key index", () => {
  const data = Buffer.from("hello websocket masking!", "utf8");
  const key = Buffer.from([0x01, 0xf0, 0x3c, 0x7f]);
  const copy = Buffer.from(data);
  C._WebSocketCore_maskXor(copy, key, 0);
  assert.notDeepEqual(copy, data);
  C._WebSocketCore_maskXor(copy, key, 0);
  assert.deepEqual(copy, data);

  // rolling startIndex: XOR(0..2) with index 0 then XOR(rest) with index 2
  // equals a single full pass -- this is the chunk-boundary property.
  const two = Buffer.from(data);
  C._WebSocketCore_maskXor(two.subarray(0, 2), key, 0);
  C._WebSocketCore_maskXor(two.subarray(2), key, 2);
  const one = Buffer.from(data);
  C._WebSocketCore_maskXor(one, key, 0);
  assert.deepEqual(two, one);
});

test("close-code tables", () => {
  const sent = C._WebSocketCore_isValidSentCloseCode;
  const recv = C._WebSocketCore_isValidReceivedCloseCode;
  for (const code of [
    1000, 1001, 1002, 1003, 1007, 1008, 1011, 1014, 3000, 4999,
  ]) {
    assert.equal(sent(code), true, String(code));
    assert.equal(recv(code), true, String(code));
  }
  for (const code of [999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 0]) {
    assert.equal(sent(code), false, "sent " + code);
  }
  // RFC 6455 7.4: 1005/1006 MUST NEVER appear in a received Close payload,
  // so the received table is exactly the sent table (ws validation.js does
  // the same). 1005 reaches the app only synthesized for an empty payload.
  for (const code of [999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) {
    assert.equal(recv(code), false, "recv " + code);
  }
  for (const code of [1000, 1002, 1003, 1007, 1008, 1011, 1014, 4999]) {
    assert.equal(recv(code), sent(code), "recv/sent agreement " + code);
  }
});

test("opcode table accepts only the defined opcodes", () => {
  for (const op of [0x0, 0x1, 0x2, 0x8, 0x9, 0xa]) {
    assert.equal(C._WebSocketCore_opcodeIsValid(op), true, String(op));
  }
  for (const op of [0x3, 0x4, 0x5, 0x6, 0x7, 0xb, 0xc, 0xd, 0xe, 0xf]) {
    assert.equal(C._WebSocketCore_opcodeIsValid(op), false, String(op));
  }
});

test("utf8IsValid", () => {
  assert.equal(
    C._WebSocketCore_utf8IsValid(Buffer.from("héllo ✓ 😀", "utf8")),
    true,
  );
  assert.equal(C._WebSocketCore_utf8IsValid(Buffer.alloc(0)), true);
  assert.equal(C._WebSocketCore_utf8IsValid(Buffer.from([0xc3])), false);
  assert.equal(
    C._WebSocketCore_utf8IsValid(Buffer.from([0xf0, 0x28, 0x8c, 0xbc])),
    false,
  );
});

// ---------------------------------------------------------------------------
// inbound happy paths
// ---------------------------------------------------------------------------

test("masked text frame from client is decoded into a text message", () => {
  const { socket, closed, messages } = setup();
  socket.feed(serverText("hi ünïcode"));
  socket.flushWrites();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "text");
  assert.equal(viewBytes(messages[0].view).toString("utf8"), "hi ünïcode");
  assert.equal(closed.length, 0);
  assert.equal(socket.writes.length, 0); // no unexpected replies
});

test("unmasked binary frame to client-role handle is decoded", () => {
  const { socket, closed, messages } = setup({ role: "client" });
  socket.feed(
    oracleFrame({ opcode: 0x2, payload: Buffer.from([1, 2, 3, 250]) }),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "binary");
  assert.deepEqual([...viewBytes(messages[0].view)], [1, 2, 3, 250]);
  assert.equal(closed.length, 0);
});

test("16-bit and 64-bit payload lengths parse (minimal encodings)", () => {
  const { socket, messages } = setup();
  socket.feed(
    oracleFrame({
      opcode: 0x2,
      payload: Buffer.alloc(1000, 0x5a),
      mask: true,
      maskKey,
    }),
  );
  socket.feed(
    oracleFrame({
      opcode: 0x2,
      payload: Buffer.alloc(65536, 0x33),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(messages.length, 2);
  assert.equal(viewBytes(messages[0].view).length, 1000);
  assert.equal(viewBytes(messages[1].view).length, 65536);
  assert.equal(viewBytes(messages[1].view)[65535], 0x33);
});

test("partial frames across chunk boundaries reassemble", () => {
  const { socket, messages } = setup();
  const frame = serverText("fragmented transport");
  for (const byte of frame) socket.feed(Buffer.from([byte]));
  assert.equal(messages.length, 1);
  assert.equal(
    viewBytes(messages[0].view).toString("utf8"),
    "fragmented transport",
  );
});

test("coalesced frames in a single chunk both decode", () => {
  const { socket, messages } = setup();
  socket.feed(Buffer.concat([serverText("one"), serverText("two")]));
  assert.equal(messages.length, 2);
  assert.equal(viewBytes(messages[0].view).toString(), "one");
  assert.equal(viewBytes(messages[1].view).toString(), "two");
});

test("fragmented text message with multi-byte UTF-8 split across frames is valid", () => {
  // "é" = C3 A9 split across two frames; must NOT trigger 1007.
  const { socket, closed, messages } = setup();
  socket.feed(
    oracleFrame({
      fin: false,
      opcode: 0x1,
      payload: Buffer.from([0xc3]),
      mask: true,
      maskKey,
    }),
  );
  socket.feed(
    oracleFrame({
      fin: true,
      opcode: 0x0,
      payload: Buffer.from([0xa9]),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(messages.length, 1);
  assert.equal(viewBytes(messages[0].view).toString("utf8"), "é");
  assert.equal(closed.length, 0);
});

test("truncated multi-byte sequence at FIN boundary -> 1007 (streaming flush)", () => {
  // Segments validate fine incrementally; only the final flush can see the
  // dangling C3 -- classic autobahn 6.x fragmented-UTF-8 trap.
  const { socket, closed, messages } = setup();
  socket.feed(
    oracleFrame({
      fin: false,
      opcode: 0x1,
      payload: Buffer.from([0x41, 0xc3]),
      mask: true,
      maskKey,
    }),
  );
  socket.feed(
    oracleFrame({
      fin: true,
      opcode: 0x0,
      payload: Buffer.from([0x42]),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(messages.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1007);
});

test("streaming decoder catches truncated sequence ending exactly at FIN", () => {
  const { socket, closed, messages } = setup();
  socket.feed(
    oracleFrame({
      fin: true,
      opcode: 0x1,
      payload: Buffer.from([0xe0, 0xa0]),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(messages.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1007);
});

test("invalid UTF-8 in unfragmented text -> close 1007", () => {
  const { reply, closed } = expectProtocolClose((s) =>
    s.feed(
      oracleFrame({
        opcode: 0x1,
        payload: Buffer.from([0xf0, 0x28, 0x8c, 0xbc]),
        mask: true,
        maskKey,
      }),
    ),
  );
  assert.equal(closed.code, 1007);
  assert.equal(reply.payload.readUInt16BE(0), 1007);
});

// ---------------------------------------------------------------------------
// inbound validation matrix
// ---------------------------------------------------------------------------

test("unmasked frame to server-role handle -> 1002 (RFC 6455 5.1)", () => {
  const { reply } = expectProtocolClose((s) =>
    s.feed(oracleFrame({ opcode: 0x1, payload: Buffer.from("x") })),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("masked frame to client-role handle -> 1002", () => {
  const { reply } = expectProtocolClose(
    (s) =>
      s.feed(
        oracleFrame({
          opcode: 0x1,
          payload: Buffer.from("x"),
          mask: true,
          maskKey,
        }),
      ),
    { role: "client" },
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("reserved opcodes -> 1002", () => {
  for (const opcode of [0x3, 0x7, 0xb, 0xf]) {
    const { reply } = expectProtocolClose((s) =>
      s.feed(
        oracleFrame({ opcode, payload: Buffer.from("z"), mask: true, maskKey }),
      ),
    );
    assert.equal(reply.payload.readUInt16BE(0), 1002, "opcode " + opcode);
  }
});

test("protocol violation errors the readable with a non-empty reason (Phase-4 oracle contract)", () => {
  // The exact bytes the Phase-4 oracle sends: FIN + reserved opcode 3,
  // zero-length payload. The app must see BOTH an error (non-empty
  // Stream.Cancelled reason) and a close, and the readable must end ERRORED,
  // never clean -- the ws-based kernel did controller.error(msg) then close.
  const { socket, errors, closed, settle } = setup();
  socket.feed(Buffer.from([0x83, 0x00]));
  socket.flushWrites();
  assert.equal(errors.length, 1, "error channel fired exactly once");
  assert.ok(errors[0] !== "" && typeof errors[0] === "string");
  assert.match(errors[0], /invalid opcode 3/);
  assert.equal(closed.length, 1, "onClose still dispatches");
  assert.equal(closed[0].code, 1002);
  assert.equal(settle.errored, true, "readable must end ERRORED");
  assert.equal(settle.closed, false, "not a clean end");
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.readUInt16BE(0), 1002);
});

test("protocol violation: Close(1002) then socket.end(); destroy stays the timer backstop", () => {
  // Autobahn close-handshake timing (3.2/3.3, 4.1.3/4.1.4, 4.2.3/4.2.4):
  // after a protocol-error Close the engine must FIN right after the Close
  // flushes (ws Sender.fail(): write(close) then end()), not hold the
  // socket open for the full close-timer window. The bounded destroy is
  // still armed in case the peer never finishes teardown.
  const { socket, handle } = setup();
  socket.feed(Buffer.from([0x83, 0x00]));
  assert.equal(socket.endCalled, false, "end waits for the write to flush");
  socket.flushWrites();
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.readUInt16BE(0), 1002);
  assert.equal(socket.endCalled, true, "FIN after the Close flushes");
  assert.equal(socket.destroyed, false, "no hard destroy before the timer");
  assert.equal(handle.state, "closed", "fireClose settles the handle");
});

test("protocol violation while closing: still no second Close and no end() from failProtocol", () => {
  // close()'s own teardown paths (peer Close ACK -> hard destroy, close
  // timer -> bounded destroy) stand on their own; the protocol-violation
  // early-return must not sneak an extra end() onto a connection whose
  // Close is already in flight.
  const { socket, handle } = setup();
  handle.close(1000, "bye", () => {});
  socket.flushWrites();
  assert.equal(socket.endCalled, false, "close() itself does not end");
  socket.feed(Buffer.from([0x83, 0x00]));
  socket.flushWrites();
  assert.equal(socket.endCalled, false);
  assert.equal(socket.destroyed, false);
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1, "still exactly one Close on the wire");
});

test("protocol violation behind a same-event delivery: message survives, Close+FIN next turn", async () => {
  // Autobahn 3.2/5.15: a valid message and a violating frame coalesced in
  // one TCP segment. ws's receiver delivers the message (its abort lands
  // after the read settles); a synchronous error here would wipe the
  // queued echo. The engine must keep the message, then put Close(1002) +
  // FIN on the wire one turn later.
  const { socket, handle, closed, errors, messages, settle } = setup();
  socket.feed(
    serverText("Hello, world!"),
    oracleFrame({ opcode: 0x3, payload: Buffer.alloc(0), mask: true, maskKey }),
  );
  assert.equal(
    socket.writes.length,
    0,
    "wire teardown waits one turn behind the delivery",
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  socket.flushWrites();
  assert.equal(messages.length, 1, "the pre-violation message survived");
  assert.deepEqual(
    viewBytes(messages[0].view),
    Buffer.from("Hello, world!", "utf8"),
  );
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.readUInt16BE(0), 1002);
  assert.equal(socket.endCalled, true, "FIN after the deferred Close flushes");
  assert.equal(errors.length, 1);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1002);
  assert.equal(settle.errored, true);
  assert.equal(handle.state, "closed");
});

test("deferral window: violation stops deliveries in later events too", async () => {
  // Between the deferred violation and the drain, a following data event
  // must not deliver anything new -- the connection is logically failed
  // (ws has already called fail() by then). The pre-violation message of
  // the violating event itself survives.
  const { socket, messages } = setup();
  socket.feed(
    serverText("one"),
    oracleFrame({ opcode: 0x3, payload: Buffer.alloc(0), mask: true, maskKey }),
  );
  socket.feed(serverText("two"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  socket.flushWrites();
  assert.equal(messages.length, 1, "only the pre-violation message survives");
  assert.deepEqual(viewBytes(messages[0].view), Buffer.from("one", "utf8"));
});

test("clean close contrast: normal Close ends the readable CLEAN, no error", () => {
  const { socket, errors, closed, settle } = setup();
  socket.feed(
    oracleFrame({
      opcode: 0x8,
      payload: Buffer.from([0x03, 0xe8]),
      mask: true,
      maskKey,
    }),
  );
  socket.flushWrites();
  assert.equal(closed.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(settle.closed, true);
  assert.equal(settle.errored, false);
});

test("protocol violation while closing: no second Close frame, app code intact", () => {
  // RFC 6455 7.1.1: exactly one Close per direction. After the app closed
  // with 1000, a stray reserved-opcode frame must NOT put a second Close on
  // the wire and must NOT overwrite the app-visible close code; the error
  // notification still fires (ws emits errors after its close frame too).
  const { socket, handle, closed, errors, settle } = setup();
  handle.close(1000, "bye", () => {});
  socket.flushWrites();
  socket.feed(Buffer.from([0x83, 0x00]));
  socket.flushWrites();
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1, "exactly one Close frame on the wire");
  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.readUInt16BE(0), 1000, "app code intact");
  assert.equal(errors.length, 1, "error notification still fires");
  assert.match(errors[0], /invalid opcode 3/);
  assert.equal(settle.errored, true);
  assert.equal(closed.length, 0, "app close code not overwritten");
  assert.equal(handle.state, "closing", "bounded teardown still pending");
  // peer ACK afterwards completes the handshake normally with code 1000
  socket.feed(
    oracleFrame({
      opcode: 0x8,
      payload: Buffer.from([0x03, 0xe8]),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1000);
  assert.equal(handle.state, "closed");
});

test("RSV1/RSV2/RSV3 bits with no extensions -> 1002", () => {
  for (const rsv of [1, 2, 4]) {
    const { reply } = expectProtocolClose((s) =>
      s.feed(
        oracleFrame({
          rsv,
          opcode: 0x1,
          payload: Buffer.from("q"),
          mask: true,
          maskKey,
        }),
      ),
    );
    assert.equal(reply.payload.readUInt16BE(0), 1002, "rsv " + rsv);
  }
});

test("fragmented control frame -> 1002", () => {
  const { reply } = expectProtocolClose((s) =>
    s.feed(oracleFrame({ fin: false, opcode: 0x9, mask: true, maskKey })),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("control payload >125 -> 1002", () => {
  const { reply } = expectProtocolClose((s) =>
    s.feed(
      oracleFrame({
        opcode: 0x9,
        payload: Buffer.alloc(126),
        mask: true,
        maskKey,
      }),
    ),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("reserved opcode used as a control frame -> 1002", () => {
  // 0xB with FIN and tiny payload is still a reserved opcode
  const { reply } = expectProtocolClose((s) =>
    s.feed(
      oracleFrame({
        opcode: 0xb,
        payload: Buffer.alloc(3),
        mask: true,
        maskKey,
      }),
    ),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("non-minimal 16-bit length -> 1002 (autobahn 5.x)", () => {
  const { reply } = expectProtocolClose((s) =>
    s.feed(
      oracleFrame({
        opcode: 0x1,
        payload: Buffer.from("short"),
        mask: true,
        maskKey,
        forceLenMode: 16,
      }),
    ),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("non-minimal 64-bit length -> 1002", () => {
  const { reply } = expectProtocolClose((s) =>
    s.feed(
      oracleFrame({
        opcode: 0x2,
        payload: Buffer.from("tiny"),
        mask: true,
        maskKey,
        forceLenMode: 64,
      }),
    ),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("64-bit length with MSB set -> 1002 (malformed)", () => {
  const header = Buffer.alloc(10);
  header[0] = 0x82; // FIN + binary
  header[1] = 127; // 64-bit length, unmasked (server->client direction)
  header.writeUInt32BE(0x80000000, 2); // MSB set
  header.writeUInt32BE(0, 6);
  const { reply } = expectProtocolClose((s) => s.feed(header), {
    role: "client",
  });
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("continuation without an open fragmented message -> 1002", () => {
  const { reply } = expectProtocolClose((s) =>
    s.feed(
      oracleFrame({
        fin: true,
        opcode: 0x0,
        payload: Buffer.from("x"),
        mask: true,
        maskKey,
      }),
    ),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("new data frame while a fragmented message is open -> 1002", () => {
  const { reply } = expectProtocolClose((s) => {
    s.feed(
      oracleFrame({
        fin: false,
        opcode: 0x1,
        payload: Buffer.from("a"),
        mask: true,
        maskKey,
      }),
    );
    s.feed(
      oracleFrame({
        fin: true,
        opcode: 0x1,
        payload: Buffer.from("b"),
        mask: true,
        maskKey,
      }),
    );
  });
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("frame above maxFrameSize -> 1009", () => {
  const { reply, closed } = expectProtocolClose(
    (s) =>
      s.feed(
        oracleFrame({
          opcode: 0x2,
          payload: Buffer.alloc(60),
          mask: true,
          maskKey,
        }),
      ),
    { maxFrameSize: 50 },
  );
  assert.equal(reply.payload.readUInt16BE(0), 1009);
  assert.equal(closed.code, 1009);
});

test("64-bit frame length above maxFrameSize -> 1009", () => {
  // unmasked 64-bit-length header announcing 100000 bytes on a client-role
  // engine with maxFrameSize 70000: rejected at length-parse time.
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(100000, 6);
  const env = setup({ role: "client", maxFrameSize: 70000 });
  env.socket.feed(header);
  env.socket.flushWrites();
  assert.equal(env.closed.length, 1);
  assert.equal(env.closed[0].code, 1009);
});

test("reassembled message above maxMessageSize -> 1009", () => {
  const { reply, closed } = expectProtocolClose(
    (s) => {
      s.feed(
        oracleFrame({
          fin: false,
          opcode: 0x2,
          payload: Buffer.alloc(8),
          mask: true,
          maskKey,
        }),
      );
      s.feed(
        oracleFrame({
          fin: true,
          opcode: 0x0,
          payload: Buffer.alloc(8),
          mask: true,
          maskKey,
        }),
      );
    },
    { maxMessageSize: 10 },
  );
  assert.equal(reply.payload.readUInt16BE(0), 1009);
  assert.equal(closed.code, 1009);
});

// ---------------------------------------------------------------------------
// ping / pong
// ---------------------------------------------------------------------------

test("ping is answered with a Pong echoing the payload verbatim", () => {
  const { socket, closed, messages } = setup();
  const pingPayload = Buffer.from("ping-payload", "utf8");
  socket.feed(
    oracleFrame({ opcode: 0x9, payload: pingPayload, mask: true, maskKey }),
  );
  assert.equal(closed.length, 0);
  assert.equal(messages.length, 0);
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0xa);
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].masked, false, "server-role pong is unmasked");
  assert.deepEqual([...frames[0].payload], [...pingPayload]);
});

test("pong arriving mid-fragmented-message is answered out-of-band, message still assembles (autobahn 4.1.5)", () => {
  const { socket, messages, closed } = setup();
  socket.feed(
    oracleFrame({
      fin: false,
      opcode: 0x2,
      payload: Buffer.from("ABC"),
      mask: true,
      maskKey,
    }),
  );
  socket.feed(
    oracleFrame({
      opcode: 0x9,
      payload: Buffer.from("P"),
      mask: true,
      maskKey,
    }),
  );
  // pong already out while the message is still incomplete
  let frames = writtenFrames(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0xa);
  assert.deepEqual([...frames[0].payload], [0x50]);
  // finish the fragmented message; the interleaved ping was not a fragment
  socket.feed(
    oracleFrame({
      fin: true,
      opcode: 0x0,
      payload: Buffer.from("DEF"),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(messages.length, 1);
  assert.equal(viewBytes(messages[0].view).toString(), "ABCDEF");
  assert.equal(closed.length, 0);
});

test("unsolicited pong is a no-op (no close, no reply)", () => {
  const { socket, closed } = setup();
  socket.feed(
    oracleFrame({
      opcode: 0xa,
      payload: Buffer.from("x"),
      mask: true,
      maskKey,
    }),
  );
  socket.feed(oracleFrame({ opcode: 0xa, mask: true, maskKey }));
  assert.equal(closed.length, 0);
  assert.equal(socket.writes.length, 0);
});

test("client-role pong replies are masked", () => {
  const env = setup({ role: "client" });
  env.socket.feed(oracleFrame({ opcode: 0x9, payload: Buffer.from("hi") }));
  const frames = writtenFrames(env.socket);
  assert.equal(frames[0].opcode, 0xa);
  assert.equal(frames[0].masked, true);
  assert.deepEqual([...frames[0].payload], [0x68, 0x69]);
});

// ---------------------------------------------------------------------------
// close handshake
// ---------------------------------------------------------------------------

test("Close received -> same code echoed, onClose once, socket half-closed", () => {
  const { socket, handle, closed } = setup();
  const reason = Buffer.from("bye now", "utf8");
  socket.feed(
    oracleFrame({
      opcode: 0x8,
      payload: Buffer.concat([Buffer.from([0x03, 0xe8]), reason]),
      mask: true,
      maskKey,
    }),
  );
  socket.flushWrites();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1000);
  assert.equal(closed[0].reason, "bye now");
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.readUInt16BE(0), 1000); // same code echoed
  assert.equal(frames[0].payload.subarray(2).toString("utf8"), "bye now");
  assert.equal(socket.endCalled, true, "engine half-closes after replying");
  assert.equal(handle.state, "closed");

  // late duplicate frames/events never double-fire onClose
  socket.feed(
    oracleFrame({
      opcode: 0x8,
      payload: Buffer.from([0x03, 0xe9]),
      mask: true,
      maskKey,
    }),
  );
  socket.emit("close");
  socket.emit("end");
  assert.equal(closed.length, 1);
});

test("Close with empty payload -> app sees 1005, reply Close has empty payload (1005 never sent)", () => {
  const { socket, closed } = setup();
  socket.feed(oracleFrame({ opcode: 0x8, mask: true, maskKey }));
  socket.flushWrites();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1005); // No Status Received, delivered as-is
  assert.equal(closed[0].reason, "");
  const frames = writtenFrames(socket);
  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.length, 0);
});

test("Close with 1-byte payload -> 1002", () => {
  const { reply } = expectProtocolClose((s) =>
    s.feed(
      oracleFrame({
        opcode: 0x8,
        payload: Buffer.from([0x03]),
        mask: true,
        maskKey,
      }),
    ),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1002);
});

test("Close with invalid code -> 1002", () => {
  // 1005/1006 are in this list on purpose: RFC 6455 7.4 forbids them on the
  // wire, so an explicit one is a protocol violation answered Close(1002),
  // exactly like the ws oracle (isValidStatusCode rejects both).
  for (const code of [1004, 1005, 1006, 1015, 1016, 2999, 999, 5000]) {
    const { reply, errors, settle } = expectProtocolClose((s) => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code, 0);
      s.feed(oracleFrame({ opcode: 0x8, payload: p, mask: true, maskKey }));
    });
    assert.equal(reply.opcode, 0x8, "code " + code);
    assert.equal(reply.payload.readUInt16BE(0), 1002, "code " + code);
    assert.equal(errors.length, 1, "error channel fired once for " + code);
    assert.match(errors[0], new RegExp("invalid status code " + code));
    assert.equal(settle.errored, true, "readable errored for " + code);
    assert.equal(settle.closed, false, "readable not clean for " + code);
  }
});

test("Close with non-UTF-8 reason -> 1007", () => {
  const p = Buffer.concat([
    Buffer.from([0x03, 0xe8]),
    Buffer.from([0xff, 0xfe]),
  ]);
  const { reply } = expectProtocolClose((s) =>
    s.feed(oracleFrame({ opcode: 0x8, payload: p, mask: true, maskKey })),
  );
  assert.equal(reply.payload.readUInt16BE(0), 1007);
});

test("Close received mid-fragmented-message drops the partial message", () => {
  const { socket, closed, messages } = setup();
  socket.feed(
    oracleFrame({
      fin: false,
      opcode: 0x1,
      payload: Buffer.from("half"),
      mask: true,
      maskKey,
    }),
  );
  socket.feed(
    oracleFrame({
      opcode: 0x8,
      payload: Buffer.from([0x03, 0xe8]),
      mask: true,
      maskKey,
    }),
  );
  socket.flushWrites();
  assert.equal(messages.length, 0);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1000);
});

test("socket death without a Close frame -> abnormal 1006 exactly once", () => {
  const { socket, closed } = setup();
  socket.emit("close");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1006);
  socket.emit("close");
  socket.emit("end");
  assert.equal(closed.length, 1);
});

test("peer FIN (end event) without Close frame -> 1006 and destroy", () => {
  const { socket, closed } = setup();
  socket.emit("end");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1006);
  assert.equal(socket.destroyed, true);
});

test("socket error -> onError once with message, close follows with 1006", () => {
  const { socket, errors, closed } = setup();
  socket.emit("error", new Error("ECONNRESET boom"));
  assert.deepEqual(errors, ["ECONNRESET boom"]);
  socket.emit("error", new Error("second error"));
  assert.equal(errors.length, 1, "onError fires at most once");
  socket.emit("close");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1006);
});

// ---------------------------------------------------------------------------
// outbound: send / close / fragmentation / masking
// ---------------------------------------------------------------------------

test("sendText/sendBytes emit single FIN frames (server role unmasked)", () => {
  const { socket, handle } = setup();
  let errs = [];
  handle.sendText("héllo", (err) => errs.push(err));
  handle.sendBytes(Buffer.from([9, 8, 7]), (err) => errs.push(err));
  socket.flushWrites();
  assert.deepEqual(errs, [null, null]);
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].opcode, 0x1);
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].masked, false);
  assert.equal(frames[0].payload.toString("utf8"), "héllo");
  assert.equal(frames[1].opcode, 0x2);
  assert.deepEqual([...frames[1].payload], [9, 8, 7]);
});

test("client-role frames are all masked, fresh key per message", () => {
  const { socket, handle } = setup({ role: "client" });
  handle.sendText("message one", () => {});
  handle.sendText("message two", () => {});
  socket.flushWrites();
  const frames = writtenFrames(socket);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].masked, true);
  assert.equal(frames[1].masked, true);
  assert.equal(frames[0].payload.toString(), "message one");
  assert.equal(frames[1].payload.toString(), "message two");
  assert.notDeepEqual(
    [...frames[0].maskKey],
    [...frames[1].maskKey],
    "fresh key per message",
  );
});

test("messages >16 KiB fragment at 2^14 and reassemble through the oracle", () => {
  const { socket, handle } = setup({ role: "client" });
  const payload = Buffer.alloc(40000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const cbCalls = [];
  handle.sendBytes(payload, (err) => cbCalls.push(err));
  socket.flushWrites();
  socket.flushWrites();
  socket.flushWrites();
  assert.equal(cbCalls.length, 1, "callback fires exactly once");
  assert.equal(cbCalls[0], null);

  const frames = writtenFrames(socket);
  assert.equal(frames.length, 3); // 16384 + 16384 + 7232
  assert.equal(frames[0].opcode, 0x2);
  assert.equal(frames[0].fin, false);
  assert.equal(frames[0].payload.length, 16384);
  assert.equal(frames[1].opcode, 0x0);
  assert.equal(frames[1].fin, false);
  assert.equal(frames[1].payload.length, 16384);
  assert.equal(frames[2].opcode, 0x0);
  assert.equal(frames[2].fin, true);
  assert.equal(frames[2].payload.length, 40000 - 32768);
  assert.deepEqual(
    [...Buffer.concat(frames.map((f) => f.payload))],
    [...payload],
  );

  // per-message mask key: all fragments of THIS message share one key...
  assert.deepEqual([...frames[0].maskKey], [...frames[1].maskKey]);
  assert.deepEqual([...frames[1].maskKey], [...frames[2].maskKey]);
  // ...and the next message gets a different one
  handle.sendBytes(Buffer.from([1]), () => {});
  socket.flushWrites();
  const after = writtenFrames(socket);
  assert.notDeepEqual(
    [...after[after.length - 1].maskKey],
    [...frames[0].maskKey],
  );
});

test("fragmented write error propagates once and aborts remaining fragments", () => {
  const { socket, handle } = setup();
  const payload = Buffer.alloc(20000, 0x41);
  const calls = [];
  handle.sendBytes(payload, (err) => calls.push(err && err.message));
  assert.equal(socket.writes.length, 1, "first fragment written synchronously");
  const first = socket.writeCallbacks.shift();
  first(new Error("write exploded"));
  assert.deepEqual(calls, ["write exploded"]);
  assert.equal(
    socket.writes.length,
    1,
    "continuation never queued after error",
  );
});

test("close() sends a Close frame, later sends fail with 'WebSocket is not open'", () => {
  const { socket, handle, closed } = setup();
  assert.equal(handle.state, "open");

  const closeCbCalls = [];
  handle.close(1000, "done", (err) => closeCbCalls.push(err));
  assert.equal(handle.state, "closing");
  socket.flushWrites();
  assert.equal(closeCbCalls.length, 1);
  assert.equal(closeCbCalls[0], null);
  socket.flushWrites();
  assert.equal(closeCbCalls.length, 1, "close callback fires once");

  const frames = writtenFrames(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x8);
  assert.equal(frames[0].payload.readUInt16BE(0), 1000);
  assert.equal(frames[0].payload.subarray(2).toString(), "done");

  // sending after Close is refused with the compatibility error string
  let sendErr = null;
  handle.sendText("too late", (err) => (sendErr = err));
  assert.ok(sendErr instanceof Error);
  assert.ok(
    sendErr.message.startsWith("WebSocket is not open"),
    "must match errorIsConnectionNotOpen: " + sendErr.message,
  );
  let bytesErr = null;
  handle.sendBytes(Buffer.from("x"), (err) => (bytesErr = err));
  assert.ok(bytesErr.message.startsWith("WebSocket is not open"));
  assert.equal(socket.writes.length, 1, "no further frames written");

  // second close() is an idempotent no-op
  let second = 0;
  handle.close(1000, "again", () => second++);
  assert.equal(second, 1);
  assert.equal(socket.writes.length, 1);

  // peer ack arrives: onClose fires once with the RECEIVED code, socket dies
  socket.feed(
    oracleFrame({
      opcode: 0x8,
      payload: Buffer.from([0x03, 0xe8]),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1000);
  assert.equal(handle.state, "closed");
  assert.equal(socket.destroyed, true);
});

test("close() without peer ack keeps handle in closing until bounded destroy", () => {
  const { socket, handle, closed } = setup();
  handle.close(1001, null, () => {});
  socket.flushWrites();
  assert.equal(handle.state, "closing");
  assert.equal(closed.length, 0, "we initiated: no onClose until teardown");
  // frames after we sent Close are ignored entirely
  socket.feed(serverText("ignored"));
  assert.equal(closed.length, 0);
});

test("close(1000) with empty reason sends just the 2-byte code", () => {
  const { socket, handle } = setup();
  handle.close(1000, "", () => {});
  socket.flushWrites();
  const frames = writtenFrames(socket);
  assert.equal(frames[0].payload.length, 2);
  assert.equal(frames[0].payload.readUInt16BE(0), 1000);
});

test("close with reason >123 bytes -> error, nothing sent", () => {
  const { socket, handle } = setup();
  let err = null;
  handle.close(1000, "ü".repeat(70), (e) => (err = e)); // 140 bytes UTF-8
  assert.ok(err instanceof Error);
  assert.ok(
    err.message.startsWith("The message must not be greater than 123 bytes"),
    err.message,
  );
  assert.equal(socket.writes.length, 0, "no Close frame may be sent");
  assert.equal(handle.state, "open", "state unchanged");
});

test("close with invalid code -> error string, nothing sent", () => {
  const { socket, handle } = setup();
  let err = null;
  handle.close(1005, "", (e) => (err = e));
  assert.ok(
    err.message.startsWith("First argument must be a valid error code"),
  );
  let err2 = null;
  handle.close(999, "", (e) => (err2 = e));
  assert.ok(
    err2.message.startsWith("First argument must be a valid error code"),
  );
  assert.equal(socket.writes.length, 0);
});

test("no messages reach the readable after we send Close", () => {
  const { socket, handle, messages } = setup();
  handle.close(1000, "bye", () => {});
  socket.flushWrites();
  // a data frame racing in after our Close must not enqueue
  socket.feed(
    oracleFrame({
      fin: true,
      opcode: 0x2,
      payload: Buffer.from("late"),
      mask: true,
      maskKey,
    }),
  );
  assert.equal(messages.length, 0);
});

test("destroy() tears down without sending anything", () => {
  const { socket, handle, closed } = setup();
  handle.destroy();
  assert.equal(socket.writes.length, 0);
  assert.equal(socket.destroyed, true);
  assert.equal(handle.state, "closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1006);
});

// ---------------------------------------------------------------------------
// backpressure contract (same pattern as _Net_buildReadable)
// ---------------------------------------------------------------------------

test("queue full pauses the socket; a drain pull resumes it", async () => {
  const socket = makeFakeSocket();
  const handle = C._WebSocketCore_attach(
    socket,
    makeConfig({ role: "server", readBufferCapacity: 1 }),
  );
  socket.feed(serverText("m1"));
  assert.equal(
    socket.paused,
    true,
    "enqueue past capacity must pause the socket",
  );
  const reader = handle.readable.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(viewBytes(first.value.view).toString(), "m1");
  assert.ok(socket.resumed >= 1, "pull must resume the socket");
});

// ---------------------------------------------------------------------------
// initialBytes: handshake leftovers handed to attach() are parsed exactly
// once, after the socket listeners exist (the Phase 4 client/server kernels
// buffer bytes past the header block before attaching the engine).
// ---------------------------------------------------------------------------

test("initialBytes surfaces a complete frame without any socket feed", async () => {
  const socket = makeFakeSocket();
  const handle = C._WebSocketCore_attach(
    socket,
    makeConfig({
      role: "server",
      initialBytes: serverText("leftover"),
    }),
  );
  // Nothing went through the fake socket -- the bytes arrived via config.
  assert.equal(socket.writes.length, 0);
  const reader = handle.readable.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(viewBytes(first.value.view).toString(), "leftover");
  // Only that one frame was parsed: no double-feed of the same bytes.
  const pending = await Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  assert.equal(pending, "pending", "initialBytes must be ingested once only");
});
