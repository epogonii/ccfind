# Inside Claude Code: /ccfind:ccfind, the table, the picker.
# Recorded against a synthetic corpus via CCFIND_CONFIG_DIR - see record.sh.
Output "__REPO__/docs/demo-cli.gif"
Require claude

Set Shell "bash"
Set FontSize 16
Set Width 1180
Set Height 780
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 12
Set TypingSpeed 28ms

Hide
Type "export CCFIND_CONFIG_DIR=__CORPUS__/.claude CCFIND_OPEN_DRYRUN=1 PS1='$ '; cd __WORK__; clear"
Enter
Type "claude --settings __WORK__/../demo-settings.json --plugin-dir __PLUGIN__ --model claude-sonnet-5"
Enter
# A fresh directory gets the workspace trust prompt; accept it while hidden.
Wait+Screen@60s /trust|proceed/
Sleep 500ms
Enter
Wait+Screen@90s /shortcuts|Welcome|Try /
Sleep 2s
# Ctrl+L clears the scrollback but NOT the welcome banner, which carries the
# account name and org - record.sh crops the top of the frame for that.
Ctrl+L
Sleep 1200ms
Show
Sleep 800ms

Type "/ccfind:ccfind reboot hangs on the workers"
Sleep 600ms
Enter
Wait+Screen@240s /Which session|resume [0-9a-f]{8}/
Sleep 2500ms
Down
Sleep 900ms
Enter
# The answer to the pick (session summary, then the open) takes ~30s. A Wait
# here would match text that is already on screen, so hold a fixed window.
Sleep 45s
Hide
