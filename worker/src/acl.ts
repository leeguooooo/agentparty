// 频道访问控制（账号模型 spec §5）——纯函数，便于单测。
// v2：判定锚点从 token 名/万能钥匙改为「账号」(principal.account) + channel_scope 硬上限。
import type { TokenIdentity } from "./auth";

// canAccessChannel / isChannelModerator 只依赖身份的这几个字段
export type AclIdentity = Pick<TokenIdentity, "hash" | "name" | "role" | "email" | "account" | "channel_scope">;

export interface ChannelAcl {
  slug: string;
  visibility: string;
  // 频道归属账号（创建者 principal.account）。老频道为 null → 仅 legacy token 过渡放行。
  owner_account: string | null;
}

// OIDC 人类身份的 hash 形如 "oidc:<sub>"（见 auth.ts verifyOidcToken）；
// ap_ token 的 hash 是 sha256 hex，绝不以此前缀开头。
function isOidcIdentity(identity: AclIdentity): boolean {
  return identity.hash.startsWith("oidc:");
}

// legacy ap_ token：非 OIDC 身份且 account 未设（tokens.owner 为 null 的存量 token）。
// 过渡期当「部署管理员」放行（spec §6，有收紧截止点）。P1 起新铸 token 强制带 owner，缺口只减不增。
function isLegacyAdminToken(identity: AclIdentity): boolean {
  return !isOidcIdentity(identity) && identity.account == null;
}

// 是否允许「进入/读」该频道（spec §5.4/§5.5 访问矩阵），判定顺序：
//   ① public → 任何通过鉴权的身份放行（public 先于 scope，scoped token 也能进公开频道）
//   ② channel_scope 非空 → 仅 slug 命中才放行，否则一律 forbidden（对所有 role 含 readonly 硬上限，
//      即使 owner_account === account 也不行；scope 不匹配连读都拒）
//   ③ legacy ap_ token（owner=null）→ 过渡期放行
//   ④ 无 scope 的 readonly（分享 token 本应带 scope，不该再签发无 scope 的）→ 私有一律拒（spec §5.5）
//   ⑤ 账号规则 → principal.account === channel.owner_account（都非空才命中）
// 写权限在此之上再叠加现有规则（readonly 不能发），不在本函数内判断。
export function canAccessChannel(identity: AclIdentity, channel: ChannelAcl): boolean {
  if (channel.visibility === "public") return true;
  if (identity.channel_scope != null) return channel.slug === identity.channel_scope;
  if (isLegacyAdminToken(identity)) return true;
  if (identity.role === "readonly") return false;
  return identity.account != null && identity.account === channel.owner_account;
}

// 是否可对频道做管理操作（踢人/归档/webhook/reset-guard，spec §5 防滥用）：
//   readonly 恒 false；scoped token 不是 moderator（仅联调用，不给管理权）；
//   legacy ap_ token 过渡放行；否则账号维度房主（account === owner_account，都非空）。
export function isChannelModerator(identity: AclIdentity, channel: ChannelAcl): boolean {
  if (identity.role === "readonly") return false;
  if (identity.channel_scope != null) return false;
  if (isLegacyAdminToken(identity)) return true;
  return identity.account != null && identity.account === channel.owner_account;
}
