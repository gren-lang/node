#!/usr/bin/env node
// Runs one Autobahn suite against the vendored tests (plain node, no deps).
//
//   node run-suite.mjs server   Gren echo server <- fuzzingclient container
//   node run-suite.mjs client   Gren client driver -> fuzzingserver container
//
// The test logic always comes from vendor/ (bind-mounted, PYTHONPATH ahead
// of the image's site-packages); the digest-pinned image is only the
// Python+Twisted runtime. Provenance: vendor/README.md. After the suite
// ends, check-reports.mjs gates the master report with the executed-case
// count taken from the tool that knows it (fuzzingclient announcement /
// /getCaseCount), so a truncated run can never pass.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as childProc from "node:child_process";

const ROOT = import.meta.dirname;
const IMAGE =
  "crossbario/autobahn-testsuite@sha256:519915fb568b04c9383f70a1c405ae3ff44ab9e35835b085239c258b6fac3074";
const IS_DARWIN = process.platform === "darwin";

const suite = process.argv[2];
if (suite !== "server" && suite !== "client") {
  console.error("usage: node run-suite.mjs server|client");
  process.exit(2);
}

const vendorMount = [
  "-v",
  path.join(ROOT, "vendor") + ":/vendor:ro",
  "-e",
  "PYTHONPATH=/vendor",
];

if (suite === "server") {
  // Gren echo server (forked, port 9009) vs. `wstest -m fuzzingclient`.
  //
  // Networking: the container must dial host port 9009. `--network host`
  // does that natively on Linux (CI); Docker Desktop's host networking is
  // commonly disabled, so on Darwin rewrite the loopback URL to
  // host.docker.internal (routed to host loopback listeners regardless of
  // --network mode) and drop --network host.
  const config = path.join(ROOT, "config", "fuzzingclient.json");
  let mounted = config;
  if (IS_DARWIN) {
    mounted = path.join(ROOT, "reports", ".fuzzingclient.darwin.json");
    fs.mkdirSync(path.dirname(mounted), { recursive: true });
    fs.writeFileSync(
      mounted,
      fs
        .readFileSync(config, "utf8")
        .replace("ws://127.0.0.1:9009", "ws://host.docker.internal:9009"),
    );
  }

  const server = childProc.fork(path.resolve(ROOT, "autobahn-server-app"), [], {
    silent: true,
  });
  server.stdout.on("data", (d) => process.stdout.write(d));
  server.stderr.on("data", (d) => process.stderr.write(d));
  let fuzzCode = 1;
  let announced = null;
  let buf = "";
  let startupError = null;
  try {
    const earlyExit = new Promise((_, reject) =>
      server.once("exit", (code, signal) =>
        reject(
          new Error(`autobahn-server-app exited early (${code ?? signal})`),
        ),
      ),
    );
    earlyExit.catch(() => {}); // the intentional kill() in `finally` must not reject unhandled
    await Promise.race([
      waitFor(
        server.stdout,
        "server started",
        10000,
        "autobahn-server-app on :9009",
      ),
      earlyExit,
    ]).catch((e) => (startupError = e));
    if (startupError) throw startupError;
    const fuzz = childProc.spawn(
      "docker",
      [
        "run",
        "--rm",
        ...(IS_DARWIN
          ? []
          : [
              "--network",
              "host",
              "--add-host=host.docker.internal:host-gateway",
            ]),
        "-v",
        mounted + ":/config/fuzzingclient.json:ro",
        ...vendorMount,
        "-v",
        path.join(ROOT, "reports") + ":/reports",
        IMAGE,
        "wstest",
        "-m",
        "fuzzingclient",
        "-s",
        "/config/fuzzingclient.json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    fuzz.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/Ok, will run (\d+) test cases/);
      if (m && announced === null) announced = parseInt(m[1], 10);
      process.stdout.write(d);
    });
    fuzz.stderr.on("data", (d) => process.stderr.write(d));
    fuzzCode = await new Promise((resolve) => fuzz.on("exit", resolve));
  } catch (e) {
    // Startup failure: report and exit after cleanup (below).
    console.error(String(e.message ?? e));
    server.kill();
    if (IS_DARWIN) fs.rmSync(mounted, { force: true });
    process.exit(1);
  } finally {
    // Every exit path: a forked app holding :9009 would poison later runs.
    server.kill();
    if (IS_DARWIN) fs.rmSync(mounted, { force: true });
  }
  if (announced === null) {
    console.error(
      "fuzzingclient never announced a case count ('Ok, will run N test cases'); refusing to gate",
    );
    process.exit(1);
  }
  console.log(
    `fuzzingclient announced N=${announced} test cases, exit code ${fuzzCode}`,
  );
  process.exit((await gate(suite, announced)) === 0 && fuzzCode === 0 ? 0 : 1);
}

// client suite: fuzzingserver container published on :9001, Gren app drives
// the control protocol.
const CONTAINER = "gren-autobahn-fuzzingserver";
const sh = (args) => childProc.spawnSync("docker", args, { encoding: "utf8" });
sh(["rm", "-f", CONTAINER]); // sweep leftovers from aborted runs
const docker = sh([
  "run",
  "-d",
  "--rm",
  "--name",
  CONTAINER,
  "-p",
  "9001:9001",
  "-v",
  path.join(ROOT, "config", "fuzzingserver.json") +
    ":/config/fuzzingserver.json:ro",
  ...vendorMount,
  "-v",
  path.join(ROOT, "reports") + ":/reports",
  IMAGE,
  "wstest",
  "-m",
  "fuzzingserver",
  "-s",
  "/config/fuzzingserver.json",
]);
if (docker.status !== 0) {
  console.error("docker run -d failed:", docker.stderr);
  process.exit(1);
}
let clientCode = 1;
let cases = null;
let buf = "";
try {
  // The fuzzingserver prints nothing until cases run, so readiness = the
  // published port answers an HTTP GET.
  await waitForHttp(9001, 60000);
  console.log("fuzzingserver listening on :9001");
  clientCode = await new Promise((resolve) => {
    const client = childProc.fork(
      path.resolve(ROOT, "autobahn-client-app"),
      [],
      { silent: true },
    );
    client.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/CASES=(\d+)/);
      if (m && cases === null) cases = parseInt(m[1], 10);
      process.stdout.write(d);
    });
    client.stderr.on("data", (d) => process.stderr.write(d));
    client.on("exit", resolve);
  });
} finally {
  // --rm alone does not reap a container still up when this process dies.
  sh(["rm", "-f", CONTAINER]);
}
if (cases === null) {
  console.error("autobahn-client-app never printed CASES=<n>");
  process.exit(1);
}
console.log(
  `autobahn-client-app reported CASES=${cases}, exit code ${clientCode}`,
);
if (clientCode !== 0) process.exit(clientCode);
process.exit(await gate(suite, cases));

function gate(suiteName, expectedCount) {
  const gate = childProc.spawn(
    process.execPath,
    [
      "check-reports.mjs",
      "--suite",
      suiteName,
      "--expected-count",
      String(expectedCount),
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  return new Promise((resolve) => gate.on("exit", resolve));
}

function waitFor(stream, pattern, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what}: no '${pattern}' within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onData = (d) => {
      if (d.toString().includes(pattern)) {
        clearTimeout(t);
        stream.off("data", onData);
        resolve();
      }
    };
    stream.on("data", onData);
  });
}

function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.end("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      });
      let got = "";
      const settle = (ok) => {
        sock.destroy();
        if (ok) resolve();
        else if (Date.now() > deadline)
          reject(new Error(`no HTTP on :${port} within ${timeoutMs}ms`));
        else setTimeout(attempt, 500);
      };
      sock.on("data", (d) => {
        got += d.toString();
        if (/^HTTP\//m.test(got)) settle(true);
      });
      sock.on("error", () => settle(false));
      sock.on("close", () => settle(/^HTTP\//m.test(got)));
      setTimeout(() => settle(/^HTTP\//m.test(got)), 2000);
    };
    attempt();
  });
}
