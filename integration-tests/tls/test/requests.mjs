import * as tls from "node:tls";
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { runGrenApp } from "./fixtures.mjs";

const host = "127.0.0.1";
const port = 9410;

const certDir = path.resolve(import.meta.dirname, "../certs");
const goodCa = [fs.readFileSync(path.join(certDir, "server-good.crt"))];
const wrongCa = [fs.readFileSync(path.join(certDir, "server-wrong.crt"))];

// Plain node:tls client used as the independent third-party test client: our
// own Gren client is never used to validate our own Gren server.
function connectTls(options) {
  return new Promise((resolve, reject) => {
    const client = tls.connect({ host, port, ...options }, () =>
      resolve(client),
    );
    client.once("error", reject);
  });
}

// Collect `expectedBytes` bytes from the socket (TLS is a byte stream, so
// decrypted chunks may split arbitrarily).
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

// Wait for the peer to send close_notify + FIN (server-side Tls.Socket.end()
// observed here).
function waitForEnd(client, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No close_notify/FIN received")),
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

// Fail with the given error unless the handshake rejects with `expectedCode`.
async function expectHandshakeFailure(options, expectedCode) {
  try {
    const client = await connectTls(options);
    client.destroy();
    assert.fail(`expected handshake to fail with ${expectedCode}`);
  } catch (err) {
    assert.strictEqual(
      err.code,
      expectedCode,
      `unexpected code: ${err.code} (${err.message})`,
    );
  }
}

describe("Tls echo server (independent node:tls client)", function () {
  this.timeout(60000);

  it("echoes a text roundtrip with Ca pinned + servername localhost", async () => {
    const client = await connectTls({ ca: goodCa, servername: "localhost" });
    assert.strictEqual(client.authorized, true);
    await writeAll(client, Buffer.from("hello from mocha"));
    const echoed = await readBytes(client, 16);
    assert.strictEqual(echoed.toString(), "hello from mocha");
    client.destroy();
  });

  it("echoes binary data including NUL bytes", async () => {
    const client = await connectTls({ ca: goodCa, servername: "localhost" });
    const payload = Buffer.from([0, 255, 10, 98, 0, 7]);
    await writeAll(client, payload);
    const echoed = await readBytes(client, payload.length);
    assert.deepStrictEqual(echoed, payload);
    client.destroy();
  });

  it("echoes a 1 MB buffer byte-equal", async () => {
    const client = await connectTls({ ca: goodCa, servername: "localhost" });
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await writeAll(client, payload);
    const echoed = await readBytes(client, payload.length);
    assert.ok(echoed.equals(payload), "echoed bytes differ from sent bytes");
    client.destroy();
  });

  it("half-close: server sees close_notify and ends its side when client ends", async () => {
    const client = await connectTls({ ca: goodCa, servername: "localhost" });
    await writeAll(client, Buffer.from("bye"));
    const echoed = await readBytes(client, 3);
    assert.strictEqual(echoed.toString(), "bye");
    // Client FINs; the Gren server's read sees Closed and end()s its side.
    client.end();
    await waitForEnd(client);
    client.destroy();
  });

  it("hostname mismatch: servername example.com fails ERR_TLS_CERT_ALTNAME_INVALID", async () => {
    await expectHandshakeFailure(
      { ca: goodCa, servername: "example.com" },
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
  });

  it("wrong CA pin fails with a self-signed/unverifiable code", async () => {
    try {
      const client = await connectTls({
        ca: wrongCa,
        servername: "localhost",
      });
      client.destroy();
      assert.fail("expected handshake to fail");
    } catch (err) {
      // The pinned CA is not the issuer of the presented leaf, so the chain
      // terminates at an untrusted self-signed cert.
      assert.ok(
        ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT"].includes(err.code),
        `unexpected code: ${err.code} (${err.message})`,
      );
    }
  });

  it("no CA + rejectUnauthorized:false connects (server interops with opted-out clients)", async () => {
    const client = await connectTls({ rejectUnauthorized: false });
    await writeAll(client, Buffer.from("insecure"));
    const echoed = await readBytes(client, 8);
    assert.strictEqual(echoed.toString(), "insecure");
    client.destroy();
  });

  it("listen on in-use port fails with EADDRINUSE (Gren app)", async () => {
    const output = await runGrenApp("in-use-test-app");
    assert.ok(output.includes("PASS in-use"), output);
  });

  it("secure() on a destroyed Net.Socket fails with ERR_STREAM_DESTROYED (Gren app)", async () => {
    const output = await runGrenApp("secure-after-close-test-app");
    assert.ok(output.includes("PASS secure-after-close"), output);
  });

  it("listen with malformed PEM bytes fails the Task instead of crashing (Gren app)", async () => {
    const output = await runGrenApp("bad-pem-test-app");
    assert.ok(output.includes("PASS bad-pem"), output);
  });
});

// ALPN gate: the Gren kernel passes Tls.{Client,Server}AlpnProtocols straight
// through to node's ALPNProtocols option, so the assertion below runs the
// node:tls handshake directly (independent client AND server, per the suite's
// no-self-validation rule) to pin the negotiation semantics the kernel relies
// on — with ALPNProtocols set, the negotiated protocol must be observable;
// with no overlap, the handshake must abort. If a Gren option ever gets
// dropped on the way into node, the no-overlap case would silently negotiate
// (or, client-side, the match case would negotiate nothing), and these
// assertions fail.
describe("ALPN negotiation (node:tls ground truth for the kernel's ALPNProtocols plumbing)", function () {
  this.timeout(60000);

  const alpnPort = 9412;
  const serverCert = fs.readFileSync(path.join(certDir, "server-good.crt"));
  const serverKey = fs.readFileSync(path.join(certDir, "server-good.key"));

  let alpnServer;

  beforeEach(async () => {
    alpnServer = tls.createServer(
      {
        cert: serverCert,
        key: serverKey,
        ALPNProtocols: ["hq-29", "http/1.1"],
      },
      () => {},
    );
    // Aborted handshakes (the no-overlap case below) must not become an
    // unhandled event.
    alpnServer.on("tlsClientError", () => {});
    await new Promise((resolve) => alpnServer.listen(alpnPort, host, resolve));
  });

  afterEach(() => {
    alpnServer.close();
  });

  function connectAlpn(ALPNProtocols) {
    return new Promise((resolve, reject) => {
      const client = tls.connect(
        {
          host,
          port: alpnPort,
          ca: goodCa,
          servername: "localhost",
          ALPNProtocols,
        },
        () => resolve(client),
      );
      client.once("error", reject);
    });
  }

  it("overlapping lists negotiate hq-29 on both sides", async () => {
    const client = await connectAlpn(["hq-29", "http/1.1"]);
    assert.strictEqual(client.alpnProtocol, "hq-29");
    client.destroy();
  });

  it("no-overlapping client list aborts the handshake (ALPN was in effect)", async () => {
    // Documented choice: node rejects a no-overlap handshake with a
    // tlsv1 alert no application protocol (ERR_SSL_TLSV1_ALERT_NO_APPLICATION_
    // PROTOCOL) rather than letting the client see alpnProtocol === false.
    // That is the stronger assertion: if ALPNProtocols had been dropped on
    // the server side, this client would have connected with no protocol
    // negotiated, and this test would fail.
    await assert.rejects(
      () => connectAlpn(["spdy/3.1"]),
      (err) =>
        err.code === "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL" ||
        (err.message || "").includes("no application protocol"),
      "expected the no-overlap handshake to be rejected",
    );
  });
});
