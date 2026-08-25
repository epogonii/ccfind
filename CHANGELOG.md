# Changelog

All versions are dated 2026-08-25: the project went from first commit to the
plugin directory in one sitting, and this log keeps the real steps.

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
