-- 账号归属模型 P1（identity-account-model-design spec §5/§6）：
-- 把频道归属 + token 隔离从 token 名/万能钥匙收敛到「账号」维度。
--   channels.owner_account：频道归属账号（创建者的 principal.account = 邮箱），nullable。
--     老频道为 NULL → 仅 legacy ap_ token 过渡放行，OIDC/带 owner 的 token 进不去（§6 迁移预期）。
--   tokens.channel_scope：把 agent/readonly token 限死单频道 slug，nullable。
--     非 NULL 时 canAccessChannel 硬上限：仅该 slug 频道可进，其余私有一律拒（含 readonly，连读都拒）。
ALTER TABLE channels ADD COLUMN owner_account TEXT;
ALTER TABLE tokens ADD COLUMN channel_scope TEXT;
