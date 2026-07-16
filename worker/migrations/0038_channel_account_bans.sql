CREATE TABLE channel_account_bans (
  channel_slug TEXT NOT NULL REFERENCES channels(slug) ON DELETE CASCADE,
  account TEXT NOT NULL,
  banned_by TEXT NOT NULL,
  banned_at INTEGER NOT NULL,
  PRIMARY KEY (channel_slug, account)
);

CREATE INDEX idx_channel_account_bans_account ON channel_account_bans(account, channel_slug);
