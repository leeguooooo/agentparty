// 消息渲染：message → doodle 卡片外壳 + mono 元信息 + markdown 正文；
// status → 时间线分隔条（spec §9 第 2 块）。
import type { MsgFrame } from "@agentparty/shared";
import type { CSSProperties } from "react";
import { agentHue } from "../lib/agentColor";
import { fmtTime } from "../lib/time";
import { Markdown } from "./Markdown";

interface Props {
  msg: MsgFrame;
  self: string | null;
}

export function MessageCard({ msg, self }: Props) {
  // 每个 agent 一个确定性色相：CSS 用 --ah 套 hsl() 给头像点/名字/卡片左条上色
  const hueStyle = { "--ah": agentHue(msg.sender.name) } as CSSProperties;
  const owner = msg.sender.owner && msg.sender.owner !== msg.sender.name ? msg.sender.owner : null;
  const lineage = msg.sender.lineage ?? null;
  const lineageLabel = lineage === null ? null : `child of ${lineage.parent_agent}`;
  const senderTitle = [
    `sender: ${msg.sender.name}`,
    `kind: ${msg.sender.kind}`,
    owner ? `owner: ${owner}` : null,
    lineage ? `parent: ${lineage.parent_agent}` : null,
    lineage ? `root: ${lineage.root_agent}` : null,
    lineage ? `team: ${lineage.team_id}` : null,
    lineage ? `depth: ${lineage.depth}` : null,
    lineage?.expires_at ? `expires: ${fmtTime(lineage.expires_at)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
  const revisionBadges = [
    msg.completion_artifact !== undefined ? "completion" : null,
    msg.edited ? "edited" : null,
    msg.retracted ? "retracted" : null,
    msg.supersedes !== undefined ? `supersedes #${msg.supersedes}` : null,
    msg.superseded_by !== undefined ? `superseded by #${msg.superseded_by}` : null,
  ].filter((part): part is string => part !== null);

  if (msg.kind === "status") {
    const statusBits = [
      msg.note,
      msg.status?.scope.length ? `scope ${msg.status.scope.join(", ")}` : null,
      msg.status?.blocked_reason ? `blocked ${msg.status.blocked_reason}` : null,
      msg.status?.summary_seq !== null && msg.status?.summary_seq !== undefined ? `summary #${msg.status.summary_seq}` : null,
    ].filter((part): part is string => typeof part === "string" && part !== "");
    return (
      <div className="msg-status" data-state={msg.state ?? undefined} style={hueStyle}>
        <span>
          <span className="msg-sender" title={senderTitle}>{msg.sender.name}</span>
          {owner !== null && (
            <span className="t-mono msg-owner" title={`owner: ${owner}`}>
              {" "}
              · {owner}
            </span>
          )}{" "}
          {lineageLabel !== null && (
            <span className="t-mono msg-lineage" title={senderTitle}>
              {lineageLabel}
            </span>
          )}{" "}
          → {msg.state}
          {statusBits.length > 0 ? ` · ${statusBits.join(" · ")}` : ""} · {fmtTime(msg.ts)}
        </span>
      </div>
    );
  }

  const mine = self !== null && msg.sender.name === self;
  const artifact = msg.completion_artifact;
  const artifactBits =
    artifact === undefined
      ? []
      : [
          `kickoff #${artifact.kickoff_seq}`,
          `${artifact.replies_count} replies`,
          artifact.timeout ? "timeout" : "closed",
          artifact.related_issues.length > 0 ? `issues ${artifact.related_issues.map((n) => `#${n}`).join(", ")}` : null,
          artifact.related_prs.length > 0 ? `PRs ${artifact.related_prs.map((n) => `#${n}`).join(", ")}` : null,
        ].filter((part): part is string => part !== null);
  return (
    <article className={"d-card msg-card" + (mine ? " msg-card--own" : "")} style={hueStyle}>
      <header className="d-meta msg-head">
        <span className="msg-avatar" aria-hidden="true" />
        <span className="msg-sender" title={senderTitle}>{msg.sender.name}</span>
        {owner !== null && (
          <span className="t-mono msg-owner" title={`owner: ${owner}`}>
            · {owner}
          </span>
        )}
        {lineageLabel !== null && (
          <span className="t-mono msg-lineage" title={senderTitle}>
            {lineageLabel}
          </span>
        )}
        <span className={"msg-kind" + (msg.sender.kind === "human" ? " msg-kind--human" : "")}>
          {msg.sender.kind}
        </span>
        {msg.mentions.map((m) => (
          <span key={m} className="msg-mention">
            @{m}
          </span>
        ))}
        {msg.reply_to !== null && <span className="msg-reply">↩ #{msg.reply_to}</span>}
        {revisionBadges.map((badge) => (
          <span key={badge} className="msg-revision">
            {badge}
          </span>
        ))}
        <span className="msg-fill" />
        <span>#{msg.seq}</span>
        <time>{fmtTime(msg.ts)}</time>
      </header>
      {artifact !== undefined && (
        <div className="msg-completion" aria-label="completion artifact">
          {artifactBits.join(" · ")}
        </div>
      )}
      {msg.retracted ? <p className="msg-retracted">message retracted</p> : <Markdown source={msg.body} />}
    </article>
  );
}
