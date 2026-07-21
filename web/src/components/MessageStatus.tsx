// 统一消息状态条（Phase 3）：把 Phase 1 的 @ 唤醒回执 + Phase 2 的已读游标合成一条，点开像 Lark 的
// 已读弹层。两条泳道诚实分开：
//   · 已读/未读 = 逐帧流式在读的身份(人类 + serve/watch --follow 的 agent)，靠 read_cursor
//   · @ 提及送达 = 事件驱动 agent(webhook/watch --once)的唤醒回执——它们不逐条读频道，只被 @ 唤醒
// 不把事件驱动 agent 混进「已读」假装它逐条读了。
import type { DirectedDeliveryState, PublicDirectedDelivery } from "@agentparty/shared";
import { useMemo, useState } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/WakeReceipt";
import type { ReadEntry } from "../lib/readList";
import { fmtTime } from "../lib/time";
import type { MentionReceipt, ReceiptState } from "../lib/wakeReceipt";

const RECEIPT_ICON: Record<ReceiptState, string> = {
  replied: "success",
  working: "waiting",
  woke: "success",
  wake_failed: "failed",
  delivered: "success",
  pending_wake: "waiting",
  pending_reconnect: "waiting",
};

const DELIVERY_ICON: Record<DirectedDeliveryState, string> = {
  queued: "waiting",
  claimed: "waiting",
  running: "waiting",
  waiting_owner: "waiting",
  replied: "success",
  failed: "failed",
};

interface Props {
  receipts: MentionReceipt[];
  readers: ReadEntry[];
  unread: ReadEntry[];
  display: (name: string) => string;
  deliveries?: PublicDirectedDelivery[];
}

function kindLabel(kind: "agent" | "human" | undefined): string {
  return kind === "human" ? "H" : "A";
}

export function MessageStatus({ receipts, readers, unread, display, deliveries = [] }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasRead = readers.length > 0 || unread.length > 0;
  const deliveryTargets = useMemo(() => new Set(deliveries.map((delivery) => delivery.target_name)), [deliveries]);
  // v1 directed delivery is authoritative. Keep legacy wake receipts only for targets without a durable delivery row.
  const visibleReceipts = receipts.filter((receipt) => !deliveryTargets.has(receipt.name));
  const hasDetails = hasRead || visibleReceipts.length > 0 || deliveries.length > 0;
  if (!hasDetails) return null;

  const receiptText = (r: MentionReceipt): string => {
    const base = t(`WakeReceipt.state.${r.state}`, { detail: r.detail ?? "" });
    return r.state === "woke" && r.at !== null ? `${base} ${fmtTime(r.at)}` : base;
  };
  const receiptTitle = (r: MentionReceipt): string =>
    t(`WakeReceipt.title.${r.state}`, { name: display(r.name), detail: r.detail ?? "" });
  // #667：终态 failed 若带 undelivered（排队超时/对端无唤醒通道），用「未送达」独立文案，与「跑了但失败」区分。
  const deliveryStateKey = (delivery: PublicDirectedDelivery): string =>
    delivery.state === "failed" && delivery.undelivered === true ? "undelivered" : delivery.state;
  const deliveryText = (delivery: PublicDirectedDelivery): string =>
    t(`WakeReceipt.delivery.state.${deliveryStateKey(delivery)}`);
  const deliveryTitle = (delivery: PublicDirectedDelivery): string =>
    [
      t("WakeReceipt.delivery.title", {
        name: display(delivery.target_name),
        state: deliveryText(delivery),
      }),
      // Browser status is deliberately coarse even when a private target frame
      // happens to contain more fields. Never surface work/session correlation
      // or arbitrary runner errors into a cross-organization channel tooltip.
      delivery.reply_seq !== null ? `reply: #${delivery.reply_seq}` : null,
    ].filter((part): part is string => part !== null).join("\n");

  return (
    <div className="msg-status-bar">
      <div className="msg-status-line">
        {hasDetails && (
          <button
            type="button"
            className={"msg-status-summary" + (open ? " is-open" : "")}
            aria-expanded={open}
            aria-label={t(open ? "WakeReceipt.details.collapse" : "WakeReceipt.details.expand")}
            onClick={() => setOpen((v) => !v)}
          >
            {hasRead ? (
              <>
                <span className="msg-status-read">
                  <span className="ap-sprite ap-sprite--success" aria-hidden="true" /> {t("WakeReceipt.read.read", { n: readers.length })}
                </span>
                {unread.length > 0 && (
                  <span className="msg-status-unread"> · {t("WakeReceipt.read.unread", { n: unread.length })}</span>
                )}
              </>
            ) : (
              <span className="msg-status-unread">
                {t(deliveries.length > 0 ? "WakeReceipt.delivery.section" : "WakeReceipt.read.mentionSection")}
              </span>
            )}
            <span className="msg-status-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        )}
        {deliveries.map((delivery) => (
          <span
            key={delivery.id}
            className={`msg-receipt msg-delivery msg-delivery--${deliveryStateKey(delivery)}`}
            title={deliveryTitle(delivery)}
            aria-label={deliveryTitle(delivery)}
            tabIndex={0}
            data-delivery-id={delivery.id}
          >
            <span className={`msg-receipt-icon ap-sprite ap-sprite--${DELIVERY_ICON[delivery.state]}`} aria-hidden="true" />
            <span className="msg-receipt-name t-mono">@{display(delivery.target_name)}</span>
            <span className="msg-receipt-label">{deliveryText(delivery)}</span>
          </span>
        ))}
        {visibleReceipts.map((r) => (
          <span
            key={r.name}
            className={`msg-receipt msg-receipt--${r.state}`}
            title={receiptTitle(r)}
            aria-label={receiptTitle(r)}
            tabIndex={0}
          >
            <span className={`msg-receipt-icon ap-sprite ap-sprite--${RECEIPT_ICON[r.state]}`} aria-hidden="true" />
            <span className="msg-receipt-name t-mono">@{display(r.name)}</span>
            <span className="msg-receipt-label">{receiptText(r)}</span>
          </span>
        ))}
      </div>
      {open && hasDetails && (
        <div className="msg-status-pop" role="group">
          {hasRead && (
            <section className="msg-status-group">
              <h4 className="msg-status-group-head">{t("WakeReceipt.read.readSection", { n: readers.length })}</h4>
              {readers.length === 0 ? (
                <p className="msg-status-empty">{t("WakeReceipt.read.none")}</p>
              ) : (
                <ul className="msg-status-names">
                  {readers.map((e) => (
                    <li key={e.name} className="msg-status-name">
                      <span className={`msg-status-kind msg-status-kind--${e.kind ?? "agent"}`} aria-hidden="true">
                        {kindLabel(e.kind)}
                      </span>{" "}
                      <span className="t-mono">{display(e.name)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {unread.length > 0 && (
            <section className="msg-status-group">
              <h4 className="msg-status-group-head">{t("WakeReceipt.read.unreadSection", { n: unread.length })}</h4>
              <ul className="msg-status-names">
                {unread.map((e) => (
                  <li key={e.name} className="msg-status-name msg-status-name--unread">
                    <span className={`msg-status-kind msg-status-kind--${e.kind ?? "agent"}`} aria-hidden="true">
                      {kindLabel(e.kind)}
                    </span>{" "}
                    <span className="t-mono">{display(e.name)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {deliveries.length > 0 && (
            <section className="msg-status-group">
              <h4 className="msg-status-group-head">{t("WakeReceipt.delivery.section")}</h4>
              <p className="msg-status-note">{t("WakeReceipt.delivery.note")}</p>
              <ul className="msg-status-names">
                {deliveries.map((delivery) => (
                  <li
                    key={delivery.id}
                    className={`msg-status-name msg-delivery--${deliveryStateKey(delivery)}`}
                    title={deliveryTitle(delivery)}
                    aria-label={deliveryTitle(delivery)}
                    tabIndex={0}
                  >
                    <span className={`msg-receipt-icon ap-sprite ap-sprite--${DELIVERY_ICON[delivery.state]}`} aria-hidden="true" />{" "}
                    <span className="t-mono">@{display(delivery.target_name)}</span>
                    <span className="msg-status-name-state"> — {deliveryText(delivery)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {visibleReceipts.length > 0 && (
            <section className="msg-status-group">
              <h4 className="msg-status-group-head">{t("WakeReceipt.read.mentionSection")}</h4>
              <p className="msg-status-note">{t("WakeReceipt.read.agentNote")}</p>
              <ul className="msg-status-names">
                {visibleReceipts.map((r) => (
                  <li
                    key={r.name}
                    className={`msg-status-name msg-receipt--${r.state}`}
                    title={receiptTitle(r)}
                    aria-label={receiptTitle(r)}
                    tabIndex={0}
                  >
                    <span className={`msg-receipt-icon ap-sprite ap-sprite--${RECEIPT_ICON[r.state]}`} aria-hidden="true" />{" "}
                    <span className="t-mono">@{display(r.name)}</span>
                    <span className="msg-status-name-state"> — {receiptText(r)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
