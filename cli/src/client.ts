// ws 客户端：帧异步迭代 + 指数退避重连 + seq 去重 + ack 驱动的游标推进
import type { ClientFrame, ServerFrame } from "@agentparty/shared";

class FrameQueue {
  private items: ServerFrame[] = [];
  private waiters: ((r: IteratorResult<ServerFrame>) => void)[] = [];
  private done = false;

  push(frame: ServerFrame): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: frame, done: false });
    else this.items.push(frame);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<ServerFrame>> {
    const item = this.items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.done) return { value: undefined, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<ServerFrame> {
    return this;
  }
}

export interface ConnectOptions {
  onCursor?: (cursor: number) => void;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
}

export interface Connection {
  frames: AsyncIterable<ServerFrame>;
  send(frame: ClientFrame): void;
  /** 消费方处理完一条 msg 后调用，此时才推进并持久化游标 */
  ack(seq: number): void;
  close(): void;
  readonly cursor: number;
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
  const httpBase = server.replace(/\/+$/, "");
  const wsUrl = httpBase.replace(/^http/, "ws") + `/api/channels/${encodeURIComponent(slug)}/ws`;

  const queue = new FrameQueue();
  let cursor = since;
  // 已入队未 ack 的 seq，broadcast 与 hello 补拉重叠时去重
  const delivered = new Set<number>();
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
      if (s <= cursor) delivered.delete(s);
    }
  };

  const stopPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  // 升级被 http 拒绝时 ws api 分不清 401/404 和断网，用 rest 探测一次
  const probeFatal = async (): Promise<ServerFrame | null> => {
    try {
      const res = await fetch(
        `${httpBase}/api/channels/${encodeURIComponent(slug)}/messages?since=0&limit=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (res.status === 401) {
        return { type: "error", code: "unauthorized", message: "invalid or revoked token, re-run: party init" };
      }
      if (res.status === 404) {
        return { type: "error", code: "not_found", message: `channel not found: ${slug}` };
      }
    } catch {
      // 网络问题，走正常重连
    }
    return null;
  };

  const scheduleReconnect = () => {
    const delay = Math.min(base * 2 ** attempt, max);
    attempt++;
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
    sock.onopen = () => {
      opened = true;
      attempt = 0;
      sock.send(JSON.stringify({ type: "hello", since: cursor }));
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
        if (frame.type === "msg") {
          if (frame.seq <= cursor || delivered.has(frame.seq)) continue;
          delivered.add(frame.seq);
        }
        // 自回声：sent 立即推进游标，自己的消息不会被当成新消息
        if (frame.type === "sent") advance(frame.seq);
        queue.push(frame);
      }
    };
    sock.onclose = () => {
      stopPing();
      if (closed) {
        queue.end();
        return;
      }
      if (!opened) {
        void probeFatal().then((fatal) => {
          if (closed) return;
          if (fatal) {
            closed = true;
            queue.push(fatal);
            queue.end();
            return;
          }
          scheduleReconnect();
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
    get cursor() {
      return cursor;
    },
  };
}
