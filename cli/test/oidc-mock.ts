// bun.serve 模拟 account.leeguoo.com(OIDC issuer) + agentparty worker，登录/刷新/铸 agent 测试用
export interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
  tokenParams?: Record<string, string>;
}

export interface OidcMock {
  url: string;
  requests: RecordedReq[];
  tokenCalls: Record<string, string>[];
  stop(): void;
}

export function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

export interface MockOptions {
  cliClientId?: string | null; // null → 不返回 cli_client_id（模拟老 worker，回落 web client_id）
  // 覆盖 /token 响应；默认按 grant_type 给确定性 token
  tokenResponse?: (params: Record<string, string>) => Record<string, unknown>;
}

export function startOidcMock(opts: MockOptions = {}): OidcMock {
  const requests: RecordedReq[] = [];
  const tokenCalls: Record<string, string>[] = [];
  let base = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const raw = await req.text();
      const auth = req.headers.get("authorization");
      const rec: RecordedReq = { method: req.method, path: u.pathname, auth, body: null };

      if (req.method === "POST" && u.pathname === "/token") {
        const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
        rec.tokenParams = params;
        tokenCalls.push(params);
        requests.push(rec);
        if (opts.tokenResponse) return Response.json(opts.tokenResponse(params));
        const grant = params.grant_type;
        if (grant === "authorization_code") {
          return Response.json({
            access_token: "acc-authcode",
            refresh_token: "ref-1",
            id_token: makeJwt({ sub: "user-123", email: "fan@example.com" }),
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (grant === "refresh_token") {
          return Response.json({
            access_token: "acc-refreshed",
            refresh_token: "ref-2",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      try {
        rec.body = raw ? JSON.parse(raw) : null;
      } catch {
        // 非 json
      }
      requests.push(rec);

      if (req.method === "GET" && u.pathname === "/api/config") {
        const oidc = { issuer: base, client_id: "agentparty-web" };
        const body: Record<string, unknown> = { oidc };
        if (opts.cliClientId !== null) body.cli_client_id = opts.cliClientId ?? "agentparty-cli";
        return Response.json(body);
      }
      if (req.method === "GET" && u.pathname === "/api/me") {
        return Response.json({
          name: "fan@example.com",
          email: "fan@example.com",
          kind: "human",
          role: "human",
          owner: null,
          channel_scope: null,
          caps: { send: true, create_channel: true, mint_agents: true, scoped_to: null },
        });
      }
      if (req.method === "POST" && u.pathname === "/api/agents") {
        const b = rec.body as { name?: string; channel_scope?: string } | null;
        return Response.json({
          token: `ap_${b?.name ?? "x"}_secret`,
          name: b?.name ?? "x",
          owner: "fan@example.com",
          ...(b?.channel_scope ? { channel_scope: b.channel_scope } : {}),
        });
      }
      if (req.method === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(u.pathname)) {
        return Response.json({ seq: 7 });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });

  base = `http://127.0.0.1:${server.port}`;
  return {
    url: base,
    requests,
    tokenCalls,
    stop() {
      server.stop(true);
    },
  };
}
