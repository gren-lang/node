import * as path from "node:path";
import * as cp from "node:child_process";
import { setTimeout } from "node:timers/promises";

// helpers

function fork(name) {
  return cp.fork(path.resolve(import.meta.dirname, name));
}

function run(name) {
  return new Promise((resolve) => fork(name).on("exit", resolve));
}

// start the tests server
const server = fork("server-app");

// cheap wait for server to be up
await setTimeout(100);

// run tests
await run("tests-app");
await run("stream-tests-app");

// shut down server
server.kill();
