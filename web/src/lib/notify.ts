import type { MsgFrame } from "@agentparty/shared";

export function shouldNotify(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, permissionGranted: boolean,
): boolean {
  if (!permissionGranted || !documentHidden || myHandle === null) return false;
  if (msg.kind !== "message" || msg.retracted) return false;
  if (msg.sender.handle === myHandle) return false; // 自己发的
  return msg.mentions.includes(myHandle);
}
