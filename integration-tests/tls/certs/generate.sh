#!/usr/bin/env bash
#
# Regenerate the TLS fixtures committed under certs/.
#
# These PEMs are checked into git so the test suite does not need openssl at
# test time (the devbox shell ships without it). Run this script manually
# whenever the certificates near expiry (they are valid for 10 years; check
# with `openssl x509 -in certs/server-good.crt -noout -enddate`):
#
#   cd integration-tests/tls/certs && ./generate.sh
#
# Requires openssl 3.x (uses -addext for the subjectAltName).
#
# Fixtures:
#   server-good.{crt,key}  self-signed, SAN: DNS:localhost, IP:127.0.0.1
#                          -- the server identity used by the echo server;
#                             clients pin server-good.crt as `Ca`
#   server-wrong.{crt,key} self-signed, SAN: DNS:example.com only
#                          -- pinning this as the client CA must break
#                             verification against the good server

set -euo pipefail

cd "$(dirname "$0")"

days=3650

openssl req -x509 -newkey rsa:2048 -sha256 -days "$days" -nodes \
  -keyout server-good.key -out server-good.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

openssl req -x509 -newkey rsa:2048 -sha256 -days "$days" -nodes \
  -keyout server-wrong.key -out server-wrong.crt \
  -subj "/CN=wrong.example" \
  -addext "subjectAltName=DNS:example.com"

chmod 644 server-good.crt server-wrong.crt
chmod 600 server-good.key server-wrong.key

echo
echo "server-good.crt:"
openssl x509 -in server-good.crt -noout -enddate -ext subjectAltName
echo "server-wrong.crt:"
openssl x509 -in server-wrong.crt -noout -enddate -ext subjectAltName
