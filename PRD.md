# Punchlist — PRD

- **Name:** Punchlist. CLI: `punch`. npm: `@nnewberg/punchlist`.
- **Status:** v0.4. M1 and M2 are built and live at https://punchlist.nnewberg.workers.dev, and M4's deterministic GitHub sync is built (§9.1 step 1). What was decided while building is in §12.
- **Date:** 2026-10-16 (v0.2: 2026-10-14)
- **Owner:** Nick
- **Source:** [Agentic TODOs Brainstorm.md](Agentic%20TODOs%20Brainstorm.md) (voice memo), plus follow-up decisions

---

## 1. Summary

Punchlist is a shared, live TODO board for each repo that keeps itself up to date.

- **One board per GitHub repo.** Everyone on the repo sees the same board in real time, the way a Google Doc works. Today that means Nick and Aaron on big-talk, and Nick and Kevin on bulletin-bee.
- **Claude Code keeps it current through a plugin:**
  - adds items when you mention them in chat
  - marks an item In Progress when an agent picks it up, and shows everyone which person and which agent has it
- **GitHub keeps it honest.** When a commit or PR resolving an item lands on the default branch, the item moves to Done and links to that commit or PR.
- **Hand edits are always possible:** in a web board (drag, add, edit), from a CLI, or by chatting with Claude.

**Architecture:**
- **Backend:** a single Cloudflare Worker deployment, with one Durable Object per board.
- **Sign-in and events:** a GitHub App.
- **Clients:** a web UI, a CLI, and a Claude Code plugin.

The board does not live in git. That deliberately departs from the memo's "it's just a file" idea, for the reasons in §5.1.

## 2. Problem

Agentic coding moves fast and in parallel: several people, each running several agents on several branches. TODO lists can't keep up.

- **Status drifts from reality.** Work ships and the list still says "Not started".
- **State spreads across several hand-kept files** that disagree with each other.
- **Teammates don't see the same picture.** Two people, or two agents, can pick up the same item without knowing.
- **Keeping the list current is manual work** that nobody does consistently, so the list loses trust and then stops being used.

### Evidence: both target repos

**big-talk** (Nick + Aaron) keeps status in four places:
- `docs/tickets/` (36 `BT-NNN` files)
- the tickets README index
- `docs/TODO.md`
- the Status section of `CLAUDE.md`

Real priority order lives only in brainstorm READMEs. Status and priority are free text. The four copies disagree: BT-008 says "Not started", but commit `cc16d77` shipped it. Assigning the next number by hand already produced a duplicate ID (BT-034).

**bulletin-bee** (Nick + Kevin) keeps work in:
- `docs/PLAN.md`: 254 lines of milestone checklists using `[ ]/[~]/[x]/[!]`
- `docs/FEEDBACK.md`: 428 lines of numbered feedback

FEEDBACK items carry hand-written cross-references like "Re-reported as #26; fixed by `b892a07`". In those references, `#N` sometimes means a feedback item and sometimes a PR.

**What both get right, and this product keeps:**
- stable IDs cited in commits, branches and code comments
- items detailed enough to hand straight to an agent
- explicit "source" and "depends on" / "blocked on" relationships

## 3. Goals and non-goals

### Goals
1. **One live board per repo for the whole team.** Any change shows up for everyone right away, and two people never see different states.
2. **No manual status upkeep.** Status follows from chat, agent activity, branches, commits and merges. Manual edits are possible but never required.
3. **One source of truth.** The web board, the CLI, the context injected into Claude and any exports all read from the same place. Nothing is a hand-kept copy.
4. **Made for agents.** Agents can read the board cheaply, claim work visibly, and close items through ordinary commits.
5. **Every change can be traced.** Every change records who made it (person, agent session or GitHub) and why (commit, PR or chat), and can be undone.
6. **Organic, not bureaucratic.**
   - No ticket-per-PR rule.
   - One commit can close several items.
   - One item can collect many commits.
   - An item's details can change over time.
7. **Works across Nick's repos.** One deployment serves several boards with different teams. Nick also gets a "My work" view across all of them.

### Non-goals (v1)
- Hosts other than GitHub. Anonymous or public boards.
- Two-way sync with GitHub Issues, Linear or other trackers.
- Notifications (email, Slack, push).
- Sub-tasks, due dates, estimates, sprints.
- Character-by-character co-editing of one item's text (see §7.2).
- A native mobile app. The web board works on a phone.
- Support for teams outside Nick's repos: self-hosting, billing, onboarding.

## 4. Users and core scenarios

**Users:**
- **Nick** works in both repos.
- **Aaron** works in big-talk.
- **Kevin** works in bulletin-bee.

All three use Claude Code, so the plugin is the main way to interact with the board, and the web board is the shared view. The CLI still works on its own, for scripts and for the times you want to skip Claude.

| # | Scenario | Expected behaviour |
|---|---|---|
| S1 | **Add by chat.** Mid-session, Nick says "add rate limiting on the invite endpoint to the todo list." | `BT-037` appears in Backlog on every open board within a second, marked as added by Nick through Claude. If a near-duplicate already exists, Claude adds a note to that item instead. |
| S2 | **Claude defers work.** Claude says "I'll leave the retry logic for later." | Claude files the item (`source: claude-deferred`) and says so in its reply. Deferred work never vanishes. |
| S3 | **Add or reorder on the web board.** Aaron drags BT-012 to the top of Up Next. | Nick's open board updates live. Nick's next Claude session already has the new priorities. |
| S4 | **Agent picks up work.** Kevin's Claude session starts on BB-031, or Kevin pushes branch `bb-031-geo-filter`. | BB-031 moves to In Progress, shown as held by "Kevin · Claude session" or "Kevin · branch bb-031-geo-filter". If Nick later asks his agent to work on BB-031, the agent warns that Kevin already has it. |
| S5 | **One merge closes two items.** A PR merged to `main` contains `Closes: BT-014, BT-017`. | Both items move to Done for everyone, each with the commit and PR linked. |
| S6 | **Fix on a branch, not merged yet.** A commit with `Closes: BB-012` is pushed to a feature branch. | The card shows "fix on `bb-012-…` (not merged)". It moves to Done when the commit lands on `main`. |
| S7 | **Commit without a reference.** A commit on `main` clearly fixes BT-009 but doesn't mention it. | The service infers the match and closes BT-009, marked "inferred" with a confidence. Anyone can reopen it in one click. |
| S8 | **Partial progress.** A commit addresses part of BB-011. | BB-011 stays open with a dated note citing the commit: "server half done in `a1b2c3d`; client still pending". |
| S9 | **Wrong close, or a revert.** Aaron reopens BT-009. Or a revert of the closing commit lands on `main`. | The item returns to its previous column. Its history keeps the close, the reopen, and who did each. |
| S10 | **New session.** A Claude session starts in either repo. | Claude receives a short summary of the board: who holds what, the top of Up Next, what's blocked, and counts. |
| S11 | **My work.** Nick opens "My work". | One list of everything Nick or his agents hold, plus his Up Next items, across big-talk and bulletin-bee. |
| S12 | **Offline.** On a plane, Nick runs `punch add …` and his agent runs `punch list`. | The read comes from a local cached copy. The add is queued and syncs on reconnect, and IDs are assigned then. |

## 5. Architecture

```
            ┌──────────── Cloudflare (Nick's account) ───────────┐
 Web board ─┤                                                    │
 (browser)  │  Worker  punchlist                                 │
   ▲  WS    │   ├─ static web UI                                 │
   │        │   ├─ REST API  (/v1/boards/:owner/:repo/…)         │
 CLI ───────┤   ├─ GitHub App webhooks  (/github/webhook)        │
  ▲         │   └─ auth  (GitHub OAuth + device flow)            │
  │         │        │                                           │
 Claude     │        ▼                                           │
 Code plugin│  Durable Object per board (SQLite)                 │
 (hooks,    │   items · event log · claims · presence · sockets  │
  commands) │        │                                           │
            │  D1: users · tokens · board directory · memberships│
            │  R2: nightly board exports                         │
            └────────┬─────────────────────────────▲─────────────┘
                     │ inferred matching           │ push / PR webhooks
                     ▼                             │
               Anthropic API                    GitHub App
```

### 5.1 Key decisions
- **The service is the source of truth, not git.** Live, identical boards for several people can't be built on git push and pull, which only syncs when someone commits, pushes and pulls.
  - Storing the board on a dedicated git branch would mean automatic commits and pushes. bulletin-bee's CLAUDE.md forbids that: commit only when asked, never push on your own.
  - The tool therefore **never commits, pushes or branches in a code repo.** It only reads GitHub events.
- **One Durable Object per board.** Every write to a board passes through one place, one at a time. That makes the hard parts easy:
  - IDs that never collide
  - ordering
  - claim conflicts
  - streaming changes to connected clients

  Its built-in SQLite storage holds the board. WebSockets that hibernate while idle keep always-open boards cheap.
- **D1 for cross-board data:** users, API tokens, which boards exist, who belongs to which board, and the "My work" index.
- **A GitHub App for sign-in, access and events.** Installing it on a repo creates the board and subscribes to that repo's webhooks. Access to a board follows the person's access to the repo (§7.1).
- **Why Cloudflare:**
  - Both target repos already deploy to Cloudflare (bulletin-bee: Workers + D1 + R2 + Anthropic SDK; big-talk: Next.js on Workers via OpenNext).
  - The one-object-per-board model fits the problem exactly.
  - Cost at this scale is close to zero.
  - Teammates never need Cloudflare access; they sign in with GitHub.

  Appendix A covers the alternatives considered.

## 6. Data model

### 6.1 Item
```jsonc
{
  "id": "BT-012",                 // server-assigned, PREFIX-NNN
  "title": "Auto-close on merge",
  "body": "markdown — one line or a full spec",
  "status": "up_next",            // backlog | up_next | in_progress | done | dropped
  "rank": "a0V",                  // fractional-index string; order within the column
  "blocked": { "reason": "needs Apple Developer account", "since": "2026-10-14" },  // or null
  "tags": ["infra", "m3"],
  "depends_on": ["BT-009"],
  "aliases": ["feedback-26"],     // former or imported IDs; still resolve
  "source": { "kind": "chat", "ref": "session 3f2a", "actor": "nick" },
    // kind: chat | claude-deferred | web | cli | import | github
  "created_at": "…", "created_by": "nick",
  "claim": {                      // or null; see §7.6
    "user": "kevin", "kind": "session", "ref": "session 9c1e",
    // kind: session | branch | manual
    "machine": "kevin-mbp", "since": "…", "heartbeat_at": "…"
  },
  "citations": [
    { "kind": "closes", "commit": "4772d30", "pr": 41, "branch": "main",
      // kind: closes | pending | refs
      "how": "explicit", "confidence": null,   // how: explicit | inferred | manual
      "author": "aaron", "at": "…", "reverted": false }
  ],
  "notes": [ { "at": "…", "actor": "nick", "commit": "a1b2c3d", "text": "server half done" } ]
}
```
- **Required fields:** `id`, `title`, `status`, `rank`, `created_*`. A one-line TODO stays one line.
- **`dropped` replaces delete.** Dropped items are hidden from the board but remain searchable. No item is ever destroyed.
- **Notes are append-only.** That is how an item's details change over time without losing the story. Changes to title and body are recorded in the event log.
- **Blocked is a flag with a reason, not a column.** A blocked item stays in its column and shows a badge.
- **`rank`** uses fractional indexing on strings. Moving a card writes only that card, and ranks never need renumbering.

### 6.2 IDs
- **Each board has a prefix**, set when it is created: `BT` for big-talk, `BB` for bulletin-bee, `PL` for this repo.
- **The board's Durable Object assigns numbers in sequence**, so collisions are impossible. Items created offline get their ID when they sync. Until then they are referred to by a temporary local handle.
- **Imported IDs are kept** (`BT-001…`). Other identifiers, such as FEEDBACK `#26`, become `aliases`, so existing references in commits, code comments and docs still resolve.

### 6.3 Event log
- **Every change is appended** with:
  - sequence number and timestamp
  - actor: who, and through what (`nick via web`, `nick via claude session 3f2a`, `github push a1b2c3d`, `reconciler`)
  - item ID
  - operation and the before/after values
- **The log drives** each item's history, undo, sync for reconnecting clients ("send me everything after sequence N"), and the precision metrics in §10.

### 6.4 Board columns
**Backlog → Up Next → In Progress → Done.**
- Priority is the vertical order within a column. There is no separate P0–P3 field.
- Done shows the last 14 days by default. Older Done items are collapsed but searchable.

## 7. Functional requirements

### 7.1 Boards, access and auth
- **FR-1 Boards come from the GitHub App.** Installing the App on a repo creates a board for it, keyed by GitHub's repo ID so renames don't break anything. Uninstalling archives the board; it does not delete it.
- **FR-2 Access follows GitHub.**
  - Repo write access lets a person edit the board.
  - Read access lets a person view it.
  - Permissions are re-checked against GitHub at most every 10 minutes and whenever a GitHub membership-change event arrives.
- **FR-3 Sign-in:**
  - Web: GitHub OAuth.
  - CLI and plugin: GitHub device flow, issuing a revocable API token per user and machine, stored in the OS keychain.
- **FR-3a Private, with no password page.**
  - **Sign-in friction:**
    - The only way in is "Sign in with GitHub". There are no passwords.
    - Sessions use a rolling 90-day cookie.
    - When a session expires, the user is sent back through GitHub automatically, without a click, because GitHub remembers the app's approval.
  - **What outsiders can learn:**
    - Signed-out visitors see only the sign-in button: no board names, counts or repo names.
    - A board the user can't access returns 404, not 403, so outsiders can't confirm that a repo has a board.
    - The site is marked `noindex`.
  - **No Cloudflare Access in front.** Webhooks and the CLI would need exceptions, people would sign in twice, and Access identifies people by email rather than by GitHub username.
- **FR-4 Agents act as their user.** An agent acts as the user signed in on that machine. Every event records both the user and the agent session.
- **FR-5 The CLI finds the board from the repo** by reading `origin`. No per-repo setup beyond `punch init` (FR-17).

### 7.2 Sync and concurrency
- **FR-6 Live updates.** Every open web board and every connected CLI session gets each change within 1 second (p95).
  - On reconnect, a client asks only for events after its last sequence number.
- **FR-7 The server decides.** Clients send operations such as `move`, `edit`, `claim` or `close`. The board's Durable Object applies them in order and broadcasts the result.
  - The web UI shows a change immediately and rolls it back if the server rejects it.
- **FR-8 Conflicts:**
  - Separate fields merge: Aaron retitling while Nick moves the card both apply.
  - For the same field, the last write wins.
  - Body edits carry the version they were based on. If someone else changed the body in between, the editor sees "Aaron edited this. Review their changes." and their own edit is not dropped silently.
  - Character-level co-editing (Yjs) is deferred until two people are actually typing in the same item at the same time.
- **FR-9 Offline.**
  - The CLI keeps a local cache of each board for reads.
  - Writes made offline wait in an outbox and are sent in order on reconnect.
  - Conflicts are resolved under FR-8 and reported to the user.

### 7.3 Web board
- **FR-10 Board page.** Each board lives at `/<owner>/<repo>`, with a switcher between boards and a "My work" view (FR-35).
- **FR-11 Drag and drop:**
  - Between columns, which changes the status. Dropping into In Progress claims the item for you.
  - Within a column, which changes the order.
- **FR-12 Inline editing.**
  - Add a card in any column.
  - Edit the title and body (markdown).
  - Add notes, tags and dependencies.
  - Set or clear Blocked, with a reason.
  - Drop an item.
- **FR-13 Cards show:**
  - ID and title
  - claim holder, with avatar, agent or branch, and "since"
  - Blocked badge and reason
  - dependencies, with unfinished ones highlighted
  - citations: commit and PR links, with "inferred" and confidence badges, and "pending on branch" badges
  - the latest note
- **FR-14 Presence.** Avatars show who else is viewing the board right now.
- **FR-15 History and undo.**
  - Each item has a history view built from the event log.
  - Any event can be undone. Undo is itself a new event.
  - Done cards have a one-click Reopen.
- **FR-16 Search and filter** by text, tag, holder, source and status, including old Done items.

### 7.4 CLI (`punch`, npm package `@nnewberg/punchlist`)
- **FR-17 Commands:**
  - `punch login` and `punch init` (links the repo to its board and adds the CLAUDE.md pointer, FR-23)
  - `add`, `list`, `show`, `move`, `start`, `release`, `block`, `unblock`, `close`, `reopen`, `drop`, `note`
  - `open` (opens the web board) and `mine`
  - `import`, `export`
- **FR-18 Compact output.** `punch list --compact` prints the board in no more than about 1,500 tokens. It is used for Claude's context and the terminal.
- **FR-19 Machine-readable output.** Every command supports `--json`.
- **FR-20 Speed.** Commands finish in under 300 ms with a warm connection. Reads fall back to the cache when offline (FR-9).

### 7.5 Claude Code plugin
- **FR-21 Skill (`punchlist`).** Tells Claude how to use the board. Every action goes through `punch` and never through files. Claude should:
  - **Add items:** when the user asks (S1), and when Claude defers work itself (S2). Check for near-duplicates first, and add a note to the existing item instead.
  - **Claim before substantial work.** If the item is already held by someone else, tell the user instead of starting.
  - **Add notes on its own** (decided 2026-10-16) when it learns something a teammate would want to know: a root cause, a blocker, a decision, partial progress. Notes are append-only and never change status. Keep them sparse: a note or two per session, not a running log.
  - **Leave decisions to people.** Only when asked does Claude:
    - add items the user merely mentions
    - close an item without a commit
    - reprioritize, move or delete items
    - edit other people's items
    - take over someone else's claim
  - **Use trailers when asked to commit:** `Closes: <IDs>` for work that finishes an item, `Refs: <IDs>` for partial progress.
  - **Never commit, push or branch just to update the board.** Board writes don't need git.
  - **Tell the board apart from Claude Code's own task list.** When the user says "todo list", "todos" or "punchlist", they mean the shared board. Claude's internal per-session task list stays private scratch space and must never stand in for filing an item on the board.
- **FR-22 Slash commands:**
  - `/punch` shows the compact board
  - `/punch add <text>` adds an item
  - `/punch start <ID>`
  - `/punch done <ID> [note]` closes it manually, with a note
  - `/punch block <ID> <reason>`
- **FR-23 CLAUDE.md pointer.** `punch init` adds no more than five lines to CLAUDE.md, saying:
  - the board is at `<url>`
  - it is managed through the plugin
  - status must not be copied into CLAUDE.md or into docs
- **FR-24 Session hooks:**
  - **SessionStart:** injects the compact board, including claims held by other people.
  - **UserPromptSubmit / Stop:** renew this session's claims.
  - **SessionEnd:** releases them.
- **FR-25 Local commits.** A PostToolUse hook on `git commit` records commits that contain closing trailers as "committed locally, not pushed" on the cited items. Everyone can then see that a fix exists before it is pushed. This is a should-have.
- **FR-25a Team onboarding.** Every collaborator uses Claude Code, so setup should take a single command per person:
  - The repo's committed `.claude/settings.json` lists the plugin, so teammates are offered it when they open the repo in Claude Code. Adding that is a normal repo change made by the team; the tool doesn't do it.
  - On first use, the plugin runs `punch login` (GitHub device flow) inside the session.
  - If the plugin isn't installed or logged in, SessionStart prints a one-line notice instead of failing quietly.

  Check the current Claude Code project-plugin settings before M3.

### 7.6 Claims and presence
- **FR-26 How a claim is made:**
  - `/punch start` or `punch start`
  - dragging the card to In Progress
  - pushing a branch whose name contains an ID (`bb-031-…`); the claim goes to the person who pushed
- **FR-27 One holder per item.** A claim on an item that is already held fails and names the current holder. The holder can be overridden with `--steal`, which is recorded in the log.
- **FR-28 Claim lifetime:**
  - Session claims expire after a TTL with no heartbeat (default 2 hours).
  - Branch claims end when the branch is deleted or merged. A merged branch named for an item closes it (`how: branch`) unless the branch's commits or PR say `Refs:` for it, which marks partial progress (§12).
  - Manual claims last until they are released.
  - When a claim ends without a close, the item goes back to the column it was in before.

### 7.7 GitHub integration and auto-close
- **FR-29 Webhook intake.** The Worker:
  - receives push, pull request, branch create/delete and membership-change events
  - verifies each event's signature
  - ignores repeat deliveries by delivery ID and commit SHA
- **FR-30 Explicit closes:**
  - A commit that lands on the default branch with `Closes|Fixes|Resolves` and IDs, in a trailer or the subject, closes those items (`how: explicit`).
  - The same keywords in a merged PR's body count too.
  - A bare ID mention, or `Refs:`, adds a note and never closes.
- **FR-31 Pending on a branch.** Closing trailers on a branch other than the default add a `pending` citation and a badge. They do not change status. So does `Closes` in an open PR's description.
- **FR-32 Inferred closes.**
  - **Trigger:** a commit lands on the default branch without a closing trailer.
  - **Inputs:** the commit message, a diff summary capped at 8k tokens, and each open item's title, body excerpt and recent notes. Matching uses a small, fast Claude model, called from the Worker and never from the board's Durable Object (§8, Cost).
  - **Confidence ≥ 0.8:** close the item, marked `how: inferred` with the confidence.
  - **Confidence 0.5–0.8:** add a note instead.
  - **Below 0.5:** do nothing.
  - **Per-board settings:** can be turned off; thresholds can be changed.
- **FR-33 PR links and reverts:**
  - A merged PR's number is attached to every citation for its commits, which covers squash and merge commits.
  - When a commit reverting a closing commit lands, the affected items reopen automatically, with a note.
- **FR-34 Many-to-many.** One commit can close or add notes to several items. One item can collect any number of citations before it closes.

### 7.8 My work (across repos)
- **FR-35 One view across repos.** "My work" (web) and `punch mine` (CLI) list, for every board the user belongs to:
  - items the user or their agents hold
  - the top of each board's Up Next
  - items blocked on the user, i.e. Blocked with the user named in the reason

  The view reads each board live, which is fine at 2–5 boards.

### 7.9 Import (v1 acceptance tests)
`punch import` runs locally against the repo's files and git history. It shows a dry-run report first and only writes to the board after the report is confirmed. It never edits repo files.

**Approach (decided 2026-10-16): Punchlist's model comes first; imports adapt to it.**
- `punch import` takes one general, documented JSON format in Punchlist's own item shape. It shows a dry run, writes in bulk, and accepts existing IDs.
- Each source repo gets a **one-time translation** into that format. The translation is done with judgment (by Claude, reviewed by people), not by parsers built into Punchlist.
- Preserving a source's format exactly is not a goal. What matters:
  - Keep the IDs, because they're referenced in commits, branches and docs. An ID that doesn't fit `PREFIX-NNN`, like BT-007a, gets a new number and keeps its old one as an alias.
  - Get statuses right.
  - Keep each item's substance.
- Fields that Punchlist has no concept of are dropped or folded into the body.
- Review happens on a single table before anything is written: ID, title, proposed status and column, and a one-line reason for each status call. It's shared with the other people on the repo.
- The per-repo rules below are guidance for the translation, not features of `punch import`.

- **FR-36 big-talk:**
  - `docs/tickets/BT-*.md` → items
    - IDs are kept; `BT-007a` becomes an alias
    - the full ticket text becomes the body
    - Source, Depends on and Related become fields
    - free-text Status is mapped to the fixed statuses, using rules plus Claude for unclear cases
    - P0/P1 → Up Next, P2/P3 → Backlog, ordered by the priority list in the brainstorm READMEs where one exists
  - `docs/TODO.md`:
    - open checkboxes → items
    - the `## Done` log → Done items, with commits taken from the prose
    - items that duplicate a ticket → notes on that ticket
- **FR-37 bulletin-bee:**
  - `docs/PLAN.md` checklists → items, keeping their state (`[~]` → In Progress, unclaimed; `[!]` → Blocked with its reason), each milestone becomes a tag (`m3`).
  - `docs/FEEDBACK.md` numbered entries → items:
    - The original text, report date and commit go in the body.
    - `feedback-N` becomes an alias.
    - "Fixed by …" references become citations.
    - Re-reported entries are merged into the item they repeat.
- **FR-38 Reconcile drift.** After import, the full git history is scanned for each open item: ID mentions, linked PRs and inferred matches. Any proposed closes or notes appear in the report. For example, BT-008 is closed via `cc16d77`.
- **FR-39 Leftover status copies.** The report lists the status copies that remain and suggests replacing each with a pointer to the board:
  - big-talk: the CLAUDE.md Status section and the tickets README index
  - bulletin-bee: PLAN.md and FEEDBACK.md

  The decision is to retire all of them (Q5). The team commits those edits; the tool only produces the report and the suggested pointer text.

## 8. Non-functional requirements
- **Latency:**
  - a change reaches every connected client within 1 s (p95)
  - the board loads in under 1.5 s
  - CLI commands take under 300 ms when warm
- **Durability:**
  - The board's SQLite storage is the primary copy.
  - A nightly JSON + markdown export of every board goes to R2, kept for 30 days.
  - `punch export` writes the same export locally on demand.
  - No operation hard-deletes an item.
- **Security:**
  - repo-scoped access (FR-2)
  - verified webhooks
  - revocable per-machine tokens
  - Worker secrets for the GitHub App key and the Anthropic key
  - The GitHub App requests the minimum permissions: metadata read, contents read (diffs for inference), pull requests read.
- **Data handling:**
  - Item content and diff summaries are stored in or pass through Nick's Cloudflare account.
  - Diff summaries are sent to the Anthropic API for inferred matching.
  - big-talk is owned by the `futureleisurefoundation` org. Nick is an org admin, so he can approve the install himself. Data ownership for org boards is covered in Q1.
- **Cost:** the Workers Paid plan at a flat **$5/mo**, plus model calls for inferred matching. Checked against Cloudflare docs on 2026-10-14.
  - **What it costs:**
    - $5.00 today. About $5.35 at 10 users / 10 boards.
    - D1, R2 and the custom domain cost $0 at this scale.
  - **Why not Free:** today's usage fits on Free, peaking at about 46% of its daily SQLite read limit. But at 10 users / 10 boards the SQLite read and write limits would be exceeded. Free is also a hard stop, not a bill: requests fail once a limit is hit.
  - **Main cost risk: broken WebSocket hibernation.** Each board that never hibernates adds about $12.50/mo in Durable Object time: about $17.50/mo today, about $43/mo at 10 boards. Four implementation rules prevent this:
    - Accept sockets with the hibernation WebSocket API, not the standard `accept()`.
    - No timers or long-pending work inside the Durable Object. Use alarms instead.
    - **Make Anthropic and GitHub API calls from the Worker, not the Durable Object.** A pending fetch keeps the object awake and billed for up to 15 minutes. The Worker has no duration charge.
    - Answer keepalives with `setWebSocketAutoResponse` so they don't wake the object.
  - **Avoid needless writes:**
    - Keep claim heartbeats in memory or write them coarsely, not one SQLite write per heartbeat.
    - Don't update a token's `last_used` on every request.
  - **Budget alert:** set one at $15/mo. The Paid plan has no spending cap.
  - **Not verified:** whether DO SQLite storage billing is live yet. It doesn't matter here, since usage stays within the included amounts.
- **Operations:**
  - deployed with `wrangler` from CI on merge to this repo's `main`, never from a laptop (bulletin-bee's deploy lesson)
  - Worker logs, plus the event log, are the audit trail

## 9. Milestones
| Milestone | Scope | Done when | Status (2026-10-16) |
|---|---|---|---|
| **M1 Service core** | Worker, board Durable Object, data model, event log, REST API, GitHub App install + sign-in, CLI basics (FR-1–9, 17–20) | Nick and a second account edit the same board from two CLIs, and each sees the other's changes | **Built and live.** Proven locally with two dev identities. `punch` 0.1.0 is on npm. Not yet tried with Aaron's or Kevin's real accounts. |
| **M2 Web board** | FR-10–16 | Two browsers stay in sync live, with drag, edit, presence, history and undo | **Built and live** |
| **M3 Claude plugin** | Skill, commands, hooks, claims, onboarding (FR-21–28) | S1, S2, S4 and S10 work across two machines, and a teammate goes from a fresh clone to a working plugin with one command | Not started |
| **M4 GitHub auto-close** | Webhooks, explicit closes, pending-on-branch, PR links, reverts, inferred closes (FR-29–34) | S5–S9 work on a real repo | **Deterministic sync built** (FR-26 branch claims, FR-29–31, FR-33, FR-34), with acceptance tests against `nnewberg/punchlist-sandbox`; S4, S5 (squash, merge and rebase), S6, S8 and S9 pass on production (2026-10-16). Inferred closes (FR-32) are step 3 of §9.1 |
| **M5 Migrate and dogfood** | Imports (FR-36–39), My work (FR-35) | Both repos are imported, Aaron and Kevin are onboarded, and the §10 metrics are tracked | My work is built; the imports are not |

### 9.1 Build order from here (revised 2026-10-16)
Automated syncing comes **before** any import. An imported board without auto-close starts drifting on day one, which is exactly what success criterion 3 rules out. It would also make Aaron's real board the first place auto-close is ever tested.

1. **A sandbox, plus deterministic GitHub sync (M4, minus inferred closes).** *Built 2026-10-16; see §12.*
   - Create the private repo `nnewberg/punchlist-sandbox` and install the App on it. Its board then appears automatically, since `nnewberg` is on the allowed-owners list.
   - Build webhook intake (FR-29), branch claims (FR-26), explicit closes and pending-on-branch (FR-30, FR-31), and PR links and reverts (FR-33).
   - Test each scenario as a script that runs real `git` and `gh` against the sandbox, then asserts what the board shows (S5–S9).
   - These scripts become repeatable acceptance tests.
2. **The Claude Code plugin (M3).**
   - Skill, `/punch` commands, hooks, and session claims with heartbeat and TTL expiry (FR-21–28).
   - Tested with headless Claude Code agents (`claude -p`) in two sandbox clones acting as two people (S1, S2, S4, S10).
3. **Inferred closes (FR-32).**
   - Evaluated against big-talk's real git history and its ticket set.
   - That same run proposes fixes to big-talk's stale statuses (FR-38), so drift reconciliation uses the real feature rather than a one-off.
4. **Imports (M5)**, with all of the above switched on from day one (§7.9).

The sandbox runs on the production Worker, not a staging copy. Boards are isolated from each other, so this is fine at this scale and saves running a second deployment and App.

## 10. Success criteria
1. **Live and the same for everyone.** A change by one person appears on the other's open board within 1 s (p95). Over the dogfood period there are zero reports of two people seeing different states.
2. **Both repos migrated.**
   - big-talk: 36 tickets plus `TODO.md`.
   - bulletin-bee: `PLAN.md` plus `FEEDBACK.md`.
   - Every mapping decision is reported, known drift is resolved (e.g. BT-008), and the old status copies are retired.
3. **No manual status upkeep.** In two weeks of dogfooding, with Aaron and Kevin both using the board, nobody hand-edits a status to fix drift.
4. **Auto-close quality:**
   - explicit closes are 100% correct
   - at least 90% of inferred closes are not reopened within 7 days
   - no more than 1 item per repo per week is found open after its work shipped
5. **No duplicated work.** No incident where two people or agents unknowingly worked on the same item.

## 11. Open questions (with recommendations)
| # | Question | Recommendation |
|---|---|---|
| Q1 | **futureleisurefoundation data ownership.** Nick is an org admin, so he can install the App and approve sending diffs to Anthropic himself. big-talk already uses Claude Code, so this adds no new exposure. What remains: big-talk's board lives in Nick's personal Cloudflare account while the repo belongs to the org. | Keep one deployment on Nick's account, since it also serves the personal bulletin-bee repo. Make the nightly R2 export of org boards available to org admins (or mirror it to org-owned storage) so the org never depends on Nick's account to get its data. Revisit if the org adds more members. |
| Q2 | ~~Do Aaron and Kevin use Claude Code?~~ **Resolved: yes, both do.** | The plugin is the main interface, and its onboarding is part of v1 (FR-25a). Because every agent runs the hooks, claims and duplicate-work warnings (S4) cover the whole team. |
| Q3 | **CLI or remote MCP for agents?** | CLI in v1, because hooks need it anyway. The Worker could also expose a remote MCP server later, with no change to the data model. |
| Q4 | ~~URL~~ **Resolved: a custom domain is optional.** | **Address:** https://punchlist.nnewberg.workers.dev (live). It started as `punchlist.<account>.workers.dev`. One deployment serves every board, so the address belongs to the service, not to any one repo; bulletin-bee not having a domain doesn't matter. **Config:** the base URL is a single setting that the CLI and plugin read. **Adding a domain later:** `workers.dev` stays active alongside it, the GitHub App lists both callback URLs, CLI tokens stay valid, and browsers re-sign-in once through GitHub automatically. **Which domain:** prefer a personal one over `getbigtalk.com`, which is the org's product domain. The repo is `nnewberg/punchlist` (personal), deployed to Nick's Cloudflare account. |
| Q5 | ~~What happens to imported source files?~~ **Resolved: they are retired and replaced by a pointer to the board.** | After import, these files are replaced by a short pointer to the board: big-talk's `docs/tickets/`, `TODO.md` and CLAUDE.md Status section; bulletin-bee's `PLAN.md` and `FEEDBACK.md`. Ticket specs move into item bodies, and PLAN milestones become tags. The team commits these edits as part of M5; the tool never edits repo files itself. |
| Q6 | **A "Deployed" signal beyond "merged".** | Later. big-talk could report deploys from its workflow, but bulletin-bee deploys by hand. A `punch deployed <sha>` hook could cover both. |
| Q7 | ~~Claude filing deferred work without asking (S2)~~ **Resolved: Claude files it automatically.** | Items are tagged `claude-deferred` and mentioned in one line. A per-board setting switches to suggest-only if it gets noisy. |
| Q8 | **Character-level co-editing.** | Not in v1 (FR-8). Revisit only if the "review their changes" prompt actually happens in practice. |

## Appendix A — Alternatives considered
| Option | Why not chosen |
|---|---|
| **Item files in each repo, synced with git** (the v0.1 PRD) | Only syncs on commit, push and pull, so the board lags and differs between people. Claims and reprioritizing stay stuck on whichever branch someone is on. Parallel branches collide on IDs. |
| **Board on a dedicated git branch, auto-pushed** | Syncs within about a minute, but needs automatic commits and pushes, which bulletin-bee's CLAUDE.md forbids. Still not live. |
| **Convex** | A strong fit with the least sync code, and the runner-up. Not chosen because both repos already run on Cloudflare and one-object-per-board fits naturally. It remains the fallback if building sync on Durable Objects proves costly. |
| **Supabase** | Workable, but Realtime sends row changes that the client must merge, so there are more pieces to wire together. |
| **Firebase / Firestore** | Good live sync and offline support, but the document model is awkward for an ordered board with an event log. Adds another vendor. |
| **Liveblocks / Yjs** | The best character-level co-editing, but it isn't a backend. Webhooks, inference and auth for non-browser clients would need a second system. |
| **Local-first sync engines** (InstantDB, Zero, ElectricSQL, Jazz) | Young. Clients other than browsers (CLI, webhooks) are second-class. Some need a Postgres you run yourself. |
| **Self-hosted server** (Node + SQLite on Fly or a VPS) | Same WebSocket work as Durable Objects, plus owning uptime, TLS and backups. |
| **GitHub Projects + Issues as the backend** | Multi-user and auto-close work today, but the board is GitHub's: slower, with no agent presence, and the ticket-system feel the memo wanted to avoid. |

## 12. Decisions made while building (as of 2026-10-16)

**Deployment**
- **Live at** https://punchlist.nnewberg.workers.dev, on Nick@newbergfamily.net's Cloudflare account (Workers Free plan for now; upgrade to Paid at about 10 boards or users, §8).
- **Storage:** D1 database `punchlist` holds users, sessions, boards, access and API tokens. The board data lives in each board's Durable Object, named `repo:<GitHub repo id>`.
- **Deploys:** GitHub Actions on every merge to `main`. The `CLOUDFLARE_API_TOKEN` repo secret has Workers Scripts and D1 edit rights. Database migrations run in CI.

**GitHub App: "Punchlist Board"** (slug `punchlist-board`; GitHub reserves the name "Punchlist")
- Owned by `nnewberg`, installable by any account. Only `ALLOWED_OWNERS` (`nnewberg`, `futureleisurefoundation`) get boards.
- Installed on big-talk, bulletin-bee and punchlist.
- Permissions: metadata, contents and pull requests, all read. Device Flow is enabled.
- Webhook events: installation, installation repositories, repository, push, pull request, create and delete (the last four ticked 2026-10-16; there's no API for it).
- Also installed on `nnewberg/punchlist-sandbox` (private, prefix `PS`), which exists only for the acceptance tests.

**Sign-in and access**
- **Web:** a rolling 90-day session cookie, stored hashed. A browser that has signed in before re-authenticates silently through GitHub when the session ends.
- **CLI:** GitHub's device flow, run by the Worker, ends in a per-machine `pl_…` token kept in the OS keychain. List and revoke them through `/v1/me/tokens`.
- **Roles:** repo write or admin means edit; read means **view only** (the board and sheet are read-only, and ops are refused); none means 404. Roles are checked with the App's installation token, cached 10 minutes in D1, and memoized for 1 minute per isolate.

**CLI**
- Published as the public npm package `@nnewberg/punchlist` (client code only).
- Publishing needs Nick's security-key 2FA, so `npm publish` runs in his own terminal, not from an agent.
- 0.1.1, which lowers the Node requirement to 20, is built but unpublished.

**UI words**
- The `dropped` status is shown as **Delete** (trash icon, Undo toast). It's still the soft delete from §6.1, and the CLI command keeps the name `drop`.
- Columns can't be reordered; the order is the workflow.
- Item IDs are never reused, so gaps after deletes are expected.

**Imports**
- See §7.9's approach note. Big-talk findings to carry into its translation:
  - 35 tickets in `docs/tickets/`. `BT-034-design-prompt.md` is an attachment to BT-034, not a ticket.
  - The free-text Status lines are often stale. BT-008, for one, shipped in `cc16d77`.
  - Only about 7 of 285 commits cite a ticket ID, so drift has to be found by inference (step 3 of §9.1).

**GitHub sync (M4, deterministic)**
- **Where the work happens.** The Worker verifies the webhook, finds the board by repo id, and makes any GitHub calls: the merged PR behind each citing commit on the default branch, and a merged PR's commits. It then makes one call to the board's Durable Object with plain facts. The object applies them in one transaction and never fetches (§8).
- **Dedupe.** The object remembers delivery IDs for 30 days, and which commits have landed on the default branch, so a redelivery or a commit seen twice changes nothing. A sync failure returns 500, so the delivery shows as failed on GitHub and can be redelivered from the App's settings.
- **Only the default branch closes.** `Closes|Fixes|Resolves` with IDs anywhere in a commit message (subject, body or trailer), or in a merged PR's title or description. Elsewhere they add a pending fix: one per item per branch, replaced by a force-push, and dropped when the item closes or the branch is deleted. A PR closed without merging leaves its badge until the branch is deleted.
- **Refs and mentions are notes.** `Refs:` / `Part of`, and bare `PREFIX-NNN` mentions, add a note citing the commit (and PR), once the commit lands on the default branch. The `refs` citation kind was dropped from the model; a note already carries the commit.
- **A merged branch closes its item** (decided with Nick): a branch named for an item (`bt-014-…`) that merges closes it, marked `via branch`, unless its commits or PR say `Refs:` for that item. Then the claim ends and the item stays open with a note. The Claude plugin will write `Closes:` and `Refs:` itself (FR-21), so this rule is mostly for hand-made commits.
- **Branch claims never steal.** Pushing a branch for an item someone else holds adds one note saying so. The pusher's own session claim becomes a branch claim, since the branch outlives the session.
- **Reverts.** `This reverts commit <sha>` (including a reverted merge commit, matched through its PR) and GitHub's Revert button (`Reverts owner/repo#N`) mark those closes reverted. An item with no other close reopens to the column it was in before, unclaimed, with a note. A revert's quoted subject (`Revert "Fix BT-9"`) never counts as a close.
- **Who it's from.** GitHub changes are logged as the pusher, commit author or PR merger, `via github`. Citations keep full SHAs and show 7 characters.
- **Not yet:** membership-change events (the 10-minute access recheck covers them for now), and inferred closes (step 3).

