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
node <skill-dir>/scripts/ccfind.mjs search "<query>" --limit 8 --json
```

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

Useful narrowings: `--field prompt` finds where the *user* raised something,
`--field output` finds a command's actual output, `--group exchange` pinpoints
the turn rather than the conversation.

## Reading a hit

```json
{
  "score": 22.65, "coverage": 1, "chunks": 160,
  "title": "cluster-setup", "session": "a1b2c3d4-...", "project": "-home-me-infra",
  "cwd": "/home/me/infra", "branch": "main",
  "when": "2026-07-28T06:26:...", "prompt": "registry mirror not picked up by containerd",
  "field": "tool", "snippet": "...", "resume": "claude --resume a1b2c3d4-..."
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
- `resume` is the exact command to jump back in.

## Answering

Lead with the session that answers the question, quote the snippet that proves
it, and give the `resume` command. Two or three hits is usually enough - do not
paste the whole result set. If `coverage` is well below 1 on every hit, say the
match is weak instead of presenting a guess as an answer.

## Notes

- `sidechain: true` marks a subagent transcript rather than the main thread.
- Injected context (system reminders, hook output, slash-command wrappers) is
  stripped before indexing, so hits are on real conversation.
- Images, encrypted advisor payloads, and thinking signatures are not indexed.
- Tool output is indexed up to 16 KB per result; a huge dump is truncated.
- The index lives in `~/.claude/ccfind/` and never leaves the machine.
