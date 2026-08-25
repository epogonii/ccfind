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
# claude for the first tape. Disable the installed copy of this plugin first
# (`claude plugin disable ccfind@ccfind`) - the tape loads the working tree with
# --plugin-dir, and two copies of the same skill would race. Pass a tape name to
# re-record just one:
#   ./docs/demo/record.sh term
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
CORPUS="$WORK/corpus"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$CORPUS" "$WORK/bin" "$WORK/infra" "$WORK/plugin"
# The tape loads the plugin from here rather than from the installed copy under
# ~/.claude: every tool call the model makes prints the script's absolute path,
# and a path under $HOME shows the account name in the frame. mktemp gives a
# path with no username in it.
cp -R "$REPO/.claude-plugin" "$REPO/skills" "$WORK/plugin/"
node "$REPO/docs/demo/gen.mjs" "$CORPUS"
node "$REPO/docs/demo/filler.mjs" "$CORPUS"
CCFIND_BIN_DIR="$WORK/bin" node "$REPO/skills/ccfind/scripts/ccfind.mjs" install >/dev/null
CCFIND_CONFIG_DIR="$CORPUS/.claude" node "$REPO/skills/ccfind/scripts/ccfind.mjs" index

# Recording settings: no status line, default output style. The banner with the
# account name and organisation is cleared inside the tape with Ctrl+L.
cat > "$WORK/demo-settings.json" <<'JSON'
{ "statusLine": { "type": "command", "command": "printf ''" }, "outputStyle": "default" }
JSON

for tape in ${1:-cli term}; do
  sed -e "s|__CORPUS__|$CORPUS|g" -e "s|__WORK__|$WORK/infra|g" -e "s|__REPO__|$REPO|g" \
      -e "s|__PLUGIN__|$WORK/plugin|g" \
      "$REPO/docs/demo/$tape.tape" > "$WORK/$tape.tape"
  # CLAUDECODE/CLAUDE_CODE_CHILD_SESSION leak in from a parent session and make
  # the recorded run print a "transcript saving is off" warning.
  env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION vhs "$WORK/$tape.tape"

  # The Claude Code welcome banner carries the account name and organisation and
  # Ctrl+L does not clear it, so crop it off the CLI recording after the fact.
  if [ "$tape" = cli ]; then
    ffmpeg -v error -y -i "$REPO/docs/demo-cli.gif" \
      -vf "crop=iw:ih-250:0:250,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer" \
      "$WORK/cli-cropped.gif"
    mv "$WORK/cli-cropped.gif" "$REPO/docs/demo-cli.gif"
  fi
done

ls -lh "$REPO"/docs/demo-*.gif
