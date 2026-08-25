---
name: ccfind
description: Search the user's own past Claude Code sessions by content and report which conversation discussed a thing, when, in which project, and how to resume it. Use this whenever the user asks about something from an earlier session rather than the current one - "where did we", "which session was that", "we already fixed this", "what was that command", "did I ask about X before", "find the conversation about", "remind me how we solved", "search my history" - or invokes /ccfind. The same asks in any other language fire it too: the trigger is what the user wants, not the words they used, and most users type these in their own language. Ranks whole transcripts with BM25 over prompts, answers, reasoning, tool calls and tool output, so an exact identifier, an error string, or a vague paraphrase all work. Runs entirely on local files with no API calls and no network.
---

# ccfind

Full-text search over the local transcripts in `~/.claude/projects/`.

This skill is user-invocable: `/ccfind:ccfind <query>` runs it with the query as
the arguments, so there is no separate slash command to keep in step with it.

`--resume` matches a session by id or name only, and `/insights` writes a report
rather than answering a question. Neither one finds the session where a specific
thing was discussed. This does.

## How to run it

Everything happens in one Node process. Two commands, in this order.

```bash
node <skill-dir>/scripts/ccfind.mjs index
node <skill-dir>/scripts/ccfind.mjs search "<query>" --limit 12 --json
node <skill-dir>/scripts/ccfind.mjs show <session-id> --json      # one session's turns
node <skill-dir>/scripts/ccfind.mjs open <session-id>             # new window on it
```

`pick "<query>"` also exists: an arrow-key list that runs `claude --resume` on
Enter. It needs a real terminal, so **never run it yourself** - a tool call has no
tty and it would just print the list. Suggest it to the user instead, and if they
have no `ccfind` command yet, `install` puts one on their PATH (`uninstall`
undoes it). Run `install` only when the user asks for a terminal command; it
writes outside the plugin directory.


If either command fails with `node: command not found`, stop and tell the user
that ccfind needs Node 18+ on `PATH` and that Claude Code's native installer
does not provide it. Do not fall back to reading transcripts by hand.

`index` is idempotent and cheap: it prints `index up to date` and exits when
nothing changed, and a full rebuild of a 90 MB corpus takes about 2 seconds.
Inside a live session the current transcript is always growing, so that skip
will rarely fire and each search normally pays the ~2 s rebuild once.
Always run it before searching so a conversation from ten minutes ago is
findable. Then read the JSON from `search` and answer from it.

## Cost

Indexing and searching are local file I/O plus arithmetic - zero API calls,
zero tokens. The only model work is you reading a small JSON result and writing
a short answer. A `--limit 8 --json` result is a few kilobytes.

**Do not separately Read any `*.jsonl` transcript files.** They are large, and
the snippet in each hit already contains the matching text. If a hit needs more
context, re-run `search` with `--session <id>` and a narrower query, or tell the
user the `resume` command from the hit and let them jump there.

## Query options

| Flag | Effect |
| --- | --- |
| `--limit N` | number of hits (default 10) |
| `--group session\|exchange` | one hit per session (default) or per user turn |
| `--project SUBSTR` | restrict to a project directory or cwd |
| `--session ID` | restrict to one session (id prefix is enough) |
| `--days N` | only sessions touched in the last N days |
| `--field title\|prompt\|answer\|thinking\|tool\|output\|summary` | search only that field |
| `--exclude ID[,ID...]` | drop sessions from results |
| `--self` | allow the current session to appear (it is excluded by default) |
| `--all` | keep the weak matches the relevance gate hides |
| `--json` | machine-readable output - use this |

`show <id>` takes `--turns N` (default 40) and `--json`. It lists a session's user
turns in order, so a hit can be understood without opening the transcript.

Useful narrowings: `--field prompt` finds where the *user* raised something,
`--field output` finds a command's actual output, `--group exchange` pinpoints
the turn rather than the conversation.

## Reading a hit

```json
{
  "relevant": 4, "weak": 19, "total": 23,
  "hits": [{
    "score": 22.65, "coverage": 1, "chunks": 160, "turns": 14,
    "title": "cluster-setup", "session": "a1b2c3d4-...", "project": "-home-me-infra",
    "cwd": "/home/me/infra", "branch": "main",
    "when": "2026-07-28T06:26:...", "prompt": "registry mirror not picked up by containerd",
    "opening": "bringing up a fresh single-node cluster on 10.0.0.4",
    "field": "tool", "snippet": "...", "resume": "claude --resume a1b2c3d4-..."
  }]
}
```

- `title` is the session's name (`/rename`) or the model-written one; fall back
  to `project` when it is null.
- `prompt` is the user turn the match hangs off - quote it, it is what the user
  will recognise.
- `coverage` is the fraction of the query's words present. `1` means every word
  was found somewhere in that session; a low value means a partial match.
- `field` says where the match landed. `prompt` or `answer` means it was
  discussed; `tool` or `output` means it appeared in a command or its output.
- `opening` is the turn the session *started* from - the cheapest one-line
  description of what it was about. Null when it is the matching turn itself.
- `turns` is how many user turns the session has: a 40-turn session is a project,
  a 2-turn one is a question.
- `open` is `/resume <id>` - typed in this window it switches to that session in
  place. `resume` is `claude --resume <id>`, which starts a separate run instead.
- `relevant`, `weak` and `total` (top level). BM25 scores every session holding
  a single query word, so `total` is wide and mostly noise. The relevance gate
  keeps the hits scoring within 25% of the top one - `relevant` - and hides the
  rest as `weak`. `hits` therefore never exceeds `relevant`, and the top hit is
  always kept. `--all` returns the whole tail if the user wants the mentions
  themselves.

## Answering

Terse, and legible in a terminal. The question is *which session*.

A markdown table, one row per hit. The headers are what makes it readable - a
bare column of numbers leaves the user guessing what `169` meant.

| # | Session | Date | Project | id | Requests | Matched |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | registry mirror | 08-06 | infra | `a1b2c3d4` | 169 | "containerd ignores the mirror" |
| 2 | node bootstrap | 08-06 | infra | `b2c3d4e5` | 6 | "kubelet never registers, cert ..." |
| 3 | secret sync | 08-05 | infra | `c3d4e5f6` | 30 | "'API_TOKEN', 'BROKER_URL' mis..." |

`Requests` is the `turns` field: how many things the user asked for in that
session. Translate the headers when answering in another language, and translate
them - never transliterate. An English header respelled in the user's alphabet is
not a word in their language and tells them nothing; the real word for it is.
Every header names the thing a column counts, so it stays a noun: a past
participle - `Asked` turned into Russian as "Спрошено" - reads as a verb about
nobody and leaves the user guessing what the numbers are. The word for
"requests" is what that column means.

Rules:

- no preamble. Not "I ran a search and found" - the table first.
- **every hit the search returned**, not the best three. `--limit 12` asks for
  twelve because the user wants the whole field; answering a twelve-hit search
  with three rows hides nine sessions. Trim cells, never drop rows.
- keep the table from wrapping: title to ~18 chars, the `Matched` cell to ~55,
  cut with `...`. A wrapped table is worse than a trimmed one.
- that fragment is verbatim from `snippet`. Never paraphrase a snippet into
  something the transcript did not say.
- id in backticks, 8 characters - but **only** in that column. Any line the user
  has to type or copy carries the whole id.
- after the table, the recommendation gets its own visual break. It is the one
  line the user acts on, so it must not read as a footnote to the table:

  ```
  **Open this one: secret sync** - where the sync was actually fixed

  /resume c3d4e5f6-7a8b-4c9d-8e0f-112233445566
  ```

  Bold label, one clause of why, then the session's `open` field on its own
  line - copied **byte for byte** from the JSON. Never shorten it, never write
  `/resume c3d4e5f6-...`: a truncated id is not something the user can type, so
  an abbreviated line is a broken line. Terse output style does not license
  trimming an identifier. `/resume <id>` is a built-in slash command: typed in this window it
  switches to that session in place. That is what the user means by "open it",
  so it is the line that must be easy to find. `claude --resume` (the `resume`
  field) is the terminal variant - mention it only if they are in a terminal.
- the withheld count goes on its own plain line when `relevant` exceeds the rows.
- **the two counts are already computed - use them, do not restate them in
  prose.** One line after the table: `4 relevant of 23 matched; 19 were weak`.
  Never write your own verdict on the weak ones ("the rest are partial matches",
  "only #1 covers every word") - the gate measured that, and a sentence guessing
  at it from the table is a guess. If you narrow the rows further yourself - only
  one project, only `coverage: 1` - say so with both numbers, because a bare
  "4 sessions" hides the ones the user never learns about.
- **Answer in the user's language, whatever it is.** This file is written in
  English and its examples are English; that is the file's language, not a
  default for the answer. Match the language of their own messages and answer
  wholly in it - table headers, the recommendation, the picker options.
- keep whatever output style the session is running. A terse style stays terse
  here too - the table stays a table either way.
- if `coverage` is well below 1 on every hit, or `relevant` is 1 with a large
  `weak`, one line saying the match is thin beats a confident guess.

## Letting the user pick

The block is text - the user cannot select in it. So **always** end a session
search with an `AskUserQuestion` picker; that is the only arrow-key selection
the chat has. Not "when it seems useful" - always.

`AskUserQuestion` takes **four options, hard cap** (harness limit, not ours), so
page through the hits three at a time:

- options 1-3: the next three hits. Label = session title, description = date,
  project, and the `opening` turn.
- option 4: `next 3 (4-6 of 13)`, in the language of the answer - naming the
  range, so the user can see the arrows reach the whole list. Re-ask with the
  next three when they take it. Only on the last page does option 4 become a
  plain *show all N* dump.

Whatever they pick, run `show <id> --json` and **answer their original question
from it** - not a summary of the session for its own sake. Terse: what that
session concluded about the thing they asked, and where in it that sits. Then
they can keep asking about it here, which is the point: the session's content is
now in this conversation.

Then **open it**, because that is what picking is for. Two things, both:

```bash
node <skill-dir>/scripts/ccfind.mjs open <session-id>
```

`open` launches a new terminal window on that session (`claude --resume`, in the
session's own cwd - tmux window if they are in tmux, iTerm/Terminal on macOS, the
installed emulator on Linux). It returns as soon as the window is up, so it never
holds the tool call open for the life of that window.

**Run it immediately after the pick, without asking.** Not "shall I open a window
on it?" - picking a session *is* the request to open it, and asking costs the
user another turn to say yes. Then one clause saying which window opened.

And still give the last line: **`/resume <full-id>`** - the `open` field
verbatim, all 36 characters, no ellipsis. That is the built-in slash
command; typed in *this* window it switches this conversation to that session
instead of opening a second one. A skill cannot type it for them - no tool
switches the active session - so hand them the line every time. `open` for a new
window, `/resume` to switch here: never end a pick without both. Arrow keys over *every* hit, with Enter that really hands the
terminal to `claude --resume`, exist in one place only: `ccfind pick "<query>"`
in a terminal. Recommend it when the list is long.

## Notes

- `sidechain: true` marks a subagent transcript rather than the main thread.
- Injected context (system reminders, hook output, slash-command wrappers) is
  stripped before indexing, so hits are on real conversation.
- Images, encrypted advisor payloads, and thinking signatures are not indexed.
- Tool output is indexed up to 16 KB per result; a huge dump is truncated.
- The index lives in `~/.claude/ccfind/` and never leaves the machine. If the
  user sets `CLAUDE_CONFIG_DIR`, both the corpus and the index follow it;
  `CCFIND_CONFIG_DIR` overrides just ccfind.
