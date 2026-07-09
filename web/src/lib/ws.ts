// ws 客户端：hello/since 补拉 + 断线指数退避重连（1s 起、上限 30s）+ 25s 心跳。
// 浏览器设不了 Authorization 头：个人 token 走 Sec-WebSocket-Protocol，分享链接才走 ?t=。
import type { ClientFrame, ServerFrame } from "@agentparty/shared";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";
export type FatalReason = "revoked" | "archived" | "forbidden";

const PING_INTERVAL_MS = 25_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// do 用 close(1008, reason) 表达终局，这几种不重连。
// forbidden = 私有频道 ACL 拒入（spec §3）：worker accept-then-close(1008,"forbidden")，
// 与 archived 同套路，客户端据此停止重连并提示，不陷入无限重连。
const FATAL_REASONS: readonly string[] = ["revoked", "archived", "forbidden"];

// 握手阶段被 worker 拒掉（401 吊销等）浏览器只给 1006，连续 N 次握手失败后
// 用 rest 探测 token 是否还活着，避免拿死 token 无限重连
const HANDSHAKE_PROBE_AFTER = 3;

export interface SocketHandlers {
  onFrame(frame: ServerFrame): void;
  onStatus(status: SocketStatus): void;
  onFatal(reason: FatalReason): void;
}

export interface ChannelSocketOptions {
  queryToken?: boolean;
  /** 初始游标：REST 已加载到的最新 seq。hello 从这里起补拉，不再全量重放（IM 式加载） */
  initialCursor?: number;
}

export class ChannelSocket {
  private ws: WebSocket | null = null;
  private cursor = 0; // 本地已见最大 seq，重连 hello 用
  private backoff = BACKOFF_MIN_MS;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private everConnected = false;
  private handshakeFails = 0; // 连续「从未 open 就被关」的次数
  private disposed = false;

  constructor(
    private readonly slug: string,
    private readonly token: string,
    private readonly handlers: SocketHandlers,
    private readonly options: ChannelSocketOptions = {},
  ) {
    this.cursor = options.initialCursor ?? 0;
  }

  connect() {
    if (this.disposed) return;
    this.handlers.onStatus(this.everConnected ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${proto}://${location.host}/api/channels/${this.slug}/ws` +
      (this.options.queryToken === true ? `?t=${encodeURIComponent(this.token)}` : "");
    const ws =
      this.options.queryToken === true
        ? new WebSocket(url)
        : new WebSocket(url, ["agentparty", this.token]);
    this.ws = ws;

    let opened = false;
    let helloSent = false;
    ws.onopen = () => {
      opened = true;
      this.everConnected = true;
      this.handshakeFails = 0;
      this.backoff = BACKOFF_MIN_MS;
      this.handlers.onStatus("open");
      // hello 等 welcome 到了再发（见 onmessage）：welcome.last_rev_seq 作 since_rev，
      // 服务端就不会把全部历史修订快照无条件重放进来——IM 窗口模式下，一条被编辑的
      // 远古消息会被插到窗口最前，导致上翻分页从它往下、中段历史永久跳过（review P1）。
      // 字面量须与 do 的 setWebSocketAutoResponse 配对，不唤醒 do
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "welcome" && !helloSent) {
        helloSent = true;
        // REST 初始页/上翻页携带的就是消息当前状态（含编辑后正文），历史修订无需重放；
        // 窗口内消息的后续修订走 live message_update。旧服务端无 last_rev_seq → 0 = 旧语义。
        this.send({ type: "hello", since: this.cursor, since_rev: frame.last_rev_seq ?? 0 });
      }
      if ((frame.type === "msg" || frame.type === "status") && frame.seq > this.cursor) this.cursor = frame.seq;
      this.handlers.onFrame(frame);
    };

    ws.onclose = (ev) => {
      this.clearPing();
      this.ws = null;
      if (this.disposed) return;
      if (ev.code === 1008 && FATAL_REASONS.includes(ev.reason)) {
        this.handlers.onStatus("closed");
        this.handlers.onFatal(ev.reason as FatalReason);
        return;
      }
      this.handlers.onStatus("reconnecting");
      if (!opened && ++this.handshakeFails >= HANDSHAKE_PROBE_AFTER) {
        void this.probeThenRetry();
        return;
      }
      this.scheduleReconnect();
    };
  }

  // 握手反复失败：先问 rest 一句 token 还行不行，401 即终局回登录闸；网络问题继续退避
  private async probeThenRetry() {
    let revoked = false;
    try {
      const res = await fetch("/api/me", {
        headers: { authorization: `Bearer ${this.token}` },
      });
      revoked = res.status === 401;
    } catch {
      // 网络不通，探测不出结论，按普通断线继续退避
    }
    if (this.disposed) return;
    if (revoked) {
      this.handlers.onStatus("closed");
      this.handlers.onFatal("revoked");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  /** 帧发出去返回 true；连接没开返回 false（调用方决定提示） */
  send(frame: ClientFrame): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  dispose() {
    this.disposed = true;
    this.clearPing();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  private clearPing() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
