// Boots the fuzzingserver container (published on 9001), waits for its
// listening log line, forks autobahn-client-app, collects its exit code and
// the N it reported on stdout ("CASES=<n>"), stops the container, then runs
// check-reports.mjs with the anti-silent-skip expected count. See Makefile
// target autobahn-client-suite and plan §6.3.
import * as path from "node:path";
import * as childProc from "node:child_process";

const ROOT = import.meta.dirname;
const CONTAINER = "gren-autobahn-fuzzingserver";

function sh(cmd, args) {
  return childProc.spawnSync(cmd, args, { encoding: "utf8" });
}

sh("docker", ["rm", "-f", CONTAINER]); // sweep leftovers from aborted runs

const docker = childProc.spawn(
  "docker",
  [
    "run",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    "9001:9001",
    "-v",
    path.join(ROOT, "config", "fuzzingserver.json") +
      ":/config/fuzzingserver.json:ro",
    "-v",
    path.join(ROOT, "vendor") + ":/vendor:ro",
    "-e",
    "PYTHONPATH=/vendor",
    "-v",
    path.join(ROOT, "reports") + ":/reports",
    // Runtime only (Python + Twisted): the tests come from vendor/, which
    // PYTHONPATH=/vendor puts ahead of the image's site-packages. Digest-pinned
    // so the runtime is reproducible too; provenance in vendor/README.md.
    "crossbario/autobahn-testsuite@sha256:519915fb568b04c9383f70a1c405ae3ff44ab9e35835b085239c258b6fac3074",
    "wstest",
    "-m",
    "fuzzingserver",
    "-s",
    "/config/fuzzingserver.json",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let dockerExited = false;
docker.on("exit", (code) => {
  dockerExited = true;
  if (code !== 0) console.error(`docker run exited ${code}`);
});

async function waitForListening(timeoutMs = 60000) {
  // The classic image's fuzzingserver prints nothing until cases run, so
  // probe the published port: it accepts TCP and answers a plain HTTP GET
  // (200) once the control endpoint is up.
  const deadline = Date.now() + timeoutMs;
  const net = await import("node:net");
  for (;;) {
    if (dockerExited) throw new Error("fuzzingserver container exited early");
    const ready = await new Promise((resolve) => {
      const sock = net.connect(9001, "127.0.0.1", () => {
        sock.end("GET / HTTP/1.1\r\nHost: 127.0.0.1:9001\r\n\r\n");
      });
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        if (/^HTTP\//m.test(buf)) {
          sock.destroy();
          resolve(true);
        }
      });
      sock.on("error", () => resolve(false));
      sock.on("close", () => resolve(buf.length > 0 && /^HTTP\//m.test(buf)));
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 2000);
    });
    if (ready) {
      console.log("fuzzingserver listening on :9001");
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        "fuzzingserver did not become ready on 9001 within " + timeoutMs + "ms",
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

let cases = null;
let clientCode = null;
try {
  await waitForListening();

  let stdoutBuf = "";
  clientCode = await new Promise((resolve) => {
    const client = childProc.fork(
      path.resolve(ROOT, "autobahn-client-app"),
      [],
      { silent: true },
    );
    client.stdout.on("data", (data) => {
      stdoutBuf += data.toString();
      const m = stdoutBuf.match(/CASES=(\d+)/);
      if (m && cases === null) cases = parseInt(m[1], 10);
      process.stdout.write(data);
    });
    client.stderr.on("data", (data) => process.stderr.write(data));
    client.on("exit", resolve);
  });
} finally {
  // Run on every exit path, including a readiness-probe throw: --rm alone
  // does not reap a container that is still up when this process dies.
  sh("docker", ["rm", "-f", CONTAINER]);
  while (!dockerExited) await new Promise((r) => setTimeout(r, 100));
}

if (cases === null) {
  console.error("autobahn-client-app never printed CASES=<n>");
  process.exit(1);
}
console.log(
  `autobahn-client-app reported CASES=${cases}, exit code ${clientCode}`,
);
if (clientCode !== 0) process.exit(clientCode);

const gateArgs = [
  "check-reports.mjs",
  "--suite",
  "client",
  "--expected-count",
  String(cases),
];
const gate = childProc.spawn(process.execPath, gateArgs, {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(await new Promise((resolve) => gate.on("exit", resolve)));
