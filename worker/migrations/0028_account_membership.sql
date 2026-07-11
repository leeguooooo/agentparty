-- 会员骨架（#277）：账号维度的 free/member 分层，用于回收托管部署每月成本；自部署始终免费。
-- 单独建表而非并进 account_profiles：account_profiles.handle 为 NOT NULL，而未设 handle 的账号
-- 也必须能被 owner 手动开通会员，故会员状态以 account 为主键独立存。
-- 无行 => free（默认）；member_since 记开通时刻，供 UI 展示与将来的 feature-gating（本次不 gate 任何功能）。
CREATE TABLE account_membership (
  account      TEXT PRIMARY KEY,
  tier         TEXT NOT NULL DEFAULT 'free',
  member_since INTEGER,
  updated_at   INTEGER NOT NULL
);
