#!/usr/bin/env bash
# =============================================================================
# Billing Proxy Comparison Test Runner
# =============================================================================
# One-click script to build and run the comparison tests.
#
# Usage:
#   ./run.sh          # Run tests
#   ./run.sh clean    # Clean up containers and volumes
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

if [[ "${1:-}" == "clean" ]]; then
  echo "Cleaning up..."
  docker compose down -v --remove-orphans 2>/dev/null || true
  echo "Done."
  exit 0
fi

echo "=== Billing Proxy Comparison Test ==="
echo ""
echo "This will:"
echo "  1. Build Sub2API from worktrees/sub2api"
echo "  2. Start mock server, proxy.js, postgres, redis, sub2api"
echo "  3. Run comparison tests"
echo ""

cleanup() {
  echo ""
  echo "Cleaning up containers..."
  docker compose down -v --remove-orphans 2>/dev/null || true
}

trap cleanup EXIT

# Clean up any previous run
docker compose down -v --remove-orphans 2>/dev/null || true

# Build and run
docker compose up --build --abort-on-container-exit --exit-code-from test-runner
