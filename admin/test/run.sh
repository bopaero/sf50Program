#!/bin/bash
# Costing editor Worker tests (SF50 at /, SR22T at /sr22t, Founder summary).
# Bundles admin/worker.js exactly as wrangler would (editor pages as text) and runs
# both suites against mocked GitHub + Cloudflare Access. Needs ../sr22tProgram
# checked out beside this repo, like the deploy.
#   bash admin/test/run.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO_DIR="$(cd "$HERE/../.." && pwd)"
npx -y esbuild "$REPO_DIR/admin/worker.js" --bundle --format=esm --loader:.html=text \
  --outfile="$HERE/worker.mjs" --log-level=warning
cd "$HERE"
REPO="$REPO_DIR" node sf50.test.mjs | grep -v '^PASS'
REPO="$REPO_DIR" SR_REPO="$REPO_DIR/../sr22tProgram" node sr22t.test.mjs | grep -v '^PASS'
