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

Report the two or three sessions that actually answer it: title, date, project,
the user turn it hangs off, the matching snippet, and the `resume` command. Then
list every other hit on one line each, and if `total` is higher than the hits you
were given, say how many are still unshown. Do not read any `*.jsonl` files
directly.

If several hits are equally plausible, offer them through `AskUserQuestion` and
run `show <id> --json` on the one picked.
