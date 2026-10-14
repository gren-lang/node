// Live raw-socket probes for the RFC 7692 permessage-deflate path (SG1 V2/V3b).
//
// Server side: a real net.createServer whose SERVER half of the handshake runs
// through the WebSocketHandshake helpers (parseRequestHead -> validateClientRequest
// -> [parseExtensionsHeader -> negotiateServer] -> acceptResponse) exactly like
// WebSocketServer.js does, then a server-role WebSocketCore handle takes over.
//
// §5b/§5d live here: the 16 MB-then-second real-TCP ordering proof and the
// strengthened (non-vacuous) take-over guard.
//
// Client side: a hand-rolled raw TCP client that speaks frames via the
// independent oracle encoder in harness.mjs. Compressed-message oracles use
// node's own zlib: a ONE-SHOT deflateRawSync for single messages, and a
// PERSISTENT deflateRaw fed a Z_SYNC_FLUSH per message (with the trailing
// 00 00 FF FF stripped) for take-over streams -- a one-shot stream per
// message would silently break the second message's back references and let
// a fresh-stream implementation falsely pass. The receiver appends the sync
// trailer itself (RFC 7692 §7.2.1), so it never appears on the wire.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import zlib from "node:zlib";

import {
  WebSocketCore as C,
  WebSocketHandshake as H,
  oracleFrame,
  oracleParse,
  collectMessages,
} from "./harness.mjs";

const maskKey = Buffer.from([0x11, 0x22, 0x33, 0x44]);
const DEFAULT_OFFER = "permessage-deflate; client_max_window_bits=15";
const DEFLATE_TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

// ---------------------------------------------------------------------------
// Generic loopback plumbing (same shape as live-probe.test.mjs)
// ---------------------------------------------------------------------------

function listen(server) {
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      server.__tracked = sockets;
      resolve();
    }),
  );
}
function close(server) {
  return new Promise((resolve) => {
    for (const s of server.__tracked || []) s.destroy();
    server.close(resolve);
  });
}

function ctors() {
  return {
    text: (view) => ({
      kind: "text",
      bytes: Buffer.from(view.buffer, view.byteOffset, view.byteLength),
    }),
    binary: (view) => ({
      kind: "binary",
      bytes: Buffer.from(view.buffer, view.byteOffset, view.byteLength),
    }),
  };
}

async function waitUntil(pred, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out: " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Walk `buf` and require `count` COMPLETE frames (see live-probe.test.mjs).
function scanFrames(buf, count) {
  let p = 0;
  const frames = [];
  for (let i = 0; i < count; i++) {
    if (p + 2 > buf.length) return null;
    const b1 = buf[p + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = p + 2;
    if (len === 126) {
      if (off + 2 > buf.length) return null;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (off + 8 > buf.length) return null;
      len = buf.readUInt32BE(off) * 4294967296 + buf.readUInt32BE(off + 4);
      off += 8;
    }
    if (masked) {
      if (off + 4 > buf.length) return null;
      off += 4;
    }
    if (off + len > buf.length) return null;
    frames.push(...oracleParse(buf.subarray(p, off + len)));
    p = off + len;
  }
  return { frames, bytes: p };
}

const framesPred = (count) => (buf) => scanFrames(buf, count);
const headPred = (buf) => {
  const i = buf.indexOf("\r\n\r\n", 0, "latin1");
  return i === -1 ? null : buf.subarray(0, i + 4);
};

// One-shot raw TCP client with a promise queue fed by incoming bytes.
function rawClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", reject);
    const state = {
      socket,
      buffer: Buffer.alloc(0),
      waiters: [],
      closed: new Promise((res) => socket.once("close", res)),
      waitFor(pred, timeout = 5000) {
        const existing = pred(state.buffer);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error("timed out waiting for bytes")),
            timeout,
          );
          state.waiters.push({ pred, res, rej, timer });
        });
      },
      consume(n) {
        const out = state.buffer.subarray(0, n);
        state.buffer = state.buffer.subarray(n);
        return Buffer.from(out);
      },
      send(...frames) {
        socket.write(
          Buffer.concat(
            frames.map((f) => (Buffer.isBuffer(f) ? f : Buffer.from(f))),
          ),
        );
      },
      // Like `send`, but issues its OWN socket.write() after `ms` -- used by
      // §5b to put the two frames in SEPARATE data events. `beforeWrite` runs
      // (and may throw) immediately before that write, so the in-test
      // window-open precondition is checked at exactly that instant.
      sendDelayed(ms, frame, beforeWrite) {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              if (beforeWrite) beforeWrite();
            } catch (err) {
              reject(err);
              return;
            }
            socket.write(Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
            resolve();
          }, ms);
        });
      },
    };
    socket.on("data", (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const w of [...state.waiters]) {
        const hit = w.pred(state.buffer);
        if (hit) {
          clearTimeout(w.timer);
          state.waiters.splice(state.waiters.indexOf(w), 1);
          w.res(hit);
        }
      }
    });
    socket.once("connect", () => resolve(state));
  });
}

// Build a client request with an arbitrary extensions offer (null => no offer),
// reusing _WebSocketHandshake_buildClientRequest for the byte layout.
function buildRequest(port, path, offer) {
  const built = H._WebSocketHandshake_buildClientRequest({
    host: "127.0.0.1",
    port,
    pathWithQuery: path,
    isTls: false,
    extensions: offer === null ? undefined : true,
  });
  if (offer === null || offer === DEFAULT_OFFER) return built;
  const replaced = built.request
    .toString("latin1")
    .replace(
      "Sec-WebSocket-Extensions: " + DEFAULT_OFFER + "\r\n",
      "Sec-WebSocket-Extensions: " + offer + "\r\n",
    );
  return { key: built.key, request: Buffer.from(replaced, "latin1") };
}

// Hand-roll the SERVER handshake (helpers only) and call onUpgraded with the
// socket, the leftover frame bytes and the negotiation answer. `compression`
// mirrors the kernel's __$compressionEnabled: false => no parsing, no
// negotiation, acceptResponse(key, null) (byte-identical v1 101).
function probeServer(compression, onUpgraded, onRecord) {
  return net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const sep = buffer.indexOf("\r\n\r\n", 0, "latin1");
      if (sep === -1) return;
      socket.removeListener("data", onData);
      const headBytes = Buffer.from(buffer.subarray(0, sep + 4));
      const leftover = Buffer.from(buffer.subarray(sep + 4));
      const parsed = H._WebSocketHandshake_parseRequestHead(headBytes);
      if (!parsed.ok) throw new Error("client request head must parse");
      const validity = H._WebSocketHandshake_validateClientRequest(parsed);
      if (!validity.ok) throw new Error("client request must validate");

      let answer = { responseLine: null, params: null };
      if (compression) {
        const ext = H._WebSocketHandshake_parseExtensionsHeader(
          parsed.headers["sec-websocket-extensions"],
        );
        if (!ext.ok) {
          socket.write(H._WebSocketHandshake_rejectResponse("BadRequest"));
          socket.end();
          return;
        }
        answer = H._WebSocketHandshake_negotiateServer(ext.elements);
      }
      const responseBytes = H._WebSocketHandshake_acceptResponse(
        parsed.headers["sec-websocket-key"],
        answer.responseLine,
      );
      if (onRecord) {
        onRecord({ headBytes, responseBytes, answer, parsed, leftover });
      }
      socket.write(responseBytes);
      if (onUpgraded) onUpgraded(socket, parsed, leftover, answer);
    };
    socket.on("data", onData);
  });
}

// A negotiated server: handshake with compression ON, then a server-role core
// handle configured exactly like WebSocketServer.js maps the answer.
async function startInflateServer(out) {
  const server = probeServer(true, (socket, parsed, leftover, answer) => {
    if (answer.responseLine === null) {
      throw new Error("server must accept the client's offer");
    }
    out.permessageDeflate = {
      role: "server",
      resetInboundPerMessage: answer.params.clientNoContextTakeover,
      serverMaxWindowBits: answer.params.serverMaxWindowBits,
      clientMaxWindowBits: answer.params.clientMaxWindowBits,
    };
    const handle = C._WebSocketCore_attach(socket, {
      role: "server",
      permessageDeflate: out.permessageDeflate,
      ctors: ctors(),
      initialBytes: leftover,
      onClose: (code, reason) => out.closes.push({ code, reason }),
    });
    out.messages = collectMessages(handle);
    out.handle = handle;
  });
  await listen(server);
  return server;
}

// Upgrade a raw client connection over a fresh probe server.
async function upgradeRawClient(port, path, offer) {
  const client = await rawClient(port);
  const { key, request } = buildRequest(port, path, offer);
  client.send(request);
  const head = await client.waitFor(headPred);
  client.consume(head.length);
  return { client, key, head };
}

// ---------------------------------------------------------------------------
// Compressed-message oracles (node zlib, independent of the kernel)
// ---------------------------------------------------------------------------

const zlibWrite = (stream, buf) => new Promise((res) => stream.write(buf, res));
const zlibFlush = (stream, kind) =>
  new Promise((res) =>
    kind === undefined ? stream.flush(res) : stream.flush(kind, res),
  );

// Single message: one-shot raw DEFLATE. The WIRE payload carries no sync
// trailer -- RFC 7692 §7.2.1 has the RECEIVER append 00 00 FF FF -- so the
// deflateRawSync stream goes out verbatim (the harness oracle's `rsv` bit 0
// is RSV3; RSV1 is the value 4).
const oneShot = (payload) => zlib.deflateRawSync(payload);

// Take-over: ONE persistent deflateRaw, Z_SYNC_FLUSH after each message, with
// the trailing 00 00 FF FF stripped off every wire payload.
function persistentOracle() {
  const stream = zlib.createDeflateRaw({ windowBits: 15 });
  let outputs = [];
  stream.on("data", (c) => outputs.push(c));
  return {
    async message(payload) {
      outputs = [];
      await zlibWrite(stream, payload);
      await zlibFlush(stream, zlib.constants.Z_SYNC_FLUSH);
      const joined = Buffer.concat(outputs);
      return joined.subarray(0, joined.length - DEFLATE_TRAILER.length);
    },
  };
}

// ---------------------------------------------------------------------------
// V2(a,b): offer bytes and probe-server 101 negotiation
// ---------------------------------------------------------------------------

test("V2(a): enabled client request carries the offer after Sec-WebSocket-Version: 13", () => {
  const { request } = H._WebSocketHandshake_buildClientRequest({
    host: "127.0.0.1",
    port: 1234,
    pathWithQuery: "/",
    isTls: false,
    extensions: true,
  });
  const text = request.toString("latin1");
  const versionIdx = text.indexOf("Sec-WebSocket-Version: 13\r\n");
  const offerIdx = text.indexOf(
    "Sec-WebSocket-Extensions: " + DEFAULT_OFFER + "\r\n",
  );
  assert.ok(versionIdx !== -1, "request must carry the version header");
  assert.ok(offerIdx !== -1, "request must carry the default offer header");
  assert.ok(offerIdx > versionIdx, "offer must follow the version header");
});

test("V2(b): probe-server 101 carries the exact negotiated extensions line", async () => {
  const cases = [
    { offer: null, expectLine: null },
    { offer: "permessage-deflate", expectLine: "permessage-deflate" },
    { offer: DEFAULT_OFFER, expectLine: DEFAULT_OFFER },
    {
      offer:
        "permessage-deflate; server_no_context_takeover; " +
        "client_no_context_takeover; server_max_window_bits=10; " +
        "client_max_window_bits",
      expectLine:
        "permessage-deflate; server_no_context_takeover; " +
        "client_no_context_takeover; server_max_window_bits=10; " +
        "client_max_window_bits=15",
    },
    {
      offer: "x-unknown, permessage-deflate",
      expectLine: "permessage-deflate",
    },
  ];

  for (const current of cases) {
    const records = [];
    const server = probeServer(true, null, (r) => records.push(r));
    await listen(server);
    const port = server.address().port;
    try {
      const client = await rawClient(port);
      const { key, request } = buildRequest(port, "/probe", current.offer);
      client.send(request);
      const head = await client.waitFor(headPred);
      const headText = head.toString("latin1");
      assert.equal(records.length, 1, "server must have seen the request");

      if (current.expectLine === null) {
        assert.ok(
          headText.indexOf("Sec-WebSocket-Extensions") === -1,
          "no offer -> 101 must carry no extensions header",
        );
        assert.deepEqual(
          records[0].headBytes
            .toString("latin1")
            .indexOf("Sec-WebSocket-Extensions"),
          -1,
          "wire request must carry no extensions header",
        );
      } else {
        assert.ok(
          headText.includes(
            "Sec-WebSocket-Extensions: " + current.expectLine + "\r\n",
          ),
          "101 must carry the negotiated line: " + current.expectLine,
        );
        assert.ok(
          records[0].responseBytes
            .toString("latin1")
            .includes(
              "Sec-WebSocket-Extensions: " + current.expectLine + "\r\n",
            ),
          "captured 101 bytes must carry the negotiated line",
        );
      }

      if (current.offer === DEFAULT_OFFER) {
        const validity = H._WebSocketHandshake_validateServerResponse(
          key,
          head,
          {
            offeredExtensions: DEFAULT_OFFER,
          },
        );
        assert.equal(validity.ok, true, "client must accept the answer");
        assert.deepEqual(validity.params, {
          serverNoContextTakeover: false,
          clientNoContextTakeover: false,
          serverMaxWindowBits: 15,
          clientMaxWindowBits: 15,
        });
      }
      client.socket.destroy();
    } finally {
      await close(server);
    }
  }
});

// ---------------------------------------------------------------------------
// V2(c): negotiated server inflates oracle RSV1 frames
// ---------------------------------------------------------------------------

test("V2(c): negotiated server inflates a single oracle RSV1 text frame", async () => {
  const out = { messages: [], closes: [], handle: null };
  const server = await startInflateServer(out);
  const port = server.address().port;
  try {
    const { client } = await upgradeRawClient(port, "/inflate", DEFAULT_OFFER);
    await waitUntil(() => out.handle !== null, "server handle");
    assert.equal(out.permessageDeflate.resetInboundPerMessage, false);

    const text = "compressed hello — permessage-deflate ✓";
    client.send(
      oracleFrame({
        rsv: 4,
        opcode: 0x1,
        payload: oneShot(Buffer.from(text, "utf8")),
        mask: true,
        maskKey,
      }),
    );
    await waitUntil(() => out.messages.length >= 1, "inflated message");
    assert.equal(out.messages[0].kind, "text");
    assert.equal(out.messages[0].bytes.toString("utf8"), text);
    client.socket.destroy();
  } finally {
    await close(server);
  }
});

// §5d: the in-repo TAKE-OVER guard. The messages are long and repetitive, so
// a persistent deflater encodes the later message as tens of bytes of pure
// back-references into the previous message's window; a fresh-stream
// (per-message) implementation cannot decode that and cannot pass. The
// deterministic fake-socket twin is §5a(g) in
// permessage-deflate-order.test.mjs.
test("V2(c)/§5d: take-over stream delivers BOTH messages byte-exact (non-vacuous)", async () => {
  const out = { messages: [], closes: [], handle: null };
  const server = await startInflateServer(out);
  const port = server.address().port;
  try {
    const { client } = await upgradeRawClient(port, "/takeover", DEFAULT_OFFER);
    await waitUntil(() => out.handle !== null, "server handle");
    assert.equal(out.permessageDeflate.resetInboundPerMessage, false);

    const oracle = persistentOracle();
    const first = "take-over block one:".repeat(1000);
    const second = "take-over block two:".repeat(1000);
    const p1 = await oracle.message(Buffer.from(first, "utf8"));
    const p2 = await oracle.message(Buffer.from(second, "utf8"));
    // Non-vacuous: message two is tiny on the wire, which is only possible via
    // back-references into message one's 32 KiB window.
    assert.ok(p1.length < 200, "msg1 wire size " + p1.length);
    assert.ok(p2.length < 200, "msg2 wire size " + p2.length);
    const f1 = oracleFrame({
      rsv: 4,
      opcode: 0x1,
      payload: p1,
      mask: true,
      maskKey,
    });
    const f2 = oracleFrame({
      rsv: 4,
      opcode: 0x1,
      payload: p2,
      mask: true,
      maskKey,
    });
    // Both frames in ONE TCP segment: the parser must pause at message one's
    // FIN and resume on the inflate callback before decoding message two.
    client.send(f1, f2);
    await waitUntil(() => out.messages.length >= 2, "both messages");
    assert.equal(out.messages[0].bytes.toString("utf8"), first);
    assert.equal(out.messages[1].bytes.toString("utf8"), second);
    client.socket.destroy();
  } finally {
    await close(server);
  }
});

// §5b: real-TCP pending-window proof. The 16 MB compressed message is written
// in ONE socket.write; ~2 ms later the second message is written in a SEPARATE
// socket.write while the first frame's decode is still pending -- asserted
// in-test (messages.length === 0 immediately before the second write), because
// a single-write form is NOT discriminating: two frames in one data event keep
// their order even on the pre-edit kernel. For this exact stimulus the pre-edit
// kernel delivered ONE garbled merged 16 MB message (recorded:
// cycle3-sg1-5b-failing-before.txt); the current kernel delivers both payloads
// byte-exact AND in order, 3/3. The 2 ms delay sits well inside the measured
// pending window (frame 2 written -> both messages delivered ~= 40 ms, i.e.
// ~20x; 3 probe runs, cycle3-sg1-5b-window-margin.txt). NOTE: the 1550.6 ms
// figure in check2-c2-window-scratch-current.txt CHECK2[c] is dominated by that
// probe's fixed 1500 ms sleep and is NOT a decode measurement. The delay is
// plumbing only -- no elapsed-time assertion is made; the in-test
// `messages.length === 0` assertion is the actual window-open proof.
test("§5b: 16 MB message then a second message, byte-exact and in order (3/3)", async () => {
  const big = Buffer.alloc(16 * 1024 * 1024, 0x41);
  big.write("END-OF-BIG-BLOCK!", big.length - 16, "utf8");
  const second = Buffer.from(
    "second message right after the 16 MB one",
    "utf8",
  );

  for (let rep = 0; rep < 3; rep += 1) {
    const out = { messages: [], closes: [], handle: null };
    const server = await startInflateServer(out);
    const port = server.address().port;
    try {
      const { client } = await upgradeRawClient(
        port,
        "/big-" + rep,
        DEFAULT_OFFER,
      );
      await waitUntil(() => out.handle !== null, "server handle");
      assert.equal(out.permessageDeflate.resetInboundPerMessage, false);

      const oracle = persistentOracle();
      const p1 = await oracle.message(big);
      const p2 = await oracle.message(second);
      const f1 = oracleFrame({
        rsv: 4,
        opcode: 0x2,
        payload: p1,
        mask: true,
        maskKey,
      });
      const f2 = oracleFrame({
        rsv: 4,
        opcode: 0x1,
        payload: p2,
        mask: true,
        maskKey,
      });
      client.socket.write(f1); // frame 1: its own TCP write
      await client.sendDelayed(2, f2, () =>
        assert.equal(
          out.messages.length,
          0,
          "decode must still be pending when frame 2 is written",
        ),
      ); // frame 2: a SEPARATE write ~2 ms later, never the concatenating `send`

      await waitUntil(
        () => out.messages.length >= 2,
        "both messages (rep " + rep + ")",
        20000,
      );
      assert.equal(out.messages[0].kind, "binary", "rep " + rep);
      assert.equal(out.messages[0].bytes.length, big.length, "rep " + rep);
      assert.ok(
        out.messages[0].bytes.equals(big),
        "rep " + rep + ": msg1 must be the 16 MB payload byte-exact",
      );
      assert.equal(out.messages[1].kind, "text", "rep " + rep);
      assert.ok(
        out.messages[1].bytes.equals(second),
        "rep " + rep + ": msg2 must be byte-exact and second",
      );
      client.socket.destroy();
    } finally {
      await close(server);
    }
  }
});

test("V2(c): resetInboundPerMessage decodes two fresh oracle streams", async () => {
  const out = { messages: [], closes: [], handle: null };
  const server = await startInflateServer(out);
  const port = server.address().port;
  try {
    const { client } = await upgradeRawClient(
      port,
      "/reset",
      "permessage-deflate; client_no_context_takeover",
    );
    await waitUntil(() => out.handle !== null, "server handle");
    assert.equal(out.permessageDeflate.resetInboundPerMessage, true);

    const first = "reset message one";
    const second = "reset message two";
    const oracleA = persistentOracle();
    const oracleB = persistentOracle(); // fresh context, no shared window
    client.send(
      oracleFrame({
        rsv: 4,
        opcode: 0x1,
        payload: await oracleA.message(Buffer.from(first, "utf8")),
        mask: true,
        maskKey,
      }),
      oracleFrame({
        rsv: 4,
        opcode: 0x1,
        payload: await oracleB.message(Buffer.from(second, "utf8")),
        mask: true,
        maskKey,
      }),
    );
    await waitUntil(() => out.messages.length >= 2, "both messages");
    assert.equal(out.messages[0].bytes.toString("utf8"), first);
    assert.equal(out.messages[1].bytes.toString("utf8"), second);
    client.socket.destroy();
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// V2(d): enabled-but-not-negotiated connection rejects RSV1
// ---------------------------------------------------------------------------

test("V2(d): RSV1 frame on a non-negotiating connection -> Close(1002)", async () => {
  const out = { closes: [] };
  const server = probeServer(true, (socket, _parsed, leftover, answer) => {
    assert.equal(answer.responseLine, null, "no offer -> server declines");
    const handle = C._WebSocketCore_attach(socket, {
      role: "server",
      permessageDeflate: null,
      ctors: ctors(),
      initialBytes: leftover,
      onClose: (code, reason) => out.closes.push({ code, reason }),
    });
    collectMessages(handle);
  });
  await listen(server);
  const port = server.address().port;
  try {
    const { client } = await upgradeRawClient(port, "/rsv1-plain", null);
    client.send(
      oracleFrame({
        rsv: 4,
        opcode: 0x1,
        payload: oneShot(Buffer.from("q")),
        mask: true,
        maskKey,
      }),
    );
    const got = await client.waitFor(framesPred(1));
    client.consume(got.bytes);
    assert.equal(got.frames[0].opcode, 0x8);
    assert.equal(got.frames[0].payload.readUInt16BE(0), 1002);
    client.socket.destroy();
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// V3b: the disabled path emits no extensions bytes and ignores an echo
// ---------------------------------------------------------------------------

test("V3b: compression disabled emits no Sec-WebSocket-Extensions on either side", async () => {
  // (1) disabled CLIENT request against a negotiating server: no offer.
  const records = [];
  const server = probeServer(true, null, (r) => records.push(r));
  await listen(server);
  const port = server.address().port;
  try {
    const client = await rawClient(port);
    const { request } = buildRequest(port, "/disabled", null);
    assert.ok(
      request.toString("latin1").indexOf("Sec-WebSocket-Extensions") === -1,
      "disabled client request must not offer",
    );
    client.send(request);
    const head = await client.waitFor(headPred);
    assert.ok(
      head.toString("latin1").indexOf("Sec-WebSocket-Extensions") === -1,
      "101 must carry no extensions header",
    );
    assert.ok(
      records[0].headBytes
        .toString("latin1")
        .indexOf("Sec-WebSocket-Extensions") === -1,
      "wire request must not offer",
    );
    assert.equal(records[0].answer.responseLine, null);
    assert.ok(
      records[0].responseBytes
        .toString("latin1")
        .indexOf("Sec-WebSocket-Extensions") === -1,
      "captured 101 must carry no extensions header",
    );
    client.socket.destroy();
  } finally {
    await close(server);
  }

  // (2) disabled SERVER 101 against a hand-rolled OFFERING client: no accept.
  const records2 = [];
  const server2 = probeServer(false, null, (r) => records2.push(r));
  await listen(server2);
  const port2 = server2.address().port;
  try {
    const client = await rawClient(port2);
    const { request } = buildRequest(port2, "/disabled-server", DEFAULT_OFFER);
    client.send(request);
    const head = await client.waitFor(headPred);
    assert.ok(
      records2[0].headBytes
        .toString("latin1")
        .includes("Sec-WebSocket-Extensions: " + DEFAULT_OFFER),
      "the peer did offer",
    );
    assert.ok(
      head.toString("latin1").indexOf("Sec-WebSocket-Extensions") === -1,
      "disabled 101 must not accept the offer",
    );
    assert.equal(records2[0].answer.responseLine, null);
    client.socket.destroy();
  } finally {
    await close(server2);
  }

  // (3) the disabled accept path is byte-identical to the v1 layout.
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const v1 = H._WebSocketHandshake_acceptResponse(key);
  const disabled = H._WebSocketHandshake_acceptResponse(key, null);
  assert.deepEqual(disabled, v1, "acceptResponse(key, null) must equal v1");
  assert.ok(
    v1.toString("latin1").indexOf("Sec-WebSocket-Extensions") === -1,
    "v1 101 must carry no extensions header",
  );
});

test("V3b: disabled client ignores an echoed permessage-deflate answer, then 1002s on RSV1", async () => {
  const serverLog = { requestHead: null, close: null };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const sep = buffer.indexOf("\r\n\r\n", 0, "latin1");
      if (sep === -1) return;
      socket.removeListener("data", onData);
      const head = buffer.subarray(0, sep + 4).toString("latin1");
      serverLog.requestHead = head;
      const keyMatch = /^Sec-WebSocket-Key: (.+)$/im.exec(head);
      // UNSOLICITED echo: the client never offered, yet the server still
      // answers with permessage-deflate. RFC 6455 §4.1 would have the client
      // Fail; the disabled client deliberately ignores it (documented).
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: " +
          H._WebSocketHandshake_acceptValue(keyMatch[1]) +
          "\r\n" +
          "Sec-WebSocket-Extensions: permessage-deflate\r\n" +
          "\r\n",
      );
      // …then an RSV1 text frame on a connection with NO negotiated extension.
      socket.write(
        oracleFrame({
          rsv: 4,
          opcode: 0x1,
          payload: oneShot(Buffer.from("denied")),
        }),
      );

      let rest = buffer.subarray(sep + 4);
      const pump = () => {
        const scanned = scanFrames(rest, 1);
        if (scanned === null) return;
        rest = rest.subarray(scanned.bytes);
        for (const f of scanned.frames) {
          if (f.opcode === 0x8) {
            serverLog.close = f.payload.readUInt16BE(0);
          }
        }
        pump();
      };
      socket.on("data", (c) => {
        rest = Buffer.concat([rest, c]);
        pump();
      });
      pump();
    };
    socket.on("data", onData);
  });
  await listen(server);
  const port = server.address().port;
  try {
    const netSocket = net.connect(port, "127.0.0.1");
    await new Promise((r) => netSocket.once("connect", r));

    const { key, request } = buildRequest(port, "/echoed", null);
    // Consume the 101 head with a temporary listener, then attach the engine:
    // mirrors _WebSocketClient_beginHandshake's handoff so a coalesced RSV1
    // frame is not double-fed.
    const leftover = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        const i = chunk.indexOf("\r\n\r\n", 0, "latin1");
        if (i === -1) return;
        netSocket.removeListener("data", onData);
        const head = chunk.subarray(0, i + 4);
        assert.ok(
          head.toString("latin1").includes("Sec-WebSocket-Extensions"),
          "the server echoed permessage-deflate",
        );
        // No offer was sent, so the v1 signature ignores the echo entirely:
        // this is the documented deviation (connect succeeds).
        assert.deepEqual(
          H._WebSocketHandshake_validateServerResponse(key, head),
          { ok: true },
        );
        resolve(chunk.subarray(i + 4));
      };
      netSocket.on("data", onData);
      netSocket.on("error", reject);
      netSocket.write(request);
    });

    assert.ok(
      serverLog.requestHead.indexOf("Sec-WebSocket-Extensions") === -1,
      "disabled client must not have offered",
    );

    const seen = { closes: [] };
    const handle = C._WebSocketCore_attach(netSocket, {
      role: "client",
      permessageDeflate: null,
      ctors: ctors(),
      onClose: (code, reason) => seen.closes.push({ code, reason }),
    });
    collectMessages(handle);
    if (leftover.length > 0) netSocket.emit("data", leftover);

    await waitUntil(() => serverLog.close !== null, "server sees Close(1002)");
    assert.equal(serverLog.close, 1002);
    assert.equal(seen.closes.length, 1);
    assert.equal(seen.closes[0].code, 1002);
    netSocket.destroy();
  } finally {
    await close(server);
  }
});
