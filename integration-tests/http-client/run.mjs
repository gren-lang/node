import * as path from "node:path";
import * as cp from "node:child_process";
import { setTimeout } from "node:timers/promises";

// helpers

function fork(name) {
  return cp.fork(path.resolve(import.meta.dirname, name));
}

function run(name) {
  return new Promise((resolve, reject) => {
    fork(name).on("exit", (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`${name} exited with code ${code}`));
    });
  });
}

// start the tests server
const server = fork("server-app");

// cheap wait for server to be up
await setTimeout(100);

// run tests
await run("tests-app");
await run("stream-tests-app");

server.kill();
