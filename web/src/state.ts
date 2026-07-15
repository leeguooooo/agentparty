// 频道页状态：协议帧 → React 状态的唯一归约点。
// 消息按 seq 去重排序；status 帧同时进时间线和 presence 快照；error 帧内联展示不做 toast。
import type {
  ChannelMode,
  DirectedDelivery,
  MsgFrame,
  PresenceEntry,
  PublicDirectedDelivery,
  ReadCursor,
  Sender,
  ServerFrame,
} from "@agentparty/shared";
import type { FatalReason, SocketStatus } from "./lib/ws";
import { MENTION_SENDER_RETENTION_MS, mergeSenderIdentity, type SenderIdentitySnapshot } from "./lib/senderIdentity";

export interface ChannelState {
  self: string | null;
  participants: Sender[];
  mode: ChannelMode;
  presence: Record<string, PresenceEntry>;
  messages: MsgFrame[]; // 按 seq 升序、已去重
  /** 定向 @ 的可靠投递状态；按 delivery id 保存，updated_at 只前进不回退。 */
  directedDeliveries: Record<string, PublicDirectedDelivery>;
  /** 每个近期发信人的最新身份快照；独立于 messages 窗口，trim 后仍可用于 @ 候选。 */
  mentionSenders: Record<string, SenderIdentitySnapshot>;
  readCursors: Record<string, ReadCursor>; // 每身份读到第几条（Phase 2）；人类 + 流式 agent 同表
  status: SocketStatus;
  readonly: boolean; // welcome.role=readonly（或 send 被拒 unauthorized 兜底）→ 隐藏输入框
  archived: boolean; // 灰条 "channel archived"
  forbidden: boolean; // 私有频道 ACL 拒入（spec §3）→ 友好红条，停止重连
  loopGuard: string | null; // 黄条，人类发言可重置
  loopGuardBaselineSeq: number | null; // welcome/error 时的游标；历史回放中的旧 human 消息不能清黄条
  sendError: string | null; // rate_limited / too_large 红条
  lastSentSeq: number; // sent 确认，composer 据此清空草稿
}

export const initialChannelState: ChannelState = {
  self: null,
  participants: [],
  mode: "normal",
  presence: {},
  messages: [],
  directedDeliveries: {},
  mentionSenders: {},
  readCursors: {},
  status: "connecting",
  readonly: false,
  archived: false,
  forbidden: false,
  loopGuard: null,
  loopGuardBaselineSeq: null,
  sendError: null,
  lastSentSeq: 0,
};

export type ChannelAction =
  | { type: "frame"; frame: ServerFrame }
  | { type: "status"; status: SocketStatus }
  | { type: "fatal"; reason: FatalReason }
  | { type: "guard_reset" }
  | { type: "send_failed"; message: string } // 本地发送失败（断线窗口），与 error 帧同走红条
  | { type: "trim"; keep: number }; // IM 窗口上限：贴底时丢弃最老的已加载消息（上翻可重新拉回）

export function channelReducer(state: ChannelState, action: ChannelAction): ChannelState {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };
    case "trim":
      return state.messages.length <= action.keep
        ? state
        : { ...state, messages: state.messages.slice(-action.keep) };
    case "guard_reset":
      return { ...state, loopGuard: null, loopGuardBaselineSeq: null, sendError: null };
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
    if (prev.seq === msg.seq) {
      // 重复（补拉 + 广播交叠）一般忽略；但修订过的旧 seq 可能是重连补拉，
      // 需要覆盖本地旧正文，否则错过 message_update 的页面会一直显示 stale 内容。
      if (isRevisionSnapshot(msg) || isRevisionSnapshot(prev)) {
        const next = messages.slice();
        next[i - 1] = msg;
        return next;
      }
      return messages;
    }
    if (prev.seq < msg.seq) break;
    i--;
  }
  const next = messages.slice();
  next.splice(i, 0, msg);
  return next;
}

function isRevisionSnapshot(msg: MsgFrame): boolean {
  return (
    msg.edited === true ||
    msg.retracted === true ||
    msg.edited_at != null ||
    msg.retracted_at != null ||
    msg.supersedes != null ||
    msg.superseded_by != null ||
    msg.completion_review != null
  );
}

function replaceMessage(messages: MsgFrame[], msg: MsgFrame): MsgFrame[] {
  let replaced = false;
  const next = messages.map((prev) => {
    if (prev.seq !== msg.seq) return prev;
    replaced = true;
    return msg;
  });
  return replaced ? next : insertMessage(messages, msg);
}

function upsertDirectedDelivery(
  deliveries: Record<string, PublicDirectedDelivery>,
  delivery: PublicDirectedDelivery,
): Record<string, PublicDirectedDelivery> | null {
  const previous = deliveries[delivery.id];
  if (previous !== undefined) {
    if (previous.updated_at > delivery.updated_at) return null;
    // Worker can broadcast queued → claimed within the same millisecond. Equal timestamps therefore preserve
    // websocket arrival order; only an actually identical replay is a no-op.
    if (
      previous.updated_at === delivery.updated_at &&
      (Object.keys(delivery) as (keyof PublicDirectedDelivery)[]).every((key) => previous[key] === delivery[key])
    ) {
      return null;
    }
  }
  return { ...deliveries, [delivery.id]: delivery };
}

/**
 * WebSocket frames are a trust boundary. A target holder receives a private `delivery` object so it can
 * execute the work, while the browser may also receive public `delivery_state` snapshots. Project both
 * variants onto the same explicit allow-list before they enter React state: TypeScript's structural typing
 * does not remove extra runtime properties from a full delivery object.
 */
function toPublicDirectedDelivery(
  delivery: DirectedDelivery | PublicDirectedDelivery,
): PublicDirectedDelivery {
  return {
    id: delivery.id,
    message_seq: delivery.message_seq,
    target_name: delivery.target_name,
    state: delivery.state,
    reply_seq: delivery.reply_seq,
    created_at: delivery.created_at,
    updated_at: delivery.updated_at,
  };
}

function rememberMentionSender(
  senders: Record<string, SenderIdentitySnapshot>,
  frame: MsgFrame,
): Record<string, SenderIdentitySnapshot> {
  const previous = senders[frame.sender.name];
  // 上翻加载老页时不把 last-seen 时间或身份倒退：旧帧只能补新快照缺失的字段，不能覆盖新值。
  const previousIsNewer = previous !== undefined && previous.ts > frame.ts;
  const sender = previousIsNewer
    ? mergeSenderIdentity(frame.sender, previous.sender)
    : mergeSenderIdentity(previous?.sender, frame.sender);
  const updated = {
    ...senders,
    [frame.sender.name]: { ts: previousIsNewer ? previous.ts : frame.ts, sender },
  };
  let watermark = frame.ts;
  for (const snapshot of Object.values(updated)) watermark = Math.max(watermark, snapshot.ts);
  return Object.fromEntries(
    Object.entries(updated).filter(([, snapshot]) => watermark - snapshot.ts <= MENTION_SENDER_RETENTION_MS),
  );
}

function applyFrame(state: ChannelState, frame: ServerFrame): ChannelState {
  switch (frame.type) {
    case "welcome": {
      const presence = { ...state.presence };
      for (const p of frame.presence) presence[p.name] = p;
      const readCursors = { ...state.readCursors };
      for (const c of frame.read_cursors ?? []) {
        const prev = readCursors[c.name];
        if (prev === undefined || c.last_seen_seq > prev.last_seen_seq) readCursors[c.name] = c;
      }
      return {
        ...state,
        self: frame.self,
        mode: frame.mode ?? state.mode,
        participants: frame.participants,
        presence,
        readCursors,
        // welcome 首帧即知角色，readonly 分享链接不闪现输入框（spec §9）
        readonly: frame.role === "readonly" ? true : state.readonly,
        loopGuard: frame.loop_guard ?? state.loopGuard,
        loopGuardBaselineSeq: frame.loop_guard != null ? frame.last_seq : state.loopGuardBaselineSeq,
      };
    }
    case "read_cursor": {
      const prev = state.readCursors[frame.name];
      if (prev !== undefined && prev.last_seen_seq >= frame.last_seen_seq) return state;
      return {
        ...state,
        readCursors: {
          ...state.readCursors,
          [frame.name]: {
            name: frame.name,
            kind: frame.kind,
            last_seen_seq: frame.last_seen_seq,
            updated_at: frame.updated_at,
          },
        },
      };
    }
    case "participants":
      return { ...state, participants: frame.participants };
    case "msg":
    case "status": {
      const next: ChannelState = {
        ...state,
        messages: insertMessage(state.messages, frame),
        mentionSenders: rememberMentionSender(state.mentionSenders, frame),
      };
      // 人类发言重置服务端 loop guard 计数，黄条同步撤下
      if (
        frame.sender.kind === "human" &&
        frame.kind === "message" &&
        (state.loopGuardBaselineSeq === null || frame.seq > state.loopGuardBaselineSeq)
      ) {
        next.loopGuard = null;
        next.loopGuardBaselineSeq = null;
      }
      return next;
    }
    case "message_update":
      return {
        ...state,
        messages: replaceMessage(state.messages, frame.message),
        mentionSenders: rememberMentionSender(state.mentionSenders, frame.message),
      };
    case "delivery": {
      const directedDeliveries = upsertDirectedDelivery(
        state.directedDeliveries,
        toPublicDirectedDelivery(frame.delivery),
      );
      // delivery.message is a transport convenience, not a message revision. Never let an older delivery
      // snapshot overwrite a message_update that the page already applied.
      const messages = state.messages.some((message) => message.seq === frame.message.seq)
        ? state.messages
        : insertMessage(state.messages, frame.message);
      if (directedDeliveries === null && messages === state.messages) return state;
      return {
        ...state,
        directedDeliveries: directedDeliveries ?? state.directedDeliveries,
        messages,
        mentionSenders:
          messages === state.messages
            ? state.mentionSenders
            : rememberMentionSender(state.mentionSenders, frame.message),
      };
    }
    case "delivery_state": {
      const directedDeliveries = upsertDirectedDelivery(
        state.directedDeliveries,
        toPublicDirectedDelivery(frame.delivery),
      );
      return directedDeliveries === null ? state : { ...state, directedDeliveries };
    }
    case "presence":
      return {
        ...state,
        presence: {
          ...state.presence,
          [frame.name]: {
            name: frame.name,
            kind: frame.kind,
            account: frame.account,
            state: frame.state,
            note: frame.note,
            ts: frame.ts,
            last_seen: frame.last_seen,
            status: frame.status,
            role: frame.role,
            role_source: frame.role_source,
            residency: frame.residency,
            wake: frame.wake,
            context: frame.context,
            lineage: frame.lineage,
            handle: frame.handle,
            display_name: frame.display_name,
            avatar_url: frame.avatar_url,
            avatar_thumb: frame.avatar_thumb,
            client_version: frame.client_version,
            connection_count: frame.connection_count,
            paused: frame.paused,
            resume_at: frame.resume_at,
            live: frame.live,
            busy: frame.busy,
            queue_depth: frame.queue_depth,
            waiting_owner_count: frame.waiting_owner_count,
            serve_standbys: frame.serve_standbys,
            current_task: frame.current_task,
            task_started_at: frame.task_started_at,
            heartbeat_at: frame.heartbeat_at,
          },
        },
      };
    case "sent":
      return { ...state, lastSentSeq: frame.seq, sendError: null, loopGuard: null, loopGuardBaselineSeq: null };
    case "error":
      // worker 可能先发 error:forbidden 再 1008 关连（private ACL 拒入，spec §3）。
      // "forbidden" 尚未进 shared ErrorCode 联合类型，运行时按字符串识别。
      if ((frame.code as string) === "forbidden") return { ...state, forbidden: true };
      switch (frame.code) {
        case "unauthorized":
          // 契约：send 被拒 unauthorized 即视为 readonly token（吊销场景随后会被 1008 踢线接管）
          return { ...state, readonly: true };
        case "loop_guard":
          return { ...state, loopGuard: frame.message, loopGuardBaselineSeq: state.messages.at(-1)?.seq ?? 0 };
        case "archived":
          return { ...state, archived: true };
        default:
          return { ...state, sendError: frame.message };
      }
    default:
      return state; // pong 等
  }
}
