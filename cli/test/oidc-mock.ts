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
  const profiles: Record<string, unknown>[] = [];
  const invites: Record<string, unknown>[] = [];
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
      if (req.method === "GET" && u.pathname === "/api/agent-profiles") {
        return Response.json({ profiles });
      }
      if (req.method === "POST" && u.pathname === "/api/agent-profiles") {
        const b = rec.body as Record<string, unknown> | null;
        const now = Date.now();
        const profile = {
          owner_account: "fan@example.com",
          handle: b?.handle ?? "x",
          name: b?.name ?? b?.handle ?? "x",
          runner: b?.runner ?? "codex",
          repo_url: b?.repo_url ?? null,
          workdir: b?.workdir ?? null,
          base_branch: b?.base_branch ?? "main",
          worktree_strategy: b?.worktree_strategy ?? "branch",
          rules: b?.rules ?? null,
          invitable_by: b?.invitable_by ?? "owner",
          created_at: now,
          updated_at: now,
        };
        profiles.push(profile);
        return Response.json(profile, { status: 201 });
      }
      if (req.method === "POST" && /^\/api\/agent-profiles\/[^/]+\/runtime-token$/.test(u.pathname)) {
        const handle = decodeURIComponent(u.pathname.split("/")[3] ?? "x");
        const profile = profiles.find((p) => p.handle === handle) ?? {
          owner_account: "fan@example.com",
          handle,
          name: handle,
          runner: "codex-sdk",
          repo_url: "git@example.com:repo.git",
          workdir: "/tmp/project",
          base_branch: "main",
          worktree_strategy: "branch",
          rules: null,
          invitable_by: "owner",
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        return Response.json({ token: `ap_${handle}_runtime`, profile }, { status: 201 });
      }
      if (req.method === "GET" && u.pathname === "/api/agent-profiles/invites") {
        const handle = u.searchParams.get("handle");
        const filtered = handle ? invites.filter((i) => i.profile_handle === handle) : invites;
        return Response.json({ invites: filtered });
      }
      if (req.method === "GET" && /^\/api\/channels\/[^/]+\/loop-guard$/.test(u.pathname)) {
        // #174 loop guard 读路径 mock
        return Response.json({ enabled: true, limit: 30, streak: 27, remaining: 3, resets_on: "human" });
      }
      if (req.method === "POST" && /^\/api\/channels\/[^/]+\/project-agents$/.test(u.pathname)) {
        const slug = u.pathname.split("/")[3] ?? "dev";
        const b = rec.body as { owner_account?: string; handle?: string } | null;
        const profile = {
          owner_account: b?.owner_account ?? "fan@example.com",
          handle: b?.handle ?? "x",
          name: b?.handle ?? "x",
          runner: "codex",
          repo_url: null,
          workdir: null,
          base_branch: "main",
          worktree_strategy: "branch",
          rules: null,
          invitable_by: "owner",
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        const invite = {
          id: invites.length + 1,
          channel_slug: slug,
          owner_account: b?.owner_account ?? "fan@example.com",
          profile_handle: b?.handle ?? "x",
          invited_by: "fan@example.com",
          invited_at: Date.now(),
          already_invited: false,
          profile,
        };
        invites.push(invite);
        return Response.json(invite, { status: 201 });
      }
      if (req.method === "DELETE" && /^\/api\/channels\/[^/]+\/project-agents$/.test(u.pathname)) {
        const slug = u.pathname.split("/")[3] ?? "dev";
        const b = rec.body as { owner_account?: string; handle?: string } | null;
        return Response.json({
          ok: true,
          channel_slug: slug,
          owner_account: b?.owner_account ?? "fan@example.com",
          profile_handle: b?.handle ?? "x",
          revoked_at: Date.now(),
        });
      }
      if (req.method === "POST" && u.pathname === "/api/spawn") {
        const b = rec.body as { name?: string; channel_scope?: string; ttl_sec?: number; team_id?: string } | null;
        const expiresAt = Date.now() + (b?.ttl_sec ?? 7200) * 1000;
        return Response.json(
          {
            token: `ap_${b?.name ?? "x"}_secret`,
            name: b?.name ?? "x",
            role: "agent",
            owner: "fan@example.com",
            channel_scope: b?.channel_scope ?? "ops",
            lineage: {
              parent_agent: "parent",
              root_agent: "parent",
              team_id: b?.team_id ?? "parent",
              depth: 1,
              expires_at: expiresAt,
            },
            expires_at: expiresAt,
          },
          { status: 201 },
        );
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
