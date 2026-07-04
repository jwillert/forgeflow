#!/usr/bin/env bash
set -euo pipefail

image_name="${FORGEFLOW_SANDBOX_IMAGE:-forgeflow-agent}"
context_dir="${FORGEFLOW_SANDBOX_BUILD_CONTEXT:-.}"
dockerfile="${FORGEFLOW_SANDBOX_DOCKERFILE:-.forgeflow/Dockerfile}"

podman build \
  -t "$image_name" \
  -f "$dockerfile" \
  "$context_dir"
