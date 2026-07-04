// worker 入口 — rest 路由 + ws 升级转发
import { RESERVED_NAMES } from "@agentparty/shared";
import type {
  CaptureKind,
  CaptureRecord,
  ChannelKind,
  ChannelMode,
  MsgFrame,
  RestErrorCode,
  TokenRole,
  WebhookFilter,
} from "@agentparty/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getServerByName } from "partyserver";
import { canAccessChannel, isChannelModerator } from "./acl";
import {
  extractBearer,
  lookupToken,
  oidcConfigFromEnv,
  randomToken,
  sha256Hex,
  type TokenIdentity,
} from "./auth";
import { ChannelDO } from "./do";
import { openapiDocument } from "./openapi";

export { ChannelDO };

// OIDC_ISSUER + OIDC_CLIENT_ID 为可选 vars/secrets：都配齐才启用人类网页 OIDC 登录（spec §10）
type AppEnv = Env & { ADMIN_SECRET?: string; OIDC_ISSUER?: string; OIDC_CLIENT_ID?: string };

type AppContext = {
  Bindings: AppEnv;
  Variables: { identity: TokenIdentity };
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLES: readonly string[] = ["agent", "human", "readonly"] satisfies TokenRole[];
const KINDS: readonly string[] = ["standing", "temp"] satisfies ChannelKind[];
const MODES: readonly string[] = ["normal", "party"] satisfies ChannelMode[];
const VISIBILITIES: readonly string[] = ["public", "private"];
const WEBHOOK_FILTERS: readonly string[] = ["mentions", "status", "needs-human", "all"] satisfies WebhookFilter[];
const CAPTURE_KINDS: readonly string[] = ["decision", "requirement", "bug", "action-item"] satisfies CaptureKind[];
const WEBHOOK_URL_MAX = 2048;
const WEBHOOK_SECRET_MAX = 4096;
const HEADER_VALUE_RE = /^[\x21-\x7e]+$/;
// do 无条件信任的内部头清单：ws 升级转发前必须逐个剥离客户端注入值，只认 worker 权威版本
const AP_FORWARD_HEADERS = [
  "x-ap-name",
  "x-ap-kind",
  "x-ap-role",
  "x-ap-owner",
  "x-ap-token-hash",
  "x-ap-mode",
  "x-ap-channel-kind",
  "x-ap-host",
  "x-ap-archived",
  "x-ap-archive-at",
] as const;
// 所属人标签：铸造时可选写入，须 header-safe（可打印 ASCII，含空格）以便经 x-ap-owner 转发给 do
const OWNER_MAX = 128;
const OWNER_RE = /^[\x20-\x7e]{1,128}$/;
// CLI 用来跑回环 PKCE 的 public client（account.leeguoo.com 已登记）。CLI 拉 /api/config 得知用哪个
const CLI_CLIENT_ID = "agentparty-cli";
const CAPTURE_NOTE_MAX = 4000;

function errorBody(code: RestErrorCode, message: string) {
  return { error: { code, message } };
}

function positiveInt(input: unknown): number | null {
  return typeof input === "number" && Number.isInteger(input) && input > 0 ? input : null;
}

function captureRowToRecord(row: {
  channel_slug: string;
  seq: number;
  kind: string;
  note: string | null;
  created_by: string;
  created_by_kind: string;
  created_at: number;
  message_sender: string;
  message_sender_kind: string;
  message_kind: string;
  message_body: string;
  message_ts: number;
}): CaptureRecord {
  return {
    type: "capture",
    channel: row.channel_slug,
    seq: row.seq,
    capture_kind: row.kind as CaptureKind,
    note: row.note,
    created_by: row.created_by,
    created_by_kind: row.created_by_kind === "human" ? "human" : "agent",
    created_at: row.created_at,
    message: {
      seq: row.seq,
      sender: {
        name: row.message_sender,
        kind: row.message_sender_kind === "human" ? "human" : "agent",
      },
      kind: row.message_kind === "status" ? "status" : "message",
      body: row.message_body,
      ts: row.message_ts,
    },
  };
}

// 铸/重铸 token 的落库逻辑（/api/tokens 与 /api/agents 共用）：
// 同名活 token 冲突返回 conflict；同名已吊销 token 复用行覆盖（owner/channel_scope 一并刷新），
// 否则插新行。返回一次性明文 token。
async function persistToken(
  db: D1Database,
  opts: { name: string; role: TokenRole; owner: string; channelScope: string | null },
): Promise<{ token: string } | { conflict: true }> {
  const existing = await db
    .prepare("SELECT id, revoked_at FROM tokens WHERE name = ?")
    .bind(opts.name)
    .first<{ id: number; revoked_at: number | null }>();
  if (existing && existing.revoked_at === null) return { conflict: true };
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  if (existing) {
    await db
      .prepare(
        "UPDATE tokens SET hash = ?, role = ?, owner = ?, channel_scope = ?, created_at = ?, revoked_at = NULL WHERE id = ?",
      )
      .bind(hash, opts.role, opts.owner, opts.channelScope, now, existing.id)
      .run();
  } else {
    await db
      .prepare("INSERT INTO tokens (hash, name, role, owner, channel_scope, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(hash, opts.name, opts.role, opts.owner, opts.channelScope, now)
      .run();
  }
  return { token };
}

const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret || c.req.header("x-admin-secret") !== secret) {
    return c.json(errorBody("unauthorized", "invalid admin secret"), 401);
  }
  await next();
});

const requireBearer = createMiddleware<AppContext>(async (c, next) => {
  if (!c.get("identity")) {
    const bearer = extractBearer(c.req.raw, {
      allowQueryToken:
        c.req.method === "GET" &&
        c.req.path.endsWith("/ws") &&
        c.req.header("upgrade")?.toLowerCase() === "websocket",
    });
    const identity = bearer ? await lookupToken(c.env.DB, bearer.token, oidcConfigFromEnv(c.env)) : null;
    if (!identity) {
      return c.json(errorBody("unauthorized", "invalid or revoked token"), 401);
    }
    if (bearer?.source === "query" && identity.role !== "readonly") {
      return c.json(errorBody("unauthorized", "query-string websocket tokens must be readonly"), 403);
    }
    c.set("identity", identity);
  }
  await next();
});

async function loadChannel(db: D1Database, slug: string) {
  return db
    .prepare(
      "SELECT slug, kind, mode, archived_at, created_by, visibility, owner_account FROM channels WHERE slug = ?",
    )
    .bind(slug)
    .first<{
      slug: string;
      kind: string;
      mode: string;
      archived_at: number | null;
      created_by: string | null;
      visibility: string;
      owner_account: string | null;
    }>();
}

// do 侧按 meta 缓存 mode/kind/host（loop guard 分档、temp 归档、webhook permalink 都要用）
function channelHeaders(channel: { kind: string; mode: string }, requestUrl: string) {
  return {
    "x-ap-mode": channel.mode,
    "x-ap-channel-kind": channel.kind,
    "x-ap-host": new URL(requestUrl).host,
  };
}

function isPrivateIpv4(host: string): boolean {
  const chunks = host.split(".");
  if (chunks.length !== 4) return false;
  const parts = chunks.map((p) => (p === "" ? NaN : Number(p)));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const parts = tail.split(":");
  if (parts.length !== 2) return null;
  const nums = parts.map((p) => Number.parseInt(p, 16));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  const [hi, lo] = nums as [number, number];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isIpv6LinkLocal(host: string): boolean {
  const first = host.split(":")[0] ?? "";
  const n = Number.parseInt(first, 16);
  return Number.isInteger(n) && n >= 0xfe80 && n <= 0xfebf;
}

function isBlockedWebhookHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const isIpv6 = host.includes(":");
  const mapped = isIpv6 ? mappedIpv4FromIpv6(host) : null;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::" ||
    host === "::1" ||
    (isIpv6 && isIpv6LinkLocal(host)) ||
    (isIpv6 && host.startsWith("fc")) ||
    (isIpv6 && host.startsWith("fd")) ||
    (mapped !== null && isPrivateIpv4(mapped)) ||
    isPrivateIpv4(host)
  );
}

const app = new Hono<AppContext>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/openapi.json", (c) => c.json(openapiDocument));

// 公开配置：web 据此决定是否显示 "Sign in with leeguoo"（未配 OIDC 时 oidc:null）；
// cli_client_id 供 CLI party login 知道用哪个 public client 跑回环 PKCE（spec §4）
app.get("/api/config", (c) => {
  const oidc = oidcConfigFromEnv(c.env);
  return c.json({
    oidc: oidc ? { issuer: oidc.issuer, client_id: oidc.clientId } : null,
    cli_client_id: CLI_CLIENT_ID,
  });
});

// 当前登录身份：web topbar 显示 "signed in as <email 或 name>"（spec §10）
app.get("/api/me", requireBearer, (c) => {
  const id = c.get("identity");
  // 权限自省（whoami --caps / 网页）：从 role + channel_scope + account 派生，让工具提前知道能干什么
  const scoped = id.channel_scope != null;
  return c.json({
    name: id.name,
    email: id.email ?? null,
    kind: id.kind,
    role: id.role,
    owner: id.owner ?? null,
    channel_scope: id.channel_scope ?? null,
    caps: {
      send: id.role !== "readonly",
      // scoped token 不得建频道（会逃出 scope）；readonly 也不行
      create_channel: id.role !== "readonly" && !scoped,
      // POST /api/agents 的门：human 账号会话（有 account）才能自助铸 agent
      mint_agents: id.role === "human" && id.account != null,
      scoped_to: id.channel_scope ?? null,
    },
  });
});

app.post("/api/tokens", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; role?: unknown; owner?: unknown; channel_scope?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const role = typeof body?.role === "string" ? body.role : "";
  if (!NAME_RE.test(name) || !ROLES.includes(role)) {
    return c.json(errorBody("bad_request", "valid name and role (agent|human|readonly) required"), 400);
  }
  // owner 必填（spec §6 修复3）：P1 起新铸 token 一律带归属账号（连 ADMIN_SECRET 铸也要求），
  // 这样 owner=null 只存在于 P1 之前的存量 token，不再新增，legacy 过渡缺口随轮换单调收敛。
  if (body?.owner === undefined || body?.owner === null) {
    return c.json(errorBody("bad_request", "owner required"), 400);
  }
  const owner = body.owner;
  // owner 须 header-safe 且不超长（后续经 x-ap-owner 转发给 do）
  if (typeof owner !== "string" || owner.length > OWNER_MAX || !OWNER_RE.test(owner)) {
    return c.json(errorBody("bad_request", `owner must be printable ascii, <= ${OWNER_MAX} chars`), 400);
  }
  // channel_scope 可选（spec §5.3）：把 agent/readonly token 限死单频道 slug——invite 递给外部
  // 协作方 / 分享链接用，canAccessChannel 据此硬上限。须是合法频道 slug。
  const channelScope = body?.channel_scope === undefined || body?.channel_scope === null ? null : body.channel_scope;
  if (channelScope !== null && (typeof channelScope !== "string" || !SLUG_RE.test(channelScope))) {
    return c.json(errorBody("bad_request", "channel_scope must be a valid channel slug"), 400);
  }
  if (RESERVED_NAMES.includes(name)) {
    return c.json(errorBody("bad_request", "name is reserved"), 400);
  }
  const result = await persistToken(c.env.DB, { name, role: role as TokenRole, owner, channelScope });
  if ("conflict" in result) {
    return c.json(errorBody("conflict", "token name already exists, revoke it first"), 409);
  }
  const { token } = result;
  return c.json(
    channelScope !== null ? { token, name, role, owner, channel_scope: channelScope } : { token, name, role, owner },
    201,
  );
});

// 账号维度自助铸 agent token（spec §5.3 / P3）：无需 ADMIN_SECRET，凭 human 账号会话即可铸。
//   - 须 human 身份且带账号锚点（OIDC 人类，或带 owner 的 human ap_ token）；readonly/agent token 一律 403。
//   - owner 恒 = 铸造者自己的 principal.account，绝不接受客户端传 owner（否则可冒充他人账号铸 token）。
//   - role 固定 agent；channel_scope 可选（须合法 slug），用于把外派 agent 限死单频道。
// ADMIN_SECRET 的 /api/tokens 保留给 CI/bootstrap。
app.post("/api/agents", requireBearer, async (c) => {
  const identity = c.get("identity");
  // readonly/agent token 不能铸；legacy human token（无 account）也不行——无从确定归属账号。
  // kind 单独判 human 不够：readonly token 的 kind 也是 human，故必须 role === "human"。
  if (identity.role !== "human" || identity.account == null) {
    return c.json(
      errorBody("forbidden", "minting agent tokens requires a human account session (party login)"),
      403,
    );
  }
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; channel_scope?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  if (!NAME_RE.test(name)) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  if (RESERVED_NAMES.includes(name)) {
    return c.json(errorBody("bad_request", "name is reserved"), 400);
  }
  const channelScope =
    body?.channel_scope === undefined || body?.channel_scope === null ? null : body.channel_scope;
  if (channelScope !== null && (typeof channelScope !== "string" || !SLUG_RE.test(channelScope))) {
    return c.json(errorBody("bad_request", "channel_scope must be a valid channel slug"), 400);
  }
  // scope 继承：channel-scoped 的调用者（如递给 B 公司的 scoped token）只能铸【同一频道 scope】的 agent，
  // 不得铸出无 scope 或别频道的 token 来放大自己的权限（否则外部方铸个无 scope agent 就进你所有频道）。
  const callerScope = identity.channel_scope ?? null;
  let effectiveScope = channelScope;
  if (callerScope !== null) {
    if (channelScope !== null && channelScope !== callerScope) {
      return c.json(
        errorBody("forbidden", "channel-scoped session can only mint tokens for its own channel"),
        403,
      );
    }
    effectiveScope = callerScope;
  }
  // owner = 铸造者账号（不取客户端值）。铸出的 agent token account 因此 = 铸造者账号，
  // 与铸造者共享同一账号 → 天然能进铸造者的私有频道（canAccessChannel 账号规则）。
  const owner = identity.account;
  const result = await persistToken(c.env.DB, { name, role: "agent", owner, channelScope: effectiveScope });
  if ("conflict" in result) {
    return c.json(errorBody("conflict", "token name already exists, revoke it first"), 409);
  }
  const { token } = result;
  return c.json(
    effectiveScope !== null
      ? { token, name, role: "agent", owner, channel_scope: effectiveScope }
      : { token, name, role: "agent", owner },
    201,
  );
});

app.delete("/api/tokens/:name", requireAdmin, async (c) => {
  const name = c.req.param("name");
  const result = await c.env.DB.prepare(
    "UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), name)
    .run();
  if (result.meta.changes === 0) {
    return c.json(errorBody("not_found", "no active token with that name"), 404);
  }
  // 吊销即时生效：踢掉所有未归档频道里该 name 的存活 ws（spec §12）
  const { results } = await c.env.DB.prepare("SELECT slug FROM channels").all<{ slug: string }>();
  await Promise.all(
    results.map(async ({ slug }) => {
      try {
        const stub = await getServerByName(c.env.CHANNELS, slug);
        await stub.fetch(
          new Request("https://do/internal/kick", {
            method: "POST",
            body: JSON.stringify({ name }),
            headers: { "content-type": "application/json", "x-partykit-room": slug },
          }),
        );
      } catch {
        // do 实例被重置时连接已随之消失，踢线是尽力而为
      }
    }),
  );
  return c.json({ ok: true });
});

app.use("/api/channels", requireBearer);
app.use("/api/channels/*", requireBearer);

// 频道列表页要「最近一条消息 + 参与者状态点」（spec §9 第 1 块），逐 do 聚合 summary
interface ChannelSummary {
  last: { sender: string; kind: string; body: string; ts: number } | null;
  presence: { name: string; state: string; note: string | null; ts: number }[];
}

app.get("/api/channels", async (c) => {
  const identity = c.get("identity");
  // created_by / owner_account 仅用于 ACL 判定，不回给客户端（保持列表响应契约不变）
  const { results } = await c.env.DB.prepare(
    "SELECT slug, title, topic, kind, mode, visibility, created_by, owner_account, created_at, archived_at FROM channels ORDER BY created_at, id",
  ).all<{ slug: string; visibility: string; created_by: string | null; owner_account: string | null }>();
  // 防私有频道泄漏给粉丝（spec §5.5）：无权访问的私有频道连名字都不出现，summary 也不拉。
  // 账号房主 / 自己的 agent / scope 命中的 token / legacy token 照常看到对应私有频道。
  const visible = results.filter((row) => canAccessChannel(identity, row));
  const channels = await Promise.all(
    visible.map(async ({ created_by, owner_account, ...row }) => {
      let summary: ChannelSummary = { last: null, presence: [] };
      try {
        const stub = await getServerByName(c.env.CHANNELS, row.slug);
        const res = await stub.fetch(
          new Request("https://do/internal/summary", { headers: { "x-partykit-room": row.slug } }),
        );
        if (res.ok) summary = (await res.json()) as ChannelSummary;
      } catch {
        // do 不可达时列表仍可用，摘要降级为空
      }
      return { ...row, last_message: summary.last, presence: summary.presence };
    }),
  );
  return c.json({ channels });
});

app.post("/api/channels", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { slug?: unknown; title?: unknown; kind?: unknown; mode?: unknown; visibility?: unknown }
    | null;
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const kind = body?.kind === undefined ? "standing" : body.kind;
  const mode = body?.mode === undefined ? "normal" : body.mode;
  // 默认 private = 零破坏（spec §3.1）
  const visibility = body?.visibility === undefined ? "private" : body.visibility;
  const title = typeof body?.title === "string" ? body.title : null;
  if (!SLUG_RE.test(slug) || typeof kind !== "string" || !KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "valid slug and kind (standing|temp) required"), 400);
  }
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    return c.json(errorBody("bad_request", "mode must be normal or party"), 400);
  }
  if (typeof visibility !== "string" || !VISIBILITIES.includes(visibility)) {
    return c.json(errorBody("bad_request", "visibility must be public or private"), 400);
  }
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot create channels"), 403);
  }
  // channel-scoped token 被绑死在单个已存在频道（跨公司邀请用），不得借建频道逃出 scope：
  // 否则递给外部方的 scoped token 能以房主账号名义创建任意新频道（含 public、抢占 slug）。
  if (c.get("identity").channel_scope != null) {
    return c.json(errorBody("forbidden", "channel-scoped token cannot create channels"), 403);
  }
  const now = Date.now();
  const creator = c.get("identity");
  try {
    await c.env.DB.prepare(
      "INSERT INTO channels (slug, title, kind, mode, visibility, created_by, owner_account, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      // created_by 记具体铸造者（审计）；owner_account = 创建者账号（ACL 依据）。
      // legacy token 无 account → owner_account = null（老频道，仅 legacy 过渡放行）。
      .bind(slug, title, kind, mode, visibility, creator.name, creator.account ?? null, now)
      .run();
  } catch {
    return c.json(errorBody("conflict", "slug already exists"), 409);
  }
  if (kind === "temp") {
    try {
      const stub = await getServerByName(c.env.CHANNELS, slug);
      await stub.fetch(
        new Request("https://do/internal/init", {
          method: "POST",
          headers: {
            "x-partykit-room": slug,
            ...channelHeaders({ kind, mode }, c.req.url),
          },
        }),
      );
    } catch {
      await c.env.DB.prepare("DELETE FROM channels WHERE slug = ? AND created_at = ?")
        .bind(slug, now)
        .run()
        .catch(() => null);
      return c.json(errorBody("unavailable", "temp channel initialization failed"), 503);
    }
  }
  return c.json({ slug, title, kind, mode, visibility }, 201);
});

app.get("/api/channels/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // 防粉丝用 REST 绕过 WS 读私有频道历史（spec §3.2）
  if (!canAccessChannel(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  const search = new URL(c.req.url).search;
  return stub.fetch(
    new Request(`https://do/internal/messages${search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/search", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!canAccessChannel(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const q = new URL(c.req.url).searchParams.get("q");
  if (q === null || q.trim() === "") {
    return c.json(errorBody("bad_request", "q required"), 400);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  const search = new URL(c.req.url).search;
  return stub.fetch(
    new Request(`https://do/internal/search${search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/wake-deliveries", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!canAccessChannel(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  const search = new URL(c.req.url).search;
  return stub.fetch(
    new Request(`https://do/internal/wake-deliveries${search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/captures", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!canAccessChannel(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  const url = new URL(c.req.url);
  const kind = url.searchParams.get("kind");
  if (kind !== null && !CAPTURE_KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "kind must be decision|requirement|bug|action-item"), 400);
  }
  const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
  if (!Number.isInteger(since) || since < 0) {
    return c.json(errorBody("bad_request", "since must be a non-negative integer"), 400);
  }
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return c.json(errorBody("bad_request", "limit must be 1..1000"), 400);
  }
  const base =
    "SELECT * FROM captures WHERE channel_slug = ? AND seq > ?" +
    (kind === null ? "" : " AND kind = ?") +
    " ORDER BY seq DESC, created_at DESC LIMIT ?";
  const stmt = c.env.DB.prepare(base);
  const query = kind === null ? stmt.bind(slug, since, limit) : stmt.bind(slug, since, kind, limit);
  const { results } = await query.all<Parameters<typeof captureRowToRecord>[0]>();
  return c.json({ captures: results.map(captureRowToRecord) });
});

app.post("/api/channels/:slug/captures", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  if (!canAccessChannel(identity, channel)) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (identity.role === "readonly") {
    return c.json(errorBody("forbidden", "readonly token cannot create captures"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { seq?: unknown; kind?: unknown; as?: unknown; note?: unknown }
    | null;
  const seq = positiveInt(body?.seq);
  const kind = typeof body?.kind === "string" ? body.kind : typeof body?.as === "string" ? body.as : "";
  const note = body?.note === undefined || body?.note === null ? null : body.note;
  if (seq === null) return c.json(errorBody("bad_request", "seq must be a positive integer"), 400);
  if (!CAPTURE_KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "kind must be decision|requirement|bug|action-item"), 400);
  }
  if (note !== null && (typeof note !== "string" || note.length > CAPTURE_NOTE_MAX)) {
    return c.json(errorBody("bad_request", `note must be a string <= ${CAPTURE_NOTE_MAX} chars`), 400);
  }

  const stub = await getServerByName(c.env.CHANNELS, slug);
  const msgRes = await stub.fetch(
    new Request(`https://do/internal/messages?since=${seq - 1}&limit=1`, {
      headers: { "x-partykit-room": slug },
    }),
  );
  if (!msgRes.ok) return c.json(errorBody("unavailable", "channel history unavailable"), 503);
  const msgBody = (await msgRes.json()) as { messages?: MsgFrame[] };
  const msg = msgBody.messages?.find((m) => m.seq === seq);
  if (!msg) return c.json(errorBody("not_found", `message seq ${seq} not found in retained history`), 404);

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO captures (
      channel_slug, seq, kind, note, created_by, created_by_kind, created_at,
      message_sender, message_sender_kind, message_kind, message_body, message_ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_slug, seq, kind) DO UPDATE SET
      note = excluded.note,
      created_by = excluded.created_by,
      created_by_kind = excluded.created_by_kind,
      created_at = excluded.created_at,
      message_sender = excluded.message_sender,
      message_sender_kind = excluded.message_sender_kind,
      message_kind = excluded.message_kind,
      message_body = excluded.message_body,
      message_ts = excluded.message_ts`,
  )
    .bind(
      slug,
      seq,
      kind,
      note,
      identity.name,
      identity.kind,
      now,
      msg.sender.name,
      msg.sender.kind,
      msg.kind,
      msg.kind === "status" ? (msg.note ?? msg.body) : msg.body,
      msg.ts,
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM captures WHERE channel_slug = ? AND seq = ? AND kind = ?")
    .bind(slug, seq, kind)
    .first<Parameters<typeof captureRowToRecord>[0]>();
  return c.json(captureRowToRecord(row!), 201);
});

app.post("/api/channels/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  // 私有频道仅 ap_ token 或房主可发（spec §3.2）；写权限的 readonly 限制在 do 侧
  if (!canAccessChannel(identity, channel)) {
    return c.json(errorBody("forbidden", "not allowed in this channel"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/messages", {
      method: "POST",
      body: await c.req.text(),
      headers: {
        "content-type": "application/json",
        "x-partykit-room": slug,
        "x-ap-name": identity.name,
        "x-ap-kind": identity.kind,
        "x-ap-role": identity.role,
        ...(identity.owner ? { "x-ap-owner": identity.owner } : {}),
        "x-ap-token-hash": identity.hash,
        ...channelHeaders(channel, c.req.url),
      },
    }),
  );
});

// outbound webhook 注册 / 列表 / 删除（spec §7/§15），存储在频道 do 里
app.post("/api/channels/:slug/webhooks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // webhook 能窃取频道全部消息，属管理操作：仅 ap_ token（非只读）或房主可管理（spec §7/§15）。
  // 前置于 archived 判定，避免向粉丝泄漏私有频道是否存在/是否已归档。
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; url?: unknown; secret?: unknown; filter?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const url = typeof body?.url === "string" ? body.url : "";
  const secret = typeof body?.secret === "string" ? body.secret : "";
  const filter = body?.filter === undefined ? "mentions" : body.filter;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (
    !NAME_RE.test(name) ||
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    url.length > WEBHOOK_URL_MAX ||
    secret.length === 0 ||
    secret.length > WEBHOOK_SECRET_MAX ||
    !HEADER_VALUE_RE.test(secret) ||
    isBlockedWebhookHost(parsed.hostname) ||
    typeof filter !== "string" ||
    !WEBHOOK_FILTERS.includes(filter)
  ) {
    return c.json(
      errorBody("bad_request", "name, https url, secret and filter (mentions|status|needs-human|all) required"),
      400,
    );
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/webhooks", {
      method: "POST",
      body: JSON.stringify({ name, url, secret, filter }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/webhooks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // webhook 能窃取频道全部消息，属管理操作：仅 ap_ token（非只读）或房主可管理（spec §7/§15）。
  // 前置于 archived 判定，避免向粉丝泄漏私有频道是否存在/是否已归档。
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/webhooks", { headers: { "x-partykit-room": slug } }),
  );
});

app.delete("/api/channels/:slug/webhooks/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // webhook 能窃取频道全部消息，属管理操作：仅 ap_ token（非只读）或房主可管理（spec §7/§15）。
  // 前置于 archived 判定，避免向粉丝泄漏私有频道是否存在/是否已归档。
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can manage webhooks"), 403);
  }
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request(`https://do/internal/webhooks?name=${encodeURIComponent(c.req.param("name"))}`, {
      method: "DELETE",
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.post("/api/channels/:slug/archive", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // 归档是破坏性操作：仅房主或 ap_ token（非只读）可为，否则粉丝能归档别人的私有频道捣乱
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can archive"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  const archivedAt = Date.now();
  const res = await stub.fetch(
    new Request("https://do/internal/archive", {
      method: "POST",
      headers: {
        "x-partykit-room": slug,
        "x-ap-archive-at": String(channel.archived_at ?? archivedAt),
        ...channelHeaders(channel, c.req.url),
      },
    }),
  );
  if (!res.ok) return c.json(errorBody("unavailable", "archive coordination failed"), 503);
  return c.json({ ok: true });
});

// 踢人（spec §5 防滥用 MVP）：房主或 ap_ token 把某 name 的存活 ws 踢下线
app.post("/api/channels/:slug/kick", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (!isChannelModerator(c.get("identity"), channel)) {
    return c.json(errorBody("forbidden", "only the channel owner or an ap_ token can kick"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  // 被踢者 name 可能是 OIDC sub（含 NAME_RE 之外的字符），只做非空 + 长度校验，不套 NAME_RE
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name || name.length > 256) {
    return c.json(errorBody("bad_request", "valid name required"), 400);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  const res = await stub.fetch(
    new Request("https://do/internal/kick", {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
  if (!res.ok) return c.json(errorBody("unavailable", "kick coordination failed"), 503);
  return c.json({ ok: true });
});

app.post("/api/channels/:slug/reset-guard", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  // 重置 loop guard 要同时满足两条：① 是房主/ap_ token（挡粉丝越权重置别人频道）
  // ② 是 human（loop guard 防的就是 agent 失控刷屏，不能让 agent 重置自己的熔断）
  if (!isChannelModerator(c.get("identity"), channel) || c.get("identity").kind !== "human") {
    return c.json(errorBody("forbidden", "only a human owner or human ap_ token can reset guard"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/reset-guard", {
      method: "POST",
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json(errorBody("bad_request", "websocket upgrade required"), 426);
  }
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  // 私有频道粉丝（OIDC 非房主）连 WS 前即挡下（spec §3.2），不进 do。
  // 用 accept-then-close(1008,"forbidden") 而非 HTTP 403：浏览器 WebSocket 只对 close code/reason
  // 敏感，握手阶段的 403 在客户端仅表现为 1006（无 reason），会被误判为普通断线而无限重连；
  // 1008+"forbidden" 与 archived 同套路，ws.ts 据此识别终局、停重连、提示（不进 do，零 DO 负载）。
  if (!canAccessChannel(identity, channel)) {
    const requested = c.req
      .header("sec-websocket-protocol")
      ?.split(",")
      .map((part) => part.trim());
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(1008, "forbidden");
    const headers = new Headers();
    if (requested?.includes("agentparty")) headers.set("Sec-WebSocket-Protocol", "agentparty");
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  // new Request(c.req.raw) 会带上客户端所有头：升级请求里任何 x-ap-* 都是客户端注入的，
  // 先逐个剥离再写 worker 权威值，否则 readonly 能靠 x-ap-archived:1 提权归档活频道、
  // 靠 x-ap-host 污染 webhook permalink（do 无条件信任 x-ap-*）。
  const fwd = new Request(c.req.raw);
  for (const h of AP_FORWARD_HEADERS) fwd.headers.delete(h);
  fwd.headers.set("x-partykit-room", slug);
  fwd.headers.set("x-ap-name", identity.name);
  fwd.headers.set("x-ap-kind", identity.kind);
  fwd.headers.set("x-ap-role", identity.role);
  if (identity.owner) fwd.headers.set("x-ap-owner", identity.owner);
  fwd.headers.set("x-ap-token-hash", identity.hash);
  fwd.headers.set("x-ap-mode", channel.mode);
  fwd.headers.set("x-ap-channel-kind", channel.kind);
  fwd.headers.set("x-ap-host", new URL(c.req.url).host);
  // 无条件写：未归档也显式置 "0"，堵住"客户端注入 1、未归档分支不覆盖"的透传
  fwd.headers.set("x-ap-archived", channel.archived_at !== null ? "1" : "0");
  const upgrade = await stub.fetch(fwd);
  const requestedProtocols = c.req
    .header("sec-websocket-protocol")
    ?.split(",")
    .map((part) => part.trim());
  if (upgrade.status === 101 && upgrade.webSocket && requestedProtocols?.includes("agentparty")) {
    const headers = new Headers(upgrade.headers);
    headers.set("Sec-WebSocket-Protocol", "agentparty");
    return new Response(null, { status: 101, webSocket: upgrade.webSocket, headers });
  }
  return upgrade;
});

export default app;
