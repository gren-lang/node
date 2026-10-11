// Phase 4 F1 regression: a rejected handshake must not crash the server.
//
// reject() in the kernel writes an HTTP 400/426, then socket.end(). If the
// peer never reads the response and closes, its socket RSTs; the kernel has
// just removed every "error" listener (cleanup), so the late ECONNRESET used
// to surface as an unhandled 'error' event and kill the whole process. The
// fix retains a no-op error listener inside reject() before end().
//
// These specs drive server-app (launched by fixtures.mjs on port 8085) with
// raw bad-upgrade requests that hit BOTH reject paths exactly, per
// __WebSocketHandshake_validateClientRequest:
//   400 BadRequest      -- GET, valid Upgrade/Connection, Sec-WebSocket-
//                          Version: 13, empty Sec-WebSocket-Key
//   426 UpgradeRequired -- GET, valid Upgrade/Connection, NO
//                          Sec-WebSocket-Version
// Each variant runs twice: once reading the response (asserting the status
// head bytes) and once never reading before destroy() (forcing the RST).
// A final real WebSocket echo roundtrip proves the server survived.
import * as net from "node:net";
import * as assert from "node:assert";
import WebSocket from "ws";
import { getAppProcess } from "./fixtures.mjs";

const HOST = "127.0.0.1";
const PORT = 8085;

// Hits reject("BadRequest") -> 400: every earlier check passes, the key is
// present but empty (validateClientRequest treats "" as missing).
const BAD_REQUEST_HEAD =
  "GET / HTTP/1.1\r\n" +
  "Host: 127.0.0.1:8085\r\n" +
  "Upgrade: websocket\r\n" +
  "Connection: Upgrade\r\n" +
  "Sec-WebSocket-Version: 13\r\n" +
  "Sec-WebSocket-Key: \r\n" +
  "\r\n";

// Hits reject("UpgradeRequired") -> 426: valid GET/Upgrade/Connection but
// the version header is absent.
const UPGRADE_REQUIRED_HEAD =
  "GET / HTTP/1.1\r\n" +
  "Host: 127.0.0.1:8085\r\n" +
  "Upgrade: websocket\r\n" +
  "Connection: Upgrade\r\n" +
  "\r\n";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Write `head` to a fresh socket.
//
// readResponse: collect the reply until the header block ends and resolve
// with it (asserts which reject branch the kernel took).
//
// otherwise: read NOTHING and destroy as soon as the request has drained.
// The rejection response is already in flight, so it stays unread in our
// receive buffer and destroy() makes the kernel answer the half-close with
// an RST -- that is the event the kernel must not crash on.
function rawExchange(head, { readResponse }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, HOST);
    socket.setNoDelay(true);
    let response = "";
    let done = false;
    function finish(err) {
      if (done) return;
      done = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(response);
    }
    socket.on("connect", () => {
      if (readResponse) {
        socket.write(head);
        return;
      }
      socket.write(head, () => {
        response = null;
        socket.destroy();
        finish();
      });
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) finish();
    });
    socket.on("error", finish);
    socket.setTimeout(2000, () => finish(new Error("raw exchange timed out")));
  });
}

describe("WebSocket server handshake rejections", function () {
  this.timeout(10000);

  it("answers a keyless upgrade with 400 Bad Request", async () => {
    const response = await rawExchange(BAD_REQUEST_HEAD, {
      readResponse: true,
    });
    assert.match(response, /^HTTP\/1\.1 400/);
  });

  it("answers a versionless upgrade with 426 Upgrade Required", async () => {
    const response = await rawExchange(UPGRADE_REQUIRED_HEAD, {
      readResponse: true,
    });
    assert.match(response, /^HTTP\/1\.1 426/);
  });

  it("survives an RST on an unread 400 rejection", async () => {
    await rawExchange(BAD_REQUEST_HEAD, { readResponse: false });
    // Give the RST a tick to reach the (unfixed) server before liveness.
    await sleep(100);
    assert.strictEqual(
      getAppProcess().exitCode,
      null,
      "server-app exited after the 400-rejection RST",
    );
  });

  it("survives an RST on an unread 426 rejection", async () => {
    await rawExchange(UPGRADE_REQUIRED_HEAD, { readResponse: false });
    await sleep(100);
    assert.strictEqual(
      getAppProcess().exitCode,
      null,
      "server-app exited after the 426-rejection RST",
    );
  });

  it("still serves a real echo roundtrip after the rejections", async () => {
    const client = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${HOST}:${PORT}`);
      const timer = setTimeout(
        () => reject(new Error("ws connect timed out")),
        3000,
      );
      ws.on("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.on("error", reject);
    });
    try {
      const echoed = new Promise((resolve, reject) => {
        client.on("message", (data) => {
          const text = data.toString();
          if (text.startsWith("echo:")) resolve(text);
        });
        client.on("error", reject);
      });
      client.send("reject-probe");
      assert.strictEqual(await echoed, "echo:reject-probe");
    } finally {
      client.close();
    }
  });
});
