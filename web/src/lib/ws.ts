// ws 客户端：hello/since 补拉 + 断线指数退避重连（1s 起、上限 30s）+ 25s 心跳。
// 浏览器设不了 Authorization 头：个人 token 走 Sec-WebSocket-Protocol，分享链接才走 ?t=。
import type { ClientFrame, ServerFrame } from "@agentparty/shared";
import { apiUrl, wsUrl } from "./base";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";
export type FatalReason = "revoked" | "archived" | "forbidden";

const PING_INTERVAL_MS = 25_000;
// 静默死连接看门狗阈值（issue #130）。健康连接下 do 的 setWebSocketAutoResponse 会对每个 ping 即时
// 回 pong，所以每个 interval 都会刷新 lastFrameAt。取 2×interval：容忍一整个心跳周期的抖动/单帧丢失，
// 但连续两个周期（含至少一个完整 ping→pong 往返）一帧不回，就判定链路已死。取值直接采纳 issue #130
// 的建议（"lastFrameAt 超 2×interval 主动 close"），也与 do 判 offline 的 60s 无帧同数量级、略更灵敏。
const PONG_TIMEOUT_MS = 2 * PING_INTERVAL_MS;
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
  private revCursor = 0; // 本地已消费最大 rev_seq，重连 hello.since_rev 用（issue #117）
  private revSeeded = false; // 首个 welcome 是否已用 last_rev_seq 播种 revCursor
  private backoff = BACKOFF_MIN_MS;
  private pingTimer: number | null = null;
  private lastFrameAt = 0; // 最近一次收到任何入站帧（含 pong）的时刻，心跳看门狗判活用（issue #130）
  // 当前这段「已发 ping 但一帧未回」沉默窗口的起点（epoch ms）；0 = 无在途未答 ping。
  // 看门狗据 now - lastPingAt 判死，而不是「lastFrameAt 超 2×interval」——后台标签页 timer 被节流到
  // ~60s/次时，后者会把每个 ping 都即时收到 pong 的健康连接误判掉线、每分钟无谓重连一次（issue #634）。
  private lastPingAt = 0;
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
    const url =
      wsUrl(`/api/channels/${this.slug}/ws`) +
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
      this.lastFrameAt = Date.now(); // 看门狗基线：刚连上视为"此刻收到过帧"，避免首个周期误判死连接
      this.lastPingAt = 0; // 新连接尚无在途未答 ping
      this.handlers.onStatus("open");
      // hello 等 welcome 到了再发（见 onmessage）：welcome.last_rev_seq 作 since_rev，
      // 服务端就不会把全部历史修订快照无条件重放进来——IM 窗口模式下，一条被编辑的
      // 远古消息会被插到窗口最前，导致上翻分页从它往下、中段历史永久跳过（review P1）。
      // 字面量须与 do 的 setWebSocketAutoResponse 配对，不唤醒 do
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        // 静默死连接（TCP 半开）看门狗：健康连接下每个 ping 都会被 do 即时 pong 回来刷新 lastFrameAt。
        // 判死只认「确实发过 ping，且自那以后一帧未回（含 pong），且真实墙钟已过 PONG_TIMEOUT_MS」——
        // 用 now - lastPingAt 这个真实时间戳差判活，而不是假设 interval 准点触发。后台标签页 timer 被浏览器
        // 节流到 ~60s/次时，旧的「lastFrameAt 超 2×interval」会把每个 ping 都即时收到 pong 的健康连接
        // 误判掉线、每分钟无谓重连（issue #634）；这里只要上一个 ping 收到过回帧，沉默窗口就被 onmessage
        // 归零，节流拉长的 tick 间隔完全不触发判死。真死连接（ping 发出、pong 石沉大海）照样在窗口越界后
        // 主动 close + 重连，绝不把"沉默"当成健康继续显示 open（issue #130）。
        if (this.lastPingAt > 0 && now - this.lastPingAt > PONG_TIMEOUT_MS) {
          this.handleStaleConnection(ws);
          return;
        }
        ws.send('{"type":"ping"}');
        // 沉默窗口起点只在「上一个 ping 已被回帧确认」（lastPingAt 已被 onmessage 归零）时才前移，
        // 已有在途未答 ping 则保留旧起点，否则每 tick 重发 ping 会不断刷新窗口、把死连接拖成永不判定。
        if (this.lastPingAt === 0) this.lastPingAt = now;
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      // 任何入站帧（含 pong）都证明链路还活着 → 刷新看门狗时钟、归零在途未答 ping 窗口（issue #130 / #634）
      this.lastFrameAt = Date.now();
      this.lastPingAt = 0;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "welcome" && !helloSent) {
        helloSent = true;
        // 首连：REST 初始页/上翻页携带的就是消息当前状态（含编辑后正文），历史修订无需重放，
        //   直接以服务端当前修订水位 last_rev_seq 作 revCursor 基线。旧服务端无 last_rev_seq → 0 = 旧语义。
        // 重连：必须用本地维护的 revCursor（已消费的最大 rev_seq）作 since_rev，绝不用新 welcome 的
        //   last_rev_seq 覆盖——否则断线窗口内发生的 edit/retract（原地 UPDATE，只 bump rev_seq）
        //   会落在 (旧 revCursor, 新 last_rev_seq] 区间被服务端补拉跳过，页面永久停留在原文（issue #117）。
        if (!this.revSeeded) {
          this.revCursor = frame.last_rev_seq ?? 0;
          this.revSeeded = true;
        }
        this.send({ type: "hello", since: this.cursor, since_rev: this.revCursor });
      }
      if ((frame.type === "msg" || frame.type === "status") && frame.seq > this.cursor) this.cursor = frame.seq;
      // 收到带 rev_seq 的修订快照（hello 补拉/live）或 live message_update 后推进 revCursor，
      // 下次重连才不会把这次修订再补拉一遍，也保证重连补拉的下界正确（issue #117）。
      if (frame.type === "msg" || frame.type === "status") this.advanceRev(frame.rev_seq);
      if (frame.type === "message_update") this.advanceRev(frame.message.rev_seq);
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
      const res = await fetch(apiUrl("/api/me"), {
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
    // 退避加 jitter（issue #634）：同频道多客户端常被同一次 DO 驱逐/重启/worker 部署/网络抖动同时断开，
    // 纯确定性退避会让它们在 1s/2s/4s 精确同拍重连，形成惊群反复打垮刚恢复的 ChannelDO，再把整群
    // 同步到下一轮。抖到 [0.5, 1)×backoff 把重连摊开到窗口内，天花板仍按 backoff 确定性翻倍。
    const delay = this.backoff * (0.5 + Math.random() * 0.5);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
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

  // 修订游标只前移：修订快照是幂等展示事件，收到即视为已消费（不等 ack，与 CLI client.ts 对齐）。
  private advanceRev(rev: number | undefined) {
    if (typeof rev === "number" && rev > this.revCursor) this.revCursor = rev;
  }

  // 看门狗判定连接已死（发了 ping 但 PONG_TIMEOUT_MS 内无任何回帧）：主动收尾并自驱重连。
  // 先摘掉 handler 再 close——半开死连接的 onclose 可能迟迟不触发，摘掉后既不依赖它，也防止 close()
  // 迟到的 onclose 又走一遍 scheduleReconnect 造成双连接。收尾等价于 onclose 的 transient 分支
  // （opened=true 时的非 1008 断线）：翻 reconnecting + 退避重连（issue #130）。
  private handleStaleConnection(ws: WebSocket) {
    this.clearPing();
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close(4000, "stale");
    } catch {
      // 已处于 CLOSING/CLOSED，忽略
    }
    if (this.ws === ws) this.ws = null;
    if (this.disposed) return;
    this.handlers.onStatus("reconnecting");
    this.scheduleReconnect();
  }

  private clearPing() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
