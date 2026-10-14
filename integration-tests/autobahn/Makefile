# Autobahn TestSuite integration.
#
# Exclusion policy: none. Both config/fuzzingclient.json and
# config/fuzzingserver.json carry "exclude-cases": [] and
# "exclude-agent-cases": {}, so each suite executes the image's full
# 517-case set with nothing skipped: 301 legacy cases (through 10.1.1),
# 90 cases in 12.x (limits/performance over compressed payloads) and 126
# cases in 13.x (permessage-deflate parameter variants); first id 1.1.1,
# last id 13.7.18. The 12.x/13.x categories are driven exclusively from
# compressed test data and only run in full once the library negotiates
# permessage-deflate (RFC 7692), which it now does; the older
# "permessage-deflate.*" pattern matched no case id in this image at all.
#
# Per-case fuzzer budgets: the 12.x/13.x robots size their payloads from
# MSG_SIZES in case/case12_x_x.py and arm closeAfter(WAITSECS) as a
# per-case cap; WAITSECS is 60, 60, 120, 240 s for the first four sizes
# and 480 s for the remaining fourteen, so a case can only outlive 480 s
# by hanging.
#
# Watchdog contract (src/AutobahnClient.gren): every client connection
# arms a per-connection watchdog. It is a hang guard, not a case-length
# budget, and must stay above the 480 s per-case cap: it ships at
# 600000 ms (1.25 x 480 s). On expiry it logs 'TIMEOUT in phase token <t>'
# and exits with code 1, aborting the whole client run - so it is a
# liveness assertion and a healthy full run never hits it.
# AutobahnServer.gren has no watchdog; the server suite is driven entirely
# by the fuzzingclient.
#
# Honesty list (plan §6.5; cases still run whose NON-STRICT verdict is
#   tolerated with evidence): 6.4.3/6.4.4, mapped to their evidence inside
#   check-reports.mjs (EXPECTED_NON_STRICT). Chop-split invalid UTF-8
#   inside one non-FIN text frame cannot be rejected until FIN by any
#   incremental validator; stock ws on the same image lands NON-STRICT
#   with the same ~2 s latency (server mode 6.4.1-4 all NON-STRICT
#   d=2011-2015 ms; client mode 6.4.3/6.4.4 NON-STRICT), matching Gren
#   (6.4.3/6.4.4 NON-STRICT d=2009-2015 ms; 6.4.1/6.4.2 are OK for
#   Gren, stricter than ws there).
#
# Completeness guard: both suites pass --expected-count, so
# check-reports.mjs compares the executed case count against N exactly.
# Client path: run-client-suite.mjs takes N from /getCaseCount. Server
# path: server-suite-runner.mjs buffers the fuzzingclient's stdout and
# captures its announced "Ok, will run N test cases", then passes that N;
# and check-reports.mjs refuses --suite server outright when no count is
# supplied, so neither suite passes a truncated/announcement-less run.
#
# Docker networking note: the fuzzingserver container is published with
# -p 9001:9001 and we dial in (works identically on Linux and Docker Desktop).
# The fuzzingclient container must DIAL our server on 127.0.0.1:9009, which
# needs shared host networking: `--network host` is native on Linux (CI). On
# Docker Desktop, host networking exists since 4.34 but is commonly disabled;
# so on Darwin server-suite-runner.mjs rewrites the loopback URL to
# host.docker.internal (which Docker Desktop routes to host loopback
# listeners regardless of the --network mode) and drops --network host.
#
# Freshness (spec §6a): every app target depends on the whole library source
# tree plus the local library manifest, not just its own src/<App>.gren, so a
# library edit rebuilds the apps instead of leaving a stale binary. Primary
# check: after touching any ../../src file, `make -n test` prints the compile
# step. SECONDARY guard (verified to survive `gren make --optimize` in each of
# the five app binaries across both Makefiles): the recipe asserts the built
# binary contains the literal 'permessage-deflate'. Guard form = grep, all
# targets.

# Observed results - PER-SUITE PROVENANCE (A3).
#
#   SERVER suite - CARRIED from cycle 5, NOT re-measured in cycle 6: the test
#     image id (sha256:519915fb...) and src/AutobahnServer.gren are
#     byte-identical to the cycle-5 run, so the two cycle-5 full runs stand.
#     evidence: goals/implement-rfc-7692-permessage-deflate-in-gren-la/
#     artifacts/cycle5-sg3-server-suite-full.txt, cycle5-sg3-completeness.txt.
#     announced 517, executed 517 (fuzzingclient exit code 0; make/gate exit 0).
#     per-category OK/INFO/FAIL:
#       1.x 16/0/0, 2.x 11/0/0, 3.x 7/0/0, 4.x 10/0/0, 5.x 20/0/0,
#       6.x 145/0/0, 7.x 34/3/0, 9.x 54/0/0, 10.x 1/0/0, 12.x 90/0/0,
#       13.x 126/0/0.
#     12.x/13.x negotiate permessage-deflate and ran to completion.
#     12.x per-case max 11815 ms, 13.x per-case max 5480 ms,
#     full-suite max 11815 ms (case 12.3.15).
#
#   CLIENT suite - CYCLE-6 MEASUREMENT on the revised binary (the shared
#     diagnostic-then-exit chain), wall clock 10m41s.
#     evidence: artifacts/cycle6-sg3-client-suite-full.txt,
#     artifacts/cycle6-sg3-client-index.json, artifacts/cycle6-sg3-completeness.txt.
#     reported CASES=517, executed 517 (app exit code 0; make/gate exit 0).
#     per-category OK/INFO/FAIL:
#       1.x 16/0/0, 2.x 11/0/0, 3.x 7/0/0, 4.x 10/0/0, 5.x 20/0/0,
#       6.x 145/0/0, 7.x 34/3/0, 9.x 54/0/0, 10.x 1/0/0, 12.x 90/0/0,
#       13.x 126/0/0.
#     12.x/13.x negotiate permessage-deflate and ran to completion.
#     12.x per-case max 11893 ms, 13.x per-case max 5116 ms,
#     full-suite max 11893 ms (case 12.3.18).
#
#   Watchdog shipped: src/AutobahnClient.gren watchdogMs = 600000 ms
#     (1.25 x 480 s); no 'TIMEOUT in phase token' line appeared in the
#     cycle-6 client run.
#
#   Non-OK cases observed (cycle-6 client run): only the pre-existing
#     6.4.3/6.4.4 NON-STRICT results (honesty list above); 7.1.6/7.13.1/
#     7.13.2 are INFORMATIONAL (accepted verdict). No further non-OK cases ->
#     sg4 hand-offs: none.


LIB_SRCS := $(shell find ../../src -type f \( -name '*.gren' -o -name '*.js' \))

.PHONY: test
test: autobahn-server-suite autobahn-client-suite

autobahn-server-app: Makefile gren.json ../../gren.json src/AutobahnServer.gren $(LIB_SRCS)
	gren make --optimize AutobahnServer --output=autobahn-server-app
	@grep -q 'permessage-deflate' autobahn-server-app || { echo 'STALE BINARY: autobahn-server-app does not contain the library under test'; exit 1; }

autobahn-client-app: Makefile gren.json ../../gren.json src/AutobahnClient.gren $(LIB_SRCS)
	gren make --optimize AutobahnClient --output=autobahn-client-app
	@grep -q 'permessage-deflate' autobahn-client-app || { echo 'STALE BINARY: autobahn-client-app does not contain the library under test'; exit 1; }

# Each suite writes its master report (index.json + index.html + per-case
# files) into its own subdirectory of reports/ (fuzzingclient.json outdir
# /reports/server, fuzzingserver.json outdir /reports/client) so the two
# suites can never clobber each other's evidence — both emit index.json and
# the fuzzingserver names per-case files gren_node_case_* in fuzzingserver
# mode regardless of which suite ran.
.PHONY: autobahn-server-suite
autobahn-server-suite: autobahn-server-app
	@grep -q 'permessage-deflate' autobahn-server-app || { echo 'STALE BINARY: autobahn-server-app does not contain the library under test'; exit 1; }
	@mkdir -p reports/server
	@rm -f reports/server/index.json reports/server/index.html
	@rm -f reports/server/unknownserver_case_*.json reports/server/unknownserver_case_*.html
	node server-suite-runner.mjs

.PHONY: autobahn-client-suite
autobahn-client-suite: autobahn-client-app
	@grep -q 'permessage-deflate' autobahn-client-app || { echo 'STALE BINARY: autobahn-client-app does not contain the library under test'; exit 1; }
	@mkdir -p reports/client
	@rm -f reports/client/index.json reports/client/index.html
	@rm -f reports/client/gren_node_case_*.json reports/client/gren_node_case_*.html
	node run-client-suite.mjs

.PHONY: clean
clean:
	rm -rf .gren
	rm -f autobahn-server-app autobahn-client-app .fuzzingclient.darwin.json
	rm -rf reports
