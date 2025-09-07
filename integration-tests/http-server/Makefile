app: Makefile gren.json src/Main.gren
	gren make --optimize Main --output=app

.PHONY: test
test: app node_modules
	npm test

node_modules: package.json package-lock.json
	npm ci

.PHONY: clean
clean:
	rm -rf .gren
	rm -rf node_modules
	rm app
