app: Makefile gren.json src/Main.gren node_modules
	npx gren make --optimize src/Main.gren --output=app

.PHONY: test
test: app node_modules
	npm test

node_modules: package.json package-lock.json
	npm install

.PHONY: clean
clean:
	rm -rf .gren
	rm -rf node_modules
	rm app
