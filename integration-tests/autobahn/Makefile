# Autobahn TestSuite integration.
#
# Exclusion policy (plan §6.5): the only case exclusions live in
# config/fuzzingclient.json and config/fuzzingserver.json as
# "exclude-cases": ["permessage-deflate.*", "12.*", "13.*"].
#   permessage-deflate.* - out-of-scope extension (D4); the classic image
#     ships no 11.x extension cases, so the pattern matches nothing today.
#   12.* / 13.* - the classic image builds these categories (limits/
#     performance and permessage-deflate-parameter variants) exclusively
#     from compressed test data, and their robots open with `if
#     self._perMessageCompress is None: behavior = UNIMPLEMENTED`
#     (case/case12_x_x.py). Our v1 handshake negotiates no extensions
#     (D4), so every one of the 216 cases reports the fuzzer-side
#     behavior constant UNIMPLEMENTED at 0-3 ms in BOTH suites - stock ws
#     (permessage-deflate enabled by default, which Gren v1 is not) shows
#     the same 216 UNIMPLEMENTED in server mode and only OK in client mode
#     where ws does negotiate deflate. This is not a gap an echo server
#     can close; it is the extension exclusion surfacing as UNIMPLEMENTED
#     instead of being cased out. §6.5's "12.x reports INFORMATIONAL /
#     13.x passes strict" expectation was verified against the wrong
#     (newer) suite and does not hold for this image - documented deviation,
#     exclusions audited by check-reports.mjs's name check.
#   Honesty list (cases still run whose NON-STRICT verdict is tolerated
#     with evidence): 6.4.3/6.4.4, mapped to their evidence inside
#     check-reports.mjs (EXPECTED_NON_STRICT). Chop-split invalid UTF-8
#     inside one non-FIN text frame cannot be rejected until FIN by any
#     incremental validator; stock ws on the same image lands NON-STRICT
#     with the same ~2 s latency (server mode 6.4.1-4 all NON-STRICT
#     d=2011-2015 ms; client mode 6.4.3/6.4.4 NON-STRICT), matching Gren
#     (6.4.3/6.4.4 NON-STRICT d=2009-2015 ms; 6.4.1/6.4.2 are OK for
#     Gren, stricter than ws there).
#
# Docker networking note: the fuzzingserver container is published with
# -p 9001:9001 and we dial in (works identically on Linux and Docker Desktop).
# The fuzzingclient container must DIAL our server on 127.0.0.1:9009, which
# needs shared host networking: `--network host` is native on Linux (CI). On
# Docker Desktop, host networking exists since 4.34 but is commonly disabled;
# so on Darwin server-suite-runner.mjs rewrites the loopback URL to
# host.docker.internal (which Docker Desktop routes to host loopback
# listeners regardless of the --network mode) and drops --network host.

.PHONY: test
test: autobahn-server-suite autobahn-client-suite

autobahn-server-app: Makefile gren.json src/AutobahnServer.gren
	gren make --optimize AutobahnServer --output=autobahn-server-app

autobahn-client-app: Makefile gren.json src/AutobahnClient.gren
	gren make --optimize AutobahnClient --output=autobahn-client-app

# Each suite writes its master report (index.json + index.html + per-case
# files) into its own subdirectory of reports/ (fuzzingclient.json outdir
# /reports/server, fuzzingserver.json outdir /reports/client) so the two
# suites can never clobber each other's evidence — both emit index.json and
# the fuzzingserver names per-case files gren_node_case_* in fuzzingserver
# mode regardless of which suite ran.
.PHONY: autobahn-server-suite
autobahn-server-suite: autobahn-server-app
	@mkdir -p reports/server
	@rm -f reports/server/index.json reports/server/index.html
	@rm -f reports/server/unknownserver_case_*.json reports/server/unknownserver_case_*.html
	node server-suite-runner.mjs

.PHONY: autobahn-client-suite
autobahn-client-suite: autobahn-client-app
	@mkdir -p reports/client
	@rm -f reports/client/index.json reports/client/index.html
	@rm -f reports/client/gren_node_case_*.json reports/client/gren_node_case_*.html
	node run-client-suite.mjs

.PHONY: clean
clean:
	rm -rf .gren
	rm -f autobahn-server-app autobahn-client-app .fuzzingclient.darwin.json
	rm -rf reports
