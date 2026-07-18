// ws 客户端：帧异步迭代 + 指数退避重连 + seq 去重 + ack 驱动的游标推进
import { parseAgentActivity, parseRunnerHealth } from "@agentparty/shared";
import type { ClientFrame, ServerFrame } from "@agentparty/shared";
import pkg from "../package.json" with { type: "json" };

class FrameQueue {
  private items: ServerFrame[] = [];
  private waiters: Array<{
    resolve: (r: IteratorResult<ServerFrame>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private done = false;
  private failed = false;
  private failure: unknown;

  push(frame: ServerFrame): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: frame, done: false });
    else this.items.push(frame);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failed = true;
    this.failure = error;
    this.items = [];
    for (const w of this.waiters.splice(0)) w.reject(error);
  }

  async next(): Promise<IteratorResult<ServerFrame>> {
    if (this.failed) throw this.failure;
    const item = this.items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.done) return { value: undefined, done: true };
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<ServerFrame> {
    return this;
  }

  // 已缓冲、尚未被消费的帧快照（#103）：serve 串行处理一条 wake 时，其后到达的帧堆在这里。
  // 用于估算「排在身后的 wake 深度」。返回副本，调用方遍历不影响队列。
  snapshot(): ServerFrame[] {
    return [...this.items];
  }

  // 租约 standby 已经取走、但没有 ack 的帧需要在接管时重新排到队首。
  // prepend 而不是 push：它们的 seq 早于当前缓冲区，必须先还旧账再处理新帧。
  prepend(frames: ServerFrame[]): boolean {
    if (this.done || frames.length === 0) return false;
    let index = 0;
    while (index < frames.length) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      waiter.resolve({ value: frames[index]!, done: false });
      index += 1;
    }
    // 禁止 unshift(...frames)：参数展开到数万帧会触发 Maximum call stack size exceeded。
    if (index < frames.length) this.items = frames.slice(index).concat(this.items);
    return true;
  }
}

export const DEFAULT_MAX_UNACKED_FRAMES = 4096;

const RETRYABLE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorCode(error: unknown): string | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return code ? `${message} (${code})` : message;
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

const SENDER_KINDS = new Set(["agent", "human"]);
const MESSAGE_KINDS = new Set(["message", "status"]);
const STATUS_STATES = new Set(["working", "waiting", "blocked", "done"]);
const PRESENCE_STATES = new Set(["online", "offline", "working", "waiting", "blocked", "done"]);
// welcome.mode carries the wire ChannelMode (shared/src/protocol.ts: "normal" | "party"), NOT the
// REST channel-visibility vocabulary (public/private/personal/public_watch). The worker sends mode on
// every welcome, so this MUST stay in lockstep with ChannelMode or parseServerFrame drops every
// welcome frame (serve never learns `self`, watch never registers its delivery adapter).
const CHANNEL_MODES = new Set(["normal", "party"]);
const TOKEN_ROLES = new Set(["agent", "readonly", "owner", "member", "moderator"]);
const DELIVERY_STATES = new Set(["queued", "claimed", "running", "waiting_owner", "replied", "failed"]);
// Mirror DirectedDeliveryCause in shared/src/protocol.ts exactly — "mention_edit" (a mention added by
// editing an existing message) is a real cause; omitting it drops those delivery frames.
const DELIVERY_CAUSES = new Set(["mention", "mention_edit", "reply", "owner_answer", "retry"]);
const ERROR_CODES = new Set([
  "bad_request",
  "unavailable",
  "mention_not_found",
  "mention_ambiguous",
  "unauthorized",
  "rate_limited",
  "too_large",
  "loop_guard",
  "workflow_guard",
  "archived",
  "quota_exceeded",
  "channel_full",
  "not_found",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSender(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.name === "string" &&
    SENDER_KINDS.has(String(value.kind)) &&
    (value.owner === undefined || typeof value.owner === "string") &&
    (value.handle === undefined || typeof value.handle === "string") &&
    (value.display_name === undefined || typeof value.display_name === "string") &&
    (value.avatar_url === undefined || typeof value.avatar_url === "string") &&
    (value.avatar_thumb === undefined || typeof value.avatar_thumb === "string") &&
    (value.client_version === undefined || typeof value.client_version === "string") &&
    (value.connection_count === undefined || isPositiveInteger(value.connection_count));
}

function isStatusEvent(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.owner === "string" &&
    STATUS_STATES.has(String(value.state)) &&
    isStringArray(value.scope) &&
    (value.summary_seq === null || isPositiveInteger(value.summary_seq)) &&
    (value.blocked_reason === null || typeof value.blocked_reason === "string") &&
    isFiniteNumber(value.updated_at);
}

function isPresenceEntry(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.name === "string" &&
    PRESENCE_STATES.has(String(value.state)) &&
    (value.note === null || typeof value.note === "string") &&
    isFiniteNumber(value.ts) &&
    (value.client_version === undefined || typeof value.client_version === "string") &&
    (value.kind === undefined || SENDER_KINDS.has(String(value.kind))) &&
    (value.account === undefined || typeof value.account === "string") &&
    (value.last_seen === undefined || isFiniteNumber(value.last_seen)) &&
    (value.status === undefined || isStatusEvent(value.status)) &&
    (value.handle === undefined || typeof value.handle === "string") &&
    (value.display_name === undefined || typeof value.display_name === "string") &&
    (value.avatar_url === undefined || typeof value.avatar_url === "string") &&
    (value.avatar_thumb === undefined || typeof value.avatar_thumb === "string") &&
    (value.paused === undefined || typeof value.paused === "boolean") &&
    (value.resume_at === undefined || isFiniteNumber(value.resume_at)) &&
    (value.live === undefined || typeof value.live === "boolean") &&
    (value.busy === undefined || typeof value.busy === "boolean") &&
    (value.queue_depth === undefined || isNonNegativeInteger(value.queue_depth)) &&
    (value.waiting_owner_count === undefined || isNonNegativeInteger(value.waiting_owner_count)) &&
    (value.serve_standbys === undefined || isNonNegativeInteger(value.serve_standbys)) &&
    (value.current_task === undefined || isPositiveInteger(value.current_task)) &&
    (value.task_started_at === undefined || isFiniteNumber(value.task_started_at)) &&
    (value.heartbeat_at === undefined || isFiniteNumber(value.heartbeat_at)) &&
    (value.activity === undefined || parseAgentActivity(value.activity) !== undefined) &&
    (value.runner_health === undefined || parseRunnerHealth(value.runner_health) !== undefined) &&
    (value.listening === undefined || value.listening === "suspect" || value.listening === "deaf") &&
    (value.connection_count === undefined || isPositiveInteger(value.connection_count));
}

function isReadCursor(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.name === "string" &&
    (value.kind === undefined || SENDER_KINDS.has(String(value.kind))) &&
    isNonNegativeInteger(value.last_seen_seq) &&
    isFiniteNumber(value.updated_at);
}

function isMessageFrame(value: unknown): boolean {
  return isRecord(value) &&
    (value.type === "msg" || value.type === "status") &&
    isPositiveInteger(value.seq) &&
    isSender(value.sender) &&
    MESSAGE_KINDS.has(String(value.kind)) &&
    typeof value.body === "string" &&
    isStringArray(value.mentions) &&
    (value.reply_to === null || isPositiveInteger(value.reply_to)) &&
    (value.state === null || STATUS_STATES.has(String(value.state))) &&
    (value.note === null || typeof value.note === "string") &&
    (value.status === null || isStatusEvent(value.status)) &&
    isFiniteNumber(value.ts) &&
    (value.edited === undefined || value.edited === true) &&
    (value.edited_at === undefined || isFiniteNumber(value.edited_at)) &&
    (value.edited_by === undefined || typeof value.edited_by === "string") &&
    (value.retracted === undefined || value.retracted === true) &&
    (value.retracted_at === undefined || isFiniteNumber(value.retracted_at)) &&
    (value.retracted_by === undefined || typeof value.retracted_by === "string") &&
    (value.supersedes === undefined || isPositiveInteger(value.supersedes)) &&
    (value.superseded_by === undefined || isPositiveInteger(value.superseded_by)) &&
    (value.rev_seq === undefined || isPositiveInteger(value.rev_seq));
}

function isDirectedDelivery(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    isPositiveInteger(value.message_seq) &&
    typeof value.target_name === "string" &&
    DELIVERY_CAUSES.has(String(value.cause)) &&
    DELIVERY_STATES.has(String(value.state)) &&
    isNonNegativeInteger(value.attempt) &&
    (value.lease_until === null || isFiniteNumber(value.lease_until)) &&
    (value.work_id === null || typeof value.work_id === "string") &&
    (value.continuation_ref === null || typeof value.continuation_ref === "string") &&
    (value.reply_seq === null || isPositiveInteger(value.reply_seq)) &&
    (value.last_error === null || typeof value.last_error === "string") &&
    isFiniteNumber(value.created_at) &&
    isFiniteNumber(value.updated_at);
}

function isPublicDirectedDelivery(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    isPositiveInteger(value.message_seq) &&
    typeof value.target_name === "string" &&
    DELIVERY_STATES.has(String(value.state)) &&
    (value.reply_seq === null || isPositiveInteger(value.reply_seq)) &&
    isFiniteNumber(value.created_at) &&
    isFiniteNumber(value.updated_at);
}

function asServerFrame(value: Record<string, unknown>): ServerFrame {
  return value as unknown as ServerFrame;
}

function parseServerFrame(value: unknown): ServerFrame | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "welcome":
      return typeof value.channel === "string" &&
        typeof value.self === "string" &&
        (value.mode === undefined || CHANNEL_MODES.has(String(value.mode))) &&
        (value.role === undefined || TOKEN_ROLES.has(String(value.role))) &&
        (value.loop_guard === undefined || value.loop_guard === null || typeof value.loop_guard === "string") &&
        Array.isArray(value.participants) &&
        value.participants.every(isSender) &&
        isNonNegativeInteger(value.last_seq) &&
        (value.last_rev_seq === undefined || isNonNegativeInteger(value.last_rev_seq)) &&
        (value.charter_rev === undefined || isNonNegativeInteger(value.charter_rev)) &&
        Array.isArray(value.presence) &&
        value.presence.every(isPresenceEntry) &&
        (value.read_cursors === undefined || (Array.isArray(value.read_cursors) && value.read_cursors.every(isReadCursor))) &&
        (value.directed_delivery === undefined || value.directed_delivery === "v1")
        ? asServerFrame(value)
        : null;
    case "participants":
      return Array.isArray(value.participants) && value.participants.every(isSender) ? asServerFrame(value) : null;
    case "msg":
    case "status":
      return isMessageFrame(value) ? asServerFrame(value) : null;
    case "message_update":
      return isPositiveInteger(value.target_seq) &&
        ["edit", "retract", "supersede", "review", "decision"].includes(String(value.action)) &&
        isSender(value.actor) &&
        isFiniteNumber(value.ts) &&
        isMessageFrame(value.message)
        ? asServerFrame(value)
        : null;
    case "sent":
      return isPositiveInteger(value.seq) ? asServerFrame(value) : null;
    case "presence":
      return isPresenceEntry(value) ? asServerFrame(value) : null;
    case "read_cursor":
      return isReadCursor(value) ? asServerFrame(value) : null;
    case "error":
      return ERROR_CODES.has(String(value.code)) && typeof value.message === "string" ? asServerFrame(value) : null;
    case "pong":
      return Object.keys(value).length === 1 ? asServerFrame(value) : null;
    case "serve_lease":
      return typeof value.name === "string" && typeof value.held === "boolean" ? asServerFrame(value) : null;
    case "delivery_adapter":
      return value.adapter === "watch" && value.registered === true ? asServerFrame(value) : null;
    case "delivery":
      return isDirectedDelivery(value.delivery) && isMessageFrame(value.message) ? asServerFrame(value) : null;
    case "delivery_state":
      return isPublicDirectedDelivery(value.delivery) &&
        (value.request_id === undefined || typeof value.request_id === "string")
        ? asServerFrame(value)
        : null;
    default:
      return null;
  }
}

export interface ConnectOptions {
  onCursor?: (cursor: number) => void;
  /** Declare that this connection consumes durable directed-delivery v1 frames. */
  directedDelivery?: "v1";
  /** 修订游标：已见过的最大 rev_seq，随 hello.since_rev 上报，服务端据此限定修订重放（issue #33） */
  sinceRev?: number;
  onRevCursor?: (revCursor: number) => void;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
  /**
   * WebSocket 已 open、但连续多久没有收到可解析的服务端 frame 后主动重连。
   * 默认 3 个 ping 周期；主要暴露给测试注入较短阈值。
   */
  inboundIdleTimeoutMs?: number;
  /** 未确认消息缓存上限；超限时 fail-fast 且不推进 cursor，交给 supervisor 重启后安全补拉。 */
  maxUnackedFrames?: number;
  /**
   * 连接健康探针（issue #254）：WS 生命周期转场通知，供上层（serve）落本地 health.json。
   * "open" = 握手成功（socket 已连上，尚未必然收到 welcome）；"reconnecting" = 断线后进入退避等待；
   * "closed" = 终局关闭，不会再重连（1008 策略性终局，或探测出的非重试错误）。frame 级的收帧时间戳不
   * 走这里——上层消费 `frames` 时打点即可，onStatus 只报连接状态本身，避免每条消息都要过一遍这里。
   */
  onStatus?: (status: "open" | "reconnecting" | "closed", detail?: { error?: string }) => void;
}

export interface Connection {
  frames: AsyncIterable<ServerFrame>;
  /** True only when the frame was handed to an OPEN socket; callers needing durability must await a server ack. */
  send(frame: ClientFrame): boolean;
  /** 消费方处理完一条 msg 后调用，此时才推进并持久化游标 */
  ack(seq: number): void;
  close(): void;
  /** 已缓冲、尚未消费的帧快照（#103）：估算 serve 排队深度用。 */
  pendingFrames(): ServerFrame[];
  /**
   * 把已经交给消费方、但尚未 ack 的普通消息重新排到队首。
   * serve standby 在租约接管时用它重放未送达 wake；返回实际重排数量。
   */
  replayUnacked(): number;
  readonly cursor: number;
  readonly revCursor: number;
}

function isRevisionSnapshot(frame: ServerFrame): boolean {
  if (frame.type !== "msg" && frame.type !== "status") return false;
  return (
    frame.edited === true ||
    frame.retracted === true ||
    frame.edited_at != null ||
    frame.retracted_at != null ||
    frame.supersedes != null ||
    frame.superseded_by != null ||
    frame.completion_review != null
  );
}

// 同一条修订的身份指纹：hello 补拉每次重连都会重放全部历史修订快照，靠它在进程内
// 只递一次；对同一 seq 的「新一次修订」指纹会变，仍然放行。
function revisionFingerprint(frame: ServerFrame): string {
  if (frame.type !== "msg" && frame.type !== "status") return "";
  return [
    frame.edited_at,
    frame.retracted_at,
    frame.supersedes,
    frame.superseded_by,
    frame.completion_review?.state,
    frame.completion_review?.reviewed_at,
    frame.completion_review?.replaced_by_seq,
    frame.body,
  ].join("|");
}

export function connect(
  server: string,
  token: string,
  slug: string,
  since: number,
  opts: ConnectOptions = {},
): Connection {
  const base = opts.backoffBaseMs ?? 1000;
  const max = opts.backoffMaxMs ?? 30_000;
  const pingEvery = opts.pingIntervalMs ?? 25_000;
  const defaultInboundIdleTimeoutMs = pingEvery * 3;
  const requestedInboundIdleTimeoutMs = opts.inboundIdleTimeoutMs ?? defaultInboundIdleTimeoutMs;
  const inboundIdleTimeoutMs =
    Number.isFinite(requestedInboundIdleTimeoutMs) && requestedInboundIdleTimeoutMs > 0
      ? Math.max(1, Math.floor(requestedInboundIdleTimeoutMs))
      : defaultInboundIdleTimeoutMs;
  const requestedMaxUnackedFrames = opts.maxUnackedFrames ?? DEFAULT_MAX_UNACKED_FRAMES;
  const maxUnackedFrames = Number.isFinite(requestedMaxUnackedFrames)
    ? Math.max(1, Math.floor(requestedMaxUnackedFrames))
    : DEFAULT_MAX_UNACKED_FRAMES;
  const httpBase = server.replace(/\/+$/, "");
  const wsUrl = httpBase.replace(/^http/, "ws") + `/api/channels/${encodeURIComponent(slug)}/ws`;

  const queue = new FrameQueue();
  let cursor = since;
  // 修订游标即时推进（不等 ack）：修订快照是幂等展示事件，收到即视为已见
  let revCursor = opts.sinceRev ?? 0;
  const advanceRev = (rev: number) => {
    if (rev > revCursor) {
      revCursor = rev;
      opts.onRevCursor?.(revCursor);
    }
  };
  // 已入队未 ack 的 seq，broadcast 与 hello 补拉重叠时去重
  const delivered = new Set<number>();
  // 非修订消息的原始帧保留到 ack；serve standby 接管租约时可把已消费但未确认的帧重新排队。
  const unacked = new Map<number, Extract<ServerFrame, { type: "msg" | "status" }>>();
  // 已递过的修订快照 seq → 指纹：跨重连去重（服务端每次 hello 都重放全部历史修订）
  const deliveredRevisions = new Map<number, string>();
  let closed = false;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let inboundWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const advance = (seq: number) => {
    if (seq > cursor) {
      cursor = seq;
      opts.onCursor?.(cursor);
    }
    for (const s of delivered) {
      if (s <= cursor) {
        delivered.delete(s);
        unacked.delete(s);
      }
    }
  };

  const stopPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const stopInboundWatchdog = () => {
    if (inboundWatchdogTimer) {
      clearTimeout(inboundWatchdogTimer);
      inboundWatchdogTimer = null;
    }
  };

  // 升级被 HTTP 拒绝时 WS API 分不清鉴权/频道错误和断网，用 REST 探测一次
  const probeFatal = async (): Promise<ServerFrame | null> => {
    try {
      const res = await fetch(
        `${httpBase}/api/channels/${encodeURIComponent(slug)}/messages?since=0&limit=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (res.status === 401) {
        return { type: "error", code: "unauthorized", message: "invalid or revoked token, re-run: party init" };
      }
      if (res.status === 403) {
        return { type: "error", code: "unauthorized", message: "channel access forbidden" };
      }
      if (res.status === 404) {
        return { type: "error", code: "not_found", message: `channel not found: ${slug}` };
      }
      if (!res.ok) {
        throw new Error(`websocket probe failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
      }
    } catch (error) {
      if (!isRetryableNetworkError(error)) throw error;
      console.debug(`party ws probe: retryable network error; reconnecting: ${errorMessage(error)}`);
    }
    return null;
  };

  // 服务端用 close(1008, reason) 表达策略性终局（archived/revoked/forbidden），与 web ws.ts 的
  // FATAL_REASONS 一致：1008 一律停止重连（transient 断线走 1001/1011/1006，服务端不会用 1008）。
  // 已识别的终局 reason 落成对应 error 帧交给上层映射退出码；未识别的 1008 直接结束帧流（不伪造
  // error），由上层（watch --follow）识别为异常终止。ErrorCode 无 revoked/forbidden，按 spec 归到
  // unauthorized；archived 保留自身码。
  const fatalCloseFrame = (reason: string): ServerFrame | null => {
    switch (reason) {
      case "archived":
        return { type: "error", code: "archived", message: "channel archived" };
      case "revoked":
        return { type: "error", code: "unauthorized", message: "token revoked, re-run: party init" };
      case "forbidden":
        return { type: "error", code: "unauthorized", message: "channel access forbidden" };
      case "unauthorized":
        return { type: "error", code: "unauthorized", message: "unauthorized" };
      default:
        return null;
    }
  };

  const scheduleReconnect = (error?: string) => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(base * 2 ** attempt, max);
    attempt++;
    opts.onStatus?.("reconnecting", error === undefined ? undefined : { error });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) open();
    }, delay);
  };

  const open = () => {
    // bun 的 WebSocket 支持 headers 扩展
    ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    const sock = ws;
    let opened = false;
    let helloSince = 0;
    const armInboundWatchdog = () => {
      stopInboundWatchdog();
      inboundWatchdogTimer = setTimeout(() => {
        inboundWatchdogTimer = null;
        if (closed || ws !== sock || sock.readyState !== WebSocket.OPEN) return;

        // 半开连接未必会及时触发 onclose，不能把重连押在 close 事件上。先把旧 socket
        // 从当前连接退役并进入现有 backoff，再尽力发起关闭；迟到的旧 socket 事件会被忽略。
        ws = null;
        stopPing();
        try {
          sock.close(1011, "inbound idle timeout");
        } catch {
          // The socket is already retired; reconnect scheduling below remains authoritative.
        }
        scheduleReconnect("inbound idle timeout");
      }, inboundIdleTimeoutMs);
    };
    sock.onopen = () => {
      if (closed || ws !== sock) {
        sock.close();
        return;
      }
      opened = true;
      // #373：退避计数不在 TCP/WS 握手完成时清零——否则"accept 后立刻 close"（过载保护/
      // 拒绝/半坏实例）会退化成 ~1 次/秒的无限紧循环锤服务端。改到收到首个业务帧才清零
      // （见 onmessage：解析成功=连接真实可用）。
      helloSince = cursor;
      armInboundWatchdog();
      sock.send(JSON.stringify({
        type: "hello",
        since: cursor,
        since_rev: revCursor,
        client_version: pkg.version,
        ...(opts.directedDelivery === "v1" ? { directed_delivery: "v1" as const } : {}),
      }));
      // External status callbacks may synchronously send an actionable frame on reconnect. Publish
      // OPEN only after hello is on the wire so no callback can overtake the mandatory handshake.
      opts.onStatus?.("open");
      stopPing();
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping" }));
      }, pingEvery);
    };
    sock.onmessage = (ev) => {
      if (closed || ws !== sock) return;
      for (const line of String(ev.data).split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const frame = parseServerFrame(parsed);
        if (frame === null) continue;
        // 只有可解析的服务端 frame 才证明应用层仍可用。畸形字节不能无限续命一个
        // 半坏连接，否则健康探针会持续显示在线而业务帧永远到不了。
        armInboundWatchdog();
        // #373：只有握手/业务帧能证明这次连接恢复了应用层服务。pong 只证明传输层仍有
        // 回包；过载或半坏实例若只回 pong 后断开，不能借此把指数退避反复清零。
        if (frame.type !== "pong") attempt = 0;
        // 全量同步（hello since=0）会带上每条消息的当前状态，历史修订无需单独补——
        // 直接采纳服务端的修订水位，避免下次连接重收一遍
        if (frame.type === "welcome" && helloSince === 0 && typeof frame.last_rev_seq === "number") {
          advanceRev(frame.last_rev_seq);
        }
        // live 修订广播（message_update）也推进修订游标，重连才不会重收这次修订
        if (frame.type === "message_update" && typeof frame.message?.rev_seq === "number") {
          advanceRev(frame.message.rev_seq);
        }
        if (frame.type === "msg" || frame.type === "status") {
          if (typeof frame.rev_seq === "number") advanceRev(frame.rev_seq);
          const revised = isRevisionSnapshot(frame);
          if (revised) {
            // 修订快照允许穿透 seq 去重（要能展示编辑/撤回），但同一修订只递一次
            // （新服务端由 since_rev 精确限定；指纹去重兜底旧服务端的全量重放）
            const fp = revisionFingerprint(frame);
            if (deliveredRevisions.get(frame.seq) === fp) continue;
            deliveredRevisions.set(frame.seq, fp);
          } else {
            if (frame.seq <= cursor || delivered.has(frame.seq)) continue;
            if (unacked.size >= maxUnackedFrames) {
              const error = new Error(
                `unacked replay buffer exceeded ${maxUnackedFrames} frames; terminating without advancing cursor`,
              );
              closed = true;
              stopPing();
              stopInboundWatchdog();
              opts.onStatus?.("closed", { error: error.message });
              queue.fail(error);
              sock.close(1011, "unacked replay buffer exceeded");
              return;
            }
            delivered.add(frame.seq);
            unacked.set(frame.seq, frame);
          }
        }
        // 自回声：sent 立即推进游标，自己的消息不会被当成新消息
        if (frame.type === "sent") advance(frame.seq);
        queue.push(frame);
      }
    };
    sock.onclose = (ev) => {
      // watchdog 已主动退役的旧 socket 可能在新连接建立后才迟到 close；不得误杀新连接的 timer。
      if (ws !== sock) return;
      ws = null;
      stopPing();
      stopInboundWatchdog();
      if (closed) {
        queue.end();
        return;
      }
      // 1008 = 服务端策略性终局：停止重连（否则会无限重连一个死频道，issue #29）。
      if (ev.code === 1008) {
        closed = true;
        const fatal = fatalCloseFrame(ev.reason ?? "");
        if (fatal) queue.push(fatal);
        opts.onStatus?.("closed", fatal && fatal.type === "error" ? { error: fatal.message } : undefined);
        queue.end();
        return;
      }
      if (!opened) {
        void probeFatal()
          .then((fatal) => {
            if (closed) return;
            if (fatal) {
              closed = true;
              queue.push(fatal);
              opts.onStatus?.("closed", fatal.type === "error" ? { error: fatal.message } : undefined);
              queue.end();
              return;
            }
            scheduleReconnect();
          })
          .catch((error: unknown) => {
            if (closed) return;
            closed = true;
            opts.onStatus?.("closed", { error: errorMessage(error) });
            queue.fail(error);
          });
        return;
      }
      scheduleReconnect();
    };
    sock.onerror = () => {
      // close 事件跟随，交给 onclose 处理
    };
  };

  open();

  return {
    frames: queue,
    send(frame: ClientFrame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    ack(seq: number) {
      advance(seq);
    },
    close() {
      if (closed) return;
      closed = true;
      stopPing();
      stopInboundWatchdog();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      queue.end();
    },
    pendingFrames() {
      return queue.snapshot();
    },
    replayUnacked() {
      const pendingSeqs = new Set(
        queue
          .snapshot()
          .filter((frame): frame is Extract<ServerFrame, { type: "msg" | "status" }> => frame.type === "msg" || frame.type === "status")
          .map((frame) => frame.seq),
      );
      const frames = [...unacked.entries()]
        .filter(([seq]) => seq > cursor && !pendingSeqs.has(seq))
        .sort(([a], [b]) => a - b)
        .map(([, frame]) => frame);
      return queue.prepend(frames) ? frames.length : 0;
    },
    get cursor() {
      return cursor;
    },
    get revCursor() {
      return revCursor;
    },
  };
}
