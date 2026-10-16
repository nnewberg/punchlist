# Punchlist

A shared, live TODO board for each repo that keeps itself up to date. See [PRD.md](PRD.md).

This is the first slice: the web board (design 1b, "Warm board", dark) on a Cloudflare Worker with one
Durable Object per board. Two browsers stay in sync for drag, edit, notes, claims, presence, history and undo.

**Not built yet:** GitHub sign-in, the CLI, the Claude Code plugin, webhooks and auto-close. Until GitHub
sign-in exists, the Worker only serves the board in `DEV_MODE`, so **don't deploy this**.

## Run it

```sh
nvm use                       # Node 22 (Vite 8 and wrangler need it)
npm install
cp .dev.vars.example .dev.vars  # DEV_MODE=1: dev identity, sample data, simulated GitHub closes
npm run dev                   # http://localhost:5173
```

- **Pick who you are per tab** with `?as=nick`, `?as=aaron` or `?as=kevin`. Open two tabs as two people to see live sync and presence.
- **Sample data.** In dev, `futureleisurefoundation/big-talk` and `nnewberg/bulletin-bee` are seeded from the design mock the first time they're opened. To reseed, `rm -rf .wrangler/state`.
- **Try the live "punch" moment** by simulating a merged PR:
  ```sh
  curl -X POST localhost:5173/v1/boards/futureleisurefoundation/big-talk/dev/gh-close \
    -H 'content-type: application/json' -H 'X-Punch-Dev-User: aaron' \
    -d '{"id":"BT-014","pr":41,"author":"aaron"}'
  ```
- **Other pages:** `/me` is My work. `/_states` is the card-states gallery used for visual QA. `/signin` is the signed-out page.

## Layout

| Path | What |
|---|---|
| `shared/` | Data model (`types.ts`) and the pure `applyOp`. The Durable Object runs `applyOp` to decide each change; the browser runs the same code for optimistic updates. |
| `worker/index.ts` | REST and WebSocket routes under `/v1`. Everything else is static assets. |
| `worker/board.ts` | `BoardDO`: SQLite items and event log, hibernating WebSockets, undo, catch-up after reconnect. |
| `web/` | React app. `boardClient.ts` is the live store; `components/` holds the UI. |
| `test/` | Vitest in the Workers runtime (`npm test`). |

## Checks

```sh
npm test && npm run typecheck && npm run build
```
