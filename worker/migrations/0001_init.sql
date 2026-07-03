-- agentparty d1 初始 schema
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT,
  topic TEXT,
  kind TEXT NOT NULL DEFAULT 'standing',
  created_by TEXT,
  created_at INTEGER,
  archived_at INTEGER
);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER,
  revoked_at INTEGER
);
