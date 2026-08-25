#!/usr/bin/env bash
# Re-record docs/demo.gif against a synthetic session history.
#
# Nothing from the real ~/.claude/projects is read: the corpus is generated into
# a throwaway HOME, so the recording can never leak private history. Needs vhs
# (https://github.com/charmbracelet/vhs) and node 18+.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

node "$REPO/docs/demo/gen.mjs" "$WORK"
node "$REPO/docs/demo/filler.mjs" "$WORK"

sed -e "s|__HOME__|$WORK|g" -e "s|__REPO__|$REPO|g" \
    "$REPO/docs/demo/demo.tape" > "$WORK/demo.tape"
vhs "$WORK/demo.tape"

echo "wrote $REPO/docs/demo.gif"
