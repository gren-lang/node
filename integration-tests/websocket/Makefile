# Freshness (spec §6a): every app target depends on the whole library source
# tree plus the local library manifest, not just its own src/<App>.gren, so a
# library edit rebuilds the apps instead of leaving a stale binary. Primary
# check: after touching any ../../src file, `make -n test` prints the compile
# step. SECONDARY guard (verified to survive `gren make --optimize` in each of
# the five app binaries across both Makefiles): the recipe asserts the built
# binary contains the literal 'permessage-deflate'. Guard form = grep, all
# targets.
LIB_SRCS := $(shell find ../../src -type f \( -name '*.gren' -o -name '*.js' \))

server-app: Makefile gren.json ../../gren.json src/Server.gren $(LIB_SRCS)
	gren make --optimize Server --output=server-app
	@grep -q 'permessage-deflate' server-app || { echo 'STALE BINARY: server-app does not contain the library under test'; exit 1; }

client-tests-app: Makefile gren.json ../../gren.json src/ClientTests.gren $(LIB_SRCS)
	gren make --optimize ClientTests --output=client-tests-app
	@grep -q 'permessage-deflate' client-tests-app || { echo 'STALE BINARY: client-tests-app does not contain the library under test'; exit 1; }
wss-app: Makefile gren.json ../../gren.json src/WssClientTest.gren $(LIB_SRCS)
	gren make --optimize WssClientTest --output=wss-app
	@grep -q 'permessage-deflate' wss-app || { echo 'STALE BINARY: wss-app does not contain the library under test'; exit 1; }

.PHONY: test
test: server-app client-tests-app wss-app node_modules
	@grep -q 'permessage-deflate' server-app || { echo 'STALE BINARY: server-app does not contain the library under test'; exit 1; }
	@grep -q 'permessage-deflate' client-tests-app || { echo 'STALE BINARY: client-tests-app does not contain the library under test'; exit 1; }
	@grep -q 'permessage-deflate' wss-app || { echo 'STALE BINARY: wss-app does not contain the library under test'; exit 1; }
	node run.mjs
	npx mocha --require test/fixtures.mjs

node_modules: package.json package-lock.json
	npm ci

.PHONY: clean
clean:
	rm -rf .gren
	rm -rf node_modules
	rm -f server-app client-tests-app wss-app
