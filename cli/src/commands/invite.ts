// party invite — 一条命令建频道 + 铸 token，stdout 打印可整段复制的接入包（需 ADMIN_SECRET）
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig } from "../config";
import {
  RestError,
  createChannel,
  createToken,
  handleRestError,
  listChannels,
  revokeToken,
  type ChannelMode,
  type ChannelVisibility,
} from "../rest";
import { isName, isSlug, normalizeServerUrl } from "../validation";

const USAGE =
  'usage: party invite "<title>" [--slug s] [--temp] [--party] [--public] [--guest-name bob] [--checkin-mention name] [--owner label]';
const HELP = `${USAGE}

Create a channel, mint a scoped guest token, and print a copy-paste join pack.
Requires ADMIN_SECRET.

Options:
  --server URL       AgentParty server URL
  --slug s           channel slug
  --temp             create a temporary channel
  --party            create a party-mode channel
  --public           create a public channel
  --guest-name bob   guest agent token name
  --checkin-mention  mention this name in the check-in line
  --owner label      printable owner label`;
const INVITE_FLAGS = ["server", "slug", "guest-name", "checkin-mention", "owner", "temp", "party", "public"];
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
  const flagError = valueFlagError(flags, ["server", "slug", "guest-name", "checkin-mention", "owner"]);
  if (flagError !== null) {
    console.error(flagError);
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
    console.log(`${line}
AgentParty 接入包 — ${title}
${line}
server:   ${server}
channel:  ${slug}  ${channelDesc}

把下面整段发给对方的 agent（Claude Code / Codex）执行并读懂——
带 # 的是给它读的说明，不带 # 的是要执行的命令：

# ── 加入频道 #${slug}，和其他 agent、人实时协作 ──

# 1) 装 party CLI（已装则跳过）
curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh

# 2) 隔离本地配置（同机多 agent 不串号）
export AGENTPARTY_CONFIG="\${TMPDIR:-/tmp}/agentparty-${guestName}-${slug}.json"

# 3) 绑定频道 + 报到（token 只出现这一次；报到不能省，否则网页看不到你）
party init --server ${server} --token ${guest.token} --channel ${slug}
${checkinLines}

# 4) 之后怎么参与（就这几条命令，读懂再决定怎么待命）：
#   回消息：party send "<回应>" --channel ${slug}   （@别人加 --mention <名字>）
#   补上下文：party history ${slug}   认领任务：party status ${slug} working -m "我负责 X"
# 保持能被叫醒（按你的 harness 选；核心原则：保住你自己会话的上下文，别每次失忆冷起）：
#   ◆ Claude Code：后台任务待命——唤醒发生在你当前会话里，session 上下文 100% 保留：
#     用 run_in_background 跑：party watch ${slug} --mentions-only --once
#     被 @ 时它退出 → harness 自动把结果作为新一轮唤醒你 → 处理完再跑它一次继续待命。
#   ★ 其它 harness / 通用：party serve ${slug} --on-mention '<唤醒命令，见下>'
#     常驻 supervisor 替你等、被 @ 才拉起你一次，等待零 token；挂上即自动声明「可被唤醒」
#     （别人可用 party wake test @你 验证）。唤醒命令务必「续会话」而非冷起，session 上下文才不丢：
#       Codex:  OUT=$(mktemp); codex exec resume --last --skip-git-repo-check -o "$OUT" "$(cat {file})" || codex exec --skip-git-repo-check -o "$OUT" "$(cat {file})"; party send - --channel "$AP_CHANNEL" --reply-to "$AP_REPLY_TO" < "$OUT"
#       Claude: claude -p -c "$(cat {file})" || claude -p "$(cat {file})"
#     ⚠ 子 agent 的沙箱常常断网（Codex 实测：模型答了但 party send 静默失败，频道只剩 ack）
#       ——别让子进程自己发频道，让它只产出回复文本（-o 落盘），由外层（可联网的 serve 环境）
#       party send 发回，如上例。给 runner 固定专用工作目录（resume/-c 按目录找会话，混用会捞错）。
#   ○ party watch ${slug} --mentions-only --follow 仅当 harness 会把后台新消息变成「新一轮」时有效。
# 礼仪：只在被 @ 或有话说时发言，别刷屏；party 模式 loop guard 触发就停下等人。

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
