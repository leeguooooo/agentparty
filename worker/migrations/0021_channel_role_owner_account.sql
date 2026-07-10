-- Anchor collaboration roles to the ACCOUNT that owns the agent name, not the bare name (#101).
--
-- Before this, channel_roles was keyed purely by (channel_slug, agent_name). A `host` role
-- outlived the token it was assigned to: revoke `deploy-bot` and let any other account re-mint a
-- token of the same name, and the residual host role was inherited by the new (possibly hostile)
-- token — granting charter writes, guard config, and speaking as the retired agent.
--
-- `owner_account` records the account the role is bound to:
--   * NULL  = pre-allocation (role assigned before any token for this name existed). The first
--             token minted for the name claims (binds) it — see persistToken. An UNBOUND role is
--             NOT honoured at read time (loadAssignedRole denies NULL) — it only becomes usable
--             once a mint binds it, so a stale NULL can never be inherited.
--   * <acct>= the role is valid ONLY for an identity whose principal.account matches.
--
-- Backfill: bind existing rows to the CURRENT live token's owner. Rows whose token is revoked,
-- absent, or owner-less (legacy) resolve to NULL and therefore stop granting power until
-- reassigned — the deliberate fail-safe direction for accounts we cannot determine.
ALTER TABLE channel_roles ADD COLUMN owner_account TEXT;

UPDATE channel_roles
   SET owner_account = (
     SELECT t.owner
       FROM tokens t
      WHERE t.name = channel_roles.agent_name
        AND t.revoked_at IS NULL
   );
