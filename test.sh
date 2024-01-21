#!/bin/bash

set -e

echo -e "\n\nRunning http-server examples...\n"
pushd examples/http-server
make test || exit 1
popd

echo -e "\n\nRunning http-client examples...\n"
pushd examples/http-client
npm test || exit 1
popd
