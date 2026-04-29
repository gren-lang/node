server-app: src/TestsServer.gren
	gren make TestsServer --output=server-app

tests-app: src/Tests.gren
	gren make Tests --output=tests-app

stream-tests-app: src/LegacyStreamTests.gren
	gren make LegacyStreamTests --output=stream-tests-app

.PHONY: test
test: server-app tests-app stream-tests-app
	node run.mjs

.PHONY: clean
clean:
	rm -rf .gren
	rm server-app
	rm tests-app
	rm stream-tests-app
