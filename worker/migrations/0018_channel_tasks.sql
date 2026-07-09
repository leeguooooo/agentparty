CREATE TABLE IF NOT EXISTS channel_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'backlog',
  assignee_name TEXT,
  assignee_kind TEXT,
  created_by TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_owner TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]',
  parent_id INTEGER,
  anchor_seqs_json TEXT NOT NULL DEFAULT '[]',
  completion_artifact_json TEXT,
  workflow_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (channel_slug) REFERENCES channels(slug) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES channel_tasks(id) ON DELETE SET NULL,
  CHECK (state IN ('triage','backlog','assigned','in_progress','needs_review','done','blocked')),
  CHECK (assignee_kind IS NULL OR assignee_kind IN ('agent','human','squad')),
  CHECK ((assignee_name IS NULL AND assignee_kind IS NULL) OR (assignee_name IS NOT NULL AND assignee_kind IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_channel_tasks_channel_state
  ON channel_tasks(channel_slug, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_tasks_channel_assignee
  ON channel_tasks(channel_slug, assignee_name, state);
