-- API tokens for the CLI and the plugin (FR-3): one per person per machine, revocable. Only the
-- token's SHA-256 is stored; `id` is a public handle for listing and revoking.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  machine TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX tokens_user ON tokens (user_id);
