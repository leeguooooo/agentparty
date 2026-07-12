// issue #150：分工内容应该自动同步到公告（charter）里。这里只负责纯文本合成/
// 合并——"分工 -> markdown 小节 -> 写进公告全文" 三步中的后两步。谁来触发（点击
// 「同步到公告」按钮）、何时触发（每次分工变更 or 手动点）由调用方（DivisionBoard /
// Channel.tsx）决定；这个模块本身不碰网络、不碰 React。
//
// 合并策略：小节包在一对稳定的 HTML 注释 marker 里。已有 marker 就整体替换（避免
// 反复点「同步」在公告里堆出一串重复小节），没有就追加在末尾，两边都保留 marker
// 之外人工手写的公告正文不动。

const START_MARKER = "<!-- ap:division:start -->";
const END_MARKER = "<!-- ap:division:end -->";

export interface DivisionCharterRole {
  display: string;
  accountLabel: string;
  role: string;
  responsibility: string | null;
}

export interface DivisionCharterLabels {
  heading: string;
  empty: string;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatDivisionSection(roles: DivisionCharterRole[], labels: DivisionCharterLabels): string {
  const body =
    roles.length === 0
      ? labels.empty
      : roles
          .map((role) => {
            const resp = role.responsibility !== null && role.responsibility !== "" ? `：${role.responsibility}` : "";
            return `- **${role.display}**（${role.accountLabel}）— ${role.role}${resp}`;
          })
          .join("\n");
  return `${START_MARKER}\n### ${labels.heading}\n${body}\n${END_MARKER}`;
}

// #150 自动同步：判断公告里是否已经有「自动分工区块」（marker 存在）。用来区分
// 「本来就没有分工、也不该无中生有写空区块」和「区块曾经写过、现在分工清零需要更新」
// 两种情况——前者自动同步应静默跳过，后者应把区块刷新为空。
export function charterHasDivisionSection(charterText: string): boolean {
  return charterText.includes(START_MARKER);
}

export function mergeDivisionIntoCharter(charterText: string, section: string): string {
  const markerRe = new RegExp(`${escapeForRegExp(START_MARKER)}[\\s\\S]*?${escapeForRegExp(END_MARKER)}`);
  if (markerRe.test(charterText)) {
    return charterText.replace(markerRe, section);
  }
  const trimmed = charterText.trimEnd();
  return trimmed === "" ? section : `${trimmed}\n\n${section}`;
}
