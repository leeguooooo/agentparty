// ws 客户端：帧异步迭代 + 指数退避重连 + seq 去重 + ack 驱动的游标推进
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
  prepend(frames: ServerFrame[]): void {
    if (this.done || frames.length === 0) return;
    // 禁止 unshift(...frames)：参数展开到数万帧会触发 Maximum call stack size exceeded。
    this.items = frames.concat(this.items);
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

export interface ConnectOptions {
  onCursor?: (cursor: number) => void;
  /** 修订游标：已见过的最大 rev_seq，随 hello.since_rev 上报，服务端据此限定修订重放（issue #33） */
  sinceRev?: number;
  onRevCursor?: (revCursor: number) => void;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
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
  send(frame: ClientFrame): void;
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
  const maxUnackedFrames = Math.max(1, Math.floor(opts.maxUnackedFrames ?? DEFAULT_MAX_UNACKED_FRAMES));
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

  const scheduleReconnect = () => {
    const delay = Math.min(base * 2 ** attempt, max);
    attempt++;
    opts.onStatus?.("reconnecting");
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
    sock.onopen = () => {
      opened = true;
      // #373：退避计数不在 TCP/WS 握手完成时清零——否则"accept 后立刻 close"（过载保护/
      // 拒绝/半坏实例）会退化成 ~1 次/秒的无限紧循环锤服务端。改到收到首个业务帧才清零
      // （见 onmessage：解析成功=连接真实可用）。
      helloSince = cursor;
      opts.onStatus?.("open");
      sock.send(JSON.stringify({ type: "hello", since: cursor, since_rev: revCursor, client_version: pkg.version }));
      stopPing();
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping" }));
      }, pingEvery);
    };
    sock.onmessage = (ev) => {
      for (const line of String(ev.data).split("\n")) {
        if (!line.trim()) continue;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(line) as ServerFrame;
        } catch {
          continue;
        }
        // #373：收到首个可解析业务帧 = 连接真实可用（accept-then-close 永远走不到这里），
        // 此刻才把指数退避清零；幂等，之后每帧再置 0 无副作用。
        attempt = 0;
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
      stopPing();
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
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    },
    ack(seq: number) {
      advance(seq);
    },
    close() {
      if (closed) return;
      closed = true;
      stopPing();
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
      queue.prepend(frames);
      return frames.length;
    },
    get cursor() {
      return cursor;
    },
    get revCursor() {
      return revCursor;
    },
  };
}
