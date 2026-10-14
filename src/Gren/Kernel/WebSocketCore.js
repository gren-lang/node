/*

*/

// Gren.Kernel.WebSocketCore
//
// RFC 6455 framing engine shared by the client and server WebSocket kernels
// (PLAN D5). Phase 3 deliverable.
//
// This file is deliberately PURE JavaScript: no Gren import header, no Gren
// value references whatsoever. Every Gren value the engine needs to hand to
// the application (the TextMessage/BinaryMessage constructors) is injected
// through the attach() config at runtime by the Phase-4 client/server
// kernels. That makes this module loadable and unit-testable by plain node
// (see integration-tests/websocket-core/test/harness.mjs).
//
// Conventions (enforced in review):
//   - Gren value constructors arrive via config.ctors; this file never
//     mentions any mangled Gren identifier.
//   - Only node builtin modules may be required, lazily inside functions
//     (node:crypto, node:zlib here), so the file loads even without a module
//     system.
//   - Every callback is guarded to fire at most once; every node socket
//     event that can occur is handled.
//
// Accepted nodeSocket interface (so tests can drive the engine with a plain
// EventEmitter-based fake):
//   on("data", fn(Buffer))   inbound bytes
//   on("end", fn())          peer half-closed (FIN)
//   on("close", fn())        socket fully closed
//   on("error", fn(Error))   socket-level error
//   write(buffer, fn(err))   outbound bytes, callback once per write
//   end()                    half-close (local FIN)
//   destroy()                hard teardown
//   pause() / resume()       flow control tied to the readable stream
//
// Close-code validation decision: the codes we ACCEPT in a received Close are
// exactly the codes we may SEND (1000-1014 minus 1004/1005/1006, plus
// 3000-4999). RFC 6455 7.4 says 1005 (No Status Received) and 1006 (Abnormal
// Closure) MUST NEVER be placed on the wire, so a peer that puts one in a
// Close payload is violating the protocol: we answer with Close(1002), which
// is what the npm "ws" oracle does (validation.js isValidStatusCode is the
// same table) and what Autobahn Testsuite gates on. The only 1005 the app ever
// sees is the one we synthesize for a Close frame with a ZERO-LENGTH payload,
// and that case is answered with a Close frame carrying an empty payload
// (no status code at all -- what "ws" does via close() with an undefined code).
//
// Masking-key decision: when this endpoint is the client, every outbound
// frame including continuations is masked, and the 4-byte key is generated
// fresh per MESSAGE (node:crypto randomBytes(4)); the continuation frames of
// one message reuse that message's key. Two different messages therefore
// always carry different keys. (PLAN 4.3.)

var _WebSocketCore_DEFAULT_READ_BUFFER_CAPACITY = 16;
var _WebSocketCore_DEFAULT_MAX_SIZE = 100 * 1024 * 1024;
var _WebSocketCore_FRAGMENT_SIZE = 16384; // 2^14
var _WebSocketCore_CLOSE_TIMEOUT_MS = 5000;
var _WebSocketCore_MAX_CLOSE_REASON_BYTES = 123;

var _WebSocketCore_EMPTY = Buffer.alloc(0);

// RFC 7692 §7.2.2: the 4-byte sync-flush marker (an empty DEFLATE block) a
// sender strips from every compressed message. Used outbound only as the
// documented zero-length-message fallback; node's zlib makes it unreachable
// (the smallest Z_SYNC_FLUSH output is the 5-byte 00 00 00 FF FF).
var _WebSocketCore_SYNC_FLUSH_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

// RFC 7692 §7.2.2: a permessage-deflate sender strips the 00 00 FF FF
// sync-flush marker (an empty DEFLATE block, BFINAL=0/BTYPE=00) from the wire;
// the receiver appends it back to complete a message's deflate stream. The
// extra 03 00 is a synthetic final empty fixed-Huffman block (RFC 1951 §3.2.3)
// so Z_FINISH both terminates the stream AND rejects an incomplete block
// sequence, i.e. a mid-block truncation.
var _WebSocketCore_INFLATE_TAIL = Buffer.from([
  0x00, 0x00, 0xff, 0xff, 0x03, 0x00,
]);

// RFC 7692 §7.2.2: the take-over dictionary is the last 32768 bytes of the
// connection's DELIVERED decompressed output -- the DEFLATE sliding window.
var _WebSocketCore_TAKE_OVER_HISTORY = 32768;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

// XOR payload in place with a 4-byte masking key, using a rolling key index
// (RFC 6455 5.3). Returns the payload for chaining.
function _WebSocketCore_maskXor(payload, maskKey, startIndex) {
  var i = startIndex || 0;
  for (var j = 0; j < payload.length; j++) {
    payload[j] = payload[j] ^ maskKey[(i + j) & 3];
  }
  return payload;
}

function _WebSocketCore_opcodeIsValid(opcode) {
  return (
    opcode === 0x0 ||
    opcode === 0x1 ||
    opcode === 0x2 ||
    opcode === 0x8 ||
    opcode === 0x9 ||
    opcode === 0xa
  );
}

function _WebSocketCore_isControlOpcode(opcode) {
  return opcode === 0x8 || opcode === 0x9 || opcode === 0xa;
}

// Codes this endpoint may place in a close frame it sends. Mirrors the table
// used by the previous (npm "ws") implementation so the Gren predicates
// errorIsInvalidCloseCode keep their meaning: 1000-1014 minus the reserved
// 1004/1005/1006, plus the private range 3000-4999.
function _WebSocketCore_isValidSentCloseCode(code) {
  return (
    (typeof code === "number" &&
      code >= 1000 &&
      code <= 1014 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006) ||
    (typeof code === "number" && code >= 3000 && code <= 4999)
  );
}

// Codes the peer may place in a close frame it sends. Identical to the sent
// set: RFC 6455 7.4 forbids 1005/1006 on the wire, so a peer that sends one
// is violating the protocol and gets Close(1002) (ws-compatible; the npm "ws"
// oracle validates received codes with the very same table).
function _WebSocketCore_isValidReceivedCloseCode(code) {
  return _WebSocketCore_isValidSentCloseCode(code);
}
// Whole-buffer fatal UTF-8 check (close reasons, unfragmented text frames).
function _WebSocketCore_utf8IsValid(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch (e) {
    return false;
  }
}

// Encode one complete frame. When maskKey (a 4-byte Buffer) is given the
// frame is masked and the payload is copied before XOR so the caller's
// buffer is never mutated. Uses minimal length encoding. rsv1 (boolean) sets
// the RSV1 bit, i.e. the permessage-deflate compressed-message flag on a data
// message's FIRST frame (never on continuations or control frames).
function _WebSocketCore_encodeFrame(fin, opcode, payload, maskKey, rsv1) {
  var len = payload.length;
  var headerLen = 2 + (len < 126 ? 0 : len < 65536 ? 2 : 8) + (maskKey ? 4 : 0);
  var frame = Buffer.allocUnsafe(headerLen + len);

  frame[0] = (fin ? 0x80 : 0x00) | (rsv1 ? 0x40 : 0x00) | (opcode & 0x0f);
  var b1 = len < 126 ? len : len < 65536 ? 126 : 127;
  var offset = 2;
  if (b1 === 126) {
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else if (b1 === 127) {
    frame.writeUInt32BE(Math.floor(len / 4294967296), 2);
    frame.writeUInt32BE(len % 4294967296, 6);
    offset = 10;
  }
  if (maskKey) {
    b1 |= 0x80;
    maskKey.copy(frame, offset, 0, 4);
    offset += 4;
  }
  frame[1] = b1;

  if (maskKey) {
    var masked = Buffer.from(payload); // copy; never mutate caller memory
    _WebSocketCore_maskXor(masked, maskKey, 0);
    masked.copy(frame, offset, 0, len);
  } else {
    payload.copy(frame, offset, 0, len);
  }
  return frame;
}

// Build a close-frame payload: null/undefined code gives the empty payload,
// a code alone gives the 2-byte code, a code plus reason gives code+reason.
function _WebSocketCore_buildClosePayload(code, reasonBytes) {
  if (code === undefined || code === null) {
    return _WebSocketCore_EMPTY;
  }
  var reasonLen = reasonBytes ? reasonBytes.length : 0;
  var buf = Buffer.allocUnsafe(2 + reasonLen);
  buf.writeUInt16BE(code, 0);
  if (reasonLen > 0) {
    reasonBytes.copy(buf, 2, 0, reasonLen);
  }
  return buf;
}

function _WebSocketCore_once(fn) {
  var called = false;
  return function (arg) {
    if (called) {
      return;
    }
    called = true;
    if (fn) {
      fn(arg);
    }
  };
}

// ---------------------------------------------------------------------------
// attach: install the engine on a connected node socket
// ---------------------------------------------------------------------------

// config = {
//   role: "client" | "server",
//   readBufferCapacity: number (default 16),
//   maxMessageSize: number (default 100 MiB),
//   maxFrameSize: number (default 100 MiB),
//   permessageDeflate: null | { role, resetInboundPerMessage,
//     resetOutboundPerMessage, serverMaxWindowBits, clientMaxWindowBits } --
//     RFC 7692 config: the sg1 inbound decoder plus the sg2 outbound
//     compressor (null when the extension was not negotiated),
//   ctors: { text: fn(DataView) -> MsgValue, binary: fn(DataView) -> MsgValue },
//   onClose: fn(code, reasonString),
//   onError: fn(messageString),
//   initialBytes: Buffer (optional) -- bytes the caller already buffered past
//     the end of the HTTP handshake (the start of the first frame); fed
//     through the parser once, after all socket listeners are installed.
// }
//
// Returns handle = {
//   readable: ReadableStream of MsgValue (backpressure via pause/resume),
//   sendText(string, cb), sendBytes(bufferLike, cb), close(code, reason, cb),
//   destroy(), state: "open" | "closing" | "closed",
// }
function _WebSocketCore_attach(nodeSocket, config) {
  var crypto = require("node:crypto");

  config = config || {};
  var role = config.role === "server" ? "server" : "client";
  var readBufferCapacity =
    typeof config.readBufferCapacity === "number" &&
    config.readBufferCapacity > 0
      ? config.readBufferCapacity
      : _WebSocketCore_DEFAULT_READ_BUFFER_CAPACITY;
  var maxMessageSize =
    typeof config.maxMessageSize === "number" && config.maxMessageSize > 0
      ? config.maxMessageSize
      : _WebSocketCore_DEFAULT_MAX_SIZE;
  var maxFrameSize =
    typeof config.maxFrameSize === "number" && config.maxFrameSize > 0
      ? config.maxFrameSize
      : _WebSocketCore_DEFAULT_MAX_SIZE;
  var ctors = config.ctors || {};
  var onCloseHandler =
    typeof config.onClose === "function" ? config.onClose : null;
  var onErrorHandler =
    typeof config.onError === "function" ? config.onError : null;
  // RFC 7692 §5: null when permessage-deflate was not negotiated (disabled, or
  // the peer declined). sg1 owns this shape; sg2 extends it with the outbound
  // compressor fields.
  var permessageDeflate = config.permessageDeflate || null;

  // RFC 7692 sg2 outbound compressor config. The window cap is derived by
  // role from the two sg1 window fields (one source of truth per side) with a
  // symmetric defensive fallback so a hand-built config can never hand
  // null/undefined to zlib: an absent/unagreed cap means 15 (§7.1.2.2 for the
  // client; the server handshake already defaults it to 15).
  var outboundResetPerMessage = false;
  var outboundWindowBits = 15;
  if (permessageDeflate !== null) {
    outboundResetPerMessage = !!permessageDeflate.resetOutboundPerMessage;
    var negotiatedWindowBits =
      role === "server"
        ? permessageDeflate.serverMaxWindowBits
        : permessageDeflate.clientMaxWindowBits;
    outboundWindowBits =
      negotiatedWindowBits === null || negotiatedWindowBits === undefined
        ? 15
        : negotiatedWindowBits;
  }

  var handle = { state: "open" };

  // ---- ReadableStream (same contract as _Net_buildReadable) --------------
  //
  // Backpressure: CountQueuingStrategy with readBufferCapacity; when the
  // queue fills (desiredSize <= 0) the socket is paused so TCP flow control
  // stops the peer; pull resumes it once the consumer drains below capacity.
  // A clean close closes the stream (readers observe Stream.Closed); an
  // error errors it (Stream.Cancelled <message>).
  var streamController = null;
  var streamClosed = false;

  handle.readable = new ReadableStream(
    {
      start: function (controller) {
        streamController = controller;
      },
      pull: function () {
        try {
          nodeSocket.resume();
        } catch (e) {
          // socket already gone; nothing to resume
        }
      },
    },
    new CountQueuingStrategy({ highWaterMark: readBufferCapacity }),
  );

  function closeReadable() {
    if (!streamClosed && streamController) {
      streamClosed = true;
      try {
        streamController.close();
      } catch (e) {
        // Controller may already be closed or errored; safe to ignore.
      }
    }
  }

  function errorReadable(message) {
    if (!streamClosed && streamController) {
      streamClosed = true;
      try {
        streamController.error(message);
      } catch (e) {
        // Controller may already be closed or errored; safe to ignore.
      }
    }
  }

  // ---- lifecycle bookkeeping ----------------------------------------------
  var closeFired = false; // onClose delivered exactly once
  var errorFired = false; // onError delivered exactly once
  var closeFrameReceived = false; // saw the peer's Close frame
  var stopEmitting = false; // enqueue no more messages (we sent Close / failed)
  var protocolFailed = false; // failProtocol ran: parser is dead (ws-like)
  var closeTimer = null; // peer-close wait after we sent Close

  function clearCloseTimer() {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function armCloseTimer() {
    clearCloseTimer();
    closeTimer = setTimeout(function () {
      closeTimer = null;
      // Peer never answered our Close within the window: abnormal teardown.
      try {
        nodeSocket.destroy();
      } catch (e) {
        // already gone
      }
    }, _WebSocketCore_CLOSE_TIMEOUT_MS);
    if (closeTimer && typeof closeTimer.unref === "function") {
      closeTimer.unref();
    }
  }

  function fireClose(code, reason) {
    if (closeFired) {
      return;
    }
    closeFired = true;
    clearCloseTimer();
    handle.state = "closed";
    closeReadable();
    if (onCloseHandler) {
      try {
        onCloseHandler(code, reason);
      } catch (e) {
        // app handler must never break the engine
      }
    }
  }

  function fireError(message) {
    if (errorFired) {
      return;
    }
    errorFired = true;
    errorReadable(message);
    if (onErrorHandler) {
      try {
        onErrorHandler(message);
      } catch (e) {
        // app handler must never break the engine
      }
    }
  }

  // ---- outbound frames ------------------------------------------------------
  //
  // RFC 7692 outbound codec (sg2). While permessage-deflate is negotiated every
  // DATA message is compressed -- a deterministic policy with no threshold and
  // no "uncompressed even though negotiated" shortcut. The payload is written
  // to a per-connection raw-DEFLATE stream, Z_SYNC_FLUSHed (RFC 7692 §7.2.2;
  // NEVER Z_FULL_FLUSH), the trailing 00 00 FF FF marker is stripped and the
  // remainder is framed with RSV1 on its FIRST frame only. The stream is created
  // lazily on the first compressed send, so a connection that never sends
  // allocates no deflater at all.
  //
  // Messages are compressed strictly one at a time (a FIFO): message N+1 is
  // neither written into zlib nor framed until message N's output has been
  // snapshotted and framed. That is what makes frame order deterministic and
  // what keeps reset() (context takeover) from ever racing a queued write. A
  // message counts as finished for FIFO purposes when its LAST frame has been
  // handed to nodeSocket.write -- not when that write's callback settles -- so
  // a socket that defers write callbacks can never stall the pipeline while
  // frame order stays intact.
  var outboundDeflater = null; // lazily created raw-DEFLATE stream
  var outboundZlib = null; // cached node:zlib module of this connection
  var outboundAccumulator = []; // compressed chunks of the message in flight
  var outboundQueue = []; // accepted data messages awaiting compression
  var outboundActiveMessage = null; // message being compressed/framed right now
  var outboundFlushPending = false; // a zlib.flush() callback is outstanding
  var outboundDeflaterPendingClose = null; // stream whose close waits on flush
  var outboundOutstanding = new Set(); // send callbacks not yet settled
  var outboundClosePending = false; // Close frame deferred behind the FIFO
  var outboundClosePayload = null;
  var outboundCloseCallback = null;

  function writeFrame(fin, opcode, payload, cb, maskKey, rsv1) {
    var done = _WebSocketCore_once(cb);
    var key = role === "client" ? maskKey || crypto.randomBytes(4) : maskKey;
    var frame;
    try {
      frame = _WebSocketCore_encodeFrame(fin, opcode, payload, key, rsv1);
    } catch (e) {
      done(e);
      return;
    }
    try {
      nodeSocket.write(frame, function (err) {
        done(err || null);
      });
    } catch (e) {
      done(e);
    }
  }

  function notOpenError() {
    // The exact prefix Connection.errorIsConnectionNotOpen matches on.
    return new Error(
      "WebSocket is not open: readyState CLOSING (" + handle.state + ")",
    );
  }

  function toBuffer(bytes) {
    if (Buffer.isBuffer(bytes)) {
      return bytes;
    }
    if (bytes instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(bytes));
    }
    if (
      bytes &&
      typeof bytes.byteLength === "number" &&
      typeof bytes.byteOffset === "number" &&
      bytes.buffer
    ) {
      // DataView or TypedArray view over a real buffer
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return Buffer.from(bytes);
  }

  // ---- outbound permessage-deflate codec ------------------------------------

  function outboundEnsureZlib() {
    if (outboundZlib === null) {
      outboundZlib = require("node:zlib");
    }
    return outboundZlib;
  }

  function outboundEnsureDeflater() {
    if (outboundDeflater === null) {
      var zlib = outboundEnsureZlib();
      // windowBits 8 is silently clamped to 9 by zlib's deflateInit2 (it cannot
      // compress through a 256-byte window); the negotiated 8..15 value is
      // passed straight through, exactly like ws, with no 8-specific workaround
      // and never a refusal to compress.
      var deflater = zlib.createDeflateRaw({ windowBits: outboundWindowBits });
      deflater.on("data", function (chunk) {
        outboundAccumulator.push(chunk);
      });
      deflater.on("error", function (err) {
        // Settle the in-flight send exactly once: the once-guards make the
        // flush callback's later error report a no-op.
        if (deflater === outboundDeflater) {
          outboundFailActive(err);
        }
      });
      outboundDeflater = deflater;
    }
    return outboundDeflater;
  }

  function outboundReleasePendingClose(deflater) {
    if (outboundDeflaterPendingClose === deflater) {
      outboundDeflaterPendingClose = null;
      try {
        deflater.close();
      } catch (e) {
        // already gone
      }
    }
  }

  function outboundDiscardDeflater() {
    var deflater = outboundDeflater;
    outboundDeflater = null;
    outboundAccumulator = [];
    if (deflater === null) {
      return;
    }
    if (outboundFlushPending) {
      // A zlib.flush() callback is still outstanding: NEITHER close() NOR
      // reset() is safe here. Closing now could drop the pending callback
      // (node before 13.10 never fired it), and reset() with a write in
      // progress is a use-after-free in node 20's zlib that aborts the
      // process (fixed upstream by nodejs/node 53bcd114b100). Just mark the
      // stream for release and close it from the flush callback, once it has
      // arrived.
      outboundDeflaterPendingClose = deflater;
      return;
    }
    try {
      deflater.close();
    } catch (e) {
      // already gone
    }
  }

  // Settle the message whose output is still being produced (compression in
  // flight, or frames not yet issued) with err, discard the deflater and move
  // on. Exactly-once is enforced by the send callback's own once-guard.
  function outboundFailActive(err) {
    var message = outboundActiveMessage;
    if (message === null) {
      return;
    }
    outboundActiveMessage = null;
    outboundFlushPending = false;
    outboundDiscardDeflater();
    message.callback(err);
    outboundAfterMessage();
  }

  function outboundAfterMessage() {
    if (outboundQueue.length > 0) {
      outboundPump();
      return;
    }
    if (outboundClosePending) {
      outboundClosePending = false;
      var payload = outboundClosePayload;
      var callback = outboundCloseCallback;
      outboundClosePayload = null;
      outboundCloseCallback = null;
      // Every accepted message's data frames reached the socket before this, so
      // the Close is the last frame on the wire.
      writeFrame(true, 0x8, payload, callback);
    }
  }

  // Frame the stripped (compressed) bytes: fragment at _WebSocketCore_FRAGMENT_SIZE
  // measured on the COMPRESSED length, first frame carrying the real opcode with
  // RSV1 set, continuations opcode 0x0 without RSV1, final frame FIN=1. onIssued
  // fires once the last frame has been handed to nodeSocket.write; sendCallback
  // settles with the first error (frame write or deflate) or null after the last
  // frame's socket-write callback.
  function outboundWriteMessage(opcode, compressed, sendCallback, onIssued) {
    var issued = _WebSocketCore_once(onIssued);
    if (compressed.length <= _WebSocketCore_FRAGMENT_SIZE) {
      writeFrame(true, opcode, compressed, sendCallback, undefined, true);
      issued();
      return;
    }
    // The client role uses ONE fresh mask key per MESSAGE, shared by every
    // fragment (never a per-fragment key).
    var messageKey = role === "client" ? crypto.randomBytes(4) : null;
    var offset = 0;
    var first = true;

    function step() {
      var remaining = compressed.length - offset;
      if (remaining <= _WebSocketCore_FRAGMENT_SIZE) {
        writeFrame(
          true,
          first ? opcode : 0x0,
          compressed.subarray(offset),
          sendCallback,
          messageKey,
          first,
        );
        issued();
        return;
      }
      writeFrame(
        false,
        first ? opcode : 0x0,
        compressed.subarray(offset, offset + _WebSocketCore_FRAGMENT_SIZE),
        function (err) {
          if (err) {
            sendCallback(err);
            issued();
            return;
          }
          offset += _WebSocketCore_FRAGMENT_SIZE;
          first = false;
          step();
        },
        messageKey,
        first,
      );
    }

    step();
  }

  function outboundPump() {
    if (outboundActiveMessage !== null || outboundQueue.length === 0) {
      return;
    }
    var message = outboundQueue.shift();
    outboundActiveMessage = message;
    var deflater = null;

    function onFlushed(err) {
      if (deflater !== outboundDeflater) {
        // destroy()/failProtocol teardown ran while this flush was pending; the
        // send callback was already settled there. This is the only outstanding
        // zlib callback, so the deferred close can complete now.
        outboundReleasePendingClose(deflater);
        return;
      }
      outboundFlushPending = false;
      if (err) {
        outboundFailActive(err);
        return;
      }
      // Snapshot the per-message accumulator and clear it IMMEDIATELY, before
      // anything else can observe it, so no later send can contribute bytes to
      // this message's output.
      var snapshot = outboundAccumulator;
      outboundAccumulator = [];
      var compressed = Buffer.concat(snapshot);
      // RFC 7692 §7.2.2: strip the trailing 00 00 FF FF sync-flush marker.
      if (compressed.length >= 4) {
        compressed = compressed.subarray(0, compressed.length - 4);
      }
      if (compressed.length === 0) {
        // Unreachable with node's zlib: the smallest Z_SYNC_FLUSH output is the
        // 5-byte 00 00 00 FF FF, so even an empty message strips to the single
        // byte 00 below (what ws puts on the wire and what our receiver
        // accepts). Kept as the §7.2.2 fallback for a zero-length message.
        compressed = _WebSocketCore_SYNC_FLUSH_TAIL;
      }
      var settle = _WebSocketCore_once(function (error) {
        outboundOutstanding.delete(settle);
        message.callback(error || null);
      });
      outboundOutstanding.add(settle);
      outboundWriteMessage(message.opcode, compressed, settle, function () {
        outboundActiveMessage = null;
        if (outboundResetPerMessage && deflater === outboundDeflater) {
          // §7.2.2 context boundary: clear the LZ77 window AFTER this message's
          // snapshot was taken and BEFORE the next message is compressed. The
          // pipeline is serialized, so no zlib work is queued at this point and
          // reset() cannot race a pending write.
          try {
            deflater.reset();
          } catch (e) {
            // already gone
          }
        }
        outboundAfterMessage();
      });
    }

    try {
      deflater = outboundEnsureDeflater();
      outboundAccumulator = [];
      deflater.write(message.payload);
      outboundFlushPending = true;
      deflater.flush(outboundZlib.constants.Z_SYNC_FLUSH, onFlushed);
    } catch (e) {
      outboundFlushPending = false;
      outboundFailActive(e);
    }
  }

  function sendData(opcode, payload, cb) {
    var callback = _WebSocketCore_once(cb);
    if (handle.state !== "open") {
      callback(notOpenError());
      return;
    }

    if (permessageDeflate !== null) {
      // Deterministic policy: every data message is compressed while the
      // extension is negotiated (no threshold, no uncompressed shortcut).
      outboundQueue.push({
        opcode: opcode,
        payload: payload,
        callback: callback,
      });
      outboundPump();
      return;
    }

    if (payload.length <= _WebSocketCore_FRAGMENT_SIZE) {
      writeFrame(true, opcode, payload, callback);
      return;
    }

    // Fragment at 2^14: first frame carries the real opcode with FIN=0,
    // continuations use opcode 0, the final fragment has FIN=1. One fresh
    // mask key per MESSAGE, shared by all its fragments (client role).
    var messageKey = role === "client" ? crypto.randomBytes(4) : null;
    var offset = 0;
    var first = true;

    function step() {
      var remaining = payload.length - offset;
      if (remaining <= _WebSocketCore_FRAGMENT_SIZE) {
        writeFrame(
          true,
          first ? opcode : 0x0,
          payload.subarray(offset),
          callback,
          messageKey,
        );
      } else {
        writeFrame(
          false,
          first ? opcode : 0x0,
          payload.subarray(offset, offset + _WebSocketCore_FRAGMENT_SIZE),
          function (err) {
            if (err) {
              callback(err);
              return;
            }
            offset += _WebSocketCore_FRAGMENT_SIZE;
            first = false;
            step();
          },
          messageKey,
        );
      }
    }

    step();
  }

  handle.sendText = function (text, cb) {
    sendData(0x1, Buffer.from(String(text), "utf8"), cb);
  };

  handle.sendBytes = function (bytes, cb) {
    sendData(0x2, toBuffer(bytes), cb);
  };

  handle.close = function (code, reason, cb) {
    var callback = _WebSocketCore_once(cb);
    if (handle.state === "closed") {
      callback(null);
      return;
    }
    if (handle.state === "closing") {
      // Close already sent; the peer ack is pending. Nothing more to do.
      callback(null);
      return;
    }

    var payload;
    if (code === undefined || code === null) {
      payload = _WebSocketCore_EMPTY;
    } else if (
      typeof code !== "number" ||
      !isFinite(code) ||
      Math.floor(code) !== code ||
      !_WebSocketCore_isValidSentCloseCode(code)
    ) {
      callback(new Error("First argument must be a valid error code number"));
      return;
    } else {
      var reasonBytes =
        reason === undefined || reason === null || reason === ""
          ? _WebSocketCore_EMPTY
          : Buffer.from(String(reason), "utf8");
      if (reasonBytes.length > _WebSocketCore_MAX_CLOSE_REASON_BYTES) {
        // Do not send; matches the string errorIsCloseReasonTooLong matches.
        callback(new Error("The message must not be greater than 123 bytes"));
        return;
      }
      payload = _WebSocketCore_buildClosePayload(code, reasonBytes);
    }

    stopEmitting = true;
    handle.state = "closing";
    armCloseTimer(); // abnormal destroy if the peer Close never arrives
    if (outboundActiveMessage !== null || outboundQueue.length > 0) {
      // A compressed data message is still in flight: deliver it before the
      // Close frame so no data/continuation frame can reach the socket after
      // our Close (the uncompressed path delivers it synchronously, hence
      // before). The callback and payload stay exactly as they are, tied to
      // the Close frame's socket write.
      outboundClosePending = true;
      outboundClosePayload = payload;
      outboundCloseCallback = callback;
      return;
    }
    writeFrame(true, 0x8, payload, callback);
  };

  // Tear the outbound pipeline down: settle every queued/in-flight send callback
  // exactly once with err, drop the deferred Close callback the same way, and
  // free the deflater without ever leaving a zlib.flush() callback dangling.
  function outboundTeardown(error) {
    if (
      outboundActiveMessage === null &&
      outboundQueue.length === 0 &&
      outboundDeflater === null &&
      outboundOutstanding.size === 0 &&
      !outboundClosePending
    ) {
      return;
    }
    var message = outboundActiveMessage;
    outboundActiveMessage = null;
    var queued = outboundQueue;
    outboundQueue = [];
    if (outboundClosePending) {
      outboundClosePending = false;
      var closeCallback = outboundCloseCallback;
      outboundClosePayload = null;
      outboundCloseCallback = null;
      if (closeCallback) {
        closeCallback(error);
      }
    }
    if (message !== null) {
      message.callback(error);
    }
    for (var i = 0; i < queued.length; i++) {
      queued[i].callback(error);
    }
    outboundOutstanding.forEach(function (settle) {
      settle(error);
    });
    outboundDiscardDeflater();
  }

  handle.destroy = function () {
    clearCloseTimer();
    handle.state = "closed";
    outboundTeardown(notOpenError());
    try {
      nodeSocket.destroy();
    } catch (e) {
      // already gone
    }
    closeReadable();
    fireClose(1006, "");
  };

  // ---- protocol failure and close-handshake paths --------------------------

  // Violation of the wire protocol.
  //
  // Order matters: the ERROR channel fires first, so the readable ends
  // ERRORED (Stream.Cancelled <message>) with a non-empty violation
  // description -- exactly what the ws-based kernel did (receiver error ->
  // connection 'error' -> controller.error(err.message), then close). The
  // Phase-4 compatibility oracle asserts on that stream-error line, so a
  // clean end-of-stream here would be a visible regression. fireClose then
  // still dispatches the app's onClose with the protocol code (the readable
  // is already settled; the streamClosed guard makes the double notify
  // safe). Finally we answer with Close(code) and wait (bounded) for the
  // peer before destroying.
  //
  // If the app already initiated its own Close (state "closing") we MUST NOT
  // put a second Close frame on the wire (RFC 6455 7.1.1 allows exactly one
  // per direction) and MUST NOT overwrite the app-visible close code; the
  // error notification above still stands -- the ws receiver also emits
  // 'error' after its close frame has been sent -- and the close-timer
  // armed by close() keeps the bounded destroy.
  // A violation that lands in the same data event as messages already
  // enqueued to the readable is deferred to the next macrotask: the
  // consumer's read promise for those messages settles on microtasks, and
  // erroring the stream synchronously right behind the enqueue wipes a
  // valid echo that ws (whose receiver defers the abort) does deliver --
  // exactly what the Autobahn 3.2/5.15 close-timing checks measure. With
  // nothing delivered this event (the common case: violation as the first
  // frame of a chunk) the teardown stays fully synchronous.
  var enqueuedThisEvent = 0; // emitMessage successes since the last event
  var deferredFailureDrainScheduled = false;

  function drainDeferredFailures() {
    deferredFailureDrainScheduled = false;
    enqueuedThisEvent = 0;
    failProtocol(lastDeferredCode, lastDeferredMessage);
  }

  var lastDeferredCode = 0;
  var lastDeferredMessage = "";

  function failProtocol(code, message) {
    if (handle.state === "closed") {
      return;
    }
    if (enqueuedThisEvent > 0) {
      lastDeferredCode = code;
      lastDeferredMessage = message;
      // Logically failed from here on: nothing new may reach the app
      // while the wire teardown waits one turn (a later data event in
      // the window must not enqueue more messages).
      stopEmitting = true;
      if (!deferredFailureDrainScheduled) {
        deferredFailureDrainScheduled = true;
        var drain = setTimeout(drainDeferredFailures, 0);
        if (drain && typeof drain.unref === "function") {
          drain.unref();
        }
      }
      return;
    }
    fireError(
      typeof message === "string" && message !== ""
        ? message
        : "Invalid WebSocket frame: protocol error " + code,
    );
    stopEmitting = true;
    // The byte stream is protocol-dead from here on. Drop the offending
    // (possibly partially consumed) frame so leftover bytes can never
    // re-trigger the parser; a peer Close ACK arriving later on the same
    // connection still parses from a clean header state.
    pending = _WebSocketCore_EMPTY;
    parseState = "header";
    if (handle.state === "closing") {
      // Our Close is already in flight: one Close per direction (7.1.1).
      // Re-arm so the bounded teardown stands even if close()'s timer was
      // cleared on the way here.
      armCloseTimer();
      return;
    }
    handle.state = "closing";
    // Drop any outbound data still in the pipeline (settling its callbacks
    // with the not-open error) so no data frame can reach the socket after
    // the Close frame below.
    outboundTeardown(notOpenError());
    // FIN right after the Close (mirroring the peer-Close reply below and
    // the ws Sender.fail() behavior): a protocol violation kills the byte
    // stream, so there is nothing left to read -- half-closing tells the
    // peer teardown is complete rather than leaving it guessing. The
    // bounded destroy from armCloseTimer stays as the backstop if the peer
    // never finishes teardown.
    writeFrame(true, 0x8, _WebSocketCore_buildClosePayload(code), function () {
      try {
        nodeSocket.end();
      } catch (e) {
        // already gone
      }
    });
    fireClose(code, "");
    // After fireClose (which clears any timer) so the bounded destroy stands.
    armCloseTimer();
  }

  function replyPong(payload) {
    if (handle.state === "closed") {
      return;
    }
    writeFrame(true, 0xa, payload, null);
  }

  function handleInboundClose(payloadBuf) {
    if (closeFrameReceived) {
      return; // only the first Close frame counts
    }
    closeFrameReceived = true;
    clearCloseTimer();

    var code;
    var reasonBytes = _WebSocketCore_EMPTY;
    if (payloadBuf.length === 0) {
      // No Status Received (RFC 6455 7.4): deliver 1005 to the app.
      code = 1005;
    } else if (payloadBuf.length === 1) {
      failProtocol(1002, "Invalid WebSocket frame: invalid payload length 1");
      return;
    } else {
      code = payloadBuf.readUInt16BE(0);
      if (!_WebSocketCore_isValidReceivedCloseCode(code)) {
        failProtocol(
          1002,
          "Invalid WebSocket frame: invalid status code " + code,
        );
        return;
      }
      reasonBytes = payloadBuf.subarray(2);
      if (!_WebSocketCore_utf8IsValid(reasonBytes)) {
        failProtocol(1007, "Invalid WebSocket frame: invalid UTF-8 sequence");
        return;
      }
    }

    var weAlreadySentClose = handle.state === "closing";
    stopEmitting = true;
    resetFragments();

    if (weAlreadySentClose) {
      // Peer acked our Close: done, hard teardown.
      try {
        nodeSocket.destroy();
      } catch (e) {
        // already gone
      }
    } else {
      // Reply with the same code. The only special code that can reach here
      // is the 1005 we synthesized for a ZERO-LENGTH payload: it is never
      // transmitted (RFC 6455 7.4), so that reply carries an empty payload
      // (no status code; ws-compatible, see header note). An explicit
      // 1005/1006 from the peer was already rejected with Close(1002).
      var replyPayload =
        code === 1005
          ? _WebSocketCore_EMPTY
          : _WebSocketCore_buildClosePayload(code, reasonBytes);
      writeFrame(true, 0x8, replyPayload, function () {
        try {
          nodeSocket.end();
        } catch (e) {
          // already gone
        }
      });
    }

    fireClose(code, reasonBytes.toString("utf8"));
    // fireClose clears the timer; re-arm after it so the socket is force-
    // destroyed if the peer never finishes TCP teardown.
    if (!weAlreadySentClose) {
      armCloseTimer();
    }
  }

  // ---- inbound framing FSM ---------------------------------------------------
  //
  // States: header -> (len16 | len64) -> maskKey -> payload -> header.
  // Handles partial frames across arbitrary TCP chunk boundaries and several
  // coalesced frames inside one chunk. Control frames interleave with a
  // fragmented message and are dispatched immediately (autobahn 4.1.5).
  var pending = _WebSocketCore_EMPTY;
  var parseState = "header";
  var frameFin = false;
  var frameOpcode = 0;
  var frameMasked = false;
  var framePayloadLen = 0;
  var frameMaskKey = null;
  var frameRsv1 = false; // RSV1 on the frame currently being parsed

  var fragmentOpcode = 0; // 0 = no fragmented message in progress
  var fragments = [];
  var fragmentBytes = 0;
  var textDecoder = null; // streaming fatal decoder for a fragmented text message

  function resetFragments() {
    fragmentOpcode = 0;
    fragments = [];
    fragmentBytes = 0;
    textDecoder = null;
  }

  // ---- permessage-deflate inbound state (RFC 7692 §6/§7.2.2) --------------
  //
  // INVARIANT PARSER_PAUSED: while awaitingInflate is true, no frame byte may
  // be consumed and no per-message receive state may be reassigned. Each
  // compressed message's payloads are ACCUMULATED into its own decode record
  // (there is no shared mutable per-message state to clobber); at the message's
  // FIN the 00 00 FF FF sync header plus a synthetic final block is appended
  // and the whole buffer is handed to zlib.inflateRaw. That is the async
  // (threadpool) buffer API -- it never blocks the event loop, so the pause is
  // the only ordering mechanism. The parser is paused from the FIN frame until
  // the callback lands, so a later frame can never be delivered ahead of the
  // message it follows. Control frames are never handed to zlib: they are
  // dispatched from onFrameComplete as before.
  var currentDecode = null; // the ONE open compressed message's decode record
  var awaitingInflate = false; // parser paused until the FIN decode callback
  var compressedLimit = 2 * maxMessageSize + 65536; // §2 step 0 policy bound
  // Rolling last <=32768 bytes of this connection's DELIVERED decompressed
  // output: the take-over dictionary (RFC 7692 §7.2.2). Never filled when the
  // negotiated context is reset per message.
  var takeOverHistory = _WebSocketCore_EMPTY;

  function recordTakeOverHistory(output) {
    if (permessageDeflate.resetInboundPerMessage) {
      return; // fresh context: no dictionary and no history buffer
    }
    var tail =
      output.length >= _WebSocketCore_TAKE_OVER_HISTORY
        ? output.subarray(output.length - _WebSocketCore_TAKE_OVER_HISTORY)
        : Buffer.concat([takeOverHistory, output]);
    takeOverHistory =
      tail.length > _WebSocketCore_TAKE_OVER_HISTORY
        ? Buffer.from(
            tail.subarray(tail.length - _WebSocketCore_TAKE_OVER_HISTORY),
          )
        : Buffer.from(tail);
  }

  function startCompressedMessage(opcode, payload, fin) {
    if (awaitingInflate) {
      // Every caller is gated by PARSER_PAUSED (G1/G2), so this is
      // unreachable for conformant input; refuse loudly on an interleave.
      failProtocol(
        1002,
        "Invalid WebSocket frame: compressed message interleaving",
      );
      return;
    }
    currentDecode = {
      opcode: opcode,
      chunks: [payload],
      bytes: payload.length,
      fin: false,
    };
    acceptCompressedPayload(currentDecode, fin);
  }

  // A continuation frame of the open compressed message (RFC 7692 §6).
  function appendCompressedPayload(payload, fin) {
    var record = currentDecode;
    record.chunks.push(payload);
    record.bytes += payload.length;
    acceptCompressedPayload(record, fin);
  }

  // §2 step 0: bound the buffer that must exist before maxOutputLength can
  // fire (it only fires at FIN). 2x covers every legal DEFLATE expansion for a
  // message whose decompressed size is within maxMessageSize (stored blocks
  // add 5 B per 64 KiB, RFC 1951 §3.2.4; a symbol-wise Huffman block is capped
  // at 15 bits/byte, 1.875x) plus 64 KiB of unconditional slack.
  function acceptCompressedPayload(record, fin) {
    if (record.bytes > compressedLimit) {
      currentDecode = null;
      failProtocol(1009, "Max payload size exceeded");
      return;
    }
    if (!fin) {
      return;
    }
    record.fin = true;
    finishCompressedMessage(record);
  }

  function finishCompressedMessage(record) {
    if (record !== currentDecode) {
      return; // a stale/late callback can only no-op
    }
    if (record.bytes === 0) {
      // §2 step 1: nothing was sent. A conforming sender's empty message is
      // exactly 0x00 (a zero-length payload is a Z_DATA_ERROR under the §2
      // signature), so deliver the empty message WITHOUT calling zlib.
      currentDecode = null;
      emitMessage(record.opcode, _WebSocketCore_EMPTY);
      return;
    }
    awaitingInflate = true;
    var zlib = require("node:zlib");
    var input = Buffer.concat(
      record.chunks.concat([_WebSocketCore_INFLATE_TAIL]),
      record.bytes + _WebSocketCore_INFLATE_TAIL.length,
    );
    zlib.inflateRaw(
      input,
      {
        windowBits: 15,
        finishFlush: zlib.constants.Z_FINISH,
        maxOutputLength: maxMessageSize,
        dictionary: permessageDeflate.resetInboundPerMessage
          ? undefined
          : takeOverHistory,
      },
      function (err, output) {
        onInflateDone(record, err, output);
      },
    );
  }

  function onInflateDone(record, err, output) {
    if (record !== currentDecode) {
      return; // stale/late callback: nothing to deliver and nothing to clear
    }
    if (err) {
      currentDecode = null;
      awaitingInflate = false;
      if (err.code === "ERR_BUFFER_TOO_LARGE") {
        failProtocol(1009, "Max payload size exceeded");
      } else {
        failProtocol(1002, "Invalid WebSocket frame: invalid compressed data");
      }
      return;
    }
    if (record.opcode === 0x1 && !_WebSocketCore_utf8IsValid(output)) {
      currentDecode = null;
      awaitingInflate = false;
      failProtocol(1007, "Invalid WebSocket frame: invalid UTF-8 sequence");
      return;
    }
    recordTakeOverHistory(output);
    emitMessage(record.opcode, output);
    currentDecode = null;
    awaitingInflate = false;
    resumeParsing();
  }

  function emitMessage(opcode, message) {
    if (stopEmitting || streamClosed || streamController === null) {
      return;
    }
    var view = new DataView(
      message.buffer,
      message.byteOffset,
      message.byteLength,
    );
    var msgValue;
    try {
      msgValue = opcode === 0x1 ? ctors.text(view) : ctors.binary(view);
    } catch (e) {
      return;
    }
    try {
      streamController.enqueue(msgValue);
    } catch (e) {
      // stream torn down concurrently; drop the message
      return;
    }
    enqueuedThisEvent += 1;
    if (
      streamController.desiredSize !== null &&
      streamController.desiredSize <= 0
    ) {
      try {
        nodeSocket.pause();
      } catch (e) {
        // already gone
      }
    }
  }

  function validateTextSegment(bytes, finalFlush) {
    try {
      if (finalFlush) {
        textDecoder.decode();
      } else {
        textDecoder.decode(bytes, { stream: true });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function appendFragment(payload, fin) {
    if (fragmentBytes + payload.length > maxMessageSize) {
      failProtocol(1009, "Max payload size exceeded");
      return;
    }
    fragments.push(payload);
    fragmentBytes += payload.length;

    if (fragmentOpcode === 0x1 && !validateTextSegment(payload, false)) {
      failProtocol(1007, "Invalid WebSocket frame: invalid UTF-8 sequence");
      return;
    }
    if (!fin) {
      return;
    }
    var op = fragmentOpcode;
    if (op === 0x1 && !validateTextSegment(null, true)) {
      failProtocol(1007, "Invalid WebSocket frame: invalid UTF-8 sequence");
      return;
    }
    var message =
      fragments.length === 1
        ? fragments[0]
        : Buffer.concat(fragments, fragmentBytes);
    resetFragments();
    emitMessage(op, message);
  }

  function onFrameComplete(fin, opcode, payload, rsv1) {
    if (opcode === 0x9) {
      // Ping: answer Pong echoing the payload verbatim, out-of-band even
      // mid-fragmented-message (autobahn 4.1.5).
      replyPong(payload);
      return;
    }
    if (opcode === 0xa) {
      // Unsolicited pong: no-op, no close (autobahn 5.x).
      return;
    }
    if (opcode === 0x8) {
      handleInboundClose(payload);
      return;
    }

    if (stopEmitting) {
      return; // data frames after we sent Close are dropped
    }

    if (opcode === 0x0) {
      if (currentDecode === null && fragmentOpcode === 0) {
        failProtocol(1002, "Invalid WebSocket frame: invalid opcode 0"); // continuation without an open fragmented message
        return;
      }
      if (currentDecode !== null && !currentDecode.fin) {
        // Continuation of a permessage-deflate message: its bytes go to the
        // open decode record, never to the fragment assembler (RFC 7692 §6).
        appendCompressedPayload(payload, fin);
        return;
      }
      appendFragment(payload, fin);
      return;
    }

    // Data frame starting a new message (text or binary).
    if (fragmentOpcode !== 0 || currentDecode !== null) {
      failProtocol(1002, "Invalid WebSocket frame: invalid opcode " + opcode); // new data frame while a fragmented message is open
      return;
    }
    if (rsv1) {
      // First frame of a permessage-deflate message (RFC 7692 §6): its payload
      // is DEFLATE-compressed and inflated as a whole; the decompressed size is
      // gated by maxOutputLength, the compressed size by §2 step 0.
      startCompressedMessage(opcode, payload, fin);
      return;
    }
    if (payload.length > maxMessageSize) {
      // maxMessageSize may be configured below maxFrameSize; gate whole
      // messages, not just individual frames.
      failProtocol(1009, "Max payload size exceeded");
      return;
    }
    if (!fin) {
      fragmentOpcode = opcode;
      fragments = [payload];
      fragmentBytes = payload.length;
      if (opcode === 0x1) {
        textDecoder = new TextDecoder("utf-8", { fatal: true });
        if (!validateTextSegment(payload, false)) {
          failProtocol(1007, "Invalid WebSocket frame: invalid UTF-8 sequence");
        }
      }
      return;
    }
    if (opcode === 0x1 && !_WebSocketCore_utf8IsValid(payload)) {
      failProtocol(1007, "Invalid WebSocket frame: invalid UTF-8 sequence");
      return;
    }
    emitMessage(opcode, payload);
  }

  function ingest(chunk) {
    if (closeFired) {
      return;
    }
    // Delivery bookkeeping is per data event: a violation deferred below
    // must only wait for messages enqueued in THIS event.
    enqueuedThisEvent = 0;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (awaitingInflate) {
      // INVARIANT PARSER_PAUSED: a compressed message's decode is pending, so
      // these bytes are BUFFERED; resumeParsing() re-enters in wire order once
      // the callback lands. Never call parseFrames() unconditionally here.
      return;
    }
    parseFrames();
  }

  // Re-enter the parser on bytes buffered while a compressed message's inflate
  // callback was pending (see awaitingInflate). Wire order is preserved: the
  // pause started exactly at the FIN frame that closed the message.
  function resumeParsing() {
    if (closeFired || awaitingInflate) {
      return;
    }
    parseFrames();
  }

  function parseFrames() {
    // INVARIANT PARSER_PAUSED (defence in depth, G2): no caller may consume a
    // frame byte while a compressed message's async decode is pending.
    if (closeFired || awaitingInflate) {
      return;
    }
    // ignore-next: loop breaks on every return path
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (parseState === "header") {
        if (pending.length < 2) {
          return;
        }
        var b0 = pending[0];
        var b1 = pending[1];
        frameFin = (b0 & 0x80) !== 0;
        frameOpcode = b0 & 0x0f;
        frameMasked = (b1 & 0x80) !== 0;
        var len7 = b1 & 0x7f;

        // RSV2/RSV3 are always protocol errors; RSV1 is the permessage-deflate
        // marker and legal ONLY on the first frame of a data message when the
        // extension was negotiated (RFC 7692 §6 -- RSV1 on a control frame or a
        // continuation MUST fail the connection).
        frameRsv1 = false;
        if ((b0 & 0x70) !== 0) {
          var rsv1Set = (b0 & 0x40) !== 0;
          if (
            rsv1Set &&
            (b0 & 0x30) === 0 &&
            permessageDeflate !== null &&
            !_WebSocketCore_isControlOpcode(frameOpcode) &&
            frameOpcode !== 0x0
          ) {
            frameRsv1 = true;
          } else {
            failProtocol(
              1002,
              rsv1Set
                ? "Invalid WebSocket frame: RSV1 must be clear"
                : "Invalid WebSocket frame: RSV2 and RSV3 must be clear",
            );
            return;
          }
        }
        if (!_WebSocketCore_opcodeIsValid(frameOpcode)) {
          failProtocol(
            1002, // reserved opcode (0x3-0x7, 0xB-0xF)
            "Invalid WebSocket frame: invalid opcode " + frameOpcode,
          );
          return;
        }
        if (_WebSocketCore_isControlOpcode(frameOpcode)) {
          if (!frameFin || len7 > 125) {
            failProtocol(
              1002, // fragmented control frame / oversized control payload
              !frameFin
                ? "Invalid WebSocket frame: FIN must be set"
                : "Invalid WebSocket frame: invalid payload length " + len7,
            );
            return;
          }
        }
        if (role === "server" && !frameMasked) {
          failProtocol(1002, "Invalid WebSocket frame: MASK must be set"); // client-to-server frames MUST be masked
          return;
        }
        if (role === "client" && frameMasked) {
          failProtocol(1002, "Invalid WebSocket frame: MASK must be clear"); // server-to-client frames MUST NOT be masked
          return;
        }

        if (len7 < 126) {
          framePayloadLen = len7;
          if (framePayloadLen > maxFrameSize) {
            failProtocol(1009, "Max payload size exceeded");
            return;
          }
          pending = pending.subarray(2);
          parseState = frameMasked ? "maskKey" : "payload";
        } else if (len7 === 126) {
          pending = pending.subarray(2);
          parseState = "len16";
        } else {
          pending = pending.subarray(2);
          parseState = "len64";
        }
      } else if (parseState === "len16") {
        if (pending.length < 2) {
          return;
        }
        framePayloadLen = pending.readUInt16BE(0);
        if (framePayloadLen < 126) {
          failProtocol(
            1002, // non-minimal 16-bit length encoding
            "Invalid WebSocket frame: invalid frame payload length",
          );
          return;
        }
        if (framePayloadLen > maxFrameSize) {
          failProtocol(1009, "Max payload size exceeded");
          return;
        }
        pending = pending.subarray(2);
        parseState = frameMasked ? "maskKey" : "payload";
      } else if (parseState === "len64") {
        if (pending.length < 8) {
          return;
        }
        var hi = pending.readUInt32BE(0);
        var lo = pending.readUInt32BE(4);
        if ((hi & 0x80000000) !== 0) {
          failProtocol(
            1002, // MSB set: malformed 64-bit length
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
          );
          return;
        }
        framePayloadLen = hi * 4294967296 + lo;
        if (framePayloadLen < 65536) {
          failProtocol(
            1002, // non-minimal 64-bit length encoding
            "Invalid WebSocket frame: invalid frame payload length",
          );
          return;
        }
        if (framePayloadLen > maxFrameSize) {
          failProtocol(1009, "Max payload size exceeded");
          return;
        }
        pending = pending.subarray(8);
        parseState = frameMasked ? "maskKey" : "payload";
      } else if (parseState === "maskKey") {
        if (pending.length < 4) {
          return;
        }
        frameMaskKey = pending.subarray(0, 4);
        pending = pending.subarray(4);
        parseState = "payload";
      } else {
        // payload
        if (pending.length < framePayloadLen) {
          return;
        }
        var payload = pending.subarray(0, framePayloadLen);
        if (frameMasked) {
          payload = Buffer.from(payload); // copy: never mutate pending in place
          _WebSocketCore_maskXor(payload, frameMaskKey, 0);
        }
        pending = pending.subarray(framePayloadLen);
        parseState = "header";
        var fin = frameFin;
        var opcode = frameOpcode;
        onFrameComplete(fin, opcode, payload, frameRsv1);
        if (closeFired || deferredFailureDrainScheduled || awaitingInflate) {
          // Close fired, a violation was deferred behind this event's
          // deliveries, or a compressed message's inflate callback is still
          // pending: the byte stream is protocol-dead or not yet in order,
          // stop parsing.
          return;
        }
      }
    }
  }

  // ---- node socket events -----------------------------------------------------

  nodeSocket.on("data", function (chunk) {
    try {
      ingest(chunk);
    } catch (e) {
      // Engine failsafe: nothing here is expected to throw; treat an
      // unexpected failure as a fatal protocol error rather than crashing
      // the app.
      failProtocol(
        1011,
        "Unexpected engine failure: " +
          (e && e.message ? e.message : String(e)),
      );
    }
  });

  nodeSocket.on("end", function () {
    // Peer half-closed. If the close handshake never completed this is an
    // abnormal closure (1006); any buffered partial frame is discarded.
    pending = _WebSocketCore_EMPTY;
    clearCloseTimer();
    try {
      nodeSocket.destroy();
    } catch (e) {
      // already gone
    }
    fireClose(1006, "");
  });

  nodeSocket.on("close", function () {
    // Final teardown. No Close frame seen means abnormal closure (1006).
    clearCloseTimer();
    fireClose(1006, "");
  });

  nodeSocket.on("error", function (err) {
    // Socket-level error: surface it (Stream.Cancelled <message> for readers)
    // and finalize; the subsequent close event delivers onClose(1006).
    fireError(err && err.message ? err.message : String(err));
    clearCloseTimer();
    try {
      nodeSocket.destroy();
    } catch (e) {
      // already gone
    }
  });

  // Handshake leftovers (the start of the first frame, already buffered by
  // the caller) are parsed once every listener is installed, so bytes are
  // neither lost nor double-parsed.
  if (config.initialBytes && config.initialBytes.length > 0) {
    ingest(config.initialBytes);
  }

  return handle;
}
