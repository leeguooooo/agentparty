-- Monotonic fence for D1 role mutations pushed asynchronously into the channel DO.
-- A single channel counter plus per-target DO cursors lets unrelated target updates
-- both apply while preventing an older request from rolling back the assigned host.
ALTER TABLE channels ADD COLUMN role_rev INTEGER NOT NULL DEFAULT 0;

-- Keep the fence at the database boundary so every mutation path participates,
-- including member/agent removal flows that delete roles without using the
-- explicit /roles endpoint.
CREATE TRIGGER channel_roles_bump_revision_insert
AFTER INSERT ON channel_roles
BEGIN
  UPDATE channels SET role_rev = role_rev + 1 WHERE slug = NEW.channel_slug;
END;

CREATE TRIGGER channel_roles_bump_revision_update
AFTER UPDATE ON channel_roles
BEGIN
  UPDATE channels SET role_rev = role_rev + 1 WHERE slug = OLD.channel_slug;
  UPDATE channels
     SET role_rev = role_rev + 1
   WHERE slug = NEW.channel_slug AND NEW.channel_slug != OLD.channel_slug;
END;

CREATE TRIGGER channel_roles_bump_revision_delete
AFTER DELETE ON channel_roles
BEGIN
  UPDATE channels SET role_rev = role_rev + 1 WHERE slug = OLD.channel_slug;
END;

-- Role validity also depends on the live token principal and scope. Bump every
-- channel that binds the old/new token name so the snapshot double-read detects
-- revocation, reminting, owner changes and scope changes.
CREATE INDEX idx_channel_roles_agent_name
ON channel_roles(agent_name, channel_slug);

CREATE TRIGGER tokens_bump_role_revision_insert
AFTER INSERT ON tokens
BEGIN
  UPDATE channels
     SET role_rev = role_rev + 1
   WHERE slug IN (
     SELECT channel_slug FROM channel_roles WHERE agent_name = NEW.name
   );
END;

CREATE TRIGGER tokens_bump_role_revision_update
AFTER UPDATE ON tokens
BEGIN
  UPDATE channels
     SET role_rev = role_rev + 1
   WHERE slug IN (
     SELECT channel_slug
       FROM channel_roles
      WHERE agent_name = OLD.name OR agent_name = NEW.name
   );
END;

CREATE TRIGGER tokens_bump_role_revision_delete
AFTER DELETE ON tokens
BEGIN
  UPDATE channels
     SET role_rev = role_rev + 1
   WHERE slug IN (
     SELECT channel_slug FROM channel_roles WHERE agent_name = OLD.name
   );
END;
