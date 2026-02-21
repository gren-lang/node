import WebSocket from "ws";
import * as assert from "node:assert";

const url = "ws://127.0.0.1:8085";

// Buffer messages from the moment the WebSocket is created.
// The WebSocket library can emit "message" in the same event-loop tick as "open"
// (when the server response and the first data frame arrive in one TCP read),
// so any listener added after `await connect()` may miss early messages.
function connect() {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    const messageQueue = [];
    const waitingForMessageQueue = [];

    client.on("message", (data, isBinary) => {
      const entry = { data, isBinary };
      if (waitingForMessageQueue.length > 0) {
        const resolve = waitingForMessageQueue.shift();
        resolve(entry);
      } else {
        messageQueue.push(entry);
      }
    });

    client._takeMessage = function () {
      return new Promise((resolve) => {
        if (messageQueue.length > 0) {
          resolve(messageQueue.shift());
        } else {
          waitingForMessageQueue.push(resolve);
        }
      });
    };

    client.on("open", () => resolve(client));
    client.on("error", reject);
  });
}

async function waitForMessage(client) {
  const { data } = await client._takeMessage();
  return data.toString();
}

async function waitForRawMessage(client) {
  return client._takeMessage();
}

function waitForClose(client) {
  return new Promise((resolve) => {
    client.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function closeConnection(client) {
  return new Promise((resolve) => {
    client.on("close", () => resolve());
    client.close();
  });
}

describe("WebSocket Server", function () {
  this.timeout(10000);
  it("sends welcome message on connection", async () => {
    const client = await connect();
    const msg = await waitForMessage(client);

    assert.equal(msg, "welcome");

    await closeConnection(client);
  });

  it("echoes text messages", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    client.send("hello");
    const echo = await waitForMessage(client);

    assert.equal(echo, "echo:hello");

    await closeConnection(client);
  });

  it("echoes multiple messages", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    client.send("first");
    const echo1 = await waitForMessage(client);
    assert.equal(echo1, "echo:first");

    client.send("second");
    const echo2 = await waitForMessage(client);
    assert.equal(echo2, "echo:second");

    await closeConnection(client);
  });

  it("echoes binary messages", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    const binaryData = Buffer.from([1, 2, 3, 4, 5]);
    client.send(binaryData);

    const echoed = await waitForRawMessage(client);

    assert.ok(echoed.isBinary, "Expected binary message");
    assert.deepEqual(Buffer.from(echoed.data), binaryData);

    await closeConnection(client);
  });

  it("handles unicode text messages", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    client.send("snow ❄ flake");
    const echo = await waitForMessage(client);

    assert.equal(echo, "echo:snow ❄ flake");

    await closeConnection(client);
  });

  it("supports multiple concurrent connections", async () => {
    const client1 = await connect();
    // Consume welcome for client1 before opening client2
    await waitForMessage(client1);

    const client2 = await connect();
    // Consume welcome for client2
    await waitForMessage(client2);

    client1.send("from-client-1");
    const echo1 = await waitForMessage(client1);
    assert.equal(echo1, "echo:from-client-1");

    client2.send("from-client-2");
    const echo2 = await waitForMessage(client2);
    assert.equal(echo2, "echo:from-client-2");

    await closeConnection(client1);
    await closeConnection(client2);
  });

  it("client can close connection", async () => {
    // This test verifies that the server handles client disconnection gracefully
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    const closePromise = waitForClose(client);
    client.close(1000, "client closing");

    const { code } = await closePromise;
    assert.equal(code, 1000);
  });

  it("server initiates close when receiving please-close", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    // Set up close listener before sending the trigger message
    const closePromise = waitForClose(client);

    client.send("please-close");

    const { code, reason } = await closePromise;
    assert.equal(code, 1000);
    assert.equal(reason, "server-initiated-close");
  });

  it("echoes a large text message", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    // Create a 100KB message
    const largeMessage = "A".repeat(100 * 1024);
    client.send(largeMessage);
    const echo = await waitForMessage(client);

    assert.equal(echo, "echo:" + largeMessage);

    await closeConnection(client);
  });

  it("echoes rapid messages in order", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    const messageCount = 50;

    // Send all messages rapidly without waiting for echoes
    for (let i = 0; i < messageCount; i++) {
      client.send("msg-" + i);
    }

    // Collect all echoes via the message queue
    const received = [];
    for (let i = 0; i < messageCount; i++) {
      received.push(await waitForMessage(client));
    }

    // Verify all messages were echoed in order
    assert.equal(received.length, messageCount);
    for (let i = 0; i < messageCount; i++) {
      assert.equal(received[i], "echo:msg-" + i);
    }

    await closeConnection(client);
  });

  it("accepts a new connection after a previous one was closed", async () => {
    // First connection
    const client1 = await connect();
    const welcome1 = await waitForMessage(client1);
    assert.equal(welcome1, "welcome");

    client1.send("first-connection");
    const echo1 = await waitForMessage(client1);
    assert.equal(echo1, "echo:first-connection");

    await closeConnection(client1);

    // Second connection after close
    const client2 = await connect();
    const welcome2 = await waitForMessage(client2);
    assert.equal(welcome2, "welcome");

    client2.send("second-connection");
    const echo2 = await waitForMessage(client2);
    assert.equal(echo2, "echo:second-connection");

    await closeConnection(client2);
  });

  it("echoes an empty string message", async () => {
    const client = await connect();

    // Consume the welcome message
    await waitForMessage(client);

    client.send("");
    const echo = await waitForMessage(client);

    assert.equal(echo, "echo:");

    await closeConnection(client);
  });
});
