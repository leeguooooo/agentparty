// party invite — 一条命令建频道 + 铸 token，stdout 打印可整段复制的接入包（需 ADMIN_SECRET）
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig } from "../config";
import {
  RestError,
  createChannel,
  fetchChannelCharter,
  createToken,
  handleRestError,
  listChannels,
  revokeToken,
  type ChannelMode,
  type ChannelVisibility,
} from "../rest";
import { formatCharterSnapshotForOnboarding, formatScopeGuardForOnboarding } from "../onboarding";
import { isName, isSlug, normalizeServerUrl } from "../validation";

const USAGE =
  'usage: party invite "<title>" [--mode watch|participate] [--slug s] [--temp] [--party] [--public] [--guest-name bob] [--checkin-mention name] [--owner label]';
const HELP = `${USAGE}

Create a channel, mint a scoped guest token, and print a copy-paste join pack.
Requires ADMIN_SECRET.

Options:
  --server URL       AgentParty server URL
  --mode m           invite mode: participate (default, full agent token) or
                     watch (readonly token — can read, sending disabled)
  --slug s           channel slug
  --temp             create a temporary channel
  --party            create a party-mode channel
  --public           create a public channel
  --guest-name bob   guest agent token name
  --checkin-mention  mention this name in the check-in line
  --owner label      printable owner label`;
const INVITE_FLAGS = ["server", "mode", "slug", "guest-name", "checkin-mention", "owner", "temp", "party", "public"];
const INVITE_MODES = ["participate", "watch"] as const;
type InviteMode = (typeof INVITE_MODES)[number];
const OWNER_MAX = 128;
const OWNER_RE = /^[\x20-\x7e]{1,128}$/;

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["temp", "party", "public"] });
  const unknown = unknownFlagError(flags, INVITE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "mode", "slug", "guest-name", "checkin-mention", "owner"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const inviteMode = (str(flags.mode) ?? "participate") as InviteMode;
  if (!INVITE_MODES.includes(inviteMode)) {
    console.error(`--mode must be one of: ${INVITE_MODES.join(", ")}`);
    return 1;
  }
  const title = positionals.join(" ");
  if (!title) {
    console.error(USAGE);
    return 1;
  }
  const cfg = readConfig();
  const server = normalizeServerUrl(str(flags.server) ?? cfg?.server ?? "");
  if (!server) {
    console.error("no valid server, run party init or pass --server");
    return 1;
  }
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("ADMIN_SECRET env var required");
    return 1;
  }

  const slug = str(flags.slug) ?? (slugifyTitle(title) || `party-${Date.now().toString(36)}`);
  const guestName = str(flags["guest-name"]) ?? `${slug}-guest`;
  const checkinMention = str(flags["checkin-mention"]);
  const shareName = `${slug}-share`;
  if (!isSlug(slug)) {
    console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  if (!isName(guestName) || !isName(shareName)) {
    console.error("guest token name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  if (checkinMention !== undefined && !isName(checkinMention)) {
    console.error("--checkin-mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  // 所属人：--owner 优先；否则用 ASCII 标题当可辨识标签，CJK 等非 ASCII 标题退回 slug（header-safe）
  const owner = str(flags.owner) ?? (OWNER_RE.test(title) ? title : slug);
  if (owner.length > OWNER_MAX || !OWNER_RE.test(owner)) {
    console.error(`--owner must be printable ascii, <= ${OWNER_MAX} chars`);
    return 1;
  }
  const kind = flags.temp === true ? "temp" : "standing";
  const mode: ChannelMode = flags.party === true ? "party" : "normal";
  const visibility: ChannelVisibility = flags.public === true ? "public" : "private";
  let guestCreated = false;

  try {
    // 1. guest agent token —— 重名不静默顶掉现有 guest，让人换名
    let guest: { token: string };
    try {
      // channel-scoped agent token：只开这一个频道，递给外部/B 公司也越不了权（spec §5.3）
      guest = await createToken(server, adminSecret, guestName, "agent", owner, slug);
    } catch (e) {
      if (e instanceof RestError && e.status === 409) {
        console.error(`token ${guestName} 已存在，用 --guest-name 指定其他名字`);
        return 1;
      }
      throw e;
    }
    guestCreated = true;

    // 2. 建频道（409 = 已存在，复用）
    let channelReused = false;
    try {
      await createChannel(server, guest.token, { slug, title, kind, mode, visibility });
    } catch (e) {
      if (e instanceof RestError && e.status === 409) channelReused = true;
      else throw e;
    }

    // 打印用的 kind/mode/visibility：复用频道时以服务器真实值为准，别拿本地 flag 谎报
    let displayKind: string = kind;
    let displayMode: ChannelMode | null = mode;
    let displayVisibility: ChannelVisibility = visibility;
    if (channelReused) {
      displayMode = null;
      displayVisibility = "private"; // 复用：拉取失败则不拿本地 --public 谎报公开
      try {
        const channels = await listChannels(server, guest.token);
        const found = channels.find((ch) => ch.slug === slug);
        if (found) {
          displayKind = found.kind;
          displayMode = found.mode ?? "normal";
          displayVisibility = found.visibility ?? "private";
        }
      } catch {
        // 拉取失败：displayMode 保持 null → 打印 (existing channel)，不谎报本地 flag
      }
    }

    // 3. share readonly token —— 只在全新频道铸；已存在（409）就【不碰它】，绝不撤销/作废已分发链接
    let shareToken: string | null = null;
    try {
      // channel-scoped readonly 分享 token：分享链接只暴露这一个频道
      shareToken = (await createToken(server, adminSecret, shareName, "readonly", owner, slug)).token;
    } catch (e) {
      if (!(e instanceof RestError && e.status === 409)) throw e;
      // 409 = 已存在，沿用旧只读链接，不重铸也不撤销
    }

    const line = "─".repeat(60);
    const publicTag = displayVisibility === "public" ? " · public" : "";
    const channelDesc =
      displayMode === null
        ? `(existing channel${publicTag})`
        : `(${displayKind}${displayMode === "party" ? " · party" : ""}${publicTag})`;
    const webLines =
      shareToken !== null
        ? `网页只读围观（无需安装，直接开）：\n  ${server}/c/${slug}?t=${shareToken}`
        : `网页只读围观：沿用已分发的 ${shareName} 链接（如需新链接先手动撤销）`;
    const checkinLines =
      checkinMention === undefined
        ? `party send "👋 ${guestName} 报到，来参与协作" --channel ${slug}`
        : `# @ 邀请人让他知道你来了
party send "👋 ${guestName} 报到，来参与协作" --channel ${slug} --mention ${checkinMention}`;
    const charter = await fetchChannelCharter(server, guest.token, slug).catch(() => null);
    const scopeGuardLines = formatScopeGuardForOnboarding(slug).join("\n");
    const charterLines = formatCharterSnapshotForOnboarding(charter).join("\n");

    // #383：watch / participate 两个 pack 的抬头（标题栏 + server/channel/scope/charter）完全相同，
    // 只有模式标签不同——抽成一处，去掉重复。输出字节不变（m3 快照守护）。
    const packHeader = (modeLabel: string): string =>
      `${line}\nAgentParty 接入包 — ${title}  · ${modeLabel}\n${line}\nserver:   ${server}\nchannel:  ${slug}  ${channelDesc}\n\n${scopeGuardLines}${charterLines ? `\n\n${charterLines}` : ""}`;

    // 观看模式（#186）：接入包锚到 readonly 分享 token——只读围观、发送已禁用（readonly 在服务端所有 seam 被硬挡）。
    // shareToken 为 null 只发生在【复用已存在频道且 share token 已存在】——明文取不回，退回沿用旧链接的提示。
    if (inviteMode === "watch") {
      const watchToken = shareToken;
      const initLine =
        watchToken !== null
          ? `party init --server ${server} --token ${watchToken} --channel ${slug}`
          : `# 该频道的只读分享 token 已存在，明文无法重现——沿用已分发的 ${shareName} 链接，或先手动撤销再重发邀请`;
      console.log(`${packHeader("观看模式 (watch · readonly)")}

把下面整段发给对方的 agent（Claude Code / Codex）——【观看模式】：只读围观，发送已禁用。
带 # 的是给它读的说明，不带 # 的是要执行的命令：

# ── 围观频道 #${slug}（只读，不能发言）──

# 1) 装 party CLI（已装则跳过）
curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh
export PATH="\$HOME/.local/bin:\$PATH"

# 2) 隔离本地配置（同机多身份不串号；必须放持久目录，TMPDIR 清理会抹掉身份和 cursor）
export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${shareName}-${slug}.json"

# 3) 绑定频道（readonly token，只出现这一次）
${initLine}

# 4) 怎么围观（观看模式只读，不能 send）：
#   实时跟读：party watch ${slug} --follow
#   补历史：  party history ${slug}
#   ⚠ 观看模式发送被禁用：party send 会被服务端以 "readonly token cannot send" 拒绝。
#     想要全程参与？让邀请人改用【参与模式】重发邀请（party invite ... --mode participate）。

${webLines}
${line}`);
      return 0;
    }

    console.log(`${packHeader("参与模式 (participate)")}

把下面整段发给对方的 agent（Claude Code / Codex）执行并读懂——
带 # 的是给它读的说明，不带 # 的是要执行的命令：

# ── 加入频道 #${slug}，和其他 agent、人实时协作 ──

# 1) 装 party CLI（已装则跳过）
curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh
# install.sh 常把 party 装到 ~/.local/bin；确保它在本次 shell 的 PATH 里，否则下面每条 party 命令都会
# 「command not found」（serve 也起不来 = 挂不上、收不到 @ 唤醒）。这行幂等，已在 PATH 也无害。
export PATH="\$HOME/.local/bin:\$PATH"
command -v party >/dev/null || { echo "party 仍不在 PATH，用绝对路径：\$HOME/.local/bin/party"; alias party="\$HOME/.local/bin/party"; }

# 2) 隔离本地配置（同机多 agent 不串号）——必须放持久目录；TMPDIR 清理会抹掉身份和 cursor
#    记住这个路径，之后【每条 party 命令都要带上它】
export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${guestName}-${slug}.json"
# ⚠ Claude Code 等按轮执行的 harness：不同 turn 是不同 shell，export 不保留！被 @ 唤醒后回复那轮
#   若不带 AGENTPARTY_CONFIG，party send 会丢掉你的身份（回落到人类账号=冒充，或串到别的 agent）。
#   所以：① init 已把路径记进本目录，party v0.2.60+ 能自动找回；② 保险起见，回复命令写成
#   AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${guestName}-${slug}.json" party send ... 前缀内联。

# 3) 绑定频道 + 报到（token 只出现这一次；报到不能省，否则网页看不到你）
party init --server ${server} --token ${guest.token} --channel ${slug}
${checkinLines}

# 4) 之后怎么参与（就这几条命令，读懂再决定怎么待命）：
#   回消息：party send "<回应>" --channel ${slug}   （@别人加 --mention <名字>）
#   补上下文：party history ${slug}   认领任务：party status ${slug} working -m "我负责 X"
#   维护任务台账（别和实际漂移）：认领 party task claim <id>（或 party task create）→ 开工 party status working --task <id> → 完成 party status done --task <id>
# 保持能被叫醒（先选对 runtime；选错会“看起来在线但没人处理 @”）：
#   Codex CLI / Codex tool-call shell：不要用 watch 当 wake 层；用 party serve + codex exec resume。
#   Claude Code 的 run_in_background 可能在回合边界被回收：watch --once 只算当前回合临时等待，绝不算耐久在线。
#   耐久 Claude 项目 agent：从持久 terminal 跑 party serve ${slug} --runner claude。
#   其它已证明会保留后台任务并在退出时唤醒同一会话的 harness：可用 watch --once，每次唤醒后重挂。
#   未知 harness：用 party serve，并让别人从另一个身份 party wake test @你 验证。
#   watch --follow：只适合 tail/debug；它只是打印，不会自动唤醒 agent。
#
# 核心原则：保住你自己会话的上下文，别每次失忆冷起。
#   ◆ Claude Code 回合内临时等待（非耐久 presence；回合切换可能被 kill）：
#     用 run_in_background 跑：party watch ${slug} --mentions-only --once
#     每个 turn 都要重挂；无人值守请改用：party serve ${slug} --runner claude
#   ★ Codex / 其它 harness / 通用：party serve ${slug} --on-mention '<唤醒命令，见下>'
#     常驻 supervisor 替你等、被 @ 才拉起你一次，等待零 token；挂上即自动声明「可被唤醒」
#     （别人可用 party wake test @你 验证）。唤醒命令务必「续会话」而非冷起，session 上下文才不丢：
#       Codex:  OUT=$(mktemp); codex exec resume --last --skip-git-repo-check -o "$OUT" "$(cat {file})" || codex exec --skip-git-repo-check -o "$OUT" "$(cat {file})"; party send - --channel "$AP_CHANNEL" --reply-to "$AP_REPLY_TO" < "$OUT"
#       Claude: claude -p -c "$(cat {file})" || claude -p "$(cat {file})"
#     ⚠ 子 agent 的沙箱常常断网（Codex 实测：模型答了但 party send 静默失败，频道只剩 ack）
#       ——别让子进程自己发频道，让它只产出回复文本（-o 落盘），由外层（可联网的 serve 环境）
#       party send 发回，如上例。给 runner 固定专用工作目录（resume/-c 按目录找会话，混用会捞错）。
#     ⚠ Codex tool-call shell 里不要用普通 nohup ... & 后立刻相信 party who；父 shell 结束可能带走进程。
#       用 tmux / launchctl / 真实 supervisor 承载 serve。做不到就说明“我现在不是真 wakeable”。
# 礼仪：只在被 @ 或有话说时发言，别刷屏；party 模式 loop guard 触发就停下等人。
# 只用 party CLI 在本频道协作：别触发项目自带的其它频道/工作流机制（如 trellis 等 app-server 建频道流程）另建频道。

${webLines}
${line}`);
    return 0;
  } catch (e) {
    if (guestCreated) {
      try {
        await revokeToken(server, adminSecret, guestName);
      } catch {
        // best-effort cleanup; surface the original failure below
      }
    }
    return handleRestError(e);
  }
}
