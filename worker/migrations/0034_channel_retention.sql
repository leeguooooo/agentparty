-- #421: channel-scoped message/audit retention is authoritative in D1 and mirrored into the channel DO.
-- NULL means retention deletion is disabled for that data class.
ALTER TABLE channels ADD COLUMN message_retention_ms INTEGER
  CHECK (message_retention_ms IS NULL OR message_retention_ms >= 60000);
ALTER TABLE channels ADD COLUMN audit_retention_ms INTEGER
  CHECK (audit_retention_ms IS NULL OR audit_retention_ms >= 60000);

-- Keep the management-audit CHECK in sync with the application union.  The identity/export actions
-- landed after 0031; include them here together with the new retention-policy action.
CREATE TABLE management_audit_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_token TEXT NOT NULL,
  actor_account TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'human', 'agent')),
  action TEXT NOT NULL CHECK (action IN (
    'token.issue',
    'token.revoke',
    'channel.create',
    'channel.permissions.update',
    'channel.visibility.update',
    'channel.member.add',
    'channel.member.remove',
    'channel.role.assign',
    'channel.role.remove',
    'channel.join_link.create',
    'channel.join_link.revoke',
    'channel.join_request.approve',
    'channel.join_request.reject',
    'channel.project_agent.invite',
    'channel.project_agent.remove',
    'channel.guard.update',
    'channel.guard.reset',
    'channel.webhook.add',
    'channel.webhook.remove',
    'channel.webhook.redeliver',
    'channel.archive',
    'channel.identity.erase',
    'channel.export',
    'channel.retention.update',
    'membership.set'
  )),
  resource TEXT NOT NULL,
  channel TEXT,
  result TEXT NOT NULL CHECK (result = 'success'),
  timestamp INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND length(metadata_json) <= 4096)
);

INSERT INTO management_audit_new (
  id, cursor_token, actor_account, actor_kind, action, resource, channel, result, timestamp, metadata_json
)
SELECT id, cursor_token, actor_account, actor_kind, action, resource, channel, result, timestamp, metadata_json
  FROM management_audit;

DROP TABLE management_audit;
ALTER TABLE management_audit_new RENAME TO management_audit;

CREATE UNIQUE INDEX idx_management_audit_cursor_token ON management_audit(cursor_token);
CREATE INDEX idx_management_audit_timestamp ON management_audit(id DESC);
CREATE INDEX idx_management_audit_channel ON management_audit(channel, id DESC);
