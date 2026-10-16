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
| `add "title" [-b body] [-s status] [-t tag]` | add an item |
| `move ID status [--top \| --before ID]` | move it |
| `start ID [--steal]` / `release ID` | claim it, or give it back |
| `block ID reason` / `unblock ID` | |
| `close ID [-m note]` / `reopen ID` | |
| `note ID text` | add a note |
| `drop ID` | delete it (stays searchable; `reopen` brings it back) |
| `mine` | what's yours across every board |
| `open [ID]` | open the board in the browser |
| `export [-o file]` | the board as JSON |
| `init` | point this repo's CLAUDE.md at the board |
| `login` / `logout` / `whoami` | |

- Every command takes `--json`, and `--board owner/repo` to work outside a clone.
- IDs can be typed loosely: `bt-30` is `BT-030`.
- **Agents:** set `PUNCH_SESSION=<id>` (or pass `--session`), and changes are recorded as that Claude session.
- **Offline:** reads use the last copy of the board, and changes wait in an outbox until the next command can send them.
- **Token storage:** in the OS keychain, or in a private file where there's no keychain. `PUNCH_HOME` moves config, cache and token, for example to be a second person in another shell.
