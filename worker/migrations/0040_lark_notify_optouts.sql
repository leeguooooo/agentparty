-- #595：Lark DM 通知改为成员默认在场（登录/入会自动入册）后，显式关闭必须被记住——
-- 否则用户 DELETE 退订，下次登录又被自动重开。optout 行存在即跳过自动入册；
-- 手动重新开启（POST /lark-notify）时删除 optout。
CREATE TABLE lark_notify_optouts (
  channel_slug TEXT NOT NULL,
  account      TEXT NOT NULL,
  opted_out_at INTEGER NOT NULL,
  PRIMARY KEY (channel_slug, account)
);
