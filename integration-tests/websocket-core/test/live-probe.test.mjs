// Live loopback probe (PLAN Phase 3 acceptance: "loopback
// text/binary/fragmented/ping roundtrip via raw-socket probe script", made
// permanent as a test).
//
// Server side: real net.createServer; the SERVER half of the handshake runs
// manually through the WebSocketHandshake helpers (parse request head ->
// validate -> write acceptResponse), then a server-role WebSocketCore handle
// takes over the socket and echoes everything back (text->text, binary->
// binary, kernel auto-pong, clean close handshake).
//
// Client side: a hand-rolled raw TCP client that performs the full client
// handshake (buildClientRequest, validateServerResponse) and speaks frames
// via the independent oracle encoder; plus a second scenario driving the
// core CLIENT engine against the same kind of server, which proves the
// masked-out path, per-message keying and outbound fragmentation
// reassembly end to end over real TCP.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  WebSocketCore as C,
  WebSocketHandshake as H,
  oracleFrame,
  oracleParse,
} from "./harness.mjs";

const maskKey = Buffer.from([0x11, 0x22, 0x33, 0x44]);

function listen(server) {
  // Track accepted sockets so close() can never hang on a connection leaked
  // by a mid-test assertion failure (server.close waits for all of them).
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

// Walk `buf` and require `count` COMPLETE frames; returns null until enough
// bytes exist, then { frames, bytes } (bytes = consumed length). Frames are
// decoded by the independent oracle parser on exact frame slices, so an
// incomplete tail can never be mistaken for a frame.
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

// Manual server-side handshake: accumulate until the header block is done,
// validate, reply 101, then hand the socket to onUpgraded.
function rawWsServer(onUpgraded) {
  return net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.indexOf("\r\n\r\n", 0, "latin1") === -1) return;
      socket.removeListener("data", onData);

      const parsed = H._WebSocketHandshake_parseRequestHead(buffer);
      if (!parsed.ok) throw new Error("client request head must parse");
      const validity = H._WebSocketHandshake_validateClientRequest(parsed);
      if (!validity.ok) throw new Error("client request must validate");

      socket.write(
        H._WebSocketHandshake_acceptResponse(
          parsed.headers["sec-websocket-key"],
        ),
      );
      onUpgraded(socket, parsed.path);
    };
    socket.on("data", onData);
  });
}

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

// Perform the client handshake over a fresh raw connection; assert the 101.
async function handshakeClient(port, path) {
  const client = await rawClient(port);
  const { key, request } = H._WebSocketHandshake_buildClientRequest({
    host: "127.0.0.1",
    port,
    pathWithQuery: path,
    isTls: false,
  });
  client.send(request);
  const head = await client.waitFor((buf) => {
    const i = buf.indexOf("\r\n\r\n", 0, "latin1");
    return i === -1 ? null : buf.subarray(0, i + 4);
  });
  const validity = H._WebSocketHandshake_validateServerResponse(key, head);
  assert.deepEqual(validity, { ok: true }, "handshake must validate");
  client.consume(head.length);
  return client;
}

const framesPred = (count) => (buf) => scanFrames(buf, count);

test("live loopback: raw-handshake client <-> core server handle (echo, ping, fragmented, close)", async () => {
  const seen = { path: null, closes: [] };
  const server = rawWsServer((socket, path) => {
    seen.path = path;
    const handle = C._WebSocketCore_attach(socket, {
      role: "server",
      ctors: ctors(),
      onClose: (code, reason) => seen.closes.push({ code, reason }),
    });
    // echo: text->text, binary->binary back through the same engine
    const reader = handle.readable.getReader();
    (function pump() {
      reader.read().then(
        ({ done, value }) => {
          if (done) return;
          if (value.kind === "text")
            handle.sendText(value.bytes.toString("utf8"), () => {});
          else handle.sendBytes(value.bytes, () => {});
          pump();
        },
        () => {},
      );
    })();
  });
  await listen(server);
  const port = server.address().port;

  try {
    const client = await handshakeClient(port, "/echo?case=1&agent=probe");
    assert.equal(
      seen.path,
      "/echo?case=1&agent=probe",
      "path+query must survive the handshake",
    );

    // 1) text echo
    client.send(
      oracleFrame({
        opcode: 0x1,
        payload: Buffer.from("héllo wörld", "utf8"),
        mask: true,
        maskKey,
      }),
    );
    let got = await client.waitFor(framesPred(1));
    client.consume(got.bytes);
    assert.equal(got.frames[0].opcode, 0x1);
    assert.equal(got.frames[0].fin, true);
    assert.equal(got.frames[0].masked, false, "server must send unmasked");
    assert.equal(got.frames[0].payload.toString("utf8"), "héllo wörld");

    // 2) binary echo
    const bin = Buffer.from([0, 1, 2, 253, 254, 255]);
    client.send(
      oracleFrame({ opcode: 0x2, payload: bin, mask: true, maskKey }),
    );
    got = await client.waitFor(framesPred(1));
    client.consume(got.bytes);
    assert.equal(got.frames[0].opcode, 0x2);
    assert.deepEqual([...got.frames[0].payload], [...bin]);

    // 3) fragmented inbound text echoes back whole; the é (C3 A9) is split
    // across the fragment boundary
    client.send(
      oracleFrame({
        fin: false,
        opcode: 0x1,
        payload: Buffer.from([0xc3]),
        mask: true,
        maskKey,
      }),
      oracleFrame({
        fin: true,
        opcode: 0x0,
        payload: Buffer.concat([
          Buffer.from([0xa9]),
          Buffer.from("ueber", "utf8"),
        ]),
        mask: true,
        maskKey,
      }),
    );
    got = await client.waitFor(framesPred(1));
    client.consume(got.bytes);
    assert.equal(got.frames[0].opcode, 0x1);
    assert.equal(got.frames[0].payload.toString("utf8"), "éueber");

    // 4) ping gets an automatic pong
    client.send(
      oracleFrame({
        opcode: 0x9,
        payload: Buffer.from("probe-ping"),
        mask: true,
        maskKey,
      }),
    );
    got = await client.waitFor(framesPred(1));
    client.consume(got.bytes);
    assert.equal(got.frames[0].opcode, 0xa);
    assert.equal(got.frames[0].payload.toString(), "probe-ping");

    // 5) clean close handshake: client Close(1000,"probe-bye") -> echoed
    const closePayload = Buffer.concat([
      Buffer.from([0x03, 0xe8]),
      Buffer.from("probe-bye", "utf8"),
    ]);
    client.send(
      oracleFrame({ opcode: 0x8, payload: closePayload, mask: true, maskKey }),
    );
    got = await client.waitFor(framesPred(1));
    client.consume(got.bytes);
    assert.equal(got.frames[0].opcode, 0x8);
    assert.equal(got.frames[0].payload.readUInt16BE(0), 1000);
    assert.equal(
      got.frames[0].payload.subarray(2).toString("utf8"),
      "probe-bye",
    );

    client.socket.end(); // FIN from the client completes the teardown
    await client.closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen.closes, [{ code: 1000, reason: "probe-bye" }]);
    client.socket.destroy();
  } finally {
    await close(server);
  }
});

test("live loopback: core client handle <-> hand-rolled raw server", async () => {
  // The server speaks frames with the oracle encoder only; the client side
  // is the engine under test in the CLIENT role (masking mandatory).
  const serverLog = { closes: 0 };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const i = buffer.indexOf("\r\n\r\n", 0, "latin1");
      if (i === -1) return;
      socket.removeListener("data", onData);
      const head = buffer.subarray(0, i).toString("latin1");
      const keyMatch = /^Sec-WebSocket-Key: (.+)$/im.exec(head);
      if (!keyMatch) throw new Error("client must send Sec-WebSocket-Key");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: " +
          H._WebSocketHandshake_acceptValue(keyMatch[1]) +
          "\r\n\r\n",
      );

      let rest = buffer.subarray(i + 4);
      // reassemble fragmented client messages so the echo comes back as ONE
      // frame (the oracle ignores opcode-0 continuations on its own)
      let openOpcode = 0;
      let openParts = [];
      const pump = () => {
        const scanned = scanFrames(rest, 1);
        if (scanned === null) return;
        rest = rest.subarray(scanned.bytes);
        for (const f of scanned.frames) {
          if (f.opcode === 0x8) {
            serverLog.closes++;
            socket.write(oracleFrame({ opcode: 0x8, payload: f.payload }));
            socket.end();
          } else if (f.opcode === 0x9) {
            socket.write(oracleFrame({ opcode: 0xa, payload: f.payload }));
          } else if (f.opcode === 0x1 || f.opcode === 0x2) {
            if (f.fin) {
              socket.write(
                oracleFrame({ opcode: f.opcode, payload: f.payload }),
              );
            } else {
              openOpcode = f.opcode;
              openParts = [f.payload];
            }
          } else if (f.opcode === 0x0) {
            if (openOpcode === 0)
              throw new Error("continuation without open message");
            openParts.push(f.payload);
            if (f.fin) {
              socket.write(
                oracleFrame({
                  opcode: openOpcode,
                  payload: Buffer.concat(openParts),
                }),
              );
              openOpcode = 0;
              openParts = [];
            }
          }
        }
        pump(); // more frames may have coalesced
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

    // client handshake BEFORE attaching the engine (so the 101 bytes are not
    // mistaken for frames); any coalesced post-handshake bytes are injected
    // into the engine right after attach.
    const { key, request } = H._WebSocketHandshake_buildClientRequest({
      host: "127.0.0.1",
      port,
      pathWithQuery: "/raw",
      isTls: false,
    });

    const leftover = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        const i = chunk.indexOf("\r\n\r\n", 0, "latin1");
        if (i === -1) return;
        netSocket.removeListener("data", onData);
        const validity = H._WebSocketHandshake_validateServerResponse(
          key,
          chunk.subarray(0, i + 4),
        );
        assert.deepEqual(validity, { ok: true }, "server 101 must validate");
        resolve(chunk.subarray(i + 4));
      };
      netSocket.on("data", onData);
      netSocket.on("error", reject);
      netSocket.write(request);
    });

    const seen = { messages: [], closes: [] };
    const handle = C._WebSocketCore_attach(netSocket, {
      role: "client",
      ctors: ctors(),
      onClose: (code, reason) => seen.closes.push({ code, reason }),
    });
    const reader = handle.readable.getReader();
    (function pump() {
      reader.read().then(
        ({ done, value }) => {
          if (!done) {
            seen.messages.push(value);
            pump();
          }
        },
        () => {},
      );
    })();
    if (leftover.length > 0) netSocket.emit("data", leftover);

    const deadline = Date.now() + 5000;
    const waitUntil = async (pred, what) => {
      while (!pred()) {
        if (Date.now() > deadline) throw new Error("timed out: " + what);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // 1) text roundtrip through the engine (masked outbound)
    let sendErr = "pending";
    handle.sendText("core client text", (err) => (sendErr = err));
    await waitUntil(() => seen.messages.length >= 1, "text echo");
    assert.equal(sendErr, null);
    assert.equal(seen.messages[0].kind, "text");
    assert.equal(seen.messages[0].bytes.toString(), "core client text");

    // 2) 20000-byte binary -> engine fragments at 2^14, the raw server
    // reassembles via the oracle, echoes ONE unfragmented frame back, the
    // engine reassembles inbound.
    const big = Buffer.alloc(20000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
    let bigErr = "pending";
    handle.sendBytes(big, (err) => (bigErr = err));
    await waitUntil(() => seen.messages.length >= 2, "binary echo");
    assert.equal(bigErr, null);
    assert.equal(seen.messages[1].kind, "binary");
    assert.deepEqual([...seen.messages[1].bytes], [...big]);

    // 3) clean close
    handle.close(1000, "live-bye", () => {});
    await waitUntil(() => seen.closes.length >= 1, "close handshake");
    assert.equal(seen.closes[0].code, 1000);
    assert.equal(seen.closes[0].reason, "live-bye");
    assert.equal(serverLog.closes, 1);
    netSocket.destroy();
  } finally {
    await close(server);
  }
});

test("live loopback: server rejects an unmasked mid-session frame with Close(1002)", async () => {
  const server = rawWsServer((socket) => {
    C._WebSocketCore_attach(socket, {
      role: "server",
      ctors: ctors(),
      onClose: () => {},
    });
  });
  await listen(server);
  const port = server.address().port;
  try {
    const client = await handshakeClient(port, "/");
    // an UNMASKED data frame violates RFC 6455 5.1 in the client->server
    // direction; the engine must answer with Close(1002)
    client.send(oracleFrame({ opcode: 0x1, payload: Buffer.from("oops") }));
    const got = await client.waitFor(framesPred(1));
    client.consume(got.bytes);
    assert.equal(got.frames[0].opcode, 0x8);
    assert.equal(got.frames[0].payload.readUInt16BE(0), 1002);
    client.socket.end();
    await client.closed;
    client.socket.destroy();
  } finally {
    await close(server);
  }
});
