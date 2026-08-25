# Changelog

All versions are dated 2026-08-25: the project went from first commit to the
plugin directory in one sitting, and this log keeps the real steps.

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
