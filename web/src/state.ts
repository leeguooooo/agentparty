// 频道页状态：协议帧 → React 状态的唯一归约点。
// 消息按 seq 去重排序；status 帧同时进时间线和 presence 快照；error 帧内联展示不做 toast。
import type { ChannelMode, MsgFrame, PresenceEntry, Sender, ServerFrame } from "@agentparty/shared";
import type { FatalReason, SocketStatus } from "./lib/ws";

export interface ChannelState {
  self: string | null;
  participants: Sender[];
  mode: ChannelMode;
  presence: Record<string, PresenceEntry>;
  messages: MsgFrame[]; // 按 seq 升序、已去重
  status: SocketStatus;
  readonly: boolean; // welcome.role=readonly（或 send 被拒 unauthorized 兜底）→ 隐藏输入框
  archived: boolean; // 灰条 "channel archived"
  forbidden: boolean; // 私有频道 ACL 拒入（spec §3）→ 友好红条，停止重连
  loopGuard: string | null; // 黄条，人类发言可重置
  sendError: string | null; // rate_limited / too_large 红条
  lastSentSeq: number; // sent 确认，composer 据此清空草稿
}

export const initialChannelState: ChannelState = {
  self: null,
  participants: [],
  mode: "normal",
  presence: {},
  messages: [],
  status: "connecting",
  readonly: false,
  archived: false,
  forbidden: false,
  loopGuard: null,
  sendError: null,
  lastSentSeq: 0,
};

export type ChannelAction =
  | { type: "frame"; frame: ServerFrame }
  | { type: "status"; status: SocketStatus }
  | { type: "fatal"; reason: FatalReason }
  | { type: "guard_reset" }
  | { type: "send_failed"; message: string }; // 本地发送失败（断线窗口），与 error 帧同走红条

export function channelReducer(state: ChannelState, action: ChannelAction): ChannelState {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };
    case "guard_reset":
      return { ...state, loopGuard: null, sendError: null };
    case "send_failed":
      return { ...state, sendError: action.message };
    case "fatal":
      // revoked 由页面层接管（回登录闸）；archived / forbidden 在此落地为对应条幅
      if (action.reason === "archived") return { ...state, archived: true };
      if (action.reason === "forbidden") return { ...state, forbidden: true };
      return state;
    case "frame":
      return applyFrame(state, action.frame);
  }
}

// 去重按 seq；帧绝大多数按序到达，从尾部回找插入点
function insertMessage(messages: MsgFrame[], msg: MsgFrame): MsgFrame[] {
  let i = messages.length;
  while (i > 0) {
    const prev = messages[i - 1]!;
    if (prev.seq === msg.seq) return messages; // 重复（补拉 + 广播交叠）
    if (prev.seq < msg.seq) break;
    i--;
  }
  const next = messages.slice();
  next.splice(i, 0, msg);
  return next;
}

function applyFrame(state: ChannelState, frame: ServerFrame): ChannelState {
  switch (frame.type) {
    case "welcome": {
      const presence = { ...state.presence };
      for (const p of frame.presence) presence[p.name] = p;
      return {
        ...state,
        self: frame.self,
        mode: frame.mode ?? state.mode,
        participants: frame.participants,
        presence,
        // welcome 首帧即知角色，readonly 分享链接不闪现输入框（spec §9）
        readonly: frame.role === "readonly" ? true : state.readonly,
        loopGuard: frame.loop_guard ?? state.loopGuard,
      };
    }
    case "participants":
      return { ...state, participants: frame.participants };
    case "msg":
    case "status": {
      const next: ChannelState = { ...state, messages: insertMessage(state.messages, frame) };
      // 人类发言重置服务端 loop guard 计数，黄条同步撤下
      if (frame.sender.kind === "human" && frame.kind === "message") next.loopGuard = null;
      return next;
    }
    case "presence":
      return {
        ...state,
        presence: {
          ...state.presence,
          [frame.name]: {
            name: frame.name,
            state: frame.state,
            note: frame.note,
            ts: frame.ts,
            last_seen: frame.last_seen,
            role: frame.role,
            residency: frame.residency,
            wake: frame.wake,
          },
        },
      };
    case "sent":
      return { ...state, lastSentSeq: frame.seq, sendError: null, loopGuard: null };
    case "error":
      // worker 可能先发 error:forbidden 再 1008 关连（private ACL 拒入，spec §3）。
      // "forbidden" 尚未进 shared ErrorCode 联合类型，运行时按字符串识别。
      if ((frame.code as string) === "forbidden") return { ...state, forbidden: true };
      switch (frame.code) {
        case "unauthorized":
          // 契约：send 被拒 unauthorized 即视为 readonly token（吊销场景随后会被 1008 踢线接管）
          return { ...state, readonly: true };
        case "loop_guard":
          return { ...state, loopGuard: frame.message };
        case "archived":
          return { ...state, archived: true };
        default:
          return { ...state, sendError: frame.message };
      }
    default:
      return state; // pong 等
  }
}
