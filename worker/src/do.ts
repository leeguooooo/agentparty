// channel durable object — seq 分配 / 广播 / presence / 补拉 / 各类熔断 / webhook 投递 / temp 归档
import {
  BODY_LIMIT,
  LOOP_GUARD_N,
  LOOP_GUARD_PARTY_N,
  MAX_WEBHOOKS_PER_CHANNEL,
  MAX_WEBHOOK_QUEUE_ROWS,
  PRESENCE_TIMEOUT_MS,
  RATE_LIMIT_PER_MIN,
  RETAIN_N,
  TEMP_IDLE_ARCHIVE_MS,
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_RETRY_BATCH_SIZE,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
  type ErrorCode,
  type CollaborationRole,
  type MsgFrame,
  type PresenceEntry,
  type PresenceFrame,
  type Residency,
  type SendFrame,
  type SearchHit,
  type Sender,
  type SenderKind,
  type ServerFrame,
  type StatusEvent,
  type StatusState,
  type TokenRole,
  type WakeInfo,
  type WakeKind,
} from "@agentparty/shared";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";

interface ConnState {
  name: string;
  kind: SenderKind;
  role: TokenRole;
  owner?: string;
  tokenHash: string;
  archived: boolean;
  lastSeen: number;
}

interface Identity {
  name: string;
  kind: SenderKind;
  role: TokenRole;
  owner?: string;
  tokenHash: string;
}

interface WebhookDeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

type SendOutcome =
  | { ok: true; seq: number; frames: ServerFrame[] }
  | { ok: false; code: ErrorCode; message: string };
type SendErrorOutcome = Extract<SendOutcome, { ok: false }>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 403,
  rate_limited: 429,
  too_large: 413,
  loop_guard: 409,
  archived: 410,
  not_found: 404,
};

// presence 扫描周期（spec §5：60s 无帧判 offline）
export const PRESENCE_SCAN_MS = PRESENCE_TIMEOUT_MS;

const STATUS_STATES: readonly string[] = ["working", "waiting", "blocked", "done"];
const COLLAB_ROLES: readonly string[] = ["host", "worker", "reviewer", "observer"];
const RESIDENCIES: readonly string[] = ["supervised", "webhook", "bare", "human_driven", "unknown"];
const WAKE_KINDS: readonly string[] = ["none", "watch", "serve", "webhook"];
const MENTION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_MENTIONS = 50;
const MENTIONS_JSON_LIMIT = 4096;
const MAX_STATUS_SCOPE = 50;
const STATUS_SCOPE_JSON_LIMIT = 4096;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function parseMentions(input: unknown): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  if (
    input.length > MAX_MENTIONS ||
    input.some((m) => typeof m !== "string" || !MENTION_NAME_RE.test(m)) ||
    byteLength(JSON.stringify(input)) > MENTIONS_JSON_LIMIT
  ) {
    return null;
  }
  return input as string[];
}

function parseStatusScope(input: unknown): string[] | undefined | null {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return null;
  if (
    input.length > MAX_STATUS_SCOPE ||
    input.some((item) => typeof item !== "string" || item.trim() === "") ||
    byteLength(JSON.stringify(input)) > STATUS_SCOPE_JSON_LIMIT
  ) {
    return null;
  }
  return input as string[];
}

function parseOptionalPositiveSeq(input: unknown): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input === "number" && Number.isInteger(input) && input > 0) return input;
  return undefined;
}

function parseStoredScope(input: unknown): string[] {
  if (typeof input !== "string" || input === "") return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function statusEventFromRow(r: Record<string, unknown>, owner: string, state: StatusState, updatedAt: number): StatusEvent {
  return {
    owner,
    state,
    scope: parseStoredScope(r.status_scope_json),
    summary_seq: r.status_summary_seq === null || r.status_summary_seq === undefined ? null : Number(r.status_summary_seq),
    blocked_reason:
      r.status_blocked_reason === null || r.status_blocked_reason === undefined
        ? null
        : String(r.status_blocked_reason),
    updated_at: updatedAt,
  };
}

function parseCollaborationRole(input: unknown): CollaborationRole | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !COLLAB_ROLES.includes(input)) return null;
  return input as CollaborationRole;
}

function parseResidency(input: unknown): Residency | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !RESIDENCIES.includes(input)) return null;
  return input as Residency;
}

function parseWake(input: unknown): WakeInfo | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) return null;
  const w = input as Record<string, unknown>;
  if (typeof w.kind !== "string" || !WAKE_KINDS.includes(w.kind)) return null;
  if (w.verified_at !== undefined && (typeof w.verified_at !== "number" || !Number.isInteger(w.verified_at))) {
    return null;
  }
  return w.verified_at === undefined
    ? { kind: w.kind as WakeKind }
    : { kind: w.kind as WakeKind, verified_at: w.verified_at };
}

// rest body 与 ws send 帧共用的校验（rest 侧无 type 字段）
function parseSendFrame(input: unknown): SendFrame | null {
  if (typeof input !== "object" || input === null) return null;
  const f = input as Record<string, unknown>;
  if (f.kind === "message") {
    if (typeof f.body !== "string") return null;
    const mentions = parseMentions(f.mentions);
    if (mentions === null) return null;
    const reply_to =
      f.reply_to === undefined || f.reply_to === null
        ? null
        : typeof f.reply_to === "number" && Number.isInteger(f.reply_to) && f.reply_to > 0
          ? f.reply_to
          : undefined;
    if (reply_to === undefined) return null;
    return { type: "send", kind: "message", body: f.body, mentions, reply_to };
  }
  if (f.kind === "status") {
    if (typeof f.state !== "string" || !STATUS_STATES.includes(f.state)) return null;
    const note = typeof f.note === "string" ? f.note : "";
    const mentions = parseMentions(f.mentions);
    if (mentions === null) return null;
    const role = parseCollaborationRole(f.role);
    if (role === null) return null;
    const residency = parseResidency(f.residency);
    if (residency === null) return null;
    const wake = parseWake(f.wake);
    if (wake === null) return null;
    const scope = parseStatusScope(f.scope);
    if (scope === null) return null;
    const summarySeq = parseOptionalPositiveSeq(f.summary_seq);
    if (summarySeq === undefined && f.summary_seq !== undefined) return null;
    const blockedReason =
      f.blocked_reason === undefined || f.blocked_reason === null
        ? undefined
        : typeof f.blocked_reason === "string"
          ? f.blocked_reason
          : null;
    if (blockedReason === null) return null;
    return {
      type: "send",
      kind: "status",
      state: f.state as StatusState,
      note,
      mentions,
      ...(scope !== undefined ? { scope } : {}),
      ...(summarySeq !== undefined ? { summary_seq: summarySeq } : {}),
      ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(residency !== undefined ? { residency } : {}),
      ...(wake !== undefined ? { wake } : {}),
    };
  }
  return null;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface WebhookRow {
  name: string;
  url: string;
  secret: string;
  filter: string;
}

function toInt(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function firstMatchingField(frame: MsgFrame, query: string): SearchHit["match_field"] {
  const q = query.toLowerCase();
  if (frame.kind === "status" && (frame.note ?? "").toLowerCase().includes(q)) return "note";
  if (frame.body.toLowerCase().includes(q)) return "body";
  return "sender";
}

function snippetFor(frame: MsgFrame, field: SearchHit["match_field"]): string {
  const text = field === "sender" ? frame.sender.name : field === "note" ? (frame.note ?? "") : frame.body;
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

export class ChannelDO extends Server<Env> {
  static options = { hibernate: true };

  onStart() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY,
      sender_name TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      sender_owner TEXT,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      reply_to INTEGER,
      state TEXT,
      note TEXT,
      status_scope_json TEXT,
      status_summary_seq INTEGER,
      status_blocked_reason TEXT,
      ts INTEGER NOT NULL
    )`);
    // 历史消息也要带 sender 所属人：给早于本次的 do 表补列（新表已含，重复 ALTER 会抛，吞掉）
    try {
      sql.exec("ALTER TABLE messages ADD COLUMN sender_owner TEXT");
    } catch {
      // 列已存在
    }
    for (const ddl of [
      "ALTER TABLE messages ADD COLUMN status_scope_json TEXT",
      "ALTER TABLE messages ADD COLUMN status_summary_seq INTEGER",
      "ALTER TABLE messages ADD COLUMN status_blocked_reason TEXT",
    ]) {
      try {
        sql.exec(ddl);
      } catch {
        // 列已存在
      }
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS presence (
      name TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL,
      status_scope_json TEXT,
      status_summary_seq INTEGER,
      status_blocked_reason TEXT,
      role TEXT,
      residency TEXT,
      wake_kind TEXT,
      wake_verified_at INTEGER
    )`);
    for (const ddl of [
      "ALTER TABLE presence ADD COLUMN role TEXT",
      "ALTER TABLE presence ADD COLUMN residency TEXT",
      "ALTER TABLE presence ADD COLUMN wake_kind TEXT",
      "ALTER TABLE presence ADD COLUMN wake_verified_at INTEGER",
      "ALTER TABLE presence ADD COLUMN status_scope_json TEXT",
      "ALTER TABLE presence ADD COLUMN status_summary_seq INTEGER",
      "ALTER TABLE presence ADD COLUMN status_blocked_reason TEXT",
    ]) {
      try {
        sql.exec(ddl);
      } catch {
        // 列已存在
      }
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rate (
      name TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, bucket)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS webhooks (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      filter TEXT NOT NULL DEFAULT 'mentions',
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS webhook_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS wake_delivery_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mention_seq INTEGER NOT NULL,
      target_name TEXT NOT NULL,
      webhook_name TEXT NOT NULL,
      adapter_kind TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      result TEXT NOT NULL,
      http_status INTEGER,
      error TEXT,
      attempted_at INTEGER NOT NULL,
      ack_seq INTEGER,
      resume_seq INTEGER
    )`);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  async onConnect(connection: Connection<ConnState>, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const state: ConnState = {
      name: h.get("x-ap-name") ?? "",
      kind: h.get("x-ap-kind") === "agent" ? "agent" : "human",
      role: (h.get("x-ap-role") ?? "readonly") as TokenRole,
      owner: h.get("x-ap-owner") ?? undefined,
      tokenHash: h.get("x-ap-token-hash") ?? "",
      archived: h.get("x-ap-archived") === "1",
      lastSeen: Date.now(),
    };
    connection.setState(state);
    // mode/kind/host 随升级请求进来，写 meta 缓存（同 archived 的手法）
    this.cacheChannelMeta(h, new URL(ctx.request.url).host);
    // 归档以 do 自己的记录为权威，升级窗口内的快照竞态也拦得住
    if (state.archived) this.setMeta("archived", "1");
    if (state.archived || this.isArchived()) {
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
      return;
    }
    const loopGuard = this.loopGuardMessage();
    this.sendFrame(connection, {
      type: "welcome",
      channel: this.name,
      self: state.name,
      mode: this.getMeta("mode") === "party" ? "party" : "normal",
      role: state.role,
      loop_guard: loopGuard,
      participants: this.participants(),
      last_seq: this.lastSeq(),
      presence: this.presenceList(),
    });
    this.broadcastFrame({ type: "participants", participants: this.participants() });
    // 只前移不后移：即便已有远期 alarm（temp 归档 +14 天 / webhook 重试）也保证 60s presence 扫描
    await this.ensureAlarmAt(Date.now() + PRESENCE_SCAN_MS);
  }

  async onMessage(connection: Connection<ConnState>, message: WSMessage) {
    const badRequest = () =>
      this.sendFrame(connection, { type: "error", code: "bad_request", message: "invalid frame" });
    if (typeof message !== "string") {
      badRequest();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      badRequest();
      return;
    }
    if (typeof raw !== "object" || raw === null) {
      badRequest();
      return;
    }
    const frame = raw as Record<string, unknown>;
    let st = connection.state;
    if (!st) return;
    st = connection.setState({ ...st, lastSeen: Date.now() });
    if (!st) return;

    if (frame.type === "ping") {
      // setWebSocketAutoResponse 只匹配字面 '{"type":"ping"}'，这里兜底其余序列化
      this.sendFrame(connection, { type: "pong" });
      return;
    }
    if (!(await this.isTokenActive(st.tokenHash))) {
      this.closeRevokedConnection(connection);
      return;
    }
    if (frame.type === "hello") {
      const since = typeof frame.since === "number" && frame.since > 0 ? Math.floor(frame.since) : 0;
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq", since)
        .toArray();
      for (const row of rows) this.sendFrame(connection, this.rowToFrame(row));
      return;
    }
    if (frame.type === "send") {
      if (st.archived || this.isArchived()) {
        this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
        return;
      }
      const rate = this.consumeRate(st.name, Date.now());
      if (rate !== null) {
        this.sendFrame(connection, { type: "error", code: rate.code, message: rate.message });
        return;
      }
      const send = parseSendFrame(frame);
      if (!send) {
        this.sendFrame(connection, { type: "error", code: "bad_request", message: "invalid send payload" });
        return;
      }
      const out = await this.handleSend(
        { name: st.name, kind: st.kind, role: st.role, owner: st.owner, tokenHash: st.tokenHash },
        send,
        { countRate: false },
      );
      if (!out.ok) {
        this.sendFrame(connection, { type: "error", code: out.code, message: out.message });
        return;
      }
      // sent 先于广播到达发送方，客户端先推进游标再看到自己的回声
      this.sendFrame(connection, { type: "sent", seq: out.seq });
      await this.closeInactiveConnections();
      for (const f of out.frames) this.broadcastFrame(f);
      await this.afterSend(out.frames[0] as MsgFrame);
    }
  }

  onClose(connection: Connection<ConnState>) {
    const st = connection.state;
    if (!st || !st.name || st.archived) return;
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== connection.id && other.state?.name === st.name) return;
    }
    this.markOffline(st.name, Date.now());
    this.broadcastFrame({ type: "participants", participants: this.participants() });
  }

  // alarm 三件套（spec §6/§13）：presence 扫描 → webhook 重试 → temp 归档检查，最后按最近到期时间续排
  async onAlarm() {
    const now = Date.now();
    const live = this.scanPresence(now);
    await this.retryWebhooks(now);
    await this.checkTempArchive(now);
    await this.scheduleNextAlarm(now, live);
  }

  // spec §5：60s 无帧（ping 由 auto-response 记时间戳）判 offline，返回存活连接数
  private scanPresence(now: number): number {
    const stale: Connection<ConnState>[] = [];
    let live = 0;
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(connection)?.getTime() ?? 0;
      const last = Math.max(pinged, st?.lastSeen ?? 0);
      if (now - last >= PRESENCE_TIMEOUT_MS) stale.push(connection);
      else live++;
    }
    for (const connection of stale) {
      const name = connection.state?.name;
      connection.close(1001, "heartbeat timeout");
      if (!name) continue;
      // getConnections 只回 open 的连接，刚 close 的不算
      let gone = true;
      for (const other of this.getConnections<ConnState>()) {
        if (other.state?.name === name) {
          gone = false;
          break;
        }
      }
      if (gone) this.markOffline(name, now);
    }
    if (stale.length > 0) {
      this.broadcastFrame({ type: "participants", participants: this.participants() });
    }
    return live;
  }

  // 队列里到期的重投一轮：成功删行，失败退避 1/4/16 分钟，超过 3 次丢弃并向频道记一条 status
  private async retryWebhooks(now: number) {
    if (this.isArchived()) return;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT q.id, q.webhook_name, q.payload, q.attempts, w.url, w.secret
         FROM webhook_queue q LEFT JOIN webhooks w ON w.name = q.webhook_name
         WHERE q.next_retry_at <= ?
         ORDER BY q.next_retry_at, q.id
         LIMIT ?`,
        now,
        WEBHOOK_RETRY_BATCH_SIZE,
      )
      .toArray();
    for (const row of rows) {
      const id = Number(row.id);
      // webhook 已被删除，队列残留直接清掉
      if (row.url === null) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      const webhookName = String(row.webhook_name);
      const payload = String(row.payload);
      const attempt = Number(row.attempts) + 1;
      const delivery = await this.deliverWebhook(String(row.url), String(row.secret), payload);
      this.recordWakeDelivery({
        mentionSeq: this.seqFromWebhookPayload(payload),
        targetName: webhookName,
        webhookName,
        attempt,
        delivery,
      });
      if (delivery.ok) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        continue;
      }
      if (attempt > WEBHOOK_MAX_RETRIES) {
        this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE id = ?", id);
        this.insertSystemStatus(`webhook ${webhookName} 连续投递失败已停用本条`, now);
        continue;
      }
      this.ctx.storage.sql.exec(
        "UPDATE webhook_queue SET attempts = ?, next_retry_at = ? WHERE id = ?",
        attempt,
        now + this.retryDelay(attempt),
        id,
      );
    }
  }

  private retryDelay(attempts: number): number {
    return WEBHOOK_RETRY_DELAYS_MS[
      Math.min(Math.max(attempts, 1), WEBHOOK_RETRY_DELAYS_MS.length) - 1
    ] as number;
  }

  // temp 频道最后一条消息后闲置超时 → 归档：写 do meta + 回写 d1 archived_at + 踢连接
  private async checkTempArchive(now: number) {
    const pending = this.getMeta("archive_pending_at");
    if (this.isArchived()) {
      if (pending !== null) await this.reconcileD1Archive(Number(pending) || now);
      return;
    }
    if (this.getMeta("ckind") !== "temp") return;
    const idleBasis = this.lastActivityTs();
    if (idleBasis === null || now - idleBasis < this.tempIdleMs()) return;
    this.archiveAndKick();
    this.setMeta("archive_pending_at", String(now));
    await this.reconcileD1Archive(now);
  }

  private async reconcileD1Archive(ts: number) {
    try {
      await this.env.DB.prepare(
        "UPDATE channels SET archived_at = ? WHERE slug = ? AND archived_at IS NULL",
      )
        .bind(ts, this.name)
        .run();
      this.deleteMeta("archive_pending_at");
    } catch {
      await this.ensureAlarmAt(Date.now() + 60_000);
    }
  }

  // 三个来源里最近的下一个到期时间：presence 扫描 / webhook 重试 / temp 归档
  private async scheduleNextAlarm(now: number, live: number) {
    const candidates: number[] = [];
    if (live > 0) candidates.push(now + PRESENCE_SCAN_MS);
    const next = this.ctx.storage.sql
      .exec("SELECT MIN(next_retry_at) AS t FROM webhook_queue")
      .one();
    if (next.t !== null) candidates.push(Number(next.t));
    if (this.getMeta("archive_pending_at") !== null) candidates.push(now + 60_000);
    if (this.getMeta("ckind") === "temp" && !this.isArchived()) {
      const basis = this.lastActivityTs();
      if (basis !== null) candidates.push(basis + this.tempIdleMs());
    }
    if (candidates.length > 0) {
      await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 1000));
    }
  }

  private markOffline(name: string, ts: number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (name, state, note, updated_at) VALUES (?, 'offline', NULL, ?)
       ON CONFLICT(name) DO UPDATE SET state = 'offline', updated_at = excluded.updated_at`,
      name,
      ts,
    );
    const frame: PresenceFrame = { type: "presence", name, state: "offline", note: null, ts };
    const entry = this.presenceFor(name);
    this.broadcastFrame(entry ? { type: "presence", ...entry } : frame);
  }

  // worker 每次转发都会带上频道快照头，do 写 meta 缓存（同 archived 的手法）
  private cacheChannelMeta(h: Headers, host: string | null) {
    const mode = h.get("x-ap-mode");
    if (mode === "normal" || mode === "party") this.setMeta("mode", mode);
    const ckind = h.get("x-ap-channel-kind");
    if (ckind === "standing" || ckind === "temp") this.setMeta("ckind", ckind);
    if (host) this.setMeta("host", host);
  }

  // 消息落库广播之后的副作用：webhook 投递 + temp 归档计时续排
  private async afterSend(msg: MsgFrame) {
    // 首投移出发送关键路径：坏/慢端点不再让每条消息阻塞 N×10s 才返回 seq（DoS 频道）
    this.ctx.waitUntil(this.dispatchWebhooks(msg));
    if (this.getMeta("ckind") === "temp" && !this.isArchived()) {
      await this.ensureAlarmAt(msg.ts + this.tempIdleMs());
    }
  }

  // spec §15：对每个 webhook 判 filter → 立即尝试投递，失败入队由 alarm 重试
  private async dispatchWebhooks(msg: MsgFrame) {
    // system 帧（webhook 失败通告）不再触发 webhook，防止失败风暴自激
    if (msg.sender.name === "system") return;
    const hooks = this.ctx.storage.sql
      .exec("SELECT name, url, secret, filter FROM webhooks")
      .toArray()
      .map((r) => ({
        name: String(r.name),
        url: String(r.url),
        secret: String(r.secret),
        filter: String(r.filter),
      })) as WebhookRow[];
    if (hooks.length === 0) return;
    const host = this.getMeta("host") ?? "agentparty";
    const now = Date.now();
    // payload 对本条消息的所有 hook 都相同，循环外算一次（hook 不变量）
    const payload = JSON.stringify({
      ...msg,
      channel: this.name,
      permalink: `https://${host}/c/${this.name}`,
    });
    const targets = hooks.filter((h) => h.filter !== "mentions" || msg.mentions.includes(h.name));
    if (targets.length === 0) return;
    // 并行投递：一个慢/坏端点不再拖累其余 hook（首投已由 afterSend 的 waitUntil 移出发送关键路径）
    const results = await Promise.all(
      targets.map(async (hook) => ({
        hook,
        delivery: await this.deliverWebhook(hook.url, hook.secret, payload),
      })),
    );
    let needAlarm = false;
    for (const { hook, delivery } of results) {
      this.recordWakeDelivery({
        mentionSeq: msg.seq,
        targetName: hook.name,
        webhookName: hook.name,
        attempt: 1,
        delivery,
      });
      if (delivery.ok) continue;
      const queued = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM webhook_queue").one().n);
      if (queued >= MAX_WEBHOOK_QUEUE_ROWS) {
        await this.insertSystemStatus("webhook retry queue is full; dropping failed delivery", now);
        continue;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO webhook_queue (webhook_name, payload, attempts, next_retry_at) VALUES (?, ?, 1, ?)",
        hook.name,
        payload,
        now + this.retryDelay(1),
      );
      needAlarm = true;
    }
    if (needAlarm) await this.ensureAlarmAt(now + this.retryDelay(1));
  }

  // 短超时 POST；Bearer = 注册时的 secret，HMAC 签 payload 供接收方校验（spec §15）
  private async deliverWebhook(url: string, secret: string, payload: string): Promise<WebhookDeliveryResult> {
    try {
      const signature = await hmacSha256Hex(secret, payload);
      const res = await fetch(url, {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
          "x-agentparty-signature": `hmac-sha256=${signature}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      return {
        ok: res.ok,
        status: res.status,
        error: res.ok ? null : res.statusText || `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private recordWakeDelivery(args: {
    mentionSeq: number;
    targetName: string;
    webhookName: string;
    attempt: number;
    delivery: WebhookDeliveryResult;
  }) {
    this.ctx.storage.sql.exec(
      `INSERT INTO wake_delivery_ledger (
         mention_seq, target_name, webhook_name, adapter_kind, attempt,
         result, http_status, error, attempted_at, ack_seq, resume_seq
       )
       VALUES (?, ?, ?, 'webhook', ?, ?, ?, ?, ?, NULL, NULL)`,
      args.mentionSeq,
      args.targetName,
      args.webhookName,
      args.attempt,
      args.delivery.ok ? "ok" : "failed",
      args.delivery.status,
      args.delivery.error,
      Date.now(),
    );
  }

  private seqFromWebhookPayload(payload: string): number {
    try {
      const parsed = JSON.parse(payload) as { seq?: unknown };
      return typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq > 0 ? parsed.seq : 0;
    } catch {
      return 0;
    }
  }

  // 3 次重试全败后向频道插一条 system status，让人看得见投递失败
  private insertSystemStatus(note: string, now: number) {
    const seq = this.lastSeq() + 1;
    const status: StatusEvent = {
      owner: "system",
      state: "blocked",
      scope: [],
      summary_seq: null,
      blocked_reason: note,
      updated_at: now,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (
         seq, sender_name, sender_kind, kind, body, mentions_json, reply_to,
         state, note, status_scope_json, status_summary_seq, status_blocked_reason, ts
       )
       VALUES (?, 'system', 'agent', 'status', ?, '[]', NULL, 'blocked', ?, '[]', NULL, ?, ?)`,
      seq,
      note,
      note,
      note,
      now,
    );
    const frame: MsgFrame = {
      type: "status",
      seq,
      sender: { name: "system", kind: "agent" },
      kind: "status",
      body: note,
      mentions: [],
      reply_to: null,
      state: "blocked",
      note,
      status,
      ts: now,
    };
    this.broadcastFrame(frame);
  }

  // 归档收口：写 meta + 广播 error:archived + 踢连接（手动归档与 temp 自动归档共用）
  private archiveAndKick() {
    this.setMeta("archived", "1");
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      if (st) connection.setState({ ...st, archived: true });
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
    }
  }

  // temp 闲置计时基准：最后一条消息，没消息就用首次见到该频道的时间
  private lastActivityTs(): number | null {
    const row = this.ctx.storage.sql.exec("SELECT MAX(ts) AS t FROM messages").one();
    if (row.t !== null) return Number(row.t);
    const born = this.getMeta("born");
    if (born !== null) return Number(born);
    this.setMeta("born", String(Date.now()));
    return Date.now();
  }

  // 测试可经 meta 注入短 TTL
  private tempIdleMs(): number {
    const injected = Number(this.getMeta("temp_idle_ms"));
    return Number.isFinite(injected) && injected > 0 ? injected : TEMP_IDLE_ARCHIVE_MS;
  }

  private async ensureAlarmAt(ts: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > ts) await this.ctx.storage.setAlarm(ts);
  }

  // worker 转发来的内部 rest
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/summary" && request.method === "GET") {
      // 频道列表页聚合用：最近一条消息（正文截断）+ presence 快照（spec §9 第 1 块）
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM messages ORDER BY seq DESC LIMIT 1")
        .toArray();
      const last = rows.length > 0 ? this.rowToFrame(rows[0]!) : null;
      return Response.json({
        last:
          last === null
            ? null
            : { sender: last.sender.name, kind: last.kind, body: last.body.slice(0, 200), ts: last.ts },
        presence: this.presenceList(),
      });
    }
    if (url.pathname === "/internal/init" && request.method === "POST") {
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      if (this.getMeta("ckind") === "temp") {
        const born = Date.now();
        this.setMeta("born", String(born));
        await this.ensureAlarmAt(born + this.tempIdleMs());
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/messages" && request.method === "GET") {
      const since = Math.max(toInt(url.searchParams.get("since"), 0), 0);
      const limit = Math.min(Math.max(toInt(url.searchParams.get("limit"), 100), 1), 1000);
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", since, limit)
        .toArray();
      return Response.json({ messages: rows.map((r) => this.rowToFrame(r)) });
    }
    if (url.pathname === "/internal/search" && request.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length === 0) {
        return Response.json({ error: { code: "bad_request", message: "q required" } }, { status: 400 });
      }
      const since = Math.max(toInt(url.searchParams.get("since"), 0), 0);
      const limit = Math.min(Math.max(toInt(url.searchParams.get("limit"), 100), 1), 1000);
      const from = url.searchParams.get("from");
      const like = `%${escapeLike(query.toLowerCase())}%`;
      const fromSql = from === null ? "" : " AND sender_name = ?";
      const args: (number | string)[] =
        from === null
          ? [since, like, like, like, limit]
          : [since, from, like, like, like, limit];
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT * FROM messages
            WHERE seq > ?${fromSql}
              AND (
                lower(body) LIKE ? ESCAPE '\\'
                OR lower(note) LIKE ? ESCAPE '\\'
                OR lower(sender_name) LIKE ? ESCAPE '\\'
              )
            ORDER BY seq DESC
            LIMIT ?`,
          ...args,
        )
        .toArray();
      const hits = rows.map((row) => {
        const frame = this.rowToFrame(row);
        const matchField = firstMatchingField(frame, query);
        return {
          type: "search_hit",
          channel: this.name,
          query,
          seq: frame.seq,
          sender: frame.sender,
          kind: frame.kind,
          match_field: matchField,
          snippet: snippetFor(frame, matchField),
          ts: frame.ts,
        } satisfies SearchHit;
      });
      return Response.json({ hits });
    }
    if (url.pathname === "/internal/wake-deliveries" && request.method === "GET") {
      const since = Math.max(toInt(url.searchParams.get("since"), 0), 0);
      const limit = Math.min(Math.max(toInt(url.searchParams.get("limit"), 20), 1), 100);
      const target = url.searchParams.get("target");
      const targetSql = target === null ? "" : " AND target_name = ?";
      const args: (number | string)[] = target === null ? [since, limit] : [since, target, limit];
      const deliveries = this.ctx.storage.sql
        .exec(
          `SELECT mention_seq, target_name, webhook_name, adapter_kind, attempt,
                  result, http_status, error, attempted_at, ack_seq, resume_seq
             FROM wake_delivery_ledger
            WHERE mention_seq >= ?${targetSql}
            ORDER BY mention_seq, attempt, id
            LIMIT ?`,
          ...args,
        )
        .toArray()
        .map((r) => ({
          mention_seq: Number(r.mention_seq),
          target_name: String(r.target_name),
          webhook_name: String(r.webhook_name),
          adapter_kind: String(r.adapter_kind),
          attempt: Number(r.attempt),
          result: String(r.result),
          http_status: r.http_status === null ? null : Number(r.http_status),
          error: r.error === null ? null : String(r.error),
          attempted_at: Number(r.attempted_at),
          ack_seq: r.ack_seq === null ? null : Number(r.ack_seq),
          resume_seq: r.resume_seq === null ? null : Number(r.resume_seq),
        }));
      return Response.json({ deliveries });
    }
    if (url.pathname === "/internal/messages" && request.method === "POST") {
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      const identity: Identity = {
        name: request.headers.get("x-ap-name") ?? "",
        kind: request.headers.get("x-ap-kind") === "agent" ? "agent" : "human",
        role: (request.headers.get("x-ap-role") ?? "readonly") as TokenRole,
        owner: request.headers.get("x-ap-owner") ?? undefined,
        tokenHash: request.headers.get("x-ap-token-hash") ?? "",
      };
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: { code: "bad_request", message: "invalid json" } }, { status: 400 });
      }
      const send = parseSendFrame(raw);
      if (!send) {
        const rate = this.consumeRate(identity.name, Date.now());
        if (rate !== null) {
          return Response.json(
            { error: { code: rate.code, message: rate.message } },
            { status: ERROR_STATUS[rate.code] },
          );
        }
        return Response.json({ error: { code: "bad_request", message: "invalid send payload" } }, { status: 400 });
      }
      const out = await this.handleSend(identity, send, { countRate: true });
      if (!out.ok) {
        return Response.json(
          { error: { code: out.code, message: out.message } },
          { status: ERROR_STATUS[out.code] },
        );
      }
      await this.closeInactiveConnections();
      for (const f of out.frames) this.broadcastFrame(f);
      await this.afterSend(out.frames[0] as MsgFrame);
      return Response.json({ seq: out.seq });
    }
    if (url.pathname === "/internal/webhooks" && request.method === "GET") {
      // 列表不回 secret 明文（spec §7）
      const webhooks = this.ctx.storage.sql
        .exec("SELECT name, url, filter, created_at FROM webhooks ORDER BY name")
        .toArray()
        .map((r) => ({
          name: String(r.name),
          url: String(r.url),
          filter: String(r.filter),
          created_at: Number(r.created_at),
        }));
      return Response.json({ webhooks });
    }
    if (url.pathname === "/internal/webhooks" && request.method === "POST") {
      // 参数校验在 worker 层完成，do 只做落库（同名覆盖 = 幂等注册）
      const body = (await request.json().catch(() => null)) as {
        name?: unknown;
        url?: unknown;
        secret?: unknown;
        filter?: unknown;
      } | null;
      if (
        typeof body?.name !== "string" ||
        typeof body.url !== "string" ||
        typeof body.secret !== "string" ||
        typeof body.filter !== "string"
      ) {
        return Response.json({ error: { code: "bad_request", message: "invalid webhook" } }, { status: 400 });
      }
      const count = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM webhooks").one().n);
      const exists = this.ctx.storage.sql
        .exec("SELECT name FROM webhooks WHERE name = ?", body.name)
        .toArray();
      if (exists.length === 0 && count >= MAX_WEBHOOKS_PER_CHANNEL) {
        return Response.json(
          { error: { code: "rate_limited", message: `max ${MAX_WEBHOOKS_PER_CHANNEL} webhooks per channel` } },
          { status: 429 },
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO webhooks (name, url, secret, filter, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET url = excluded.url, secret = excluded.secret, filter = excluded.filter`,
        body.name,
        body.url,
        body.secret,
        body.filter,
        Date.now(),
      );
      return Response.json({ name: body.name, url: body.url, filter: body.filter }, { status: 201 });
    }
    if (url.pathname === "/internal/webhooks" && request.method === "DELETE") {
      const name = url.searchParams.get("name") ?? "";
      const existed = this.ctx.storage.sql
        .exec("SELECT name FROM webhooks WHERE name = ?", name)
        .toArray();
      if (existed.length === 0) {
        return Response.json({ error: { code: "not_found", message: "no such webhook" } }, { status: 404 });
      }
      this.ctx.storage.sql.exec("DELETE FROM webhooks WHERE name = ?", name);
      this.ctx.storage.sql.exec("DELETE FROM webhook_queue WHERE webhook_name = ?", name);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/reset-guard" && request.method === "POST") {
      this.setMeta("agent_streak", "0");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/archive" && request.method === "POST") {
      // do 自己记下归档态（handleSend/onConnect 的权威依据），再踢存活连接
      this.cacheChannelMeta(request.headers, request.headers.get("x-ap-host"));
      const ts = toInt(request.headers.get("x-ap-archive-at"), Date.now());
      this.archiveAndKick();
      this.setMeta("archive_pending_at", String(ts));
      await this.reconcileD1Archive(ts);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/kick" && request.method === "POST") {
      // token 吊销即时生效：按 name 踢掉存活连接
      const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name : "";
      if (!name) {
        return Response.json({ error: { code: "bad_request", message: "name required" } }, { status: 400 });
      }
      for (const connection of this.getConnections<ConnState>()) {
        if (connection.state?.name !== name) continue;
        this.closeRevokedConnection(connection);
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  // 校验 → 分配 seq → 落库 → 修剪/presence，返回待广播帧
  private async handleSend(
    identity: Identity,
    frame: SendFrame,
    options: { countRate?: boolean } = {},
  ): Promise<SendOutcome> {
    if (this.isArchived()) {
      return { ok: false, code: "archived", message: "channel is archived" };
    }
    if (identity.role === "readonly") {
      return { ok: false, code: "unauthorized", message: "readonly token cannot send" };
    }
    if (!(await this.isTokenActive(identity.tokenHash))) {
      return { ok: false, code: "unauthorized", message: "invalid or revoked token" };
    }
    const payload = frame.kind === "message" ? frame.body : frame.note;
    if (byteLength(payload) > BODY_LIMIT) {
      return { ok: false, code: "too_large", message: `body exceeds ${BODY_LIMIT} bytes` };
    }
    const loopGuard = identity.kind === "agent" ? this.loopGuardMessage() : null;
    if (loopGuard !== null) {
      return {
        ok: false,
        code: "loop_guard",
        message: loopGuard,
      };
    }
    const now = Date.now();
    if (options.countRate !== false) {
      const rate = this.consumeRate(identity.name, now);
      if (rate !== null) return rate;
    }

    const sql = this.ctx.storage.sql;
    const seq = this.lastSeq() + 1;
    const sender: Sender = identity.owner
      ? { name: identity.name, kind: identity.kind, owner: identity.owner }
      : { name: identity.name, kind: identity.kind };
    const status: StatusEvent | null =
      frame.kind === "status"
        ? {
            owner: identity.name,
            state: frame.state,
            scope: frame.scope ?? [],
            summary_seq: frame.summary_seq ?? null,
            blocked_reason: frame.blocked_reason ?? null,
            updated_at: now,
          }
        : null;
    const msg: MsgFrame =
      frame.kind === "message"
        ? {
            type: "msg",
            seq,
            sender,
            kind: "message",
            body: frame.body,
            mentions: frame.mentions,
            reply_to: frame.reply_to,
            state: null,
            note: null,
            status: null,
            ts: now,
          }
        : {
            type: "status",
            seq,
            sender,
            kind: "status",
            body: frame.note,
            mentions: frame.mentions ?? [],
            reply_to: null,
            state: frame.state,
            note: frame.note,
            status,
            ts: now,
          };
    sql.exec(
      `INSERT INTO messages (
         seq, sender_name, sender_kind, sender_owner, kind, body, mentions_json, reply_to,
         state, note, status_scope_json, status_summary_seq, status_blocked_reason, ts
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      identity.name,
      identity.kind,
      identity.owner ?? null,
      msg.kind,
      msg.body,
      JSON.stringify(msg.mentions),
      msg.reply_to,
      msg.state,
      msg.note,
      status === null ? null : JSON.stringify(status.scope),
      status?.summary_seq ?? null,
      status?.blocked_reason ?? null,
      now,
    );
    this.setMeta("agent_streak", String(identity.kind === "agent" ? this.agentStreak() + 1 : 0));
    if (seq % 100 === 0) {
      sql.exec("DELETE FROM messages WHERE seq <= ?", seq - RETAIN_N);
    }

    const frames: ServerFrame[] = [msg];
    if (frame.kind === "status") {
      const wakeProvided = frame.wake !== undefined ? 1 : 0;
      sql.exec(
        `INSERT INTO presence (
           name, state, note, updated_at, status_scope_json, status_summary_seq, status_blocked_reason,
           role, residency, wake_kind, wake_verified_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           state = excluded.state,
           note = excluded.note,
           updated_at = excluded.updated_at,
           status_scope_json = excluded.status_scope_json,
           status_summary_seq = excluded.status_summary_seq,
           status_blocked_reason = excluded.status_blocked_reason,
           role = COALESCE(excluded.role, presence.role),
           residency = COALESCE(excluded.residency, presence.residency),
           wake_kind = CASE WHEN ? THEN excluded.wake_kind ELSE presence.wake_kind END,
           wake_verified_at = CASE WHEN ? THEN excluded.wake_verified_at ELSE presence.wake_verified_at END`,
        identity.name,
        frame.state,
        frame.note,
        now,
        JSON.stringify(status?.scope ?? []),
        status?.summary_seq ?? null,
        status?.blocked_reason ?? null,
        frame.role ?? null,
        frame.residency ?? null,
        frame.wake?.kind ?? null,
        frame.wake?.verified_at ?? null,
        wakeProvided,
        wakeProvided,
      );
      const entry = this.presenceFor(identity.name);
      frames.push(entry ? { type: "presence", ...entry } : { type: "presence", name: identity.name, state: frame.state, note: frame.note, ts: now });
    }
    return { ok: true, seq, frames };
  }

  private consumeRate(name: string, now: number): SendErrorOutcome | null {
    const sql = this.ctx.storage.sql;
    const bucket = Math.floor(now / 60_000);
    sql.exec("DELETE FROM rate WHERE bucket < ?", bucket - 1);
    // 滑动窗口：当前 bucket + 上一 bucket 按剩余占比折算，跨分钟边界不翻倍
    let current = 0;
    let previous = 0;
    for (const row of sql
      .exec("SELECT bucket, count FROM rate WHERE name = ? AND bucket >= ?", name, bucket - 1)
      .toArray()) {
      if (Number(row.bucket) === bucket) current = Number(row.count);
      else previous = Number(row.count);
    }
    const windowUsed = current + previous * (1 - (now % 60_000) / 60_000);
    if (windowUsed >= RATE_LIMIT_PER_MIN) {
      return {
        ok: false,
        code: "rate_limited",
        message: `over ${RATE_LIMIT_PER_MIN} messages per minute`,
      };
    }
    sql.exec(
      `INSERT INTO rate (name, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT(name, bucket) DO UPDATE SET count = count + 1`,
      name,
      bucket,
    );
    return null;
  }

  private broadcastFrame(frame: ServerFrame) {
    for (const connection of this.getConnections<ConnState>()) {
      this.sendFrame(connection, frame);
    }
  }

  private async closeInactiveConnections() {
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      if (!st) continue;
      if (!(await this.isTokenActive(st.tokenHash))) this.closeRevokedConnection(connection);
    }
  }

  private closeRevokedConnection(connection: Connection<ConnState>) {
    this.sendFrame(connection, { type: "error", code: "unauthorized", message: "token revoked" });
    connection.close(1008, "revoked");
  }

  private async isTokenActive(hash: string): Promise<boolean> {
    if (!hash) return false;
    // OIDC 人类 token 不落 D1，无法被吊销扫描；生命周期由 JWT exp 在 worker 边界管辖（spec §10）
    if (hash.startsWith("oidc:")) return true;
    try {
      const row = await this.env.DB.prepare("SELECT id FROM tokens WHERE hash = ? AND revoked_at IS NULL")
        .bind(hash)
        .first<{ id: number }>();
      return row !== null;
    } catch {
      return false;
    }
  }

  private sendFrame(connection: Connection, frame: ServerFrame) {
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      try {
        connection.close(1011, "send failed");
      } catch {
        // The runtime may already have detached the socket.
      }
    }
  }

  private lastSeq(): number {
    const row = this.ctx.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) AS last FROM messages").one();
    return Number(row.last);
  }

  private agentStreak(): number {
    return Number(this.getMeta("agent_streak") ?? "0");
  }

  private loopGuardMessage(): string | null {
    // loop guard 分档（spec §3）：party 频道放宽到 200，阈值按 meta 缓存的 mode 选
    const guardLimit = this.getMeta("mode") === "party" ? LOOP_GUARD_PARTY_N : LOOP_GUARD_N;
    return this.agentStreak() >= guardLimit
      ? `${guardLimit} consecutive agent messages, waiting for a human`
      : null;
  }

  private isArchived(): boolean {
    return this.getMeta("archived") === "1";
  }

  private participants(): Sender[] {
    const seen = new Map<string, Sender>();
    for (const connection of this.getConnections<ConnState>()) {
      const st = connection.state;
      if (st?.name && !seen.has(st.name)) {
        seen.set(st.name, st.owner ? { name: st.name, kind: st.kind, owner: st.owner } : { name: st.name, kind: st.kind });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private getMeta(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length > 0 ? String(rows[0]!.value) : null;
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private deleteMeta(key: string) {
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  private presenceList(): PresenceEntry[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT name, state, note, updated_at, status_scope_json, status_summary_seq, status_blocked_reason,
                role, residency, wake_kind, wake_verified_at
         FROM presence ORDER BY name`,
      )
      .toArray()
      .map((r) => this.presenceRowToEntry(r));
  }

  private presenceFor(name: string): PresenceEntry | null {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT name, state, note, updated_at, status_scope_json, status_summary_seq, status_blocked_reason,
                role, residency, wake_kind, wake_verified_at
         FROM presence WHERE name = ?`,
        name,
      )
      .toArray();
    return rows.length > 0 ? this.presenceRowToEntry(rows[0]!) : null;
  }

  private presenceRowToEntry(r: Record<string, unknown>): PresenceEntry {
    const ts = Number(r.updated_at);
    const wake =
      r.wake_kind === null || r.wake_kind === undefined
        ? undefined
        : r.wake_verified_at === null || r.wake_verified_at === undefined
          ? { kind: String(r.wake_kind) as WakeKind }
          : { kind: String(r.wake_kind) as WakeKind, verified_at: Number(r.wake_verified_at) };
    const state = String(r.state) as PresenceEntry["state"];
    const status =
      state === "offline"
        ? undefined
        : statusEventFromRow(r, String(r.name), state as StatusState, ts);
    return {
      name: String(r.name),
      state,
      note: r.note === null ? null : String(r.note),
      ts,
      last_seen: ts,
      ...(status === undefined ? {} : { status }),
      ...(r.role === null || r.role === undefined ? {} : { role: String(r.role) as CollaborationRole }),
      ...(r.residency === null || r.residency === undefined ? {} : { residency: String(r.residency) as Residency }),
      ...(wake === undefined ? {} : { wake }),
    };
  }

  private rowToFrame(r: Record<string, unknown>): MsgFrame {
    const kind = String(r.kind) as MsgFrame["kind"];
    const state = r.state === null ? null : (String(r.state) as StatusState);
    const note = r.note === null ? null : String(r.note);
    const ts = Number(r.ts);
    const status: StatusEvent | null =
      kind === "status" && state !== null
        ? statusEventFromRow(r, String(r.sender_name), state, ts)
        : null;
    return {
      type: kind === "status" ? "status" : "msg",
      seq: Number(r.seq),
      sender:
        r.sender_owner === null || r.sender_owner === undefined
          ? { name: String(r.sender_name), kind: String(r.sender_kind) as SenderKind }
          : { name: String(r.sender_name), kind: String(r.sender_kind) as SenderKind, owner: String(r.sender_owner) },
      kind,
      body: String(r.body),
      mentions: JSON.parse(String(r.mentions_json ?? "[]")) as string[],
      reply_to: r.reply_to === null ? null : Number(r.reply_to),
      state,
      note,
      status,
      ts,
    };
  }
}
