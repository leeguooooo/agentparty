-- #736 / migration 0042: 频道「当前已定稿」权威锚点。
-- ledger 永不 UPDATE/DELETE；channel_decision_heads 只保存每个 topic 当前 active 的指针。
-- supersede 通过新行显式引用旧行，既保留完整历史，又能 O(1) 拉取新人接入所需的当前态。
CREATE TABLE channel_decisions (
  id TEXT PRIMARY KEY,
  channel_slug TEXT NOT NULL REFERENCES channels(slug) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_seq INTEGER,
  supersedes_id TEXT REFERENCES channel_decisions(id),
  created_by TEXT NOT NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('agent', 'human')),
  created_at INTEGER NOT NULL,
  CHECK (length(topic) > 0),
  CHECK (length(summary) > 0),
  CHECK (source_seq IS NULL OR source_seq > 0),
  CHECK (supersedes_id IS NULL OR supersedes_id != id)
);

CREATE UNIQUE INDEX idx_channel_decisions_supersedes
  ON channel_decisions(channel_slug, supersedes_id)
  WHERE supersedes_id IS NOT NULL;
CREATE INDEX idx_channel_decisions_channel_created
  ON channel_decisions(channel_slug, created_at DESC, id DESC);

CREATE TABLE channel_decision_heads (
  channel_slug TEXT NOT NULL REFERENCES channels(slug) ON DELETE CASCADE,
  topic TEXT COLLATE NOCASE NOT NULL,
  decision_id TEXT NOT NULL REFERENCES channel_decisions(id),
  PRIMARY KEY (channel_slug, topic)
);

-- 新 topic 只允许在还没有 active head 时写入；已有结论必须显式 supersede。
-- supersede 只允许指向【同频道、同 topic、当前 active】的旧行。DB.batch 中随后原子推进 head。
CREATE TRIGGER channel_decisions_validate_insert
BEFORE INSERT ON channel_decisions
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM channels c
       WHERE c.slug = NEW.channel_slug
         AND c.archived_at IS NOT NULL
    )
    THEN RAISE(ABORT, 'channel is archived')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NULL AND EXISTS (
      SELECT 1 FROM channel_decision_heads h
       WHERE h.channel_slug = NEW.channel_slug
         AND h.topic = NEW.topic COLLATE NOCASE
    )
    THEN RAISE(ABORT, 'active decision already exists for topic')
  END;
  SELECT CASE
    -- Keep this literal aligned with shared/src/protocol.ts CHANNEL_DECISION_ACTIVE_MAX.
    WHEN NEW.supersedes_id IS NULL AND (
      SELECT COUNT(*) FROM channel_decision_heads h
       WHERE h.channel_slug = NEW.channel_slug
    ) >= 100
    THEN RAISE(ABORT, 'channel active decision limit reached')
  END;
  SELECT CASE
    WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM channel_decision_heads h
        JOIN channel_decisions old ON old.id = h.decision_id
       WHERE h.channel_slug = NEW.channel_slug
         AND h.topic = NEW.topic COLLATE NOCASE
         AND h.decision_id = NEW.supersedes_id
         AND old.channel_slug = NEW.channel_slug
    )
    THEN RAISE(ABORT, 'supersedes_id must reference the active decision for the same topic')
  END;
END;
