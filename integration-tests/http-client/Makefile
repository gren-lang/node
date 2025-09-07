server-app:
	gren make TestsServer --output=server-app

tests-app:
	gren make Tests --output=tests-app

stream-tests-app:
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
