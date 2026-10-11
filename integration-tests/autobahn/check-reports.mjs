#!/usr/bin/env node
// Gate on the Autobahn TestSuite reports (plain node, no npm deps).
//
// Usage: node check-reports.mjs [--suite server|client] [--reports DIR]
//            [--expected-count N] [--config FILE]
//
// Parses reports/index.json in the classic master-report format produced by
// createMasterReportJSON: { "<agent>": { "<caseId>": { "behavior",
// "behaviorClose", "duration", "reportfile" } } }. See plan §6.4.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function flag(name, dflt) {
  const i = args.indexOf("--" + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}

const suite = flag("suite", "server");
const reportsDir = path.resolve(
  import.meta.dirname,
  flag(
    "reports",
    path.join("reports", suite === "server" ? "server" : "client"),
  ),
);
const expectedCount = flag("expected-count", null);
const configFile = flag(
  "config",
  path.join(
    import.meta.dirname,
    "config",
    `fuzzing${suite === "server" ? "client" : "server"}.json`,
  ),
);

const FAIL_BEHAVIOR = new Set(["FAILED", "UNIMPLEMENTED", "NON-STRICT"]);
const FAIL_CLOSE = new Set(["WRONG CODE", "UNCLEAN", "FAILED BY CLIENT"]);
const OK_BEHAVIOR = new Set(["OK", "INFORMATIONAL"]);

// glob-ish exclusion patterns from the config ("9.*" -> /^\d+\.\d+$/ style).
function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function categoryOf(caseId) {
  const m = /^(\d+)\./.exec(caseId);
  return m ? m[1] + ".x" : "?";
}

function fmtSecs(ms) {
  return (ms / 1000).toFixed(1) + "s";
}

let raw;
try {
  raw = readFileSync(path.join(reportsDir, "index.json"), "utf8");
} catch (e) {
  console.error(
    `check-reports: cannot read ${path.join(reportsDir, "index.json")}: ${e.message}`,
  );
  process.exit(1);
}

let master;
try {
  master = JSON.parse(raw);
} catch (e) {
  console.error(`check-reports: index.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

// The classic index.json maps agent -> caseId -> verdict. Some images emit a
// {"created":..., "agents": {...}} wrapper instead; unwrap if present.
const agents =
  master.agents && typeof master.agents === "object" ? master.agents : master;

let config = { "exclude-cases": [] };
if (existsSync(configFile)) {
  try {
    config = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    /* config unreadable: fall back to empty exclusion list */
  }
}
const excludes = (config["exclude-cases"] || []).map(patternToRegex);

const violations = [];
const notes = [];
const byCategory = new Map();
let executed = 0;

// Exclusions (plan §6.5): exclude-cases patterns skip cases entirely (they
// do not count toward the executed total; the fuzzer never ran them).
//
// Honesty list (plan §6.5): NON-STRICT results that are stock-ws-equivalent
// deviate from the strict posture and are documented here, not silenced:
// each case id maps to the evidence for the deviation. A case matching this
// list whose verdict is anything OTHER than NON-STRICT (OK/FAILED/close
// problem) still fails the gate — the entry waives exactly the observed
// deviation, nothing more.
const EXPECTED_NON_STRICT = {
  // 6.4.3/6.4.4: invalid UTF-8 delivered as multiple chops of ONE text
  // frame. The fuzzer's expectation demands the validator reject on the
  // chop where invalidity completes, but the frame is not FIN-terminated
  // when the chop arrives; no incremental validator (ours nor ws's
  // utf-8-validate) can decide before FIN, so both answer Close(1007)
  // ~2000 ms late (after the robot's 2 s inter-chop timer closes the
  // case). Evidence: stock ws driver, same image — server mode 6.4.1-4
  // all NON-STRICT d=2011-2015 ms (/tmp/p5-ws-baseline), client mode
  // 6.4.3/6.4.4 NON-STRICT d=2014-2015 ms; Gren 6.4.3/6.4.4 NON-STRICT
  // d=2009-2015 ms in both suites (6.4.1/6.4.2 are OK for Gren, stricter
  // than ws there).
  "6.4.3": "late 1007 on chop-split invalid UTF-8: ws-equivalent (see comment)",
  "6.4.4": "late 1007 on chop-split invalid UTF-8: ws-equivalent (see comment)",
};
let excludedCount = 0;
for (const [agent, cases] of Object.entries(agents)) {
  if (!cases || typeof cases !== "object") continue;
  for (const caseId of Object.keys(cases)) {
    if (excludes.some((re) => re.test(caseId))) excludedCount += 1;
  }
}
for (const [agent, cases] of Object.entries(agents)) {
  if (!cases || typeof cases !== "object") continue;
  for (const [caseId, verdict] of Object.entries(cases)) {
    if (typeof verdict !== "object" || verdict === null) continue; // skip metadata keys
    if (excludes.some((re) => re.test(caseId))) continue; // excluded: never executed
    executed += 1;
    const behavior = verdict.behavior ?? "MISSING";
    const behaviorClose = verdict.behaviorClose ?? "MISSING";
    const cat = categoryOf(caseId);
    if (!byCategory.has(cat))
      byCategory.set(cat, { ok: 0, info: 0, fail: 0, excluded: 0 });
    const row = byCategory.get(cat);

    if (
      behavior === "NON-STRICT" &&
      behaviorClose === "OK" &&
      Object.prototype.hasOwnProperty.call(EXPECTED_NON_STRICT, caseId)
    ) {
      row.ok += 1;
      notes.push(
        `${agent} case ${caseId}: NON-STRICT waived (honesty list §6.5)`,
      );
      continue;
    }

    const bad = [];
    if (!OK_BEHAVIOR.has(behavior)) bad.push(`behavior ${behavior}`);
    if (behaviorClose !== "OK" && behavior !== "INFORMATIONAL") {
      if (FAIL_CLOSE.has(behaviorClose))
        bad.push(`behaviorClose ${behaviorClose}`);
    }
    if (bad.length) {
      row.fail += 1;
      violations.push(
        `${agent} case ${caseId}: ${bad.join(", ")} (${verdict.reportfile ?? "no report"})`,
      );
    } else if (behavior === "INFORMATIONAL") {
      row.info += 1;
      notes.push(`${agent} case ${caseId}: INFORMATIONAL`);
    } else {
      row.ok += 1;
    }
  }
}

for (const pat of config["exclude-cases"] || []) {
  notes.push(`excluded by config: ${pat}`);
}
if (excludedCount > 0) {
  notes.push(`${excludedCount} reported cases skipped by exclusion patterns`);
}

// Anti-silent-skip: the suite must have executed SOMETHING (an empty or
// truncated index.json parses cleanly and would otherwise pass vacuously),
// and with --expected-count (client suite: N from getCaseCount) the
// executed count must equal N exactly.
if (executed === 0) {
  violations.push(
    "no cases executed (index.json empty or fully excluded/truncated)",
  );
}
if (expectedCount !== null) {
  const n = Number(expectedCount);
  if (executed !== n) {
    violations.push(
      `executed case count ${executed} != getCaseCount N=${n} (silent skip?)`,
    );
  }
}

const cats = [...byCategory.keys()].sort((a, b) => parseInt(a) - parseInt(b));
console.log(`\nAutobahn ${suite}-suite report gate (${reportsDir})`);
console.log("category |  OK  | INFO | FAIL");
console.log("---------|------|------|-----");
for (const cat of cats) {
  const r = byCategory.get(cat);
  console.log(
    `${cat.padEnd(8)} | ${String(r.ok).padStart(4)}  | ${String(r.info).padStart(4)} | ${String(r.fail).padStart(4)}`,
  );
}
console.log(`---------|------|------|-----`);
console.log(`total: ${executed} executed`);
for (const note of notes) console.log(`  - ${note}`);
if (violations.length) {
  console.log(`\nVIOLATIONS (${violations.length}):`);
  for (const v of violations) console.log(`  ! ${v}`);
  console.log(`\nDetails: ${path.join(reportsDir, "index.html")}`);
  process.exit(1);
}
console.log("\nAll executed cases OK or INFORMATIONAL — gate PASSED");
