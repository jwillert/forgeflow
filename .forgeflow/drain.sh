#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

flock .forgeflow/forgeflow.lock npx tsx .forgeflow/drain.ts
