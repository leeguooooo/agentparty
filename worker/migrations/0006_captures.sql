-- Durable channel captures: explicit scribe tags for important chat content.
CREATE TABLE captures (
  id INTEGER PRIMARY KEY,
  channel_slug TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message_sender TEXT NOT NULL,
  message_sender_kind TEXT NOT NULL,
  message_kind TEXT NOT NULL,
  message_body TEXT NOT NULL,
  message_ts INTEGER NOT NULL,
  UNIQUE(channel_slug, seq, kind)
);

CREATE INDEX idx_captures_channel_created ON captures(channel_slug, created_at);
CREATE INDEX idx_captures_channel_seq ON captures(channel_slug, seq);
