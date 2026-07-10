import type { ChannelKind, ServerFrame, TokenRole } from "@agentparty/shared";
import { SELF, env } from "cloudflare:test";

export const ADMIN_HEADERS = { "x-admin-secret": "test-admin-secret" };

type FrameOfType<T extends ServerFrame["type"]> = ServerFrame extends infer F
  ? F extends { type: infer U }
    ? T extends U
      ? F
      : never
    : never
  : never;

export function uniq(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 测试造 token 直接插 d1。opts 省略 = legacy 存量 token（owner/channel_scope 皆 null）；
// 传 owner → 带归属账号（account 走账号规则）；传 channelScope → channel-scoped token（硬上限单频道）。
export async function seedToken(
  role: TokenRole,
  name = uniq(`tok-${role}`),
  opts: {
    owner?: string;
    channelScope?: string;
    parentAgent?: string;
    rootAgent?: string;
    teamId?: string;
    spawnDepth?: number;
    childExpiresAt?: number;
  } = {},
) {
  const token = `ap_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO tokens (
       hash, name, role, owner, channel_scope,
       parent_agent, root_agent, team_id, spawn_depth, child_expires_at,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(token),
      name,
      role,
      opts.owner ?? null,
      opts.channelScope ?? null,
      opts.parentAgent ?? null,
      opts.rootAgent ?? null,
      opts.teamId ?? null,
      opts.spawnDepth ?? null,
      opts.childExpiresAt ?? null,
      Date.now(),
    )
    .run();
  return { token, name };
}

export function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://ap.test${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function createChannel(token: string, kind: ChannelKind = "standing"): Promise<string> {
  const slug = uniq("ch");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
  return slug;
}

export function postMessage(slug: string, token: string, body: string): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [], reply_to: null }),
  });
}

interface Waiter {
  resolve: (frame: ServerFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsClient {
  private buf: ServerFrame[] = [];
  private waiters: Waiter[] = [];

  static async open(
    slug: string,
    token: string,
    authMode: "header" | "query" | "protocol" = "header",
  ): Promise<WsClient> {
    const query = authMode === "query" ? `?t=${encodeURIComponent(token)}` : "";
    const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws${query}`, {
      headers:
        authMode === "header"
          ? { upgrade: "websocket", authorization: `Bearer ${token}` }
          : authMode === "protocol"
            ? { upgrade: "websocket", "sec-websocket-protocol": `agentparty, ${token}` }
          : { upgrade: "websocket" },
    });
    if (res.status !== 101 || !res.webSocket) {
      throw new Error(`ws upgrade failed: ${res.status}`);
    }
    return new WsClient(res.webSocket);
  }

  private constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      this.push(JSON.parse(event.data as string) as ServerFrame);
    });
  }

  private push(frame: ServerFrame) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.buf.push(frame);
    }
  }

  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }

  raw(text: string) {
    this.ws.send(text);
  }

  next(timeoutMs = 3000): Promise<ServerFrame> {
    const buffered = this.buf.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("timeout waiting for frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async nextOfType<T extends ServerFrame["type"]>(
    type: T,
    timeoutMs = 3000,
  ): Promise<FrameOfType<T>> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame.type === type) return frame as FrameOfType<T>;
    }
  }

  close() {
    this.ws.close();
  }
}

// #96 起新频道默认开启 loop guard。测「关闭态」行为的用例必须显式关闭，
// 不能再借用默认值——否则默认值一变，这些用例就在测别的东西。
export async function disableLoopGuard(slug: string, token: string): Promise<void> {
  const res = await api(`/api/channels/${slug}/loop-guard`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });
  if (!res.ok) throw new Error(`disableLoopGuard failed: ${res.status}`);
}
