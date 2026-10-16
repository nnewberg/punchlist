# Punchlist plugin for Claude Code

Claude keeps your repo's shared [Punchlist](https://punchlist.nnewberg.workers.dev) board current:
- it adds items when you ask, checking for duplicates first
- it claims an item before working on it, and warns you when someone else has it
- it files work it leaves for later
- it starts every session knowing the board

## Install

**In a repo that already offers it**, open the repo in Claude Code and trust the folder; the plugin turns on by itself. Then run `/punch login` once per machine.

**To offer it in a repo**, commit this to the repo's `.claude/settings.json` (`punch init` prints it too):

```json
{
  "extraKnownMarketplaces": {
    "punchlist": { "source": { "source": "github", "repo": "nnewberg/punchlist" }, "autoUpdate": true }
  },
  "enabledPlugins": { "punchlist@punchlist": true }
}
```

**To install it for yourself**, run `/plugin install punchlist --marketplace nnewberg/punchlist`.

Requirements:
- Node.js 20 or later. The plugin installs the `punch` CLI it needs into its own data folder the first time it runs.
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
