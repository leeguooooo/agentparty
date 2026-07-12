import type { MsgFrame } from "@agentparty/shared";

export function isOwnMention(msg: MsgFrame, myHandle: string | null): boolean {
  if (myHandle === null || msg.kind !== "message" || msg.retracted) return false;
  if (msg.sender.handle === myHandle) return false;
  return msg.mentions.includes(myHandle);
}

export function shouldNotify(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, permissionGranted: boolean,
): boolean {
  return permissionGranted && documentHidden && isOwnMention(msg, myHandle);
}

// 页内 toast 判定（Task R5-toast）：与 shouldNotify 互补。
// 差异：① 仅标签页**聚焦**时（!documentHidden）弹——未聚焦交给 shouldNotify 的系统通知；
//       ② 门槛用 optin（铃铛开关），**不需要**浏览器通知授权（页内 toast 纯 DOM，无需 permission）。
// 其余判定（message 类型 / 未撤回 / 非自己发 / 命中 mentions）与 shouldNotify 一致。
export function shouldToast(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, optin: boolean,
): boolean {
  return optin && !documentHidden && isOwnMention(msg, myHandle);
}

export function nextMentionBadgeCount(
  current: number,
  msg: MsgFrame,
  myHandle: string | null,
  documentHidden: boolean,
): number {
  return documentHidden && isOwnMention(msg, myHandle) ? current + 1 : current;
}

export function shouldMarkSeen(documentHidden: boolean, stickBottom: boolean): boolean {
  return !documentHidden && stickBottom;
}
