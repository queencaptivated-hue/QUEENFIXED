#!/usr/bin/env sh
# Thin wrapper kept for backwards compatibility. The real logic lives in
# vercel-build.mjs (Node) so it can't break on CRLF line endings or a missing PATH.
cd "$(dirname "$0")/.." || exit 1
exec node scripts/vercel-build.mjs
