-- When this person last opened the board in the web app (PL-019). /v1/me lists their boards most
-- recently opened first, so `/` reopens the one they were on. CLI and Claude activity don't count.
ALTER TABLE access ADD COLUMN opened_at TEXT;
