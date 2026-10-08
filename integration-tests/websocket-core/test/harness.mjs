// Test harness for the Gren.Kernel.WebSocket* pure-JS engine files.
//
// Both kernel files are deliberately ctor-free pure JavaScript (no Gren
// imports, node builtins required lazily inside functions), so we can load
// them into a fresh vm context with just a `require` shim and pick up the
// exported `_WebSocketCore_*` / `_WebSocketHandshake_*` globals directly.
//
// The sandbox gets the OUTER realm's Error so `err instanceof Error` holds
// for errors the engine constructs, and ReadableStream is wrapped so every
// controller.enqueue is recorded synchronously on the stream object
// (handle.readable.__record) and the controller.close/error settle calls are
// recorded on handle.readable.__settle -- unit tests observe enqueued
// messages and whether the readable ended CLEAN or ERRORED without racing
// reader microtasks.
//
// The README in this directory documents why this suite exists pre-Phase-4.

import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const RealReadableStream = ReadableStream;
function loadKernel(relativePath) {
  const source = readFileSync(join(repoRoot, relativePath), "utf8");
  const sandbox = {
    require: createRequire(import.meta.url), // node builtins only are used by the kernels
    Buffer,
    TextDecoder,
    Error, // outer-realm Error so instanceof works across the vm boundary
    ReadableStream: class PatchedReadableStream extends RealReadableStream {
      constructor(source, strategy) {
        const record = [];
        const settle = { closed: false, errored: false, reason: undefined };
        let inner = source;
        if (source) {
          const origStart = source.start;
          inner = Object.assign({}, source, {
            start: (controller) => {
              const origEnqueue = controller.enqueue.bind(controller);
              const origClose = controller.close.bind(controller);
              const origError = controller.error.bind(controller);
              controller.enqueue = (value) => {
                record.push(value);
                origEnqueue(value);
              };
              controller.close = () => {
                settle.closed = true;
                origClose();
              };
              controller.error = (reason) => {
                settle.errored = true;
                settle.reason = reason;
                origError(reason);
              };
              if (origStart) return origStart(controller);
            },
          });
        }
        super(inner, strategy);
        this.__record = record;
        this.__settle = settle;
      }
    },
    CountQueuingStrategy,
    DataView,
    Uint8Array,
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: relativePath });
  return sandbox;
}

const core = loadKernel("src/Gren/Kernel/WebSocketCore.js");
const handshakeRaw = loadKernel("src/Gren/Kernel/WebSocketHandshake.js");

// Plain objects built inside the vm context carry the sandbox prototypes, so
// assert.deepEqual (strict) rejects them even when structurally identical.
// Rebuild handshake results in the test realm, leaving buffers and typed
// views untouched.
function plainify(value) {
  if (value === null || typeof value !== "object") return value;
  if (
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(plainify);
  const out = {};
  for (const key of Object.keys(value)) out[key] = plainify(value[key]);
  return out;
}
const handshake = {};
for (const [name, fn] of Object.entries(handshakeRaw)) {
  handshake[name] =
    typeof fn === "function" ? (...args) => plainify(fn(...args)) : fn;
}

// Sanity: every global the tests expect must exist, so a rename in the
// kernel fails loudly at import time rather than in some deep assertion.
for (const name of [
  "_WebSocketCore_attach",
  "_WebSocketCore_maskXor",
  "_WebSocketCore_encodeFrame",
  "_WebSocketCore_buildClosePayload",
  "_WebSocketCore_isValidSentCloseCode",
  "_WebSocketCore_isValidReceivedCloseCode",
  "_WebSocketCore_opcodeIsValid",
  "_WebSocketCore_utf8IsValid",
]) {
  assert.equal(
    typeof core[name],
    "function",
    `missing core export ${name} (did it load?)`,
  );
}
for (const name of [
  "_WebSocketHandshake_parseWsUrl",
  "_WebSocketHandshake_buildClientRequest",
  "_WebSocketHandshake_acceptValue",
  "_WebSocketHandshake_validateServerResponse",
  "_WebSocketHandshake_parseRequestHead",
  "_WebSocketHandshake_validateClientRequest",
  "_WebSocketHandshake_rejectResponse",
  "_WebSocketHandshake_acceptResponse",
]) {
  assert.equal(
    typeof handshake[name],
    "function",
    `missing handshake export ${name} (did it load?)`,
  );
}

export const WebSocketCore = core;
export const WebSocketHandshake = handshake;

// ---------------------------------------------------------------------------
// Fake socket: the core engine only ever touches the socket interface
// documented at the top of src/Gren/Kernel/WebSocketCore.js:
//   on("data"|"end"|"close"|"error", fn), write(buf, cb), end(), destroy(),
//   pause(), resume()
// -- so this plain object (plus an emit() driver) is a sufficient stand-in
// for unit tests; live-probe tests use real sockets.
// ---------------------------------------------------------------------------

export function makeFakeSocket() {
  const listeners = new Map();
  const socket = {
    writes: [], // every Buffer passed to write()
    writeCallbacks: [], // pending write callbacks (call cb(err|null) to settle)
    events: [], // lifecycle events triggered by the engine
    paused: false,
    resumed: 0,
    endCalled: false,
    destroyed: false,
    failNextWrites: null, // when set to an Error, write() invokes cb(err)

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return socket;
    },
    emit(event, arg) {
      for (const fn of listeners.get(event) || []) fn(arg);
    },
    write(buf, cb) {
      socket.writes.push(buf);
      const callback = (err) => cb(err || null);
      socket.writeCallbacks.push(callback);
      if (socket.failNextWrites) {
        const err = socket.failNextWrites;
        socket.failNextWrites = null;
        process.nextTick(() => callback(err));
      }
      return true;
    },
    flushWrites(err) {
      const pending = socket.writeCallbacks.splice(0);
      for (const cb of pending) cb(err);
    },
    end() {
      socket.endCalled = true;
      socket.events.push("end");
    },
    destroy() {
      socket.destroyed = true;
      socket.events.push("destroy");
    },
    pause() {
      socket.paused = true;
    },
    resume() {
      socket.paused = false;
      socket.resumed++;
    },
    // Feed bytes into the engine as if they arrived from the peer.
    feed(...chunks) {
      socket.emit("data", Buffer.concat(chunks.map(toBufferArg)));
    },
    feedBytes(...arrays) {
      socket.feed(...arrays.map((a) => Buffer.from(a)));
    },
  };
  return socket;
}

function toBufferArg(c) {
  return Buffer.isBuffer(c) ? c : Buffer.from(c);
}

export function makeConfig(overrides = {}) {
  return {
    role: "server",
    ctors: {
      text: (view) => ({ kind: "text", view }),
      binary: (view) => ({ kind: "binary", view }),
    },
    ...overrides,
  };
}

// Observe messages the engine enqueues. The patched ReadableStream records
// every controller.enqueue synchronously in handle.readable.__record, so
// tests can assert immediately after feeding bytes without awaiting
// microtasks. A detached reader keeps the stream drained for the common
// (no-backpressure) case.
export function collectMessages(handle) {
  const messages = handle.readable.__record;
  const reader = handle.readable.getReader();
  function pump() {
    reader.read().then(
      ({ done }) => {
        if (!done) pump();
      },
      () => {
        // errored stream: tests assert errors via the onError capture instead
      },
    );
  }
  pump();
  return messages;
}

// A minimal independent frame encoder used as a test oracle. Deliberately
// written from the RFC by hand (no shared code with the kernel) so kernel
// and test cannot agree on the same mistake.
export function oracleFrame(opts) {
  const {
    fin = true,
    rsv = 0,
    opcode,
    payload = Buffer.alloc(0),
    mask = false,
    maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]),
    forceLenMode, // 7 | 16 | 64 -- force non-minimal encoding for tests
  } = opts;
  const len = payload.length;
  const mode = forceLenMode ?? (len < 126 ? 7 : len < 65536 ? 16 : 64);

  const parts = [];
  parts.push(
    Buffer.from([
      ((fin ? 0x80 : 0x00) | ((rsv & 7) << 4) | (opcode & 0x0f)) & 0xff,
    ]),
  );

  let lenBytes;
  let b1;
  if (mode === 7) {
    b1 = len;
    lenBytes = Buffer.alloc(0);
  } else if (mode === 16) {
    b1 = 126;
    lenBytes = Buffer.alloc(2);
    lenBytes.writeUInt16BE(len, 0);
  } else {
    b1 = 127;
    lenBytes = Buffer.alloc(8);
    lenBytes.writeUInt32BE(Math.floor(len / 4294967296), 0);
    lenBytes.writeUInt32BE(len % 4294967296, 4);
  }

  if (mask) b1 |= 0x80;
  parts.push(Buffer.from([b1]));
  if (lenBytes.length) parts.push(lenBytes);

  let body = payload;
  if (mask) {
    parts.push(Buffer.from(maskKey));
    body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= maskKey[i % 4];
  }
  parts.push(body);
  return Buffer.concat(parts);
}

// Independent frame parser used as a test oracle. Returns array of
// { fin, rsv, opcode, masked, maskKey, payload } for a byte buffer holding
// a whole number of frames.
export function oracleParse(buffer) {
  const frames = [];
  let p = 0;
  while (p < buffer.length) {
    const b0 = buffer[p];
    const b1 = buffer[p + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = (b0 & 0x70) >> 4;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    p += 2;
    if (len === 126) {
      len = buffer.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      len = buffer.readUInt32BE(p) * 4294967296 + buffer.readUInt32BE(p + 4);
      p += 8;
    }
    let maskKey = null;
    if (masked) {
      maskKey = buffer.subarray(p, p + 4);
      p += 4;
    }
    let payload = Buffer.from(buffer.subarray(p, p + len));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    p += len;
    frames.push({ fin, rsv, opcode, masked, maskKey, payload });
  }
  return frames;
}
