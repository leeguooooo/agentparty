// 左侧频道列表：频道名 + 最近一条消息 + 参与者状态点（spec §9 第 1 块）
import { useEffect, useRef, useState } from "react";
import type { ChannelInfo } from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/Home"; // 复用 "已归档 (N)" key，两处折叠开关文案一致
import "../i18n/strings/App";

interface Props {
  /** 服务器视图身份；切换实例时分类和归档展开状态必须从默认值重新开始。 */
  scopeKey: string;
  channels: ChannelInfo[] | null;
  active: string | null;
  error: string | null;
  onOpen(slug: string): void;
  onRetry?: () => void;
}

// 分类筛选：全部 / 我创建的（owned）/ 我加入的（member）。只筛 live 段，archived 段独立不受影响。
type ChannelCategory = "all" | "created" | "joined";

const CATEGORY_LABEL_KEY: Record<ChannelCategory, string> = {
  all: "Home.channelCategoryAll",
  created: "Home.channelCategoryCreated",
  joined: "Home.channelCategoryJoined",
};

const CATEGORY_EMPTY_KEY: Record<Exclude<ChannelCategory, "all">, string> = {
  created: "Home.channelCategoryEmptyCreated",
  joined: "Home.channelCategoryEmptyJoined",
};

const MAX_DOTS = 4;

function presenceDotPriority(state: ChannelInfo["presence"][number]["state"]): number {
  if (state === "working") return 0;
  if (state === "offline") return 2;
  return 1;
}

// 参与者状态点：每人一个蜡笔点，色 = presence 状态；没人报过 presence 给一颗灰点占位
export function PresenceDots({ channel }: { channel: ChannelInfo }) {
  const t = useT();
  // 列表最多只能放四颗点：先把正在工作和其他在线成员提到离线记录前面，再截断。
  // sort 是稳定的，同一优先级内继续沿用服务端顺序，不让状态点在每次刷新时乱跳。
  const entries = [...(channel.presence ?? [])]
    .sort((a, b) => presenceDotPriority(a.state) - presenceDotPriority(b.state))
    .slice(0, MAX_DOTS);
  return (
    <span className="chan-dots">
      {entries.length === 0 && <span className="d-dot d-dot--offline" title={t("Home.noParticipants")} />}
      {entries.map((p) => (
        <span key={p.name} className={`d-dot d-dot--${p.state}`} title={`${p.name} — ${p.state}`} />
      ))}
    </span>
  );
}

export function lastMessagePreview(c: ChannelInfo): string | null {
  if (c.last_message == null) return null;
  const body = c.last_message.body.replace(/\s+/g, " ").trim();
  return `${c.last_message.sender}: ${body === "" ? `[${c.last_message.kind}]` : body}`;
}

function ChannelPill({
  c,
  active,
  onOpen,
}: {
  c: ChannelInfo;
  active: string | null;
  onOpen(slug: string): void;
}) {
  const preview = lastMessagePreview(c);
  return (
    <button
      type="button"
      className={
        "d-pill chan-pill" +
        (c.slug === active ? " is-active" : "") +
        (c.archived_at !== null ? " chan-pill--archived" : "")
      }
      onClick={() => onOpen(c.slug)}
      title={c.topic ?? c.slug}
    >
      <span className="chan-head">
        <PresenceDots channel={c} />
        <span className="chan-name">{c.title ?? c.slug}</span>
        {c.visibility === "public" && <span className="d-hl public-badge">PUBLIC</span>}
        {c.mode === "party" && <span className="d-hl party-badge">PARTY</span>}
        {c.kind === "temp" && <span className="chan-tag t-mono">temp</span>}
        {c.archived_at !== null && <span className="chan-tag t-mono">archived</span>}
      </span>
      {preview !== null && <span className="chan-last t-mono">{preview}</span>}
    </button>
  );
}

type ScopedProps = Omit<Props, "scopeKey">;

function ScopedChannelList({ channels, active, error, onOpen, onRetry }: ScopedProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [category, setCategory] = useState<ChannelCategory>("all");
  const previousActiveRef = useRef<string | null | undefined>(undefined);
  const t = useT();
  // 默认只显示活跃频道；归档的（联调用完的 temp 等）折叠起来，避免刷屏
  const live = channels?.filter((c) => c.archived_at === null) ?? null;
  const archived = channels?.filter((c) => c.archived_at !== null) ?? [];
  // 分类只筛 live，archived 段保持独立不受影响。owned/member 缺字段（旧 worker）按 false 处理。
  const createdCount = live?.filter((c) => c.owned === true).length ?? 0;
  const joinedCount = live?.filter((c) => c.member === true).length ?? 0;
  const categoryCount: Record<ChannelCategory, number> = {
    all: live?.length ?? 0,
    created: createdCount,
    joined: joinedCount,
  };
  useEffect(() => {
    if (channels === null || previousActiveRef.current === active) return;
    previousActiveRef.current = active;
    if (active === null) return;
    const activeChannel = channels.find((channel) => channel.slug === active);
    if (activeChannel === undefined) return;
    if (activeChannel.archived_at !== null) {
      setShowArchived(true);
      return;
    }
    const excluded =
      (category === "created" && activeChannel.owned !== true) ||
      (category === "joined" && activeChannel.member !== true);
    if (excluded) setCategory("all");
  }, [active, category, channels]);
  const filteredLive =
    live === null
      ? null
      : live.filter((c) => {
          if (category === "created") return c.owned === true;
          if (category === "joined") return c.member === true;
          return true;
        });
  return (
    <nav className="side" aria-label="channels">
      <p className="side-label t-mono">{t("Home.channelsLabel")}</p>
      {channels === null && error === null && <p className="side-note t-mono">{t("Home.loading")}</p>}
      {error !== null && (
        <p className="side-note side-note--err t-mono">
          <span>{error}</span>{" "}
          {onRetry && (
            <button type="button" className="d-btn channels-retry" onClick={onRetry}>
              {t("App.error.retry")}
            </button>
          )}
        </p>
      )}
      {channels !== null && (
        <div className="chan-cat-switch" role="group" aria-label="channel categories">
          {(Object.keys(CATEGORY_LABEL_KEY) as ChannelCategory[]).map((cat) => (
            <button
              key={cat}
              type="button"
              className={"chan-cat-btn" + (cat === category ? " is-active" : "")}
              aria-pressed={cat === category}
              onClick={() => setCategory(cat)}
            >
              {t(CATEGORY_LABEL_KEY[cat], { count: categoryCount[cat] })}
            </button>
          ))}
        </div>
      )}
      {filteredLive?.map((c) => (
        <ChannelPill key={c.slug} c={c} active={active} onOpen={onOpen} />
      ))}
      {live !== null && live.length === 0 && archived.length === 0 && (
        <p className="side-note t-mono">$ party channel create</p>
      )}
      {category !== "all" && filteredLive !== null && filteredLive.length === 0 && live !== null && live.length > 0 && (
        <p className="side-note t-mono">{t(CATEGORY_EMPTY_KEY[category])}</p>
      )}
      {archived.length > 0 && (
        <>
          <button
            type="button"
            className="side-archived-toggle t-mono"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
          >
            {showArchived ? "▾" : "▸"} {t("Home.archivedToggle", { count: archived.length })}
          </button>
          {showArchived &&
            archived.map((c) => (
              <ChannelPill key={c.slug} c={c} active={active} onOpen={onOpen} />
            ))}
        </>
      )}
    </nav>
  );
}

export function ChannelList({ scopeKey, ...props }: Props) {
  return <ScopedChannelList key={scopeKey} {...props} />;
}
