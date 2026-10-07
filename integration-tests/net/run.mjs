import * as path from "node:path";
import * as childProc from "node:child_process";

// Start the Gren Net echo server, run the Gren client tests, then shut down.
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
      if (data.toString().includes("Net server started")) {
        clearTimeout(timeout);
        proc.stdout.resume();
        proc.stderr.resume();
        resolve();
      }
    });

    proc.stderr.resume();
  });
}

// Hard deadline for the client run so a hung client can never leave the
// runner (and the forked server holding port 9310) alive indefinitely.
const CLIENT_TIMEOUT_MS = 30000;

const server = fork("server-app");

let exitCode = 1;
try {
  await waitForServerStart(server);

  exitCode = await new Promise((resolve, reject) => {
    const client = fork("client-tests-app");
    const watchdog = setTimeout(() => {
      client.kill();
      reject(new Error(`Client did not exit within ${CLIENT_TIMEOUT_MS}ms`));
    }, CLIENT_TIMEOUT_MS);

    client.stdout.on("data", (data) => process.stdout.write(data));
    client.stderr.on("data", (data) => process.stderr.write(data));
    client.on("exit", (code) => {
      clearTimeout(watchdog);
      resolve(code);
    });
    client.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
  });
} finally {
  // Always reap the forked server: on a start timeout, a client failure, or a
  // client watchdog kill, an orphaned server would hold port 9310 and make
  // every subsequent run fail with EADDRINUSE.
  server.kill();
}

process.exit(exitCode);
