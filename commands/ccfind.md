---
description: Search past Claude Code sessions for a topic and show which conversation to resume
argument-hint: <what to look for>
---

Search the user's past sessions for: **$ARGUMENTS**

Use the `ccfind` skill. Run the indexer, then the search, and answer from the
JSON:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/ccfind/scripts/ccfind.mjs" index
node "$CLAUDE_PLUGIN_ROOT/skills/ccfind/scripts/ccfind.mjs" search "$ARGUMENTS" --limit 12 --json
```

Answer with a markdown table, one row per hit: `#`, session title, MM-DD,
project, 8-char id in backticks, turn count, and the shortest verbatim fragment
that proves the match. Headers in the user's language. List **every** hit the
search returned, not the best three; if `total` is higher, say how many are
unshown on its own line. Then a bold recommendation line with one clause of why,
and its `claude --resume` command alone in a fenced `bash` block. Do not read
any `*.jsonl` files directly.

Then offer the top three through `AskUserQuestion` plus a "show all N" option,
and run `show <id> --json` on whichever is picked.
