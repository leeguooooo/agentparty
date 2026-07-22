// 底部插话框：Markdown、@name mention（动态在线列表补全，issue #39）、Cmd/Ctrl+Enter 发送（spec §9 第 4 块）。
// readonly / archived 时由页面层直接不渲染本组件（错误内联为条幅）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, CSSProperties, DragEvent, KeyboardEvent } from "react";
import type { Attachment } from "@agentparty/shared";
import { formatSize, isImageAttachment, useAttachmentBlobUrl } from "./AttachmentList";
import { agentHue } from "../lib/agentColor";
import {
  activeMentionQuery,
  filterCandidates,
  type DraftMentionStatus,
  type MentionCandidate,
  type MentionTier,
} from "../lib/mentions";
import { useT, type TFunc } from "../i18n/useT";
import { FeatureTip } from "./FeatureTip";
import "../i18n/strings/Composer";
import "../i18n/strings/WakeReceipt";

interface Props {
  draft: string;
  setDraft(value: string): void;
  onSend(): void;
  onEscape?: () => void;
  focusRequest?: number | null;
  ready: boolean; // ws open 才能发
  candidates: MentionCandidate[]; // @ 补全候选（participants ∪ presence，已分档排序）
  mentionStatuses: DraftMentionStatus[]; // 草稿里已 @ 的目标 + 当前存活档位（发送前提醒会不会白发）
  // 附件（#176）：已上传待发的引用 + 选文件/移除回调 + 每文件上传中/错误态。缺省即无附件能力。
  attachments?: Attachment[];
  onPickFiles?: (files: FileList) => void;
  onRemoveAttachment?: (key: string) => void;
  // 在途/失败的上传（每文件一条）；uploading 时禁发，error 时给重试/撤下。
  uploads?: UploadItem[];
  onRetryUpload?: (id: string) => void;
  onCancelUpload?: (id: string) => void;
  uploading?: boolean;
  uploadError?: string | null;
}

// 上传中/失败的附件（#176）：已完成的进 attachments，在途/失败的进 uploads，各自成 chip。
export interface UploadItem {
  id: string;
  filename: string;
  size: number;
  status: "uploading" | "error";
  error?: string;
}

// #377 待发附件预览（参考 Codex）：图片显缩略图 + 角标 ×；非图片显文件名 chip + ×。
function PendingAttachment({
  att,
  onRemove,
  removeLabel,
}: {
  att: Attachment;
  onRemove?: (key: string) => void;
  removeLabel: string;
}) {
  const isImage = isImageAttachment(att.content_type);
  const { src, failed } = useAttachmentBlobUrl(isImage ? att.url : "");
  const removeBtn =
    onRemove === undefined ? null : (
      <button
        type="button"
        className="composer-attachment-remove"
        aria-label={removeLabel}
        onClick={() => onRemove(att.key)}
      >
        ×
      </button>
    );
  if (isImage && !failed) {
    return (
      <li className="composer-attachment composer-attachment--img" title={`${att.filename} · ${formatSize(att.size)}`}>
        {src === null ? (
          <span className="composer-attachment-thumb composer-attachment-thumb--loading" aria-hidden="true" />
        ) : (
          <img className="composer-attachment-thumb" src={src} alt={att.filename} />
        )}
        {removeBtn}
      </li>
    );
  }
  return (
    <li className="composer-attachment t-mono">
      <span className="composer-attachment-name">{att.filename}</span>
      <span className="composer-attachment-size">{formatSize(att.size)}</span>
      {removeBtn}
    </li>
  );
}

const TIER_DOT: Record<MentionTier, string> = { online: "●", wakeable: "◐", recent: "○" };
const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]);
// 发送前状态条把「最近活跃(recent)」也归到「离线·不可唤醒」——发送时它既不在线也不会被唤醒。
const REACH_TIER: Record<MentionTier, "online" | "wakeable" | "offline"> = {
  online: "online",
  wakeable: "wakeable",
  recent: "offline",
};

interface MentionMenuState {
  start: number;
  query: string;
  items: MentionCandidate[];
  active: number;
}

function sameCandidateNames(prev: MentionCandidate[], next: MentionCandidate[]): boolean {
  return prev.length === next.length && prev.every((item, index) => item.name === next[index]?.name);
}

function groupLabel(group: string, t: TFunc): string {
  if (group === "human sessions") return t("Composer.group.humanSessions");
  if (group === "unowned agents") return t("Composer.group.unownedAgents");
  if (group === "squads") return t("Composer.group.squads");
  return group;
}

export function Composer({
  draft,
  setDraft,
  onSend,
  onEscape,
  focusRequest = null,
  ready,
  candidates,
  mentionStatuses,
  attachments = [],
  onPickFiles,
  onRemoveAttachment,
  uploads = [],
  onRetryUpload,
  onCancelUpload,
  uploading = false,
  uploadError = null,
}: Props) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const canAttach = onPickFiles !== undefined;
  const anyUploading = uploading || uploads.some((u) => u.status === "uploading");
  // 有附件时允许空正文发送（纯图片消息）；任一上传在途时禁发，避免发出漏引用的半成品。
  const sendDisabled = !ready || anyUploading || (draft.trim() === "" && attachments.length === 0);
  const TIER_LABEL: Record<MentionTier, string> = {
    online: t("Composer.tier.online"),
    wakeable: t("Composer.tier.wakeable"),
    recent: t("Composer.tier.recent"),
  };
  const reachLabel = (s: DraftMentionStatus): string => {
    const reach = REACH_TIER[s.tier];
    if (reach === "online") return t("WakeReceipt.pre.online");
    if (reach === "wakeable") return t("WakeReceipt.pre.wakeable", { kind: s.wakeKind ?? "wake" });
    return t("WakeReceipt.pre.offline");
  };
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 输入法合成护栏（#729）：单靠 keydown 的 isComposing 不够——WebKit/WKWebView（桌面版）
  // 确认候选时 compositionend 先于确认键的 keydown 触发，那一刻 isComposing 已是 false，
  // 回车会把半成品误发出去。用一个 ref 顶住合成期，并延到下一帧才放开，盖住那次确认 keydown。
  const composingRef = useRef(false);
  const activeMentionRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MentionMenuState | null>(null);

  // 自动增高（#340）：随内容长高、封顶 40vh（超出后框内滚动）；清空 draft 时缩回初始 3 行。
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (ta === null) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }, [draft]);

  useLayoutEffect(() => {
    if (focusRequest === null) return;
    const ta = taRef.current;
    if (ta === null) return;
    ta.focus({ preventScroll: true });
    ta.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusRequest]);

  useEffect(() => {
    if (menu === null) return;
    activeMentionRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [menu?.active, menu?.query, menu?.start]);

  // 光标处是否在打 @<prefix> → 算候选菜单
  const recompute = useCallback(
    (text: string, caret: number) => {
      const q = activeMentionQuery(text, caret);
      if (q === null) {
        setMenu(null);
        return;
      }
      const items = filterCandidates(candidates, q.query);
      setMenu((prev) => {
        if (items.length === 0) return null;
        if (prev !== null && prev.start === q.start && prev.query === q.query && sameCandidateNames(prev.items, items)) {
          return { start: q.start, query: q.query, items, active: Math.min(prev.active, items.length - 1) };
        }
        return { start: q.start, query: q.query, items, active: 0 };
      });
    },
    [candidates],
  );

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  // 选中候选：把 @<query> 替换成 @<name> + 空格，光标移到其后
  const choose = useCallback(
    (cand: MentionCandidate) => {
      const ta = taRef.current;
      if (ta === null || menu === null) return;
      const caret = ta.selectionStart ?? draft.length;
      const before = draft.slice(0, menu.start);
      const after = draft.slice(caret);
      const inserted = `@${cand.name} `;
      const next = before + inserted + after;
      setDraft(next);
      setMenu(null);
      const pos = before.length + inserted.length;
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    },
    [draft, menu, setDraft],
  );

  const onCompositionStart = () => {
    composingRef.current = true;
  };
  const onCompositionEnd = () => {
    // WebKit/WKWebView 里确认候选的 compositionend 早于确认键 keydown——保持护栏到本轮事件结束后
    // 的下一帧再放开，确保那次 Enter 的 keydown 仍被拦住。没有 rAF（测试/SSR）时退回微任务。
    const release = () => {
      composingRef.current = false;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
    else void Promise.resolve().then(release);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing 或护栏 ref 任一为真都视为合成中：前者覆盖 Chrome（keydown 时仍 true），
    // 后者覆盖 WebKit（compositionend 先行、keydown 时已 false）。
    if (e.nativeEvent.isComposing || composingRef.current) return;
    if (menu !== null) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenu((prev) => (prev === null ? prev : { ...prev, active: (prev.active + 1) % prev.items.length }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenu((prev) => (prev === null ? prev : { ...prev, active: (prev.active - 1 + prev.items.length) % prev.items.length }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(menu.items[menu.active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape?.();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSend();
      return;
    }
    // 单独 Enter 发送，但要放过输入法合成中的 Enter（中文/日文候选词确认），否则会误发半成品
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onSend();
    }
  };

  const onKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (NAV_KEYS.has(e.key)) return;
    recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
  };

  // 拖拽到插话框任意处即上传（#176）。dragover 必须 preventDefault，否则浏览器不触发 drop。
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    e.preventDefault();
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // 只有真正离开 composer（而非移到子元素）才收起高亮
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files !== undefined && files.length > 0) onPickFiles?.(files);
  };
  // 剪贴板里带文件（截图/复制的图片或文件）即上传；纯文本粘贴不拦截，走默认插入。
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const files = e.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      e.preventDefault();
      onPickFiles?.(files);
    }
  };

  return (
    <div
      className={"composer" + (dragging ? " composer--dragging" : "")}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="composer-dropzone" aria-hidden="true">
          {t("Composer.attach.dropHere")}
        </div>
      )}
      {menu !== null && (
        <ul className="mention-menu" role="listbox" aria-label="mention suggestions">
          {menu.items.map((c, i) => {
            const prev = menu.items[i - 1];
            const showGroup = prev === undefined || prev.group !== c.group;
            const owner = c.account && c.account !== c.display ? c.account : null;
            const title = [
              c.display,
              owner ? t("Composer.owner", { account: owner }) : "",
              t(`Composer.kind.${c.kind}`),
              c.role ? t("Composer.role", { role: c.role }) : "",
              c.responsibility ? t("Composer.responsibility", { responsibility: c.responsibility }) : "",
              c.note ? t("Composer.note", { note: c.note }) : "",
              c.name !== c.display ? `@${c.name}` : "",
            ].filter(Boolean).join(" · ");
            return (
              <li key={c.name} className="mention-row">
                {showGroup && (
                  <div className="mention-group" aria-hidden="true">
                    {groupLabel(c.group, t)}
                  </div>
                )}
                <div
                  ref={i === menu.active ? activeMentionRef : undefined}
                  role="option"
                  aria-selected={i === menu.active}
                  className={"mention-item" + (i === menu.active ? " is-active" : "")}
                  style={{ "--ah": agentHue(c.name) } as CSSProperties}
                  title={title}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(c);
                  }}
                >
                  <span className="mention-dot" aria-hidden="true" />
                  <span className="mention-main">
                    <span className="mention-name t-mono">{c.display}</span>
                    {owner !== null && <span className="mention-owner t-mono">{owner}</span>}
                  </span>
                  <span className={`mention-kind mention-kind--${c.kind}`}>{t(`Composer.kind.${c.kind}`)}</span>
                  {c.role && <span className="mention-role">{c.role}</span>}
                  {c.responsibility && <span className="mention-responsibility">{c.responsibility}</span>}
                  <span className={`mention-tier mention-tier--${c.tier}`}>
                    {TIER_DOT[c.tier]} {TIER_LABEL[c.tier]}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {mentionStatuses.length > 0 && (
        <ul className="composer-reach" aria-label="mention reachability">
          {mentionStatuses.map((s) => (
            <li key={s.name} className={`composer-reach-item composer-reach-item--${REACH_TIER[s.tier]}`}>
              <span className="composer-reach-dot" aria-hidden="true" />
              <span className="composer-reach-name t-mono">@{s.display}</span>
              <span className="composer-reach-label">{reachLabel(s)}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={taRef}
        className="composer-input t-mono"
        rows={3}
        placeholder={t("Composer.placeholder")}
        value={draft}
        onChange={onChange}
        onKeyUp={onKeyUp}
        onClick={(e) => recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
        onBlur={() => setTimeout(() => setMenu(null), 120)}
      />
      {attachments.length > 0 && (
        <ul className="composer-attachments" aria-label="pending attachments">
          {attachments.map((att) => (
            <PendingAttachment
              key={att.key}
              att={att}
              onRemove={onRemoveAttachment}
              removeLabel={`remove ${att.filename}`}
            />
          ))}
        </ul>
      )}
      {uploads.length > 0 && (
        <ul className="composer-uploads" aria-label="uploads in progress">
          {uploads.map((u) => (
            <li key={u.id} className={`composer-upload composer-upload--${u.status} t-mono`}>
              {u.status === "uploading" ? (
                <span className="composer-upload-spinner" aria-hidden="true" />
              ) : (
                <span className="composer-upload-icon composer-upload-icon--error" aria-hidden="true">!</span>
              )}
              <span className="composer-upload-name">{u.filename}</span>
              {u.status === "uploading" ? (
                <span className="composer-upload-status">{t("Composer.upload.uploading")}</span>
              ) : (
                <span className="composer-upload-status composer-upload-error-text">
                  {u.error ?? t("Composer.upload.failed")}
                </span>
              )}
              {u.status === "error" && onRetryUpload !== undefined && (
                <button
                  type="button"
                  className="composer-upload-retry"
                  onClick={() => onRetryUpload(u.id)}
                >
                  {t("Composer.upload.retry")}
                </button>
              )}
              {onCancelUpload !== undefined && (
                <button
                  type="button"
                  className="composer-upload-cancel"
                  aria-label={`dismiss ${u.filename}`}
                  onClick={() => onCancelUpload(u.id)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {uploadError !== null && <p className="banner banner--red composer-upload-error">{uploadError}</p>}
      <FeatureTip tip="Tips.wake" className="composer-wake-tip" />
      <div className="composer-actions">
        {canAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="composer-file-input"
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files !== null && e.target.files.length > 0) onPickFiles?.(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="d-btn composer-attach"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              title={t("Composer.attach.title")}
            >
              {uploading ? t("Composer.attach.uploading") : t("Composer.attach.label")}
            </button>
          </>
        )}
        <button
          type="button"
          className="d-btn d-btn--primary composer-send"
          onClick={onSend}
          disabled={sendDisabled}
          title={ready ? t("Composer.send.readyTitle") : t("Composer.send.connectingTitle")}
        >
          {t("Composer.send.label")}
        </button>
      </div>
    </div>
  );
}
