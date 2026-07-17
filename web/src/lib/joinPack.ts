// 完整接入包的唯一 builder：「＋ 让 agent 加入」（AgentJoin）与 vault「复制接入包」
// （AgentTokens）都调这一份，两个入口的产物从结构上逐字节同构，杜绝再漂移（#584 复盘）。
// 独立成模块而不放 agentTokenVault：AgentJoin 的测试整体 mock 了 vault 模块，
// builder 放那边会让组件测试拿到假实现。
import { AGENT_NAME_RE, charterSnapshotBodyLines, mcpServerName } from "@agentparty/shared/onboarding";
import type { ChannelCharter } from "./api";
import type { TFunc } from "../i18n/useT";
import "../i18n/strings/AgentJoin";

// snippet 里保底的 CLI 版本：低于它就强制重装（旧版会把「需升级」误报成 token 失效，见 issue #2）。
// 发布带 CLI 行为变更的版本时同步上调。
// 0.2.52：接入包依赖 watch --once（Claude Code 待命）与 serve 自动声明可唤醒。
// 0.2.124：接入包 MCP-first，依赖 party mcp 的 party_decision_ask 与 party_send attach
//（不能写 0.2.123——该版已从 #579 发布、不含这两个工具，锁它会让过闸的 CLI 缺工具）。
export const MIN_CLI = "0.2.124";

// 与桌面最小接入包共用同一份 awk 三段版本比较；只查 command -v 会放过装着旧版、缺 MCP 工具的机器。
export const VERSION_GE_SNIPPET =
  `version_ge(){ awk -v a="$1" -v b="$2" 'BEGIN{split(a,A,".");split(b,B,".");for(i=1;i<=3;i++){A[i]+=0;B[i]+=0;if(A[i]>B[i])exit 0;if(A[i]<B[i])exit 1}exit 0}'; }`;

// 公告正文必须整体注释化：接入包的约定是「不带 # 的行是要执行的命令」，而 charter 由频道
// 管理员可控——逐字插入等于让对方频道的管理员向接入方的终端注入任意命令（跨公司信任边界上
// 的 RCE）。每行加 "# " 前缀让内容只可读、不可执行；空行补 "#" 防止段落断开处漏出裸行；
// 正文先过 charterSnapshotBodyLines 剥控制字节（ESC/CSI/CR 能视觉覆盖注释前缀，见 shared 注释）。
function charterSnapshotLines(charter: ChannelCharter | null, t: TFunc): string[] {
  if (!charter?.charter) return [];
  return [
    t("AgentJoin.cmd.charterHeader"),
    t("AgentJoin.cmd.charterBegin"),
    ...charterSnapshotBodyLines(charter.charter).map((line) => (line === "" ? "#" : `# ${line}`)),
    t("AgentJoin.cmd.charterEnd"),
    ``,
  ];
}

export interface FullJoinPackInput {
  slug: string;
  agentName: string;
  agentToken: string;
  /** 真实后端 origin（#530：桌面版必须传 apiBase，不能是 tauri://localhost）。 */
  server: string;
  inviterName: string;
  /** 生成时刻的频道公告快照；null 则整段省略（包里已指引用 party charter 看最新）。 */
  charter: ChannelCharter | null;
  t: TFunc;
}

// 完整接入脚本：init 只写配置不发消息，必须带「报到发言」，否则网页上看不到 agent。
export function buildFullJoinPack(input: FullJoinPackInput): string {
  const { slug, agentName, agentToken, server, charter, t } = input;
  // #597：邀请人的「频道身份」可能是 account id（lark:on_xxx / github:xxx），不满足 mention
  // 的 name 正则——渲染出的 --mention 会被 CLI 直接拒绝，新 agent 第一条报到就报错。
  // 校验不过就整体降级为不 @：报到照发，blocked 指引改教它用 party who 反查 handle。
  const inviterName = AGENT_NAME_RE.test(input.inviterName) ? input.inviterName : null;
  return [
    t("AgentJoin.cmd.header", { slug }),
    t("AgentJoin.cmd.intro1"),
    t("AgentJoin.cmd.intro2"),
    ``,
    t("AgentJoin.cmd.scope1", { slug }),
    t("AgentJoin.cmd.scope2"),
    ``,
    ...charterSnapshotLines(charter, t),
    t("AgentJoin.cmd.step1"),
    // PATH 必须先于版本检查：install.sh 装到 ~/.local/bin，若检查时查的是系统 PATH 里
    // 另一个够新的 party、后续命令却用回 ~/.local/bin 的旧版，版本闸就被绕过了。
    `export PATH="\$HOME/.local/bin:\$PATH"`,
    VERSION_GE_SNIPPET,
    `need=${MIN_CLI}; have="$(party --version 2>/dev/null || echo 0)"; version_ge "$have" "$need" || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
    t("AgentJoin.cmd.pathNote1"),
    t("AgentJoin.cmd.pathNote2"),
    `command -v party >/dev/null || alias party="\$HOME/.local/bin/party"`,
    ``,
    t("AgentJoin.cmd.step2"),
    `mkdir -p "$HOME/.agentparty/agents"`,
    `export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${agentName}-${slug}.json"`,
    t("AgentJoin.cmd.turnWarn1"),
    t("AgentJoin.cmd.turnWarn2"),
    t("AgentJoin.cmd.turnWarn3"),
    t("AgentJoin.cmd.turnWarn4", { agentName, slug }),
    ``,
    t("AgentJoin.cmd.step3"),
    `party init --server ${server} --token ${agentToken} --channel ${slug}`,
    inviterName === null ? t("AgentJoin.cmd.step3noteNoMention", { slug }) : t("AgentJoin.cmd.step3note"),
    inviterName === null
      ? `party send "${t("AgentJoin.cmd.checkinMessage", { agentName })}" --channel ${slug}`
      : `party send "${t("AgentJoin.cmd.checkinMessage", { agentName })}" --channel ${slug} --mention ${inviterName}`,
    ``,
    t("AgentJoin.cmd.step4"),
    `claude mcp add ${mcpServerName(agentName)} --env AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${agentName}-${slug}.json" -- party mcp --channel ${slug}`,
    t("AgentJoin.cmd.step4codex", { mcpName: mcpServerName(agentName), agentName, slug }),
    t("AgentJoin.cmd.step4fallback"),
    ``,
    t("AgentJoin.cmd.step5"),
    t("AgentJoin.cmd.step5reply", { slug }),
    t("AgentJoin.cmd.step5more", { slug }),
    t("AgentJoin.cmd.contextAnchor1", { slug }),
    t("AgentJoin.cmd.contextAnchor2", { agentName, slug }),
    t("AgentJoin.cmd.contextAnchor3"),
    t("AgentJoin.cmd.blocked1", { slug }),
    inviterName === null
      ? t("AgentJoin.cmd.blocked2NoMention", { slug })
      : t("AgentJoin.cmd.blocked2", { slug, inviterName }),
    t("AgentJoin.cmd.stayReachable"),
    t("AgentJoin.cmd.mcpWakeNote"),
    t("AgentJoin.cmd.claudeMode1"),
    t("AgentJoin.cmd.claudeMode2", { slug }),
    t("AgentJoin.cmd.claudeMode3"),
    t("AgentJoin.cmd.otherMode1"),
    t("AgentJoin.cmd.otherMode2"),
    t("AgentJoin.cmd.otherMode3", { slug }),
    t("AgentJoin.cmd.otherMode4"),
    `#        Codex:  OUT=$(mktemp); codex exec resume --last --skip-git-repo-check -o "$OUT" "$(cat {file})" || codex exec --skip-git-repo-check -o "$OUT" "$(cat {file})"; party send - --channel "$AP_CHANNEL" --reply-to "$AP_REPLY_TO" < "$OUT"`,
    `#        Claude: claude -p -c "$(cat {file})" || claude -p "$(cat {file})"`,
    t("AgentJoin.cmd.sandboxWarn1"),
    t("AgentJoin.cmd.sandboxWarn2"),
    t("AgentJoin.cmd.sandboxWarn3"),
    t("AgentJoin.cmd.sandboxWarn4"),
    t("AgentJoin.cmd.watchNote", { slug }),
    t("AgentJoin.cmd.etiquette"),
  ].join("\n");
}
