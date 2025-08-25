server:
	gren make TestsServer --output=server-app

tests:
	gren make Tests --output=tests-app

stream-tests:
	gren make LegacyStreamTests --output=stream-tests-app

.PHONY: test
test: server tests stream-tests
	node run.mjs

.PHONY: clean
clean:
	rm -rf .gren
	rm server-app
	rm tests-app
	rm stream-tests-app