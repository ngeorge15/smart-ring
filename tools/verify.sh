#!/bin/bash
# Deterministic checks, with no private DB or pre-existing /tmp files.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 tools/verify.py
