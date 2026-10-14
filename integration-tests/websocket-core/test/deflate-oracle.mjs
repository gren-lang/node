// Independent, kernel-free ORACLE for RFC 7692 permessage-deflate, used to
// judge the frames our WebSocket core emits (and any bytes teed off a real
// wire). Written directly from RFC 7692 §7.2.1 (decompression) and §7.2.3
// (RSV1 rules); it shares NO code with src/Gren/Kernel/WebSocketCore.js, so
// kernel and oracle cannot agree on the same mistake.
//
// This file is a PLAIN HELPER MODULE: no side effects at import and no
// node:test registrations, so `node --test test/` does not execute it as a
// suite (only *.test.mjs files are collected).
//
// ---------------------------------------------------------------------------
// STABLE EXPORT LIST (other workers import these names read-only; do not
// rename or repurpose):
//
//   FRAME_TRAILER                Buffer([00 00 ff ff]) -- the §7.2.1 tail marker.
//   parseFrames(bytes)           -> Frame[]
//   assembleMessages(frames)     -> { messages: MessageGroup[], controlFrames: Frame[] }
//   createInflateDecoder(opts)   -> Decoder  (persistent InflateRaw, §7.2.1)
//   decodeMessages(groups, opts) -> Promise<Buffer[]>
//   decodeBuffer(bytes, opts)    -> Promise<Buffer[]>   (parse + assemble + decode)
//
// Frame: { fin, rsv, opcode, masked, maskKey, payload }
//   `rsv` is the raw 3-bit reserved field shifted into bits 4-6, exactly like
//   the harness's own `oracleParse` (so RSV1 === 4, RSV2 === 2, RSV3 === 1).
//   `payload` is the UNMASKED application payload; `maskKey` is null when the
//   frame is unmasked (server role) and a 4-byte Buffer otherwise.
//
// MessageGroup: { opcode, rsv1, payload, frames }
//   `opcode` is 0x1 (text) or 0x2 (binary), taken from the group's FIRST frame;
//   `rsv1` is true iff that first frame carried RSV1 (RFC 7692: a message is
//   compressed iff RSV1 is set on its first frame); `payload` is the
//   concatenation of the group's frame payloads (still COMPRESSED when
//   rsv1), and `frames` holds the group's frames in wire order.
//
// Decoder / decodeMessages / decodeBuffer options:
//   { resetPerMessage = false, windowBits = 15 }
//   `resetPerMessage` mirrors the negotiated no_context_takeover of the PEER's
//   compressor (the kernel's `resetInboundPerMessage`): when true the inflate
//   stream is reset() between messages per §7.2.1; when false the LZ77 window
//   (history) carries over from message to message.
//
// Decoder: { decode(compressedPayload) -> Promise<Buffer>, reset(), close() }
//   `decode` writes the payload plus FRAME_TRAILER into a persistent
//   zlib.createInflateRaw({ windowBits }) and flush()es it (§7.2.1), resolving
//   with the decompressed bytes; a zlib error surfaces as a rejected Promise
//   (the stream is then dead and every later decode rejects too). `reset()`
//   drops the retained history; `close()` releases the stream.
// ---------------------------------------------------------------------------

import zlib from "node:zlib";

export const FRAME_TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CONTROL_MIN = 0x8;
const RSV1 = 0x4;

// ---------------------------------------------------------------------------
// (a) Frame parser: bytes -> Frame[] (strict; throws on a truncated frame or
// an illegal use of the reserved bits it can verify without more context).
// ---------------------------------------------------------------------------
export function parseFrames(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const frames = [];
  let p = 0;
  while (p < buf.length) {
    if (p + 2 > buf.length) {
      throw new Error(`deflate-oracle: truncated frame header at byte ${p}`);
    }
    const b0 = buf[p];
    const b1 = buf[p + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = (b0 & 0x70) >> 4;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let q = p + 2;
    if (len === 126) {
      if (q + 2 > buf.length) {
        throw new Error(`deflate-oracle: truncated 16-bit length at byte ${q}`);
      }
      len = buf.readUInt16BE(q);
      q += 2;
    } else if (len === 127) {
      if (q + 8 > buf.length) {
        throw new Error(`deflate-oracle: truncated 64-bit length at byte ${q}`);
      }
      const hi = buf.readUInt32BE(q);
      const lo = buf.readUInt32BE(q + 4);
      if ((hi & 0x80000000) !== 0) {
        throw new Error(
          "deflate-oracle: 64-bit payload length has the high bit set",
        );
      }
      len = hi * 4294967296 + lo;
      q += 8;
    }
    let maskKey = null;
    if (masked) {
      if (q + 4 > buf.length) {
        throw new Error(`deflate-oracle: truncated mask key at byte ${q}`);
      }
      maskKey = Buffer.from(buf.subarray(q, q + 4));
      q += 4;
    }
    if (q + len > buf.length) {
      throw new Error(
        `deflate-oracle: truncated payload (need ${len} bytes at byte ${q}, have ${buf.length - q})`,
      );
    }
    const payload = Buffer.from(buf.subarray(q, q + len));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    frames.push({ fin, rsv, opcode, masked, maskKey, payload });
    p = q + len;
  }
  return frames;
}

// ---------------------------------------------------------------------------
// (b) Message assembler: frames -> message groups, honouring the FIN /
// continuation rules and RFC 7692's RSV1 placement (first frame of a
// compressed message only, never on a continuation or a control frame).
// Validates aggressively -- this is a judge, so a malformed stream throws
// rather than being silently repaired.
// ---------------------------------------------------------------------------
export function assembleMessages(frames) {
  const messages = [];
  const controlFrames = [];
  let open = null; // the in-progress message group, if any

  function finish(group) {
    return {
      opcode: group.opcode,
      rsv1: group.rsv1,
      payload: Buffer.concat(group.payloads),
      frames: group.frames,
    };
  }

  for (const frame of frames) {
    if (frame.opcode >= OP_CONTROL_MIN) {
      if (!frame.fin) {
        throw new Error("deflate-oracle: fragmented control frame (FIN clear)");
      }
      if (frame.rsv !== 0) {
        throw new Error("deflate-oracle: reserved bit set on a control frame");
      }
      if (frame.payload.length > 125) {
        throw new Error(
          "deflate-oracle: control frame payload exceeds 125 bytes",
        );
      }
      controlFrames.push(frame);
      continue;
    }
    if (frame.opcode === OP_CONTINUATION) {
      if (!open) {
        throw new Error(
          "deflate-oracle: continuation frame without a message start",
        );
      }
      if (frame.rsv !== 0) {
        throw new Error(
          "deflate-oracle: reserved bit set on a continuation frame",
        );
      }
      open.frames.push(frame);
      open.payloads.push(frame.payload);
      if (frame.fin) {
        messages.push(finish(open));
        open = null;
      }
      continue;
    }
    if (frame.opcode !== OP_TEXT && frame.opcode !== OP_BINARY) {
      throw new Error(
        `deflate-oracle: unknown opcode 0x${frame.opcode.toString(16)}`,
      );
    }
    if (open) {
      throw new Error(
        "deflate-oracle: new data frame before the previous message finished",
      );
    }
    if ((frame.rsv & ~RSV1) !== 0) {
      throw new Error("deflate-oracle: RSV2/RSV3 must be clear");
    }
    open = {
      opcode: frame.opcode,
      rsv1: (frame.rsv & RSV1) !== 0,
      frames: [frame],
      payloads: [frame.payload],
    };
    if (frame.fin) {
      messages.push(finish(open));
      open = null;
    }
  }
  if (open) {
    throw new Error("deflate-oracle: truncated message (group never saw FIN)");
  }
  return { messages, controlFrames };
}

// ---------------------------------------------------------------------------
// (c) Decoder: a persistent raw-inflate stream driven per RFC 7692 §7.2.1 --
// append the 4-byte trailer, feed the stream, flush(), and reset() between
// messages when the peer's compressor uses no context takeover. Mirrors the
// node/`ws` usage pattern (write + flush callback), never Z_FULL_FLUSH on the
// compressor side; the deflate side of this oracle is the CALLER's job.
// ---------------------------------------------------------------------------
export function createInflateDecoder(options = {}) {
  const { resetPerMessage = false, windowBits = 15 } = options;
  const stream = zlib.createInflateRaw({ windowBits });
  let chunks = [];
  let inFlight = null; // { resolve, reject } of the pending decode()
  let streamError = null;
  let closed = false;

  stream.on("data", (chunk) => {
    chunks.push(chunk);
  });
  stream.on("error", (err) => {
    streamError = err;
    const pending = inFlight;
    if (pending) {
      inFlight = null;
      pending.reject(err);
    }
  });

  function decode(payload) {
    if (closed) {
      return Promise.reject(new Error("deflate-oracle: decoder is closed"));
    }
    if (streamError) {
      return Promise.reject(streamError);
    }
    if (inFlight) {
      return Promise.reject(
        new Error(
          "deflate-oracle: decode() called while a previous decode is in flight",
        ),
      );
    }
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    return new Promise((resolve, reject) => {
      inFlight = { resolve, reject };
      chunks = [];
      stream.write(body);
      stream.write(FRAME_TRAILER);
      stream.flush((flushErr) => {
        const pending = inFlight;
        if (!pending) return; // an 'error' event already settled this decode
        inFlight = null;
        if (flushErr) {
          reject(flushErr);
          return;
        }
        if (streamError) {
          reject(streamError);
          return;
        }
        const out = Buffer.concat(chunks);
        chunks = [];
        if (resetPerMessage) {
          try {
            stream.reset();
          } catch (err) {
            reject(err);
            return;
          }
        }
        resolve(out);
      });
    });
  }

  function reset() {
    if (!closed && !streamError) stream.reset();
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      stream.close(() => resolve());
    });
  }

  return { decode, reset, close };
}

// Decode a batch of message groups in wire order with ONE persistent inflate
// stream, so context takeover spans the batch exactly as it does on the wire.
// A group with rsv1 === false is not compressed and its payload passes through
// verbatim (and does not advance the inflate context).
export async function decodeMessages(groups, options = {}) {
  const decoder = createInflateDecoder(options);
  try {
    const out = [];
    for (const group of groups) {
      if (group.rsv1) {
        out.push(await decoder.decode(group.payload));
      } else {
        out.push(Buffer.from(group.payload));
      }
    }
    return out;
  } finally {
    await decoder.close();
  }
}

// Convenience: parse + assemble + decode a whole byte buffer that holds
// complete frames (one direction of a connection).
export function decodeBuffer(bytes, options = {}) {
  const { messages } = assembleMessages(parseFrames(bytes));
  return decodeMessages(messages, options);
}
