#!/bin/bash

set -e

echo -e "Running unit tests...\n"
pushd tests
gren make --optimize src/Main.gren && node app
popd

echo -e "\n\nRunning http-server examples...\n"
pushd examples/http-server
make test
popd

echo -e "\n\nRunning http-client examples...\n"
pushd examples/http-client
npm test
popd
