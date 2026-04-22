import * as path from "node:path";
import * as childProc from "node:child_process";

let proc;

export function mochaGlobalSetup() {
  const appPath = path.resolve(import.meta.dirname, "../app");
  proc = childProc.fork(appPath, [], { silent: true });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server did not start within 5000ms"));
    }, 5000);

    proc.stdout.on("data", (data) => {
      if (data.toString().includes("WebSocket server started")) {
        clearTimeout(timeout);
        // Keep draining stdout/stderr
        proc.stdout.resume();
        proc.stderr.resume();
        resolve();
      }
    });

    proc.stderr.resume();
  });
}

export function mochaGlobalTeardown() {
  proc.kill();
}
