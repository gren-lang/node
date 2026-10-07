import * as path from "node:path";
import * as childProc from "node:child_process";

let proc;

export function mochaGlobalSetup() {
  const appPath = path.resolve(import.meta.dirname, "../server-app");
  proc = childProc.fork(appPath, [], { silent: true });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server did not start within 5000ms"));
    }, 5000);

    proc.stdout.on("data", (data) => {
      if (data.toString().includes("Net server started")) {
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

export function getAppProcess() {
  return proc;
}

// Run one of the standalone Gren test apps (RefusedTest / InUseTest) and
// assert it exits 0. These apps encode the assertion themselves: they print
// PASS/FAIL and set the exit code accordingly.
export function runGrenApp(appName, timeoutMs = 10000) {
  const appPath = path.resolve(import.meta.dirname, "..", appName);
  return new Promise((resolve, reject) => {
    const child = childProc.execFile(process.execPath, [appPath], {
      timeout: timeoutMs,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${appName} exited with code ${code}\n${output}`));
      }
    });
    child.on("error", reject);
  });
}
