# Vendored Autobahn TestSuite (unmodified)

The WebSocket conformance tests executed by the suites in this directory
live here, byte-for-byte as published. This tree — not the copy baked into
the Docker image — is what runs: both runners bind-mount `vendor/` into the
container at `/vendor` and set `PYTHONPATH=/vendor`, which outranks the
image's `site-packages` on `sys.path` (verified: `autobahntestsuite.__file__`
resolves to `/vendor/...` and `pkg_resources.resource_filename` for the
12.x/13.x compressed testdata also resolves there). The image is then only a
Python + Twisted runtime, never a source of tests, so no image rebuild or
tampering can alter what is tested.

## Provenance

| | |
|---|---|
| Package | `autobahntestsuite` 25.10.1 (AutobahnTestSuite, typedef int GmbH, Apache-2.0) |
| Origin | PyPI wheel `autobahntestsuite-25.10.1-py2-none-any.whl` |
| Wheel URL | <https://files.pythonhosted.org/packages/1a/5f/e123d416ce8571778a19483c8bf37f38aa34b04d4d43b4ef308fa016b8df/autobahntestsuite-25.10.1-py2-none-any.whl> |
| Wheel sha256 | `b57ee6b22de624a03256878ad453c9897d2ad7ee08a4c38b35ee2847637e1383` (matches the digest in the PyPI JSON API) |
| Downloaded | 2026-10-15 |
| Extracted from | the wheel, then re-verified: all 199 RECORD hashes re-computed and matched (195 package files + 4 dist-info files) |
| Cross-checked against | `crossbario/autobahn-testsuite@sha256:519915fb568b04c9383f70a1c405ae3ff44ab9e35835b085239c258b6fac3074` — its `/opt/pypy/site-packages/autobahntestsuite` is byte-identical to this tree (recursive diff, 195/195 files) |

Contents: 195 files — the case implementations (`autobahntestsuite/case/`),
the fuzzing drivers (`fuzzing.py`), the report templates, and `testdata/`
(the compressed payloads for 10.1.1 / 12.x / 13.x). `*.pyc` files from the
wheel were dropped (the container's PyPy recompiles from source; RECORD
lists them without hashes and `verify-vendor.mjs` treats them as optional).

## Integrity gate

`node verify-vendor.mjs` re-hashes every file here against the wheel's
RECORD and fails on any mismatch, missing file, or extra file. The Makefile
runs it before either suite, so a suite result is only ever produced from
this exact bytes-on-disk suite.

## Refreshing

Re-download the wheel from the URL above, verify the sha256, extract with
`unzip`, replace `autobahntestsuite/`, and update the version/date/sha in
this README and in the image digest pin in `../server-suite-runner.mjs` /
`../run-client-suite.mjs` if the suite version moves.

## History

This tree replaces an earlier arrangement where the suites ran the test
code shipped inside the Docker image and the repo carried only the
fuzzingclient/fuzzingserver configs — configs that had been edited twice
during development (case exclusions added, then removed with the
`permessage-deflate` implementation). The test _code_ itself was never in
the repo and was verified (recursive diff, 2026-10-15) to have been
byte-identical to this same 25.10.1 wheel the whole time. Vendoring it
makes that guarantee durable and reviewable: `git log` on this directory
now shows the exact bytes of every test that has ever run against Gren.
