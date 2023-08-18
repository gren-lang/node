#!/bin/bash

set -e

echo -e "Running unit tests...\n" && \
cd tests && gren make --optimize src/Main.gren && node app && \

echo -e "\n\nRunning http-server examples...\n" && \
cd examples/http-server && make test
