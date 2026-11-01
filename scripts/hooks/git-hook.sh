#!/bin/sh
# Git hook installed by `npm run hooks:install` (also run by `npm install`).
#
# Installed as a copy in the Git directory, so it keeps working across branches
# and worktrees, including branches that predate this file. Every forwarded hook
# name is the same copy, which dispatches on its own name: pre-commit formats
# the staged files first, then the hook runs the pre-commit hook of the hooks
# directory that core.hooksPath replaced, so a machine-wide hook such as a
# company scanner keeps running.
set -u

name=$(basename "$0")
root=$(git rev-parse --show-toplevel) || exit 1

if [ "$name" = pre-commit ] && [ -f "$root/scripts/pre-commit-format.mjs" ] && command -v node >/dev/null 2>&1; then
  node "$root/scripts/pre-commit-format.mjs"
  status=$?
  [ "$status" -eq 0 ] || exit "$status"
fi

chained=$(git config --get cordisx.hooksChainPath 2>/dev/null || true)
[ -n "$chained" ] || exit 0

target="$chained/$name"
[ -x "$target" ] || exit 0

# Never run this directory again when the recorded chain is where we are.
self=$(cd "$(dirname "$0")" && pwd -P)
[ "$(cd "$chained" 2>/dev/null && pwd -P)" = "$self" ] && exit 0

exec "$target" "$@"
