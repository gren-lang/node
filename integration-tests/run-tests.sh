#!/usr/bin/env bash

set -e

test_dirs=(
  "http-server"
  "http-client"
  "signals"
  "file-system"
  "child-process"
  "sqlite"
  "websocket"
)

for dir in "${test_dirs[@]}"; do
  echo -e "Running $dir tests...\n\n"
  pushd "$dir"
  just test
  popd
done
