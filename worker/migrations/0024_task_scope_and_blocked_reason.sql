-- 任务台账（channel_tasks）首次拥有「作用域」与「阻塞原因」两个一等字段（#204）。
-- 目的：让 open_claims / conflicts / blockers 改由任务台账派生，claim 的同一性变成 task id，
-- scope 从「拼 claimKey 的同一性来源」降级为可变数据；conflicts 用任务 scope 跑 overlap 判定；
-- blockers 直接带出结构化 blocked_reason，而不是从消息折叠里猜。
-- 既有行按默认值补齐：scope_json 空数组、blocked_reason 为空。
ALTER TABLE channel_tasks ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE channel_tasks ADD COLUMN blocked_reason TEXT;
