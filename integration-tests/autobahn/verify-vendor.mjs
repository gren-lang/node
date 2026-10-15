// Re-hashes every file in vendor/autobahntestsuite against the sha256
// digests recorded in vendor/autobahntestsuite-25.10.1.dist-info/RECORD
// (the wheel manifest shipped inside the PyPI wheel). The wheel itself is
// pinned by sha256 in vendor/README.md; RECORD is the chain from that pin
// down to each test file, so this script is what makes "the tests in this
// repo are unmodified" mechanically checkable on every suite run.
//
// Rules:
//  - every RECORD entry WITH a hash must exist in vendor/ and match;
//  - every file present under vendor/autobahntestsuite must be listed in
//    RECORD (hash or not) - an unlisted file is a planted or edited test;
//  - RECORD entries WITHOUT a hash (.pyc, generated at install time on the
//    wheel's target interpreter) are not required to exist here.
//
// Exit 0 + summary line on success; exit 1 + one line per discrepancy.
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const ROOT = import.meta.dirname;
const VENDOR = path.join(ROOT, "vendor");
const RECORD = path.join(
  VENDOR,
  "autobahntestsuite-25.10.1.dist-info",
  "RECORD",
);

function fail(msg) {
  console.error(`verify-vendor: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(RECORD)) fail(`${RECORD} is missing`);

const entries = new Map(); // packagePath -> {algo, val} | null (unhashed)
for (const line of fs.readFileSync(RECORD, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [p, hash] = line.split(",");
  if (!p.startsWith("autobahntestsuite/")) continue;
  if (!hash) {
    entries.set(p, null);
    continue;
  }
  const [algo, val] = hash.split("=");
  entries.set(p, { algo: algo.toLowerCase(), val });
}

function walk(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

const present = walk(path.join(VENDOR, "autobahntestsuite"));
const problems = [];
let checked = 0;

for (const rel of present) {
  const pkgPath = `autobahntestsuite/${rel}`;
  if (!entries.has(pkgPath)) {
    problems.push(`unlisted file (not in RECORD): ${pkgPath}`);
    continue;
  }
  const entry = entries.get(pkgPath);
  if (entry === null) continue;
  const data = fs.readFileSync(path.join(VENDOR, pkgPath));
  const got = crypto
    .createHash("sha256")
    .update(data)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  if (got !== entry.val) problems.push(`hash mismatch: ${pkgPath}`);
  checked += 1;
}

for (const [pkgPath, entry] of entries) {
  if (entry === null) continue;
  if (!fs.existsSync(path.join(VENDOR, pkgPath))) {
    problems.push(`missing file required by RECORD: ${pkgPath}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`verify-vendor: ${p}`);
  console.error(
    `verify-vendor: ${problems.length} discrepancy(ies) - the vendored ` +
      "Autobahn TestSuite is NOT pristine; restore it from the pinned wheel " +
      "(see vendor/README.md) before trusting any suite result",
  );
  process.exit(1);
}

console.log(
  `verify-vendor: ${checked} hashed files verified against RECORD; ` +
    `${present.length} files present, none extra`,
);
