# Punchlist plugin for Claude Code

Claude keeps your repo's shared [Punchlist](https://punchlist.nnewberg.workers.dev) board current:
- it adds items when you ask, checking for duplicates first
- it claims an item before working on it, and warns you when someone else has it
- it files work it leaves for later
- it starts every session knowing the board

## Install

**To set up a repo**, open it in Claude Code and paste this:

```text
Set up Punchlist for this repo. Run `claude plugin marketplace add nnewberg/punchlist` (fine if it's already added), then `claude plugin marketplace update punchlist`. Then run `claude plugin marketplace list --json`, take the installLocation of the punchlist marketplace, and run `<installLocation>/plugins/punchlist/bin/punch setup`. Do the one next step it prints, then run it again, until it says "Setup complete". Ask me before committing anything.
```

`punch setup` signs you in, gets the repo a board, turns the plugin on in `.claude/settings.json`, adds the CLAUDE.md pointer, and offers a PR. `/punch setup` runs it again any time, and `punch setup --check` is the health check.

**In a repo that already offers it**, pull main and open the repo in Claude Code. Approve the plugin when it asks, and sign in once when Claude offers.

**To use `punch` in a terminal too**, run `punch setup --link`. It links the plugin's own `punch` into `~/.local/bin`, so the terminal runs the same version.

Requirements:
- Node.js 20 or later, anywhere on the machine. The plugin finds it itself (on PATH, or from nvm, fnm, Volta, asdf or Homebrew) and installs the `punch` CLI it needs into its own data folder the first time it runs.
- The repo needs the Punchlist Board GitHub App installed, which is what gives it a board.

## What's in it

| Part | What it does |
|---|---|
| `SessionStart` hook | Puts the house rules (`rules.md`) and the compact board into Claude's context. It also tells Claude's shell which session it is, so the board records each change as this session. |
| `UserPromptSubmit` / `Stop` hooks | Keep this session's claims alive. They send at most one heartbeat every 5 minutes, in the background. |
| `SessionEnd` hook | Releases this session's claims. If a session dies without it, its claims lapse after 2 hours. |
| `punchlist` skill | How Claude uses the board: duplicate checks, claims, deferred work, notes, `Closes:` and `Refs:` trailers, sign-in. |
| `/punch` | `/punch`, `/punch add <text>`, `/punch start <ID>`, `/punch done <ID> [note]`, `/punch block <ID> <reason>`, `/punch login`. |
| `bin/punch` | Runs the CLI version this plugin was built for (`cli-version`). |

## Developing it

To run Claude with this checkout's plugin and CLI:

```sh
npm run build:cli
PUNCH_CLI=$PWD/cli/dist/punch.mjs claude --plugin-dir plugins/punchlist
```

When the plugin needs a new CLI:
1. Publish the CLI.
2. Bump `cli-version`.

Bump `version` in `.claude-plugin/plugin.json` whenever anything in this folder changes. Teammates' Claude Code updates the plugin when that number changes; without it, every commit to this repo (even one that only touches the Worker) would count as a plugin update.
