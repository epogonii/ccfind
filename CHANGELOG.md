# Changelog

Versions up to 0.16.3 are dated 2026-08-25: the project went from first commit
to the plugin directory in one sitting, and this log keeps the real steps.

## 0.17.2

- The missing table, actually found this time. Four releases had guessed at it
  from the transcripts; a headless run settles it. `claude -p "<a search>"` with
  `--model` and a `--settings` file that switches a plugin off isolates one
  variable at a time, and in that harness the picker is unavailable, so the table
  would be the whole final message - which rules out any theory about text before
  a tool call.

  Two conditions have to hold together. Weaker models drop the table unless
  SKILL.md states outright that it is the answer rather than an optional
  flourish, and a terse-output style plugin that bans "decorative tables" takes
  this one with it, because from inside that rule a table is a table. So the
  Answering section now opens by saying the reply *is* the table, and says the
  table is data, not decoration - a house style demanding compression governs the
  sentences around it, not the columns. The bullet that used to open "no
  preamble" now says "open with the table itself": the old phrasing read, to a
  model already inclined to say less, as permission to print nothing.

  Verified on the same query across four runs: weak model without the style
  plugin, with it, and a strong model with it - table in all three after the
  change, absent in the control before it.

## 0.17.1

- The table is back in front of the picker, where 0.16.5 had it. 0.17.0 moved
  the hit list into the `question` string on the theory that Claude Code
  collapses pre-tool-call text into "(summarized)" - that theory was wrong.
  "(summarized)" is the away-recap, the thing the UI shows when you come back
  to a session after a few minutes away, not a rule about mid-turn text; and
  in the sessions where the table went missing the model had written no text at
  all, so there was nothing to collapse. The question string does render
  multiline, but a paragraph of run-together hits reads worse than the table it
  was standing in for. SKILL.md now says why the pre-picker text is legitimate
  (an answer is not a progress note) and that the question stays one line.

## 0.17.0

- The hits moved into the picker itself. Claude Code 2.1.246 collapses any
  message text written before a tool call into a one-line "(summarized)" stub,
  so the table-before-picker layout - however firmly the skill demanded it -
  can never be seen there: the model's text, when it wrote one at all, was
  swallowed by the UI (older versions, e.g. on Linux, still render it, which
  is why the same skill looked fine on one machine and broken on another).
  The `AskUserQuestion` question string is the one surface guaranteed to
  render in full, and it renders multiline (verified), so it now carries a
  numbered hit list - title, date, project, request count, snippet fragment -
  plus the counts line. The full table moved to the turn's final message after
  the pick, the only message the UI never collapses, and a cancelled picker
  gets the table as the final message too.

## 0.16.5

- The table-before-picker rule now argues with the reason it was being broken.
  With 0.16.4's wording loaded, a high-effort model still answered a search
  with the bare picker: its harness tells it mid-turn text may not be shown and
  everything belongs in the final message, so it deferred the table to after
  the pick - where a cancelled picker means the user gets nothing at all.
  SKILL.md now states that text before a tool call is rendered above the
  picker, that the user needs the table *to* pick, and that a turn whose only
  visible output is the `AskUserQuestion` call is wrong every time.

## 0.16.4

- The answer's table cannot be skipped in favour of the picker. On one machine
  the model went straight from the search result to `AskUserQuestion`, so the
  user saw a picker with three titles and nothing else - no table, no counts,
  no recommendation, and no answer to what they asked. SKILL.md now spells out
  the order: the table, the counts line and the recommendation as message text
  first, the picker call after, and that reasoning text does not count as
  output.
- `open` refuses a session id that is not a plain file name. The id is a
  transcript's file name and is interpolated unquoted into the `sh -lc` command
  the new terminal window runs, so a stray file with shell metacharacters in
  its name would have executed them. Ids are now validated against
  `[A-Za-z0-9._-]` before anything is launched.

## 0.16.3

- The generated launcher is CommonJS. It was written with `import` statements
  and no `.mjs` extension, so Node only accepted it where it guesses the module
  kind from the syntax - a feature that landed in 20.19. On Node 18, which the
  skill documents as the floor, `ccfind` died with
  `SyntaxError: Cannot use import statement outside a module` on every run: the
  command existed and never worked. It now uses `require` for the three built-ins
  and a dynamic `import()` for the plugin script, which runs on every supported
  version. Verified on Node 18 as well as 20 and 22.
- A test asserts the launcher's source has no top-level `import`. Running the
  launcher is not enough of a check on a modern Node, where the syntax guess
  hides exactly this bug - which is how it shipped in the first place. 113 tests.

## 0.16.2

- `install` names the startup file the user's own shell reads. It printed
  `>> ~/.zshrc && exec zsh` unconditionally, which is right on a default macOS
  and wrong everywhere bash is the shell: the user edits a file that is never
  sourced, `ccfind` still does not exist afterwards, and that looks like the
  launcher failed rather than like the advice being wrong. `$SHELL` now decides -
  `~/.bashrc` under bash on Linux, `~/.bash_profile` under bash on macOS, where
  terminals start login shells, `fish_add_path` under fish, `~/.zshrc` under zsh,
  and a bare `export PATH` line plus the shell's name for anything else.
- The 0.16.1 documentation quoted only bash's wording of the error. zsh, the
  macOS default, says `zsh: command not found: ccfind` - the same words in a
  different order, which is enough for a reader to conclude the page is about
  someone else's problem. Both forms are now named.
- `install` and `uninstall` have tests: 27 of them, over the launcher's contents
  and executable bit, the version it resolves to, the per-shell PATH advice, and
  both refusals to touch a file ccfind did not write. They run against a
  throwaway `CCFIND_BIN_DIR`, so the suite never writes to a real bin directory,
  and they run on macOS in CI, which is where the shell difference lives. 112
  tests in total.

## 0.16.1

- Documented the one step a new user cannot guess. The plugin installs a skill,
  not a binary, so `ccfind pick` in a fresh terminal answers
  `bash: ccfind: command not found` - which reads like a broken install rather
  than a missing one-time command. The exact string now appears where someone who
  just saw it will look: the terminal blurb at the top, the end of `## Install`,
  and the first line of `Terminal command`. No new instructions were invented; the
  existing section is simply reachable from where the problem is met.
- The skill now checks `command -v ccfind` before recommending `pick`, and offers
  `install` in the same breath when the command is missing, instead of leaving the
  user to hit the error first. It still runs `install` only on request or on that
  offer being taken, because the launcher is the one file ccfind writes outside
  the plugin directory.
- A plugin `bin/` directory would not have helped: Claude Code puts
  `<plugin>/bin` on the PATH of the shells it spawns itself, and `pick` needs a
  real terminal, which is exactly the PATH that entry never reaches.

## 0.16.0

- `pick` gained an incremental filter. `/` opens a line under the list, prefilled
  with the query already showing, and every keystroke re-runs the search:
  backspace deletes, ctrl-u clears, Enter keeps the new query and returns to
  moving through the list, Escape puts the old list back. Measured on the author's
  own corpus: about 2.8 ms per keystroke, because the index is already in memory
  by the time the picker draws and a re-query reads no file. The filter line is
  drawn below the list and the list gives up two rows to it, so the screen row a
  click lands on still means the same row. An empty or unmatched filter is a state
  the screen survives rather than an exit: no cursor, no detail pane, Enter opens
  nothing, and backspace types back into a list that matches.
- The picker's key handling is now one function, and `CCFIND_PICK_KEYS` replays a
  key script into it, so the filter is covered by the normal test suite instead of
  needing a pseudo-terminal. `\e` is Escape, `\r` is Enter, `\b` is Backspace,
  `\xNN` is that byte; when the script runs out, `pick` prints the query it ended
  on and the session it left selected. 16 new tests, 85 in total.
- Nothing about the terminal launch changed: `open` and its per-platform command
  lines are the same bytes as 0.15.4 on Linux, macOS and tmux.

## 0.15.4

- Fixed the rest of what 0.15.2 and 0.15.3 were aiming at: a Linux window opened
  by `open` still closed without the confirmation the same terminal shows for
  every other window. Keeping a shell above `claude` was necessary but not
  sufficient. A VTE terminal decides whether anything is running by comparing the
  pty's foreground process group with the process it spawned, and a shell handed
  `-c` runs its command in its own process group unless job control is on, so the
  two matched and the terminal saw an idle window. Measured: without `set -m` the
  child's pgid is the shell's own, with it the child leads its own group - which is
  exactly the shape an interactive shell produces, and confirmed in a real ptyxis
  window, which then asked before closing. The Linux command is now
  `sh -lc 'set -m; cd <cwd> && claude --resume <id>; exit $?'`. Both halves are
  needed: `set -m` for the process group, the trailing builtin to stop the shell
  from replacing itself with `claude`. macOS and tmux are untouched - their command
  lines are byte-identical to 0.15.1's.

## 0.15.3

- Fixed a regression in 0.15.2 that only showed on macOS. The `; exit $?` added to
  keep a shell above the resumed session went onto the command for every platform,
  and on macOS that command is not run by a shell we spawn - `do script` types it
  into a new window's *interactive* shell, which normally stays at a prompt once
  `claude` quits. Exiting it would have closed that window instead, losing the
  shell the user was left with. macOS never needed the guard anyway: `claude` is
  already a child of that interactive shell, which is exactly what Terminal and
  iTerm look for when they warn about closing a window. The trailing builtin now
  goes only to the Linux emulator ladder, and tmux is left out too, since
  `kill-window` never asks. Verified by forcing the platform: the macOS and tmux
  command lines are byte-identical to 0.15.1's.

## 0.15.2

- Fixed: closing a window that `open` had launched killed the session without the
  confirmation every other window of the same terminal shows. The launch ran
  `sh -lc "cd ... && claude --resume <id>"`, and a shell handed `-c` replaces
  itself with the last command instead of forking it, so `claude` became the
  terminal's own process. Emulators that offer to confirm closing - ptyxis,
  gnome-terminal, konsole - look for a child process still running, found none,
  and closed on the first click. The command now ends in `; exit $?`, which keeps
  the shell above `claude` where those emulators look; the exit status is still
  `claude`'s.

- Docs: the indexing cost was wrong everywhere it was stated. `README.md` and the
  skill both claimed a full rebuild of a 90 MB corpus took about 2 seconds, an
  implied 45 MB/s that does not hold. Measured on a 250 MB history of 93
  transcripts: a full rebuild takes about 19 s, roughly 13 MB/s. Two related
  claims were wrong with it - a cold search is 1.2 s on that history rather than
  the benchmark corpus's 133 ms, because the figure is dominated by reading the
  index back and this index is 9.3 MB rather than 3.9 MB; and an unchanged corpus
  is not skipped "instantly", since the skip still starts a process, stats every
  transcript and loads the index, costing about as much as a search. The skill now
  states the throughput instead of a single total, and tells the model to say the
  indexing step is running when the history is large, rather than leaving a tool
  call that looks stuck. No behaviour change.

## 0.15.1

- Fixed: a session opened by `open` stopped saving its transcript. The terminal
  was launched with this process's environment, so Claude Code's per-session
  markers came along, and `CLAUDE_CODE_CHILD_SESSION` told the resumed session
  it was a child run - which turns transcript persistence off. Every window
  `open` produced therefore discarded its own conversation and could never be
  indexed or found again. The launch now hands the terminal an environment with
  those markers removed: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, the session
  id, entrypoint, exec path, messaging socket and token, and `CLAUDE_PID`.
  Configuration the user chose, `CLAUDE_CONFIG_DIR` included, is untouched.
  `pick` handed the same environment to `claude --resume` and is fixed with it.

## 0.15.0

- Fixed: `open` had no way to open a window on a current GNOME desktop. The
  emulator list predated ptyxis (GNOME's terminal since Fedora 41) and GNOME
  Console, so a box with either and nothing else fell through every candidate
  and printed the fallback. It now asks `xdg-terminal-exec` first - the
  freedesktop dispatcher, which honours whichever terminal the user chose - and
  knows ptyxis, kgx, foot, terminator and xfce4-terminal.
- Fixed: `open` blocked for as long as the window it opened stayed open. A
  foreground terminal (kitty, foot, xterm) *is* the window and does not exit
  while it is up, and `open` runs from inside a tool call, which hung with it.
  The launch is asynchronous now and lets go of the terminal it started.
- Fixed: `open` counted a terminal killed by a signal as a window that opened,
  and reported success with nothing on screen.
- Fixed: a non-numeric or negative `--days` silently either dropped the filter
  (`--days abc`) or matched nothing (`--days -3`). Both now mean no date filter
  and say so on stderr, so `--json` output stays clean. A fractional window
  (`--days 0.5` for the last twelve hours) still filters.
- Indexing no longer rescans the whole exchange list once per transcript, which
  was quadratic in the size of the corpus: 1500 sessions and 21 000 exchanges
  went from 3.9 s to 2.9 s, for a byte-identical index.
- Tests: `node test/run.mjs` builds its own corpus in a temporary directory and
  covers indexing, search, every filter, the relevance gate, `show`, `pick` and
  all four outcomes of a terminal launch. It never reads or writes a real
  `~/.claude`. GitHub Actions runs it on Node 18, 20 and 22, Linux and macOS.

## 0.14.2

- Fixed: `--self` no longer discards an explicit `--exclude` list; it only
  lifts the automatic current-session exclusion.
- Fixed: a non-numeric `--limit` or `--turns` falls back to the default
  instead of silently returning nothing.
- Fixed: an empty search result now carries the same `group` key as a
  non-empty one.
- `pick` usage line documents `--all`.
- Manifest: `repository`, `license`, `$schema` for the plugin directory.
- README: prerequisites and a terminal-install pointer that works outside a
  Claude Code session.

## 0.14.1

- Crisp SVG wordmark (the pixel art blurred under fractional scaling).
- Search-result table names the turn count `Requests`.

## 0.14.0

- Relevance gate: hits scoring below 25% of the top one are hidden and
  counted as `weak`; `--all` returns them. Results carry
  `relevant`/`weak`/`total`.

## 0.13.0

- Demo recordings (vhs) against a synthetic corpus; README shows them.

## 0.12.0

- `CLAUDE_CONFIG_DIR` honoured for corpus and index; `CCFIND_CONFIG_DIR`
  overrides it for ccfind alone.

## 0.11.0

- Dropped the duplicate slash command - the skill itself is user-invocable
  as `/ccfind:ccfind`.

## 0.10.0

- Mouse support in the terminal picker: click to select, wheel to scroll.

## 0.9.x

- 0.9.3: the picked session opens immediately instead of asking first.
- 0.9.2: the `/resume <id>` line is always the full id, never abbreviated.
- 0.9.1: `open` names the terminal app it used, not the mechanism.
- 0.9.0: `open <id>` - a new terminal window resumed on that session
  (tmux, iTerm2, Terminal, or the installed Linux emulator).

## 0.8.0

- Answers hand back `/resume <id>` so a picked session can open in place.

## 0.7.0

- The installed `ccfind` launcher resolves the plugin version at run time,
  so a plugin update needs no reinstall.
- Output language: English by default, the user's language in answers.

## 0.6.0

- Markdown-table answers; recovered a plugin.json truncated by a bad patch.

## 0.5.0

- Aligned single-block search output; every hit listed, not the top three.

## 0.4.0

- `install`/`uninstall`: puts a `ccfind` command on PATH, no alias needed.

## 0.3.x

- 0.3.1: the picker is always offered; the picked session answers the
  original question.
- 0.3.0: `pick` - an arrow-key session picker for the terminal; Enter runs
  `claude --resume` on the selection.

## 0.2.0

- `show <id>`: a session's user turns in order, without opening the
  transcript; every match reported and described.

## 0.1.x

- 0.1.1: readable search output, clearer install docs.
- 0.1.0: BM25 index and search over the local transcripts in
  `~/.claude/projects/`, JSON and human output, `stats` and `bench`.
