CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assets_owner ON assets(owner, archived, created);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  refs TEXT NOT NULL,
  ratio TEXT NOT NULL,
  duration INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  upstream TEXT,
  error TEXT,
  created INTEGER NOT NULL,
  next INTEGER NOT NULL DEFAULT 0,
  lease INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(owner, status, next, created);
