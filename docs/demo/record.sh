#!/usr/bin/env bash
# Re-record the two README demos:
#   docs/demo-cli.gif   - /ccfind:ccfind inside Claude Code, table + picker
#   docs/demo-term.gif  - ccfind pick in a terminal
#
# Nothing from the real ~/.claude/projects is read. The corpus is generated into
# a throwaway directory and ccfind is pointed at it with CCFIND_CONFIG_DIR, so a
# recording can never leak private history. The Claude Code run still uses your
# real login (it has to), so disable any plugin that rewrites its output style
# first - `claude plugin disable <name>` - or the demo will show that style.
#
# Needs vhs (https://github.com/charmbracelet/vhs), node 18+, and a logged-in
# claude for the first tape.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
CORPUS="$WORK/corpus"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$CORPUS" "$WORK/bin" "$WORK/infra"
node "$REPO/docs/demo/gen.mjs" "$CORPUS"
node "$REPO/docs/demo/filler.mjs" "$CORPUS"
CCFIND_BIN_DIR="$WORK/bin" node "$REPO/skills/ccfind/scripts/ccfind.mjs" install >/dev/null
CCFIND_CONFIG_DIR="$CORPUS/.claude" node "$REPO/skills/ccfind/scripts/ccfind.mjs" index

# Recording settings: no status line, default output style. The banner with the
# account name and organisation is cleared inside the tape with Ctrl+L.
cat > "$WORK/demo-settings.json" <<'JSON'
{ "statusLine": { "type": "command", "command": "printf ''" }, "outputStyle": "default" }
JSON

for tape in cli term; do
  sed -e "s|__CORPUS__|$CORPUS|g" -e "s|__WORK__|$WORK/infra|g" -e "s|__REPO__|$REPO|g" \
      "$REPO/docs/demo/$tape.tape" > "$WORK/$tape.tape"
  # CLAUDECODE/CLAUDE_CODE_CHILD_SESSION leak in from a parent session and make
  # the recorded run print a "transcript saving is off" warning.
  env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION vhs "$WORK/$tape.tape"
done

ls -lh "$REPO/docs/demo-cli.gif" "$REPO/docs/demo-term.gif"
