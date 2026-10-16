# punch

The command line for [Punchlist](https://punchlist.nnewberg.workers.dev): a live, shared TODO board for each repo.

```sh
npm i -g @nnewberg/punchlist
punch login            # signs in with GitHub (device code)
cd your-repo
punch list --compact   # the board for this repo, found from `origin`
```

| Command | |
|---|---|
| `list [--compact] [--status s] [--mine] [--all]` | the board; `--compact` is the agent view |
| `show ID` | one item, with notes and history |
| `add "title" [-b body] [-s status] [-t tag] [--deferred]` | add an item; `--deferred` marks work Claude left for later |
| `edit ID [--title "title"] [-b body \| --body-file path]` | retitle it or replace its description (`--body-file -` reads stdin). If someone changed the description since you read it, nothing is saved and you're told who |
| `search "words"` | the closest items, including Done in the last 30 days (the duplicate check) |
| `move ID status [--top \| --before ID]` | move it |
| `start ID [--steal]` / `release ID` | claim it, or give it back |
| `block ID reason` / `unblock ID` | |
| `close ID [-m note]` / `reopen ID` | |
| `note ID text` | add a note |
| `drop ID` | delete it (stays searchable; `reopen` brings it back) |
| `mine` | what's yours across every board |
| `open [ID]` | open the board in the browser |
| `export [-o file]` | the board as JSON |
| `import FILE [--yes]` | add items from an import file (Punchlist's item shape, IDs kept), after a dry run |
| `init` | point this repo's CLAUDE.md at the board |
| `login [--start \| --finish]` | sign in with GitHub; in two steps with `--start` and `--finish` (how Claude does it) |
| `logout` / `whoami` | |
| `hook session-start \| heartbeat \| session-end` | run by the Claude Code plugin's hooks |

- Every command takes `--json`, and `--board owner/repo` to work outside a clone.
- IDs can be typed loosely: `bt-30` is `BT-030`.
- **Agents:** set `PUNCH_SESSION=<id>` (or pass `--session`), and changes are recorded as that Claude session. The Claude Code plugin does this for you. A claim made in a session lasts while the session's hooks keep sending heartbeats, and lapses 2 hours after the last one.
- **Offline:** reads use the last copy of the board, and changes wait in an outbox until the next command can send them.
- **Token storage:** in the OS keychain, or in a private file where there's no keychain. `PUNCH_HOME` moves config, cache and token, for example to be a second person in another shell.
