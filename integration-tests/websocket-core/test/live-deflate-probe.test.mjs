// §5.4 live loopback matrix: REAL loopback TCP with BOTH endpoints running our
// core handle (one client role, one server role), negotiating permessage-deflate
// through the WebSocketHandshake helpers exactly like WebSocketClient.js /
// WebSocketServer.js do.
//
// The point of this probe (sg1 lesson: a single-write happy path once hid a
// wire-order bug) is that the socket `write` path is WRAPPED so every frame the
// kernel hands to the socket reaches the peer in randomly split chunks --
// including 1-byte writes and cuts that land inside a frame header, inside a
// payload, and inside the last four bytes of a payload (the position the RFC
// 7692 §7.2.1 sync trailer occupied before the sender stripped it).
//
// Every direction of every scenario is TEE'd as it is written and then decoded
// by `deflate-oracle.mjs` -- a kernel-free RFC 7692 §7.2.1 decoder -- so the
// evidence is about the bytes on the wire, never the receiver's opinion.
//
// Determinism: all payloads and all split schedules come from a seeded
// mulberry32 PRNG, so a failure is reproducible byte for byte.
//
// Coverage: text and binary; >= 8 messages per direction; context retained
// (the retain scenario additionally proves the wire stream DEPENDS on
// cross-message LZ77 history, since a resetting decoder rejects it); empty
// messages interleaved; a 300 KB incompressible payload (outbound
// multi-fragment) plus a peer direction delivered in 1-byte chunks; the four
// takeover combinations; window caps 9 and 15 (the cap-9 scenarios carry the
// §0.3(3) stimulus, so an over-cap compressor is rejected by the 9-bit oracle);
// a clean close at the end of every scenario.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  WebSocketCore as C,
  WebSocketHandshake as H,
  collectMessages,
} from "./harness.mjs";
import {
  parseFrames,
  assembleMessages,
  decodeMessages,
} from "./deflate-oracle.mjs";

const FRAGMENT_SIZE = 16384; // _WebSocketCore_FRAGMENT_SIZE (2^14)

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32): deterministic payloads and split schedules.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prngBytes(prng, n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(prng() * 256) & 0xff;
  return buf;
}

function repeatTo(pattern, n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = pattern[i % pattern.length];
  return buf;
}

// §0.3(3) window-cap stimulus: 30000 pseudo-random bytes + 500 filler + the
// SAME 30000 bytes. A 15-bit compressor matches the second copy at distance
// 30500 (one long back-reference); a 9-bit compressor (512-byte window) cannot
// and emits the second copy literally. Its compressed size therefore differs by
// ~2x between the two caps, and a 9-bit inflate REJECTS a 15-bit encoding of it.
const STIMULUS = (() => {
  const prng = mulberry32(0x0057494e); // "WIN"
  const first = prngBytes(prng, 30000);
  const filler = prngBytes(prng, 500);
  return Buffer.concat([first, filler, Buffer.from(first)]);
})();

const CTORS = {
  text: (view) => ({
    kind: "text",
    bytes: Buffer.from(view.buffer, view.byteOffset, view.byteLength),
  }),
  binary: (view) => ({
    kind: "binary",
    bytes: Buffer.from(view.buffer, view.byteOffset, view.byteLength),
  }),
};

// ---------------------------------------------------------------------------
// Loopback plumbing (same shape as live-probe.test.mjs: a tracked-socket
// cleanup so a failing assertion can never hang server.close()).
// ---------------------------------------------------------------------------
function trackSockets(server) {
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.__tracked = sockets;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => {
    for (const s of server.__tracked || []) s.destroy();
    server.close(() => resolve());
  });
}

async function waitUntil(pred, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out: " + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Split writer + tee.
//
// The kernel hands ONE complete frame per nodeSocket.write. We record the frame
// bytes on the tee (its concat is the wire byte stream for the direction), then
// re-issue that frame as several real writes whose cut positions come from the
// seeded PRNG. Structural cuts are forced so a header byte, a payload byte and a
// byte inside the last four (the stripped sync-trailer position) are always
// boundaries; the random walk supplies the rest and a 13% single-byte step
// guarantees 1-byte writes. The kernel's write callback settles exactly once,
// on the LAST chunk.
// ---------------------------------------------------------------------------
function makeTee() {
  return { chunks: [], boundaries: new Set(), total: 0 };
}

function teeBytes(tee) {
  return Buffer.concat(tee.chunks);
}

function frameHeaderLen(buf) {
  const b1 = buf[1];
  const masked = (b1 & 0x80) !== 0;
  const len = b1 & 0x7f;
  const extra = len === 126 ? 2 : len === 127 ? 8 : 0;
  return 2 + extra + (masked ? 4 : 0);
}

function splitCuts(buf, prng, oneByte) {
  const n = buf.length;
  if (n <= 1) return [0, n];
  const marks = new Set([0, n]);
  if (oneByte) {
    for (let i = 1; i < n; i++) marks.add(i);
    return [...marks].sort((a, b) => a - b);
  }
  const headerLen = frameHeaderLen(buf);
  const payloadLen = Math.max(0, n - headerLen);
  marks.add(1); // inside the 2-byte base header
  if (headerLen > 2) marks.add(2);
  if (headerLen < n) marks.add(headerLen); // header/payload boundary
  if (payloadLen >= 8) marks.add(headerLen + (payloadLen >> 1)); // inside payload
  if (n - 2 > 0) marks.add(n - 2); // inside the last 4 bytes (trailer position)
  let pos = 0;
  while (pos < n) {
    const step = prng() < 0.13 ? 1 : 1 + Math.floor(prng() * 173);
    pos = Math.min(n, pos + step);
    if (pos > 0 && pos < n) marks.add(pos);
  }
  return [...marks].sort((a, b) => a - b);
}

function installSplitWriter(socket, tee, prng, oneByte) {
  const realWrite = socket.write.bind(socket);
  socket.write = function (data, cb) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const start = tee.total;
    const cuts = splitCuts(buf, prng, oneByte === true);
    for (let i = 1; i < cuts.length - 1; i++)
      tee.boundaries.add(start + cuts[i]);
    tee.chunks.push(buf);
    tee.total = start + buf.length;
    const last = cuts.length - 2;
    let settled = false;
    for (let i = 0; i <= last; i++) {
      realWrite(buf.subarray(cuts[i], cuts[i + 1]), (err) => {
        if (err) {
          if (!settled) {
            settled = true;
            if (cb) cb(err);
          }
          return;
        }
        if (i === last && !settled) {
          settled = true;
          if (cb) cb(null);
        }
      });
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Split classification: which byte regions did the writes actually cut through?
// ---------------------------------------------------------------------------
function classifySplits(frames, boundaries) {
  const counts = { header: 0, payload: 0, trailer: 0 };
  let off = 0;
  const spans = frames.map((f) => {
    const extra = f.payload.length < 126 ? 0 : f.payload.length < 65536 ? 2 : 8;
    const headerLen = 2 + extra + (f.masked ? 4 : 0);
    const start = off;
    const end = off + headerLen + f.payload.length;
    off = end;
    return { start, headerLen, end };
  });
  for (const b of boundaries) {
    for (const s of spans) {
      if (b <= s.start || b >= s.end) continue;
      if (b < s.start + s.headerLen) counts.header++;
      else if (b < s.end - 4) counts.payload++;
      else counts.trailer++;
      break;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Handshake + connection bring-up (both ends are our core handles; the HTTP
// handshake runs through the helpers exactly like the two kernel producers).
// ---------------------------------------------------------------------------
function offerString(p) {
  let s = "permessage-deflate";
  if (p.serverNoContextTakeover) s += "; server_no_context_takeover";
  if (p.clientNoContextTakeover) s += "; client_no_context_takeover";
  if (typeof p.serverMaxWindowBits === "number")
    s += "; server_max_window_bits=" + p.serverMaxWindowBits;
  if (typeof p.clientMaxWindowBits === "number")
    s += "; client_max_window_bits=" + p.clientMaxWindowBits;
  return s;
}

function offerParamsFor(scenario) {
  return {
    serverNoContextTakeover: scenario.serverNoContext === true,
    clientNoContextTakeover: scenario.clientNoContext === true,
    // caps 15 are the RFC default: leave the parameter absent (the handshake
    // then defaults both sides to 15). caps 9 are offered explicitly.
    serverMaxWindowBits:
      scenario.serverBits === 15 ? null : scenario.serverBits,
    clientMaxWindowBits: scenario.clientBits,
    clientMaxWindowBitsOffered: true,
  };
}

function buildOfferRequest(port, offerParams) {
  const built = H._WebSocketHandshake_buildClientRequest({
    host: "127.0.0.1",
    port,
    pathWithQuery: "/deflate-live",
    isTls: false,
    extensions: true,
  });
  const text = built.request
    .toString("latin1")
    .replace(
      /Sec-WebSocket-Extensions: [^\r]*/,
      "Sec-WebSocket-Extensions: " + offerString(offerParams),
    );
  return { key: built.key, request: Buffer.from(text, "latin1") };
}

async function openConnection(scenario, env) {
  const offerParams = offerParamsFor(scenario);
  env.offerParams = offerParams;

  let resolveServer;
  let rejectServer;
  const serverReady = new Promise((res, rej) => {
    resolveServer = res;
    rejectServer = rej;
  });

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const sep = buffer.indexOf("\r\n\r\n", 0, "latin1");
        if (sep === -1) return;
        socket.removeListener("data", onData);
        const headBytes = Buffer.from(buffer.subarray(0, sep + 4));
        const leftover = Buffer.from(buffer.subarray(sep + 4));

        const parsed = H._WebSocketHandshake_parseRequestHead(headBytes);
        assert.equal(parsed.ok, true, "server: request head must parse");
        const validity = H._WebSocketHandshake_validateClientRequest(parsed);
        assert.equal(validity.ok, true, "server: request must validate");
        const ext = H._WebSocketHandshake_parseExtensionsHeader(
          parsed.headers["sec-websocket-extensions"],
        );
        assert.equal(ext.ok, true, "server: offer must parse");
        const answer = H._WebSocketHandshake_negotiateServer(ext.elements);
        assert.notEqual(
          answer.responseLine,
          null,
          "server: must accept the offer",
        );

        // The 101 goes out on the REAL write (the wrapper is installed after).
        socket.write(
          H._WebSocketHandshake_acceptResponse(
            parsed.headers["sec-websocket-key"],
            answer.responseLine,
          ),
        );

        env.serverAnswer = answer;
        // Exactly the mapping of src/Gren/Kernel/WebSocketServer.js.
        env.serverCfg = {
          role: "server",
          resetInboundPerMessage: answer.params.clientNoContextTakeover,
          resetOutboundPerMessage: answer.params.serverNoContextTakeover,
          serverMaxWindowBits: answer.params.serverMaxWindowBits,
          clientMaxWindowBits: answer.params.clientMaxWindowBits,
        };
        installSplitWriter(
          socket,
          env.serverTee,
          env.serverPrng,
          scenario.oneByteServer,
        );
        env.serverHandle = C._WebSocketCore_attach(socket, {
          role: "server",
          permessageDeflate: env.serverCfg,
          ctors: CTORS,
          initialBytes: leftover,
          onClose: (code, reason) => env.serverCloses.push({ code, reason }),
          onError: (msg) => env.serverErrors.push(msg),
        });
        env.serverMessages = collectMessages(env.serverHandle);
        resolveServer();
      } catch (err) {
        rejectServer(err);
      }
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  trackSockets(server);
  await listen(server);
  env.server = server;
  const port = server.address().port;

  // --- client: manual handshake through the helpers, then attach the handle --
  const { key, request } = buildOfferRequest(port, offerParams);
  const socket = net.connect(port, "127.0.0.1");
  socket.setNoDelay(true);
  socket.on("error", () => {});
  env.clientSocket = socket;
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const { head, leftover } = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n", 0, "latin1");
      if (sep === -1) return;
      socket.removeListener("data", onData);
      resolve({
        head: Buffer.from(buf.subarray(0, sep + 4)),
        leftover: Buffer.from(buf.subarray(sep + 4)),
      });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(request);
  });

  const validity = H._WebSocketHandshake_validateServerResponse(key, head, {
    offeredParams: offerParams,
  });
  assert.equal(
    validity.ok,
    true,
    "client: 101 must validate: " + JSON.stringify(validity),
  );
  env.clientNegotiated = validity.params;
  // Exactly the mapping of src/Gren/Kernel/WebSocketClient.js.
  env.clientCfg =
    validity.params === null
      ? null
      : {
          role: "client",
          resetInboundPerMessage: validity.params.serverNoContextTakeover,
          resetOutboundPerMessage: validity.params.clientNoContextTakeover,
          serverMaxWindowBits: validity.params.serverMaxWindowBits,
          clientMaxWindowBits: validity.params.clientMaxWindowBits,
        };
  installSplitWriter(
    socket,
    env.clientTee,
    env.clientPrng,
    scenario.oneByteClient,
  );
  env.clientHandle = C._WebSocketCore_attach(socket, {
    role: "client",
    permessageDeflate: env.clientCfg,
    ctors: CTORS,
    initialBytes: leftover,
    onClose: (code, reason) => env.clientCloses.push({ code, reason }),
    onError: (msg) => env.clientErrors.push(msg),
  });
  env.clientMessages = collectMessages(env.clientHandle);

  await serverReady; // the server half must be attached before any send
  return { server, port };
}

// ---------------------------------------------------------------------------
// Deterministic message plan for one direction (>= 8 messages).
// ---------------------------------------------------------------------------
function buildPlan(scenario, dir) {
  const prng = mulberry32(
    scenario.seed ^ (dir === "c2s" ? 0x0000c2 : 0x0000c3),
  );
  const A = repeatTo(Buffer.from("abcdefgh", "latin1"), 4096);
  const plan = [];
  const push = (kind, bytes) =>
    plan.push({ kind, opcode: kind === "text" ? 0x1 : 0x2, bytes });
  push("text", Buffer.from("deflate-probe " + dir + " #0", "utf8"));
  push("binary", prngBytes(prng, 1));
  push("text", A); // #2
  push("text", Buffer.from(A)); // #3 identical -> history-dependent if retained
  push("text", Buffer.alloc(0)); // empty
  push("text", Buffer.from("after-empty " + dir, "utf8"));
  push("binary", prngBytes(prng, 2000));
  push("text", repeatTo(Buffer.from("tail-", "latin1"), 1000));
  push("binary", prngBytes(prng, 1500));
  if (scenario.bigC2S && dir === "c2s") push("binary", prngBytes(prng, 300000));
  if (scenario.stimulus && dir === "c2s") push("binary", STIMULUS);
  return plan;
}

function send(handle, msg) {
  return new Promise((resolve, reject) => {
    const cb = (err) => (err ? reject(err) : resolve());
    if (msg.kind === "text") handle.sendText(msg.bytes.toString("utf8"), cb);
    else handle.sendBytes(msg.bytes, cb);
  });
}

function decodeOptions(env, dir) {
  if (dir === "c2s") {
    return {
      resetPerMessage: env.serverCfg.resetInboundPerMessage === true,
      windowBits:
        env.clientCfg.clientMaxWindowBits === null ||
        env.clientCfg.clientMaxWindowBits === undefined
          ? 15
          : env.clientCfg.clientMaxWindowBits,
    };
  }
  return {
    resetPerMessage: env.clientCfg.resetInboundPerMessage === true,
    windowBits:
      env.serverCfg.serverMaxWindowBits === null ||
      env.serverCfg.serverMaxWindowBits === undefined
        ? 15
        : env.serverCfg.serverMaxWindowBits,
  };
}

// ---------------------------------------------------------------------------
// The scenario table: the four takeover combinations + window caps 9/15.
// ---------------------------------------------------------------------------
const SCENARIOS = [
  {
    name: "retain/retain caps=15/15 (300KB multi-fragment c->s, 1-byte s->c chunks)",
    seed: 0x51a1,
    serverNoContext: false,
    clientNoContext: false,
    serverBits: 15,
    clientBits: 15,
    bigC2S: true,
    oneByteServer: true,
  },
  {
    name: "server-resets / client-retains caps=15/15",
    seed: 0x51a2,
    serverNoContext: true,
    clientNoContext: false,
    serverBits: 15,
    clientBits: 15,
  },
  {
    name: "server-retains / client-resets caps=15/15",
    seed: 0x51a3,
    serverNoContext: false,
    clientNoContext: true,
    serverBits: 15,
    clientBits: 15,
  },
  {
    name: "both-reset caps=15/15",
    seed: 0x51a4,
    serverNoContext: true,
    clientNoContext: true,
    serverBits: 15,
    clientBits: 15,
  },
  {
    name: "retain/retain caps=9/9 (+window stimulus c->s)",
    seed: 0x51a5,
    serverNoContext: false,
    clientNoContext: false,
    serverBits: 9,
    clientBits: 9,
    stimulus: true,
  },
  {
    name: "both-reset caps=9/9 (+window stimulus c->s)",
    seed: 0x51a6,
    serverNoContext: true,
    clientNoContext: true,
    serverBits: 9,
    clientBits: 9,
    stimulus: true,
  },
];

// ---------------------------------------------------------------------------
// Wire assertions: independent oracle decode of the tee'd bytes + RSV1/frame
// layout + split-region coverage + ordering.
// ---------------------------------------------------------------------------
async function assertWire(env, scenario, dir) {
  const tee = dir === "c2s" ? env.clientTee : env.serverTee;
  const plan = dir === "c2s" ? env.c2sPlan : env.s2cPlan;
  const label = scenario.name + " [" + dir + "]";
  const bytes = teeBytes(tee);
  const frames = parseFrames(bytes);
  const { messages } = assembleMessages(frames);

  assert.equal(messages.length, plan.length, label + ": wire message count");
  for (let i = 0; i < plan.length; i++) {
    const g = messages[i];
    assert.equal(g.opcode, plan[i].opcode, label + " msg#" + i + " opcode");
    // The discriminator against the pre-edit kernel: it emits this frame
    // UNCOMPRESSED (RSV1 clear), so this assertion is the failing-before.
    assert.equal(
      g.rsv1,
      true,
      label + " msg#" + i + " must carry RSV1 (compressed on the wire)",
    );
    if (plan[i].bytes.length === 0) {
      assert.equal(
        g.payload.length,
        1,
        label + " empty msg#" + i + " wire payload is the 1-byte 00",
      );
      assert.equal(
        g.payload[0],
        0x00,
        label + " empty msg#" + i + " byte value",
      );
    }
  }

  // Outbound fragmentation layout for the 300 KB payload.
  if (scenario.bigC2S && dir === "c2s") {
    const idx = plan.findIndex((m) => m.bytes.length === 300000);
    const g = messages[idx];
    const expectedFrames = Math.ceil(g.payload.length / FRAGMENT_SIZE);
    assert.ok(
      expectedFrames >= 2,
      label +
        " 300 KB compressed payload must fragment (got " +
        expectedFrames +
        ")",
    );
    assert.equal(
      g.frames.length,
      expectedFrames,
      label + " 300 KB frame count (compressed length / 16384)",
    );
    assert.equal(g.frames[0].rsv, 4, label + " 300 KB frame0 RSV1");
    assert.equal(
      g.frames[0].opcode,
      plan[idx].opcode,
      label + " 300 KB frame0 opcode",
    );
    assert.equal(g.frames[0].fin, false, label + " 300 KB frame0 FIN cleared");
    for (let k = 1; k < g.frames.length; k++) {
      assert.equal(
        g.frames[k].rsv,
        0,
        label + " 300 KB continuation RSV cleared",
      );
      assert.equal(
        g.frames[k].opcode,
        0x0,
        label + " 300 KB continuation opcode",
      );
    }
    assert.equal(
      g.frames[g.frames.length - 1].fin,
      true,
      label + " 300 KB last fragment FIN set",
    );
    const keys = new Set(
      g.frames.map((f) => (f.maskKey || Buffer.alloc(0)).toString("hex")),
    );
    assert.equal(keys.size, 1, label + " 300 KB one mask key per message");
  }

  // No data/continuation frame may follow the Close frame.
  const closeIdx = frames.findIndex((f) => f.opcode === 0x8);
  if (closeIdx !== -1) {
    for (let k = closeIdx + 1; k < frames.length; k++) {
      assert.ok(frames[k].opcode >= 0x8, label + " no data frame after Close");
    }
  }

  // Randomized boundary splitting must actually have cut every region.
  const splits = classifySplits(frames, tee.boundaries);
  assert.ok(
    splits.header >= 1,
    label + " must split inside a frame header: " + JSON.stringify(splits),
  );
  assert.ok(
    splits.payload >= 1,
    label + " must split inside a payload: " + JSON.stringify(splits),
  );
  assert.ok(
    splits.trailer >= 1,
    label +
      " must split inside the last 4 payload bytes (trailer region): " +
      JSON.stringify(splits),
  );

  // Independent RFC 7692 §7.2.1 decode of the wire bytes.
  const opts = decodeOptions(env, dir);
  const decoded = await decodeMessages(messages, opts);
  for (let i = 0; i < plan.length; i++) {
    assert.deepEqual(decoded[i], plan[i].bytes, label + " decoded msg#" + i);
  }

  // Retained context must genuinely depend on cross-message history: the same
  // stream decoded with a resetting decoder (fresh LZ77 window per message)
  // must be REJECTED. Only valid when the compressing side had a 15-bit window
  // (a 9-bit window cannot reach back to the previous 4 KB message at all).
  if (opts.resetPerMessage === false && opts.windowBits === 15) {
    await assert.rejects(
      decodeMessages(messages, { ...opts, resetPerMessage: true }),
      /invalid distance too far back/,
      label + " retained stream must depend on cross-message history",
    );
  }

  return { frames, messages, splits, wireBytes: bytes.length };
}

function assertReceived(label, received, plan) {
  assert.equal(
    received.length,
    plan.length,
    label + ": receiver delivered every message",
  );
  for (let i = 0; i < plan.length; i++) {
    assert.equal(received[i].kind, plan[i].kind, label + " msg#" + i + " kind");
    assert.deepEqual(
      Buffer.from(received[i].bytes),
      plan[i].bytes,
      label + " msg#" + i + " bytes",
    );
  }
}

async function runScenario(scenario) {
  const env = {
    clientTee: makeTee(),
    serverTee: makeTee(),
    clientPrng: mulberry32(scenario.seed ^ 0x1111),
    serverPrng: mulberry32(scenario.seed ^ 0x2222),
    clientCloses: [],
    serverCloses: [],
    clientErrors: [],
    serverErrors: [],
  };
  env.c2sPlan = buildPlan(scenario, "c2s");
  env.s2cPlan = buildPlan(scenario, "s2c");

  const { server } = await openConnection(scenario, env);
  try {
    assert.equal(
      env.clientCfg === null,
      false,
      "client must negotiate permessage-deflate",
    );
    assert.equal(
      env.clientNegotiated !== null,
      true,
      "server must answer with permessage-deflate",
    );

    // Drive both directions in the same tick (FIFO + ordering stress).
    const sends = [];
    const max = Math.max(env.c2sPlan.length, env.s2cPlan.length);
    for (let i = 0; i < max; i++) {
      if (env.c2sPlan[i]) sends.push(send(env.clientHandle, env.c2sPlan[i]));
      if (env.s2cPlan[i]) sends.push(send(env.serverHandle, env.s2cPlan[i]));
    }
    await Promise.all(sends);

    await waitUntil(
      () => env.serverMessages.length >= env.c2sPlan.length,
      scenario.name + ": server received all c->s messages",
    );
    await waitUntil(
      () => env.clientMessages.length >= env.s2cPlan.length,
      scenario.name + ": client received all s->c messages",
    );

    // Clean close from the client.
    env.clientHandle.close(1000, "probe-bye", () => {});
    await waitUntil(
      () => env.clientCloses.length >= 1 && env.serverCloses.length >= 1,
      scenario.name + ": clean close handshake",
      10000,
    );
    assert.equal(
      env.clientCloses[0].code,
      1000,
      scenario.name + " client close code",
    );
    assert.equal(
      env.clientCloses[0].reason,
      "probe-bye",
      scenario.name + " client close reason",
    );
    assert.equal(
      env.serverCloses[0].code,
      1000,
      scenario.name + " server close code",
    );
    assert.equal(
      env.serverCloses[0].reason,
      "probe-bye",
      scenario.name + " server close reason",
    );
    assert.deepEqual(
      env.clientErrors,
      [],
      scenario.name + " no client protocol errors",
    );
    assert.deepEqual(
      env.serverErrors,
      [],
      scenario.name + " no server protocol errors",
    );

    // Wire evidence (tee) + independent oracle decode, both directions.
    const c2s = await assertWire(env, scenario, "c2s");
    const s2c = await assertWire(env, scenario, "s2c");
    // Receiver-side delivery, both directions.
    assertReceived(
      scenario.name + " [c2s receiver]",
      env.serverMessages,
      env.c2sPlan,
    );
    assertReceived(
      scenario.name + " [s2c receiver]",
      env.clientMessages,
      env.s2cPlan,
    );

    console.log(
      JSON.stringify({
        scenario: scenario.name,
        negotiation: {
          server: env.serverAnswer.responseLine,
          serverCfg: env.serverCfg,
          clientCfg: env.clientCfg,
        },
        c2s: {
          messages: env.c2sPlan.length,
          wireBytes: c2s.wireBytes,
          frames: c2s.frames.length,
          splits: c2s.splits,
        },
        s2c: {
          messages: env.s2cPlan.length,
          wireBytes: s2c.wireBytes,
          frames: s2c.frames.length,
          splits: s2c.splits,
        },
      }),
    );
  } finally {
    if (env.clientSocket) env.clientSocket.destroy();
    await closeServer(server);
  }
}

for (const scenario of SCENARIOS) {
  test(scenario.name, { timeout: 120000 }, async () => {
    await runScenario(scenario);
  });
}
