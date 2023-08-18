app: Makefile gren.json ../../gren.json $(shell find src -type f) $(shell find ../../src -type f)
	gren make --optimize src/Main.gren

.PHONY: serve
serve: app
	node app

.PHONY: test
test: app node_modules
	npx playwright test -x

node_modules: package.json package-lock.json
	npm install

.PHONY: clean
clean:
	rm -rf .gren
	rm -rf node_modules
	rm app
