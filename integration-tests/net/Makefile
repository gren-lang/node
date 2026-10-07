server-app: Makefile gren.json src/Server.gren
	gren make --optimize Server --output=server-app

client-tests-app: Makefile gren.json src/ClientTests.gren
	gren make --optimize ClientTests --output=client-tests-app

refused-test-app: Makefile gren.json src/RefusedTest.gren
	gren make --optimize RefusedTest --output=refused-test-app

in-use-test-app: Makefile gren.json src/InUseTest.gren
	gren make --optimize InUseTest --output=in-use-test-app

.PHONY: test
test: server-app client-tests-app refused-test-app in-use-test-app node_modules
	node run.mjs
	npx mocha --require test/fixtures.mjs

node_modules: package.json package-lock.json
	npm ci

.PHONY: clean
clean:
	rm -rf .gren
	rm -rf node_modules
	rm -f server-app client-tests-app refused-test-app in-use-test-app
