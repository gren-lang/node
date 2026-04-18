#!/usr/bin/env bash

set -e

test_dirs=(
  "http-server"
  "http-client"
  "signals"
  "child-process"
  "sqlite"
)

for dir in "${test_dirs[@]}"; do
  echo -e "Running $dir tests...\n\n"
  pushd "$dir"
  make test || exit 1
  popd
done
