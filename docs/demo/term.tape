# In a terminal: ccfind pick - arrow keys, live detail pane, Enter resumes.
Output "__REPO__/docs/demo-term.gif"
Require node

Set Shell "bash"
Set FontSize 16
Set Width 1180
Set Height 620
Set Theme "Catppuccin Mocha"
Set Padding 20
Set Framerate 12
Set TypingSpeed 28ms

Hide
Type "export CCFIND_CONFIG_DIR=__CORPUS__/.claude CCFIND_PICK_DRYRUN=1 PATH=__WORK__/bin:$PATH PS1='$ '; cd __WORK__; clear"
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
Sleep 2500ms
