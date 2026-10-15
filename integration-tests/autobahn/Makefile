# Autobahn TestSuite integration — run the WebSocket fuzzer against Gren.
#
# Tests: the canonical Autobahn TestSuite (517 cases, 1.1.1..13.7.18) under
# vendor/, byte-for-byte the PyPI wheel autobahntestsuite-25.10.1 (chain of
# provenance in vendor/README.md). vendor-check re-hashes every file against
# the wheel RECORD before each suite, and the runners bind-mount vendor/ at
# /vendor with PYTHONPATH ahead of the image's site-packages — the
# digest-pinned crossbario/autobahn-testsuite image contributes only the
# Python+Twisted runtime, never the tests. A green suite therefore always
# means "passed against unmodified upstream tests"; configs carry
# "exclude-cases": [] so nothing is skipped.
#
# Suites (both must pass; reports land in reports/{server,client}):
#   server  fuzzingclient container -> Gren echo server (src/AutobahnServer.gren)
#   client  Gren driver (src/AutobahnClient.gren) -> fuzzingserver container
# The client driver arms a per-connection 600 s hang guard (above the 480 s
# ceiling the 12.x/13.x robots impose); a healthy run never hits it.
#
# Both suites hand the executed-case count (fuzzingclient announcement /
# /getCaseCount) to check-reports.mjs, which fails on any verdict other than
# OK/INFORMATIONAL (except the evidence-backed honesty-list entries), on an
# empty report, and on a count mismatch — wstest itself exits 0 even when
# every case FAILs, so the gate is load-bearing.
#
# Docker networking (run-suite.mjs): the fuzzingserver is published with
# -p 9001:9001 (identical on Linux and Docker Desktop); the fuzzingclient
# dials our server via --network host on Linux, and via
# host.docker.internal (config rewritten at run time) on Docker Desktop.

LIB_SRCS := $(shell find ../../src -type f \( -name '*.gren' -o -name '*.js' \))

.PHONY: test build vendor-check server-suite client-suite clean

test: server-suite client-suite

build: autobahn-server-app autobahn-client-app

autobahn-server-app: gren.json ../../gren.json src/AutobahnServer.gren $(LIB_SRCS)
	gren make --optimize AutobahnServer --output=autobahn-server-app

autobahn-client-app: gren.json ../../gren.json src/AutobahnClient.gren $(LIB_SRCS)
	gren make --optimize AutobahnClient --output=autobahn-client-app

.PHONY: autobahn-server-app autobahn-client-app

server-suite: autobahn-server-app vendor-check
	@mkdir -p reports/server
	@rm -f reports/server/index.* reports/server/unknownserver_case_*.json reports/server/unknownserver_case_*.html
	@node run-suite.mjs server

client-suite: autobahn-client-app vendor-check
	@mkdir -p reports/client
	@rm -f reports/client/index.* reports/client/gren_node_case_*.json reports/client/gren_node_case_*.html
	@node run-suite.mjs client

vendor-check:
	@node verify-vendor.mjs

clean:
	rm -rf .gren reports
	rm -f autobahn-server-app autobahn-client-app
