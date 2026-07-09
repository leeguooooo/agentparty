-- Configurable channel metadata permissions (#71).
ALTER TABLE channels ADD COLUMN charter_write_policy TEXT NOT NULL DEFAULT 'moderators';
ALTER TABLE channels ADD COLUMN charter_write_agents TEXT NOT NULL DEFAULT 'moderators';
ALTER TABLE channels ADD COLUMN charter_write_agent_allowlist_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE channels ADD COLUMN members_list_policy TEXT NOT NULL DEFAULT 'members';
ALTER TABLE channels ADD COLUMN members_list_agents TEXT NOT NULL DEFAULT 'members';
ALTER TABLE channels ADD COLUMN members_list_agent_allowlist_json TEXT NOT NULL DEFAULT '[]';
