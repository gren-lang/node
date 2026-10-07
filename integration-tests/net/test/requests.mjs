import * as net from "node:net";
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import { runGrenApp } from "./fixtures.mjs";

const host = "127.0.0.1";
const port = 9310;

// Plain node:net client used as the independent third-party test client.
function connect() {
  return new Promise((resolve, reject) => {
    const client = net.connect({ host, port }, () => resolve(client));
    client.on("error", reject);
  });
}

// Collect `expectedBytes` bytes from the socket (TCP is a byte stream, so
// chunks may split arbitrarily).
function readBytes(client, expectedBytes, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out: received ${received}/${expectedBytes} bytes`),
      );
    }, timeoutMs);

    const onData = (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= expectedBytes) {
        cleanup();
        resolve(Buffer.concat(chunks, received).subarray(0, expectedBytes));
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      reject(
        new Error(
          `Socket ended early: received ${received}/${expectedBytes} bytes`,
        ),
      );
    };
    function cleanup() {
      clearTimeout(timer);
      client.off("data", onData);
      client.off("error", onError);
      client.off("end", onEnd);
    }

    client.on("data", onData);
    client.on("error", onError);
    client.on("end", onEnd);
  });
}

// Wait for the peer to send FIN (server-side Socket.end() observed here).
function waitForEnd(client, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No FIN received")),
      timeoutMs,
    );
    client.once("end", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function writeAll(client, buffer) {
  return new Promise((resolve, reject) => {
    client.write(buffer, (err) => (err ? reject(err) : resolve()));
  });
}

describe("Net echo server (independent node:net client)", function () {
  this.timeout(60000);

  it("echoes text roundtrip", async () => {
    const client = await connect();
    try {
      const payload = Buffer.from("hello from mocha", "utf8");
      await writeAll(client, payload);
      const echoed = await readBytes(client, payload.length);
      assert.deepStrictEqual(echoed, payload);
    } finally {
      client.destroy();
    }
  });

  it("echoes binary roundtrip including NUL bytes", async () => {
    const client = await connect();
    try {
      const payload = Buffer.from([0, 1, 2, 0, 255, 128, 0, 7, 0]);
      await writeAll(client, payload);
      const echoed = await readBytes(client, payload.length);
      assert.ok(echoed.equals(payload));
    } finally {
      client.destroy();
    }
  });

  it("echoes 10k small messages in order", async () => {
    const client = await connect();
    try {
      const count = 10000;
      const parts = [];
      for (let i = 0; i < count; i++) {
        parts.push(Buffer.from(String(i).padStart(10, "0"), "ascii"));
      }

      // Sequential writes: await each write callback so backpressure from the
      // Gren server (readBufferCapacity 16 chunks) actually throttles us.
      for (const part of parts) {
        await writeAll(client, part);
      }

      const echoed = await readBytes(client, count * 10, 60000);
      const expected = Buffer.concat(parts);
      assert.ok(
        echoed.equals(expected),
        "echoed byte stream must match sent stream exactly (order + content)",
      );
    } finally {
      client.destroy();
    }
  });

  it("echoes a 10 MB buffer byte-equal", async () => {
    const client = await connect();
    try {
      const payload = crypto.randomBytes(10 * 1024 * 1024);
      await writeAll(client, payload);
      const echoed = await readBytes(client, payload.length, 60000);
      assert.ok(echoed.equals(payload), "10 MB echo must be byte-identical");
    } finally {
      client.destroy();
    }
  });

  it("half-close: server sees FIN and ends its side when client ends", async () => {
    const client = await connect();
    try {
      const payload = Buffer.from("goodbye", "utf8");
      await writeAll(client, payload);
      // Read the echo before ending so ordering is unambiguous.
      const echoed = await readBytes(client, payload.length);
      assert.ok(echoed.equals(payload));

      // Client half-closes: FIN to the server. The server observes its
      // readable closing (Stream.Closed) and responds with Socket.end() —
      // which we must observe as 'end' (FIN back), not just a close.
      client.end();
      await waitForEnd(client);
    } finally {
      client.destroy();
    }
  });

  it("connect to never-bound port fails with ECONNREFUSED (Gren app)", async () => {
    const output = await runGrenApp("refused-test-app");
    assert.match(output, /PASS refused/);
  });

  it("listen on in-use port fails with EADDRINUSE (Gren app)", async () => {
    // The echo server (fixtures) IS running on 9310 right now.
    const output = await runGrenApp("in-use-test-app");
    assert.match(output, /PASS in-use/);
  });
});
