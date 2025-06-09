#!/usr/bin/env bash

set -e

echo -e "Running http-server tests...\n\n"
pushd http-server
make test || exit 1
popd

echo -e "Running http-client tests...\n\n"
pushd http-client
make test || exit 1
popd

echo -e "Running signals tests...\n\n"
pushd signals
make test || exit 1
popd
