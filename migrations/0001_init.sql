-- Cross-board data (PRD §5): who people are, who's signed in, which boards exist, and who can use them.
-- Item data lives in each board's Durable Object, not here.

-- A person is their GitHub account. Events and claims refer to people by lowercase login.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,                 -- GitHub user id
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

-- Web sessions (FR-3a): a rolling 90-day cookie. Only the token's SHA-256 is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- One board per repo with the GitHub App installed (FR-1), keyed by repo id so renames don't break it.
-- Uninstalling archives a board; nothing is deleted.
CREATE TABLE boards (
  repo_id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL COLLATE NOCASE,
  prefix TEXT NOT NULL,
  installation_id INTEGER,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
-- Names are unique among live boards only: a repo deleted and recreated under its old name is a new board.
CREATE UNIQUE INDEX boards_name ON boards (owner, repo) WHERE archived_at IS NULL;

-- Each person's role on each board, from their access to the repo (FR-2), re-checked when older
-- than 10 minutes.
CREATE TABLE access (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES boards (repo_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('edit', 'view', 'none')),
  checked_at TEXT NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
