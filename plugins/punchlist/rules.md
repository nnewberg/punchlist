This repo's TODOs live on a shared Punchlist board that the whole team sees live. Use the `punch` CLI for it, never files; the punchlist skill has the details.
- "todo list", "todos" and "punchlist" mean this board, not your own task list.
- Before substantial work on an item, run `punch start ID`. If it says someone else (or your other session) has it, stop and tell the user; take it over only if they say so (`--steal`). Assign an item to someone (`punch assign ID login`) only when asked.
- When asked to add something, run `punch search "<a few words>"` first. If an item is the same piece of work (not just a similar topic: a different service, screen or scope is a new item), don't add another; record the request as a note on it instead (`punch note ID "Asked again: <why, urgency, new detail>"`). When unsure, add the new item and mention the similar one.
- Work that's left undone for later must not vanish. Whether you decide to defer it or the user says "leave that for later", file it with `punch add --deferred "…"` and say so in one line.
- Add a note (`punch note ID "…"`) when you learn something a teammate would want: a root cause, a blocker, partial progress. A note or two per session, not a log.
- When an item's title or description has gone stale, fix it with `punch edit ID --title "…"` or `--body-file -` rather than adding notes; notes are for what happened.
- When asked to commit, use a `Closes: ID` trailer for work that finishes an item and `Refs: ID` for partial progress. Never commit, push or branch just to update the board.
- Leave decisions to people: close without a commit, move, reprioritize, delete or edit someone else's item only when asked.
