#!/usr/bin/env node
// Durable non-vacuity instrument for the server-suite completeness gate
// (spec §2.4/§3). Plain node, no npm deps, no docker: it drives
// server-suite-runner.mjs and check-reports.mjs inside a throwaway temp dir
// with a PATH-shadowing `docker` stub, so truncated / announcement-less /
// failing reports can be gated without touching the repo's reports/.
//
// Pre-fix the hole must reproduce (a synthetic 300-case report passes the
// gate); post-fix the very same controls must fail. Identical controls,
// opposite verdicts: that is the non-vacuity proof for the §2 fix.
//
// Usage: node gate-selftest.mjs --expect=pre-fix|post-fix
//
//   control                                      pre-fix  post-fix
//   C1 truncated 300 + announce 517                  0     !=0, 1 violation (count)
//   C2 complete  517 + announce 517                  0     0 (gate PASSED)
//   C3 complete  517, no announcement                0     !=0 (runner, else gate)
//   C4 complete  517 with 9.1.1 FAILED              !=0    !=0 (verdict still fails)
//   C5 gate --suite server, no count                 0     !=0 (not supplied)
//   C6 gate --suite server --expected-count 517      0     0
//
// Exit 0 iff every observed exit code (and, post-fix, every marker) matches
// the expectation for the requested mode.

import * as childProc from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = import.meta.dirname;
const PORT = 9009;
const EXPECTED_CASES = 517;
const TRUNCATED_CASES = 300;
const ANNOUNCE = `Ok, will run ${EXPECTED_CASES} test cases against 1 servers`;
const CONTROL_TIMEOUT_MS = 120000;
const PORT_WAIT_MS = 10000;
const OUTPUT_LINE_CAP = 400;
const COPIED = [
  "autobahn-server-app",
  "server-suite-runner.mjs",
  "check-reports.mjs",
  path.join("config", "fuzzingclient.json"),
];

const expectArg = process.argv.slice(2).find((a) => a.startsWith("--expect="));
const expectMode = expectArg ? expectArg.slice("--expect=".length) : null;
if (expectMode !== "pre-fix" && expectMode !== "post-fix") {
  console.error("usage: node gate-selftest.mjs --expect=pre-fix|post-fix");
  process.exit(2);
}

function log(line = "") {
  process.stdout.write(line + "\n");
}

function abort(msg) {
  console.error(`gate-selftest: ${msg}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- fixtures --

function agentsOf(master) {
  return master.agents && typeof master.agents === "object"
    ? master.agents
    : master;
}

// The gate's own counting rule (check-reports.mjs:112-118): per-agent
// object-valued case entries; non-object values are metadata, skipped.
function countCases(master) {
  let n = 0;
  for (const cases of Object.values(agentsOf(master))) {
    if (!cases || typeof cases !== "object") continue;
    for (const verdict of Object.values(cases)) {
      if (typeof verdict === "object" && verdict !== null) n += 1;
    }
  }
  return n;
}

function loadFixtureSource() {
  const src = path.join(ROOT, "reports", "server", "index.json");
  if (!fs.existsSync(src)) {
    abort(
      `fixture source ${src} is missing; run the server suite once ` +
        "(make autobahn-server-suite) or restore the report first",
    );
  }
  let master;
  try {
    master = JSON.parse(fs.readFileSync(src, "utf8"));
  } catch (e) {
    abort(`fixture source ${src} is not valid JSON: ${e.message}`);
  }
  if (master === null || typeof master !== "object") {
    abort(`fixture source ${src} is not a JSON object`);
  }
  const n = countCases(master);
  if (n !== EXPECTED_CASES) {
    abort(
      `fixture source ${src} holds ${n} case entries, expected exactly ` +
        `${EXPECTED_CASES} counted the way check-reports.mjs counts them ` +
        "- refusing to run vacuously",
    );
  }
  return master;
}

// The first 300 case entries, verdicts forced OK so no waiver or
// INFORMATIONAL note can mask the completeness comparison.
function truncateFixture(master) {
  const out = {};
  let kept = 0;
  for (const [agent, cases] of Object.entries(agentsOf(master))) {
    if (kept >= TRUNCATED_CASES) break;
    if (!cases || typeof cases !== "object") continue;
    for (const [caseId, verdict] of Object.entries(cases)) {
      if (kept >= TRUNCATED_CASES) break;
      if (typeof verdict !== "object" || verdict === null) continue;
      if (!out[agent]) out[agent] = {};
      out[agent][caseId] = { ...verdict, behavior: "OK", behaviorClose: "OK" };
      kept += 1;
    }
  }
  return out;
}

function failedFixture(master) {
  const clone = JSON.parse(JSON.stringify(master));
  let hit = 0;
  for (const cases of Object.values(agentsOf(clone))) {
    if (!cases || typeof cases !== "object") continue;
    const verdict = cases["9.1.1"];
    if (verdict && typeof verdict === "object") {
      verdict.behavior = "FAILED";
      hit += 1;
    }
  }
  if (hit !== 1) {
    abort(`fixture source holds ${hit} entries for case 9.1.1, expected 1`);
  }
  return clone;
}

function assertAllOk(master) {
  for (const cases of Object.values(agentsOf(master))) {
    for (const verdict of Object.values(cases)) {
      if (typeof verdict !== "object" || verdict === null) continue;
      if (verdict.behavior !== "OK" || verdict.behaviorClose !== "OK") {
        abort("truncated fixture carries a non-OK verdict");
      }
    }
  }
}

// ------------------------------------------------------------------- stub --

const STUB_SOURCE = `#!/bin/sh
# docker stub for gate-selftest.mjs: starts no container and exits 0 in every
# mode. AUTOBAHN_STUB_MODE picks the fixture copied into
# reports/server/index.json (paths are relative to cwd, the harness temp dir)
# and whether the fuzzingclient announcement is printed on stdout.
case "$AUTOBAHN_STUB_MODE" in
  truncated-announce)
    cp fixtures/truncated.json reports/server/index.json
    echo '${ANNOUNCE}'
    ;;
  complete-announce)
    cp fixtures/complete.json reports/server/index.json
    echo '${ANNOUNCE}'
    ;;
  complete-noannounce)
    cp fixtures/complete.json reports/server/index.json
    ;;
  failed-announce)
    cp fixtures/failed.json reports/server/index.json
    echo '${ANNOUNCE}'
    ;;
  *)
    echo "docker stub: unknown AUTOBAHN_STUB_MODE '$AUTOBAHN_STUB_MODE'" >&2
    ;;
esac
exit 0
`;

// ------------------------------------------------------------- spawn/ports --

function runControl(command, args, env) {
  return new Promise((resolve) => {
    const child = childProc.spawn(command, args, {
      cwd: T,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: the runner forks the Gren app, and a timeout must
      // take that grandchild down too or it keeps port 9009 bound.
      detached: true,
    });
    let out = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, CONTROL_TIMEOUT_MS);
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, out, timedOut });
    };
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) =>
      done({ code: null, note: `spawn error: ${e.message}` }),
    );
    child.on("exit", (code, signal) =>
      done({ code, note: signal ? `killed by signal ${signal}` : null }),
    );
  });
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitForPortFree(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await portBusy(PORT))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

// ----------------------------------------------------------- controls/expect --

const RUNNER_CONTROLS = [
  {
    id: "C1",
    label: `runner stub: truncated ${TRUNCATED_CASES} + announce N`,
    stubMode: "truncated-announce",
  },
  {
    id: "C2",
    label: `runner stub: complete ${EXPECTED_CASES} + announce N`,
    stubMode: "complete-announce",
  },
  {
    id: "C3",
    label: `runner stub: complete ${EXPECTED_CASES}, no announcement`,
    stubMode: "complete-noannounce",
  },
  {
    id: "C4",
    label: "runner stub: complete with 9.1.1 FAILED",
    stubMode: "failed-announce",
  },
];

const GATE_CONTROLS = [
  {
    id: "C5",
    label: "gate direct: --suite server, no --expected-count",
    extraArgs: [],
  },
  {
    id: "C6",
    label: `gate direct: --suite server --expected-count ${EXPECTED_CASES}`,
    extraArgs: ["--expected-count", String(EXPECTED_CASES)],
  },
];

const EXPECTATIONS = {
  "pre-fix": {
    C1: { exit: "zero" },
    C2: { exit: "zero" },
    C3: { exit: "zero" },
    C4: { exit: "nonzero" },
    C5: { exit: "zero" },
    C6: { exit: "zero" },
  },
  "post-fix": {
    C1: {
      exit: "nonzero",
      markers: [
        /executed case count 300 != expected N=517/,
        /VIOLATIONS \(1\)/,
      ],
    },
    C2: {
      exit: "zero",
      markers: [
        /expected count: 517 \(enforced\)/,
        /total: 517 executed/,
        /gate PASSED/,
      ],
      countMarkers: [{ re: /NON-STRICT waived/g, n: 2 }],
      absentMarkers: [/excluded by config:/],
    },
    C3: {
      exit: "nonzero",
      anyOfMarkers: [
        {
          label: "runner refused: never announced",
          re: /never announced a test-case count/,
        },
        {
          label: "gate refused: not supplied for --suite server",
          re: /not supplied for --suite server/,
        },
      ],
    },
    C4: {
      exit: "nonzero",
      markers: [
        /VIOLATIONS \(\d+\):/,
        /! [^\n]*case 9\.1\.1[^\n]*behavior FAILED/,
      ],
    },
    C5: { exit: "nonzero", markers: [/not supplied for --suite server/] },
    C6: {
      exit: "zero",
      markers: [/expected count: 517 \(enforced\)/, /gate PASSED/],
    },
  },
};

function expectedExitText(control) {
  return EXPECTATIONS[expectMode][control.id].exit === "zero" ? "0" : "!=0";
}

function evaluate(control, result) {
  const exp = EXPECTATIONS[expectMode][control.id];
  if (!exp) {
    abort(`no expectation for ${control.id} in --expect=${expectMode}`);
  }
  const problems = [];
  const matched = [];
  const missing = [];
  let exitText;
  if (result.timedOut) {
    exitText = `none (SIGKILLed after ${CONTROL_TIMEOUT_MS} ms)`;
    problems.push(`timed out after ${CONTROL_TIMEOUT_MS} ms - SIGKILLed`);
  } else if (typeof result.code !== "number") {
    exitText = `none (${result.note ?? "process did not exit"})`;
    problems.push(`no exit code (${result.note ?? "process did not exit"})`);
  } else {
    exitText = String(result.code);
    if (exp.exit === "zero" && result.code !== 0) {
      problems.push(`exit ${result.code}, expected 0`);
    } else if (exp.exit === "nonzero" && result.code === 0) {
      problems.push("exit 0, expected non-zero");
    }
  }
  for (const re of exp.markers ?? []) {
    if (re.test(result.out)) matched.push(re.source);
    else missing.push(re.source);
  }
  const anyOf = exp.anyOfMarkers ?? [];
  for (const m of anyOf) {
    if (m.re.test(result.out)) matched.push(`any-of(${m.label})`);
    else missing.push(`any-of(${m.label})`);
  }
  if (anyOf.length && matched.every((m) => !m.startsWith("any-of("))) {
    problems.push("neither accepted diagnostic was printed");
  }
  for (const m of exp.countMarkers ?? []) {
    const key = `${m.re.source} x${m.n}`;
    const seen = (result.out.match(m.re) ?? []).length;
    if (seen === m.n) matched.push(key);
    else {
      missing.push(key);
      problems.push(
        `expected ${m.n} lines matching ${m.re.source}, saw ${seen}`,
      );
    }
  }
  for (const re of exp.absentMarkers ?? []) {
    if (re.test(result.out)) problems.push(`unexpected output: ${re.source}`);
  }
  return {
    id: control.id,
    label: control.label,
    exitText,
    expectedExitText: expectedExitText(control),
    matched,
    missing,
    problems,
    ok: problems.length === 0,
    out: result.out,
  };
}

function skippedResult(control, note) {
  return {
    id: control.id,
    label: control.label,
    exitText: "not run",
    expectedExitText: expectedExitText(control),
    matched: [],
    missing: [],
    problems: [note],
    ok: false,
    out: "",
  };
}

function startControl(control) {
  log("");
  log(`=== ${control.id} [${new Date().toISOString()}] ${control.label} ===`);
}

function showControl(control, result) {
  const verdict = evaluate(control, result);
  log(`observed exit code: ${verdict.exitText}`);
  if (verdict.matched.length) {
    log(`matched markers: ${verdict.matched.join(" | ")}`);
  }
  if (verdict.missing.length) {
    log(`missing markers: ${verdict.missing.join(" | ")}`);
  }
  for (const p of verdict.problems) log(`problem: ${p}`);
  log(`verdict: ${verdict.ok ? "PASS" : "FAIL"}`);
  const lines = result.out.split("\n");
  log(`captured output (${lines.length} lines):`);
  for (const line of lines.slice(0, OUTPUT_LINE_CAP)) log("    " + line);
  if (lines.length > OUTPUT_LINE_CAP) {
    log(
      `    ... ${lines.length - OUTPUT_LINE_CAP} more lines omitted ` +
        `(cap ${OUTPUT_LINE_CAP})`,
    );
  }
  results.push(verdict);
}

// -------------------------------------------------------------------- main --

log(`gate-selftest: mode --expect=${expectMode}`);
log(`utc: ${new Date().toISOString()}`);
log(`node: ${process.version} (${process.execPath})`);
log(`harness dir: ${ROOT}`);

for (const rel of COPIED) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
    abort(`precondition failed: ${p} is missing or empty`);
  }
}
const source = loadFixtureSource();
log(
  "precondition: fixture source reports/server/index.json has " +
    `${countCases(source)} case entries (gate counting rule)`,
);

const T = fs.mkdtempSync(path.join(os.tmpdir(), "gate-selftest-"));
log(`temp dir: ${T}`);

for (const rel of COPIED) {
  const dest = path.join(T, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}

const fixturesDir = path.join(T, "fixtures");
fs.mkdirSync(fixturesDir, { recursive: true });
fs.copyFileSync(
  path.join(ROOT, "reports", "server", "index.json"),
  path.join(fixturesDir, "complete.json"),
);
const truncated = truncateFixture(source);
const failed = failedFixture(source);
assertAllOk(truncated);
const truncatedCount = countCases(truncated);
const failedCount = countCases(failed);
if (truncatedCount !== TRUNCATED_CASES) {
  abort(`truncated fixture holds ${truncatedCount} case entries`);
}
if (failedCount !== EXPECTED_CASES) {
  abort(`failed fixture holds ${failedCount} case entries`);
}
fs.writeFileSync(
  path.join(fixturesDir, "truncated.json"),
  JSON.stringify(truncated),
);
fs.writeFileSync(path.join(fixturesDir, "failed.json"), JSON.stringify(failed));
fs.mkdirSync(path.join(T, "reports", "server"), { recursive: true });
log(
  "fixtures: complete.json (verbatim report), truncated.json " +
    `(${truncatedCount} entries, verdicts forced OK), failed.json ` +
    `(${failedCount} entries, 9.1.1 FAILED)`,
);

const stubBin = path.join(T, "stub-bin");
fs.mkdirSync(stubBin, { recursive: true });
const stubPath = path.join(stubBin, "docker");
fs.writeFileSync(stubPath, STUB_SOURCE);
fs.chmodSync(stubPath, 0o755);
log(`docker stub: ${stubPath} (PATH-shadowing, exits 0 in every mode)`);

if (await portBusy(PORT)) {
  abort(
    `port ${PORT} is busy before C1 - a stale autobahn-server-app or a ` +
      "concurrent suite run holds it; stop it and re-run",
  );
}
log(`precondition: port ${PORT} free before the first control: yes`);

const results = [];
let ranRunnerControl = false;

for (const control of RUNNER_CONTROLS) {
  if (ranRunnerControl && !(await waitForPortFree(PORT_WAIT_MS))) {
    const note =
      `port ${PORT} still busy ${PORT_WAIT_MS} ms after the previous ` +
      "control; skipped";
    startControl(control);
    log(`problem: ${note}`);
    log("verdict: FAIL");
    results.push(skippedResult(control, note));
    continue;
  }
  ranRunnerControl = true;
  const env = {
    ...process.env,
    PATH: stubBin + path.delimiter + (process.env.PATH ?? ""),
    AUTOBAHN_STUB_MODE: control.stubMode,
  };
  startControl(control);
  log(
    `cmd: node server-suite-runner.mjs (cwd=${T}, PATH=${stubBin}:$PATH, ` +
      `AUTOBAHN_STUB_MODE=${control.stubMode})`,
  );
  showControl(
    control,
    await runControl(process.execPath, ["server-suite-runner.mjs"], env),
  );
}

// The gate controls run against the complete fixture, not the stub's last
// write (C4 left the failing report in T/reports/server).
const reportsDir = path.join(T, "reports", "server");
fs.copyFileSync(
  path.join(fixturesDir, "complete.json"),
  path.join(reportsDir, "index.json"),
);
for (const control of GATE_CONTROLS) {
  const args = [
    "check-reports.mjs",
    "--suite",
    "server",
    "--reports",
    reportsDir,
    ...control.extraArgs,
  ];
  startControl(control);
  log(`cmd: node ${args.join(" ")} (cwd=${T})`);
  showControl(control, await runControl(process.execPath, args, process.env));
}

const scenarioWidth = Math.max(
  "scenario".length,
  ...results.map((r) => r.label.length),
);
function markerCell(r) {
  const total = r.matched.length + r.missing.length;
  return total === 0 ? "n/a" : `${r.matched.length}/${total} matched`;
}
log("");
log(`--- expectation table (--expect=${expectMode}) ---`);
log(
  [
    "id".padEnd(3),
    "scenario".padEnd(scenarioWidth),
    "exit".padEnd(8),
    "expected".padEnd(8),
    "markers".padEnd(13),
    "result",
  ].join(" | "),
);
for (const r of results) {
  log(
    [
      r.id.padEnd(3),
      r.label.padEnd(scenarioWidth),
      r.exitText.padEnd(8),
      r.expectedExitText.padEnd(8),
      markerCell(r).padEnd(13),
      r.ok ? "PASS" : "FAIL",
    ].join(" | "),
  );
}
const failedControls = results.filter((r) => !r.ok);
for (const r of failedControls) {
  log(`  ! ${r.id}: ${r.problems.join("; ")}`);
}
log(
  `RESULT: ${results.length - failedControls.length}/${results.length} ` +
    `controls matched --expect=${expectMode}`,
);

if (failedControls.length === 0) {
  fs.rmSync(T, { recursive: true, force: true });
  log(`temp dir removed: ${T}`);
  process.exit(0);
}
log(`temp dir kept for inspection: ${T}`);
process.exit(1);
