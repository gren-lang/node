#!/usr/bin/env node
// Gate on an Autobahn master report (plain node, no npm deps).
//
//   node check-reports.mjs --suite server|client --expected-count N
//
// Parses reports/<suite>/index.json ({ agent: { caseId: { behavior,
// behaviorClose, ... } } }) and fails on any case that is not OK or
// INFORMATIONAL, on empty/truncated runs, and on a count mismatch against N
// (the announcement from run-suite.mjs). Exit 0 + summary, exit 1 + list.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};

const suite = flag("suite", "server");
const reportsDir = path.resolve(
  import.meta.dirname,
  "reports",
  suite === "server" ? "server" : "client",
);
const expectedCount = flag("expected-count", null);
const configFile = path.join(
  import.meta.dirname,
  "config",
  `fuzzing${suite === "server" ? "client" : "server"}.json`,
);

const OK_BEHAVIOR = new Set(["OK", "INFORMATIONAL"]);
const FAIL_CLOSE = new Set(["WRONG CODE", "UNCLEAN", "FAILED BY CLIENT"]);

// NON-STRICT verdicts tolerated with evidence ("honesty list" — each entry
// waives exactly the documented deviation; any OTHER verdict on that case
// still fails the gate). 6.4.3/6.4.4: invalid UTF-8 delivered as multiple
// chops of one non-FIN text frame cannot be rejected before FIN by any
// incremental validator, so Close(1007) lands after the robot's 2 s timer;
// stock ws on the same image reports the same NON-STRICT (~2 s latency) in
// both suites.
const EXPECTED_NON_STRICT = {
  "6.4.3": "late 1007 on chop-split invalid UTF-8: ws-equivalent",
  "6.4.4": "late 1007 on chop-split invalid UTF-8: ws-equivalent",
};

// exclude-cases patterns from the config skip cases entirely (never
// executed, never counted).
const patternToRegex = (p) =>
  new RegExp(
    "^" +
      p
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
let config = { "exclude-cases": [] };
if (existsSync(configFile)) {
  try {
    config = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {}
}
const excludes = (config["exclude-cases"] || []).map(patternToRegex);

const raw = (() => {
  try {
    return readFileSync(path.join(reportsDir, "index.json"), "utf8");
  } catch (e) {
    console.error(
      `cannot read ${path.join(reportsDir, "index.json")}: ${e.message}`,
    );
    process.exit(1);
  }
})();
let master;
try {
  master = JSON.parse(raw);
} catch (e) {
  console.error(`cannot parse index.json: ${e.message}`);
  process.exit(1);
}
// Some images wrap in {"created":..., "agents": {...}}; unwrap if present.
const agents =
  master.agents && typeof master.agents === "object" ? master.agents : master;

const violations = [];
const notes = [];
const byCategory = new Map();
let executed = 0;

for (const [agent, cases] of Object.entries(agents)) {
  if (!cases || typeof cases !== "object") continue;
  for (const [caseId, verdict] of Object.entries(cases)) {
    if (typeof verdict !== "object" || verdict === null) continue; // metadata key
    if (excludes.some((re) => re.test(caseId))) continue; // never executed
    executed += 1;
    const cat = caseId.split(".")[0];
    if (!byCategory.has(cat)) byCategory.set(cat, { ok: 0, info: 0, fail: 0 });
    const row = byCategory.get(cat);
    const behavior = verdict.behavior ?? "MISSING";
    const behaviorClose = verdict.behaviorClose ?? "MISSING";

    if (Object.hasOwn(EXPECTED_NON_STRICT, caseId)) {
      // The entry waives exactly the documented deviation: this case MUST
      // be NON-STRICT/OK. Any other verdict is drift and fails the gate.
      if (behavior === "NON-STRICT" && behaviorClose === "OK") {
        row.ok += 1;
        notes.push(
          `${agent} case ${caseId}: NON-STRICT waived (${EXPECTED_NON_STRICT[caseId]})`,
        );
      } else {
        row.fail += 1;
        violations.push(
          `${agent} case ${caseId}: expected NON-STRICT (honesty list), got behavior ${behavior}, behaviorClose ${behaviorClose} (${verdict.reportfile ?? "no report"})`,
        );
      }
      continue;
    }
    const bad = [];
    if (!OK_BEHAVIOR.has(behavior)) bad.push(`behavior ${behavior}`);
    if (
      behaviorClose !== "OK" &&
      behavior !== "INFORMATIONAL" &&
      FAIL_CLOSE.has(behaviorClose)
    ) {
      bad.push(`behaviorClose ${behaviorClose}`);
    }
    if (bad.length) {
      row.fail += 1;
      violations.push(
        `${agent} case ${caseId}: ${bad.join(", ")} (${verdict.reportfile ?? "no report"})`,
      );
    } else if (behavior === "INFORMATIONAL") {
      row.info += 1;
    } else {
      row.ok += 1;
    }
  }
}

// Anti-silent-skip: a clean run executed N cases; an empty or truncated
// index.json must never pass vacuously.
if (executed === 0)
  violations.push("no cases executed (index.json empty or fully excluded)");
if (expectedCount === null)
  violations.push("expected case count not supplied (silent skip?)");
else if (executed !== Number(expectedCount))
  violations.push(
    `executed case count ${executed} != expected N=${expectedCount} (silent skip?)`,
  );

console.log(`\nAutobahn ${suite}-suite report gate (${reportsDir})`);
console.log("category |  OK  | INFO | FAIL");
console.log("---------|------|------|-----");
for (const cat of [...byCategory.keys()].sort(
  (a, b) => parseInt(a) - parseInt(b),
)) {
  const r = byCategory.get(cat);
  console.log(
    `${cat.padEnd(8)} | ${String(r.ok).padStart(4)}  | ${String(r.info).padStart(4)} | ${String(r.fail).padStart(4)}`,
  );
}
console.log("---------|------|------|-----");
console.log(
  `total: ${executed} executed, expected: ${expectedCount ?? "NOT ENFORCED"}`,
);
for (const note of notes) console.log(`  - ${note}`);
if (violations.length) {
  console.log(`\nVIOLATIONS (${violations.length}):`);
  for (const v of violations) console.log(`  ! ${v}`);
  process.exit(1);
}
console.log("\nAll executed cases OK or INFORMATIONAL — gate PASSED");
