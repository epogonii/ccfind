Output "__REPO__/docs/demo.gif"
Require node

Set Shell "bash"
Set FontSize 17
Set Width 1200
Set Height 700
Set Theme "Catppuccin Mocha"
Set Padding 22
Set Framerate 24
Set TypingSpeed 32ms

Hide
Type "export HOME=__HOME__ PS1='$ '; cd __REPO__; rm -rf $HOME/.claude/ccfind; clear"
Enter
Show
Sleep 700ms

Type "node skills/ccfind/scripts/ccfind.mjs index"
Enter
Sleep 1400ms

Type "node skills/ccfind/scripts/ccfind.mjs search 'reboot hangs waiting on shutdown manager' --limit 3"
Enter
Sleep 5000ms
