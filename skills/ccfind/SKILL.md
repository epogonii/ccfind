---
name: ccfind
description: Search the user's own past Claude Code sessions by content and report which conversation discussed a thing, when, in which project, and how to resume it. Use this whenever the user asks about something from an earlier session rather than the current one - "where did we", "which session was that", "we already fixed this", "what was that command", "did I ask about X before", "find the conversation about", "remind me how we solved", "search my history", "поищи в прошлых сессиях", "в какой сессии", "мы это уже делали" - or invokes /ccfind. Ranks whole transcripts with BM25 over prompts, answers, reasoning, tool calls and tool output, so an exact identifier, an error string, or a vague paraphrase all work. Runs entirely on local files with no API calls and no network.
---

# ccfind

Full-text search over the local transcripts in `~/.claude/projects/`.

`--resume` matches a session by id or name only, and `/insights` writes a report
rather than answering a question. Neither one finds the session where a specific
thing was discussed. This does.

## How to run it

Everything happens in one Node process. Two commands, in this order.

```bash
node <skill-dir>/scripts/ccfind.mjs index
node <skill-dir>/scripts/ccfind.mjs search "<query>" --limit 12 --json
node <skill-dir>/scripts/ccfind.mjs show <session-id> --json      # one session's turns
```

`pick "<query>"` also exists: an arrow-key list that runs `claude --resume` on
Enter. It needs a real terminal, so **never run it yourself** - a tool call has no
tty and it would just print the list. Suggest it to the user instead.


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
| `--json` | machine-readable output - use this |

`show <id>` takes `--turns N` (default 40) and `--json`. It lists a session's user
turns in order, so a hit can be understood without opening the transcript.

Useful narrowings: `--field prompt` finds where the *user* raised something,
`--field output` finds a command's actual output, `--group exchange` pinpoints
the turn rather than the conversation.

## Reading a hit

```json
{
  "total": 8,
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
- `resume` is the exact command to jump back in.
- `total` (top level) is how many sessions matched, which is usually more than
  `--limit` returned.

## Answering

Terse. The question is *which session*, not an essay about searching.

Default shape - the two or three that answer it, one line each, then the rest as
one line each, then a count:

```
1. Fix NuGet dependency resolution   08-04  acme-api   12.2  e5f6a7b8
   "падает restore пакетов в CI" -> buildUrl .../job/acme-api/470/
2. ...
+ 20 more, weaker: registry mirror 08-10, ansible 07-31, mcp 08-05, ...
```

Rules:

- no preamble. Not "I ran a search and found" - just the hits.
- one quoted fragment per hit, the shortest that proves it, verbatim from
  `snippet`. Never paraphrase a snippet into something the transcript did not say.
- the first 8 characters of the session id are enough to resume with; print the
  whole `claude --resume` line only for the one you are recommending.
- state what is not shown in a clause, not a paragraph: `+ 20 more`. Never let
  `total` be larger than what you listed without saying so.
- report `total` as it comes back. If you narrow it further yourself - only the
  `coverage: 1` hits, only one project - give both numbers (`8 of 23 with every
  word`), because a bare "8 sessions" hides the 15 the user never learns about.
- a full table only when the user asks to see all of them.
- match the user's language, and whatever output style the session is running. A
  terse style stays terse here too.
- if `coverage` is well below 1 on every hit, one line saying the match is weak
  beats a confident guess.

## Letting the user pick

Always end a session search with an `AskUserQuestion` picker rather than asking
the user to copy an id or open a terminal: the top three sessions plus a *"show
all N"* option. Not "when it seems useful" - always, because arrow keys in the
chat are the only selection the user has, and a printed id costs them a copy, a
window switch and a lost train of thought. Label = session title, description = date,
project, and the `opening` turn. The picker takes four options at most, which is
why the fourth one is the escape hatch to the full list.

Whatever they pick, run `show <id> --json` and **answer their original question
from it** - not a summary of the session for its own sake. Terse: what that
session concluded about the thing they asked, and where in it that sits. Then
they can keep asking about it here, which is the point: the session's content is
now in this conversation.

Be straight about the limit: **you cannot switch the active session for them.**
`claude --resume` starts a separate run, and no skill can move this conversation
into another one. Picking pulls that session's content in here, which keeps the
work in progress. For the real jump, there is `claude --resume <id>` - or
`ccfind.mjs pick "<query>"` in a terminal, which is an arrow-key list that hands
the terminal straight to `claude --resume` on Enter.

## Notes

- `sidechain: true` marks a subagent transcript rather than the main thread.
- Injected context (system reminders, hook output, slash-command wrappers) is
  stripped before indexing, so hits are on real conversation.
- Images, encrypted advisor payloads, and thinking signatures are not indexed.
- Tool output is indexed up to 16 KB per result; a huge dump is truncated.
- The index lives in `~/.claude/ccfind/` and never leaves the machine.
