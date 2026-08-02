import * as path from "node:path";
import * as childProc from "node:child_process";

// Start the Gren WebSocket server, run the Gren client tests, then shut down.
// The mocha server tests are run separately by the Makefile (they start their
// own server instance via fixtures.mjs).

function fork(name) {
  return childProc.fork(path.resolve(import.meta.dirname, name), [], {
    silent: true,
  });
}

function waitForServerStart(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server did not start within 5000ms"));
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      if (data.toString().includes("WebSocket server started")) {
        clearTimeout(timeout);
        proc.stdout.resume();
        proc.stderr.resume();
        resolve();
      }
    });

    proc.stderr.resume();
  });
}

const server = fork("server-app");
await waitForServerStart(server);

const exitCode = await new Promise((resolve) => {
  const client = fork("client-tests-app");
  client.stdout.on("data", (data) => process.stdout.write(data));
  client.stderr.on("data", (data) => process.stderr.write(data));
  client.on("exit", resolve);
});

server.kill();

process.exit(exitCode);
