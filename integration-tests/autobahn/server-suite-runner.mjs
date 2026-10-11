// Starts the Gren autobahn-server-app (fork, waits for the same stdout
// handshake as integration-tests/websocket/run.mjs: "server started"), runs
// the fuzzingclient container against it, stops the server, then gates on
// reports/clients/index.json. See Makefile target autobahn-server-suite.
import * as path from "node:path";
import * as fs from "node:fs";
import * as childProc from "node:child_process";

const ROOT = import.meta.dirname;
const IS_DARWIN = process.platform === "darwin";
const CONFIG = IS_DARWIN
  ? path.join(ROOT, ".fuzzingclient.darwin.json")
  : path.join(ROOT, "config", "fuzzingclient.json");

if (IS_DARWIN) {
  // Docker Desktop (often without --network host support) reaches host
  // loopback listeners via host.docker.internal; rewrite the canonical URL.
  const src = fs.readFileSync(
    path.join(ROOT, "config", "fuzzingclient.json"),
    "utf8",
  );
  fs.writeFileSync(
    CONFIG,
    src.replace("ws://127.0.0.1:9009", "ws://host.docker.internal:9009"),
  );
}

function fork(name) {
  return childProc.fork(path.resolve(ROOT, name), [], { silent: true });
}

function waitForServerStart(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server did not start within " + timeoutMs + "ms"));
    }, timeoutMs);
    proc.stdout.on("data", (data) => {
      if (data.toString().includes("server started")) {
        clearTimeout(timeout);
        proc.stdout.resume();
        proc.stderr.resume();
        resolve();
      }
    });
    proc.stderr.on("data", (data) => process.stderr.write(data));
  });
}

const server = fork("autobahn-server-app");
server.stdout.on("data", (d) => process.stdout.write(d));
await waitForServerStart(server);
console.log("autobahn-server-app listening on 9009; starting fuzzingclient");

const dockerArgs = [
  "run",
  "--rm",
  ...(IS_DARWIN
    ? []
    : ["--network", "host", "--add-host=host.docker.internal:host-gateway"]),
  "-v",
  CONFIG + ":/config/fuzzingclient.json:ro",
  "-v",
  path.join(ROOT, "reports") + ":/reports",
  "crossbario/autobahn-testsuite",
  "wstest",
  "-m",
  "fuzzingclient",
  "-s",
  "/config/fuzzingclient.json",
];

const fuzz = childProc.spawn("docker", dockerArgs, { stdio: "inherit" });
const fuzzCode = await new Promise((resolve) => fuzz.on("exit", resolve));

server.kill();

const gate = childProc.spawn(
  process.execPath,
  ["check-reports.mjs", "--suite", "server"],
  { cwd: ROOT, stdio: "inherit" },
);
const gateCode = await new Promise((resolve) => gate.on("exit", resolve));

if (IS_DARWIN) fs.rmSync(CONFIG, { force: true });

console.log("fuzzingclient exit code:", fuzzCode);
process.exit(gateCode === 0 && fuzzCode === 0 ? 0 : 1);
