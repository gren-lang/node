import WebSocket from "ws";
import * as assert from "node:assert";

const url = "ws://127.0.0.1:8085";

// Buffer messages from the moment the WebSocket is created.
// The ws library can emit "message" in the same event-loop tick as "open"
// (when the server response and the first data frame arrive in one TCP read),
// so any listener added after `await connect()` may miss early messages.
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messageQueue = [];
    const waitingForMessageQueue = [];

    ws.on("message", (data, isBinary) => {
      const entry = { data, isBinary };
      if (waitingForMessageQueue.length > 0) {
        waitingForMessageQueue.shift()(entry);
      } else {
        messageQueue.push(entry);
      }
    });

    ws._takeMessage = function () {
      return new Promise((resolve) => {
        if (messageQueue.length > 0) {
          resolve(messageQueue.shift());
        } else {
          waitingForMessageQueue.push(resolve);
        }
      });
    };

    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function waitForMessage(ws) {
  const { data } = await ws._takeMessage();
  return data.toString();
}

async function waitForRawMessage(ws) {
  return ws._takeMessage();
}

function waitForClose(ws) {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function closeConnection(ws) {
  return new Promise((resolve) => {
    ws.on("close", () => resolve());
    ws.close();
  });
}

describe("WebSocket Server", function () {
  this.timeout(10000);
  it("sends welcome message on connection", async () => {
    const ws = await connect();
    const msg = await waitForMessage(ws);

    assert.equal(msg, "welcome");

    await closeConnection(ws);
  });

  it("echoes text messages", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    ws.send("hello");
    const echo = await waitForMessage(ws);

    assert.equal(echo, "echo:hello");

    await closeConnection(ws);
  });

  it("echoes multiple messages", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    ws.send("first");
    const echo1 = await waitForMessage(ws);
    assert.equal(echo1, "echo:first");

    ws.send("second");
    const echo2 = await waitForMessage(ws);
    assert.equal(echo2, "echo:second");

    await closeConnection(ws);
  });

  it("echoes binary messages", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    const binaryData = Buffer.from([1, 2, 3, 4, 5]);
    ws.send(binaryData);

    const echoed = await waitForRawMessage(ws);

    assert.ok(echoed.isBinary, "Expected binary message");
    assert.deepEqual(Buffer.from(echoed.data), binaryData);

    await closeConnection(ws);
  });

  it("handles unicode text messages", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    ws.send("snow ❄ flake");
    const echo = await waitForMessage(ws);

    assert.equal(echo, "echo:snow ❄ flake");

    await closeConnection(ws);
  });

  it("supports multiple concurrent connections", async () => {
    const ws1 = await connect();
    // Consume welcome for ws1 before opening ws2
    await waitForMessage(ws1);

    const ws2 = await connect();
    // Consume welcome for ws2
    await waitForMessage(ws2);

    ws1.send("from-client-1");
    const echo1 = await waitForMessage(ws1);
    assert.equal(echo1, "echo:from-client-1");

    ws2.send("from-client-2");
    const echo2 = await waitForMessage(ws2);
    assert.equal(echo2, "echo:from-client-2");

    await closeConnection(ws1);
    await closeConnection(ws2);
  });

  it("client can close connection", async () => {
    // This test verifies that the server handles client disconnection gracefully
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    const closePromise = waitForClose(ws);
    ws.close(1000, "client closing");

    const { code } = await closePromise;
    assert.equal(code, 1000);
  });

  it("server initiates close when receiving please-close", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    // Set up close listener before sending the trigger message
    const closePromise = waitForClose(ws);

    ws.send("please-close");

    const { code, reason } = await closePromise;
    assert.equal(code, 1000);
    assert.equal(reason, "server-initiated-close");
  });

  it("echoes a large text message", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    // Create a 100KB message
    const largeMessage = "A".repeat(100 * 1024);
    ws.send(largeMessage);
    const echo = await waitForMessage(ws);

    assert.equal(echo, "echo:" + largeMessage);

    await closeConnection(ws);
  });

  it("echoes rapid messages in order", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    const messageCount = 50;

    // Send all messages rapidly without waiting for echoes
    for (let i = 0; i < messageCount; i++) {
      ws.send("msg-" + i);
    }

    // Collect all echoes via the message queue
    const received = [];
    for (let i = 0; i < messageCount; i++) {
      received.push(await waitForMessage(ws));
    }

    // Verify all messages were echoed in order
    assert.equal(received.length, messageCount);
    for (let i = 0; i < messageCount; i++) {
      assert.equal(received[i], "echo:msg-" + i);
    }

    await closeConnection(ws);
  });

  it("accepts a new connection after a previous one was closed", async () => {
    // First connection
    const ws1 = await connect();
    const welcome1 = await waitForMessage(ws1);
    assert.equal(welcome1, "welcome");

    ws1.send("first-connection");
    const echo1 = await waitForMessage(ws1);
    assert.equal(echo1, "echo:first-connection");

    await closeConnection(ws1);

    // Second connection after close
    const ws2 = await connect();
    const welcome2 = await waitForMessage(ws2);
    assert.equal(welcome2, "welcome");

    ws2.send("second-connection");
    const echo2 = await waitForMessage(ws2);
    assert.equal(echo2, "echo:second-connection");

    await closeConnection(ws2);
  });

  it("echoes an empty string message", async () => {
    const ws = await connect();

    // Consume the welcome message
    await waitForMessage(ws);

    ws.send("");
    const echo = await waitForMessage(ws);

    assert.equal(echo, "echo:");

    await closeConnection(ws);
  });
});
