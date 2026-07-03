// worker 入口 — rest 路由 + ws 升级转发
import { RESERVED_NAMES } from "@agentparty/shared";
import type { ChannelKind, ChannelMode, RestErrorCode, TokenRole, WebhookFilter } from "@agentparty/shared";
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
const WEBHOOK_FILTERS: readonly string[] = ["mentions", "all"] satisfies WebhookFilter[];
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

function errorBody(code: RestErrorCode, message: string) {
  return { error: { code, message } };
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
    .prepare("SELECT slug, kind, mode, archived_at, created_by, visibility FROM channels WHERE slug = ?")
    .bind(slug)
    .first<{
      slug: string;
      kind: string;
      mode: string;
      archived_at: number | null;
      created_by: string | null;
      visibility: string;
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

// 公开配置：web 据此决定是否显示 "Sign in with leeguoo"（未配 OIDC 时 oidc:null）
app.get("/api/config", (c) => {
  const oidc = oidcConfigFromEnv(c.env);
  return c.json({ oidc: oidc ? { issuer: oidc.issuer, client_id: oidc.clientId } : null });
});

// 当前登录身份：web topbar 显示 "signed in as <email 或 name>"（spec §10）
app.get("/api/me", requireBearer, (c) => {
  const id = c.get("identity");
  return c.json({
    name: id.name,
    email: id.email ?? null,
    kind: id.kind,
    role: id.role,
    owner: id.owner ?? null,
  });
});

app.post("/api/tokens", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; role?: unknown; owner?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const role = typeof body?.role === "string" ? body.role : "";
  if (!NAME_RE.test(name) || !ROLES.includes(role)) {
    return c.json(errorBody("bad_request", "valid name and role (agent|human|readonly) required"), 400);
  }
  // owner 可选：给则须 header-safe 且不超长（后续经 x-ap-owner 转发给 do）
  const owner = body?.owner === undefined || body?.owner === null ? null : body.owner;
  if (owner !== null && (typeof owner !== "string" || owner.length > OWNER_MAX || !OWNER_RE.test(owner))) {
    return c.json(errorBody("bad_request", `owner must be printable ascii, <= ${OWNER_MAX} chars`), 400);
  }
  if (RESERVED_NAMES.includes(name)) {
    return c.json(errorBody("bad_request", "name is reserved"), 400);
  }
  const existing = await c.env.DB.prepare("SELECT id, revoked_at FROM tokens WHERE name = ?")
    .bind(name)
    .first<{ id: number; revoked_at: number | null }>();
  if (existing && existing.revoked_at === null) {
    return c.json(errorBody("conflict", "token name already exists, revoke it first"), 409);
  }
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  if (existing) {
    // 已吊销的同名 token 允许重铸，复用行（owner 一并覆盖，未给则清空）
    await c.env.DB.prepare(
      "UPDATE tokens SET hash = ?, role = ?, owner = ?, created_at = ?, revoked_at = NULL WHERE id = ?",
    )
      .bind(hash, role, owner, now, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO tokens (hash, name, role, owner, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(hash, name, role, owner, now)
      .run();
  }
  return c.json(owner !== null ? { token, name, role, owner } : { token, name, role }, 201);
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
  // created_by 仅用于 ACL 判定，不回给客户端（保持列表响应契约不变）
  const { results } = await c.env.DB.prepare(
    "SELECT slug, title, topic, kind, mode, visibility, created_by, created_at, archived_at FROM channels ORDER BY created_at, id",
  ).all<{ slug: string; visibility: string; created_by: string | null }>();
  // 防私有频道泄漏给粉丝（spec §3.2）：无权访问的私有频道连名字都不出现，summary 也不拉。
  // ap_ token / OIDC 房主照常看到自己的私有频道。
  const visible = results.filter((row) => canAccessChannel(identity, row));
  const channels = await Promise.all(
    visible.map(async ({ created_by, ...row }) => {
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
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO channels (slug, title, kind, mode, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(slug, title, kind, mode, visibility, c.get("identity").name, now)
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
      errorBody("bad_request", "name, https url, secret and filter (mentions|all) required"),
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
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot archive"), 403);
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
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot reset guard"), 403);
  }
  if (c.get("identity").kind !== "human") {
    return c.json(errorBody("unauthorized", "only human tokens can reset loop guard"), 403);
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
