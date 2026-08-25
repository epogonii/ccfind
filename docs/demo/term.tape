# In a terminal: ccfind pick - arrow keys, live detail pane, Enter resumes.
# Enter is real here: it hands the terminal to `claude --resume` on the picked
# session, which reads the synthetic corpus via CLAUDE_CONFIG_DIR - see record.sh.
Output "__REPO__/docs/demo-term.gif"
Require node
Require claude

Set Shell "bash"
Set FontSize 16
Set Width 1180
Set Height 620
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 12
Set TypingSpeed 28ms

Hide
Type "export CLAUDE_CONFIG_DIR=__CORPUS__/.claude PATH=__BIN__:$PATH PS1='$ '; cd __WORK__; clear"
Enter
Show
Sleep 700ms

Type "ccfind pick 'reboot'"
Enter
Wait+Screen@30s /click to move/
Sleep 1800ms
Down
Sleep 800ms
Down
Sleep 800ms
Down
Sleep 1200ms
Up
Sleep 1500ms
Enter
# The picker is gone now; claude paints its banner, then the resumed session.
# Wait on the banner - the session's own words already sit in the detail pane
# before Enter, so they cannot be the signal.
Wait+Screen@60s /Claude Code v/
Sleep 8s
Hide
Ctrl+C
Sleep 300ms
Ctrl+C
Sleep 800ms
