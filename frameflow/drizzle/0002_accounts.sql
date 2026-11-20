CREATE TABLE IF NOT EXISTS account_integrations (
  owner TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  region TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  version TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS account_drafts (
  owner TEXT PRIMARY KEY,
  draft TEXT NOT NULL
);
