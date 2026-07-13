-- #165: owner-facing agent nickname changes are security-relevant identity mutations.
-- SQLite cannot extend a CHECK list in place, so rebuild while preserving every existing row/index.
CREATE TABLE management_audit_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_token TEXT NOT NULL,
  actor_account TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'human', 'agent')),
  action TEXT NOT NULL CHECK (action IN (
    'token.issue',
    'token.revoke',
    'agent.nickname.update',
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
