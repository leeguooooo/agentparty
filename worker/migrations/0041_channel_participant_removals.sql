-- Persistent, channel-scoped revocation authority for removed participants.
--
-- A row remains active until a moderator explicitly restores the participant.
-- Name and account principals stay separate: restoring an account must not
-- accidentally restore an independently removed agent name.
CREATE TABLE channel_participant_removals (
  channel_slug TEXT NOT NULL REFERENCES channels(slug) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('name', 'account')),
  principal TEXT NOT NULL COLLATE NOCASE,
  restore_account TEXT,
  removed_at INTEGER NOT NULL,
  removal_epoch TEXT NOT NULL,
  removed_by TEXT NOT NULL,
  PRIMARY KEY (channel_slug, principal_type, principal)
);

CREATE INDEX idx_channel_participant_removals_principal
  ON channel_participant_removals(principal_type, principal, channel_slug);

-- Upgrade pre-0041 account bans into the authority consumed by the Durable
-- Object. The stable epoch makes retries deterministic across restored copies.
INSERT INTO channel_participant_removals
  (channel_slug, principal_type, principal, restore_account, removed_at, removal_epoch, removed_by)
SELECT channel_slug,
       'account',
       account,
       NULL,
       banned_at,
       'legacy-ban:' || channel_slug || ':' || lower(account) || ':' || banned_at,
       banned_by
  FROM channel_account_bans
 WHERE 1 = 1
ON CONFLICT(channel_slug, principal_type, principal) DO NOTHING;

-- Durable name -> account evidence for identities that are not represented by
-- an ap_ token row (notably verified-email OIDC sessions). The binding is
-- written only after the participant passes the channel removal gate. Keeping
-- the participant kind prevents an account re-add from implicitly restoring an
-- independently removed agent name.
CREATE TABLE channel_participant_bindings (
  channel_slug TEXT NOT NULL REFERENCES channels(slug) ON DELETE CASCADE,
  participant_name TEXT NOT NULL COLLATE NOCASE,
  account TEXT NOT NULL,
  participant_kind TEXT NOT NULL CHECK (participant_kind IN ('human', 'agent')),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (channel_slug, participant_name)
);

CREATE INDEX idx_channel_participant_bindings_account
  ON channel_participant_bindings(channel_slug, account);

-- Lets project-agent removal make the invite revocation its transaction CAS.
-- Every subtree tombstone/revoke statement is conditioned on this exact epoch,
-- so a losing concurrent DELETE cannot overwrite the winner's removal epoch.
ALTER TABLE channel_agent_invites ADD COLUMN removal_epoch TEXT;
