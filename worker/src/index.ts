// worker 入口 — rest 路由 + ws 升级转发
import type { ChannelKind, TokenRole } from "@agentparty/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getServerByName } from "partyserver";
import { extractBearer, lookupToken, randomToken, sha256Hex, type TokenIdentity } from "./auth";
import { ChannelDO } from "./do";
import { openapiDocument } from "./openapi";

export { ChannelDO };

type AppEnv = Env & { ADMIN_SECRET?: string };

type AppContext = {
  Bindings: AppEnv;
  Variables: { identity: TokenIdentity };
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLES: readonly string[] = ["agent", "human", "readonly"] satisfies TokenRole[];
const KINDS: readonly string[] = ["standing", "temp"] satisfies ChannelKind[];

function errorBody(code: string, message: string) {
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
    const token = extractBearer(c.req.raw);
    const identity = token ? await lookupToken(c.env.DB, token) : null;
    if (!identity) {
      return c.json(errorBody("unauthorized", "invalid or revoked token"), 401);
    }
    c.set("identity", identity);
  }
  await next();
});

async function loadChannel(db: D1Database, slug: string) {
  return db
    .prepare("SELECT slug, kind, archived_at FROM channels WHERE slug = ?")
    .bind(slug)
    .first<{ slug: string; kind: string; archived_at: number | null }>();
}

const app = new Hono<AppContext>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/openapi.json", (c) => c.json(openapiDocument));

app.post("/api/tokens", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; role?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const role = typeof body?.role === "string" ? body.role : "";
  if (!NAME_RE.test(name) || !ROLES.includes(role)) {
    return c.json(errorBody("bad_request", "valid name and role (agent|human|readonly) required"), 400);
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
    // 已吊销的同名 token 允许重铸，复用行
    await c.env.DB.prepare(
      "UPDATE tokens SET hash = ?, role = ?, created_at = ?, revoked_at = NULL WHERE id = ?",
    )
      .bind(hash, role, now, existing.id)
      .run();
  } else {
    await c.env.DB.prepare("INSERT INTO tokens (hash, name, role, created_at) VALUES (?, ?, ?, ?)")
      .bind(hash, name, role, now)
      .run();
  }
  return c.json({ token, name, role }, 201);
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
  const { results } = await c.env.DB.prepare(
    "SELECT slug FROM channels WHERE archived_at IS NULL",
  ).all<{ slug: string }>();
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

app.get("/api/channels", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT slug, title, topic, kind, created_at, archived_at FROM channels ORDER BY created_at, id",
  ).all();
  return c.json({ channels: results });
});

app.post("/api/channels", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { slug?: unknown; title?: unknown; kind?: unknown }
    | null;
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const kind = body?.kind === undefined ? "standing" : body.kind;
  const title = typeof body?.title === "string" ? body.title : null;
  if (!SLUG_RE.test(slug) || typeof kind !== "string" || !KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "valid slug and kind (standing|temp) required"), 400);
  }
  try {
    await c.env.DB.prepare(
      "INSERT INTO channels (slug, title, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(slug, title, kind, c.get("identity").name, Date.now())
      .run();
  } catch {
    return c.json(errorBody("conflict", "slug already exists"), 409);
  }
  return c.json({ slug, title, kind }, 201);
});

app.get("/api/channels/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
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
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const identity = c.get("identity");
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
      },
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
  if (channel.archived_at === null) {
    await c.env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ? AND archived_at IS NULL")
      .bind(Date.now(), slug)
      .run();
  }
  // 重试/重入也通知 do：写 do 归档态 + 踢存活连接，通知丢失可靠这里补偿
  const stub = await getServerByName(c.env.CHANNELS, slug);
  await stub.fetch(
    new Request("https://do/internal/archive", {
      method: "POST",
      headers: { "x-partykit-room": slug },
    }),
  );
  return c.json({ ok: true });
});

app.post("/api/channels/:slug/reset-guard", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot reset guard"), 403);
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
  const stub = await getServerByName(c.env.CHANNELS, slug);
  // do 无条件信任 x-ap-*，只有 worker 能构造到达 do 的请求
  const fwd = new Request(c.req.raw);
  fwd.headers.set("x-partykit-room", slug);
  fwd.headers.set("x-ap-name", identity.name);
  fwd.headers.set("x-ap-kind", identity.kind);
  fwd.headers.set("x-ap-role", identity.role);
  if (channel.archived_at !== null) fwd.headers.set("x-ap-archived", "1");
  return stub.fetch(fwd);
});

export default app;
