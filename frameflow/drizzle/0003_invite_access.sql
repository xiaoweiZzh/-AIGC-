CREATE TABLE IF NOT EXISTS studio_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS studio_sessions (
  token_hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES studio_accounts(id),
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS studio_sessions_owner ON studio_sessions(owner, expires);
