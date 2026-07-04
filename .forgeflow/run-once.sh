#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

flock -n .forgeflow/forgeflow.lock npx tsx .forgeflow/run.ts
