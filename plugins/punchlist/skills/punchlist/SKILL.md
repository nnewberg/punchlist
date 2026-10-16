---
name: punchlist
description: How to use this repo's shared Punchlist TODO board through the `punch` CLI. Covers adding items with a duplicate check, claiming before work, filing deferred work, notes, closing trailers in commits, and signing in. Use it whenever the user mentions the todo list, todos, the punchlist or an item ID like BT-014, and whenever you start, defer or finish work that's on the board.
---

# Punchlist

This repo's TODOs live on a shared board that everyone on the repo sees live, in a browser and in their own Claude sessions. You change it only through the `punch` CLI. Never edit files to track work: no TODO.md, no status lines in docs or CLAUDE.md. Your own task list is private scratch space and never stands in for the board.

Every `punch` command you run is recorded as this Claude session, under the signed-in person's name. Add `--json` when you need to parse the output.

## Reading the board

The board was put in your context when the session started.

| To see | Run |
|---|---|
| The board again | `punch list --compact` |
| One item, with notes and history | `punch show ID` |
| One column | `punch list --status next` (or `backlog`, `progress`, `done`) |
| What the person holds on every board | `punch mine` |

IDs can be typed loosely: `bt-14` is `BT-014`.

## Adding items

Add an item when the user asks ("add X to the todo list", "put that on the punchlist"). Before adding, check for a duplicate:

1. Run `punch search "<three to six key words>"`.
2. If a match is the same piece of work, don't add. Record the request as a note on it instead, so the board shows it came up again, with whatever it adds: who asked, why, how urgent, new detail. For example: `punch note ID "Asked again: invites are getting hammered"`. Then tell the user which item already covers it. That includes a recent Done item, if the work has come back.
   - A similar topic isn't enough. "Rate-limit the invite endpoint" and "rate-limit the login endpoint" are two items, and so is the same fix for a different service, screen or scope.
   - When you're unsure, add the new item and mention the similar one ("Added PS-41; PS-16 looks related").
3. Otherwise run `punch add "<short imperative title>"`. Use `-b "<details>"` for context worth keeping, and `-s next` only if the user says it's next.

Write titles the way a teammate would scan them: "Rate-limit the invite endpoint", not "the thing Nick mentioned".

Items the user merely mentions in passing ("we should probably also…") are theirs to decide on. Ask whether to add them instead of adding them yourself.

## Work you leave for later

Work that's left undone for later must not vanish. File it when:
- you leave part of a task undone ("I'll leave the retry logic for later")
- you spot a follow-up and don't do it
- the user says to leave part of what they asked for until later ("…but leave the README for later")

File it like this:

```sh
punch add --deferred "Retry failed uploads with backoff" -b "Left from <what you were doing>: <why>"
```

Run `punch search` first, as above. Then tell the user in one line, for example: "Filed PS-041 for the retry logic."

## Claiming before work

Before substantial work on an item (more than a quick look or a one-line answer), claim it:

```sh
punch start ID
```

- **It succeeds.** The item moves to In Progress, held by this session. Everyone sees it.
- **Someone else has it.** `punch start` fails with `<Name> already has ID`. Stop and tell the user who has it. Don't start the work, and don't take it over unless the user says so. Then use `punch start ID --steal`, which is logged.
- **"Your other Claude session has ID".** The same person already has a session on it. Tell the user and ask before stealing.
- **It's held by the user's own branch.** The claim stays the branch's. That's fine; carry on.

The claim lasts while this session is in use. It's released when the session ends, and lapses after 2 hours with no activity. If you stop working on an item before then without finishing it, run `punch release ID`.

## Notes

Add a note on your own when you learn something a teammate picking up the item would want:
- a root cause
- a blocker
- a decision and its reason
- partial progress ("server half done; client still to do")

```sh
punch note ID "Root cause: the invite handler retries on 429, which doubles the load."
```

Keep notes sparse, a note or two per session, not a running log. Notes never change status.

## Finishing work

Items close themselves when the fix lands on the default branch, through GitHub. When the user asks you to commit, cite the item in the commit message:

- `Closes: ID` (or `Fixes:` / `Resolves:`) for work that finishes it. Several IDs are fine: `Closes: BT-014, BT-017`.
- `Refs: ID` for partial progress. That adds a note and keeps the item open.

Never commit, push or create a branch just to update the board; board changes don't need git. Commit only when the user asks.

## Leave decisions to people

Do these only when the user asks:
- close an item without a commit: `punch close ID -m "why"`
- move or reprioritize: `punch move ID next --top`
- delete: `punch drop ID`
- edit or close someone else's item
- take over someone else's claim (`--steal`)

Blocking is a status report, so you may `punch block ID "<reason, naming who or what>"` when you're truly stuck on something outside your control. Say so.

## Signing in

If the session start said punch isn't signed in, or a command says "Not signed in":

1. Run `punch login --start`. It opens GitHub in the browser and prints a code.
2. Tell the user the code and the URL, and ask them to enter it.
3. Run `punch login --finish` with a Bash timeout of 10 minutes (600000 ms). It returns once they've approved.

If a command says there's no board for the repo, the Punchlist Board GitHub App isn't installed on it, or the user lacks access. Tell them once, and don't keep trying.

## Offline

If `punch` can't reach the server, reads show the last saved copy of the board, and changes queue and go out with the next command. Mention it once if it happens; there's no need to retry.
