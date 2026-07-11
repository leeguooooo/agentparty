// 会员骨架（#277）：申请入口的纯逻辑。申请走邮件，owner 收到后手动开通
// （party membership activate / POST /api/admin/membership）。本次不接支付、不 gate 任何功能。
// 会员判定统一走 shared 的 isMember（唯一的 feature-gating 钩子），这里不重复比字符串。
import type { MeInfo } from "./api";

// owner 手动开通的联系邮箱（与 README 商业授权同一入口）。
export const MEMBERSHIP_CONTACT_EMAIL = "leeguooooo@gmail.com";

// 给免费账号构造「申请会员」的 mailto：预填收件人 + 主题 + 正文（带上申请者账号，便于 owner 定位开通）。
export function membershipApplyMailto(me: MeInfo, subject: string, body: string): string {
  const who = me.email ?? me.owner ?? me.handle ?? me.name;
  const params = new URLSearchParams({ subject, body: `${body}${who}` });
  return `mailto:${MEMBERSHIP_CONTACT_EMAIL}?${params.toString()}`;
}

// me.membership_tier 归一给 shared.isMember 用（旧 server 缺字段 => null => free）。
export function membershipStatusOf(me: MeInfo): { tier: string } | null {
  return me.membership_tier == null ? null : { tier: me.membership_tier };
}
