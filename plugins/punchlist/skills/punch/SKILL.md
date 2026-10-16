---
name: punch
description: Show or change this repo's shared Punchlist board. Usage - /punch, /punch add TEXT, /punch start ID, /punch done ID [note], /punch block ID REASON, /punch login
argument-hint: "[add TEXT | start ID | done ID [note] | block ID REASON | login]"
allowed-tools: Bash(punch *)
disable-model-invocation: true
---

The user typed `/punch $ARGUMENTS`. Do the matching action below with the `punch` CLI, then reply in a line or two. Follow the punchlist skill's rules.

| What they typed | What to do |
|---|---|
| nothing | Run `punch list --compact` and show it as is. |
| `add <text>` | Run `punch search "<key words of text>"`. If an item is clearly the same work, run `punch note ID "<text>"` on it instead, and say which item. Otherwise run `punch add "<text as a short title>"` and give the new ID. |
| `start <ID>` | Run `punch start <ID>`. If someone else holds it, say who, and don't steal unless they say so. Then ask whether to begin the work. |
| `done <ID> [note]` | Run `punch close <ID> -m "<note>"` (leave off `-m` if there's no note). This closes it by hand, which they've asked for. |
| `block <ID> <reason>` | Run `punch block <ID> "<reason>"`. |
| `login` | Run `punch login --start`. It opens a GitHub page in their browser; tell them so, with the code to enter there and the URL in case no page opened. Then run `punch login --finish` with a 10-minute Bash timeout, and say who is now signed in. |
| anything else | Pass it straight through as `punch <their words>`. For example, `/punch release PS-4` runs `punch release PS-4`. |

Commands print a plain-text summary, and you can show it as is. On an error, say what it means in a sentence.
