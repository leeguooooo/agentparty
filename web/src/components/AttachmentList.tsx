// 消息附件渲染（#176）：图片内联缩略图，其它文件给下载按钮。
import { useEffect, useState } from "react";
import type { Attachment } from "@agentparty/shared";
import { fetchAttachmentBlob, fetchAttachmentSignedUrl, getToken } from "../lib/api";

export function isImageAttachment(contentType: string): boolean {
  return contentType.startsWith("image/");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 先换短时签名 URL，让 <img src>、新标签页和 Lark 等不能带 Authorization 的消费端都能读取。
// 老 worker 没有签名接口时回退 blob，保持滚动发布期间兼容。
export function useAttachmentBlobUrl(url: string): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setSrc(null);
    setFailed(false);
    if (url === "") return; // 非图片附件传空串 → 不发请求（hook 不能条件调用，用空串跳过）
    const token = getToken();
    void (async () => {
      if (token) {
        try {
          const signedUrl = await fetchAttachmentSignedUrl(token, url);
          if (alive) setSrc(signedUrl);
          return;
        } catch {
          // Rolling deploy / self-hosted old worker: fall back to the authenticated blob path.
        }
      }
      const blob = await fetchAttachmentBlob(token, url);
      if (!alive) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    })()
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return { src, failed };
}

function ImageThumb({ att }: { att: Attachment }) {
  const { src, failed } = useAttachmentBlobUrl(att.url);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [att.url]);
  if (failed || imageFailed) return <FileLink att={att} />;
  if (src === null) {
    return <span className="msg-attachment-loading t-mono">{att.filename}…</span>;
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" className="msg-attachment-img" title={att.filename}>
      <img src={src} alt={att.filename} loading="lazy" onError={() => setImageFailed(true)} />
    </a>
  );
}

function FileLink({ att }: { att: Attachment }) {
  const onDownload = async () => {
    try {
      const token = getToken();
      if (token) {
        const signedUrl = await fetchAttachmentSignedUrl(token, att.url);
        const a = document.createElement("a");
        a.href = signedUrl;
        a.download = att.filename;
        a.rel = "noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }
      const blob = await fetchAttachmentBlob(null, att.url);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch {
      // 静默失败：下载权限/网络问题在 UI 无 toast 约定下不打断阅读
    }
  };
  return (
    <button
      type="button"
      className="d-btn msg-attachment-file t-mono"
      onClick={() => void onDownload()}
      title={`${att.filename} · ${formatSize(att.size)} · download`}
    >
      <span className="msg-attachment-download-icon" aria-hidden="true">↓</span>
      <span className="msg-attachment-fname">{att.filename}</span>
      <span className="msg-attachment-size">{formatSize(att.size)}</span>
    </button>
  );
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((att) => (
        <div key={att.key} className="msg-attachment">
          {isImageAttachment(att.content_type) ? <ImageThumb att={att} /> : <FileLink att={att} />}
        </div>
      ))}
    </div>
  );
}
