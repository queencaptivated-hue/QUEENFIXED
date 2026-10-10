#!/usr/bin/env sh
cd "$(dirname "$0")/.." || exit 1
BUILD_OUT_DIR=.amplify-output exec node scripts/vercel-build.mjs
