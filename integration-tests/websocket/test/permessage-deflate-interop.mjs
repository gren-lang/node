// RFC 7692 §5.3 — permessage-deflate interop against the STOCK `ws@8` oracle.
//
// This spec lives in the integration-tests/websocket suite because that suite
// already declares `ws` as a dependency; the kernel (`src/Gren/Kernel/
// WebSocketCore.js`) and the WebSocketHandshake helpers are imported READ-ONLY
// from the sibling websocket-core test directory, which must keep its "no npm
// dependencies" property.
//
// Both directions drive REAL loopback TCP with our core handle attached after a
// MANUAL handshake through the WebSocketHandshake helpers (the pattern of
// websocket-core/test/live-probe.test.mjs). The local socket's `write` is
// wrapped so every frame OUR handle emits is inspected on the wire BEFORE the
// peer sees it:
//
//   * frame 0 of every outbound DATA message must carry RSV1, continuations
//     must not, and the assembled payload with the 4-byte 00 00 ff ff trailer
//     re-appended must inflate to the input (the deflate-oracle judge);
//   * a fragmented outbound message must have FIN 0 on the first frame,
//     RSV1 only there, and FIN 1 on the last.
//
// The `ws` frames are NEVER inspected for RSV1: ws sets RSV1 = compress, and
// only narrows to a byte-length threshold when the endpoint's
// no_context_takeover has been negotiated, so ws's small/empty messages
// legitimately travel uncompressed (rsv1 = 0) while in the default
// configuration they are compressed regardless of size. ws is therefore a
// delivery oracle here, not an RSV1 oracle: its messages only have to arrive
// byte-exactly.
//
// Standalone: `cd integration-tests/websocket && node
// node_modules/mocha/bin/mocha.js test/permessage-deflate-interop.mjs` — no
// `--require test/fixtures.mjs`, no dependency on the suite's global fixture
// server (this file hosts its own peers on ephemeral ports).
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import WebSocket, { WebSocketServer } from "ws";

import {
  WebSocketCore as C,
  WebSocketHandshake as H,
} from "../../websocket-core/test/harness.mjs";
import {
  parseFrames,
  assembleMessages,
  createInflateDecoder,
} from "../../websocket-core/test/deflate-oracle.mjs";

const HOST = "127.0.0.1";

// The installed suite already declares ws@8.x and mocha; ws@8 also supports
// explicit fragmentation through `send(data, { fin })`, which is used for the
// "fragmented send" requirement on the ws side (our kernel fragments on its
// own at _WebSocketCore_FRAGMENT_SIZE).
const wsVersion = createRequire(import.meta.url)("ws/package.json").version;

// ---------------------------------------------------------------------------
// Options matrix (spec §5.3): the same 5 combinations are handed to the ws
// endpoint in BOTH directions.
// ---------------------------------------------------------------------------
const MATRIX = [
  { label: "default takeover both ways", options: true },
  {
    label: "serverNoContextTakeover",
    options: { serverNoContextTakeover: true },
  },
  {
    label: "clientNoContextTakeover",
    options: { clientNoContextTakeover: true },
  },
  {
    label: "serverMaxWindowBits=9 clientMaxWindowBits=9",
    options: { serverMaxWindowBits: 9, clientMaxWindowBits: 9 },
  },
  {
    label: "serverNoContextTakeover + windowBits 9/9",
    options: {
      serverNoContextTakeover: true,
      serverMaxWindowBits: 9,
      clientMaxWindowBits: 9,
    },
  },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function listen(server) {
  // Track accepted sockets so teardown can never hang on a leaked connection.
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, HOST, () => {
      server.__tracked = sockets;
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    for (const s of server.__tracked || []) s.destroy();
    server.close(resolve);
  });
}

function waitUntil(pred, what, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function loop() {
      let hit = false;
      try {
        hit = pred();
      } catch (err) {
        reject(err);
        return;
      }
      if (hit) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for " + what));
        return;
      }
      setTimeout(loop, 5);
    })();
  });
}

// Deterministic, genuinely incompressible bytes (xorshift32): the compressed
// output stays ~= the input length, so a 40000-byte payload exceeds
// _WebSocketCore_FRAGMENT_SIZE (16384) and forces the kernel to fragment.
function incompressible(n, seed = 0x12345678) {
  const out = Buffer.alloc(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function compressibleText(marker, repeats) {
  return (
    marker +
    " " +
    "The quick brown fox jumps over the lazy dog. ".repeat(repeats)
  );
}

// The server-side window the negotiated extension line must carry for a given
// matrix entry (ws answers server_max_window_bits=9 when it was offered/asked
// for, 15 otherwise).
function expectedServerWindow(options) {
  return options && options.serverMaxWindowBits === 9 ? 9 : 15;
}

// ---------------------------------------------------------------------------
// Wire tee (§5.4 technique): record every Buffer handed to socket.write, so
// every frame OUR handle emits can be parsed by the kernel-free oracle.
// ---------------------------------------------------------------------------

function makeTee() {
  const writes = [];
  return {
    writes,
    wrap(socket) {
      const original = socket.write;
      socket.write = function (chunk, ...rest) {
        if (Buffer.isBuffer(chunk)) writes.push(Buffer.from(chunk));
        else writes.push(Buffer.from(String(chunk), "utf8"));
        return original.call(this, chunk, ...rest);
      };
    },
    reset() {
      writes.length = 0;
    },
    // Parse the recorded writes into message groups. Every write is exactly
    // one whole frame (the kernel's writeFrame writes one frame per call), and
    // assembleMessages throws on a truncated/illegal stream, so this doubles as
    // an RSV1-placement judge (a reserved bit on a continuation or control
    // frame is rejected there).
    groups() {
      const frames = [];
      for (const w of writes) frames.push(...parseFrames(w));
      return assembleMessages(frames);
    },
  };
}

// Every outbound data message of OUR handle must be a single compressed
// message on the wire: RSV1 on frame 0 only, and the payload plus the
// 4-byte trailer must inflate to the input.
async function expectOurCompressed(tee, decoder, payload, label, opts = {}) {
  const { messages, controlFrames } = tee.groups();
  assert.equal(
    controlFrames.length,
    0,
    `${label}: no control frame may interleave with a data message`,
  );
  assert.equal(
    messages.length,
    1,
    `${label}: one send must produce exactly one data message group`,
  );
  const group = messages[0];
  assert.equal(
    group.rsv1,
    true,
    `${label}: RSV1 must be set on our compressed message (frame 0)`,
  );
  assert.equal(
    group.frames[0].rsv & 0x4,
    0x4,
    `${label}: RSV1 bit literal check on frame 0`,
  );
  for (const frame of group.frames.slice(1)) {
    assert.equal(
      frame.rsv,
      0,
      `${label}: continuation frames must not carry RSV1`,
    );
  }
  if (group.frames.length > 1) {
    assert.equal(
      group.frames[0].fin,
      false,
      `${label}: first frame of a fragmented message has FIN clear`,
    );
    assert.equal(
      group.frames[group.frames.length - 1].fin,
      true,
      `${label}: last frame of a fragmented message has FIN set`,
    );
  }
  if (opts.fragmented) {
    assert.ok(
      group.frames.length > 1,
      `${label}: expected the kernel to fragment this message`,
    );
  }
  const inflated = await decoder.decode(group.payload);
  assert.deepEqual(
    Buffer.from(inflated),
    Buffer.from(payload),
    `${label}: our payload + trailer inflates to the input`,
  );
  return group;
}

function assertDelivered(message, payload, kind, label) {
  assert.equal(message.kind, kind, `${label}: message kind`);
  assert.deepEqual(
    Buffer.from(message.bytes),
    Buffer.from(payload),
    `${label}: delivered bytes`,
  );
}

// ---------------------------------------------------------------------------
// Conversation driver: strictly sequential, so the frame order and the
// received-message indices are deterministic. The ws endpoint echoes every
// message our handle sends (so our INBOUND decoder is judged on the peer's
// compressed stream too); the peer's own sends are NOT echoed back to it.
// ---------------------------------------------------------------------------

async function ourSend(ours, peer, kind, payload, label, opts = {}) {
  const peerBefore = peer.received.length;
  const oursBefore = ours.received.length;
  ours.tee.reset();
  await ours.send(kind, payload);
  await expectOurCompressed(
    ours.tee,
    ours.decoder,
    Buffer.from(payload),
    label,
    opts,
  );
  await waitUntil(
    () => peer.received.length > peerBefore,
    `${label}: ws delivery`,
  );
  assertDelivered(peer.received[peerBefore], payload, kind, `${label}: ws got`);
  await waitUntil(
    () => ours.received.length > oursBefore,
    `${label}: ws echo back to us`,
  );
  assertDelivered(
    ours.received[oursBefore],
    payload,
    kind,
    `${label}: our decode of the ws echo`,
  );
}

async function peerSend(ours, peer, kind, payload, label) {
  const oursBefore = ours.received.length;
  const peerBefore = peer.received.length;
  peer.send(payload, kind === "binary");
  await waitUntil(
    () => ours.received.length > oursBefore,
    `${label}: our delivery`,
  );
  assertDelivered(ours.received[oursBefore], payload, kind, `${label}: we got`);
  assert.equal(
    peer.received.length,
    peerBefore,
    `${label}: the ws endpoint must not receive its own send back`,
  );
}

async function peerSendFragments(ours, peer, parts, label) {
  const oursBefore = ours.received.length;
  const peerBefore = peer.received.length;
  const expected = Buffer.concat(parts);
  peer.sendFragments(parts, true);
  await waitUntil(
    () => ours.received.length > oursBefore,
    `${label}: our delivery`,
  );
  assertDelivered(
    ours.received[oursBefore],
    expected,
    "binary",
    `${label}: reassembled`,
  );
  assert.equal(
    peer.received.length,
    peerBefore,
    `${label}: the ws endpoint must not receive its own fragments back`,
  );
}

async function conversation(ours, peer, label) {
  // 1) multi-message stream, each >= 4 KB of compressible text, ours -> ws
  //    (with ws's echo decoded by our inbound path).
  for (let i = 0; i < 4; i++) {
    await ourSend(
      ours,
      peer,
      "text",
      compressibleText(`stream-${i}`, 100),
      `${label}: text stream #${i}`,
    );
  }

  // 2) small binary, ours -> ws
  const small = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
  await ourSend(ours, peer, "binary", small, `${label}: small binary`);

  // 3) empty messages, ours -> ws (text and binary)
  await ourSend(ours, peer, "text", "", `${label}: empty text`);
  await ourSend(
    ours,
    peer,
    "binary",
    Buffer.alloc(0),
    `${label}: empty binary`,
  );

  // 4) one fragmented send from OUR kernel: 40 KB of incompressible bytes keeps
  //    the compressed output above _WebSocketCore_FRAGMENT_SIZE, so the kernel
  //    emits several frames with RSV1 on frame 0 only.
  await ourSend(
    ours,
    peer,
    "binary",
    incompressible(40000),
    `${label}: large incompressible (our fragments)`,
    { fragmented: true },
  );

  // 5) ws -> ours: text, binary, empty, a large compressible payload (ws
  //    compresses it), and one explicit ws fragmentation.
  await peerSend(
    ours,
    peer,
    "text",
    "peer text ünïcode ✓",
    `${label}: ws text`,
  );
  await peerSend(ours, peer, "binary", small, `${label}: ws binary`);
  await peerSend(ours, peer, "text", "", `${label}: ws empty text`);
  await peerSend(
    ours,
    peer,
    "binary",
    Buffer.alloc(0),
    `${label}: ws empty binary`,
  );
  await peerSend(
    ours,
    peer,
    "text",
    compressibleText("ws-large", 200),
    `${label}: ws large compressible text`,
  );
  await peerSendFragments(
    ours,
    peer,
    [
      Buffer.from(compressibleText("frag-a", 60)),
      Buffer.from(compressibleText("frag-b", 60)),
    ],
    `${label}: ws explicit fragments`,
  );
}

// ---------------------------------------------------------------------------
// Direction A: stock ws SERVER + our CORE CLIENT handle.
// ---------------------------------------------------------------------------

async function runDirectionA(matrixLabel, options) {
  const label = `A[${matrixLabel}]`;
  const peer = {
    received: [],
    errors: [],
    closeCodes: [],
    socket: null,
    send(payload, isBinary) {
      peer.socket.send(payload, { binary: isBinary });
    },
    sendFragments(parts, isBinary) {
      parts.forEach((part, i) =>
        peer.socket.send(part, {
          binary: isBinary,
          fin: i === parts.length - 1,
        }),
      );
    },
  };

  const wss = new WebSocketServer({
    host: HOST,
    port: 0,
    perMessageDeflate: options,
  });
  wss.on("error", (err) => peer.errors.push("server: " + err.message));
  wss.on("connection", (socket) => {
    peer.socket = socket;
    socket.on("error", (err) => peer.errors.push("socket: " + err.message));
    socket.on("close", (code) => peer.closeCodes.push(code));
    socket.on("message", (data, isBinary) => {
      peer.received.push({
        kind: isBinary ? "binary" : "text",
        bytes: Buffer.from(data),
      });
      socket.send(data, { binary: isBinary });
    });
  });
  await new Promise((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const netSocket = net.connect(wss.address().port, HOST);
  const ours = { received: [], errors: [], closes: [] };
  try {
    await new Promise((resolve, reject) => {
      netSocket.once("connect", resolve);
      netSocket.once("error", reject);
    });

    // Manual CLIENT handshake with the RFC 7692 default offer, validated by the
    // kernel's own client-side validator.
    const { key, request } = H._WebSocketHandshake_buildClientRequest({
      host: HOST,
      port: wss.address().port,
      pathWithQuery: "/interop",
      isTls: false,
      extensions: true,
    });
    const { params, rest } = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        const i = chunk.indexOf("\r\n\r\n", 0, "latin1");
        if (i === -1) return;
        netSocket.removeListener("data", onData);
        const head = chunk.subarray(0, i + 4);
        const validity = H._WebSocketHandshake_validateServerResponse(
          key,
          head,
          {
            offeredParams: H._WebSocketHandshake_DEFAULT_OFFER_PARAMS,
          },
        );
        if (!validity.ok) {
          reject(
            new Error(
              "server 101 must validate: " + JSON.stringify(validity.error),
            ),
          );
          return;
        }
        resolve({ params: validity.params, rest: chunk.subarray(i + 4) });
      };
      netSocket.on("data", onData);
      netSocket.on("error", reject);
      netSocket.write(request);
    });
    assert.notEqual(
      params,
      null,
      `${label}: ws must agree to permessage-deflate`,
    );
    assert.equal(
      params.serverMaxWindowBits,
      expectedServerWindow(options),
      `${label}: negotiated server window`,
    );

    const tee = makeTee();
    tee.wrap(netSocket);
    const handle = C._WebSocketCore_attach(netSocket, {
      role: "client",
      ctors: ctors(),
      permessageDeflate: {
        role: "client",
        resetInboundPerMessage: params.serverNoContextTakeover,
        resetOutboundPerMessage: params.clientNoContextTakeover,
        serverMaxWindowBits: params.serverMaxWindowBits,
        clientMaxWindowBits: params.clientMaxWindowBits,
      },
      onError: (message) => ours.errors.push(message),
      onClose: (code, reason) => ours.closes.push({ code, reason }),
      initialBytes: rest.length > 0 ? rest : undefined,
    });
    ours.handle = handle;
    ours.tee = tee;
    ours.decoder = createInflateDecoder({
      resetPerMessage: params.clientNoContextTakeover,
    });
    ours.send = (kind, payload) =>
      new Promise((resolve, reject) => {
        const cb = (err) => (err ? reject(err) : resolve());
        if (kind === "text") handle.sendText(payload, cb);
        else handle.sendBytes(payload, cb);
      });

    const reader = handle.readable.getReader();
    (function pump() {
      reader.read().then(
        ({ done, value }) => {
          if (!done) {
            ours.received.push(value);
            pump();
          }
        },
        () => {},
      );
    })();

    await conversation(ours, peer, label);

    // Clean close handshake: our client initiates; ws echoes. No protocol close.
    handle.close(1000, "interop-bye");
    await waitUntil(() => ours.closes.length > 0, `${label}: our close`);
    assert.equal(ours.closes[0].code, 1000, `${label}: our clean close code`);
    await waitUntil(() => peer.closeCodes.length > 0, `${label}: ws close`);
    assert.ok(
      peer.closeCodes.every((code) => code === 1000 || code === 1005),
      `${label}: ws must observe a normal close, saw ${peer.closeCodes}`,
    );
  } finally {
    netSocket.destroy();
    await new Promise((resolve) => wss.close(resolve));
  }

  assert.deepEqual(
    ours.errors,
    [],
    `${label}: our handle saw no protocol error`,
  );
  assert.deepEqual(peer.errors, [], `${label}: ws saw no error`);
}

// ---------------------------------------------------------------------------
// Direction B: stock ws CLIENT + our CORE SERVER handle.
// ---------------------------------------------------------------------------

function coreServer(onUpgraded) {
  return net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const i = buffer.indexOf("\r\n\r\n", 0, "latin1");
      if (i === -1) return;
      socket.removeListener("data", onData);
      const parsed = H._WebSocketHandshake_parseRequestHead(buffer);
      if (!parsed.ok)
        throw new Error("request head must parse: " + parsed.message);
      const validity = H._WebSocketHandshake_validateClientRequest(parsed);
      if (!validity.ok) {
        throw new Error("request must validate: " + JSON.stringify(validity));
      }
      const extensions = H._WebSocketHandshake_parseExtensionsHeader(
        parsed.headers["sec-websocket-extensions"],
      );
      if (!extensions.ok) throw new Error("extensions header must parse");
      const answer = H._WebSocketHandshake_negotiateServer(extensions.elements);
      socket.write(
        H._WebSocketHandshake_acceptResponse(
          parsed.headers["sec-websocket-key"],
          answer.responseLine,
        ),
      );
      onUpgraded(socket, answer, buffer.subarray(i + 4));
    };
    socket.on("data", onData);
  });
}

async function runDirectionB(matrixLabel, options) {
  const label = `B[${matrixLabel}]`;
  const ours = { received: [], errors: [], closes: [] };
  const peer = {
    received: [],
    errors: [],
    closeCodes: [],
    client: null,
    send(payload, isBinary) {
      peer.client.send(payload, { binary: isBinary });
    },
    sendFragments(parts, isBinary) {
      parts.forEach((part, i) =>
        peer.client.send(part, {
          binary: isBinary,
          fin: i === parts.length - 1,
        }),
      );
    },
  };

  let serverConfig = null;
  const server = coreServer((socket, answer, rest) => {
    assert.notEqual(
      answer.params,
      null,
      `${label}: our server must accept ws's permessage-deflate offer`,
    );
    serverConfig = answer.params;
    const tee = makeTee();
    tee.wrap(socket);
    const handle = C._WebSocketCore_attach(socket, {
      role: "server",
      ctors: ctors(),
      permessageDeflate: {
        role: "server",
        resetInboundPerMessage: answer.params.clientNoContextTakeover,
        resetOutboundPerMessage: answer.params.serverNoContextTakeover,
        serverMaxWindowBits: answer.params.serverMaxWindowBits,
        clientMaxWindowBits: answer.params.clientMaxWindowBits,
      },
      onError: (message) => ours.errors.push(message),
      onClose: (code, reason) => ours.closes.push({ code, reason }),
      initialBytes: rest.length > 0 ? rest : undefined,
    });
    ours.handle = handle;
    ours.tee = tee;
    ours.decoder = createInflateDecoder({
      resetPerMessage: answer.params.serverNoContextTakeover,
    });
    ours.send = (kind, payload) =>
      new Promise((resolve, reject) => {
        const cb = (err) => (err ? reject(err) : resolve());
        if (kind === "text") handle.sendText(payload, cb);
        else handle.sendBytes(payload, cb);
      });
    const reader = handle.readable.getReader();
    (function pump() {
      reader.read().then(
        ({ done, value }) => {
          if (!done) {
            ours.received.push(value);
            pump();
          }
        },
        () => {},
      );
    })();
  });
  await listen(server);

  const client = new WebSocket(
    `ws://${HOST}:${server.address().port}/interop`,
    {
      perMessageDeflate: options,
    },
  );
  peer.client = client;
  client.on("error", (err) => peer.errors.push("client: " + err.message));
  client.on("close", (code) => peer.closeCodes.push(code));
  // ws echoes what it receives (so our SERVER's outbound frames are judged by a
  // stock ws decoder); its own sends are not echoed.
  client.on("message", (data, isBinary) => {
    peer.received.push({
      kind: isBinary ? "binary" : "text",
      bytes: Buffer.from(data),
    });
    client.send(data, { binary: isBinary });
  });

  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    await waitUntil(() => ours.handle !== undefined, `${label}: server attach`);
    assert.equal(
      serverConfig.serverMaxWindowBits,
      expectedServerWindow(options),
      `${label}: negotiated server window`,
    );

    await conversation(ours, peer, label);

    ours.handle.close(1000, "interop-bye");
    await waitUntil(() => ours.closes.length > 0, `${label}: our close`);
    assert.equal(ours.closes[0].code, 1000, `${label}: our clean close code`);
    await waitUntil(() => peer.closeCodes.length > 0, `${label}: ws close`);
    assert.ok(
      peer.closeCodes.every((code) => code === 1000 || code === 1005),
      `${label}: ws must observe a normal close, saw ${peer.closeCodes}`,
    );
  } finally {
    client.terminate();
    await closeServer(server);
  }

  assert.deepEqual(
    ours.errors,
    [],
    `${label}: our handle saw no protocol error`,
  );
  assert.deepEqual(peer.errors, [], `${label}: ws saw no error`);
}

// ---------------------------------------------------------------------------

describe("permessage-deflate interop with stock ws (RFC 7692 §5.3)", function () {
  this.timeout(30000);

  it("uses the installed ws@8", function () {
    assert.match(wsVersion, /^8\./);
  });

  for (const { label, options } of MATRIX) {
    it(`direction A (ws server + our core client): ${label}`, async function () {
      await runDirectionA(label, options);
    });

    it(`direction B (ws client + our core server): ${label}`, async function () {
      await runDirectionB(label, options);
    });
  }
});
