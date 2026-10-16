# Punchlist

A shared, live TODO board for each repo that keeps itself up to date. See [PRD.md](PRD.md).

**Built so far:**
- The web board (design 1b, "Warm board", dark) on a Cloudflare Worker with one Durable Object per board. Two browsers stay in sync for drag, edit, notes, claims, presence, history and undo.
- GitHub sign-in. Each repo with the Punchlist GitHub App installed gets a board, and who can see or change it follows their access to the repo.

- The `punch` CLI ([cli/README.md](cli/README.md)): GitHub device-flow login, the board for the repo you're in, offline reads and an outbox.

**Not built yet:** the Claude Code plugin, `punch import`, and push/PR webhooks for auto-close.

## Run it

```sh
nvm use                       # Node 22 (Vite 8 and wrangler need it)
npm install
cp .dev.vars.example .dev.vars  # DEV_MODE=1: dev identity, sample boards, simulated GitHub closes
npm run dev                   # applies local D1 migrations, then http://localhost:5173
```

- **Pick who you are per tab** with `?as=nick`, `?as=aaron` or `?as=kevin`. Open two tabs as two people to see live sync and presence.
  - Kevin can only *view* big-talk, so `?as=kevin` shows the read-only board.
  - Aaron can't see bulletin-bee at all.
- **Sample data.** In dev, the sample boards and people are seeded into the local D1 database, and each board is filled from the design mock the first time it's opened. To reseed, `rm -rf .wrangler/state && npm run dev`.
- **Try the live "punch" moment** by simulating a merged PR:
  ```sh
  curl -X POST localhost:5173/v1/boards/futureleisurefoundation/big-talk/dev/gh-close \
    -H 'content-type: application/json' -H 'X-Punch-Dev-User: aaron' \
    -d '{"id":"BT-014","pr":41,"author":"aaron"}'
  ```
- **Other pages:** `/me` is My work. `/_states` (dev only) is the card-states gallery used for visual QA.
- **Real GitHub sign-in locally:** once the App exists (below), its settings are in `.dev.vars`. Set `DEV_MODE=0` there and sign in at http://localhost:5173.

## The CLI

```sh
npm run build:cli && node cli/dist/punch.mjs --help
```

- **Locally, as two people:** each shell gets its own `PUNCH_HOME`, and logs in against the dev server with a sample person:
  ```sh
  PUNCH_HOME=/tmp/nick  node cli/dist/punch.mjs login --dev nick  --url http://localhost:5173
  PUNCH_HOME=/tmp/aaron node cli/dist/punch.mjs login --dev aaron --url http://localhost:5173
  ```
- **Publishing:** `npm run build:cli`, then `cd cli && npm publish`.

## How sign-in and access work

- **Sign-in.** The only way in is GitHub, through the App's user authorization. The CLI uses GitHub's device flow, which the Worker runs, and gets a Punchlist API token: one per machine, stored hashed, and revocable (`punch logout`, or `DELETE /v1/me/tokens/:id`).
  - The session is a random token in an HttpOnly cookie, stored only as a hash. It rolls forward for 90 days while it's used.
  - A browser that has signed in before goes back through GitHub on its own when the session ends.
  - No GitHub token is stored.
- **Boards** come from App installations, through the webhook plus a reconcile after install and at sign-in. A board is keyed by GitHub repo id, so renames keep it. Uninstalling archives the board. Only accounts in `ALLOWED_OWNERS` (wrangler.jsonc) get boards.
- **Access.** The App checks each person's repo permission:

  | Repo permission | On the board |
  |---|---|
  | write or admin | edit |
  | read | view only |
  | none | 404 |

  A role is re-checked once it's 10 minutes old.

## Deploy

CI deploys on every merge to `main` (`.github/workflows/deploy.yml`). First-time setup:

1. **Cloudflare token.** Create an API token on Nick's account with *Workers Scripts: Edit* and *D1: Edit*. Add it to this repo's secrets as `CLOUDFLARE_API_TOKEN`.
2. **First deploy.** Merge to `main`, or run the workflow by hand. The deploy log prints the `workers.dev` URL. Until the App exists, the site only shows the sign-in page.
3. **GitHub App.** Run:
   ```sh
   node scripts/create-github-app.mjs https://punchlist.<subdomain>.workers.dev
   ```
   Then click Create on GitHub, and follow its printed steps:
   - `npx wrangler secret bulk .github-app.secrets.json`
   - install the App on the repos
   - commit the updated `GITHUB_APP_SLUG`

## Layout

| Path | What |
|---|---|
| `shared/` | Data model (`types.ts`) and the pure `applyOp`. The Durable Object runs `applyOp` to decide each change; the browser runs the same code for optimistic updates. |
| `worker/index.ts` | Routes: `/v1` (REST and WebSocket), `/auth` (sign-in), `/github` (webhook, post-install). Everything else is static assets. |
| `worker/board.ts` | `BoardDO`: SQLite items and event log, hibernating WebSockets, undo, catch-up after reconnect. |
| `worker/auth.ts`, `worker/github.ts`, `worker/directory.ts` | Sessions; the GitHub App (JWT, installation tokens, permission checks); the D1 board directory and roles. |
| `migrations/` | D1 schema: users, sessions, boards, access, API tokens. |
| `cli/` | The `punch` CLI (npm `@nnewberg/punchlist`), bundled with the shared board code into one file. |
| `web/` | React app. `boardClient.ts` is the live store; `components/` holds the UI. |
| `test/` | Vitest in the Workers runtime (`npm test`), with GitHub faked for sign-in and access. |

## Checks

```sh
npm test && npm run typecheck && npm run build && npm run build:cli
```
